/*
 * Portions of this file are derived from:
 * - ansi-regex (https://github.com/chalk/ansi-regex)
 * - strip-ansi (https://github.com/chalk/strip-ansi)
 *
 * MIT License
 *
 * Copyright (c) Sindre Sorhus <sindresorhus@gmail.com> (https://sindresorhus.com)
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

// Sticky matching checks only the current introducer and allocates no match array.
const CSI_PATTERN = /[\u001B\u009B][[\]()#;?]*(?:\d{1,4}(?:[;:]\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]/y;

function findOscEnd(value: string, start: number): number {
	for (let index = start; index < value.length; index++) {
		const code = value.charCodeAt(index);
		if (code === 7 || code === 0x9c) return index + 1;
		if (code === 0x1b && value.charCodeAt(index + 1) === 0x5c) return index + 2;
	}
	return -1;
}

export function stripAnsi(value: string): string {
	if (typeof value !== "string") {
		throw new TypeError(`Expected a \`string\`, got \`${typeof value}\``);
	}

	// Fast path: ANSI codes require ESC (7-bit) or CSI (8-bit) introducer
	if (!value.includes("\u001B") && !value.includes("\u009B")) {
		return value;
	}

	let output = "", start = 0, noMoreOsc = false;
	for (let index = 0; index < value.length; index++) {
		const code = value.charCodeAt(index);
		if (code !== 0x1b && code !== 0x9b) continue;
		let end = -1;
		if (!noMoreOsc && code === 0x1b && value.charCodeAt(index + 1) === 0x5d) {
			end = findOscEnd(value, index + 2);
			// Unterminated repeated OSC starts used to rescan the entire remaining suffix.
			if (end < 0) noMoreOsc = true;
		}
		if (end < 0) {
			CSI_PATTERN.lastIndex = index;
			if (CSI_PATTERN.test(value)) end = CSI_PATTERN.lastIndex;
		}
		if (end >= 0) {
			if (index > start) output += value.slice(start, index);
			start = end; index = end - 1;
		}
	}
	return start === 0 ? value : output + value.slice(start);
}

const TEXT = 0;
const ESCAPE = 1;
const INTERMEDIATE = 2;
const CSI = 3;
const OSC = 4;
const OSC_ESCAPE = 5;

/**
 * Command-owned streaming filter. Incomplete controls are discarded at end of
 * stream. Only the numeric state crosses calls, even for an unterminated OSC of
 * arbitrary size. Visible spans, rather than individual characters, form output.
 * The stateless stripAnsi API above intentionally keeps its existing semantics.
 */
export class AnsiStreamFilter {
	private state = TEXT;

	write(value: string): string {
		if (this.state === TEXT && !value.includes("\x1b") && !value.includes("\u009b") && !value.includes("\u009d")) return value;

		let result = "";
		let start = 0;
		for (let index = 0; index < value.length; index++) {
			const code = value.charCodeAt(index);
			if (this.state === TEXT) {
				if (code !== 0x1b && code !== 0x9b && code !== 0x9d) continue;
				if (start < index) result += value.slice(start, index);
				this.state = code === 0x1b ? ESCAPE : code === 0x9b ? CSI : OSC;
			} else if (this.state === OSC || this.state === OSC_ESCAPE) {
				if (code === 0x07 || code === 0x9c || (this.state === OSC_ESCAPE && code === 0x5c)) this.state = TEXT;
				else this.state = code === 0x1b ? OSC_ESCAPE : OSC;
			} else if (code === 0x1b) {
				this.state = ESCAPE;
			} else if (code === 0x18 || code === 0x1a) {
				this.state = TEXT;
			} else if (this.state === ESCAPE && code === 0x5b) {
				this.state = CSI;
			} else if (this.state === ESCAPE && code === 0x5d) {
				this.state = OSC;
			} else if (this.state === CSI && code >= 0x20 && code <= 0x3f) {
				// Parameters and intermediates; do not buffer their contents.
			} else if (this.state !== CSI && code >= 0x20 && code <= 0x2f) {
				this.state = INTERMEDIATE;
			} else if (code >= (this.state === CSI ? 0x40 : 0x30) && code <= 0x7e) {
				this.state = TEXT;
			} else {
				// An invalid byte terminates the malformed sequence; reprocess it
				// as text (or a new introducer), without losing a visible character.
				this.state = TEXT;
				start = index;
				index--;
				continue;
			}
			start = index + 1;
		}
		return this.state === TEXT && start < value.length ? result + value.slice(start) : result;
	}

	reset(): void {
		this.state = TEXT;
	}
}
