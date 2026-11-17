import assert from "node:assert/strict";
import test from "node:test";
import { executionFixture } from "./codemode-recovery/execution-fixture.ts";
import { body } from "./codemode-recovery/fixture.ts";
import { CodemodeSandbox } from "../packages/codemode/src/runtime/host.ts";

test("independent batch completes other items, returns only failure diagnostics, and never replays successes", async t => {
	const f = await executionFixture(t);
	const { result } = await f.run(`const r=await batch([
		{tool:"probe",args:{kind:"ok",id:"first"}},
		{tool:"probe",args:{kind:"failure"}},
		{tool:"probe",args:{kind:"ok",id:"last",delay:40}},
	]);text(r.summary);text(r.results[2].result.content);store("completed",r.summary.completed);`);
	assert.equal(result.isError, false, body(result.content));
	assert.match(body(result.content), /CODEMODE_PARTIAL/);
	assert.match(body(result.content), /"completed":2/); assert.match(body(result.content), /"failed":1/);
	assert.match(body(result.content), /"index":1/); assert.match(body(result.content), /expected fixture failure/);
	assert.match(body(result.content), /ok last/); assert.deepEqual(f.calls, ["ok", "failure", "ok"]); assert.deepEqual(f.aborted, []);
	const next = await f.run('text(load("completed"));');
	assert.match(body(next.result.content), /\n2/); assert.equal(f.calls.length, 3);
});

test("independent batch preserves fatal uncertainty and never commits failed-script state", async t => {
	const f = await executionFixture(t);
	const { result } = await f.run('store("bad",true);await batch([{tool:"probe",args:{kind:"verification"}},{tool:"probe",args:{kind:"ok",delay:1000}}]);');
	assert.equal(result.isError, true, body(result.content));
	assert.ok(result.details.codemode.calls.some((call: any) => call.systemFailure));
	assert.match(body((await f.run('text(load("bad")??null);')).result.content), /null/);
	assert.equal(f.calls.filter(value => value === "verification").length, 1);
});

test("batch descriptor validation and an empty batch execute no tools", async t => {
	const f = await executionFixture(t);
	const invalid = await f.run('await batch([{tool:"probe",args:{kind:"ok"}},{tool:1,args:{}}]);');
	assert.equal(invalid.result.isError, true); assert.equal(f.calls.length, 0);
	const empty = await f.run('text((await batch([])).summary);');
	assert.equal(empty.result.isError, false, body(empty.result.content)); assert.match(body(empty.result.content), /"completed":0/);
});

test("independent batches preserve user cancellation and release pending children", async t => {
	const f = await executionFixture(t);
	const pending = f.run('store("cancelled",true);await batch([{tool:"probe",args:{kind:"ok",delay:10000}},{tool:"probe",args:{kind:"ok",delay:10000}}]);');
	await f.started; f.session.agent.abort();
	const cancelled = await pending;
	assert.equal(cancelled.result.isError, true); assert.ok(f.aborted.length >= 1);
	const next = await f.run('text(load("cancelled")??null);');
	assert.match(body(next.result.content), /null/);
});

test("batch forwards per-item review and keeps the originally dispatched tool identity", async () => {
	const observed: unknown[] = [];
	const sandbox = new CodemodeSandbox({ globals: [{ name: "callTool", spread: true, execute: args => {
		observed.push(args); return { content: [], isError: false };
	} }] });
	try {
		const result = await sandbox.execute('const item={tool:"original",args:{id:1},review:true};const pending=batch([item]);item.tool="changed";return (await pending).results[0].tool;');
		assert.equal(result.ok, true); if (result.ok) assert.equal(result.value, "original");
		assert.deepEqual(observed, [["original", { id: 1 }, { allowFailure: true, review: true }]]);
	} finally { await sandbox.close(); }
});

test("batch cannot replace the owner helper or bypass ordinary bridge call limits", async () => {
	assert.throws(() => new CodemodeSandbox({ globals: [{ name: "batch", execute: () => 1 }] }), /reserved/);
	let calls = 0;
	const sandbox = new CodemodeSandbox({ globals: [{ name: "callTool", spread: true, execute: () => { calls++; return { content: [], isError: false }; } }] });
	try {
		const result = await sandbox.execute('await batch(Array.from({length:257},()=>({tool:"fixture",args:{}})));');
		assert.equal(result.ok, false); assert.ok(calls <= 256);
		if (!result.ok) assert.match(result.error.message, /call limit/);
	} finally { await sandbox.close(); }
});
