import { PINNED_SANDBOX_TEST_OPTIONS } from "./helpers/windows-sandbox-prerequisites.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { CapturedProcess, SandboxLifecycle } from "../scripts/acceptance/windows-sandbox-lifecycle.mjs";
import { sameSnapshot, validateSnapshot, parseHostSnapshot, guestContext, OwnedHelperRunner } from "../scripts/acceptance/windows-sandbox-clipboard.mjs";

function snapshot() { return { protocol: "super-pi-wsb-clipboard-host-v3", sequence: 10, owner: "123", totalAllocationBytes: 8,
	context: { sessionId: 1, system: false, visible: true, station: "WinSta0", desktop: "Default", inputDesktop: "Default", userSidSha256: "d".repeat(64) },
	formats: [{ id: 13, name: null, storageKind: "standard-text", allocationBytes: 8, logicalBytes: 6, storageSha256: "a".repeat(64) }] }; }
test("clipboard snapshot rejects unsupported/incomplete data and detects restored-content sequence changes", () => {
	const base = snapshot(); assert.equal(sameSnapshot(base, snapshot()), true);
	assert.equal(sameSnapshot(base, { ...snapshot(), sequence: 11 }), false);
	assert.equal(sameSnapshot(base, { ...snapshot(), owner: "124" }), false);
	const changed = snapshot(); changed.formats[0].storageSha256 = "b".repeat(64); assert.equal(sameSnapshot(base, changed), false);
	const unknown = snapshot(); unknown.formats[0].id = 2; assert.throws(() => validateSnapshot(unknown));
	const empty = snapshot(); empty.formats[0].logicalBytes = 2; assert.throws(() => validateSnapshot(empty));
	const partial = snapshot(); partial.formats[0].logicalBytes = 9; assert.throws(() => validateSnapshot(partial));
	const duplicate = snapshot(); duplicate.formats.push({ ...duplicate.formats[0] }); assert.throws(() => validateSnapshot(duplicate));
	const a = snapshot(); a.formats.push({ id: 16, name: null, storageKind: "standard-locale", allocationBytes: 4, logicalBytes: 4, storageSha256: "c".repeat(64) }); a.totalAllocationBytes = 12;
	const reordered = structuredClone(a); reordered.formats.reverse(); assert.equal(sameSnapshot(a, reordered), false);
	for (const change of [{ system: true }, { sessionId: 0 }, { station: "Service-0" }, { inputDesktop: "Winlogon" }, { visible: false }]) {
		const wrong = snapshot(); Object.assign(wrong.context, change); assert.throws(() => validateSnapshot(wrong));
	}
	const switched = snapshot(); switched.context.sessionId = 2; assert.equal(sameSnapshot(base, switched), false);
	const anotherUser = snapshot(); anotherUser.context.userSidSha256 = "e".repeat(64); assert.equal(sameSnapshot(base, anotherUser), false);
});
function withRegistered(id = 0xC010, name = "DataObject") {
	const value = snapshot(); value.totalAllocationBytes += 9;
	value.formats.push({ id, name, storageKind: "registered-hglobal-opaque", allocationBytes: 9, logicalBytes: null, storageSha256: "b".repeat(64) });
	return value;
}
test("registered HGLOBAL snapshots require complete bounded storage evidence independent of registered names", () => {
	const base = withRegistered(); assert.equal(sameSnapshot(base, structuredClone(base)), true);
	for (const [id, name] of [[0xC000, "AnotherRegisteredFormat"], [0xFFFF, "任意注册格式"], [49356, "EnterpriseDataProtectionId"], [49171, "Ole Private Data"]]) {
		assert.equal(validateSnapshot(withRegistered(id, name)).formats[1].name, name);
	}
	assert.equal(sameSnapshot(base, withRegistered(0xC011)), false); // Runtime ID, not a constant 49161.
	assert.equal(sameSnapshot(base, withRegistered(0xC010, "Renamed")), false);
	assert.equal(sameSnapshot(base, snapshot()), false);
	const reordered = structuredClone(base); reordered.formats.reverse(); assert.equal(sameSnapshot(base, reordered), false);
	const changed = structuredClone(base); changed.formats[1].storageSha256 = "c".repeat(64); assert.equal(sameSnapshot(base, changed), false);
	const resized = structuredClone(base); resized.formats[1].allocationBytes++; resized.totalAllocationBytes++; assert.equal(sameSnapshot(base, resized), false);
	for (const protocol of ["super-pi-wsb-clipboard-host-v1", "super-pi-wsb-clipboard-host-v2"]) assert.throws(() => validateSnapshot({ ...base, protocol }));
	for (const change of [{ name: "" }, { name: "DataObject\0" }, { name: undefined }, { name: null }, { name: "x".repeat(255) },
		{ id: 0x200 }, { id: 0x300 }, { id: 0xBFFF }, { id: 0x10000 }, { id: 49161.5 },
		{ logicalBytes: 9 }, { logicalBytes: undefined }, { allocationBytes: 0 }, { allocationBytes: 8 * 1024 * 1024 + 1 },
		{ storageKind: "standard-text" }, { storageKind: undefined }, { storageSha256: "" }]) {
		const invalid = withRegistered(); Object.assign(invalid.formats[1], change); assert.throws(() => validateSnapshot(invalid));
	}
	const duplicate = withRegistered(); duplicate.formats.push({ ...duplicate.formats[1] }); duplicate.totalAllocationBytes += 9;
	assert.throws(() => validateSnapshot(duplicate));
	const onlyBinary = withRegistered(); onlyBinary.formats.shift(); onlyBinary.totalAllocationBytes = 9; assert.throws(() => validateSnapshot(onlyBinary));
	const emptyText = withRegistered(); emptyText.formats[0].logicalBytes = 2; assert.throws(() => validateSnapshot(emptyText));
	const disguised = snapshot(); disguised.formats[0].name = "DataObject"; assert.throws(() => validateSnapshot(disguised));
	const complete = withRegistered(49161);
	for (const id of [1, 7, 16]) complete.formats.push({ id, name: null, storageKind: id === 16 ? "standard-locale" : "standard-text", allocationBytes: 4, logicalBytes: 4, storageSha256: "d".repeat(64) });
	for (const [id, name] of [[49356, "EnterpriseDataProtectionId"], [49171, "Ole Private Data"]]) complete.formats.push({ ...base.formats[1], id, name });
	complete.totalAllocationBytes += 30; assert.equal(parseHostSnapshot(JSON.stringify(complete) + "\r\n").formats.length, 7);
	const missing = structuredClone(complete); missing.formats.pop(); assert.throws(() => validateSnapshot(missing)); // Total still describes the full set.
	const removed = structuredClone(missing); removed.totalAllocationBytes -= 9; assert.equal(sameSnapshot(complete, removed), false);
	const cap = snapshot();
	for (let index = 0; index < 63; index++) { cap.formats.push({ ...base.formats[1], id: 0xC000 + index, name: "F" + index }); cap.totalAllocationBytes += 9; }
	assert.equal(parseHostSnapshot(JSON.stringify(cap) + "\r\n").formats.length, 64);
	const countOverflow = structuredClone(cap); countOverflow.formats.push({ ...base.formats[1], id: 0xFFFF }); countOverflow.totalAllocationBytes += 9;
	assert.throws(() => validateSnapshot(countOverflow));
	// Use complete, individually valid names whose UTF-8 receipt exceeds the existing 16 KiB capture budget.
	for (const item of cap.formats) if (item.name !== null) item.name = "界".repeat(249) + item.id;
	assert.equal(validateSnapshot(cap).formats.length, 64);
	assert.throws(() => parseHostSnapshot(JSON.stringify(cap)), /output bound/);
	assert.throws(() => parseHostSnapshot(JSON.stringify(complete).slice(0, -1)));
	const overTotal = structuredClone(complete); overTotal.totalAllocationBytes = 0;
	for (const item of overTotal.formats) { item.allocationBytes = 8 * 1024 * 1024; overTotal.totalAllocationBytes += item.allocationBytes; }
	assert.throws(() => validateSnapshot(overTotal));
});
test("registered HGLOBAL native storage, output and unlock checks use only process-owned memory", { skip: process.platform !== "win32", ...PINNED_SANDBOX_TEST_OPTIONS }, t => {
	const repository = fileURLToPath(new URL("../", import.meta.url));
	const compiler = "C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe";
	assert.equal(createHash("sha256").update(fs.readFileSync(compiler)).digest("hex"), "eca02e6b15cde93009a59a3d129d5a77fb5008f2e1cf62cf573b6737c747ecc3");
	const parent = fs.realpathSync(path.join(repository, ".artifacts"));
	const root = path.join(parent, "wsb-clipboard-registered-check-" + randomUUID());
	fs.mkdirSync(root); const identity = fs.lstatSync(root, { bigint: true });
	const executable = path.join(root, "check.exe"); let binaryIdentity;
	try {
		const compiled = spawnSync(compiler, ["/nologo", "/target:exe", "/platform:x64", "/reference:System.Web.Extensions.dll", "/main:ClipboardHostChecks", "/out:" + executable,
			path.join(repository, "scripts", "acceptance", "windows-sandbox-clipboard-host.cs"), path.join(repository, "tests", "fixtures", "windows-sandbox-clipboard-host-check.cs")],
			{ cwd: root, windowsHide: true, encoding: "utf8", timeout: 30000, maxBuffer: 16 * 1024 });
		if (fs.existsSync(executable)) binaryIdentity = fs.lstatSync(executable, { bigint: true });
		assert.ifError(compiled.error); assert.equal(compiled.status, 0, compiled.stdout + compiled.stderr);
		const checked = spawnSync(executable, [], { cwd: root, windowsHide: true, encoding: "utf8", timeout: 10000, maxBuffer: 16 * 1024 });
		assert.ifError(checked.error); assert.equal(checked.status, 0, checked.stdout + checked.stderr);
		const receipt = JSON.parse(checked.stdout); assert.equal(receipt.passed, true);
		t.diagnostic(JSON.stringify({ root, compilerPid: compiled.pid, checkPid: checked.pid, ...receipt }));
	} finally {
		const actual = fs.lstatSync(root, { bigint: true });
		assert.ok(actual.isDirectory() && !actual.isSymbolicLink() && actual.dev === identity.dev && actual.ino === identity.ino);
		assert.equal(fs.realpathSync(root), root); assert.equal(path.dirname(root), parent);
		if (binaryIdentity) {
			const actualBinary = fs.lstatSync(executable, { bigint: true });
			assert.ok(actualBinary.isFile() && !actualBinary.isSymbolicLink() && actualBinary.dev === binaryIdentity.dev && actualBinary.ino === binaryIdentity.ino);
			fs.unlinkSync(executable);
		}
		fs.rmdirSync(root); assert.equal(fs.existsSync(root), false);
		t.diagnostic("Owned compile/check artifact removed; no clipboard entry point executed.");
	}
});
test("an unresolved host helper cannot be overwritten by cleanup observation or authorize deletion", async () => {
	let launches = 0, killed = 0;
	const pending = { pid: 42, child: { kill() { killed++; } }, async wait() { return "timeout"; } };
	const runner = new OwnedHelperRunner("fixture", () => {}, () => { launches++; return pending; });
	await assert.rejects(runner.run("host-observer", []), /exit unconfirmed/);
	assert.equal(runner.active, pending); assert.equal(runner.calls[0].pid, 42); assert.equal(runner.calls[0].outcome, "timeout\/exit-unconfirmed");
	await assert.rejects(runner.run("host-observer", ["window"]), /unresolved/);
	assert.equal(launches, 1); assert.equal(killed, 1); assert.equal(runner.active, pending);
});
test("guest evidence must identify the real interactive context, never just an ExistingLogin label", () => {
	const taskId = "11111111-2222-3333-4444-555555555555";
	const ready = { protocol: "super-pi-wsb-clipboard-guest-v1", taskId, phase: "ready",
		context: { sessionId: 1, system: false, visible: true, station: "WinSta0", desktop: "Default", user: "guest", sid: "S-1-5-21-1" } };
	assert.equal(guestContext(ready, taskId, "ready"), ready);
	assert.throws(() => guestContext({ ...ready, context: undefined }, taskId, "ready"));
	for (const change of [{ system: true }, { sessionId: 0 }, { station: "Service-0" }, { visible: false }]) assert.throws(() => guestContext({ ...ready, context: { ...ready.context, ...change } }, taskId, "ready"));
});
class Call extends EventEmitter {
	pid = 1;
	wait = CapturedProcess.prototype.wait;
	constructor(result) { super(); this.result = result; }
	finish() { this.result = good(); this.emit("settled"); }
}
function good(stdout = "") { return { exitCode: 0, signal: null, launchError: null, truncated: false, stdout, stderr: "" }; }
test("interactive connection remains owned through guest cancellation and is released only after VM stop", async () => {
	let id, running = false; const connection = new Call(), execution = new Call(), calls = [];
	const cli = { launch(args) {
		calls.push(args[0]);
		if (args[0] === "start") { id = args[2]; running = true; return new Call(good()); }
		if (args[0] === "list") return new Call(good(JSON.stringify({ WindowsSandboxEnvironments: running ? [{ Id: id }] : [] })));
		if (args[0] === "connect") { assert.equal(args[2], id); return connection; }
		if (args[0] === "exec") { assert.equal(args[2], id); assert.equal(args[8], "ExistingLogin"); assert.equal(args[4], '"C:\\SuperPiClipboard\\Input\\probe.exe"'); return execution; }
		if (args[0] === "stop") { assert.equal(args[2], id); running = false; connection.finish(); execution.finish(); return new Call(good()); }
		throw new Error("Unexpected operation");
	} };
	const owner = new SandboxLifecycle({ cli, config: "test", journal() {}, limits: { callMs: 10, startMs: 10, settleMs: 10, exitMs: 10, pollMs: 1 } });
	await owner.start(); owner.connectClipboardSession(); assert.ok(owner.connection);
	const abort = new AbortController(), work = owner.executeClipboardProbe(abort.signal); abort.abort();
	await assert.rejects(work, /cancelled/); assert.ok(owner.execution); assert.ok(owner.connection);
	assert.equal(await owner.cleanup(), true); assert.equal(owner.connection, undefined); assert.equal(owner.execution, undefined);
	assert.equal(calls.filter(kind => kind === "stop").length, 1); assert.equal(connection.listenerCount("settled"), 0);
});
