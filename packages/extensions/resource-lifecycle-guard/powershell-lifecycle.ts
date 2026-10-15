import { inspectBashResourceLifecycle } from "./core.ts";

const MAX_CHARS = 128 * 1024;
const MAX_TOKENS = 2048;
const MAX_NESTING = 64;
const BASH = new Set(["bash", "sh", "zsh", "dash", "ksh", "fish"]);
const DETACHED = new Set(["start-job", "sajb", "start-threadjob", "start-service", "sasv", "restart-service", "resume-service", "rsv", "start-scheduledtask", "register-scheduledjob", "set-scheduledjob", "register-scheduledtask", "set-scheduledtask", "nohup", "disown", "setsid", "daemonize", "invoke-item", "ii"]);
const EXTERNAL_DETACHED = new Set(["nohup", "disown", "setsid", "daemonize"]);
const PROCESS = new Set(["start-process", "start", "saps"]);
const SERVICE_STARTERS = new Set(["start-service", "sasv", "restart-service", "resume-service", "rsv"]);
const CONTROL_BLOCK = new Set(["if", "elseif", "else", "for", "foreach", "while", "do", "switch", "try", "catch", "finally", "trap", "begin", "process", "end", "clean", "dynamicparam", "data", "function", "filter", "class", "enum", "workflow", "configuration", "parallel", "sequence", "inlinescript"]);
const VARIABLE_LOOKUP_PARAMETERS = ["name", "valueonly", "include", "exclude", "scope", "verbose", "debug", "erroraction", "warningaction", "informationaction", "progressaction", "errorvariable", "warningvariable", "informationvariable", "outvariable", "outbuffer", "pipelinevariable"];
const VARIABLE_LOOKUP_ALIASES = new Map([["vb", "verbose"], ["db", "debug"], ["ea", "erroraction"], ["wa", "warningaction"], ["infa", "informationaction"], ["proga", "progressaction"], ["ev", "errorvariable"], ["wv", "warningvariable"], ["iv", "informationvariable"], ["ov", "outvariable"], ["ob", "outbuffer"], ["pv", "pipelinevariable"]]);
const FOR_EACH = new Set(["foreach-object", "foreach", "%"]);
const FOR_EACH_PARAMETERS = ["inputobject", "begin", "process", "end", "remainingscripts", "membername", "argumentlist", "parallel", "throttlelimit", "timeoutseconds", "asjob", "usenewrunspace", "whatif", "confirm", ...VARIABLE_LOOKUP_PARAMETERS.slice(5)];
const PROCESS_PARAMETERS = ["filepath", "argumentlist", "credential", "workingdirectory", "loaduserprofile", "nonewwindow", "passthru", "redirectstandarderror", "redirectstandardinput", "redirectstandardoutput", "verb", "windowstyle", "wait", "usenewenvironment", "environment", "whatif", "confirm", ...VARIABLE_LOOKUP_PARAMETERS.slice(5)];
const BITS_START_PARAMETERS = ["asynchronous", "dynamic", "customheaderswriteonly", "authentication", "credential", "description", "httpmethod", "destination", "displayname", "priority", "transferpolicy", "aclflags", "securityflags", "usestoredcredential", "proxyauthentication", "proxybypass", "proxycredential", "proxylist", "proxyusage", "retryinterval", "retrytimeout", "maxdownloadtime", "source", "suspended", "transfertype", "customheaders", "notifyflags", "notifycmdline", "certstorelocation", "certstorename", "certhash", "whatif", "confirm", ...VARIABLE_LOOKUP_PARAMETERS.slice(5)];
const BITS_RESUME_PARAMETERS = ["bitsjob", "asynchronous", "whatif", "confirm", ...VARIABLE_LOOKUP_PARAMETERS.slice(5)];
const SERVICE_START_PARAMETERS = ["name", "inputobject", "passthru", "displayname", "include", "exclude", "force", "whatif", "confirm", ...VARIABLE_LOOKUP_PARAMETERS.slice(5)];
const SERVICE_SET_PARAMETERS = ["name", "inputobject", "displayname", "credential", "description", "startuptype", "securitydescriptorsddl", "status", "force", "passthru", "computername", "whatif", "confirm", ...VARIABLE_LOOKUP_PARAMETERS.slice(5)];
const ITEM_PARAMETERS = ["path", "literalpath", "filter", "include", "exclude", "credential", "whatif", "confirm", ...VARIABLE_LOOKUP_PARAMETERS.slice(5)];
const WMI_JOB_COMMANDS = new Set(["get-wmiobject", "gwmi", "remove-wmiobject", "rwmi", "set-wmiinstance", "swmi", "invoke-wmimethod", "iwmi"]);
const REMOTE_COMMANDS = new Set(["invoke-command", "icm"]);
const COMPUTER_JOB_COMMANDS = new Set(["restart-computer", "stop-computer", "test-connection"]);
// Native metadata: these are the names competing with the AsJob prefix. Other
// parameters do not affect its binding and retain ordinary argument inspection.
const WMI_JOB_PARAMETERS = ["asjob", "authentication", "authority", "arguments"];
const COMPUTER_JOB_PARAMETERS = ["asjob"];
const REMOTE_JOB_PARAMETERS = ["asjob", "applicationname", "allowredirection", "authentication", "argumentlist", "indisconnectedsession", "disconnected", "inputobject", ...VARIABLE_LOOKUP_PARAMETERS.slice(5)];
const SYSTEMCTL_START = new Set(["start", "restart", "reload-or-restart", "isolate"]);
const SYSTEMCTL_FLAGS = new Set(["--user", "--system", "--global", "--no-block", "--no-legend", "--no-pager", "--no-ask-password", "--quiet", "-q", "--all", "-a", "--full", "-l", "--force", "-f", "--runtime", "--wait", "--no-wall"]);
const SYSTEMCTL_VALUES = new Set(["--host", "-H", "--machine", "-M", "--type", "-t", "--state", "--property", "-p", "--output", "-o", "--root", "--image", "--job-mode", "--lines", "-n", "--kill-whom", "--kill-who", "--signal", "-s", "--preset-mode"]);
const CMD_OPTIONS = /^\/(?:d|s|q|a|u|[efv]:(?:on|off)|t:[\da-f]{2})$/i;
const CMD_START_FLAGS = new Set(["/i", "/min", "/max", "/separate", "/shared", "/low", "/normal", "/high", "/realtime", "/abovenormal", "/belownormal", "/b"]);
const CMD_START_VALUES = new Set(["/d", "/node", "/affinity", "/machine"]);
const SPACE = /\s/;
const PUNCTUATION = /[;|\n\r{}()=&]/;
// PowerShell accepts unambiguous parameter prefixes and these Unicode dashes.
const PARAMETER_DASH = /^[-\u2013\u2014\u2015]/;
const TYPE_CHARACTER = /[\w.,+]/;
const STATEMENT_LABEL = /^:[\w]+$/;
const SIMPLE_VARIABLE = /^\$(?:[\p{L}\p{Nd}_?:]+|\{(?:[^`{}]|`[\s\S])+\})(?:\.[\p{L}\p{Nd}_]+|\[[\p{L}\p{Nd}_$?]+\])*$/u;
const STREAM_REDIRECT = /^[1-6*]?>$/;
const STREAM_NUMBER = /^[1-6]$/;
const FILE_REDIRECT = /^[1-6*]?>>?$/;

interface Token { value: string; quoted: boolean; quotedEnd: number; dynamic: boolean; operator: boolean; typeOnly: boolean; start: number; end: number }

function quoteKind(value: string | undefined): number {
	return value === "'" || value === "‘" || value === "’" ? 1 : value === '"' || value === "“" || value === "”" ? 2 : 0;
}

/** Skip opaque data only, preserving the following statement boundary. */
function hereStringEnd(source: string, start: number): number {
	const quote = quoteKind(source[start + 1]);
	let i = start + 2;
	while (source[i] === " " || source[i] === "\t" || source[i] === "\r") i++;
	if (source[i] !== "\n") return -1;
	for (; i < source.length; i++) if (source[i] === "\n" && quoteKind(source[i + 1]) === quote && source[i + 2] === "@") return i + 3;
	return -1;
}

function quotedStringEnd(source: string, start: number, depth: number): number {
	if (depth > MAX_NESTING) return -1;
	const quote = quoteKind(source[start]);
	for (let i = start + 1; i < source.length;) {
		const c = source[i++];
		if (quoteKind(c) === quote) {
			if (quoteKind(source[i]) === quote) { i++; continue; }
			return i;
		}
		if (quote === 2 && c === "`") i++;
		else if (quote === 2 && c === "$" && source[i] === "(") {
			i = parenthesisEnd(source, i, depth + 1);
			if (i < 0) return -1;
		}
	}
	return -1;
}

function parenthesisEnd(source: string, start: number, depth: number): number {
	let nesting = 1;
	for (let i = start + 1; i < source.length;) {
		if (depth + nesting > MAX_NESTING) return -1;
		const c = source[i++];
		if (c === "`") { i++; continue; }
		if (c === "#" && (SPACE.test(source[i - 2]!) || PUNCTUATION.test(source[i - 2]!))) { while (i < source.length && source[i] !== "\n") i++; continue; }
		if (c === "<" && source[i] === "#") {
			const end = source.indexOf("#>", i + 1);
			if (end < 0) return -1;
			i = end + 2; continue;
		}
		if (c === "@" && quoteKind(source[i])) i = hereStringEnd(source, i - 1);
		else if (quoteKind(c)) i = quotedStringEnd(source, i - 1, depth + nesting);
		else if (c === "(") nesting++;
		else if (c === ")" && !--nesting) return i;
		if (i < 0) return -1;
	}
	return -1;
}

/** Locate the attribute boundary; its argument/script tokens are still inspected. */
function attributeEnd(source: string, start: number): number {
	let i = skipTypeTrivia(source, start + 1);
	if (i < 0) return -1;
	const name = i;
	while (i < source.length && TYPE_CHARACTER.test(source[i]!)) i++;
	if (i === name) return -1;
	i = skipTypeTrivia(source, i);
	if (i < 0 || source[i] !== "(") return -1;
	i = parenthesisEnd(source, i, 0);
	if (i < 0) return -1;
	i = skipTypeTrivia(source, i);
	return i >= 0 && source[i] === "]" ? i + 1 : -1;
}

/** Type trivia is syntax, not part of its identity. Never consume executable text. */
function skipTypeTrivia(source: string, start: number): number {
	let i = start;
	while (i < source.length) {
		if (SPACE.test(source[i]!)) { i++; continue; }
		if (!source.startsWith("<#", i)) break;
		const end = source.indexOf("#>", i + 2);
		if (end < 0) return -1;
		i = end + 2;
	}
	return i;
}

function readType(source: string, start: number): { value: string; end: number } | undefined {
	let i = start, depth = 0, named = false, value = "", span = start;
	while (i < source.length) {
		const end = skipTypeTrivia(source, i);
		if (end < 0) return undefined;
		if (end !== i) { value += source.slice(span, i); i = end; span = i; }
		const c = source[i++];
		if (c === "[") { if (++depth > MAX_NESTING) return undefined; }
		else if (c === "]") { if (!--depth) return named ? { value: value + source.slice(span, i), end: i } : undefined; }
		else if (!c || !TYPE_CHARACTER.test(c)) return undefined;
		else named = true;
	}
	return undefined;
}

/** Only native boolean literals prove a switch's value; quoted strings do not. */
function literalSwitch(tokens: readonly Token[], index: number, command: string): boolean | undefined {
	const token = tokens[index]!, raw = command.slice(token.start, token.end), colon = raw.indexOf(":");
	if (colon < 0) return true;
	const next = tokens[index + 1];
	const value = (colon === raw.length - 1 && next ? command.slice(next.start, next.end) : raw.slice(colon + 1)).toLowerCase();
	return value === "$true" ? true : value === "$false" ? false : undefined;
}

function isFileRedirect(tokens: readonly Token[], index: number, command: string): boolean {
	const token = tokens[index]!;
	// Native argument mode distinguishes data> from "data">. Retain the closing
	// boundary of leading quoted operands, without re-parsing or stripping escapes.
	return !token.operator && FILE_REDIRECT.test(command.slice(token.quotedEnd || token.start, token.end))
		&& !isStreamMerge(tokens, index + 1);
}

/** Literal ShouldProcess dry runs only; nested commands retain their own checks. */
function hasLiteralWhatIf(tokens: readonly Token[], start: number, command: string, parameters: readonly string[]): boolean {
	let depth = 0, enabled = false;
	for (let j = start; j < tokens.length; j++) {
		const arg = tokens[j]!;
		if (isStreamMerge(tokens, j)) { j++; continue; }
		if (arg.operator && arg.value === "=") continue;
		if (arg.operator) {
			if (arg.value === "(" || arg.value === "{" || arg.value === "[") { if (++depth > MAX_NESTING) return false; }
			else if (arg.value === ")" || arg.value === "}" || arg.value === "]") { if (!depth) break; depth--; }
			else if (!depth) break;
			continue;
		}
		if (depth) continue;
		if (!arg.quoted && (arg.value === "--" || arg.value === "--%")) return false;
		if (isFileRedirect(tokens, j, command)) { if (tokens[j + 1] && !tokens[j + 1]!.operator) j++; continue; }
		if (isArgumentSuffix(tokens, j)) continue;
		const raw = command.slice(arg.start, arg.end), colon = raw.indexOf(":");
		if (!PARAMETER_DASH.test(raw)) continue;
		const option = raw.slice(1, colon < 0 ? raw.length : colon).toLowerCase();
		if (lookupOption(option, parameters) !== "whatif") continue;
		// Start-Process has no WhatIf in 5.1: bare -wi with a value binds WindowStyle.
		// A bare -wi is either a modern dry run or a legacy binding failure.
		// Literal boolean colon values cannot bind the legacy enum and stay safe.
		// Do not guess the final engine: executable recovery may change it later.
		const next = tokens[j + 1];
		if (parameters === PROCESS_PARAMETERS && option === "wi" && colon < 0 && next
			&& (next.value === "(" || (!next.operator && !PARAMETER_DASH.test(command.slice(next.start, next.end))))) continue;
		enabled = literalSwitch(tokens, j, command) === true;
		if (colon === raw.length - 1) j++;
	}
	return enabled;
}

/** Inspect only the command's own arguments; nested expressions get the main walk. */
function inspectCommandSwitch(tokens: readonly Token[], start: number, command: string, parameters: readonly string[], optionName: "wait" | "asynchronous" | "asjob", additionalOption?: "suspended" | "indisconnectedsession"): string | undefined {
	let wait = false, depth = 0;
	for (let j = start; j < tokens.length; j++) {
		const arg = tokens[j]!;
		if (isStreamMerge(tokens, j)) { j++; continue; }
		if (arg.operator && arg.value === "=") continue;
		if (arg.operator) {
			if (arg.value === "(" || arg.value === "{" || arg.value === "[") { if (++depth > MAX_NESTING) return UNCERTAIN; }
			else if (arg.value === ")" || arg.value === "}" || arg.value === "]") { if (!depth) break; depth--; }
			else if (!depth) break;
			continue;
		}
		if (depth) continue;
		if (optionName === "wait" && !arg.quoted && arg.dynamic && arg.value.startsWith("@") && arg.value.length > 1) return UNCERTAIN;
		if (!arg.quoted && arg.value === "--%") return UNCERTAIN;
		if (!arg.quoted && arg.value === "--") { if (optionName === "wait") return UNCERTAIN; break; }
		if (isFileRedirect(tokens, j, command)) { if (tokens[j + 1] && !tokens[j + 1]!.operator) j++; continue; }
		if (isArgumentSuffix(tokens, j)) continue;
		const raw = command.slice(arg.start, arg.end), colon = raw.indexOf(":");
		if (!PARAMETER_DASH.test(raw)) continue;
		const resolved = lookupOption(raw.slice(1, colon < 0 ? raw.length : colon).toLowerCase(), parameters);
		const option = resolved === "disconnected" && parameters === REMOTE_JOB_PARAMETERS ? "indisconnectedsession" : resolved;
		if (!option || (option !== optionName && option !== additionalOption)) continue;
		const enabled = literalSwitch(tokens, j, command);
		if (optionName === "wait") { if (enabled !== true) return UNCERTAIN; wait = true; }
		else if (enabled !== false) return BACKGROUND;
		if (colon === raw.length - 1) j++;
	}
	return optionName === "wait" && !wait ? BACKGROUND : undefined;
}

/** Bounded native parameter metadata; exact names/common aliases precede prefixes. */
function lookupOption(value: string, parameters: readonly string[]): string | undefined {
	if (value === "wi" && parameters.includes("whatif")) return "whatif";
	if (value === "cf" && parameters.includes("confirm")) return "confirm";
	const alias = VARIABLE_LOOKUP_ALIASES.get(value);
	if (alias) return alias;
	let match: string | undefined;
	for (let index = 0; index < parameters.length; index++) {
		const candidate = parameters[index]!;
		if (candidate === value) return candidate;
		if (value && candidate.startsWith(value)) { if (match) return undefined; match = candidate; }
	}
	return match;
}

/** Balanced type prefixes are linear, including generics, jagged arrays and bad input. */
function isSimpleVariable(value: string): boolean {
	let index = 0;
	while (value[index] === "[") {
		let depth = 1, named = false; index++;
		while (index < value.length && depth) {
			const c = value[index++]!;
			if (c === "[") { if (++depth > MAX_NESTING) return false; }
			else if (c === "]") depth--;
			else if (!TYPE_CHARACTER.test(c)) return false;
			else named = true;
		}
		if (depth || !named) return false;
	}
	return SIMPLE_VARIABLE.test(index ? value.slice(index) : value);
}

function isArgumentSuffix(tokens: readonly Token[], index: number): boolean {
	const previous = tokens[index - 1];
	return previous?.operator === true && previous.value === "=" && previous.end === tokens[index]!.start;
}

function isStreamMerge(tokens: readonly Token[], index: number): boolean {
	const token = tokens[index], previous = tokens[index - 1], next = tokens[index + 1];
	return token?.operator === true && token.value === "&" && previous !== undefined && next !== undefined
		&& !previous.quoted && !next.quoted && previous.end === token.start && next.start === token.end
		&& STREAM_REDIRECT.test(previous.value) && STREAM_NUMBER.test(next.value);
}

/** Recognize explicit start verbs after supported systemctl global options.
 * Unknown/dynamic options remain ordinary opaque execution, never a new ban. */
function inspectSystemctl(tokens: readonly Token[], start: number): string | undefined {
	let options = true, now = false, enable = false;
	for (let i = start; i < tokens.length; i++) {
		const token = tokens[i]!;
		if (token.operator || token.dynamic) return undefined;
		const value = token.value;
		if (options && value === "--") { options = false; continue; }
		if (options && value.startsWith("-")) {
			if (value === "--now") { if (enable) return BACKGROUND; now = true; continue; }
			if (SYSTEMCTL_FLAGS.has(value)) continue;
			let offset = 1;
			const long = value.startsWith("--");
			if (!long) {
				while (offset < value.length && "qalf".includes(value[offset]!)) offset++;
				if (offset === value.length) continue;
			}
			const short = long ? value : "-" + value[offset];
			if (!SYSTEMCTL_VALUES.has(short)) return undefined;
			if (!long && offset + 1 < value.length) continue;
			if (tokens[i + 1]?.value === "=") i++;
			const operand = tokens[++i];
			if (!operand || operand.operator || operand.dynamic) return undefined;
			continue;
		}
		if (enable) continue; // Remaining plain operands are unit names.
		if (SYSTEMCTL_START.has(value)) return BACKGROUND;
		if (value !== "enable" && value !== "reenable") return undefined;
		if (now) return BACKGROUND;
		enable = true;
	}
	return undefined;
}

/** Literal cmd /c start keeps its own wait option; arbitrary batch code is opaque. */
function inspectCmdStart(tokens: readonly Token[], start: number): string | undefined {
	let i = start;
	for (; i < tokens.length; i++) {
		const token = tokens[i]!;
		if (token.operator || token.dynamic) return undefined;
		if (token.value.toLowerCase() === "/c") break;
		if (!CMD_OPTIONS.test(token.value)) return undefined;
	}
	const launch = tokens[++i];
	if (!launch || launch.operator || launch.dynamic || launch.value.toLowerCase() !== "start") return undefined;
	let wait = false, title = false;
	for (i++; i < tokens.length; i++) {
		const token = tokens[i]!;
		if (token.operator) break;
		if (token.quotedEnd) { if (!title) { title = true; continue; } break; }
		if (token.dynamic) return wait ? undefined : BACKGROUND;
		const value = token.value.toLowerCase();
		if (value === "/wait") { wait = true; continue; }
		if (value === "/?") return undefined;
		if (CMD_START_FLAGS.has(value)) continue;
		if (CMD_START_VALUES.has(value)) {
			const operand = tokens[++i];
			if (!operand || operand.operator) return undefined;
			continue;
		}
		break; // The program and its parameters cannot supply start's /wait.
	}
	return wait ? undefined : BACKGROUND;
}

function refusal(code: string, reason: string): string {
	return `[${code}] PowerShell not executed: ${reason}.\nNext: submit a literal foreground command for normal authorization; do not retry the same blocked call.`;
}
const UNCERTAIN = refusal("SHELL_UNINSPECTABLE", "this PowerShell invocation cannot be inspected");
const BACKGROUND = refusal("SHELL_BACKGROUND", "unmanaged background work requires an owned task; Start-Process must use a literal -Wait");
/** Invocation-only bounded lexer, not an authorization or a PowerShell sandbox.
 * Unlike Bash, assignment, member access and script blocks are ordinary PS syntax.
 * Detect explicit job/process options; do not infer behavior from types or members.
 * Opaque fragments defer to normal permission classification without suppressing
 * subsequent statements. Unknown program behavior is not itself a refusal.
 * Passing this preflight is not proof that arbitrary code cannot detach work.
 */
export function inspectPowerShellResourceLifecycle(input: unknown): string | undefined {
	if (!input || typeof input !== "object") return undefined;
	const command = (input as { command?: unknown }).command;
	if (typeof command !== "string" || !command) return undefined;
	if (command.length > MAX_CHARS) return refusal("SHELL_INSPECTION_LIMIT", "command exceeds the inspection size limit");
	// Call-owned, capped, never cached or retained by progress/render owners.
	const tokens: Token[] = [];
	// Reuse the bounded primitive stack: attribute ends while lexing, then contexts.
	const contexts: number[] = [];
	for (let i = 0; i < command.length;) {
		if (tokens.length >= MAX_TOKENS) return refusal("SHELL_INSPECTION_LIMIT", "too many PowerShell tokens");
		const start = i, ch = command[i]!;
		if (i === contexts[contexts.length - 1]! - 1) {
			contexts.pop();
			tokens.push({ value: "]", quoted: false, quotedEnd: 0, dynamic: false, operator: true, typeOnly: false, start, end: ++i });
			continue;
		}
		if (ch === "#") { while (i < command.length && command[i] !== "\n") i++; continue; }
		if (command.startsWith("<#", i)) {
			const end = command.indexOf("#>", i + 2);
			if (end < 0) return UNCERTAIN;
			i = end + 2;
			continue;
		}
		if (PUNCTUATION.test(ch)) { tokens.push({ value: ch, quoted: false, quotedEnd: 0, dynamic: false, operator: true, typeOnly: false, start, end: ++i }); continue; }
		if (SPACE.test(ch)) { i++; continue; }
		if (ch === "@" && quoteKind(command[i + 1])) {
			i = hereStringEnd(command, i);
			if (i < 0) return UNCERTAIN;
			tokens.push({ value: "", quoted: true, quotedEnd: i, dynamic: false, operator: false, typeOnly: false, start, end: i });
			continue;
		}
		if (ch === "[") {
			const end = attributeEnd(command, i);
			if (end >= 0) {
				if (contexts.length === MAX_NESTING) return UNCERTAIN;
				contexts.push(end);
				tokens.push({ value: "[", quoted: false, quotedEnd: 0, dynamic: false, operator: true, typeOnly: false, start, end: ++i });
				continue;
			}
		}
		let value = "", quoted = false, quotedEnd = 0, dynamic = false, span = i, typeOnly = false;
		while (command[i] === "[") {
			const type = readType(command, i);
			if (!type) break;
			value += type.value; i = type.end; span = i; typeOnly = true;
		}
		if (typeOnly && command[i] === "@" && (command[i + 1] === "{" || command[i + 1] === "(")) {
			tokens.push({ value, quoted: false, quotedEnd: 0, dynamic: false, operator: false, typeOnly: true, start, end: i });
			continue;
		}
		if (typeOnly && command.startsWith("::", i)) {
			value += "::"; i = skipTypeTrivia(command, i + 2);
			if (i < 0) return UNCERTAIN;
			span = i; typeOnly = false;
		}
		while (i < command.length && !SPACE.test(command[i]!) && !PUNCTUATION.test(command[i]!)) {
			typeOnly = false;
			const c = command[i++]!;
			if (c === "$" && command[i] === "{") {
				dynamic = true; i++;
				while (i < command.length && command[i] !== "}") {
					if (command[i] === "{") return UNCERTAIN;
					i += command[i] === "`" ? 2 : 1;
				}
				if (command[i] !== "}") return UNCERTAIN;
				i++; continue;
			}
			if (c === "`") {
				value += command.slice(span, i - 1);
				if (i >= command.length) return UNCERTAIN;
				const escaped = command[i++]!;
				if (escaped === "\r" && command[i] === "\n") i++;
				else if (escaped !== "\n") value += escaped;
				span = i;
				continue;
			}
			const quote = quoteKind(c);
			if (!quote) { if (c === "$" || c === "@") dynamic = true; continue; }
			const quoteStart = i - 1;
			value += command.slice(span, i - 1);
			quoted = true;
			span = i;
			let closed = false;
			while (i < command.length) {
				const q = command[i++]!;
				if (quoteKind(q) === quote) {
					value += command.slice(span, i - 1);
					if (quoteKind(command[i]) === quote) { value += q; i++; span = i; continue; }
					if (quoteStart === start || quoteStart === quotedEnd) quotedEnd = i;
					span = i;
					closed = true; break;
				}
				if (quote === 2 && q === "`") { if (i >= command.length) return UNCERTAIN; value += command.slice(span, i - 1) + command[i++]!; span = i; continue; }
				if (quote === 2 && q === "$") {
					// Nested string expressions need normal opaque-script authorization.
					if (command[i] === "(") { i = parenthesisEnd(command, i, 0); if (i < 0) return UNCERTAIN; }
					dynamic = true;
				}
			}
			if (!closed) return UNCERTAIN;
		}
		value += command.slice(span, i);
		if (value || quoted) tokens.push({ value, quoted, quotedEnd, dynamic, operator: false, typeOnly, start, end: i });
	}
	if (contexts.length) return UNCERTAIN;

	let head = true, assignable = false, controlBlock = false, paramBlock = false, classBlock = false, switchBlock = false;
	let doBlock = false, afterDo = false, doCondition = false, foreachBlock = false;
	// Low bits: 0 paren, 1 control block, 2 hash key, 3 hash value, 4 block argument, 5 param list.
	// 6 is a do body, 7 its trailing while/until condition.
	// Flag 8 restores an enclosing control statement after its condition parentheses.
	// 9/10 are attribute boundaries/arguments: names are metadata, script bodies code.
	// 11 is class/enum declaration metadata; method bodies use ordinary block contexts.
	// 12 is switch pattern metadata; 16 restores it after the input expression.
	// 24/40 are foreach's variable/in states; flag 64 restores an assignment target.
	// Primitive call-owned stack, capped at MAX_NESTING and never retained.
	for (let i = 0; i < tokens.length; i++) {
		const token = tokens[i]!, value = token.value;
		const topIndex = contexts.length - 1, top = contexts[topIndex], contextKind = top === undefined ? undefined : top & 63;
		if (token.operator) {
			if (value === "=") {
				head = assignable; controlBlock = false; paramBlock = false; foreachBlock = false; classBlock = false; switchBlock = false;
				if (assignable && contextKind === 2) contexts[topIndex] = (top! & 64) | 3;
				assignable = false; continue;
			}
			const assigning: boolean = assignable;
			assignable = false;
			if (value === "(" || value === "{" || value === "[") {
				if (contexts.length === MAX_NESTING) return UNCERTAIN;
				const previous = tokens[i - 1];
				const kind = value === "[" ? 9 : value === "(" ? (contextKind === 9 || contextKind === 10 ? 10 : doCondition ? 7 : paramBlock ? 5 : switchBlock ? 16 : controlBlock ? foreachBlock ? 24 : 8 : 0) : classBlock ? 11 : switchBlock ? 12 : previous?.value === "@" && !previous.quoted && previous.end === token.start ? 2 : doBlock ? 6 : controlBlock ? 1 : 4;
				contexts.push(kind | (assigning ? 64 : 0));
				head = value !== "[" && kind !== 10; controlBlock = false; paramBlock = false; doBlock = false; doCondition = false; foreachBlock = false; classBlock = false; switchBlock = false; continue;
			}
			if (value === ")" || value === "}" || value === "]") {
				const saved = contexts.pop(), context = saved === undefined ? undefined : saved & 63;
				if (context === undefined || (context === 9 ? value !== "]" : value === "]" || (value === ")") !== ((context & 7) === 0 || context === 5 || context === 7 || context === 10))) return UNCERTAIN;
				head = context === 1 || context === 5 || context === 6 || context === 7 || context === 9 || context === 11 || context === 12;
				assignable = (saved! & 64) !== 0 || (context === 0 && assigning);
				switchBlock = context === 16;
				controlBlock = switchBlock || context === 8 || context === 24 || context === 40; paramBlock = false; foreachBlock = false; afterDo = context === 6; continue;
			}
			if (value !== "\n" && value !== "\r") { controlBlock = false; foreachBlock = false; classBlock = false; switchBlock = false; }
			if ((value === ";" || value === "\n" || value === "\r") && (contextKind === 2 || contextKind === 3)) contexts[topIndex] = (top! & 64) | 2;
			if (value === "&") {
				const next = tokens[i + 1];
				if (isStreamMerge(tokens, i)) { i++; continue; }
				if (next?.operator && next.value === "&" && next.start === token.end) { i++; head = true; continue; }
				if (!head) return BACKGROUND;
			} else head = true;
			continue;
		}
		if (contextKind === 40 && !token.quoted && value.toLowerCase() === "in") { contexts[topIndex] = (top! & 64) | 8; head = true; assignable = false; continue; }
		if (!head || contextKind === 10) continue;
		head = false;
		if (contextKind === 2) { assignable = true; continue; }
		if (token.typeOnly) { head = true; continue; }
		if (contextKind === 11 && !token.dynamic) { paramBlock = true; continue; }
		if (contextKind === 12 && !token.dynamic) continue;
		if (!token.quoted && value === ".") { head = true; continue; }
		if (!token.quoted && value.startsWith(":")) {
			if (!STATEMENT_LABEL.test(value)) return UNCERTAIN;
			head = true; continue;
		}
		// A quoted expression is data unless preceded by an invocation operator.
		if (quoteKind(command[token.start]) && tokens[i - 1]?.value !== "&" && (tokens[i - 1]?.value !== "." || tokens[i - 1]?.quoted)) continue;
		if (token.dynamic) {
			// A variable/member expression is not a Bash executable position.
			if (tokens[i - 1]?.value === "&") continue;
			if (isSimpleVariable(value)) { assignable = true; if (contextKind === 24) contexts[topIndex] = (top! & 64) | 40; continue; }
			if (value.startsWith("$") || value.startsWith("[")) assignable = true;
			if ((value.startsWith("++") || value.startsWith("--")) && isSimpleVariable(value.slice(2))) continue;
			if ((value.endsWith("++") || value.endsWith("--")) && isSimpleVariable(value.slice(0, -2))) continue;
			if (value === "$" || (value === "@" && (tokens[i + 1]?.value === "(" || tokens[i + 1]?.value === "{"))) continue;
			// Runtime indirection belongs to normal opaque-script authorization.
			continue;
		}
		const name = value.slice(Math.max(value.lastIndexOf("/"), value.lastIndexOf("\\")) + 1).toLowerCase();
		const externalName = name.endsWith(".exe") ? name.slice(0, -4) : name;
		controlBlock = !token.quoted && CONTROL_BLOCK.has(name);
		classBlock = !token.quoted && (name === "class" || name === "enum");
		switchBlock = !token.quoted && name === "switch";
		foreachBlock = !token.quoted && name === "foreach";
		paramBlock = !token.quoted && name === "param";
		doBlock = !token.quoted && name === "do";
		doCondition = afterDo && !token.quoted && (name === "while" || name === "until"); afterDo = false;
		if (!token.quoted && (name === "return" || name === "throw" || name === "exit")) { head = true; continue; }
		if (DETACHED.has(name)) {
			const parameters = SERVICE_STARTERS.has(name) ? SERVICE_START_PARAMETERS : name === "invoke-item" || name === "ii" ? ITEM_PARAMETERS : undefined;
			if (!parameters || !hasLiteralWhatIf(tokens, i + 1, command, parameters)) return BACKGROUND;
		}
		if (EXTERNAL_DETACHED.has(externalName)) return BACKGROUND;
		if (WMI_JOB_COMMANDS.has(name) || COMPUTER_JOB_COMMANDS.has(name)) {
			const reason = inspectCommandSwitch(tokens, i + 1, command, WMI_JOB_COMMANDS.has(name) ? WMI_JOB_PARAMETERS : COMPUTER_JOB_PARAMETERS, "asjob");
			if (reason) return reason;
		}
		if (REMOTE_COMMANDS.has(name)) {
			const reason = inspectCommandSwitch(tokens, i + 1, command, REMOTE_JOB_PARAMETERS, "asjob", "indisconnectedsession");
			if (reason) return reason;
		}
		if (FOR_EACH.has(name) && !(name === "foreach" && tokens[i + 1]?.value === "(")) {
			const reason = inspectCommandSwitch(tokens, i + 1, command, FOR_EACH_PARAMETERS, "asjob");
			if (reason) return reason;
		}
		if (name === "set-service" && !hasLiteralWhatIf(tokens, i + 1, command, SERVICE_SET_PARAMETERS)) {
			let depth = 0;
			for (let j = i + 1; j < tokens.length; j++) {
				const arg = tokens[j]!;
				if (arg.operator && arg.value === "=") continue;
				if (arg.operator) {
					if (arg.value === "(" || arg.value === "{" || arg.value === "[") { if (++depth > MAX_NESTING) return UNCERTAIN; }
					else if (arg.value === ")" || arg.value === "}" || arg.value === "]") { if (!depth) break; depth--; }
					else if (!depth) break;
					continue;
				}
				if (depth || isArgumentSuffix(tokens, j)) continue;
				if (!arg.quoted && (arg.value === "--%" || arg.value === "--")) break;
				if (isFileRedirect(tokens, j, command)) { if (tokens[j + 1] && !tokens[j + 1]!.operator) j++; continue; }
				const raw = command.slice(arg.start, arg.end), colon = raw.indexOf(":"), option = raw.slice(1, colon < 0 ? raw.length : colon).toLowerCase();
				if (!PARAMETER_DASH.test(raw) || lookupOption(option, SERVICE_SET_PARAMETERS) !== "status") continue;
				const separate = colon < 0 || colon === raw.length - 1;
				const status = separate ? tokens[j + 1] : arg;
				// Dynamic status/data remains opaque; a literal Running is explicit.
				if (!status || status.operator || status.dynamic) continue;
				const state = (separate ? status.value : status.value.slice(status.value.indexOf(":") + 1)).toLowerCase();
				if (state === "running") return BACKGROUND;
			}
		}
		if (PROCESS.has(name) && !hasLiteralWhatIf(tokens, i + 1, command, PROCESS_PARAMETERS)) {
			const reason = inspectCommandSwitch(tokens, i + 1, command, PROCESS_PARAMETERS, "wait");
			if (reason) return reason;
		}
		if (name === "start-bitstransfer" || name === "resume-bitstransfer") {
			const reason = inspectCommandSwitch(tokens, i + 1, command, name === "start-bitstransfer" ? BITS_START_PARAMETERS : BITS_RESUME_PARAMETERS, "asynchronous", name === "start-bitstransfer" ? "suspended" : undefined);
			if (reason) return reason;
		}
		if (BASH.has(externalName)) {
			const flag = tokens[i + 1], script = tokens[i + 2];
			if (flag?.value !== "-c" || !script?.quoted || script.dynamic) return UNCERTAIN;
			const reason = inspectBashResourceLifecycle({ command: script.value });
			if (reason) return reason;
		}
		if (externalName === "cmd") {
			const reason = inspectCmdStart(tokens, i + 1);
			if (reason) return reason;
		}
		if (externalName === "systemctl") {
			const reason = inspectSystemctl(tokens, i + 1);
			if (reason) return reason;
		}
		if (externalName === "docker" || externalName === "pm2" || externalName === "service") {
			let end = token.end;
			for (let j = i + 1; j < tokens.length; j++) {
				const arg = tokens[j]!;
				if (arg.operator && arg.value === "=") continue;
				if (arg.operator) break;
				if (arg.dynamic) return UNCERTAIN;
				end = arg.end;
			}
			if (inspectBashResourceLifecycle({ command: command.slice(token.start, end) })) return BACKGROUND;
		}
	}
	return contexts.length ? UNCERTAIN : undefined;
}
