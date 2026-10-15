import { inspectBashResourceLifecycle } from "./core.ts";

const MAX_CHARS = 128 * 1024;
const MAX_TOKENS = 2048;
const MAX_NESTING = 64;
const BASH = new Set(["bash", "sh", "zsh", "dash", "ksh", "fish"]);
const LAUNCHERS = new Set(["powershell", "pwsh", "cmd", "invoke-expression", "iex", "invoke-command", "icm", "invoke-cimmethod", "invoke-wmimethod", "iwmi", "invoke-item", "ii", "set-alias", "new-alias", "import-alias", "sal", "nal", "function", "filter", "class", "enum", "workflow", "configuration"]);
const DETACHED = new Set(["start-job", "sajb", "start-threadjob", "start-service", "sasv", "restart-service", "resume-service", "rsv", "start-scheduledtask", "register-scheduledjob", "set-scheduledjob", "nohup", "disown", "setsid", "daemonize"]);
const PROCESS = new Set(["start-process", "start", "saps"]);
const CONTROL_BLOCK = new Set(["if", "elseif", "else", "for", "foreach", "while", "do", "switch", "try", "catch", "finally", "trap", "begin", "process", "end", "clean", "dynamicparam", "data"]);
const PROVIDER_MUTATORS = new Set(["set-item", "si", "new-item", "ni", "copy-item", "cpi", "cp", "copy", "move-item", "mi", "mv", "move", "rename-item", "rni", "ren", "set-location", "sl", "cd", "chdir", "push-location", "pushd"]);
const EXECUTABLE_PROVIDER = /(?:^|[:,])(?:[^:,]*\\)?(?:alias|function|variable):/i;
const VARIABLE_MUTATORS = new Set(["set-variable", "sv", "set", "new-variable", "nv"]);
const DEFAULT_PARAMETERS = /\bpsdefaultparametervalues\b/i;
const SESSION_STATE = /\b(?:sessionstate|sessionstateproxy|psvariable)\b/i;
const VARIABLE_WILDCARD = /[*?\[]/;
const VARIABLE_LOOKUP_FLAGS = new Set(["valueonly", "verbose", "debug"]);
const VARIABLE_LOOKUP_OPTIONS = new Set(["scope", "include", "exclude", "erroraction", "warningaction", "informationaction", "progressaction", "ea", "wa"]);
const SPACE = /\s/;
const PUNCTUATION = /[;|\n\r{}()=&]/;
// PowerShell accepts unambiguous parameter prefixes and these Unicode dashes.
const JOB_OPTION = /^[-\u2013\u2014\u2015]as(?:j(?:o(?:b)?)?)?(?::|$)/i;
const PARAMETER_DASH = /^[-\u2013\u2014\u2015]/;
const TYPE_CHARACTER = /[\w.,+]/;
const STATEMENT_LABEL = /^:[\w]+$/;
const SIMPLE_VARIABLE = /^\$(?:[\w:]+|\{(?:[^`{}]|`[\s\S])+\})(?:\.[\w]+|\[[\w$]+\])*$/;
const STREAM_REDIRECT = /^[1-6*]?>$/;
const STREAM_NUMBER = /^[1-6]$/;
const OPAQUE_MEMBER = /(?:\.|::)(?:Start(?:New|Job|\.Invoke)?|Invoke[\w]*|DynamicInvoke|BeginInvoke|GetSteppablePipeline|ExpandString|Run(?:Async)?|Exec|Continue|Shell(?:Execute(?:Ex)?)?)$/i;

interface Token { value: string; quoted: boolean; dynamic: boolean; operator: boolean; start: number; end: number }

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

function isAsyncOption(value: string): boolean {
	if (!PARAMETER_DASH.test(value)) return false;
	const colon = value.indexOf(":"), end = colon < 0 ? value.length : colon;
	return end >= 4 && end <= 13 && "asynchronous".startsWith(value.slice(1, end).toLowerCase());
}

function isArgumentSuffix(tokens: readonly Token[], index: number): boolean {
	const previous = tokens[index - 1];
	return previous?.operator === true && previous.value === "=" && previous.end === tokens[index]!.start;
}

function isStreamMerge(tokens: readonly Token[], index: number): boolean {
	const token = tokens[index]!, previous = tokens[index - 1], next = tokens[index + 1];
	return token.operator && token.value === "&" && previous !== undefined && next !== undefined
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
 * Opaque scripts still pass through permission review and exact final authorization.
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
			let depth = 1; i += 2;
			while (i < command.length && depth) {
				if (command.startsWith("<#", i)) { if (++depth > 16) return UNCERTAIN; i += 2; }
				else if (command.startsWith("#>", i)) { depth--; i += 2; }
				else i++;
			}
			if (depth) return UNCERTAIN;
			continue;
		}
		if (PUNCTUATION.test(ch)) { tokens.push({ value: ch, quoted: false, dynamic: false, operator: true, start, end: ++i }); continue; }
		if (SPACE.test(ch)) { i++; continue; }
		if (ch === "@" && (command[i + 1] === "'" || command[i + 1] === '"')) return UNCERTAIN;
		let value = "", quoted = false, dynamic = false, span = i;
		while (i < command.length && !SPACE.test(command[i]!) && !PUNCTUATION.test(command[i]!)) {
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
			value += command.slice(span, i - 1);
			quoted = true;
			span = i;
			let closed = false;
			while (i < command.length) {
				const q = command[i++]!;
				if (q === c) {
					value += command.slice(span, i - 1);
					if (c === "'" && command[i] === "'") { value += "'"; i++; span = i; continue; }
					span = i;
					closed = true; break;
				}
				if (c === '"' && q === "`") { if (i >= command.length) return UNCERTAIN; value += command.slice(span, i - 1) + command[i++]!; span = i; continue; }
				if (c === '"' && q === "$") {
					// Do not hide executable subexpressions inside expandable strings.
					if (command[i] === "(") return UNCERTAIN;
					dynamic = true;
				}
			}
			if (!closed) return UNCERTAIN;
		}
		value += command.slice(span, i);
		if (value || quoted) tokens.push({ value, quoted, dynamic, operator: false, start, end: i });
	}

	let head = true, assignable = false, equalsData = false, controlBlock = false, paramBlock = false;
	let doBlock = false, afterDo = false, doCondition = false;
	// Low bits: 0 paren, 1 control block, 2 hash key, 3 hash value, 4 block argument, 5 param list.
	// 6 is a do body, 7 its trailing while/until condition.
	// Flag 8 restores an enclosing control statement after its condition parentheses.
	// Primitive call-owned stack, capped at MAX_NESTING and never retained.
	const contexts: number[] = [];
	for (let i = 0; i < tokens.length; i++) {
		const token = tokens[i]!, value = token.value;
		if (token.operator) {
			if (value === "=") {
				head = assignable; equalsData = !assignable; controlBlock = false; paramBlock = false;
				if (assignable && contexts.at(-1) === 2) contexts[contexts.length - 1] = 3;
				assignable = false; continue;
			}
			assignable = false; equalsData = false;
			if (value === "(" || value === "{") {
				if (contexts.length === MAX_NESTING) return UNCERTAIN;
				const previous = tokens[i - 1];
				contexts.push(value === "(" ? (doCondition ? 7 : paramBlock ? 5 : controlBlock ? 8 : 0) : previous?.value === "@" && !previous.quoted && previous.end === token.start ? 2 : doBlock ? 6 : controlBlock ? 1 : 4);
				head = true; controlBlock = false; paramBlock = false; doBlock = false; doCondition = false; continue;
			}
			if (value === ")" || value === "}") {
				const context = contexts.pop();
				if (context === undefined || (value === ")") !== ((context & 7) === 0 || context === 5 || context === 7)) return UNCERTAIN;
				head = context === 1 || context === 5 || context === 6 || context === 7;
				controlBlock = (context & 8) !== 0; paramBlock = false; afterDo = context === 6; continue;
			}
			if (value !== "\n" && value !== "\r") controlBlock = false;
			if ((value === ";" || value === "\n" || value === "\r") && (contexts.at(-1) === 2 || contexts.at(-1) === 3)) contexts[contexts.length - 1] = 2;
			if (value === "&") {
				const next = tokens[i + 1];
				if (isStreamMerge(tokens, i)) { i++; continue; }
				if (next?.operator && next.value === "&" && next.start === token.end) { i++; head = true; continue; }
				if (!head) return BACKGROUND;
				const target = tokens[i + 1];
				if (!target || target.dynamic || target.value === "(") return refusal("SHELL_DYNAMIC_EXECUTABLE", "the call operator requires a literal executable or script block");
			} else head = true;
			continue;
		}
		const dataPiece = equalsData && isArgumentSuffix(tokens, i);
		equalsData = false;
		// Ambient defaults can silently bind AsJob/Asynchronous on later commands.
		if (token.dynamic && command[token.start] !== "'" && command[token.start] !== '"' && DEFAULT_PARAMETERS.test(value)) return UNCERTAIN;
		if (command[token.start] !== "'" && command[token.start] !== '"' && SESSION_STATE.test(value)) return UNCERTAIN;
		if (!dataPiece && !token.quoted && (JOB_OPTION.test(value) || isAsyncOption(value))) return BACKGROUND;
		// Splat contents can carry job switches even before a literal parameter.
		// No local variable/dataflow evaluation is performed by this filter.
		if (!dataPiece && !token.quoted && token.dynamic && value.startsWith("@") && value.length > 1) return refusal("SHELL_UNINSPECTABLE", "splatted PowerShell arguments may hide lifecycle options; pass explicit arguments");
		// Known launcher/evaluator members cannot prove ownership. Inspect argument
		// positions too; dynamic member names must not hide these same entrypoints.
		if (command[token.start] !== "'" && command[token.start] !== '"' && tokens[i + 1]?.operator && tokens[i + 1]?.value === "(" && token.end === tokens[i + 1]?.start) {
			if (OPAQUE_MEMBER.test(value)) return refusal("SHELL_UNINSPECTABLE", "launcher or evaluator member ownership cannot be verified; use a literal foreground command (Start-Process requires -Wait)");
			if (token.dynamic && value !== "$" && value !== "@" && !isSimpleVariable(value)) return UNCERTAIN;
		}
		if (!head) continue;
		head = false;
		if (contexts.at(-1) === 2) { assignable = true; continue; }
		// Attribute constructors can hide parameter defaults behind further parens.
		if (contexts.at(-1) === 5 && value.startsWith("[") && !isSimpleVariable(value)) return UNCERTAIN;
		if (!token.quoted && value.startsWith(":")) {
			if (!STATEMENT_LABEL.test(value)) return UNCERTAIN;
			head = true; continue;
		}
		// A quoted expression is data unless preceded by PowerShell's call operator.
		if ((command[token.start] === "'" || command[token.start] === '"') && tokens[i - 1]?.value !== "&") continue;
		if (token.dynamic) {
			// A variable/member expression is not a Bash executable position.
			if (isSimpleVariable(value)) { assignable = true; continue; }
			if ((value.startsWith("++") || value.startsWith("--")) && isSimpleVariable(value.slice(2))) continue;
			if ((value.endsWith("++") || value.endsWith("--")) && isSimpleVariable(value.slice(0, -2))) continue;
			if (value === "$" || (value === "@" && (tokens[i + 1]?.value === "(" || tokens[i + 1]?.value === "{"))) continue;
			return UNCERTAIN;
		}
		const name = value.slice(Math.max(value.lastIndexOf("/"), value.lastIndexOf("\\")) + 1).toLowerCase().replace(/\.exe$/, "");
		controlBlock = !token.quoted && CONTROL_BLOCK.has(name);
		paramBlock = !token.quoted && name === "param";
		doBlock = !token.quoted && name === "do";
		doCondition = afterDo && !token.quoted && (name === "while" || name === "until"); afterDo = false;
		if (!token.quoted && (name === "return" || name === "throw" || name === "exit")) { head = true; continue; }
		if (DETACHED.has(name)) return BACKGROUND;
		if (LAUNCHERS.has(name) || name === ".") return UNCERTAIN;
		if (name === "get-variable" || name === "gv") {
			let literalName = false;
			for (let j = i + 1; j < tokens.length; j++) {
				let arg = tokens[j]!;
				if (arg.operator) { if (arg.value === "(" || arg.value === "{") return UNCERTAIN; break; }
				if (arg.dynamic || DEFAULT_PARAMETERS.test(arg.value)) return UNCERTAIN;
				const raw = command.slice(arg.start, arg.end), colon = raw.indexOf(":"), option = raw.slice(1, colon < 0 ? raw.length : colon).toLowerCase();
				let target = arg.value;
				if (PARAMETER_DASH.test(raw)) {
					if (VARIABLE_LOOKUP_FLAGS.has(option)) continue;
					const named = !!option && "name".startsWith(option);
					if (!named && !VARIABLE_LOOKUP_OPTIONS.has(option)) return UNCERTAIN;
					if (colon < 0) { arg = tokens[++j]!; if (!arg || arg.operator || arg.dynamic) return UNCERTAIN; target = arg.value; }
					else target = arg.value.slice(arg.value.indexOf(":") + 1);
					if (DEFAULT_PARAMETERS.test(target)) return UNCERTAIN;
					if (!named) continue;
				}
				if (!target || VARIABLE_WILDCARD.test(target)) return UNCERTAIN;
				literalName = true;
			}
			if (!literalName) return UNCERTAIN;
		}
		const variableMutation = VARIABLE_MUTATORS.has(name);
		if (PROVIDER_MUTATORS.has(name) || variableMutation) {
			for (let j = i + 1; j < tokens.length; j++) {
				const arg = tokens[j]!;
				if (arg.operator && arg.value === "=") continue;
				if (arg.operator && (arg.value === "(" || arg.value === "{")) return UNCERTAIN;
				if (arg.operator) break;
				if (arg.dynamic || arg.value === "--%" || EXECUTABLE_PROVIDER.test(arg.value)) return UNCERTAIN;
				if (variableMutation && DEFAULT_PARAMETERS.test(arg.value)) return UNCERTAIN;
			}
		}
		if (name === "set-service") {
			for (let j = i + 1; j < tokens.length; j++) {
				const arg = tokens[j]!;
				if (arg.operator && arg.value === "=") continue;
				if (arg.operator && (arg.value === "(" || arg.value === "{")) return UNCERTAIN;
				if (arg.operator) break;
				if (arg.value === "--%") return UNCERTAIN;
				if (isArgumentSuffix(tokens, j)) continue;
				const raw = command.slice(arg.start, arg.end), colon = raw.indexOf(":"), option = raw.slice(1, colon < 0 ? raw.length : colon).toLowerCase();
				if (!PARAMETER_DASH.test(raw) || !option || !"status".startsWith(option)) continue;
				const status = colon < 0 ? tokens[++j] : arg;
				if (!status || status.operator || status.dynamic) return UNCERTAIN;
				const state = (colon < 0 ? status.value : status.value.slice(status.value.indexOf(":") + 1)).toLowerCase();
				if (state !== "stopped" && state !== "paused") return BACKGROUND;
			}
		}
		if (PROCESS.has(name)) {
			let wait = false;
			for (let j = i + 1; j < tokens.length; j++) {
				const arg = tokens[j]!;
				if (isStreamMerge(tokens, j)) { j++; continue; }
				if (arg.operator && arg.value === "=") continue;
				if (arg.operator) break;
				if (arg.dynamic) return UNCERTAIN;
				if (!arg.quoted && arg.value === "--%") return UNCERTAIN;
				if (!isArgumentSuffix(tokens, j) && command.slice(arg.start, arg.end).toLowerCase() === "-wait") wait = true;
				if (!isArgumentSuffix(tokens, j) && !arg.quoted && arg.value.toLowerCase().startsWith("-wait:")) return UNCERTAIN;
			}
			if (!wait) return BACKGROUND;
		}
		if (BASH.has(name)) {
			const flag = tokens[i + 1], script = tokens[i + 2];
			if (flag?.value !== "-c" || !script?.quoted || script.dynamic) return UNCERTAIN;
			const reason = inspectBashResourceLifecycle({ command: script.value });
			if (reason) return reason;
		}
		if (name === "docker" || name === "pm2" || name === "systemctl" || name === "service") {
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
