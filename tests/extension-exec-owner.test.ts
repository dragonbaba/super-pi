import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { setImmediate as nextTurn } from "node:timers/promises";
import test from "node:test";
import { execCommand } from "../packages/coding-agent/src/core/exec.ts";
import { SessionExecutionBoundary } from "../packages/coding-agent/src/core/execution-boundary.ts";
import { ExtensionExecOwner } from "../packages/coding-agent/src/core/extension-exec-owner.ts";
import { createExtensionRuntime } from "../packages/coding-agent/src/core/extensions/loader.ts";
import { WindowsShellJob } from "../packages/coding-agent/src/utils/windows-shell-job.ts";
import { ExecFixture, installExecFixture } from "./helpers/extension-exec-fixture.ts";

for (const mode of ["transition", "invalidate"] as const) test(`runtime ${mode} closes exec admission and joins physical cleanup`, async () => {
	const runtime = createExtensionRuntime(), child = new ExecFixture(); child.autoExit = false;
	let release!: (value: string | undefined) => void;
	const gate = new Promise<string | undefined>(resolve => { release = resolve; }); child.cleanupGate = gate;
	const restore = installExecFixture(child), oldSignal = runtime.executionBoundary.signal;
	try {
		const pending = runtime.execOwner.exec("fixture", [], process.cwd()); await child.ready;
		let published = false;
		if (mode === "invalidate") runtime.invalidate();
		const drain = mode === "invalidate" ? runtime.executionBoundary.dispose() : runtime.executionBoundary.transition(() => { published = true; });
		assert.equal(oldSignal.aborted, true);
		await assert.rejects(runtime.execOwner.exec("fixture", [], process.cwd()), /BOUNDARY_CHANGED/);
		await nextTurn(); assert.equal(published, false);
		child.finish();
		if (process.platform === "win32") { await nextTurn(); assert.equal(published, false); assert.equal(child.stopCount, 1); }
		release(undefined); await drain;
		assert.equal((await pending).killed, true); child.assertReleased();
		assert.equal(getEventListeners(oldSignal, "abort").length, 0);
		assert.equal(published, mode === "transition");
		if (mode === "transition") runtime.executionBoundary.assertCurrent();
		else assert.equal(runtime.executionBoundary.participantCount, 0);
	} finally {
		release(undefined); child.finish();
		await runtime.executionBoundary.dispose(); runtime.invalidate(); await runtime.disposeProviderOwners(); restore();
	}
});

test("ordinary failures and invalid options do not poison runtime transitions", async () => {
	const boundary = new SessionExecutionBoundary(), owner = new ExtensionExecOwner(boundary);
	try {
		await assert.rejects(owner.exec("unused", [], process.cwd(), { maxBuffer: -1 }), RangeError);
		const result = await owner.exec(process.execPath, ["-e", "process.exitCode=17"], process.cwd());
		assert.equal(result.code, 17);
		await boundary.transition(() => {}); boundary.assertCurrent();
	} finally { await boundary.dispose(); }
});

test("unconfirmed physical cleanup fails drain and cannot reopen admission", { skip: process.platform !== "win32" }, async () => {
	const boundary = new SessionExecutionBoundary(), owner = new ExtensionExecOwner(boundary);
	const child = new ExecFixture(); child.cleanupFailure = "injected job cleanup failure";
	const restore = installExecFixture(child);
	try {
		const pending = owner.exec("fixture", [], process.cwd()); await child.ready; child.finish();
		const result = await pending; assert.equal(result.code, 1); assert.match(result.stderr, /injected job cleanup failure/);
		await assert.rejects(owner.exec("unused", [], process.cwd()), /injected job cleanup failure/);
		await assert.rejects(boundary.transition(() => { assert.fail("must not publish"); }), /injected job cleanup failure/);
		await assert.rejects(boundary.dispose(), /injected job cleanup failure/);
		assert.equal(boundary.participantCount, 1); assert.equal(boundary.hasDeadline, false); child.assertReleased();
	} finally { restore(); }
});

for (const reason of ["caller", "runtime", "deadline", "native failure"] as const) test(`Windows ${reason} during admission never dispatches a command`, { skip: process.platform !== "win32" }, async () => {
	const boundary = new SessionExecutionBoundary(), owner = new ExtensionExecOwner(boundary), controller = new AbortController();
	let release!: () => void;
	const original = WindowsShellJob.spawn, gate = new Promise<void>(resolve => { release = resolve; });
	let dispatched = false;
	WindowsShellJob.spawn = async (_cmd, _args, cwd, _env, _stdin, _signal, beforeSpawn) => {
		await gate;
		if (reason === "native failure") throw new Error("native admission failed");
		beforeSpawn!(cwd); dispatched = true; throw new Error("unexpected dispatch");
	};
	try {
		const pending = owner.exec("unused", [], process.cwd(), { signal: controller.signal, timeout: reason === "deadline" ? 1 : undefined });
		let drain: Promise<void> | undefined;
		if (reason === "caller") controller.abort();
		if (reason === "runtime") drain = boundary.dispose();
		if (reason === "deadline") { const start = performance.now(); while (performance.now() - start < 2) { /* admission gate, no process */ } }
		release(); const result = await pending; await drain;
		assert.equal(dispatched, false); assert.equal(result.code, 1);
		assert.equal(result.killed, reason !== "native failure");
		if (reason === "native failure") assert.match(result.stderr, /native admission failed/);
	} finally { release(); WindowsShellJob.spawn = original; await boundary.dispose(); }
});

test("Windows cancellation after dispatch but before exec resumes still stops its job", { skip: process.platform !== "win32" }, async () => {
	const child = new ExecFixture(), restore = installExecFixture(child), controller = new AbortController();
	const spawn = WindowsShellJob.spawn;
	WindowsShellJob.spawn = async (...args) => { const job = await spawn(...args); controller.abort(); return job; };
	try {
		const result = await execCommand("fixture", [], process.cwd(), { signal: controller.signal });
		assert.equal(result.killed, true); assert.equal(child.stopCount, 1); child.assertReleased();
	} finally { restore(); }
});
