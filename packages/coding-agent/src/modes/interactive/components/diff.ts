import * as Diff from "diff";
import { theme } from "../theme/theme.ts";

const MAX_INTRA_LINE_DIFF_CODE_UNITS = 2048;
const MAX_INTRA_LINE_DIFF_EDIT_LENGTH = 256;

export function getDiffRenderThemeSignature(): string {
	const sentinel = "sp-diff-style";
	return [
		theme.fg("toolDiffAdded", sentinel),
		theme.fg("toolDiffRemoved", sentinel),
		theme.fg("toolDiffContext", sentinel),
		theme.inverse(sentinel),
	].join("\0");
}

/**
 * Parse diff line to extract prefix, line number, and content.
 * Format: "+123 content" or "-123 content" or " 123 content" or "     ..."
 */
function parseDiffLine(line: string): { prefix: string; lineNum: string; content: string } | null {
	const normalizedLine = line.endsWith("\r") ? line.slice(0, -1) : line;
	const match = normalizedLine.match(/^([+-\s])(\s*\d*)\s(.*)$/);
	if (!match) return null;
	return { prefix: match[1], lineNum: match[2], content: match[3] };
}

/**
 * Replace tabs with spaces for consistent rendering.
 */
function replaceTabs(text: string): string {
	return text.replace(/\t/g, "   ");
}

/**
 * Compute word-level diff and render with inverse on changed parts.
 * Uses diffWords which groups whitespace with adjacent words for cleaner highlighting.
 * Strips leading whitespace from inverse to avoid highlighting indentation.
 */
function renderIntraLineDiff(oldContent: string, newContent: string): { removedLine: string; addedLine: string } | undefined {
	const wordDiff = Diff.diffWords(oldContent, newContent, { maxEditLength: MAX_INTRA_LINE_DIFF_EDIT_LENGTH });
	if (!wordDiff) return undefined;

	let removedLine = "";
	let addedLine = "";
	let isFirstRemoved = true;
	let isFirstAdded = true;

	for (const part of wordDiff) {
		if (part.removed) {
			let value = part.value;
			// Strip leading whitespace from the first removed part
			if (isFirstRemoved) {
				const leadingWs = value.match(/^(\s*)/)?.[1] || "";
				value = value.slice(leadingWs.length);
				removedLine += leadingWs;
				isFirstRemoved = false;
			}
			if (value) {
				removedLine += theme.inverse(value);
			}
		} else if (part.added) {
			let value = part.value;
			// Strip leading whitespace from the first added part
			if (isFirstAdded) {
				const leadingWs = value.match(/^(\s*)/)?.[1] || "";
				value = value.slice(leadingWs.length);
				addedLine += leadingWs;
				isFirstAdded = false;
			}
			if (value) {
				addedLine += theme.inverse(value);
			}
		} else {
			removedLine += part.value;
			addedLine += part.value;
		}
	}

	return { removedLine, addedLine };
}

function renderWholeLineChange(
	prefix: string,
	lineNum: string,
	content: string,
	color: "toolDiffRemoved" | "toolDiffAdded",
): string {
	const leadingWs = content.match(/^(\s*)/)?.[1] || "";
	const value = content.slice(leadingWs.length);
	const body = value ? leadingWs + theme.inverse(value) : leadingWs;
	return theme.fg(color, `${prefix}${lineNum} ${body}`);
}

export interface RenderDiffOptions {
	/** File path (unused, kept for API compatibility) */
	filePath?: string;
}

/**
 * Render a diff string with colored lines and intra-line change highlighting.
 * - Context lines: dim/gray
 * - Removed lines: red, with inverse on changed tokens
 * - Added lines: green, with inverse on changed tokens
 */
export function renderDiff(diffText: string, _options: RenderDiffOptions = {}): string {
	const lines = diffText.split("\n");
	const result: string[] = [];

	let i = 0;
	while (i < lines.length) {
		const line = lines[i];
		const parsed = parseDiffLine(line);

		if (!parsed) {
			result.push(theme.fg("toolDiffContext", line));
			i++;
			continue;
		}

		if (parsed.prefix === "-") {
			// Collect consecutive removed lines
			const removedLines: { lineNum: string; content: string }[] = [];
			while (i < lines.length) {
				const p = parseDiffLine(lines[i]);
				if (!p || p.prefix !== "-") break;
				removedLines.push({ lineNum: p.lineNum, content: p.content });
				i++;
			}

			// Collect consecutive added lines
			const addedLines: { lineNum: string; content: string }[] = [];
			while (i < lines.length) {
				const p = parseDiffLine(lines[i]);
				if (!p || p.prefix !== "+") break;
				addedLines.push({ lineNum: p.lineNum, content: p.content });
				i++;
			}

			// Only do intra-line diffing when there's exactly one removed and one added line
			// (indicating a single line modification). Otherwise, show lines as-is.
			if (removedLines.length === 1 && addedLines.length === 1) {
				const removed = removedLines[0];
				const added = addedLines[0];

				const oldContent = replaceTabs(removed.content);
				const newContent = replaceTabs(added.content);
				const intraLine = oldContent.length + newContent.length <= MAX_INTRA_LINE_DIFF_CODE_UNITS
					? renderIntraLineDiff(oldContent, newContent)
					: undefined;
				if (intraLine) {
					result.push(theme.fg("toolDiffRemoved", `-${removed.lineNum} ${intraLine.removedLine}`));
					result.push(theme.fg("toolDiffAdded", `+${added.lineNum} ${intraLine.addedLine}`));
				} else {
					result.push(renderWholeLineChange("-", removed.lineNum, oldContent, "toolDiffRemoved"));
					result.push(renderWholeLineChange("+", added.lineNum, newContent, "toolDiffAdded"));
				}
			} else {
				// Show all removed lines first, then all added lines
				for (const removed of removedLines) {
					result.push(renderWholeLineChange("-", removed.lineNum, replaceTabs(removed.content), "toolDiffRemoved"));
				}
				for (const added of addedLines) {
					result.push(renderWholeLineChange("+", added.lineNum, replaceTabs(added.content), "toolDiffAdded"));
				}
			}
		} else if (parsed.prefix === "+") {
			// Standalone added line
			result.push(renderWholeLineChange("+", parsed.lineNum, replaceTabs(parsed.content), "toolDiffAdded"));
			i++;
		} else {
			// Context line
			result.push(theme.fg("toolDiffContext", ` ${parsed.lineNum} ${replaceTabs(parsed.content)}`));
			i++;
		}
	}

	return result.join("\n");
}
