import { createHash } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { assertPermissionMode, type SessionPermissionMode } from "./permission-mode.ts";
import { WORKSPACE_TOOL_NAMES } from "./session-execution-profile.ts";
import type { ExtensionContext, ExtensionRuntime, ToolCallEvent, ToolDefinition } from "./extensions/types.ts";
import type { ReadonlySessionManager, SessionEntry, SessionEntryVisitor } from "./session-manager.ts";
import { assessCanonicalMutationPath, canonicalizeProspectivePath, canonicalWorkspaceMetadata } from "./files/protected-path-policy.ts";
import { assessHostMutations } from "./files/host-mutation-policy.ts";
import { attachPermissionPathApproval, mutationRequestHash, type PermissionPathApproval } from "./files/file-invocation.ts";
import { InputReadPolicyLease } from "./files/session-input-read-permission.ts";
import { resolveReadPathAsync, resolveToCwd } from "./tools/path-utils.ts";
import { attachToolPath } from "./files/tool-path-authorization.ts";
import { resolveToolPath } from "./files/file-path.ts";
import { prepareNativeDelegation } from "./files/native-delegation.ts";
import { attachSubagentWorkspaceDelegation, attachStructuredReadonlyWorkspaceDelegation, structuredReadonlyRequestHash,
    attachBrowserExecAuthorization, browserExecRequestHash } from "./files/extension-permissions.ts";
import { InputWorkspaceGrantLease, type InputWorkspaceGrant, type InputWorkspaceIssuance,
    type AssertInputWorkspace, type ObserveInputWorkspace } from "./files/input-workspace-grant-lease.ts";

export type ExecutionEnvironment = "sandbox" | "trusted-host";
export type PermissionDecision = "allow" | "ask" | "deny";
export interface ExecutionPermissionRule {
    tool: string; decision: PermissionDecision;
    /** Exact command, never a shell prefix or parsed risk classification. */
    command?: string;
    /** Workspace-relative subtree. Allow requires containment; deny/ask covers any intersecting search scope. */
    path?: string;
}
export interface ExecutionPermissions { approval?: "interactive" | "never"; rules?: ExecutionPermissionRule[]; }
interface ResolvedPolicyPaths { paths: string[]; workspaces: string[]; }
export interface PermissionRefusal {
    readonly key: string;
    readonly source: "legacy" | "explicit";
    readonly summary: string;
    readonly reason?: string;
}
const MUTATIONS = new Set(["edit", "write", "delete", "move", "file_batch"]);
const SEARCHES = new Set(["grep", "find", "ls"]);
const RECURSIVE_SCOPES = new Set([...SEARCHES, "subagent", "structured_readonly_command"]);
const SAFE = new Set(["codemode", "tool_search", "tasks"]);
const SANDBOX_TOOLS = new Set<string>([...SAFE, ...WORKSPACE_TOOL_NAMES]);
const BLOCKED = "[POLICY_BLOCKED] ";
const MAX_REFUSALS = 128;
const MAX_REFUSAL_SUMMARY = 4096;
const MAX_REFUSAL_REASON = 1024;
const APPROVAL_TIMEOUT_MS = 60000;
const REFUSAL_KEY = /^[a-f0-9]{64}$/;
const APPROVAL_CHOICES = ["允许一次", "拒绝", "拒绝并说明原因"];
const assertSignal = AbortSignal.prototype.throwIfAborted;
function inside(root: string, target: string): boolean {
    const part = relative(root, target);
    return part === "" || part !== ".." && !part.startsWith("..\\") && !part.startsWith("../") && !isAbsolute(part);
}
function insideCanonical(root: string, target: string): boolean {
    return target === root || target.length > root.length && target.startsWith(root)
        && (target[root.length] === "\\" || target[root.length] === "/");
}
function fingerprint(value: unknown): string {
    const json = JSON.stringify(value);
    if (json.length > 16 * 1024 * 1024) throw new Error(BLOCKED + "Invocation exceeds the authorization size limit");
    return createHash("sha256").update(json).digest("hex");
}
function invocationFingerprint(name: string, input: unknown): string {
    return isMutation(name, input) ? mutationRequestHash(name as PermissionPathApproval["operation"], input) : fingerprint(input);
}
function isMutation(name: string, input: unknown): boolean {
    return MUTATIONS.has(name) || name === "lsp_fix" && (input as { write?: unknown } | null)?.write === true;
}

/** One cold invocation snapshot. It is released by the existing pending tool owner. */
export class NativePolicyInvocation {
    private original?: object;
    private check?: () => void;
    private readonly hash: string;
    private readonly id: string;
    private readonly name: string;
    private context?: WeakRef<ExtensionContext>;
    private readonly cwd: string;
    private readonly session: string;
    constructor(event: ToolCallEvent, check: () => void, ctx: ExtensionContext) {
        this.original = event.input; this.hash = invocationFingerprint(event.toolName, event.input); this.id = event.toolCallId;
        this.name = event.toolName; this.check = check;
        this.context = new WeakRef(ctx); this.cwd = ctx.cwd; this.session = ctx.sessionManager.getSessionId();
    }
    consume(args: unknown, id: string, name: string, signal?: AbortSignal): void {
        if (!this.check || args !== this.original || id !== this.id || name !== this.name || invocationFingerprint(name, args) !== this.hash)
            throw new Error(BLOCKED + "Invocation changed after authorization");
        const ctx = this.context?.deref();
        if (!ctx || ctx.cwd !== this.cwd || ctx.sessionManager.getSessionId() !== this.session) throw new Error(BLOCKED + "Session changed");
        signal?.throwIfAborted(); this.check();
    }
    release(): void { this.original = undefined; this.check = undefined; this.context = undefined; }
}

/** Native operation authorization, independent of the OS execution backend.
 * No shell parsing, command risk inference, extension grant bus, or output hooks.
 * Configuration is immutable for this runtime; reload uses the execution barrier.
 */
export class SessionExecutionPolicy implements SessionEntryVisitor {
    readonly mode?: SessionPermissionMode;
    readonly environment: ExecutionEnvironment;
    private readonly runtime: ExtensionRuntime;
    private readonly rules: readonly ExecutionPermissionRule[];
    private readonly approval: "interactive" | "never";
    private readonly definitions = new WeakSet<ToolDefinition>();
    private grant?: InputWorkspaceGrant;
    private issuance?: InputWorkspaceIssuance;
    private workspace = "";
    private sessionId = "";
    private readonly denied = new Map<string, PermissionRefusal>();
    private refusalManager?: WeakRef<ReadonlySessionManager>;
    private refusalGeneration = -1;
    private refusalCursor = 0;
    private scannedLeaf?: WeakRef<SessionEntry>;
    private legacyHistory = false;
    private epoch = 0;
    private closed = false;
    private readonly directories: readonly string[];
    constructor(runtime: ExtensionRuntime, environment: ExecutionEnvironment, config: ExecutionPermissions = {}, mode?: SessionPermissionMode,
        directories: readonly string[] = []) {
        this.directories = directories;
        this.mode = mode;
        if (mode !== undefined) { assertPermissionMode(mode); if ((mode === "host-write") !== (environment === "trusted-host")) throw new Error("Permission mode and backend disagree"); }
        if (environment !== "sandbox" && environment !== "trusted-host") throw new Error("Invalid executionEnvironment");
        if (config.approval !== undefined && config.approval !== "interactive" && config.approval !== "never") throw new Error("Invalid executionPermissions.approval");
        if (config.rules !== undefined && (!Array.isArray(config.rules) || config.rules.length > 128)) throw new Error("At most 128 execution permission rules are supported");
        this.runtime = runtime; this.environment = environment; this.approval = config.approval ?? "interactive";
        this.rules = Object.freeze((config.rules ?? []).map(rule => {
            if (!rule || typeof rule.tool !== "string" || !rule.tool.length || rule.tool.length > 128
                || !["allow", "ask", "deny"].includes(rule.decision)
                || rule.command !== undefined && (typeof rule.command !== "string" || rule.command.length > 32768)
                || rule.path !== undefined && (typeof rule.path !== "string" || rule.path.length > 4096 || isAbsolute(rule.path) || !inside(resolve("."), resolve(rule.path))))
                throw new Error("Invalid execution permission rule");
            return Object.freeze({ ...rule });
        }));
        runtime.executionBoundary.register("native-permissions", { revoke: this.revoke, drain: this.drain });
    }
    private readonly revoke = (): void => { this.epoch++; this.grant = undefined; this.issuance = undefined; };
    private readonly drain = async (): Promise<void> => {};
    dispose(): void {
        this.closed = true; this.revoke(); this.denied.clear(); this.refusalManager = undefined;
        this.refusalGeneration = -1; this.refusalCursor = 0; this.scannedLeaf = undefined; this.legacyHistory = false;
    }
    registerDefinition(definition: ToolDefinition): void {
        if (SANDBOX_TOOLS.has(definition.name) && (definition.name !== "bash" || this.mode !== undefined)) this.definitions.add(definition);
    }
    supports(definition: ToolDefinition): boolean { return this.environment !== "sandbox" || this.definitions.has(definition); }
    private guard(ctx: ExtensionContext): () => void {
        this.runtime.executionBoundary.assertCurrent();
        const owner = new WeakRef(this), generation = this.epoch, signal = ctx.signal ?? this.runtime.executionBoundary.signal;
        return function assertNativePermission() {
            const active = owner.deref();
            if (!active || active.closed || active.epoch !== generation)
                throw new Error(BLOCKED + "Original permission context expired");
            if (signal) assertSignal.call(signal);
        };
    }
    private refuse(ctx: ExtensionContext, code: string, message: string): never {
        if (ctx.hasUI) ctx.ui.notify(message, "error");
        throw new Error(code + message);
    }
    private async paths(ctx: ExtensionContext, targets: readonly string[], mutation: boolean, operation = "变更"): Promise<ResolvedPolicyPaths> {
        const check = this.guard(ctx), output: string[] = [];
        if (targets.length > 34) throw new Error(BLOCKED + "Too many paths");
        if (!targets.length) return { paths: output, workspaces: [] };
        const workspaces = [await realpath(ctx.cwd)], unavailable: string[] = []; check();
        for (const directory of this.directories) {
            let canonical: string | undefined;
            try { canonical = await realpath(directory); } catch { /* Keep unavailable grants closed without disabling unrelated host paths. */ }
            check();
            if (canonical !== directory) {
                if (this.mode !== "host-write") throw new Error(BLOCKED + "Additional workspace is unavailable or redirected: " + directory);
                unavailable.push(directory);
            } else workspaces.push(canonical);
        }
        const metadata = mutation ? await canonicalWorkspaceMetadata(workspaces) : undefined; check();
        for (const target of targets) {
            if (typeof target !== "string" || target.length > 4096 || target.includes("\0")) throw new Error(BLOCKED + "Invalid path");
            const absolute = resolve(ctx.cwd, target);
            const canonical = mutation ? await canonicalizeProspectivePath(absolute) : await realpath(absolute); check();
            for (const directory of unavailable) {
                if (inside(directory, absolute) || inside(directory, canonical)) throw new Error(BLOCKED + "Additional workspace is unavailable or redirected: " + directory);
            }
            if (mutation) {
                const result = assessCanonicalMutationPath(workspaces, canonical, metadata);
                for (const violation of result.violations) {
                    if (violation !== "workspace_escape" || this.mode !== "host-write") {
                        this.refuse(ctx, BLOCKED, `禁止 ${operation}：${canonical}\n受保护或工作区外目标（${violation}）。操作未执行，请明确告知用户。`);
                    }
                }
                output.push(canonical);
            } else {
                let contained = false;
                for (const root of workspaces) if (inside(root, canonical)) { contained = true; break; }
                if (this.mode !== "host-write" && !contained) throw new Error(BLOCKED + "Read is outside the workspace: " + target);
                output.push(canonical);
            }
        }
        return { paths: output, workspaces };
    }
    private async decision(tool: string, command: unknown, paths: readonly string[], cwd: string, fallback?: PermissionDecision): Promise<PermissionDecision> {
        let selected: PermissionDecision | undefined;
        for (const rule of this.rules) {
            if (rule.tool !== "*" && rule.tool !== tool || rule.command !== undefined && rule.command !== command) continue;
            if (rule.path !== undefined) {
                if (!paths.length) continue;
                const root = await canonicalizeProspectivePath(resolve(cwd, rule.path));
                let matches = rule.decision === "allow";
                for (const target of paths) {
                    const contained = inside(root, target);
                    if (rule.decision === "allow") { if (!contained) { matches = false; break; } }
                    else if (contained || RECURSIVE_SCOPES.has(tool) && inside(target, root)) { matches = true; break; }
                }
                if (!matches) continue;
            }
            if (rule.decision === "deny") return "deny";
            // An explicit ask is not overridden by a broader allow.
            if (selected !== "ask") selected = rule.decision;
        }
        return selected ?? fallback ?? (this.mode !== undefined || SAFE.has(tool) || tool === "read" || tool === "powershell" && this.environment === "sandbox" ? "allow" : "ask");
    }
    private restoreRefusals(manager: ReadonlySessionManager): void {
        if (!manager.isHistoryConsistent()) throw new Error(BLOCKED + "Permission history is uncertain; reload the session before continuing");
        const generation = manager.getHistoryGeneration();
        if (this.refusalManager?.deref() !== manager || this.refusalGeneration !== generation) {
            this.denied.clear(); this.refusalCursor = 0;
            this.refusalManager = new WeakRef(manager); this.refusalGeneration = generation;
        }
        this.refusalCursor = manager.visitAppendedEntries(this.refusalCursor, this);
    }
    /** Stable append visitor; ordinary transcript entries do no allocation or branch copying. */
    visitSessionEntry(entry: SessionEntry): void {
        if (entry.type !== "custom") return;
        const kind = entry.customType;
        if (kind !== "native-permission-denial-v1" && kind !== "native-permission-denial-v2" && kind !== "native-permission-revocation-v1") return;
        const data = entry.data as Partial<PermissionRefusal> | undefined;
        if (!data || typeof data.key !== "string" || !REFUSAL_KEY.test(data.key)) throw new Error(BLOCKED + "Invalid permission history record");
        if (kind === "native-permission-revocation-v1") {
            if ((entry.data as { source?: string }).source !== "user-command") throw new Error(BLOCKED + "Invalid permission revocation source");
            this.denied.delete(data.key); return;
        }
        if (this.denied.size >= MAX_REFUSALS && !this.denied.has(data.key)) throw new Error(BLOCKED + "Refusal capacity reached; use /permissions refusals or start a new session");
        if (kind === "native-permission-denial-v1") {
            this.denied.set(data.key, Object.freeze({ key: data.key, source: "legacy", summary: "历史拒绝记录：无法区分明确拒绝、取消或超时" }));
        } else {
            if (data.source !== "explicit" || typeof data.summary !== "string" || data.summary.length > MAX_REFUSAL_SUMMARY
                || data.reason !== undefined && (typeof data.reason !== "string" || data.reason.length > MAX_REFUSAL_REASON)) throw new Error(BLOCKED + "Invalid explicit refusal record");
            this.denied.set(data.key, Object.freeze({ key: data.key, source: "explicit", summary: data.summary, reason: data.reason }));
        }
    }
    listRefusals(ctx: ExtensionContext): readonly PermissionRefusal[] {
        this.guard(ctx)(); this.restoreRefusals(ctx.sessionManager);
        return Array.from(this.denied.values());
    }
    revokeRefusal(ctx: ExtensionContext, key: string): boolean {
        this.guard(ctx)(); this.restoreRefusals(ctx.sessionManager);
        if (!this.denied.has(key)) return false;
        this.runtime.appendEntry("native-permission-revocation-v1", { key, source: "user-command" });
        this.denied.delete(key);
        return true;
    }
    private restoreHistory(ctx: ExtensionContext): void {
        this.restoreRefusals(ctx.sessionManager);
        const manager = ctx.sessionManager, leaf = manager.getLeafEntry(), previous = this.scannedLeaf?.deref();
        if (leaf === previous && (leaf !== undefined || this.scannedLeaf === undefined)) return;
        let entry = leaf, legacy = false;
        while (entry && entry !== previous) {
            if (entry.type === "custom") {
                if (entry.customType === "session-permission-state-v1") legacy = true;
            }
            entry = entry.parentId ? manager.getEntry(entry.parentId) : undefined;
        }
        // Branch replacement must recompute legacy state; only an actual ancestor may reuse it.
        this.legacyHistory = legacy || entry !== undefined && entry === previous && this.legacyHistory;
        this.scannedLeaf = leaf ? new WeakRef(leaf) : undefined;
    }
    async authorize(event: ToolCallEvent, ctx: ExtensionContext, definition?: ToolDefinition, explicitUserCommand = false): Promise<NativePolicyInvocation> {
        const check = this.guard(ctx); check();
        const invocation = new NativePolicyInvocation(event, check, ctx);
        if (this.environment === "sandbox" && (!definition || !this.supports(definition)))
            throw new Error("[SANDBOX_UNSUPPORTED] This entry has no sandbox backend: " + event.toolName);
        const mutation = isMutation(event.toolName, event.input);
        if (this.mode === "read-only" && mutation) throw new Error(BLOCKED + "当前为只读模式；请通过 /permissions 选择沙箱读写");
        // Legacy audits do not contain exact request identities. Never reinterpret
        // their grants or erase a historical rejection by guessing an equivalent rule.
        this.restoreHistory(ctx);
        if (this.mode === undefined && this.legacyHistory && !SAFE.has(event.toolName) && event.toolName !== "read")
            throw new Error("[LEGACY_PERMISSION_MIGRATION] Historical grants cannot be widened by a new profile. Start a new session with explicit execution rules; history remains unchanged.");
        if (this.runtime.executionBoundary.getToolSelectionMode() === "plan" && (mutation || event.toolName === "powershell" || event.toolName === "bash" || event.toolName === "browser_exec"))
            throw new Error(BLOCKED + "Plan mode does not authorize execution or mutations");
        const input = event.input as Record<string, any>, targets: string[] = [];
        if (event.toolName === "file_batch") {
            if (!Array.isArray(input.operations) || !input.operations.length || input.operations.length > 16) throw new Error(BLOCKED + "Invalid file batch");
            for (const item of input.operations) {
                targets.push(this.environment === "trusted-host" && (item.operation === "write" || item.operation === "edit") && typeof item.path === "string"
                    ? resolveToolPath(ctx.cwd, item.path) : item.path);
                if (item.destination !== undefined) targets.push(item.destination);
            }
        } else if (event.toolName === "lsp_fix") {
            targets.push(resolve(ctx.cwd, typeof input.root === "string" && input.root.trim() ? input.root : ".", input.path));
        } else if (SEARCHES.has(event.toolName)) targets.push(input.path ?? ".");
        else if (mutation || event.toolName === "read") {
            targets.push(this.environment === "trusted-host" && (event.toolName === "write" || event.toolName === "edit") && typeof input.path === "string"
                ? resolveToolPath(ctx.cwd, input.path) : input.path);
            if (input.destination !== undefined) targets.push(input.destination);
        }
        // Match the host tool's interpretation before checking rules. Sandbox paths
        // retain their workspace-relative grammar; native mutations own their resolver.
        if (this.environment === "trusted-host" && targets.length && (event.toolName === "read" || SEARCHES.has(event.toolName))) {
            targets[0] = event.toolName === "read" ? await resolveReadPathAsync(targets[0]!, ctx.cwd) : resolveToCwd(targets[0] || ".", ctx.cwd);
            check();
        }
        const delegation = event.toolName === "subagent" || event.toolName === "structured_readonly_command"
            ? await prepareNativeDelegation(event.toolName, input, ctx.cwd, this.runtime.executionBoundary.getToolSelectionMode() === "plan") : undefined;
        check();
        const resolved = delegation ? undefined : await this.paths(ctx, targets, mutation, event.toolName); check();
        const paths = delegation?.paths ?? resolved!.paths;
        const host = mutation && this.mode === "host-write" ? await assessHostMutations(resolved!.workspaces, paths, event.toolName, input) : undefined; check();
        if (host?.forbidden) this.refuse(ctx, BLOCKED, `敏感目标禁止删除或移出：${host.forbidden}\n操作未执行，请明确告知用户。`);
        let decision = await this.decision(event.toolName, input.command, paths, ctx.cwd, explicitUserCommand ? "allow" : undefined); check();
        if (event.toolName === "file_batch") {
            let index = 0;
            for (const item of input.operations) {
                const count = item.destination === undefined ? 1 : 2;
                const itemDecision = await this.decision(item.operation, undefined, paths.slice(index, index + count), ctx.cwd, decision); check();
                if (itemDecision === "deny" || decision !== "deny" && itemDecision === "ask") decision = itemDecision;
                index += count;
            }
        }
        const keys: string[] = [];
        const session = ctx.sessionManager.getSessionId();
        if (mutation) {
            const items = event.toolName === "file_batch" ? input.operations : [{ ...input, operation: event.toolName }];
            let index = 0;
            for (const item of items) {
                const target = paths[index++], destination = item.destination === undefined ? undefined : paths[index++];
                // One rejected batch also refuses its unchanged individual operations.
                const hash = mutationRequestHash(item.operation, { ...item, path: target, destination, purpose: undefined });
                keys.push(fingerprint([session, item.operation, hash]));
            }
        } else keys.push(fingerprint([session, event.toolName, invocationFingerprint(event.toolName, input)]));
        if (decision === "deny" || keys.some(key => this.denied.has(key))) throw new Error(BLOCKED + "Explicitly denied operation");
        if (host?.externalOverwrite) this.refuse(ctx, "[EXTERNAL_FILE_WRITE_BLOCKED] ",
            `禁止覆盖或编辑工作区外已有文件：${host.externalOverwrite}\n操作未执行。请停止当前任务并告知用户，等待下一步指令。`);
        if (host?.ask) decision = "ask";
        if (decision === "ask") {
            if (this.approval === "never" || !ctx.hasUI) throw new Error("[APPROVAL_REQUIRED] Operation was not executed: " + event.toolName);
            const details = mutation ? host?.details || paths.join("\n") : JSON.stringify(input, null, 2);
            if (details.length > 16384) throw new Error("[APPROVAL_REQUIRED] Request is too large for one interactive review; configure an explicit scoped rule");
            const signal = ctx.signal ?? this.runtime.executionBoundary.signal;
            const selected = await ctx.ui.select("允许这次操作？", APPROVAL_CHOICES,
                { signal, timeout: APPROVAL_TIMEOUT_MS, kind: "permission", details: `${event.toolName} (${this.environment})\ncwd: ${ctx.cwd}\n${details}` });
            check();
            if (selected !== APPROVAL_CHOICES[0] && selected !== APPROVAL_CHOICES[1] && selected !== APPROVAL_CHOICES[2])
                throw new Error("[APPROVAL_CANCELLED] Operation was not executed; this request may be asked again");
            if (selected !== APPROVAL_CHOICES[0]) {
                let reason: string | undefined;
                if (selected === APPROVAL_CHOICES[2]) {
                    const value = await ctx.ui.input("拒绝原因（仅记录本次明确拒绝）", undefined, { signal, timeout: APPROVAL_TIMEOUT_MS });
                    check();
                    if (value === undefined) throw new Error("[APPROVAL_CANCELLED] Refusal explanation was cancelled; operation was not executed");
                    reason = value.trim().slice(0, MAX_REFUSAL_REASON) || undefined;
                }
                invocation.consume(event.input, event.toolCallId, event.toolName, ctx.signal);
                if (this.denied.size + keys.length > MAX_REFUSALS) throw new Error(BLOCKED + "Refusal capacity reached; use /permissions refusals or start a new session");
                let pathIndex = 0;
                for (let index = 0; index < keys.length; index++) {
                    const key = keys[index]!, item = event.toolName === "file_batch" ? input.operations[index] : undefined;
                    const summary = item ? `${item.operation}\n${paths[pathIndex++]}${item.destination === undefined ? "" : " → " + paths[pathIndex++]}`
                        : `${event.toolName}\ncwd: ${ctx.cwd}\n${details}`;
                    const record: PermissionRefusal = Object.freeze({ key, source: "explicit", summary: summary.slice(0, MAX_REFUSAL_SUMMARY), reason });
                    this.denied.set(key, record); this.runtime.appendEntry("native-permission-denial-v2", record);
                }
                throw new Error(BLOCKED + "User declined this operation" + (reason ? ": " + reason : ""));
            }
        }
        invocation.consume(event.input, event.toolCallId, event.toolName, ctx.signal);
        if (delegation?.subagent) attachSubagentWorkspaceDelegation(input, { schemaVersion: 1, sequence: this.runtime.executionBoundary.generation,
            toolCallId: event.toolCallId, grants: delegation.subagent, assertCurrent: check, revocationSignal: ctx.signal ?? this.runtime.executionBoundary.signal });
        if (delegation?.structured) attachStructuredReadonlyWorkspaceDelegation(input, { ...delegation.structured, schemaVersion: 1,
            sequence: this.runtime.executionBoundary.generation, toolCallId: event.toolCallId, requestHash: structuredReadonlyRequestHash(input),
            assertCurrent: check, revocationSignal: ctx.signal ?? this.runtime.executionBoundary.signal });
        if (event.toolName === "browser_exec") attachBrowserExecAuthorization(input, { schemaVersion: 1, sequence: this.runtime.executionBoundary.generation,
            toolCallId: event.toolCallId, requestHash: browserExecRequestHash(input), assertCurrent: check, revocationSignal: ctx.signal ?? this.runtime.executionBoundary.signal });
        if (this.environment === "trusted-host" && (event.toolName === "read" || SEARCHES.has(event.toolName)))
            attachToolPath(input, event.toolName, event.toolCallId, paths[0]!, check);
        if (mutation) attachPermissionPathApproval(input, { schemaVersion: 1, sequence: this.runtime.executionBoundary.generation,
            toolCallId: event.toolCallId, operation: event.toolName as PermissionPathApproval["operation"],
            requestHash: mutationRequestHash(event.toolName as PermissionPathApproval["operation"], input), canonicalTarget: paths[0]!,
            canonicalPaths: paths, newExternalFiles: host?.newExternalFiles,
            protectedRoots: [resolve(ctx.cwd, ".git"), resolve(ctx.cwd, ".sp")], assertCurrent: check, revocationSignal: ctx.signal ?? this.runtime.executionBoundary.signal });
        return invocation;
    }
    async authorizeFileObservation(ctx: ExtensionContext, targets: readonly string[]) {
        const check = this.guard(ctx);
        const { paths } = await this.paths(ctx, targets, false); check();
        const decision = await this.decision("read", undefined, paths, ctx.cwd); check();
        if (decision !== "allow") throw new Error(BLOCKED + "File observation requires an existing read grant");
        const renew = async () => { check(); await this.paths(ctx, targets, false); check(); };
        return Object.assign(renew, { assertCurrent: check });
    }
    async prepareInputRead(ctx: ExtensionContext, targets: readonly string[]): Promise<InputReadPolicyLease> {
        await this.authorizeFileObservation(ctx, targets);
        return new InputReadPolicyLease(ctx, targets, this.guard(ctx));
    }
    async prepareInputWorkspaceRead(ctx: ExtensionContext, targets: readonly string[]): Promise<InputWorkspaceGrantLease> {
        const check = this.guard(ctx); await this.authorizeFileObservation(ctx, targets); check();
        const canonical = await realpath(ctx.cwd), stat = await lstat(canonical, { bigint: true }); check();
        const id = ctx.sessionManager.getSessionId();
        if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(BLOCKED + "Workspace is not an ordinary directory");
        if (!this.grant || this.sessionId !== id || this.workspace !== ctx.cwd) {
            this.grant = Object.freeze({ requestedPath: canonical, canonicalPath: canonical, device: Number(stat.dev), inode: Number(stat.ino) });
            this.issuance = Object.freeze({ ...this.grant, identity: Object.freeze({ dev: stat.dev, ino: stat.ino }) });
            this.sessionId = id; this.workspace = ctx.cwd;
        }
        if (this.issuance!.identity.dev !== stat.dev || this.issuance!.identity.ino !== stat.ino) throw new Error(BLOCKED + "Original workspace changed");
        const lease = new InputWorkspaceGrantLease(ctx, targets, this, this.grant, -1, check,
            SessionExecutionPolicy.assertWorkspace, SessionExecutionPolicy.observeWorkspace, this.issuance);
        try { return await lease.prepare(); } catch (error) { lease.dispose(); throw error; }
    }
    private static readonly assertWorkspace: AssertInputWorkspace = (issuer, grant, slot, binding, paths, issuance) => {
        const owner = issuer as SessionExecutionPolicy;
        if (owner.grant !== grant || owner.issuance !== issuance || slot !== -1 || grant.canonicalPath !== binding.canonicalPath
            || issuance?.identity.dev !== binding.identity.dev || issuance.identity.ino !== binding.identity.ino)
            throw new Error(BLOCKED + "Workspace grant changed");
        // A frozen array's iterator was visible in the allocation profile at
        // every pure ownership check; indexed access creates no iterator.
        for (let index = 0; index < paths.length; index++) {
            const target = paths[index]!;
            if (!insideCanonical(binding.canonicalPath, target) && !insideCanonical(owner.workspace, target))
                throw new Error(BLOCKED + "Workspace scope changed");
        }
    };
    private static readonly observeWorkspace: ObserveInputWorkspace = async (issuer, ctx, _grant, binding, paths, check) => {
        const owner = issuer as SessionExecutionPolicy;
        await owner.paths(ctx, paths, false); check();
        const canonical = await realpath(binding.requestedPath), stat = await lstat(canonical, { bigint: true }); check();
        if (canonical !== binding.canonicalPath || !stat.isDirectory() || stat.dev !== binding.identity.dev || stat.ino !== binding.identity.ino)
            throw new Error(BLOCKED + "Original workspace directory changed");
    };
}
