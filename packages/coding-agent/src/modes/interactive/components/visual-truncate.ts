/**
 * Shared utility for truncating text to visual lines (accounting for line wrapping).
 * Used by both tool-execution.ts and bash-execution.ts for consistent behavior.
 */

import { visibleWidth, wrapTextWithAnsiTail } from "@super-pi/tui";
import { TAB_PATTERN } from "../../../utils/shell-regex.ts";

export interface VisualTruncateResult {
	/** The visual lines to display */
	visualLines: string[];
	/** Number of visual lines that were skipped (hidden) */
	skippedCount: number;
}

/**
 * Truncate text to a maximum number of visual lines (from the end).
 * This accounts for line wrapping based on terminal width.
 *
 * @param text - The text content (may contain newlines)
 * @param maxVisualLines - Maximum number of visual lines to show
 * @param width - Terminal/render width
 * @param paddingX - Horizontal padding for Text component (default 0).
 *                   Use 0 when result will be placed in a Box (Box adds its own padding).
 *                   Use 1 when result will be placed in a plain Container.
 * @returns The truncated visual lines and count of skipped lines
 */
export function truncateToVisualLines(
	text: string,
	maxVisualLines: number,
	width: number,
	paddingX: number = 0,
): VisualTruncateResult {
	if (!text) {
		return { visualLines: [], skippedCount: 0 };
	}

	if (!text.trim()) return { visualLines: [], skippedCount: 0 };
	const tail = wrapTextWithAnsiTail(text.replace(TAB_PATTERN, "   "), Math.max(1, width - paddingX * 2), maxVisualLines);
	const margin = " ".repeat(paddingX);
	for (let index = 0; index < tail.lines.length; index++) {
		const line = margin + tail.lines[index] + margin;
		tail.lines[index] = line + " ".repeat(Math.max(0, width - visibleWidth(line)));
	}
	return { visualLines: tail.lines, skippedCount: tail.skippedCount };
}
