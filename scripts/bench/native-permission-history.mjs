// Offline production-history lookup and release evidence; not part of ordinary CI.
import assert from "node:assert/strict";
import { Session } from "node:inspector/promises";
import { setImmediate as tick } from "node:timers/promises";
import { performance } from "node:perf_hooks";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.ts";
import { SessionExecutionPolicy } from "../../packages/coding-agent/src/core/execution-policy.ts";
import { createExtensionRuntime } from "../../packages/coding-agent/src/core/extensions/loader.ts";

const HISTORY = 10000, ITERATIONS = 200000, WARMUP = 10000;
const NativeWeakRef = globalThis.WeakRef;
let weakRefAllocations = 0;
class CountedWeakRef extends NativeWeakRef {
  constructor(target) { super(target); weakRefAllocations++; }
}
function forbidHistoryCopy() { throw new Error("History array materialization"); }
function sampleBytes(node, ownedOnly = false) {
  let bytes = !ownedOnly || node.callFrame.url.endsWith("/execution-policy.ts") ? node.selfSize : 0;
  for (const child of node.children) bytes += sampleBytes(child, ownedOnly);
  return bytes;
}
function policySites(node, output) {
  if (node.selfSize && node.callFrame.url.endsWith("/execution-policy.ts")) output.push({ function: node.callFrame.functionName, bytes: node.selfSize });
  for (const child of node.children) policySites(child, output);
}
function largerSampleFirst(left, right) { return right.bytes - left.bytes; }
function fixture() {
  const manager = SessionManager.inMemory(process.cwd()), runtime = createExtensionRuntime();
  runtime.appendEntry = function append(type, data) { manager.appendCustomEntry(type, data); };
  const owner = new SessionExecutionPolicy(runtime, "trusted-host", { rules: [{ tool: "powershell", decision: "ask" }] }, "host-write");
  const ctx = { cwd: process.cwd(), hasUI: true, sessionManager: manager, signal: runtime.executionBoundary.signal, ui: {} };
  return { manager, runtime, owner, ctx };
}

assert.equal(typeof globalThis.gc, "function", "Run with node --expose-gc --experimental-strip-types");
const profiler = new Session(); profiler.connect();
const f = fixture(), references = [];
let measuredWeakRefs, elapsedMs, profile;
try {
  for (let index = 0; index < HISTORY; index++) f.manager.appendCustomEntry("ordinary-history", undefined);
  f.manager.getBranch = forbidHistoryCopy; f.manager.getEntries = forbidHistoryCopy;
  f.owner.restoreHistory(f.ctx);
  globalThis.WeakRef = CountedWeakRef;
  try {
    for (let index = 0; index < ITERATIONS; index++) f.owner.restoreHistory(f.ctx);
    measuredWeakRefs = weakRefAllocations;
  } finally { globalThis.WeakRef = NativeWeakRef; }
  // Sample the unchanged production globals separately from constructor instrumentation.
  for (let index = 0; index < WARMUP; index++) f.owner.restoreHistory(f.ctx);
  globalThis.gc();
  await profiler.post("HeapProfiler.startSampling", { samplingInterval: 1024, includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true });
  const start = performance.now();
  for (let index = 0; index < ITERATIONS; index++) f.owner.restoreHistory(f.ctx);
  elapsedMs = performance.now() - start;
  profile = (await profiler.post("HeapProfiler.stopSampling")).profile;
  assert.equal(measuredWeakRefs, 0); assert.equal(f.owner.refusalCursor, f.manager.getAppendCursor());
  assert.equal(f.owner.denied.size, 0);
} finally { profiler.disconnect(); f.owner.dispose(); await f.runtime.executionBoundary.dispose(); }

async function lifecycle(outcome) {
  const { manager, runtime, owner, ctx } = fixture();
  const controller = new AbortController(); ctx.signal = controller.signal;
  manager.appendCustomEntry("native-permission-denial-v1", { key: "a".repeat(64) });
  const record = owner.listRefusals(ctx)[0];
  references.push(new NativeWeakRef(owner), new NativeWeakRef(manager), new NativeWeakRef(record), new NativeWeakRef(ctx));
  ctx.ui.select = function choose(_title, choices) {
    if (outcome === "abort") controller.abort();
    return Promise.resolve(outcome === "cancel" ? undefined : choices[outcome === "allow" ? 0 : 1]);
  };
  try {
    const request = owner.authorize({ type: "tool_call", toolName: "powershell", toolCallId: "lifecycle", input: { command: "Write-Output fixture" } }, ctx);
    if (outcome === "allow") (await request).release();
    else await assert.rejects(request, outcome === "abort" ? /aborted/ : outcome === "cancel" ? /APPROVAL_CANCELLED/ : /User declined/);
  } finally {
    owner.dispose(); await runtime.executionBoundary.dispose();
    assert.equal(owner.denied.size, 0); assert.equal(owner.refusalManager, undefined);
    assert.equal(owner.scannedLeaf, undefined); assert.equal(owner.refusalCursor, 0);
  }
}

{
  for (const outcome of ["allow", "deny", "cancel", "abort"]) await lifecycle(outcome);
  let live = references.length;
  for (let cycle = 0; cycle < 4; cycle++) {
    await tick(); globalThis.gc(); await tick();
    live = 0;
    for (const reference of references) if (reference.deref()) live++;
  }
  assert.equal(live, 0);
  const sites = []; policySites(profile.head, sites); sites.sort(largerSampleFirst);
  console.log(JSON.stringify({ schemaVersion: 1, benchmark: "native-permission-history", node: process.version, platform: process.platform,
    history: HISTORY, warmup: WARMUP, iterations: ITERATIONS, elapsedMs, weakRefsPerWarmLookup: measuredWeakRefs / ITERATIONS,
    historyArrays: 0, sampledTotalBytes: sampleBytes(profile.head), sampledPolicyBytes: sampleBytes(profile.head, true), leadingPolicySites: sites.slice(0, 5),
    lifecycleOutcomes: ["allow", "deny", "cancel", "abort"], references: references.length, gcCycles: 4, liveAfterDispose: live }));
}
