import assert from "node:assert/strict";
import { test } from "node:test";
import { getEventListeners } from "node:events";
import { CodemodeSandbox } from "../packages/codemode/src/runtime/host.ts";
import { loadQuickJSWasm } from "../packages/codemode/src/wasm.ts";
import { MAX_CALLS, MAX_CODE_CHARS, MAX_OUTPUT_ITEMS } from "../packages/codemode/src/limits.ts";
import { parseCodemodeSource } from "../packages/codemode/src/source.ts";
import { BoundedJson } from "../packages/codemode/src/bounded-json.ts";
import { BridgeBudget, isWorkerToHostMessage } from "../packages/codemode/src/runtime/protocol.ts";

test("Codemode shares the compiled WASM promise and runs isolated executions", async () => {
	assert.equal(loadQuickJSWasm(), loadQuickJSWasm());
	const sandbox = new CodemodeSandbox({ tools: [{ name: "read-file", execute: args => args }] });
	try {
		const first = await sandbox.execute('globalThis.secret = 7; text(await tools.read_file({x: 2})); return ALL_TOOLS[0].name');
		assert.equal(first.ok, true);
		if (!first.ok) return;
		assert.equal(first.value, "read_file");
		assert.deepEqual(first.output, [{ type: "text", text: '{"x":2}' }]);
		assert.equal(first.calls[0]?.status, "ok");
		const second = await sandbox.execute('return [typeof secret, typeof process, typeof require, typeof fetch, typeof setTimeout]');
		assert.equal(second.ok, true);
		if (second.ok) assert.deepEqual(second.value, Array(5).fill("undefined"));
	} finally { await sandbox.close(); }
});

for (const [label, code] of [
	["CPU loop", "while (true) {}"],
	["microtask loop", "while (true) await null"],
] as const) {
	test(`Codemode terminates ${label} and remains reusable`, async () => {
		const sandbox = new CodemodeSandbox();
		try {
			const start = performance.now();
			const result = await sandbox.execute(code, { timeoutMs: 250 });
			assert.equal(result.ok, false);
			if (!result.ok) assert.equal(result.error.kind, "timeout");
			assert.ok(performance.now() - start < 5000);
			assert.equal((await sandbox.execute("return 2")).ok, true);
		} finally { await sandbox.close(); }
	});
}

for (const [label, code, expected] of [
	["text flood", 'for(let i=0;i<100000;i++) text("")', "output limit"],
	["large single line", 'text("x".repeat(10 * 1024 * 1024))', "output limit"],
	["console flood", 'console.log("x".repeat(2 * 1024 * 1024))', "console output limit"],
	["caught quota failure", 'try { text("x".repeat(2 * 1024 * 1024)); } catch {} return "success"', "output limit"],
	["call flood", 'for(let i=0;i<10000;i++) tools.read({})', "call limit"],
	["argument flood", 'try { await tools.read({x:"x".repeat(1024 * 1024)}); } catch {}', "argument limit"],
	["oversized return", 'return "x".repeat(2 * 1024 * 1024)', "return value"],
	["store deletion flood", 'for(let i=0;i<100000;i++) store("key"+i,undefined)', "store write count"],
	["unsettled promise", 'await new Promise(() => {})', "can never settle"],
	["invalid syntax", 'let = ;', ""],
] as const) {
	test(`Codemode bounds ${label}`, async () => {
		let calls = 0;
		const sandbox = new CodemodeSandbox({ tools: [{ name: "read", execute: () => { calls++; return 1; } }] });
		try {
			const result = await sandbox.execute(code);
			assert.equal(result.ok, false, JSON.stringify(result));
			if (!result.ok) assert.ok(result.error.message.includes(expected), result.error.message);
			assert.ok(result.output.length <= MAX_OUTPUT_ITEMS);
			assert.ok(calls <= MAX_CALLS);
		} finally { await sandbox.close(); }
	});
}

test("Codemode store preserves prototype keys, returns copies, and discards writes on error", async () => {
	const sandbox = new CodemodeSandbox();
	try {
		const store = JSON.parse('{"__proto__":{"x":2},"a":{"v":1}}');
		const result = await sandbox.execute('const a=load("a");a.v=9;store("__proto__",load("__proto__"));store("del",undefined);return load("a")', { store });
		assert.equal(result.ok, true);
		if (result.ok) {
			assert.deepEqual(result.value, { v: 1 });
			assert.equal(Object.getPrototypeOf(result.storeWrites.set), null);
			assert.deepEqual(result.storeWrites.set.__proto__, { x: 2 });
			assert.deepEqual(result.storeWrites.delete, ["del"]);
		}
		const failed = await sandbox.execute('store("x",2); throw new Error("oops")');
		assert.equal(failed.ok, false);
		assert.equal("storeWrites" in failed, false);
		await assert.rejects(sandbox.execute("return 1", { store: { bad: "x".repeat(300_000) } }), /limit/);
	} finally { await sandbox.close(); }
});

test("Codemode abort releases listeners and cancels unawaited host calls", async () => {
	const controller = new AbortController();
	let aborts = 0;
	let notifyStarted!: () => void;
	const started = new Promise<void>(resolve => { notifyStarted = resolve; });
	const sandbox = new CodemodeSandbox({ tools: [{ name: "wait", execute: (_args, context) => new Promise(resolve => {
		context.signal.addEventListener("abort", () => { aborts++; resolve(undefined); }, { once: true });
		notifyStarted();
	}) }] });
	try {
		const task = sandbox.execute("await tools.wait({})", { signal: controller.signal });
		await started;
		controller.abort();
		const result = await task;
		assert.equal(result.ok, false);
		if (!result.ok) assert.equal(result.error.kind, "aborted");
		assert.equal(aborts, 1);
		assert.equal(getEventListeners(controller.signal, "abort").length, 0);
		const unawaited = await sandbox.execute("tools.wait({}); return 1");
		assert.equal(unawaited.calls[0]?.status, "cancelled");
		assert.equal(aborts, 2);
	} finally { await sandbox.close(); }
});

test("Codemode catalog snapshots invalidate on changes; rejects overlapping execution and closed use", async () => {
	const sandbox = new CodemodeSandbox();
	try {
		assert.equal((await sandbox.execute("return ALL_TOOLS.length")).ok, true);
		sandbox.registerTool({ name: "newTool", execute: () => 42 });
		const result = await sandbox.execute("return await tools.newTool({})");
		assert.equal(result.ok && result.value, 42);
		sandbox.unregisterTool("newTool");
		assert.equal((await sandbox.execute("await tools.newTool({})")).ok, false);
		const controller = new AbortController();
		const running = sandbox.execute("while(true) {}", { signal: controller.signal });
		await assert.rejects(sandbox.execute("return 1"), /active execution/);
		controller.abort();
		await running;
	} finally { await sandbox.close(); }
	await assert.rejects(sandbox.execute("return 1"), /closed/);
});

test("Codemode refuses invalid outer limits and bounds tool results before crossing back", async () => {
	const sandbox = new CodemodeSandbox({ tools: [{ name: "big", execute: () => "x".repeat(10 * 1024 * 1024) }] });
	try {
		await assert.rejects(sandbox.execute("x".repeat(MAX_CODE_CHARS + 1)), /source/);
		for (const timeoutMs of [Infinity, NaN, 0, -1, 300001]) await assert.rejects(sandbox.execute("return 1", { timeoutMs }), /timeout/);
		const result = await sandbox.execute("await tools.big({})");
		assert.equal(result.ok, false);
		assert.equal(result.calls[0]?.status, "error");
	} finally { await sandbox.close(); }
});

test("Codemode validates protocol shapes and enforces cumulative budgets independently of VM helpers", () => {
	for (const value of [{ type: "call" }, { type: "done", ok: true }, { type: "output", item: null }]) assert.equal(isWorkerToHostMessage(value), false);
	const budget = new BridgeBudget();
	for (let i = 0; i < MAX_OUTPUT_ITEMS; i++) assert.equal(budget.consume({ type: "output", item: { type: "text", text: "" } }), true);
	assert.equal(budget.consume({ type: "output", item: { type: "text", text: "" } }), false);
	const serializer = new BoundedJson();
	assert.equal(serializer.stringify({ a: 1 }, 100), '{"a":1}');
	assert.throws(() => serializer.stringify({ a: "x".repeat(10000) }, 100), /limit/);
	assert.equal(serializer.stringify("ok", 100), '"ok"');
});

test("Codemode source options keep source lines and reject unsupported directives", () => {
	assert.deepEqual(parseCodemodeSource('// @options: {"timeout_ms":20,"max_output_tokens":100}\nreturn 1'), { code: "\nreturn 1", options: { timeoutMs: 20, maxOutputTokens: 100 } });
	assert.throws(() => parseCodemodeSource("// @options: {}"), /followed/);
	assert.throws(() => parseCodemodeSource('// @options: {"trusted":true}\nreturn 1'), /only supports/);
});
