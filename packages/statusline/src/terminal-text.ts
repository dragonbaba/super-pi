import { WHITESPACE_CHARACTER_PATTERN } from "./regex.js";

const DEFAULT_DISPLAY_LIMIT = 160;
const MAX_INPUT_CODE_UNITS = 4096;
const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

export function unknownTerminalText(value: unknown): string {
	if (value === null || value === undefined) return "";
	if (typeof value === "string") return value;
	if (typeof value === "symbol") return value.description ?? "";
	try { return `${value}`; } catch { return "[unprintable value]"; }
}

/** Remove terminal control sequences and cap untrusted text before it reaches a renderer. */
export function sanitizeTerminalText(value: string, maxGraphemes = DEFAULT_DISPLAY_LIMIT): string {
	if (maxGraphemes <= 0) return "";
	const boundedValue = value.length > MAX_INPUT_CODE_UNITS
		? value.slice(0, MAX_INPUT_CODE_UNITS)
		: value;
	let safe = "";
	for (let index = 0; index < boundedValue.length; ) {
		const codePoint = boundedValue.codePointAt(index) ?? 0;
		const character = String.fromCodePoint(codePoint);
		if (isTerminalSequenceStart(codePoint)) {
			index = skipTerminalSequence(boundedValue, index, codePoint);
			continue;
		}
		if (
			codePoint <= 0x1f ||
			(codePoint >= 0x7f && codePoint <= 0x9f) ||
			codePoint === 0x2028 ||
			codePoint === 0x2029
		) {
			if (WHITESPACE_CHARACTER_PATTERN.test(character)) safe += " ";
			index += character.length;
			continue;
		}
		safe += character;
		index += character.length;
	}

	const graphemes: string[] = [];
	for (const item of graphemeSegmenter.segment(safe)) graphemes.push(item.segment);
	return graphemes.length <= maxGraphemes ? safe : graphemes.slice(0, maxGraphemes).join("");
}

function isTerminalSequenceStart(codePoint: number): boolean {
	return (
		codePoint === 0x1b ||
		codePoint === 0x9b ||
		codePoint === 0x9d ||
		codePoint === 0x90 ||
		codePoint === 0x98 ||
		codePoint === 0x9e ||
		codePoint === 0x9f
	);
}

function skipTerminalSequence(value: string, start: number, codePoint: number): number {
	let index = start + 1;
	const next = value.charCodeAt(index);
	const isOsc = codePoint === 0x9d || (codePoint === 0x1b && next === 0x5d);
	const isStringSequence =
		[0x90, 0x98, 0x9e, 0x9f].includes(codePoint) ||
		(codePoint === 0x1b && [0x50, 0x58, 0x5e, 0x5f].includes(next));
	if (isOsc || isStringSequence) {
		if (codePoint === 0x1b) index += 1;
		while (index < value.length) {
			const current = value.charCodeAt(index);
			if (isOsc && current === 0x07) return index + 1;
			if (current === 0x9c) return index + 1;
			if (current === 0x1b && value.charCodeAt(index + 1) === 0x5c) return index + 2;
			index += 1;
		}
		return index;
	}
	const isCsi = codePoint === 0x9b || (codePoint === 0x1b && next === 0x5b);
	if (isCsi) {
		if (codePoint === 0x1b) index += 1;
		while (index < value.length) {
			const current = value.charCodeAt(index++);
			if (current >= 0x40 && current <= 0x7e) break;
		}
		return index;
	}
	return Math.min(value.length, start + (codePoint === 0x1b ? 2 : 1));
}
