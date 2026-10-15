import { inspectBashResourceLifecycle } from "./core.ts";

const MAX_CHARS = 128 * 1024;
const MAX_TOKENS = 2048;
const MAX_NESTING = 64;
const BASH = new Set(["bash", "sh", "zsh", "dash", "ksh", "fish"]);
const DETACHED = new Set(["start-job", "sajb", "start-threadjob", "start-service", "sasv", "restart-service", "resume-service", "rsv", "start-scheduledtask", "register-scheduledjob", "set-scheduledjob", "register-scheduledtask", "set-scheduledtask", "nohup", "disown", "setsid", "daemonize", "invoke-item", "ii"]);
const EXTERNAL_DETACHED = new Set(["nohup", "disown", "setsid", "daemonize"]);
const PROCESS = new Set(["start-process", "start", "saps"]);
const SERVICE_STARTERS = new Set(["start-service", "sasv", "restart-service", "resume-service", "rsv"]);
const CONTROL_BLOCK = new Set(["if", "elseif", "else", "for", "foreach", "while", "do", "switch", "try", "catch", "finally", "trap", "begin", "process", "end", "clean", "dynamicparam", "data", "function", "filter", "class", "enum", "workflow", "configuration"]);
const VARIABLE_LOOKUP_PARAMETERS = ["name", "valueonly", "include", "exclude", "scope", "verbose", "debug", "erroraction", "warningaction", "informationaction", "progressaction", "errorvariable", "warningvariable", "informationvariable", "outvariable", "outbuffer", "pipelinevariable"];
const VARIABLE_LOOKUP_ALIASES = new Map([["vb", "verbose"], ["db", "debug"], ["ea", "erroraction"], ["wa", "warningaction"], ["infa", "informationaction"], ["proga", "progressaction"], ["ev", "errorvariable"], ["wv", "warningvariable"], ["iv", "informationvariable"], ["ov", "outvariable"], ["ob", "outbuffer"], ["pv", "pipelinevariable"]]);
const FOR_EACH = new Set(["foreach-object", "foreach", "%"]);
const FOR_EACH_PARAMETERS = ["inputobject", "begin", "process", "end", "remainingscripts", "membername", "argumentlist", "parallel", "throttlelimit", "timeoutseconds", "asjob", "usenewrunspace", "whatif", "confirm", ...VARIABLE_LOOKUP_PARAMETERS.slice(5)];
const PROCESS_PARAMETERS = ["filepath", "argumentlist", "credential", "workingdirectory", "loaduserprofile", "nonewwindow", "passthru", "redirectstandarderror", "redirectstandardinput", "redirectstandardoutput", "verb", "windowstyle", "wait", "usenewenvironment", "environment", "whatif", "confirm", ...VARIABLE_LOOKUP_PARAMETERS.slice(5)];
const BITS_START_PARAMETERS = ["asynchronous", "dynamic", "customheaderswriteonly", "authentication", "credential", "description", "httpmethod", "destination", "displayname", "priority", "transferpolicy", "aclflags", "securityflags", "usestoredcredential", "proxyauthentication", "proxybypass", "proxycredential", "proxylist", "proxyusage", "retryinterval", "retrytimeout", "maxdownloadtime", "source", "suspended", "transfertype", "customheaders", "notifyflags", "notifycmdline", "certstorelocation", "certstorename", "certhash", "whatif", "confirm", ...VARIABLE_LOOKUP_PARAMETERS.slice(5)];
const BITS_RESUME_PARAMETERS = ["bitsjob", "asynchronous", "whatif", "confirm", ...VARIABLE_LOOKUP_PARAMETERS.slice(5)];
const SERVICE_START_PARAMETERS = ["name", "inputobject", "passthru", "displayname", "include", "exclude", "force", "whatif", "confirm", ...VARIABLE_LOOKUP_PARAMETERS.slice(5)];
const SERVICE_SET_PARAMETERS = ["name", "inputobject", "displayname", "credential", "description", "startuptype", "securitydescriptorsddl", "status", "force", "passthru", "computername", "whatif", "confirm", ...VARIABLE_LOOKUP_PARAMETERS.slice(5)];
const WMI_JOB_COMMANDS = new Set(["get-wmiobject", "gwmi", "remove-wmiobject", "rwmi", "set-wmiinstance", "swmi"]);
const COMPUTER_JOB_COMMANDS = new Set(["restart-computer", "stop-computer", "test-connection"]);
// Native metadata: these are the names competing with the AsJob prefix. Other
// parameters do not affect its binding and retain ordinary argument inspection.
const WMI_JOB_PARAMETERS = ["asjob", "authentication", "authority", "arguments"];
const COMPUTER_JOB_PARAMETERS = ["asjob"];
const SPACE = /\s/;
const PUNCTUATION = /[;|\n\r{}()=&]/;
// PowerShell accepts unambiguous parameter prefixes and these Unicode dashes.
const PARAMETER_DASH = /^[-\u2013\u2014\u2015]/;
const TYPE_CHARACTER = /[\w.,+]/;
const STATEMENT_LABEL = /^:[\w]+$/;
const SIMPLE_VARIABLE = /^\$(?:[\w:]+|\{(?:[^`{}]|`[\s\S])+\})(?:\.[\w]+|\[[\w$]+\])*$/;
const STREAM_REDIRECT = /^[1-6*]?>$/;
const STREAM_NUMBER = /^[1-6]$/;
const FILE_REDIRECT = /^[1-6*]?>>?$/;

interface Token { value: string; quoted: boolean; quotedEnd: number; dynamic: boolean; operator: boolean; typeOnly: boolean; start: number; end: number }

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
			if (arg.value === "(" || arg.value === "{") { if (++depth > MAX_NESTING) return false; }
			else if (arg.value === ")" || arg.value === "}") { if (!depth) break; depth--; }
			else if (!depth) break;
			continue;
		}
		if (depth) continue;
		if (!arg.quoted && (arg.value === "--" || arg.value === "--%")) return false;
		if (isFileRedirect(tokens, j, command)) { if (tokens[j + 1] && !tokens[j + 1]!.operator) j++; continue; }
		if (isArgumentSuffix(tokens, j)) continue;
		const raw = command.slice(arg.start, arg.end), colon = raw.indexOf(":");
		if (!PARAMETER_DASH.test(raw) || lookupOption(raw.slice(1, colon < 0 ? raw.length : colon).toLowerCase(), parameters) !== "whatif") continue;
		enabled = literalSwitch(tokens, j, command) === true;
		if (colon === raw.length - 1) j++;
	}
	return enabled;
}

/** Inspect only the command's own arguments; nested expressions get the main walk. */
function inspectCommandSwitch(tokens: readonly Token[], start: number, command: string, parameters: readonly string[], optionName: "wait" | "asynchronous" | "asjob", additionalOption?: "suspended"): string | undefined {
	let wait = false, depth = 0;
	for (let j = start; j < tokens.length; j++) {
		const arg = tokens[j]!;
		if (isStreamMerge(tokens, j)) { j++; continue; }
		if (arg.operator && arg.value === "=") continue;
		if (arg.operator) {
			if (arg.value === "(" || arg.value === "{") { if (++depth > MAX_NESTING) return UNCERTAIN; }
			else if (arg.value === ")" || arg.value === "}") { if (!depth) break; depth--; }
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
		const option = lookupOption(raw.slice(1, colon < 0 ? raw.length : colon).toLowerCase(), parameters);
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

function refusal(code: string, reason: string): string {
	return `[${code}] PowerShell not executed: ${reason}.\nNext: submit a literal foreground command for normal authorization; do not retry the same blocked call.`;
}
const UNCERTAIN = refusal("SHELL_UNINSPECTABLE", "this PowerShell invocation cannot be inspected");
const BACKGROUND = refusal("SHELL_BACKGROUND", "unmanaged background work requires an owned task; Start-Process must use a literal -Wait");
/** Invocation-only bounded lexer, not an authorization or a PowerShell sandbox.
 * Unlike Bash, assignment, member access and script blocks are ordinary PS syntax.
 * Detect explicit job/process options; do not infer behavior from types or members.
 * Here-strings, string subexpressions and indirect calls defer to normal permission
 * classification. Unknown program behavior is not a lifecycle refusal by itself.
 * Passing this preflight is not proof that arbitrary code cannot detach work.
 */
export function inspectPowerShellResourceLifecycle(input: unknown): string | undefined {
	if (!input || typeof input !== "object") return undefined;
	const command = (input as { command?: unknown }).command;
	if (typeof command !== "string" || !command) return undefined;
	if (command.length > MAX_CHARS) return refusal("SHELL_INSPECTION_LIMIT", "command exceeds the inspection size limit");
	// Call-owned, capped, never cached or retained by progress/render owners.
	const tokens: Token[] = [];
	for (let i = 0; i < command.length;) {
		if (tokens.length >= MAX_TOKENS) return refusal("SHELL_INSPECTION_LIMIT", "too many PowerShell tokens");
		const start = i, ch = command[i]!;
		if (ch === "#") { while (i < command.length && command[i] !== "\n") i++; continue; }
		if (command.startsWith("<#", i)) {
			const end = command.indexOf("#>", i + 2);
			if (end < 0) return UNCERTAIN;
			i = end + 2;
			continue;
		}
		if (PUNCTUATION.test(ch)) { tokens.push({ value: ch, quoted: false, quotedEnd: 0, dynamic: false, operator: true, typeOnly: false, start, end: ++i }); continue; }
		if (SPACE.test(ch)) { i++; continue; }
		if (ch === "@" && (command[i + 1] === "'" || command[i + 1] === '"')) return undefined;
		let value = "", quoted = false, quotedEnd = 0, dynamic = false, span = i, typeOnly = false;
		while (command[i] === "[") {
			const type = readType(command, i);
			if (!type) break;
			value += type.value; i = type.end; span = i; typeOnly = true;
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
			if (c !== "'" && c !== '"') { if (c === "$" || c === "@") dynamic = true; continue; }
			const quoteStart = i - 1;
			value += command.slice(span, i - 1);
			quoted = true;
			span = i;
			let closed = false;
			while (i < command.length) {
				const q = command[i++]!;
				if (q === c) {
					value += command.slice(span, i - 1);
					if (c === "'" && command[i] === "'") { value += "'"; i++; span = i; continue; }
					if (quoteStart === start || quoteStart === quotedEnd) quotedEnd = i;
					span = i;
					closed = true; break;
				}
				if (c === '"' && q === "`") { if (i >= command.length) return UNCERTAIN; value += command.slice(span, i - 1) + command[i++]!; span = i; continue; }
				if (c === '"' && q === "$") {
					// Nested string expressions need normal opaque-script authorization.
					if (command[i] === "(") return undefined;
					dynamic = true;
				}
			}
			if (!closed) return UNCERTAIN;
		}
		value += command.slice(span, i);
		if (value || quoted) tokens.push({ value, quoted, quotedEnd, dynamic, operator: false, typeOnly, start, end: i });
	}

	let head = true, assignable = false, controlBlock = false, paramBlock = false;
	let doBlock = false, afterDo = false, doCondition = false, foreachBlock = false;
	// Low bits: 0 paren, 1 control block, 2 hash key, 3 hash value, 4 block argument, 5 param list.
	// 6 is a do body, 7 its trailing while/until condition.
	// Flag 8 restores an enclosing control statement after its condition parentheses.
	// 24/40 are foreach's variable/in states.
	// Primitive call-owned stack, capped at MAX_NESTING and never retained.
	const contexts: number[] = [];
	for (let i = 0; i < tokens.length; i++) {
		const token = tokens[i]!, value = token.value;
		const topIndex = contexts.length - 1, top = contexts[topIndex], contextKind = top;
		if (token.operator) {
			if (value === "=") {
				head = assignable; controlBlock = false; paramBlock = false; foreachBlock = false;
				if (assignable && contextKind === 2) contexts[topIndex] = 3;
				assignable = false; continue;
			}
			assignable = false;
			if (value === "(" || value === "{") {
				if (contexts.length === MAX_NESTING) return UNCERTAIN;
				const previous = tokens[i - 1];
				const kind = value === "(" ? (doCondition ? 7 : paramBlock ? 5 : controlBlock ? foreachBlock ? 24 : 8 : 0) : previous?.value === "@" && !previous.quoted && previous.end === token.start ? 2 : doBlock ? 6 : controlBlock ? 1 : 4;
				contexts.push(kind);
				head = true; controlBlock = false; paramBlock = false; doBlock = false; doCondition = false; foreachBlock = false; continue;
			}
			if (value === ")" || value === "}") {
				const context = contexts.pop();
				if (context === undefined || (value === ")") !== ((context & 7) === 0 || context === 5 || context === 7)) return UNCERTAIN;
				head = context === 1 || context === 5 || context === 6 || context === 7;
				controlBlock = (context & 8) !== 0; paramBlock = false; foreachBlock = false; afterDo = context === 6; continue;
			}
			if (value !== "\n" && value !== "\r") { controlBlock = false; foreachBlock = false; }
			if ((value === ";" || value === "\n" || value === "\r") && (contextKind === 2 || contextKind === 3)) contexts[topIndex] = 2;
			if (value === "&") {
				const next = tokens[i + 1];
				if (isStreamMerge(tokens, i)) { i++; continue; }
				if (next?.operator && next.value === "&" && next.start === token.end) { i++; head = true; continue; }
				if (!head) return BACKGROUND;
				const target = tokens[i + 1];
				if (!target || target.dynamic || target.value === "(") return undefined;
			} else head = true;
			continue;
		}
		if (contextKind === 40 && !token.quoted && value.toLowerCase() === "in") { contexts[topIndex] = 8; head = true; assignable = false; continue; }
		if (!head) continue;
		head = false;
		if (contextKind === 2) { assignable = true; continue; }
		if (token.typeOnly) { head = true; continue; }
		if (!token.quoted && value.startsWith(":")) {
			if (!STATEMENT_LABEL.test(value)) return UNCERTAIN;
			head = true; continue;
		}
		// A quoted expression is data unless preceded by PowerShell's call operator.
		if ((command[token.start] === "'" || command[token.start] === '"') && tokens[i - 1]?.value !== "&") continue;
		if (token.dynamic) {
			// A variable/member expression is not a Bash executable position.
			if (isSimpleVariable(value)) { assignable = true; if (contextKind === 24) contexts[topIndex] = 40; continue; }
			if ((value.startsWith("++") || value.startsWith("--")) && isSimpleVariable(value.slice(2))) continue;
			if ((value.endsWith("++") || value.endsWith("--")) && isSimpleVariable(value.slice(0, -2))) continue;
			if (value === "$" || (value === "@" && (tokens[i + 1]?.value === "(" || tokens[i + 1]?.value === "{"))) continue;
			// Runtime indirection belongs to normal opaque-script authorization.
			continue;
		}
		const name = value.slice(Math.max(value.lastIndexOf("/"), value.lastIndexOf("\\")) + 1).toLowerCase();
		const externalName = name.endsWith(".exe") ? name.slice(0, -4) : name;
		controlBlock = !token.quoted && CONTROL_BLOCK.has(name);
		foreachBlock = !token.quoted && name === "foreach";
		paramBlock = !token.quoted && name === "param";
		doBlock = !token.quoted && name === "do";
		doCondition = afterDo && !token.quoted && (name === "while" || name === "until"); afterDo = false;
		if (!token.quoted && (name === "return" || name === "throw" || name === "exit")) { head = true; continue; }
		if (DETACHED.has(name) && !(SERVICE_STARTERS.has(name) && hasLiteralWhatIf(tokens, i + 1, command, SERVICE_START_PARAMETERS))) return BACKGROUND;
		if (EXTERNAL_DETACHED.has(externalName)) return BACKGROUND;
		if (WMI_JOB_COMMANDS.has(name) || COMPUTER_JOB_COMMANDS.has(name)) {
			const reason = inspectCommandSwitch(tokens, i + 1, command, WMI_JOB_COMMANDS.has(name) ? WMI_JOB_PARAMETERS : COMPUTER_JOB_PARAMETERS, "asjob");
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
					if (arg.value === "(" || arg.value === "{") { if (++depth > MAX_NESTING) return UNCERTAIN; }
					else if (arg.value === ")" || arg.value === "}") { if (!depth) break; depth--; }
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
		if (externalName === "docker" || externalName === "pm2" || externalName === "systemctl" || externalName === "service") {
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
