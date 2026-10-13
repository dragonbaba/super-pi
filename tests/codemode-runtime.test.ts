import assert from "node:assert/strict";
import { test } from "node:test";
import { getEventListeners } from "node:events";
import { CodemodeSandbox } from "../packages/codemode/src/runtime/host.ts";
import { WorkerPool } from "../packages/codemode/src/runtime/worker-pool.ts";
import { loadQuickJSWasm } from "../packages/codemode/src/wasm.ts";
import { MAX_CALLS, MAX_CODE_CHARS, MAX_OUTPUT_ITEMS } from "../packages/codemode/src/limits.ts";
import { parseCodemodeSource } from "../packages/codemode/src/source.ts";
import { BoundedJson } from "../packages/codemode/src/bounded-json.ts";
import { BridgeBudget, isWorkerToHostMessage } from "../packages/codemode/src/runtime/protocol.ts";
import { assignCodemodeIdentifiers, renderToolSignature } from "../packages/codemode/src/declarations.ts";

test("pooled scripts keep fresh VMs, catalogs, quotas and fenced late tool results", async () => {
	let releaseLate!: (value: unknown) => void;
	let lateSignal: AbortSignal | undefined;
	const sandbox = new CodemodeSandbox({ reuseWorker: true, tools: [
		{ name: "late", execute: (_args, { signal }) => { lateSignal = signal; return new Promise(resolve => { releaseLate = resolve; }); } },
		{ name: "echo", execute: args => args },
	] });
	try {
		const first = await sandbox.execute('globalThis.secret = 7; tools.late({}); store("secret", 1); for(let i=0;i<128;i++) text(i); return await tools.echo(3)');
		assert.ok(first.ok, JSON.stringify(first));
		assert.equal(lateSignal?.aborted, true);
		assert.equal(first.calls[0]?.status, "cancelled");
		assert.deepEqual(sandbox.stats, { activeExecutions: 0, workersStarted: 1, workersStopped: 0 });
		sandbox.unregisterTool("late");
		sandbox.registerTool({ name: "next", execute: () => { releaseLate("stale result"); return 9; } });
		const second = await sandbox.execute('text("fresh budget"); return [typeof secret, load("secret"), load("input"), ALL_TOOLS.map(t => t.name), await tools.next(), await tools.echo(4)]', { store: { input: 2 } });
		assert.ok(second.ok, JSON.stringify(second));
		assert.deepEqual(second.value, ["undefined", null, 2, ["echo", "next"], 9, 4]);
		assert.deepEqual(second.output, [{ type: "text", text: "fresh budget" }]);
		assert.deepEqual(sandbox.stats, { activeExecutions: 0, workersStarted: 1, workersStopped: 0 });
		// Bound the lifetime to 64 leases even when every execution is healthy.
		for (let index = 2; index < 65; index++) assert.ok((await sandbox.execute("return 1")).ok);
		assert.deepEqual(sandbox.stats, { activeExecutions: 0, workersStarted: 2, workersStopped: 1 });
	} finally { releaseLate?.(undefined); await sandbox.close(); }
	assert.deepEqual(sandbox.stats, { activeExecutions: 0, workersStarted: 2, workersStopped: 2 });
	await sandbox.close();
	await assert.rejects(sandbox.execute("return 1"), /closed/);
});

test("pooled workers are retired on failure, timeout, abort and active close", async () => {
	const sandbox = new CodemodeSandbox({ reuseWorker: true });
	try {
		const unawaited = await sandbox.execute('void (async () => { while(true) await null; })(); return 42', { timeoutMs: 500 });
		assert.ok(unawaited.ok, JSON.stringify(unawaited));
		assert.equal(unawaited.value, 42, "completion cancels unawaited VM microtasks before reuse");
		for (const code of ['throw new Error("bad")', "let = ;", "while(true) {}", "while(true) await null"]) {
			assert.ok((await sandbox.execute("return 1")).ok);
			const failed = await sandbox.execute(code, { timeoutMs: 200 });
			assert.equal(failed.ok, false);
			assert.equal(sandbox.stats.workersStarted, sandbox.stats.workersStopped);
		}
		const large = await sandbox.execute("const bytes = new Uint8Array(72 * 1024 * 1024); return bytes.length");
		assert.ok(large.ok, JSON.stringify(large));
		assert.equal(sandbox.stats.workersStarted, sandbox.stats.workersStopped, "oversized Worker is not retained");
		let entered!: () => void;
		let release!: () => void;
		const started = new Promise<void>(resolve => { entered = resolve; });
		const blocked = new Promise<void>(resolve => { release = resolve; });
		sandbox.registerTool({ name: "block", execute: () => { entered(); return blocked; } });
		const controller = new AbortController();
		const executing = sandbox.execute("await tools.block()", { signal: controller.signal });
		await started;
		await assert.rejects(sandbox.execute("return 2"), /overlap|active|already|one/i);
		controller.abort();
		const aborted = await executing;
		assert.ok(!aborted.ok && aborted.error.kind === "aborted");
		assert.equal(getEventListeners(controller.signal, "abort").length, 0);
		release();
		assert.ok((await sandbox.execute("return 3")).ok);
		const running = sandbox.execute("while(true) {}");
		await sandbox.close();
		const closed = await running;
		assert.ok(!closed.ok && closed.error.kind === "aborted");
	} finally { await sandbox.close(); }
	assert.equal(sandbox.stats.workersStarted, sandbox.stats.workersStopped);
});

test("worker pool owns one slot through idle retirement and rejects double acquisition", async t => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const lifecycle = { workersStarted: 0, workersStopped: 0 };
	const pool = new WorkerPool(new URL('data:text/javascript,import { parentPort } from "node:worker_threads"; parentPort.on("message", () => {});'), lifecycle);
	const lease = { completed: false }, nextLease = { completed: false }, lastLease = { completed: false };
	try {
		const first = await pool.acquire(lease);
		await assert.rejects(pool.acquire(nextLease), /already leased/);
		await pool.release(first, lease, true);
		await pool.release(first, lease, true); // Double release cannot add another idle slot/timer.
		assert.equal(await pool.acquire(nextLease), first);
		await pool.release(first, lease, true); // Stale owner, same physical Worker.
		await assert.rejects(pool.acquire(lastLease), /already leased/);
		await pool.release(first, nextLease, true);
		t.mock.timers.tick(30_000);
		const second = await pool.acquire(lastLease);
		assert.notEqual(first, second);
		assert.deepEqual(lifecycle, { workersStarted: 2, workersStopped: 1 });
		await pool.release(first, nextLease, true); // A stale Worker cannot return the current slot.
		await assert.rejects(pool.acquire(lease), /already leased/);
		const retiring = pool.release(second, lastLease, false);
		const cancelled = pool.acquire(lease);
		lease.completed = true;
		const replacement = pool.acquire(nextLease);
		await assert.rejects(cancelled, /cancelled/);
		await retiring;
		await replacement; // The cancelled waiter never steals the replacement lease.
		assert.deepEqual(lifecycle, { workersStarted: 3, workersStopped: 2 });
	} finally { await pool.close(); }
	assert.deepEqual(lifecycle, { workersStarted: 3, workersStopped: 3 });
	await assert.rejects(pool.acquire(nextLease), /closed/);
});

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

test("unknown tools point to catalog discovery without inventing a sandbox global", async () => {
	let calls = 0;
	const sandbox = new CodemodeSandbox({ tools: [{ name: "read-file", description: "Read a fixture", execute: () => { calls++; return "found"; } }] });
	try {
		const failed = await sandbox.execute("await tools.readFile({})");
		assert.equal(failed.ok, false);
		if (failed.ok) return;
		assert.equal(failed.error.kind, "script");
		assert.equal(failed.error.name, "TypeError");
		assert.match(failed.error.message, /Did you mean tools\.read_file/);
		assert.match(failed.error.message, /ALL_TOOLS/);
		assert.doesNotMatch(failed.error.message, /searchTools/);
		assert.equal(calls, 0);
		assert.deepEqual(failed.calls, []);
		const recovered = await sandbox.execute('const tool = ALL_TOOLS.find(t => t.description.includes("fixture")); return [await tools[tool.name]({}), typeof searchTools, typeof describeTools]');
		assert.equal(recovered.ok, true);
		if (recovered.ok) assert.deepEqual(recovered.value, ["found", "undefined", "undefined"]);
		assert.equal(calls, 1);
	} finally { await sandbox.close(); }
	assert.deepEqual(sandbox.stats, { activeExecutions: 0, workersStarted: 2, workersStopped: 2 });
});

test("Codemode built-in patches cannot corrupt calls, output or store writes", async () => {
	const sandbox = new CodemodeSandbox({
		tools: [{ name: "echo", execute: args => args }],
		globals: [{ name: "echoArgs", spread: true, execute: args => args }],
	});
	try {
		const result = await sandbox.execute(`
			Array.prototype.toJSON = () => null;
			Object.prototype.toJSON = () => 5;
			Promise.prototype.then = () => {};
			Map.prototype.get = () => undefined;
			globalThis.JSON = { stringify: () => "x", parse: () => "x" };
			store("k", [1]); store("old", undefined);
			text(await tools.echo({a: 2}));
			return [load("k"), await echoArgs([3], {b: 4})];
		`, { store: { old: 0 } });
		assert.equal(result.ok, true, JSON.stringify(result));
		if (result.ok) {
			assert.deepEqual(result.value, [[1], [[3], { b: 4 }]]);
			assert.deepEqual(result.output, [{ type: "text", text: '{"a":2}' }]);
			assert.deepEqual({ ...result.storeWrites.set }, { k: [1] });
			assert.deepEqual(result.storeWrites.delete, ["old"]);
			assert.equal(result.calls[0]?.status, "ok");
		}
		const exited = await sandbox.execute('Array.prototype.toJSON = () => null; store("k", [2]); exit()');
		assert.equal(exited.ok, true, JSON.stringify(exited));
		if (exited.ok) assert.deepEqual({ ...exited.storeWrites.set }, { k: [2] });
		const next = await sandbox.execute('return [Object.prototype.toJSON === undefined, Array.prototype.toJSON === undefined, await tools.echo(7)]');
		assert.equal(next.ok, true, JSON.stringify(next));
		if (next.ok) assert.deepEqual(next.value, [true, true, 7]);
	} finally { await sandbox.close(); }
	assert.deepEqual(sandbox.stats, { activeExecutions: 0, workersStarted: 3, workersStopped: 3 });
	assert.equal(Object.hasOwn(Object.prototype, "toJSON"), false);
	assert.equal(Object.hasOwn(Array.prototype, "toJSON"), false);
});

test("Codemode rejects configured globals that shadow live VM names before execution", async () => {
	const sandbox = new CodemodeSandbox({
		tools: [{ name: "Math", execute: () => 7 }],
		globals: [{ name: "custom.echo", execute: args => args }],
	});
	try {
		const result = await sandbox.execute('return [Object.getOwnPropertyNames(globalThis).filter(name => name !== "custom"), await custom.echo(3), await tools.Math({})]');
		assert.equal(result.ok, true, JSON.stringify(result));
		if (!result.ok) return;
		const [names, echoed, tool] = result.value as [string[], number, number];
		assert.equal(echoed, 3);
		assert.equal(tool, 7);
		assert.ok(names.includes("JSON") && names.includes("Promise") && names.includes("Math"));
		// Verify the host's reserved names against the actual engine, so upgrades
		// cannot silently reintroduce startup failures for new built-ins.
		for (const name of names) for (const configured of [name, `${name}.echo`]) {
			assert.throws(() => new CodemodeSandbox({ globals: [{ name: configured, execute: () => 0 }] }), /conflicts with a reserved VM global/, configured);
		}
	} finally { await sandbox.close(); }
	assert.deepEqual(sandbox.stats, { activeExecutions: 0, workersStarted: 1, workersStopped: 1 });
});

test("Codemode freezes indirect intrinsics while preserving instance overrides", async () => {
	const sandbox = new CodemodeSandbox();
	try {
		const result = await sandbox.execute(`
			"use strict";
			const object = {}; object.toString = () => "custom";
			function Legacy() {}
			Legacy.prototype = Object.create(Error.prototype); Legacy.prototype.constructor = Legacy;
			class MyError extends Error { constructor(message) { super(message); this.name = "MyError"; } }
			const bare = new Error(); bare.message = "later";
			const date = new Date(0); const customDate = new Date(0); customDate.toJSON = () => "date";
			const array = [1]; array.toJSON = () => [2];
			class Custom { toJSON() { return {custom: true}; } }
			globalThis.ownGlobal = 7;
			const frozen = [Object.prototype, Array.prototype, JSON,
				Object.getPrototypeOf(function* () {}).prototype, Object.getPrototypeOf(async function () {}),
				Object.getPrototypeOf(async function* () {}).prototype, Object.getPrototypeOf(Int8Array).prototype,
				Object.getPrototypeOf([][Symbol.iterator]()), Object.getPrototypeOf(Object.getPrototypeOf([][Symbol.iterator]())),
				Object.getPrototypeOf(new Map()[Symbol.iterator]()), Object.getPrototypeOf(new Set()[Symbol.iterator]()),
				Object.getPrototypeOf(""[Symbol.iterator]()), Object.getPrototypeOf(/a/[Symbol.matchAll](""))
			].every(Object.isFrozen);
			return [frozen, String(object), new Legacy().constructor === Legacy, new MyError("x").name,
				bare.message, date, customDate, array, new Custom(), ownGlobal];
		`);
		assert.equal(result.ok, true, JSON.stringify(result));
		if (result.ok) assert.deepEqual(result.value, [true, "custom", true, "MyError", "later", "1970-01-01T00:00:00.000Z", "date", [2], { custom: true }, 7]);
	} finally { await sandbox.close(); }
	assert.deepEqual(sandbox.stats, { activeExecutions: 0, workersStarted: 1, workersStopped: 1 });
});

test("Codemode rejected built-in patches and unreadable thrown values remain script errors", async () => {
	const sandbox = new CodemodeSandbox();
	try {
		for (const code of [
			'"use strict"; Array.prototype.toJSON = () => null',
			'Object.defineProperty(Object.prototype, "toJSON", {value: () => 5})',
			'Object.setPrototypeOf(Array.prototype, {})',
			'"use strict"; globalThis.JSON = {}',
			'Error.prototype.name = "patched"',
		]) {
			const result = await sandbox.execute(code);
			assert.equal(result.ok, false, code);
			if (!result.ok) { assert.equal(result.error.kind, "script"); assert.equal(result.error.name, "TypeError"); }
		}
		const result = await sandbox.execute('store("lost", 1); const error = new Error("x"); Object.defineProperty(error, "message", {get() {throw 7;}}); throw error');
		assert.equal(result.ok, false);
		if (!result.ok) {
			assert.equal(result.error.kind, "script");
			assert.equal(result.error.message, "The script threw a value that cannot be described");
			assert.equal("storeWrites" in result, false);
		}
		const numeric = await sandbox.execute('const error = new Error(); error.name = 17; error.message = 42; throw error');
		assert.equal(numeric.ok, false);
		if (!numeric.ok) {
			assert.equal(numeric.error.kind, "script");
			assert.equal(numeric.error.name, "17");
			assert.equal(numeric.error.message, "42");
		}
		const next = await sandbox.execute('return 7');
		assert.equal(next.ok && next.value, 7);
	} finally { await sandbox.close(); }
	assert.deepEqual(sandbox.stats, { activeExecutions: 0, workersStarted: 8, workersStopped: 8 });
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
	for (const value of [{ type: "call" }, { type: "done", ok: true }, { type: "done", ok: true, writes: "[]", reusable: "yes" }, { type: "output", item: null }]) assert.equal(isWorkerToHostMessage(value), false);
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

test("tool names that normalize to the same identifier all stay reachable and listed", async () => {
	// Registration order must not decide the mapping: the valid identifier keeps its own name.
	for (const names of [["foo-bar", "foo_bar", "foo.bar"], ["foo.bar", "foo_bar", "foo-bar"]]) {
		const identifiers = assignCodemodeIdentifiers(names);
		assert.deepEqual(Object.fromEntries(identifiers), { "foo-bar": "foo_bar_2", "foo.bar": "foo_bar_3", foo_bar: "foo_bar" });
		const sandbox = new CodemodeSandbox({ tools: names.map(name => ({ name, execute: () => name })) });
		try {
			const result = await sandbox.execute(
				'return [ALL_TOOLS.map(t => t.name).sort(), await tools.foo_bar({}), await tools.foo_bar_2({}), await tools.foo_bar_3({}), await tools["foo-bar"]({}), await tools["foo.bar"]({})]');
			assert.equal(result.ok, true, JSON.stringify(result));
			if (result.ok) assert.deepEqual(result.value, [["foo_bar", "foo_bar_2", "foo_bar_3"], "foo_bar", "foo-bar", "foo.bar", "foo-bar", "foo.bar"]);
		} finally { await sandbox.close(); }
	}
	assert.deepEqual(Object.fromEntries(assignCodemodeIdentifiers(["a-b", "a_b_2", "a.b"])), { "a-b": "a_b", "a.b": "a_b_3", a_b_2: "a_b_2" });
	assert.ok(renderToolSignature({ name: "foo-bar" }, { identifier: "foo_bar_2" }).startsWith("foo_bar_2(args: unknown)"));
});
