const ASCII_SPACE = 0x20;
const ASCII_TAB = 0x09;
const ASCII_CARRIAGE_RETURN = 0x0D;
const ASCII_LINE_FEED = 0x0A;

function isAsciiWhitespace(code: number): boolean {
	return code === ASCII_SPACE || code === ASCII_TAB || code === ASCII_CARRIAGE_RETURN || code === ASCII_LINE_FEED;
}

function isAsciiLetterOrDigit(code: number): boolean {
	return (code >= 0x30 && code <= 0x39)
		|| (code >= 0x41 && code <= 0x5A)
		|| (code >= 0x61 && code <= 0x7A);
}

export function isSafeIdentifier(value: unknown, maxLength = 64): value is string {
	if (typeof value !== "string" || value.length === 0 || value.length > maxLength) return false;
	for (let index = 0; index < value.length; index++) {
		const code = value.charCodeAt(index);
		if (isAsciiLetterOrDigit(code)) continue;
		if (index > 0 && (code === 0x2D || code === 0x2E || code === 0x5F)) continue;
		return false;
	}
	return true;
}

export type IdentifierListResult =
	| { ok: true; values: string[] | undefined }
	| { ok: false };

/** Parse, trim, validate, and deduplicate one bounded comma list in a single pass. */
export function parseIdentifierList(value: string, maxItems: number): IdentifierListResult {
	const values: string[] = [];
	const seen = new Set<string>();
	let rawItems = 0;
	let segmentStart = 0;
	for (let cursor = 0; cursor <= value.length; cursor++) {
		if (cursor < value.length && value.charCodeAt(cursor) !== 0x2C) continue;
		let start = segmentStart;
		let end = cursor;
		while (start < end && isAsciiWhitespace(value.charCodeAt(start))) start++;
		while (end > start && isAsciiWhitespace(value.charCodeAt(end - 1))) end--;
		segmentStart = cursor + 1;
		if (start === end) return { ok: false };
		rawItems++;
		if (rawItems > maxItems) return { ok: false };
		const identifier = value.slice(start, end);
		if (!isSafeIdentifier(identifier)) return { ok: false };
		if (!seen.has(identifier)) {
			seen.add(identifier);
			values.push(identifier);
		}
	}
	return { ok: true, values: values.length > 0 ? values : undefined };
}
