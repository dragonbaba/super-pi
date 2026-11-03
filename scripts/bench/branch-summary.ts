import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { Session } from "node:inspector/promises";
import { release } from "node:os";
import { resolve } from "node:path";
import { setImmediate as nextTurn } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { createAssistantMessageEventStream } from "@super-pi/ai";
import type { AssistantMessage, Model } from "@super-pi/ai";
import type { SessionEntry } from "../../packages/coding-agent/src/core/session-manager.ts";

const moduleIndex = process.argv.indexOf("--summary-module");
const modulePath = resolve(moduleIndex < 0 ? "packages/coding-agent/src/core/compaction/branch-summarization.ts" : process.argv[moduleIndex + 1]);
const { generateBranchSummary } = await import(pathToFileURL(modulePath).href);
const smoke = process.argv.includes("--smoke"), warmup = 10, timingIterations = 512, profileIterations = 6, samplingInterval = 1024;
const model: Model<any> = { id: "summary-fixture", name: "summary-fixture", api: "openai-responses", provider: "fixture",
  baseUrl: "https://fixture.invalid", reasoning: false, input: ["text"], contextWindow: 2000000, maxTokens: 16384,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
function history(size: number): SessionEntry[] {
  return Array.from({ length: size }, (_, i) => ({ type: "message", id: `entry-${i}`, parentId: i ? `entry-${i - 1}` : null,
    timestamp: "2026-01-01T00:00:00Z", message: { role: "user", content: `${i}: ${"history payload ".repeat(64)}`, timestamp: i } }));
}
async function gc() { for (let i = 0; i < 5; i++) { await nextTurn(); globalThis.gc!(); } }
async function run(entries: SessionEntry[], reason: "normal" | "abort" | "error" = "normal", observe?: (context: any, options: any) => void) {
  const controller = new AbortController();
  return generateBranchSummary(entries, { model, maxTokens: 8192, signal: controller.signal,
    retry: { enabled: false, maxRetries: 0, baseDelayMs: 0 }, streamFn: (_model: unknown, context: any, options: any) => {
      observe?.(context, options);
      const stream = createAssistantMessageEventStream();
      const message: AssistantMessage = { role: "assistant", api: model.api, provider: model.provider, model: model.id,
        content: [{ type: "text", text: "Fixture summary" }], timestamp: 1, usage,
        stopReason: reason === "normal" ? "stop" : reason === "abort" ? "aborted" : "error", errorMessage: reason === "error" ? "fixture failure" : undefined };
      if (reason === "normal") stream.push({ type: "done", reason: "stop", message });
      else { if (reason === "abort") controller.abort(); stream.push({ type: "error", reason: reason === "abort" ? "aborted" : "error", error: message }); }
      return stream;
    } });
}

async function count(size: number) {
  const entries = history(size), join = Array.prototype.join;
  let serializations = 0, serializedMessages = 0, serializedCodeUnits = 0, requests = 0, promptCodeUnits = 0;
  Array.prototype.join = function(separator?: string) {
    const value = join.call(this, separator);
    if (separator === "\n\n" && typeof this[0] === "string" && this[0].startsWith("[User]:")) {
      serializations++; serializedMessages += this.length; serializedCodeUnits += value.length;
    }
    return value;
  };
  try {
    const result = await run(entries, "normal", context => { requests++; promptCodeUnits = context.messages[0].content[0].text.length; });
    assert.ok(result.summary); assert.equal(requests, 1); assert.equal(serializations, 1); assert.equal(serializedMessages, size);
    return { size, requests, serializations, serializedMessages, serializedCodeUnits, promptCodeUnits, promptUtf16Bytes: promptCodeUnits * 2 };
  } finally { Array.prototype.join = join; }
}

async function lifecycle(reason: "normal" | "abort" | "error") {
  const entries = history(1024);
  let contextRef: WeakRef<object> | undefined, optionsRef: WeakRef<object> | undefined, promptCodeUnits = 0;
  const result = await run(entries, reason, (context, options) => {
    contextRef = new WeakRef(context); optionsRef = new WeakRef(options); promptCodeUnits = context.messages[0].content[0].text.length;
  });
  await gc();
  assert.equal(contextRef!.deref(), undefined); assert.equal(optionsRef!.deref(), undefined);
  assert.equal(entries.length, 1024); // Caller-owned history and returned result remain live.
  assert.ok(reason === "normal" ? result.summary : reason === "abort" ? result.aborted : result.error);
  return { reason, callerEntries: entries.length, resultRetained: true, peakRequestPromptUtf16Bytes: promptCodeUnits * 2,
    retainedRequestContexts: 0, retainedRequestOptions: 0, retainedRequestPromptBytes: 0 };
}

async function measure(size: number) {
  const entries = history(size), samples: number[] = [];
  for (let i = 0; i < warmup; i++) await run(entries);
  const cpu = process.cpuUsage();
  for (let i = 0; i < timingIterations; i++) { const start = performance.now(); await run(entries); samples.push(performance.now() - start); }
  const elapsed = process.cpuUsage(cpu); samples.sort((a, b) => a - b); await gc();
  const heapBefore = process.memoryUsage().heapUsed; let peakHeap = heapBefore;
  const inspector = new Session(); inspector.connect(); let profile;
  try {
    await inspector.post("HeapProfiler.startSampling", { samplingInterval, includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true });
    for (let i = 0; i < profileIterations; i++) { await run(entries); peakHeap = Math.max(peakHeap, process.memoryUsage().heapUsed); }
    profile = (await inspector.post("HeapProfiler.stopSampling")).profile;
  } finally { inspector.disconnect(); }
  await gc(); const heapAfterGC = process.memoryUsage().heapUsed;
  let sampledBytes = 0; const sites: { frame: string; bytes: number }[] = [];
  function visit(node: typeof profile.head): void {
    sampledBytes += node.selfSize;
    if (node.selfSize) sites.push({ frame: `${node.callFrame.functionName}@${node.callFrame.url}:${node.callFrame.lineNumber + 1}`, bytes: node.selfSize });
    for (const child of node.children ?? []) visit(child);
  }
  visit(profile.head);
  return { size, sampledBytes, sampledBytesPerSummary: sampledBytes / profileIterations,
    wallP95Milliseconds: samples[Math.ceil(samples.length * 0.95) - 1], cpuMicrosecondsPerInvocation: (elapsed.user + elapsed.system) / timingIterations,
    heapBefore, peakHeap, heapAfterGC, allocationSites: sites.sort((a, b) => b.bytes - a.bytes).slice(0, 8) };
}

assert.equal(typeof globalThis.gc, "function", "run with --expose-gc");
const counters = [], lifecycleRows = [], measurements = [];
for (const size of [256, 512, 1024]) counters.push(await count(size));
for (const reason of ["normal", "abort", "error"] as const) lifecycleRows.push(await lifecycle(reason));
if (!smoke) for (const size of [256, 512, 1024]) measurements.push(await measure(size));
console.log(JSON.stringify({ fixtureVersion: 1, node: process.version, os: `${process.platform} ${release()}`, modulePath,
  sourceHash: createHash("sha256").update(readFileSync(modulePath, "utf8").replaceAll("\r\n", "\n")).digest("hex"),
  warmup, timingIterations, profileIterations, samplingInterval, counters, lifecycle: lifecycleRows, measurements }));
