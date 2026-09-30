import { type Input, truncateToWidth, wrapTextWithAnsi } from "@super-pi/tui";
import type { MenuBinding, MenuKeybindings, MenuScreenComponentOptions } from "./contracts.js";

const WHITESPACE_PATTERN = /\s+/gu;

export function truncateOwnedLines(lines: string[], width: number): string[] {
	for (let index = 0; index < lines.length; index++) lines[index] = truncateToWidth(lines[index]!, width, "");
	return lines;
}

export function appendMutedLines(target: string[], lines: readonly string[], width: number, theme: MenuScreenComponentOptions<string, string>["theme"]): void {
	for (const line of lines) {
		for (const wrapped of wrapTextWithAnsi(theme.fg("muted", safeMenuText(line)), width)) target.push(wrapped);
	}
}

export function getSearchLabel(item: { label: string }): string { return item.label; }
export function getSearchText(item: { text: string }): string { return item.text; }

export function findItemIndex<T extends { item: { id: string } }>(items: readonly T[], id: string | undefined): number {
	for (let index = 0; index < items.length; index++) if (items[index]!.item.id === id) return index;
	return -1;
}

export function findValueIndex(items: readonly { value: string }[], value: string | undefined): number {
	for (let index = 0; index < items.length; index++) if (items[index]!.value === value) return index;
	return -1;
}

export function findItem<T extends { id: string }>(items: readonly T[], id: string | undefined): T | undefined {
	for (const item of items) if (item.id === id) return item;
	return undefined;
}

export function renderFrame<ScreenId extends string, ActionId extends string>(
	title: string,
	lines: readonly string[],
	content: readonly string[],
	destination: "back" | "close",
	width: number,
	options: MenuScreenComponentOptions<ScreenId, ActionId>,
	confirmAction = "select",
): string[] {
	const safeWidth = Math.max(1, width);
	const result = wrapTextWithAnsi(
			options.theme.fg("accent", options.theme.bold(safeMenuText(title))),
			safeWidth,
		);
	appendMutedLines(result, lines, safeWidth, options.theme);
	if (content.length > 0) {
		result.push("");
		for (const line of content) result.push(line);
	}
	for (const line of wrapTextWithAnsi(
			options.theme.fg("dim", menuHint(options.keybindings, destination, confirmAction)),
			safeWidth,
		)) result.push(line);
	return truncateOwnedLines(result, safeWidth);
}

export function menuHint(
	keybindings: MenuKeybindings,
	destination: "back" | "close",
	confirmAction: string,
) {
	const up = bindingText(keybindings, "tui.select.up");
	const down = bindingText(keybindings, "tui.select.down");
	const confirm = bindingText(keybindings, "tui.select.confirm");
	const cancel = bindingText(keybindings, "tui.select.cancel", "ctrl+c");
	let hint = up || down ? `${up}${up && down ? "/" : ""}${down} navigate` : "";
	if (confirm && confirmAction) hint += (hint ? " • " : "") + `${confirm} ${confirmAction}`;
	if (cancel) hint += (hint ? " • " : "") + `${cancel} ${destination}`;
	if (destination === "back") hint += (hint ? " • " : "") + "ctrl+c close";
	return hint;
}

function bindingText(keybindings: MenuKeybindings, binding: MenuBinding, excluded?: string) {
	let text = "";
	for (const key of keybindings.getKeys(binding)) {
		if (key === excluded) continue;
		const label = key === "up" ? "↑" : key === "down" ? "↓" : key === "escape" ? "esc" : safeMenuText(key);
		if (label) text += (text ? "/" : "") + label;
	}
	return text;
}

export function safeMenuText(value: unknown) {
	return replaceTerminalControls(value).replace(WHITESPACE_PATTERN, " ").trim();
}

export function handleSearchInput(input: Input, data: string) {
	input.handleInput(data);
	const value = replaceTerminalControls(input.getValue());
	if (value !== input.getValue()) input.setValue(value);
}

export function replaceTerminalControls(value: unknown) {
	let text = "";
	for (const character of typeof value === "string" ? value : String(value)) {
		const codePoint = character.codePointAt(0) ?? 0;
		text += codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f) ? " " : character;
	}
	return text;
}
