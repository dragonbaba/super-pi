import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import { TAB_PATTERN } from "../packages/tui/src/regex.ts";
import { graphemeWidth, stripTerminalSequences, visibleWidth } from "../packages/tui/src/utils.ts";

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const originalSegment = Intl.Segmenter.prototype.segment;
let segmentCalls = 0;
let segmentedCharacters = 0;

function observeSegment(this: Intl.Segmenter, input: string): Intl.Segments {
	segmentCalls++;
	segmentedCharacters += input.length;
	return originalSegment.call(this, input);
}

// The full Unicode algorithm is the oracle; it has no edge trimming or cache.
function fullWidth(input: string): number {
	const plain = stripTerminalSequences(input.replace(TAB_PATTERN, "   "));
	let width = 0;
	for (const { segment } of segmenter.segment(plain)) width += graphemeWidth(segment);
	return width;
}

test("width matches complete grapheme measurement across ANSI and Unicode boundaries", () => {
	const fragments = [
		"", "a", " ", "0", "\t", "\r\n", "\x00", "\x7f", "\u0085",
		"中", "😀", "e\u0301", "\u0301", "\u0600", "\u200d", "\ufe0f", "\u20e3",
		"🇯🇵", "🇯", "👩🏽‍💻", "क्", "ष", "กํา", "ກຳ", "\u1100\u1161", "\ud800", "\udc00",
		"\x1b[31m", "\x1b[0m", "\x1b]8;;https://example.test/中\x07", "\x1b]8;;\x1b\\",
		"\x1b_pi:cursor\x07", "\x1b[", "\x1b[3\x1b[0m", "\x1b]unterminated", "\x1b[\tm",
	];
	for (const left of fragments) {
		for (const right of fragments) {
			for (const padding of [0, 1, 64]) {
				const input = "prefix ".repeat(padding) + left + right + " suffix".repeat(padding);
				assert.equal(visibleWidth(input), fullWidth(input), JSON.stringify(input));
			}
		}
	}
	let seed = 0x513ad;
	for (let index = 0; index < 10_000; index++) {
		let input = `${index}: `;
		for (let part = 0; part < 7; part++) {
			seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
			input += fragments[seed % fragments.length];
		}
		input += " ".repeat(index % 121);
		assert.equal(visibleWidth(input), fullWidth(input), JSON.stringify(input));
	}
});

test("styled ASCII does not segment and Unicode cache survives unrelated padding/styles", () => {
	Intl.Segmenter.prototype.segment = observeSegment;
	segmentCalls = 0;
	segmentedCharacters = 0;
	try {
		for (let index = 0; index < 1000; index++) {
			assert.equal(visibleWidth(`\x1b[31m${index}\tASCII\x1b[0m`), String(index).length + 8);
		}
		assert.equal(segmentCalls, 0);
		const core = "渲染計測\u0600a\u0301";
		const expected = fullWidth(core);
		segmentCalls = 0;
		segmentedCharacters = 0;
		for (let index = 0; index < 1000; index++) {
			const prefix = `${index}: `;
			const suffix = " ".repeat(1 + index % 120);
			assert.equal(visibleWidth(`\x1b[3${index % 8}m${prefix}${core}${suffix}\x1b[0m`), prefix.length + expected + suffix.length);
		}
		// Full-input entries share the 512-key budget, so FIFO eviction may also
		// evict the core. A thousand distinct styles/paddings still need <=3 parses.
		assert.ok(segmentCalls <= 3);
		assert.ok(segmentedCharacters <= 3 * (core.length + 2));
	} finally {
		Intl.Segmenter.prototype.segment = originalSegment;
	}
});

test("Unicode width cache retains at most the existing 512 cores", () => {
	Intl.Segmenter.prototype.segment = observeSegment;
	try {
		for (let index = 0; index < 600; index++) visibleWidth(String.fromCodePoint(0xe000 + index));
		segmentCalls = 0;
		visibleWidth(String.fromCodePoint(0xe000 + 599));
		assert.equal(segmentCalls, 0);
		visibleWidth(String.fromCodePoint(0xe000));
		assert.equal(segmentCalls, 1, "evicted input must be measured again");
		for (let index = 0; index < 300; index++) visibleWidth(`prefix ${String.fromCodePoint(0xf000 + index)} suffix`);
		segmentCalls = 0;
		visibleWidth(`prefix ${String.fromCodePoint(0xf000)} suffix`);
		assert.equal(segmentCalls, 1, "full-input and core entries must share the same capacity");
	} finally {
		Intl.Segmenter.prototype.segment = originalSegment;
	}
});

test("width hot chain has no closures, dynamic regexes, or per-call container/wrapper construction", () => {
	const source = ts.createSourceFile("utils.ts", readFileSync("packages/tui/src/utils.ts", "utf8"), ts.ScriptTarget.Latest, true);
	const names = new Set(["visibleWidth", "rememberWidth", "terminalAsciiWidth", "isPrintableAscii", "findTerminalSequenceEnd", "graphemeWidth", "couldBeEmoji"]);
	const checked = new Set<string>();
	function visit(node: ts.Node): void {
		assert.ok(!ts.isArrowFunction(node) && !ts.isFunctionExpression(node), "hot closure");
		assert.ok(!ts.isNewExpression(node), "hot constructor");
		assert.ok(!ts.isObjectLiteralExpression(node) && !ts.isArrayLiteralExpression(node), "hot wrapper/container");
		assert.notEqual(node.kind, ts.SyntaxKind.RegularExpressionLiteral, "hot regex");
		ts.forEachChild(node, visit);
	}
	for (const statement of source.statements) {
		if (ts.isFunctionDeclaration(statement) && statement.name && names.has(statement.name.text)) {
			checked.add(statement.name.text);
			visit(statement);
		}
	}
	assert.deepEqual(checked, names);
});
