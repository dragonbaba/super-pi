import { createHash } from "node:crypto";
import { access, opendir, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { classifyToolFailure } from "../session-tool-errors/core.ts";
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
  MSYS_DRIVE_PATH_RE,
  NPM_EXECUTABLE_RE,
  READ_OFFSET_ERROR_RE,
  SHELL_DYNAMIC_PATH_RE,
  SHELL_SYNTAX_FAILURE_RE,
  UNIX_TMP_PATH_RE,
} from "./regex.js";

const MAX_TRACKED_KEYS = 64;
const MAX_HASH_DEPTH = 16;
const MAX_HASH_NODES = 2_048;
const MAX_HASH_STRING_CHARS = 4_096;
const MAX_HASH_TOTAL_CHARS = 16_384;
const REPEATED_FAILURE_THRESHOLD = 2;
const FIRST_REPEAT_REMINDER_THRESHOLD = 3;
const SECOND_REPEAT_REMINDER_THRESHOLD = 5;
const FINAL_REPEAT_REMINDER_THRESHOLD = 8;
const MAX_WARNING_CHARS = 600;
const MAX_ERROR_TEXT_CHARS = 8_192;
const MAX_NEARBY_ENTRIES = 256;
const MAX_COMMAND_TOKENS = 64;
const MAX_COMMAND_CHARS = 4_096;
const MAX_DISTANCE_CHARS = 96;
const TOOL_INPUT_REPAIRS = Symbol.for("pi.toolInputRepairs");
const NPM_MANIFEST_ACTIONS = new Set(["restart", "run", "run-script", "start", "stop", "test"]);
const EMPTY_PATH_ARGUMENTS: readonly string[] = Object.freeze([]);
const GENTLE_REPEAT_REMINDER = "You are repeating the same bounded canonical tool call. Re-read the latest result before calling it again; change the arguments or method, or finish if the available evidence is sufficient.";
const READ_ONLY_TOOLS = new Set([
  "read",
  "grep",
  "find",
  "ls",
  "codegraph",
  "lsp_diagnostics",
  "lsp_navigate",
  "memory_search",
  "session_search",
  "structured_readonly_command",
]);

export interface GuardState {
  failuresByTool: Map<string, number>;
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

function setBounded<T>(map: Map<string, T>, key: string, value: T): void {
  if (!map.has(key) && map.size >= MAX_TRACKED_KEYS) {
    const oldest = map.keys().next().value;
    if (oldest !== undefined) map.delete(oldest);
  }
  map.set(key, value);
}

interface CanonicalizeState {
  nodes: number;
  characters: number;
  seen: Set<object>;
}

interface CanonicalKeyEntry {
  bounded: string;
  original: string;
}

function compareCanonicalKeys(left: CanonicalKeyEntry, right: CanonicalKeyEntry): number {
  return left.bounded < right.bounded ? -1 : left.bounded > right.bounded ? 1 : 0;
}

function boundedCanonicalString(value: string, state: CanonicalizeState, label = "string"): string {
  const remaining = Math.max(0, MAX_HASH_TOTAL_CHARS - state.characters);
  const inspected = Math.min(value.length, MAX_HASH_STRING_CHARS, remaining);
  state.characters += inspected;
  if (inspected === value.length) return value;
  if (inspected === 0) return `[${label}:${value.length}:bounded]`;
  const headLength = Math.ceil(inspected / 2);
  const sample = value.slice(0, headLength) + value.slice(value.length - (inspected - headLength));
  const digest = createHash("sha256").update(sample).digest("base64url").slice(0, 12);
  return `[${label}:${value.length}:${digest}]`;
}

function visitCanonical(item: unknown, depth: number, state: CanonicalizeState): unknown {
  state.nodes++;
  if (state.nodes > MAX_HASH_NODES || depth > MAX_HASH_DEPTH) return "[bounded]";
  if (item === null || typeof item === "boolean") return item;
  if (typeof item === "string") return boundedCanonicalString(item, state);
  if (typeof item === "number") return Number.isFinite(item) ? item : "[number]";
  if (typeof item === "bigint") return `${item}n`;
  if (typeof item !== "object") return `[${typeof item}]`;
  if (state.seen.has(item)) return "[cycle]";
  state.seen.add(item);
  if (Array.isArray(item)) {
    const limit = Math.max(0, Math.min(item.length, MAX_HASH_NODES - state.nodes));
    const result = new Array<unknown>(limit + (limit < item.length ? 1 : 0));
    for (let index = 0; index < limit; index++) result[index] = visitCanonical(item[index], depth + 1, state);
    if (limit < item.length) result[limit] = `[items:${item.length - limit}]`;
    state.seen.delete(item);
    return result;
  }
  const object = item as Record<string, unknown>;
  const result: Record<string, unknown> = Object.create(null);
  const keys: CanonicalKeyEntry[] = [];
  const keyLimit = Math.max(0, MAX_HASH_NODES - state.nodes);
  let scanned = 0;
  let boundedKeys = false;
  for (const key in object) {
    scanned++;
    if (scanned > MAX_HASH_NODES || keys.length >= keyLimit) {
      boundedKeys = true;
      break;
    }
    if (Object.hasOwn(object, key)) {
      keys.push({ bounded: boundedCanonicalString(key, state, "key"), original: key });
    }
  }
  keys.sort(compareCanonicalKeys);
  for (let index = 0; index < keys.length; index++) {
    const key = keys[index];
    const boundedKey = Object.hasOwn(result, key.bounded) ? `${key.bounded}:${index}` : key.bounded;
    result[boundedKey] = visitCanonical(object[key.original], depth + 1, state);
  }
  if (boundedKeys) result["[bounded-keys]"] = true;
  state.seen.delete(item);
  return result;
}

function canonicalize(value: unknown): string {
  const state: CanonicalizeState = { nodes: 0, characters: 0, seen: new Set<object>() };
  try {
    return JSON.stringify(visitCanonical(value, 0, state));
  } catch {
    return "[unserializable]";
  }
}

export function callKey(toolName: string, input: unknown): string {
  return `${boundedToolName(toolName)}:${createHash("sha256").update(canonicalize(input)).digest("base64url").slice(0, 16)}`;
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

function commandPrefixTokens(command: string): string[] | undefined {
  const source = command.slice(0, MAX_COMMAND_CHARS);
  const tokens: string[] = [];
  let token = "";
  let quote = 0;
  for (let index = 0; index < source.length; index++) {
    const code = source.charCodeAt(index);
    if (quote !== 0) {
      if (code === quote) quote = 0;
      else token += source[index];
      continue;
    }
    if (code === 34 || code === 39) {
      quote = code;
      continue;
    }
    if (code === 38 || code === 59 || code === 124 || code === 10 || code === 13) break;
    if (code === 32 || code === 9) {
      if (!token) continue;
      tokens.push(token);
      token = "";
      if (tokens.length >= MAX_COMMAND_TOKENS) break;
      continue;
    }
    token += source[index];
  }
  if (quote !== 0) return undefined;
  if (token && tokens.length < MAX_COMMAND_TOKENS) tokens.push(token);
  return tokens;
}

function staticLeadingCdDirectory(command: string, cwd: string): string | undefined {
  const tokens = commandPrefixTokens(command);
  if (!tokens || tokens[0] !== "cd") return undefined;
  const value = tokens.length === 2
    ? tokens[1]
    : tokens.length === 3 && tokens[1] === "--" ? tokens[2] : undefined;
  if (!value || value === "-" || SHELL_DYNAMIC_PATH_RE.test(value)) return undefined;
  if (process.platform === "win32") {
    const match = MSYS_DRIVE_PATH_RE.exec(value);
    if (match) {
      const suffix = value.slice(match[0].length).replaceAll("/", "\\");
      return `${match[1].toUpperCase()}:\\${suffix}`;
    }
  }
  return toolPath(cwd, value);
}

async function bashStaticCdFailure(command: string, cwd: string): Promise<string | undefined> {
  const directory = staticLeadingCdDirectory(command, cwd);
  if (!directory) return undefined;
  try {
    if ((await stat(directory)).isDirectory()) return undefined;
  } catch { /* Return one deterministic preflight failure below. */ }
  return structuredPreflightFailure(
    "WORKDIR_MISMATCH",
    "bash",
    `Static leading cd target is not an existing directory: ${directory}.`,
    "Inspect the verified parent directory and use an existing exact path before retrying.",
  );
}

function npmManifestDirectory(command: string, cwd: string): string | undefined {
  const tokens = commandPrefixTokens(command);
  if (!tokens || tokens.length < 2 || !NPM_EXECUTABLE_RE.test(tokens[0])) return undefined;
  let packageDirectory = cwd;
  let action: string | undefined;
  for (let index = 1; index < tokens.length; index++) {
    const token = tokens[index];
    if (token === "--prefix" || token === "-C" || token === "--dir") {
      const value = tokens[++index];
      if (!value) return undefined;
      packageDirectory = toolPath(cwd, value);
      continue;
    }
    if (token.startsWith("--prefix=") || token.startsWith("--dir=")) {
      const equals = token.indexOf("=");
      const value = token.slice(equals + 1);
      if (!value) return undefined;
      packageDirectory = toolPath(cwd, value);
      continue;
    }
    if (token.startsWith("-")) continue;
    action ??= token.toLowerCase();
  }
  return action && NPM_MANIFEST_ACTIONS.has(action) ? packageDirectory : undefined;
}

async function bashWorkdirFailure(input: Record<PropertyKey, unknown>, cwd: string): Promise<string | undefined> {
  if (typeof input.command !== "string") return undefined;
  const cdFailure = await bashStaticCdFailure(input.command, cwd);
  if (cdFailure) return cdFailure;
  const packageDirectory = npmManifestDirectory(input.command, cwd);
  if (!packageDirectory) return undefined;
  let validManifest = false;
  try {
    const manifest = join(packageDirectory, "package.json");
    await access(manifest);
    validManifest = (await stat(manifest)).isFile();
  } catch {
    validManifest = false;
  }
  if (validManifest) return undefined;
  return structuredPreflightFailure(
    "WORKDIR_MISMATCH",
    "bash",
    `Package lifecycle preflight found no regular package.json file in ${packageDirectory}.`,
    "Change into the intended package directory, correct --prefix/-C, or inspect that directory before retrying.",
  );
}

export async function prepareDeterministicCall(
  toolName: string,
  input: unknown,
  cwd: string,
): Promise<DeterministicCallPreparation> {
  if (!input || typeof input !== "object") return EMPTY_DETERMINISTIC_PREPARATION;
  const object = input as Record<PropertyKey, unknown>;
  const blockReason = toolName === "bash"
    ? await bashWorkdirFailure(object, cwd)
    : toolName === "structured_readonly_command"
      ? structuredRgBraceFailure(object)
      : undefined;
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
): Promise<string | undefined> {
  if ((toolName === "edit" || toolName === "write") && classifyFailureText(failureText, input, toolName) === "read_required") {
    return "[Read recovery] This mutation had no qualifying prior read and made no change. Read the exact target range with the read tool in a completed tool turn, then retry against that current content; grep, Bash, LSP, and same-turn reads do not satisfy this guard.";
  }
  if (toolName === "bash" && isMsysRegexArgvFailure(input, failureText)) {
    return "[MSYS argv recovery] Windows MSYS command-line parsing likely collapsed paired backslashes before Bash parsed quotes. Use structured_readonly_command with rg argv inside the workspace, or remove the Bash argv backslash dependency before retrying.";
  }
  const command = toolName === "bash" && input && typeof input === "object"
    ? (input as { command?: unknown }).command
    : undefined;
  if (typeof command === "string" && NODE_SCRIPT_COMMAND_RE.test(command)) {
    if (NODE_SCRIPT_SYNTAX_FAILURE_RE.test(failureText)) {
      return "[Node script recovery] Node rejected the script syntax before the intended work could be trusted. For a script file, run node --check on that exact file before execution; for node -e, reduce the snippet or move nontrivial code into a checked file. Do not retry unchanged quoting or template-string escapes.";
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
    if (typeof command === "string" && UNIX_TMP_PATH_RE.test(command)) {
      return "[Path recovery] Replace hardcoded /tmp with $TMPDIR in shell or os.tmpdir() in Node on Windows.";
    }
  }
  if (classifyFailureText(failureText, input, toolName) !== "path_not_found" || !input || typeof input !== "object") return undefined;
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
): string | undefined {
  if (state.batchCalls.has(key)) {
    state.blocked++;
    state.batchDuplicates++;
    return JSON.stringify({
      ok: false,
      category: "DUPLICATE_CALL",
      operation: boundedToolName(toolName),
      retryable: false,
      stateChanged: false,
      cause: "An identical sibling call already exists in the current assistant tool batch.",
      nextAction: "Reuse the first sibling result; do not issue another identical call.",
    });
  }
  setBounded(state.batchCalls, key, true);
  return undefined;
}

export function resetBatchState(state: GuardState): void {
  state.batchCalls.clear();
}

export function classifyFailureText(text: string, input?: unknown, toolName = "tool"): string {
  const boundedText = text.slice(0, MAX_ERROR_TEXT_CHARS);
  if (isMsysRegexArgvFailure(input, boundedText)) return "platform_path_error";
  return classifyToolFailure(toolName, boundedText, input).category;
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

function warningText(toolName: string, reasons: string[]): string {
  const text = `[Tool-loop guardrail] ${boundedToolName(toolName)}: ${reasons.join("; ")}. Stop repeating the same approach: inspect the error/state, change arguments or method, or explain the blocker.`;
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
  const prefix = `${key}:`;
  if (!state.activeFailureSignature?.startsWith(prefix)) {
    state.activeFailureSignature = undefined;
    state.activeFailureCount = 0;
    return undefined;
  }
  if (state.activeFailureCount < REPEATED_FAILURE_THRESHOLD) return undefined;
  const category = state.activeFailureSignature.slice(prefix.length);
  state.blocked++;
  return JSON.stringify({
    ok: false,
    category: "REPEATED_CALL_BLOCKED",
    operation: boundedToolName(toolName),
    retryable: false,
    stateChanged: false,
    failureCategory: category,
    failureCount: state.activeFailureCount,
    cause: "The identical call already failed repeatedly and remains blocked until its arguments or method change.",
    nextAction: "Inspect the original failure and change the arguments or method before retrying.",
  });
}

export function recordResult(
  state: GuardState,
  toolName: string,
  input: unknown,
  isError: boolean,
  failureText = "",
  canonicalCallKey?: string,
): string | undefined {
  if (isError) {
    if (GUARD_BLOCK_CATEGORY_RE.test(failureText)) return undefined;
    setBounded(state.failuresByTool, toolName, (state.failuresByTool.get(toolName) ?? 0) + 1);
    const category = classifyFailureText(failureText, input, toolName);
    const key = signatureKey(canonicalCallKey ?? callKey(toolName, input), category);
    state.activeFailureCount = state.activeFailureSignature === key ? state.activeFailureCount + 1 : 1;
    state.activeFailureSignature = key;
    setBounded(state.failuresBySignature, key, state.activeFailureCount);
    if (state.activeFailureCount < REPEATED_FAILURE_THRESHOLD) return undefined;
    state.warnings++;
    if (state.activeFailureCount > REPEATED_FAILURE_THRESHOLD) {
      return `[TLG: identical ${boundedToolName(toolName)}/${category} failure still active; change approach.]`;
    }
    return warningText(toolName, [`the identical call failed ${state.activeFailureCount} consecutive times with category ${category}`]);
  }

  state.activeFailureSignature = undefined;
  state.activeFailureCount = 0;
  clearFailuresForTool(state, toolName);
  if (READ_ONLY_TOOLS.has(toolName)) return undefined;
  // Successful state-changing tools invalidate stale failure evidence, but the
  // consecutive-call reminder remains independent and observes every result.
  state.failuresByTool.clear();
  state.failuresBySignature.clear();
  return undefined;
}

function clearFailuresForTool(state: GuardState, toolName: string): void {
  state.failuresByTool.delete(toolName);
  const prefix = `${boundedToolName(toolName)}:`;
  for (const key of state.failuresBySignature.keys()) if (key.startsWith(prefix)) state.failuresBySignature.delete(key);
}

export function resetGuardState(state: GuardState): void {
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
