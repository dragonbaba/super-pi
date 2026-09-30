import { stripVTControlCharacters } from "node:util";
import {
	type Focusable,
	fuzzyFilter,
	Input,
	Key,
	matchesKey,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@super-pi/tui";
import type { MenuBrowseItem } from "../types.js";
import type { BrowseOptions, MenuKeybindings, MenuScreenComponent } from "./contracts.js";
import { appendMutedLines, findItemIndex, handleSearchInput, safeMenuText } from "./rendering.js";
import { reviewDialogPages } from "./review.js";

const RESERVED_HOST_ROWS = 3;
const MAX_CONTEXT_ROWS = 2;

type BrowseView = "list" | "detail";

interface SearchableItem {
	item: MenuBrowseItem;
	label: string;
	statusText: string;
	description: string;
	searchText: string;
}

function searchableItemText(candidate: SearchableItem): string {
	let text = candidate.label;
	if (candidate.statusText) text += (text ? " " : "") + candidate.statusText;
	if (candidate.description) text += (text ? " " : "") + candidate.description;
	if (candidate.searchText) text += (text ? " " : "") + candidate.searchText;
	return text;
}

export function createBrowseComponent<ScreenId extends string, ActionId extends string>(
	options: BrowseOptions<ScreenId, ActionId>,
): MenuScreenComponent {
	const searchInput = new Input();
	const allItems: SearchableItem[] = options.screen.items.map((item) => ({
		item,
		label: safeBrowseText(item.label),
		statusText: safeBrowseText(item.statusText ?? ""),
		description: safeBrowseText(item.description ?? ""),
		searchText: safeBrowseText(item.searchText ?? ""),
	}));
	let filteredItems = [...allItems];
	let selectedIndex = Math.max(
		0,
		filteredItems.findIndex(({ item }) => item.id === options.selectedItemId),
	);
	let restoreItemId: string | undefined;
	let listViewportRows = 1;
	let searchInputVisible = true;
	let detailScrollOffset = 0;
	let detailViewportRows = 1;
	let detailMaximumScroll = 0;
	let view: BrowseView = "list";
	let focused = false;
	let disposed = false;
	const selected = () => filteredItems[selectedIndex];
	const syncFocus = () => {
		searchInput.focused = focused && view === "list" && searchInputVisible;
	};
	const setSelectedIndex = (index: number, wrap: boolean, rememberUserSelection: boolean) => {
		if (filteredItems.length === 0) {
			selectedIndex = 0;
			return;
		}
		selectedIndex = wrap
			? (index + filteredItems.length) % filteredItems.length
			: Math.max(0, Math.min(index, filteredItems.length - 1));
		if (rememberUserSelection) restoreItemId = undefined;
		const itemId = selected()?.item.id;
		if (itemId) options.onSelectionChange?.(itemId);
	};
	const move = (delta: number) => setSelectedIndex(selectedIndex + delta, true, true);
	const page = (delta: number) =>
		setSelectedIndex(selectedIndex + delta * Math.max(1, listViewportRows), false, true);
	const applyFilter = () => {
		const previouslySelectedId = selected()?.item.id;
		filteredItems = fuzzyFilter(allItems, searchInput.getValue(), searchableItemText);
		if (filteredItems.length === 0) {
			if (previouslySelectedId) restoreItemId ??= previouslySelectedId;
			selectedIndex = 0;
			return;
		}
		const previousIndex = findItemIndex(filteredItems, previouslySelectedId);
		if (previousIndex < 0 && previouslySelectedId) restoreItemId ??= previouslySelectedId;
		const restoreIndex = findItemIndex(filteredItems, restoreItemId);
		const nextIndex = restoreIndex >= 0 ? restoreIndex : previousIndex >= 0 ? previousIndex : 0;
		if (restoreIndex >= 0) restoreItemId = undefined;
		setSelectedIndex(nextIndex, false, false);
	};
	const component: MenuScreenComponent & Focusable = {
		get focused() {
			return focused;
		},
		set focused(value: boolean) {
			focused = value;
			syncFocus();
		},
		render(width) {
			const safeWidth = Math.max(1, width);
			const availableRows = componentRows(options.tui.terminal.rows);
			if (view === "detail") {
				const content = detailLines(selected()?.item, safeWidth);
				const layout = detailLayout(availableRows, content.length);
				detailViewportRows = layout.contentRows;
				detailMaximumScroll = Math.max(0, content.length - layout.contentRows);
				detailScrollOffset = clamp(detailScrollOffset, 0, detailMaximumScroll);
				const lines = [
					...(layout.titleRows
						? [options.theme.fg("accent", options.theme.bold(selected()?.label || "Details"))]
						: []),
					...content.slice(detailScrollOffset, detailScrollOffset + layout.contentRows),
					...(layout.positionRows
						? [
								options.theme.fg(
									"dim",
									positionText(detailScrollOffset, layout.contentRows, content.length),
								),
							]
						: []),
					...(layout.hintRows ? [options.theme.fg("dim", detailHint(options.keybindings))] : []),
				];
				return boundedLines(lines, safeWidth, availableRows);
			}

			const context: string[] = [];
			for (const line of options.screen.lines ?? []) {
				for (const wrapped of wrapTextWithAnsi(options.theme.fg("muted", safeBrowseText(line)), safeWidth)) context.push(wrapped);
			}
			const layout = listLayout(
				availableRows,
				context.length,
				filteredItems.length,
				options.screen.viewportSize,
			);
			listViewportRows = layout.itemRows;
			searchInputVisible = layout.searchRows > 0;
			syncFocus();
			const viewportStart = listWindowStart(selectedIndex, filteredItems.length, layout.itemRows);
			const rows = listRows(
				filteredItems,
				selectedIndex,
				viewportStart,
				layout.itemRows,
				safeWidth,
				options,
			);
			const description = selected()?.description;
			const lines = [
				...(layout.titleRows
					? [options.theme.fg("accent", options.theme.bold(safeBrowseText(options.screen.title)))]
					: []),
				...context.slice(0, layout.contextRows),
				...(layout.searchRows ? renderSearchInput(searchInput, safeWidth) : []),
				...rows,
				...(layout.positionRows
					? [
							options.theme.fg(
								"dim",
								positionText(viewportStart, layout.itemRows, filteredItems.length),
							),
						]
					: []),
				...(layout.descriptionRows && description ? [options.theme.fg("muted", description)] : []),
				...(layout.hintRows
					? [
							options.theme.fg(
								"dim",
								browseHint(options.keybindings, options.screen.hint ?? "back"),
							),
						]
					: []),
			];
			return boundedLines(lines, safeWidth, availableRows);
		},
		invalidate() {
			searchInput.invalidate();
		},
		handleInput(data) {
			if (disposed) return;
			if (matchesKey(data, Key.ctrl("c"))) {
				options.onEvent({ kind: "close" });
			} else if (options.keybindings.matches(data, "tui.select.cancel")) {
				if (view === "detail") {
					view = "list";
					detailScrollOffset = 0;
					syncFocus();
				} else options.onEvent({ kind: options.screen.hint ?? "back" });
			} else if (view === "detail") {
				if (options.keybindings.matches(data, "tui.select.up")) {
					detailScrollOffset = clamp(detailScrollOffset - 1, 0, detailMaximumScroll);
				} else if (options.keybindings.matches(data, "tui.select.down")) {
					detailScrollOffset = clamp(detailScrollOffset + 1, 0, detailMaximumScroll);
				} else if (options.keybindings.matches(data, "tui.select.pageUp")) {
					detailScrollOffset = clamp(
						detailScrollOffset - detailViewportRows,
						0,
						detailMaximumScroll,
					);
				} else if (options.keybindings.matches(data, "tui.select.pageDown")) {
					detailScrollOffset = clamp(
						detailScrollOffset + detailViewportRows,
						0,
						detailMaximumScroll,
					);
				} else if (matchesKey(data, Key.home)) detailScrollOffset = 0;
				else if (matchesKey(data, Key.end)) detailScrollOffset = detailMaximumScroll;
			} else if (options.keybindings.matches(data, "tui.select.up")) move(-1);
			else if (options.keybindings.matches(data, "tui.select.down")) move(1);
			else if (options.keybindings.matches(data, "tui.select.pageUp")) page(-1);
			else if (options.keybindings.matches(data, "tui.select.pageDown")) page(1);
			else if (matchesKey(data, Key.home)) setSelectedIndex(0, false, true);
			else if (matchesKey(data, Key.end)) {
				setSelectedIndex(filteredItems.length - 1, false, true);
			} else if (options.keybindings.matches(data, "tui.select.confirm")) {
				if (selected()) {
					view = "detail";
					detailScrollOffset = 0;
					syncFocus();
				}
			} else if (searchInputVisible) {
				handleSearchInput(searchInput, data);
				applyFilter();
			}
			options.tui.requestRender();
		},
		async waitForPending() {},
		dispose() {
			if (disposed) return;
			disposed = true;
			searchInput.focused = false;
			options.onDispose?.();
		},
	};
	return component;
}

function listRows<ScreenId extends string, ActionId extends string>(
	items: readonly SearchableItem[],
	selectedIndex: number,
	viewportStart: number,
	viewportRows: number,
	width: number,
	options: BrowseOptions<ScreenId, ActionId>,
): string[] {
	if (options.screen.items.length === 0) {
		return [options.theme.fg("dim", "  No items available")];
	}
	if (items.length === 0) return [options.theme.fg("dim", "  No matching items")];
	const lines: string[] = [];
	for (let index = viewportStart; index < Math.min(items.length, viewportStart + viewportRows); index++) {
		const candidate = items[index]!;
		const prefix = index === selectedIndex ? "› " : "  ";
		const suffix = candidate.statusText ? `  [${candidate.statusText}]` : "";
		const labelWidth = Math.max(0, width - visibleWidth(prefix) - visibleWidth(suffix));
		const label = truncateToWidth(candidate.label, labelWidth, "");
		const line = truncateToWidth(`${prefix}${label}${suffix}`, width, "");
		lines.push(index === selectedIndex ? options.theme.fg("accent", line) : line);
	}
	return lines;
}

function detailLines(item: MenuBrowseItem | undefined, width: number): string[] {
	if (!item) return ["No matching item."];
	const lines: string[] = [];
	for (const line of browseDetailSource(item)) {
		if (!line) lines.push("");
		else for (const wrapped of wrapTextWithAnsi(line, width)) lines.push(wrapped);
	}
	return lines;
}

export function browseDialogLabel(item: MenuBrowseItem) {
	const label = safeBrowseText(item.label);
	const status = safeBrowseText(item.statusText ?? "");
	return status ? `${label} [${status}]` : label;
}

export function browseDialogPages(item: MenuBrowseItem) {
	return reviewDialogPages({
		kind: "review",
		title: safeBrowseText(item.label),
		content: browseDetailSource(item).join("\n"),
		viewportSize: "adaptive",
	});
}

function browseDetailSource(item: MenuBrowseItem) {
	const lines: string[] = [];
	if (item.statusText) lines.push(`Status: ${safeBrowseText(item.statusText)}`);
	if (item.description) lines.push(safeBrowseText(item.description));
	if (item.details) for (const detail of item.details) lines.push(safeBrowseText(detail));
	return lines.length > 0 ? lines : ["No details available."];
}

function renderSearchInput(input: Input, width: number): string[] {
	const prefix = "Search: ";
	const inputWidth = Math.max(1, width - visibleWidth(prefix));
	const lines: string[] = [];
	for (const line of input.render(inputWidth)) lines.push(truncateToWidth(`${prefix}${line}`, width, ""));
	return lines;
}

interface BrowseListLayout {
	titleRows: number;
	contextRows: number;
	searchRows: number;
	itemRows: number;
	positionRows: number;
	descriptionRows: number;
	hintRows: number;
}

function listLayout(
	availableRows: number,
	contextLength: number,
	itemCount: number,
	requestedViewport: number | "adaptive" | undefined,
): BrowseListLayout {
	if (availableRows === 1) {
		return {
			titleRows: 0,
			contextRows: 0,
			searchRows: 0,
			itemRows: 1,
			positionRows: 0,
			descriptionRows: 0,
			hintRows: 0,
		};
	}
	const titleRows = availableRows >= 4 ? 1 : 0;
	const searchRows = availableRows >= 3 ? 1 : 0;
	const hintRows = availableRows >= 3 ? 1 : 0;
	const descriptionRows = availableRows >= 7 ? 1 : 0;
	const baseRows = titleRows + searchRows + hintRows + descriptionRows;
	const contextRows =
		availableRows >= 8
			? Math.min(contextLength, MAX_CONTEXT_ROWS, Math.max(0, availableRows - baseRows - 1))
			: 0;
	const itemBudget = Math.max(1, availableRows - baseRows - contextRows);
	let itemRows =
		typeof requestedViewport === "number" ? Math.min(itemBudget, requestedViewport) : itemBudget;
	let positionRows = 0;
	if (itemCount > itemRows) {
		if (itemBudget > itemRows) positionRows = 1;
		else if (itemRows >= 2) {
			positionRows = 1;
			itemRows -= 1;
		}
	}
	return {
		titleRows,
		contextRows,
		searchRows,
		itemRows,
		positionRows,
		descriptionRows,
		hintRows,
	};
}

interface BrowseDetailLayout {
	titleRows: number;
	contentRows: number;
	positionRows: number;
	hintRows: number;
}

function detailLayout(availableRows: number, contentLength: number): BrowseDetailLayout {
	if (availableRows === 1) {
		return { titleRows: 0, contentRows: 1, positionRows: 0, hintRows: 0 };
	}
	const titleRows = availableRows >= 4 ? 1 : 0;
	const hintRows = availableRows >= 3 ? 1 : 0;
	let contentRows = Math.max(1, availableRows - titleRows - hintRows);
	const positionRows = contentLength > contentRows && contentRows >= 2 ? 1 : 0;
	contentRows -= positionRows;
	return { titleRows, contentRows, positionRows, hintRows };
}

function componentRows(rows: number) {
	const terminalRows = Number.isFinite(rows) ? Math.floor(rows) : 24;
	return Math.max(1, terminalRows - RESERVED_HOST_ROWS);
}

function listWindowStart(selectedIndex: number, itemCount: number, viewportSize: number) {
	if (itemCount <= viewportSize) return 0;
	return Math.max(
		0,
		Math.min(selectedIndex - Math.floor(viewportSize / 2), itemCount - viewportSize),
	);
}

function positionText(offset: number, viewportSize: number, itemCount: number) {
	if (itemCount === 0) return "0/0";
	return `${offset + 1}-${Math.min(itemCount, offset + viewportSize)}/${itemCount}`;
}

function boundedLines(lines: readonly string[], width: number, rows: number) {
	const bounded: string[] = [];
	for (let index = 0; index < Math.min(lines.length, rows); index++) bounded.push(truncateToWidth(lines[index]!, width, ""));
	return bounded;
}

function browseHint(keybindings: MenuKeybindings, destination: "back" | "close") {
	const up = bindingText(keybindings, "tui.select.up");
	const down = bindingText(keybindings, "tui.select.down");
	const confirm = bindingText(keybindings, "tui.select.confirm");
	const cancel = bindingText(keybindings, "tui.select.cancel", "ctrl+c");
	let hint = "type to search";
	if (up || down) hint += ` · ${up}${up && down ? "/" : ""}${down} navigate`;
	if (confirm) hint += ` · ${confirm} details`;
	if (cancel) hint += ` · ${cancel} ${destination}`;
	if (destination === "back") hint += " · ctrl+c close";
	return hint;
}

function detailHint(keybindings: MenuKeybindings) {
	const up = bindingText(keybindings, "tui.select.up");
	const down = bindingText(keybindings, "tui.select.down");
	const pageUp = bindingText(keybindings, "tui.select.pageUp");
	const pageDown = bindingText(keybindings, "tui.select.pageDown");
	const cancel = bindingText(keybindings, "tui.select.cancel", "ctrl+c");
	let hint = up || down ? `${up}${up && down ? "/" : ""}${down} scroll` : "";
	if (pageUp || pageDown) hint += (hint ? " · " : "") + `${pageUp}${pageUp && pageDown ? "/" : ""}${pageDown} page`;
	if (cancel) hint += (hint ? " · " : "") + `${cancel} back`;
	return hint + (hint ? " · " : "") + "ctrl+c close";
}

function bindingText(
	keybindings: MenuKeybindings,
	binding: Parameters<MenuKeybindings["getKeys"]>[0],
	excluded?: string,
) {
	let text = "";
	for (const key of keybindings.getKeys(binding)) {
		if (key === excluded) continue;
		const label = key === "up" ? "↑" : key === "down" ? "↓" : key === "escape" ? "esc" : key === "enter" || key === "return" ? "enter" : safeMenuText(key);
		if (label) text += (text ? "/" : "") + label;
	}
	return text;
}

function safeBrowseText(value: unknown) {
	return safeMenuText(stripVTControlCharacters(typeof value === "string" ? value : String(value)));
}

function clamp(value: number, minimum: number, maximum: number) {
	return Math.max(minimum, Math.min(value, maximum));
}
