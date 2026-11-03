import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Type } from "typebox";
import type { AgentToolExecutionContext } from "@super-pi/agent-core";
import type { ExtensionContext, ExtensionRuntime, ToolDefinition } from "../extensions/types.ts";
import { SandboxTaskBinding, type SandboxTaskBorrow } from "./task-binding.ts";
import { parseSandboxTaskRequest, sandboxGuestCwd, type SandboxTaskRequest } from "./task-request.ts";

export interface SandboxCommandOutput {
    exitCode: number; timedOut: boolean; stdout: string; stderr: string;
    stdoutTruncated: boolean; stderrTruncated: boolean; stdoutSeen: number; stderrSeen: number; elapsedMs: number;
}
export interface SandboxRun {
    result: SandboxCommandOutput;
    input?: Record<string, unknown>;
    finish(): Promise<void>;
    diagnostics: unknown;
}
export type SandboxBackend = (borrow: SandboxTaskBorrow, artifactParent: string) => Promise<SandboxRun>;
type Dispatch<State> = (state: State, name: string, args: Record<string, unknown>, allowFailure: boolean) => Promise<{ isError?: boolean; [key: string]: unknown }>;
interface ActiveCommand {
    borrow: SandboxTaskBorrow;
    request: SandboxTaskRequest;
    serialized: string;
    used: boolean;
    run?: SandboxRun;
}
const inputRow = Type.Object({ path: Type.String(), snapshot: Type.String() }, { additionalProperties: false });
const writeRow = Type.Object({ path: Type.String(), operation: Type.Union([Type.Literal("add"), Type.Literal("modify")]),
    snapshot: Type.Union([Type.String(), Type.Null()]) }, { additionalProperties: false });
export const SANDBOX_POWERSHELL_PARAMETERS = Type.Object({
    command: Type.String({ minLength: 1, description: "PowerShell script executed in a fresh, offline Windows Sandbox." }),
    cwd: Type.Optional(Type.String({ description: "Relative directory inside the sandbox workspace; defaults to '.'." })),
    timeout: Type.Optional(Type.Number({ minimum: 0.001, maximum: 30, description: "Command deadline in seconds, excluding VM startup; default 30." })),
    inputs: Type.Optional(Type.Array(inputRow, { maxItems: 16, description: "Selected native read snapshots, at most 4096 bytes per file and 16384 total." })),
    writes: Type.Optional(Type.Array(writeRow, { maxItems: 16, description: "Explicit output files to submit through the normal file_batch authorization; modifications require the selected original snapshot." })),
}, { additionalProperties: false });

function requestFor(value: unknown): SandboxTaskRequest {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("[SANDBOX_INPUT] Object arguments required");
    const input = value as Record<string, unknown>;
    for (const key of Object.keys(input)) if (!["command", "cwd", "timeout", "inputs", "writes"].includes(key))
        throw new Error("[SANDBOX_INPUT] Unsupported PowerShell field: " + key);
    const timeout = input.timeout ?? 30;
    if (typeof timeout !== "number" || !Number.isFinite(timeout)) throw new Error("[SANDBOX_INPUT] Invalid timeout");
    return parseSandboxTaskRequest({ version: 1, profile: "windows-powershell-foreground-v1", command: input.command,
        cwd: input.cwd ?? ".", timeoutMs: timeout * 1000, inputs: input.inputs ?? [], writes: input.writes ?? [] });
}
async function productionBackend(borrow: SandboxTaskBorrow, artifactParent: string): Promise<SandboxRun> {
    const packaged = new URL("./windows-runtime/windows-sandbox-task-runtime.mjs", import.meta.url);
    const source = new URL("../../../../../scripts/acceptance/windows-sandbox-task-runtime.mjs", import.meta.url);
    const location = existsSync(fileURLToPath(packaged)) ? packaged : source;
    const runtime = await import(location.href);
    return runtime.executeWindowsTask(borrow, artifactParent);
}

/** Session-owned, one foreground task at a time. This is not an authorization
 * table: command and candidate writes both pass through the original dispatcher. */
export class SessionSandbox {
    private active?: ActiveCommand;
    private pending?: Promise<unknown>;
    private retained?: unknown;
    private lastDiagnostics?: unknown;
    private closed = false;
    private readonly runtime: () => ExtensionRuntime;
    private readonly artifactParent: string;
    private readonly backend: SandboxBackend;
    constructor(runtime: () => ExtensionRuntime, artifactParent: string, backend: SandboxBackend = productionBackend) {
        this.runtime = runtime; this.artifactParent = artifactParent; this.backend = backend;
    }

    definition(): ToolDefinition {
        return { name: "powershell", label: "PowerShell (Windows Sandbox)",
            description: "Run Windows PowerShell 5.1 in an offline Windows Sandbox, with ErrorActionPreference=Stop and process-local script execution enabled. UTF-8 script files containing non-ASCII text need a BOM (PowerShell 5.1 decoding). Only selected read snapshots enter its workspace. Explicit output files return through file_batch authorization. No host environment, network, background jobs, or host fallback. Files are limited to 4096 bytes each, 16384 bytes total, 16 paths; command timeout is at most 30 seconds.",
            promptSnippet: "Run offline PowerShell in Windows Sandbox with explicit snapshot inputs and output files",
            parameters: SANDBOX_POWERSHELL_PARAMETERS, executionMode: "sequential", modelExposure: "nested",
            execute: this.executeChild };
    }
    async dispatch<State>(input: Record<string, unknown>, ctx: ExtensionContext, context: AgentToolExecutionContext,
        signal: AbortSignal, dispatch: Dispatch<State>, state: State, allowFailure: boolean): Promise<unknown> {
        if (this.closed || this.pending || this.retained) throw new Error("[SANDBOX_BUSY] Previous task is active or has unresolved cleanup");
        const request = requestFor(input), runtime = this.runtime();
        if (!runtime.nativeFiles) throw new Error("[SANDBOX_UNAVAILABLE] Native file owner is unavailable");
        const binding = new SandboxTaskBinding(request, runtime.nativeFiles, ctx, context, context.parentToolCallId, signal, runtime);
        const operation = binding.run(async borrow => {
            const slot: ActiveCommand = { borrow, request, serialized: JSON.stringify(request), used: false };
            this.active = slot;
            try {
                const result = await dispatch(state, "powershell", input, allowFailure);
                if (!result.isError && !result.observationFailure && slot.run?.input) {
                    borrow.assertInputsCurrent();
                    const write = await dispatch(state, "file_batch", slot.run.input, allowFailure);
                    return { ...result, isError: write.isError === true, writeback: write };
                }
                return result;
            } finally {
                try {
                    if (slot.run) { await slot.run.finish(); this.lastDiagnostics = slot.run.diagnostics; }
                } catch (error) { this.retained = slot.run ?? error; throw error; }
                finally { slot.run = undefined; this.active = undefined; }
            }
        });
        this.pending = operation;
        try { return await operation; }
        finally { this.pending = undefined; binding.dispose(); }
    }
    private readonly executeChild: ToolDefinition["execute"] = async (id, input, signal) => {
        const slot = this.active;
        if (!slot || slot.used || !id.startsWith(slot.borrow.execution.parentToolCallId + ":nested:")
            || JSON.stringify(requestFor(input)) !== slot.serialized) throw new Error("[SANDBOX_BINDING_STALE] Original CodeMode command binding required");
        slot.borrow.assertInputsCurrent(); signal?.throwIfAborted(); slot.used = true;
        try { slot.run = await this.backend(slot.borrow, path.resolve(this.artifactParent)); }
        catch (error) {
            const failure = error as { sandboxOwner?: unknown; sandboxDiagnostics?: unknown; cause?: { sandboxOwner?: unknown } };
            this.lastDiagnostics = failure.sandboxDiagnostics;
            if (failure.sandboxOwner || failure.cause?.sandboxOwner) this.retained = failure.sandboxOwner ?? failure.cause?.sandboxOwner;
            throw error;
        }
        const output = slot.run.result;
        return { content: [{ type: "text", text: output.stdout || "(no stdout)" }, { type: "text", text: output.stderr || "(no stderr)" }],
            isError: output.exitCode !== 0 || output.timedOut,
            details: { sandbox: { profile: slot.request.profile, elapsedMs: output.elapsedMs, stdoutSeen: output.stdoutSeen, stderrSeen: output.stderrSeen },
                shellExecution: { version: 1, producer: "custom-shell", started: true, executionStatus: output.timedOut ? "interrupted" : "exited",
                    sideEffects: "unknown", retryGuidance: "inspect_before_retry", cwd: sandboxGuestCwd(slot.request), exitCode: output.exitCode,
                    signal: null, termination: output.timedOut ? "timeout" : "exit",
                    output: { complete: !output.stdoutTruncated && !output.stderrTruncated, tailTruncated: output.stdoutTruncated || output.stderrTruncated,
                        log: "not_needed", cleanup: "not_needed" } } } };
    };
    async close(): Promise<void> {
        this.closed = true;
        await this.drain();
    }
    async drain(): Promise<void> {
        try { await this.pending; } finally { if (this.retained) throw new Error("[SANDBOX_CLEANUP_PENDING] Original sandbox owner remains retained"); }
    }
    get diagnostics() { return { active: !!this.active, pending: !!this.pending, retained: !!this.retained, closed: this.closed, last: this.lastDiagnostics }; }
}
