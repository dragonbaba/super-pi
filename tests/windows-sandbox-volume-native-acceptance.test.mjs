import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { TaskVolumeOwner, VolumeProtocol, VOLUME_LIMITS, POWERSHELL7_PATH, POWERSHELL7_PREFIX, verifyPowerShell7 } from "../scripts/acceptance/windows-sandbox-volume.mjs";
import { exerciseNativeOwner, validateNativeProbe, nativeJournal, finishNativeAcceptance, summarizeHelperCalls, summarizeOperationError, PREFLIGHT } from "../scripts/acceptance/windows-sandbox-volume-native-acceptance.mjs";
import { OwnedHelperRunner } from "../scripts/acceptance/windows-sandbox-clipboard.mjs";
const taskId = "11111111-2222-3333-4444-555555555555";
const volumePath = "\\\\?\\Volume{aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee}\\";
const exchangeId = "AABBCCDD:0000000000000002";
function diagnosticFixture() {
 const child = new EventEmitter(); child.pid = 7;
 child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.stdin = new EventEmitter();
 const state = { requests: [], records: [], publicationListeners: [], revokes: 0, cancels: 0 };
 child.stdin.write = (text, done) => { state.requests.push(JSON.parse(text)); done(); };
 child.kill = () => assert.fail("The volume manager must never be killed");
 const driver = new VolumeProtocol(child, taskId);
 const listenerCount = () => child.stdout.listenerCount("data") + child.stdout.listenerCount("end") + child.stderr.listenerCount("data")
  + child.stdin.listenerCount("error") + child.listenerCount("error") + child.listenerCount("close");
 const owner = new TaskVolumeOwner({ driver, taskId,
  readRuntime: () => ({ state: "not-started", neverDispatched: true, callsClosed: true }),
  journal(record) { state.records.push(record); state.publicationListeners.push(listenerCount()); },
  revokeCandidates() { state.revokes++; }, cancelExecution() { state.cancels++; } });
 return { child, driver, owner, state, listenerCount };
}
test("volume diagnostics preserve raw stderr and publish physical-close state after releasing pending listeners", async () => {
 const { child, driver, owner, state, listenerCount } = diagnosticFixture();
 const pending = assert.rejects(driver.command("prepare", () => {}), /Unexpected helper stderr/);
 child.stderr.emit("data", Buffer.from([0xff, 0, 0x81])); child.stderr.emit("data", Buffer.from([0xfe, 10]));
 child.stdout.emit("end"); child.stdin.emit("error", Error("late stdin failure")); child.emit("error", Error("late transport failure"));
 assert.equal(state.records.length, 1); assert.equal(driver.pending, true); assert.equal(listenerCount(), 6);
 assert.equal(state.records[0].helperClosed, false); assert.equal(state.records[0].transport.buffersReleased, false);
 const closeWait = driver.waitClosed(); child.emit("close", 23, null); await pending;
 assert.equal(await closeWait, false); assert.equal(state.records.length, 2);
 const final = state.records.at(-1); assert.equal(final.helperClosed, true); assert.equal(final.pending, false);
 assert.deepEqual(state.publicationListeners, [6, 0]);
 assert.deepEqual(final.transport, { exitCode: 23, signal: null, buffersReleased: true,
  stderr: { encoding: "uninterpreted", rawBase64: Buffer.from([0xff, 0, 0x81, 0xfe, 10]).toString("base64"),
   seenBytes: 5, capturedBytes: 5, truncated: false } });
 assert.equal(state.revokes, 1); assert.equal(state.cancels, 1); assert.equal(listenerCount(), 0);
 await assert.rejects(owner.release()); assert.equal(owner.shareAdmission, false); assert.equal(owner.state, "blocked");
 assert.deepEqual(state.requests.map(request => request.command), ["prepare"]);
});
test("volume diagnostics cap raw bytes and retain signal evidence without per-chunk publications or live buffers", async () => {
 const { child, driver, state } = diagnosticFixture();
 const pending = assert.rejects(driver.command("prepare", () => {}), /Unexpected helper stderr/);
 const first = Buffer.alloc(2048, 0x80), second = Buffer.alloc(17, 0xff);
 child.stderr.emit("data", first); child.stderr.emit("data", second);
 assert.equal(state.records.length, 1); child.emit("close", null, "SIGTERM"); await pending;
 const final = state.records.at(-1), evidence = final.transport;
 assert.equal(evidence.exitCode, null); assert.equal(evidence.signal, "SIGTERM"); assert.equal(evidence.buffersReleased, true);
 assert.equal(evidence.stderr.seenBytes, 2065); assert.equal(evidence.stderr.capturedBytes, 1024);
 assert.equal(evidence.stderr.truncated, true); assert.equal(evidence.stderr.rawBase64.length, 1368);
 assert.deepEqual(Buffer.from(evidence.stderr.rawBase64, "base64"), first.subarray(0, VOLUME_LIMITS.stderrBytes));
 first.fill(0); second.fill(0); assert.deepEqual(driver.diagnostics, evidence);
 assert.equal(driver.pending, false); assert.equal(state.records.length, 2); assert.equal(state.revokes, 1); assert.equal(state.cancels, 1);
 assert.deepEqual(state.publicationListeners, [6, 0]);
 assert.ok(Buffer.byteLength(JSON.stringify(final, null, 2)) < VOLUME_LIMITS.journalBytes);
 const report = { protocol: "synthetic", taskId, volume: final, released: false, receiptUnknownHandles: [], sequencePassed: false,
  artifactsRemoved: false, journalFailed: false, outputBoundFailed: false, cleanupError: "retained", error: "stderr" };
 const text = finishNativeAcceptance({ remove() { assert.fail("Unreleased owner must be retained"); } }, report, {}, driver, () => {});
 const result = JSON.parse(text); assert.equal(result.passed, false); assert.ok(result.reportedUtc); assert.equal(Object.hasOwn(result, "finishedUtc"), false);
 assert.ok(Buffer.byteLength(text) + 1 < 8192); assert.equal(result.volume.transport.stderr.rawBase64, evidence.stderr.rawBase64);
});
function receipt() { return { protocol: "super-pi-volume-probe-v1", taskId, volumePath, exchangeId,
 fileId: "AABBCCDD:0000000000000003", bytes: 32, matched: true, opened: 2, closed: 2, closeUnknown: false }; }
function fixture(change) {
 const state = { calls: [], revokes: 0, cancels: 0, closed: false, runtime: { state: "not-started", neverDispatched: true, callsClosed: true } };
 const driver = { pid: 7, physicallyClosed: false, pending: false, setUnsafeHandler(handler) { this.unsafe = handler; },
  async command(command, observe) {
   state.calls.push(command);
   const value = { phase: command === "release" || command === "exit" ? "released" : "prepared-not-share-admitted", error: null,
    imageCreated: true, imageId: "AABBCCDD:0000000000000001", diskId: taskId, physicalPath: "\\\\.\\PhysicalDrive77", volumePath, exchangeId,
    closeUnknown: false, managementClosed: command === "release" || command === "exit", detached: command === "release" || command === "exit" };
   change?.(command, value); observe(value); return value;
  }, async waitClosed() { this.physicallyClosed = true; state.closed = true; return true; } };
 const owner = new TaskVolumeOwner({ driver, taskId, readRuntime: () => state.runtime, journal() {},
  revokeCandidates() { state.revokes++; }, cancelExecution() { state.cancels++; } });
 return { owner, state, driver };
}
test("native-only sequence releases disk after the single fixed probe and validates actual association", async () => {
 const { owner, state } = fixture(), record = { taskId };
 assert.equal(await exerciseNativeOwner(owner, new AbortController().signal, receipt, record), true);
 assert.deepEqual(state.calls, ["prepare", "verify", "probe", "release", "exit"]); assert.equal(state.closed, true);
 assert.equal(owner.shareAdmission, false); await assert.rejects(owner.probeOnce());
 for (const change of [r => r.taskId = "other", r => r.volumePath = "C:\\fallback", r => r.closed = 1, r => r.bytes = 4096, r => r.extra = true]) {
  const value = receipt(); change(value); assert.throws(() => validateNativeProbe(value, taskId, { volumePath, exchangeId }));
 }
});
test("native probe refuses active runtime and retry; uncertain identity or close retain ownership", async () => {
 const first = fixture(); await first.owner.prepare(); first.state.runtime = { state: "active", callsClosed: false };
 await assert.rejects(first.owner.probeOnce()); assert.deepEqual(first.state.calls, ["prepare"]);
 first.state.runtime = { state: "not-started", neverDispatched: true, callsClosed: true };
 await first.owner.probeOnce(); await assert.rejects(first.owner.probeOnce());
 for (const fault of ["identity", "native-identity", "close", "write", "receipt"]) {
  const { owner, state } = fixture((command, value) => {
   if (command !== "probe") return;
   if (fault === "identity") value.exchangeId = "AABBCCDD:0000000000000009";
   else if (fault === "native-identity") { value.error = "storage-identity-failed"; value.phase = "blocked"; }
   else if (fault === "close") value.closeUnknown = true;
   else if (fault === "write") { value.error = "storage-operation-failed"; value.phase = "blocked"; }
  });
  const record = { taskId }; assert.equal(await exerciseNativeOwner(owner, new AbortController().signal, () => { throw Error("must not read"); }, record), false);
  assert.equal(state.calls.includes("release"), fault === "write");
  assert.equal(state.revokes, fault === "write" ? 0 : 1); assert.equal(state.cancels, state.revokes);
 }
});
test("cancellation after preparation skips the probe and still closes the owned disk", async () => {
 const controller = new AbortController(), { owner, state } = fixture(command => { if (command === "prepare") controller.abort(); });
 const record = { taskId }; assert.equal(await exerciseNativeOwner(owner, controller.signal, receipt, record), false);
 assert.deepEqual(state.calls, ["prepare", "release", "exit"]); assert.equal(record.cancelled, true); assert.equal(state.closed, true);
});
test("outer journal failure and final output budget retain ownership without recursive saving or oversized output", async () => {
 for (const fault of ["none", "journal", "journal-first", "journal-held-helper", "output", "private-close", "helper-pending"]) {
  const record = { protocol: "test", taskId, artifactRoot: "D:\\test-owned", released: true, receiptUnknownHandles: [],
   artifactsRemoved: false, sequencePassed: true, passed: false, journalFailed: false, outputBoundFailed: false, cleanupError: null, error: null };
  let removes = 0, writes = 0, unsafe = 0;
  const journalFailure = fault.startsWith("journal");
  const resource = { journal() { writes++; if (journalFailure) throw Error("injected"); }, remove() { removes++; } };
  const save = nativeJournal(resource, record, () => { unsafe++; assert.throws(save); });
  const driver = { pid: 7, physicallyClosed: fault !== "helper-pending", pending: fault === "helper-pending" };
  let helpers = {};
  if (fault === "journal-first") assert.throws(save);
  if (fault === "journal-held-helper") {
   const held = { pid: 9 }; helpers = new OwnedHelperRunner("synthetic", save, () => held);
   await assert.rejects(helpers.run("fixed-compiler", [], 10)); assert.equal(helpers.active, held);
  }
  if (fault === "output") record.large = "x".repeat(8192);
  if (fault === "private-close") record.receiptUnknownHandles.push(9);
  const text = finishNativeAcceptance(resource, record, helpers, driver, save), output = JSON.parse(text);
  assert.ok(Buffer.byteLength(text) + 1 <= 7680); assert.equal(removes, 0);
  assert.equal(output.passed, false); assert.equal(unsafe, journalFailure ? 1 : 0);
  if (journalFailure) { assert.throws(save); assert.equal(writes, 1); }
 }
 const calls = summarizeHelperCalls([{ executable: "fixed", pid: 1, outcome: "settled", killRequested: false,
  result: { exitCode: 1, signal: null, launchError: null, truncated: false, stdoutSeen: 16384, stderrSeen: 16384,
   stdout: "o".repeat(16384), stderr: "e".repeat(16384) } }]);
 assert.equal(calls[0].result.stdoutPreview.length, 256); assert.equal(calls[0].result.stderrPreview.length, 256);
 assert.equal(calls[0].result.stdoutSeen, 16384); assert.equal(calls[0].result.previewTruncated, true);
 const errors = ["prepare", "verify", "probe", "release", "exit"].map(command => summarizeOperationError({ command,
  classification: "storage-operation-failed", phase: "blocked", exception: "TestException", message: "m".repeat(512), hresult: -1, nativeCode: 5 }, command));
 assert.ok(errors.every(error => error.message.length === 256 && error.messageTruncated));
 assert.ok(Buffer.byteLength(JSON.stringify({ helperCalls: calls, operationErrors: errors })) < 4096);
});
test("new native probe compiles; actual helper probe functions run only with storage substitutes", { timeout: 30000 }, t => {
 const parent = fs.realpathSync(os.tmpdir()), root = fs.mkdtempSync(path.join(parent, "super-pi-volume-native-check-"));
 const identity = fs.lstatSync(root, { bigint: true });
 t.after(() => {
  const actual = fs.lstatSync(root, { bigint: true }); assert.equal(actual.isSymbolicLink(), false);
  assert.equal(actual.dev, identity.dev); assert.equal(actual.ino, identity.ino);
  assert.equal(path.dirname(fs.realpathSync(root)), parent); assert.equal(path.resolve(root), root);
  fs.rmSync(root, { recursive: true }); assert.equal(fs.existsSync(root), false);
 });
 const assembly = path.join(root, "volume-native.dll"), preflight = path.join(root, "preflight.ps1");
 fs.writeFileSync(preflight, PREFLIGHT, { flag: "wx" });
 const source = fileURLToPath(new URL("../scripts/acceptance/windows-sandbox-volume-native.cs", import.meta.url));
 const helper = fileURLToPath(new URL("../scripts/acceptance/windows-sandbox-volume-helper.ps1", import.meta.url));
 const fixturePath = fileURLToPath(new URL("./fixtures/windows-sandbox-volume-probe-check.ps1", import.meta.url));
 const compiled = spawnSync("C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe",
  ["/nologo", "/target:library", "/platform:x64", "/out:" + assembly, source], { windowsHide: true, encoding: "utf8", timeout: 15000, maxBuffer: 16384 });
 assert.equal(compiled.error, undefined); assert.equal(compiled.status, 0, compiled.stdout + compiled.stderr);
 assert.ok(fs.statSync(assembly).size <= VOLUME_LIMITS.nativeBytes);
 verifyPowerShell7();
 const checked = spawnSync(POWERSHELL7_PATH,
  [...POWERSHELL7_PREFIX, "-File", fixturePath, "-HelperPath", helper, "-NativeAssembly", assembly, "-FixtureRoot", root, "-PreflightPath", preflight],
  { windowsHide: true, encoding: "utf8", timeout: 15000, maxBuffer: 16384 });
 assert.equal(checked.error, undefined); assert.equal(checked.status, 0, checked.stdout + checked.stderr);
 const result = JSON.parse(checked.stdout.replace(/^\uFEFF/, "")); assert.equal(result.cases, 7); assert.equal(result.realStorageOperations, 0);
 assert.equal(result.helperParsed, true); assert.equal(result.preflightParsed, true); validateNativeProbe(result.probe, taskId, { volumePath, exchangeId });
 t.diagnostic(JSON.stringify({ cases: result.cases, realStorageOperations: result.realStorageOperations }));
});
