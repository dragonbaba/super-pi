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
const IPC_TIMEOUT_DIAGNOSTIC = /^browser_harness\.helpers\._IPCResponseTimeout: ([\w.]{1,64} timed out after [\d.]{1,12}s) waiting for the daemon/;
const UNKNOWN_TOOL_DIAGNOSTIC = /^tools\.([\w$]{1,80}) does not exist\./;
const EXIT_DIAGNOSTIC = /^Command exited with code -?\d+\.?$/;
const NUMERIC_OUTPUT_LINE = /^[+-]?\d+(?:\.\d+)?$/;
const PREFLIGHT_HEADING = /^(?:\[POLICY_BLOCKED(?::[A-Z_]+)?\]\s*)?Not executed:$/;
const DIAGNOSTIC_WHITESPACE = /[\r\n\t]+/g;

/** Completion-only projection shared by the model summary and collapsed UI.
 * Scan a bounded prefix without splitting arbitrary tool output into a line array.
 * This is presentation, never a change to the recorded execution outcome. */
export function codemodeFailureReason(text: string, audience: "display" | "model" = "display"): string {
	const bounded = text.slice(0, CODEMODE_DISPLAY_PREVIEW_CHARS).replace(FAILURE_WRAPPER, "");
	// Browser execution already places the authoritative final exception first.
	// Never replace it with an earlier chained exception from the retained trace.
	const browserSummary = text.startsWith("[BROWSER_EXEC_") && bounded.includes("\n[Browser diagnostics]\n");
	let first = "", diagnostic = "", exit = "";
	for (let start = 0; start < bounded.length;) {
		const newline = bounded.indexOf("\n", start);
		const end = newline < 0 ? bounded.length : newline;
		const line = bounded.slice(start, end).trim();
		start = end + 1;
		if (!line || line === "Traceback (most recent call last):" || line.startsWith("File \"") || PREFLIGHT_HEADING.test(line)) continue;
		if (MISSING_PATH_DIAGNOSTIC.test(line)) diagnostic = audience === "model" ? line : "Path does not exist.";
		else if (EXCEPTION_DIAGNOSTIC.test(line)) diagnostic = line;
		else if (EXIT_DIAGNOSTIC.test(line)) { exit = line; continue; }
		if (!first || NUMERIC_OUTPUT_LINE.test(first)) first = line;
		if (browserSummary) break;
	}
	// Unknown diagnostics (git/curl/compiler output) still carry more information
	// than an exit code. Bare numeric stdout remains only a fallback.
	const reason = diagnostic || (first && !NUMERIC_OUTPUT_LINE.test(first) ? first : "") || exit || first || "Tool call failed.";
	const ipcTimeout = IPC_TIMEOUT_DIAGNOSTIC.exec(reason);
	if (ipcTimeout) return audience === "display" ? `${ipcTimeout[1]}; result unconfirmed.`
		: `${ipcTimeout[0]}. Outcome unconfirmed; inspect list_tabs() before further actions. Do not automatically retry.`;
	const unknownTool = audience === "display" ? UNKNOWN_TOOL_DIAGNOSTIC.exec(reason) : null;
	if (unknownTool) return `Tool ${unknownTool[1]} is unavailable in this script; check tool discovery.`;
	// The model needs the exact target/code to recover; the visible row only
	// needs a short reason. Neither view changes canonical diagnostics.
	const limit = audience === "model" ? 512 : 160;
	return (reason.length > limit ? reason.slice(0, limit - 1) + "…" : reason).replace(DIAGNOSTIC_WHITESPACE, " ");
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
