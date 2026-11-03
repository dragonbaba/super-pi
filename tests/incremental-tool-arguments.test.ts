import assert from "node:assert/strict";
import test from "node:test";
import { IncrementalToolArguments } from "../packages/ai/src/utils/incremental-tool-arguments.ts";
import { hasIncompleteToolArguments, parseStreamingJson } from "../packages/ai/src/utils/json-parse.ts";

const legal = [
	'{}', '[]', '{"s":"A中🌍é\\n\\t\\b\\f\\r\\\"\\\\\\/Z","u":"\\uD83D\\uDE00"}',
	'{"nested":[{},[],{"a":[null,true,false,-0,1.25,-1.25e-10,1e+30]}],"last":"ok"}',
	'{"a":"first","a":{"second":2},"__proto__":{"safe":true},"constructor":"data"}',
	'[0,1,2,3,{"x":"value"},[true,false,null]]', 'true', 'false', 'null', '-0', '1e100',
	'{"n":12345678901234567890123456789012345678901234567890123456789012345678901234567890}',
];

for (const input of legal) test(`incremental preview and final value agree across every split: ${input.slice(0, 45)}`, () => {
	const expected = JSON.parse(input);
	for (let split = 0; split <= input.length; split++) {
		const parser = new IncrementalToolArguments();
		parser.append(input.slice(0, split));
		const preview = parser.append(input.slice(split));
		// Huge unfinished root scalars may lag; all container fixtures close their scalar tokens.
		assert.deepEqual(preview, expected);
		assert.deepEqual(parser.finalize(), expected);
		const state = parser.diagnostics();
		assert.equal(state.inputCodeUnits, input.length); assert.equal(state.scannedCodeUnits, input.length);
		assert.equal(state.finalizations, 1); assert.equal(state.retainedRawCodeUnits, 0); assert.equal(state.depth, 0);
	}
});

test("one mutable preview graph extends strings and never mutates a caller snapshot", () => {
	const parser = new IncrementalToolArguments();
	const first = parser.append('{"path":"first');
	const snapshot = structuredClone(first); Object.freeze(snapshot);
	assert.equal(hasIncompleteToolArguments(first), true);
	assert.equal(parser.append('/second","items":[1,'), first);
	assert.deepEqual(snapshot, { path: "first" });
	assert.equal(parser.append('2]}'), first);
	assert.deepEqual(first, { path: "first/second", items: [1, 2] });
	const final = parser.finalize();
	assert.notEqual(final, first); assert.equal(hasIncompleteToolArguments(final), false);
});

test("partial escapes and Unicode wait for their own characters; invalid escape repair stays terminal-compatible", () => {
	const parser = new IncrementalToolArguments();
	assert.deepEqual(parser.append('{"s":"a\\'), { s: "a" });
	assert.deepEqual(parser.append('u4'), { s: "a" });
	assert.deepEqual(parser.append('E2D'), { s: "a中" });
	assert.deepEqual(parser.append('\\q\n"}'), { s: "a中\\q\n" });
	assert.deepEqual(parser.finalize(), { s: "a中\\q\n" });
});

for (const input of ['', '{"s":"prefix', '{"items":[1,2', '{"s":"\\u12', '{"s":"\\d"}', '{"s":"line\nbreak"}', '{"x":1} trailing', '{"x":tru', '{"x":1e+']) {
	test(`terminal recovery preserves existing incomplete semantics: ${input}`, () => {
		const expected = parseStreamingJson(input), parser = new IncrementalToolArguments();
		for (const char of input) parser.append(char);
		const result = parser.finalize();
		assert.deepEqual(result, expected);
		assert.equal(hasIncompleteToolArguments(result), hasIncompleteToolArguments(expected));
	});
}

test("large strings and open containers consume input once; scalar previews have a fixed inspection bound", () => {
	for (const size of [4096, 8192, 16384]) {
		const input = JSON.stringify({ payload: "x".repeat(size), items: Array.from({ length: size / 64 }, (_, i) => ({ i })) });
		const parser = new IncrementalToolArguments();
		for (let i = 0; i < input.length; i += 7) parser.append(input.slice(i, i + 7));
		const state = parser.diagnostics();
		assert.equal(state.inputCodeUnits, input.length); assert.equal(state.scannedCodeUnits, input.length);
		assert.ok(state.scalarPreviewCodeUnits <= Math.ceil(input.length / 7) * 64);
		assert.deepEqual(parser.finalize(), JSON.parse(input));
	}
});

test("deep inputs have no invented depth cap and dispose releases all parser-owned references", () => {
	const parser = new IncrementalToolArguments(), input = '['.repeat(1000) + '0' + ']'.repeat(1000);
	for (const char of input) parser.append(char);
	assert.equal(parser.diagnostics().maxDepth, 1000); parser.finalize();
	const partial = new IncrementalToolArguments(); partial.append('{"nested":[{"s":"' + 'x'.repeat(100000));
	partial.dispose(); partial.dispose();
	const state = partial.diagnostics();
	assert.equal(state.depth, 0); assert.equal(state.retainedRawCodeUnits, 0); assert.equal(state.retainedTokenCodeUnits, 0);
	assert.equal(state.retainedParent, false); assert.equal(state.retainedRoot, false);
	assert.throws(() => partial.append('late'), /closed/); assert.throws(() => partial.finalize(), /closed/);
});
