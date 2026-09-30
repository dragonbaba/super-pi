/**
 * Utilities for formatting keybinding hints in the UI.
 */

import { getKeybindings, type Keybinding, type KeyId } from "@super-pi/tui";
import { theme } from "../theme/theme.ts";

export interface KeyTextFormatOptions {
	capitalize?: boolean;
}

const DEFAULT_FORMAT_OPTIONS: KeyTextFormatOptions = {};
const CAPITALIZED_FORMAT_OPTIONS: KeyTextFormatOptions = { capitalize: true };

function formatKeyPart(part: string, options: KeyTextFormatOptions): string {
	const displayPart = process.platform === "darwin" && part.toLowerCase() === "alt" ? "option" : part;
	return options.capitalize ? displayPart.charAt(0).toUpperCase() + displayPart.slice(1) : displayPart;
}

export function formatKeyText(key: string, options: KeyTextFormatOptions = DEFAULT_FORMAT_OPTIONS): string {
	let result = "";
	let start = 0;
	for (let index = 0; index < key.length; index++) {
		const delimiter = key[index];
		if (delimiter !== "/" && delimiter !== "+") continue;
		result += formatKeyPart(key.slice(start, index), options) + delimiter;
		start = index + 1;
	}
	return result + formatKeyPart(key.slice(start), options);
}

function formatKeys(keys: KeyId[], options: KeyTextFormatOptions = DEFAULT_FORMAT_OPTIONS): string {
	let result = "";
	for (let index = 0; index < keys.length; index++) {
		if (index > 0) result += "/";
		result += formatKeyText(keys[index]!, options);
	}
	return result;
}

export function keyText(keybinding: Keybinding): string {
	return formatKeys(getKeybindings().getKeys(keybinding));
}

export function keyDisplayText(keybinding: Keybinding): string {
	return formatKeys(getKeybindings().getKeys(keybinding), CAPITALIZED_FORMAT_OPTIONS);
}

export function keyHint(keybinding: Keybinding, description: string): string {
	return theme.fg("dim", keyText(keybinding)) + theme.fg("muted", ` ${description}`);
}

export function rawKeyHint(key: string, description: string): string {
	return theme.fg("dim", formatKeyText(key)) + theme.fg("muted", ` ${description}`);
}
