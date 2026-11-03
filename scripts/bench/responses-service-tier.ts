import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { Session } from "node:inspector/promises";
import { setImmediate } from "node:timers/promises";
import { createOpenAIResponsesOwner } from "../../packages/openai-server-compaction/src/custom-stream.ts";
import { sseFrames, textEvents } from "../../tests/helpers/responses-sse-fixture.ts";

// Manual bounded production transport probe: no remote requests, files, CI job or timing threshold.
const gc = (globalThis as { gc?: () => void }).gc;
assert.ok(gc, "run with --expose-gc");
const sessionId = "bench-responses-service-tier";
const continuity = process.argv.includes("--continuity");
const model: any = { id: "gpt-5.1", api: "openai-responses", provider: "openai", baseUrl: "https://api.openai.com/v1",
  input: ["text"], reasoning: false, contextWindow: 64000, maxTokens: 512, cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } };
const context: any = { messages: [{ role: "user", content: "fixture ".repeat(1024), timestamp: 1 }] };
const events: any[] = structuredClone(textEvents());
events.splice(2, 0, ...Array.from({ length: 7 }, () => ({ ...events[1] })));
events.at(-1).response.usage = { input_tokens: 1000000, output_tokens: 1000000, total_tokens: 2000000 };
const frames = events.map(event => JSON.stringify(event));
const sse = sseFrames(events);
const refs: WeakRef<object>[] = [];
const sockets: EventEmitter[] = [];
let requests = 0, hooks = 0, deltas = 0, wrongPrice = 0, inputItems = 0;
class Socket extends EventEmitter {
  readyState = 1;
  send(body: string) {
    requests++;
    const payload = JSON.parse(body);
    assert.equal(payload.service_tier, "priority");
    inputItems += payload.input.length;
    queueMicrotask(() => { for (const frame of frames) this.emit("message", frame); });
  }
  close() { this.readyState = 3; }
  terminate() { this.close(); }
}
const owner = createOpenAIResponsesOwner({ socketFactory: async () => { const socket = new Socket(); sockets.push(socket); return socket; } });
const stream = owner.streamSimple;
const originalFetch = globalThis.fetch;
globalThis.fetch = (async (_url: unknown, init: any) => {
  requests++;
  assert.equal(JSON.parse(init.body).service_tier, "priority");
  return new Response(sse, { headers: { "content-type": "text/event-stream" } });
}) as typeof fetch;
const profiler = new Session();
async function request(transport: "websocket" | "sse", track: boolean) {
  if (continuity) { transport = "websocket"; context.messages.push({ role: "user", content: "next", timestamp: hooks }); }
  const active = stream(model, context, { sessionId, apiKey: "synthetic", transport, onPayload: (payload: any) => {
    hooks++; payload.service_tier = "priority";
    if (track) refs.push(new WeakRef(payload));
  } });
  for await (const event of active) if (event.type === "text_delta") deltas++;
  const result = await active.result();
  assert.equal(result.stopReason, "stop", result.errorMessage);
  if (result.usage.cost.total !== 4) wrongPrice++;
  if (continuity) context.messages.push(result);
  if (track) { refs.push(new WeakRef(active), new WeakRef(result)); }
}
try {
  await request("websocket", false); await request("sse", false);
  requests = hooks = deltas = wrongPrice = inputItems = 0;
  gc(); profiler.connect();
  await profiler.post("HeapProfiler.startSampling", { samplingInterval: 4096, includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true });
  const times = new Float64Array(32);
  for (let i = 0; i < times.length; i++) {
    const start = performance.now(); await request(i % 2 ? "sse" : "websocket", true); times[i] = performance.now() - start;
  }
  const { profile } = await profiler.post("HeapProfiler.stopSampling");
  let bytes = 0;
  const pending = [profile.head];
  while (pending.length) { const node = pending.pop()!; bytes += node.selfSize; for (const child of node.children) pending.push(child); }
  await owner.dispose();
  if (continuity) context.messages.length = 0;
  for (let i = 0; i < 4; i++) { await setImmediate(); gc(); }
  const retained = refs.filter(ref => ref.deref()).length;
  const listeners = sockets.reduce((sum, socket) => sum + socket.eventNames().reduce((n, name) => n + socket.listenerCount(name), 0), 0);
  assert.equal(requests, 32); assert.equal(hooks, 32); assert.equal(deltas, 256);
  assert.equal(retained, 0); assert.equal(listeners, 0);
  assert.deepEqual([owner.pendingRequests, owner.queuedSessions, owner.connections], [0, 0, 0]);
  assert.equal(owner.state.entryCount, 0);
  if (continuity) assert.equal(inputItems, 32, "same-tier requests keep the incremental input path");
  times.sort();
  console.log(JSON.stringify({ continuity, requests, hooks, deltas, wrongPrice, inputItems, trackedReferences: refs.length, retained, listeners,
    pendingRequests: owner.pendingRequests, queuedSessions: owner.queuedSessions, connections: owner.connections,
    stateEntries: owner.state.entryCount,
    sampledBytesPerRequest: bytes / times.length, p95Ms: times[30], node: process.version }));
} finally {
  profiler.disconnect(); globalThis.fetch = originalFetch;
  await owner.dispose();
}
