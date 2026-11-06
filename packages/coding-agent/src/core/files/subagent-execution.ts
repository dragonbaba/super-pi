import type { ChildProcess } from "node:child_process";
import { resolve } from "node:path";
import type { Agent, AgentEvent, AgentTool, NestedToolResultMessage } from "@super-pi/agent-core";
import type { ToolDefinition } from "../extensions/types.ts";
import type { SessionPermissionMode } from "../permission-mode.ts";
import { assertPermissionMode } from "../permission-mode.ts";
import { resolveToCwd } from "../tools/path-utils.ts";
import { assertCheckpointJson } from "../tasks/checkpoints.ts";
import { resolveToolPath } from "./file-path.ts";

export const WORKSPACE_MESSAGE_PREFIX = "sp-workspace-v1:";
const MAX_MESSAGE_BYTES = 2 * 1024 * 1024;
const WORKSPACE_TOOLS = new Set(["read", "grep", "find", "ls", "write", "edit", "delete", "move", "file_batch", "bash"]);
const READ_TOOLS = new Set(["read", "grep", "find", "ls"]);
const SEARCH_TOOLS = new Set(["grep", "find", "ls"]);
const READY_TIMEOUT_MS = 30_000;
type NestedToolDispatch = ReturnType<Agent["createDelegatedToolDispatch"]>;
interface Descriptor { name: string; label: string; description: string; parameters: ToolDefinition["parameters"]; }
export interface SubagentExecutionProfile {
    mode: SessionPermissionMode;
    workspace: string;
    directories: readonly string[];
    generation: number;
    cwd: string;
    writable: boolean;
}
export interface SubagentExecutionOptions {
    profile: SubagentExecutionProfile;
    toolCallId: string;
    tools: readonly string[];
    signal: AbortSignal;
    assertCurrent(): void;
}
export type OpenSubagentExecution = (options: SubagentExecutionOptions) => SubagentExecution;

function encode(packet: unknown): string {
    assertCheckpointJson(packet, MAX_MESSAGE_BYTES, true);
    const json = JSON.stringify(packet);
    if (Buffer.byteLength(json) > MAX_MESSAGE_BYTES) throw new Error("Subagent workspace message exceeds 2 MiB");
    return WORKSPACE_MESSAGE_PREFIX + json;
}
function decode(raw: string): any {
    if (Buffer.byteLength(raw) > MAX_MESSAGE_BYTES + WORKSPACE_MESSAGE_PREFIX.length) throw new Error("Oversized subagent workspace message");
    const packet = JSON.parse(raw.slice(WORKSPACE_MESSAGE_PREFIX.length));
    if (!packet || !Number.isSafeInteger(packet.id) || packet.id < 1) throw new Error("Invalid subagent workspace sequence");
    return packet;
}
function errorText(error: unknown): string { return (error instanceof Error ? error.message : String(error)).slice(0, 4096); }
function observeToolEvent(_event: AgentEvent): void { /* Completion is returned to the task, never to a parent provider turn. */ }

/** One task owns one active request. Every request reuses the native dispatcher and releases its scope. */
export class SubagentExecution {
    readonly profile: SubagentExecutionProfile;
    readonly descriptors: Descriptor[] = [];
    private agent?: Agent;
    private check?: () => void;
    private scope?: NestedToolDispatch;
    private pending?: Promise<NestedToolResultMessage>;
    private readonly controller = new AbortController();
    private readonly parentSignal: AbortSignal;
    private readonly parentToolCallId: string;
    private readonly tools: AgentTool[] = [];
    private sequence = 0;
    private cleanupFailure?: string;
    private readonly revoke = (): void => { this.controller.abort(); void this.scope?.close(); };
    failureReason?: string;
    constructor(agent: Agent, definitions: ReadonlyMap<string, ToolDefinition>, tools: ReadonlyMap<string, AgentTool>, options: SubagentExecutionOptions) {
        options.assertCurrent(); options.signal.throwIfAborted();
        this.agent = agent; this.check = options.assertCurrent; this.profile = options.profile;
        this.parentSignal = options.signal; this.parentToolCallId = options.toolCallId;
        for (const name of options.tools) {
            if (!WORKSPACE_TOOLS.has(name) || !options.profile.writable && !READ_TOOLS.has(name)) continue;
            const definition = definitions.get(name);
            const tool = tools.get(name);
            if (!definition || !tool) throw new Error(`Parent tool is unavailable: ${name}`);
            this.tools.push(tool);
            this.descriptors.push({ name, label: definition.label, description: definition.description, parameters: definition.parameters });
        }
        this.parentSignal.addEventListener("abort", this.revoke, { once: true });
    }
    execute(name: string, input: unknown): Promise<NestedToolResultMessage> {
        if (!this.agent || !this.check || this.pending) throw new Error("Subagent execution is closed or already busy");
        this.check(); this.controller.signal.throwIfAborted();
        if (!this.descriptors.some(tool => tool.name === name)) throw new Error("Tool is outside the delegated profile: " + name);
        if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Expected tool arguments object");
        const args = { ...input } as Record<string, any>;
        // Only structured path fields change base. Shell source is passed through unchanged.
        if (name === "bash") {
            // Child profiles do not expose tasks controls. Preserve that existing background admission rule.
            if (args.background === true) throw new Error("Subagent shells require foreground execution; the child has no shell task-management tools");
            if (args.cwd !== undefined) args.cwd = resolve(this.profile.cwd, args.cwd);
            else if (this.profile.cwd !== this.profile.workspace) args.cwd = this.profile.cwd;
        }
        else if (name === "file_batch") {
            if (!Array.isArray(args.operations)) throw new Error("Expected file batch operations");
            args.operations = args.operations.map((item: Record<string, any>) => this.rebase(item, item.operation));
        } else Object.assign(args, this.rebase(args, name));
        this.scope = this.agent.createDelegatedToolDispatch(`${this.parentToolCallId}:delegated:${++this.sequence}`, this.controller.signal, observeToolEvent, this.tools);
        this.pending = this.run(name, args, this.scope);
        return this.pending;
    }
    private rebase(input: Record<string, unknown>, operation: string): Record<string, unknown> {
        const args = { ...input };
        if (typeof args.path === "string") args.path = READ_TOOLS.has(operation) ? resolveToCwd(args.path, this.profile.cwd)
            : operation === "write" || operation === "edit" ? resolveToolPath(this.profile.cwd, args.path) : resolve(this.profile.cwd, args.path);
        else if (args.path === undefined && SEARCH_TOOLS.has(operation)) args.path = this.profile.cwd;
        if (typeof args.destination === "string") args.destination = resolve(this.profile.cwd, args.destination);
        return args;
    }
    private async run(name: string, args: Record<string, unknown>, scope: NestedToolDispatch): Promise<NestedToolResultMessage> {
        try {
            const result = await scope.callTool(name, args, { allowFailure: true });
            if (result.isError) {
                for (const part of result.content) if (part.type === "text" &&
                    (part.text.includes("[EXTERNAL_FILE_WRITE_BLOCKED]") || part.text.includes("[APPROVAL_REQUIRED]"))) {
                    this.failureReason = part.text.slice(0, 4096); this.controller.abort();
                }
            }
            return result;
        } finally {
            await scope.close();
            if (scope.abandonedCalls) this.cleanupFailure = "Delegated tool ignored cancellation; effects may still be running. Execution must remain closed.";
            this.scope = undefined; this.pending = undefined;
        }
    }
    cancelRequest(): void { void this.scope?.close(); }
    async dispose(): Promise<void> {
        this.parentSignal.removeEventListener("abort", this.revoke); this.revoke();
        const scope = this.scope; await scope?.close();
        if (scope?.abandonedCalls) this.cleanupFailure = "Delegated tool ignored cancellation; effects may still be running. Execution must remain closed.";
        // Scope close imposes the existing bounded cancellation grace. An abandoned call is reported by that owner.
        this.agent = undefined; this.check = undefined; this.scope = undefined; this.pending = undefined;
        this.descriptors.length = 0;
        this.tools.length = 0;
        if (this.cleanupFailure) throw new Error(this.cleanupFailure);
    }
}

/** Exact ChildProcess IPC endpoint. No network channel and no messages for deltas/progress. */
export class SubagentExecutionServer {
    private proc?: ChildProcess;
    private owner?: SubagentExecution;
    private fail?: (reason: string) => void;
    private sequence = 0;
    private ready = false;
    private busy = false;
    private readonly message = (raw: unknown): void => {
        if (typeof raw !== "string" || !raw.startsWith(WORKSPACE_MESSAGE_PREFIX)) return;
        void this.handle(raw).catch(this.failed);
    };
    private readonly failed = (error: unknown): void => { this.fail?.("Subagent workspace channel stopped: " + errorText(error)); };
    private readonly sent = (error: Error | null): void => { if (error) this.failed(error); };
    constructor(owner: SubagentExecution) { this.owner = owner; }
    attach(proc: ChildProcess, fail: (reason: string) => void): void {
        if (this.proc || !this.owner) throw new Error("Workspace channel is already attached or closed");
        this.proc = proc; this.fail = fail; proc.on("message", this.message);
    }
    private async handle(raw: string): Promise<void> {
        const owner = this.owner, proc = this.proc;
        if (!owner || !proc) return;
        const packet = decode(raw);
        // Cancellation belongs to the current request, including a reply already in flight.
        if (packet.kind === "cancel" && this.ready && packet.id === this.sequence) {
            if (this.busy) owner.cancelRequest();
            return;
        }
        if (this.busy || packet.id !== ++this.sequence) throw new Error("Out-of-order workspace request");
        this.busy = true;
        try {
            if (packet.kind === "ready" && !this.ready) {
                this.ready = true;
                proc.send(encode({ id: packet.id, ok: true, profile: owner.profile, tools: owner.descriptors }), this.sent);
            } else if (packet.kind === "tool" && this.ready) {
                const result = await owner.execute(packet.name, packet.input);
                if (owner.failureReason) { this.fail?.(owner.failureReason); return; }
                if (this.proc !== proc || !proc.connected) return;
                let encoded: string;
                try { encoded = encode({ id: packet.id, ok: true, result }); }
                catch { encoded = encode({ id: packet.id, ok: false, reason: "Tool finished but its result could not be represented within the 2 MiB IPC limit. Effects may already exist; inspect state before any retry." }); }
                proc.send(encoded, this.sent);
            } else throw new Error("Unexpected workspace request");
        } finally { this.busy = false; }
    }
    async dispose(): Promise<void> {
        this.proc?.off("message", this.message); this.proc = undefined; this.fail = undefined;
        const owner = this.owner; this.owner = undefined; await owner?.dispose();
    }
}

/** Child runtime installs these proxies instead of local native files, tasks or a second VM. */
export class SubagentParentClient {
    profile!: SubagentExecutionProfile;
    private descriptors: Descriptor[] = [];
    private sequence = 0;
    private resolve?: (packet: any) => void;
    private reject?: (error: Error) => void;
    private timer?: ReturnType<typeof setTimeout>;
    private failure?: Error;
    private signal?: AbortSignal;
    private cancelling = false;
    private readonly message = (raw: unknown): void => {
        if (typeof raw !== "string" || !raw.startsWith(WORKSPACE_MESSAGE_PREFIX)) return;
        try {
            const packet = decode(raw);
            if (!this.resolve || packet.id !== this.sequence || typeof packet.ok !== "boolean") throw new Error("Invalid parent workspace reply");
            const resolve = this.resolve, reject = this.reject!; this.clear();
            // Native completion/interrupt receipts remain authoritative even after cancellation.
            if (packet.ok) resolve(packet); else reject(new Error(packet.reason));
        } catch (error) { this.stop(new Error(errorText(error))); }
    };
    private readonly disconnected = (): void => { this.stop(new Error("Parent workspace channel disconnected; local execution is unavailable")); };
    private readonly aborted = (): void => {
        if (!this.resolve || this.cancelling) return;
        this.cancelling = true;
        try {
            if (!process.connected || !process.send) throw new Error("Parent workspace channel is unavailable");
            process.send(encode({ id: this.sequence, kind: "cancel" }), this.sent);
        } catch (error) { this.stop(new Error(errorText(error))); }
        // Keep the pending result until the parent has joined the bounded native cleanup.
    };
    private readonly sent = (error: Error | null): void => { if (error) this.stop(error); };
    constructor() { process.on("message", this.message); process.on("disconnect", this.disconnected); }
    async initialize(): Promise<void> {
        const packet = await this.request("ready");
        assertPermissionMode(packet.profile?.mode);
        if (!Array.isArray(packet.tools) || packet.tools.length > WORKSPACE_TOOLS.size || typeof packet.profile.cwd !== "string") throw new Error("Invalid parent execution profile");
        this.profile = packet.profile; this.descriptors = packet.tools;
    }
    definitions(): Record<string, ToolDefinition> {
        const output: Record<string, ToolDefinition> = {};
        for (const descriptor of this.descriptors) {
            const name = descriptor.name;
            if (!WORKSPACE_TOOLS.has(name)) throw new Error("Unexpected delegated tool: " + name);
            output[name] = { ...descriptor, execute: async (_id, args, signal) => {
                const packet = await this.request("tool", { name, input: args }, signal);
                const result = packet.result as NestedToolResultMessage;
                return { content: result.content, details: result.details, isError: result.isError };
            } };
        }
        return output;
    }
    private request(kind: "ready" | "tool", fields?: object, signal?: AbortSignal): Promise<any> {
        if (this.failure) return Promise.reject(this.failure);
        if (this.resolve) return Promise.reject(new Error("A delegated workspace request is already pending"));
        signal?.throwIfAborted();
        const encoded = encode({ id: this.sequence + 1, kind, ...fields });
        this.sequence++;
        return new Promise((resolve, reject) => {
            this.resolve = resolve; this.reject = reject; this.signal = signal;
            signal?.addEventListener("abort", this.aborted, { once: true });
            // Tool requests use the parent's task deadline, so a 60s approval can complete.
            if (kind === "ready") this.timer = setTimeout(SubagentParentClient.timeout, READY_TIMEOUT_MS, this);
            try {
                if (!process.connected || !process.send) throw new Error("Parent workspace channel is unavailable");
                process.send(encoded, this.sent);
            } catch (error) { this.stop(new Error(errorText(error))); }
        });
    }
    private static timeout(client: SubagentParentClient): void { client.stop(new Error("Parent execution initialization timed out")); }
    private clear(): void {
        if (this.timer) clearTimeout(this.timer); this.timer = undefined;
        this.signal?.removeEventListener("abort", this.aborted); this.signal = undefined;
        this.cancelling = false;
        this.resolve = undefined; this.reject = undefined;
    }
    private stop(error: Error): void { this.failure ??= error; const reject = this.reject; this.clear(); reject?.(this.failure); }
    dispose(): void {
        this.stop(new Error("Parent execution client closed"));
        process.off("message", this.message); process.off("disconnect", this.disconnected); this.descriptors.length = 0;
    }
}
