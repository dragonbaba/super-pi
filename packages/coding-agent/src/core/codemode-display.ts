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
