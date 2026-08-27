import * as fs from "node:fs";
import * as path from "node:path";
import { deleteKittyImage, isImageLine } from "./terminal-image.ts";
import { type TUI, TuiBase, type TuiStopOptions } from "./tui.ts";
import { visibleWidth } from "./utils.ts";
import {
	isLineViewportComponent,
	type LineViewportMutationKind,
	type LineViewportMutationObservation,
	type LineViewportRender,
	renderComponentsViewport,
} from "./components/viewport-container.ts";

const KITTY_SEQUENCE_PREFIX = "\x1b_G";

interface KittyImageHeader {
	ids: number[];
	rows: number;
}

function parseKittyImageHeader(line: string): KittyImageHeader | undefined {
	const sequenceStart = line.indexOf(KITTY_SEQUENCE_PREFIX);
	if (sequenceStart === -1) return undefined;
	const paramsStart = sequenceStart + KITTY_SEQUENCE_PREFIX.length;
	const paramsEnd = line.indexOf(";", paramsStart);
	if (paramsEnd === -1) return undefined;

	const ids: number[] = [];
	let rows = 1;
	for (const param of line.slice(paramsStart, paramsEnd).split(",")) {
		const [key, value] = param.split("=", 2);
		if (value === undefined) continue;
		const numberValue = Number(value);
		if (!Number.isInteger(numberValue) || numberValue <= 0 || numberValue > 0xffffffff) continue;
		if (key === "i") ids.push(numberValue);
		else if (key === "r") rows = numberValue;
	}
	return { ids, rows };
}

function extractKittyImageIds(line: string): number[] {
	return parseKittyImageHeader(line)?.ids ?? [];
}

function extractKittyImageRows(line: string): number {
	return parseKittyImageHeader(line)?.rows ?? 1;
}

function isTermuxSession(): boolean {
	return Boolean(process.env.TERMUX_VERSION);
}

export interface TuiMainScreenRenderState {
	previousLines: string[];
	previousWidth: number;
	previousHeight: number;
	cursorRow: number;
	hardwareCursorRow: number;
	maxLinesRendered: number;
	previousViewportTop: number;
	viewportWindowStart?: number;
	viewportDocumentHeight?: number;
	viewportMutationTokens: readonly unknown[];
	previousKittyImageIds: readonly number[];
}

/** TUI implementation that renders into the terminal's main screen and scrollback. */
export class TuiMainScreen extends TuiBase implements TUI {
	readonly mode = "regular" as const;
	private previousLines: string[] = [];
	private previousKittyImageIds = new Set<number>();
	private previousWidth = 0;
	private previousHeight = 0;
	private cursorRow = 0;
	private hardwareCursorRow = 0;
	private maxLinesRendered = 0;
	private previousViewportTop = 0;
	private viewportWindowStart: number | undefined;
	private viewportDocumentHeight: number | undefined;
	private readonly viewportMutationTokens: unknown[] = [];
	private readonly viewportMutationScratch: LineViewportMutationObservation = { token: 0, kind: "none" };
	private readonly viewportMutationSummary: LineViewportMutationObservation = { token: 0, kind: "none" };
	private readonly frameRootHeights: number[] = [];
	private readonly frameRootLines: Array<readonly string[] | undefined> = [];
	private readonly frameRootLineStarts: number[] = [];
	private readonly frameRootLeadingKittyImages: Array<LineViewportRender["leadingKittyImage"]> = [];
	private readonly boundedFrameLinesA: string[] = [];
	private readonly boundedFrameLinesB: string[] = [];
	private readonly rootFrameRender: LineViewportRender = { lines: [], startLine: 0, totalHeight: 0 };
	private expandedFirstChanged = -1;
	private expandedLastChanged = -1;

	captureRenderState(): TuiMainScreenRenderState {
		return {
			previousLines: [...this.previousLines],
			previousWidth: this.previousWidth,
			previousHeight: this.previousHeight,
			cursorRow: this.cursorRow,
			hardwareCursorRow: this.hardwareCursorRow,
			maxLinesRendered: this.maxLinesRendered,
			previousViewportTop: this.previousViewportTop,
			viewportWindowStart: this.viewportWindowStart,
			viewportDocumentHeight: this.viewportDocumentHeight,
			viewportMutationTokens: [...this.viewportMutationTokens],
			previousKittyImageIds: [...this.previousKittyImageIds],
		};
	}

	restoreRenderState(state: TuiMainScreenRenderState): void {
		this.previousLines = state.previousLines.map((line) => (isImageLine(line) ? "" : line));
		this.previousKittyImageIds = new Set(state.previousKittyImageIds);
		this.previousWidth = state.previousWidth;
		this.previousHeight = state.previousHeight;
		this.cursorRow = state.cursorRow;
		this.hardwareCursorRow = state.hardwareCursorRow;
		this.maxLinesRendered = state.maxLinesRendered;
		this.previousViewportTop = state.previousViewportTop;
		this.viewportWindowStart = state.viewportWindowStart;
		this.viewportDocumentHeight = state.viewportDocumentHeight;
		this.viewportMutationTokens.length = state.viewportMutationTokens.length;
		for (let index = 0; index < state.viewportMutationTokens.length; index++) {
			this.viewportMutationTokens[index] = state.viewportMutationTokens[index];
		}
	}

	protected override resetRenderState(): void {
		this.previousLines = [];
		this.previousWidth = -1;
		this.previousHeight = -1;
		this.cursorRow = 0;
		this.hardwareCursorRow = 0;
		this.maxLinesRendered = 0;
		this.previousViewportTop = 0;
		this.viewportWindowStart = undefined;
		this.viewportDocumentHeight = undefined;
		this.viewportMutationTokens.length = 0;
	}

	protected override beforeTerminalStop(options: TuiStopOptions): void | Promise<void> {
		if (options.preserveScreen || this.previousLines.length === 0) return;
		let buffer = " ";
		const targetRow = this.viewportDocumentHeight ?? this.previousLines.length;
		const lineDiff = targetRow - this.hardwareCursorRow;
		if (lineDiff > 0) buffer += `\x1b[${lineDiff}B`;
		else if (lineDiff < 0) buffer += `\x1b[${-lineDiff}A`;
		buffer += "\r\n";
		return this.terminal.write(buffer);
	}

	private collectKittyImageIds(lines: string[]): Set<number> {
		const ids = new Set<number>();
		for (const line of lines) {
			for (const id of extractKittyImageIds(line)) {
				ids.add(id);
			}
		}
		return ids;
	}

	private deleteKittyImages(ids: Iterable<number>): string {
		let buffer = "";
		for (const id of ids) {
			buffer += deleteKittyImage(id);
		}
		return buffer;
	}

	private getKittyImageReservedRows(lines: string[], index: number, maxIndex = lines.length - 1): number {
		const rows = extractKittyImageRows(lines[index] ?? "");
		if (rows <= 1) return 1;

		const maxRows = Math.min(rows, maxIndex - index + 1, lines.length - index);
		let reservedRows = 1;
		while (reservedRows < maxRows) {
			const line = lines[index + reservedRows] ?? "";
			if (isImageLine(line) || visibleWidth(line) > 0) break;
			reservedRows++;
		}
		return reservedRows;
	}

	private expandChangedRangeForKittyImages(
		firstChanged: number,
		lastChanged: number,
		newLines: string[],
	): void {
		this.expandedFirstChanged = firstChanged;
		this.expandedLastChanged = lastChanged;
		this.expandChangedRangeForKittyLines(this.previousLines, firstChanged, lastChanged);
		this.expandChangedRangeForKittyLines(newLines, firstChanged, lastChanged);
	}

	private expandChangedRangeForKittyLines(lines: string[], firstChanged: number, lastChanged: number): void {
		for (let index = 0; index < lines.length; index++) {
			if (extractKittyImageIds(lines[index]).length === 0) continue;
			const blockEnd = index + this.getKittyImageReservedRows(lines, index) - 1;
			if (index >= firstChanged || (index <= lastChanged && blockEnd >= firstChanged)) {
				this.expandedFirstChanged = Math.min(this.expandedFirstChanged, index);
				this.expandedLastChanged = Math.max(this.expandedLastChanged, blockEnd);
			}
		}
	}

	private deleteChangedKittyImages(firstChanged: number, lastChanged: number): string {
		if (firstChanged < 0 || lastChanged < firstChanged) return "";

		const ids = new Set<number>();
		const maxLine = Math.min(lastChanged, this.previousLines.length - 1);
		for (let i = firstChanged; i <= maxLine; i++) {
			for (const id of extractKittyImageIds(this.previousLines[i] ?? "")) {
				ids.add(id);
			}
		}

		return this.deleteKittyImages(ids);
	}

	private computeLineDiff(
		hardwareCursorRow: number,
		previousViewportTop: number,
		targetRow: number,
		viewportTop: number,
	): number {
		const currentScreenRow = hardwareCursorRow - previousViewportTop;
		const targetScreenRow = targetRow - viewportTop;
		return targetScreenRow - currentScreenRow;
	}

	private renderFullFrame(
		clear: boolean,
		lines: string[],
		width: number,
		height: number,
		cursorPos: { row: number; col: number } | null,
		hasViewportDocument: boolean,
		generatedDocumentHeight: number,
	): void {
		this.fullRedrawCount += 1;
		let buffer = "\x1b[?2026h";
		if (clear) {
			buffer += this.deleteKittyImages(this.previousKittyImageIds);
			buffer += "\x1b[2J\x1b[H\x1b[3J";
		}
		for (let index = 0; index < lines.length; index++) {
			if (index > 0) buffer += "\r\n";
			const line = lines[index];
			const image = isImageLine(line);
			const imageReservedRows = image ? this.getKittyImageReservedRows(lines, index) : 1;
			if (imageReservedRows > 1 && imageReservedRows <= height) {
				for (let row = 1; row < imageReservedRows; row++) buffer += "\r\n";
				buffer += `\x1b[${imageReservedRows - 1}A`;
				buffer += line;
				buffer += `\x1b[${imageReservedRows - 1}B`;
				index += imageReservedRows - 1;
				continue;
			}
			buffer += line;
		}
		buffer += "\x1b[?2026l";
		this.writeTerminalFrame(buffer, lines.length);
		this.cursorRow = Math.max(0, lines.length - 1);
		this.hardwareCursorRow = this.cursorRow;
		if (clear) this.maxLinesRendered = lines.length;
		else this.maxLinesRendered = Math.max(this.maxLinesRendered, lines.length);
		const bufferLength = Math.max(height, lines.length);
		this.previousViewportTop = Math.max(0, bufferLength - height);
		this.positionHardwareCursor(cursorPos, lines.length);
		this.previousLines = lines;
		this.previousKittyImageIds = this.collectKittyImageIds(lines);
		this.previousWidth = width;
		this.previousHeight = height;
		this.captureViewportMutationTokens(width, hasViewportDocument ? generatedDocumentHeight : undefined);
	}

	private logFullRedraw(reason: string, nextLineCount: number, height: number): void {
		if (process.env.SP_DEBUG_REDRAW !== "1") return;
		const logPath = path.join(this.logDirectory, "pi-debug.log");
		const message = `[${new Date().toISOString()}] fullRender: ${reason} (prev=${this.previousLines.length}, new=${nextLineCount}, height=${height})\n`;
		fs.mkdirSync(path.dirname(logPath), { recursive: true });
		fs.appendFileSync(logPath, message);
	}

	private writeRenderDebugLog(
		firstChanged: number,
		viewportTop: number,
		height: number,
		lineDiff: number,
		hardwareCursorRow: number,
		renderEnd: number,
		finalCursorRow: number,
		cursorPos: { row: number; col: number } | null,
		newLines: string[],
		buffer: string,
	): void {
		const debugDir = "/tmp/tui";
		fs.mkdirSync(debugDir, { recursive: true });
		const debugPath = path.join(debugDir, `render-${Date.now()}-${Math.random().toString(36).slice(2)}.log`);
		const debugData = [
			`firstChanged: ${firstChanged}`,
			`viewportTop: ${viewportTop}`,
			`cursorRow: ${this.cursorRow}`,
			`height: ${height}`,
			`lineDiff: ${lineDiff}`,
			`hardwareCursorRow: ${hardwareCursorRow}`,
			`renderEnd: ${renderEnd}`,
			`finalCursorRow: ${finalCursorRow}`,
			`cursorPos: ${JSON.stringify(cursorPos)}`,
			`newLines.length: ${newLines.length}`,
			`previousLines.length: ${this.previousLines.length}`,
			"",
			"=== newLines ===",
			JSON.stringify(newLines, null, 2),
			"",
			"=== previousLines ===",
			JSON.stringify(this.previousLines, null, 2),
			"",
			"=== buffer ===",
			JSON.stringify(buffer),
		].join("\n");
		fs.writeFileSync(debugPath, debugData);
	}

	protected doRender(): void {
		if (this.stopped) return;
		const width = this.terminal.columns;
		const height = this.terminal.rows;
		const widthChanged = this.previousWidth !== 0 && this.previousWidth !== width;
		const heightChanged = this.previousHeight !== 0 && this.previousHeight !== height;
		const hasViewportDocument = this.children.some(isLineViewportComponent);
		if (
			!widthChanged &&
			!heightChanged &&
			this.previousLines.length > 0 &&
			hasViewportDocument &&
			this.renderVisibleDocument(width, height)
		) {
			return;
		}
		if (hasViewportDocument) this.recordFullHistoryFallback();
		this.viewportWindowStart = undefined;
		this.viewportDocumentHeight = undefined;
		const previousBufferLength = this.previousHeight > 0 ? this.previousViewportTop + this.previousHeight : height;
		let prevViewportTop = heightChanged ? Math.max(0, previousBufferLength - height) : this.previousViewportTop;
		let viewportTop = prevViewportTop;
		let hardwareCursorRow = this.hardwareCursorRow;
		// Render all components to get new lines
		let newLines = this.render(width);
		const generatedDocumentHeight = newLines.length;
		this.recordRootRender(newLines.length, Math.min(newLines.length, height));

		// Composite overlays into the rendered lines (before differential compare)
		if (this.hasOverlayEntries) {
			newLines = this.compositeOverlays(newLines, width, height);
		}

		// Extract cursor position before applying line resets (marker must be found first)
		const cursorPos = this.extractCursorPosition(newLines, height);

		newLines = this.applyLineResets(newLines);

		// First render - just output everything without clearing (assumes clean screen)
		if (this.previousLines.length === 0 && !widthChanged && !heightChanged) {
			this.logFullRedraw("first render", newLines.length, height);
			this.renderFullFrame(false, newLines, width, height, cursorPos, hasViewportDocument, generatedDocumentHeight);
			return;
		}

		// Width changes always need a full re-render because wrapping changes.
		if (widthChanged) {
			this.logFullRedraw(`terminal width changed (${this.previousWidth} -> ${width})`, newLines.length, height);
			this.renderFullFrame(true, newLines, width, height, cursorPos, hasViewportDocument, generatedDocumentHeight);
			return;
		}

		// Height changes normally need a full re-render to keep the visible viewport aligned,
		// but Termux changes height when the software keyboard shows or hides.
		// In that environment, a full redraw causes the entire history to replay on every toggle.
		if (heightChanged && !isTermuxSession()) {
			this.logFullRedraw(`terminal height changed (${this.previousHeight} -> ${height})`, newLines.length, height);
			this.renderFullFrame(true, newLines, width, height, cursorPos, hasViewportDocument, generatedDocumentHeight);
			return;
		}

		// Content shrunk below the working area and no overlays - re-render to clear empty rows
		// (overlays need the padding, so only do this when no overlays are active)
		// Configurable via setClearOnShrink() or SP_CLEAR_ON_SHRINK=0 env var
		if (this.getClearOnShrink() && newLines.length < this.maxLinesRendered && !this.hasOverlayEntries) {
			this.logFullRedraw(`clearOnShrink (maxLinesRendered=${this.maxLinesRendered})`, newLines.length, height);
			this.renderFullFrame(true, newLines, width, height, cursorPos, hasViewportDocument, generatedDocumentHeight);
			return;
		}

		// Find first and last changed lines
		let firstChanged = -1;
		let lastChanged = -1;
		const maxLines = Math.max(newLines.length, this.previousLines.length);
		for (let i = 0; i < maxLines; i++) {
			const oldLine = i < this.previousLines.length ? this.previousLines[i] : "";
			const newLine = i < newLines.length ? newLines[i] : "";

			if (oldLine !== newLine) {
				if (firstChanged === -1) {
					firstChanged = i;
				}
				lastChanged = i;
			}
		}
		const appendedLines = newLines.length > this.previousLines.length;
		if (appendedLines) {
			if (firstChanged === -1) {
				firstChanged = this.previousLines.length;
			}
			lastChanged = newLines.length - 1;
		}
		if (firstChanged !== -1) {
			this.expandChangedRangeForKittyImages(firstChanged, lastChanged, newLines);
			firstChanged = this.expandedFirstChanged;
			lastChanged = this.expandedLastChanged;
		}
		const appendStart = appendedLines && firstChanged === this.previousLines.length && firstChanged > 0;

		// No changes - but still need to update hardware cursor position if it moved
		if (firstChanged === -1) {
			this.positionHardwareCursor(cursorPos, newLines.length);
			this.previousViewportTop = prevViewportTop;
			this.previousHeight = height;
			this.captureViewportMutationTokens(width, hasViewportDocument ? generatedDocumentHeight : undefined);
			return;
		}

		// All changes are in deleted lines (nothing to render, just clear)
		if (firstChanged >= newLines.length) {
			if (this.previousLines.length > newLines.length) {
				let buffer = "\x1b[?2026h";
				buffer += this.deleteChangedKittyImages(firstChanged, lastChanged);
				// Move to end of new content (clamp to 0 for empty content)
				const targetRow = Math.max(0, newLines.length - 1);
				if (targetRow < prevViewportTop) {
					this.logFullRedraw(`deleted lines moved viewport up (${targetRow} < ${prevViewportTop})`, newLines.length, height);
					this.renderFullFrame(true, newLines, width, height, cursorPos, hasViewportDocument, generatedDocumentHeight);
					return;
				}
				const lineDiff = this.computeLineDiff(hardwareCursorRow, prevViewportTop, targetRow, viewportTop);
				if (lineDiff > 0) buffer += `\x1b[${lineDiff}B`;
				else if (lineDiff < 0) buffer += `\x1b[${-lineDiff}A`;
				buffer += "\r";
				// Clear extra lines without scrolling
				const extraLines = this.previousLines.length - newLines.length;
				if (extraLines > height) {
					this.logFullRedraw(`extraLines > height (${extraLines} > ${height})`, newLines.length, height);
					this.renderFullFrame(true, newLines, width, height, cursorPos, hasViewportDocument, generatedDocumentHeight);
					return;
				}
				const clearStartOffset = newLines.length === 0 ? 0 : 1;
				if (extraLines > 0 && clearStartOffset > 0) {
					buffer += `\x1b[${clearStartOffset}B`;
				}
				for (let i = 0; i < extraLines; i++) {
					buffer += "\r\x1b[2K";
					if (i < extraLines - 1) buffer += "\x1b[1B";
				}
				const moveBack = Math.max(0, extraLines - 1 + clearStartOffset);
				if (moveBack > 0) {
					buffer += `\x1b[${moveBack}A`;
				}
				buffer += "\x1b[?2026l";
				this.writeTerminalFrame(buffer, extraLines);
				this.cursorRow = targetRow;
				this.hardwareCursorRow = targetRow;
			}
			this.positionHardwareCursor(cursorPos, newLines.length);
			this.previousLines = newLines;
			this.previousKittyImageIds = this.collectKittyImageIds(newLines);
			this.previousWidth = width;
			this.previousHeight = height;
			this.previousViewportTop = prevViewportTop;
			this.captureViewportMutationTokens(width, hasViewportDocument ? generatedDocumentHeight : undefined);
			return;
		}

		// Differential rendering can only touch what was actually visible.
		// If the first changed line is above the previous viewport, we need a full redraw.
		if (firstChanged < prevViewportTop) {
			this.logFullRedraw(`firstChanged < viewportTop (${firstChanged} < ${prevViewportTop})`, newLines.length, height);
			this.renderFullFrame(true, newLines, width, height, cursorPos, hasViewportDocument, generatedDocumentHeight);
			return;
		}

		// Render from first changed line to end
		// Build buffer with all updates wrapped in synchronized output
		let buffer = "\x1b[?2026h"; // Begin synchronized output
		buffer += this.deleteChangedKittyImages(firstChanged, lastChanged);
		const prevViewportBottom = prevViewportTop + height - 1;
		const moveTargetRow = appendStart ? firstChanged - 1 : firstChanged;
		if (moveTargetRow > prevViewportBottom) {
			const currentScreenRow = Math.max(0, Math.min(height - 1, hardwareCursorRow - prevViewportTop));
			const moveToBottom = height - 1 - currentScreenRow;
			if (moveToBottom > 0) {
				buffer += `\x1b[${moveToBottom}B`;
			}
			const scroll = moveTargetRow - prevViewportBottom;
			buffer += "\r\n".repeat(scroll);
			prevViewportTop += scroll;
			viewportTop += scroll;
			hardwareCursorRow = moveTargetRow;
		}

		// Move cursor to first changed line (use hardwareCursorRow for actual position)
		const lineDiff = this.computeLineDiff(hardwareCursorRow, prevViewportTop, moveTargetRow, viewportTop);
		if (lineDiff > 0) {
			buffer += `\x1b[${lineDiff}B`; // Move down
		} else if (lineDiff < 0) {
			buffer += `\x1b[${-lineDiff}A`; // Move up
		}

		buffer += appendStart ? "\r\n" : "\r"; // Move to column 0

		// Only render changed lines (firstChanged to lastChanged), not all lines to end
		// This reduces flicker when only a single line changes (e.g., spinner animation)
		const renderEnd = Math.min(lastChanged, newLines.length - 1);
		for (let i = firstChanged; i <= renderEnd; i++) {
			if (i > firstChanged) buffer += "\r\n";
			const line = newLines[i];
			const isImage = isImageLine(line);
			const imageReservedRows = isImage ? this.getKittyImageReservedRows(newLines, i, renderEnd) : 1;
			if (imageReservedRows > 1) {
				const imageStartScreenRow = i - viewportTop;
				if (imageStartScreenRow < 0 || imageStartScreenRow + imageReservedRows > height) {
					this.logFullRedraw(
						`kitty image pre-clear would scroll (${imageStartScreenRow} + ${imageReservedRows} > ${height})`,
						newLines.length,
						height,
					);
					this.renderFullFrame(true, newLines, width, height, cursorPos, hasViewportDocument, generatedDocumentHeight);
					return;
				}

				buffer += "\x1b[2K";
				for (let row = 1; row < imageReservedRows; row++) {
					buffer += "\r\n\x1b[2K";
				}
				buffer += `\x1b[${imageReservedRows - 1}A`;
				buffer += line;
				buffer += `\x1b[${imageReservedRows - 1}B`;
				i += imageReservedRows - 1;
				continue;
			}

			buffer += "\x1b[2K"; // Clear current line
			if (!isImage && visibleWidth(line) > width) {
				// Log all lines to crash file for debugging
				const crashLogPath = path.join(this.logDirectory, "pi-crash.log");
				let crashData = `Crash at ${new Date().toISOString()}\nTerminal width: ${width}\n`;
				crashData += `Line ${i} visible width: ${visibleWidth(line)}\n\n=== All rendered lines ===\n`;
				for (let lineIndex = 0; lineIndex < newLines.length; lineIndex++) {
					const renderedLine = newLines[lineIndex];
					crashData += `[${lineIndex}] (w=${visibleWidth(renderedLine)}) ${renderedLine}\n`;
				}
				fs.mkdirSync(path.dirname(crashLogPath), { recursive: true });
				fs.writeFileSync(crashLogPath, crashData);

				// Clean up terminal state before throwing
				void this.stop();

				const errorMsg = [
					`Rendered line ${i} exceeds terminal width (${visibleWidth(line)} > ${width}).`,
					"",
					"This is likely caused by a custom TUI component not truncating its output.",
					"Use visibleWidth() to measure and truncateToWidth() to truncate lines.",
					"",
					`Debug log written to: ${crashLogPath}`,
				].join("\n");
				throw new Error(errorMsg);
			}
			buffer += line;
		}

		// Track where cursor ended up after rendering
		let finalCursorRow = renderEnd;

		// If we had more lines before, clear them and move cursor back
		if (this.previousLines.length > newLines.length) {
			// Move to end of new content first if we stopped before it
			if (renderEnd < newLines.length - 1) {
				const moveDown = newLines.length - 1 - renderEnd;
				buffer += `\x1b[${moveDown}B`;
				finalCursorRow = newLines.length - 1;
			}
			const extraLines = this.previousLines.length - newLines.length;
			for (let i = newLines.length; i < this.previousLines.length; i++) {
				buffer += "\r\n\x1b[2K";
			}
			// Move cursor back to end of new content
			buffer += `\x1b[${extraLines}A`;
		}

		buffer += "\x1b[?2026l"; // End synchronized output

		if (process.env.SP_TUI_DEBUG === "1") {
			this.writeRenderDebugLog(
				firstChanged,
				viewportTop,
				height,
				lineDiff,
				hardwareCursorRow,
				renderEnd,
				finalCursorRow,
				cursorPos,
				newLines,
				buffer,
			);
		}

		// Write entire buffer at once
		this.writeTerminalFrame(
			buffer,
			renderEnd - firstChanged + 1 + Math.max(0, this.previousLines.length - newLines.length),
		);

		// Track cursor position for next render
		// cursorRow tracks end of content (for viewport calculation)
		// hardwareCursorRow tracks actual terminal cursor position (for movement)
		this.cursorRow = Math.max(0, newLines.length - 1);
		this.hardwareCursorRow = finalCursorRow;
		// Track terminal's working area (grows but doesn't shrink unless cleared)
		this.maxLinesRendered = Math.max(this.maxLinesRendered, newLines.length);
		this.previousViewportTop = Math.max(prevViewportTop, finalCursorRow - height + 1);

		// Position hardware cursor for IME
		this.positionHardwareCursor(cursorPos, newLines.length);

		this.previousLines = newLines;
		this.previousKittyImageIds = this.collectKittyImageIds(newLines);
		this.previousWidth = width;
		this.previousHeight = height;
		this.captureViewportMutationTokens(width, hasViewportDocument ? generatedDocumentHeight : undefined);
	}

	/**
	 * Diff only the visible line window after the first full main-screen render.
	 * Returns false for shrink/backward movement or Kitty content so the established
	 * full renderer can preserve those terminal-specific semantics.
	 */
	private renderVisibleDocument(width: number, height: number): boolean {
		const previousDocumentHeight = this.viewportDocumentHeight ?? this.previousLines.length;
		const previousStart = this.viewportWindowStart ?? Math.max(0, previousDocumentHeight - height);
		const previousWindow =
			this.viewportWindowStart === undefined ? this.previousLines.slice(previousStart) : this.previousLines;
		// The production transcript is a single indexed document. Ask it for the
		// tail directly so dirty active lines are measured and consumed by one query.
		// Composite roots retain the generic path and its conservative attribution.
		let rendered: LineViewportRender;
		if (this.children.length === 1 && isLineViewportComponent(this.children[0])) {
			rendered = this.children[0].renderViewportTail(width, height);
			this.frameRootHeights.length = 1;
			this.frameRootHeights[0] = rendered.totalHeight;
		} else {
			rendered = this.renderRootViewportTail(width, height);
		}
		const totalHeight = rendered.totalHeight;
		const mutation = this.observeViewportMutations(width);
		if (mutation.kind === "unsafe") return false;
		if (
			totalHeight !== previousDocumentHeight &&
			mutation.kind !== "tail-append" &&
			!(mutation.kind === "range" && mutation.heightChanged)
		) {
			return false;
		}
		if (mutation.kind === "tail-append" && totalHeight < previousDocumentHeight) return false;
		if (
			mutation.kind === "range" &&
			(mutation.earliestChangedLine === undefined ||
				mutation.latestChangedLine === undefined ||
					mutation.earliestChangedLine < previousStart ||
					mutation.earliestChangedLine >= previousStart + previousWindow.length ||
					(!mutation.heightChanged &&
						mutation.latestChangedLine > previousStart + previousWindow.length))
		) {
			return false;
		}
		const requestedStart = Math.max(0, totalHeight - height);
		if (requestedStart < previousStart) return false;

		const sourceOffset = Math.max(0, requestedStart - rendered.startLine);
		let nextWindow =
			sourceOffset === 0 && rendered.lines.length <= height
				? rendered.lines
				: rendered.lines.slice(sourceOffset, sourceOffset + height);
		this.recordRootRender(totalHeight, Math.min(nextWindow.length, height));
		if (this.hasOverlayEntries) nextWindow = this.compositeOverlays(nextWindow, width, height);
		const cursorPos = this.extractCursorPosition(nextWindow, height);
		nextWindow = this.applyLineResets(nextWindow);

		if (
			rendered.leadingKittyImage ||
			previousWindow.some(isImageLine) ||
			nextWindow.some(isImageLine) ||
			requestedStart - previousStart > height
		) {
			return false;
		}

		const shiftedRows = requestedStart - previousStart;
		const expectedOffset = shiftedRows;
		let buffer = "\x1b[?2026h";
		let writeCursorRow = this.hardwareCursorRow;
		if (shiftedRows > 0) {
			buffer += `\x1b[${height};1H`;
			buffer += "\r\n".repeat(shiftedRows);
			writeCursorRow = Math.max(0, totalHeight - 1);
		}

		let diffLines = 0;
		const comparisonLength = Math.max(nextWindow.length, Math.max(0, previousWindow.length - expectedOffset));
		for (let row = 0; row < comparisonLength; row++) {
			const previousLine = previousWindow[row + expectedOffset] ?? "";
			const nextLine = nextWindow[row] ?? "";
			if (previousLine === nextLine) continue;
			const targetRow = requestedStart + row;
			const rowDelta = targetRow - writeCursorRow;
			if (rowDelta > 0) buffer += `\x1b[${rowDelta}B`;
			else if (rowDelta < 0) buffer += `\x1b[${-rowDelta}A`;
			buffer += `\r\x1b[2K${nextLine}`;
			diffLines++;
			writeCursorRow = targetRow;
		}
		buffer += "\x1b[?2026l";
		if (shiftedRows > 0 || diffLines > 0) {
			this.writeTerminalFrame(buffer, diffLines + shiftedRows);
			this.hardwareCursorRow = writeCursorRow;
		}

		this.previousLines = nextWindow;
		// A successful bounded frame contains only text. Preserve IDs owned by
		// offscreen history so the next full replay can delete stale placements.
		this.previousWidth = width;
		this.previousHeight = height;
		this.viewportWindowStart = requestedStart;
		this.viewportDocumentHeight = totalHeight;
		this.previousViewportTop = requestedStart;
		this.cursorRow = Math.max(0, totalHeight - 1);
		this.maxLinesRendered = Math.max(this.maxLinesRendered, totalHeight);
		const absoluteCursor = cursorPos ? { row: requestedStart + cursorPos.row, col: cursorPos.col } : null;
		this.positionHardwareCursor(absoluteCursor, totalHeight);
		return true;
	}

	private observeViewportMutations(width: number): LineViewportMutationObservation {
		let kind: LineViewportMutationKind = "none";
		let earliestChangedLine: number | undefined;
		let latestChangedLine: number | undefined;
		let heightChanged = false;
		let childStart = 0;
		let changedChildren = 0;
		this.viewportMutationTokens.length = this.children.length;
		for (let index = 0; index < this.children.length; index++) {
			const child = this.children[index];
			if (isLineViewportComponent(child)) {
				const observation = child.observeViewportMutation(
					width,
					this.viewportMutationTokens[index],
					this.viewportMutationScratch,
				);
				this.viewportMutationTokens[index] = observation.token;
				if (observation.kind !== "none") {
					changedChildren++;
					if (kind !== "none" || changedChildren > 1 || observation.kind === "unsafe") {
						kind = "unsafe";
					} else {
						kind = observation.kind;
						if (observation.earliestChangedLine !== undefined) {
							earliestChangedLine = childStart + observation.earliestChangedLine;
						}
						if (observation.latestChangedLine !== undefined) {
							latestChangedLine = childStart + observation.latestChangedLine;
						}
						heightChanged = observation.heightChanged === true;
					}
				}
			} else {
				this.viewportMutationTokens[index] = undefined;
			}
			childStart += this.frameRootHeights[index] ?? 0;
		}
		this.viewportMutationSummary.token = 0;
		this.viewportMutationSummary.kind = kind;
		this.viewportMutationSummary.earliestChangedLine = earliestChangedLine;
		this.viewportMutationSummary.latestChangedLine = latestChangedLine;
		this.viewportMutationSummary.heightChanged = heightChanged;
		return this.viewportMutationSummary;
	}

	private captureViewportMutationTokens(width: number, documentHeight: number | undefined): void {
		this.viewportMutationTokens.length = this.children.length;
		for (let index = 0; index < this.children.length; index++) {
			const child = this.children[index];
			this.viewportMutationTokens[index] = isLineViewportComponent(child)
				? child.observeViewportMutation(width, undefined, this.viewportMutationScratch).token
				: undefined;
		}
		this.viewportWindowStart = undefined;
		this.viewportDocumentHeight = documentHeight;
	}

	private renderRootViewportTail(width: number, height: number): LineViewportRender {
		const safeHeight = Math.max(0, Math.floor(height));
		const childCount = this.children.length;
		this.frameRootHeights.length = childCount;
		this.frameRootLines.length = childCount;
		this.frameRootLineStarts.length = childCount;
		this.frameRootLeadingKittyImages.length = childCount;
		let totalHeight = 0;
		let remaining = safeHeight;
		for (let index = childCount - 1; index >= 0; index--) {
			const child = this.children[index];
			let childHeight: number;
			if (isLineViewportComponent(child)) {
				if (remaining > 0) {
					const childRender = child.renderViewportTail(width, remaining);
					childHeight = childRender.totalHeight;
					this.frameRootLines[index] = childRender.lines;
					this.frameRootLineStarts[index] = childRender.startLine;
					this.frameRootLeadingKittyImages[index] = childRender.leadingKittyImage;
				} else {
					childHeight = child.getContentHeight(width);
					this.frameRootLines[index] = undefined;
					this.frameRootLineStarts[index] = childHeight;
					this.frameRootLeadingKittyImages[index] = undefined;
				}
			} else {
				const childLines = child.render(width);
				childHeight = childLines.length;
				this.frameRootLines[index] = remaining > 0 ? childLines : undefined;
				this.frameRootLineStarts[index] = Math.max(0, childHeight - remaining);
				this.frameRootLeadingKittyImages[index] = undefined;
			}
			this.frameRootHeights[index] = childHeight;
			totalHeight += childHeight;
			remaining = Math.max(0, remaining - childHeight);
		}

		const requestedStart = Math.max(0, totalHeight - safeHeight);
		const lines = this.previousLines === this.boundedFrameLinesA
			? this.boundedFrameLinesB
			: this.boundedFrameLinesA;
		lines.length = 0;
		let childAbsoluteStart = 0;
		let leadingKittyImage: LineViewportRender["leadingKittyImage"];
		try {
			for (let index = 0; index < childCount; index++) {
				const childLines = this.frameRootLines[index];
				if (childLines) {
					const childLineStart = this.frameRootLineStarts[index];
					for (let lineIndex = 0; lineIndex < childLines.length; lineIndex++) {
						const absoluteLine = childAbsoluteStart + childLineStart + lineIndex;
						if (absoluteLine >= requestedStart && lines.length < safeHeight) lines.push(childLines[lineIndex]);
					}
					const childLeading = this.frameRootLeadingKittyImages[index];
					if (!leadingKittyImage && childLeading) {
						leadingKittyImage = {
							line: childLeading.line,
							absoluteRow: childAbsoluteStart + childLeading.absoluteRow,
						};
					}
				}
				childAbsoluteStart += this.frameRootHeights[index];
			}
		} finally {
			for (let index = 0; index < childCount; index++) {
				this.frameRootLines[index] = undefined;
				this.frameRootLeadingKittyImages[index] = undefined;
			}
		}
		this.rootFrameRender.lines = lines;
		this.rootFrameRender.startLine = requestedStart;
		this.rootFrameRender.totalHeight = totalHeight;
		this.rootFrameRender.leadingKittyImage = leadingKittyImage;
		return this.rootFrameRender;
	}

	/**
	 * Position the hardware cursor for IME candidate window.
	 * @param cursorPos The cursor position extracted from rendered output, or null
	 * @param totalLines Total number of rendered lines
	 */
	private positionHardwareCursor(cursorPos: { row: number; col: number } | null, totalLines: number): void {
		if (!cursorPos || totalLines <= 0) {
			this.writeTerminalFrame("\x1b[?25l", 0);
			return;
		}

		// Clamp cursor position to valid range
		const targetRow = Math.max(0, Math.min(cursorPos.row, totalLines - 1));
		const targetCol = Math.max(0, cursorPos.col);

		// Move cursor from current position to target
		const rowDelta = targetRow - this.hardwareCursorRow;
		let buffer = "";
		if (rowDelta > 0) {
			buffer += `\x1b[${rowDelta}B`; // Move down
		} else if (rowDelta < 0) {
			buffer += `\x1b[${-rowDelta}A`; // Move up
		}
		// Move to absolute column (1-indexed)
		buffer += `\x1b[${targetCol + 1}G`;

		this.hardwareCursorRow = targetRow;
		if (this.getShowHardwareCursor()) {
			buffer += "\x1b[?25h";
		} else {
			buffer += "\x1b[?25l";
		}
		this.writeTerminalFrame(buffer, 0);
	}
}
