import { MAX_ERROR_CHARS } from "../limits.ts";
import type { CodemodeError } from "../types.ts";

export const SCRIPT_PREFIX = "(async (tools, console) => {";
const SCRIPT_FRAME = /^[ \t]*at codemode\.js:(\d+)(?::(\d+))?\r?$/m;
const EXCERPT_BEFORE = 60;
const EXCERPT_AFTER = 100;

function sourceLocation(code: string, stack: string | undefined): CodemodeError["sourceLocation"] {
	const frame = stack && SCRIPT_FRAME.exec(stack);
	if (!frame) return;
	const reportedLine = Number(frame[1]);
	let byteColumn = frame[2] === undefined ? undefined : Number(frame[2]) - (reportedLine === 1 ? SCRIPT_PREFIX.length : 0);
	if (byteColumn !== undefined && byteColumn < 1) byteColumn = undefined;
	let line = 1;
	let start = 0;
	let end = 0;
	for (; end < code.length; end++) {
		const char = code.charCodeAt(end);
		if (char !== 10 && char !== 13 && char !== 0x2028 && char !== 0x2029) continue;
		if (line === reportedLine) break;
		if (char === 13 && code.charCodeAt(end + 1) === 10) end++;
		line++;
		start = end + 1;
	}
	// QuickJS reports UTF-8 byte columns. The synthetic closing line maps to
	// the end of the last user line, including when that line is empty.
	const afterSource = line < reportedLine;
	let offset = start;
	let bytes = 1;
	while (offset < end && (afterSource || (byteColumn !== undefined && bytes < byteColumn))) {
		const point = code.codePointAt(offset)!;
		bytes += point <= 0x7f ? 1 : point <= 0x7ff ? 2 : point <= 0xffff ? 3 : 4;
		offset += point <= 0xffff ? 1 : 2;
	}
	if (afterSource || (byteColumn !== undefined && bytes < byteColumn)) byteColumn = bytes;
	let left = Math.max(start, offset - EXCERPT_BEFORE);
	let right = Math.min(end, offset + EXCERPT_AFTER);
	if (left > start && (code.charCodeAt(left) & 0xfc00) === 0xdc00) left++;
	if (right < end && (code.charCodeAt(right) & 0xfc00) === 0xdc00) right--;
	const excerpt = (left > start ? "…" : "") + code.slice(left, right) + (right < end ? "…" : "");
	return { line, byteColumn, excerpt };
}

export function describeScriptCreationError(error: Error, code: string): string {
	const message = error.message.slice(0, MAX_ERROR_CHARS);
	const head = message ? `${error.name}: ${message}` : error.name;
	const stack = error.stack?.trimEnd();
	return JSON.stringify({
		name: error.name,
		message,
		stack: (stack ? `${head}\n${stack}` : head).slice(0, MAX_ERROR_CHARS),
		sourceLocation: error.name === "SyntaxError" ? sourceLocation(code, stack) : undefined,
	});
}
