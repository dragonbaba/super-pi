import { extname, isAbsolute, relative, resolve } from "node:path";

const MAX_OBLIGATIONS = 32;
const MAX_AUDIT_OBLIGATIONS = 16;
const MAX_LABEL_CHARS = 180;
const MAX_TOOL_TEXT_CHARS = 8_192;
const MAX_DRAFT_CHARS = 1_000_000;

export const FALSE_SUCCESS_GUARD_VERSION = "0.3.4-pi.84.2";
export const FALSE_SUCCESS_AUDIT_TYPE = "false-success-intervention-v1";

const COMPLETION_CLAIM_RE = /(?:已完成|完成了|已经完成|已修复|修复完成|已实现|实现完成|验证通过|测试通过|全部通过|成功完成|\bdone\b|\bcompleted\b|\bfixed\b|\bimplemented\b|all (?:tests|checks) pass(?:ed)?)/iu;
const INCOMPLETE_DISCLOSURE_RE = /(?:未完成|尚未完成|无法完成|仍(?:然)?(?:失败|存在|需要)|尚(?:未|需)|阻塞|被阻止|需要(?:用户|外部)|\bnot complete\b|\bincomplete\b|\bstill (?:failed|failing|blocked|remaining)\b|\bblocked\b|\bremaining\b|\bcould not\b|\bunable to\b)/iu;
const PARTIAL_MUTATION_RE = /partial[_ -]?mutation|"?statechanged"?\s*:\s*true/iu;
const LEADING_CD_RE = /^cd\s+((?:"[^"]*"|'[^']*'|\S+))\s*&&\s*/u;
const SHELL_OPERATOR_RE = /&&|\|\||;/u;
const NODE_TEST_RE = /^(?:"[^"]*[/\\])?(?:node(?:\.exe)?)"?\s+--test\b/u;
const TEST_COMMAND_RE = /^(?:npm|pnpm|yarn|bun)(?:\s+(?:--prefix|-c|--dir)\s+(?:"[^"]+"|\S+))*\s+(?:run\s+)?test\b|^(?:pytest|vitest|jest|cargo\s+test|go\s+test|dotnet\s+test|gradle\s+test|mvn\s+(?:test|verify))\b/u;
const NODE_TSC_RE = /^(?:"[^"]*[/\\])?(?:node(?:\.exe)?)"?\s+"?[^"]*[/\\]typescript[/\\]bin[/\\]tsc"?\b/u;
const TYPECHECK_COMMAND_RE = /^(?:tsc|typecheck|type-check|mypy|pyright|cargo\s+check|go\s+vet)\b/u;
const LINT_COMMAND_RE = /^(?:eslint|biome\s+(?:check|lint)|ruff\s+check|golangci-lint|cargo\s+clippy)\b|^(?:npm|pnpm|yarn|bun)(?:\s+(?:--prefix|-c|--dir)\s+(?:"[^"]+"|\S+))*\s+(?:run\s+)?lint\b/u;
const BUILD_COMMAND_RE = /^(?:npm|pnpm|yarn|bun)(?:\s+(?:--prefix|-c|--dir)\s+(?:"[^"]+"|\S+))*\s+(?:run\s+)?build\b|^(?:cargo|go|dotnet|gradle|mvnw?|cmake)\s+build\b/u;
const PACKAGE_PREFIX_RE = /^(?:npm|pnpm|yarn|bun)\s+(?:--prefix|-c|--dir)\s+("[^"]+"|'[^']+'|\S+)/u;
const POLICY_BLOCKED_RE = /policy[_ -]?blocked/iu;
const TIMEOUT_RE = /timed?\s*out|timeout/iu;
const PATH_NOT_FOUND_RE = /enoent|no such file|path not found/iu;
const COMMAND_FAILED_RE = /command exited with code|process exited with code/iu;
const WINDOWS_ABSOLUTE_RE = /^[a-z]:[/\\]/iu;

const MUTATION_TOOLS = new Set(["edit", "write", "lsp_fix"]);
const INITIAL_GOAL_MARKER = "pi-goal-prompt:";
const GOAL_OBJECTIVE_OPEN = "<goal_objective>";
const GOAL_ID_OPEN = "<goal_id>";

export type VerificationFamily = "test" | "typecheck" | "build" | "lint" | "diagnostics";
export type InterventionKind = "completion_replaced" | "goal_completion_blocked";
export type ObligationScopeKind = "target" | "package" | "workspace";

export interface CompletionObligation {
  key: string;
  kind: "verification" | "mutation" | "partial_mutation";
  tool: string;
  category: string;
  label: string;
  scopeKind: ObligationScopeKind;
  scopePath: string;
  target?: string;
}

export interface FalseSuccessState {
  obligations: Map<string, CompletionObligation>;
  interventions: number;
}

export interface FalseSuccessLifecycleState {
  pendingExplicitBoundary: boolean;
}

export interface ToolObservation {
  toolName: string;
  input: Record<string, unknown>;
  isError: boolean;
  text?: string;
  details?: unknown;
  cwd?: string;
}

export interface InterventionAudit {
  schemaVersion: 1;
  guardVersion: string;
  kind: InterventionKind;
  outcome: "blocked";
  category: "unverified_completion";
  tool: "assistant_message" | "goal_complete";
  model: string;
  obligationCount: number;
  obligations: Array<{
    kind: CompletionObligation["kind"];
    tool: string;
    category: string;
    scopeKind: ObligationScopeKind;
  }>;
  interventionSequence: number;
  draftChars?: number;
}

export interface CompletionIntervention {
  replacement: string;
  audit: InterventionAudit;
}

export interface GoalCompletionIntervention {
  reason: string;
  audit: InterventionAudit;
}

interface VerificationScope {
  family: VerificationFamily;
  kind: ObligationScopeKind;
  path: string;
}

export function createFalseSuccessState(): FalseSuccessState {
  return { obligations: new Map(), interventions: 0 };
}

export function createFalseSuccessLifecycleState(): FalseSuccessLifecycleState {
  return { pendingExplicitBoundary: false };
}

export function resetFalseSuccessState(state: FalseSuccessState): void {
  state.obligations.clear();
  state.interventions = 0;
}

export function observeInputBoundary(
  lifecycle: FalseSuccessLifecycleState,
  input: { source: "interactive" | "rpc" | "extension"; streamingBehavior?: "steer" | "followUp" },
): void {
  if (input.source !== "extension" && input.streamingBehavior !== "steer") {
    lifecycle.pendingExplicitBoundary = true;
  }
}

export function beginPromptBoundary(
  state: FalseSuccessState,
  lifecycle: FalseSuccessLifecycleState,
  prompt: string,
): boolean {
  const initialGoalPrompt = prompt.includes(INITIAL_GOAL_MARKER)
    && prompt.includes(GOAL_OBJECTIVE_OPEN)
    && prompt.includes(GOAL_ID_OPEN);
  if (!lifecycle.pendingExplicitBoundary && !initialGoalPrompt) return false;
  lifecycle.pendingExplicitBoundary = false;
  resetFalseSuccessState(state);
  return true;
}

export function observeToolResult(state: FalseSuccessState, observation: ToolObservation): string | undefined {
  const scope = verificationScope(observation.toolName, observation.input, observation.cwd);
  const target = mutationTarget(observation.toolName, observation.input, observation.cwd);
  const text = (observation.text ?? "").slice(0, MAX_TOOL_TEXT_CHARS);

  if (observation.isError) {
    if (scope) {
      const key = verificationKey(scope);
      const obligation = makeObligation(
        key,
        "verification",
        observation.toolName,
        classifyFailure(text),
        `${scope.family} verification failed`,
        scope.kind,
        scope.path,
      );
      setBounded(state.obligations, obligation);
      return undefined;
    }

    if (target) {
      const partial = detailsStateChanged(observation.details) || PARTIAL_MUTATION_RE.test(text);
      const key = `${partial ? "partial" : "mutation"}:${target}`;
      const obligation = makeObligation(
        key,
        partial ? "partial_mutation" : "mutation",
        observation.toolName,
        classifyFailure(text),
        partial ? `partial mutation may have changed ${displayTarget(target)}` : `mutation failed for ${displayTarget(target)}`,
        "target",
        target,
        target,
      );
      setBounded(state.obligations, obligation);
      return undefined;
    }
    return undefined;
  }

  if (scope) {
    state.obligations.delete(verificationKey(scope));
    clearCoveredMutationObligations(state, scope);
    return undefined;
  }

  if (target) {
    state.obligations.delete(`mutation:${target}`);
    // A successful same-target mutation repairs a failed operation. A previous
    // partial mutation still needs authoritative verification covering it.
  }
  return undefined;
}

export function completionIntervention(
  state: FalseSuccessState,
  assistantText: string,
  model = "unknown",
): CompletionIntervention | undefined {
  if (state.obligations.size === 0) return undefined;
  if (!COMPLETION_CLAIM_RE.test(assistantText) || INCOMPLETE_DISCLOSURE_RE.test(assistantText)) return undefined;
  state.interventions++;
  const lines = [
    "⚠️ 完成状态：尚未验证",
    "",
    "运行时未接受本次“已完成”声明，因为以下证据义务仍未关闭：",
  ];
  for (const item of state.obligations.values()) {
    const scope = `${item.scopeKind}:${bounded(item.scopePath)}`;
    lines.push(`- ${item.label} (${item.tool}, ${item.category}, ${scope})`);
  }
  lines.push(
    "",
    "需要在同一范围完成匹配验证，或明确报告任务尚未完成。下面保留模型原始汇报供检查，其中的完成声明不代表已经通过运行时验证。",
    "",
    "--- 模型原始汇报（未验证）---",
    assistantText,
  );
  return {
    replacement: lines.join("\n"),
    audit: makeAudit(
      state,
      "completion_replaced",
      "assistant_message",
      model,
      Math.min(assistantText.length, MAX_DRAFT_CHARS),
    ),
  };
}

export function completionReplacement(state: FalseSuccessState, assistantText: string): string | undefined {
  return completionIntervention(state, assistantText)?.replacement;
}

export function goalCompletionIntervention(
  state: FalseSuccessState,
  model = "unknown",
): GoalCompletionIntervention | undefined {
  if (state.obligations.size === 0) return undefined;
  state.interventions++;
  const audit = makeAudit(state, "goal_completion_blocked", "goal_complete", model);
  return {
    reason: JSON.stringify({
      ok: false,
      category: "unverified_completion",
      operation: "goal_complete",
      outcome: "blocked",
      retryable: true,
      stateChanged: false,
      obligationCount: audit.obligationCount,
      guardVersion: FALSE_SUCCESS_GUARD_VERSION,
    }),
    audit,
  };
}

export function verificationFamily(
  toolName: string,
  input: Record<string, unknown>,
): VerificationFamily | undefined {
  return verificationScope(toolName, input)?.family;
}

function verificationScope(
  toolName: string,
  input: Record<string, unknown>,
  cwd = process.cwd(),
): VerificationScope | undefined {
  const base = normalizeAbsolute(cwd, cwd);
  if (toolName === "lsp_diagnostics") return diagnosticsScope(input, base);
  if (toolName === "run_tests") return genericVerificationScope("test", input, base);
  if (toolName === "run_build") return genericVerificationScope("build", input, base);
  if (toolName === "run_linter") return genericVerificationScope("lint", input, base);
  if (toolName !== "bash" && toolName !== "powershell") return undefined;

  const command = typeof input.command === "string" ? input.command : "";
  return authoritativeShellVerificationScope(command, base);
}

function authoritativeShellVerificationScope(command: string, cwd: string): VerificationScope | undefined {
  // The verification command must determine the complete shell invocation's
  // exit status. A later `||`, `;`, or `&&` command can hide or replace that
  // status, so composite forms are not accepted as authoritative evidence.
  let remaining = command.trim();
  let segmentBase = cwd;
  let cdMatch = LEADING_CD_RE.exec(remaining);
  while (cdMatch) {
    segmentBase = normalizeAbsolute(unquote(cdMatch[1]!), segmentBase);
    remaining = remaining.slice(cdMatch[0].length).trim();
    cdMatch = LEADING_CD_RE.exec(remaining);
  }
  if (!remaining || SHELL_OPERATOR_RE.test(remaining)) return undefined;
  const family = familyForCommand(remaining.toLowerCase());
  if (!family) return undefined;
  const prefixMatch = PACKAGE_PREFIX_RE.exec(remaining);
  const packagePath = prefixMatch
    ? normalizeAbsolute(unquote(prefixMatch[1]!), segmentBase)
    : segmentBase;
  return { family, kind: "package", path: packagePath };
}

function diagnosticsScope(input: Record<string, unknown>, cwd: string): VerificationScope {
  const root = typeof input.root === "string" && input.root.trim()
    ? normalizeAbsolute(input.root.trim(), cwd)
    : cwd;
  const paths = Array.isArray(input.paths) ? input.paths : undefined;
  if (!paths || paths.length === 0) return { family: "diagnostics", kind: "workspace", path: root };

  let firstPath: string | undefined;
  let commonPath: string | undefined;
  let pathCount = 0;
  for (const value of paths) {
    if (typeof value !== "string" || !value.trim()) continue;
    const normalized = normalizeAbsolute(value.trim(), root);
    if (!firstPath) firstPath = normalized;
    commonPath = commonPath ? commonAncestor(commonPath, normalized) : normalized;
    pathCount++;
  }
  if (!firstPath || !commonPath) return { family: "diagnostics", kind: "workspace", path: root };
  if (pathCount === 1 && extname(firstPath)) {
    return { family: "diagnostics", kind: "target", path: firstPath };
  }
  return { family: "diagnostics", kind: "package", path: pathCount === 1 ? firstPath : commonPath };
}

function genericVerificationScope(
  family: VerificationFamily,
  input: Record<string, unknown>,
  cwd: string,
): VerificationScope {
  const raw = firstString(input, "cwd", "root", "packagePath", "path");
  return { family, kind: raw ? "package" : "workspace", path: raw ? normalizeAbsolute(raw, cwd) : cwd };
}

function familyForCommand(command: string): VerificationFamily | undefined {
  if (NODE_TEST_RE.test(command) || TEST_COMMAND_RE.test(command)) return "test";
  if (NODE_TSC_RE.test(command) || TYPECHECK_COMMAND_RE.test(command)) return "typecheck";
  if (LINT_COMMAND_RE.test(command)) return "lint";
  if (BUILD_COMMAND_RE.test(command)) return "build";
  return undefined;
}

function mutationTarget(
  toolName: string,
  input: Record<string, unknown>,
  cwd = process.cwd(),
): string | undefined {
  if (!MUTATION_TOOLS.has(toolName)) return undefined;
  const path = typeof input.path === "string" ? input.path.trim() : "";
  return path ? normalizeAbsolute(path, cwd) : undefined;
}

function verificationKey(scope: VerificationScope): string {
  return `verification:${scope.family}:${scope.kind}:${scope.path}`;
}

function clearCoveredMutationObligations(state: FalseSuccessState, scope: VerificationScope): void {
  for (const [key, obligation] of state.obligations) {
    if (obligation.kind === "verification") continue;
    if (scopeCovers(scope, obligation)) state.obligations.delete(key);
  }
}

function scopeCovers(scope: VerificationScope, obligation: CompletionObligation): boolean {
  if (scope.kind === "target") return obligation.scopePath === scope.path;
  return pathContains(scope.path, obligation.scopePath);
}

function pathContains(parent: string, child: string): boolean {
  const rel = relative(parent, child).replaceAll("\\", "/");
  return rel === "" || (rel !== ".." && !rel.startsWith("../") && !isAbsolute(rel));
}

function commonAncestor(left: string, right: string): string {
  let candidate = left;
  while (!pathContains(candidate, right)) {
    const parent = resolve(candidate, "..");
    if (parent === candidate) return candidate;
    candidate = parent;
  }
  return candidate;
}

function normalizeAbsolute(value: string, cwd: string): string {
  const stripped = value.startsWith("@") ? value.slice(1) : value;
  const absolute = isAbsolute(stripped) || WINDOWS_ABSOLUTE_RE.test(stripped)
    ? resolve(stripped)
    : resolve(cwd, stripped);
  return absolute.replaceAll("\\", "/").replace(/\/$/u, "").toLowerCase();
}

function unquote(value: string): string {
  if (value.length >= 2) {
    const first = value.charCodeAt(0);
    const last = value.charCodeAt(value.length - 1);
    if ((first === 34 && last === 34) || (first === 39 && last === 39)) return value.slice(1, -1);
  }
  return value;
}

function firstString(input: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = input[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function displayTarget(target: string): string {
  const slash = target.lastIndexOf("/");
  return slash >= 0 ? target.slice(slash + 1) : target;
}

function detailsStateChanged(details: unknown): boolean {
  if (!details || typeof details !== "object") return false;
  return (details as { stateChanged?: unknown }).stateChanged === true;
}

function classifyFailure(text: string): string {
  if (POLICY_BLOCKED_RE.test(text)) return "policy_blocked";
  if (PARTIAL_MUTATION_RE.test(text)) return "partial_mutation";
  if (TIMEOUT_RE.test(text)) return "timeout";
  if (PATH_NOT_FOUND_RE.test(text)) return "path_not_found";
  if (COMMAND_FAILED_RE.test(text)) return "command_failed";
  return "tool_error";
}

function makeObligation(
  key: string,
  kind: CompletionObligation["kind"],
  tool: string,
  category: string,
  label: string,
  scopeKind: ObligationScopeKind,
  scopePath: string,
  target?: string,
): CompletionObligation {
  return {
    key,
    kind,
    tool: bounded(tool),
    category: bounded(category),
    label: bounded(label),
    scopeKind,
    scopePath,
    target: target ? bounded(target) : undefined,
  };
}

function makeAudit(
  state: FalseSuccessState,
  kind: InterventionKind,
  tool: InterventionAudit["tool"],
  model: string,
  draftChars?: number,
): InterventionAudit {
  const obligations: InterventionAudit["obligations"] = [];
  for (const item of state.obligations.values()) {
    if (obligations.length >= MAX_AUDIT_OBLIGATIONS) break;
    obligations.push({
      kind: item.kind,
      tool: bounded(item.tool),
      category: bounded(item.category),
      scopeKind: item.scopeKind,
    });
  }
  return {
    schemaVersion: 1,
    guardVersion: FALSE_SUCCESS_GUARD_VERSION,
    kind,
    outcome: "blocked",
    category: "unverified_completion",
    tool,
    model: bounded(model || "unknown"),
    obligationCount: state.obligations.size,
    obligations,
    interventionSequence: state.interventions,
    ...(draftChars === undefined ? {} : { draftChars }),
  };
}

function setBounded(map: Map<string, CompletionObligation>, obligation: CompletionObligation): void {
  if (!map.has(obligation.key) && map.size >= MAX_OBLIGATIONS) {
    const oldest = map.keys().next().value;
    if (oldest !== undefined) map.delete(oldest);
  }
  map.set(obligation.key, obligation);
}

function bounded(value: string): string {
  return value.length <= MAX_LABEL_CHARS ? value : `${value.slice(0, MAX_LABEL_CHARS - 1)}…`;
}
