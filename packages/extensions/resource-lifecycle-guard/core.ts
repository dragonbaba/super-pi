import { basename, resolve } from "node:path";
import {
	DETACH_UTILITY_PATTERN,
	DOCKER_CLEANUP_PATTERN,
	DOCKER_DETACHED_PATTERN,
	EXIT_TRAP_PATTERN,
	NODE_RECURSIVE_RM_PATTERN,
	NODE_UNLINK_PATTERN,
	POWERSHELL_REMOVE_RECURSIVE_PATTERN,
	PROCESS_CLEANUP_PATTERN,
	PYTHON_RMTREE_PATTERN,
	PYTHON_UNLINK_PATTERN,
	SERVICE_CLEANUP_PATTERN,
	SERVICE_START_PATTERN,
	SHELL_WAIT_PATTERN,
	WINDOWS_DETACH_PATTERN,
	WINDOWS_START_BACKGROUND_PATTERN,
	WINDOWS_WAIT_PATTERN,
} from "./regex.ts";
import { extractCommandSubstitutions } from "./shell-substitution.ts";

const MAX_INSPECTED_COMMAND_CHARS = 128 * 1024;
const BLOCK_REASON =
	"Blocked an unmanaged long-lived process. Keep setup, use, and cleanup in one foreground bash call (record the PID, install an EXIT trap, then kill and wait), or use a Pi-managed browser tool. Detached services must not survive into the final report.";
const MAX_MUTATION_PRIMITIVES = 16;
const MAX_MUTATION_TARGETS = 16;
const MAX_SCRIPT_SEGMENTS = 64;
const MAX_WRAPPER_DEPTH = 4;
const SCRIPT_WRAPPERS = new Set(["bash", "bash.exe", "sh", "zsh"]);
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
	const substitutions = extractCommandSubstitutions(command);
	if (substitutions.unterminated) return true;
	for (const script of substitutions.scripts) {
		if (hasUnquotedBackgroundOperator(script)) return true;
	}
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

function hasShellOwnedCleanup(command: string): boolean {
	if (SHELL_WAIT_PATTERN.test(command)) return true;
	return EXIT_TRAP_PATTERN.test(command) && PROCESS_CLEANUP_PATTERN.test(command);
}

export function inspectBashResourceLifecycle(input: unknown): string | undefined {
	if (!input || typeof input !== "object") return undefined;
	const command = (input as { command?: unknown }).command;
	if (typeof command !== "string" || command.length === 0) return undefined;
	if (command.length > MAX_INSPECTED_COMMAND_CHARS) {
		return "Blocked an oversized bash command because its process lifecycle cannot be audited safely.";
	}

	if (DETACH_UTILITY_PATTERN.test(command)) return BLOCK_REASON;
	if (
		(WINDOWS_DETACH_PATTERN.test(command) || WINDOWS_START_BACKGROUND_PATTERN.test(command)) &&
		!WINDOWS_WAIT_PATTERN.test(command)
	) return BLOCK_REASON;
	if (DOCKER_DETACHED_PATTERN.test(command) && !DOCKER_CLEANUP_PATTERN.test(command)) return BLOCK_REASON;
	if (SERVICE_START_PATTERN.test(command) && !SERVICE_CLEANUP_PATTERN.test(command)) return BLOCK_REASON;
	if (hasUnquotedBackgroundOperator(command) && !hasShellOwnedCleanup(command)) return BLOCK_REASON;
	return undefined;
}

export interface HighRiskMutationScan {
	risk: "HIGH";
	primitives: string[];
	targets: string[];
	dynamicScope: boolean;
	unverifiableScope: boolean;
	workspaceWide: boolean;
}

type ShellSegment = string[];

interface ScanBuilder {
	primitives: string[];
	targets: string[];
	targetSet: Set<string>;
	dynamicScope: boolean;
	unverifiableScope: boolean;
	workspaceWide: boolean;
	segmentsVisited: number;
}

export function inspectHighRiskBashMutation(input: unknown, cwd: string): HighRiskMutationScan | undefined {
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
	inspectShellScript(command, resolve(cwd), 0, builder);
	if (builder.primitives.length === 0) return undefined;
	return {
		risk: "HIGH",
		primitives: builder.primitives,
		targets: builder.targets,
		dynamicScope: builder.dynamicScope,
		unverifiableScope: builder.unverifiableScope,
		workspaceWide: builder.workspaceWide,
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

function inspectShellScript(script: string, initialCwd: string, depth: number, builder: ScanBuilder): void {
	if (depth > MAX_WRAPPER_DEPTH) {
		builder.dynamicScope = true;
		builder.unverifiableScope = true;
		return;
	}
	const substitutions = extractCommandSubstitutions(script);
	if (substitutions.unterminated) {
		addPrimitive(builder, "unterminated_command_substitution");
		markUnverifiable(builder);
	}
	for (const nested of substitutions.scripts) inspectShellScript(nested, initialCwd, depth + 1, builder);
	const segments = parseShellSegments(script);
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
		const commandIndex = commandTokenIndex(tokens);
		if (commandIndex < 0 || commandIndex >= tokens.length) continue;
		const command = commandName(tokens[commandIndex]!);
		if (command === "cd") {
			const target = tokens[commandIndex + 1];
			if (!target || hasDynamicSyntax(target)) {
				builder.dynamicScope = true;
				builder.unverifiableScope = true;
			} else {
				workingDirectory = resolve(workingDirectory, target);
			}
			continue;
		}
		inspectCommand(tokens, commandIndex, command, workingDirectory, depth, builder);
	}
}

function inspectCommand(
	tokens: readonly string[],
	commandIndex: number,
	command: string,
	cwd: string,
	depth: number,
	builder: ScanBuilder,
): void {
	if (SCRIPT_WRAPPERS.has(command)) {
		inspectScriptWrapper(tokens, commandIndex + 1, SHELL_SCRIPT_FLAGS, cwd, depth, builder);
		return;
	}
	if (command === "cmd" || command === "cmd.exe") {
		inspectScriptWrapper(tokens, commandIndex + 1, CMD_SCRIPT_FLAGS, cwd, depth, builder);
		return;
	}
	if (POWERSHELL_WRAPPERS.has(command)) {
		inspectScriptWrapper(tokens, commandIndex + 1, POWERSHELL_SCRIPT_FLAGS, cwd, depth, builder);
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
): void {
	for (let index = start; index < tokens.length; index++) {
		if (!flags.has(tokens[index]!.toLowerCase())) continue;
		const script = tokens[index + 1];
		if (!script) {
			builder.dynamicScope = true;
			builder.unverifiableScope = true;
			return;
		}
		inspectShellScript(script, cwd, depth + 1, builder);
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
	let target: string | undefined;
	for (let index = start; index < tokens.length; index++) {
		const value = tokens[index]!;
		if (value === "-delete") deleteAction = true;
		else if (!target && !value.startsWith("-")) target = value;
	}
	if (!deleteAction) return;
	addPrimitive(builder, "find_delete");
	if (target) addTarget(builder, target, cwd);
	else markUnverifiable(builder);
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

function parseShellSegments(command: string): ShellSegment[] {
	const segments: ShellSegment[] = [];
	let tokens: string[] = [];
	let value = "";
	let tokenStarted = false;
	let quote = 0;
	let escaped = false;

	for (let index = 0; index < command.length; index++) {
		const code = command.charCodeAt(index);
		if (escaped) {
			value += command[index];
			tokenStarted = true;
			escaped = false;
			continue;
		}
		if (code === 92 && quote !== 39) {
			escaped = true;
			tokenStarted = true;
			continue;
		}
		if (quote !== 0) {
			if (code === quote) quote = 0;
			else value += command[index];
			continue;
		}
		if (code === 34 || code === 39) {
			quote = code;
			tokenStarted = true;
			continue;
		}
		if (code === 32 || code === 9) {
			if (tokenStarted) {
				tokens.push(value);
				value = "";
				tokenStarted = false;
			}
			continue;
		}
		if (code === 10 || code === 13 || code === 59 || code === 38 || code === 124 || code === 40 || code === 41) {
			if (tokenStarted) tokens.push(value);
			if (tokens.length > 0) segments.push(tokens);
			tokens = [];
			value = "";
			tokenStarted = false;
			if ((code === 38 || code === 124) && command.charCodeAt(index + 1) === code) index++;
			continue;
		}
		value += command[index];
		tokenStarted = true;
	}
	if (tokenStarted) tokens.push(value);
	if (tokens.length > 0) segments.push(tokens);
	return segments;
}

function commandTokenIndex(tokens: readonly string[]): number {
	let index = 0;
	if (commandName(tokens[index] ?? "") === "sudo") {
		index++;
		while (index < tokens.length && tokens[index]!.startsWith("-")) index++;
	}
	if (commandName(tokens[index] ?? "") === "env") {
		index++;
		while (index < tokens.length) {
			const value = tokens[index]!;
			if (value.startsWith("-") || value.includes("=")) index++;
			else break;
		}
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
		if (code === 36 || code === 37 || code === 42 || code === 63 || code === 91 || code === 93 || code === 123 || code === 125) return true;
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
