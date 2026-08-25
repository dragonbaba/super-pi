import * as os from "node:os";
import { pathToFileURL } from "node:url";
import type { ImageContent, TextContent } from "@super-pi/ai";
import { getCapabilities, getImageDimensions, hyperlink, imageFallback } from "@super-pi/tui";
import type { Theme } from "../../modes/interactive/theme/theme.ts";
import { stripAnsi } from "../../utils/ansi.ts";
import { resolvePath } from "../../utils/paths.ts";
import { sanitizeBinaryOutput } from "../../utils/shell.ts";
import { CARRIAGE_RETURN_PATTERN, TAB_PATTERN } from "../../utils/shell-regex.ts";

export function shortenPath(path: unknown): string {
	if (typeof path !== "string") return "";
	const home = os.homedir();
	if (path.startsWith(home)) {
		return `~${path.slice(home.length)}`;
	}
	return path;
}

export function linkPath(styledText: string, rawPath: string, cwd: string): string {
	if (!getCapabilities().hyperlinks) return styledText;
	const absolutePath = resolvePath(rawPath, cwd);
	return hyperlink(styledText, pathToFileURL(absolutePath).href);
}

export function str(value: unknown): string | null {
	if (typeof value === "string") return value;
	if (value == null) return "";
	return null;
}

export function replaceTabs(text: string): string {
	return text.replace(TAB_PATTERN, "   ");
}

export function normalizeDisplayText(text: string): string {
	return text.replace(CARRIAGE_RETURN_PATTERN, "");
}

export function getTextOutput(
	result: { content: Array<{ type: string; text?: string; data?: string; mimeType?: string }> } | undefined,
	showImages: boolean,
): string {
	if (!result) return "";

	let output = "";
	let textBlockCount = 0;
	for (const block of result.content) {
		if (block.type !== "text") continue;
		if (textBlockCount > 0) output += "\n";
		output += sanitizeBinaryOutput(stripAnsi(block.text || "")).replace(CARRIAGE_RETURN_PATTERN, "");
		textBlockCount++;
	}

	const caps = getCapabilities();
	if (!caps.images || !showImages) {
		for (const block of result.content) {
			if (block.type !== "image") continue;
			const mimeType = block.mimeType ?? "image/unknown";
			const dimensions =
				block.data && block.mimeType ? (getImageDimensions(block.data, block.mimeType) ?? undefined) : undefined;
			if (output) output += "\n";
			output += imageFallback(mimeType, dimensions);
		}
	}

	return output;
}

export type ToolRenderResultLike<TDetails> = {
	content: (TextContent | ImageContent)[];
	details: TDetails;
};

export function invalidArgText(theme: Theme): string {
	return theme.fg("error", "[invalid arg]");
}

export function renderToolPath(
	rawPath: string | null,
	theme: Theme,
	cwd: string,
	options?: { emptyFallback?: string },
): string {
	if (rawPath === null) return invalidArgText(theme);
	const value = rawPath || options?.emptyFallback;
	if (!value) return theme.fg("toolOutput", "...");
	return linkPath(theme.fg("accent", shortenPath(value)), value, cwd);
}
