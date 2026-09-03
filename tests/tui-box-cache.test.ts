import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { Box } from "../packages/tui/src/components/box.ts";
import type { Component } from "../packages/tui/src/tui.ts";

class MutableLines implements Component {
	lines: string[];

	constructor(...lines: string[]) {
		this.lines = lines;
	}

	render(_width: number): string[] {
		return this.lines;
	}

	invalidate(): void {}
}

test("Box cache preserves hit identity and misses on content, length, width, and background changes", () => {
	let background = "a";
	const child = new MutableLines("one", "two");
	const box = new Box(0, 0, (text) => `${background}:${text}`);
	box.addChild(child);

	const initial = box.render(12);
	assert.equal(box.render(12), initial);

	child.lines = ["one", "changed"];
	const contentMiss = box.render(12);
	assert.notEqual(contentMiss, initial);
	assert.equal(box.render(12), contentMiss);

	child.lines = ["one", "changed", "three"];
	const lengthMiss = box.render(12);
	assert.notEqual(lengthMiss, contentMiss);
	assert.equal(box.render(12), lengthMiss);

	const widthMiss = box.render(13);
	assert.notEqual(widthMiss, lengthMiss);
	assert.equal(box.render(13), widthMiss);

	background = "b";
	const backgroundMiss = box.render(13);
	assert.notEqual(backgroundMiss, widthMiss);
	assert.equal(box.render(13), backgroundMiss);
});

test("Box empty-child and padded output remain byte-for-byte golden", () => {
	assert.deepEqual(new Box().render(12), []);

	const box = new Box(1, 1);
	box.addChild(new MutableLines("alpha", "b"));
	const expected = ["        ", " alpha  ", " b      ", "        "];
	assert.deepEqual(box.render(8), expected);
	assert.equal(box.render(8), box.render(8));
});

test("Box.matchCache and the selected G2C render chain contain no inline callbacks", () => {
	const source = readFileSync(new URL("../packages/tui/src/components/box.ts", import.meta.url), "utf8");
	const start = source.indexOf("\tprivate matchCache(");
	const end = source.indexOf("\n\tinvalidate(): void", start);
	assert.notEqual(start, -1);
	assert.notEqual(end, -1);
	const matchCache = source.slice(start, end);
	assert.doesNotMatch(matchCache, /\.every\s*\(|\.some\s*\(|\.find\s*\(|=>|\.bind\s*\(/u);
});
