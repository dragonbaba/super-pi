import { PINNED_SANDBOX_TEST_OPTIONS } from "./helpers/windows-sandbox-prerequisites.mjs";
import { POWERSHELL7_PATH, POWERSHELL7_PREFIX, verifyPowerShell7 } from "../scripts/acceptance/windows-sandbox-volume.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parseStartupReceipt, StartupCapture, StartupOutput, StartupLifetime, cleanupAllowed, encodeStartupEvidence, encodeStartupCleanup, startupJournal,
 attachStartupEvidence, validateCleanupSnapshot, STARTUP_LIMITS } from "../scripts/acceptance/windows-sandbox-volume-startup.mjs";
const taskId = "11111111-2222-3333-4444-555555555555";
const success = () => ({ protocol: "super-pi-volume-startup-v1", taskId, ok: true, step: "complete", completed: "native-constructor", error: null });
const result = value => { const bytes = Buffer.from(JSON.stringify(value)); return { stdoutSeen: bytes.length, stdoutRawBase64: bytes.toString("base64"), exitCode: 0, signal: null }; };
function fixture() {
 const child = new EventEmitter(); child.pid = 7; child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
 child.kill = () => assert.fail("Never terminate the diagnostic manager");
 const capture = new StartupCapture(child);
 return { child, capture, listeners: () => child.stdout.listenerCount("data") + child.stderr.listenerCount("data")
  + child.listenerCount("error") + child.listenerCount("close") };
}
test("startup receipt and output preserve bounds and responsibility across callback, stream and footer failures", async () => {
 assert.deepEqual(parseStartupReceipt(result(success()), taskId), success());
 const failure = { ...success(), ok: false, step: "native-constructor", completed: "output-encoding",
  error: { exception: "System.ArgumentException", hresult: -2147024809, nativeCode: null, message: "bounded", messageTruncated: false } };
 assert.deepEqual(parseStartupReceipt({ ...result(failure), exitCode: 1 }, taskId), failure);
 for (const mutate of [r => r.taskId = "other", r => r.extra = true, r => r.completed = "none", r => r.ok = "true", r => r.error = {}]) {
  const value = success(); mutate(value); assert.throws(() => parseStartupReceipt(result(value), taskId));
 }
 for (const raw of [{ stdoutSeen: 0 }, { stdoutSeen: 2049 }, { stdoutSeen: 1, stdoutRawBase64: "/w==" }]) assert.throws(() => parseStartupReceipt(raw, taskId));
 failure.error.message = "m".repeat(257); assert.throws(() => parseStartupReceipt(result(failure), taskId));
 assert.throws(() => encodeStartupEvidence({ large: "x".repeat(8192) }));
 const text = encodeStartupEvidence({ raw: "x".repeat(4000) }); assert.ok(Buffer.byteLength(text) + 512 <= STARTUP_LIMITS.output);
 assert.ok(Buffer.byteLength(encodeStartupCleanup({ artifactsRemoved: false, retained: true, startupSucceeded: false, cleanupError: "错".repeat(256) })) <= 512);
 for (const mode of ["callback", "event", "footer"]) {
  const stream = new EventEmitter(), report = { artifactsRemoved: false, evidenceEmitted: false };
  let saved = 0, writes = 0, lateCallback;
  const output = new StartupOutput(stream, report, () => { saved++; });
  stream.write = (_text, done) => {
   writes++;
   if (mode === "footer" && writes === 1) { done(); return; }
   const error = Error("broken output");
   if (mode === "event") { lateCallback = done; stream.emit("error", error); } else done(error);
   stream.emit("error", error); // A later stream error must remain observed and idempotent.
  };
  if (mode === "footer") { await output.write("evidence\n"); report.evidenceEmitted = true; report.artifactsRemoved = true; }
  await assert.rejects(output.write("record\n"), /broken output/);
  assert.equal(report.outputFailed, true); assert.equal(report.artifactsRemoved, mode === "footer");
  assert.equal(report.retained, mode !== "footer"); assert.equal(saved, 1);
  assert.equal(cleanupAllowed(report, {}, { result: {} }), false); assert.throws(() => output.write("retry"));
  if (mode === "event") {
   const bus = new EventEmitter(), lifetime = new StartupLifetime(bus, report, new AbortController(), () => {}, output);
   lifetime.finish(); await new Promise(resolve => setImmediate(resolve));
   assert.equal(lifetime.released, false); assert.ok(output.pending); assert.equal(stream.listenerCount("error"), 1);
   stream.emit("error", Error("still observed")); lateCallback(Error("write drained"));
   await new Promise(resolve => setImmediate(resolve)); assert.equal(lifetime.released, true); assert.equal(output.pending, undefined);
  }
  output.dispose(); assert.equal(stream.listenerCount("error"), 0);
 }
});
test("startup capture retains bounded raw evidence, physical-close time and releases buffers/listeners", async () => {
 const { child, capture, listeners } = fixture(); const observed = [];
 capture.once("settled", () => observed.push({ listeners: listeners(), out: capture.out, err: capture.err, result: capture.result }));
 const waited = capture.wait(1000);
 child.stdout.emit("data", Buffer.alloc(2050, 0x41)); child.stderr.emit("data", Buffer.alloc(1500, 0xff));
 child.stderr.emit("data", Buffer.from([0x81, 0])); child.emit("close", 23, null);
 assert.equal(await waited, "settled"); assert.equal(observed.length, 1); assert.equal(observed[0].listeners, 0);
 assert.equal(observed[0].out, undefined); assert.equal(observed[0].err, undefined); assert.equal(capture.child, undefined);
 assert.equal(capture.result.exitCode, 23); assert.equal(capture.result.signal, null); assert.ok(capture.result.closedUtc);
 assert.equal(capture.result.stdoutSeen, 2050); assert.equal(capture.result.stdoutCaptured, 2048); assert.equal(capture.result.stdoutTruncated, true);
 assert.deepEqual(capture.result.stderr, { encoding: "uninterpreted", seenBytes: 1502, capturedBytes: 1024,
  rawBase64: Buffer.alloc(1024, 0xff).toString("base64"), truncated: true });
 assert.equal(capture.result.stderr.rawBase64.length, 1368); assert.equal(capture.listenerCount("settled"), 0);
});
test("startup deadlines, cancellation and sticky journal failure retain responsibility after late physical close", async () => {
 for (const mode of ["timeout", "cancelled", "journal"]) {
  const { child, capture, listeners } = fixture(), controller = new AbortController();
  const report = { taskId, rootIdentity: { dev: "1", ino: "2" }, retained: false, cancelled: false, evidenceEmitted: true, journalFailed: false };
  let writes = 0;
  const files = {}, save = startupJournal({ journal() { writes++; if (mode === "journal") throw Error("injected journal failure"); } }, report,
   files, () => report.rootIdentity, () => ({ sha256: "synthetic" }));
  attachStartupEvidence(capture, report, save);
  if (mode === "cancelled") { report.cancelled = true; controller.abort(); }
  if (mode === "journal") assert.throws(save); else {
   const outcome = await capture.wait(1, controller.signal); assert.equal(outcome, mode); report.retained = true;
  }
  assert.equal(cleanupAllowed(report, {}, capture), false); assert.equal(listeners(), 4);
  child.stdout.emit("data", Buffer.from(JSON.stringify(success()))); child.emit("close", 0, null);
  assert.equal(report.startupSucceeded, true); assert.equal(report.startupCapture.buffersReleased, true);
  assert.equal(listeners(), 0); assert.equal(capture.listenerCount("settled"), 0); assert.equal(cleanupAllowed(report, {}, capture), false);
  if (mode === "journal") { assert.throws(save); assert.equal(writes, 1); assert.equal(report.journalFailed, true); }
  else assert.equal(writes, 1);
 }
 const report = { rootIdentity: {}, journalFailed: false, retained: false, large: "x".repeat(8192) };
 let writes = 0; const save = startupJournal({ journal() { writes++; } }, report, {}, () => ({}), () => ({}));
 assert.throws(save); assert.equal(writes, 0); assert.equal(report.journalFailed, true);
 const { child, capture, listeners } = fixture(), bus = new EventEmitter(), stream = new EventEmitter();
 const late = { taskId, artifactsRemoved: false, cancelled: false, retained: true, evidenceEmitted: true }, controller = new AbortController();
 let saves = 0; const persist = () => { saves++; };
 const output = new StartupOutput(stream, late, persist), lifetime = new StartupLifetime(bus, late, controller, persist, output);
 const compiler = new EventEmitter(); // Also retains a compiler whose physical close is not confirmed.
 attachStartupEvidence(capture, late, persist); lifetime.track(compiler); lifetime.track(capture);
 assert.equal(await capture.wait(1), "timeout"); lifetime.finish();
 bus.emit("SIGINT"); bus.emit("SIGINT"); bus.emit("SIGTERM");
 assert.equal(saves, 1); assert.equal(controller.signal.aborted, true); assert.equal(bus.listenerCount("SIGINT"), 1);
 child.stdout.emit("data", Buffer.from(JSON.stringify(success()))); child.emit("close", 0, null);
 await new Promise(resolve => setImmediate(resolve));
 assert.equal(saves, 2); assert.equal(late.startupCapture.buffersReleased, true); assert.equal(listeners(), 0);
 assert.equal(lifetime.released, false); assert.equal(bus.listenerCount("SIGTERM"), 1); assert.equal(stream.listenerCount("error"), 1);
 compiler.result = { exitCode: 0 }; compiler.emit("settled"); await new Promise(resolve => setImmediate(resolve));
 assert.equal(lifetime.released, true); assert.equal(lifetime.calls.length, 0);
 assert.equal(bus.listenerCount("SIGINT"), 0); assert.equal(bus.listenerCount("SIGTERM"), 0); assert.equal(stream.listenerCount("error"), 0);
 assert.equal(cleanupAllowed(late, {}, capture), false);
 const closedBus = new EventEmitter(), closedStream = new EventEmitter(), closedReport = { artifactsRemoved: true, retained: false, cancelled: false };
 const closedController = new AbortController(); let closedSaves = 0;
 const closedOutput = new StartupOutput(closedStream, closedReport, () => { closedSaves++; });
 const closedLifetime = new StartupLifetime(closedBus, closedReport, closedController, () => { closedSaves++; }, closedOutput);
 let footerDone; closedStream.write = (_text, done) => { footerDone = done; };
 const footerWait = closedOutput.write("cleanup-footer\n");
 closedLifetime.finish(); closedBus.emit("SIGINT"); closedBus.emit("SIGTERM");
 assert.equal(closedSaves, 0); assert.equal(closedController.signal.aborted, false);
 assert.equal(closedReport.cancelled, false); assert.equal(closedReport.retained, false); assert.equal(closedReport.artifactsRemoved, true);
 assert.equal(closedLifetime.released, false); assert.ok(closedOutput.pending); footerDone(); await footerWait;
 await new Promise(resolve => setImmediate(resolve)); assert.equal(closedLifetime.released, true);
 assert.equal(closedBus.listenerCount("SIGINT"), 0); assert.equal(closedStream.listenerCount("error"), 0);
});
test("startup cleanup requires emitted evidence, closed ownership and exact root/file identities", () => {
 const report = { evidenceEmitted: true }, capture = { result: {} };
 assert.equal(cleanupAllowed(report, {}, capture), true);
 for (const key of ["cancelled", "journalFailed", "outputFailed", "retained"]) assert.equal(cleanupAllowed({ ...report, [key]: true }, {}, capture), false);
 assert.equal(cleanupAllowed({}, {}, capture), false); assert.equal(cleanupAllowed(report, { active: {} }, capture), false);
 assert.equal(cleanupAllowed(report, {}, { result: null }), false);
 const root = { dev: "1", ino: "2" }, files = { "lifecycle.json": { ino: "3", sha256: "a" }, "volume-native.dll": { ino: "4", sha256: "b" } };
 validateCleanupSnapshot(root, { ...root }, files, structuredClone(files));
 assert.throws(() => validateCleanupSnapshot(root, { ...root, ino: "9" }, files, files));
 assert.throws(() => validateCleanupSnapshot(root, root, files, { ...files, "task.vhd": {} }));
 assert.throws(() => validateCleanupSnapshot(root, root, files, { "lifecycle.json": files["lifecycle.json"] }));
 assert.throws(() => validateCleanupSnapshot(root, root, files, { ...files, "volume-native.dll": { ino: "9", sha256: "b" } }));
});
test("startup PowerShell 7 parse-only guard never executes helper body or native constructor", { timeout: 15000, ...PINNED_SANDBOX_TEST_OPTIONS }, t => {
 const script = fileURLToPath(new URL("./fixtures/windows-sandbox-volume-startup-parse.ps1", import.meta.url));
 const helper = fileURLToPath(new URL("../scripts/acceptance/windows-sandbox-volume-helper.ps1", import.meta.url));
 verifyPowerShell7();
 const call = spawnSync(POWERSHELL7_PATH, [...POWERSHELL7_PREFIX, "-File", script, "-Helper", helper],
  { windowsHide: true, shell: false, encoding: "utf8", timeout: 10000, maxBuffer: 8192 });
 assert.equal(call.error, undefined); assert.equal(call.status, 0, call.stderr); assert.equal(call.signal, null);
 assert.deepEqual(JSON.parse(call.stdout.trim()), { parsed: true, startupExits: 2, helperExecuted: false, storageCalls: 0 });
 t.diagnostic(JSON.stringify({ parseOnlyPid: call.pid, exitCode: call.status, signal: call.signal, helperExecuted: false, storageCalls: 0 }));
});
