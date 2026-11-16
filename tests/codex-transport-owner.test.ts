import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { setImmediate as nextTurn, setTimeout as delay } from "node:timers/promises";
import { zstdDecompressSync } from "node:zlib";
import test from "node:test";
import { buildOpenAICodexRequestBody, closeOpenAICodexWebSocketSessions, compactOpenAICodexRequest,
  createOpenAICodexTransportOwner, resetOpenAICodexWebSocketDebugStats, stream } from "../packages/ai/src/api/openai-codex-responses.ts";
import { cleanupSessionResources } from "../packages/ai/src/session-resources.ts";
import { codexModel, codexToken, responsesContext, sseFrames, textEvents } from "./helpers/responses-sse-fixture.ts";

const artifact = { type: "compaction", encrypted_content: "owner-artifact" };
const compactEvents = [{ type: "response.output_item.done", output_index: 0, item: artifact },
  { type: "response.completed", response: { id: "compacted", status: "completed", output: [artifact] } }];
const deferred = () => { let release!: () => void; const promise = new Promise<void>(r => { release = r; }); return { promise, release }; };
const payloadAfter = (result: any, options: any) => buildOpenAICodexRequestBody(codexModel,
  { ...responsesContext, messages: [...responsesContext.messages, result] }, options, options.sessionId) as unknown as Record<string, unknown>;

test("Codex manual compaction accepts restored history without priming a new owner", async () => {
  const owner = createOpenAICodexTransportOwner(), requests: any[] = [];
  let fail = true;
  const options = { apiKey: codexToken(), sessionId: "restored-manual-compact", shapeDiagnostics: true,
    fetch: (async (_url, init) => {
      const body = new Headers(init?.headers).get("content-encoding") === "zstd"
        ? zstdDecompressSync(init?.body as Uint8Array).toString("utf8") : String(init?.body);
      const payload = JSON.parse(body); requests.push(payload);
      if (fail) return new Response("synthetic provider failure", { status: 500 });
      const events = payload.input.some((item: any) => item.type === "compaction_trigger") ? compactEvents : textEvents();
      return new Response(sseFrames(events), { headers: { "content-type": "text/event-stream" } });
    }) as typeof fetch };
  const payload = buildOpenAICodexRequestBody(codexModel, responsesContext, options, options.sessionId) as unknown as Record<string, unknown>;
  const original = structuredClone(payload);
  try {
    await assert.rejects(owner.compact(codexModel, payload, options), /synthetic provider failure/);
    assert.equal(requests.length, 1, "one actual compaction attempt, no regular probe or automatic retry");
    fail = false;
    const result = await owner.compact(codexModel, payload, options);
    assert.deepEqual(result.compactionItem, artifact);
    assert.equal(result.diagnostics, undefined, "no invented comparison against a regular dispatch that never happened");
    assert.equal(requests.length, 2);
    for (const request of requests) {
      assert.equal(request.previous_response_id, undefined);
      assert.deepEqual(request.input, [...(payload.input as any[]), { type: "compaction_trigger" }]);
      assert.equal(request.instructions, payload.instructions);
      assert.deepEqual(request.tools, payload.tools);
    }
    assert.deepEqual(payload, original);
    assert.equal(owner.diagnostics.commitments, 0);
    const next = await owner.stream(codexModel, responsesContext, { ...options, transport: "sse" }).result();
    assert.equal(next.stopReason, "stop");
    assert.equal(requests.length, 3, "the next regular turn is sent once");
    assert.equal(owner.diagnostics.commitments, 1);
    owner.reset(); await owner.drain(); owner.resume();
    assert.equal(owner.diagnostics.commitments, 0);
    assert.deepEqual((await owner.compact(codexModel, payloadAfter(next, options), options)).compactionItem, artifact);
    assert.equal(requests.length, 4, "a reset owner can compact without another regular turn");
  } finally { await owner.dispose(); }
  for (const count of Object.values(owner.diagnostics)) assert.equal(count, 0);
});

test("Codex full-history compaction releases a prior WS boundary only when dispatching", async () => {
  const f = socketsFixture(), owner = createOpenAICodexTransportOwner();
  let http = 0;
  const options = { apiKey: codexToken(), sessionId: "manual-after-ws-compact", transport: "auto" as const,
    codexRemoteCompaction: true, fetch: (async () => { http++; return new Response(sseFrames(compactEvents), { headers: { "content-type": "text/event-stream" } }); }) as typeof fetch };
  try {
    const regular = await owner.stream(codexModel, responsesContext, options).result();
    const payload = payloadAfter(regular, options);
    await owner.compact(codexModel, payload, options);
    assert.equal(owner.diagnostics.commitments, 0); assert.equal(owner.diagnostics.cached, 1);
    const fullHistory = { ...payload, input: [artifact, ...(payload.input as any[])] };
    const aborted = new AbortController();
    await assert.rejects(owner.compact(codexModel, fullHistory, { ...options, signal: aborted.signal,
      onRequestBodyBytes: () => aborted.abort() }), /abort/i);
    assert.equal(http, 0); assert.equal(owner.diagnostics.cached, 1); assert.equal(f.sockets[0].readyState, 1);
    assert.deepEqual((await owner.compact(codexModel, fullHistory, options)).compactionItem, artifact);
    assert.equal(http, 1); assert.equal(owner.diagnostics.cached, 0); assert.equal(f.sockets[0].readyState, 3);
    assert.equal((await owner.stream(codexModel, responsesContext, options).result()).stopReason, "stop");
    assert.equal(f.sockets.length, 2); assert.equal(f.bodies.at(-1).previous_response_id, undefined);
  } finally { await owner.dispose(); f.release(); }
});

test("Codex full-history compaction cannot replace a busy owner connection or use a stale response ID", async () => {
  const f = socketsFixture(), owner = createOpenAICodexTransportOwner();
  let http = 0;
  const options = { apiKey: codexToken(), sessionId: "busy-manual-compact", transport: "auto" as const,
    fetch: (async () => { http++; throw new Error("unexpected HTTP dispatch"); }) as typeof fetch };
  try {
    const payload = buildOpenAICodexRequestBody(codexModel, responsesContext, options, options.sessionId) as unknown as Record<string, unknown>;
    await assert.rejects(owner.compact(codexModel, { ...payload, previous_response_id: "stale" }, options), /full.history.*previous_response_id/i);
    f.mode("output"); const active = owner.stream(codexModel, responsesContext, options);
    await nextTurn();
    await assert.rejects(owner.compact(codexModel, payload, options), /WebSocket is busy/);
    assert.equal(http, 0); assert.equal(f.sockets[0].readyState, 1);
    owner.revoke(); await owner.drain(); assert.equal((await active.result()).stopReason, "aborted");
  } finally { await owner.dispose(); f.release(); }
});

function socketsFixture() {
  const original = globalThis.WebSocket;
  const sent = deferred();
  let mode: "success" | "connecting" | "failure" | "output" = "success";
  const sockets: Socket[] = [], bodies: any[] = [];
  class Socket {
    readyState = 0;
    readonly listeners = new Map<string, Set<(event: any) => void>>();
    constructor() {
      sockets.push(this);
      queueMicrotask(() => {
        if (this.readyState === 3 || mode === "connecting") return;
        if (mode === "failure") this.emit("error", new Error("offline connection"));
        else { this.readyState = 1; this.emit("open", {}); }
      });
    }
    addEventListener(type: string, listener: (event: any) => void) {
      let set = this.listeners.get(type); if (!set) this.listeners.set(type, set = new Set()); set.add(listener);
    }
    removeEventListener(type: string, listener: (event: any) => void) { this.listeners.get(type)?.delete(listener); }
    emit(type: string, value: any) { for (const listener of this.listeners.get(type) ?? []) listener(value); }
    send(json: string) {
      const body = JSON.parse(json); bodies.push(body);
      sent.release();
      if (mode === "output") return;
      const events = body.input?.some((item: any) => item.type === "compaction_trigger") ? compactEvents : textEvents();
      queueMicrotask(() => { for (const event of events) this.emit("message", { data: JSON.stringify(event) }); });
    }
    close() { this.readyState = 3; }
  }
  globalThis.WebSocket = Socket as unknown as typeof WebSocket;
  return { sockets, bodies, sent: sent.promise, mode(value: typeof mode) { mode = value; }, release() { globalThis.WebSocket = original; } };
}

for (const laterBlob of [false, true]) test(`Codex decodes mixed WebSocket frames in arrival order; later Blob=${laterBlob}`, async () => {
  const f = socketsFixture(), owner = createOpenAICodexTransportOwner();
  const first = deferred(), second = deferred();
  f.mode("output");
  const options = { apiKey: codexToken(), sessionId: `ordered-frames-${laterBlob}`, transport: "websocket" as const, maxRetries: 0 };
  const request = owner.stream(codexModel, responsesContext, options);
  const deltas: string[] = [];
  const consumed = (async () => { for await (const event of request) if (event.type === "text_delta") deltas.push(event.delta); return request.result(); })();
  try {
    await Promise.race([f.sent, request.result().then(result => { throw new Error(`Request ended before WebSocket send: ${result.errorMessage}`); })]);
    await nextTurn();
    const socket = f.sockets[0]!, events = structuredClone(textEvents()) as any[];
    events[2].item.content[0].text = "AB";
    events[3].response.output[0].content[0].text = "AB";
    const a = new TextEncoder().encode(JSON.stringify({ ...events[1], delta: "A" })).buffer;
    const b = new TextEncoder().encode(JSON.stringify({ ...events[1], delta: "B" })).buffer;
    socket.emit("message", { data: JSON.stringify(events[0]) });
    socket.emit("message", { data: { async arrayBuffer() { await first.promise; return a; } } });
    socket.emit("message", { data: laterBlob ? { async arrayBuffer() { await second.promise; return b; } } : new TextDecoder().decode(b) });
    socket.emit("message", { data: JSON.stringify(events[2]) });
    socket.emit("message", { data: JSON.stringify(events[3]) });
    if (laterBlob) { socket.readyState = 3; socket.emit("close", { code: 1000, wasClean: true }); }
    second.release(); await nextTurn();
    assert.deepEqual(deltas, [], "later frames cannot overtake the first admitted Blob");
    first.release();
    const result = await consumed;
    assert.equal(result.stopReason, "stop", result.errorMessage);
    assert.deepEqual(deltas, ["A", "B"]);
    assert.equal(socket.listeners.get("message")?.size, 0);
    f.mode("success");
    assert.equal((await owner.stream(codexModel, responsesContext, options).result()).stopReason, "stop");
    assert.equal(f.sockets.length, laterBlob ? 2 : 1);
  } finally { first.release(); second.release(); owner.revoke(); await consumed.catch(() => {}); await owner.dispose(); f.release(); }
});

test("Codex snapshots borrowed binary buffers and reuses one decoder per request", async () => {
  const f = socketsFixture(), owner = createOpenAICodexTransportOwner(), originalDecoder = globalThis.TextDecoder;
  let decoders = 0;
  const request = owner.stream(codexModel, responsesContext, { apiKey: codexToken(), sessionId: "borrowed-buffer", transport: "websocket", maxRetries: 0 });
  const deltas: string[] = [];
  const consumed = (async () => { for await (const event of request) if (event.type === "text_delta") deltas.push(event.delta); return request.result(); })();
  f.mode("output");
  try {
    await f.sent; await nextTurn();
    globalThis.TextDecoder = class extends originalDecoder {
      constructor(...args: ConstructorParameters<typeof TextDecoder>) { super(...args); decoders++; }
    };
    const socket = f.sockets[0]!, events = structuredClone(textEvents()) as any[];
    events[2].item.content[0].text = "AB"; events[3].response.output[0].content[0].text = "AB";
    const a = new TextEncoder().encode(JSON.stringify({ ...events[1], delta: "A" }));
    const b = new TextEncoder().encode(JSON.stringify({ ...events[1], delta: "B" }));
    assert.equal(a.byteLength, b.byteLength);
    socket.emit("message", { data: JSON.stringify(events[0]) });
    socket.emit("message", { data: a }); a.set(b); socket.emit("message", { data: a });
    socket.emit("message", { data: JSON.stringify(events[2]) }); socket.emit("message", { data: JSON.stringify(events[3]) });
    assert.equal((await consumed).stopReason, "stop");
    assert.deepEqual(deltas, ["A", "B"], "borrowing a buffer must not change an earlier admitted frame");
    assert.equal(decoders, 1);
  } finally { owner.revoke(); await consumed.catch(() => {}); await owner.dispose(); globalThis.TextDecoder = originalDecoder; f.release(); }
});

test("Codex drain joins every admitted Blob after cancellation and releases listeners", async () => {
  const f = socketsFixture(), owner = createOpenAICodexTransportOwner(), a = deferred(), b = deferred();
  f.mode("output");
  const request = owner.stream(codexModel, responsesContext, { apiKey: codexToken(), sessionId: "ordered-abort", transport: "websocket", maxRetries: 0 });
  try {
    await f.sent; await nextTurn();
    const data = new TextEncoder().encode(JSON.stringify(textEvents()[0])).buffer;
    f.sockets[0]!.emit("message", { data: { async arrayBuffer() { await a.promise; return data; } } });
    f.sockets[0]!.emit("message", { data: { async arrayBuffer() { await b.promise; return data; } } });
    owner.revoke(); let settled = false;
    const draining = owner.drain().then(() => { settled = true; });
    a.release(); await nextTurn();
    assert.equal(settled, false, "the second conversion was already admitted and must be joined too");
    b.release(); await draining;
    assert.equal((await request.result()).stopReason, "aborted");
    assert.equal(owner.diagnostics.pending, 0);
    for (const set of f.sockets[0]!.listeners.values()) assert.equal(set.size, 0);
  } finally { a.release(); b.release(); owner.revoke(); await owner.dispose(); f.release(); }
});

test("Codex malformed WebSocket JSON stays a protocol error and does not trigger HTTP replay", async () => {
  const f = socketsFixture(), owner = createOpenAICodexTransportOwner(); let http = 0;
  f.mode("output");
  const request = owner.stream(codexModel, responsesContext, { apiKey: codexToken(), sessionId: "null-frame", transport: "auto", maxRetries: 0,
    fetch: (async () => { http++; throw new Error("unexpected replay"); }) as typeof fetch });
  try {
    await f.sent; await nextTurn(); f.sockets[0]!.emit("message", { data: "null" });
    const result = await request.result();
    assert.equal(result.stopReason, "error"); assert.match(result.errorMessage!, /Invalid Codex WebSocket JSON/); assert.equal(http, 0);
  } finally { owner.revoke(); await owner.dispose(); f.release(); }
});

test("Codex idle timeout covers an admitted Blob and joins conversion before settling", { timeout: 5000 }, async () => {
  const f = socketsFixture(), owner = createOpenAICodexTransportOwner(), gate = deferred();
  let http = 0;
  f.mode("output");
  const options = { apiKey: codexToken(), sessionId: "blob-idle-timeout", transport: "websocket" as const, timeoutMs: 40, maxRetries: 0,
    fetch: (async () => { http++; return new Response(sseFrames(textEvents()), { headers: { "content-type": "text/event-stream" } }); }) as typeof fetch };
  const request = owner.stream(codexModel, responsesContext, options);
  try {
    await f.sent; await nextTurn();
	f.sockets[0]!.emit("message", { data: JSON.stringify(textEvents()[0]) }); await nextTurn();
    f.sockets[0]!.emit("message", { data: { async arrayBuffer() { await gate.promise; return new TextEncoder().encode(JSON.stringify(textEvents()[0])).buffer; } } });
    await delay(100);
    assert.equal(f.sockets[0]!.readyState, 3, "idle timeout must still close a connection during conversion");
    assert.equal(owner.diagnostics.pending, 1, "already-started conversion remains owned until joined");
    gate.release();
    const result = await request.result();
    assert.equal(result.stopReason, "error"); assert.match(result.errorMessage!, /WebSocket idle timeout/);
    assert.equal(http, 0, "a started request is never replayed after timeout");
    f.mode("success");
    assert.equal((await owner.stream(codexModel, responsesContext, options).result()).stopReason, "stop");
    assert.equal(http, 1, "the next request follows the existing session fallback");
  } finally { gate.release(); owner.revoke(); await owner.dispose(); f.release(); }
});

test("Codex handles a later rejected Blob while an earlier conversion is pending", { timeout: 5000 }, async () => {
  const f = socketsFixture(), owner = createOpenAICodexTransportOwner(), gate = deferred();
  f.mode("output");
  const options = { apiKey: codexToken(), sessionId: "rejected-blob", transport: "auto" as const, maxRetries: 0,
    fetch: (async () => { throw new Error("unexpected HTTP replay"); }) as typeof fetch };
  const request = owner.stream(codexModel, responsesContext, options);
  try {
    await f.sent; await nextTurn();
    f.sockets[0]!.emit("message", { data: { async arrayBuffer() { await gate.promise; return new TextEncoder().encode(JSON.stringify(textEvents()[0])).buffer; } } });
    f.sockets[0]!.emit("message", { data: { async arrayBuffer() { throw new Error("conversion failed"); } } });
    await nextTurn(); gate.release();
    const result = await request.result();
    assert.equal(result.stopReason, "error"); assert.match(result.errorMessage!, /Invalid Codex WebSocket data: conversion failed/);
	owner.revoke(); await owner.drain(); owner.resume();
    assert.equal(owner.diagnostics.pending, 0);
    for (const listeners of f.sockets[0]!.listeners.values()) assert.equal(listeners.size, 0);
    f.mode("success");
    assert.equal((await owner.stream(codexModel, responsesContext, options).result()).stopReason, "stop");
  } finally { gate.release(); owner.revoke(); await owner.dispose(); f.release(); }
});

test("Codex explicit owners isolate same-ID connections, fallback, commitments and legacy cleanup", { timeout: 5000 }, async () => {
  const f = socketsFixture(), left = createOpenAICodexTransportOwner(), right = createOpenAICodexTransportOwner();
  const options = { apiKey: codexToken(), sessionId: "same-codex-owner", transport: "auto" as const, maxRetries: 0, codexRemoteCompaction: true,
    fetch: (async () => new Response(sseFrames(textEvents()), { headers: { "content-type": "text/event-stream" } })) as typeof fetch };
  try {
    const first = await left.stream(codexModel, responsesContext, options).result();
    const second = await right.stream(codexModel, responsesContext, options).result();
    assert.equal(first.stopReason, "stop"); assert.equal(second.stopReason, "stop");
    assert.equal(f.sockets.length, 2);
    cleanupSessionResources();
    assert.equal(left.diagnostics.cached, 1); assert.equal(right.diagnostics.commitments, 1);
    const unchanged = right.getDebugStats(options.sessionId);
    left.reset(); await left.drain(); left.resume(); f.mode("failure");
    assert.equal((await left.stream(codexModel, responsesContext, options).result()).stopReason, "stop");
    assert.equal(left.diagnostics.fallbacks, 1); assert.equal(right.diagnostics.fallbacks, 0);
    assert.deepEqual(right.getDebugStats(options.sessionId), unchanged);
    f.mode("success");
    const legacy = await stream(codexModel, responsesContext, options).result();
    await left.dispose();
    assert.deepEqual((await right.compact(codexModel, payloadAfter(second, options), options)).compactionItem, artifact);
    assert.deepEqual((await compactOpenAICodexRequest(codexModel, payloadAfter(legacy, options), options)).compactionItem, artifact);
    assert.equal(right.diagnostics.consumed, 1);
    await right.dispose();
    assert.deepEqual(left.diagnostics, { pending: 0, sockets: 0, cached: 0, timers: 0, commitments: 0, consumed: 0, debug: 0, fallbacks: 0 });
    assert.deepEqual(right.diagnostics, left.diagnostics);
    assert.throws(() => right.resume(), /disposed/);
  } finally {
    await left.dispose(); await right.dispose(); closeOpenAICodexWebSocketSessions(); resetOpenAICodexWebSocketDebugStats(); f.release();
  }
});

test("Codex owner drains hooks, connecting and temporary sockets, SSE and WS compaction without late writes", { timeout: 5000 }, async () => {
  const f = socketsFixture(), owner = createOpenAICodexTransportOwner(), caller = new AbortController();
  let http = 0;
  const options = { apiKey: codexToken(), sessionId: "owner-lifecycle", transport: "auto" as const, signal: caller.signal,
    maxRetries: 0, codexRemoteCompaction: true, fetch: (async () => { http++; throw new Error("unexpected fallback"); }) as typeof fetch };
  try {
    const entered = deferred(), hook = deferred();
    const waiting = owner.stream(codexModel, responsesContext, { ...options, onPayload: async () => { entered.release(); await hook.promise; } });
    await entered.promise; owner.revoke(); let settled = false;
    const drain = owner.drain().then(() => { settled = true; }); await nextTurn(); assert.equal(settled, false);
    hook.release(); await drain; assert.equal((await waiting.result()).stopReason, "aborted"); assert.equal(f.bodies.length, 0);
    owner.resume(); f.mode("connecting");
    const connecting = owner.stream(codexModel, responsesContext, options);
    await nextTurn(); assert.equal(owner.diagnostics.sockets, 1);
    owner.revoke(); await owner.drain(); assert.equal((await connecting.result()).stopReason, "aborted");
    owner.resume(); f.mode("success");
    assert.equal((await owner.stream(codexModel, responsesContext, options).result()).stopReason, "stop");
    f.mode("output");
    const busy = owner.stream(codexModel, responsesContext, options);
    await nextTurn();
    const temporary = owner.stream(codexModel, responsesContext, options);
    const noId = owner.stream(codexModel, responsesContext, { ...options, sessionId: undefined });
    await nextTurn(); assert.equal(owner.diagnostics.sockets, 3);
    owner.revoke(); await owner.drain();
    for (const active of [busy, temporary, noId]) assert.equal((await active.result()).stopReason, "aborted");
    assert.equal(http, 0);
    owner.resume(); f.mode("success");
    const regular = await owner.stream(codexModel, responsesContext, options).result();
    f.mode("output"); const compact = owner.compact(codexModel, payloadAfter(regular, options), options);
    const failedCompact = assert.rejects(compact, /abort/); await nextTurn();
    const decoding = deferred(), decoded = deferred();
    f.sockets.at(-1)!.emit("message", { data: { async arrayBuffer() {
      decoding.release(); await decoded.promise;
      return new TextEncoder().encode(JSON.stringify(compactEvents.at(-1))).buffer;
    } } });
    await decoding.promise; owner.revoke(); settled = false;
    const decodeDrain = owner.drain().then(() => { settled = true; }); await nextTurn();
    assert.equal(settled, false, "drain must join a Blob conversion already in progress");
    assert.equal(owner.diagnostics.pending, 1);
    decoded.release(); await decodeDrain; await failedCompact;
    assert.equal(owner.diagnostics.commitments, 0); assert.equal(owner.diagnostics.consumed, 0);
    owner.resume();
    const sseOptions = { ...options, transport: "sse" as const,
      fetch: (async () => new Response(sseFrames(textEvents()), { headers: { "content-type": "text/event-stream" } })) as typeof fetch };
    const sseRegular = await owner.stream(codexModel, responsesContext, sseOptions).result();
    const compactEntered = deferred(), compactHook = deferred();
    const delayedCompact = owner.compact(codexModel, payloadAfter(sseRegular, sseOptions), { ...sseOptions,
      fetch: async () => new Response(sseFrames(compactEvents), { headers: { "content-type": "text/event-stream" } }),
      onResponse: async () => { compactEntered.release(); await compactHook.promise; } });
    await compactEntered.promise;
    assert.equal((await owner.stream(codexModel, responsesContext, sseOptions).result()).stopReason, "stop");
    compactHook.release(); await delayedCompact;
    assert.equal(owner.diagnostics.commitments, 1, "late compaction cannot consume a newer successful request");
    assert.equal(owner.diagnostics.consumed, 0);
    const reading = deferred(); let cancelledBody = false;
    const bodyStream = owner.stream(codexModel, responsesContext, { ...sseOptions, fetch: async () => new Response(new ReadableStream<Uint8Array>({
      pull() { reading.release(); }, cancel() { cancelledBody = true; },
    }), { headers: { "content-type": "text/event-stream" } }) });
    await reading.promise; await nextTurn(); owner.revoke(); await owner.drain();
    assert.equal((await bodyStream.result()).stopReason, "aborted"); assert.equal(cancelledBody, true);
    owner.resume();
    const erroredBody = owner.stream(codexModel, responsesContext, { ...sseOptions,
      fetch: async () => new Response(new ReadableStream<Uint8Array>({ start(controller) { controller.error(new DOMException("fetch aborted", "AbortError")); } }),
        { headers: { "content-type": "text/event-stream" } }),
      onResponse: () => { owner.revoke(); } });
    assert.equal((await erroredBody.result()).stopReason, "aborted"); await owner.drain();
    owner.resume(); const responseEntered = deferred(), responseHook = deferred(), cancelling = deferred(), cancelled = deferred();
    const sse = owner.stream(codexModel, responsesContext, { ...options, transport: "sse",
      timeoutMs: 5000,
      fetch: async () => new Response(new ReadableStream<Uint8Array>({ cancel() { cancelling.release(); return cancelled.promise; } }),
        { headers: { "content-type": "text/event-stream" } }),
      onResponse: async () => { responseEntered.release(); await responseHook.promise; } });
    await responseEntered.promise; settled = false;
    const disposal = owner.dispose().then(() => { settled = true; }); await nextTurn(); assert.equal(settled, false);
    responseHook.release(); await cancelling.promise; await nextTurn(); assert.equal(settled, false, "body cancellation must really settle");
    cancelled.release(); await disposal; assert.equal((await sse.result()).stopReason, "aborted");
    assert.equal(getEventListeners(caller.signal, "abort").length, 0);
    for (const socket of f.sockets) {
      assert.equal(socket.readyState, 3);
      for (const listeners of socket.listeners.values()) assert.equal(listeners.size, 0);
    }
    assert.deepEqual(owner.diagnostics, { pending: 0, sockets: 0, cached: 0, timers: 0, commitments: 0, consumed: 0, debug: 0, fallbacks: 0 });
    const failedOwner = createOpenAICodexTransportOwner();
    const failed = failedOwner.stream(codexModel, responsesContext, { ...sseOptions,
      fetch: async () => new Response(new ReadableStream<Uint8Array>({ cancel() { throw new Error("synthetic cancel failure"); } }),
        { headers: { "content-type": "text/event-stream" } }), onResponse() { throw new Error("hook failed"); } });
    assert.equal((await failed.result()).stopReason, "error");
    await assert.rejects(failedOwner.dispose(), /synthetic cancel failure/);
  } finally { await owner.dispose(); f.release(); }
});
