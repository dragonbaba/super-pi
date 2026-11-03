/**
 * Mutable preview for one tool invocation. Observer snapshots remain the host's responsibility.
 * Token-state approach informed by Pi v1.5.0 streaming-json.ts (Mario Zechner, MIT;
 * see LICENSE-MIT at the package root). No per-delta changes or open-path copies.
 */
import type { JsonValue } from "../types.ts";
import { markIncompleteToolArguments, parseStreamingJson } from "./json-parse.ts";

type Container = { [key: string]: JsonValue } | JsonValue[];
type Frame = { container: Container; array: boolean; key: string | undefined; nextIndex: number; phase: number };
const NUMBER = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/;
const SIMPLE_ESCAPES: Readonly<Record<string, string>> = { '"': '"', "\\": "\\", "/": "/", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" };
const MAX_SCALAR_PREVIEW = 64;

function delimiter(char: string): boolean {
	return char === " " || char === "\t" || char === "\r" || char === "\n" || char === "," || char === ":"
		|| char === "{" || char === "}" || char === "[" || char === "]" || char === '"';
}
function hex(char: string): boolean { return char >= "0" && char <= "9" || char >= "a" && char <= "f" || char >= "A" && char <= "F"; }
function scalar(token: string, partial: boolean): JsonValue | undefined {
	if (partial ? "true".startsWith(token) : token === "true") return true;
	if (partial ? "false".startsWith(token) : token === "false") return false;
	if (partial ? "null".startsWith(token) : token === "null") return null;
	if (NUMBER.test(token)) return Number(token);
	if (!partial) return undefined;
	// A bounded preview can show the mantissa while exponent digits are still arriving.
	let end = token.length;
	if (token[end - 1] === "+" || token[end - 1] === "-") end--;
	if (token[end - 1] !== "e" && token[end - 1] !== "E") return undefined;
	const mantissa = token.slice(0, end - 1);
	return NUMBER.test(mantissa) ? Number(mantissa) : undefined;
}
function closedParser(): never { throw new Error("Tool argument parser is closed"); }

export class IncrementalToolArguments {
	private raw = "";
	private root: JsonValue | undefined;
	private empty: Record<string, unknown> | undefined = markIncompleteToolArguments({});
	private readonly stack: Frame[] = [];
	private mode = 0; // structural, key string, value string, scalar
	private token = "";
	private escape = "";
	private parent: Container | undefined;
	private key: string | number | undefined;
	private validSlot = false;
	private done = false;
	private closed = false;
	private inputCodeUnits = 0;
	private scannedCodeUnits = 0;
	private scalarPreviewCodeUnits = 0;
	private scalarFinalCodeUnits = 0;
	private finalizations = 0;
	private containers = 0;
	private maxDepth = 0;

	append(fragment: string): Record<string, any> {
		if (this.closed) closedParser();
		this.raw += fragment;
		this.inputCodeUnits += fragment.length;
		let index = 0;
		while (index < fragment.length && !this.done) {
			if (this.mode === 1 || this.mode === 2) index = this.readString(fragment, index);
			else if (this.mode === 3) index = this.readScalar(fragment, index);
			else { this.scannedCodeUnits++; this.structural(fragment[index++]); }
		}
		if (this.mode === 3 && this.token.length <= MAX_SCALAR_PREVIEW) {
			this.scalarPreviewCodeUnits += this.token.length;
			const value = scalar(this.token, true);
			if (value !== undefined) this.place(value);
		}
		return (this.root === undefined ? this.empty : this.root) as Record<string, any>;
	}

	finalize(): Record<string, any> {
		if (this.closed) closedParser();
		this.finalizations++;
		try { return parseStreamingJson(this.raw); }
		finally { this.dispose(); }
	}

	dispose(): void {
		this.closed = true;
		this.raw = ""; this.token = ""; this.escape = "";
		this.root = undefined; this.empty = undefined; this.parent = undefined; this.key = undefined;
		this.stack.length = 0;
	}

	/** Explicit diagnostic boundary; never called by append or provider delivery. */
	diagnostics() {
		return { inputCodeUnits: this.inputCodeUnits, scannedCodeUnits: this.scannedCodeUnits,
			scalarPreviewCodeUnits: this.scalarPreviewCodeUnits, scalarFinalCodeUnits: this.scalarFinalCodeUnits,
			finalizations: this.finalizations, containers: this.containers, maxDepth: this.maxDepth,
			depth: this.stack.length, retainedRawCodeUnits: this.raw.length, retainedTokenCodeUnits: this.token.length,
			retainedRoot: this.root !== undefined, retainedParent: this.parent !== undefined, closed: this.closed };
	}

	private selectSlot(): void {
		const frame = this.stack[this.stack.length - 1];
		this.parent = frame?.container;
		this.key = frame?.array ? frame.nextIndex : frame?.key;
		this.validSlot = frame === undefined ? this.root === undefined : frame.array || this.key !== undefined && (frame.phase === 1 || frame.phase === 2);
	}
	private place(value: JsonValue): void {
		if (!this.validSlot) return;
		if (this.parent === undefined) { this.root = markIncompleteToolArguments(value); return; }
		if (this.key === "__proto__") defineMember(this.parent, value);
		else (this.parent as Record<string | number, JsonValue>)[this.key!] = value;
	}
	private valueEnded(): void {
		const frame = this.stack[this.stack.length - 1];
		if (frame === undefined) { if (this.root !== undefined) this.done = true; }
		else { frame.phase = 3; frame.key = undefined; if (frame.array) frame.nextIndex++; }
		this.parent = undefined; this.key = undefined; this.validSlot = false;
	}
	private structural(char: string): void {
		const frame = this.stack[this.stack.length - 1];
		switch (char) {
			case " ": case "\t": case "\r": case "\n": return;
			case '"':
				this.token = "";
				if (frame && !frame.array && (frame.phase === 0 || frame.phase === 3)) this.mode = 1;
				else { this.mode = 2; this.selectSlot(); this.place(""); }
				return;
			case "{": case "[": this.openContainer(char === "["); return;
			case "}": case "]": if (this.stack.length) { this.stack.pop(); this.valueEnded(); } return;
			case ":": if (frame && !frame.array && frame.phase === 1) frame.phase = 2; return;
			case ",": if (frame) frame.phase = frame.array ? 2 : 0; return;
			default: this.mode = 3; this.token = char; this.selectSlot();
		}
	}
	/** Allocates exactly the JSON container and its active syntax frame, not a delta wrapper. */
	private openContainer(array: boolean): void {
		const container: Container = array ? [] : {};
		this.selectSlot(); this.place(container);
		this.stack.push({ container, array, key: undefined, nextIndex: 0, phase: array ? 2 : 0 });
		this.containers++; this.maxDepth = Math.max(this.maxDepth, this.stack.length);
		this.parent = undefined; this.key = undefined; this.validSlot = false;
	}
	private appendString(text: string): void {
		this.token += text;
		if (this.mode === 2) this.place(this.token);
	}
	private readString(text: string, start: number): number {
		let runStart = start;
		for (let index = start; index < text.length; index++) {
			this.scannedCodeUnits++;
			if (this.escape !== "") {
				if (this.continueEscape(text[index])) { runStart = index + 1; continue; }
				runStart = index;
			}
			const code = text.charCodeAt(index);
			if (code === 0x22) {
				if (index > runStart) this.appendString(text.slice(runStart, index));
				if (this.mode === 1) {
					const frame = this.stack[this.stack.length - 1]; frame.key = this.token; frame.phase = 1;
				} else this.valueEnded();
				this.token = ""; this.mode = 0;
				return index + 1;
			}
			if (code === 0x5c) {
				if (index > runStart) this.appendString(text.slice(runStart, index));
				this.escape = "\\"; runStart = index + 1;
			}
		}
		if (text.length > runStart) this.appendString(text.slice(runStart));
		return text.length;
	}
	private continueEscape(char: string): boolean {
		if (this.escape === "\\") {
			const decoded = SIMPLE_ESCAPES[char];
			if (decoded !== undefined) { this.escape = ""; this.appendString(decoded); return true; }
			if (char === "u") { this.escape = "\\u"; return true; }
			this.escape = ""; this.appendString("\\"); return false;
		}
		if (hex(char)) {
			this.escape += char;
			if (this.escape.length < 6) return true;
			this.appendString(String.fromCharCode(Number.parseInt(this.escape.slice(2), 16)));
			this.escape = ""; return true;
		}
		this.appendString(this.escape); this.escape = ""; return false;
	}
	private readScalar(text: string, start: number): number {
		let end = start;
		while (end < text.length && !delimiter(text[end])) end++;
		this.scannedCodeUnits += end - start;
		if (end > start) this.token += text.slice(start, end);
		if (end < text.length) {
			this.scalarFinalCodeUnits += this.token.length;
			const value = scalar(this.token, false);
			if (value !== undefined) this.place(value);
			this.token = ""; this.mode = 0; this.valueEnded();
		}
		return end;
	}
}

/** JSON own-property semantics at this special key; ordinary writes allocate no descriptor. */
function defineMember(container: Container, value: JsonValue): void {
	Object.defineProperty(container, "__proto__", { value, writable: true, enumerable: true, configurable: true });
}
