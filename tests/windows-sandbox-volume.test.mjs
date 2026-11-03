import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { EventEmitter } from "node:events";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { TaskVolumeOwner, VolumeProtocol, VOLUME_LIMITS, POWERSHELL7_PATH, POWERSHELL7_PREFIX, verifyPowerShell7 } from "../scripts/acceptance/windows-sandbox-volume.mjs";
import { OfflineCandidateOwner, CANDIDATE_LIMITS, CANDIDATE_PROTOCOL } from "../scripts/acceptance/windows-sandbox-candidates.mjs";
const taskId = "11111111-2222-3333-4444-555555555555";
function facts(phase = "prepared-not-share-admitted") {
	return { protocol: "super-pi-volume-v1", taskId, sequence: 1, kind: "reply", phase, error: null,
		imageCreated: true, imageId: "AABBCCDD:0000000000000001", diskId: taskId, physicalPath: "\\\\.\\PhysicalDrive77",
		volumePath: "\\\\?\\Volume{aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee}\\", exchangeId: "AABBCCDD:0000000000000002",
		capacity: VOLUME_LIMITS.capacity, imageBudget: VOLUME_LIMITS.imageBytes, shareAdmission: false,
		detached: phase === "released", managementClosed: phase === "released", closeUnknown: false };
}
class Driver {
	pid = 123; physicallyClosed = false; pending = false; calls = []; mutate; unsafe;
	setUnsafeHandler(callback) { this.unsafe = callback; }
	async command(command, observe) {
		this.calls.push(command); const reply = facts(command === "release" || command === "exit" ? "released" : undefined);
		this.mutate?.(command, reply); observe(reply); return reply;
	}
	async waitClosed() { this.physicallyClosed = true; return true; }
}
function owner(driver = new Driver(), extras = {}) {
	const state = { runtime: { state: "not-started", neverDispatched: true, callsClosed: true }, revocations: 0, cancellations: 0, journals: [] };
	const instance = new TaskVolumeOwner({ driver, taskId, readRuntime: () => state.runtime,
		journal: value => state.journals.push(value), revokeCandidates: () => state.revocations++, cancelExecution: () => state.cancellations++, ...extras });
	return { instance, state, driver };
}
function root(t) {
	const parent = fs.realpathSync(os.tmpdir()), directory = fs.mkdtempSync(path.join(parent, "super-pi-wsb-volume-check-"));
	const identity = fs.lstatSync(directory, { bigint: true });
	t.after(() => {
		const actual = fs.lstatSync(directory, { bigint: true });
		assert.equal(actual.isSymbolicLink(), false); assert.equal(actual.dev, identity.dev); assert.equal(actual.ino, identity.ino);
		assert.equal(path.dirname(fs.realpathSync(directory)), parent); assert.equal(path.resolve(directory), directory);
		fs.rmSync(directory, { recursive: true }); assert.equal(fs.existsSync(directory), false);
	});
	return { directory, identity };
}

test("volume preparation never admits WSB sharing; release is gated by live host runtime and reads", async () => {
	const { instance, state, driver } = owner(); const prepared = await instance.prepare();
	assert.equal(instance.shareAdmission, false); assert.equal(prepared.volumePath + "exchange", "\\\\?\\Volume{aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee}\\exchange");
	for (const runtime of [{ state: "active", callsClosed: true }, { state: "closed", instanceAbsent: true, callsClosed: false },
		{ state: "unknown", instanceAbsent: true, callsClosed: true }, { state: "not-started", neverDispatched: false, callsClosed: true }]) {
		state.runtime = runtime; await assert.rejects(instance.release()); assert.deepEqual(driver.calls, ["prepare"]);
	}
	state.runtime = { state: "closed", instanceAbsent: true, callsClosed: true };
	await instance.verify(); instance.beginCandidateRead(); await assert.rejects(instance.release());
	instance.endCandidateRead({ activeHandles: 0, uncertainHandles: [] });
	assert.equal(await instance.release(), true); const count = driver.calls.length; assert.equal(await instance.release(), true);
	assert.equal(driver.calls.length, count); assert.equal(state.revocations, 0); assert.equal(driver.physicallyClosed, true);
});

test("helper exit, identity drift and close-unknown retain ownership and request cancellation", async () => {
	for (const mode of ["helper-exit", "identity", "read-close", "verify-error"]) {
		const { instance, driver, state } = owner(); await instance.prepare();
		if (mode === "helper-exit") { driver.unsafe(); driver.unsafe(); }
		else if (mode === "read-close") { instance.beginCandidateRead(); instance.endCandidateRead({ activeHandles: 1, uncertainHandles: [7] }); }
		else { driver.mutate = (_, reply) => { if (mode === "identity") reply.volumePath = "\\\\?\\Volume{bbbbbbbb-bbbb-cccc-dddd-eeeeeeeeeeee}\\"; else reply.error = "storage-operation-failed"; }; await assert.rejects(instance.verify()); }
		assert.equal(instance.state, "blocked"); assert.equal(instance.shareAdmission, false);
		assert.equal(state.revocations, 1); assert.equal(state.cancellations, 1); await assert.rejects(instance.release());
		assert.equal(driver.calls.includes("release"), false);
	}
});

test("host journal failure after a read revokes once and permanently blocks reuse and release", async () => {
	let fail = false;
	const { instance, driver, state } = owner(new Driver(), { journal: () => { if (fail) throw new Error("injected journal failure"); } });
	await instance.prepare(); instance.beginCandidateRead(); fail = true;
	assert.throws(() => instance.endCandidateRead({ activeHandles: 0, uncertainHandles: [] }));
	assert.equal(instance.state, "blocked"); assert.equal(state.revocations, 1); assert.equal(state.cancellations, 1);
	fail = false; driver.unsafe();
	assert.throws(() => instance.beginCandidateRead()); await assert.rejects(instance.release());
	assert.equal(state.revocations, 1); assert.equal(state.cancellations, 1); assert.deepEqual(driver.calls, ["prepare"]);
});

test("failed preparation may release only recorded resources; failed detach never exits or releases the owner", async () => {
	for (const phase of ["creating", "created", "attached", "initialized", "partitioned"]) {
		const { instance, driver } = owner(); driver.mutate = (command, reply) => {
			if (command === "prepare") { reply.error = "storage-operation-failed"; reply.phase = phase; }
		};
		await assert.rejects(instance.prepare()); assert.equal(instance.state, "blocked"); await instance.release();
		assert.deepEqual(driver.calls, ["prepare", "release", "exit"]);
	}
	const { instance, driver } = owner(); await instance.prepare();
	driver.mutate = (command, reply) => { if (command === "release") { reply.error = "storage-operation-failed"; reply.phase = "blocked"; reply.managementClosed = false; } };
	await assert.rejects(instance.release()); assert.equal(instance.state, "blocked"); assert.equal(driver.calls.includes("exit"), false);
});

test("disk release keeps actual checked candidate bytes alive; task revoke still reaches them", async t => {
	const { directory, identity } = root(t), snapshotId = randomUUID(); fs.mkdirSync(path.join(directory, "payload"));
	fs.writeFileSync(path.join(directory, "payload", "a.txt"), "abc");
	fs.writeFileSync(path.join(directory, "candidates.json"), JSON.stringify({ protocol: CANDIDATE_PROTOCOL, taskId, snapshotId,
		candidates: [{ path: "a.txt", operation: "add" }], report: { exitCode: 23 } }));
	const candidates = new OfflineCandidateOwner({ taskId, snapshotId, instanceId: randomUUID(), root: directory,
		rootIdentity: { dev: identity.dev, ino: identity.ino }, allowed: [{ path: "a.txt", operation: "add", revision: null }], budget: { ...CANDIDATE_LIMITS },
		lifecycle: { state: "closed", callsClosed: true, instanceAbsent: true, cancelled: false, timedOut: false, platformFailed: false },
		observations: { cliClose: { exitCode: 0, signal: null }, platformReceipt: null } });
	t.after(() => candidates.dispose());
	const { instance } = owner(new Driver(), { revokeCandidates: () => candidates.revoke() }); await instance.prepare();
	instance.beginCandidateRead(); const checked = candidates.check(); instance.endCandidateRead(candidates.diagnostics);
	assert.equal(checked.status, "candidate-checked"); await instance.release(); assert.equal(checked.copyBytes(0).toString(), "abc");
	instance.revoke(); assert.throws(() => checked.copyBytes(0)); assert.equal(candidates.diagnostics.retainedBytes, 0);
});

class Child extends EventEmitter {
	pid = 321; stdout = new EventEmitter(); stderr = new EventEmitter(); stdin = new EventEmitter(); writes = [];
	constructor() { super(); this.stdin.write = (value, callback) => { this.writes.push(JSON.parse(value)); callback?.(); }; }
	reply(value) { this.stdout.emit("data", Buffer.from(JSON.stringify(value) + "\r\n")); }
}
test("bounded protocol rejects forged replies and waits for physical close without killing a helper", async () => {
	for (const corrupt of [r => r.taskId = randomUUID(), r => r.shareAdmission = true, r => r.volumePath = "C:\\fallback",
		r => r.authorized = true, r => r.sequence = 2]) {
		const child = new Child(), protocol = new VolumeProtocol(child, taskId); let unsafe = 0; protocol.setUnsafeHandler(() => unsafe++);
		const pending = protocol.command("prepare", () => {}, 1000); const reply = facts(); corrupt(reply); child.reply(reply);
		await assert.rejects(pending); assert.equal(protocol.blocked, true); assert.equal(protocol.pending, true); assert.ok(unsafe);
		child.emit("close", 1, null); assert.equal(protocol.pending, false); assert.equal(child.stdout.listenerCount("data"), 0);
	}
	const child = new Child(), protocol = new VolumeProtocol(child, taskId); protocol.setUnsafeHandler(() => {});
	await assert.rejects(protocol.command("prepare", () => {}, 1)); assert.equal(protocol.physicallyClosed, false); assert.equal(protocol.pending, true);
	child.emit("close", 1, null); assert.equal(protocol.pending, false);
});

test("protocol budget, broken input and graceful exit preserve bounded physical ownership", async () => {
	for (const mode of ["oversize", "input-error", "early-close"]) {
		const child = new Child(), protocol = new VolumeProtocol(child, taskId); protocol.setUnsafeHandler(() => {});
		const pending = protocol.command("prepare", () => {}, 1000);
		if (mode === "oversize") child.stdout.emit("data", Buffer.alloc(8193, 0x41));
		else if (mode === "input-error") child.stdin.emit("error", new Error("injected"));
		else child.emit("close", 0, null);
		await assert.rejects(pending); if (!protocol.physicallyClosed) child.emit("close", 1, null);
		assert.equal(protocol.physicallyClosed, true); assert.equal(child.stdin.listenerCount("error"), 0);
	}
	const child = new Child(), protocol = new VolumeProtocol(child, taskId); protocol.setUnsafeHandler(() => {});
	const pending = protocol.command("exit", () => {}, 1000); child.reply(facts("released")); await pending;
	const closing = protocol.waitClosed(1000); child.emit("close", 0, null); assert.equal(await closing, true);
});

test("native helper compiles and its actual PowerShell functions pass non-storage substitute checks", { timeout: 30000 }, async t => {
	const { directory } = root(t);
	const source = fileURLToPath(new URL("../scripts/acceptance/windows-sandbox-volume-native.cs", import.meta.url));
	const helper = fileURLToPath(new URL("../scripts/acceptance/windows-sandbox-volume-helper.ps1", import.meta.url));
	const fixture = fileURLToPath(new URL("./fixtures/windows-sandbox-volume-helper-check.ps1", import.meta.url));
	const assembly = path.join(directory, "volume-native.dll");
	const compiled = spawnSync("C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe",
		["/nologo", "/target:library", "/platform:x64", "/out:" + assembly, source], { windowsHide: true, encoding: "utf8", timeout: 15000, maxBuffer: 16384 });
	assert.equal(compiled.error, undefined); assert.equal(compiled.status, 0, compiled.stdout + compiled.stderr);
	assert.ok(fs.statSync(assembly).size <= VOLUME_LIMITS.nativeBytes);
	verifyPowerShell7();
	const checked = spawnSync(POWERSHELL7_PATH,
		[...POWERSHELL7_PREFIX, "-File", fixture, "-HelperPath", helper, "-NativeAssembly", assembly, "-FixtureRoot", directory],
		{ windowsHide: true, encoding: "utf8", timeout: 15000, maxBuffer: 16384 });
	assert.equal(checked.error, undefined); assert.equal(checked.status, 0, checked.stdout + checked.stderr);
	const report = JSON.parse(checked.stdout.replace(/^\uFEFF/, "")); assert.equal(report.cases, 20); assert.equal(report.realStorageOperations, 0);
	assert.equal(report.helperParsed, true); assert.equal(report.abiSize, 56);
	const child = new Child(), protocol = new VolumeProtocol(child, taskId); protocol.setUnsafeHandler(() => {});
	const pending = protocol.command("prepare", () => {}, 1000); child.reply(report.protocolReply);
	try { assert.equal((await pending).error, null); } finally { child.emit("close", 1, null); }
	const { protocolReply, ...summary } = report; t.diagnostic(JSON.stringify(summary));
});
