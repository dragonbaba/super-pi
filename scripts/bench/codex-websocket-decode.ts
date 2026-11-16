import assert from "node:assert/strict";
import { Session } from "node:inspector/promises";
import { setImmediate as nextTurn } from "node:timers/promises";
import { createOpenAICodexTransportOwner } from "../../packages/ai/src/api/openai-codex-responses.ts";
import { codexModel, codexToken, responsesContext, textEvents } from "../../tests/helpers/responses-sse-fixture.ts";
import { readIntegerOption } from "./benchmark.ts";

const gc = globalThis.gc;
assert.ok(gc, "Run with --expose-gc");
const deltas = readIntegerOption("--deltas", 2000), runs = readIntegerOption("--runs", 20);
const binary = !process.argv.includes("--text"), expected = "x".repeat(deltas);
const events = structuredClone(textEvents()) as any[];
events[2].item.content[0].text = expected; events[3].response.output[0].content[0].text = expected;
const encoder = new TextEncoder();
const packets: { data: string | ArrayBuffer }[] = [];
function addPacket(event: unknown): void {
  const text = JSON.stringify(event); packets.push({ data: binary ? encoder.encode(text).buffer : text });
}
addPacket(events[0]);
for (let index = 0; index < deltas; index++) addPacket({ ...events[1], delta: "x" });
addPacket(events[2]); addPacket(events[3]);
const sockets: Socket[] = [];
let requests = 0, deliveredDeltas = 0, closed = 0;
class Socket {
  readyState = 0;
  listeners = new Map<string, Set<(event: unknown) => void>>();
  constructor() { sockets.push(this); queueMicrotask(() => { this.readyState = 1; this.emit("open", {}); }); }
  addEventListener(name: string, callback: (event: unknown) => void): void {
    let set = this.listeners.get(name); if (!set) { set = new Set(); this.listeners.set(name, set); } set.add(callback);
  }
  removeEventListener(name: string, callback: (event: unknown) => void): void { this.listeners.get(name)?.delete(callback); }
  emit(name: string, event: unknown): void { for (const callback of this.listeners.get(name) ?? []) callback(event); }
  deliver = (): void => { for (const packet of packets) this.emit("message", packet); };
  send(_text: string): void { requests++; queueMicrotask(this.deliver); }
  close(): void { this.readyState = 3; closed++; }
}
const originalSocket = globalThis.WebSocket;
globalThis.WebSocket = Socket as unknown as typeof WebSocket;
const owner = createOpenAICodexTransportOwner(), references: WeakRef<object>[] = [];
async function run(): Promise<void> {
  const stream = owner.stream(codexModel, responsesContext, { apiKey: codexToken(), sessionId: "decode-benchmark", transport: "websocket", maxRetries: 0 });
  let count = 0;
  for await (const event of stream) if (event.type === "text_delta") count++;
  const result = await stream.result();
  assert.equal(result.stopReason, "stop", result.errorMessage);
  assert.equal(count, deltas); deliveredDeltas += count;
  assert.equal(result.content.find(block => block.type === "text")?.text, expected);
  references.push(new WeakRef(stream), new WeakRef(result));
}
const profiler = new Session(); profiler.connect();
let sampled, heapBefore = 0, peakHeap = 0;
const times = new Float64Array(runs);
try {
  for (let index = 0; index < 3; index++) await run();
  gc(); heapBefore = process.memoryUsage().heapUsed; peakHeap = heapBefore;
  await profiler.post("HeapProfiler.startSampling", { samplingInterval: 4096, includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true });
  for (let index = 0; index < runs; index++) {
    const start = performance.now(); await run(); times[index] = performance.now() - start;
    peakHeap = Math.max(peakHeap, process.memoryUsage().heapUsed);
  }
  sampled = await profiler.post("HeapProfiler.stopSampling");
} finally { profiler.disconnect(); await owner.dispose(); globalThis.WebSocket = originalSocket; }
for (const socket of sockets) for (const set of socket.listeners.values()) assert.equal(set.size, 0);
assert.equal(owner.diagnostics.pending, 0); assert.equal(owner.diagnostics.cached, 0);
for (let index = 0; index < 6; index++) { await nextTurn(); gc(); }
let retained = 0; for (const reference of references) if (reference.deref()) retained++;
assert.equal(retained, 0);
let sampledBytes = 0; const stack = [sampled!.profile.head], sites: { name: string; bytes: number }[] = [];
while (stack.length) { const node = stack.pop()!; sampledBytes += node.selfSize;
  if (node.selfSize) sites.push({ name: node.callFrame.functionName, bytes: node.selfSize });
  for (const child of node.children ?? []) stack.push(child);
}
sites.sort((left, right) => right.bytes - left.bytes); times.sort();
console.log(JSON.stringify({ mode: binary ? "arraybuffer" : "text", deltas, runs, requests, deliveredDeltas, connections: sockets.length, closed,
  p50Ms: times[Math.floor(runs * .5)], p95Ms: times[Math.min(runs - 1, Math.floor(runs * .95))], sampledBytes,
  heapBefore, observedPeakHeap: peakHeap, controlledGcHeap: process.memoryUsage().heapUsed,
  trackedReferences: references.length, retained, leadingSites: sites.slice(0, 8), node: process.version }));
