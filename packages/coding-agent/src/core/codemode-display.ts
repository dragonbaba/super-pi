import { createHash } from "node:crypto";

// Display metadata is bounded and never participates in tool policy or read evidence.
export const CODEMODE_DISPLAY_MAX_CALLS = 256;
export const CODEMODE_DISPLAY_PREVIEW_CHARS = 2048;
export const CODEMODE_DISPLAY_INPUT_CHARS = 512;
export const CODEMODE_DISPLAY_JSON_CHARS = 64 * 1024;
export const CODEMODE_DISPLAY_MAX_DIGESTS = 16;

export interface CodemodeChildDisplay {
	toolCallId: string;
	toolName: string;
	sequence?: number;
	durationMs?: number;
	isError: boolean;
	preview: string;
	inputSummary?: string;
	previewTruncated?: boolean;
	outputPath?: string;
	executionStatus?: string;
	exitCode?: number | null;
	outputDigests?: string[];
	ref?: string;
	executed?: boolean | "unknown";
	resultComplete?: boolean | "unknown";
	displayLimited?: boolean;
	failureHandled?: boolean;
	recoveryError?: string;
	recoveryCapped?: boolean;
	evicted?: boolean;
}

export function codemodeInputSummary(input: unknown): string {
	if (!input || typeof input !== "object") return "";
	const args = input as Record<string, unknown>;
	for (const key of INPUT_KEYS) {
		const value = args[key];
		if (typeof value === "string") return (value.length > CODEMODE_DISPLAY_INPUT_CHARS
			? value.slice(0, CODEMODE_DISPLAY_INPUT_CHARS - 1) + "…" : value).replaceAll("\r", " ").replaceAll("\n", " ").replaceAll("\t", " ");
	}
	return "";
}
const INPUT_KEYS = Object.freeze(["command", "path", "file", "url", "query", "pattern", "name"]);

const FAILURE_WRAPPER = /^(?:\[(?:SHELL_RUNTIME_FAILED|BROWSER_EXEC_FAILED|CODEMODE_[A-Z_]+)\]\s*)+/;
const MISSING_PATH_DIAGNOSTIC = /^(?:ls: cannot access .+: No such file or directory|(?:Error: )?ENOENT: no such file or directory(?:,.*)?|(?:Get-Item|Get-Content|Test-Path)\s*:\s*Cannot find path .+ because it does not exist\.?)[\s]*$/i;
const EXCEPTION_DIAGNOSTIC = /^(?:[\w.]*Error|[\w.]*Exception|[\w.]*Timeout)(?:\s*\[[\w_]+\])?:\s*\S/;
const SPAWN_DIAGNOSTIC = /^Error: spawn(?:Sync)? (?:.+ )?(?:E[A-Z0-9_]+|UNKNOWN)\b/;
const IPC_TIMEOUT_DIAGNOSTIC = /^browser_harness\.helpers\._IPCResponseTimeout: ([\w.]{1,64} timed out after [\d.]{1,12}s) waiting for the daemon/;
const UNKNOWN_TOOL_DIAGNOSTIC = /^tools\.([\w$]{1,80}) does not exist\./;
const EXIT_DIAGNOSTIC = /^Command exited with code -?\d+\.?$/;
const NUMERIC_OUTPUT_LINE = /^[+-]?\d+(?:\.\d+)?$/;
const PREFLIGHT_HEADING = /^(?:\[(?:POLICY_BLOCKED|SHELL_WRAPPER)(?::[A-Z_]+)?\]\s*)?Not executed:$/;
const POWERSHELL_PREFLIGHT = /^\[SHELL_[A-Z_]+\] PowerShell not executed:\s*/;
const COMPILER_DIAGNOSTIC = /^(?:.+(?:\(\d+,\d+\)|:\d+(?::\d+)?)(?::|\s+-)\s*(?:fatal )?error\b|error\s+(?:TS\d+|[A-Z]+\d+):)/i;
const NPM_STARTUP = /^(?:npm (?:notice run|info run)\b|npm (?:notice|info)\s*$)/;
const NPM_SCRIPT_HEADER = /^> (?:@[^/\s@]+\/)?[^@\s]+@\d+\.\d+\.\d+(?:[-+][^\s]+)? \S/;
const NPM_VERSIONLESS_HEADER = /^> \S+(?: \S+)?$/;
const NPM_SCRIPT_COMMAND = /^(?:>|\$)\s/;
const ANSI_SGR = /\x1b\[[\d;]*m/g;
const HTTP_EXCEPTION = /^(?:aiohttp\.client_exceptions\.)?(?:ClientResponseError|WSServerHandshakeError):\s*([45]\d{2}),\s*message=['"]([^'"\r\n]{1,100})['"]/;
const DIAGNOSTIC_WHITESPACE = /[\r\n\t]+/g;
const TOOL_DIAGNOSTIC = /(?:\bNo such (?:filter|file|encoder|format)\b|\bUnknown (?:encoder|decoder|format)\b|^Error (?:opening|initializing|while|writing)\b)/i;

/** At most 2048 code units inspected, including both ends of arbitrarily large output. */
export function codemodeFailureWindow(text: string): string {
	if (text.length <= CODEMODE_DISPLAY_PREVIEW_CHARS) return text;
	let head = 1024, tail = text.length - 1020;
	if (text.charCodeAt(head - 1) >= 0xd800 && text.charCodeAt(head - 1) <= 0xdbff) head--;
	if (text.charCodeAt(tail) >= 0xdc00 && text.charCodeAt(tail) <= 0xdfff) tail++;
	return text.slice(0, head) + "\n…\n" + text.slice(tail);
}

/** Completion-only projection shared by the model summary and collapsed UI.
 * Scan a bounded prefix without splitting arbitrary tool output into a line array.
 * This is presentation, never a change to the recorded execution outcome. */
export function codemodeFailureReason(text: string, audience: "display" | "model" = "display"): string {
	const bounded = codemodeFailureWindow(text).replace(ANSI_SGR, "").replace(FAILURE_WRAPPER, "");
	// Browser execution already places the authoritative final exception first.
	// Never replace it with an earlier chained exception from the retained trace.
	const browserSummary = text.startsWith("[BROWSER_EXEC_") && bounded.includes("\n[Browser diagnostics]\n");
	let first = "", diagnostic = "", compiler = "", terminal = "", exit = "", recovery = "", shortHeader = "";
	let shortStart = 0, quotedStart = -1, quotedEnd = 0;
	let preflight = false, npmCommandPending = false;
	for (let start = 0; start < bounded.length;) {
		const lineStart = start, newline = bounded.indexOf("\n", start);
		const end = newline < 0 ? bounded.length : newline;
		let line = bounded.slice(start, end).trim();
		start = end + 1;
		if (PREFLIGHT_HEADING.test(line)) { preflight = true; continue; }
		if (POWERSHELL_PREFLIGHT.test(line)) { preflight = true; if (audience === "display") line = line.replace(POWERSHELL_PREFLIGHT, ""); }
		if (preflight && line.startsWith("Next:")) { recovery = line; continue; }
		if (!line) continue;
		if (shortHeader) {
			// A short pair can also be quoted diagnostics. Keep it until a real
			// cause is found; an exit status alone must not discard the pair.
			if (line.startsWith("> ")) { if (quotedStart < 0) quotedStart = shortStart; quotedEnd = end; shortHeader = ""; continue; }
			if (!first) first = shortHeader;
			shortHeader = "";
		}
		// A versionless npm preamble and quoted diagnostics are ambiguous. Keep
		// one bounded source span, materialized only when selected as the fallback.
		if (quotedStart >= 0 && line.startsWith("> ")) { quotedEnd = end; continue; }
		if (NPM_SCRIPT_HEADER.test(line)) { npmCommandPending = true; continue; }
		if (NPM_STARTUP.test(line)) continue;
		if (npmCommandPending) { npmCommandPending = false; if (NPM_SCRIPT_COMMAND.test(line)) continue; }
		if (!first && NPM_VERSIONLESS_HEADER.test(line)) { shortHeader = line; shortStart = lineStart; continue; }
		if (line === "Traceback (most recent call last):" || line.startsWith("File \"")) continue;
		if (!compiler && COMPILER_DIAGNOSTIC.test(line)) compiler = line;
		if (MISSING_PATH_DIAGNOSTIC.test(line)) {
			diagnostic = audience === "model" ? line : "Path does not exist.";
			if (compiler) terminal = diagnostic;
		} else if (EXCEPTION_DIAGNOSTIC.test(line)) {
			diagnostic = line;
			// A later specific failure supersedes compiler output, not a generic wrapper.
			if (compiler && (!line.startsWith("Error:") || SPAWN_DIAGNOSTIC.test(line))) terminal = line;
		} else if (!diagnostic && TOOL_DIAGNOSTIC.test(line)) diagnostic = line;
		else if (EXIT_DIAGNOSTIC.test(line)) { exit = line; continue; }
		if (!first || NUMERIC_OUTPUT_LINE.test(first)) first = line;
		if (browserSummary) break;
	}
	if (!first && shortHeader) first = shortHeader;
	// Unknown diagnostics (git/curl/compiler output) still carry more information
	// than an exit code. Bare numeric stdout remains only a fallback.
	const reason = terminal || compiler || diagnostic || (first && !NUMERIC_OUTPUT_LINE.test(first) ? first : "") || (quotedStart >= 0 ? bounded.slice(quotedStart, quotedEnd).trim() : "") || exit || first || "Tool call failed.";
	const httpException = audience === "display" ? HTTP_EXCEPTION.exec(reason) : null;
	if (httpException) return `HTTP ${httpException[1]}: ${httpException[2]}.`;
	const ipcTimeout = IPC_TIMEOUT_DIAGNOSTIC.exec(reason);
	if (ipcTimeout) return audience === "display" ? `${ipcTimeout[1]}; result unconfirmed.`
		: `${ipcTimeout[0]}. Outcome unconfirmed; inspect list_tabs() before further actions. Do not automatically retry.`;
	const unknownTool = audience === "display" ? UNKNOWN_TOOL_DIAGNOSTIC.exec(reason) : null;
	if (unknownTool) return `Tool ${unknownTool[1]} is unavailable in this script; check tool discovery.`;
	// The model needs the exact target/code to recover; the visible row only
	// needs a short reason. Neither view changes canonical diagnostics.
	const limit = audience === "model" ? 512 : 160;
	const summary = audience === "model" && recovery ? `${reason} ${recovery}` : reason;
	return (summary.length > limit ? summary.slice(0, limit - 1) + "…" : summary).replace(DIAGNOSTIC_WHITESPACE, " ");
}

/** Completion boundary only: hash without constructing another complete output string. */
export function codemodeTextDigest(text: string): string {
	return createHash("sha256").update(text).digest("hex");
}

export function codemodeOutputDigests(content: readonly { type: string; text?: string }[]): string[] {
	const digests: string[] = [];
	for (const block of content) {
		if (block.type === "text" && typeof block.text === "string") digests.push(codemodeTextDigest(block.text));
		if (digests.length === CODEMODE_DISPLAY_MAX_DIGESTS) break;
	}
	return digests;
}
