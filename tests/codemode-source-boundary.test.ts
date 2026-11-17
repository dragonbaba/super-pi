import assert from "node:assert/strict";
import { test } from "node:test";
import { CodemodeSandbox } from "../packages/codemode/src/runtime/host.ts";

function longSource(body: string, length: number): string {
	return `/*${" ".repeat(length - body.length - 4)}*/${body}`;
}

test("whole source beyond former character limits executes once and releases each VM", async () => {
	let effects = 0;
	const sandbox = new CodemodeSandbox({ reuseWorker: true, tools: [{ name: "effect", execute() { return ++effects; } }] });
	try {
		for (const length of [191310, 1024 * 1024 + 1]) {
			const result = await sandbox.execute(longSource('return await tools.effect({});', length));
			assert.equal(result.ok, true, JSON.stringify(result));
			assert.equal(result.ok && result.value, effects);
			assert.equal(result.calls.length, 1);
			assert.equal(sandbox.stats.activeExecutions, 0);
		}
		assert.equal(effects, 2);
		const invalid = await sandbox.execute(longSource('return (', 191310));
		assert.equal(invalid.ok, false);
		if (!invalid.ok) { assert.equal(invalid.error.kind, "script"); assert.equal(invalid.error.name, "SyntaxError"); }
		assert.equal(invalid.calls.length, 0);
		assert.equal(sandbox.stats.workersStarted, sandbox.stats.workersStopped);
		assert.equal((await sandbox.execute("return 42")).ok, true);
		assert.equal(effects, 2, "neither failure nor recovery replays a completed tool");
	} finally { await sandbox.close(); }
	assert.equal(sandbox.stats.activeExecutions, 0);
	assert.equal(sandbox.stats.workersStarted, sandbox.stats.workersStopped);
});

test("actual VM heap exhaustion retains completed effects and retires the worker", async () => {
	let effects = 0;
	const sandbox = new CodemodeSandbox({ reuseWorker: true, memoryLimitBytes: 8 * 1024 * 1024,
		tools: [{ name: "effect", execute() { effects++; } }] });
	try {
		const result = await sandbox.execute(longSource('await tools.effect({}); const a=[]; for (;;) a.push(new Uint8Array(1024*1024));', 191310));
		assert.equal(result.ok, false);
		if (!result.ok) assert.match(result.error.message, /memory/i);
		assert.equal(result.calls[0]?.status, "ok");
		assert.equal(effects, 1);
		assert.equal(sandbox.stats.workersStarted, sandbox.stats.workersStopped);
		const next = await sandbox.execute("return 42");
		assert.equal(next.ok && next.value, 42);
		assert.equal(effects, 1);
	} finally { await sandbox.close(); }
	assert.equal(sandbox.stats.activeExecutions, 0);
	assert.equal(sandbox.stats.workersStarted, sandbox.stats.workersStopped);
});

test("long source timeout and cancellation preserve effects without replay on the next cell", async () => {
	let effects = 0;
	const controller = new AbortController();
	const sandbox = new CodemodeSandbox({ reuseWorker: true, tools: [
		{ name: "effect", execute() { effects++; } },
		{ name: "cancel", execute() { controller.abort(); } },
	] });
	try {
		const timeout = await sandbox.execute(longSource('await tools.effect({}); while (true) {}', 191310), { timeoutMs: 500 });
		assert.equal(timeout.ok, false);
		if (!timeout.ok) assert.equal(timeout.error.kind, "timeout");
		assert.equal(timeout.calls[0]?.status, "ok");
		assert.equal(sandbox.stats.workersStarted, sandbox.stats.workersStopped);
		const aborted = await sandbox.execute(longSource('await tools.effect({}); await tools.cancel({});', 191310), { signal: controller.signal });
		assert.equal(aborted.ok, false);
		if (!aborted.ok) assert.equal(aborted.error.kind, "aborted");
		assert.equal(aborted.calls[0]?.status, "ok");
		assert.equal(sandbox.stats.workersStarted, sandbox.stats.workersStopped);
		const next = await sandbox.execute("return 42");
		assert.equal(next.ok && next.value, 42);
		assert.equal(effects, 2);
	} finally { await sandbox.close(); }
	assert.equal(sandbox.stats.activeExecutions, 0);
	assert.equal(sandbox.stats.workersStarted, sandbox.stats.workersStopped);
});
