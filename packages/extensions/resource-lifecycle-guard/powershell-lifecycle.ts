import { inspectBashResourceLifecycle } from "./core.ts";

const MAX_CHARS = 128 * 1024;
const MAX_TOKENS = 2048;
const MAX_NESTING = 64;
const BASH = new Set(["bash", "sh", "zsh", "dash", "ksh", "fish"]);
const LAUNCHERS = new Set(["powershell", "pwsh", "cmd", "invoke-expression", "iex", "invoke-command", "icm", "invoke-cimmethod", "icim", "invoke-wmimethod", "iwmi", "invoke-item", "ii", "set-alias", "new-alias", "import-alias", "ipal", "sal", "nal", "function", "filter", "class", "enum", "workflow", "configuration"]);
const DETACHED = new Set(["start-job", "sajb", "start-threadjob", "start-service", "sasv", "restart-service", "resume-service", "rsv", "start-scheduledtask", "register-scheduledjob", "set-scheduledjob", "register-scheduledtask", "set-scheduledtask", "nohup", "disown", "setsid", "daemonize"]);
const PROCESS = new Set(["start-process", "start", "saps"]);
const SERVICE_STARTERS = new Set(["start-service", "sasv", "restart-service", "resume-service", "rsv"]);
const CONTROL_BLOCK = new Set(["if", "elseif", "else", "for", "foreach", "while", "do", "switch", "try", "catch", "finally", "trap", "begin", "process", "end", "clean", "dynamicparam", "data"]);
const PROVIDER_MUTATORS = new Set(["set-item", "si", "new-item", "ni", "copy-item", "cpi", "cp", "copy", "move-item", "mi", "mv", "move", "rename-item", "rni", "ren", "set-location", "sl", "cd", "chdir", "push-location", "pushd"]);
const EXECUTABLE_PROVIDER = /(?:^|[:,])(?:[^:,]*\\)?(?:alias|function|variable):/i;
const EXECUTABLE_VARIABLE = /\$(?:\{)?(?:alias|function):/i;
// Braced names preserve raw escapes in the lexer. Control escapes are not their
// literal letter; retaining those markers keeps them distinct from capability names.
const VARIABLE_ESCAPE = /`([^0abefnrtvu])/g;
const VARIABLE_MUTATORS = new Set(["set-variable", "sv", "set", "new-variable", "nv"]);
const DEFAULT_PARAMETERS = /\bpsdefaultparametervalues\b/i;
const SESSION_STATE = /(?:\.|::|\[)(?:sessionstate|sessionstateproxy|psvariable)\b/i;
const PROVIDER_READERS = new Set(["get-item", "gi", "get-childitem", "gci", "ls", "dir"]);
const VARIABLE_PROVIDER = /(?:^|[:,])(?:[^:,]*\\)?variable:/i;
const VARIABLE_WILDCARD = /[*?\[]/;
const VARIABLE_LOOKUP_FLAGS = new Set(["valueonly", "verbose", "debug"]);
const VARIABLE_REFERENCE_OPTIONS = new Set(["name", "errorvariable", "warningvariable", "informationvariable", "outvariable", "pipelinevariable"]);
const VARIABLE_OUTPUT_OPTIONS = new Set(["errorvariable", "warningvariable", "informationvariable", "outvariable", "pipelinevariable"]);
const VARIABLE_LOOKUP_PARAMETERS = ["name", "valueonly", "include", "exclude", "scope", "verbose", "debug", "erroraction", "warningaction", "informationaction", "progressaction", "errorvariable", "warningvariable", "informationvariable", "outvariable", "outbuffer", "pipelinevariable"];
const VARIABLE_LOOKUP_ALIASES = new Map([["vb", "verbose"], ["db", "debug"], ["ea", "erroraction"], ["wa", "warningaction"], ["infa", "informationaction"], ["proga", "progressaction"], ["ev", "errorvariable"], ["wv", "warningvariable"], ["iv", "informationvariable"], ["ov", "outvariable"], ["ob", "outbuffer"], ["pv", "pipelinevariable"]]);
const ITEM_READER_PARAMETERS = ["path", "literalpath", "filter", "include", "exclude", "force", "credential", "stream", ...VARIABLE_LOOKUP_PARAMETERS.slice(5)];
const CHILD_READER_PARAMETERS = ["path", "literalpath", "filter", "include", "exclude", "recurse", "depth", "force", "name", "attributes", "directory", "file", "hidden", "readonly", "system", "followsymlink", "usestat", ...VARIABLE_LOOKUP_PARAMETERS.slice(5)];
const PROVIDER_READER_FLAGS = new Set(["recurse", "force", "name", "directory", "file", "hidden", "readonly", "system", "followsymlink", "usestat", "verbose", "debug"]);
const FILESYSTEM_STRING = /^"(?:Microsoft\.PowerShell\.Core\\)?FileSystem::[^"\r\n]*"$/i;
const FOR_EACH = new Set(["foreach-object", "foreach", "%"]);
const FOR_EACH_PARAMETERS = ["inputobject", "begin", "process", "end", "remainingscripts", "membername", "argumentlist", "parallel", "throttlelimit", "timeoutseconds", "asjob", "usenewrunspace", "whatif", "confirm", ...VARIABLE_LOOKUP_PARAMETERS.slice(5)];
const FOR_EACH_FLAGS = new Set(["asjob", "usenewrunspace", "whatif", "confirm", "verbose", "debug"]);
const FOR_EACH_BLOCKS = new Set(["begin", "process", "end", "remainingscripts", "parallel"]);
const OBJECT_PARAMETERS = ["typename", "comobject", "argumentlist", "strict", "property", ...VARIABLE_LOOKUP_PARAMETERS.slice(5)];
const OBJECT_FLAGS = new Set(["strict", "verbose", "debug"]);
const PROCESS_PARAMETERS = ["filepath", "argumentlist", "credential", "workingdirectory", "loaduserprofile", "nonewwindow", "passthru", "redirectstandarderror", "redirectstandardinput", "redirectstandardoutput", "verb", "windowstyle", "wait", "usenewenvironment", "environment", "whatif", "confirm", ...VARIABLE_LOOKUP_PARAMETERS.slice(5)];
const BITS_START_PARAMETERS = ["asynchronous", "dynamic", "customheaderswriteonly", "authentication", "credential", "description", "httpmethod", "destination", "displayname", "priority", "transferpolicy", "aclflags", "securityflags", "usestoredcredential", "proxyauthentication", "proxybypass", "proxycredential", "proxylist", "proxyusage", "retryinterval", "retrytimeout", "maxdownloadtime", "source", "suspended", "transfertype", "customheaders", "notifyflags", "notifycmdline", "certstorelocation", "certstorename", "certhash", "whatif", "confirm", ...VARIABLE_LOOKUP_PARAMETERS.slice(5)];
const BITS_RESUME_PARAMETERS = ["bitsjob", "asynchronous", "whatif", "confirm", ...VARIABLE_LOOKUP_PARAMETERS.slice(5)];
const WMI_PARAMETERS = ["class", "recurse", "property", "filter", "amended", "directread", "list", "query", "asjob", "impersonation", "authentication", "locale", "enableallprivileges", "authority", "credential", "throttlelimit", "computername", "namespace", ...VARIABLE_LOOKUP_PARAMETERS.slice(5)];
const WMI_SCHEMA_WORD = /^(?:meta_class|classdefsonly|schemaonly)$/i;
const WORD_CHARACTER = /[\w]/;
const CONTENT_MUTATORS = new Set(["set-content", "sc", "add-content", "ac", "clear-content", "clc"]);
const CONTENT_PARAMETERS = ["value", "passthru", "path", "literalpath", "filter", "include", "exclude", "force", "credential", "whatif", "confirm", "usetransaction", "nonewline", "encoding", "asbytestream", "stream", ...VARIABLE_LOOKUP_PARAMETERS.slice(5)];
const CONTENT_FLAGS = new Set(["passthru", "force", "whatif", "confirm", "usetransaction", "nonewline", "asbytestream", "verbose", "debug"]);
const CONTENT_READERS = new Set(["get-content", "gc", "cat", "type"]);
const CONTENT_READER_PARAMETERS = ["readcount", "totalcount", "tail", "path", "literalpath", "filter", "include", "exclude", "force", "credential", "usetransaction", "delimiter", "wait", "raw", "encoding", "asbytestream", "stream", ...VARIABLE_LOOKUP_PARAMETERS.slice(5)];
const CONTENT_READER_FLAGS = new Set(["force", "usetransaction", "wait", "raw", "asbytestream", "verbose", "debug"]);
const SERVICE_START_PARAMETERS = ["name", "inputobject", "passthru", "displayname", "include", "exclude", "force", "whatif", "confirm", ...VARIABLE_LOOKUP_PARAMETERS.slice(5)];
const SERVICE_SET_PARAMETERS = ["name", "inputobject", "displayname", "credential", "description", "startuptype", "securitydescriptorsddl", "status", "force", "passthru", "computername", "whatif", "confirm", ...VARIABLE_LOOKUP_PARAMETERS.slice(5)];
const TEE_PARAMETERS = ["inputobject", "filepath", "literalpath", "append", "encoding", "variable", ...VARIABLE_LOOKUP_PARAMETERS.slice(5)];
const WMI_JOB_COMMANDS = new Set(["get-wmiobject", "gwmi", "remove-wmiobject", "rwmi", "set-wmiinstance", "swmi"]);
const COMPUTER_JOB_COMMANDS = new Set(["restart-computer", "stop-computer", "test-connection"]);
// Native metadata: these are the names competing with the AsJob prefix. Other
// parameters do not affect its binding and retain ordinary argument inspection.
const WMI_JOB_PARAMETERS = ["asjob", "authentication", "authority", "arguments"];
const COMPUTER_JOB_PARAMETERS = ["asjob"];
const WMI_CAPABILITY = /(?:^|\[|:)(?:wmiclass|WbemScripting\.SWbemLocator(?:\.1)?|(?:(?:System\.)?Management\.)?ManagementClass)(?:\]|,|$)/i;
const SCRIPT_BLOCK_COMPILER = /\[(?:System\.Management\.Automation\.)?scriptblock\]::Create$/i;
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
const OPAQUE_MEMBER = /(?:\.|::)(?:Start(?:New|Job|Service|\.Invoke)?|ResumeService|Invoke[\w]*|DynamicInvoke|BeginInvoke|GetSteppablePipeline|GetScriptBlock|NewScriptBlock|ExpandString|Run(?:Async)?|Exec|ExecuteShellCommand|Continue|Shell(?:Execute(?:Ex)?)?)$/i;

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

/** AssemblyName selects native assembly loading; other Add-Type sets can compile code. */
function inspectAddType(tokens: readonly Token[], start: number, command: string): string | undefined {
	let depth = 0, assemblyName = false;
	for (let j = start; j < tokens.length; j++) {
		const arg = tokens[j]!;
		if (arg.operator && arg.value === "=") continue;
		if (arg.operator) {
			if (arg.value === "(" || arg.value === "{") { if (++depth > MAX_NESTING) return UNCERTAIN; }
			else if (arg.value === ")" || arg.value === "}") { if (!depth) break; depth--; }
			else if (!depth) break;
			continue;
		}
		if (depth || isArgumentSuffix(tokens, j)) continue;
		if (!arg.quoted && (arg.value === "--" || arg.value === "--%")) break;
		if (isFileRedirect(tokens, j, command)) { if (tokens[j + 1] && !tokens[j + 1]!.operator) j++; continue; }
		const raw = command.slice(arg.start, arg.end), colon = raw.indexOf(":"), option = raw.slice(1, colon < 0 ? raw.length : colon).toLowerCase();
		// Verified 5.1/7.6 metadata: AssemblyName is the only parameter starting A.
		if (!PARAMETER_DASH.test(raw) || !option || !"assemblyname".startsWith(option)) continue;
		const separate = colon < 0 || colon === raw.length - 1, target = separate ? tokens[++j] : arg;
		if (!target || target.operator || target.dynamic || !(separate ? target.value : target.value.slice(target.value.indexOf(":") + 1))) return UNCERTAIN;
		assemblyName = true;
	}
	return assemblyName ? undefined : UNCERTAIN;
}

/** Literal WQL may still return class definitions. Quoted filter values are data. */
function hasWmiSchemaQuery(query: string): boolean {
	for (let i = 0; i < query.length;) {
		const c = query[i++]!;
		if (c === "'" || c === '"') {
			let closed = false;
			while (i < query.length) {
				const q = query[i++]!;
				if (q === "\\") { i++; continue; }
				if (q !== c) continue;
				if (query[i] === c) { i++; continue; }
				closed = true; break;
			}
			if (!closed) return true;
		} else if (WORD_CHARACTER.test(c)) {
			const start = i - 1;
			while (i < query.length && WORD_CHARACTER.test(query[i]!)) i++;
			if (WMI_SCHEMA_WORD.test(query.slice(start, i))) return true;
		}
	}
	return false;
}

/** Content data may be dynamic, but provider identity must be inspectable. */
function inspectContentTargets(tokens: readonly Token[], start: number, command: string, reader: boolean, providerParameters?: readonly string[]): string | undefined {
	let depth = 0, pathSeen = false, parameter: string | undefined;
	const parameters = providerParameters ?? (reader ? CONTENT_READER_PARAMETERS : CONTENT_PARAMETERS);
	const flags = providerParameters ? PROVIDER_READER_FLAGS : reader ? CONTENT_READER_FLAGS : CONTENT_FLAGS;
	const pathRefusal = providerParameters ? PROVIDER_PATH : UNCERTAIN;
	for (let j = start; j < tokens.length; j++) {
		const arg = tokens[j]!;
		if (arg.operator && arg.value === "=") continue;
		if (arg.operator) {
			if (arg.value === "(" || arg.value === "{") {
				if (!depth) {
					if (parameter === "path" || parameter === "literalpath" || (!parameter && !pathSeen)) return pathRefusal;
					parameter = undefined;
				}
				if (++depth > MAX_NESTING) return UNCERTAIN;
			} else if (arg.value === ")" || arg.value === "}") { if (!depth) break; depth--; }
			else if (!depth) break;
			continue;
		}
		if (depth || isArgumentSuffix(tokens, j)) continue;
		let raw = command.slice(arg.start, arg.end), target = arg.value;
		const colon = raw.indexOf(":");
		if (!parameter && PARAMETER_DASH.test(raw) && (!arg.quoted || colon >= 0)) {
			const option = raw.slice(1, colon < 0 ? raw.length : colon).toLowerCase();
			parameter = option === "lp" || option === "pspath" ? "literalpath"
				: reader && !providerParameters && (option === "first" || option === "head") ? "totalcount"
				: reader && !providerParameters && option === "last" ? "tail" : lookupOption(option, parameters);
			if (!parameter) return UNCERTAIN;
			if (flags.has(parameter) && colon !== raw.length - 1) { parameter = undefined; continue; }
			if (colon < 0 || colon === raw.length - 1) continue;
			target = arg.value.slice(arg.value.indexOf(":") + 1); raw = raw.slice(colon + 1);
		}
		if (parameter === "path" || parameter === "literalpath" || (!parameter && !pathSeen)) {
			if ((providerParameters ? VARIABLE_PROVIDER : EXECUTABLE_PROVIDER).test(target) || (arg.dynamic && !FILESYSTEM_STRING.test(raw))) return pathRefusal;
			pathSeen = true;
		}
		parameter = undefined;
	}
	// Path can bind from pipeline object properties; require an explicit target
	// rather than guessing the provider from uninspected upstream data.
	return pathSeen || providerParameters ? undefined : UNCERTAIN;
}

/** Tee's Variable parameter is a variable sink, separate from common -OutVariable. */
function inspectTeeVariable(tokens: readonly Token[], start: number, command: string): string | undefined {
	let depth = 0;
	for (let j = start; j < tokens.length; j++) {
		const arg = tokens[j]!;
		if (arg.operator && arg.value === "=") continue;
		if (arg.operator) {
			if (arg.value === "(" || arg.value === "{") { if (++depth > MAX_NESTING) return UNCERTAIN; }
			else if (arg.value === ")" || arg.value === "}") { if (!depth) break; depth--; }
			else if (!depth) break;
			continue;
		}
		if (depth || isArgumentSuffix(tokens, j)) continue;
		const raw = command.slice(arg.start, arg.end), colon = raw.indexOf(":");
		if (!PARAMETER_DASH.test(raw)) continue;
		const option = raw.slice(1, colon < 0 ? raw.length : colon).toLowerCase();
		const parameter = option === "path" ? "filepath" : option === "lp" || option === "pspath" ? "literalpath" : lookupOption(option, TEE_PARAMETERS);
		if (!parameter) return UNCERTAIN;
		if (parameter !== "variable") continue;
		const separate = colon < 0 || colon === raw.length - 1, target = separate ? tokens[++j] : arg;
		if (!target || target.operator || target.dynamic || DEFAULT_PARAMETERS.test(separate ? target.value : target.value.slice(target.value.indexOf(":") + 1))) return UNCERTAIN;
	}
	return undefined;
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

/** Explicit generic method arguments do not change the member being invoked. */
function isOpaqueMember(value: string): boolean {
	let end = value.length;
	if (value[end - 1] === "]") {
		let depth = 0;
		for (let i = end - 1; i >= 0; i--) {
			if (value[i] === "]") { if (++depth > MAX_NESTING) return true; }
			else if (value[i] === "[" && --depth === 0) { end = i; break; }
		}
	}
	return OPAQUE_MEMBER.test(end === value.length ? value : value.slice(0, end));
}

/** New-Object property keys may dispatch methods, not just assign properties. */
function inspectObjectProperties(tokens: readonly Token[], start: number): string | undefined {
	let depth = 1, key = true;
	for (let j = start + 1; j < tokens.length; j++) {
		const arg = tokens[j]!;
		if (arg.operator) {
			if (arg.value === "{" || arg.value === "(") {
				if (key && depth === 1) return UNCERTAIN;
				if (++depth > MAX_NESTING) return UNCERTAIN;
			} else if (arg.value === "}" || arg.value === ")") { if (!--depth) return undefined; }
			else if (depth === 1 && (arg.value === ";" || arg.value === "\n" || arg.value === "\r")) key = true;
			continue;
		}
		if (depth === 1 && key) {
			if (arg.dynamic || isOpaqueMember("." + arg.value)) return UNCERTAIN;
			key = false;
		}
	}
	return UNCERTAIN;
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
const PROVIDER_PATH = "[SHELL_UNINSPECTABLE] PowerShell not executed: this provider path may expose mutable variable handles.\nNext: for file reads, pass a literal path or an explicitly qualified string such as Get-Item -LiteralPath \"FileSystem::$file\" for normal authorization; do not retry the same blocked call.";

/** Type/ProgID identity must be literal; constructor data can stay dynamic. */
function inspectNewObject(tokens: readonly Token[], start: number, command: string): string | undefined {
	let depth = 0, typeSeen = false, parameter: string | undefined;
	for (let j = start; j < tokens.length; j++) {
		const arg = tokens[j]!;
		if (arg.operator && arg.value === "=") continue;
		if (arg.operator) {
			if (arg.value === "(" || arg.value === "{") {
				if (!depth) {
					if (parameter === "typename" || parameter === "comobject" || parameter === "property" || (!parameter && !typeSeen)) return UNCERTAIN;
					parameter = undefined;
				}
				if (++depth > MAX_NESTING) return UNCERTAIN;
			} else if (arg.value === ")" || arg.value === "}") { if (!depth) break; depth--; }
			else if (!depth) break;
			continue;
		}
		if (depth || isArgumentSuffix(tokens, j)) continue;
		const raw = command.slice(arg.start, arg.end), colon = raw.indexOf(":");
		let type = arg.value;
		if (!parameter && PARAMETER_DASH.test(raw) && (!arg.quoted || colon >= 0)) {
			const option = raw.slice(1, colon < 0 ? raw.length : colon).toLowerCase();
			parameter = option === "args" ? "argumentlist" : lookupOption(option, OBJECT_PARAMETERS);
			if (!parameter) return UNCERTAIN;
			if (OBJECT_FLAGS.has(parameter) && colon !== raw.length - 1) { parameter = undefined; continue; }
			if (colon < 0 || colon === raw.length - 1) continue;
			type = arg.value.slice(arg.value.indexOf(":") + 1);
		}
		if (parameter === "typename" || parameter === "comobject" || (!parameter && !typeSeen)) {
			if (!type || arg.dynamic || WMI_CAPABILITY.test(type)) return UNCERTAIN;
			typeSeen = true;
		}
		if (parameter === "property") {
			const next = tokens[j + 1];
			if (type !== "@" || arg.quoted || next?.value !== "{" || next.start !== arg.end) return UNCERTAIN;
			const reason = inspectObjectProperties(tokens, j + 1);
			if (reason) return reason;
		}
		parameter = undefined;
	}
	return undefined;
}

/** ForEach-Object can dispatch methods without parentheses. Inspect its own
 * arguments, leaving literal script blocks to the main bounded token walk. */
function inspectForEach(tokens: readonly Token[], start: number, command: string): string | undefined {
	let depth = 0, memberPending = true, literalArguments = false, parameter: string | undefined;
	for (let j = start; j < tokens.length; j++) {
		const arg = tokens[j]!;
		if (arg.operator && arg.value === "=") continue;
		if (arg.operator) {
			if (arg.value === "(" || arg.value === "{") {
				if (!depth) {
					if (parameter === "membername" || (!parameter && arg.value !== "{") || (parameter && FOR_EACH_BLOCKS.has(parameter) && arg.value !== "{")) return UNCERTAIN;
					if (!parameter || FOR_EACH_BLOCKS.has(parameter)) memberPending = false;
					parameter = undefined;
				}
				if (++depth > MAX_NESTING) return UNCERTAIN;
			} else if (arg.value === ")" || arg.value === "}") { if (!depth) break; depth--; }
			else if (!depth) break;
			continue;
		}
		if (depth || isArgumentSuffix(tokens, j)) continue;
		if (!parameter && !arg.quoted && arg.value === "--") { literalArguments = true; continue; }
		const raw = command.slice(arg.start, arg.end), colon = raw.indexOf(":");
		let member = arg.value;
		if (!literalArguments && !parameter && PARAMETER_DASH.test(raw) && (!arg.quoted || colon >= 0)) {
			parameter = lookupOption(raw.slice(1, colon < 0 ? raw.length : colon).toLowerCase(), FOR_EACH_PARAMETERS);
			if (!parameter) return UNCERTAIN;
			if (parameter === "asjob") {
				if (literalSwitch(tokens, j, command) !== false) return BACKGROUND;
				if (colon === raw.length - 1) j++;
				parameter = undefined; continue;
			}
			if (FOR_EACH_FLAGS.has(parameter) && colon !== raw.length - 1) { parameter = undefined; continue; }
			if (colon < 0 || colon === raw.length - 1) continue;
			member = arg.value.slice(arg.value.indexOf(":") + 1);
		}
		if (parameter === "membername" || (!parameter && memberPending)) {
			if (arg.dynamic || VARIABLE_WILDCARD.test(member) || isOpaqueMember("." + member) || SESSION_STATE.test("." + member)) return UNCERTAIN;
			memberPending = false;
		} else if (parameter && FOR_EACH_BLOCKS.has(parameter)) return UNCERTAIN;
		parameter = undefined;
	}
	return undefined;
}

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
			const end = command.indexOf("#>", i + 2);
			if (end < 0) return UNCERTAIN;
			i = end + 2;
			continue;
		}
		if (PUNCTUATION.test(ch)) { tokens.push({ value: ch, quoted: false, quotedEnd: 0, dynamic: false, operator: true, typeOnly: false, start, end: ++i }); continue; }
		if (SPACE.test(ch)) { i++; continue; }
		if (ch === "@" && (command[i + 1] === "'" || command[i + 1] === '"')) return UNCERTAIN;
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
					// Do not hide executable subexpressions inside expandable strings.
					if (command[i] === "(") return UNCERTAIN;
					dynamic = true;
				}
			}
			if (!closed) return UNCERTAIN;
		}
		value += command.slice(span, i);
		if (value || quoted) tokens.push({ value, quoted, quotedEnd, dynamic, operator: false, typeOnly, start, end: i });
	}

	let head = true, assignable = false, equalsData = false, controlBlock = false, paramBlock = false;
	let doBlock = false, afterDo = false, doCondition = false, foreachBlock = false, argumentData = false;
	// Low bits: 0 paren, 1 control block, 2 hash key, 3 hash value, 4 block argument, 5 param list.
	// 6 is a do body, 7 its trailing while/until condition.
	// Flag 8 restores an enclosing control statement after its condition parentheses.
	// 24/40 are foreach's variable/in states; flag 64 saves enclosing -- argument mode.
	// Primitive call-owned stack, capped at MAX_NESTING and never retained.
	const contexts: number[] = [];
	for (let i = 0; i < tokens.length; i++) {
		const token = tokens[i]!, value = token.value;
		const topIndex = contexts.length - 1, top = contexts[topIndex], contextKind = top === undefined ? undefined : top & 63;
		if (token.operator) {
			if (value === "=") {
				head = assignable; equalsData = !assignable; controlBlock = false; paramBlock = false; foreachBlock = false;
				if (assignable && contextKind === 2) contexts[topIndex] = (top! & 64) | 3;
				assignable = false; continue;
			}
			assignable = false; equalsData = false;
			if (value === "(" || value === "{") {
				if (contexts.length === MAX_NESTING) return UNCERTAIN;
				const previous = tokens[i - 1];
				const kind = value === "(" ? (doCondition ? 7 : paramBlock ? 5 : controlBlock ? foreachBlock ? 24 : 8 : 0) : previous?.value === "@" && !previous.quoted && previous.end === token.start ? 2 : doBlock ? 6 : controlBlock ? 1 : 4;
				contexts.push(kind | (argumentData ? 64 : 0));
				head = true; controlBlock = false; paramBlock = false; doBlock = false; doCondition = false; foreachBlock = false; argumentData = false; continue;
			}
			if (value === ")" || value === "}") {
				const saved = contexts.pop(), context = saved === undefined ? undefined : saved & 63;
				if (context === undefined || (value === ")") !== ((context & 7) === 0 || context === 5 || context === 7)) return UNCERTAIN;
				head = context === 1 || context === 5 || context === 6 || context === 7;
				controlBlock = (context & 8) !== 0; paramBlock = false; foreachBlock = false; afterDo = context === 6; argumentData = (saved! & 64) !== 0; continue;
			}
			if (value !== "\n" && value !== "\r") { controlBlock = false; foreachBlock = false; }
			if ((value === ";" || value === "\n" || value === "\r") && (contextKind === 2 || contextKind === 3)) contexts[topIndex] = (top! & 64) | 2;
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
		if (head) argumentData = false;
		if (!head && !token.quoted && value === "--") { argumentData = true; continue; }
		const dataPiece = equalsData && isArgumentSuffix(tokens, i);
		equalsData = false;
		const variableValue = token.dynamic && value.includes("`") ? value.replace(VARIABLE_ESCAPE, "$1") : value;
		// Ambient defaults can silently bind AsJob/Asynchronous on later commands.
		if (token.dynamic && command[token.start] !== "'" && command[token.start] !== '"' && DEFAULT_PARAMETERS.test(variableValue)) return UNCERTAIN;
		if (token.dynamic && command[token.start] !== "'" && command[token.start] !== '"'
			&& EXECUTABLE_VARIABLE.test(variableValue)) return UNCERTAIN;
		const previous = tokens[i - 1];
		const capabilityExpression = token.dynamic || value.startsWith("[")
			|| ((value.startsWith(".") || value.startsWith("::")) && previous?.operator === true && (previous.value === ")" || previous.value === "}") && previous.end === token.start);
		if (capabilityExpression && command[token.start] !== "'" && command[token.start] !== '"' && SESSION_STATE.test(variableValue)) return UNCERTAIN;
		if (command[token.start] !== "'" && command[token.start] !== '"' && value.startsWith("[") && WMI_CAPABILITY.test(value)) return UNCERTAIN;
		// Common variable-output parameters can install ambient defaults even on
		// otherwise harmless commands; do not evaluate dynamic target names.
		if (!argumentData && !dataPiece && PARAMETER_DASH.test(command[token.start]!) && (!token.quoted || value.includes(":"))) {
			const raw = command.slice(token.start, token.end), colon = raw.indexOf(":");
			const parameter = lookupOption(raw.slice(1, colon < 0 ? raw.length : colon).toLowerCase(), VARIABLE_LOOKUP_PARAMETERS);
			if (parameter && VARIABLE_OUTPUT_OPTIONS.has(parameter)) {
				const separate = colon < 0 || colon === raw.length - 1;
				const target = separate ? tokens[i + 1] : token;
				if (!target || target.operator || target.dynamic || DEFAULT_PARAMETERS.test(target.value)) return UNCERTAIN;
				if (!separate && !target.value.slice(target.value.indexOf(":") + 1)) return UNCERTAIN;
			}
		}
		// Splat contents can carry job switches even before a literal parameter.
		// No local variable/dataflow evaluation is performed by this filter.
		if (!dataPiece && !token.quoted && token.dynamic && value.startsWith("@") && value.length > 1) return refusal("SHELL_UNINSPECTABLE", "splatted PowerShell arguments may hide lifecycle options; pass explicit arguments");
		// Known launcher/evaluator members cannot prove ownership. Inspect argument
		// positions too; dynamic member names must not hide these same entrypoints.
		if (command[token.start] !== "'" && command[token.start] !== '"' && tokens[i + 1]?.operator && tokens[i + 1]?.value === "(" && token.end === tokens[i + 1]?.start) {
			if (isOpaqueMember(value) || SCRIPT_BLOCK_COMPILER.test(value)) return refusal("SHELL_UNINSPECTABLE", "launcher or evaluator member ownership cannot be verified; use a literal foreground command (Start-Process requires -Wait)");
			if (token.dynamic && value !== "$" && value !== "@" && (value.includes("::") || !isSimpleVariable(value))) return UNCERTAIN;
		}
		if (contextKind === 40 && !token.quoted && value.toLowerCase() === "in") { contexts[topIndex] = (top! & 64) | 8; head = true; assignable = false; continue; }
		if (!head) continue;
		head = false;
		if (contextKind === 2) { assignable = true; continue; }
		if (token.typeOnly) { head = true; continue; }
		// Attribute constructors can hide parameter defaults behind further parens.
		if (contextKind === 5 && value.startsWith("[") && !isSimpleVariable(value)) return UNCERTAIN;
		if (!token.quoted && value.startsWith(":")) {
			if (!STATEMENT_LABEL.test(value)) return UNCERTAIN;
			head = true; continue;
		}
		// A quoted expression is data unless preceded by PowerShell's call operator.
		if ((command[token.start] === "'" || command[token.start] === '"') && tokens[i - 1]?.value !== "&") continue;
		if (token.dynamic) {
			// A variable/member expression is not a Bash executable position.
			if (isSimpleVariable(value)) { assignable = true; if (contextKind === 24) contexts[topIndex] = (top! & 64) | 40; continue; }
			if ((value.startsWith("++") || value.startsWith("--")) && isSimpleVariable(value.slice(2))) continue;
			if ((value.endsWith("++") || value.endsWith("--")) && isSimpleVariable(value.slice(0, -2))) continue;
			if (value === "$" || (value === "@" && (tokens[i + 1]?.value === "(" || tokens[i + 1]?.value === "{"))) continue;
			return UNCERTAIN;
		}
		const name = value.slice(Math.max(value.lastIndexOf("/"), value.lastIndexOf("\\")) + 1).toLowerCase().replace(/\.exe$/, "");
		controlBlock = !token.quoted && CONTROL_BLOCK.has(name);
		foreachBlock = !token.quoted && name === "foreach";
		paramBlock = !token.quoted && name === "param";
		doBlock = !token.quoted && name === "do";
		doCondition = afterDo && !token.quoted && (name === "while" || name === "until"); afterDo = false;
		if (!token.quoted && (name === "return" || name === "throw" || name === "exit")) { head = true; continue; }
		if (DETACHED.has(name) && !(SERVICE_STARTERS.has(name) && hasLiteralWhatIf(tokens, i + 1, command, SERVICE_START_PARAMETERS))) return BACKGROUND;
		if (LAUNCHERS.has(name) || name === ".") return UNCERTAIN;
		if (WMI_JOB_COMMANDS.has(name) || COMPUTER_JOB_COMMANDS.has(name)) {
			const reason = inspectCommandSwitch(tokens, i + 1, command, WMI_JOB_COMMANDS.has(name) ? WMI_JOB_PARAMETERS : COMPUTER_JOB_PARAMETERS, "asjob");
			if (reason) return reason;
		}
		if (name === "new-object") {
			const reason = inspectNewObject(tokens, i + 1, command);
			if (reason) return reason;
		}
		if (name === "add-type") {
			const reason = inspectAddType(tokens, i + 1, command);
			if (reason) return reason;
		}
		if (name === "get-wmiobject" || name === "gwmi") {
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
				if (!arg.quoted && arg.value === "--") break;
				const raw = command.slice(arg.start, arg.end), colon = raw.indexOf(":");
				const option = raw.slice(1, colon < 0 ? raw.length : colon).toLowerCase();
				if (!PARAMETER_DASH.test(raw)) continue;
				const parameter = lookupOption(option, WMI_PARAMETERS);
				if (parameter === "list") return UNCERTAIN;
				if (parameter === "query") {
					const separate = colon < 0 || colon === raw.length - 1;
					const query = separate ? tokens[++j] : arg;
					if (!query || query.operator || query.dynamic || hasWmiSchemaQuery(separate ? query.value : query.value.slice(query.value.indexOf(":") + 1))) return UNCERTAIN;
				}
			}
		}
		if (FOR_EACH.has(name) && !(name === "foreach" && tokens[i + 1]?.value === "(")) {
			const reason = inspectForEach(tokens, i + 1, command);
			if (reason) return reason;
		}
		// Windows PowerShell's sc alias is Set-Content; native sc.exe is a separate
		// existing service-control authorization path, not a provider cmdlet.
		const contentReader = CONTENT_READERS.has(name);
		if ((CONTENT_MUTATORS.has(name) || contentReader) && !value.toLowerCase().endsWith(".exe")) {
			const reason = inspectContentTargets(tokens, i + 1, command, contentReader);
			if (reason) return reason;
		}
		if ((name === "tee-object" || name === "tee") && !value.toLowerCase().endsWith(".exe")) {
			const reason = inspectTeeVariable(tokens, i + 1, command);
			if (reason) return reason;
		}
		if (PROVIDER_READERS.has(name)) {
			const parameters = name === "get-item" || name === "gi" ? ITEM_READER_PARAMETERS : CHILD_READER_PARAMETERS;
			const reason = inspectContentTargets(tokens, i + 1, command, true, parameters);
			if (reason) return reason;
		}
		if (name === "get-variable" || name === "gv") {
			let literalName = false;
			for (let j = i + 1; j < tokens.length; j++) {
				let arg = tokens[j]!;
				if (arg.operator && arg.value === "=") continue;
				if (arg.operator) { if (arg.value === "(" || arg.value === "{") return UNCERTAIN; break; }
				if (DEFAULT_PARAMETERS.test(arg.value)) return UNCERTAIN;
				const raw = command.slice(arg.start, arg.end), colon = raw.indexOf(":"), option = raw.slice(1, colon < 0 ? raw.length : colon).toLowerCase();
				let target = arg.value;
				if (PARAMETER_DASH.test(raw)) {
					const resolved = lookupOption(option, VARIABLE_LOOKUP_PARAMETERS);
					if (!resolved) return UNCERTAIN;
					if (VARIABLE_LOOKUP_FLAGS.has(resolved) && colon !== raw.length - 1) continue;
					const variableReference = VARIABLE_REFERENCE_OPTIONS.has(resolved);
					if (variableReference && arg.dynamic) return UNCERTAIN;
					const named = resolved === "name";
					if (colon < 0 || colon === raw.length - 1) { arg = tokens[++j]!; if (!arg || arg.operator || (variableReference && arg.dynamic)) return UNCERTAIN; target = arg.value; }
					else target = arg.value.slice(arg.value.indexOf(":") + 1);
					if (DEFAULT_PARAMETERS.test(target)) return UNCERTAIN;
					if (!named) continue;
				}
				if (arg.dynamic) return UNCERTAIN;
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
		if (name === "set-service" && !hasLiteralWhatIf(tokens, i + 1, command, SERVICE_SET_PARAMETERS)) {
			for (let j = i + 1; j < tokens.length; j++) {
				const arg = tokens[j]!;
				if (arg.operator && arg.value === "=") continue;
				if (arg.operator && (arg.value === "(" || arg.value === "{")) return UNCERTAIN;
				if (arg.operator) break;
				if (arg.value === "--%") return UNCERTAIN;
				if (isArgumentSuffix(tokens, j)) continue;
				const raw = command.slice(arg.start, arg.end), colon = raw.indexOf(":"), option = raw.slice(1, colon < 0 ? raw.length : colon).toLowerCase();
				if (!PARAMETER_DASH.test(raw) || !option || !"status".startsWith(option)) continue;
				const separate = colon < 0 || colon === raw.length - 1;
				const status = separate ? tokens[++j] : arg;
				if (!status || status.operator || status.dynamic) return UNCERTAIN;
				const state = (separate ? status.value : status.value.slice(status.value.indexOf(":") + 1)).toLowerCase();
				if (state !== "stopped" && state !== "paused") return BACKGROUND;
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
