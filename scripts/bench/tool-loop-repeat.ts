import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { Session } from "node:inspector/promises";
import { resolve } from "node:path";
import { setImmediate } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { createJiti } from "jiti";
import { CallLedger } from "../../packages/extensions/tool-loop-guardrails/call-ledger.ts";
import { RetryWait } from "../../packages/extensions/tool-loop-guardrails/transient-retry.ts";

// The identical driver can load an independently installed/built old checkout.
const target = resolve(process.argv[2] ?? process.cwd());
const jiti = createJiti(import.meta.url);
const { default: guard } = await jiti.import<any>(pathToFileURL(resolve(target, "packages/extensions/tool-loop-guardrails/index.ts")).href);
const gc = (globalThis as { gc?: () => void }).gc;
assert.ok(gc, "run with --expose-gc");
const iterations = 256, warmup = 32;
let phase = "idle", scannedBytes = 0, updates = 0, digests = 0, resultBytes = 0, resultDigests = 0;
const hashPrototype = Object.getPrototypeOf(createHash("sha256"));
const originalUpdate = hashPrototype.update, originalDigest = hashPrototype.digest;
hashPrototype.update = function(value: any, encoding?: BufferEncoding) {
  const bytes = typeof value === "string" ? Buffer.byteLength(value, encoding) : value.byteLength;
  if (phase === "admission") { scannedBytes += bytes; updates++; }
  if (phase === "result") resultBytes += bytes;
  return originalUpdate.call(this, value, encoding);
};
hashPrototype.digest = function(...args: any[]) {
  if (phase === "admission") digests++;
  if (phase === "result") resultDigests++;
  return originalDigest.apply(this, args);
};

function fixture() {
  const hooks = new Map<string, (...args: any[]) => any>();
  guard({ on(name: string, hook: any) { hooks.set(name, hook); }, registerTool() {}, registerFlag() {}, getFlag() {}, sendMessage() {} });
  hooks.get("agent_start")!();
  return hooks;
}

const ctx = { cwd: target };
async function invoke(hooks: ReturnType<typeof fixture>, input: object, index: number): Promise<void> {
  const toolCallId = `c${index}`, parentToolCallId = `p${index}`;
  phase = "admission";
  const outcome = await hooks.get("tool_call")!({ toolName: "fixture_operation", toolCallId, input, parentToolCallId }, ctx);
  assert.equal(outcome, undefined);
  phase = "result";
  await hooks.get("tool_result")!({ toolName: "fixture_operation", toolCallId, input, isError: false, content: [{ type: "text", text: "ok" }], details: {} }, ctx);
  phase = "idle";
  hooks.get("tool_execution_end")!({ toolCallId });
  hooks.get("tool_execution_end")!({ toolCallId: parentToolCallId });
}

const owners: WeakRef<object>[] = [];
async function lifecycle(mode: string): Promise<void> {
  const hooks = fixture(), input = { code: "large-source-".repeat(8192) };
  owners.push(new WeakRef(input));
  const event = { toolName: "fixture_operation", toolCallId: "child", parentToolCallId: "parent", input };
  owners.push(new WeakRef(event));
  const admission = hooks.get("tool_call")!(event, ctx);
  if (mode === "cancel-during-preparation") {
    hooks.get("tool_execution_end")!({ toolCallId: "parent" });
    await admission;
  } else {
    await admission;
    if (mode !== "parent-cancel") {
      const result = { ...event, isError: mode === "failure", content: [{ type: "text", text: "SyntaxError: fixture" }], details: {} };
      owners.push(new WeakRef(result), new WeakRef(result.content));
      await hooks.get("tool_result")!(result, ctx);
    }
    hooks.get("tool_execution_end")!({ toolCallId: "parent" });
  }
  hooks.get("agent_end")!();
  // Retain the lifecycle owner to prove clear() releases sources even while hooks stay alive.
  retainedHooks.push(hooks);
}
const retainedHooks: ReturnType<typeof fixture>[] = [];
const retainedLedgers: CallLedger[] = [];
async function retryLifecycle(mode: string): Promise<void> {
  const ledger = new CallLedger(), pending = ledger.remember("child", "bounded-key", "parent");
  const wait = pending.wait = new RetryWait(), controller = new AbortController();
  owners.push(new WeakRef(pending), new WeakRef(wait), new WeakRef(controller.signal));
  const promise = wait.start(mode === "normal" ? 1 : 10_000, controller.signal);
  if (mode === "signal") controller.abort();
  else if (mode === "parent") ledger.end("parent");
  else if (mode === "end") ledger.clear();
  assert.equal(await promise, mode === "normal");
  ledger.clear();
  assert.equal(ledger.pending.size + ledger.nested.size + ledger.released.size, 0);
  retainedLedgers.push(ledger);
}

try {
  for (const length of [64, 1024 * 1024]) {
    const hooks = fixture(), input = { code: "x".repeat(length) };
    for (let i = 0; i < warmup; i++) await invoke(hooks, input, i);
    scannedBytes = updates = digests = resultBytes = resultDigests = 0;
    gc();
    const heapBefore = process.memoryUsage().heapUsed;
    const profiler = new Session(); profiler.connect();
    const times: number[] = [];
    let sampledBytes = 0;
    const sites: { site: string; bytes: number }[] = [];
    try {
      await profiler.post("HeapProfiler.startSampling", { samplingInterval: 4096, includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true });
      for (let i = 0; i < iterations; i++) { const started = performance.now(); await invoke(hooks, input, i); times.push(performance.now() - started); }
      const { profile } = await profiler.post("HeapProfiler.stopSampling");
      const stack = [profile.head];
      while (stack.length) {
        const node = stack.pop()!; sampledBytes += node.selfSize;
        if (node.selfSize) sites.push({ site: `${node.callFrame.functionName} ${node.callFrame.url}:${node.callFrame.lineNumber + 1}`, bytes: node.selfSize });
        for (const child of node.children) stack.push(child);
      }
    } finally { profiler.disconnect(); }
    const heapBeforeClear = process.memoryUsage().heapUsed;
    hooks.get("agent_end")!(); gc();
    sites.sort((a, b) => b.bytes - a.bytes); times.sort((a, b) => a - b);
    assert.equal(resultBytes, 0); assert.equal(resultDigests, 0);
    console.log(JSON.stringify({ target, length, iterations, warmup, sampledBytesPerCall: sampledBytes / iterations,
      p50Ms: times[Math.floor(times.length / 2)], p95Ms: times[Math.floor(times.length * 0.95)],
      counters: { admissionScannedBytes: scannedBytes, hashUpdates: updates, admissionDigests: digests, resultScannedBytes: resultBytes, resultDigests },
      heapBefore, heapBeforeClear, heapAfterClearGc: process.memoryUsage().heapUsed, sites: sites.slice(0, 8) }));
  }
  for (const mode of ["normal", "failure", "parent-cancel", "cancel-during-preparation"]) for (let i = 0; i < 16; i++) await lifecycle(mode);
  // New retry-owner lifecycle is reported separately from the comparable old/new hook fixtures.
  if (process.argv[2] === undefined) for (const mode of ["normal", "signal", "parent", "end"]) for (let i = 0; i < 8; i++) await retryLifecycle(mode);
  await setImmediate(); for (let i = 0; i < 4; i++) { gc(); await setImmediate(); }
  let retainedAfterGc = 0;
  for (const reference of owners) if (reference.deref()) retainedAfterGc++;
  assert.equal(retainedAfterGc, 0);
  console.log(JSON.stringify({ lifecycle: { owners: owners.length, retainedHooks: retainedHooks.length, retainedRetryLedgers: retainedLedgers.length, retainedAfterGc }, node: process.version, v8: process.versions.v8, platform: process.platform }));
} finally { hashPrototype.update = originalUpdate; hashPrototype.digest = originalDigest; }
