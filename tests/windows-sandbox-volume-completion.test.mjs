import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { VolumeProtocol } from "../scripts/acceptance/windows-sandbox-volume.mjs";
import { NativeOutput, NativeLifetime, completeNativeAcceptance, nativeCleanupAllowed, encodeNativeCleanup } from "../scripts/acceptance/windows-sandbox-volume-native-acceptance.mjs";
const taskId = "11111111-2222-3333-4444-555555555555";
const tick = () => new Promise(resolve => setImmediate(resolve));
function fixture() {
 const bus = new EventEmitter(), stream = new EventEmitter();
 const report = { protocol: "synthetic-native", taskId, artifactRoot: "synthetic-only", released: true, receiptUnknownHandles: [],
  artifactsRemoved: false, sequencePassed: true, passed: false, journalFailed: false, outputBoundFailed: false, outputFailed: false,
  evidenceEmitted: false, retained: false, cancelled: false, cleanupError: null, error: null, physicalCalls: [] };
 const state = { saves: 0, removes: 0, cancels: 0, afterRemovalSaves: 0, writes: [], savedPhysical: [] };
 const save = () => { state.saves++; state.savedPhysical = structuredClone(report.physicalCalls); if (report.artifactsRemoved) state.afterRemovalSaves++; };
 const output = new NativeOutput(stream, report, () => { if (!report.artifactsRemoved) save(); });
 const lifetime = new NativeLifetime(bus, report, save, output, () => { state.cancels++; });
 const resource = { remove() { assert.equal(report.evidenceEmitted, true); assert.equal(output.pending, undefined); state.removes++; } };
 stream.write = (text, done) => { state.writes.push({ text, done }); return false; };
 return { bus, stream, report, state, save, output, lifetime, resource };
}

test("native completion delivers evidence before removal and releases observers only after the footer callback", async t => {
 const f = fixture();
 const finished = completeNativeAcceptance(f.resource, f.report, {}, undefined, f.save, f.output, f.lifetime);
 assert.equal(f.state.writes.length, 1); assert.equal(f.state.removes, 0); assert.equal(f.report.evidenceEmitted, false);
 const evidence = JSON.parse(f.state.writes[0].text); assert.equal(evidence.passed, false); assert.equal(evidence.artifactsRemoved, false);
 assert.ok(Buffer.byteLength(f.state.writes[0].text) <= 7680);
 f.state.writes[0].done(); await tick();
 assert.equal(f.state.removes, 1); assert.equal(f.report.artifactsRemoved, true); assert.equal(f.report.evidenceEmitted, true);
 assert.equal(f.state.writes.length, 2); assert.equal(f.lifetime.released, false); assert.ok(f.output.pending);
 f.bus.emit("SIGINT"); f.bus.emit("SIGTERM"); assert.equal(f.state.cancels, 0); assert.equal(f.report.cancelled, false);
 const footer = JSON.parse(f.state.writes[1].text); assert.equal(footer.passed, true); assert.equal(footer.retained, false);
 assert.ok(f.state.writes.reduce((n, value) => n + Buffer.byteLength(value.text), 0) <= 8192);
 f.state.writes[1].done(); await finished; await tick();
 assert.equal(f.report.passed, true); assert.equal(f.lifetime.released, true); assert.equal(f.lifetime.calls.length, 0);
 assert.equal(f.bus.listenerCount("SIGINT"), 0); assert.equal(f.bus.listenerCount("SIGTERM"), 0); assert.equal(f.stream.listenerCount("error"), 0);
 assert.equal(f.output.pending, undefined); assert.equal(f.output.stream, undefined); assert.equal(f.output.report, undefined);
 assert.equal(f.lifetime.save, undefined); assert.equal(f.state.afterRemovalSaves, 0);
 assert.ok(Buffer.byteLength(encodeNativeCleanup({ ...f.report, cleanupError: "错".repeat(256) })) <= 512);
 for (const fault of ["outputFailed", "outputBoundFailed", "journalFailed", "retained"]) assert.equal(nativeCleanupAllowed({ ...f.report, [fault]: true }, {}, undefined), false);
 assert.equal(nativeCleanupAllowed({ ...f.report, receiptUnknownHandles: [9] }, {}, undefined), false);
 t.diagnostic(JSON.stringify({maximumWrites:2,maximumPendingWrite:1,signalListenersAfter:0,errorListenersAfter:0,retainedCallsAfter:0,filesystemOperations:0}));
});

test("native completion retains records on callback, stream and synchronous errors and preserves removal after footer failure", async t => {
 for (const mode of ["callback", "event", "throw", "footer"]) {
  const f = fixture(); let late;
  f.stream.write = (text, done) => {
   f.state.writes.push({ text, done });
   if (mode === "footer" && f.state.writes.length === 1) { done(); return; }
   if (mode === "throw") throw Error("synchronous output failure");
   if (mode === "event") { late = done; f.stream.emit("error", Error("stream output failure")); return; }
   done(Error("callback output failure")); f.stream.emit("error", Error("duplicate output failure"));
  };
  await completeNativeAcceptance(f.resource, f.report, {}, undefined, f.save, f.output, f.lifetime);
  assert.equal(f.report.outputFailed, true); assert.equal(f.report.passed, false);
  assert.equal(f.state.removes, mode === "footer" ? 1 : 0); assert.equal(f.report.artifactsRemoved, mode === "footer");
  assert.equal(f.report.retained, mode !== "footer"); assert.equal(f.state.afterRemovalSaves, 0);
  if (mode === "event") {
   await tick(); assert.equal(f.lifetime.released, false); assert.ok(f.output.pending); assert.equal(f.stream.listenerCount("error"), 1);
   f.stream.emit("error", Error("late observed error")); late(Error("late callback failure"));
  }
  await tick(); assert.equal(f.lifetime.released, true); assert.equal(f.output.pending, undefined);
  assert.equal(f.stream.listenerCount("error"), 0); assert.equal(f.bus.listenerCount("SIGINT"), 0); assert.equal(f.state.afterRemovalSaves, 0);
 }
 t.diagnostic(JSON.stringify({failureModes:4,retryWrites:0,afterRemovalSaves:0,filesystemOperations:0}));
});

test("native completion retains repeated cancellation and late physical-close evidence for all three owned calls", async t => {
 const f = fixture(); f.report.released = false; f.report.sequencePassed = false;
 const helper1 = new EventEmitter(), helper2 = new EventEmitter(); helper1.pid = 10; helper2.pid = 11;
 const child = new EventEmitter(); child.pid = 12; child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.stdin = new EventEmitter();
 child.stdin.write = (_text, done) => done(); child.kill = () => assert.fail("Never kill the manager");
 const driver = new VolumeProtocol(child, taskId); driver.setUnsafeHandler(() => {});
 f.lifetime.track(helper1); f.lifetime.track(helper2); f.lifetime.track(driver);
 assert.throws(() => f.lifetime.track(new EventEmitter()), /call budget/);
 const pending = assert.rejects(driver.command("prepare", () => {}), /unexpectedly/);
 f.stream.write = (text, done) => { f.state.writes.push({ text, done }); done(); };
 await completeNativeAcceptance(f.resource, f.report, { active: helper2 }, driver, f.save, f.output, f.lifetime);
 assert.equal(f.report.retained, true); assert.equal(f.lifetime.released, false); assert.equal(f.state.removes, 0);
 f.bus.emit("SIGINT"); f.bus.emit("SIGINT"); f.bus.emit("SIGTERM"); assert.equal(f.state.cancels, 1);
 assert.equal(f.bus.listenerCount("SIGINT"), 1); assert.equal(f.bus.listenerCount("SIGTERM"), 1);
 helper1.result = { exitCode: 0, signal: null }; helper1.emit("settled"); await tick(); assert.equal(f.lifetime.released, false);
 child.emit("close", 23, null); await pending; await tick();
 assert.equal(driver.childReleased, true); assert.equal(driver.pid, 12); assert.equal(driver.pending, false); assert.equal(driver.diagnostics.buffersReleased, true);
 assert.equal(f.report.physicalCalls[2].closed, true); assert.equal(f.report.physicalCalls[2].exitCode, 23);
 assert.equal(f.lifetime.released, false); assert.equal(f.state.removes, 0); assert.equal(f.report.retained, true);
 const childListeners = child.stdout.listenerCount("data") + child.stdout.listenerCount("end") + child.stderr.listenerCount("data")
  + child.stdin.listenerCount("error") + child.listenerCount("error") + child.listenerCount("close");
 assert.equal(childListeners, 0); assert.equal(driver.listenerCount("settled"), 0);
 helper2.result = { exitCode: 0, signal: null }; helper2.emit("settled"); await tick();
 assert.equal(f.lifetime.released, true); assert.equal(f.lifetime.calls.length, 0); assert.equal(f.state.removes, 0);
 assert.equal(f.report.physicalCalls.every(call => call.closed), true); assert.equal(f.report.retained, true);
 assert.equal(f.bus.listenerCount("SIGINT"), 0); assert.equal(f.bus.listenerCount("SIGTERM"), 0); assert.equal(f.stream.listenerCount("error"), 0);
 assert.equal(helper1.listenerCount("settled"), 0); assert.equal(helper2.listenerCount("settled"), 0);
 t.diagnostic(JSON.stringify({trackedCalls:3,cancelInvocations:1,lateCleanupCalls:0,childListenersAfter:0,retainedCallsAfter:0,filesystemOperations:0}));
});

test("native completion persists physical close while the evidence or footer callback is still outstanding", async t => {
 for (const phase of ["evidence", "footer"]) {
  const f = fixture(), call = new EventEmitter(); call.pid = 13; f.lifetime.track(call);
  f.report.released = false; f.report.sequencePassed = false;
  const finished = completeNativeAcceptance(f.resource, f.report, { active: call }, undefined, f.save, f.output, f.lifetime);
  if (phase === "footer") { f.state.writes[0].done(); await tick(); assert.equal(f.state.writes.length, 2); }
  assert.ok(f.output.pending); assert.equal(f.lifetime.finished, false); assert.equal(f.state.savedPhysical[0].closed, false);
  call.result = { exitCode: 0, signal: null }; call.emit("settled");
  assert.equal(f.state.savedPhysical[0].closed, true); assert.equal(f.state.savedPhysical[0].exitCode, 0);
  assert.equal(f.report.retained, true); assert.equal(f.state.removes, 0); assert.equal(f.lifetime.released, false);
  if (phase === "evidence") { f.state.writes[0].done(); await tick(); assert.equal(f.state.writes.length, 2); }
  f.state.writes[1].done(); await finished; await tick();
  assert.equal(f.state.savedPhysical[0].closed, true); assert.equal(f.state.removes, 0); assert.equal(f.lifetime.released, true);
  assert.equal(f.bus.listenerCount("SIGINT"), 0); assert.equal(f.stream.listenerCount("error"), 0);
 }
 t.diagnostic(JSON.stringify({pendingWritePhases:2,lateClosePersisted:2,lateCleanupCalls:0,filesystemOperations:0}));
});
