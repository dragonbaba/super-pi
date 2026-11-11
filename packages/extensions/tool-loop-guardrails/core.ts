import { RetryBudget, isTransientFailure, type RetryOperation } from "./transient-retry.ts";
import { callKey } from "./call-identity.ts";
export { callKey } from "./call-identity.ts";
import { access, opendir } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { UNCERTAIN_LIFECYCLE } from "../resource-lifecycle-guard/core.ts";
import { classifyToolFailure } from "./failure-classification.ts";
import { readShellExecution } from "@super-pi/coding-agent";
import { classifyStructuredReadonlyArguments } from "../resource-lifecycle-guard/structured-argv.ts";
import {
  BACKSLASH_PAIR_RE,
  BRACE_PATH_RE,
  GUARD_BLOCK_CATEGORY_RE,
  MSYS_REGEX_PARSE_FAILURE_RE,
  NODE_ESM_WINDOWS_PATH_RE,
  NODE_MODULE_RESOLUTION_FAILURE_RE,
  NODE_SCRIPT_COMMAND_RE,
  NODE_SCRIPT_SYNTAX_FAILURE_RE,
  READ_OFFSET_ERROR_RE,
  SHELL_SYNTAX_FAILURE_RE,
  UNIX_TMP_PATH_RE,
} from "./regex.ts";

const MAX_TRACKED_KEYS = 64;
const FAILURE_WARNING_THRESHOLD = 2;
const MAX_UNTRACKED_TRANSIENT_FAILURES = 2;
const FIRST_REPEAT_REMINDER_THRESHOLD = 3;
const SECOND_REPEAT_REMINDER_THRESHOLD = 5;
const FINAL_REPEAT_REMINDER_THRESHOLD = 8;
const MAX_WARNING_CHARS = 600;
const MAX_ERROR_TEXT_CHARS = 8_192;
const MAX_NEARBY_ENTRIES = 256;
const MAX_DISTANCE_CHARS = 96;
const TOOL_INPUT_REPAIRS = Symbol.for("pi.toolInputRepairs");
const EMPTY_PATH_ARGUMENTS: readonly string[] = Object.freeze([]);
const BATCH_DUPLICATE_CAUSE = "An identical sibling call already exists in the current assistant tool batch.";
const BATCH_DUPLICATE_ACTION = "Reuse the first sibling result; do not issue another identical call.";
const NESTED_DUPLICATE_CAUSE = "An identical call from the same Codemode script is still running.";
const NESTED_DUPLICATE_ACTION = "Await the first call and reuse its result; repeat it only after that call completes.";
const GENTLE_REPEAT_REMINDER = "You are repeating the same bounded canonical tool call. Re-read the latest result before calling it again; change the arguments or method, or finish if the available evidence is sufficient.";

export interface GuardState {
  failuresByTool: Map<string, number>;
  retry: RetryBudget;
  failureEvictions: number;
  failuresBySignature: Map<string, number>;
  batchCalls: Map<string, true>;
  warnings: number;
  repeatReminders: number;
  blocked: number;
  batchDuplicates: number;
  activeFailureSignature?: string;
  activeFailureCount: number;
  repeatChainKey?: string;
  repeatChainCount: number;
}

export function createGuardState(): GuardState {
  return {
    failuresByTool: new Map(),
    retry: new RetryBudget(),
    failureEvictions: 0,
    failuresBySignature: new Map(),
    batchCalls: new Map(),
    warnings: 0,
    repeatReminders: 0,
    blocked: 0,
    batchDuplicates: 0,
    activeFailureCount: 0,
    repeatChainCount: 0,
  };
}

function boundedToolName(value: string): string {
  return value.length <= 80 ? value : value.slice(0, 80);
}

export function guardCapacityReason(toolName: string, cause: string, retryable = true): string {
  return JSON.stringify({ ok: false, category: "GUARD_CAPACITY", operation: boundedToolName(toolName),
    retryable, stateChanged: false, cause });
}

function setBounded<T>(map: Map<string, T>, key: string, value: T): void {
  if (!map.has(key) && map.size >= MAX_TRACKED_KEYS) {
    const oldest = map.keys().next().value;
    if (oldest !== undefined) map.delete(oldest);
  }
  map.set(key, value);
}

export interface DeterministicCallPreparation {
  blockReason?: string;
  repairNote?: string;
}

const EMPTY_DETERMINISTIC_PREPARATION: DeterministicCallPreparation = Object.freeze({});

function structuredPreflightFailure(category: string, operation: string, cause: string, nextAction: string): string {
  return JSON.stringify({
    ok: false,
    category,
    operation,
    retryable: true,
    stateChanged: false,
    cause,
    nextAction,
  });
}

export function attachRepairKind(input: Record<PropertyKey, unknown>, kind: string): void {
  const current = input[TOOL_INPUT_REPAIRS];
  const kinds = Array.isArray(current) ? [...current, kind] : [kind];
  Object.defineProperty(input, TOOL_INPUT_REPAIRS, {
    configurable: true,
    enumerable: false,
    value: kinds,
  });
}

function toolPath(cwd: string, value: string): string {
  const path = value.startsWith("@") ? value.slice(1) : value;
  return isAbsolute(path) ? resolve(path) : resolve(cwd, path);
}

export function repairReadOffsetFromError(
  input: Record<PropertyKey, unknown>,
  errorText: string,
): string | undefined {
  const match = READ_OFFSET_ERROR_RE.exec(errorText.trim());
  if (!match || typeof input.offset !== "number" || !Number.isFinite(input.offset)) return undefined;
  const requestedOffset = Math.max(1, Math.floor(input.offset));
  const reportedOffset = Number(match[1]);
  const totalLines = Number(match[2]);
  if (!Number.isSafeInteger(reportedOffset)
    || !Number.isSafeInteger(totalLines)
    || totalLines < 1
    || requestedOffset !== reportedOffset
    || requestedOffset <= totalLines) return undefined;
  input.offset = totalLines;
  return `[Input repair] read offset ${requestedOffset} exceeded the file length and was clamped to line ${totalLines} (total lines: ${totalLines}).`;
}

function structuredRgPathOperands(input: Record<PropertyKey, unknown>): readonly string[] {
  if (input.command !== "rg" || !Array.isArray(input.args)) return EMPTY_PATH_ARGUMENTS;
  for (const argument of input.args) if (typeof argument !== "string") return EMPTY_PATH_ARGUMENTS;
  return classifyStructuredReadonlyArguments("rg", input.args as string[]).rgSearchPaths;
}

function structuredRgBraceFailure(input: Record<PropertyKey, unknown>): string | undefined {
  for (const path of structuredRgPathOperands(input)) {
    if (!BRACE_PATH_RE.test(path)) continue;
    return structuredPreflightFailure(
      "PLATFORM_PATH_ERROR",
      "structured_readonly_command",
      "Brace expansion is a shell feature; structured rg path arguments are passed literally.",
      "Expand the brace expression into explicit path arguments or run separate structured rg calls.",
    );
  }
  return undefined;
}

export async function prepareDeterministicCall(
  toolName: string,
  input: unknown,
): Promise<DeterministicCallPreparation> {
  if (!input || typeof input !== "object") return EMPTY_DETERMINISTIC_PREPARATION;
  const object = input as Record<PropertyKey, unknown>;
  // Shell directory and package lookup semantics belong to the runtime; explicit tool cwd is validated separately.
  const blockReason = toolName === "structured_readonly_command" ? structuredRgBraceFailure(object) : undefined;
  return blockReason ? { blockReason } : EMPTY_DETERMINISTIC_PREPARATION;
}

function boundedEditDistance(left: string, right: string): number {
  const a = left.toLowerCase().slice(0, MAX_DISTANCE_CHARS);
  const b = right.toLowerCase().slice(0, MAX_DISTANCE_CHARS);
  let previous = new Array<number>(b.length + 1);
  let current = new Array<number>(b.length + 1);
  for (let index = 0; index <= b.length; index++) previous[index] = index;
  for (let leftIndex = 1; leftIndex <= a.length; leftIndex++) {
    current[0] = leftIndex;
    for (let rightIndex = 1; rightIndex <= b.length; rightIndex++) {
      current[rightIndex] = Math.min(
        current[rightIndex - 1] + 1,
        previous[rightIndex] + 1,
        previous[rightIndex - 1] + (a.charCodeAt(leftIndex - 1) === b.charCodeAt(rightIndex - 1) ? 0 : 1),
      );
    }
    [previous, current] = [current, previous];
  }
  return previous[b.length];
}

async function nearestExistingPath(value: string, cwd: string): Promise<string | undefined> {
  if (!value.trim()) return undefined;
  const target = toolPath(cwd, value);
  let parent = dirname(target);
  let desired = basename(target);
  for (let depth = 0; depth < 4; depth++) {
    try {
      const directory = await opendir(parent);
      let best: string | undefined;
      let bestDistance = Number.MAX_SAFE_INTEGER;
      let inspected = 0;
      for await (const directoryEntry of directory) {
        if (inspected++ >= MAX_NEARBY_ENTRIES) break;
        const entry = directoryEntry.name;
        const distance = boundedEditDistance(desired, entry);
        if (distance > bestDistance || (distance === bestDistance && best !== undefined && entry >= best)) continue;
        best = entry;
        bestDistance = distance;
      }
      return best ? join(parent, best) : parent;
    } catch {
      const next = dirname(parent);
      if (next === parent) return undefined;
      desired = basename(parent);
      parent = next;
    }
  }
  return undefined;
}

async function nearestFailurePath(input: Record<PropertyKey, unknown>, cwd: string): Promise<string | undefined> {
  if (typeof input.path === "string" && input.path.trim()) return nearestExistingPath(input.path, cwd);
  const structuredCwd = input.command === "rg" && typeof input.cwd === "string" && input.cwd.trim()
    ? toolPath(cwd, input.cwd)
    : cwd;
  for (const path of structuredRgPathOperands(input)) {
    try {
      await access(toolPath(structuredCwd, path));
    } catch {
      return nearestExistingPath(path, structuredCwd);
    }
  }
  return undefined;
}

function isMsysRegexArgvFailure(input: unknown, failureText: string): boolean {
  if (process.platform !== "win32" || !input || typeof input !== "object") return false;
  const command = (input as { command?: unknown }).command;
  return typeof command === "string"
    && BACKSLASH_PAIR_RE.test(command)
    && MSYS_REGEX_PARSE_FAILURE_RE.test(failureText);
}

export async function failureRecoveryHint(
  toolName: string,
  input: unknown,
  failureText: string,
  cwd: string,
  details?: unknown,
): Promise<string | undefined> {
  // Structured producer facts outrank arbitrary stdout. Do not append a guessed
  // parser/path/policy advisory that contradicts the recorded shell outcome.
  const execution = toolName === "bash" || toolName === "powershell" ? readShellExecution(details) : undefined;
  if (execution) {
    if (execution.started !== false) return "[Shell execution recovery] Preserve the original diagnostic and recorded exit/termination facts. Inspect the exact command and affected state before a fresh request; completed effects are not undone. Do not retry unchanged or infer the cause from output alone.";
    return undefined;
  }
  const category = classifyFailureText(failureText, input, toolName, details);
  if ((toolName === "edit" || toolName === "write") && category === "read_required") {
    return toolName === "write"
      ? "[Read recovery] Existing whole-file overwrite requires qualifying complete content from dedicated read in an earlier completed tool turn, still matching the target. A truncated read(path) is not complete; grep, Bash, LSP, stale evidence and same-turn reads do not satisfy this guard. For a local change use a qualifying range/snapshot edit. Missing targets need no read and retain exclusive creation and permissions."
      : "[Read recovery] Use dedicated read for the exact edit range in an earlier completed tool turn, then edit against that current content; grep, Bash, LSP, stale evidence and same-turn reads do not satisfy this guard.";
  }
  if ((toolName === "bash" || toolName === "powershell") && (failureText === UNCERTAIN_LIFECYCLE || (failureText.startsWith("[SHELL_") && category === "policy_blocked"))) return undefined;
  if (failureText.includes("Blocked an uncertain/uninspectable shell lifecycle")) {
    return "[Lifecycle recovery] This shell syntax could not be analyzed before execution. Use an equivalent inspectable foreground form or a registered native tool for the same authorized operation. Every form still requires target permission, qualifying prior reads for mutations, and a managed process lifetime. Inspect the diagnostic before retrying unchanged.";
  }
  if (failureText.includes("Blocked an unmanaged long-lived process")) {
    return "[Lifecycle recovery] Remove '&' or the detaching launcher, set background: true with explicit cwd, and manage the command with tasks.";
  }
  if (category === "policy_blocked") {
    return "[Permission recovery] Resolve the permission or policy failure for this exact operation before retrying. Do not evade it by changing language, launcher, or tool; use only a registered capability allowed for the target.";
  }
  if (toolName === "bash" && isMsysRegexArgvFailure(input, failureText)) {
    return "[MSYS argv recovery] Windows MSYS command-line parsing likely collapsed paired backslashes before Bash parsed quotes. Use structured_readonly_command with rg argv inside the workspace, or remove the Bash argv backslash dependency before retrying.";
  }
  const command = toolName === "bash" && input && typeof input === "object"
    ? (input as { command?: unknown }).command
    : undefined;
	if (typeof command === "string" && NODE_SCRIPT_COMMAND_RE.test(command)) {
		if (NODE_SCRIPT_SYNTAX_FAILURE_RE.test(failureText)) {
			return "[Node script recovery] Node reported a script syntax/parse error; preserve the first useful error and its location. A valid long node -e is allowed when argv transfer is reliable. For complex quoting or reusable code, a checked .cjs/.mjs file or stdin is an option; run node --check on that exact source before retrying. Do not retry unchanged source.";
		}
    if (NODE_MODULE_RESOLUTION_FAILURE_RE.test(failureText)) {
      return "[Node module recovery] Node could not resolve the requested module/package. Resolve it from a verified parent manifest or dependency tree before retrying; do not guess a top-level node_modules path.";
    }
  }
  if (toolName === "bash" && typeof command === "string" && SHELL_SYNTAX_FAILURE_RE.test(failureText)) {
    return "[Shell syntax recovery] The shell could not parse the command, so the intended operation may not have run. Inspect the exact quoting, separators, and generated command text; change the command before retrying instead of adding blind escapes.";
  }
  if (NODE_ESM_WINDOWS_PATH_RE.test(failureText)) {
    return "[Path recovery] Convert the Windows absolute module path with pathToFileURL(...).href before passing it to Node ESM import().";
  }
  if (process.platform === "win32" && input && typeof input === "object") {
    const command = (input as { command?: unknown }).command;
    if (typeof command === "string" && UNIX_TMP_PATH_RE.test(command)
      && category === "path_not_found" && UNIX_TMP_PATH_RE.test(failureText)) {
      return "[Path recovery] The error names a /tmp path. Verify that exact path and the failing executable in this shell; spelling alone does not establish the cause. Use the actual shell temporary directory or os.tmpdir() in Node where appropriate, after resolving permissions.";
    }
  }
  if (category !== "path_not_found" || !input || typeof input !== "object") return undefined;
  // Nested calls have already received their own recovery handling. The parent
  // contains script source, not a filesystem target; do not invent a second path advisory.
  if (toolName === "codemode") return undefined;
  const nearby = await nearestFailurePath(input as Record<PropertyKey, unknown>, cwd);
  return nearby
    ? `[Path recovery] The requested path does not exist. Nearest existing candidate: ${nearby}`
    : `[Path recovery] ${boundedToolName(toolName)} should verify the parent directory before retrying; do not guess another path.`;
}

export function inspectBatchCall(
  state: GuardState,
  toolName: string,
  input: unknown,
  key = callKey(toolName, input),
  calls = state.batchCalls,
  /** A nested sibling issued while an identical call ran, then serialized behind it. */
  overlapped = false,
): string | undefined {
  if (overlapped || calls.has(key)) {
    state.blocked++;
    state.batchDuplicates++;
    // A caller-owned set holds in-flight nested children rather than a protocol batch.
    const nested = calls !== state.batchCalls;
    return JSON.stringify({
      ok: false,
      category: "DUPLICATE_CALL",
      operation: boundedToolName(toolName),
      retryable: false,
      stateChanged: false,
      cause: nested ? NESTED_DUPLICATE_CAUSE : BATCH_DUPLICATE_CAUSE,
      nextAction: nested ? NESTED_DUPLICATE_ACTION : BATCH_DUPLICATE_ACTION,
    });
  }
  if (calls.size >= 256) {
    state.blocked++;
    return guardCapacityReason(toolName, "The bounded batch identity table is full; await calls or start a fresh turn.");
  }
  calls.set(key, true);
  return undefined;
}

export function resetBatchState(state: GuardState): void {
  state.batchCalls.clear();
}

export function classifyFailureText(text: string, input?: unknown, toolName = "tool", details?: unknown): string {
  const boundedText = text.slice(0, MAX_ERROR_TEXT_CHARS);
  if (!readShellExecution(details) && isMsysRegexArgvFailure(input, boundedText)) return "platform_path_error";
  return classifyToolFailure(toolName, boundedText, input, details).category;
}

export function observeRepeatedCall(
  state: GuardState,
  toolName: string,
  input: unknown,
  key = callKey(toolName, input),
): string | undefined {
  const count = state.repeatChainKey === key ? state.repeatChainCount + 1 : 1;
  state.repeatChainKey = key;
  state.repeatChainCount = count;
  if (count !== FIRST_REPEAT_REMINDER_THRESHOLD
    && count !== SECOND_REPEAT_REMINDER_THRESHOLD
    && count !== FINAL_REPEAT_REMINDER_THRESHOLD) return undefined;
  state.warnings++;
  state.repeatReminders++;
  if (count === FIRST_REPEAT_REMINDER_THRESHOLD) return GENTLE_REPEAT_REMINDER;
  return `[Tool-loop reminder] ${boundedToolName(toolName)} has been called ${count} consecutive times with the same bounded canonical arguments. Re-read the latest result and change arguments or method, or finish if enough evidence has been gathered.`;
}

function warningText(toolName: string, reason: string): string {
  const text = `[Tool-loop guardrail] ${boundedToolName(toolName)}: ${reason}. Stop repeating the same approach: inspect the error/state, change arguments or method, or explain the blocker.`;
  return text.length <= MAX_WARNING_CHARS ? text : text.slice(0, MAX_WARNING_CHARS);
}

function signatureKey(canonicalCallKey: string, category: string): string {
  return `${canonicalCallKey}:${category}`;
}

export function inspectBeforeCall(
  state: GuardState,
  toolName: string,
  input: unknown,
  key = callKey(toolName, input),
): string | undefined {
  const retryReason = state.retry.refusal(key);
  if (retryReason) {
    state.blocked++;
    const retry = state.retry.operations.get(key);
    return JSON.stringify({ ok: false, category: retry?.inFlight ? "TRANSIENT_RETRY_IN_FLIGHT" : "TRANSIENT_RETRY_EXHAUSTED", operation: boundedToolName(toolName),
      retryable: retry?.inFlight === true, stateChanged: false, attempts: retry?.attempts ?? 0,
      waitMs: retry?.waitMs ?? 0, maxAttempts: state.retry.policy.maxAttempts,
      maxWaitMs: state.retry.policy.maxWaitMs, cause: retryReason });
  }
  // Only retry-table overflow retains a resource refusal. Ordinary failure
  // summaries are advisory and never decide whether the next call may execute.
  if (state.retry.saturated
    && (state.failuresBySignature.get(signatureKey(key, "transient_retry_overflow")) ?? 0) >= MAX_UNTRACKED_TRANSIENT_FAILURES) {
    state.blocked++;
    return guardCapacityReason(toolName, "The transient retry table is full and this operation exhausted its two untracked recovery attempts; start a fresh user run.", false);
  }
  return undefined;
}

/** A normally completed shell command with a nonzero exit is an outcome, not a tool error, but still a failed attempt for repeat accounting. */
export function shellCommandFailed(toolName: string, details: unknown): boolean {
  if (toolName !== "bash" && toolName !== "powershell") return false;
  const execution = readShellExecution(details);
  return execution !== undefined && execution.termination === "exit" && execution.exitCode !== 0;
}

export function recordResult(
  state: GuardState,
  toolName: string,
  input: unknown,
  isError: boolean,
  failureText = "",
  canonicalCallKey?: string,
  details?: unknown,
  reservedRetryOperation?: RetryOperation,
  isLeaf = true,
): string | undefined {
	// Child results already update the ledger. A handled parent cannot erase them.
	if (toolName === "codemode" && !isError) return undefined;
  if (isError) {
    const execution = readShellExecution(details);
    if (!execution && GUARD_BLOCK_CATEGORY_RE.test(failureText)) return undefined;
    let category = classifyFailureText(failureText, input, toolName, details);
    if (execution?.producer === "agent" && execution.started === false
      && (category === "duplicate_call" || category === "repeated_call_blocked")) return undefined;
    if (category === "aborted") return undefined;
    setBounded(state.failuresByTool, boundedToolName(toolName), (state.failuresByTool.get(boundedToolName(toolName)) ?? 0) + 1);
    const call = canonicalCallKey ?? callKey(toolName, input);
    if (isTransientFailure(category, failureText, details)) {
      if (state.retry.record(call, reservedRetryOperation)) return undefined;
      // A single overflow category also bounds mixed HTTP/network/timeout failures.
      category = "transient_retry_overflow";
    }
    const key = signatureKey(call, category);
    const count = (state.failuresBySignature.get(key) ?? 0) + 1;
    if (!state.failuresBySignature.has(key) && state.failuresBySignature.size >= MAX_TRACKED_KEYS) {
      state.failureEvictions++;
    }
    setBounded(state.failuresBySignature, key, count);
    // Ordinary failure counts are diagnostic only; transient overflow is a separate resource limit.
    state.activeFailureCount = count;
    state.activeFailureSignature = key;
    if (count !== FAILURE_WARNING_THRESHOLD) return undefined;
    state.warnings++;
    return warningText(toolName, `the identical call failed ${state.activeFailureCount} times with category ${category}`);
  }

  state.activeFailureSignature = undefined;
  state.activeFailureCount = 0;
  const call = canonicalCallKey ?? callKey(toolName, input);
  const retry = state.retry.operations.get(call);
  // A stale retry must not erase a newer generation. An ordinary sibling may
  // report recovery, but cannot remove another invocation's live reservation.
  if (retry === reservedRetryOperation || (!reservedRetryOperation && !retry?.inFlight)) {
    state.retry.operations.delete(call);
  }
  if (isLeaf && (toolName === "edit" || toolName === "write" || toolName === "bash" || toolName === "powershell")) {
    // Known workspace mutations invalidate deterministic evidence, not transport budgets.
    state.failuresBySignature.clear();
    state.failuresByTool.clear();
  } else {
    const prefix = `${call}:`;
    for (const key of state.failuresBySignature.keys()) if (key.startsWith(prefix)) state.failuresBySignature.delete(key);
    state.failuresByTool.delete(boundedToolName(toolName));
  }
  return undefined;
}

export function resetGuardState(state: GuardState): void {
  state.retry.clear();
  state.failureEvictions = 0;
  state.failuresByTool.clear();
  state.failuresBySignature.clear();
  state.batchCalls.clear();
  state.warnings = 0;
  state.repeatReminders = 0;
  state.blocked = 0;
  state.batchDuplicates = 0;
  state.activeFailureSignature = undefined;
  state.activeFailureCount = 0;
  state.repeatChainKey = undefined;
  state.repeatChainCount = 0;
}

export function guardStatus(state: GuardState): string {
  return `mode=deterministic; warnings=${state.warnings}; repeatReminders=${state.repeatReminders}; blocked=${state.blocked}; batchDuplicates=${state.batchDuplicates}; trackedTools=${state.failuresByTool.size}; failedSignatures=${state.failuresBySignature.size}; repeatChainCount=${state.repeatChainCount}`;
}
