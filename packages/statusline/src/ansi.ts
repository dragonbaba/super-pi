import { LEADING_HASH_PATTERN } from "./regex.js";

export function ansiStyle(text: string, colors: { fg?: string; bg?: string }): string {
	const codes: string[] = [];
	if (colors.fg) codes.push(truecolorCode("38", colors.fg));
	if (colors.bg) codes.push(truecolorCode("48", colors.bg));
	if (codes.length === 0) return text;
	return `\u001b[${codes.join(";")}m${text}\u001b[0m`;
}

export function ansiFg(hex: string, text: string): string {
	return ansiStyle(text, { fg: hex });
}

function truecolorCode(prefix: "38" | "48", hex: string): string {
	const { red, green, blue } = hexToRgb(hex);
	return `${prefix};2;${red};${green};${blue}`;
}

function hexToRgb(hex: string): { red: number; green: number; blue: number } {
	const normalized = hex.replace(LEADING_HASH_PATTERN, "");
	return {
		red: Number.parseInt(normalized.slice(0, 2), 16),
		green: Number.parseInt(normalized.slice(2, 4), 16),
		blue: Number.parseInt(normalized.slice(4, 6), 16),
	};
}
