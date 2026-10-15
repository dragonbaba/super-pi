import { inspectBashResourceLifecycle } from "./core.ts";

const MAX_CHARS = 128 * 1024;
const MAX_TOKENS = 2048;
const BASH = new Set(["bash", "sh", "zsh", "dash", "ksh", "fish"]);
const LAUNCHERS = new Set(["powershell", "pwsh", "cmd", "invoke-expression", "iex", "invoke-command", "icm", "set-alias", "new-alias", "sal", "nal", "function", "filter"]);
const DETACHED = new Set(["start-job", "sajb", "start-threadjob", "start-service", "sasv", "restart-service", "nohup", "disown", "setsid", "daemonize"]);
const PROCESS = new Set(["start-process", "start", "saps"]);
const SPACE = /\s/;
const PUNCTUATION = /[;|\n\r{}()=&]/;
const JOB_OPTION = /^-asjob(?::|$)/i;
// Bracket delimiters are excluded from identifier spans: repeated casts cannot
// be repartitioned exponentially when a malformed variable follows them.
const SIMPLE_VARIABLE = /^(?:\[[\w.,+]+(?:\[[\w.,]*\])?\])*\$[\w:]+(?:\.[\w]+|\[[\w$]+\])*$/;
const STREAM_REDIRECT = /^[1-6*]?>$/;
const STREAM_NUMBER = /^[1-6]$/;
const OPAQUE_MEMBER = /(?:\.|::)(?:Start(?:New|Job|\.Invoke)?|Invoke(?:Script|Member|Expression)?|DynamicInvoke|BeginInvoke|ExpandString|Run(?:Async)?|Exec|ShellExecute(?:Ex)?)$/i;

interface Token { value: string; quoted: boolean; dynamic: boolean; operator: boolean; start: number; end: number }

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

	let head = true;
	for (let i = 0; i < tokens.length; i++) {
		const token = tokens[i]!, value = token.value;
		if (token.operator) {
			if (value === "&") {
				const next = tokens[i + 1];
				if (isStreamMerge(tokens, i)) { i++; continue; }
				if (next?.operator && next.value === "&" && next.start === token.end) { i++; head = true; continue; }
				if (!head) return BACKGROUND;
				const target = tokens[i + 1];
				if (!target || target.dynamic || target.value === "(") return refusal("SHELL_DYNAMIC_EXECUTABLE", "the call operator requires a literal executable or script block");
			} else head = value !== ")";
			continue;
		}
		if (!token.quoted && JOB_OPTION.test(value)) return BACKGROUND;
		// Splat contents can carry job switches even before a literal parameter.
		// No local variable/dataflow evaluation is performed by this filter.
		if (!token.quoted && token.dynamic && value.startsWith("@") && value.length > 1) return refusal("SHELL_UNINSPECTABLE", "splatted PowerShell arguments may hide lifecycle options; pass explicit arguments");
		// Known launcher/evaluator members cannot prove ownership. Inspect argument
		// positions too; dynamic member names must not hide these same entrypoints.
		if (command[token.start] !== "'" && command[token.start] !== '"' && tokens[i + 1]?.operator && tokens[i + 1]?.value === "(") {
			if (OPAQUE_MEMBER.test(value)) return refusal("SHELL_UNINSPECTABLE", "launcher or evaluator member ownership cannot be verified; use a literal foreground command (Start-Process requires -Wait)");
			if (token.dynamic && value !== "$" && !SIMPLE_VARIABLE.test(value)) return UNCERTAIN;
		}
		if (!head) continue;
		head = false;
		// A quoted expression is data unless preceded by PowerShell's call operator.
		if ((command[token.start] === "'" || command[token.start] === '"') && tokens[i - 1]?.value !== "&") continue;
		if (token.dynamic) {
			// A variable/member expression is not a Bash executable position.
			if (SIMPLE_VARIABLE.test(value) || value === "$") continue;
			return UNCERTAIN;
		}
		const name = value.slice(Math.max(value.lastIndexOf("/"), value.lastIndexOf("\\")) + 1).toLowerCase().replace(/\.exe$/, "");
		if (!token.quoted && (name === "return" || name === "throw")) { head = true; continue; }
		if (DETACHED.has(name)) return BACKGROUND;
		if (LAUNCHERS.has(name) || name === ".") return UNCERTAIN;
		if (PROCESS.has(name)) {
			let wait = false;
			for (let j = i + 1; j < tokens.length; j++) {
				const arg = tokens[j]!;
				if (isStreamMerge(tokens, j)) { j++; continue; }
				if (arg.operator) break;
				if (arg.dynamic) return UNCERTAIN;
				if (!arg.quoted && arg.value === "--%") return UNCERTAIN;
				if (command.slice(arg.start, arg.end).toLowerCase() === "-wait") wait = true;
				if (!arg.quoted && arg.value.toLowerCase().startsWith("-wait:")) return UNCERTAIN;
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
				if (arg.operator) break;
				if (arg.dynamic) return UNCERTAIN;
				end = arg.end;
			}
			if (inspectBashResourceLifecycle({ command: command.slice(token.start, end) })) return BACKGROUND;
		}
	}
	return undefined;
}
