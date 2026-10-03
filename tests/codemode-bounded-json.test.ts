import assert from "node:assert/strict";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { BoundedJson } from "../packages/codemode/src/bounded-json.ts";
import { CodemodeStore } from "../packages/coding-agent/src/core/codemode-store.ts";

test("bounded JSON accepts actual-size boundaries for arrays, keys, escapes and boxed values", () => {
	const serializer = new BoundedJson();
	const values = [Array(20000).fill(0), [true, false, null, undefined, NaN, Infinity, -0, 1e-200],
		{ "": 0, "0": [[], {}, "\n\u0000\ud800\"\\"], ignored: undefined }, { a: { b: [0, "日"] } },
		runInNewContext('new String("hello")'), runInNewContext('new Number(0)'), new Date(0), "", 0, null, {}];
	values.push(runInNewContext('Object.assign(new String("long value"), { [Symbol.toPrimitive]: () => "" })'));
	for (const value of values) {
		const json = JSON.stringify(value)!;
		assert.equal(serializer.stringify(value, json.length), json);
		assert.throws(() => serializer.stringify(value, json.length - 1), RangeError);
	}
	assert.equal(serializer.stringify(Array(20000).fill(0), 262144)?.length, 40001);
});

test("raw JSON primitives retain exact boundaries without bypassing oversized-leaf checks", t => {
	const raw = (JSON as typeof JSON & { rawJSON?: (text: string) => unknown }).rawJSON;
	if (!raw) { t.skip("This Node version has no JSON.rawJSON"); return; }
	const serializer = new BoundedJson();
	for (const text of ['0', 'true', '"escaped\\nvalue"', '12345678901234567890']) {
		const value = raw(text);
		assert.equal(serializer.stringify(value, text.length), text);
		assert.throws(() => serializer.stringify(value, text.length - 1), /limit/);
	}
	assert.throws(() => serializer.stringify(raw('"' + 'x'.repeat(1000000) + '"'), 32), /limit/);
});

test("bounded JSON caps omitted-value traversal, oversized leaves and releases state after failure", () => {
	const serializer = new BoundedJson();
	const omitted = Object.create(null);
	for (let i = 0; i < 1100; i++) omitted[i] = undefined;
	assert.throws(() => serializer.stringify(omitted, 2), /traversal/);
	assert.throws(() => serializer.stringify("x".repeat(1000000), 32), /limit/);
	assert.throws(() => serializer.stringify(runInNewContext('new String("x".repeat(1000000))'), 32), /limit/);
	const circular: any = {}; circular.self = circular;
	assert.throws(() => serializer.stringify(circular, 1024));
	assert.throws(() => serializer.stringify({ get value() { return serializer.stringify(1, 1); } }, 1024), /reentered/);
	assert.equal(serializer.stringify({ valid: true }, 14), '{"valid":true}');
	assert.equal(serializer.stringify(undefined, 0), undefined);
});

test("store accepts numeric snapshots and failed restore or apply preserves prior values", () => {
	const store = new CodemodeStore();
	store.restore({ previous: 7 });
	store.apply({ set: { numbers: Array(20000).fill(0) }, delete: [] });
	const saved = store.snapshot;
	store.restore(saved);
	assert.equal((store.snapshot.numbers as number[]).length, 20000);
	assert.throws(() => store.restore({ invalid: "x".repeat(262145) }));
	assert.equal(store.snapshot.previous, 7);
	assert.throws(() => store.apply({ set: { invalid: "x".repeat(262145) }, delete: [] }));
	assert.equal(store.snapshot.previous, 7);
});
