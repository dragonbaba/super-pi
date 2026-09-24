import { basename, resolve } from "node:path";
import {
	DETACH_UTILITY_PATTERN,
	DOCKER_DETACHED_PATTERN,
	EXECUTABLE_EXPANSION_TEXT_PATTERN,
	HEAD_COUNT_OPTION_PATTERN,
	LEADING_ASSIGNMENT_PATTERN,
	LEADING_REDIRECTION_PATTERN,
	LOOKUP_ASSIGNMENT_PATTERN,
	NODE_RECURSIVE_RM_PATTERN,
	NODE_UNLINK_PATTERN,
	NONNEGATIVE_INTEGER_PATTERN,
	OPAQUE_JOB_INTERPRETER_PATTERN,
	OPAQUE_JOB_LAUNCHER_PATTERN,
	OWNED_FOREGROUND_JOB_PATTERN,
	OWNED_USE_COMMAND_PATTERN,
	POWERSHELL_REMOVE_RECURSIVE_PATTERN,
	PYTHON_RMTREE_PATTERN,
	PYTHON_UNLINK_PATTERN,
	REDIRECTION_OPERATOR_PATTERN,
	SERVICE_START_PATTERN,
	SHELL_WRAPPER_TEXT_PATTERN,
	SIMPLE_VARIABLE_PATTERN,
	WINDOWS_DETACH_PATTERN,
	WINDOWS_START_BACKGROUND_PATTERN,
	WINDOWS_WAIT_PATTERN,
} from "./regex.ts";
import { extractCommandSubstitutions, inspectHereDocuments, prepareShellAnalysis } from "./shell-substitution.ts";
import { parseTimeoutInvocation } from "./timeout-wrapper.ts";
import { bashArithmeticForHeader, bashLoopVariableIndex, bashPipelinePrefixEnd, bashScriptOperandIndex, unsafeBashForHeaderReason, hasStatefulBashPrintf, shellExpansionRisk, hasUnsafeBashTestOperand, hasUnsafeBashLoopListOperand, hasUnsafeCommandQueryOperand, isBashArithmeticCommandHead, isBashDoubleBracketCloseBoundary, isBashNetworkRedirectionTarget, isBashDoubleBracketHead, isBashProcessSubstitutionStart, isBashTestWhitespace, isShellDynamicDescriptor, isShellFileDescriptor, isShellOutputFileRedirection, isSimpleBashAnsiCQuote, isStaticDescriptorCopy, shellRedirectionLength, stripShellRedirections } from "./shell-redirection.ts";
import { FD_DUPLICATION_PATTERN } from "./regex.ts";
import { diagnosticForPrimitives, policyMetadata, renderPolicyDiagnostic, type PolicyDiagnosticMetadata } from "./policy-diagnostics.ts";

const MAX_INSPECTED_COMMAND_CHARS = 128 * 1024;
const BLOCK_REASON =
	"Blocked an unmanaged long-lived process before execution; this Bash call was not executed.\nRetry: keep setup and bounded use in one inspectable foreground call with a recorded PID, EXIT trap, kill and wait; resubmit for authorization.";
const MAX_MUTATION_PRIMITIVES = 16;
const MAX_MUTATION_TARGETS = 16;
const MAX_SCRIPT_SEGMENTS = 64;
const MAX_WRAPPER_DEPTH = 4;
const SCRIPT_WRAPPERS = new Set(["bash", "bash.exe", "sh", "sh.exe", "zsh", "zsh.exe", "dash", "dash.exe", "ksh", "ksh.exe", "fish", "fish.exe"]);
const POWERSHELL_WRAPPERS = new Set(["powershell", "powershell.exe", "pwsh", "pwsh.exe"]);
const NODE_COMMANDS = new Set(["node", "node.exe"]);
const PYTHON_COMMANDS = new Set(["python", "python.exe", "python3", "python3.exe", "py", "py.exe"]);
const RM_RECURSIVE_OPTIONS = new Set(["--recursive"]);
const POWERSHELL_RECURSIVE_OPTIONS = new Set(["-recurse", "-r"]);
const POWERSHELL_TARGET_OPTIONS = new Set(["-path", "-literalpath"]);
const WINDOWS_RMDIR_RECURSIVE_OPTIONS = new Set(["/s"]);
const GIT_CLEAN_FORCE_OPTIONS = new Set(["-f", "--force"]);
const GIT_CLEAN_DIRECTORY_OPTIONS = new Set(["-d"]);
const SHELL_SCRIPT_FLAGS = new Set(["-c"]);
const CMD_SCRIPT_FLAGS = new Set(["/c"]);
const POWERSHELL_SCRIPT_FLAGS = new Set(["-command", "-c"]);

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
const EMPTY_SUBSTITUTIONS: readonly string[] = [];
export const UNCERTAIN_LIFECYCLE = "[SHELL_UNINSPECTABLE] This Bash call was not executed: uncertain/uninspectable shell structure.\nRetry: use an inspectable foreground command and resubmit for authorization.";
function lifecycleRefusal(code: string, reason: string, recovery: string): string {
 return `[${code}] This Bash call was not executed: ${reason}.\nRetry: ${recovery}; resubmit for authorization.`;
}
function dynamicExecutable(token: string | undefined): string {
 // Echo only a simple variable name, never command substitutions or arbitrary operands.
 const variable = token && SIMPLE_VARIABLE_PATTERN.test(token) ? ` (${token})` : "";
 return lifecycleRefusal("SHELL_DYNAMIC_EXECUTABLE", `executable position uses a variable or dynamic expression${variable}`, "use the quoted literal executable path in a foreground command");
}

export function inspectBashResourceLifecycle(input: unknown, nativePowerShellAvailable = false): string | undefined {
 if (!input || typeof input !== "object") return undefined;
 const command = (input as { command?: unknown }).command;
 if (typeof command !== "string" || command.length === 0) return undefined;
 if (command.length > MAX_INSPECTED_COMMAND_CHARS) return lifecycleRefusal("SHELL_INSPECTION_LIMIT", "command exceeds the inspection size limit", "reduce this command's size");
 return inspectLifecycleScript(command, 0, nativePowerShellAvailable);
}

function inspectLifecycleScript(source: string, depth: number, nativePowerShellAvailable = false): string | undefined {
 if (depth > MAX_WRAPPER_DEPTH) return lifecycleRefusal("SHELL_INSPECTION_LIMIT", "wrapper/substitution nesting exceeds the inspection depth", "reduce nesting");
 const here = source.includes("<<") ? inspectHereDocuments(source) : undefined;
 if (here?.uncertain) return here.heredoc
  ? "[SHELL_HEREDOC] This Bash call was not executed: heredoc is uncertain/uninspectable.\n[Lifecycle recovery] Create/edit the diagnostic script natively with its own read/path permissions, then resubmit foreground execution for authorization."
  : lifecycleRefusal("SHELL_UNINSPECTABLE", "arithmetic structure could not be inspected", "correct or simplify the arithmetic expression");
 const command = here?.command ?? source;
 const substitutions = extractCommandSubstitutions(command);
 if (substitutions.unterminated || substitutions.unsupported) return lifecycleRefusal("SHELL_SUBSTITUTION", substitutions.unterminated ? "unterminated command substitution" : "uncertain/uninspectable command substitution grammar", "simplify the substitution into inspectable foreground commands");
 for (const script of here?.substitutions ?? EMPTY_SUBSTITUTIONS) { const result = inspectLifecycleScript(script, depth + 1, nativePowerShellAvailable); if (result) return result; }
 for (const script of substitutions.scripts) { const result = inspectLifecycleScript(script, depth + 1, nativePowerShellAvailable); if (result) return result; }
 if (hasAmbiguousBashCwd(command)) return lifecycleRefusal("SHELL_UNINSPECTABLE", "working directory, evaluator state, or reserved-prefix syntax cannot be established (conditional, grouped or indirect cd, source/eval, or an ambiguous prefix)", "submit an inspectable foreground command; when cwd changes, keep a supported bare cd and its dependent operation in one Bash call (for example, cd sub && ls); each new call receives fresh checks");
 if (DETACH_UTILITY_PATTERN.test(command)) return BLOCK_REASON;
 if ((WINDOWS_DETACH_PATTERN.test(command) || WINDOWS_START_BACKGROUND_PATTERN.test(command)) && !WINDOWS_WAIT_PATTERN.test(command)) return BLOCK_REASON;
 if (DOCKER_DETACHED_PATTERN.test(command) || SERVICE_START_PATTERN.test(command)) return BLOCK_REASON;
 if (hasUnquotedBackgroundOperator(command)) {
  const owned = OWNED_FOREGROUND_JOB_PATTERN.exec(command);
  if (!owned || !hasBoundedOwnedUse(owned[2]) || OPAQUE_JOB_LAUNCHER_PATTERN.test(commandName(owned[1]!)) || OPAQUE_JOB_INTERPRETER_PATTERN.test(commandName(owned[1]!))) return BLOCK_REASON;
 }
 if (!SHELL_WRAPPER_TEXT_PATTERN.test(command) && !EXECUTABLE_EXPANSION_TEXT_PATTERN.test(command) && !command.includes("[[") && !command.includes("((") && !command.includes("for") && !command.includes("select")) return undefined;
 const segments = parseShellSegments(command);
 if (segments.length > MAX_SCRIPT_SEGMENTS) return lifecycleRefusal("SHELL_INSPECTION_LIMIT", "too many command segments", "reduce the number of segments");
 const loopReason = unsafeBashLoopHeaders(segments);
 if (loopReason) return lifecycleRefusal("SHELL_UNINSPECTABLE", loopReason === "stateful_loop_list_expansion" ? "loop list expansion can change later shell state" : "loop variable can change later executable lookup", "use a literal list or simple variable reference without shell-state changes");
 for (const tokens of segments) {
  if (tokens.bashTestProcessSubstitution) return lifecycleRefusal("SHELL_UNINSPECTABLE", "process substitution inside a Bash test cannot be safely inspected", "split the process substitution into separately inspectable commands");
  if (hasUnsafeBashTestOperand(tokens)) return lifecycleRefusal("SHELL_UNINSPECTABLE", "Bash test operand may change shell state or evaluate arithmetic", "use simple variable tests or literal numeric comparisons");
  // Possible assignment through a referenced value is left to permission review.
  if (shellExpansionRisk(tokens) === 2) return lifecycleRefusal("SHELL_UNINSPECTABLE", "expansion assigns shell variables or runs code in the current shell", "use literal values or simple variable references");
  if (hasBareBashArithmeticCommand(tokens)) return lifecycleRefusal("SHELL_UNINSPECTABLE", "arithmetic command can change later shell state", "use an inspectable foreground command without a bare arithmetic command");
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
    if (uncertainAssignment(tokens, index, true)) return lifecycleRefusal("SHELL_UNINSPECTABLE", "uncertain assignment expansion or executable lookup", "use literal assignments that do not change executable lookup");
    changedLookup = true; index++; continue;
   }
   const redirection = LEADING_REDIRECTION_PATTERN.exec(token);
   if (redirection) {
    changedLookup = true; index++;
    if (!redirection[1]) { if (!tokens[index]) return UNCERTAIN_LIFECYCLE; index++; }
    continue;
   }
   const prefix = token === "command" || token === "exec" ? token : "";
   if (prefix !== "command" && prefix !== "exec") break;
   if (prefix === "command" && (tokens[index + 1] === "-v" || tokens[index + 1] === "-V")) {
    // Query operands are names to inspect, never executable positions. Nested
    // substitutions were inspected above before this branch.
    if (hasUnsafeCommandQueryOperand(tokens, index + 2)) return lifecycleRefusal("SHELL_UNINSPECTABLE", "command query operand has state-changing or uncertain expansion", "use literal names or simple variable references");
    index = tokens.length;
    break;
   }
   if (++index > MAX_WRAPPER_DEPTH || !tokens[index] || tokens[index]!.startsWith("-")) return lifecycleRefusal("SHELL_WRAPPER", "unsupported command/exec prefix depth or operand", "use a direct foreground executable");
  }
  if (index >= tokens.length) continue;
  if (tokens.bashTestOpenAt === index && tokens.bashTestClosed && tokens[index] === "[[") continue;
  if (REDIRECTION_OPERATOR_PATTERN.test(tokens[index] ?? "")) return UNCERTAIN_LIFECYCLE;
  if (tokens.expansions?.[index] || hasDynamicSyntax(tokens[index] ?? "")) return dynamicExecutable(tokens[index]);
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
     return renderPolicyDiagnostic({ code: "LAUNCHER_UNSUPPORTED", category: "SHELL_WRAPPER", launcher: name, nativeToolAvailable: nativePowerShellAvailable, retryable: false, action: "native_tool" });
    }
    return lifecycleRefusal("SHELL_WRAPPER", "launcher operand grammar is uncertain/uninspectable", "use a directly inspectable foreground executable");
   }
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
  if (name === "eval") for (let operand = index + 1; operand < tokens.length; operand++) {
   if (tokens[operand]!.includes("<<")) return lifecycleRefusal("SHELL_WRAPPER", "eval operand cannot be inspected as literal executable source", "use directly inspectable foreground commands");
  }
  if (!SCRIPT_WRAPPERS.has(name)) continue;
  const flag = index + 1;
  const scriptIndex = tokens[flag] === "-c" ? bashScriptOperandIndex(tokens, flag) : -1;
  if (scriptIndex < 0) return lifecycleRefusal("SHELL_WRAPPER", "shell wrapper requires a direct literal -c script operand", "use a supported direct -c operand");
  const result = inspectLifecycleScript(tokens[scriptIndex]!, depth + 1, nativePowerShellAvailable); if (result) return result;
 }
 return undefined;
}

export interface HighRiskMutationScan {
	risk: "HIGH";
	primitives: string[];
	targets: string[];
	dynamicScope: boolean;
	unverifiableScope: boolean;
	workspaceWide: boolean;
	diagnostic?: PolicyDiagnosticMetadata;
}

type ShellSegment = string[] & { dynamic?: boolean; expansions?: number[]; redirections?: number[]; redirectionFds?: (string | undefined)[]; subshellDepth?: number; pipelineMember?: boolean; conditionalMember?: boolean; separatorAfter?: string; firstWordQuoted?: boolean; secondWordQuoted?: boolean; thirdWordQuoted?: boolean; bashTestOpenAt?: number; bashTestClosed?: boolean; bashTestProcessSubstitution?: boolean; bashArithmeticCommandAt?: number };

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
	diagnostic?: PolicyDiagnosticMetadata;
}

export function inspectHighRiskBashMutation(input: unknown, cwd: string, shellOperation: "bash" | "powershell" = "bash"): HighRiskMutationScan | undefined {
	if (!input || typeof input !== "object") return undefined;
	const command = (input as { command?: unknown }).command;
	if (typeof command !== "string" || command.length === 0) return undefined;
	if (command.length > MAX_INSPECTED_COMMAND_CHARS) {
		return {
			risk: "HIGH",
			primitives: ["oversized_uninspectable"],
			targets: [],
			dynamicScope: true,
			unverifiableScope: true,
			workspaceWide: false,
			diagnostic: policyMetadata(diagnosticForPrimitives(["oversized_uninspectable"]), renderPolicyDiagnostic(diagnosticForPrimitives(["oversized_uninspectable"]))),
		};
	}

	const builder: ScanBuilder = {
		primitives: [],
		targets: [],
		targetSet: new Set(),
		dynamicScope: false,
		unverifiableScope: false,
		workspaceWide: false,
		segmentsVisited: 0,
	};
	inspectShellScript(command, resolve(cwd), 0, builder, shellOperation);
	if (builder.primitives.length === 0) return undefined;
	return {
		risk: "HIGH",
		primitives: builder.primitives,
		targets: builder.targets,
		dynamicScope: builder.dynamicScope,
		unverifiableScope: builder.unverifiableScope,
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
		if (descriptorFd && isShellDynamicDescriptor(descriptorFd)) {
			addPrimitive(builder, "unverifiable_redirection");
			markUnverifiable(builder);
			continue;
		}
		// Input redirections and heredocs remain with the existing lifecycle parser.
		// Numeric descriptor copies have no path target. Shell ordering is kept in
		// the source sent to Bash; only analysis tokens are compacted below.
		if (isStaticDescriptorCopy(operator, target, descriptorFd)) continue;
		if (operator === "<" && target && !hasDynamicSyntax(target) && !isBashNetworkRedirectionTarget(target)) continue;
		// Here-documents, descriptor moves/closures and dynamic copies stay opaque.
		if (!isShellOutputFileRedirection(operator)) {
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
		addPrimitive(builder, "output_redirection");
		if (!target || hasDynamicSyntax(target)) {
			markUnverifiable(builder);
			continue;
		}
		addTarget(builder, target, cwd);
	}
	stripShellRedirections(tokens, redirections);
}

function inspectShellScript(script: string, initialCwd: string, depth: number, builder: ScanBuilder, shellOperation: "bash" | "powershell"): void {
	if (depth > MAX_WRAPPER_DEPTH) {
		builder.dynamicScope = true;
		builder.unverifiableScope = true;
		return;
	}
	if (hasAmbiguousBashCwd(script)) {
		addPrimitive(builder, "unverifiable_working_directory");
		markUnverifiable(builder);
		return;
	}
	const analysis = prepareShellAnalysis(script);
	if (analysis.hasHeredoc) {
		addPrimitive(builder, "heredoc_uninspectable");
		markUnverifiable(builder);
	}
	if (analysis.uncertain) {
		addPrimitive(builder, "shell_context_uninspectable");
		markUnverifiable(builder);
	}
	for (const nested of analysis.substitutions) inspectShellScript(nested, initialCwd, depth + 1, builder, shellOperation);
	const substitutions = extractCommandSubstitutions(analysis.command);
	if (substitutions.unterminated) {
		addPrimitive(builder, "unterminated_command_substitution");
		markUnverifiable(builder);
	}
	if (substitutions.unsupported) markUnverifiable(builder);
	for (const nested of substitutions.scripts) inspectShellScript(nested, initialCwd, depth + 1, builder, shellOperation);
	const segments = parseShellSegments(analysis.command);
	const loopReason = unsafeBashLoopHeaders(segments);
	if (loopReason) { addPrimitive(builder, loopReason); markUnverifiable(builder); }
	let workingDirectory = initialCwd;
	for (const segment of segments) {
		builder.segmentsVisited++;
		if (builder.segmentsVisited > MAX_SCRIPT_SEGMENTS) {
			builder.dynamicScope = true;
			builder.unverifiableScope = true;
			return;
		}
		const tokens = segment;
		if (tokens.length === 0) continue;
		if (tokens.bashTestProcessSubstitution) { addPrimitive(builder, "unverifiable_process_substitution"); markUnverifiable(builder); continue; }
		if (hasUnsafeBashTestOperand(tokens)) { addPrimitive(builder, "unverifiable_bash_test_operand"); markUnverifiable(builder); }
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
	if (shellOperation === "bash" && command === "eval" && tokens[commandIndex] === "eval") {
		const sourceIndex = commandIndex + 1;
		if (depth >= MAX_WRAPPER_DEPTH || sourceIndex + 1 !== tokens.length || tokens.expansions?.[sourceIndex]) {
			addPrimitive(builder, "unverifiable_eval"); markUnverifiable(builder);
		} else inspectShellScript(tokens[sourceIndex]!, cwd, depth + 1, builder, "bash");
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
	if (NODE_COMMANDS.has(command)) {
		inspectCodeWrapper(tokens, commandIndex + 1, "node", cwd, builder);
		return;
	}
	if (PYTHON_COMMANDS.has(command)) {
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
	const masked = maskCodeStringsAndComments(source, language);
	if (language === "python") {
		inspectCodeCall(source, masked, PYTHON_RMTREE_PATTERN, "python_rmtree", cwd, builder);
		inspectCodeCall(source, masked, PYTHON_UNLINK_PATTERN, "python_unlink", cwd, builder);
		return;
	}
	inspectCodeCall(source, masked, NODE_RECURSIVE_RM_PATTERN, "node_recursive_rm", cwd, builder);
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
	const match = pattern.exec(masked);
	if (!match) return;
	addPrimitive(builder, primitive);
	const open = source.indexOf("(", match.index);
	const literal = open >= 0 ? literalFirstArgument(source, open) : undefined;
	if (literal === undefined) {
		builder.dynamicScope = true;
		builder.unverifiableScope = true;
		return;
	}
	addTarget(builder, literal, cwd);
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
	addPrimitive(builder, "rm_recursive");
	collectPositionalTargets(tokens, start, cwd, builder, "dash");
}

function inspectPowerShellRemove(tokens: readonly string[], start: number, cwd: string, builder: ScanBuilder): void {
	let recursive = false;
	for (let index = start; index < tokens.length; index++) {
		if (POWERSHELL_RECURSIVE_OPTIONS.has(tokens[index]!.toLowerCase())) recursive = true;
	}
	if (!recursive) return;
	addPrimitive(builder, "powershell_remove_recursive");
	let explicitTarget = false;
	for (let index = start; index < tokens.length; index++) {
		const value = tokens[index]!;
		const lower = value.toLowerCase();
		if (POWERSHELL_TARGET_OPTIONS.has(lower)) {
			const target = tokens[++index];
			if (target) {
				addTarget(builder, target, cwd);
				explicitTarget = true;
			}
			continue;
		}
		if (!value.startsWith("-")) {
			addTarget(builder, value, cwd);
			explicitTarget = true;
		}
	}
	if (!explicitTarget) markUnverifiable(builder);
}

function inspectWindowsRmdir(tokens: readonly string[], start: number, cwd: string, builder: ScanBuilder): void {
	let recursive = false;
	for (let index = start; index < tokens.length; index++) {
		if (WINDOWS_RMDIR_RECURSIVE_OPTIONS.has(tokens[index]!.toLowerCase())) recursive = true;
	}
	if (!recursive) return;
	addPrimitive(builder, "windows_rmdir_recursive");
	let found = false;
	for (let index = start; index < tokens.length; index++) {
		const value = tokens[index]!;
		if (value.startsWith("/")) continue;
		addTarget(builder, value, cwd);
		found = true;
	}
	if (!found) markUnverifiable(builder);
}

function inspectFind(tokens: readonly string[], start: number, cwd: string, builder: ScanBuilder): void {
	let deleteAction = false;
	let execAction = false;
	for (let index = start; index < tokens.length; index++) {
		const value = tokens[index]!;
		if (value === "-delete") deleteAction = true;
		else if (value === "-exec" || value === "-execdir") execAction = true;
	}
	if (!deleteAction && !execAction) return;
	addPrimitive(builder, deleteAction ? "find_delete" : "find_exec");
	if (execAction) markUnverifiable(builder);
	const target = findSearchRoot(tokens, start);
	if (target) addTarget(builder, target, cwd);
	else markUnverifiable(builder);
}

function findSearchRoot(tokens: readonly string[], start: number): string | undefined {
	for (let index = start; index < tokens.length; index++) {
		const value = tokens[index]!;
		if (value === "--") return tokens[index + 1] && !tokens[index + 1]!.startsWith("-") ? tokens[index + 1] : undefined;
		if (value === "-H" || value === "-L" || value === "-P") continue;
		if (value.startsWith("-")) return undefined;
		return value;
	}
	return undefined;
}

function inspectXargs(tokens: readonly string[], start: number, builder: ScanBuilder): void {
	for (let index = start; index < tokens.length; index++) {
		if (commandName(tokens[index]!) !== "rm") continue;
		addPrimitive(builder, "xargs_rm");
		markUnverifiable(builder);
		return;
	}
}

function inspectGit(tokens: readonly string[], start: number, builder: ScanBuilder): void {
	const subcommand = tokens[start]?.toLowerCase();
	if (subcommand === "reset") {
		for (let index = start + 1; index < tokens.length; index++) {
			if (tokens[index]!.toLowerCase() !== "--hard") continue;
			addPrimitive(builder, "git_reset_hard");
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
	addPrimitive(builder, "git_clean");
	builder.workspaceWide = true;
}

function collectPositionalTargets(
	tokens: readonly string[],
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
		addTarget(builder, value, cwd);
		found = true;
	}
	if (!found) markUnverifiable(builder);
}

function addTarget(builder: ScanBuilder, rawTarget: string, cwd: string): void {
	if (hasDynamicSyntax(rawTarget)) {
		builder.dynamicScope = true;
		const prefix = staticTargetPrefix(rawTarget);
		if (!prefix) {
			builder.unverifiableScope = true;
			return;
		}
		addResolvedTarget(builder, resolve(cwd, prefix));
		return;
	}
	addResolvedTarget(builder, resolve(cwd, rawTarget));
}

function addResolvedTarget(builder: ScanBuilder, target: string): void {
	if (builder.targetSet.has(target)) return;
	if (builder.targets.length >= MAX_MUTATION_TARGETS) {
		markUnverifiable(builder);
		return;
	}
	builder.targetSet.add(target);
	builder.targets.push(target);
}

function addPrimitive(builder: ScanBuilder, primitive: string): void {
	for (const existing of builder.primitives) {
		if (existing === primitive) return;
	}
	if (builder.primitives.length >= MAX_MUTATION_PRIMITIVES) {
		markUnverifiable(builder);
		return;
	}
	builder.primitives.push(primitive);
}

function markUnverifiable(builder: ScanBuilder): void {
	builder.dynamicScope = true;
	builder.unverifiableScope = true;
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

/** A local/conditional cd cannot establish one reliable cwd for later targets. */
export function hasAmbiguousBashCwd(command: string): boolean {
	const segments = parseShellSegments(command);
	let loopDepth = 0;
	let conditionalDepth = 0;
	let braceDepth = 0;
	let cdSemanticsChanged = false;
	let exitRedefined = false;
	for (let segmentIndex = 0; segmentIndex < segments.length; segmentIndex++) {
		const tokens = segments[segmentIndex]!;
		const controlIndex = skipBashReservedPrefixes(tokens, 0);
		if (controlIndex < 0) return true;
		const first = tokens[controlIndex];
		if (first === "done" && loopDepth > 0) loopDepth--;
		if ((first === "fi" || first === "esac") && conditionalDepth > 0) conditionalDepth--;
		if (first === "}" && braceDepth > 0) braceDepth--;
		if (first === "for" || first === "while" || first === "until" || first === "select") loopDepth++;
		if (first === "if" || first === "case") conditionalDepth++;
		if (first === "{") braceDepth++;
		const simpleSegment = loopDepth === 0 && conditionalDepth === 0 && braceDepth === 0
			&& !tokens.subshellDepth && !tokens.pipelineMember && !tokens.conditionalMember && controlIndex === 0;
		let index = commandTokenIndex(tokens);
		if (index < 0) continue;
		// A launcher such as `env` or `sudo` runs an external program, never a shell builtin.
		const launched = index > 0;
		if (index === 0 && !tokens.firstWordQuoted && (tokens[index] === "do" || tokens[index] === "{" || tokens[index] === "then" || tokens[index] === "else"
			|| tokens[index] === "if" || tokens[index] === "elif" || tokens[index] === "while" || tokens[index] === "until")) index++;
		index = skipBashReservedPrefixes(tokens, index);
		if (index < 0) return true;
		let builtinPrefixes = 0;
		let leadingAssignment = false;
		let cdpathAssignment = false;
		while (index < tokens.length) {
			const after = afterLeadingRedirection(tokens, index);
			if (after !== index) { index = after; continue; }
			if (LEADING_ASSIGNMENT_PATTERN.test(tokens[index]!)) {
				leadingAssignment = true;
				if (tokens[index]!.startsWith("CDPATH=") || tokens[index]!.startsWith("CDPATH+=")) cdpathAssignment = true;
				index++; continue;
			}
			// `command command cd`, `command -p cd` and `builtin -- cd` still dispatch to cd.
			if (tokens[index] === "command" || tokens[index] === "builtin") {
				if (++builtinPrefixes > MAX_WRAPPER_DEPTH) return true;
				index++;
				while (tokens[index] === "-p" || tokens[index] === "--") index++;
				continue;
			}
			break;
		}
		// An assignment-only simple command persists in the parent shell; a prefix
		// assignment before an executable is not evidence of the later shell cwd.
		if (index >= tokens.length) {
			if (cdpathAssignment && !tokens.subshellDepth && !tokens.pipelineMember) cdSemanticsChanged = true;
			continue;
		}
		// Builtins are exact bare words: `./cd`, `/opt/cd` and `CD` are external executables.
		const name = launched ? "" : tokens[index] ?? "";
		// These builtins persist an assignment in the parent shell even though the
		// assignment word follows the command name rather than preceding it.
		if (!tokens.subshellDepth && !tokens.pipelineMember && (name === "export" || name === "declare" || name === "typeset" || name === "readonly")) {
			for (let operand = index + 1; operand < tokens.length; operand++) {
				const after = afterLeadingRedirection(tokens, operand);
				if (after !== operand) { operand = after - 1; continue; }
				if (tokens[operand]!.startsWith("CDPATH=") || tokens[operand]!.startsWith("CDPATH+=")) { cdSemanticsChanged = true; break; }
			}
		}
		// The scans track only a direct literal `cd`; directory stacks are not followed.
		if (name === "pushd" || name === "popd") return true;
		if (changesBashCdSemantics(tokens, index, name)) { cdSemanticsChanged = true; continue; }
		// A sourced file or evaluated source runs in this shell. Without bounded
		// state propagation, a later command could use a different cwd or lookup.
		if ((name === "source" || name === "." || name === "eval") && segmentIndex + 1 < segments.length
			&& !(name === "eval" && index + 2 === tokens.length && !tokens.expansions?.[index + 1]
				&& (tokens[index + 1] === "false" || tokens[index + 1] === "true" || tokens[index + 1] === ":"))) return true;
		if (name === "function" ? tokens[index + 1] === "exit" : name === "exit" && tokens.separatorAfter === "(") exitRedefined = true;
		if (name === "cd") {
			// Redirections may surround the operand; Bash rejects a second operand
			// (`cd: too many arguments`) and stays in the original directory.
			const operandIndex = skipRedirections(tokens, index + 1);
			const target = tokens[operandIndex];
			if (leadingAssignment || builtinPrefixes > 0 || cdSemanticsChanged
				|| !target || target.startsWith("-") || hasDynamicSyntax(target)
				|| skipRedirections(tokens, operandIndex + 1) < tokens.length) return true;
			// cd itself can fail even when its redirections succeed. An independent
			// later target must therefore be read-only or gated on successful cd.
			if (target !== "." && hasLaterBashCommandSubstitution(segments, segmentIndex)) return true;
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
			if (controlIndex > 0) return true;
			// The RHS of `cd path && ...` only runs after a successful cd. A later
			// independent command is safe only when its effects are provably read-only.
			if (!skippedByOr && !tokens.subshellDepth && !tokens.pipelineMember && tokens.separatorAfter === "&&"
				&& hasOnlyReadOnlyConditionalTail(segments, segmentIndex)) continue;
			return true;
		}
	}
	return false;
}

/**
 * Builtin toggles, a `cd` function, cdable_vars/expand_aliases and physical
 * mode make a later literal `cd` resolve differently from the scanned path.
 */
function changesBashCdSemantics(tokens: ShellSegment, index: number, name: string): boolean {
	if (name === "enable") return true;
	if (name === "function") return tokens[index + 1] === "cd";
	if (name !== "shopt" && name !== "set") return false;
	for (let cursor = index + 1; cursor < tokens.length; cursor++) {
		const word = tokens[cursor]!;
		if (tokens.expansions?.[cursor]) return true;
		if (name === "shopt" ? word === "cdable_vars" || word === "expand_aliases"
			: word === "physical" || (word.length > 1 && (word[0] === "-" || word[0] === "+") && word[1] !== "-" && word.includes("P"))) return true;
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
	if (command !== "find") return false;
	if (argv[index + 1] !== ".") return false;
	for (let cursor = index + 2; cursor < argv.length; cursor += 2) {
		const option = argv[cursor];
		const operand = argv[cursor + 1];
		if (option === "-maxdepth" && operand && NONNEGATIVE_INTEGER_PATTERN.test(operand)) continue;
		if (option === "-type" && (operand === "d" || operand === "f")) continue;
		if ((option === "-iname" || option === "-name") && operand) continue;
		return false;
	}
	return true;
}

function parseShellSegments(command: string): ShellSegment[] {
	const segments: ShellSegment[] = [];
	let tokens: ShellSegment = [];
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
		// Launcher assignment operands are ordinary argv words: unquoted braces
		// can expand one apparent assignment into additional executable operands.
		if (quote === 0 && (code === 123 || code === 125)) {
			const expansions = tokens.expansions ??= [];
			expansions[tokens.length] = (expansions[tokens.length] ?? 0) | 8;
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
			else if (code === 41 && subshellDepth > 0) subshellDepth--;
			tokens = [];
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

function commandTokenIndex(tokens: readonly string[]): number {
	let index = 0;
	let wrapperDepth = 0;
	while (index < tokens.length) {
		const name = commandName(tokens[index] ?? "");
		if (++wrapperDepth > MAX_WRAPPER_DEPTH) return -1;
		if (name === "sudo" || name === "doas") {
			index++;
			while (index < tokens.length && tokens[index]!.startsWith("-")) index++;
			continue;
		}
		if (name === "env") {
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
			if (!parsed.supported) return -1;
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

function staticTargetPrefix(target: string): string | undefined {
	let end = target.length;
	for (let index = 0; index < target.length; index++) {
		const code = target.charCodeAt(index);
		if (code === 36 || code === 37 || code === 42 || code === 63 || code === 91 || code === 123) {
			end = index;
			break;
		}
	}
	while (end > 0) {
		const code = target.charCodeAt(end - 1);
		if (code !== 47 && code !== 92) break;
		end--;
	}
	return end > 0 ? target.slice(0, end) : undefined;
}

function maskCodeStringsAndComments(source: string, language: "node" | "python"): string {
	const output = new Array<string>(source.length);
	let quote = 0;
	let triple = false;
	let lineComment = false;
	let blockComment = false;
	let escaped = false;
	for (let index = 0; index < source.length; index++) {
		const code = source.charCodeAt(index);
		const next = source.charCodeAt(index + 1);
		if (lineComment) {
			output[index] = code === 10 || code === 13 ? source[index]! : " ";
			if (code === 10 || code === 13) lineComment = false;
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
			output[index] = " ";
			output[index + 1] = " ";
			index++;
			lineComment = true;
			continue;
		}
		if (language === "node" && code === 47 && next === 42) {
			output[index] = " ";
			output[index + 1] = " ";
			index++;
			blockComment = true;
			continue;
		}
		if (language === "python" && code === 35) {
			output[index] = " ";
			lineComment = true;
			continue;
		}
		if (code === 34 || code === 39 || (language === "node" && code === 96)) {
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
		output[index] = source[index]!;
	}
	return output.join("");
}

function literalFirstArgument(source: string, openParen: number): string | undefined {
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
			escaped = true;
			continue;
		}
		if (code === quote) return value;
		value += source[index];
	}
	return undefined;
}
