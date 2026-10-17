import { basename, resolve } from "node:path";
import { homedir } from "node:os";
import {
	BASH_ALIASES_ASSIGNMENT,
	DETACH_UTILITY_PATTERN,
	DIRECT_SHELL_VARIABLE_PATTERN,
	DOCKER_DETACHED_PATTERN,
	EXECUTABLE_EXPANSION_TEXT_PATTERN,
	HEAD_COUNT_OPTION_PATTERN,
	HEREDOC_SHELL_COMMAND_PATTERN,
	NODE_COMMAND_PATTERN,
	HEREDOC_SOURCE_COMMAND_PATTERN,
	LEADING_ASSIGNMENT_PATTERN,
	LEADING_REDIRECTION_PATTERN,
	LOOKUP_ASSIGNMENT_PATTERN,
	TEMPORARY_CDPATH_QUERY_PATTERN,
	NODE_RM_CALL_PATTERN,
	NODE_RECURSIVE_OPTION_PATTERN,
	NODE_NONRECURSIVE_OPTIONS_PATTERN,
	NODE_UNLINK_PATTERN,
	NODE_LITERAL_METHOD_KEY_PATTERN,
	NONNEGATIVE_INTEGER_PATTERN,
	SIMPLE_BASH_LET_ASSIGNMENT_PATTERN,
	OPAQUE_JOB_LAUNCHER_PATTERN,
	OWNED_FOREGROUND_JOB_PATTERN,
	OWNED_USE_COMMAND_PATTERN,
	POWERSHELL_REMOVE_RECURSIVE_PATTERN,
	PYTHON_RMTREE_PATTERN,
	PYTHON_COMMAND_PATTERN,
	PYTHON_UNLINK_PATTERN,
	REDIRECTION_OPERATOR_PATTERN,
	SERVICE_START_PATTERN,
	SHELL_WRAPPER_TEXT_PATTERN,
	SIMPLE_VARIABLE_PATTERN,
	SOURCE_DESCRIPTOR_PATTERN,
	WINDOWS_DETACH_PATTERN,
	WINDOWS_START_BACKGROUND_PATTERN,
	WINDOWS_WAIT_PATTERN,
} from "./regex.ts";
import { commandSubstitutionEnd, MAX_SUBSTITUTIONS, MAX_SUBSTITUTION_NESTING } from "./shell-substitution.ts";
import { analyzeShellSource, type ShellAnalysisOwner } from "./shell-analysis.ts";
import { parseTimeoutInvocation } from "./timeout-wrapper.ts";
import { findPredicateHasOperand, isReadOnlyFindTail, isReadOnlySortTail } from "./readonly-find.ts";
import { isReadOnlyFindLoop } from "./readonly-find-loop.ts";
import { isLiteralReadLoop } from "./readonly-loop.ts";
import { bashArithmeticForHeader, bashLoopVariableIndex, bashPipelinePrefixEnd, bashScriptOperandIndex, unsafeBashForHeaderReason, hasStatefulBashPrintf, shellExpansionRisk, hasUnsafeBashTestOperand, hasUnsafeBashLoopListOperand, hasUnsafeCommandQueryOperand, isBashArithmeticCommandHead, isBashDoubleBracketCloseBoundary, isBashNetworkRedirectionTarget, isBashDoubleBracketHead, isBashProcessSubstitutionStart, isBashTestWhitespace, isLookupSensitiveBashVariable, isShellDynamicDescriptor, isShellFileDescriptor, isShellOutputFileRedirection, isSimpleBashAnsiCQuote, isStaticDescriptorCopy, shellRedirectionLength, stripShellRedirections } from "./shell-redirection.ts";
import { FD_DUPLICATION_PATTERN } from "./regex.ts";
import { isCodeMethodNamePart, writeCodeMethodName, writeEscapedNodeMethodKey } from "./code-method-names.ts";
import { diagnosticForPrimitives, policyMetadata, renderPolicyDiagnostic, type PolicyDiagnosticMetadata } from "./policy-diagnostics.ts";

const MAX_INSPECTED_COMMAND_CHARS = 128 * 1024;
const BLOCK_REASON =
	"Blocked an unmanaged long-lived process before execution; this Bash call was not executed.\nRetry: keep setup and bounded use in one inspectable foreground call with a recorded PID, EXIT trap, kill and wait; resubmit for authorization. For session-managed background execution, keep the command itself foreground and set background: true with explicit cwd in a live TUI/RPC session with the tasks tool available. Otherwise use foreground execution.";

/** Parser diagnostics are opacity evidence; only lifecycle and native routing block. */
export function isBlockingLifecycleReason(reason: string): boolean {
	return reason === BLOCK_REASON || reason.startsWith("[SHELL_BACKGROUND]") || reason.startsWith("[SHELL_WRAPPER:LAUNCHER_UNSUPPORTED]");
}
const MAX_MUTATION_PRIMITIVES = 16;
const MAX_MUTATION_TARGETS = 16;
const MAX_SCRIPT_SEGMENTS = 64;
const MAX_WRAPPER_DEPTH = 4;
const SCRIPT_WRAPPERS = new Set(["bash", "bash.exe", "sh", "sh.exe", "zsh", "zsh.exe", "dash", "dash.exe", "ksh", "ksh.exe", "fish", "fish.exe"]);
const POWERSHELL_WRAPPERS = new Set(["powershell", "powershell.exe", "pwsh", "pwsh.exe"]);
// Documented zero-value switches; unknown option arity retains both interpretations.
const NODE_VALUE_FREE_FLAGS = new Set([
	"--no-warnings", "--trace-warnings", "--no-deprecation", "--trace-deprecation", "--throw-deprecation", "--trace-uncaught",
	"--enable-source-maps", "--preserve-symlinks", "--preserve-symlinks-main", "--expose-gc", "--jitless",
	"--test", "--test-only", "--test-force-exit", "--test-update-snapshots", "--experimental-test-coverage",
	"--watch", "--watch-preserve-output", "--trace-exit", "--trace-sync-io", "--abort-on-uncaught-exception",
	// Documented operand-free CLI options (Node 24/26). Unknown arities still
	// retain both interpretations; this catalog does not infer arbitrary flags.
	"--allow-addons", "--allow-child-process", "--allow-ffi", "--allow-inspector", "--allow-net", "--allow-wasi", "--allow-worker",
	"--build-snapshot", "--cpu-prof", "--disable-sigusr1", "--disable-wasm-trap-handler",
	"--disallow-code-generation-from-strings", "--enable-etw-stack-walking", "--enable-fips", "--entry-url",
	"--experimental-addon-modules", "--experimental-eventsource", "--experimental-ffi", "--experimental-import-meta-resolve",
	"--experimental-inspector-network-resource", "--experimental-network-inspection", "--experimental-print-required-tla",
	"--experimental-storage-inspection", "--experimental-stream-iter", "--experimental-test-module-mocks", "--experimental-vfs",
	"--experimental-vm-modules", "--experimental-worker-inspection", "--experimental-strip-types", "--experimental-transform-types",
	"--force-context-aware", "--force-fips", "--force-node-api-uncaught-exceptions-policy", "--frozen-intrinsics", "--heap-prof",
	"--insecure-http-parser", "--interpreted-frames-native-stack", "--no-addons", "--no-async-context-frame",
	"--no-experimental-detect-module", "--no-experimental-global-navigator", "--no-experimental-repl-await",
	"--no-experimental-require-module", "--no-experimental-sqlite", "--no-experimental-websocket", "--webstorage", "--no-experimental-webstorage",
	"--no-extra-info-on-fatal-exception", "--no-force-async-hooks-checks", "--no-global-search-paths",
	"--enable-network-family-autoselection", "--no-network-family-autoselection", "--no-require-module", "--no-strip-types", "--node-memory-debug",
	"--openssl-legacy-provider", "--openssl-shared-config", "--pending-deprecation", "--permission", "--experimental-permission", "--permission-audit",
	"--prof", "--prof-process", "--report-compact", "--report-exclude-env", "--report-exclude-network", "--report-on-fatalerror",
	"--report-on-signal", "--report-uncaught-exception", "--test-randomize", "--tls-max-v1.2", "--tls-max-v1.3",
	"--tls-min-v1.0", "--tls-min-v1.1", "--tls-min-v1.2", "--tls-min-v1.3", "--trace-env", "--trace-env-js-stack",
	"--trace-env-native-stack", "--trace-promises", "--trace-sigint", "--trace-tls", "--track-heap-objects",
	"--use-bundled-ca", "--use-env-proxy", "--use-openssl-ca", "--use-system-ca", "--v8-options", "--zero-fill-buffers",
]);
const RM_RECURSIVE_OPTIONS = new Set(["--recursive"]);
const POWERSHELL_RECURSIVE_OPTIONS = new Set(["-recurse", "-r"]);
const POWERSHELL_TARGET_OPTIONS = new Set(["-path", "-literalpath"]);
const WINDOWS_RMDIR_RECURSIVE_OPTIONS = new Set(["/s"]);
const GIT_CLEAN_FORCE_OPTIONS = new Set(["-f", "--force"]);
const GIT_CLEAN_DIRECTORY_OPTIONS = new Set(["-d"]);
const SHELL_SCRIPT_FLAGS = new Set(["-c"]);
const CMD_SCRIPT_FLAGS = new Set(["/c"]);
const POWERSHELL_SCRIPT_FLAGS = new Set(["-command", "-c"]);
const SHELL_INPUT_DECODER = new TextDecoder("utf-8", { fatal: true });

function hasUnquotedBackgroundOperator(command: string): boolean {
	let quote: "'" | '"' | undefined;
	let escaped = false;
	for (let index = 0; index < command.length; index++) {
		const character = command[index];
		if (escaped) {
			escaped = false;
			continue;
		}
		if (character === "\\" && quote !== "'") {
			escaped = true;
			continue;
		}
		if (quote) {
			if (character === quote) quote = undefined;
			continue;
		}
		if (character === "'" || character === '"') {
			quote = character;
			continue;
		}
		if (character !== "&") continue;
		const previous = command[index - 1];
		const next = command[index + 1];
		if (previous === "&" || next === "&") continue;
		if (previous === ">" || previous === "<" || next === ">") continue;
		return true;
	}
	return false;
}

// One literal foreground job, immutable PID binding, bounded literal use, exact cleanup.
function hasBoundedOwnedUse(work: string | undefined): boolean {
 if (work === undefined) return true;
 const commands = work.split(";");
 if (commands.length > 16) return false;
 for (const command of commands) if (!OWNED_USE_COMMAND_PATTERN.test(command.trim())) return false;
 return true;
}
export const UNCERTAIN_LIFECYCLE = "[SHELL_UNINSPECTABLE] This Bash call was not executed: uncertain/uninspectable shell structure.\nRetry: use an inspectable foreground command and resubmit for authorization.";
function lifecycleRefusal(code: string, reason: string, recovery: string): string {
 return `[${code}] This Bash call was not executed: ${reason}.\nRetry: ${recovery}; resubmit for authorization.`;
}
function dynamicExecutable(token: string | undefined): string {
 // Echo only a simple variable name, never command substitutions or arbitrary operands.
 const variable = token && SIMPLE_VARIABLE_PATTERN.test(token) ? ` (${token})` : "";
 return lifecycleRefusal("SHELL_DYNAMIC_EXECUTABLE", `executable position uses a variable or dynamic expression${variable}`, "use the quoted literal executable path in a foreground command");
}

type NativePowerShellAvailability = boolean | (() => "active" | "discoverable" | "unavailable");
export function inspectBashResourceLifecycle(input: unknown, nativePowerShellAvailable: NativePowerShellAvailability = false, analysisOwner?: ShellAnalysisOwner): string | undefined {
 if (!input || typeof input !== "object") return undefined;
 const command = (input as { command?: unknown }).command;
 if (typeof command !== "string" || command.length === 0) return undefined;
 if (command.length > MAX_INSPECTED_COMMAND_CHARS) return lifecycleRefusal("SHELL_INSPECTION_LIMIT", "command exceeds the inspection size limit", "reduce this command's size");
 return inspectLifecycleScript(command, 0, nativePowerShellAvailable, analysisOwner);
}

function inspectLifecycleScript(source: string, depth: number, nativePowerShellAvailable: NativePowerShellAvailability = false, analysisOwner?: ShellAnalysisOwner, descriptorContext?: DescriptorContext): string | undefined {
 if (depth > MAX_WRAPPER_DEPTH) return lifecycleRefusal("SHELL_INSPECTION_LIMIT", "wrapper/substitution nesting exceeds the inspection depth", "reduce nesting");
 if (isReadOnlyFindLoop(source)) return undefined;
 const prepared = analysisOwner ? analysisOwner.get(source) : analyzeShellSource(source);
 const here = prepared.view;
 const command = here.command;
 const substitutions = prepared.substitutions;
 if (here.unboundedHeredoc || substitutions.boundaryRefusal === 2) return lifecycleRefusal("SHELL_HEREDOC", "heredoc or CR-sensitive source boundaries cannot be inspected for executable input or following commands", "use a bounded literal heredoc outside function substitution, without CR-sensitive delimiters or escapes");
 if (here.uninspectableFunction || substitutions.boundaryRefusal === 1) return UNCERTAIN_LIFECYCLE;
 // Check already-visible launches before deferring parser diagnostics to permissions.
 if (DETACH_UTILITY_PATTERN.test(command)) return BLOCK_REASON;
 if ((WINDOWS_DETACH_PATTERN.test(command) || WINDOWS_START_BACKGROUND_PATTERN.test(command)) && !WINDOWS_WAIT_PATTERN.test(command)) return BLOCK_REASON;
 if (DOCKER_DETACHED_PATTERN.test(command) || SERVICE_START_PATTERN.test(command)) return BLOCK_REASON;
 if (hasUnquotedBackgroundOperator(command)) {
  const owned = OWNED_FOREGROUND_JOB_PATTERN.exec(command);
  if (!owned || !hasBoundedOwnedUse(owned[2])) return BLOCK_REASON;
  const ownedName = commandName(owned[1]!);
  if (OPAQUE_JOB_LAUNCHER_PATTERN.test(ownedName) || PYTHON_COMMAND_PATTERN.test(ownedName) || NODE_COMMAND_PATTERN.test(ownedName)) return BLOCK_REASON;
 }
 if (here.hasHeredoc && heredocHasAliasRisk(command)) return lifecycleRefusal("SHELL_HEREDOC", "alias expansion or definitions may change the heredoc consumer", "use a separate call without alias changes, file sourcing or eval");
 if (hasUnboundDescriptorSource(command, here.hereDocuments, descriptorContext)) return lifecycleRefusal("SHELL_HEREDOC", "a script descriptor has no inspectable binding in this command and may be inherited", "bind the descriptor explicitly in this call or use an inspectable literal script");
 if (here.substitutionUncertain) return lifecycleRefusal("SHELL_SUBSTITUTION", "uncertain/uninspectable executable heredoc substitution", "simplify the substitution into inspectable foreground commands");
 if (substitutions.limitExceeded === "count") return `[SHELL_INSPECTION_LIMIT] Bash not executed: more than ${MAX_SUBSTITUTIONS} command substitutions per script.\nRetry: split into smaller calls (max ${MAX_SUBSTITUTIONS} each).`;
 if (substitutions.limitExceeded === "nesting") return `[SHELL_INSPECTION_LIMIT] Bash not executed: command substitution nesting exceeds ${MAX_SUBSTITUTION_NESTING} levels.\nRetry: reduce nesting.`;
 if (substitutions.unterminated || substitutions.unsupported) return lifecycleRefusal("SHELL_SUBSTITUTION", substitutions.unterminated ? "unterminated command substitution" : "uncertain/uninspectable command substitution grammar", "simplify the substitution into inspectable foreground commands");
 for (const script of here.substitutions) { const result = inspectLifecycleScript(script, depth + 1, nativePowerShellAvailable, analysisOwner); if (result) return result; }
 for (const script of substitutions.scripts) { const result = inspectLifecycleScript(script, depth + 1, nativePowerShellAvailable, analysisOwner); if (result) return result; }
 const trapScripts = literalStoredScripts(command);
 if (trapScripts === null) return lifecycleRefusal("SHELL_INSPECTION_LIMIT", "resolved stored actions exceed the source count or size limit", "split stored actions into smaller inspectable calls");
 if (trapScripts) for (const script of trapScripts) { const result = inspectLifecycleScript(script, depth + 1, nativePowerShellAvailable, analysisOwner); if (result) return result; }
 const processScripts = literalProcessSources(command);
 if (processScripts === null) return lifecycleRefusal("SHELL_INSPECTION_LIMIT", "sourced process-substitution bodies exceed the source count or size limit", "split sourced input into smaller inspectable calls");
 if (processScripts === false) return UNCERTAIN_LIFECYCLE;
 if (processScripts) for (const script of processScripts) { const result = inspectLifecycleScript(script, depth + 1, nativePowerShellAvailable, analysisOwner); if (result) return result; }
 if (here.hereDocuments) for (const document of here.hereDocuments) {
  const consumers = heredocDocumentConsumers(document, command, here.hereDocuments);
  if (consumers & 1 && document.expanded) return lifecycleRefusal("SHELL_HEREDOC", "expanded shell heredoc source cannot be inspected as literal input", "use a quoted delimiter with an inspectable literal shell body");
  if (consumers & 1 && document.hasCarriageReturn) return lifecycleRefusal("SHELL_HEREDOC", "CR-bearing shell heredoc source has transport-dependent semantics", "use an LF-only shell body and resubmit for authorization");
  if (consumers & 8) return lifecycleRefusal("SHELL_HEREDOC", "heredoc executable input or consumer nesting cannot be inspected", "use a direct literal stdin consumer without transforming its input");
  const body = heredocExecutableBody(document, command);
  if (consumers & 1 && body === undefined) return lifecycleRefusal("SHELL_HEREDOC", "a shell heredoc consumer receives an uninspectable transformed body", "use a supported literal transform or an inspectable literal shell body");
  if (consumers & 1 && body !== undefined) {
   if (heredocHasAliasRisk(body)) return lifecycleRefusal("SHELL_HEREDOC", "sourced heredoc input may change aliases or later consumers", "use a separate call without alias changes, file sourcing or eval");
   const result = inspectLifecycleScript(body, depth + 1, nativePowerShellAvailable, analysisOwner);
   if (result) return result;
  }
 }
 if (!SHELL_WRAPPER_TEXT_PATTERN.test(command) && !EXECUTABLE_EXPANSION_TEXT_PATTERN.test(command) && !command.includes("[[") && !command.includes("((") && !command.includes("for") && !command.includes("select") && !command.includes("coproc")) return undefined;
 const segments = parseShellSegments(command, true);
 if (segments.length > MAX_SCRIPT_SEGMENTS) return lifecycleRefusal("SHELL_INSPECTION_LIMIT", "too many command segments", "reduce the number of segments");
 for (let segment = 0; segment < segments.length; segment++) {
  const tokens = segments[segment]!;
  const coprocBody = coprocBodyIndex(tokens);
  if (coprocBody >= tokens.length && tokens[coprocBody - 1] === "coproc" && tokens.separatorAfter === "(") return UNCERTAIN_LIFECYCLE;
  if (tokens.bashTestProcessSubstitution) return lifecycleRefusal("SHELL_UNINSPECTABLE", "process substitution inside a Bash test cannot be safely inspected", "split the process substitution into separately inspectable commands");
  if (hasUnsafeBashTestOperand(tokens) || hasUnsafeBashBuiltinOperand(tokens)) return lifecycleRefusal("SHELL_UNINSPECTABLE", "Bash test, callback or name operand may execute uninspected arithmetic or source", "use callback-free reads, simple variable tests and literal numeric subscripts/comparisons");
  if (hasBareBashArithmeticCommand(tokens)) return lifecycleRefusal("SHELL_UNINSPECTABLE", "arithmetic command can change later shell state", "use an inspectable foreground command without a bare arithmetic command");
  // Assignment, arithmetic and lookup uncertainty is classified by permissions.
  // It cannot turn a visible detached launch into an authorized foreground job.
  // The global filter is only an optimization; unrelated segments supply no
  // shell/evaluator evidence. No closure or reconstructed segment string.
  let shellText = false;
  let dynamicText = false;
  for (const token of tokens) {
   if (SHELL_WRAPPER_TEXT_PATTERN.test(token)) shellText = true;
   if (EXECUTABLE_EXPANSION_TEXT_PATTERN.test(token)) dynamicText = true;
  }
  if (!shellText && !dynamicText) continue;
  let index = tokens[0] === "do" || tokens[0] === "{" ? 1 : 0; let changedLookup = false; let prefixes = 0;
  if (tokens[0] === "for" || tokens[0] === "done" || tokens[0] === "}" || index >= tokens.length) continue;
  while (index < tokens.length) {
   const token = tokens[index]!;
   if (++prefixes > MAX_SCRIPT_SEGMENTS) return lifecycleRefusal("SHELL_INSPECTION_LIMIT", "too many command prefixes", "reduce prefixes");
   if (LEADING_ASSIGNMENT_PATTERN.test(token)) {
    // Shell assignment words do not undergo field splitting (unlike env argv).
    changedLookup = true; index++; continue;
   }
   const redirection = LEADING_REDIRECTION_PATTERN.exec(token);
   if (redirection) {
    changedLookup = true; index++;
    if (!redirection[1]) { if (!tokens[index]) return UNCERTAIN_LIFECYCLE; index++; }
    continue;
   }
   const prefix = token === "command" || token === "exec" || token === "builtin" ? token : "";
   if (!prefix) break;
   if (prefix === "command" && (tokens[index + 1] === "-v" || tokens[index + 1] === "-V")) {
    // Query operands are names to inspect, never executable positions. Nested
    // substitutions were inspected above before this branch.
    if (hasUnsafeCommandQueryOperand(tokens, index + 2)) return lifecycleRefusal("SHELL_UNINSPECTABLE", "command query operand has state-changing or uncertain expansion", "use literal names or simple variable references");
    index = tokens.length;
    break;
   }
   index++;
   if (prefix === "builtin" && tokens[index] === "--") index++;
   if (index > MAX_WRAPPER_DEPTH || !tokens[index] || tokens[index]!.startsWith("-")) return lifecycleRefusal("SHELL_WRAPPER", "unsupported command/exec prefix depth or operand", "use a direct foreground executable");
  }
  if (index >= tokens.length) continue;
  if (tokens.bashTestOpenAt === index && tokens.bashTestClosed && tokens[index] === "[[") continue;
  if (REDIRECTION_OPERATOR_PATTERN.test(tokens[index] ?? "")) return UNCERTAIN_LIFECYCLE;
  if (tokens.expansions?.[index] || hasDynamicSyntax(tokens[index] ?? "")) continue;
  let name = commandName(tokens[index] ?? "");
  // Only literal, option-free launcher operands are resolved. env assignments are
  // data, not executable names; split-string/options/dynamic lookup stay unknown.
  let launchers = 0;
  while (OPAQUE_JOB_LAUNCHER_PATTERN.test(name) && !SCRIPT_WRAPPERS.has(name)) {
   if (++launchers > MAX_WRAPPER_DEPTH) return lifecycleRefusal("SHELL_INSPECTION_LIMIT", "too many nested launchers", "reduce launcher nesting");
   if (name === "timeout" || name === "timeout.exe") {
    const parsed = parseTimeoutInvocation(tokens, index);
    if (!parsed.supported) return lifecycleRefusal("SHELL_WRAPPER", parsed.reason, "使用受支持的正整数秒字面量格式，或直接调用内部程序并设置工具超时；不同子命令的超时不能静默合并");
    index = parsed.commandIndex;
    if (tokens.expansions?.[index]) return dynamicExecutable(tokens[index]);
    name = commandName(tokens[index]!);
    continue;
   }
   // Other launchers (e.g. timeout durations, xargs/busybox modes) need different
   // operand grammars; never mistake their option/argument for the executable.
   if (name !== "env" && name !== "sudo" && name !== "doas") {
    if (POWERSHELL_WRAPPERS.has(name)) {
     const availability = typeof nativePowerShellAvailable === "function" ? nativePowerShellAvailable() : nativePowerShellAvailable ? "active" : "unavailable";
     return renderPolicyDiagnostic({ code: "LAUNCHER_UNSUPPORTED", category: "SHELL_WRAPPER", launcher: name, nativeToolAvailable: availability === "active", nativeToolDiscoverable: availability === "discoverable", retryable: false, action: "native_tool" });
    }
    return lifecycleRefusal("SHELL_WRAPPER", "launcher operand grammar is uncertain/uninspectable", "use a directly inspectable foreground executable");
   }
   if (name === "env" && hasUninspectableEnvLauncher(tokens, index)) return lifecycleRefusal("SHELL_WRAPPER", "launcher operand grammar is uncertain/uninspectable", "use a directly inspectable foreground executable");
   index++;
   if (tokens[index] === "--") index++;
   if (name === "env" || name === "sudo") {
    // env and sudo accept NAME=VALUE beyond Bash identifiers (e.g. foo.bar).
    while (index < tokens.length && tokens[index]!.includes("=")) {
     if (uncertainAssignment(tokens, index)) return lifecycleRefusal("SHELL_UNINSPECTABLE", "uncertain launcher assignment expansion or lookup", "use literal launcher assignments");
     index++;
    }
   }
   // Shell redirections are removed from argv, not launcher executables. Their
   // interleaved/quoted provenance is outside this token view: refuse, don't guess.
   if (REDIRECTION_OPERATOR_PATTERN.test(tokens[index] ?? "")) return UNCERTAIN_LIFECYCLE;
   if (!tokens[index] || tokens[index]!.startsWith("-")) return lifecycleRefusal("SHELL_WRAPPER", "missing or unsupported launcher operand", "use a directly inspectable foreground executable");
   if (hasDynamicSyntax(tokens[index]!)) return dynamicExecutable(tokens[index]);
   changedLookup = true;
   name = commandName(tokens[index]!);
  }
  // Resolve only this segment; unrelated text in another command is not authority or uncertainty.
  if (changedLookup && SCRIPT_WRAPPERS.has(name)) return lifecycleRefusal("SHELL_WRAPPER", "shell lookup was changed by a prefix", "remove the lookup-changing prefix from the shell wrapper");
  if (tokens.dynamic && (SCRIPT_WRAPPERS.has(name) || name === "eval")) return lifecycleRefusal("SHELL_WRAPPER", "shell/eval operand contains dynamic expansion", "supply a literal inspectable script operand");
  if (name === "alias" && tokens[index] === "alias") {
   for (let operand = skipRedirections(tokens, index + 1); operand < tokens.length; operand = skipRedirections(tokens, operand + 1)) {
    if (tokens[operand]!.indexOf("=") < 1) continue;
    const script = literalAliasSource(tokens, operand);
    if (script === undefined) continue;
    const result = inspectLifecycleScript(script, depth + 1, nativePowerShellAvailable, analysisOwner); if (result) return result;
   }
   continue;
  }
  if (name === "eval" && tokens[index] === "eval") {
   const script = literalEvalScript(tokens, index + 1);
   if (script === undefined || script.includes("<<")) return lifecycleRefusal("SHELL_WRAPPER", "eval operand cannot be inspected as literal executable source", "use directly inspectable foreground commands");
   const result = inspectLifecycleScript(script, depth + 1, nativePowerShellAvailable, analysisOwner); if (result) return result;
   continue;
  }
  if (name === "trap" && tokens[index] === "trap") {
   let actionIndex = skipRedirections(tokens, index + 1);
   const endOfOptions = tokens[actionIndex] === "--";
   if (endOfOptions) actionIndex = skipRedirections(tokens, actionIndex + 1);
   let action = tokens[actionIndex];
   if (action && action !== "-" && (endOfOptions || action !== "-p" && action !== "-l")) {
    if (tokens.expansions?.[actionIndex]) {
     const literal = literalAdjacentSource(segments[segment - 1], action);
     if (literal === undefined) return lifecycleRefusal("SHELL_WRAPPER", "trap action cannot be inspected as literal executable source", "supply a literal inspectable trap action");
     action = literal;
    }
    const result = inspectLifecycleScript(action, depth + 1, nativePowerShellAvailable, analysisOwner); if (result) return result;
   }
   continue;
  }
  if (!SCRIPT_WRAPPERS.has(name)) continue;
  // A bounded heredoc passed to a syntax-only shell is data. Keep the general
  // wrapper grammar unchanged outside this explicitly identified mode.
  if (here.hasHeredoc && simpleStdinConsumers(tokens, 0, depth, undefined, index) === 16) continue;
  const flag = index + 1;
  const scriptIndex = tokens[flag] === "-c" ? bashScriptOperandIndex(tokens, flag) : -1;
  if (scriptIndex < 0) return lifecycleRefusal("SHELL_WRAPPER", "shell wrapper requires a direct literal -c script operand", "use a supported direct -c operand");
  const result = inspectLifecycleScript(tokens[scriptIndex]!, depth + 1, nativePowerShellAvailable, analysisOwner,
   { segments, current: segment, documents: here.hereDocuments, parent: descriptorContext }); if (result) return result;
 }
 return undefined;
}

export interface HighRiskMutationScan {
	risk: "HIGH";
	/** True only for a recognized mutation, never for parser uncertainty alone. */
	mutationDetected: boolean;
	contextUncertain: boolean;
	primitives: string[];
	targets: string[];
	dynamicScope: boolean;
	unverifiableScope: boolean;
	workspaceWide: boolean;
	diagnostic?: PolicyDiagnosticMetadata;
}

type ShellSegment = string[] & { sourceStart?: number; dynamic?: boolean; expansions?: number[]; redirections?: number[]; redirectionFds?: (string | undefined)[]; subshellDepth?: number; subshellClosedAfter?: boolean; pipelineMember?: boolean; conditionalMember?: boolean; separatorAfter?: string; firstWordQuoted?: boolean; secondWordQuoted?: boolean; thirdWordQuoted?: boolean; bashTestOpenAt?: number; bashTestClosed?: boolean; bashTestProcessSubstitution?: boolean; bashArithmeticCommandAt?: number };

function uncertainAssignment(tokens: ShellSegment, index: number, shellAssignment = false): boolean {
 const expansion = tokens.expansions?.[index] ?? 0;
 return (expansion & (shellAssignment ? 4 : 14)) !== 0 || (expansion !== 0 && LOOKUP_ASSIGNMENT_PATTERN.test(tokens[index]!));
}

interface ScanBuilder {
	primitives: string[];
	targets: string[];
	targetSet: Set<string>;
	dynamicScope: boolean;
	unverifiableScope: boolean;
	workspaceWide: boolean;
	segmentsVisited: number;
	analysisOwner?: ShellAnalysisOwner;
	mutationDetected: boolean;
	unverifiableMutation: boolean;
	diagnostic?: PolicyDiagnosticMetadata;
}

export function inspectHighRiskBashMutation(input: unknown, cwd: string, shellOperation: "bash" | "powershell" = "bash", analysisOwner?: ShellAnalysisOwner): HighRiskMutationScan | undefined {
	if (!input || typeof input !== "object") return undefined;
	const command = (input as { command?: unknown }).command;
	if (typeof command !== "string" || command.length === 0) return undefined;
	if (command.length > MAX_INSPECTED_COMMAND_CHARS) {
		return {
			risk: "HIGH",
			mutationDetected: false,
			contextUncertain: true,
			primitives: ["oversized_uninspectable"],
			targets: [],
			dynamicScope: true,
			unverifiableScope: true,
			workspaceWide: false,
			diagnostic: policyMetadata(diagnosticForPrimitives(["oversized_uninspectable"]), renderPolicyDiagnostic(diagnosticForPrimitives(["oversized_uninspectable"]))),
		};
	}

	if (shellOperation === "bash" && (isLiteralReadLoop(command) || isReadOnlyFindLoop(command))) return undefined;
	const builder: ScanBuilder = {
		primitives: [],
		targets: [],
		targetSet: new Set(),
		dynamicScope: false,
		unverifiableScope: false,
		workspaceWide: false,
		segmentsVisited: 0,
		analysisOwner,
		mutationDetected: false,
		unverifiableMutation: false,
	};
	inspectShellScript(command, resolve(cwd), 0, builder, shellOperation);
	// Parser uncertainty is not itself evidence of a mutation. The permission
	// classifier retains that uncertainty as opaque input in every access mode.
	if (builder.primitives.length === 0) return undefined;
	return {
		risk: "HIGH",
		mutationDetected: builder.mutationDetected,
		contextUncertain: builder.unverifiableScope,
		primitives: builder.primitives,
		targets: builder.targets,
		dynamicScope: builder.dynamicScope,
		unverifiableScope: builder.unverifiableMutation,
		workspaceWide: builder.workspaceWide,
		diagnostic: builder.diagnostic,
	};
}

export function structuredMutationBlock(
	scan: HighRiskMutationScan,
	policyReason: "protected_root" | "confirmation_required" | "user_rejected",
	protectedRoots: readonly string[] = [],
): string {
	return JSON.stringify({
		ok: false,
		category: "POLICY_BLOCKED",
		operation: "bash",
		risk: scan.risk,
		policyReason,
		parserVersion: 2,
		primitives: scan.primitives,
		protectedRoots,
		targetsInspected: scan.targets.length,
		dynamicScope: scan.dynamicScope,
		unverifiableScope: scan.unverifiableScope,
		workspaceWide: scan.workspaceWide,
		stateChanged: false,
		retryable: policyReason !== "protected_root",
		requiresConfirmation: policyReason === "confirmation_required",
	});
}

function inspectOutputRedirections(tokens: ShellSegment, cwd: string, builder: ScanBuilder): void {
	const redirections = tokens.redirections;
	if (!redirections) return;
	for (let position = 0; position < redirections.length; position++) {
		const index = redirections[position]!;
		const operator = tokens[index]!;
		const target = index + 1 === redirections[position + 1] ? undefined : tokens[index + 1];
		const descriptorFd = tokens.redirectionFds?.[position];
		const writesFile = isShellOutputFileRedirection(operator, target, descriptorFd);
		if (writesFile && target !== "/dev/null") addMutationPrimitive(builder, "output_redirection");
		if (descriptorFd && isShellDynamicDescriptor(descriptorFd)) {
			addPrimitive(builder, "unverifiable_redirection");
			markUnverifiable(builder, writesFile && target !== "/dev/null");
			continue;
		}
		// Input redirections and heredocs remain with the existing lifecycle parser.
		// Numeric descriptor copies have no path target. Shell ordering is kept in
		// the source sent to Bash; only analysis tokens are compacted below.
		if (isStaticDescriptorCopy(operator, target, descriptorFd)) continue;
		if (operator === "<" && target && !hasDynamicSyntax(target) && !isBashNetworkRedirectionTarget(target)) continue;
		// Here-documents, descriptor moves/closures and dynamic copies stay opaque.
		if (!writesFile) {
			addPrimitive(builder, "unverifiable_redirection");
			const descriptor = descriptorFd ? `${descriptorFd}${operator}${target ?? ""}` : `${operator}${target ?? ""}`;
			if (builder.diagnostic === undefined && FD_DUPLICATION_PATTERN.test(descriptor)) {
				const diagnostic = diagnosticForPrimitives(builder.primitives, { syntax: descriptor });
				builder.diagnostic = policyMetadata(diagnostic, renderPolicyDiagnostic(diagnostic));
			}
			markUnverifiable(builder);
			continue;
		}
		if (target === "/dev/null") continue;
		if (!target || tokens.expansions?.[index + 1] || hasDynamicSyntax(target)) {
			markUnverifiable(builder, true);
			continue;
		}
		addTarget(builder, target, cwd);
	}
	stripShellRedirections(tokens, redirections);
	redirections.length = 0;
}

function inspectShellScript(script: string, initialCwd: string, depth: number, builder: ScanBuilder, shellOperation: "bash" | "powershell"): void {
	if (depth > MAX_WRAPPER_DEPTH) {
		markUnverifiable(builder, builder.mutationDetected);
		return;
	}
	const prepared = builder.analysisOwner ? builder.analysisOwner.get(script) : analyzeShellSource(script);
	const analysis = prepared.view;
	let uncertainStateStart = uninspectableBashStateStart(analysis.command);
	// Nested substitutions are inspected before the outer segment walk. Preserve
	// their prior conservative context until that source ordering is modeled.
	if (uncertainStateStart >= 0 && (analysis.substitutions.length || prepared.substitutions.scripts.length)) uncertainStateStart = 0;
	if (uncertainStateStart === 0) {
		uncertainStateStart = -1;
		addPrimitive(builder, "unverifiable_shell_state");
		markUnverifiable(builder);
	}
	if (analysis.uncertain) {
		addPrimitive(builder, "shell_context_uninspectable");
		markUnverifiable(builder);
	}
	const trapScripts = literalStoredScripts(analysis.command);
	if (trapScripts === null) markUnverifiable(builder, true);
	if (trapScripts) for (const source of trapScripts) { markUnverifiable(builder); inspectShellScript(source, initialCwd, depth + 1, builder, shellOperation); }
	const processScripts = literalProcessSources(analysis.command);
	if (processScripts === null) markUnverifiable(builder, true);
	if (processScripts === false) markUnverifiable(builder);
	if (processScripts) for (const source of processScripts) { markUnverifiable(builder); inspectShellScript(source, initialCwd, depth + 1, builder, shellOperation); }
	if (analysis.hereDocuments) for (const document of analysis.hereDocuments) {
		const consumers = heredocDocumentConsumers(document, analysis.command, analysis.hereDocuments), body = heredocExecutableBody(document, analysis.command);
		if (consumers & 15 && (document.priorSource || document.pipelineHeader || heredocHasUntrackedCwd(document.header))) markUnverifiable(builder);
		if (consumers & 1 && body !== undefined && !document.expanded) inspectShellScript(body, initialCwd, depth + 1, builder, "bash");
		if (consumers & 7 && document.expanded) { addPrimitive(builder, "heredoc_expanded_source"); markUnverifiable(builder); }
		if (consumers & 2 && body !== undefined && !document.expanded) inspectEmbeddedCode(body, "node", initialCwd, builder);
		if (consumers & 4 && body !== undefined && !document.expanded) inspectEmbeddedCode(body, "python", initialCwd, builder);
		if (consumers & 8) markUnverifiable(builder);
	}
	for (const nested of analysis.substitutions) inspectShellScript(nested, initialCwd, depth + 1, builder, shellOperation);
	const substitutions = prepared.substitutions;
	if (substitutions.unterminated) {
		addPrimitive(builder, "unterminated_command_substitution");
		markUnverifiable(builder);
	}
	if (substitutions.unsupported) markUnverifiable(builder);
	for (const nested of substitutions.scripts) inspectShellScript(nested, initialCwd, depth + 1, builder, shellOperation);
	const segments = parseShellSegments(analysis.command, true);
	const loopReason = unsafeBashLoopHeaders(segments);
	if (loopReason) { addPrimitive(builder, loopReason); markUnverifiable(builder); }
	let workingDirectory = initialCwd;
	for (const segment of segments) {
		if (uncertainStateStart >= 0 && segment.sourceStart! >= uncertainStateStart) {
			addPrimitive(builder, "unverifiable_shell_state"); markUnverifiable(builder); uncertainStateStart = -1;
		}
		builder.segmentsVisited++;
		if (builder.segmentsVisited > MAX_SCRIPT_SEGMENTS) {
			markUnverifiable(builder, builder.mutationDetected);
			return;
		}
		const tokens = segment;
		if (tokens.length === 0) continue;
		if (tokens.bashTestProcessSubstitution) { addPrimitive(builder, "unverifiable_process_substitution"); markUnverifiable(builder); continue; }
		if (hasUnsafeBashTestOperand(tokens)) {
			addPrimitive(builder, "unverifiable_bash_test_operand"); markUnverifiable(builder);
			// Bash evaluates arithmetic/test subscripts even when the source word
			// was quoted. Inspect visible substitutions in those evaluated words.
			for (const token of tokens) if (token.includes("$(") || token.includes("`")) {
				inspectShellScript(token, workingDirectory, depth + 1, builder, shellOperation);
			}
		}
		if (shellOperation === "bash" && shellExpansionRisk(tokens) !== 0) { addPrimitive(builder, "stateful_shell_expansion"); markUnverifiable(builder); }
		if (shellOperation === "bash" && hasBareBashArithmeticCommand(tokens)) {
			addPrimitive(builder, "unverifiable_arithmetic_command"); markUnverifiable(builder); continue;
		}
		inspectOutputRedirections(tokens, workingDirectory, builder);
		const commandIndex = commandTokenIndex(tokens);
		if (commandIndex < 0 || commandIndex >= tokens.length) continue;
		if (tokens[commandIndex] === "for" || tokens[commandIndex] === "done" || tokens[commandIndex] === "}") continue;
		const executableIndex = tokens[commandIndex] === "do" || tokens[commandIndex] === "{" ? commandIndex + 1 : commandIndex;
		if (executableIndex >= tokens.length) continue;
		const inspectedIndex = shellOperation === "bash" ? bashPipelinePrefixEnd(tokens, executableIndex) : executableIndex;
		if (inspectedIndex < 0) { addPrimitive(builder, "unverifiable_launcher"); markUnverifiable(builder); continue; }
		if (inspectedIndex >= tokens.length) continue;
		const command = commandName(tokens[inspectedIndex]!);
		// Only the bare, unlaunched builtin changes this shell's cwd; `./cd` or `env cd` cannot.
		if (tokens[inspectedIndex] === "cd" && commandIndex === 0) {
			if (inspectedIndex !== executableIndex) { addPrimitive(builder, "unverifiable_working_directory"); markUnverifiable(builder); continue; }
			const target = tokens[inspectedIndex + 1];
			if (!target || hasDynamicSyntax(target)) {
				builder.dynamicScope = true;
				builder.unverifiableScope = true;
			} else {
				workingDirectory = resolve(workingDirectory, target);
			}
			continue;
		}
		inspectCommand(tokens, inspectedIndex, command, workingDirectory, depth, builder, shellOperation);
	}
}

function inspectCommand(
	tokens: ShellSegment,
	commandIndex: number,
	command: string,
	cwd: string,
	depth: number,
	builder: ScanBuilder,
	shellOperation: "bash" | "powershell",
): void {
	if (command === "command" || command === "exec" || (shellOperation === "bash" && command === "builtin")) {
		if (tokens[commandIndex] !== command) { addPrimitive(builder, "unverifiable_launcher"); markUnverifiable(builder); return; }
		if (depth >= MAX_WRAPPER_DEPTH) { addPrimitive(builder, "unverifiable_launcher"); markUnverifiable(builder); return; }
		if (command === "command" && (tokens[commandIndex + 1] === "-v" || tokens[commandIndex + 1] === "-V")) {
			if (hasUnsafeCommandQueryOperand(tokens, commandIndex + 2)) { addPrimitive(builder, "unverifiable_command_query"); markUnverifiable(builder); }
			return;
		}
		const nextIndex = command === "builtin" && tokens[commandIndex + 1] === "--" ? commandIndex + 2 : commandIndex + 1;
		const next = tokens[nextIndex];
		if (!next || next.startsWith("-")) { addPrimitive(builder, "unverifiable_launcher"); markUnverifiable(builder); return; }
		inspectCommand(tokens, nextIndex, commandName(next), cwd, depth + 1, builder, shellOperation);
		return;
	}
	if (command === "printf" && hasStatefulBashPrintf(tokens, commandIndex)) {
		addPrimitive(builder, "stateful_printf_variable_assignment");
		markUnverifiable(builder);
		return;
	}
	if (shellOperation === "bash" && command === "alias" && tokens[commandIndex] === "alias") {
		for (let operand = commandIndex + 1; operand < tokens.length; operand++) {
			const source = literalAliasSource(tokens, operand);
			if (source !== undefined) { markUnverifiable(builder); inspectShellScript(source, cwd, depth + 1, builder, "bash"); }
		}
		return;
	}
	if (shellOperation === "bash" && command === "eval" && tokens[commandIndex] === "eval") {
		const source = literalEvalScript(tokens, commandIndex + 1);
		if (depth >= MAX_WRAPPER_DEPTH || source === undefined) {
			addPrimitive(builder, "unverifiable_eval"); markUnverifiable(builder);
		} else inspectShellScript(source, cwd, depth + 1, builder, "bash");
		return;
	}
	if (shellOperation === "bash" && command === "trap" && tokens[commandIndex] === "trap") {
		const actionIndex = tokens[commandIndex + 1] === "--" ? commandIndex + 2 : commandIndex + 1;
		const action = tokens[actionIndex];
		if (action && action !== "-" && action !== "-p" && action !== "-l" && !tokens.expansions?.[actionIndex]) {
			inspectShellScript(action, cwd, depth + 1, builder, "bash");
		}
		return;
	}
	if (SCRIPT_WRAPPERS.has(command)) {
		inspectScriptWrapper(tokens, commandIndex + 1, SHELL_SCRIPT_FLAGS, cwd, depth, builder, "bash", true);
		return;
	}
	if (command === "cmd" || command === "cmd.exe") {
		inspectScriptWrapper(tokens, commandIndex + 1, CMD_SCRIPT_FLAGS, cwd, depth, builder, shellOperation);
		return;
	}
	if (POWERSHELL_WRAPPERS.has(command)) {
		inspectScriptWrapper(tokens, commandIndex + 1, POWERSHELL_SCRIPT_FLAGS, cwd, depth, builder, "powershell");
		return;
	}
	if (NODE_COMMAND_PATTERN.test(command)) {
		inspectCodeWrapper(tokens, commandIndex + 1, "node", cwd, builder);
		return;
	}
	if (PYTHON_COMMAND_PATTERN.test(command)) {
		inspectCodeWrapper(tokens, commandIndex + 1, "python", cwd, builder);
		return;
	}
	if (command === "rm") inspectRm(tokens, commandIndex + 1, cwd, builder);
	else if (command === "remove-item") inspectPowerShellRemove(tokens, commandIndex + 1, cwd, builder);
	else if (command === "rmdir" || command === "rd") inspectWindowsRmdir(tokens, commandIndex + 1, cwd, builder);
	else if (command === "find") inspectFind(tokens, commandIndex + 1, cwd, builder);
	else if (command === "xargs") inspectXargs(tokens, commandIndex + 1, builder);
	else if (command === "git") inspectGit(tokens, commandIndex + 1, builder);
}

function inspectScriptWrapper(
	tokens: readonly string[],
	start: number,
	flags: ReadonlySet<string>,
	cwd: string,
	depth: number,
	builder: ScanBuilder,
	shellOperation: "bash" | "powershell",
	bashStyle = false,
): void {
	for (let index = start; index < tokens.length; index++) {
		if (!flags.has(tokens[index]!.toLowerCase())) continue;
		const scriptIndex = bashStyle ? bashScriptOperandIndex(tokens, index) : index + 1;
		const script = scriptIndex < 0 ? undefined : tokens[scriptIndex];
		if (!script) {
			builder.dynamicScope = true;
			builder.unverifiableScope = true;
			return;
		}
		inspectShellScript(script, cwd, depth + 1, builder, shellOperation);
		return;
	}
}

function inspectCodeWrapper(
	tokens: readonly string[],
	start: number,
	language: "node" | "python",
	cwd: string,
	builder: ScanBuilder,
): void {
	for (let index = start; index < tokens.length; index++) {
		const flag = tokens[index]!.toLowerCase();
		if ((language === "node" && flag !== "-e" && flag !== "--eval") || (language === "python" && flag !== "-c")) continue;
		const source = tokens[index + 1];
		if (!source) {
			builder.dynamicScope = true;
			builder.unverifiableScope = true;
			return;
		}
		inspectEmbeddedCode(source, language, cwd, builder);
		return;
	}
}

function inspectEmbeddedCode(source: string, language: "node" | "python", cwd: string, builder: ScanBuilder): void {
	const masked = maskCodeStringsAndComments(source, language, builder);
	if (language === "python") {
		inspectCodeCall(source, masked, PYTHON_RMTREE_PATTERN, "python_rmtree", cwd, builder);
		inspectCodeCall(source, masked, PYTHON_UNLINK_PATTERN, "python_unlink", cwd, builder);
		return;
	}
	inspectCodeCall(source, masked, NODE_RM_CALL_PATTERN, "node_recursive_rm", cwd, builder);
	inspectCodeCall(source, masked, NODE_UNLINK_PATTERN, "node_unlink", cwd, builder);
}

function inspectCodeCall(
	source: string,
	masked: string,
	pattern: RegExp,
	primitive: string,
	cwd: string,
	builder: ScanBuilder,
): void {
	// Module regexes are borrowed only for this synchronous scan. Reset on every
	// exit, including the bounded overflow path; no per-call regex or source copy.
	pattern.lastIndex = 0;
	try {
		let calls = 0;
		for (let match = pattern.exec(masked); match; match = pattern.exec(masked)) {
			if (++calls > MAX_SCRIPT_SEGMENTS) { markUnverifiable(builder, true); return; }
			const open = pattern === PYTHON_UNLINK_PATTERN ? pythonPathArgumentOpen(masked, match.index) : pattern.lastIndex - 1;
			const indirect = (pattern === NODE_RM_CALL_PATTERN || pattern === NODE_UNLINK_PATTERN) && nodeIndirectCall(masked, open);
			const recursive = indirect ? -1 : pattern === NODE_RM_CALL_PATTERN ? nodeHasRecursiveOption(masked, open) : 1;
			if (!recursive) continue;
			addMutationPrimitive(builder, primitive);
			const literal = open >= 0 && recursive > 0 ? literalFirstArgument(source, open, primitive === "python_unlink") : undefined;
			if (literal === undefined) markUnverifiable(builder, true);
			else addTarget(builder, literal, cwd);
		}
	} finally { pattern.lastIndex = 0; }
}

/** No positional interpretation of call/apply receiver/argument lists. */
function nodeIndirectCall(masked: string, open: number): boolean {
	let end = open;
	while (end > 0 && (isCodeWhitespace(masked.charCodeAt(end - 1)) || masked.charCodeAt(end - 1) === 41)) end--;
	if (masked.charCodeAt(end - 1) === 46 && masked.charCodeAt(end - 2) === 63) end -= 2;
	while (end > 0 && (isCodeWhitespace(masked.charCodeAt(end - 1)) || masked.charCodeAt(end - 1) === 41)) end--;
	return masked.endsWith("call", end) || masked.endsWith("apply", end);
}

/** Resolve only a direct Path constructor receiver. The existing mask preserves
 * offsets while hiding strings/comments; other receivers keep unknown scope. */
function pythonPathArgumentOpen(masked: string, methodDot: number): number {
	let index = methodDot - 1;
	while (index >= 0) {
		const code = masked.charCodeAt(index);
		if (code !== 32 && code !== 9 && code !== 10 && code !== 13) break;
		index--;
	}
	if (masked.charCodeAt(index) !== 41) return -1;
	let depth = 1;
	while (--index >= 0) {
		const code = masked.charCodeAt(index);
		if (code === 41) depth++;
		else if (code === 40 && --depth === 0) break;
	}
	if (index < 0) return -1;
	const open = index;
	while (index > 0) {
		const code = masked.charCodeAt(index - 1);
		if (code !== 32 && code !== 9 && code !== 10 && code !== 13) break;
		index--;
	}
	if (!masked.endsWith("Path", index)) return -1;
	const before = masked.charCodeAt(index - 5);
	if (before === 95 || before >= 48 && before <= 57 || before >= 65 && before <= 90 || before >= 97 && before <= 122) return -1;
	return open;
}

/** The existing mask removes strings/comments. Balance this call's parentheses
 * only; do not decode or evaluate nested arguments or borrow a later call's flag. */
function nodeHasRecursiveOption(masked: string, open: number): number {
	let depth = 1, options = false;
	try {
		for (let index = open + 1; index < masked.length; index++) {
			const code = masked.charCodeAt(index);
			// A remaining slash can start a regex literal or division. Neither is
			// parsed by this mask; do not let its punctuation erase a known rm call.
			if (code === 47) return -1;
			if (code === 40) depth++;
			else if (code === 41 && --depth === 0) return options ? -1 : 0;
			if (code === 44 && depth === 1 && !options) {
				options = true;
				NODE_NONRECURSIVE_OPTIONS_PATTERN.lastIndex = index + 1;
				// Only an entire bounded literal nonrecursive options object proves
				// absence. Quoted/computed keys, spreads and variables stay unknown.
				if (NODE_NONRECURSIVE_OPTIONS_PATTERN.test(masked)) return 0;
			}
			if (code !== 82 && code !== 114) continue;
			NODE_RECURSIVE_OPTION_PATTERN.lastIndex = index;
			if (NODE_RECURSIVE_OPTION_PATTERN.test(masked)) return 1;
		}
		return options ? -1 : 0;
	} finally { NODE_RECURSIVE_OPTION_PATTERN.lastIndex = NODE_NONRECURSIVE_OPTIONS_PATTERN.lastIndex = 0; }
}

function inspectRm(tokens: readonly string[], start: number, cwd: string, builder: ScanBuilder): void {
	let recursive = false;
	let optionsEnded = false;
	for (let index = start; index < tokens.length; index++) {
		const value = tokens[index]!;
		if (!optionsEnded && value === "--") {
			optionsEnded = true;
			continue;
		}
		if (!optionsEnded && value.startsWith("-")) {
			if (RM_RECURSIVE_OPTIONS.has(value.toLowerCase()) || shortOptionContains(value, "r")) recursive = true;
		}
	}
	if (!recursive) return;
	addMutationPrimitive(builder, "rm_recursive");
	collectPositionalTargets(tokens, start, cwd, builder, "dash");
}

function inspectPowerShellRemove(tokens: readonly string[] & { expansions?: readonly number[] }, start: number, cwd: string, builder: ScanBuilder): void {
	let recursive = false;
	for (let index = start; index < tokens.length; index++) {
		if (POWERSHELL_RECURSIVE_OPTIONS.has(tokens[index]!.toLowerCase())) recursive = true;
	}
	if (!recursive) return;
	addMutationPrimitive(builder, "powershell_remove_recursive");
	let explicitTarget = false;
	for (let index = start; index < tokens.length; index++) {
		const value = tokens[index]!;
		const lower = value.toLowerCase();
		if (POWERSHELL_TARGET_OPTIONS.has(lower)) {
			const target = tokens[++index];
			if (target) {
				addTarget(builder, target, cwd, tokens.expansions?.[index]);
				explicitTarget = true;
			}
			continue;
		}
		if (!value.startsWith("-")) {
			addTarget(builder, value, cwd, tokens.expansions?.[index]);
			explicitTarget = true;
		}
	}
	if (!explicitTarget) markUnverifiable(builder, true);
}

function inspectWindowsRmdir(tokens: readonly string[], start: number, cwd: string, builder: ScanBuilder): void {
	let recursive = false;
	for (let index = start; index < tokens.length; index++) {
		if (WINDOWS_RMDIR_RECURSIVE_OPTIONS.has(tokens[index]!.toLowerCase())) recursive = true;
	}
	if (!recursive) return;
	addMutationPrimitive(builder, "windows_rmdir_recursive");
	let found = false;
	for (let index = start; index < tokens.length; index++) {
		const value = tokens[index]!;
		if (value.startsWith("/")) continue;
		addTarget(builder, value, cwd);
		found = true;
	}
	if (!found) markUnverifiable(builder, true);
}

function inspectFind(tokens: readonly string[] & { expansions?: readonly number[] }, start: number, cwd: string, builder: ScanBuilder): void {
	let deleteAction = false;
	let execAction = false;
	for (let index = start; index < tokens.length; index++) {
		const value = tokens[index]!;
		if (!execAction && !tokens.expansions?.[index] && (value === "--help" || value === "--version")) return;
		if (findPredicateHasOperand(value) || value === "-fprint" || value === "-fprint0" || value === "-fls") { index++; continue; }
		if (value === "-fprintf") { index += 2; continue; }
		if (value === "-delete") deleteAction = true;
		else if (value === "-exec" || value === "-execdir") execAction = true;
	}
	if (!deleteAction && !execAction) return;
	addMutationPrimitive(builder, deleteAction ? "find_delete" : "find_exec");
	if (execAction) markUnverifiable(builder, true);
	const target = findSearchRootIndex(tokens, start);
	if (target >= 0) addTarget(builder, tokens[target]!, cwd, tokens.expansions?.[target]);
	else markUnverifiable(builder, true);
}

function findSearchRootIndex(tokens: readonly string[], start: number): number {
	for (let index = start; index < tokens.length; index++) {
		const value = tokens[index]!;
		if (value === "--") return tokens[index + 1] && !tokens[index + 1]!.startsWith("-") ? index + 1 : -1;
		if (value === "-H" || value === "-L" || value === "-P") continue;
		if (value.startsWith("-")) return -1;
		return index;
	}
	return -1;
}

function inspectXargs(tokens: readonly string[], start: number, builder: ScanBuilder): void {
	for (let index = start; index < tokens.length; index++) {
		if (commandName(tokens[index]!) !== "rm") continue;
		addMutationPrimitive(builder, "xargs_rm");
		markUnverifiable(builder, true);
		return;
	}
}

function inspectGit(tokens: readonly string[], start: number, builder: ScanBuilder): void {
	const subcommand = tokens[start]?.toLowerCase();
	if (subcommand === "reset") {
		for (let index = start + 1; index < tokens.length; index++) {
			if (tokens[index]!.toLowerCase() !== "--hard") continue;
			addMutationPrimitive(builder, "git_reset_hard");
			builder.workspaceWide = true;
			return;
		}
		return;
	}
	if (subcommand !== "clean") return;
	let force = false;
	let directories = false;
	for (let index = start + 1; index < tokens.length; index++) {
		const option = tokens[index]!.toLowerCase();
		if (GIT_CLEAN_FORCE_OPTIONS.has(option) || shortOptionContains(option, "f")) force = true;
		if (GIT_CLEAN_DIRECTORY_OPTIONS.has(option) || shortOptionContains(option, "d")) directories = true;
	}
	if (!force || !directories) return;
	addMutationPrimitive(builder, "git_clean");
	builder.workspaceWide = true;
}

function collectPositionalTargets(
	tokens: readonly string[] & { expansions?: readonly number[] },
	start: number,
	cwd: string,
	builder: ScanBuilder,
	optionStyle: "dash",
): void {
	let found = false;
	let optionsEnded = false;
	for (let index = start; index < tokens.length; index++) {
		const value = tokens[index]!;
		if (!optionsEnded && value === "--") {
			optionsEnded = true;
			continue;
		}
		if (!optionsEnded && optionStyle === "dash" && value.startsWith("-")) continue;
		addTarget(builder, value, cwd, tokens.expansions?.[index]);
		found = true;
	}
	if (!found) markUnverifiable(builder, true);
}

function addTarget(builder: ScanBuilder, rawTarget: string, cwd: string, expansion = 0): void {
	const target = staticMutationTarget(rawTarget, cwd, expansion);
	if (target === undefined) { builder.dynamicScope = true; markUnverifiable(builder, true); return; }
	addResolvedTarget(builder, target);
}

function addResolvedTarget(builder: ScanBuilder, target: string): void {
	if (builder.targetSet.has(target)) return;
	if (builder.targets.length >= MAX_MUTATION_TARGETS) {
		markUnverifiable(builder, true);
		return;
	}
	builder.targetSet.add(target);
	builder.targets.push(target);
}

function addMutationPrimitive(builder: ScanBuilder, primitive: string): void {
	builder.mutationDetected = true;
	if (builder.unverifiableScope) builder.unverifiableMutation = true;
	addPrimitive(builder, primitive);
}

/** Literal interpreter stdin is executable source; data consumers remain opaque
 * data. This is analysis only and never reconstructs the command for execution. */
function nodeMayReadStdin(tokens: readonly string[] & { expansions?: readonly number[] }, start: number, descriptor = 0): boolean {
	// Unknown Node/V8 options may take zero or one value. Track both possible
	// argv interpretations with primitive states; a value is never proof of a
	// program operand, even when that value itself resembles a source flag.
	// Bits: option parsing without/with eval=1/2, unknown option value=4/8,
	// eval source=16, first operand after -- without/with eval=32/64.
	let states = 1, interactive = false;
	for (let index = start; index < tokens.length; index++) {
		const word = tokens[index]!;
		// A forwarded expansion can disappear or supply flags/descriptor paths.
		// It cannot establish a definite program operand in any live argv state.
		if (states && tokens.expansions?.[index]) return true;
		if (states & 32 && (word === "-" && descriptor === 0 || isHeredocDescriptorPath(word, descriptor))) return true;
		const options = states & 3;
		states = (states & 12) >> 2 | (states & 16 ? 2 : 0);
		if (!options) continue;
		if (word === "-") { if (options & 1 && descriptor === 0) return true; continue; }
		if (word === "--") { states |= options << 5; continue; }
		if (!word.startsWith("-")) { if (options & 1 && isHeredocDescriptorPath(word, descriptor)) return true; continue; }
		if (word === "--check" || word === "-c" || word === "--help" || word === "-h" || word === "--version" || word === "-v" || word === "--test" || word === "--completion-bash" || word === "--v8-options" || word === "--prof-process") { if (!states) interactive = false; continue; }
		if (word === "--interactive" || word === "-i") { interactive = true; states |= options; continue; }
		if (word === "--eval" || word === "--print" || word === "-e" || word === "-p") { states |= 16; continue; }
		if (word.startsWith("--eval=") || word.startsWith("--print=") || word.startsWith("-e") || word.startsWith("-p")) { states |= 2; continue; }
		states |= options;
		if (NODE_VALUE_FREE_FLAGS.has(word)) continue;
		if (!word.includes("=") && (word.startsWith("--") || word.length === 2)) states |= options << 2;
	}
	return descriptor === 0 && (interactive || (states & 37) !== 0);
}

function isHeredocDescriptorPath(operand: string | undefined, descriptor: number): boolean {
	const value = descriptorPathNumber(operand);
	return value >= -1 && (descriptor < 0 ? operand !== "/dev/stdin" : value === descriptor);
}

/** -2 is not a descriptor path; -1 is a path whose descriptor is unknown. */
function descriptorPathNumber(operand: string | undefined): number {
	if (operand === "/dev/stdin") return 0;
	if (!operand) return -2;
	let index = operand.startsWith("/dev/fd/") ? 8 : operand.startsWith("/proc/self/fd/") ? 14 : -1;
	if (index < 0) return -2;
	if (index === operand.length) return -1;
	let value = 0;
	for (; index < operand.length; index++) {
		const code = operand.charCodeAt(index); if (code < 48 || code > 57) return -1;
		value = value * 10 + code - 48;
	}
	return Number.isSafeInteger(value) ? value : -1;
}

/** Extra POSIX descriptors can survive exec when a parent supplied them without
 * close-on-exec. Only an explicit preceding/same-command binding establishes
 * provenance. This records no values and does not extend true/: content tracking. */
type DescriptorContext = { segments: ShellSegment[]; current: number; documents?: readonly HeredocBinding[]; parent?: DescriptorContext };

function hasUnboundDescriptorSource(command: string, documents?: readonly HeredocBinding[], parent?: DescriptorContext): boolean {
	if (!command.includes("/")) return false;
	const segments = parseShellSegments(command, true);
	for (let current = 0; current < segments.length; current++) {
		const tokens = segments[current]!;
		let index = skipRedirections(tokens, 0);
		while (index < tokens.length) {
			const word = tokens[index]!;
			if (LEADING_ASSIGNMENT_PATTERN.test(word) || word === "{" || word === "then" || word === "do" || word === "else" || word === "if" || word === "elif" || word === "while" || word === "until") { index = skipRedirections(tokens, index + 1); continue; }
			if (word !== "builtin" && word !== "command") break;
			index = skipRedirections(tokens, index + 1); if (tokens[index] === "-p") index++; if (tokens[index] === "--") index++;
		}
		if (tokens[index] !== "source" && tokens[index] !== ".") continue;
		index = skipRedirections(tokens, index + 1); if (tokens[index] === "--") index = skipRedirections(tokens, index + 1);
		const match = SOURCE_DESCRIPTOR_PATTERN.exec(tokens[index] ?? ""), descriptor = match ? Number(match[1]) : -1;
		if (descriptor < 3) continue;
		let bound = descriptorBoundAt(segments, current, documents, descriptor);
		for (let context = parent; context && !bound; context = context.parent) bound = descriptorBoundAt(context.segments, context.current, context.documents, descriptor);
		if (!bound) return true;
	}
	return false;
}

function descriptorBoundAt(segments: ShellSegment[], current: number, documents: readonly HeredocBinding[] | undefined, descriptor: number): boolean {
	const sourceStart = segments[current]!.sourceStart!;
	if (documents) for (const document of documents) {
		if (document.descriptor !== descriptor) continue;
		if (document.bodyEnd < sourceStart && isPersistentHeredocDeclaration(document.header)) return true;
		const header = parseShellSegments(document.header, true), owner = header[header.length - 1];
		const start = document.contextEnd - document.header.length + (owner?.sourceStart ?? 0);
		if (owner && sourceStart >= start && sourceStart < document.contextEnd) return true;
	}
	// Follow only descriptor provenance, backwards through existing token views.
	// A later copy does not restore analyzable heredoc contents across exec.
	let heredocBoundary = -1;
	for (let before = current; before >= 0; before--) {
		const declaration = segments[before]!;
		if (declaration.sourceStart! < heredocBoundary) return false;
		if (before !== current && (declaration[skipRedirections(declaration, 0)] !== "exec" || declaration.subshellDepth || declaration.pipelineMember)) continue;
		for (let redirect = (declaration.redirections?.length ?? 0) - 1; redirect >= 0; redirect--) {
			const index = declaration.redirections![redirect]!, operator = declaration[index]!;
			const explicit = declaration.redirectionFds?.[redirect];
			const destination = explicit === undefined ? (operator.startsWith("<") ? 0 : 1) : Number(explicit);
			if (destination !== descriptor) continue;
			if (operator !== "<&" && operator !== ">&") return true;
			descriptor = descriptorCopyOrigin(declaration[index + 1] ?? "");
			if (descriptor < 0) return false;
			heredocBoundary = -1;
			if (documents) for (const document of documents) {
				if (document.descriptor === descriptor && document.bodyEnd < declaration.sourceStart!
					&& isPersistentHeredocDeclaration(document.header)) heredocBoundary = Math.max(heredocBoundary, document.bodyEnd);
			}
		}
	}
	// Standard input/output are tool-owned; an inherited extra descriptor is not.
	return descriptor < 3 && heredocBoundary < 0;
}

function descriptorCopyOrigin(target: string): number {
	const end = target.length - (target.endsWith("-") ? 1 : 0);
	if (!end) return -1;
	let value = 0;
	for (let index = 0; index < end; index++) {
		const code = target.charCodeAt(index);
		if (code < 48 || code > 57) return -1;
		value = value * 10 + code - 48;
	}
	return Number.isSafeInteger(value) ? value : -1;
}

/** No alias-value tracking. The masked outer source cannot prove a consumer when
 * alias state may change. Descriptor sourcing is checked separately against its
 * document, preserving known literal stdin and persisted-descriptor consumers. */
export const aliasRiskCounters = { prefixChecks: 0, viewsCreated: 0, viewsReleased: 0, liveViews: 0, sourceChars: 0 };
function heredocHasAliasRisk(command: string, depth = 0): boolean {
	const segments = parseShellSegments(command);
	aliasRiskCounters.viewsCreated++; aliasRiskCounters.liveViews++; aliasRiskCounters.sourceChars += command.length;
	try { return shellSegmentsHaveAliasRisk(segments, depth); }
	finally { segments.length = 0; aliasRiskCounters.viewsReleased++; aliasRiskCounters.liveViews--; }
}

/** Reuse an already parsed prefix when checking a literal process producer. */
function shellSegmentsHaveAliasRisk(segments: ShellSegment[], depth: number, end = segments.length, inspectedProcesses = false): boolean {
	aliasRiskCounters.prefixChecks++;
	if (depth > MAX_WRAPPER_DEPTH) return true;
	if (segments.length > MAX_SCRIPT_SEGMENTS) return true;
	for (let segment = 0; segment < end; segment++) {
		const tokens = segments[segment]!;
		const processSource = inspectedProcesses && tokens.separatorAfter === "(" && tokens[tokens.length - 1] === "<";
		if (tokens.redirections) stripShellRedirections(tokens, tokens.redirections);
		let index = 0;
		while (index < tokens.length) {
			const word = tokens[index]!;
			if (BASH_ALIASES_ASSIGNMENT.test(word)) return true;
			if (word === "function" && tokens[index + 2] === "{") { index += 3; continue; }
			if (LEADING_ASSIGNMENT_PATTERN.test(word) || word === "{" || word === "do" || word === "then" || word === "else" || word === "if" || word === "elif" || word === "while" || word === "until" || word === "!" || word === "time") { index++; continue; }
			if (word !== "builtin" && word !== "command") break;
			index++; if (tokens[index] === "-p") index++; if (tokens[index] === "--") index++;
		}
		const name = tokens[index];
		if (name === "alias" || name === "eval") return true;
		if ((name === "source" || name === ".") && !processSource) {
			const operand = tokens[index + (tokens[index + 1] === "--" ? 2 : 1)];
			if (operand !== "/dev/stdin" && !(operand && SOURCE_DESCRIPTOR_PATTERN.test(operand))) return true;
		}
		if (name === "declare" || name === "typeset" || name === "local" || name === "export" || name === "readonly") {
			for (let operand = index + 1; operand < tokens.length; operand++) if (BASH_ALIASES_ASSIGNMENT.test(tokens[operand]!)) return true;
		}
		if (name === "shopt") {
			let enabling = false, relevant = false;
			for (let operand = index + 1; operand < tokens.length; operand++) {
				const word = tokens[operand]!;
				if (tokens.expansions?.[operand] || hasDynamicSyntax(word)) { enabling = true; relevant = true; }
				if (word.startsWith("-") && shortOptionContains(word, "s")) enabling = true;
				if (word === "expand_aliases") relevant = true;
			}
			if (enabling && relevant) return true;
		}
		if (name && SCRIPT_WRAPPERS.has(commandName(name))) {
			for (let option = index + 1; option < tokens.length; option++) if (tokens[option] === "-c") {
				const operand = bashScriptOperandIndex(tokens, option);
				if (operand >= 0 && tokens[operand] !== undefined && heredocHasAliasRisk(tokens[operand]!, depth + 1)) return true;
				break;
			}
		}
	}
	return false;
}

/** Literal alias definitions are stored executable source, not plain argv data. */
export function literalAliasSource(tokens: ShellSegment, index: number): string | undefined {
	const word = tokens[index], equals = word?.indexOf("=") ?? -1;
	return equals > 0 && !tokens.expansions?.[index] ? word!.slice(equals + 1) : undefined;
}

/** Resolve only a direct variable whose immediately preceding command consists
 * entirely of literal assignments. Unresolved trap actions are lifecycle refusals.
 * At most 16 sources, 128 KiB total, owned only by the synchronous caller. */
export function literalStoredScripts(command: string): string[] | null | undefined {
	if (!command.includes("$") || !command.includes("trap") && !command.includes("alias")) return undefined;
	const segments = parseShellSegments(command);
	if (segments.length > MAX_SCRIPT_SEGMENTS) return null;
	let scripts: string[] | undefined, bytes = 0;
	for (let segment = 1; segment < segments.length; segment++) {
		const tokens = segments[segment]!, previous = segments[segment - 1]!;
		let index = commandTokenIndex(tokens);
		if (index < 0) continue;
		while (tokens[index] === "builtin" || tokens[index] === "command") { index++; if (tokens[index] === "--") index++; }
		const alias = tokens[index] === "alias";
		if (!alias && tokens[index] !== "trap") continue;
		let action = skipRedirections(tokens, index + 1);
		if (tokens[action] === "--") action = skipRedirections(tokens, action + 1);
		for (let operand = action; operand < tokens.length; operand = skipRedirections(tokens, operand + 1)) {
			if (!alias && operand !== action) break;
			if (!tokens.expansions?.[operand]) continue;
			const word = tokens[operand]!, equals = alias ? word.indexOf("=") : -1;
			if (alias && equals < 1) continue;
			const source = literalAdjacentSource(previous, alias ? word.slice(equals + 1) : word);
			if (source === undefined) continue;
			if (bytes + source.length > MAX_INSPECTED_COMMAND_CHARS || (scripts?.length ?? 0) >= MAX_SUBSTITUTIONS) return null;
			scripts ??= []; scripts.push(source); bytes += source.length;
		}
	}
	return scripts;
}

function literalAdjacentSource(previous: ShellSegment | undefined, word: string): string | undefined {
	if (!previous || previous.pipelineMember || previous.conditionalMember || previous.subshellDepth) return undefined;
	const match = DIRECT_SHELL_VARIABLE_PATTERN.exec(word);
	return match ? literalPreviousAssignment(previous, match[1] ?? match[2]!) : undefined;
}

function literalPreviousAssignment(tokens: ShellSegment, name: string): string | undefined {
	let source: string | undefined;
	for (let operand = 0; operand < tokens.length; operand++) {
		const word = tokens[operand]!;
		if (!LEADING_ASSIGNMENT_PATTERN.test(word) || tokens.expansions?.[operand]) return undefined;
		const equals = word.indexOf("=");
		if (word.slice(0, equals) === name) source = word.slice(equals + 1);
	}
	return source;
}

/** Eval joins literal argv with spaces before parsing; never use it for execution. */
export function literalEvalScript(tokens: ShellSegment, start: number): string | undefined {
	let script = "", first = true;
	let index = skipRedirections(tokens, start);
	if (tokens[index] === "--") index = skipRedirections(tokens, index + 1);
	for (; index < tokens.length; index = skipRedirections(tokens, index + 1)) {
		if (tokens.expansions?.[index]) return undefined;
		if (!first) script += " ";
		script += tokens[index]!;
		first = false;
	}
	return script;
}

/** Bits: shell=1, Node=2, Python=4, uninspectable input=8, shell noexec=16. */
export function heredocConsumers(header: string, descriptor = 0, depth = 0, pipeline = false, functions?: ShellSegment[], pipelineStart?: number): number {
	if (depth > MAX_WRAPPER_DEPTH) return 8;
	const segments = parseShellSegments(header);
	const tokens = segments[segments.length - 1];
	if (!tokens) return 0;
	if (tokens.redirectionFds) for (const fd of tokens.redirectionFds) if (fd && isShellDynamicDescriptor(fd)) descriptor = -1;
	if (pipeline) {
		let start = pipelineStart ?? segments.length - 1;
		if (pipelineStart === undefined) while (start > 0 && (segments[start - 1]!.separatorAfter === "|" || segments[start - 1]!.separatorAfter === "|&")) start--;
		if (start < 0 || start >= segments.length) return 8;
		return stdinScriptConsumers(segments, descriptor, depth + 1, start, functions);
	}
	if (tokens.redirections) { stripShellRedirections(tokens, tokens.redirections); tokens.redirections.length = 0; }
	if (tokens[0] === "}" || tokens[0] === "fi" || tokens[0] === "done" || tokens[0] === "esac"
		|| tokens.length === 0 && segments.length > 1 && segments[segments.length - 2]!.subshellClosedAfter) {
		let start = 0;
		if (tokens[0] === "}") {
			let braces = 1;
			for (let cursor = segments.length - 2; cursor >= 0; cursor--) {
				const segment = segments[cursor]!;
				if (segment.firstWordQuoted) continue;
				if (segment[0] === "}") braces++;
				for (let word = 0; segment[word] === "{"; word++) braces--;
				if (braces <= 0) { start = cursor; break; }
			}
		} else if (tokens.length === 0) {
			start = segments.length - 2;
			const subshellDepth = segments[start]!.subshellDepth ?? 0;
			while (start > 0 && (segments[start - 1]!.subshellDepth ?? 0) >= subshellDepth) start--;
		}
		return stdinScriptConsumers(segments, descriptor, depth + 1, start, functions);
	}
	const consumers = simpleStdinConsumers(tokens, descriptor, depth, functions);
	return descriptor < 0 && consumers & 7 ? 8 : consumers;
}

type HeredocBinding = { header: string; contextEnd: number; bodyEnd: number; descriptor: number };
export function heredocDocumentConsumers(document: { header: string; pipelineHeader?: string; contextEnd?: number; bodyEnd?: number; descriptor: number }, command?: string, documents?: readonly HeredocBinding[]): number {
	const functions = command && (command.includes("(") || command.includes("function") || command.includes("coproc")) ? parseShellSegments(command.slice(0, document.contextEnd)) : undefined;
	const pipelineStart = document.pipelineHeader ? parseShellSegments(document.header).length - 1 : undefined;
	const consumers = heredocConsumers(document.header, document.descriptor, 0, false, functions)
		| (document.pipelineHeader ? heredocConsumers(document.pipelineHeader, document.descriptor, 0, true, functions, pipelineStart) : 0)
		| persistedHeredocConsumers(document, command, documents);
	const coprocContext = functions ? coprocHeredocContext(functions) : 0;
	return coprocContext === 2 || consumers & 1 && coprocContext ? consumers | 8 : consumers;
}

/** Locate a literal coproc keyword at a command head, never an argv occurrence.
 * Return its body offset, -1 for ordinary argv, or -2 for unbounded syntax. */
function coprocBodyIndex(tokens: ShellSegment): number {
	let index = 0;
	while (tokens[index] === "{" || tokens[index] === "then" || tokens[index] === "else" || tokens[index] === "do"
		|| tokens[index] === "if" || tokens[index] === "elif" || tokens[index] === "while" || tokens[index] === "until") {
		if (index > 2 || (index === 0 ? tokens.firstWordQuoted : index === 1 ? tokens.secondWordQuoted : tokens.thirdWordQuoted)) return -1;
		index++;
	}
	index = bashPipelinePrefixEnd(tokens, index);
	if (index < 0 || tokens[index] !== "coproc") return -1;
	if (index > 2) return -2;
	if (index === 0 ? tokens.firstWordQuoted : index === 1 ? tokens.secondWordQuoted : tokens.thirdWordQuoted) return -1;
	index++;
	// Other compound grammars need their own nesting proof. Keep main's heredoc
	// refusal rather than treating a partially scanned body as ordinary input.
	for (let word = index; word <= index + 1; word++) {
		if (word === 1 && tokens.secondWordQuoted || word === 2 && tokens.thirdWordQuoted) continue;
		const value = tokens[word];
		if (value === "if" || value === "while" || value === "until" || value === "for" || value === "select" || value === "case") return -2;
	}
	// A name precedes a compound command, not an ordinary simple command.
	if (tokens[index + 1] === "{" || tokens.length === index + 1 && tokens.separatorAfter === "(") index++;
	return index;
}

/** Reuse the bounded prefix's segment view. Only primitive brace/subshell state
 * survives between segments; no alias, variable or process tracking is added. */
function coprocHeredocContext(segments: readonly ShellSegment[]): number {
	let braces = 0, coprocBrace = 0, coprocSubshell = -1, piped = false, current = false;
	for (const tokens of segments) {
		const body = coprocBodyIndex(tokens);
		if (body === -2) return 2;
		current = coprocBrace > 0 || coprocSubshell >= 0 && (tokens.subshellDepth ?? 0) > coprocSubshell || piped || body >= 0;
		if (body >= 0) for (let word = 0; tokens[word] === "{"; word++) braces++;
		if (body >= 0 && tokens[body] === "{") { if (!coprocBrace) coprocBrace = braces + 1; }
		if (body >= tokens.length && tokens.separatorAfter === "(") coprocSubshell = tokens.subshellDepth ?? 0;
		let word = body >= 0 ? body : 0;
		if (!tokens.firstWordQuoted || body >= 0) {
			while (tokens[word] === "{") { braces++; word++; }
			if (tokens[0] === "}") { if (braces > 0) braces--; if (braces < coprocBrace) coprocBrace = 0; }
		}
		if (coprocSubshell >= 0 && tokens.subshellClosedAfter && (tokens.subshellDepth ?? 0) === coprocSubshell + 1) coprocSubshell = -1;
		piped = current && (tokens.separatorAfter === "|" || tokens.separatorAfter === "|&");
	}
	return current ? 1 : 0;
}

function isPersistentHeredocDeclaration(header: string): boolean {
	return persistentHeredocDescriptor(header, 0) >= -1;
}

function persistentHeredocDescriptor(header: string, descriptor: number): number {
	if (!header.includes("exec")) return -2;
	const declarations = parseShellSegments(header), declaration = declarations[declarations.length - 1];
	if (!declaration || declaration.pipelineMember || declaration.subshellDepth || declaration.conditionalMember) return -2;
	if (declaration.redirectionFds) for (const fd of declaration.redirectionFds) if (fd && isShellDynamicDescriptor(fd)) descriptor = -1;
	if (declaration.redirections) stripShellRedirections(declaration, declaration.redirections);
	return declaration.length === 1 && declaration[0] === "exec" ? descriptor : -2;
}

/** Only true/: preserve known persistent input. After other commands, a matching
 * interpreter read refuses; binding alone or reading data is not a violation.
 * Two numeric scratch lists are call-owned, capped at16 and cleared in finally. */
function persistedHeredocConsumers(document: { header: string; bodyEnd?: number; descriptor: number }, command?: string, documents?: readonly HeredocBinding[]): number {
	if (!command || document.bodyEnd === undefined) return 0;
	const descriptor = persistentHeredocDescriptor(document.header, document.descriptor);
	if (descriptor < -1) return 0;
	let end = command.length;
	// A later unconditional literal heredoc rebinding has its own inspected body.
	if (documents) for (const next of documents) {
		if (descriptor >= 0 && next.bodyEnd > document.bodyEnd && next.descriptor === descriptor && persistentHeredocDescriptor(next.header, next.descriptor) === descriptor) {
			end = Math.min(end, next.contextEnd - next.header.length);
		}
	}
	const tail = parseShellSegments(command.slice(document.bodyEnd, end));
	const bindings = [descriptor], candidates: number[] = [];
	persistentDescriptorCounters.arraysCreated += 2; persistentDescriptorCounters.liveArrays += 2;
	let uncertain = descriptor < 0 || tail.length > MAX_SCRIPT_SEGMENTS, consumers = 0;
	try {
		for (const tokens of tail) {
			const persistent = isPersistentExecSegment(tokens);
			if (persistent) {
				updatePersistentDescriptors(tokens, bindings);
				uncertain = true;
				if (!bindings.length) return consumers;
				continue;
			}
			for (const bound of bindings) addDescriptorCandidate(candidates, bound, descriptorReadState(tokens, bound, bindings));
			addDescriptorCandidate(candidates, 0, descriptorReadState(tokens, 0, bindings));
			for (const word of tokens) {
				const path = descriptorPathNumber(word);
				if (path >= -1) addDescriptorCandidate(candidates, path, descriptorReadState(tokens, path, bindings));
			}
			if (tokens.subshellDepth || tokens.pipelineMember || tokens.conditionalMember) uncertain = true;
			if (tokens.redirections) { stripShellRedirections(tokens, tokens.redirections); tokens.redirections.length = 0; }
			for (const candidate of candidates) {
				const input = candidate >= 0 ? candidate : candidate === -1 ? -1 : -candidate - 2;
				const read = simpleStdinConsumers(tokens, input, 0, undefined, 0, true);
				if (!(read & 15)) continue;
				if (uncertain || candidate < 0 || read & 8) return 8;
				consumers |= read;
			}
			candidates.length = 0;
			if (tokens.length && tokens[0] !== "true" && tokens[0] !== ":") uncertain = true;
		}
		return consumers;
	} finally {
		bindings.length = 0; candidates.length = 0;
		persistentDescriptorCounters.arraysReleased += 2; persistentDescriptorCounters.liveArrays -= 2;
	}
}

export const persistentDescriptorCounters = { arraysCreated: 0, arraysReleased: 0, liveArrays: 0, maxEntries: 0, lookups: 0, redirections: 0, overflows: 0 };

function addDescriptorCandidate(candidates: number[], descriptor: number, state: number): void {
	if (!state || candidates.includes(-1)) return;
	const value = state === 2 ? descriptor < 0 ? -1 : -descriptor - 2 : descriptor;
	if (candidates.includes(value)) return;
	if (candidates.length === 16) { candidates.length = 1; candidates[0] = -1; persistentDescriptorCounters.overflows++; return; }
	candidates.push(value);
	persistentDescriptorCounters.maxEntries = Math.max(persistentDescriptorCounters.maxEntries, candidates.length);
}

function isPersistentExecSegment(tokens: ShellSegment): boolean {
	let index = skipRedirections(tokens, 0);
	while (tokens[index] === "command" || tokens[index] === "builtin") {
		index = skipRedirections(tokens, index + 1);
		if (tokens[index] === "-p" || tokens[index] === "--") index = skipRedirections(tokens, index + 1);
	}
	return tokens[index] === "exec" && skipRedirections(tokens, index + 1) >= tokens.length && !tokens.subshellDepth && !tokens.pipelineMember && !tokens.conditionalMember;
}

function redirectionDescriptor(tokens: ShellSegment, position: number): number {
	const fd = tokens.redirectionFds?.[position];
	if (fd === undefined) return tokens[tokens.redirections![position]!]!.startsWith("<") ? 0 : 1;
	return isShellDynamicDescriptor(fd) ? -1 : Number(fd);
}

function removePersistentDescriptor(bindings: number[], descriptor: number): void {
	let kept = 0;
	for (const bound of bindings) if (bound !== descriptor) bindings[kept++] = bound;
	bindings.length = kept;
}

function updatePersistentDescriptors(tokens: ShellSegment, bindings: number[]): void {
	for (let position = 0; position < (tokens.redirections?.length ?? 0); position++) {
		persistentDescriptorCounters.redirections++;
		const index = tokens.redirections![position]!, operator = tokens[index]!, target = tokens[index + 1] ?? "", destination = redirectionDescriptor(tokens, position);
		const copy = operator === "<&" || operator === ">&";
		const origin = copy ? descriptorCopyOrigin(target) : operator === "<" ? descriptorPathNumber(target) : -2;
		const unknown = destination < 0 || origin === -1 && target !== "-" && Boolean(tokens.expansions?.[index + 1] || hasDynamicSyntax(target));
		const copied = unknown ? bindings.length > 0 : origin >= 0 && (bindings.includes(origin) || bindings.includes(-1));
		if (destination >= 0) removePersistentDescriptor(bindings, destination);
		if (copied && !bindings.includes(destination)) {
			if (bindings.length === 16) { bindings.length = 1; bindings[0] = -1; persistentDescriptorCounters.overflows++; }
			else bindings.push(destination);
		}
		if (copy && target.endsWith("-") && origin >= 0) removePersistentDescriptor(bindings, origin);
		persistentDescriptorCounters.maxEntries = Math.max(persistentDescriptorCounters.maxEntries, bindings.length);
	}
}

/** Follow this command's redirects backwards against persistent numeric bindings.
 * Return0 for unrelated/closed input,1 for a known binding,2 for uncertainty. */
function descriptorReadState(tokens: ShellSegment, descriptor: number, bindings: readonly number[]): number {
	persistentDescriptorCounters.lookups++;
	if (descriptor < 0) {
		for (const bound of bindings) if (bound < 0 || descriptorReadState(tokens, bound, bindings)) return 2;
		return 0;
	}
	for (let position = (tokens.redirections?.length ?? 0) - 1; position >= 0; position--) {
		persistentDescriptorCounters.redirections++;
		const index = tokens.redirections![position]!, operator = tokens[index]!, target = tokens[index + 1] ?? "", destination = redirectionDescriptor(tokens, position);
		const copy = operator === "<&" || operator === ">&";
		const origin = copy ? descriptorCopyOrigin(target) : operator === "<" ? descriptorPathNumber(target) : -2;
		if (copy && target.endsWith("-") && origin === descriptor && destination !== descriptor) return 0;
		if (destination < 0) return bindings.length ? 2 : 0;
		if (destination !== descriptor) continue;
		if (origin >= 0) { descriptor = origin; continue; }
		return origin === -1 && target !== "-" && Boolean(tokens.expansions?.[index + 1] || hasDynamicSyntax(target)) && bindings.length ? 2 : 0;
	}
	return bindings.includes(descriptor) ? 1 : bindings.includes(-1) ? 2 : 0;
}

/** Literal echo/printf producers used directly by source. No shell execution,
 * retained state, or guessing of dynamic output; at most 16 call-owned strings. */
export function literalProcessSources(command: string): string[] | false | null | undefined {
	if (!command.includes("<(")) return undefined;
	if (command.length > MAX_INSPECTED_COMMAND_CHARS) return null;
	let quote = 0, escaped = false, sources: string[] | undefined, bytes = 0, producerAliasRisk = false;
	for (let index = 0; index < command.length; index++) {
		const code = command.charCodeAt(index);
		if (escaped) { escaped = false; continue; }
		if (code === 92 && quote !== 39) { escaped = true; continue; }
		if (quote) { if (code === quote) quote = 0; continue; }
		if (code === 39 || code === 34) { quote = code; continue; }
		if (code === 35 && (index === 0 || command[index - 1] === " " || command[index - 1] === "\n")) { const end = command.indexOf("\n", index); if (end < 0) break; index = end; continue; }
		if (code !== 60 || command[index + 1] !== "(") continue;
		const end = commandSubstitutionEnd(command, index);
		if (end < 0) return sources;
		const prefixes = parseShellSegments(command.slice(0, index)), consumer = prefixes[prefixes.length - 1];
		let cursor = consumer ? commandTokenIndex(consumer) : -1;
		if (consumer && cursor >= 0) {
			while (consumer[cursor] === "command" || consumer[cursor] === "builtin") { cursor++; if (consumer[cursor] === "--") cursor++; }
			if (consumer[cursor] === "source" || consumer[cursor] === ".") {
				cursor++; if (consumer[cursor] === "--") cursor++;
				if (cursor === consumer.length) {
					const producers = parseShellSegments(command.slice(index + 2, end)), producer = producers[0];
					if (producers.length === 1 && producer && !producer.redirections?.length && !producer.dynamic) {
						if ((producer[0] === "echo" || producer[0] === "printf") && (producerAliasRisk || functionStdinConsumers(prefixes, producer[0], 0, 1) !== -1
							|| shellSegmentsHaveAliasRisk(prefixes, 0, prefixes.length - 1, true))) return false;
						const source = producer[0] === "echo" && producer.length === 2 && !producer[1]!.startsWith("-") && !producer[1]!.includes("\\") ? producer[1]
							: producer[0] === "printf" && producer.length === 3 && (producer[1] === "%s" || producer[1] === "%s\\n") ? producer[2] : undefined;
						if (source !== undefined) {
							if (bytes + source.length > MAX_INSPECTED_COMMAND_CHARS || (sources?.length ?? 0) >= MAX_SUBSTITUTIONS) return null;
							sources ??= []; sources.push(source); bytes += source.length;
							// A literal sourced setup can invalidate later producer semantics.
							// Retain only uncertainty, never alias names/values or a symbol map.
							producerAliasRisk = heredocHasAliasRisk(source);
						} else return false;
					} else return false;
				}
			}
		}
		index = end;
	}
	return sources;
}

export function heredocConsumer(header: string, descriptor = 0): "bash" | "node" | "python" | undefined {
	const consumers = heredocConsumers(header, descriptor);
	return consumers & 1 ? "bash" : consumers & 2 ? "node" : consumers & 4 ? "python" : undefined;
}

function isTransparentStdinStage(tokens: ShellSegment): boolean {
	if (tokens[0] !== "cat" || tokens.expansions?.[0]) return false;
	let index = tokens[1] === "--" ? 2 : 1;
	for (; index < tokens.length; index++) if (tokens[index] !== "-" || tokens.expansions?.[index]) return false;
	return true;
}

/** Follow literal descriptor copies/moves in order. A call-owned list of at
 * most 16 aliases proves disconnection; unknown/overflow retains inspection. */
function pipelineDescriptorConnected(tokens: ShellSegment, descriptor: number): boolean {
	if (!tokens.redirections?.length) return true;
	const connected = [descriptor];
	for (let redirect = 0; redirect < tokens.redirections.length; redirect++) {
		const index = tokens.redirections[redirect]!, operator = tokens[index]!, target = tokens[index + 1];
		const explicit = tokens.redirectionFds?.[redirect];
		if (explicit !== undefined && !isShellFileDescriptor(explicit)) return true;
		const destination = explicit === undefined ? operator.startsWith("<") ? 0 : 1 : Number(explicit);
		let origin = -1, move = false;
		if ((operator === "<&" || operator === ">&") && target !== undefined) {
			move = target.endsWith("-") && target.length > 1;
			const end = target.length - (move ? 1 : 0);
			let value = 0, digits = 0;
			for (; digits < end; digits++) {
				const code = target.charCodeAt(digits); if (code < 48 || code > 57) break;
				value = value * 10 + code - 48;
			}
			if (digits === end && digits) origin = value;
			else if (target !== "-" && (tokens.expansions?.[index + 1] || hasDynamicSyntax(target))) return true;
		}
		const copied = origin >= 0 && connected.includes(origin);
		const old = connected.indexOf(destination); if (old >= 0) connected.splice(old, 1);
		if (copied) { if (connected.length >= 16) return true; connected.push(destination); }
		if (move) { const moved = connected.indexOf(origin); if (moved >= 0) connected.splice(moved, 1); }
		if (operator === "&>" || operator === "&>>" || operator === ">&" && explicit === undefined && origin < 0 && target !== "-") {
			const stderr = connected.indexOf(2); if (stderr >= 0) connected.splice(stderr, 1);
		}
	}
	return connected.includes(descriptor);
}

/** Resolve named literal brace-body functions only, within the existing 64
 * segment / four-level bounds. -1 means no matching definition, not a refusal. */
function functionStdinConsumers(segments: ShellSegment[], name: string, descriptor: number, depth: number): number {
	if (segments.length > MAX_SCRIPT_SEGMENTS) return 8;
	let consumers = -1, conditionalDepth = 0;
	for (let definition = 0; definition < segments.length; definition++) {
		const declaration = segments[definition]!;
		if (declaration[0] === "fi" || declaration[0] === "done" || declaration[0] === "esac") conditionalDepth = Math.max(0, conditionalDepth - 1);
		if (declaration[0] === "if" || declaration[0] === "for" || declaration[0] === "while" || declaration[0] === "until" || declaration[0] === "case" || declaration[0] === "select") conditionalDepth++;
		let word = 0;
		while (declaration[word] === "{" || declaration[word] === "then" || declaration[word] === "else" || declaration[word] === "do") word++;
		let bodySegment = definition, bodyWord = -1;
		let declared = false;
		if (declaration[word] === "function" && declaration[word + 1] === name) {
			declared = true;
			bodyWord = declaration.indexOf("{", word + 2);
			if (bodyWord < 0 && declaration.length === word + 2 && (declaration.separatorAfter === "(" || declaration.separatorAfter === "\n" || declaration.separatorAfter === "\r")) { bodySegment++; bodyWord = 0; }
		}
		else if (declaration[word] === name && declaration.length === word + 1 && declaration.separatorAfter === "(") { declared = true; bodySegment++; bodyWord = 0; }
		if (!declared) continue;
		if (bodyWord < 0 || !segments[bodySegment] || segments[bodySegment]![bodyWord] !== "{" || depth > MAX_WRAPPER_DEPTH) return 8;
		if (consumers < 0 || conditionalDepth === 0 && !declaration.conditionalMember && !declaration.subshellDepth) consumers = 0;
		let braces = 0;
		for (let cursor = bodySegment; cursor < segments.length; cursor++) {
			const tokens = segments[cursor]!, start = cursor === bodySegment ? bodyWord : 0;
			for (let token = start; token < tokens.length; token++) {
				if (tokens[token] === "{") braces++;
				else if (tokens[token] === "}") braces--;
			}
			if (tokens[start] !== "}") consumers |= simpleStdinConsumers(tokens, descriptor, depth, segments, start);
			if (braces <= 0) break;
		}
	}
	return consumers;
}

/** A bounded, call-owned byte buffer is released after one UTF-8 decode. */
export function decodeLiteralBase64(source: string): string | undefined {
	if (source.length > MAX_INSPECTED_COMMAND_CHARS) return undefined;
	const bytes = new Uint8Array(Math.floor(source.length * 3 / 4));
	let bits = 0, value = 0, length = 0, digits = 0, padding = 0;
	for (let index = 0; index < source.length; index++) {
		const code = source.charCodeAt(index);
		if (code === 9 || code === 10 || code === 13 || code === 32) continue;
		if (code === 61) { if (++padding > 2) return undefined; continue; }
		if (padding) return undefined;
		const digit = code >= 65 && code <= 90 ? code - 65 : code >= 97 && code <= 122 ? code - 71 : code >= 48 && code <= 57 ? code + 4 : code === 43 ? 62 : code === 47 ? 63 : -1;
		if (digit < 0) return undefined;
		value = value << 6 | digit; bits += 6; digits++;
		if (bits >= 8) { bits -= 8; bytes[length++] = value >> bits & 255; }
	}
	if (digits % 4 === 1 || padding && (digits + padding) % 4 !== 0) return undefined;
	try { return SHELL_INPUT_DECODER.decode(bytes.subarray(0, length)); } catch { return undefined; }
}

/** Decode only supported literal transforms before the first executable reader.
 * Undefined is uninspected source; lifecycle refuses it for recognized shells. */
export function heredocExecutableBody(document: { header: string; pipelineHeader?: string; contextEnd?: number; body: string; descriptor: number }, command?: string): string | undefined {
	if (!document.pipelineHeader) return document.body;
	const segments = parseShellSegments(document.pipelineHeader);
	if (segments.length > MAX_SCRIPT_SEGMENTS) return undefined;
	const functions = command && (command.includes("(") || command.includes("function")) ? parseShellSegments(command.slice(0, document.contextEnd)) : undefined;
	const start = parseShellSegments(document.header).length - 1;
	if (start < 0 || start >= segments.length) return undefined;
	let body: string | undefined = document.body;
	for (let index = start; index < segments.length - 1; index++) {
		const tokens = segments[index]!;
		if (index > start && !pipelineDescriptorConnected(tokens, 0)) return undefined;
		const outputConnected = pipelineDescriptorConnected(tokens, 1);
		if (tokens.redirections) { stripShellRedirections(tokens, tokens.redirections); tokens.redirections.length = 0; }
		if (functions && (tokens[0] === "cat" || tokens[0] === "base64") && functionStdinConsumers(functions, tokens[0], document.descriptor, 1) !== -1) return undefined;
		if (simpleStdinConsumers(tokens, document.descriptor, 0, functions)) return body;
		if (!outputConnected) return undefined;
		if (isTransparentStdinStage(tokens)) continue;
		if (tokens[0] !== "base64" || tokens.length !== 2 || tokens[1] !== "-d" && tokens[1] !== "--decode") return undefined;
		body = decodeLiteralBase64(body);
		if (body === undefined) return undefined;
	}
	return body;
}

function stdinScriptConsumers(segments: ShellSegment[], descriptor: number, depth: number, start = 0, functions?: ShellSegment[], descriptorOnly = false): number {
	if (depth > MAX_WRAPPER_DEPTH || segments.length > MAX_SCRIPT_SEGMENTS) return 8;
	let consumers = 0;
	let disconnected = false;
	for (let index = start; index < segments.length; index++) {
		const tokens = segments[index]!;
		const pipeAfter = tokens.separatorAfter === "|" || tokens.separatorAfter === "|&";
		if (disconnected) { disconnected = pipeAfter; continue; }
		if (index > start && (segments[index - 1]!.separatorAfter === "|" || segments[index - 1]!.separatorAfter === "|&") && !pipelineDescriptorConnected(tokens, 0)) { disconnected = pipeAfter; continue; }
		const outputConnected = !pipeAfter || pipelineDescriptorConnected(tokens, 1);
		if (tokens.redirections) { stripShellRedirections(tokens, tokens.redirections); tokens.redirections.length = 0; }
		consumers |= simpleStdinConsumers(tokens, descriptor, depth, functions, 0, descriptorOnly);
		if (!outputConnected) disconnected = true;
	}
	return descriptor < 0 && consumers & 7 ? 8 : consumers;
}

export const heredocConsumerCounters = { tailCalls: 0, tailWords: 0 };

/** One name classification for direct consumers and unresolved argv tails.
 * Raw argv words can include paths/case/.exe; regex test creates no path copies. */
function heredocConsumerKind(value: string): number {
	if (HEREDOC_SOURCE_COMMAND_PATTERN.test(value)) return 16;
	if (HEREDOC_SHELL_COMMAND_PATTERN.test(value)) return 1;
	if (NODE_COMMAND_PATTERN.test(value)) return 2;
	return PYTHON_COMMAND_PATTERN.test(value) ? 4 : 0;
}

/** Unknown prefix/option grammar cannot establish which later word executes.
 * Keep data-only tails opaque; visible consumer names/expansions are uncertain. */
function uninspectableHeredocTail(tokens: ShellSegment, start: number): number {
	heredocConsumerCounters.tailCalls++;
	for (let index = start; index < tokens.length; index++) {
		heredocConsumerCounters.tailWords++;
		if (tokens.expansions?.[index] || heredocConsumerKind(tokens[index]!)) return 8;
	}
	return 0;
}

function simpleStdinConsumers(tokens: ShellSegment, descriptor: number, depth: number, functions?: ShellSegment[], start = 0, descriptorOnly = false): number {
	if (depth > MAX_WRAPPER_DEPTH) return 8;
	const coprocBody = coprocBodyIndex(tokens);
	if (coprocBody === -2) return 8;
	let index = start || (coprocBody >= 0 ? coprocBody : commandTokenIndex(tokens, true));
	if (coprocBody >= 0 && index >= tokens.length) return 8;
	if (index < 0) return descriptorOnly ? 0 : uninspectableHeredocTail(tokens, start + 1);
	if (index >= tokens.length) return 0;
	while (tokens[index] === "{" || tokens[index] === "do" || tokens[index] === "then" || tokens[index] === "else" || tokens[index] === "if" || tokens[index] === "elif" || tokens[index] === "while" || tokens[index] === "until") index++;
	if (coprocBody >= 0 && tokens[index] === "coproc") return 8;
	index = bashPipelinePrefixEnd(tokens, index);
	if (index < 0) return descriptorOnly ? 0 : 8;
	let functionsAllowed = true;
	// Prefix dispatch is a linear token walk, bounded by the command-size limit.
	// Stopping partway would misclassify a later stdin consumer as ordinary data.
	while (index < tokens.length) {
		const prefix = tokens[index];
		if (LEADING_ASSIGNMENT_PATTERN.test(prefix!)) { index++; continue; }
		if (prefix !== "command" && prefix !== "builtin" && prefix !== "exec") break;
		functionsAllowed = false;
		index++;
		if (prefix === "command" && tokens[index] === "-p") index++;
		if (tokens[index] === "--") index++;
		if (!tokens[index] || tokens[index]!.startsWith("-")) return 0;
	}
	let name = commandName(tokens[index] ?? "");
	const functionConsumers = functionsAllowed && functions ? functionStdinConsumers(functions, tokens[index] ?? "", descriptor, depth + 1) : undefined;
	if (functionConsumers !== undefined && functionConsumers !== -1) return functionConsumers;
	// Match lifecycle preflight's existing supported launcher grammar. External
	// launchers forward stdin but cannot dispatch the caller's shell functions.
	let launchers = 0;
	while (name === "env" || name === "sudo" || name === "doas" || name === "timeout" || name === "timeout.exe") {
		if (++launchers > MAX_WRAPPER_DEPTH) return 8;
		if (name === "env" && hasUninspectableEnvLauncher(tokens, index)) return descriptorOnly ? 0 : uninspectableHeredocTail(tokens, index + 1);
		if (name === "timeout" || name === "timeout.exe") {
			const parsed = parseTimeoutInvocation(tokens, index);
			if (!parsed.supported) return descriptorOnly ? 0 : uninspectableHeredocTail(tokens, index + 1);
			index = parsed.commandIndex;
		} else {
			index++;
			if (tokens[index] === "--") index++;
			if (name === "env" || name === "sudo") while (index < tokens.length && !tokens[index]!.startsWith("-") && tokens[index]!.includes("=")) {
				if (uncertainAssignment(tokens, index)) return descriptorOnly ? 0 : uninspectableHeredocTail(tokens, index);
				index++;
			}
		}
		if (!tokens[index] || tokens[index]!.startsWith("-") || tokens.expansions?.[index] || hasDynamicSyntax(tokens[index]!)) return descriptorOnly ? 0 : uninspectableHeredocTail(tokens, index);
		name = commandName(tokens[index]!);
	}
	if (name === "alias" && tokens[index] === "alias") {
		let consumers = 0;
		for (let operand = index + 1; operand < tokens.length; operand++) {
			const script = literalAliasSource(tokens, operand);
			if (script !== undefined) consumers |= stdinScriptConsumers(parseShellSegments(script), descriptor, depth + 1, 0, functions, descriptorOnly);
		}
		return consumers;
	}
	if (name === "eval" && tokens[index] === "eval") {
		const script = literalEvalScript(tokens, index + 1);
		return script === undefined ? 8 : stdinScriptConsumers(parseShellSegments(script), descriptor, depth + 1, 0, functions, descriptorOnly);
	}
	const kind = heredocConsumerKind(name);
	if (kind === 16) {
		const operand = tokens[index + (tokens[index + 1] === "--" ? 2 : 1)];
		return isHeredocDescriptorPath(operand, descriptor) ? 1 : 0;
	}
	const language = kind === 1 ? "bash" : kind === 2 ? "node" : kind === 4 ? "python" : undefined;
	if (!language) return descriptorOnly ? 0 : uninspectableHeredocTail(tokens, index + 1);
	if (language === "node") return nodeMayReadStdin(tokens, index + 1, descriptor) ? 2 : 0;
	const languageMask = language === "bash" ? 1 : 4;
	const stdinMask = descriptor !== 0 ? 0 : language === "bash" ? 1 : 4;
	let shellStdin = false, shellNoexec = false, shellInteractive = false, shellPrettyPrint = false;
	for (let cursor = index + 1; cursor < tokens.length; cursor++) {
		const option = tokens[cursor]!;
		if (tokens.expansions?.[cursor]) return language === "bash" ? 8 : languageMask;
		if (option === "-") return (shellNoexec || shellPrettyPrint) && !shellInteractive ? 16 : stdinMask;
		if (option === "--") {
			if (tokens.expansions?.[cursor + 1]) return language === "bash" ? 8 : languageMask;
			if ((shellNoexec || shellPrettyPrint) && !shellInteractive) return 16;
			if (shellStdin && language === "bash" || cursor + 1 === tokens.length || tokens[cursor + 1] === "-") return stdinMask;
			return isHeredocDescriptorPath(tokens[cursor + 1], descriptor) ? languageMask : shellStdin ? stdinMask : 0;
		}
		if (!option.startsWith("-") && !(language === "bash" && option.startsWith("+"))) {
			if ((shellNoexec || shellPrettyPrint) && !shellInteractive) return 16;
			if (shellStdin && language === "bash") return stdinMask;
			// Python -i executes its script before reading interactive stdin.
			return isHeredocDescriptorPath(option, descriptor) ? languageMask : shellStdin ? stdinMask : 0;
		}
		if (option === "--help" || option === "--version" || language !== "bash" && option === "-h" || language === "python" && option === "-V") return 0;
		if (language === "python") {
			if (option === "--help-env" || option === "--help-xoptions" || option === "--help-all") return 0;
			// py's attached runtime selector is one operand, not a cluster of
			// Python flags; V/c/m/i inside Company/Tag cannot change stdin mode.
			if ((name === "py" || name === "py.exe") && option.startsWith("-V:")) continue;
			if (option === "--check-hash-based-pycs") { if (++cursor >= tokens.length) return 16; if (tokens.expansions?.[cursor]) return languageMask; continue; }
			if (!option.startsWith("--")) for (let flag = 1; flag < option.length; flag++) {
				if (option[flag] === "V") return 0;
				if (option[flag] === "i") shellStdin = true;
				if (option[flag] === "c" || option[flag] === "m") return flag + 1 === option.length && cursor + 1 >= tokens.length ? 16 : shellStdin ? stdinMask : 0;
				if (option[flag] === "W" || option[flag] === "X") { if (flag + 1 === option.length) { if (++cursor >= tokens.length) return 16; if (tokens.expansions?.[cursor]) return languageMask; } break; }
			}
		} else {
			if (option === "--rcfile" || option === "--init-file") { if (++cursor >= tokens.length) return 16; continue; }
			if ((name === "bash" || name === "bash.exe") && option === "--pretty-print") { shellPrettyPrint = true; continue; }
			if ((name === "bash" || name === "bash.exe") && (option === "--dump-strings" || option === "--dump-po-strings")) return 16;
			let scriptOption = false;
			if (!option.startsWith("--")) for (let flag = 1; flag < option.length; flag++) {
				if ((name === "bash" || name === "bash.exe") && option[flag] === "D") return 16;
				if (option[flag] === "n") shellNoexec = option[0] === "-";
				if (option[flag] === "i") shellInteractive = option[0] === "-";
				if (option[flag] === "c") scriptOption = true;
				if (option[flag] === "s") shellStdin = option[0] === "-";
				if (option[flag] === "o" || option[flag] === "O") {
					if (flag + 1 === option.length) {
						cursor++;
						if (option[flag] === "o" && tokens[cursor] === "noexec") shellNoexec = option[0] === "-";
					}
					break;
				}
			}
			if (scriptOption) {
				const sourceIndex = cursor + 1;
				if (!tokens[sourceIndex] || tokens.expansions?.[sourceIndex]) return 8;
				// Bash keeps parsing options after -c until its literal script word.
				// Do not infer noexec when a following option may re-enable it.
				if (tokens[sourceIndex]!.startsWith("-") || tokens[sourceIndex]!.startsWith("+")) return 8;
				if ((shellNoexec || shellPrettyPrint) && !shellInteractive) return 16;
				return stdinScriptConsumers(parseShellSegments(tokens[sourceIndex]!), descriptor, depth + 1, 0, functions, descriptorOnly);
			}
		}
	}
	return (shellNoexec || shellPrettyPrint) && !shellInteractive ? 16 : stdinMask;
}

// Bodies are inspected separately from their declaration's surrounding flow.
// Do not assign initial cwd to a mutation after earlier commands or pipeline stages.
export function heredocHasUntrackedCwd(header: string): boolean {
	const segments = parseShellSegments(header);
	return segments.length !== 1 || segments[0]!.includes("-c") || segments[0]!.includes("eval");
}

function addPrimitive(builder: ScanBuilder, primitive: string): void {
	for (const existing of builder.primitives) {
		if (existing === primitive) return;
	}
	if (builder.primitives.length >= MAX_MUTATION_PRIMITIVES) {
		markUnverifiable(builder, builder.mutationDetected);
		return;
	}
	builder.primitives.push(primitive);
}

function markUnverifiable(builder: ScanBuilder, mutation = false): void {
	builder.dynamicScope = true;
	builder.unverifiableScope = true;
	if (mutation) builder.unverifiableMutation = true;
}

/** Follow only newline continuations of a for/select in-list; all other shell state remains local to its segment. */
function unsafeBashLoopHeaders(segments: readonly ShellSegment[]): ReturnType<typeof unsafeBashForHeaderReason> {
	for (let segmentIndex = 0; segmentIndex < segments.length; segmentIndex++) {
		const header = segments[segmentIndex]!;
		const immediate = unsafeBashForHeaderReason(header);
		if (immediate) return immediate;
		const variableIndex = bashLoopVariableIndex(header);
		if (variableIndex < 0 || !header[variableIndex]) continue;
		let listSegment = segmentIndex;
		let listStart = variableIndex + 1;
		if (header[listStart] === "in") listStart++;
		else if (listStart === header.length && (header.separatorAfter === "\n" || header.separatorAfter === "\r")
			&& segments[segmentIndex + 1]?.[0] === "in" && !segments[segmentIndex + 1]?.firstWordQuoted) {
			listSegment++;
			listStart = 1;
		} else continue;
		for (; listSegment < segments.length; listSegment++) {
			const list = segments[listSegment]!;
			if (hasUnsafeBashLoopListOperand(list, listStart)) return "stateful_loop_list_expansion";
			if (list.separatorAfter !== "\n" && list.separatorAfter !== "\r") break;
			const next = segments[listSegment + 1];
			if (!next || (next[0] === "do" && !next.firstWordQuoted)) break;
			listStart = 0;
		}
	}
	return undefined;
}

/**
 * Permission scope also treats every C-style for header as opaque, matching
 * standalone `((...))`: arithmetic can assign through recursive variable values.
 */
export function unsafeBashLoopHeaderReason(command: string): ReturnType<typeof unsafeBashForHeaderReason> | "opaque_arithmetic_loop_header" {
	const segments = parseShellSegments(command);
	const reason = unsafeBashLoopHeaders(segments);
	if (reason) return reason;
	for (let index = 0; index < segments.length; index++) {
		if (bashArithmeticForHeader(segments[index]!) !== undefined) return "opaque_arithmetic_loop_header";
	}
	return undefined;
}

function afterLeadingRedirection(tokens: ShellSegment, index: number): number {
	const positions = tokens.redirections;
	if (!positions) return index;
	for (let position = 0; position < positions.length; position++) {
		if (positions[position] === index) return positions[position + 1] === index + 1 ? index + 1 : index + 2;
	}
	return index;
}

/** The segment after `cd ... ||` is a bare parent-shell `exit [n]` ending its list. */
function isExitOnFailure(segments: readonly ShellSegment[], cdIndex: number): boolean {
	if (segments[cdIndex]!.separatorAfter !== "||") return false;
	const next = segments[cdIndex + 1];
	if (!next || next[0] !== "exit" || next.firstWordQuoted || next.subshellDepth || next.redirections || next.dynamic) return false;
	if (next.length > 2 || (next.length === 2 && !NONNEGATIVE_INTEGER_PATTERN.test(next[1]!))) return false;
	const separator = next.separatorAfter;
	return separator === undefined || separator === ";" || separator === "\n" || separator === "\r";
}

function skipRedirections(tokens: ShellSegment, index: number): number {
	for (let after = afterLeadingRedirection(tokens, index); after !== index; after = afterLeadingRedirection(tokens, index)) index = after;
	return index;
}

/** Reuse the existing argv view; callbacks and recursive arithmetic are not evaluated. */
function hasUnsafeBashBuiltinOperand(tokens: ShellSegment): boolean {
	let index = skipRedirections(tokens, 0);
	if (index === 0 && !tokens.firstWordQuoted && (tokens[index] === "if" || tokens[index] === "elif" || tokens[index] === "while"
		|| tokens[index] === "until" || tokens[index] === "then" || tokens[index] === "else" || tokens[index] === "do" || tokens[index] === "{")) index = skipRedirections(tokens, index + 1);
	for (let prefixes = 0; prefixes <= MAX_WRAPPER_DEPTH; prefixes++) {
		const pipeline = bashPipelinePrefixEnd(tokens, index);
		if (pipeline < 0) return false; // Existing prefix checks own unsupported grammar.
		index = skipRedirections(tokens, pipeline);
		const word = tokens[index];
		if (!word) return false;
		if (LEADING_ASSIGNMENT_PATTERN.test(word)) { index = skipRedirections(tokens, index + 1); continue; }
		if (word !== "builtin" && word !== "command" && word !== "exec") break;
		index = skipRedirections(tokens, index + 1);
		if (word === "command" && (tokens[index] === "-v" || tokens[index] === "-V")) return false;
		if (word === "command" && tokens[index] === "-p") index = skipRedirections(tokens, index + 1);
		if (tokens[index] === "--") index = skipRedirections(tokens, index + 1);
	}
	const name = tokens[index];
	if (name === "test" || name === "[") return hasUnsafeBashTestOperand(tokens, index);
	if (name === "printf") {
		index = skipRedirections(tokens, index + 1);
		while (tokens[index]?.startsWith("-v")) {
			const attached = tokens[index]!.length > 2;
			if (!attached) index = skipRedirections(tokens, index + 1);
			if (hasNonliteralBashSubscript(tokens[index] ?? "", attached ? 2 : 0)) return true;
			index = skipRedirections(tokens, index + 1);
		}
		return false;
	}
	const reads = name === "read" || name === "mapfile" || name === "readarray";
	if (!reads && name !== "unset" && name !== "declare" && name !== "local" && name !== "typeset"
		&& name !== "readonly" && name !== "export" && name !== "let") return false;
	let options = name !== "let"; // Leading +/- are arithmetic operators for let.
	for (let operand = skipRedirections(tokens, index + 1); operand < tokens.length; operand = skipRedirections(tokens, operand + 1)) {
		const word = tokens[operand]!;
		if (options && word === "--") { options = false; continue; }
		if (options && word.length > 1 && (word[0] === "-" || !reads && word[0] === "+")) {
			if (!reads) continue;
			for (let flag = 1; flag < word.length; flag++) {
				const option = word[flag]!;
				if (name !== "read" && option === "C") return true;
				if (!(name === "read" ? "adinNptu" : "dnOscu").includes(option)) continue;
				const attached = flag + 1 < word.length;
				const valueIndex = attached ? operand : skipRedirections(tokens, operand + 1);
				if (name === "read" && option === "a"
					&& hasNonliteralBashSubscript(tokens[valueIndex] ?? "", attached ? flag + 1 : 0)) return true;
				if (!attached) operand = valueIndex;
				break; // Remaining characters are an option operand, not more flags.
			}
			continue;
		}
		if (!tokens.expansions?.[operand]) options = false;
		if ((!reads || name === "read") && hasNonliteralBashSubscript(word, 0, !reads)) return true;
	}
	return false;
}

/** Name/assignment arithmetic may recurse through values; only digits are bounded. */
function hasNonliteralBashSubscript(word: string, start = 0, expression = false): boolean {
	for (let index = start; index < word.length; index++) {
		let code = word.charCodeAt(index);
		if (code !== 95 && !(code >= 65 && code <= 90) && !(code >= 97 && code <= 122)) {
			if (!expression) return false;
			continue;
		}
		do {
			code = word.charCodeAt(++index);
		} while (code === 95 || code >= 65 && code <= 90 || code >= 97 && code <= 122 || code >= 48 && code <= 57);
		if (code === 91) {
			const first = ++index;
			while (word.charCodeAt(index) >= 48 && word.charCodeAt(index) <= 57) index++;
			if (index === first || word.charCodeAt(index) !== 93 || word.charCodeAt(index + 1) === 91) return true;
			if (!expression && index + 1 < word.length) return true;
		}
		if (!expression) return false;
	}
	return false;
}

function hasBareBashArithmeticCommand(tokens: ShellSegment): boolean {
	if (tokens.bashArithmeticCommandAt === undefined) return false;
	let index = skipRedirections(tokens, 0);
	if (index === 0 && !tokens.firstWordQuoted && (tokens[index] === "do" || tokens[index] === "then" || tokens[index] === "else"
		|| tokens[index] === "if" || tokens[index] === "elif" || tokens[index] === "while" || tokens[index] === "until" || tokens[index] === "{")) index = skipRedirections(tokens, index + 1);
	while (LEADING_ASSIGNMENT_PATTERN.test(tokens[index] ?? "")) index = skipRedirections(tokens, index + 1);
	return isBashArithmeticCommandHead(tokens, bashPipelinePrefixEnd(tokens, index));
}

function hasLaterBashCommandSubstitution(segments: readonly ShellSegment[], start: number): boolean {
	for (let segment = start + 1; segment < segments.length; segment++) {
		const expansions = segments[segment]!.expansions;
		if (expansions) for (const flags of expansions) if (flags && (flags & 4) !== 0) return true;
	}
	return false;
}

function hasLaterBashCommandInShell(segments: readonly ShellSegment[], index: number): boolean {
	const next = segments[index + 1];
	return next !== undefined && !segments[index]!.subshellClosedAfter && (next.subshellDepth ?? 0) >= (segments[index]!.subshellDepth ?? 0);
}

function changesBashExecutableLookup(word: string): boolean {
	const equals = word.indexOf("=");
	if (equals < 1) return false;
	const end = word.charCodeAt(equals - 1) === 43 ? equals - 1 : equals;
	const name = word.slice(0, end);
	return name !== "CDPATH" && isLookupSensitiveBashVariable(name);
}

function isUncertainBashReadDestination(word: string, expansion: number): boolean {
	if (expansion || hasDynamicSyntax(word)) return true;
	const subscript = word.indexOf("[");
	return isLookupSensitiveBashVariable(subscript < 0 ? word : word.slice(0, subscript));
}

/** Only bounded literal read/mapfile option operands can be skipped as data. */
function hasUninspectableBashReadDestination(tokens: ShellSegment, index: number, name: string): boolean {
	let options = true;
	for (let operand = index + 1; operand < tokens.length; operand++) {
		const after = afterLeadingRedirection(tokens, operand);
		if (after !== operand) { operand = after - 1; continue; }
		const word = tokens[operand]!;
		if (options && word === "--") { options = false; continue; }
		if (options && word.startsWith("-") && word.length > 1) {
			for (let option = 1; option < word.length; option++) {
				const flag = word[option]!;
				// Array origin is arithmetic, and a callback is executable source.
				if (name !== "read" && (flag === "O" || flag === "C")) return true;
				const arrayName = name === "read" && flag === "a";
				const value = arrayName || (name === "read" ? "dinNptu" : "dnscu").includes(flag);
				if (!value) {
					if (name === "read" ? flag !== "e" && flag !== "r" && flag !== "s" : flag !== "t") return true;
					continue;
				}
				const attached = word.slice(option + 1);
				const valueIndex = attached ? operand : skipRedirections(tokens, operand + 1);
				const argument = attached || tokens[valueIndex];
				if (!argument || arrayName && isUncertainBashReadDestination(argument, tokens.expansions?.[valueIndex] ?? 0)) return true;
				if ((name === "read" ? "nNtu" : "nscu").includes(flag) && !NONNEGATIVE_INTEGER_PATTERN.test(argument)) return true;
				if (!attached) operand = valueIndex;
				break;
			}
			continue;
		}
		options = false;
		if (isUncertainBashReadDestination(word, tokens.expansions?.[operand] ?? 0)) return true;
	}
	return false;
}

function hasUninspectableBashLet(tokens: ShellSegment, index: number): boolean {
	for (let operand = index + 1; operand < tokens.length; operand++) {
		const after = afterLeadingRedirection(tokens, operand);
		if (after !== operand) { operand = after - 1; continue; }
		const simple = SIMPLE_BASH_LET_ASSIGNMENT_PATTERN.exec(tokens[operand]!);
		if (!simple || tokens.expansions?.[operand] || isLookupSensitiveBashVariable(simple[1])) return true;
	}
	return false;
}

/** Only regular-builtin queries have portable temporary assignment semantics.
 * export is a POSIX special builtin: Bash invoked as sh can persist its prefix. */
function isTemporaryCdpathQuery(tokens: ShellSegment, index: number): boolean {
	if (index !== 1 || tokens.firstWordQuoted || tokens.expansions?.[0]
		|| !TEMPORARY_CDPATH_QUERY_PATTERN.test(tokens[0]!)) return false;
	const name = tokens[index];
	const option = skipRedirections(tokens, index + 1);
	if ((name !== "declare" && name !== "typeset") || tokens[option] !== "-p") return false;
	const variable = skipRedirections(tokens, option + 1);
	return tokens[variable] === "CDPATH" && !tokens.expansions?.[variable]
		&& skipRedirections(tokens, variable + 1) === tokens.length;
}

/** Reject bounded command lists whose later cwd or executable lookup cannot be established. */
export function hasUninspectableBashState(command: string): boolean {
	return uninspectableBashStateStart(command) >= 0;
}

/** First affected simple-command source offset; compound state stays conservative. */
export function uninspectableBashStateStart(command: string): number {
	const segments = parseShellSegments(command, true);
	let loopDepth = 0;
	let conditionalDepth = 0;
	let braceDepth = 0;
	// A child's lookup state is inherited from its ancestors but discarded
	// when a closed subshell returns to its parent.
	const cdSemanticsChanges: boolean[] = [];
	let exitRedefined = false;
	for (let segmentIndex = 0; segmentIndex < segments.length; segmentIndex++) {
		const tokens = segments[segmentIndex]!;
		const depth = tokens.subshellDepth ?? 0;
		cdSemanticsChanges.length = depth + 1;
		let cdSemanticsChanged = false;
		for (let ancestor = 0; ancestor <= depth; ancestor++) if (cdSemanticsChanges[ancestor]) cdSemanticsChanged = true;
		// An inherited or prior CDPATH change reaches a nested evaluator, and
		// command substitutions can observe the same changed shell state.
		if (cdSemanticsChanged && tokens.expansions) for (const flags of tokens.expansions) if ((flags & 4) !== 0) return 0;
		const controlIndex = skipBashReservedPrefixes(tokens, 0);
		if (controlIndex < 0) return 0;
		const first = tokens[controlIndex];
		if (first === "done" && loopDepth > 0) loopDepth--;
		if ((first === "fi" || first === "esac") && conditionalDepth > 0) conditionalDepth--;
		if (first === "}" && braceDepth > 0) braceDepth--;
		if (first === "for" || first === "while" || first === "until" || first === "select") loopDepth++;
		if (first === "if" || first === "case") conditionalDepth++;
		if (first === "{") braceDepth++;
		const simpleSegment = loopDepth === 0 && conditionalDepth === 0 && braceDepth === 0
			&& !tokens.subshellDepth && !tokens.pipelineMember && !tokens.conditionalMember && controlIndex === 0;
		const stateStart = simpleSegment ? tokens.sourceStart! : 0;
		let index = commandTokenIndex(tokens);
		if (index < 0) continue;
		// A launcher such as `env` or `sudo` runs an external program, never a shell builtin.
		const launched = index > 0;
		if (index === 0) {
			let controlPrefixes = 0;
			while (index < tokens.length) {
				index = skipBashReservedPrefixes(tokens, index);
				if (index < 0) return stateStart;
				if (tokens[index] !== "do" && tokens[index] !== "{" && tokens[index] !== "then" && tokens[index] !== "else"
					&& tokens[index] !== "if" && tokens[index] !== "elif" && tokens[index] !== "while" && tokens[index] !== "until") break;
				// Prefixes and control words can alternate (`! if cd ...`). Beyond
				// the retained quote provenance, do not guess whether a word is syntax.
				if (index > 2 || ++controlPrefixes > MAX_WRAPPER_DEPTH) return stateStart;
				if (index === 0 ? tokens.firstWordQuoted : index === 1 ? tokens.secondWordQuoted : tokens.thirdWordQuoted) break;
				index++;
			}
		} else index = skipBashReservedPrefixes(tokens, index);
		if (index < 0) return stateStart;
		let builtinPrefixes = 0;
		let leadingAssignment = false;
		let cdpathAssignment = false;
		let lookupAssignment = false;
		while (index < tokens.length) {
			const after = afterLeadingRedirection(tokens, index);
			if (after !== index) { index = after; continue; }
			if (LEADING_ASSIGNMENT_PATTERN.test(tokens[index]!)) {
				leadingAssignment = true;
				if (tokens[index]!.startsWith("CDPATH=") || tokens[index]!.startsWith("CDPATH+=")) cdpathAssignment = true;
				if (!(index === 0 ? tokens.firstWordQuoted : index === 1 ? tokens.secondWordQuoted : index === 2 && tokens.thirdWordQuoted)
					&& changesBashExecutableLookup(tokens[index]!)) lookupAssignment = true;
				index++; continue;
			}
			// `command command cd`, `command -p cd` and `builtin -- cd` still dispatch to cd.
			if (tokens[index] === "command" || tokens[index] === "builtin") {
				if (++builtinPrefixes > MAX_WRAPPER_DEPTH) return stateStart;
				index++;
				while (tokens[index] === "-p" || tokens[index] === "--") index++;
				continue;
			}
			break;
		}
		// Bash lastpipe may run the final pipeline member in the current shell.
		// Earlier members still cannot persist their assignments there.
		const mayPersist = !tokens.pipelineMember || tokens.separatorAfter !== "|";
		// An assignment-only simple command persists in its current shell; a prefix
		// assignment before an executable is not evidence of the later shell cwd.
		if (index >= tokens.length) {
			if (cdpathAssignment && mayPersist) cdSemanticsChanges[depth] = true;
			if (lookupAssignment && hasLaterBashCommandInShell(segments, segmentIndex)) return stateStart;
			continue;
		}
		// Builtins are exact bare words: `./cd`, `/opt/cd` and `CD` are external executables.
		const effectiveName = tokens[index] ?? "";
		const name = launched ? "" : effectiveName;
		// Functions can shadow apparently harmless builtins and run in the
		// calling shell. A later command (including a final eval) may call one.
		if ((name === "function" && !tokens.firstWordQuoted
			|| tokens.separatorAfter === "(" && index + 1 === tokens.length && !tokens.firstWordQuoted && !tokens.dynamic)
			&& hasLaterBashCommandInShell(segments, segmentIndex)) return stateStart;
		// A temporary lookup assignment also affects the executable selected by
		// this very command; do not authorize it using the inherited PATH.
		if (lookupAssignment) return stateStart;
		// A definition on an earlier line can replace a later command. The
		// bounded scanner does not propagate alias definitions or removals.
		if ((name === "alias" || name === "unalias") && hasLaterBashCommandInShell(segments, segmentIndex)) {
			for (let operand = skipRedirections(tokens, index + 1); operand < tokens.length; operand = skipRedirections(tokens, operand + 1)) {
				if (name === "unalias" || tokens[operand]!.includes("=") || tokens.expansions?.[operand]) return stateStart;
			}
		}
		if (cdpathAssignment && mayPersist && !isTemporaryCdpathQuery(tokens, index)
			&& (name === "export" || name === "readonly" || name === "declare" || name === "typeset")) cdSemanticsChanges[depth] = cdSemanticsChanged = true;
		// These builtins persist an assignment in their current shell even though the
		// assignment word follows the command name rather than preceding it.
		if (mayPersist && (name === "export" || name === "declare" || name === "typeset" || name === "readonly")) {
			for (let operand = index + 1; operand < tokens.length; operand++) {
				const after = afterLeadingRedirection(tokens, operand);
				if (after !== operand) { operand = after - 1; continue; }
				if (tokens[operand]!.startsWith("CDPATH=") || tokens[operand]!.startsWith("CDPATH+=")) cdSemanticsChanges[depth] = cdSemanticsChanged = true;
				if (changesBashExecutableLookup(tokens[operand]!) && hasLaterBashCommandInShell(segments, segmentIndex)) return stateStart;
			}
		}
		if (cdSemanticsChanged && (SCRIPT_WRAPPERS.has(commandName(effectiveName)) || name === "eval" || name === "source" || name === "." || name === "exec")) return stateStart;
		if ((name === "declare" || name === "typeset" || name === "local")
			&& hasLaterBashCommandInShell(segments, segmentIndex)) {
			for (let operand = index + 1; operand < tokens.length; operand++) {
				const word = tokens[operand]!;
				if ((word.startsWith("-") || word.startsWith("+")) && word.charCodeAt(1) !== 45 && word.includes("n")) return stateStart;
			}
		}
		if (name === "let" && hasLaterBashCommandInShell(segments, segmentIndex)
			&& hasUninspectableBashLet(tokens, index)) return stateStart;
		if ((name === "read" || name === "readarray" || name === "mapfile")
			&& hasLaterBashCommandInShell(segments, segmentIndex)
			&& hasUninspectableBashReadDestination(tokens, index, name)) return stateStart;
		if (name === "getopts" && hasLaterBashCommandInShell(segments, segmentIndex)) {
			const optionsIndex = skipRedirections(tokens, index + 1);
			const destinationIndex = skipRedirections(tokens, optionsIndex + 1);
			const destination = tokens[destinationIndex];
			if (!tokens[optionsIndex] || !destination
				|| isUncertainBashReadDestination(destination, tokens.expansions?.[destinationIndex] ?? 0)) return stateStart;
		}
		// The scans track only a direct literal `cd`; directory stacks are not followed.
		if (name === "pushd" || name === "popd") return stateStart;
		// hash with operands can pin or clear a lookup for a later command. A
		// bare `hash` only lists entries and does not change the table.
		if (name === "hash" && skipRedirections(tokens, index + 1) < tokens.length && hasLaterBashCommandInShell(segments, segmentIndex)) return stateStart;
		if (changesBashCdSemantics(tokens, index, name)) { cdSemanticsChanges[depth] = true; continue; }
		// Trap actions are executable source, including EXIT actions at shutdown.
		// A pipeline's last member can also persist a trap under `lastpipe`.
		if (name === "trap") {
			let actionIndex = skipRedirections(tokens, index + 1);
			const endOfOptions = tokens[actionIndex] === "--";
			if (endOfOptions) actionIndex = skipRedirections(tokens, actionIndex + 1);
			const action = tokens[actionIndex];
			if (action !== undefined && (endOfOptions || action !== "-p" && action !== "-l") && action !== "-"
				&& (action !== "" || tokens.expansions?.[actionIndex]) && !OWNED_FOREGROUND_JOB_PATTERN.test(command)) return stateStart;
		}
		// A sourced file or evaluated source runs in this shell. Without bounded
		// state propagation, a later command could use a different cwd or lookup.
		if ((name === "source" || name === "." || name === "eval") && segmentIndex + 1 < segments.length) return stateStart;
		if (name === "function" ? tokens[index + 1] === "exit" : name === "exit" && tokens.separatorAfter === "(") exitRedefined = true;
		if (name === "cd") {
			// Redirections may surround the operand; Bash rejects a second operand
			// (`cd: too many arguments`) and stays in the original directory.
			const operandIndex = skipRedirections(tokens, index + 1);
			const target = tokens[operandIndex];
			if (leadingAssignment || builtinPrefixes > 0 || cdSemanticsChanged
				|| !target || target.startsWith("-") || hasDynamicSyntax(target)
				|| skipRedirections(tokens, operandIndex + 1) < tokens.length) return stateStart;
			// cd itself can fail even when its redirections succeed. An independent
			// later target must therefore be read-only or gated on successful cd.
			if (target !== "." && hasLaterBashCommandSubstitution(segments, segmentIndex)) return stateStart;
			if (simpleSegment && (segmentIndex + 1 === segments.length || hasOnlyReadOnlyConditionalTail(segments, segmentIndex))) continue;
			// After `a || cd`, a true `a` skips cd while later `&&`/`||` commands still run:
			// `(a || cd dir) && next`. An incoming `&&` skips both cd and its dependents.
			const skippedByOr = segmentIndex > 0 && segments[segmentIndex - 1]!.separatorAfter === "||";
			// `cd dir || exit [n]` leaves the shell unless cd succeeded, like `&&` for the rest of the script.
			if (!exitRedefined && !skippedByOr && loopDepth === 0 && conditionalDepth === 0 && braceDepth === 0 && controlIndex === 0
				&& !tokens.subshellDepth && !tokens.pipelineMember && isExitOnFailure(segments, segmentIndex)) continue;
			// A literal `cd .` leaves relative targets at the same path whether it
			// succeeds or fails; other conditional cd targets can change the cwd.
			if (target === ".") continue;
			if (controlIndex > 0) return stateStart;
			// The RHS of `cd path && ...` only runs after a successful cd. A later
			// independent command is safe only when its effects are provably read-only.
			if (!skippedByOr && !tokens.subshellDepth && !tokens.pipelineMember && tokens.separatorAfter === "&&"
				&& hasOnlyReadOnlyConditionalTail(segments, segmentIndex)) continue;
			return stateStart;
		}
	}
	return -1;
}

/**
 * Builtin toggles, a `cd` function, cdable_vars/expand_aliases and physical
 * mode make a later literal `cd` resolve differently from the scanned path.
 */
function changesBashCdSemantics(tokens: ShellSegment, index: number, name: string): boolean {
	if (name === "enable") return true;
	if (name === "function") return tokens[index + 1] === "cd";
	if (name !== "shopt" && name !== "set") return false;
	if (name === "set") {
		for (let cursor = skipRedirections(tokens, index + 1); cursor < tokens.length; cursor = skipRedirections(tokens, cursor + 1)) {
			const word = tokens[cursor]!;
			if (tokens.expansions?.[cursor]) return true;
			// Options stop at -- or the first positional parameter. A literal
			// positional "posix"/"physical" never changes shell mode.
			if (word === "--" || word.length < 2 || word[0] !== "-" && word[0] !== "+") return false;
			if (word.includes("P")) return true;
			if (word.includes("o")) {
				cursor = skipRedirections(tokens, cursor + 1);
				if (tokens.expansions?.[cursor] || tokens[cursor] === "physical" || tokens[cursor] === "posix") return true;
			}
		}
		return false;
	}
	let setOptions = false, changing = false;
	for (let cursor = skipRedirections(tokens, index + 1); cursor < tokens.length; cursor = skipRedirections(tokens, cursor + 1)) {
		const word = tokens[cursor]!;
		if (tokens.expansions?.[cursor]) return true;
		if (word.length > 1 && word[0] === "-") {
			if (word.includes("o")) setOptions = true;
			if (word.includes("s") || word.includes("u")) changing = true;
		}
		if (changing && (word === "cdable_vars" || word === "expand_aliases")) return true;
		if (changing && setOptions && (word === "posix" || word === "physical")) return true;
	}
	return false;
}

function skipBashReservedPrefixes(tokens: ShellSegment, start: number): number {
	return bashPipelinePrefixEnd(tokens, start);
}

function hasOnlyReadOnlyConditionalTail(segments: readonly ShellSegment[], cdIndex: number): boolean {
	let independent = false;
	for (let index = cdIndex + 1; index < segments.length; index++) {
		const separator = segments[index - 1]!.separatorAfter;
		if (separator !== "&&" && separator !== "|" && separator !== "(" && separator !== ")") independent = true;
		if (independent && !isReadOnlyConditionalTailSegment(segments[index]!)) return false;
	}
	return true;
}

function isReadOnlyConditionalTailSegment(tokens: ShellSegment): boolean {
	if (tokens.dynamic || tokens.expansions?.length) return false;
	const redirections = tokens.redirections;
	if (redirections) for (let position = 0; position < redirections.length; position++) {
		const index = redirections[position]!;
		if (isStaticDescriptorCopy(tokens[index]!, tokens[index + 1], tokens.redirectionFds?.[position])) continue;
		if (tokens[index] === "<" && tokens[index + 1] && !isShellDynamicDescriptor(tokens.redirectionFds?.[position] ?? "")
			&& !hasDynamicSyntax(tokens[index + 1]!) && !isBashNetworkRedirectionTarget(tokens[index + 1]!)) continue;
		if (tokens[index] !== ">" || tokens.redirectionFds?.[position] !== "2" || tokens[index + 1] !== "/dev/null") return false;
	}
	const argv = redirections ? tokens.slice() : tokens;
	if (redirections) stripShellRedirections(argv, redirections);
	if (argv.length === 0) return true;
	const index = commandTokenIndex(argv);
	if (index < 0 || index >= argv.length) return false;
	const command = argv[index];
	if (index > 0 && (index !== 2 || argv[0] !== "timeout" || command !== "find")) return false;
	if (command === "echo" || command === ":" || command === "true" || command === "false") return true;
	if (command === "command") return argv[index + 1] === "-v" || argv[index + 1] === "-V"
		|| argv[index + 1] === "echo";
	if (command === "cat") return argv.length === index + 1;
	if (command === "head") {
		for (let cursor = index + 1; cursor < argv.length; cursor++) {
			const value = argv[cursor]!;
			if (!HEAD_COUNT_OPTION_PATTERN.test(value) && !NONNEGATIVE_INTEGER_PATTERN.test(value)) return false;
		}
		return true;
	}
	return command === "find" ? isReadOnlyFindTail(argv, index) : command === "sort" && isReadOnlySortTail(argv, index);
}

function parseShellSegments(command: string, positions = false): ShellSegment[] {
	const segments: ShellSegment[] = [];
	let tokens: ShellSegment = [];
	if (positions) tokens.sourceStart = 0;
	let value = "";
	let tokenStarted = false;
	let quote = 0;
	let ansiC = false;
	let arithmeticDepth = 0;
	let escaped = false;
	let literalWord = true;
	let redirectionTargetPending = false;
	let subshellDepth = 0;
	let bashDoubleBracket = false;

	for (let index = 0; index < command.length; index++) {
		const code = command.charCodeAt(index);
		if (escaped) {
			literalWord = false;
			value += command[index];
			tokenStarted = true;
			escaped = false;
			continue;
		}
		if (code === 92 && quote !== 39) {
			const next = command.charCodeAt(index + 1);
			if (next === 10) { index++; continue; }
			// Double quotes only remove backslash before $, `, ", backslash or LF.
			if (quote === 34 && next !== 36 && next !== 96 && next !== 34 && next !== 92) {
				value += "\\"; tokenStarted = true; continue;
			}
			escaped = true;
			tokenStarted = true;
			continue;
		}
		if (quote === 0 && code === 36 && isSimpleBashAnsiCQuote(command, index)) {
			quote = 39; ansiC = true; literalWord = false; tokenStarted = true; index++; continue;
		}
		if (quote !== 39 && (code === 36 || code === 96)) {
			tokens.dynamic = true;
			const flags = code === 96 || command.charCodeAt(index + 1) === 40 ? 4 : quote === 34 ? 1 : 2;
			const expansions = tokens.expansions ??= [];
			expansions[tokens.length] = (expansions[tokens.length] ?? 0) | flags;
		}
		// Preserve a substitution as part of this argv word; its body is inspected
		// recursively by lifecycle/mutation analysis, never as outer shell state.
		if (quote !== 39 && code === 36 && command.charCodeAt(index + 1) === 40 && command.charCodeAt(index + 2) !== 40) {
			const end = commandSubstitutionEnd(command, index);
			if (end >= 0) {
				value += command.slice(index, end + 1);
				tokenStarted = true;
				literalWord = false;
				index = end;
				continue;
			}
		}
		// Launcher assignment operands are ordinary argv words: unquoted braces
		// can expand one apparent assignment into additional executable operands.
		if (quote === 0 && (code === 123 || code === 125)) {
			const expansions = tokens.expansions ??= [];
			expansions[tokens.length] = (expansions[tokens.length] ?? 0) | 8;
		}
		if (quote === 0 && !tokenStarted && code === 126) {
			const expansions = tokens.expansions ??= [];
			expansions[tokens.length] = (expansions[tokens.length] ?? 0) | 32;
		}
		// Preserve actual unquoted pathname expansion for unresolved heredoc argv.
		// Reuse the existing per-word flags; quoted/escaped query text stays data.
		if (quote === 0 && !bashDoubleBracket && (code === 42 || code === 63
			|| code === 91 && command.charCodeAt(index + 1) !== 91 && !isBashTestWhitespace(command.charCodeAt(index + 1)))) {
			const expansions = tokens.expansions ??= [];
			expansions[tokens.length] = (expansions[tokens.length] ?? 0) | 16;
		}
		if (quote !== 0) {
			// Decode the \n, \r and \t escapes a simple $'...' quote may contain, as Bash does,
			// so a path operand names the real file rather than its escaped spelling.
			if (ansiC && code === 92) {
				const escaped = command.charCodeAt(++index);
				value += String.fromCharCode(escaped === 110 ? 10 : escaped === 114 ? 13 : 9);
				continue;
			}
			if (code === quote) { quote = 0; ansiC = false; }
			else value += command[index];
			continue;
		}
		if (code === 36 && command.charCodeAt(index + 1) === 40 && command.charCodeAt(index + 2) === 40) {
			value += command.slice(index, index + 3);
			tokenStarted = true;
			literalWord = false;
			arithmeticDepth = 2;
			index += 2;
			continue;
		}
		if (code === 40 && command.charCodeAt(index + 1) === 40) {
			if (arithmeticDepth === 0 && !tokenStarted && !redirectionTargetPending) tokens.bashArithmeticCommandAt = tokens.length;
			value += "((";
			tokenStarted = true;
			literalWord = false;
			arithmeticDepth = 2;
			index++;
			continue;
		}
		if (arithmeticDepth > 0) {
			if (code === 40) arithmeticDepth++;
			else if (code === 41) arithmeticDepth--;
			value += command[index];
			tokenStarted = true;
			continue;
		}
		if (code === 34 || code === 39) {
			quote = code;
			literalWord = false;
			tokenStarted = true;
			continue;
		}
		if (code === 32 || code === 9 || (bashDoubleBracket && isBashTestWhitespace(code))) {
			if (tokenStarted) {
				if (!literalWord && tokens.length === 0) tokens.firstWordQuoted = true;
				if (!literalWord && tokens.length === 1) tokens.secondWordQuoted = true;
				if (!literalWord && tokens.length === 2) tokens.thirdWordQuoted = true;
				tokens.push(value);
				redirectionTargetPending = false;
				value = "";
				tokenStarted = false;
				literalWord = true;
			}
			continue;
		}
		if (code === 35 && !tokenStarted) {
			while (index < command.length && command.charCodeAt(index) !== 10 && command.charCodeAt(index) !== 13) index++;
			if (index >= command.length) break;
			index--; continue;
		}
		if (!bashDoubleBracket && code === 91 && command.charCodeAt(index + 1) === 91 && !tokenStarted
			&& isBashDoubleBracketHead(tokens) && isBashTestWhitespace(command.charCodeAt(index + 2))) {
			tokens.bashTestOpenAt = tokens.length;
			value = "[["; tokenStarted = true; bashDoubleBracket = true; index++; continue;
		}
		if (bashDoubleBracket && code === 93 && command.charCodeAt(index + 1) === 93 && !tokenStarted
			&& isBashDoubleBracketCloseBoundary(command, index + 2)) {
			tokens.bashTestClosed = true;
			value = "]]"; tokenStarted = true; bashDoubleBracket = false; index++; continue;
		}
		if (bashDoubleBracket && isBashProcessSubstitutionStart(command, index)) tokens.bashTestProcessSubstitution = true;
		const redirectionWidth = bashDoubleBracket ? 0 : shellRedirectionLength(command, index);
		if (redirectionWidth > 0) {
			const sourceFd = !redirectionTargetPending && literalWord && (isShellFileDescriptor(value) || isShellDynamicDescriptor(value)) ? value : undefined;
			if (tokenStarted && !sourceFd) {
				if (!literalWord && tokens.length === 0) tokens.firstWordQuoted = true;
				if (!literalWord && tokens.length === 1) tokens.secondWordQuoted = true;
				if (!literalWord && tokens.length === 2) tokens.thirdWordQuoted = true;
				tokens.push(value);
			}
			(tokens.redirections ??= []).push(tokens.length);
			(tokens.redirectionFds ??= []).push(sourceFd);
			tokens.push(command.slice(index, index + redirectionWidth));
			redirectionTargetPending = true;
			index += redirectionWidth - 1;
			value = "";
			tokenStarted = false;
			literalWord = true;
			continue;
		}
		if (code === 10 || code === 13 || code === 59 || code === 38 || code === 124 || code === 40 || code === 41) {
			if (bashDoubleBracket) { value += command[index]; tokenStarted = true; continue; }
			if (tokenStarted) {
				if (!literalWord && tokens.length === 0) tokens.firstWordQuoted = true;
				if (!literalWord && tokens.length === 1) tokens.secondWordQuoted = true;
				if (!literalWord && tokens.length === 2) tokens.thirdWordQuoted = true;
				tokens.push(value);
			}
			const pipeline = code === 124 && command.charCodeAt(index + 1) !== 124;
			const conditional = (code === 38 || code === 124) && command.charCodeAt(index + 1) === code;
			if (pipeline) tokens.pipelineMember = true;
			if (conditional) tokens.conditionalMember = true;
			tokens.separatorAfter = conditional ? (code === 38 ? "&&" : "||") : command[index];
			// A list operator after `)` belongs to the closed command, even when
			// the current token buffer is empty. Keep its dependency edge.
			if (tokens.length === 0 && code !== 40 && code !== 41 && segments.length > 0
				&& segments[segments.length - 1]!.separatorAfter === ")") {
				segments[segments.length - 1]!.separatorAfter = tokens.separatorAfter;
			}
			if (tokens.length > 0) segments.push(tokens);
			if (code === 40) subshellDepth++;
			else if (code === 41 && subshellDepth > 0) {
				const last = segments[segments.length - 1];
				if (last && (last.subshellDepth ?? 0) >= subshellDepth) last.subshellClosedAfter = true;
				subshellDepth--;
			}
			tokens = [];
			if (positions) tokens.sourceStart = index + 1;
			tokens.subshellDepth = subshellDepth;
			tokens.pipelineMember = pipeline;
			tokens.conditionalMember = conditional;
			literalWord = true;
			value = "";
			tokenStarted = false;
			redirectionTargetPending = false;
			if ((code === 38 || code === 124) && command.charCodeAt(index + 1) === code) index++;
			continue;
		}
		value += command[index];
		tokenStarted = true;
	}
	if (tokenStarted) {
		if (!literalWord && tokens.length === 0) tokens.firstWordQuoted = true;
		if (!literalWord && tokens.length === 1) tokens.secondWordQuoted = true;
		if (!literalWord && tokens.length === 2) tokens.thirdWordQuoted = true;
		tokens.push(value);
	}
	if (tokens.length > 0) segments.push(tokens);
	return segments;
}

// Only retain the already-recognized single-token env forms. An unsupported
// option may consume the next word; do not mistake that operand for a command.
// Shared by CLI lifecycle refusal and heredoc consumer lookup; no argv parsing
// or reconstruction of option values is added.
function hasUninspectableEnvLauncher(tokens: readonly string[], start: number): boolean {
	for (let index = start + 1; index < tokens.length; index++) {
		const value = tokens[index]!;
		if (value === "--") return false;
		if (!value.startsWith("-")) {
			if (value.includes("=")) continue;
			return false;
		}
		if (value === "-i" || value === "-0" || value.startsWith("--unset=") || value.startsWith("-u") && value.length > 2) continue;
		return true;
	}
	return false;
}

function commandTokenIndex(tokens: readonly string[], inspectHeredoc = false): number {
	let index = 0;
	let wrapperDepth = 0;
	while (index < tokens.length) {
		const name = commandName(tokens[index] ?? "");
		if (++wrapperDepth > MAX_WRAPPER_DEPTH) return -1;
		if (name === "sudo" || name === "doas") {
			if (inspectHeredoc && tokens[index + 1]?.startsWith("-") && tokens[index + 1] !== "--") return index;
			index++;
			while (index < tokens.length && tokens[index]!.startsWith("-")) index++;
			continue;
		}
		if (name === "env") {
			if (inspectHeredoc && hasUninspectableEnvLauncher(tokens, index)) return index;
			index++;
			if (tokens[index] === "--") index++;
			while (index < tokens.length) {
				const value = tokens[index]!;
				if (value.startsWith("-") || value.includes("=")) index++;
				else break;
			}
			continue;
		}
		if (name === "timeout" || name === "timeout.exe") {
			const parsed = parseTimeoutInvocation(tokens, index);
			if (!parsed.supported) return inspectHeredoc ? index : -1;
			index = parsed.commandIndex;
			continue;
		}
		break;
	}
	return index;
}

function commandName(value: string): string {
	return basename(value.replaceAll("\\", "/")).toLowerCase();
}

function shortOptionContains(value: string, letter: string): boolean {
	if (value.length < 2 || value.charCodeAt(0) !== 45 || value.charCodeAt(1) === 45) return false;
	return value.toLowerCase().includes(letter);
}

function hasDynamicSyntax(value: string): boolean {
	for (let index = 0; index < value.length; index++) {
		const code = value.charCodeAt(index);
		if (code === 36 || code === 37 || code === 42 || code === 63 || code === 91 || code === 93 || code === 123 || code === 125 || code === 126) return true;
	}
	return false;
}

/** Only a leading unquoted HOME tilde and a final-segment glob are bounded. */
export function staticMutationTarget(target: string, cwd: string, expansion = 0): string | undefined {
	if (expansion & ~48) return undefined;
	if (expansion & 32) {
		if (target !== "~" && !target.startsWith("~/")) return undefined;
		cwd = homedir();
		target = "." + target.slice(1); // The OS-provided HOME is a path, not shell source.
	}
	const separator = Math.max(target.lastIndexOf("/"), target.lastIndexOf("\\"));
	let glob = false;
	for (let index = 0; index < target.length; index++) {
		const code = target.charCodeAt(index);
		if (code === 42 || code === 63 || code === 91) {
			if (!(expansion & 16) || index < separator) return undefined;
			glob = true;
		} else if (code === 36 || code === 37 || code === 123 || code === 125 || code === 126) return undefined;
	}
	return resolve(cwd, glob ? separator < 0 ? "." : target.slice(0, separator + 1) : target);
}

function maskCodeStringsAndComments(source: string, language: "node" | "python", builder: ScanBuilder): string {
	const output = new Array<string>(source.length);
	let quote = 0;
	let triple = false;
	let lineComment = false;
	let blockComment = false;
	let escaped = false;
	let propertyStart = -2; // -2: not a property; -1: after a dot, before its name.
	for (let index = 0; index < source.length; index++) {
		const code = source.charCodeAt(index);
		const next = source.charCodeAt(index + 1);
		if (lineComment) {
			const lineEnd = code === 10 || code === 13 || language === "node" && (code === 8232 || code === 8233);
			output[index] = lineEnd ? source[index]! : " ";
			if (lineEnd) lineComment = false;
			continue;
		}
		if (blockComment) {
			output[index] = " ";
			if (code === 42 && next === 47) {
				output[index + 1] = " ";
				index++;
				blockComment = false;
			}
			continue;
		}
		if (quote !== 0) {
			output[index] = " ";
			if (escaped) {
				escaped = false;
				continue;
			}
			if (code === 92) {
				escaped = true;
				continue;
			}
			if (triple && code === quote && next === quote && source.charCodeAt(index + 2) === quote) {
				output[index + 1] = " ";
				output[index + 2] = " ";
				index += 2;
				quote = 0;
				triple = false;
			} else if (!triple && code === quote) {
				quote = 0;
			}
			continue;
		}
		if (language === "node" && code === 47 && next === 47) {
			if (propertyStart >= 0) propertyStart = -2;
			output[index] = " ";
			output[index + 1] = " ";
			index++;
			lineComment = true;
			continue;
		}
		if (language === "node" && code === 47 && next === 42) {
			if (propertyStart >= 0) propertyStart = -2;
			output[index] = " ";
			output[index + 1] = " ";
			index++;
			blockComment = true;
			continue;
		}
		if (language === "python" && code === 35) {
			if (propertyStart >= 0) propertyStart = -2;
			output[index] = " ";
			lineComment = true;
			continue;
		}
		if (language === "python" && code === 92 && (next === 10 || next === 13 && source.charCodeAt(index + 2) === 10)) {
			output[index] = " "; continue;
		}
		if (code === 34 || code === 39 || (language === "node" && code === 96)) {
			propertyStart = -2;
			const keyEnd = language === "node" ? nodeLiteralMethodKeyEnd(source, index) : index;
			if (keyEnd > index) {
				for (; index < keyEnd; index++) output[index] = source[index]!;
				index--; continue;
			}
			if (language === "node") {
				const decodedEnd = writeEscapedNodeMethodKey(source, output, index);
				if (decodedEnd < 0) { addMutationPrimitive(builder, "node_unresolved_method"); markUnverifiable(builder, true); }
				else if (decodedEnd > 0) { index = decodedEnd - 1; continue; }
			}
			quote = code;
			triple = language === "python" && next === code && source.charCodeAt(index + 2) === code;
			output[index] = " ";
			if (triple) {
				output[index + 1] = " ";
				output[index + 2] = " ";
				index += 2;
			}
			continue;
		}
		if (code === 46) propertyStart = -1;
		else if (propertyStart !== -2) {
			if (language === "node" && code === 92 && next === 117 || language === "python" && code >= 128 && isCodeMethodNamePart(code)) {
				const end = writeCodeMethodName(source, output, propertyStart < 0 ? index : propertyStart, language);
				propertyStart = -2;
				if (end < 0) { addMutationPrimitive(builder, "node_unresolved_method"); markUnverifiable(builder, true); }
				else { index = end - 1; continue; }
			} else if (isCodeMethodNamePart(code)) { if (propertyStart === -1) propertyStart = index; }
			else if (propertyStart >= 0 || !isCodeWhitespace(code)) propertyStart = -2;
		}
		output[index] = source[index]!;
	}
	return output.join("");
}

/** Preserve only an exact quoted deletion key after [, inside this mask's
 * code state. Literal strings/comments outside property keys remain masked. */
function nodeLiteralMethodKeyEnd(source: string, start: number): number {
	let before = start - 1;
	while (before >= 0 && isCodeWhitespace(source.charCodeAt(before))) before--;
	if (source.charCodeAt(before) !== 91) return start;
	NODE_LITERAL_METHOD_KEY_PATTERN.lastIndex = start;
	try { return NODE_LITERAL_METHOD_KEY_PATTERN.test(source) ? NODE_LITERAL_METHOD_KEY_PATTERN.lastIndex : start; }
	finally { NODE_LITERAL_METHOD_KEY_PATTERN.lastIndex = 0; }
}

function isCodeWhitespace(code: number): boolean {
	return code === 32 || code >= 9 && code <= 13 || code === 160 || code === 5760
		|| code >= 8192 && code <= 8202 || code === 8232 || code === 8233 || code === 8239
		|| code === 8287 || code === 12288 || code === 65279;
}

function literalFirstArgument(source: string, openParen: number, singleArgument = false): string | undefined {
	let index = openParen + 1;
	while (index < source.length) {
		const code = source.charCodeAt(index);
		if (code !== 32 && code !== 9 && code !== 10 && code !== 13) break;
		index++;
	}
	const quote = source.charCodeAt(index);
	if (quote !== 34 && quote !== 39) return undefined;
	let value = "";
	let escaped = false;
	for (index++; index < source.length; index++) {
		const code = source.charCodeAt(index);
		if (escaped) {
			value += source[index];
			escaped = false;
			continue;
		}
		if (code === 92) {
			const next = source.charCodeAt(index + 1);
			// Only quote/backslash escapes share these literal semantics in both
			// supported languages. Never guess hex, Unicode, octal or other escapes.
			if (next !== 92 && next !== 34 && next !== 39) return undefined;
			escaped = true;
			continue;
		}
		if (code === quote) {
			let end = index + 1;
			while (source.charCodeAt(end) === 32 || source.charCodeAt(end) === 9 || source.charCodeAt(end) === 10 || source.charCodeAt(end) === 13) end++;
			if (singleArgument && source.charCodeAt(end) === 44) {
				end++;
				while (source.charCodeAt(end) === 32 || source.charCodeAt(end) === 9 || source.charCodeAt(end) === 10 || source.charCodeAt(end) === 13) end++;
			}
			return source.charCodeAt(end) === 41 || !singleArgument && source.charCodeAt(end) === 44 ? value : undefined;
		}
		value += source[index];
	}
	return undefined;
}
