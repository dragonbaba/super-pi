import { createHash } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { assertPermissionMode, isHostPermissionMode, isRestrictedHostMode, type SessionPermissionMode } from "./permission-mode.ts";
import { AutoReviewBreaker, runAutoReview } from "./auto-review.ts";
import { WORKSPACE_TOOL_NAMES } from "./session-execution-profile.ts";
import type { ExtensionContext, ExtensionRuntime, ToolCallEvent, ToolDefinition } from "./extensions/types.ts";
import type { ReadonlySessionManager, SessionEntry, SessionEntryVisitor } from "./session-manager.ts";
import { assessCanonicalMutationPath, canonicalizeProspectivePath, canonicalWorkspaceMetadata } from "./files/protected-path-policy.ts";
import { assessHostMutations } from "./files/host-mutation-policy.ts";
import { inspectNativeShellMutations, type NativeShellMutations } from "./shell-policy/native-mutations.ts";
import { classifyHostShellCommand, findNonReadOnlyShellSegment, HOST_SHELL_FILE_COMMANDS, HOST_SHELL_OTHER, HOST_SHELL_READ_ONLY,
    HOST_SHELL_RULE_ALLOWED, type HostShellCommandClass, shellRuleVerdict, suggestShellRules } from "./shell-policy/readonly-command.ts";
import { type ProjectPermissionRule, type ProjectPermissionStore, RULE_ALLOW, RULE_ASK, RULE_DENY,
    RULE_NONE } from "./project-permissions.ts";
import { ShellAnalysisOwner } from "./shell-policy/shell-analysis.ts";
import { prepareShellCwd } from "./tools/shell-cwd.ts";
import { attachPermissionPathApproval, mutationRequestHash, type PermissionPathApproval } from "./files/file-invocation.ts";
import { InputReadPolicyLease } from "./files/session-input-read-permission.ts";
import { resolveReadPathAsync, resolveToCwd } from "./tools/path-utils.ts";
import { attachToolPath } from "./files/tool-path-authorization.ts";
import { resolveToolPath } from "./files/file-path.ts";
import { prepareNativeDelegation } from "./files/native-delegation.ts";
import { isParentExecutionTool } from "./files/subagent-execution.ts";
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
/** `outside`: a host tier accepted a path outside every workspace; host-restricted asks for it. */
interface ResolvedPolicyPaths { paths: string[]; workspaces: string[]; outside: boolean; }
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
const REMEMBER_CHOICE = "允许，并在本项目不再询问";
const REMEMBER_CHOICES = [APPROVAL_CHOICES[0]!, REMEMBER_CHOICE, APPROVAL_CHOICES[1]!, APPROVAL_CHOICES[2]!];
const AUTO_PAUSED_STATUS = "宿主机受限 · Auto 已暂停（改为询问）";
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
/**
 * Exact names and `*` as before, plus MCP server rules: `mcp__<server>` or a trailing glob such as
 * `mcp__<server>__*` / `mcp__<server>__get_*`. The server is spelled either as its configured ID or
 * as the normalized segment its tool names use; the rest of the pattern is matched against the tool
 * name after that segment. Server IDs may contain `__`, so a server rule and an allow glob are checked
 * against the definition's server identity, never inferred from the name. Ask/deny globs may be
 * broader (`mcp__*`). Prefixes are computed once at construction, so matching allocates nothing.
 */
type McpRuleIdentity = Pick<ToolDefinition, "mcpServer" | "mcpToolPrefix">;
/** The pattern before a trailing `*`, or the whole pattern when it has no glob. */
function ruleToolPrefix(pattern: string): string | undefined {
    if (!pattern.startsWith("mcp__")) return undefined;
    const glob = pattern.indexOf("*");
    if (glob < 0) return pattern;
    return glob === pattern.length - 1 ? pattern.slice(0, -1) : undefined;
}
/** `prefix` = `mcp__` + this server spelling, then nothing (exact) or `__` + a tool-name prefix. */
function serverScopedMatch(prefix: string, glob: boolean, tool: string, toolStart: number, spelling: string, start: number, length: number): boolean {
    const end = 5 + length;
    if (prefix.length < end || !sameChars(prefix, 5, spelling, start, length)) return false;
    if (prefix.length === end) return !glob; // `mcp__<server>*` also covers other servers' names.
    if (!prefix.startsWith("__", end)) return false;
    const rest = prefix.length - end - 2, available = tool.length - toolStart;
    return (glob ? available >= rest : available === rest) && sameChars(prefix, end + 2, tool, toolStart, rest);
}
function sameChars(left: string, leftStart: number, right: string, rightStart: number, length: number): boolean {
    for (let index = 0; index < length; index++) if (left.charCodeAt(leftStart + index) !== right.charCodeAt(rightStart + index)) return false;
    return true;
}

function isMutation(name: string, input: unknown): boolean {
    return MUTATIONS.has(name) || name === "lsp_fix" && (input as { write?: unknown } | null)?.write === true;
}

/**
 * Host-restricted defaults, below explicit rules: anything outside the workspaces asks; shell
 * commands run when read-only, or when they are file commands whose recognized targets are
 * all certain (and, by `outside`, inside); other shell commands and MCP tools ask.
 */
function restrictedFallback(tool: string, outside: boolean, shell: NativeShellMutations | undefined, shellClass: HostShellCommandClass,
    definition: McpRuleIdentity | undefined, projectAllowed: boolean): PermissionDecision | undefined {
    if (outside) return "ask";
    if (tool === "bash" || tool === "powershell") {
        if (shellClass === HOST_SHELL_READ_ONLY) return "allow";
        // A listed file command always yields targets; a rule-allowed program may have none to check.
        if (shellClass === HOST_SHELL_RULE_ALLOWED) return shell?.uncertain ? "ask" : "allow";
        return shellClass === HOST_SHELL_FILE_COMMANDS && shell !== undefined && !shell.uncertain ? "allow" : "ask";
    }
    // A project allow rule for the exact tool is the user's "不再询问".
    return definition?.mcpServer !== undefined ? projectAllowed ? "allow" : "ask" : undefined;
}

function describeRules(rules: readonly ProjectPermissionRule[]): string {
    let text = "";
    for (const rule of rules) text += `  ${rule.tool}${rule.command === undefined ? "" : ": " + rule.command}\n`;
    return text;
}

/** A delete (or a move, which deletes its source) by a file tool, a batch item or a recognized shell target. */
function deletes(tool: string, input: Record<string, any>, shell: NativeShellMutations | undefined): boolean {
    if (tool === "delete" || tool === "move") return true;
    if (tool === "file_batch") {
        for (const item of input.operations) if (item.operation === "delete" || item.operation === "move") return true;
        return false;
    }
    if (shell) for (const target of shell.targets) if (target.kind !== "write") return true;
    return false;
}

/** The request as the approval dialog and the Auto reviewer both show it. */
function askDetails(input: Record<string, any>, shell: NativeShellMutations | undefined, shellCwd: string | undefined,
    host: { details: string } | undefined, mutation: boolean, paths: readonly string[], destructiveMcp: boolean): string {
    return shell ? `cwd: ${shellCwd}\ncommand: ${input.command}\n${host!.details}`
        : mutation ? host?.details || paths.join("\n")
        : (destructiveMcp ? "MCP 工具声明了 destructiveHint，可能产生破坏性副作用。\n" : "") + JSON.stringify(input, null, 2);
}

/** A recognized shell write whose canonical target is an existing directory; `paths` is index-aligned with the targets. */
async function writesIntoDirectory(shell: NativeShellMutations, paths: readonly string[]): Promise<boolean> {
    for (let index = 0; index < shell.targets.length; index++) {
        if (shell.targets[index]!.kind !== "write") continue;
        try { if ((await lstat(paths[index]!)).isDirectory()) return true; } catch { /* A new path is the target itself. */ }
    }
    return false;
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
 * Consumes existing recognized mutation evidence; no command grammar or risk tiers here.
 * Configuration is immutable for this runtime; reload uses the execution barrier.
 */
export class SessionExecutionPolicy implements SessionEntryVisitor {
    readonly mode?: SessionPermissionMode;
    readonly environment: ExecutionEnvironment;
    private readonly runtime: ExtensionRuntime;
    private readonly rules: readonly ExecutionPermissionRule[];
    /** Per rule, index-aligned with `rules`: "" for an MCP name, the prefix of an MCP glob, else undefined. */
    private readonly rulePrefixes: readonly (string | undefined)[];
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
    /** Project-shared rules (R4), read before every authorization when the file changed. */
    private readonly project?: ProjectPermissionStore;
    /** host-auto only: rejections that hand the asks back to the user for this runtime. */
    private readonly autoReview?: AutoReviewBreaker;
    constructor(runtime: ExtensionRuntime, environment: ExecutionEnvironment, config: ExecutionPermissions = {}, mode?: SessionPermissionMode,
        directories: readonly string[] = [], project?: ProjectPermissionStore) {
        this.directories = directories;
        this.project = project;
        this.mode = mode;
        if (mode === "host-auto") this.autoReview = new AutoReviewBreaker();
        if (mode !== undefined) { assertPermissionMode(mode); if (isHostPermissionMode(mode) !== (environment === "trusted-host")) throw new Error("Permission mode and backend disagree"); }
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
        this.rulePrefixes = Object.freeze(this.rules.map(rule => ruleToolPrefix(rule.tool)));
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
    supports(definition: ToolDefinition): boolean {
        return this.environment !== "sandbox" || this.definitions.has(definition)
            || this.mode !== undefined && this.runtime.openSubagentExecution !== undefined && isParentExecutionTool(definition);
    }
    private guard(ctx: ExtensionContext, lifetimeSignal?: AbortSignal): () => void {
        this.runtime.executionBoundary.assertCurrent();
        const owner = new WeakRef(this), generation = this.epoch, signal = lifetimeSignal ?? ctx.signal ?? this.runtime.executionBoundary.signal;
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
    private async paths(ctx: ExtensionContext, targets: readonly string[], mutation: boolean, operation = "变更", enforceMutationRoots = true): Promise<ResolvedPolicyPaths> {
        const check = this.guard(ctx), output: string[] = [], host = isHostPermissionMode(this.mode);
        if (targets.length > 34) throw new Error(BLOCKED + "Too many paths");
        if (!targets.length) return { paths: output, workspaces: [], outside: false };
        const workspaces = [await realpath(ctx.cwd)], unavailable: string[] = []; check();
        let outside = false;
        for (const directory of this.directories) {
            let canonical: string | undefined;
            try { canonical = await realpath(directory); } catch { /* Keep unavailable grants closed without disabling unrelated host paths. */ }
            check();
            if (canonical !== directory) {
                if (!host) throw new Error(BLOCKED + "Additional workspace is unavailable or redirected: " + directory);
                unavailable.push(directory);
            } else workspaces.push(canonical);
        }
        const metadata = mutation && enforceMutationRoots ? await canonicalWorkspaceMetadata(workspaces) : undefined; check();
        for (const target of targets) {
            if (typeof target !== "string" || target.length > 4096 || target.includes("\0")) throw new Error(BLOCKED + "Invalid path");
            const absolute = resolve(ctx.cwd, target);
            // Guest-only files need not exist on the host; the worker owns their actual read validation.
            const canonical = mutation || this.environment === "sandbox" ? await canonicalizeProspectivePath(absolute) : await realpath(absolute); check();
            for (const directory of unavailable) {
                if (inside(directory, absolute) || inside(directory, canonical)) throw new Error(BLOCKED + "Additional workspace is unavailable or redirected: " + directory);
            }
            if (mutation && enforceMutationRoots) {
                const result = assessCanonicalMutationPath(workspaces, canonical, metadata);
                for (const violation of result.violations) {
                    if (violation !== "workspace_escape" || !host) {
                        this.refuse(ctx, BLOCKED, `禁止 ${operation}：${canonical}\n受保护或工作区外目标（${violation}）。操作未执行，请明确告知用户。`);
                    }
                    outside = true;
                }
                output.push(canonical);
            } else {
                let contained = false;
                for (const root of workspaces) if (inside(root, canonical)) { contained = true; break; }
                if (!contained) {
                    if (!host) throw new Error(BLOCKED + "Read is outside the workspace: " + target);
                    outside = true;
                }
                output.push(canonical);
            }
        }
        return { paths: output, workspaces, outside };
    }
    private async assessShellMutations(ctx: ExtensionContext, resolved: ResolvedPolicyPaths, shell: NativeShellMutations) {
        const check = this.guard(ctx), operations: { operation: string }[] = [];
        let metadata: string[] | undefined;
        for (let index = 0; index < shell.targets.length; index++) {
            const kind = shell.targets[index]!.kind, target = resolved.paths[index]!;
            if (kind === "delete") {
                metadata ??= await canonicalWorkspaceMetadata(resolved.workspaces); check();
                const assessment = assessCanonicalMutationPath(resolved.workspaces, target, metadata);
                for (const violation of assessment.violations) if (violation !== "workspace_escape")
                    this.refuse(ctx, BLOCKED, `敏感目标禁止删除：${target}\n受保护目标（${violation}）。操作未执行，请明确告知用户。`);
            }
            operations.push({ operation: kind });
        }
        // Existing directory markers (e.g. git's .git) are not evidence of an existing-file overwrite.
        const host = operations.length ? await assessHostMutations(resolved.workspaces, resolved.paths, "file_batch", { operations }, true)
            : { ask: false, details: "" };
        check();
        if (shell.uncertain) { host.ask = true; host.details += "已识别变更，但既有分析结果不能确认全部目标；请核对原命令。\n"; }
        return host;
    }
    private async decision(tool: string, command: unknown, paths: readonly string[], cwd: string, fallback?: PermissionDecision, mcp?: McpRuleIdentity): Promise<PermissionDecision> {
        let selected: PermissionDecision | undefined;
        for (let index = 0; index < this.rules.length; index++) {
            const rule = this.rules[index]!;
            if (!this.ruleMatches(index, tool, mcp) || rule.command !== undefined && rule.command !== command) continue;
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
    /**
     * The project allow rules that "不再询问" saves for this request, or undefined when saving
     * them would not stop the ask (an explicit ask rule, or a command structure no rule covers).
     */
    private async rememberableRules(tool: string, command: unknown, paths: readonly string[], cwd: string,
        definition: McpRuleIdentity | undefined): Promise<ProjectPermissionRule[] | undefined> {
        if (!this.project || await this.decision(tool, command, paths, cwd, "allow", definition) !== "allow") return undefined;
        if (tool !== "bash" && tool !== "powershell") return [{ tool, decision: "allow" }];
        const suggestions = typeof command === "string" ? suggestShellRules(tool, command) : undefined;
        if (!suggestions) return undefined;
        const rules: ProjectPermissionRule[] = [];
        for (const rule of suggestions) rules.push({ tool, decision: "allow", command: rule });
        return rules;
    }
    /** An explicit ask rule covers this request (or a batch item), apart from the defaults. */
    private async ruleAsks(tool: string, input: Record<string, any>, paths: readonly string[], cwd: string,
        definition: McpRuleIdentity | undefined): Promise<boolean> {
        if (await this.decision(tool, input.command, paths, cwd, "allow", definition) === "ask") return true;
        if (tool !== "file_batch") return false;
        let index = 0;
        for (const item of input.operations) {
            const count = item.destination === undefined ? 1 : 2;
            if (await this.decision(item.operation, undefined, paths.slice(index, index + count), cwd, "allow") === "ask") return true;
            index += count;
        }
        return false;
    }
    /** One Auto review; a rejection or any review failure leaves the operation unexecuted. */
    private async autoApprove(ctx: ExtensionContext, tool: string, request: string, check: () => void): Promise<void> {
        if (request.length > 16384) throw new Error("[APPROVAL_REQUIRED] Request is too large for one review; configure an explicit scoped rule");
        const verdict = await runAutoReview(this.runtime, ctx, request, ctx.signal ?? this.runtime.executionBoundary.signal);
        // A cancelled turn or a stale permission context is not the reviewer's rejection.
        check();
        const tripped = this.autoReview!.record(verdict.approved);
        if (ctx.hasUI) {
            ctx.ui.notify(`Auto 审查${verdict.approved ? "批准" : "拒绝"}：${tool}${verdict.reason ? " — " + verdict.reason : ""}`, verdict.approved ? "info" : "warning");
            if (tripped) {
                ctx.ui.setStatus("permissions", AUTO_PAUSED_STATUS);
                ctx.ui.notify("Auto 审查连续拒绝 3 次或最近 50 次中拒绝 10 次，本次运行改回人工询问；重新选择 /permissions 可恢复。", "warning");
            }
        }
        if (!verdict.approved) throw new Error("[AUTO_REVIEW_DENIED] Auto review rejected this operation; it was not executed"
            + (verdict.reason ? ": " + verdict.reason : "") + ". Do not retry it in another form; tell the user or take an approach that needs no approval.");
    }
    /** Project rules for `/permissions rules`; undefined when this session has no project store. */
    describeProjectRules(): ReturnType<ProjectPermissionStore["describe"]> | undefined {
        return this.project?.describe();
    }
    /** An allow rule that names this tool or its MCP server, not the catch-all `*`. */
    private namedAllow(tool: string, mcp: McpRuleIdentity | undefined): boolean {
        for (let index = 0; index < this.rules.length; index++) {
            const rule = this.rules[index]!;
            if (rule.decision === "allow" && rule.tool !== "*" && rule.command === undefined && rule.path === undefined && this.ruleMatches(index, tool, mcp)) return true;
        }
        return false;
    }
    private ruleMatches(index: number, tool: string, mcp: McpRuleIdentity | undefined): boolean {
        const rule = this.rules[index]!, pattern = rule.tool, prefix = this.rulePrefixes[index];
        if (pattern === "*" || pattern === tool) return true;
        if (prefix === undefined) return false;
        const glob = prefix.length !== pattern.length, server = mcp?.mcpServer, toolPrefix = mcp?.mcpToolPrefix;
        if (server !== undefined && toolPrefix !== undefined && tool.startsWith(toolPrefix)) {
            const toolStart = toolPrefix.length;
            if (serverScopedMatch(prefix, glob, tool, toolStart, server, 0, server.length)
                || serverScopedMatch(prefix, glob, tool, toolStart, toolPrefix, 5, toolStart - 7)) return true;
        }
        // Any other glob may span servers, so only an ask or deny applies it.
        return glob && rule.decision !== "allow" && tool.startsWith(prefix);
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
        const plan = this.runtime.executionBoundary.getToolSelectionMode() === "plan";
        if (plan && (mutation || event.toolName === "browser_exec"))
            throw new Error(BLOCKED + "Plan mode does not authorize execution or mutations");
        const input = event.input as Record<string, any>, targets: string[] = [];
        if (plan && (event.toolName === "bash" || event.toolName === "powershell")) {
            const blocked = findNonReadOnlyShellSegment(event.toolName, typeof input?.command === "string" ? input.command : "",
                this.runtime.executionBoundary.getReadOnlyShellSubcommands());
            if (blocked !== undefined) throw new Error(BLOCKED + "Plan mode runs only read-only commands; this one is not: " + blocked);
        }
        const project = this.project ? await this.project.refresh() : undefined; check();
        const projectWarning = this.project?.takeWarning();
        if (projectWarning && ctx.hasUI) ctx.ui.notify(projectWarning, "warning");
        const restricted = isRestrictedHostMode(this.mode);
        const shellTool = event.toolName === "bash" || event.toolName === "powershell";
        const hostShell = isHostPermissionMode(this.mode) && shellTool;
        const shellBinding = hostShell ? await prepareShellCwd(input, ctx.cwd) : undefined; check();
        const shellCwd = hostShell ? shellBinding?.canonical ?? await realpath(ctx.cwd) : undefined; check();
        let shell: NativeShellMutations | undefined, shellClass: HostShellCommandClass = HOST_SHELL_OTHER;
        const shellRules = shellTool && typeof input?.command === "string" && project?.hasShellRules(event.toolName === "powershell") ? project : undefined;
        let projectVerdict = project ? project.toolDecision(event.toolName) : RULE_NONE;
        if (hostShell) {
            const tool = event.toolName as "bash" | "powershell";
            // Host-restricted classification and project rules read the mutation analysis's token table.
            const owner = (restricted || shellRules) && typeof input.command === "string" ? new ShellAnalysisOwner(input.command, shellCwd!, this.epoch, tool) : undefined;
            try {
                shell = inspectNativeShellMutations(tool, input, shellCwd!, this.epoch, owner);
                if (restricted && owner) shellClass = classifyHostShellCommand(tool, input.command, owner, shellRules);
                if (shellRules) projectVerdict = Math.max(projectVerdict, shellRuleVerdict(tool, input.command, shellRules, owner));
            } finally { owner?.release(); }
        } else if (shellRules) projectVerdict = Math.max(projectVerdict, shellRuleVerdict(event.toolName as "bash" | "powershell", input.command, shellRules));
        if (shell) for (const target of shell.targets) targets.push(target.target);
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
            ? await prepareNativeDelegation(event.toolName, input, ctx.cwd, this.mode === "read-only" || plan) : undefined;
        check();
        // A delegated workspace outside the session's is outside access too, so host-restricted checks it.
        const delegated = delegation && (this.environment === "sandbox" || restricted) ? await this.paths(ctx, delegation.paths, false) : undefined; check();
        const resolved = delegation ? undefined : await this.paths(ctx, targets, mutation || shell !== undefined, event.toolName, shell === undefined); check();
        const paths = delegation?.paths ?? resolved!.paths;
        const host = shell ? await this.assessShellMutations(ctx, resolved!, shell)
            : mutation && isHostPermissionMode(this.mode) ? await assessHostMutations(resolved!.workspaces, paths, event.toolName, input) : undefined; check();
        if (host?.forbidden) this.refuse(ctx, BLOCKED, `敏感目标禁止删除或移出：${host.forbidden}\n操作未执行，请明确告知用户。`);
        const projectToolAllow = project?.toolDecision(event.toolName) === RULE_ALLOW;
        let fallback = explicitUserCommand ? "allow"
            : restricted ? restrictedFallback(event.toolName, (resolved ?? delegated)?.outside === true, shell, shellClass, definition, projectToolAllow) : undefined;
        // Only an ask that a project allow rule could lift offers "不再询问": not outside paths, uncertain targets or writes into directories.
        let liftable = restricted && fallback === "ask" && (resolved ?? delegated)?.outside !== true
            && (shellTool ? shellClass === HOST_SHELL_OTHER : definition?.mcpServer !== undefined);
        // `cp a.txt dir/` writes `dir/a.txt`, which the recognized target `dir` does not show
        // (it may be a link out of the workspace), so a write into an existing directory asks,
        // with or without a saved rule.
        if ((fallback === "allow" || liftable) && restricted && shell && await writesIntoDirectory(shell, paths)) { fallback = "ask"; liftable = false; }
        check();
        let decision = await this.decision(event.toolName, input.command, paths, ctx.cwd, fallback, definition); check();
        if (event.toolName === "file_batch") {
            let index = 0;
            for (const item of input.operations) {
                const count = item.destination === undefined ? 1 : 2;
                const itemDecision = await this.decision(item.operation, undefined, paths.slice(index, index + count), ctx.cwd, decision); check();
                if (itemDecision === "deny" || decision !== "deny" && itemDecision === "ask") decision = itemDecision;
                // Each operation also answers to the project rules for its own tool.
                const itemVerdict = project ? project.toolDecision(item.operation) : RULE_NONE;
                if (itemVerdict > projectVerdict) projectVerdict = itemVerdict;
                index += count;
            }
        }
        // Project rules rank like explicit ones (deny > ask > allow); their allow only lifts the fallbacks above.
        if (projectVerdict === RULE_DENY) decision = "deny";
        else if (projectVerdict === RULE_ASK && decision === "allow") decision = "ask";
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
        if (host?.externalOverwrite) {
            void this.runtime.executionBoundary.pauseForUser();
            this.refuse(ctx, "[EXTERNAL_FILE_WRITE_BLOCKED] ",
                `禁止覆盖或编辑工作区外已有文件：${host.externalOverwrite}\n操作未执行。当前整轮任务已暂停，请告知用户并等待下一步指令。`);
        }
        if (host?.ask) decision = "ask";
        // Like Codex, a declared destructive MCP tool asks even when its other hints look harmless.
        // A rule naming the tool or its server is the user's explicit standing approval.
        const destructiveMcp = decision === "allow" && definition?.mcpDestructive === true && !explicitUserCommand && !this.namedAllow(event.toolName, definition)
            && !projectToolAllow;
        if (destructiveMcp) decision = "ask";
        // host-auto: the session model answers an ordinary ask in the user's place; explicit ask
        // rules and deletes outside the workspaces stay with the user, as does a tripped breaker.
        if (decision === "ask" && this.autoReview && !this.autoReview.tripped && this.approval !== "never"
            && !((resolved ?? delegated)?.outside === true && deletes(event.toolName, input, shell))
            && projectVerdict !== RULE_ASK && !await this.ruleAsks(event.toolName, input, paths, ctx.cwd, definition)) {
            check();
            await this.autoApprove(ctx, event.toolName, `${event.toolName} (${this.environment})\ncwd: ${ctx.cwd}\n`
                + askDetails(input, shell, shellCwd, host, mutation, paths, destructiveMcp), check);
            decision = "allow";
        }
        if (decision === "ask") {
            if (this.approval === "never" || !ctx.hasUI) throw new Error("[APPROVAL_REQUIRED] Operation was not executed: " + event.toolName);
            const details = askDetails(input, shell, shellCwd, host, mutation, paths, destructiveMcp);
            if (details.length > 16384) throw new Error("[APPROVAL_REQUIRED] Request is too large for one interactive review; configure an explicit scoped rule");
            const remembered = liftable && !host?.ask && projectVerdict === RULE_NONE
                ? await this.rememberableRules(event.toolName, input.command, paths, ctx.cwd, definition) : undefined;
            check();
            const signal = ctx.signal ?? this.runtime.executionBoundary.signal;
            const selected = await ctx.ui.select("允许这次操作？", remembered ? REMEMBER_CHOICES : APPROVAL_CHOICES,
                { signal, timeout: APPROVAL_TIMEOUT_MS, kind: "permission", details: `${event.toolName} (${this.environment})\ncwd: ${ctx.cwd}\n${details}`
                    + (remembered ? `\n选择“${REMEMBER_CHOICE}”会在本项目保存：\n${describeRules(remembered)}` : "") });
            check();
            if (selected !== APPROVAL_CHOICES[0] && selected !== APPROVAL_CHOICES[1] && selected !== APPROVAL_CHOICES[2] && (!remembered || selected !== REMEMBER_CHOICE))
                throw new Error("[APPROVAL_CANCELLED] Operation was not executed; this request may be asked again");
            if (selected === REMEMBER_CHOICE) {
                try {
                    await this.project!.remember(remembered!);
                    ctx.ui.notify("已保存到本项目权限规则，可用 /permissions rules 查看：\n" + describeRules(remembered!), "info");
                } catch (error) {
                    ctx.ui.notify("未能保存项目权限规则，本次仍按允许执行：" + (error instanceof Error ? error.message : String(error)), "warning");
                }
                check();
            } else if (selected !== APPROVAL_CHOICES[0]) {
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
        shellBinding?.setAuthority(check);
        invocation.consume(event.input, event.toolCallId, event.toolName, ctx.signal);
        if (delegation?.subagent) {
            const signal = this.runtime.executionBoundary.signal;
            const open = this.runtime.openSubagentExecution;
            if (this.mode !== undefined && !open) throw new Error(BLOCKED + "Parent execution channel is unavailable");
            attachSubagentWorkspaceDelegation(input, { schemaVersion: 1, sequence: this.runtime.executionBoundary.generation,
                toolCallId: event.toolCallId, grants: delegation.subagent, assertCurrent: this.guard(ctx, signal), revocationSignal: signal,
                parentExecution: this.mode && open ? { profile: { mode: this.mode, workspace: delegation.workspace,
                    directories: this.directories, generation: this.runtime.executionBoundary.generation }, open } : undefined });
        }
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
        // A project read rule binds observation as an explicit one does; deny and ask both block it.
        const project = this.project ? await this.project.refresh() : undefined; check();
        if (decision !== "allow" || (project?.toolDecision("read") ?? RULE_NONE) >= RULE_ASK)
            throw new Error(BLOCKED + "File observation requires an existing read grant");
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
