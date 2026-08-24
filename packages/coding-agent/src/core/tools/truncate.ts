/**
 * Shared truncation utilities for tool outputs.
 *
 * Truncation is based on two independent limits - whichever is hit first wins:
 * - Line limit (default: 2000 lines)
 * - Byte limit (default: 50KB)
 *
 * Never returns partial lines (except bash tail truncation edge case).
 */

export const DEFAULT_MAX_LINES = 2000;
export const DEFAULT_MAX_BYTES = 50 * 1024; // 50KB
export const GREP_MAX_LINE_LENGTH = 500; // Max chars per grep match line

export interface TruncationResult {
	/** The truncated content */
	content: string;
	/** Whether truncation occurred */
	truncated: boolean;
	/** Which limit was hit: "lines", "bytes", or null if not truncated */
	truncatedBy: "lines" | "bytes" | null;
	/** Total number of lines in the original content */
	totalLines: number;
	/** Total number of bytes in the original content */
	totalBytes: number;
	/** Number of complete lines in the truncated output */
	outputLines: number;
	/** Number of bytes in the truncated output */
	outputBytes: number;
	/** Whether the last line was partially truncated (only for tail truncation edge case) */
	lastLinePartial: boolean;
	/** Whether the first line exceeded the byte limit (for head truncation) */
	firstLineExceedsLimit: boolean;
	/** The max lines limit that was applied */
	maxLines: number;
	/** The max bytes limit that was applied */
	maxBytes: number;
}

export interface TruncationOptions {
	/** Maximum number of lines (default: 2000) */
	maxLines?: number;
	/** Maximum number of bytes (default: 50KB) */
	maxBytes?: number;
}

function countLogicalLines(content: string): number {
	if (content.length === 0) {
		return 0;
	}
	let newlineCount = 0;
	let position = -1;
	while ((position = content.indexOf("\n", position + 1)) !== -1) {
		newlineCount++;
	}
	return content.endsWith("\n") ? newlineCount : newlineCount + 1;
}

function unchangedResult(
	content: string,
	totalLines: number,
	totalBytes: number,
	maxLines: number,
	maxBytes: number,
): TruncationResult {
	return {
		content,
		truncated: false,
		truncatedBy: null,
		totalLines,
		totalBytes,
		outputLines: totalLines,
		outputBytes: totalBytes,
		lastLinePartial: false,
		firstLineExceedsLimit: false,
		maxLines,
		maxBytes,
	};
}

/**
 * Format bytes as human-readable size.
 */
export function formatSize(bytes: number): string {
	if (bytes < 1024) {
		return `${bytes}B`;
	} else if (bytes < 1024 * 1024) {
		return `${(bytes / 1024).toFixed(1)}KB`;
	} else {
		return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
	}
}

/**
 * Truncate content from the head (keep first N lines/bytes).
 * Suitable for file reads where you want to see the beginning.
 *
 * Never returns partial lines. If first line exceeds byte limit,
 * returns empty content with firstLineExceedsLimit=true.
 */
export function truncateHead(content: string, options: TruncationOptions = {}): TruncationResult {
	const maxLines = options.maxLines ?? DEFAULT_MAX_LINES;
	const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;

	const totalBytes = Buffer.byteLength(content, "utf-8");
	const totalLines = countLogicalLines(content);

	// Check if no truncation needed
	if (totalLines <= maxLines && totalBytes <= maxBytes) {
		return unchangedResult(content, totalLines, totalBytes, maxLines, maxBytes);
	}

	// Check if first line alone exceeds byte limit
	const firstEnd = content.indexOf("\n");
	const firstLine = content.slice(0, firstEnd === -1 ? content.length : firstEnd);
	if (Buffer.byteLength(firstLine, "utf-8") > maxBytes) {
		return {
			content: "",
			truncated: true,
			truncatedBy: "bytes",
			totalLines,
			totalBytes,
			outputLines: 0,
			outputBytes: 0,
			lastLinePartial: false,
			firstLineExceedsLimit: true,
			maxLines,
			maxBytes,
		};
	}

	// Collect complete lines that fit
	const outputLinesArr: string[] = [];
	let outputBytesCount = 0;
	let truncatedBy: "lines" | "bytes" = "lines";

	let start = 0;
	for (let lineIndex = 0; lineIndex < totalLines && lineIndex < maxLines; lineIndex++) {
		const newline = content.indexOf("\n", start);
		const end = newline === -1 ? content.length : newline;
		const line = content.slice(start, end);
		const lineBytes = Buffer.byteLength(line, "utf-8") + (outputLinesArr.length > 0 ? 1 : 0);

		if (outputBytesCount + lineBytes > maxBytes) {
			truncatedBy = "bytes";
			break;
		}

		outputLinesArr.push(line);
		outputBytesCount += lineBytes;
		if (newline === -1) break;
		start = newline + 1;
	}

	// If we exited due to line limit
	if (outputLinesArr.length >= maxLines && outputBytesCount <= maxBytes) {
		truncatedBy = "lines";
	}

	const outputContent = outputLinesArr.join("\n");
	return {
		content: outputContent,
		truncated: true,
		truncatedBy,
		totalLines,
		totalBytes,
		outputLines: outputLinesArr.length,
		outputBytes: Buffer.byteLength(outputContent, "utf-8"),
		lastLinePartial: false,
		firstLineExceedsLimit: false,
		maxLines,
		maxBytes,
	};
}

/**
 * Truncate content from the tail (keep last N lines/bytes).
 * Suitable for bash output where you want to see the end (errors, final results).
 *
 * May return partial first line if the last line of original content exceeds byte limit.
 */
export function truncateTail(content: string, options: TruncationOptions = {}): TruncationResult {
	const maxLines = options.maxLines ?? DEFAULT_MAX_LINES;
	const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;

	const totalBytes = Buffer.byteLength(content, "utf-8");
	const totalLines = countLogicalLines(content);

	// Check if no truncation needed
	if (totalLines <= maxLines && totalBytes <= maxBytes) {
		return unchangedResult(content, totalLines, totalBytes, maxLines, maxBytes);
	}

	// Work backwards from the end
	const reverseOutputLines: string[] = [];
	let outputBytesCount = 0;
	let truncatedBy: "lines" | "bytes" = "lines";
	let lastLinePartial = false;

	let end = content.endsWith("\n") ? content.length - 1 : content.length;
	while (reverseOutputLines.length < maxLines && reverseOutputLines.length < totalLines) {
		const newline = content.lastIndexOf("\n", end - 1);
		const line = content.slice(newline + 1, end);
		const lineBytes = Buffer.byteLength(line, "utf-8") + (reverseOutputLines.length > 0 ? 1 : 0);

		if (outputBytesCount + lineBytes > maxBytes) {
			truncatedBy = "bytes";
			// Edge case: if we haven't added ANY lines yet and this line exceeds maxBytes,
			// take the end of the line (partial)
			if (reverseOutputLines.length === 0) {
				const truncatedLine = truncateStringToBytesFromEndBounded(line, maxBytes);
				reverseOutputLines.push(truncatedLine);
				outputBytesCount = Buffer.byteLength(truncatedLine, "utf-8");
				lastLinePartial = true;
			}
			break;
		}

		reverseOutputLines.push(line);
		outputBytesCount += lineBytes;
		if (newline === -1) break;
		end = newline;
	}

	// If we exited due to line limit
	if (reverseOutputLines.length >= maxLines && outputBytesCount <= maxBytes) {
		truncatedBy = "lines";
	}

	reverseOutputLines.reverse();
	const outputContent = reverseOutputLines.join("\n");

	return {
		content: outputContent,
		truncated: true,
		truncatedBy,
		totalLines,
		totalBytes,
		outputLines: reverseOutputLines.length,
		outputBytes: Buffer.byteLength(outputContent, "utf-8"),
		lastLinePartial,
		firstLineExceedsLimit: false,
		maxLines,
		maxBytes,
	};
}

/**
 * Truncate a string to fit within a byte limit (from the end).
 * Handles multi-byte UTF-8 characters correctly.
 */
function truncateStringToBytesFromEndBounded(str: string, maxBytes: number): string {
	let start = str.length;
	let bytes = 0;
	while (start > 0) {
		const last = str.charCodeAt(start - 1);
		let codeUnits = 1;
		let charBytes: number | undefined;
		if (last >= 0xdc00 && last <= 0xdfff && start > 1) {
			const first = str.charCodeAt(start - 2);
			if (first >= 0xd800 && first <= 0xdbff) {
				codeUnits = 2;
				charBytes = 4;
			}
		}
		charBytes ??= last <= 0x7f ? 1 : last <= 0x7ff ? 2 : 3;
		if (bytes + charBytes > maxBytes) break;
		bytes += charBytes;
		start -= codeUnits;
	}
	return Buffer.from(str.slice(start), "utf-8").toString("utf-8");
}

/**
 * Truncate a single line to max characters, adding [truncated] suffix.
 * Used for grep match lines.
 */
export function truncateLine(
	line: string,
	maxChars: number = GREP_MAX_LINE_LENGTH,
): { text: string; wasTruncated: boolean } {
	if (line.length <= maxChars) {
		return { text: line, wasTruncated: false };
	}
	return { text: `${line.slice(0, maxChars)}... [truncated]`, wasTruncated: true };
}
