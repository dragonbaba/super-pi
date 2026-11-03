import assert from "node:assert/strict";
import { Session } from "node:inspector/promises";
import { setImmediate } from "node:timers/promises";
import { createJiti } from "jiti";
import { createEventBus } from "../../packages/coding-agent/src/core/event-bus.ts";
import { createExtensionRuntime, ExtensionRunner, loadExtensionFromFactory } from "../../packages/coding-agent/src/core/extensions/index.ts";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.ts";

// Manual bounded before/after probe; no CI matrix, subprocess, or disk fixture.
const { default: guard } = await createJiti(import.meta.url).import<any>("../../packages/extensions/false-success-guard/index.ts");
const gc = (globalThis as { gc?: () => void }).gc;
assert.ok(gc, "run with --expose-gc");
const iterations = 128, warmup = 16;
const references: WeakRef<object>[] = [], retainedRunners: ExtensionRunner[] = [];
let textReads = 0, audits = 0;
const events = createEventBus(), runtime = createExtensionRuntime();
const extension = await loadExtensionFromFactory(guard, process.cwd(), events, runtime);
const runner = new ExtensionRunner([extension], runtime, process.cwd(), SessionManager.inMemory(), {} as never);
runner.bindCore({ appendEntry() { audits++; } } as never, {} as never);
runner.onError(error => { throw new Error(error.error); });
await runner.emitToolResult({ type: "tool_result", toolCallId: "failure", toolName: "run_tests", input: {}, isError: true, content: [{ type: "text", text: "fixture failed" }] } as never);
const active = runner.hasHandlers("message_end");

function message(text: string): any {
  const block = { type: "text", get text() { textReads++; return text; } };
  const value = { role: "assistant", stopReason: "stop", provider: "fixture", model: "fixture", content: [block] };
  references.push(new WeakRef(block), new WeakRef(value.content), new WeakRef(value));
  return value;
}

async function deliver(text: string): Promise<boolean> {
  const value = message(text);
  // Real runner dispatch, including its context/hook boundary. Session may skip
  // this entirely when no other extension registers message_end.
  const replacement = await runner.emitMessageEnd({ type: "message_end", message: value });
  assert.equal(Boolean(replacement), active);
  return replacement !== undefined;
}

try {
  for (const length of [64, 1024 * 1024]) {
    const text = "已完成。" + "x".repeat(length - 4);
    for (let i = 0; i < warmup; i++) await deliver(text);
    textReads = audits = 0;
    const profiler = new Session(); profiler.connect();
    const times = new Float64Array(iterations);
    const sites: { site: string; bytes: number }[] = [];
    let bytes = 0, replacements = 0;
    try {
      gc();
      await profiler.post("HeapProfiler.startSampling", { samplingInterval: 4096, includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true });
      for (let i = 0; i < iterations; i++) {
        const start = performance.now();
        if (await deliver(text)) replacements++;
        times[i] = performance.now() - start;
      }
      const { profile } = await profiler.post("HeapProfiler.stopSampling");
      const pending = [profile.head];
      while (pending.length) {
        const node = pending.pop()!; bytes += node.selfSize;
        if (node.selfSize) sites.push({ site: `${node.callFrame.functionName} ${node.callFrame.url}:${node.callFrame.lineNumber + 1}`, bytes: node.selfSize });
        for (const child of node.children) pending.push(child);
      }
    } finally { profiler.disconnect(); }
    times.sort();
    sites.sort((a, b) => b.bytes - a.bytes);
    assert.equal(replacements, active ? iterations : 0);
    assert.equal(audits, active ? iterations : 0);
    if (!active) assert.equal(textReads, 0);
    console.log(JSON.stringify({ length, iterations, warmup, messageEndHandlers: extension.handlers.get("message_end")?.length ?? 0,
      textReads, replacements, audits, sampledBytesPerCall: bytes / iterations, p95Ms: times[Math.floor(iterations * 0.95)], sites: sites.slice(0, 6) }));
  }
} finally {
  await runner.emit({ type: "session_shutdown", reason: "exit" } as never);
  events.clear(); retainedRunners.push(runner);
}
await setImmediate();
for (let i = 0; i < 4; i++) { gc(); await setImmediate(); }
let retained = 0;
for (const reference of references) if (reference.deref()) retained++;
assert.equal(retained, 0);
console.log(JSON.stringify({ lifecycle: { tracked: references.length, retainedRunners: retainedRunners.length, retainedAfterGc: retained }, node: process.version, platform: process.platform }));
