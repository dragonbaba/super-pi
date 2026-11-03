import assert from "node:assert/strict";
import { constants as bufferConstants } from "node:buffer";
import childProcess from "node:child_process";
import { getEventListeners, once } from "node:events";
import { mkdtempSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { execCommand } from "../packages/coding-agent/src/core/exec.ts";
import { createEventBus } from "../packages/coding-agent/src/core/event-bus.ts";
import { createExtensionRuntime, loadExtensionFromFactory } from "../packages/coding-agent/src/core/extensions/loader.ts";
import type { ExtensionAPI } from "../packages/coding-agent/src/core/extensions/types.ts";
import { ExecFixture, installExecFixture } from "./helpers/extension-exec-fixture.ts";
import { removeOwnedFixture } from "./helpers/owned-fixture-cleanup.ts";

test("the public extension API forwards cwd and maxBuffer to the same exec owner", async () => {
	const runtime = createExtensionRuntime(), bus = createEventBus();
	let api: ExtensionAPI | undefined;
	const child = new ExecFixture(), restore = installExecFixture(child, options => {
		assert.equal(options.cwd, tmpdir()); assert.equal(options.shell, false); assert.equal(options.windowsHide, true);
	});
	try {
		await loadExtensionFromFactory(pi => { api = pi; }, process.cwd(), bus, runtime);
		const pending = api!.exec("fixture", [], { cwd: tmpdir(), maxBuffer: 2 });
		await child.ready;
		child.stdout.emit("data", Buffer.from("abc"));
		const result = await pending;
		assert.equal(result.stdout, "ab"); assert.equal(result.truncated, true); assert.equal(result.code, 1);
		child.assertReleased();
	} finally { restore(); runtime.invalidate(); await runtime.disposeProviderOwners(); bus.clear(); }
});

test("real commands preserve stdout/stderr, empty output and nonzero exit", async () => {
	assert.deepEqual(await execCommand(process.execPath, ["-e", ""], process.cwd()), { stdout: "", stderr: "", code: 0, killed: false, truncated: false });
	const result = await execCommand(process.execPath, ["-e", "process.stdout.write('你好🌍');process.stderr.write('warning');process.exitCode=17"], process.cwd());
	assert.deepEqual(result, { stdout: "你好🌍", stderr: "warning", code: 17, killed: false, truncated: false });
});

test("UTF-8 survives every split point and both streams retain independent decoder state", async () => {
	const bytes = Buffer.from("A中🌍éZ");
	for (let split = 1; split < bytes.length; split++) {
		const child = new ExecFixture(), restore = installExecFixture(child);
		try {
			const pending = execCommand("fixture", [], process.cwd());
			await child.ready;
			child.stdout.emit("data", bytes.subarray(0, split));
			child.stderr.emit("data", bytes.subarray(0, bytes.length - split));
			child.stdout.emit("data", bytes.subarray(split));
			child.stderr.emit("data", bytes.subarray(bytes.length - split));
			child.finish();
			const result = await pending;
			assert.equal(result.stdout, "A中🌍éZ"); assert.equal(result.stderr, result.stdout);
			child.assertReleased();
		} finally { restore(); }
	}
});

test("a real output overflow terminates the child with bounded output", async () => {
	const result = await execCommand(process.execPath, ["-e", "process.stdout.write('x'.repeat(4096));process.stderr.write('y'.repeat(4096))"], process.cwd(), { maxBuffer: 128 });
	assert.equal(result.truncated, true); assert.equal(result.killed, true); assert.notEqual(result.code, 0);
	assert.equal(Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr), 128);
});

test("a genuine incomplete UTF-8 EOF is flushed, unlike an artificial capacity cut", async () => {
	const child = new ExecFixture(), restore = installExecFixture(child);
	try {
		const pending = execCommand("fixture", [], process.cwd(), { maxBuffer: 1 });
		await child.ready;
		child.stdout.emit("data", Buffer.from([0xe4])); child.finish();
		const result = await pending;
		assert.equal(result.stdout, "\ufffd"); assert.equal(result.code, 0); assert.equal(result.truncated, false);
		child.assertReleased();
	} finally { restore(); }
});

test("shared raw-byte cap accepts a prefix once and discards an incomplete UTF-8 suffix", async () => {
	const child = new ExecFixture(), restore = installExecFixture(child);
	try {
		const pending = execCommand("fixture", [], process.cwd(), { maxBuffer: 7 });
		await child.ready;
		child.stdout.emit("data", Buffer.from("abc"));
		child.stderr.emit("data", Buffer.from("é"));
		child.stdout.emit("data", Buffer.from("中tail")); // only two of the three UTF-8 bytes fit
		child.stderr.emit("data", Buffer.from("late"));
		if (!child.killed) child.finish();
		const result = await pending;
		assert.deepEqual(result, { stdout: "abc", stderr: "é", code: 1, killed: true, truncated: true });
		assert.deepEqual(child.signals, [process.platform === "win32" ? "SIGKILL" : "SIGTERM"]); child.assertReleased();
	} finally { restore(); }
});

for (const cap of [0, 4]) test(`maxBuffer=${cap}: exact capacity succeeds, one extra byte fails`, async () => {
	for (const extra of [0, 1]) {
		const child = new ExecFixture(), restore = installExecFixture(child);
		try {
			const pending = execCommand("fixture", [], process.cwd(), { maxBuffer: cap });
			await child.ready;
			child.stdout.emit("data", Buffer.alloc(cap + extra, 120));
			if (!extra) child.finish();
			else if (!child.killed) child.finish(); // let the baseline report its missing capacity behavior
			const result = await pending;
			assert.equal(result.stdout, "x".repeat(cap)); assert.equal(result.truncated, Boolean(extra));
			assert.equal(result.code, extra); child.assertReleased();
		} finally { restore(); }
	}
});

test("invalid caps reject before spawn; a pre-aborted command never executes", async () => {
	let spawns = 0;
	const child = new ExecFixture(), restore = installExecFixture(child, () => { spawns++; process.nextTick(() => child.finish()); });
	try {
		for (const maxBuffer of [-1, 1.5, NaN, Infinity, bufferConstants.MAX_STRING_LENGTH + 1]) {
			await assert.rejects(execCommand("fixture", [], process.cwd(), { maxBuffer }), RangeError);
		}
		const controller = new AbortController(); controller.abort();
		assert.deepEqual(await execCommand("fixture", [], process.cwd(), { signal: controller.signal }), { stdout: "", stderr: "", code: 1, killed: true, truncated: false });
		assert.equal(spawns, 0);
	} finally { restore(); }
});

test("spawn failures retain ENOENT diagnostics including with a zero output cap", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-exec-enoent-"));
	try {
		const result = await execCommand(join(root, "missing"), [], root, { maxBuffer: 0 });
		assert.equal(result.code, 1); assert.match(result.stderr, /ENOENT/); assert.equal(result.truncated, false);
	} finally { removeOwnedFixture(root); }
});

test("signal termination is not reported as a successful exit", async () => {
	const child = new ExecFixture(), restore = installExecFixture(child);
	try {
		const pending = execCommand("fixture", [], process.cwd());
		await child.ready;
		child.finish(null, "SIGTERM");
		const result = await pending;
		assert.equal(result.code, 1); assert.equal(result.killed, false); child.assertReleased();
	} finally { restore(); }
});

for (const reason of ["abort", "timeout", "cap"] as const) test(`${reason}: force kill uses actual exit facts and releases timers/listeners`, async t => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const child = new ExecFixture(); child.autoExit = false;
	const restore = installExecFixture(child), controller = new AbortController();
	try {
		const pending = execCommand("fixture", [], process.cwd(), { signal: controller.signal, timeout: 10, maxBuffer: 1 });
		await child.ready;
		if (reason === "abort") controller.abort();
		else if (reason === "timeout") t.mock.timers.tick(10);
		else child.stdout.emit("data", Buffer.from("over"));
		assert.deepEqual(child.signals, [process.platform === "win32" ? "SIGKILL" : "SIGTERM"]);
		child.stdout.emit("data", Buffer.from("late while stopping"));
		t.mock.timers.tick(4999); assert.equal(child.signals.length, 1);
		t.mock.timers.tick(1); assert.deepEqual(child.signals, process.platform === "win32" ? ["SIGKILL"] : ["SIGTERM", "SIGKILL"]);
		child.finish(0); // cooperative child exit=0 must not conceal an interruption
		const result = await pending;
		assert.equal(result.code, 1); assert.equal(result.killed, true);
		assert.equal(result.truncated, reason === "cap");
		assert.equal(result.stdout, reason === "cap" ? "o" : "");
		assert.equal(getEventListeners(controller.signal, "abort").length, 0); child.assertReleased();
		t.mock.timers.tick(20000); assert.equal(child.signals.length, process.platform === "win32" ? 1 : 2);
	} finally { restore(); }
});

test("completed execution removes its timeout, force timer and data callbacks; stale data cannot revive capture", async t => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const child = new ExecFixture(), restore = installExecFixture(child), controller = new AbortController();
	try {
		const pending = execCommand("fixture", [], process.cwd(), { timeout: 50, signal: controller.signal });
		await child.ready;
		const callbacks = child.stdout.listeners("data");
		child.stdout.emit("data", Buffer.from("done")); child.finish();
		const result = await pending;
		child.assertReleased(); assert.equal(getEventListeners(controller.signal, "abort").length, 0);
		for (const callback of callbacks) callback(Buffer.from("late"));
		t.mock.timers.tick(20000); controller.abort();
		assert.equal(result.stdout, "done"); assert.deepEqual(child.signals, []);
	} finally { restore(); }
});

test("abort after root exit closes inherited reading ends without waiting for descendant output", async t => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const child = new ExecFixture(), restore = installExecFixture(child), controller = new AbortController();
	try {
		const pending = execCommand("fixture", [], process.cwd(), { signal: controller.signal });
		await child.ready;
		child.exitCode = 0; child.emit("exit", 0, null);
		child.stdout.emit("data", Buffer.from("tail")); controller.abort();
		assert.equal(child.stdout.destroyed, true); assert.equal(child.stderr.destroyed, true);
		t.mock.timers.tick(100); await pending; child.assertReleased();
	} finally { restore(); }
});

test("real cancellation follows a child readiness handshake and leaves the owned PID exited", { timeout: 10000 }, async () => {
	const original = childProcess.spawn, controller = new AbortController();
	let child: childProcess.ChildProcess | undefined;
	childProcess.spawn = ((...args: Parameters<typeof childProcess.spawn>) => {
		child = original(...args);
		child.stdout!.once("data", () => controller.abort());
		return child;
	}) as typeof childProcess.spawn;
	syncBuiltinESMExports();
	try {
		const result = await execCommand(process.execPath, ["-e", "process.stdout.write('ready');setInterval(()=>{},1000)"], process.cwd(), { signal: controller.signal });
		assert.equal(result.killed, true); assert.notEqual(result.code, 0);
		assert.ok(child!.exitCode !== null || child!.signalCode !== null);
		assert.equal(getEventListeners(controller.signal, "abort").length, 0);
	} finally {
		childProcess.spawn = original; syncBuiltinESMExports();
		if (child && child.exitCode === null && child.signalCode === null) { const exited = once(child, "exit"); child.kill("SIGKILL"); await exited; }
	}
});

test("POSIX child ignoring SIGTERM is actually reaped by the 5s escalation", { skip: process.platform === "win32", timeout: 12000 }, async () => {
	const original = childProcess.spawn, controller = new AbortController();
	let child: childProcess.ChildProcess | undefined;
	childProcess.spawn = ((...args: Parameters<typeof childProcess.spawn>) => {
		child = original(...args); child.stdout!.once("data", () => controller.abort()); return child;
	}) as typeof childProcess.spawn;
	syncBuiltinESMExports();
	try {
		const result = await execCommand(process.execPath, ["-e", "process.on('SIGTERM',()=>{});process.stdout.write('ready');setInterval(()=>{},1000)"], process.cwd(), { signal: controller.signal });
		assert.equal(child!.signalCode, "SIGKILL"); assert.equal(result.code, 1); assert.equal(result.killed, true);
	} finally {
		childProcess.spawn = original; syncBuiltinESMExports();
		if (child && child.exitCode === null && child.signalCode === null) { const exited = once(child, "exit"); child.kill("SIGKILL"); await exited; }
	}
});
