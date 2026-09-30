import { stripVTControlCharacters } from "node:util";
import {
	Key,
	matchesKey,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@super-pi/tui";
import type { MenuScreen, ReviewScreen } from "../types.js";
import type {
	MenuKeybindings,
	MenuScreenComponent,
	MenuScreenComponentOptions,
} from "./contracts.js";
import { appendMutedLines, menuHint, renderFrame, safeMenuText, truncateOwnedLines } from "./rendering.js";
import { getLanguageFromPath, highlightCode } from "./syntax-highlighting.js";

const DEFAULT_REVIEW_VIEWPORT_SIZE = 14;
const RPC_REVIEW_VIEWPORT_SIZE = 8;
const RPC_REVIEW_LINE_WIDTH = 120;
const RESERVED_HOST_ROWS = 3;
const TAB_SIZE = 4;
const CR_PATTERN = /\r\n?/gu;
const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

export type ReviewOptions<
	ScreenId extends string,
	ActionId extends string,
> = MenuScreenComponentOptions<ScreenId, ActionId> & {
	screen: Extract<MenuScreen<ScreenId, ActionId>, { kind: "review" }>;
};

export function createReviewComponent<ScreenId extends string, ActionId extends string>(
	options: ReviewOptions<ScreenId, ActionId>,
): MenuScreenComponent {
	let scrollOffset = 0;
	let lastMaximumScroll = 0;
	let lastViewportSize = reviewViewportSize(options.screen);
	let disposed = false;

	const moveTo = (offset: number) => {
		scrollOffset = Math.max(0, Math.min(offset, lastMaximumScroll));
		options.tui.requestRender();
	};

	return {
		render(width) {
			const safeWidth = Math.max(1, width);
			const allLines = formatReviewLines(options.screen, safeWidth, options.theme);
			const terminalRows =
				options.screen.viewportSize === "adaptive" ? options.tui.terminal.rows : undefined;
			if (terminalRows !== undefined && Number.isFinite(terminalRows)) {
				const frame = renderAdaptiveReviewFrame({
					screen: options.screen,
					allLines,
					width: safeWidth,
					terminalRows,
					scrollOffset,
					theme: options.theme,
					keybindings: options.keybindings,
				});
				scrollOffset = frame.scrollOffset;
				lastMaximumScroll = frame.maximumScroll;
				lastViewportSize = frame.viewportSize;
				return frame.lines;
			}

			const viewportSize = reviewViewportSize(options.screen);
			lastMaximumScroll = Math.max(0, allLines.length - viewportSize);
			scrollOffset = Math.max(0, Math.min(scrollOffset, lastMaximumScroll));
			lastViewportSize = viewportSize;
			const visible = allLines.slice(scrollOffset, scrollOffset + viewportSize);
			const first = allLines.length === 0 ? 0 : scrollOffset + 1;
			const last = Math.min(allLines.length, scrollOffset + viewportSize);
			const position =
				allLines.length > viewportSize
					? [options.theme.fg("dim", `${first}-${last}/${allLines.length}`)]
					: [];
			return renderFrame(
				options.screen.title,
				options.screen.lines ?? [],
				[...visible, ...position],
				options.screen.hint ?? "back",
				safeWidth,
				options,
				options.screen.confirm ? safeMenuText(options.screen.confirm.label) : "",
			);
		},
		invalidate() {},
		handleInput(data) {
			if (disposed) return;
			if (matchesKey(data, Key.ctrl("c"))) options.onEvent({ kind: "close" });
			else if (options.keybindings.matches(data, "tui.select.cancel")) {
				options.onEvent({ kind: options.screen.hint ?? "back" });
			} else if (options.keybindings.matches(data, "tui.select.up")) {
				moveTo(scrollOffset - 1);
			} else if (options.keybindings.matches(data, "tui.select.down")) {
				moveTo(scrollOffset + 1);
			} else if (options.keybindings.matches(data, "tui.select.pageUp")) {
				moveTo(scrollOffset - lastViewportSize);
			} else if (options.keybindings.matches(data, "tui.select.pageDown")) {
				moveTo(scrollOffset + lastViewportSize);
			} else if (matchesKey(data, Key.home)) moveTo(0);
			else if (matchesKey(data, Key.end)) moveTo(lastMaximumScroll);
			else if (options.screen.confirm && options.keybindings.matches(data, "tui.select.confirm")) {
				options.onEvent({ kind: "activate", itemId: options.screen.confirm.id });
			}
		},
		async waitForPending() {},
		dispose() {
			if (disposed) return;
			disposed = true;
			options.onDispose?.();
		},
	};
}

interface AdaptiveReviewFrameOptions<ActionId extends string> {
	screen: ReviewScreen<ActionId>;
	allLines: readonly string[];
	width: number;
	terminalRows: number;
	scrollOffset: number;
	theme: MenuScreenComponentOptions<string, ActionId>["theme"];
	keybindings: MenuKeybindings;
}

interface AdaptiveReviewFrame {
	lines: string[];
	scrollOffset: number;
	maximumScroll: number;
	viewportSize: number;
}

interface AdaptiveReviewChrome {
	header: string[];
	separator: boolean;
	hint: string[];
	showPosition: boolean;
	viewportSize: number;
}

function renderAdaptiveReviewFrame<ActionId extends string>(
	options: AdaptiveReviewFrameOptions<ActionId>,
): AdaptiveReviewFrame {
	const availableRows = Math.max(1, Math.floor(options.terminalRows) - RESERVED_HOST_ROWS);
	const destination = options.screen.hint ?? "back";
	const confirmAction = options.screen.confirm ? safeMenuText(options.screen.confirm.label) : "";
	const fullHeader = wrapTextWithAnsi(
			options.theme.fg("accent", options.theme.bold(safeMenuText(options.screen.title))),
			options.width,
		);
	appendMutedLines(fullHeader, options.screen.lines ?? [], options.width, options.theme);
	truncateOwnedLines(fullHeader, options.width);
	const fullHint = truncateOwnedLines(wrapTextWithAnsi(
		options.theme.fg("dim", menuHint(options.keybindings, destination, confirmAction)),
		options.width,
	), options.width);
	const criticalHint = truncateToWidth(
		options.theme.fg("dim", compactReviewHint(options.keybindings, destination, confirmAction)),
		options.width,
		"",
	);

	let chrome = allocateAdaptiveReviewChrome(
		availableRows,
		fullHeader,
		fullHint,
		criticalHint,
		false,
	);
	if (availableRows >= 4 && options.allLines.length > chrome.viewportSize) {
		chrome = allocateAdaptiveReviewChrome(availableRows, fullHeader, fullHint, criticalHint, true);
	}

	const maximumScroll = Math.max(0, options.allLines.length - chrome.viewportSize);
	const scrollOffset = Math.max(0, Math.min(options.scrollOffset, maximumScroll));
	const first = options.allLines.length === 0 ? 0 : scrollOffset + 1;
	const last = Math.min(options.allLines.length, scrollOffset + chrome.viewportSize);
	const position = chrome.showPosition
		? [options.theme.fg("dim", `${first}-${last}/${options.allLines.length}`)]
		: [];
	const lines: string[] = [];
	for (const line of chrome.header) lines.push(line);
	if (chrome.separator) lines.push("");
	for (let index = scrollOffset; index < Math.min(options.allLines.length, scrollOffset + chrome.viewportSize); index++) lines.push(options.allLines[index]!);
	for (const line of position) lines.push(line);
	for (const line of chrome.hint) lines.push(line);
	truncateOwnedLines(lines, options.width);

	return { lines, scrollOffset, maximumScroll, viewportSize: chrome.viewportSize };
}

function allocateAdaptiveReviewChrome(
	availableRows: number,
	fullHeader: readonly string[],
	fullHint: readonly string[],
	criticalHint: string,
	showPosition: boolean,
): AdaptiveReviewChrome {
	if (availableRows === 1) {
		return { header: [], separator: false, hint: [], showPosition: false, viewportSize: 1 };
	}
	const compactHeader = [fullHeader[0] ?? ""];
	if (availableRows === 2) {
		return {
			header: compactHeader,
			separator: false,
			hint: [],
			showPosition: false,
			viewportSize: 1,
		};
	}
	if (availableRows === 3) {
		return {
			header: compactHeader,
			separator: false,
			hint: [criticalHint],
			showPosition: false,
			viewportSize: 1,
		};
	}

	let remainingRows = availableRows - 3 - Number(showPosition);
	const extraHeaderCount = Math.min(remainingRows, Math.max(0, fullHeader.length - 1));
	const header = [...compactHeader, ...fullHeader.slice(1, 1 + extraHeaderCount)];
	remainingRows -= extraHeaderCount;

	let hint = [criticalHint];
	const fullHintExtraRows = Math.max(0, fullHint.length - 1);
	if (remainingRows > 0 && fullHint.length > 0 && fullHintExtraRows <= remainingRows) {
		hint = [...fullHint];
		remainingRows -= fullHintExtraRows;
	}

	const separator = remainingRows > 0;
	if (separator) remainingRows -= 1;
	return {
		header,
		separator,
		hint,
		showPosition,
		viewportSize: 1 + remainingRows,
	};
}

function compactReviewHint(
	keybindings: MenuKeybindings,
	destination: "back" | "close",
	confirmAction: string,
) {
	const confirm = reviewBindingText(keybindings, "tui.select.confirm");
	const cancel = reviewBindingText(keybindings, "tui.select.cancel", "ctrl+c");
	const up = reviewBindingText(keybindings, "tui.select.up");
	const down = reviewBindingText(keybindings, "tui.select.down");
	let hint = confirm && confirmAction ? `${confirm} ${confirmAction}` : "";
	if (cancel) hint += (hint ? " • " : "") + `${cancel} ${destination}`;
	if (destination === "back" || !cancel) hint += (hint ? " • " : "") + "ctrl+c close";
	if (up || down) hint += (hint ? " • " : "") + `${up}${up && down ? "/" : ""}${down} navigate`;
	return hint;
}

function reviewBindingText(
	keybindings: MenuKeybindings,
	binding: Parameters<MenuKeybindings["getKeys"]>[0],
	excluded?: string,
) {
	let text = "";
	for (const key of keybindings.getKeys(binding)) {
		if (key === excluded) continue;
		const label = key === "up" ? "↑" : key === "down" ? "↓" : key === "escape" ? "esc" : safeMenuText(key);
		if (label) text += (text ? "/" : "") + label;
	}
	return text;
}

export function reviewDialogPages<ActionId extends string>(
	screen: ReviewScreen<ActionId>,
): string[][] {
	const lines = plainReviewLines(screen.content, RPC_REVIEW_LINE_WIDTH);
	const pageSize = reviewDialogPageSize(screen);
	const pages: string[][] = [];
	for (let index = 0; index < lines.length; index += pageSize) {
		pages.push(lines.slice(index, index + pageSize));
	}
	return pages.length > 0 ? pages : [[""]];
}

function formatReviewLines<ActionId extends string>(
	screen: ReviewScreen<ActionId>,
	width: number,
	theme: MenuScreenComponentOptions<string, ActionId>["theme"],
): string[] {
	const segments = reviewSegments(screen.content, width);
	const format = screen.format ?? { kind: "text" as const };
	const lines: string[] = [];
	const language = format.kind === "code" ? format.language ?? (format.filePath ? getLanguageFromPath(format.filePath) : undefined) : undefined;
	for (const {source,text} of segments) {
		if (format.kind === "code") lines.push(highlightCode(text, language, theme));
		else if (format.kind === "diff") {
			const color = source.startsWith("@@") ? "accent" : source.startsWith("+") && !source.startsWith("+++") ? "toolDiffAdded" : source.startsWith("-") && !source.startsWith("---") ? "toolDiffRemoved" : "toolDiffContext";
			lines.push(theme.fg(color, text));
		} else lines.push(theme.fg("text", text));
	}
	return lines;
}

function plainReviewLines(content: string, width: number): string[] {
	const lines: string[] = [];
	for (const segment of reviewSegments(content, width)) lines.push(segment.text);
	return lines;
}

function reviewSegments(content: string, width: number) {
	const safe = sanitizeDocumentText(content);
	const segments: { source: string; text: string }[] = [];
	for (const line of safe.split("\n")) {
		const source = expandTabs(line);
		for (const text of hardWrapLine(source, width)) segments.push({ source, text });
	}
	return segments;
}

export function sanitizeDocumentText(value: unknown): string {
	const stripped = stripVTControlCharacters(typeof value === "string" ? value : String(value)).replace(CR_PATTERN, "\n");
	let text = "";
	for (const character of stripped) {
		if (character === "\n" || character === "\t") { text += character; continue; }
		const codePoint = character.codePointAt(0) ?? 0;
		text += codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f) ? " " : character;
	}
	return text;
}

function expandTabs(line: string): string {
	let column = 0;
	let result = "";
	for (const { segment } of graphemeSegmenter.segment(line)) {
		if (segment === "\t") {
			const count = TAB_SIZE - (column % TAB_SIZE);
			result += " ".repeat(count);
			column += count;
			continue;
		}
		result += segment;
		column += visibleWidth(segment);
	}
	return result;
}

function hardWrapLine(line: string, width: number): string[] {
	const safeWidth = Math.max(1, width);
	if (line.length === 0) return [""];
	const lines: string[] = [];
	let current = "";
	let currentWidth = 0;
	for (const { segment } of graphemeSegmenter.segment(line)) {
		const segmentWidth = visibleWidth(segment);
		if (segmentWidth > safeWidth) {
			if (current.length > 0) { lines.push(current); current = ""; currentWidth = 0; }
			lines.push("?".repeat(safeWidth));
			continue;
		}
		if (currentWidth + segmentWidth > safeWidth && current.length > 0) { lines.push(current); current = ""; currentWidth = 0; }
		current += segment;
		currentWidth += segmentWidth;
	}
	if (current.length > 0 || lines.length === 0) lines.push(current);
	return lines;
}

function reviewViewportSize<ActionId extends string>(screen: ReviewScreen<ActionId>) {
	return typeof screen.viewportSize === "number"
		? screen.viewportSize
		: DEFAULT_REVIEW_VIEWPORT_SIZE;
}

function reviewDialogPageSize<ActionId extends string>(screen: ReviewScreen<ActionId>) {
	return typeof screen.viewportSize === "number"
		? Math.min(screen.viewportSize, RPC_REVIEW_VIEWPORT_SIZE)
		: RPC_REVIEW_VIEWPORT_SIZE;
}
