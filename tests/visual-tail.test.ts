import assert from "node:assert/strict";
import test from "node:test";
import { Text } from "@super-pi/tui";
import { truncateToVisualLines } from "../packages/coding-agent/src/modes/interactive/components/visual-truncate.ts";

test("bounded visual tail matches existing Text layout across ANSI and Unicode", () => {
	const samples = ["", "   ", "a\nb\nc\n", "a\r\nb\rc", "\x1b[31m红色 中文\n🦖 é 👨‍👩‍👧‍👦\x1b[0m", "\x1b[4m" + "abcd".repeat(1000), "a  b\tend  ", "中".repeat(400), "\x1b]8;;https://example.test\x07link\x1b]8;;\x07"];
	for (const text of samples) for (const width of [1, 2, 9, 80]) for (const padding of [0, 1]) for (const limit of [1, 5, 30]) {
		const expected = new Text(text, padding, 0).render(width);
		const actual = truncateToVisualLines(text, limit, width, padding);
		assert.deepEqual(actual.visualLines, expected.slice(-limit), JSON.stringify({ text: text.slice(0, 60), width, padding, limit }));
		assert.equal(actual.skippedCount, Math.max(0, expected.length - limit));
		const retained = actual.visualLines.slice(); truncateToVisualLines("another call", 2, 10);
		assert.deepEqual(actual.visualLines, retained);
	}
});
