import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import zlib from "node:zlib";
import { EventEmitter, getEventListeners } from "node:events";
import { setImmediate as nextTurn } from "node:timers/promises";
import { InMemoryCredentialStore } from "../../packages/ai/src/auth/credential-store.ts";
import { openaiCodexOAuth } from "../../packages/ai/src/auth/oauth/openai-codex.ts";
import { stream as streamResponses } from "../../packages/ai/src/api/openai-responses.ts";
import { resolveProviderAuth } from "../../packages/ai/src/auth/resolve.ts";
import extension from "../../packages/openai-server-compaction/src/index.ts";
import fastExtension from "../../packages/openai-fast-mode/src/index.ts";
import { fastModeConfigPath, saveFastModeConfig } from "../../packages/openai-fast-mode/src/config.ts";
import { createProviderAwareCompactionExtension } from "../../packages/provider-aware-compaction/src/index.ts";
import { DefaultResourceLoader } from "../../packages/coding-agent/src/core/resource-loader.ts";
import { createAgentSession } from "../../packages/coding-agent/src/core/sdk.ts";
import { AgentSessionRuntime } from "../../packages/coding-agent/src/core/agent-session-runtime.ts";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.ts";
import { SettingsManager } from "../../packages/coding-agent/src/core/settings-manager.ts";
import { ModelRuntime } from "../../packages/coding-agent/src/core/model-runtime.ts";
import { generateSummary, generateBranchSummary } from "../../packages/coding-agent/src/core/compaction/index.ts";
import { responsesUsage, sseFrames, textEvents } from "../helpers/responses-sse-fixture.ts";
import { FakeCodexWebSocket } from "../helpers/codex-websocket-fixture.ts";
import { createOpenAIResponsesOwner } from "../../packages/openai-server-compaction/src/custom-stream.ts";
import { loadConfig } from "../../packages/openai-server-compaction/src/config.ts";
// Match the SDK's module instance when checking its legacy compatibility domain.
import { stream as legacyCodexStream, compactOpenAICodexRequest, buildOpenAICodexRequestBody } from "@super-pi/ai/api/openai-codex-responses";
import { cleanupSessionResources } from "@super-pi/ai";
import { createAssistantMessageEventStream } from "@super-pi/ai";
import { getApiProvider, registerApiProvider, registerBuiltInApiProviders } from "@super-pi/ai/compat";

const token = (account = "one", generation = 1) => `header.${Buffer.from(JSON.stringify({ sub: "user", generation,
  "https://api.openai.com/auth": { chatgpt_account_id: account } })).toString("base64url")}.signature`;
const artifact = { type: "compaction", encrypted_content: "OPAQUE_LIFECYCLE_SENTINEL" };
const response = (events: unknown[]) => new Response(sseFrames(events), { headers: { "content-type": "text/event-stream" } });

test("Responses owners isolate identical session IDs and join revoked connect, hooks, warmup and transports", { timeout: 5000 }, async () => {
  const deferred = () => { let release!: () => void; const promise = new Promise<void>(r => { release = r; }); return { promise, release }; };
  const connect = deferred(), connecting = deferred();
  let hold = false, sent = deferred(), hooks = 0, http = 0;
  const sockets: Socket[] = [];
  class Socket extends EventEmitter {
    readyState = 1;
    send() { sent.release(); if (!hold) queueMicrotask(() => { for (const e of textEvents()) this.emit("message", JSON.stringify(e)); }); }
    close() { this.readyState = 3; }
    terminate() { this.close(); }
  }
  let first = true;
  const left = createOpenAIResponsesOwner({ socketFactory: async () => {
    if (first) { first = false; connecting.release(); await connect.promise; }
    const socket = new Socket(); sockets.push(socket); return socket;
  } });
  const right = createOpenAIResponsesOwner({ socketFactory: async () => { const socket = new Socket(); sockets.push(socket); return socket; } });
  const sessionId = "same-id-two-owners", caller = new AbortController();
  const config = { ...loadConfig(), enabled: true, usePreviousResponseId: true };
  const model: any = { id: "gpt-5.1", api: "openai-responses", provider: "openai", baseUrl: "https://api.openai.com/v1",
    input: ["text"], reasoning: false, contextWindow: 64000, maxTokens: 512, cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } };
  const context: any = { messages: [{ role: "user", content: "fixture", timestamp: 1 }] };
  const options = { sessionId, apiKey: "offline", transport: "auto" as const, signal: caller.signal, maxRetries: 0, onPayload: () => { hooks++; } };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => { http++; throw new Error("unexpected SSE fallback"); }) as typeof fetch;
  try {
    const marker = {};
    for (const owner of [left, right]) {
      owner.state.setSessionConfig(sessionId, config);
      owner.state.setRemoteCompactionState(sessionId, { modelKey: "marker", explicitHistory: [] } as any);
      owner.state.setResponsesRequestShapeState(sessionId, { updatedAt: 1, serviceTier: "priority" });
      assert.equal(owner.state.markMessageProcessed(sessionId, marker), true);
      assert.equal(owner.state.claimCompactionContinuation(sessionId, "same-entry"), true);
    }
    const active = left.streamSimple(model, context, options), queued = left.streamSimple(model, context, options);
    await connecting.promise;
    assert.equal((await right.streamSimple(model, context, options).result()).stopReason, "stop");
    assert.equal(left.pendingRequests, 2); assert.equal(left.queuedSessions, 1);
    left.revoke(); let drained = false;
    const drain = left.drain().then(() => { drained = true; });
    await nextTurn(); assert.equal(drained, false, "close alone cannot settle a pending socket factory");
    assert.throws(() => left.resume(), /draining/);
    assert.throws(() => left.streamSimple(model, context, options), /revoked/);
    connect.release(); await drain;
    assert.equal((await active.result()).stopReason, "aborted");
    assert.equal((await queued.result()).stopReason, "aborted");
    assert.equal(hooks, 1, "revoked queued work never reaches the hook");
    assert.equal(left.state.getContinuationState(sessionId), undefined);
    assert.ok(right.state.getContinuationState(sessionId));
    assert.ok(left.state.getRemoteCompactionState(sessionId), "live refresh keeps opaque history");
    assert.equal(left.state.getSessionConfig(sessionId), config);

    left.resume(); const entered = deferred(), payload = deferred();
    const hooked = left.streamSimple(model, context, { ...options, onPayload: async () => { entered.release(); await payload.promise; } });
    await entered.promise; left.revoke(); drained = false;
    const hookDrain = left.drain().then(() => { drained = true; });
    await nextTurn(); assert.equal(drained, false, "the owner joins the real hook completion");
    payload.release(); await hookDrain; assert.equal((await hooked.result()).stopReason, "aborted");
    assert.equal(http, 0, "revocation never falls through to SSE");

    hold = true;
    for (const warmup of [true, false]) {
      left.resume(); sent = deferred();
      const waiting = left.streamSimple(model, context, { ...options, openaiWsWarmup: warmup } as any);
      await sent.promise; left.revoke(); await left.drain();
      assert.equal((await waiting.result()).stopReason, "aborted");
    }
    const fetching = deferred();
    globalThis.fetch = (async (_url: unknown, init: any) => {
      http++; fetching.release();
      return await new Promise<Response>((_resolve, reject) => {
        const abort = () => reject(new DOMException("aborted", "AbortError"));
        if (init.signal.aborted) abort(); else init.signal.addEventListener("abort", abort, { once: true });
      });
    }) as typeof fetch;
    let reentrant: Promise<void> | undefined;
    left.resume(); const sse = left.streamSimple(model, context, { ...options, transport: "sse", onPayload: (_payload, _model, request) => {
      (request as { signal?: AbortSignal } | undefined)?.signal?.addEventListener("abort", () => { reentrant = left.dispose(); }, { once: true });
    } });
    await fetching.promise; const disposal = left.dispose(); await disposal;
    assert.equal(reentrant, disposal); assert.equal((await sse.result()).stopReason, "aborted");
    assert.equal(http, 1); assert.throws(() => left.resume(), /disposed/);
    assert.equal(left.state.getRemoteCompactionState(sessionId), undefined);
    assert.equal(left.state.getResponsesRequestShapeState(sessionId), undefined);
    assert.equal(left.state.getSessionConfig(sessionId), undefined);
    assert.equal(left.state.entryCount, 0);
    assert.throws(() => left.state.markMessageProcessed(sessionId, marker), /disposed/);
    assert.throws(() => left.state.claimCompactionContinuation(sessionId, "same-entry"), /disposed/);
    assert.throws(() => left.state.setContinuationState(sessionId, { responseId: "late", modelKey: "late", updatedAt: 1 }), /disposed/);
    assert.equal(left.state.entryCount, 0);
    assert.equal(right.state.markMessageProcessed(sessionId, marker), false);
    assert.equal(right.state.claimCompactionContinuation(sessionId, "same-entry"), false);
    assert.ok(right.state.getRemoteCompactionState(sessionId));
    hold = false;
    assert.equal((await right.streamSimple(model, context, options).result()).stopReason, "stop");
    await right.dispose();
    for (const owner of [left, right]) assert.deepEqual([owner.pendingRequests, owner.queuedSessions, owner.connections], [0, 0, 0]);
    assert.equal(getEventListeners(caller.signal, "abort").length, 0);
    for (const socket of sockets) { assert.equal(socket.readyState, 3); assert.deepEqual(socket.eventNames(), []); }
  } finally { connect.release(); await left.dispose(); await right.dispose(); globalThis.fetch = originalFetch; }
});

test("SDK shutdown joins the bound Responses owner and reports disposal failure", { timeout: 5000 }, async () => {
  for (const fail of [false, true]) {
    let enter!: () => void, release!: () => void, api: any, disposals = 0, revoked = false;
    const entered = new Promise<void>(r => { enter = r; });
    const gate = new Promise<void>(r => { release = r; });
    const owner = { revoke() { revoked = true; }, async drain() { await gate; }, async dispose() {
      disposals++; enter(); await gate; if (fail) throw new Error("synthetic owner disposal failure");
    } };
    const f = await fixture(false, undefined, "gpt-5.1", { compactionExtension: pi => {
      api = pi; pi.on("session_start", () => pi.setOpenAIResponsesStream(streamResponses, owner));
    } });
    let codexEnter!: () => void, codexRelease!: () => void;
    const codexEntered = new Promise<void>(r => { codexEnter = r; });
    const codexGate = new Promise<void>(r => { codexRelease = r; });
    try {
      assert.throws(() => api.setOpenAIResponsesStream(streamResponses), /omitted/);
      assert.throws(() => api.setOpenAIResponsesStream(streamResponses, { ...owner }), /replaced/);
      const binding = f.session.extensionRunner.getOpenAIResponsesDispatch();
      assert.throws(() => api.setOpenAIResponsesStream("invalid", owner), /function/);
      assert.equal(f.session.extensionRunner.getOpenAIResponsesDispatch(), binding);
      api.setOpenAIResponsesStream(undefined);
      assert.throws(() => api.setOpenAIResponsesStream(streamResponses), /omitted/);
      api.setOpenAIResponsesStream(streamResponses, owner);
      const codexRequest = tokenOwner(f).streamSimple({ ...f.model, api: "openai-codex-responses", provider: "openai-codex" },
        { messages: [{ role: "user", content: "owned shutdown", timestamp: 1 }] },
        { apiKey: token(), transport: "sse", maxRetries: 0, onPayload: async () => { codexEnter(); await codexGate; } }).result();
      await codexEntered;
      let settled = false;
      const disposal = f.sessionRuntime.dispose();
      void disposal.then(() => { settled = true; }, () => { settled = true; });
      await entered; await nextTurn(); assert.equal(settled, false); assert.equal(revoked, true);
      release(); await nextTurn(); assert.equal(settled, false, "shutdown must still join the native Codex hook after Responses settles");
      codexRelease(); assert.equal((await codexRequest).stopReason, "aborted");
      if (fail) await assert.rejects(disposal, /synthetic owner disposal failure/); else await disposal;
      for (const count of Object.values(tokenOwner(f).diagnostics)) assert.equal(count, 0, "Codex cleanup also completes when the other owner fails");
      assert.equal(disposals, 1, "invalidation joins the same terminal operation");
      assert.throws(() => api.setOpenAIResponsesStream(streamResponses, owner), /stale/);
    } finally {
      release(); codexRelease();
      if (fail) await assert.rejects(f.release(), /synthetic owner disposal failure/); else await f.release();
    }
  }
});

test("Responses runtime dispatch preserves prepared Provider source and revocation", { timeout: 5000 }, async () => {
  let api: any, ownedCalls = 0, customCalls = 0, authCalls = 0;
  let switchInHook = false, switched = false;
  const f = await fixture(false, undefined, "gpt-5.1", { compactionExtension: pi => { api = pi; extension(pi); }, previewHooks: pi => {
    pi.on("before_provider_request", async () => {
      if (!switchInHook) return;
      switchInHook = false;
      assert.equal(await pi.setModel({ ...f.model, id: "gpt-5.2" }), true);
      switched = true;
    });
  } });
  const base = f.session.extensionRunner.getOpenAIResponsesDispatch()!.streamSimple;
  const owned = (...args: Parameters<typeof base>) => { ownedCalls++; return base(...args); };
  const custom = (...args: Parameters<typeof base>) => { customCalls++; return streamResponses(...args as Parameters<typeof streamResponses>); };
  const input = { messages: [{ role: "user" as const, content: "fixture", timestamp: 1 }] };
  const options = { transport: "sse" as const, sessionId: f.manager.getSessionId(), maxRetries: 0 };
  const result = async () => f.runtime.streamSimple(f.model, input, options, undefined, f.session.extensionRunner.getOpenAIResponsesDispatch()).result();
  try {
    assert.deepEqual(f.runtime.getRegisteredProviderIds(), [], "compaction must not register a Provider");
    api.setOpenAIResponsesStream(owned, (f.session as any)._resourceLoader.getExtensions().runtime.openAIResponsesOwner);
    f.setAuthResolver(async () => { authCalls++; return { auth: { apiKey: "prepared-synthetic", baseUrl: "https://api.openai.com/selected",
      headers: { "OpenAI-Project": null, "x-fixture-auth": "prepared" } }, env: { FIXTURE: "true" }, source: "api_key" }; });
    await f.session.prompt("SDK owned dispatch");
    assert.equal(ownedCalls, 1); assert.equal(authCalls, 1); assert.equal(f.headerCalls, 1);
    assert.equal(f.requests.at(-1)!.authorization, "Bearer prepared-synthetic");
    assert.equal(f.requests.at(-1)!.headers.get("x-fixture-auth"), "prepared");
    assert.match(f.requests.at(-1)!.url, /\/selected\/responses$/);
    f.runtime.registerProvider("openai", { headers: { "x-metadata-only": "allowed" } });
    assert.equal((await result()).stopReason, "stop"); assert.equal(ownedCalls, 2, "metadata-only registrations do not replace transport");
    f.runtime.registerProvider("openai", { api: "openai-responses", streamSimple: custom });
    assert.equal((await result()).stopReason, "stop"); assert.equal(customCalls, 1); assert.equal(ownedCalls, 2);
    api.setOpenAIResponsesStream(owned, (f.session as any)._resourceLoader.getExtensions().runtime.openAIResponsesOwner);
    assert.equal((await result()).stopReason, "stop"); assert.equal(customCalls, 2, "install order does not overwrite user transport");
    f.runtime.registerNativeProvider({ id: "openai", name: "user-native", auth: {}, getModels: () => [f.model], stream: custom, streamSimple: custom } as any);
    assert.equal((await result()).stopReason, "stop"); assert.equal(customCalls, 3, "native custom Provider wins");
    for (const initialCustom of [true, false]) {
      if (!initialCustom) f.runtime.unregisterProvider("openai");
      let enter = () => {}, release = () => {};
      const entered = new Promise<void>(resolve => { enter = resolve; });
      const gate = new Promise<void>(resolve => { release = resolve; });
      f.setAuthResolver(async () => { enter(); await gate; return { auth: { apiKey: "prepared-synthetic" }, source: "api_key" }; });
      const beforeOwned: number = ownedCalls, beforeCustom: number = customCalls;
      const pending = result(); await entered;
      if (initialCustom) f.runtime.unregisterProvider("openai");
      else f.runtime.registerProvider("openai", { api: "openai-responses", streamSimple: custom });
      release(); assert.equal((await pending).stopReason, "stop");
      assert.equal(ownedCalls, beforeOwned + (initialCustom ? 0 : 1));
      assert.equal(customCalls, beforeCustom + (initialCustom ? 1 : 0), "source remains bound to captured Provider during auth");
    }
    f.runtime.unregisterProvider("openai");
    const dispatch = f.session.extensionRunner.getOpenAIResponsesDispatch()!;
    const before = f.requests.length;
    f.setAuthResolver(async () => { api.setOpenAIResponsesStream(undefined); return { auth: { apiKey: "synthetic" }, source: "api_key" }; });
    const stale = await f.runtime.streamSimple(f.model, input, options, undefined, dispatch).result();
    assert.equal(stale.stopReason, "error"); assert.match(stale.errorMessage!, /stale runtime installation/);
    assert.equal(f.requests.length, before, "revocation cannot fall through to another transport");
    f.setAuthResolver(async () => ({ auth: { apiKey: "synthetic" }, source: "api_key" }));
    f.runtime.registerProvider("openai", { api: "openai-responses", streamSimple: custom });
    const customAfterRevoke: number = customCalls;
    assert.equal((await f.runtime.streamSimple(f.model, input, options, undefined, dispatch).result()).stopReason, "stop");
    assert.equal(customCalls, customAfterRevoke + 1, "an unused revoked adapter cannot block a custom Provider");
    f.runtime.unregisterProvider("openai");
    const count = ownedCalls;
    assert.equal((await result()).stopReason, "stop"); assert.equal(ownedCalls, count, "no publisher retains the ordinary Provider");
    const transportOwner = (f.session as any)._resourceLoader.getExtensions().runtime.openAIResponsesOwner;
    api.setOpenAIResponsesStream(owned, transportOwner);
    const beforeSwitch = f.requests.length;
    switchInHook = true;
    await f.session.prompt("switch inside payload hook");
    assert.equal(switched, true, "model_select cannot wait for its containing request");
    assert.equal(f.requests.length, beforeSwitch, "the revoked old model request never reaches transport");
    await transportOwner.drain();
    assert.equal(transportOwner.state.getContinuationState(f.manager.getSessionId()), undefined);
    assert.equal(transportOwner.state.getResponsesRequestShapeState(f.manager.getSessionId()), undefined);
    await f.session.prompt("new model after revoked request");
    assert.equal(f.requests.at(-1)!.payload.model, "gpt-5.2");
  } finally { await f.release(); }
});

test("Codex intent belongs to the SDK runtime across preview, transitions and disposal", async () => {
  const key = Symbol.for("@super-pi/ai/codex-remote-compaction-sessions");
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, key);
  const oldEnabled = process.env.SP_OPENAI_SERVER_COMPACTION_ENABLED;
  const originalFetch = globalThis.fetch;
  Object.defineProperty(globalThis, key, { configurable: true, get() { throw new Error("retired registry read"); }, set() { throw new Error("retired registry write"); } });
  process.env.SP_OPENAI_SERVER_COMPACTION_ENABLED = "true";
  let api: any, otherApi: any, flipOnHeader = false, treeCleared = 0, shutdownCleared = 0;
  const hookErrors: unknown[] = [];
  let first: Awaited<ReturnType<typeof fixture>> | undefined, second: Awaited<ReturnType<typeof fixture>> | undefined;
  const owner = (f: Awaited<ReturnType<typeof fixture>>) => (f.session as any)._resourceLoader.getExtensions().runtime;
  const enabledHeader = (f: Awaited<ReturnType<typeof fixture>>) => f.requests.at(-1)!.headers.get("x-codex-beta-features")?.includes("remote_compaction_v2") ?? false;
  try {
    first = await fixture(true, undefined, "gpt-5.1", { compactionExtension: pi => {
      api = pi; extension(pi);
      pi.on("session_before_tree", () => { assert.equal(owner(first!).codexRemoteCompactionEnabled, false); treeCleared++; });
      pi.on("session_shutdown", () => { assert.equal(owner(first!).codexRemoteCompactionEnabled, false); shutdownCleared++; });
      pi.on("before_provider_headers", () => { if (flipOnHeader) { flipOnHeader = false; pi.setCodexRemoteCompactionEnabled(false); } });
    } });
    // A mode binding makes reload re-emit session_start, as in the interactive host.
    await first.session.bindExtensions({ onError: error => { hookErrors.push(error); } });
    const firstFetch = globalThis.fetch;
    assert.equal(owner(first).codexRemoteCompactionEnabled, true, "extension config retains enabled default");
    assert.throws(() => api.setCodexRemoteCompactionEnabled("true"), /boolean/);
    api.setCodexRemoteCompactionEnabled(false);
    const count = first.requests.length;
    const preview = await first.session.buildProviderRequestPayload({ systemPrompt: "fixture", messages: [] });
    assert.ok(preview); assert.equal(first.requests.length, count);
    assert.equal(owner(first).codexRemoteCompactionEnabled, false, "preview does not publish intent");
    assert.equal(Object.hasOwn(preview, "codexRemoteCompaction"), false);
    api.setCodexRemoteCompactionEnabled(true); flipOnHeader = true;
    await first.session.prompt("captured before header hook");
    assert.equal(enabledHeader(first), true, "one request captures its intent before asynchronous header work");
    await first.session.prompt("next request uses updated intent"); assert.equal(enabledHeader(first), false);
    api.setCodexRemoteCompactionEnabled(true);
    second = await fixture(true, undefined, "gpt-5.1", { compactionExtension: pi => { otherApi = pi; } });
    const secondFetch = globalThis.fetch;
    assert.equal(owner(second).codexRemoteCompactionEnabled, false, "runtime without publisher defaults to false");
    await second.session.prompt("independent disabled owner"); assert.equal(enabledHeader(second), false);
    assert.equal(owner(first).codexRemoteCompactionEnabled, true);
    otherApi.setCodexRemoteCompactionEnabled(true);
    globalThis.fetch = firstFetch;
    const beforeTree = first.manager.getEntries().find(entry => entry.type === "message")!.id;
    await first.session.navigateTree(beforeTree);
    assert.equal(treeCleared, 1); assert.equal(owner(first).codexRemoteCompactionEnabled, true);
    for (const transition of ["reload", "switch", "fork"] as const) {
      const oldApi = api, oldOwner = owner(first);
      if (transition === "reload") await first.session.reload();
      else if (transition === "switch") await first.sessionRuntime.switchSession(first.manager.getSessionFile()!);
      else await first.sessionRuntime.fork(first.manager.getEntries().find(entry => entry.type === "message")!.id, { position: "at" });
      assert.equal(oldOwner.codexRemoteCompactionEnabled, false, transition);
      assert.throws(() => oldApi.setCodexRemoteCompactionEnabled(true), /stale/, transition);
      assert.equal(owner(first).codexRemoteCompactionEnabled, true, transition);
      await first.session.prompt(`intent after ${transition}`); assert.equal(enabledHeader(first), true);
    }
    const oldOwner = owner(first), oldApi = api;
    await first.release();
    assert.equal(oldOwner.codexRemoteCompactionEnabled, false);
    assert.throws(() => oldApi.setCodexRemoteCompactionEnabled(true), /stale/);
    assert.ok(shutdownCleared >= 4);
    assert.equal(owner(second).codexRemoteCompactionEnabled, true, "disposing one owner cannot revoke another");
    globalThis.fetch = secondFetch;
    await second.session.prompt("surviving enabled owner"); assert.equal(enabledHeader(second), true);
    const otherOwner = owner(second);
    await second.release();
    assert.equal(otherOwner.codexRemoteCompactionEnabled, false, "invalidate resets even without a shutdown publisher");
    assert.throws(() => otherApi.setCodexRemoteCompactionEnabled(true), /stale/);
    assert.deepEqual(hookErrors, []);
  } finally {
    try { if (second) await second.release(); if (first) await first.release(); }
    finally {
      globalThis.fetch = originalFetch;
      if (oldEnabled === undefined) delete process.env.SP_OPENAI_SERVER_COMPACTION_ENABLED; else process.env.SP_OPENAI_SERVER_COMPACTION_ENABLED = oldEnabled;
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
    }
  }
});

test("direct Responses WebSocket uses the configured endpoint and effective routing headers", async () => {
  const connections: Array<{ url: string; headers: Record<string, string> }> = [];
  const bodies: any[] = [];
  let reportedTier: string | undefined = "fast";
  let mutablePayload: any;
  const eventsForRequest = () => {
    const events: any[] = structuredClone(textEvents());
    events.at(-1).response.service_tier = reportedTier;
    events.at(-1).response.usage = { input_tokens: 1000000, output_tokens: 1000000, total_tokens: 2000000 };
    if (mutablePayload) mutablePayload.service_tier = "flex";
    return events;
  };
  const originalFetch = globalThis.fetch;
  class Socket extends EventEmitter {
    readyState = 1;
    send(body: string) { bodies.push(JSON.parse(body)); queueMicrotask(() => {
      for (const event of eventsForRequest()) this.emit("message", JSON.stringify(event));
    }); }
    close() { this.readyState = 3; }
    terminate() { this.close(); }
  }
  const owner = createOpenAIResponsesOwner({ socketFactory: async (url, options) => {
    connections.push({ url, headers: options.headers }); return new Socket();
  } });
  const stream = owner.streamSimple;
  const model: any = { id: "gpt-5.1", api: "openai-responses", provider: "openai", baseUrl: "https://api.openai.com/custom",
    headers: { "OpenAI-Project": "old-project" }, input: ["text"], reasoning: false, contextWindow: 64000, maxTokens: 512,
    cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } };
  const context: any = { messages: [{ role: "user", content: "hello", timestamp: 1 }] };
  try {
    const result = await stream(model, context, { sessionId: "audit-direct-ws", apiKey: "offline", transport: "websocket",
      headers: { "OpenAI-Project": null, "OpenAI-Organization": "org-synthetic" } }).result();
    assert.equal(result.stopReason, "stop", result.errorMessage);
    assert.equal(result.usage.cost.total, 4, "actual Fast response prices the direct API WebSocket once");
    assert.equal(bodies.length, 1);
    assert.equal(connections.length, 1);
    assert.equal(connections[0].url, "wss://api.openai.com/custom/responses");
    assert.equal(new Headers(connections[0].headers).get("openai-project"), null);
    assert.equal(new Headers(connections[0].headers).get("openai-organization"), "org-synthetic");
    reportedTier = "default";
    const servedDefault = await stream(model, context, { sessionId: "audit-direct-ws", apiKey: "offline", transport: "websocket",
      serviceTier: "fast" } as any).result();
    assert.equal(servedDefault.usage.cost.total, 2, "actual default wins over requested Fast");
    globalThis.fetch = (async (_url: unknown, init: any) => {
      bodies.push(JSON.parse(init.body));
      return response(eventsForRequest());
    }) as typeof fetch;
    for (const transport of ["websocket", "sse", "native"] as const) {
      for (const scenario of ["set", "delete", "reported"] as const) {
        reportedTier = scenario === "reported" ? "default" : undefined;
        const result = await (transport === "native" ? streamResponses : stream)(model, context, { sessionId: "audit-direct-ws", apiKey: "offline", transport: transport === "native" ? "sse" : transport,
          serviceTier: scenario === "delete" ? "priority" : undefined,
          onPayload(payload: any) {
            // SimpleStreamOptions has no serviceTier option; its HTTP fallback gets tier through this hook.
            assert.equal(payload.service_tier, scenario === "delete" && transport !== "sse" ? "priority" : undefined);
            if (scenario === "set") return (mutablePayload = { ...payload, service_tier: "priority" });
            mutablePayload = payload;
            if (scenario === "delete") delete payload.service_tier;
            else payload.service_tier = "priority";
          } } as any).result();
        assert.equal(result.stopReason, "stop", result.errorMessage);
        assert.equal(bodies.at(-1).service_tier, scenario === "delete" ? undefined : "priority");
        assert.equal(result.usage.cost.total, scenario === "set" ? 4 : 2, `${transport}/${scenario} uses final request tier captured before dispatch`);
        mutablePayload = undefined;
      }
    }
  } finally { globalThis.fetch = originalFetch; await owner.dispose(); }
});

test("direct WebSocket continuation binds final tier to a successful response only", async () => {
  const sessionId = "audit-ws-tier-continuation";
  const bodies: any[] = [];
  let outcome: "completed" | "failed" = "completed";
  let tier: string | undefined;
  let patch: ((payload: any) => void) | undefined;
  let hooks = 0;
  class Socket extends EventEmitter {
    readyState = 1;
    send(body: string) {
      bodies.push(JSON.parse(body));
      const id = `tier_response_${bodies.length}`;
      queueMicrotask(() => {
        const events: any[] = structuredClone(textEvents());
        events.at(-1).response.id = id;
        events.at(-1).response.status = outcome;
        if (outcome === "failed") events.at(-1).response.error = { code: "offline", message: "synthetic request failure" };
        events.at(-1).response.service_tier = "fast";
        for (const event of events) this.emit("message", JSON.stringify(event));
      });
    }
    close() { this.readyState = 3; }
    terminate() { this.close(); }
  }
  const owner = createOpenAIResponsesOwner({ socketFactory: async () => new Socket() });
  const stream = owner.streamSimple;
  const model: any = { id: "gpt-5.1", api: "openai-responses", provider: "openai", baseUrl: "https://api.openai.com/v1",
    input: ["text"], reasoning: false, contextWindow: 64000, maxTokens: 512, cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } };
  const context: any = { messages: [] };
  const send = async (maxTokens = 512, signal?: AbortSignal) => {
    context.messages.push({ role: "user", content: `turn ${hooks}`, timestamp: hooks });
    const result = await stream(model, context, { sessionId, apiKey: "offline", transport: "websocket", maxTokens, signal,
      onPayload: (payload: any) => { hooks++; if (tier !== undefined) payload.service_tier = tier; patch?.(payload); } }).result();
    if (result.stopReason !== "error" && result.stopReason !== "aborted") context.messages.push(result);
    return result;
  };
  try {
    owner.state.setContinuationState(sessionId, { responseId: "unknown-http", modelKey: "openai:openai-responses:gpt-5.1", updatedAt: 1, contextLength: 1 });
    patch = () => assert.equal(owner.state.getContinuationState(sessionId), undefined, "cold continuation is discarded before hooks");
    assert.equal((await send()).stopReason, "stop");
    assert.equal(bodies[0].previous_response_id, undefined);
    patch = undefined;
    assert.equal((await send()).stopReason, "stop");
    assert.equal(bodies[1].previous_response_id, "tier_response_1", "known omitted tier differs from unknown evidence");
    assert.equal(bodies[1].input.length, 1);

    tier = "priority";
    const beforeMismatch = bodies.length, beforeHooks = hooks;
    const mismatch = await send();
    assert.equal(mismatch.stopReason, "error");
    assert.match(mismatch.errorMessage!, /continuation.*tier/i);
    assert.equal(bodies.length, beforeMismatch);
    assert.equal(hooks, beforeHooks + 1, "no hook replay");
    assert.equal((await send()).stopReason, "stop", "next cold request can establish a fresh boundary");
    assert.equal(bodies.at(-1).previous_response_id, undefined);
    assert.ok(bodies.at(-1).input.length > 1);
    owner.state.setContinuationState(sessionId, { ...owner.state.getContinuationState(sessionId)!, responseId: "interleaved-http" });
    patch = payload => {
      assert.equal(owner.state.getContinuationState(sessionId), undefined);
      assert.equal(payload.previous_response_id, undefined, "warm WS must not substitute its older response for unproven HTTP state");
      assert.ok(payload.input.length > 1);
    };
    assert.equal((await send()).stopReason, "stop");
    patch = undefined;
    const successful = owner.state.getContinuationState(sessionId)!;

    // Even if the manager observes an ID on a failed completed frame, it has no successful tier proof.
    outcome = "failed"; tier = "flex";
    const failure = await send(256);
    assert.equal(failure.stopReason, "error");
    assert.equal(failure.errorMessage, "synthetic request failure");
    assert.equal(owner.state.getContinuationState(sessionId), successful);
    outcome = "completed"; tier = "priority";
    assert.equal((await send()).stopReason, "stop");
    assert.equal(bodies.at(-1).previous_response_id, successful.responseId);

    tier = "flex";
    patch = payload => { delete payload.previous_response_id; payload.input = [{ role: "user", content: "independent input" }]; };
    assert.equal((await send()).stopReason, "stop");
    assert.equal(bodies.at(-1).previous_response_id, undefined);
    assert.deepEqual(bodies.at(-1).input, [{ role: "user", content: "independent input" }]);
    patch = payload => { payload.previous_response_id = "unowned-response"; };
    const beforeForeign = bodies.length;
    assert.equal((await send()).stopReason, "error");
    assert.equal(bodies.length, beforeForeign);

    patch = undefined;
    assert.equal((await send()).stopReason, "stop");
    const priorAbort = owner.state.getContinuationState(sessionId);
    const controller = new AbortController();
    patch = () => controller.abort();
    const beforeAbort = bodies.length;
    assert.equal((await send(512, controller.signal)).stopReason, "aborted");
    assert.equal(controller.signal.aborted, true);
    assert.equal(bodies.length, beforeAbort);
    assert.equal(owner.state.getContinuationState(sessionId), priorAbort);
  } finally { await owner.dispose(); }
});

async function fixture(codex = false, fail?: "remote" | "summary", modelId = "gpt-5.1", extra?: {
  headers?: (headers: Record<string, string | null | undefined>) => void;
  tool?: (session: any) => Promise<void>;
  customEnd?: () => Promise<void>;
  previewHooks?: (pi: any) => void;
  compactionExtension?: (pi: any) => void;
  noExtensions?: boolean;
  extensionPaths?: string[];
  sessionId?: string;
}) {
  const root = mkdtempSync(join(tmpdir(), "compaction-lifecycle-"));
  const settings = SettingsManager.inMemory({ compaction: { enabled: false, keepRecentTokens: 128, reserveTokens: 128 },
    retry: { enabled: false }, transport: "sse", providerRetry: { maxRetries: 0 } } as any);
  const model: any = { id: codex ? "gpt-5.1-codex" : modelId, name: "fixture", api: codex ? "openai-codex-responses" : "openai-responses",
    provider: codex ? "openai-codex" : "openai", baseUrl: codex ? "https://chatgpt.com/backend-api" : "https://api.openai.com/v1",
    reasoning: false, input: ["text"], cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }, contextWindow: 64000, maxTokens: 512 };
  let key = codex ? token() : "sk-offline-one", endpoint = model.baseUrl;
  const requests: Array<{ payload: any; url: string; authorization: string | null; headers: Headers }> = [];
  let callTool = false, headerCalls = 0;
  const refreshRequests: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: any, init: any) => {
    if (String(url).includes("/oauth/token")) {
      refreshRequests.push(String(url));
      return new Response(JSON.stringify({ access_token: token("one", refreshRequests.length + 1),
        refresh_token: "rotated-synthetic", expires_in: 3600 }), { status: 200 });
    }
    const body = new Headers(init.headers).get("content-encoding") === "zstd"
      ? (zlib as any).zstdDecompressSync(init.body).toString("utf8")
      : typeof init.body === "string" ? init.body : new TextDecoder().decode(init.body);
    const payload = JSON.parse(body);
    requests.push({ payload, url: String(url), authorization: new Headers(init.headers).get("authorization"), headers: new Headers(init.headers) });
    if (payload.messages) return new Response(sseFrames([
      { id: "chat-summary", object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: "offline policy summary" }, finish_reason: null }] },
      { id: "chat-summary", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } },
    ]) + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
    if (payload.input?.some((item: any) => item.type === "compaction_trigger")) {
      if (fail === "remote") return new Response(JSON.stringify({ error: { message: "offline remote failure" } }), { status: 500 });
      return response([{ type: "response.output_item.done", output_index: 0, item: artifact },
        { type: "response.completed", response: { status: "completed", output: [artifact], usage: { input_tokens: 10, output_tokens: 2 } } }]);
    }
    if (fail === "summary") return response([{ type: "response.failed", response: { status: "failed", error: { code: "offline", message: "summary failed" } } }]);
    if (callTool) {
      callTool = false;
      const item = { type: "function_call", id: "fc_note", call_id: "call_note", name: "note", arguments: "{}", status: "completed" };
      return response([{ type: "response.output_item.added", output_index: 0, item },
        { type: "response.output_item.done", output_index: 0, item },
        { type: "response.completed", response: { id: "resp_tool", status: "completed", output: [item] } }]);
    }
    const events: any[] = structuredClone(textEvents());
    events[2].item.status = "completed";
    events[3].response.output[0].status = "completed";
    if (requests.length > 1) {
      const text = `REPLY_${requests.length}_héllo✓`;
      events[1].delta = text;
      events[2].item.content[0].text = text;
      const reasoning = { type: "reasoning", id: `reasoning_${requests.length}`, summary: [], encrypted_content: `PRIVATE_REASONING_${requests.length}` };
      events.splice(3, 0, { type: "response.output_item.added", output_index: 1, item: reasoning },
        { type: "response.output_item.done", output_index: 1, item: reasoning });
      events.at(-1).response.output.push(reasoning);
    }
    return response(events);
  }) as typeof fetch;
  const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false });
  runtime.getAuth = async () => ({ auth: { apiKey: key, baseUrl: endpoint }, source: codex ? "oauth" : "api_key" });
  runtime.getModel = () => model;
  runtime.hasConfiguredAuth = () => true;
  runtime.checkAuth = async () => ({ type: "api_key" });
  const resourceLoader = new DefaultResourceLoader({ cwd: root, agentDir: root, settingsManager: settings,
    noExtensions: extra?.extensionPaths ? true : extra?.noExtensions ?? false, additionalExtensionPaths: extra?.extensionPaths,
    extensionFactories: extra?.noExtensions ? [] : [(pi: any) => {
      if (!extra?.extensionPaths) (extra?.compactionExtension ?? extension)(pi);
      extra?.previewHooks?.(pi);
      pi.on("before_provider_headers", (event: any) => { headerCalls++; extra?.headers?.(event.headers); });
      pi.on("message_end", async (event: any) => { if (event.message.role === "custom") await extra?.customEnd?.(); });
    }], noContextFiles: true, noSkills: true, noPromptTemplates: true, noThemes: true });
  await resourceLoader.reload();
  const manager = extra?.sessionId ? SessionManager.inMemory(root, { id: extra.sessionId }) : SessionManager.create(root, root);
  for (let i = 0; i < 4; i++) {
    manager.appendMessage({ role: "user", content: `old ${i} ${"history ".repeat(600)}`, timestamp: i });
    manager.appendMessage({ role: "assistant", content: [{ type: "text", text: `old reply ${i}` }], api: model.api,
      provider: model.provider, model: model.id, usage: responsesUsage, stopReason: "stop", timestamp: i });
  }
  const { session } = await createAgentSession({ cwd: root, agentDir: root, settingsManager: settings, sessionManager: manager,
    resourceLoader, model, modelRuntime: runtime, noTools: extra?.tool ? "builtin" : "all",
    customTools: extra?.tool ? [{ name: "note", modelOnly: true, label: "Note", description: "direct wire fixture", parameters: { type: "object", properties: {} },
      execute: async () => { await extra.tool!(session); return { content: [{ type: "text", text: "TOOL_RESULT_SENTINEL" }], details: {} }; } }] : undefined });
  await session.bindExtensions({});
  const sessionRuntime = new AgentSessionRuntime(session, { cwd: root, agentDir: root } as any, async target => {
    const loader = new DefaultResourceLoader({ cwd: target.cwd, agentDir: target.agentDir, settingsManager: settings,
      noExtensions: extra?.noExtensions ?? false, extensionFactories: extra?.noExtensions ? [] : [extra?.compactionExtension ?? extension], noContextFiles: true, noSkills: true, noPromptTemplates: true, noThemes: true });
    await loader.reload();
    const created = await createAgentSession({ cwd: target.cwd, agentDir: target.agentDir, settingsManager: settings,
      sessionManager: target.sessionManager, sessionStartEvent: target.sessionStartEvent, resourceLoader: loader,
      model, modelRuntime: runtime, noTools: "all" });
    return { ...created, services: { cwd: target.cwd, agentDir: target.agentDir } as any, diagnostics: [] };
  });
  sessionRuntime.setRebindSession(async active => { await active.bindExtensions({}); });
  return { get session() { return sessionRuntime.session; }, get manager() { return sessionRuntime.session.sessionManager; }, sessionRuntime, runtime, requests, refreshRequests, model, root,
    setAuthResolver(resolver: () => Promise<any>) { runtime.getAuth = resolver; },
    requestTool() { callTool = true; }, get headerCalls() { return headerCalls; },
    changeKey(value: string) { key = value; }, changeEndpoint(value: string) { endpoint = value; },
    clearFailure() { fail = undefined; },
    async release() { try { await sessionRuntime.dispose(); } finally { globalThis.fetch = originalFetch; rmSync(root, { recursive: true, force: true }); } } };
}

function tokenOwner(f: Awaited<ReturnType<typeof fixture>>) {
  return f.session.extensionRunner.getOpenAICodexDispatch().owner;
}

test("SDK summary dispatch uses configured transport and explicit requests retain their transport", async () => {
  const f = await fixture(false, undefined, "gpt-5.1", { noExtensions: true });
  const dispatch = f.runtime.streamSimple.bind(f.runtime);
  const transports: unknown[] = [];
  f.runtime.streamSimple = (...args: Parameters<typeof dispatch>) => {
    transports.push(args[2]?.transport);
    return dispatch(...args);
  };
  try {
    await f.session.compact();
    assert.deepEqual(transports, ["sse"]);
    f.session.agent.transport = "websocket-cached";
    await f.session.prompt("EXPLICIT_TRANSPORT");
    assert.deepEqual(transports, ["sse", "websocket-cached"]);
    assert.equal(f.requests.length, 2);
  } finally { await f.release(); }
});

test("SDK Codex owners isolate identical IDs without extensions and preserve legacy callers", { timeout: 5000 }, async () => {
  const sessionId = "native-codex-same-id";
  const first = await fixture(true, undefined, "gpt-5.1", { noExtensions: true, sessionId });
  let second: Awaited<ReturnType<typeof fixture>> | undefined;
  const enable = (f: typeof first) => { (f.session as any)._resourceLoader.getExtensions().runtime.codexRemoteCompactionEnabled = true; };
  try {
    enable(first); await first.session.prompt("first native owner");
    second = await fixture(true, undefined, "gpt-5.1", { noExtensions: true, sessionId });
    enable(second); await second.session.prompt("second native owner");
    const left = tokenOwner(first), right = tokenOwner(second);
    assert.notEqual(left, right); assert.equal(left.diagnostics.commitments, 1); assert.equal(right.diagnostics.commitments, 1);
    cleanupSessionResources(sessionId);
    assert.equal(left.diagnostics.commitments, 1); assert.equal(right.diagnostics.commitments, 1);
    const context = { messages: [{ role: "user" as const, content: "legacy caller", timestamp: 1 }] };
    const options = { apiKey: token(), sessionId, transport: "sse" as const, maxRetries: 0, codexRemoteCompaction: true };
    const legacy = await legacyCodexStream(second.model, context, options).result();
    assert.equal(legacy.stopReason, "stop");
    const untouched = right.getDebugStats(sessionId);
    await first.session.setModel({ ...first.model, id: "gpt-5.2-codex" }); await left.drain();
    assert.equal(left.diagnostics.commitments, 0); assert.equal(right.diagnostics.commitments, 1);
    assert.deepEqual(right.getDebugStats(sessionId), untouched);
    await first.sessionRuntime.dispose();
    const regularPayload = await second.session.buildProviderRequestPayload({ systemPrompt: second.session.systemPrompt, messages: second.session.messages });
    assert.deepEqual((await second.session.compactProviderRequestPayload({ regularPayload: regularPayload!, signal: new AbortController().signal }))?.compactionItem, artifact);
    const legacyPayload = buildOpenAICodexRequestBody(second.model, { messages: [...context.messages, legacy] }, options, sessionId) as unknown as Record<string, unknown>;
    assert.deepEqual((await compactOpenAICodexRequest(second.model, legacyPayload, options)).compactionItem, artifact);
    await second.sessionRuntime.dispose();
    for (const owner of [left, right]) for (const count of Object.values(owner.diagnostics)) assert.equal(count, 0);
  } finally { if (second) await second.release(); await first.release(); cleanupSessionResources(sessionId); }
});

test("SDK Codex generation rejects stale auth and header work while custom Providers retain priority", { timeout: 5000 }, async () => {
  let api: any, pause = "", entered = () => {}, release = () => {}, gate = Promise.resolve(), switchInHook = false;
  const f = await fixture(true, undefined, "gpt-5.1", { compactionExtension: () => {}, previewHooks: pi => {
    api = pi;
    pi.on("before_provider_headers", async () => { if (pause === "headers") { entered(); await gate; } });
    pi.on("before_provider_request", async () => {
      if (switchInHook) { switchInHook = false; await pi.setModel({ ...f.model, id: "gpt-5.2-codex" }); }
    });
  } });
  const owner = tokenOwner(f), dispatch = f.session.extensionRunner.getOpenAICodexDispatch();
  const context = { messages: [{ role: "user" as const, content: "generation fixture", timestamp: 1 }] };
  const options = { sessionId: f.session.sessionId, transport: "sse" as const, maxRetries: 0 };
  f.setAuthResolver(async () => { if (pause === "auth") { entered(); await gate; } return { auth: { apiKey: token() }, source: "oauth" }; });
  try {
    for (const kind of ["ordinary", "compact", "summary"]) for (const phase of ["auth", "headers"]) {
      pause = phase;
      const waiting = new Promise<void>(r => { entered = r; }); gate = new Promise<void>(r => { release = r; });
      const before = f.requests.length;
      const result = kind === "summary" ? assert.rejects(f.session.compact(), /previous.*generation/) : kind === "compact"
        ? assert.rejects(f.session.compactProviderRequestPayload({ regularPayload: {}, signal: new AbortController().signal }), /previous.*generation/)
        : (async () => {
          const stream = await f.session.agent.streamFunction(f.model, context, options);
          const value = await stream.result(); assert.equal(value.stopReason, "error"); assert.match(value.errorMessage!, /previous.*generation/);
        })();
      await waiting;
      await api.resetCodexTransport();
      const obsolete = owner.generation;
      await api.resetCodexTransport(); // A second revoke must invalidate work captured while already revoked.
      assert.throws(() => owner.resume(obsolete), /previous.*generation/);
      owner.resume(); release(); await result;
      assert.equal(f.requests.length, before, "stale work cannot reach transport");
      pause = "";
    }
    for (const compact of [false, true]) {
      pause = "headers";
      const waiting = new Promise<void>(r => { entered = r; }); gate = new Promise<void>(r => { release = r; });
      const before = f.requests.length;
      const pending = compact
        ? assert.rejects(f.session.compactProviderRequestPayload({ regularPayload: {}, signal: new AbortController().signal }), /previous.*generation|EXECUTION_BOUNDARY/)
        : (async () => {
          const value = await (await f.session.agent.streamFunction(f.model, context, options)).result();
          assert.equal(value.stopReason, "error"); assert.match(value.errorMessage!, /previous.*generation|EXECUTION_BOUNDARY/);
        })();
      await waiting;
      const transition = (f.session as any)._resourceLoader.getExtensions().runtime.executionBoundary.transition(() => undefined);
      await nextTurn(); release(); await pending; await transition;
      assert.equal(f.requests.length, before); pause = ""; owner.resume();
    }
    const oldGeneration = owner.generation;
    await api.resetCodexTransport();
    let customCalls = 0;
    const custom = (model: any, context: any, options: any) => { customCalls++; return legacyCodexStream(model, context, options); };
    f.runtime.registerProvider("openai-codex", { api: "openai-codex-responses", streamSimple: custom });
    assert.equal((await f.runtime.streamSimple(f.model, context, options, undefined, undefined, dispatch, oldGeneration).result()).stopReason, "stop");
    assert.equal(customCalls, 1, "unused stale native binding does not block custom transport");
    f.runtime.unregisterProvider("openai-codex");
    const originalStream = f.session.agent.streamFunction;
    f.session.agent.streamFunction = (model: any, context: any, options: any) => legacyCodexStream(model, context, { ...options, apiKey: token(), transport: "sse" });
    f.setAuthResolver(async () => { await api.resetCodexTransport(); return { auth: { apiKey: token() }, source: "oauth" }; });
    const customBefore = f.requests.length;
    try { await f.session.compact(); assert.equal(f.requests.length, customBefore + 1, "custom Agent summary ignores unused native generation"); }
    finally { f.session.agent.streamFunction = originalStream; }
    f.setAuthResolver(async () => ({ auth: { apiKey: token() }, source: "oauth" }));
    owner.resume();
    const before = f.requests.length; switchInHook = true;
    await f.session.prompt("model switch from payload hook");
    assert.equal(switchInHook, false); assert.equal(f.requests.length, before, "model selection must not wait on or dispatch its containing request");
    await owner.drain();
    await f.session.prompt("new model generation"); assert.equal(f.requests.at(-1)!.payload.model, "gpt-5.2-codex");
  } finally { pause = ""; release(); await f.release(); cleanupSessionResources(options.sessionId); }
});

for (const codex of [false, true]) for (const queued of [false, true]) test(`${codex ? "Codex" : "API"} opaque replay includes ${queued ? "tool-queued" : "idle"} custom messages exactly once`, async () => {
  const sentinel = queued ? "QUEUED_CUSTOM_SENTINEL" : "IDLE_CUSTOM_SENTINEL";
  const send = async (session: any) => { await session.sendCustomMessage({ customType: "local", content: sentinel, display: true }, { triggerTurn: false }); };
  const f = await fixture(codex, undefined, "gpt-5.1", queued ? { tool: send } : undefined);
  let customEnds = 0;
  const off = f.session.subscribe(event => { if (event.type === "message_end" && event.message.role === "custom") customEnds++; });
  try {
    await f.session.prompt("establish boundary"); await f.session.compact();
    if (queued) f.requestTool(); else await send(f.session);
    await f.session.prompt("CUSTOM_NEXT");
    assert.equal(f.requests.length, queued ? 4 : 3);
    const wire = JSON.stringify(f.requests.at(-1)!.payload.input);
    assert.equal(wire.split(sentinel).length - 1, 1, wire);
    if (queued) assert.ok(wire.indexOf("TOOL_RESULT_SENTINEL") < wire.indexOf(sentinel), wire);
    assert.equal(customEnds, 1);
    assert.equal(f.session.messages.filter((m: any) => m.role === "custom" && m.content === sentinel).length, 1);
    const reopened = SessionManager.open(f.manager.getSessionFile()!, f.root).getEntries();
    assert.equal(reopened.filter((e: any) => e.type === "custom_message" && e.content === sentinel).length, 1);
    await f.session.prompt("CUSTOM_AGAIN");
    assert.equal(f.requests.length, queued ? 5 : 4);
    assert.equal(JSON.stringify(f.requests.at(-1)!.payload.input).split(sentinel).length - 1, 1);
  } finally { off(); await f.release(); }
});

for (const codex of [false, true]) for (const name of ["OpenAI-Project", "OpenAI-Organization"]) {
  test(`${codex ? "Codex" : "API"} opaque compatibility follows final header hook ${name} injection, change and deletion`, async () => {
    let value: string | null | undefined;
    const f = await fixture(codex, undefined, "gpt-5.1", { headers: headers => { if (value !== undefined) headers[name] = value; } });
    try {
      await f.session.prompt("establish boundary"); await f.session.compact();
      const history = f.manager.getEntries().filter(e => e.type === "compaction");
      for (const route of ["route-one", "route-two", null]) {
        value = route;
        const calls = f.headerCalls, count = f.requests.length;
        await f.session.prompt(`HEADER_NEXT_${route}`);
        assert.equal(f.headerCalls, calls + 1, "header hooks execute once per request");
        assert.equal(f.requests.length, count + 1);
        const next = f.requests.at(-1)!;
        assert.equal(next.headers.get(name), route);
        assert.equal(next.payload.input.some((item: any) => item.type === "compaction"), route === null);
        assert.equal(next.payload.previous_response_id, undefined);
        assert.match(JSON.stringify(next.payload.input), /HEADER_NEXT_/);
        assert.deepEqual(f.manager.getEntries().filter(e => e.type === "compaction"), history);
      }
    } finally { await f.release(); }
  });
}

test("API continuation invalidates on final header hook route changes and resumes only on a matching dispatch", async () => {
  let value: string | null = "project-one";
  const f = await fixture(false, undefined, "gpt-5.1", { headers: headers => { headers["OpenAI-Project"] = value; } });
  try {
    await f.session.prompt("first"); await f.session.prompt("same project");
    assert.equal(f.requests[1].payload.previous_response_id, "resp_1");
    value = "project-two"; await f.session.prompt("different project");
    assert.equal(f.requests[2].headers.get("openai-project"), value);
    assert.equal(f.requests[2].payload.previous_response_id, undefined);
    await f.session.prompt("same new project");
    assert.equal(f.requests[3].payload.previous_response_id, "resp_1");
    value = null; await f.session.prompt("deleted project");
    assert.equal(f.requests[4].headers.get("openai-project"), null);
    assert.equal(f.requests[4].payload.previous_response_id, undefined);
    assert.equal(f.requests.length, 5);
    assert.match(JSON.stringify(SessionManager.open(f.manager.getSessionFile()!, f.root).getEntries()), /different project/);
  } finally { await f.release(); }
});

for (const codex of [false, true]) test(`${codex ? "Codex" : "API"} final header deletion suppresses a model default without losing compatible durable history`, async () => {
  let value: string | null = "model-project";
  const f = await fixture(codex, undefined, "gpt-5.1", { headers: headers => { headers["OpenAI-Project"] = value; } });
  f.model.headers = { "OpenAI-Project": "model-project" };
  try {
    await f.session.prompt("establish boundary"); await f.session.compact();
    value = null; await f.session.prompt("DELETE_MODEL_PROJECT");
    assert.equal(f.requests.at(-1)!.headers.get("openai-project"), null);
    assert.equal(f.requests.at(-1)!.payload.input.some((item: any) => item.type === "compaction"), false);
    value = "model-project"; await f.session.prompt("RESTORE_MODEL_PROJECT");
    assert.equal(f.requests.at(-1)!.payload.input.some((item: any) => item.type === "compaction"), true);
    assert.match(JSON.stringify(f.requests.at(-1)!.payload.input), /DELETE_MODEL_PROJECT/);
    assert.equal(f.requests.length, 4);
    assert.equal(SessionManager.open(f.manager.getSessionFile()!, f.root).getEntries().filter(e => e.type === "compaction").length, 1);
  } finally { await f.release(); }
});

test("Codex account header hooks cannot change token-owned transport identity or invalidate its compatible opaque history", async () => {
  let value: string | null = "attempted-other-account";
  const f = await fixture(true, undefined, "gpt-5.1", { headers: headers => { headers["ChatGPT-Account-Id"] = value; } });
  try {
    await f.session.prompt("establish boundary"); await f.session.compact();
    for (const header of [null, "another-override"]) {
      value = header;
      const count = f.headerCalls;
      await f.session.prompt("TOKEN_OWNED_ACCOUNT_NEXT");
      assert.equal(f.headerCalls, count + 1);
      assert.equal(f.requests.at(-1)!.headers.get("chatgpt-account-id"), "one");
      assert.equal(f.requests.at(-1)!.payload.input.some((item: any) => item.type === "compaction"), true);
    }
    assert.equal(f.requests.length, 4);
    assert.equal(SessionManager.open(f.manager.getSessionFile()!, f.root).getEntries().filter(e => e.type === "compaction").length, 1);
  } finally { await f.release(); }
});

test("regular request and compaction preview use their resolved credential without a second registry lookup", async () => {
  const f = await fixture();
  f.model.headers = { "OpenAI-Project": "old-model-project" };
  let lookups = 0;
  f.setAuthResolver(async () => ({ auth: { apiKey: ++lookups === 1 ? "first-effective-key" : "later-key", baseUrl: "https://api.openai.com/selected",
    headers: { "OpenAI-Project": null, "OpenAI-Organization": "current-organization" } }, source: "api_key" }));
  try {
    await f.session.prompt("ONE_AUTH_SNAPSHOT");
    assert.equal(lookups, 1);
    assert.equal(f.requests.length, 1);
    assert.equal(f.requests[0].authorization, "Bearer first-effective-key");
    assert.match(f.requests[0].url, /\/selected\//);
    assert.equal(f.requests[0].headers.get("openai-project"), null);
    await f.session.compact();
    assert.equal(lookups, 2, "one lookup for the regular request and one for compaction, none for its preview");
    assert.equal(f.requests.length, 2);
    assert.equal(f.requests[1].authorization, "Bearer later-key");
    assert.match(f.requests[1].url, /\/selected\//);
    assert.equal(f.requests[1].headers.get("openai-project"), null, "compaction must not resurrect a deleted model header");
    assert.equal(f.requests[1].headers.get("openai-organization"), "current-organization");
    const auth = await (f.session as any)._getRequiredRequestAuth(f.model);
    assert.equal(auth.headers["OpenAI-Project"], null);
    // The native summary APIs pass the same deletion intent through to actual synthetic wire requests.
    await generateSummary(f.session.messages, auth.model, 128, auth.apiKey, auth.headers);
    const branch = await generateBranchSummary(f.manager.getEntries(), { model: auth.model, apiKey: auth.apiKey,
      headers: auth.headers, signal: new AbortController().signal });
    assert.ok(branch.summary); assert.equal(branch.error, undefined);
    assert.equal(f.requests.length, 4);
    for (const request of f.requests.slice(2)) {
      assert.equal(request.headers.get("openai-project"), null);
      assert.equal(request.headers.get("openai-organization"), "current-organization");
    }
  } finally { await f.release(); }
});

test("provider preview preserves auth identity and rejects stale async results", { timeout: 10_000 }, async () => {
  let seen: any, gateAt = "", entered = () => {}, release = () => {}, gate = Promise.resolve();
  const f = await fixture(false, undefined, "gpt-5.1", { previewHooks: pi => {
    pi.on("context", async () => { if (gateAt === "context") { entered(); await gate; } });
    pi.on("before_provider_request", async (event: any) => {
      seen = event.requestAuth;
      if (gateAt === "payload") { entered(); await gate; }
    });
  } });
  const loader = f.session.resourceLoader;
  const originalReload = loader.reload.bind(loader);
  let releaseReload = () => {};
  let builtModel: any, builds = 0, lookups = 0;
  const auth = Object.freeze({ model: { ...f.model, baseUrl: "https://api.openai.com/selected" }, apiKey: "synthetic",
    headers: Object.freeze({ "OpenAI-Project": null }), env: Object.freeze({ FIXTURE: "true" }) });
  const input = { systemPrompt: "offline", messages: [], auth };
  const pending: Promise<unknown>[] = [];
  f.setAuthResolver(async () => { lookups++; return { auth: { apiKey: "fallback" }, source: "api_key" }; });
  (f.session as any)._providerRequestPayloadBuilder = (value: any) => { builds++; builtModel = value.model; return { model: value.model.id, input: [], instructions: value.systemPrompt }; };
  try {
    assert.ok(await f.session.buildProviderRequestPayload(input));
    assert.equal(seen, auth); assert.equal(builtModel, auth.model);
    assert.equal(seen.headers["OpenAI-Project"], null); assert.equal(lookups, 0);
    for (const key of ["id", "provider", "api"]) {
      await assert.rejects(f.session.buildProviderRequestPayload({ ...input, auth: { ...auth, model: { ...auth.model, [key]: "other" } } }), /snapshot does not match/);
    }
    assert.equal(builds, 1);
    assert.ok(await f.session.buildProviderRequestPayload({ systemPrompt: "legacy", messages: [] }));
    assert.equal(seen, undefined); assert.equal(builtModel, f.model); assert.equal(lookups, 1);
    // Stop real reload after the loader publishes a fresh epoch-0 runtime but before the runner swaps.
    gateAt = "context";
    const ready = new Promise<void>(resolve => { entered = resolve; });
    gate = new Promise<void>(resolve => { release = resolve; });
    const stale = assert.rejects(f.session.buildProviderRequestPayload(input), /stale|EXECUTION_BOUNDARY_CHANGED/);
    pending.push(stale); await ready;
    const oldRunner = f.session.extensionRunner, oldGeneration = loader.getExtensions().runtime.executionBoundary.generation;
    let published = () => {}, didPublish = false;
    const publication = new Promise<void>(resolve => { published = () => { didPublish = true; resolve(); }; });
    const rebuild = new Promise<void>(resolve => { releaseReload = resolve; });
    loader.reload = async () => { await originalReload(); published(); await rebuild; };
    const reloading = f.session.reload(); pending.push(reloading);
    await nextTurn(); assert.equal(didPublish, false, "reload must join old preparations before publication");
    release(); await stale;
    await publication;
    assert.equal(loader.getExtensions().runtime.executionBoundary.generation, oldGeneration);
    assert.equal(f.session.extensionRunner, oldRunner);
    releaseReload(); await reloading;
    loader.reload = originalReload;
    for (const phase of ["context", "payload"]) {
      gateAt = phase;
      const ready = new Promise<void>(resolve => { entered = resolve; });
      gate = new Promise<void>(resolve => { release = resolve; });
      const result = f.session.buildProviderRequestPayload(input);
      const rejection = assert.rejects(result, /stale model or session|EXECUTION_BOUNDARY_CHANGED/);
      pending.push(rejection);
      await ready;
      if (phase === "context") await f.session.setModel({ ...f.model });
      else pending.push(loader.getExtensions().runtime.executionBoundary.transition(() => undefined));
      release(); await rejection;
      await f.session.setModel(f.model);
      await Promise.all(pending);
    }
    assert.equal(lookups, 1, "stale previews must not resolve authentication again");
    assert.equal((f.session as any)._toolBudgetPayloadPreviewDepth, 0);
  } finally { release(); releaseReload(); loader.reload = originalReload; await Promise.allSettled(pending); await f.release(); }
});

test("native compaction selection rejects overlapping adapters before execution in either order", { timeout: 5000 }, async () => {
  const oldEnabled = process.env.SP_OPENAI_SERVER_COMPACTION_ENABLED;
  try {
    for (const reverse of [false, true]) {
      process.env.SP_OPENAI_SERVER_COMPACTION_ENABLED = "true";
      let summaries = 0, boundaryChecks = 0, allowed = false, authLookups = 0, autoFailure = "";
      const aware = createProviderAwareCompactionExtension({ targetProvider: "openai", fallbackModel: "openai/gpt-5.1",
        crossProviderBoundaryFn: () => { boundaryChecks++; return { allowed }; },
        compactFn: async preparation => { summaries++; return { summary: "selected policy", firstKeptEntryId: preparation.firstKeptEntryId, tokensBefore: preparation.tokensBefore }; },
      });
      const f = await fixture(false, undefined, "gpt-5.1", { compactionExtension: pi => {
        if (reverse) { aware(pi); extension(pi); } else { extension(pi); aware(pi); }
      } });
      const off = f.session.subscribe((event: any) => { if (event.type === "compaction_end" && event.reason === "threshold") autoFailure = event.errorMessage ?? ""; });
      f.setAuthResolver(async () => { authLookups++; return { auth: { apiKey: "synthetic" }, source: "api_key" }; });
      try {
        await f.session.prompt("establish successful request");
        const before = f.requests.length;
        await assert.rejects(f.session.compact(), /Conflicting compaction strategies/);
        await (f.session as any)._runAutoCompaction("threshold", false);
        assert.match(autoFailure, /Conflicting compaction strategies/);
        assert.equal(f.requests.length, before); assert.equal(summaries, 0); assert.equal(boundaryChecks, 0);
        assert.equal(authLookups, 3, "ordinary request and each host compaction resolve active auth; candidates perform no extra lookups");
        assert.equal(f.manager.getEntries().filter(entry => entry.type === "compaction").length, 0);
        process.env.SP_OPENAI_SERVER_COMPACTION_ENABLED = "false";
        await assert.rejects(f.session.compact(), /cancelled/);
        assert.equal(boundaryChecks, 1); assert.equal(summaries, 0); assert.equal(f.requests.length, before);
        allowed = true;
        await f.session.compact();
        assert.equal(summaries, 1); assert.equal(f.requests.length, before);
        assert.equal(f.manager.getEntries().filter(entry => entry.type === "compaction").length, 1);
      } finally { off(); await f.release(); }
    }
  } finally { if (oldEnabled === undefined) delete process.env.SP_OPENAI_SERVER_COMPACTION_ENABLED; else process.env.SP_OPENAI_SERVER_COMPACTION_ENABLED = oldEnabled; }
});

test("native compaction strategies preserve snapshots, legacy overrides and lifecycle failure boundaries", { timeout: 5000 }, async () => {
  let mode = "success", configured = "captured", prepares = 0, executions = 0, api: any, savedEvent: any;
  let entered = () => {}, release = () => {}, gate = Promise.resolve();
  const f = await fixture(false, undefined, "gpt-5.1", { compactionExtension: pi => {
    api = pi;
    pi.registerCompactionStrategy({ id: "fixture", prepare: () => {
      prepares++;
      if (mode === "none") return undefined;
      if (mode === "select-error") throw new Error("selection failed");
      if (mode === "select-async") return gate.then(() => { throw new Error("late invalid preparation"); });
      if (mode === "select-invalid") return {};
      const captured = configured;
      return async (event: any) => {
        executions++; savedEvent = event;
        if (mode === "execute-error") throw new Error("execution failed");
        if (mode === "execute-invalid") return {};
        if (mode === "cancel") return { cancel: true };
        if (mode === "fallback") return undefined;
        return { compaction: { summary: captured, firstKeptEntryId: event.preparation.firstKeptEntryId, tokensBefore: event.preparation.tokensBefore } };
      };
    } });
    // A later non-matching selector changes external configuration; the chosen closure must retain its snapshot.
    pi.registerCompactionStrategy({ id: "non-matching", prepare: () => { configured = "changed after selection"; return undefined; } });
  } });
  const runtime = () => (f.session as any)._resourceLoader.getExtensions().runtime;
  try {
    assert.equal(f.session.extensionRunner.hasHandlers("session_before_compact"), true, "native-only registration reaches host dispatch");
    await f.session.compact();
    assert.equal(executions, 1); assert.equal(prepares, 1); assert.equal(f.requests.length, 0);
    const checkpoint = f.manager.getEntries().find(entry => entry.type === "compaction");
    assert.equal((checkpoint as any).summary, "captured");
    assert.throws(() => api.registerCompactionStrategy({ id: "late", prepare: () => undefined }), /during extension loading/);
    for (const fault of ["select-error", "select-invalid", "execute-error", "execute-invalid", "cancel"]) {
      mode = fault; const before: number = executions;
      if (fault === "cancel") assert.deepEqual(await f.session.extensionRunner.emit(savedEvent), { cancel: true });
      else await assert.rejects(f.session.extensionRunner.emit(savedEvent), /selection failed|prepare synchronously|execution failed|explicit undefined fallback/);
      assert.equal(executions, before + (fault.startsWith("execute") || fault === "cancel" ? 1 : 0));
      assert.equal(f.requests.length, 0);
    }
    mode = "select-async"; gate = new Promise<void>(r => { release = r; });
    await assert.rejects(f.session.extensionRunner.emit(savedEvent), /prepare synchronously/);
    let drained = false; const draining = f.session.extensionRunner.drainExecution().then(() => { drained = true; });
    await nextTurn(); assert.equal(drained, false); release(); await draining;
    // Legacy overrides are an explicit compatibility priority, regardless of registration order.
    api.on("session_before_compact", async () => {
      if (mode === "legacy-cancel") return { cancel: true };
      if (mode === "legacy-result") return { compaction: { summary: "legacy", firstKeptEntryId: savedEvent.preparation.firstKeptEntryId, tokensBefore: 0 } };
      if (mode === "legacy-wait") { entered(); await gate; }
      return undefined;
    });
    for (const legacy of ["legacy-cancel", "legacy-result"]) {
      mode = legacy; const before: number = prepares; const result: any = await f.session.extensionRunner.emit(savedEvent);
      assert.equal(prepares, before); assert.ok(result?.cancel || result?.compaction);
    }
    mode = "legacy-wait";
    const waiting = new Promise<void>(r => { entered = r; }); gate = new Promise<void>(r => { release = r; });
    const before = prepares;
    const pending = assert.rejects(f.session.extensionRunner.emit(savedEvent), /stale model/);
    await waiting; await f.session.setModel({ ...f.model, id: "gpt-5.2" }); release(); await pending;
    assert.equal(prepares, before); assert.equal(f.requests.length, 0);
    mode = "fallback";
    await f.session.prompt("native fallback after checkpoint");
    const beforeFallback = f.requests.length;
    await f.session.compact(); assert.equal(f.requests.length, beforeFallback + 1, "selected strategy may explicitly request the native summary");
    const previous = runtime(), oldApi = api;
    await f.session.reload();
    assert.equal(previous.compactionStrategies.size, 0); assert.equal(runtime().compactionStrategies.size, 2);
    assert.throws(() => oldApi.registerCompactionStrategy({ id: "stale", prepare: () => undefined }), /stale/);
  } finally { release(); await f.release(); }
});

test("host supplemental scopes preserve ordinary state and apply selected-model hooks", async () => {
  for (const codex of [false, true]) {
    let api: any, payloadHooks = 0, headerHooks = 0;
    const f = await fixture(codex, undefined, "gpt-5.1", { previewHooks: pi => {
      api = pi;
      pi.on("before_provider_headers", (event: any, ctx: any) => {
        if (event.purpose !== "supplemental-summary") return;
        headerHooks++; assert.equal(ctx.model.id, f.model.id); event.headers["X-Summary"] = "yes";
      });
      pi.on("before_provider_request", (event: any, ctx: any) => {
        if (event.purpose !== "supplemental-summary") return;
        payloadHooks++; assert.equal(ctx.model.id, f.model.id);
        return { ...event.payload, service_tier: "flex" };
      });
    } });
    try {
      await f.session.prompt("ORDINARY_BEFORE_SUMMARY");
      const native = tokenOwner(f), generation = native.generation, prior = { ...native.diagnostics };
      const owner = (f.session as any)._resourceLoader.getExtensions().runtime.openAIResponsesOwner;
      const continuation = owner.state.getContinuationState(f.manager.getSessionId());
      const budget = f.session.getToolResultBudgetStatus();
      const prefix = (f.session as any)._prefixManifestRecorder.current;
      let escaped: any;
      await api.withSupplementalSummary(new AbortController().signal, async (stream: any) => {
        escaped = stream;
        const result = await (await stream(f.model, { messages: [{ role: "user", content: "ONLY_SUPPLEMENTAL", timestamp: 1 }] },
          { apiKey: codex ? token() : "offline", sessionId: f.manager.getSessionId(), cacheRetention: "long", transport: "websocket" })).result();
        assert.equal(result.stopReason, "stop");
      });
      await nextTurn();
      assert.equal(native.generation, generation); assert.deepEqual(native.diagnostics, prior);
      assert.equal(owner.state.getContinuationState(f.manager.getSessionId()), continuation);
      assert.equal((f.session as any)._prefixManifestRecorder.current, prefix);
      assert.deepEqual(f.session.getToolResultBudgetStatus(), budget);
      assert.equal(payloadHooks, 1); assert.equal(headerHooks, 1);
      const summary = f.requests.at(-1)!;
      assert.equal(summary.headers.get("x-summary"), "yes");
      assert.equal(summary.payload.service_tier, "flex"); assert.equal(summary.payload.previous_response_id, undefined);
      assert.doesNotMatch(JSON.stringify(summary.payload.input), /ORDINARY_BEFORE_SUMMARY|old reply|compaction_trigger/);
      await assert.rejects(escaped(f.model, { messages: [] }), /closed|abort/i);
      await f.session.compact();
      await f.session.prompt("ORDINARY_AFTER_SUMMARY");
      assert.ok(f.requests.at(-1)!.payload.input.some((item: any) => item.type === "compaction"));
    } finally { await f.release(); }
  }
});

test("host supplemental scopes reject stale preparation and join their custom request", { timeout: 5000 }, async () => {
  let api: any, phase = "", finishHeader!: () => void, enteredHeader!: () => void;
  let headerGate = Promise.resolve(), entered = Promise.resolve(), finishTail = () => {};
  const f = await fixture(false, undefined, "gpt-5.1", { previewHooks: pi => {
    api = pi;
    pi.on("before_provider_headers", async (event: any) => {
      if (event.purpose !== "supplemental-summary") return;
      if (phase === "header") { enteredHeader(); await headerGate; }
      if (phase === "failure") throw new Error("synthetic summary header rejection");
    });
  } });
  const controller = new AbortController();
  const send = (stream: any, signal?: AbortSignal) => stream(f.model, { messages: [{ role: "user", content: "summary", timestamp: 1 }] }, { apiKey: "offline", signal });
  try {
    phase = "header";
    headerGate = new Promise<void>(resolve => { finishHeader = resolve; });
    entered = new Promise<void>(resolve => { enteredHeader = resolve; });
    const pending = api.withSupplementalSummary(new AbortController().signal, async (stream: any) => (await send(stream, controller.signal)).result());
    await entered; controller.abort(); finishHeader();
    await assert.rejects(pending, /abort/i); assert.equal(f.requests.length, 0);
    phase = "failure";
    await assert.rejects(api.withSupplementalSummary(new AbortController().signal, async (stream: any) => {
      await (await send(stream)).result();
      return "swallowed hook error";
    }), /synthetic summary header rejection/);
    assert.equal(f.requests.length, 0);
    phase = "";
    await api.withSupplementalSummary(new AbortController().signal, async (stream: any) => {
      await api.resetCodexTransport();
      assert.equal((await (await send(stream)).result()).stopReason, "stop");
    });
    const directRequests = f.requests.length;
    await assert.rejects(api.withSupplementalSummary(new AbortController().signal, async (stream: any) => {
      await f.session.setModel({ ...f.model, id: "gpt-5.2" });
      return (await send(stream)).result();
    }), /stale|generation/);
    assert.equal(f.requests.length, directRequests);
    const message = { role: "assistant" as const, content: [], api: f.model.api, provider: f.model.provider, model: f.model.id,
      usage: responsesUsage, stopReason: "stop" as const, timestamp: 1 };
    f.session.agent.streamFunction = (() => ({ async *[Symbol.asyncIterator]() {
      yield { type: "done", reason: "stop", message };
      throw new Error("synthetic iterator cleanup failure");
    } })) as any;
    await assert.rejects(api.withSupplementalSummary(new AbortController().signal, async (stream: any) => {
      try { await send(stream); } catch { /* Even swallowing the stream error must not commit a success. */ }
      return "swallowed cleanup failure";
    }), /synthetic iterator cleanup failure/);
    let failTail!: () => void;
    const lateTail = new Promise<void>(resolve => { failTail = resolve; });
    f.session.agent.streamFunction = (() => ({ async *[Symbol.asyncIterator]() {
      yield { type: "done", reason: "stop", message };
      await lateTail;
      throw new Error("late iterator cleanup failure");
    } })) as any;
    const early = api.withSupplementalSummary(new AbortController().signal, async (stream: any) => {
      void send(stream).catch(() => undefined);
      await nextTurn();
      return "callback returned before cleanup";
    });
    const earlyFailure = assert.rejects(early, /late iterator cleanup failure/);
    await nextTurn(); failTail(); await earlyFailure;
    const custom = createAssistantMessageEventStream();
    let customCalls = 0, returned = false;
    let customEntered!: () => void;
    const started = new Promise<void>(resolve => { customEntered = resolve; });
    const tail = new Promise<void>(resolve => { finishTail = resolve; });
    f.session.agent.streamFunction = (() => {
      customCalls++; customEntered();
      return { async *[Symbol.asyncIterator]() { yield* custom; await tail; } };
    }) as any;
    const running = api.withSupplementalSummary(new AbortController().signal, async (stream: any) => {
      await api.resetCodexTransport();
      void send(stream).catch(() => undefined);
      await started;
      await assert.rejects(send(stream), /unfinished/);
      return "callback finished before request";
    });
    void running.then(() => { returned = true; }, () => { returned = true; });
    await nextTurn(); assert.equal(customCalls, 1); assert.equal(returned, false);
    custom.push({ type: "done", reason: "stop", message }); custom.end(message);
    await nextTurn(); assert.equal(returned, false, "done must not release an unfinished iterator");
    const shutdown = f.sessionRuntime.dispose();
    let disposed = false; void shutdown.then(() => { disposed = true; });
    await nextTurn(); assert.equal(disposed, false);
    finishTail();
    await assert.rejects(running, /stale|boundary|disposed/i); await shutdown;
    assert.equal((f.session as any)._resourceLoader.getExtensions().runtime.executionBoundary.preparationCount, 0);
  } finally { finishHeader?.(); finishTail(); await f.release(); }
});

test("portable summaries preserve complete selected authentication through algorithm fallback", { timeout: 10000 }, async () => {
  const modeKey = "SP_OPENAI_SERVER_COMPACTION_SUMMARY_MODE", modelKey = "SP_OPENAI_SERVER_COMPACTION_SUMMARY_MODEL";
  const oldMode = process.env[modeKey], oldModel = process.env[modelKey];
  process.env[modeKey] = "always";
  process.env[modelKey] = "current";
  let activeAuth: any, candidateResolution: any, failPortable = false, cancelPortable = false;
  const calls: Array<{ model: any; options: any; kind: string }> = [];
  const lookups: string[] = [];
  const f = await fixture(false, undefined, "gpt-5.1", { previewHooks: pi => {
    pi.on("session_before_compact", (event: any) => { activeAuth = event.auth; });
  } });
  const provider = f.runtime.getProvider("openai")!, original = provider.streamSimple;
  const candidate = { ...f.model, id: "gpt-summary", baseUrl: "https://api.openai.com/catalog-candidate" };
  f.model.headers = { "X-Remove": "model-placeholder" };
  candidate.headers = f.model.headers;
  let candidateMode = "ok", deletion = true;
  f.runtime.getModel = (_provider, id) => id === candidate.id ? candidate : f.model;
  f.runtime.getAuth = async model => {
    assert.equal(typeof model, "object");
    const id = typeof model === "string" ? model : model.id;
    lookups.push(id);
    if (id === candidate.id) {
      if (candidateMode === "throw") throw new Error("synthetic auth failure");
      if (candidateMode === "missing") return undefined;
      if (candidateMode === "sparse") {
        candidateResolution = { auth: { apiKey: "candidate-synthetic" }, source: "api_key" };
        return candidateResolution;
      }
      candidateResolution = { auth: { apiKey: "candidate-synthetic", baseUrl: "https://api.openai.com/effective-candidate",
        headers: { "X-Account": "candidate", ...(deletion ? { "X-Remove": null } : {}) } }, env: { ACCOUNT: "candidate" }, source: "api_key" };
      return candidateResolution;
    }
    return { auth: { apiKey: "active-synthetic", baseUrl: "https://api.openai.com/effective-active",
      headers: { "X-Account": "active", ...(deletion ? { "X-Remove": null } : {}) } }, env: { ACCOUNT: "active" }, source: "api_key" };
  };
  provider.streamSimple = (model, context, options) => {
      const portable = calls.length === 0;
      calls.push({ model, options, kind: portable ? "portable" : "fallback" });
      if (cancelPortable) f.session.abortCompaction();
      if ((portable && failPortable) || cancelPortable) {
        const failed = createAssistantMessageEventStream();
        failed.end({ role: "assistant", content: [{ type: "text", text: "PARTIAL_NOT_A_SUMMARY" }], api: model.api, provider: model.provider, model: model.id,
          usage: responsesUsage, stopReason: "error", errorMessage: "synthetic portable failure", timestamp: 1 });
        return failed;
      }
      return original(model, context, options);
  };
  async function run(selected: boolean, fallback: boolean, unavailable = "ok") {
    process.env[modelKey] = selected ? candidate.id : "current";
    candidateMode = unavailable; failPortable = fallback;
    lookups.length = calls.length = f.requests.length = 0;
    for (let i = 0; i < 3; i++) f.manager.appendMessage({ role: "user", content: "fresh history ".repeat(256), timestamp: i });
    await f.session.compact();
    assert.deepEqual(lookups, selected ? [f.model.id, candidate.id] : [f.model.id]);
    assert.deepEqual(calls.map(call => call.kind), fallback ? ["portable", "fallback"] : ["portable"]);
    const useCandidate = selected && (unavailable === "ok" || unavailable === "sparse");
    const expectedModel = useCandidate ? candidate : activeAuth.model;
    const expectedAuth = useCandidate ? candidateResolution.auth : activeAuth;
    const expectedEnv = useCandidate ? candidateResolution.env : activeAuth.env;
    for (const call of calls) {
      assert.equal(call.model.id, expectedModel.id);
      assert.equal(call.model.baseUrl, useCandidate ? expectedAuth.baseUrl ?? candidate.baseUrl : expectedModel.baseUrl);
      if (!useCandidate) assert.equal(call.model, activeAuth.model);
      assert.equal(call.options.apiKey, expectedAuth.apiKey);
      for (const [name, value] of Object.entries(expectedAuth.headers ?? {})) assert.equal(call.options.headers[name], value);
      if (!expectedAuth.headers) assert.equal(call.options.headers["X-Account"], undefined);
      assert.deepEqual(call.options.env, expectedEnv);
    }
    const summaryRequest = f.requests.find(request => !request.payload.input?.some((item: any) => item.type === "compaction_trigger"))!;
    assert.ok(summaryRequest);
    assert.equal(summaryRequest.url, `${useCandidate ? expectedAuth.baseUrl ?? candidate.baseUrl : expectedModel.baseUrl}/responses`);
    assert.equal(summaryRequest.headers.get("x-account"), unavailable === "sparse" ? null : useCandidate ? "candidate" : "active");
    if (deletion) assert.equal(summaryRequest.headers.has("x-remove"), false);
  }
  try {
    await run(false, false);
    await run(true, false);
    deletion = false;
    await run(true, true);
    await run(true, true, "sparse");
    await run(true, true, "missing");
    await run(true, false, "throw");
    // Existing nullable-header restriction must still block algorithm fallback.
    deletion = true; failPortable = true; calls.length = f.requests.length = 0;
    f.manager.appendMessage({ role: "user", content: "fresh private history ".repeat(256), timestamp: 10 });
    await assert.rejects(f.session.compact("redact all private details"), /cancel/i);
    assert.deepEqual(calls.map(call => call.kind), ["portable"]);
    assert.equal(f.requests.length, 0);
    cancelPortable = true; calls.length = 0;
    await assert.rejects(f.session.compact(), /abort|cancel/i);
    assert.deepEqual(calls.map(call => call.kind), ["portable"]);
  } finally {
    provider.streamSimple = original;
    await f.release();
    if (oldMode === undefined) delete process.env[modeKey]; else process.env[modeKey] = oldMode;
    if (oldModel === undefined) delete process.env[modelKey]; else process.env[modelKey] = oldModel;
  }
});

test("portable summary Fast hooks preserve ordinary Codex and Responses continuity", async () => {
  const root = mkdtempSync(join(tmpdir(), "summary-fast-contract-"));
  const priorDir = process.env.SP_CODING_AGENT_DIR, priorMode = process.env.SP_OPENAI_SERVER_COMPACTION_SUMMARY_MODE;
  const priorModel = process.env.SP_OPENAI_SERVER_COMPACTION_SUMMARY_MODEL;
  process.env.SP_CODING_AGENT_DIR = root;
  process.env.SP_OPENAI_SERVER_COMPACTION_SUMMARY_MODE = "always";
  process.env.SP_OPENAI_SERVER_COMPACTION_SUMMARY_MODEL = "gpt-summary";
  mkdirSync(join(root, "config")); saveFastModeConfig({ enabled: true }, fastModeConfigPath(root));
  try {
    for (const codex of [true, false]) {
      let native: any, prior: any, continuation: any, prefix: any, budget: any, hooks = 0, scopes = 0;
      const f = await fixture(codex, undefined, "gpt-5.1", { compactionExtension: pi => {
        fastExtension(pi, "0.84.1"); extension(pi);
        const host = pi.withSupplementalSummary!;
        pi.withSupplementalSummary = (signal: AbortSignal, callback: any) => host(signal, async (stream: any) => {
          const result = await callback(stream); await nextTurn(); scopes++;
          assert.deepEqual(native.diagnostics, prior);
          assert.equal((f.session as any)._resourceLoader.getExtensions().runtime.openAIResponsesOwner.state.getContinuationState(f.manager.getSessionId()), continuation);
          assert.equal((f.session as any)._prefixManifestRecorder.current, prefix);
          assert.deepEqual(f.session.getToolResultBudgetStatus(), budget);
          return result;
        });
        pi.on("before_provider_request", (event: any, ctx: any) => {
          if (event.purpose !== "supplemental-summary") return;
          hooks++; assert.equal(ctx.model.id, "gpt-summary");
          assert.equal(event.payload.service_tier, codex ? "priority" : undefined);
          return { ...event.payload, service_tier: "flex" };
        });
      } });
      try {
        const candidate = { ...f.model, id: "gpt-summary" };
        f.runtime.getModel = (_provider, id) => id === candidate.id ? candidate : f.model;
        await f.session.prompt("ORDINARY_BEFORE_PORTABLE"); await nextTurn();
        native = tokenOwner(f); prior = { ...native.diagnostics };
        continuation = (f.session as any)._resourceLoader.getExtensions().runtime.openAIResponsesOwner.state.getContinuationState(f.manager.getSessionId());
        prefix = (f.session as any)._prefixManifestRecorder.current; budget = f.session.getToolResultBudgetStatus();
        await f.session.compact();
        await f.session.prompt("ORDINARY_AFTER_PORTABLE");
        assert.equal(hooks, 1); assert.equal(scopes, 1); assert.equal(f.requests.length, 4);
        const [ordinary, summary, remote, next] = f.requests;
        assert.equal(summary.payload.model, candidate.id); assert.equal(summary.payload.service_tier, "flex");
        assert.equal(summary.payload.previous_response_id, undefined);
        for (const request of [ordinary, remote, next]) assert.equal(request.payload.service_tier, codex ? "priority" : undefined);
        assert.ok(remote.payload.input.some((item: any) => item.type === "compaction_trigger"));
        assert.ok(next.payload.input.some((item: any) => item.type === "compaction"));
      } finally { await f.release(); }
    }
  } finally {
    if (priorDir === undefined) delete process.env.SP_CODING_AGENT_DIR; else process.env.SP_CODING_AGENT_DIR = priorDir;
    if (priorMode === undefined) delete process.env.SP_OPENAI_SERVER_COMPACTION_SUMMARY_MODE; else process.env.SP_OPENAI_SERVER_COMPACTION_SUMMARY_MODE = priorMode;
    if (priorModel === undefined) delete process.env.SP_OPENAI_SERVER_COMPACTION_SUMMARY_MODEL; else process.env.SP_OPENAI_SERVER_COMPACTION_SUMMARY_MODEL = priorModel;
    rmSync(root, { recursive: true, force: true });
  }
});

test("portable summary invalidation prevents stale dispatch and joins parallel cancellation", { timeout: 5000 }, async () => {
  const priorMode = process.env.SP_OPENAI_SERVER_COMPACTION_SUMMARY_MODE, priorModel = process.env.SP_OPENAI_SERVER_COMPACTION_SUMMARY_MODEL;
  process.env.SP_OPENAI_SERVER_COMPACTION_SUMMARY_MODE = "always";
  process.env.SP_OPENAI_SERVER_COMPACTION_SUMMARY_MODEL = "gpt-summary";
  try {
    for (const phase of ["auth", "headers", "parallel-cancel"]) {
      let entered!: () => void, release!: () => void, remoteEntered!: () => void, releaseRemote!: () => void;
      const ready = new Promise<void>(resolve => { entered = resolve; });
      const gate = new Promise<void>(resolve => { release = resolve; });
      const remoteReady = new Promise<void>(resolve => { remoteEntered = resolve; });
      const remoteGate = new Promise<void>(resolve => { releaseRemote = resolve; });
      const f = await fixture(false, undefined, phase === "parallel-cancel" ? "o3" : "gpt-5.1", { previewHooks: pi => {
        pi.on("before_provider_headers", async (event: any) => {
          if (phase !== "auth" && event.purpose === "supplemental-summary") { entered(); await gate; }
        });
      } });
      const pending: Promise<unknown>[] = [];
      const fetchRemote = globalThis.fetch;
      if (phase === "parallel-cancel") globalThis.fetch = async (...args) => {
        const response = await fetchRemote(...args);
        remoteEntered(); await remoteGate;
        return response;
      };
      try {
        const candidate = { ...f.model, id: "gpt-summary" }, auth = f.runtime.getAuth.bind(f.runtime);
        f.runtime.getModel = (_provider, id) => id === candidate.id ? candidate : f.model;
        f.runtime.getAuth = async (model, options) => {
          if (typeof model === "string") throw new Error("fixture expects a model authentication lookup");
          if (phase === "auth" && typeof model === "object" && model.id === candidate.id) { entered(); await gate; }
          return auth(model, options);
        };
        const rejected = assert.rejects(f.session.compact(), /cancel|abort|stale|boundary/i); pending.push(rejected);
        await ready;
        if (phase === "auth") await f.session.setModel({ ...f.model, id: "gpt-5.2" });
        else if (phase === "headers") pending.push(f.session.reload());
        else { await remoteReady; f.session.abortCompaction(); releaseRemote(); }
        await nextTurn();
        assert.equal(f.requests.length, phase === "parallel-cancel" ? 1 : 0);
        if (phase === "parallel-cancel") assert.equal(f.session.isCompacting, true, "cancel must join the pending summary hook");
        release(); await Promise.all(pending);
        assert.equal(f.requests.length, phase === "parallel-cancel" ? 1 : 0);
        assert.equal(f.manager.getEntries().filter(entry => entry.type === "compaction").length, 0);
        assert.equal(f.session.isCompacting, false);
      } finally { release(); releaseRemote(); await Promise.allSettled(pending); globalThis.fetch = fetchRemote; await f.release(); }
    }
  } finally {
    if (priorMode === undefined) delete process.env.SP_OPENAI_SERVER_COMPACTION_SUMMARY_MODE; else process.env.SP_OPENAI_SERVER_COMPACTION_SUMMARY_MODE = priorMode;
    if (priorModel === undefined) delete process.env.SP_OPENAI_SERVER_COMPACTION_SUMMARY_MODEL; else process.env.SP_OPENAI_SERVER_COMPACTION_SUMMARY_MODEL = priorModel;
  }
});

test("provider-aware self summaries preserve captured auth and keep fallback boundaries", async () => {
  let handler: any, api: any, event: any, received: any, lookups = 0, summaries = 0;
  const result = (preparation: any) => ({ summary: "synthetic summary", firstKeptEntryId: preparation.firstKeptEntryId, tokensBefore: preparation.tokensBefore });
  const options = {
    policies: ["kimi-self-preserve-32k-v1"] as const,
    compactFn: async (preparation: any, model: any, apiKey: any, headers: any, _focus: any, _signal: any, _thinking: any, _stream: any, env: any) => {
      summaries++; received = { model, apiKey, headers, env, shape: "standalone" }; return result(preparation);
    },
    originalPrefixCompactFn: async (input: any) => { summaries++; received = { ...input, shape: "original" }; return result(input.preparation); },
  };
  const install = (pi: any) => {
    api = pi;
    pi.on("session_before_compact", (value: any) => { event = value; });
    createProviderAwareCompactionExtension(options)({ ...pi, registerCompactionStrategy: (strategy: any) => {
      handler = (event: any, ctx: any) => strategy.prepare(ctx)?.(event, ctx); pi.registerCompactionStrategy(strategy);
    } });
  };
  const f = await fixture(false, undefined, "gpt-5.1", { compactionExtension: install });
  const model = { ...f.model, provider: "kimi-coding", id: "k3-256k" };
  f.setAuthResolver(async () => { lookups++; return { auth: { baseUrl: "https://fixture.invalid/selected",
    headers: { Authorization: "Bearer synthetic", "OpenAI-Project": null } }, env: { FIXTURE: "true" }, source: "api_key" }; });
  try {
    await f.session.setModel(model);
    await f.session.compact();
    assert.equal(lookups, 1, "native compaction resolves once; self extension must not resolve again");
    assert.equal(summaries, 1); assert.equal(received.shape, "original");
    assert.equal(received.model, event.auth.model); assert.match(received.model.baseUrl, /\/selected$/);
    assert.equal(received.apiKey, undefined, "header-only authentication remains supported");
    assert.equal(received.headers, event.auth.headers); assert.equal(received.env, event.auth.env);
    assert.equal(received.headers["OpenAI-Project"], null);
    const ctx = f.session.extensionRunner.createContext();
    const plain = { ...event.auth, headers: { Authorization: "Bearer synthetic" } };
    assert.ok((await handler({ ...event, auth: plain }, ctx)).compaction);
    assert.equal(received.shape, "standalone"); assert.equal(received.headers, plain.headers);
    assert.ok((await handler({ ...event, auth: { model: event.auth.model, apiKey: "snapshot-only" } }, ctx)).compaction);
    assert.equal(received.apiKey, "snapshot-only"); assert.equal(received.headers, undefined);
    for (const key of ["provider", "id", "api"]) {
      assert.deepEqual(await handler({ ...event, auth: { ...event.auth, model: { ...event.auth.model, [key]: "different" } } }, ctx), { cancel: true });
    }
    assert.deepEqual(await handler({ ...event, auth: { model: event.auth.model } }, ctx), { cancel: true });
    const cancelled = new AbortController(); cancelled.abort();
    assert.deepEqual(await handler({ ...event, signal: cancelled.signal }, ctx), { cancel: true });
    assert.equal(lookups, 1); assert.equal(summaries, 3);
    assert.ok((await handler({ ...event, auth: undefined }, ctx)).compaction);
    assert.equal(lookups, 2, "old callers without a snapshot still resolve their auth");
    assert.equal(summaries, 4);
    const pendingCancellation = new AbortController();
    f.setAuthResolver(async () => { lookups++; pendingCancellation.abort(); return { auth: { apiKey: "late-synthetic" }, source: "api_key" }; });
    assert.deepEqual(await handler({ ...event, auth: undefined, signal: pendingCancellation.signal }, ctx), { cancel: true });
    assert.equal(lookups, 3); assert.equal(summaries, 4);
    let allowed = false;
    const other = { ...model, provider: "other-provider", id: "summary" };
    f.session.modelRuntime.getModel = () => other;
    f.setAuthResolver(async () => { lookups++; return { auth: { apiKey: "other-synthetic" }, source: "api_key" }; });
    createProviderAwareCompactionExtension({ ...options, targetProvider: model.provider, fallbackModel: "other-provider/summary",
      crossProviderBoundaryFn: () => ({ allowed }) })({ ...api, registerCompactionStrategy: (strategy: any) => {
        handler = (event: any, ctx: any) => strategy.prepare(ctx)?.(event, ctx);
      } });
    assert.deepEqual(await handler(event, ctx), { cancel: true });
    assert.equal(lookups, 3); assert.equal(summaries, 4);
    allowed = true;
    assert.ok((await handler(event, ctx)).compaction);
    assert.equal(lookups, 4); assert.equal(summaries, 5);
    assert.equal(received.apiKey, "other-synthetic"); assert.equal(received.model, other);
    assert.equal(f.requests.length, 0, "the summaries are local fixture callbacks, never external requests");
  } finally { await f.release(); }
});

test("native SDK compaction consumes one auth snapshot across summary retries", async () => {
  let snapshot: any;
  const f = await fixture(false, undefined, "gpt-5.1", { compactionExtension: () => {},
    headers: headers => { headers["X-Transformed"] = "retained"; },
    previewHooks: pi => pi.on("session_before_compact", (event: any) => { snapshot = event.auth; }) });
  const provider = f.session.modelRuntime.getProvider(f.model.provider)!, originalStream = provider.streamSimple;
  let providerCalls = 0;
  provider.streamSimple = (model, context, options) => {
    providerCalls++;
    assert.deepEqual(options?.env, { FIXTURE_ACCOUNT: "A" });
    assert.notEqual(options?.env, snapshot.env);
    assert.equal("auth" in options!, false); assert.equal("assertCurrent" in options!, false);
    return originalStream(model, context, options);
  };
  let lookups = 0;
  // Enable one immediate outer summary retry, preserving the fixture's disabled provider retries.
  f.session.settingsManager.getRetrySettings = () => ({ enabled: true, maxRetries: 1, baseDelayMs: 0 });
  const syntheticFetch = globalThis.fetch;
  let attempts = 0;
  globalThis.fetch = async (...args) => {
    const result = await syntheticFetch(...args);
    return attempts++ === 0 ? response([{ type: "response.failed", response: { status: "failed", error: { code: "server_error", message: "terminated" } } }]) : result;
  };
  f.model.headers = { "OpenAI-Project": "old-model-project" };
  f.setAuthResolver(async () => {
    const first = ++lookups === 1;
    return { auth: { apiKey: first ? "snapshot-A" : "other-B", baseUrl: `https://api.openai.com/${first ? "A" : "B"}`,
      headers: first ? { "OpenAI-Project": null, "X-Account": "A" } : { "X-Account": "B", "X-Other-Account": "B" } },
      env: { FIXTURE_ACCOUNT: first ? "A" : "B" }, source: "api_key" };
  });
  try {
    await f.session.compact();
    assert.equal(f.requests.length, 2);
    for (const request of f.requests) {
      assert.match(request.url, /\/A\//);
      assert.equal(request.authorization, "Bearer snapshot-A");
      assert.equal(request.headers.get("openai-project"), null);
      assert.equal(request.headers.get("x-account"), "A");
      assert.equal(request.headers.get("x-other-account"), null);
      assert.equal(request.headers.get("x-transformed"), "retained");
    }
    assert.equal(lookups, 1, "all native summary parts must reuse the captured authentication");
    assert.equal(providerCalls, 2); assert.equal(snapshot.headers["X-Transformed"], undefined);
    assert.doesNotMatch(JSON.stringify(f.manager.getEntries()), /snapshot-A|other-B|FIXTURE_ACCOUNT/);
  } finally { provider.streamSimple = originalStream; await f.release(); }
});

test("native summaries reject auth and dispatch races while custom streams stay usable", async () => {
  for (const phase of ["auth", "headers", "dispatch", "custom", "auto", "branch", "retry"]) {
    let f: Awaited<ReturnType<typeof fixture>>;
    f = await fixture(false, undefined, "gpt-5.1", { compactionExtension: () => {}, previewHooks: pi => {
      if (phase === "headers") pi.on("before_provider_headers", async () => { await f.session.setModel({ ...f.model }); });
    } });
    let lookups = 0, customCalls = 0, retryFinished = 0;
    let unsubscribe = () => {};
    const runtime = f.session.modelRuntime as any, prepare = runtime.prepareRequest;
    f.setAuthResolver(async () => {
      lookups++;
      if (phase === "auth") await f.session.setModel({ ...f.model });
      return { auth: { apiKey: "synthetic" }, source: "api_key" };
    });
    if (phase === "dispatch") runtime.prepareRequest = async (...args: any[]) => {
      const prepared = await prepare.apply(runtime, args);
      await f.session.setModel({ ...f.model });
      return prepared;
    };
    if (phase === "custom") {
      const stream = f.session.agent.streamFunction;
      f.session.agent.streamFunction = (...args) => { customCalls++; return stream(...args); };
    }
    if (phase === "retry") {
      f.session.settingsManager.getRetrySettings = () => ({ enabled: true, maxRetries: 1, baseDelayMs: 0 });
      const syntheticFetch = globalThis.fetch;
      globalThis.fetch = async (...args) => {
        await syntheticFetch(...args);
        return response([{ type: "response.failed", response: { status: "failed", error: { code: "server_error", message: "terminated" } } }]);
      };
      unsubscribe = f.session.subscribe(event => {
        if (event.type === "summarization_retry_scheduled") return f.session.setModel({ ...f.model });
        if (event.type === "summarization_retry_finished") retryFinished++;
      });
    }
    try {
      if (phase === "custom") {
        await f.session.compact();
        assert.equal(customCalls, 1); assert.equal(f.requests.length, 1);
        assert.equal(lookups, 2, "a user-replaced stream retains its own ordinary authentication path");
      } else if (phase === "auto" || phase === "branch") {
        if (phase === "auto") {
          await (f.session as any)._runAutoCompaction("threshold", false);
          assert.equal(f.manager.getEntries().filter(entry => entry.type === "compaction").length, 1);
        }
        else {
          const target = f.manager.getEntries().find(entry => entry.type === "message")!.id;
          const branch = await f.session.navigateTree(target, { summarize: true });
          assert.equal(branch.cancelled, false);
        }
        assert.equal(lookups, 1, phase); assert.equal(f.requests.length, 1, phase);
      } else {
        await assert.rejects(f.session.compact(), /stale model or session/);
        assert.equal(f.requests.length, phase === "retry" ? 1 : 0, phase);
        assert.equal(lookups, 1, phase);
        assert.equal(f.manager.getEntries().filter(entry => entry.type === "compaction").length, 0);
        if (phase === "retry") assert.equal(retryFinished, 1);
      }
    } finally { unsubscribe(); runtime.prepareRequest = prepare; await f.release(); }
  }
});

test("session replacement waits for an idle custom callback and cannot write into the incoming session", async () => {
  let entered!: () => void, release!: () => void;
  const ready = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const f = await fixture(false, undefined, "gpt-5.1", { customEnd: async () => { entered(); await gate; } });
  let sent: Promise<void> | undefined, replacement: ReturnType<AgentSessionRuntime["newSession"]> | undefined;
  try {
    await f.session.prompt("establish boundary"); await f.session.compact();
    const oldFile = f.manager.getSessionFile()!;
    const outgoing = f.session;
    sent = outgoing.sendCustomMessage({ customType: "local", content: "OLD_OWNER_CUSTOM", display: true }, { triggerTurn: false });
    await ready;
    replacement = f.sessionRuntime.newSession();
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(f.session, outgoing, "replacement must retain the owner until the custom hook finishes");
    assert.equal(outgoing.isIdle, false);
    release(); await sent; await replacement;
    await f.session.prompt("INCOMING_REQUEST");
    assert.doesNotMatch(JSON.stringify(f.requests.at(-1)!.payload.input), /OLD_OWNER_CUSTOM/);
    assert.equal(f.manager.getEntries().some((e: any) => e.type === "custom_message"), false);
    assert.equal(SessionManager.open(oldFile, f.root).getEntries().filter((e: any) => e.type === "custom_message" && e.content === "OLD_OWNER_CUSTOM").length, 1);
  } finally { release(); await Promise.allSettled([sent, replacement]); await f.release(); }
});

for (const codex of [false, true]) test(`successful ${codex ? "Codex" : "API"} compaction replays opaque history on the next actual request`, async () => {
  const f = await fixture(codex);
  try {
    // Codex native compaction requires the last successful regular dispatch commitment.
    await f.session.prompt("establish boundary");
    assert.equal((f.session.messages.at(-1) as any).stopReason, "stop", (f.session.messages.at(-1) as any).errorMessage);
    const preview = await f.session.buildProviderRequestPayload({ systemPrompt: f.session.systemPrompt, messages: f.session.messages });
    assert.ok(preview, `missing preview for ${f.session.model?.api}`);
    assert.equal(preview.prompt_cache_key, f.manager.getSessionId(), `preview keys: ${Object.keys(preview)}`);
    if (codex) {
      assert.ok((f.session.messages.at(-1) as any).content[0].textSignature, JSON.stringify(f.session.messages.at(-1)));
      assert.deepEqual(JSON.parse(JSON.stringify((preview.input as any[]).slice(0, -1))), f.requests[0].payload.input);
      assert.deepEqual(JSON.parse(JSON.stringify((preview.input as any[]).at(-1))), {
        type: "message", id: "msg_1", role: "assistant", status: "completed",
        content: [{ type: "output_text", text: "héllo✓", annotations: [] }],
      });
    }
    await f.session.compact();
    const compaction = f.manager.getEntries().find((entry: any) => entry.type === "compaction")!;
    assert.ok(compaction);
    await f.session.prompt("continue after compact");
    assert.equal(f.requests.length, 3);
    const outgoing = f.requests.at(-1)!.payload;
    assert.equal(outgoing.previous_response_id, undefined);
    assert.equal(outgoing.input.filter((item: any) => item.type === "compaction").length, 1);
    assert.match(JSON.stringify(outgoing.input), /continue after compact/);
    assert.match(JSON.stringify(SessionManager.open(f.manager.getSessionFile()!, f.root).getEntries()), /OPAQUE_LIFECYCLE_SENTINEL/);
  } finally { await f.release(); }
});

test("Fast intent stays session-local while final request tier governs Codex compaction", async () => {
  const root = mkdtempSync(join(tmpdir(), "fast-tier-contract-"));
  const prior = process.env.SP_CODING_AGENT_DIR;
  process.env.SP_CODING_AGENT_DIR = root;
  mkdirSync(join(root, "config"));
  try {
    // Both registration orders share the real SDK/preview/native compaction chain.
    for (const fastFirst of [true, false]) {
      saveFastModeConfig({ enabled: true }, fastModeConfigPath(root));
      let override: string | undefined;
      const f = await fixture(true, undefined, "gpt-5.1", { compactionExtension: pi => {
        if (fastFirst) fastExtension(pi, "0.84.1");
        extension(pi);
        if (!fastFirst) fastExtension(pi, "0.84.1");
        pi.on("before_provider_request", (event: any) => override === undefined ? undefined : { ...event.payload, service_tier: override });
      } });
      try {
        const establishAndCompact = async (tier: string | undefined) => {
          const start = f.requests.length;
          await f.session.prompt(`tier boundary ${start}`);
          await f.session.compact();
          assert.equal(f.requests.length, start + 2);
          for (const request of f.requests.slice(start)) {
            assert.equal(request.payload.service_tier, tier);
            assert.equal(request.headers.get("x-codex-routing-hint"), `model=${f.model.id}${tier === undefined ? "" : `;tier=${tier}`}`);
          }
        };
        await establishAndCompact("priority");
        assert.equal(Reflect.has(globalThis, Symbol.for("pi.openai-fast-mode.runtime-state.v2")), false);
        await f.session.prompt("another successful priority request before changing Fast");
        await f.session.prompt("/fast off");
        const count = f.requests.length;
        const compactions = f.manager.getEntries().filter(entry => entry.type === "compaction").length;
        await assert.rejects(f.session.compact(), /Compaction cancelled/);
        assert.equal(f.requests.length, count, "tier mismatch rejects before dispatch");
        assert.equal(f.manager.getEntries().filter(entry => entry.type === "compaction").length, compactions);
        await establishAndCompact(undefined);
        override = "flex";
        await establishAndCompact("flex");
        await f.session.prompt("/fast on");
        await establishAndCompact("flex");
      } finally { await f.release(); }
    }

    // One extension can own sibling sessions without sharing toggles or shutdown.
    saveFastModeConfig({ enabled: false }, fastModeConfigPath(root));
    const handlers = new Map<string, (event: any, ctx: any) => any>();
    let command: any;
    fastExtension({ on: (name, handler) => { handlers.set(name, handler); }, registerCommand: (_name, value) => { command = value; } }, "0.84.1");
    const context = (id: string, codex = true) => ({ model: { provider: codex ? "openai-codex" : "openai", api: codex ? "openai-codex-responses" : "openai-responses" },
      sessionManager: { getSessionId: () => id }, ui: { notify() {}, setStatus() {} } });
    const a = context("a"), b = context("b"), direct = context("direct", false);
    const payload = { service_tier: "default" };
    const hook = handlers.get("before_provider_request")!;
    assert.equal(hook({ payload }, a), undefined);
    await command.handler("on", a);
    assert.equal(hook({ payload }, a).service_tier, "priority");
    assert.equal(hook({ payload }, b), undefined);
    await command.handler("on", direct);
    assert.equal(hook({ payload }, direct), undefined);
    handlers.get("session_shutdown")!({}, b);
    assert.equal(hook({ payload }, a).service_tier, "priority");
    await command.handler("off", a);
    assert.equal(hook({ payload }, a), undefined);
    assert.equal(payload.service_tier, "default");
    handlers.get("session_shutdown")!({}, a);
    handlers.get("session_shutdown")!({}, direct);
  } finally {
    if (prior === undefined) delete process.env.SP_CODING_AGENT_DIR;
    else process.env.SP_CODING_AGENT_DIR = prior;
    rmSync(root, { recursive: true, force: true });
  }
});

for (const failure of ["remote", "summary"] as const) test(`GPT ${failure} failure does not commit compaction or discard local history`, async () => {
  const prior = process.env.SP_OPENAI_SERVER_COMPACTION_SUMMARY_MODE;
  process.env.SP_OPENAI_SERVER_COMPACTION_SUMMARY_MODE = failure === "summary" ? "always" : "fallback";
  const f = await fixture(false, failure);
  try {
    const before = f.manager.getEntries().filter(entry => entry.type === "message");
    await assert.rejects(f.session.compact(failure === "summary" ? "Omit all private data from the summary." : undefined), /Compaction cancelled/);
    assert.deepEqual(f.manager.getEntries().filter(entry => entry.type === "message"), before);
    assert.equal(f.manager.getEntries().some(entry => entry.type === "compaction"), false);
    assert.deepEqual(SessionManager.open(f.manager.getSessionFile()!, f.root).getEntries().filter(entry => entry.type === "message"), before);
    const telemetry: any = f.manager.getEntries().find((entry: any) => entry.customType === "compaction-telemetry-v1");
    assert.equal(telemetry.data.outcome, "failed_closed");
    assert.equal(telemetry.data.failureClass, failure === "summary" ? "portable_summary_failed" : "provider_native_failed");
    assert.equal(f.requests.some(request => request.payload.input?.some((item: any) => item.type === "compaction_trigger")), failure === "remote");
    const failedRequests = failure === "summary" ? 2 : 1;
    assert.equal(f.requests.length, failedRequests);
    f.clearFailure();
    await f.session.prompt("AFTER_FAILED_COMPACTION");
    assert.equal(f.requests.length, failedRequests + 1);
    const next = f.requests.at(-1)!.payload;
    assert.equal(next.previous_response_id, undefined);
    assert.equal(next.input.some((item: any) => item.type === "compaction"), false);
    assert.match(JSON.stringify(next.input), /old 0/);
    assert.match(JSON.stringify(next.input), /AFTER_FAILED_COMPACTION/);
  } finally {
    await f.release();
    if (prior === undefined) delete process.env.SP_OPENAI_SERVER_COMPACTION_SUMMARY_MODE;
    else process.env.SP_OPENAI_SERVER_COMPACTION_SUMMARY_MODE = prior;
  }
});

test("non-GPT native failure retains the existing local compaction fallback", async () => {
  const f = await fixture(false, "remote", "o3");
  try {
    await f.session.compact();
    assert.equal(f.manager.getEntries().filter(entry => entry.type === "compaction").length, 1);
    assert.ok(f.requests.some(request => request.payload.input?.some((item: any) => item.type === "compaction_trigger")));
    f.clearFailure();
    const count = f.requests.length;
    await f.session.prompt("NON_GPT_FALLBACK_NEXT");
    assert.equal(f.requests.length, count + 1);
    assert.equal(f.requests.at(-1)!.payload.input.some((item: any) => item.type === "compaction"), false);
    assert.match(JSON.stringify(f.requests.at(-1)!.payload.input), /NON_GPT_FALLBACK_NEXT/);
    assert.equal(SessionManager.open(f.manager.getSessionFile()!, f.root).getEntries().filter(entry => entry.type === "compaction").length, 1);
  } finally { await f.release(); }
});

test("disposing one extension owner preserves another session's compatible opaque outgoing history", async () => {
  const originalFetch = globalThis.fetch;
  const first = await fixture();
  let second: Awaited<ReturnType<typeof fixture>> | undefined;
  try {
    await first.session.prompt("first owner"); await first.session.compact();
    second = await fixture();
    await second.session.prompt("second owner"); await second.session.compact();
    const secondFetch = globalThis.fetch;
    await first.release();
    globalThis.fetch = secondFetch;
    await second.session.prompt("SURVIVING_OWNER_NEXT");
    assert.equal(second.requests.length, 3);
    assert.equal(second.requests[2].payload.input.some((item: any) => item.type === "compaction"), true);
    assert.match(JSON.stringify(second.requests[2].payload.input), /SURVIVING_OWNER_NEXT/);
    assert.equal(second.manager.getEntries().filter(entry => entry.type === "compaction").length, 1);
  } finally { if (second) await second.release(); await first.release(); globalThis.fetch = originalFetch; }
});

for (const codex of [false, true]) for (const transition of ["refresh", "resume", "switch", "fork-after", "fork-before", "tree-after", "tree-before", "model", "endpoint", "identity"] as const) {
  test(`${codex ? "Codex" : "API"} opaque replay respects ${transition} and preserves persisted local history`, async () => {
    const f = await fixture(codex);
    try {
      const early = f.manager.getEntries().find(entry => entry.type === "message")!.id;
      await f.session.prompt("establish boundary");
      await f.session.compact();
      const file = f.manager.getSessionFile()!;
      const checkpoint = f.manager.getEntries().find(entry => entry.type === "compaction")!.id;
      const before = SessionManager.open(file, f.root).getEntries();
      let opaqueExpected = true;
      if (transition === "refresh") await f.session.prompt("/provider-refresh");
      else if (transition === "resume") await f.sessionRuntime.switchSession(file);
      else if (transition === "switch") {
        await f.sessionRuntime.newSession();
        await f.session.prompt("unrelated session");
        assert.equal(f.requests.at(-1)!.payload.input.some((item: any) => item.type === "compaction"), false);
        await f.sessionRuntime.switchSession(file);
      } else if (transition.startsWith("fork")) {
        await f.sessionRuntime.fork(transition === "fork-after" ? checkpoint : early, { position: "at" });
        opaqueExpected = transition === "fork-after";
      } else if (transition.startsWith("tree")) {
        await f.session.navigateTree(transition === "tree-after" ? checkpoint : early);
        opaqueExpected = transition === "tree-after";
      } else if (transition === "model") {
        await f.session.setModel({ ...f.model, id: `${f.model.id}-other` });
        opaqueExpected = false;
      } else if (transition === "endpoint") { f.changeEndpoint(`${f.model.baseUrl}/other`); opaqueExpected = false; }
      else if (transition === "identity") { f.changeKey(codex ? token("two") : "sk-offline-two"); opaqueExpected = false; }
      const count = f.requests.length;
      await f.session.prompt("TRANSITION_NEXT_PROMPT");
      assert.equal(f.requests.length, count + 1, "no probe or duplicate request");
      const request = f.requests.at(-1)!;
      assert.equal(request.payload.previous_response_id, undefined, "live continuation must not cross lifecycle boundaries");
      assert.equal(request.payload.input.some((item: any) => item.type === "compaction"), opaqueExpected);
      assert.match(JSON.stringify(request.payload.input), /TRANSITION_NEXT_PROMPT/);
      assert.equal(request.authorization, `Bearer ${transition === "identity" ? (codex ? token("two") : "sk-offline-two") : (codex ? token() : "sk-offline-one")}`);
      if (transition === "endpoint") assert.match(request.url, /\/other\//);
      // Original durable entries remain authoritative even after incompatible replay or branch navigation.
      const reopened = SessionManager.open(file, f.root).getEntries();
      for (const entry of before) assert.deepEqual(reopened.find(candidate => candidate.id === entry.id), entry);
      if (["model", "endpoint", "identity"].includes(transition)) {
        const portableReply = (f.session.messages.at(-1) as any).content[0].text;
        if (transition === "model") await f.session.setModel(f.model);
        else if (transition === "endpoint") f.changeEndpoint(f.model.baseUrl);
        else f.changeKey(codex ? token() : "sk-offline-one");
        await f.session.prompt("COMPATIBLE_RETURN");
        assert.equal(f.requests.at(-1)!.payload.input.some((item: any) => item.type === "compaction"), true);
        assert.match(JSON.stringify(f.requests.at(-1)!.payload.input), /COMPATIBLE_RETURN/);
        assert.ok(JSON.stringify(f.requests.at(-1)!.payload.input).includes(portableReply), "returning to the compatible identity retains the intervening local reply");
        assert.equal(JSON.stringify(f.requests.at(-1)!.payload.input).includes(`PRIVATE_REASONING_${count + 1}`), false);
        await f.sessionRuntime.switchSession(f.manager.getSessionFile()!);
        await f.session.prompt("COMPATIBLE_REOPEN");
        assert.ok(JSON.stringify(f.requests.at(-1)!.payload.input).includes(portableReply), "persisted reconstruction retains the same portable reply");
        assert.equal(JSON.stringify(f.requests.at(-1)!.payload.input).includes(`PRIVATE_REASONING_${count + 1}`), false);
      }
    } finally { await f.release(); }
  });
}

test("same-identity Codex token rotation retains opaque replay and uses the rotated credential", async () => {
  const f = await fixture(true);
  try {
    await f.session.prompt("establish boundary");
    await f.session.compact();
    f.changeKey(token("one", 2));
    await f.session.prompt("ROTATED_NEXT");
    assert.equal(f.requests.length, 3);
    assert.equal(f.requests[2].authorization, `Bearer ${token("one", 2)}`);
    assert.equal(f.requests[2].payload.input.some((item: any) => item.type === "compaction"), true);
    assert.match(JSON.stringify(f.requests[2].payload.input), /ROTATED_NEXT/);
  } finally { await f.release(); }
});

test("ordinary Codex requests and native compaction resolve refreshed auth at their request boundaries", async () => {
  const f = await fixture(true);
  const store = new InMemoryCredentialStore();
  const provider: any = { id: "openai-codex", auth: { oauth: openaiCodexOAuth } };
  await store.modify("openai-codex", async () => ({ type: "oauth", access: token(), refresh: "synthetic-refresh",
    expires: Date.now() + 60000, accountId: "one" }));
  f.setAuthResolver(() => resolveProviderAuth(provider, store, { env: async () => undefined, fileExists: async () => false }));
  try {
    await f.session.prompt("AUTH_BOUNDARY");
    assert.equal(f.refreshRequests.length, 1);
    assert.equal(f.requests[0].authorization, `Bearer ${token("one", 2)}`);
    await store.modify("openai-codex", async current => ({ ...current!, expires: Date.now() + 60000 }));
    await f.session.compact();
    assert.equal(f.refreshRequests.length, 2);
    assert.equal(f.requests[1].authorization, `Bearer ${token("one", 3)}`);
    await f.session.prompt("AUTH_AFTER_COMPACT");
    assert.equal(f.refreshRequests.length, 2);
    assert.equal(f.requests.length, 3);
    assert.equal(f.requests[2].authorization, `Bearer ${token("one", 3)}`);
    assert.equal(f.requests[2].payload.input.some((item: any) => item.type === "compaction"), true);
  } finally { await f.release(); }
});

test("legacy opaque history without a proven request identity falls back to portable local context", async () => {
  const f = await fixture();
  try {
    const first = f.manager.getEntries().find(entry => entry.type === "message")!.id;
    f.manager.appendCompaction("PORTABLE_LEGACY_SUMMARY", first, 10000, { remoteCompaction: {
      version: 2, provider: "openai-responses-compaction", modelKey: "openai:openai-responses:gpt-5.1", replacementHistory: [artifact],
    } }, true);
    await f.sessionRuntime.switchSession(f.manager.getSessionFile()!);
    await f.session.prompt("LEGACY_NEXT");
    const input = f.requests.at(-1)!.payload.input;
    assert.equal(input.some((item: any) => item.type === "compaction"), false);
    assert.match(JSON.stringify(input), /PORTABLE_LEGACY_SUMMARY/);
    assert.equal(f.manager.getEntries().filter(entry => entry.type === "compaction").length, 1);
  } finally { await f.release(); }
});

test("manifest-loaded compaction packages preserve selection and configuration in either order", { timeout: 10000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "compaction-assembly-"));
  const names = ["SP_CODING_AGENT_DIR", "SP_OPENAI_SERVER_COMPACTION_ENABLED", "SP_OPENAI_SERVER_COMPACTION_SUMMARY_MODE",
    "SP_OPENAI_SERVER_COMPACTION_SUMMARY_MODEL", "SP_PORTABLE_COMPACTION_FALLBACK", "SP_PORTABLE_COMPACTION_TARGET_PROVIDER",
    "SP_PORTABLE_COMPACTION_FALLBACK_MODEL", "SP_PORTABLE_COMPACTION_ALLOW_CROSS_PROVIDER"];
  const previous = names.map(name => process.env[name]);
  try {
    for (const name of names) delete process.env[name];
    process.env.SP_CODING_AGENT_DIR = root; mkdirSync(join(root, "config"));
    const repo = fileURLToPath(new URL("../../", import.meta.url));
    const settingsDir = join(repo, ".sp", "config");
    const packages: string[] = JSON.parse(readFileSync(join(settingsDir, "settings.json"), "utf8")).packages;
    const entries: string[] = [];
    for (const source of packages) {
      const path = resolve(settingsDir, source), manifest = JSON.parse(readFileSync(join(path, "package.json"), "utf8"));
      if (!["@super-pi/openai-server-compaction", "@super-pi/provider-aware-compaction", "@super-pi/openai-fast-mode"].includes(manifest.name)) continue;
      assert.equal(manifest.pi.extensions.length, 1); entries.push(resolve(path, manifest.pi.extensions[0]));
    }
    assert.equal(entries.length, 3);
    const configure = (name: string, value: unknown) => writeFileSync(join(root, "config", name), JSON.stringify(value));
    for (const reverse of [false, true]) {
      configure("openai-server-compaction.json", {}); configure("provider-aware-compaction.json", {});
      if (reverse) saveFastModeConfig({ enabled: false }, fastModeConfigPath(root));
      const paths = reverse ? [...entries].reverse() : entries;
      let legacyCancel = false, summaryHooks = 0;
      const f = await fixture(true, undefined, "gpt-5.1", { extensionPaths: paths, previewHooks: pi => {
        pi.on("session_before_compact", () => legacyCancel ? { cancel: true } : undefined);
        pi.on("before_provider_request", (event: any) => { if (event.purpose === "supplemental-summary") summaryHooks++; });
      } });
      try {
        const loaded = f.session.resourceLoader.getExtensions();
        const freshHistory = (label: string) => {
          for (let index = 0; index < 3; index++) f.manager.appendMessage({ role: "user", content: `${label} ${"history ".repeat(256)}`, timestamp: index });
        };
        assert.deepEqual(loaded.errors, []);
        const real = loaded.extensions.map(item => resolve(item.resolvedPath)).filter(path => entries.includes(path));
        assert.deepEqual(real, paths); assert.equal(new Set(real).size, 3);
        assert.equal(loaded.runtime.compactionStrategies.size, 2);
        assert.equal(loaded.runtime.compactionStrategies.get("provider-aware")!.prepare(f.session.extensionRunner.createContext()), undefined);
        await f.session.prompt("MANIFEST_DEFAULT"); await f.session.compact();
        assert.equal(f.requests.length, 2); assert.equal(f.requests[0].payload.service_tier, undefined);
        assert.ok(f.requests[1].payload.input.some((item: any) => item.type === "compaction_trigger"));
        assert.equal(summaryHooks, 0);
        await f.session.prompt("/fast on");
        assert.equal(f.requests.length, 2, "the loaded /fast command must not become a model prompt");
        configure("openai-server-compaction.json", { portableSummaryMode: "always" });
        await f.session.prompt("MANIFEST_FAST_PORTABLE"); await f.session.compact();
        assert.equal(f.requests.length, 5); assert.equal(summaryHooks, 1);
        for (const request of f.requests.slice(2)) assert.equal(request.payload.service_tier, "priority");
        assert.ok(f.requests.at(-1)!.payload.input.some((item: any) => item.type === "compaction_trigger"));

        configure("openai-server-compaction.json", { enabled: false });
        await f.session.reload();
        const current = f.session.resourceLoader.getExtensions();
        assert.deepEqual(current.errors, []); assert.equal(current.runtime.compactionStrategies.size, 2);
        assert.equal(current.runtime.compactionStrategies.get("openai-server")!.prepare(f.session.extensionRunner.createContext()), undefined);
        freshHistory("NATIVE_FALLBACK");
        await f.session.compact();
        assert.equal(f.requests.length, 6);
        assert.equal(f.requests.at(-1)!.payload.input.some((item: any) => item.type === "compaction_trigger"), false);
        assert.equal((f.manager.getEntries().filter(entry => entry.type === "compaction").at(-1) as any).details?.remoteCompaction, undefined);

        await f.session.setModel({ ...f.model, provider: "deepseek", id: "deepseek-v4-flash", api: "openai-completions" });
        assert.equal(current.runtime.compactionStrategies.get("provider-aware")!.prepare(f.session.extensionRunner.createContext()), undefined);
        configure("provider-aware-compaction.json", { policies: ["deepseek-self-preserve-v1"] });
        freshHistory("EXPLICIT_SELF_PRESET");
        await f.session.compact();
        assert.equal(f.requests.length, 7); assert.ok(f.requests.at(-1)!.payload.messages);
        const compact = f.manager.getEntries().filter(entry => entry.type === "compaction").at(-1) as any;
        assert.equal(compact.details.providerAwareCompaction.policy, "deepseek-self-preserve-v1");
        assert.equal(compact.details.providerAwareCompaction.requestShape, "original-prefix-v1");
        legacyCancel = true;
        freshHistory("LEGACY_CANCEL");
        await assert.rejects(f.session.compact(), /cancel/i);
        assert.equal(f.requests.length, 7);
        assert.equal(f.manager.getEntries().filter(entry => entry.type === "compaction").at(-1), compact);
      } finally { await f.release(); }
    }
  } finally {
    names.forEach((name, index) => { if (previous[index] === undefined) delete process.env[name]; else process.env[name] = previous[index]; });
    rmSync(root, { recursive: true, force: true }); assert.equal(existsSync(root), false);
  }
});

test("Codex post-compaction boundary rejection preserves evidence and allows explicit recovery", async () => {
  const originalWebSocket = globalThis.WebSocket;
  FakeCodexWebSocket.sentBodies = []; FakeCodexWebSocket.connections = 0; FakeCodexWebSocket.closes = 0;
  FakeCodexWebSocket.mode = "success";
  FakeCodexWebSocket.replies = body => body.input?.some((item: any) => item.type === "compaction_trigger")
    ? [{ type: "response.output_item.done", output_index: 0, item: artifact },
      { type: "response.completed", response: { id: "compact-boundary", status: "completed", output: [artifact], usage: { input_tokens: 10, output_tokens: 2 } } }]
    : textEvents();
  globalThis.WebSocket = FakeCodexWebSocket as any;
  let invalid = "", hooks = 0;
  const f = await fixture(true, undefined, "gpt-5.1", { previewHooks: pi => {
    pi.on("before_provider_request", (event: any) => {
      hooks++;
      if (invalid === "missing") event.payload.input = event.payload.input.filter((item: any) => item.type !== "compaction");
      else if (invalid === "ambiguous") event.payload.input.push({ ...artifact });
    });
  } });
  const owner = tokenOwner(f);
  try {
    f.session.agent.transport = "websocket-cached";
    await f.session.prompt("BEFORE_CACHED_COMPACTION");
    await f.session.compact();
    assert.equal(FakeCodexWebSocket.sentBodies.length, 2);
    assert.equal(FakeCodexWebSocket.sentBodies[1].previous_response_id, "resp_1");
    const before = { ...owner.diagnostics };
    for (const failure of ["missing", "ambiguous"]) {
      invalid = failure; const priorHooks = hooks;
      await f.session.prompt(`REJECT_${failure}`);
      const message = f.session.messages.at(-1) as any;
      assert.equal(message.stopReason, "error");
      assert.match(message.errorMessage, /post-compaction continuation boundary.*missing or ambiguous/i);
      assert.equal(hooks, priorHooks + 1, "a rejected request must not replay payload hooks");
      assert.equal(FakeCodexWebSocket.sentBodies.length, 2); assert.equal(f.requests.length, 0);
      assert.deepEqual(owner.diagnostics, before, "rejection keeps the established cache evidence");
    }
    invalid = "";
    await f.session.prompt("VALID_BOUNDARY_AGAIN");
    assert.equal(FakeCodexWebSocket.sentBodies.length, 3);
    const recovered = FakeCodexWebSocket.sentBodies.at(-1)!;
    assert.equal(recovered.previous_response_id, "compact-boundary");
    assert.equal(recovered.input.some((item: any) => item.type === "compaction"), false);
    assert.match(JSON.stringify(recovered.input), /VALID_BOUNDARY_AGAIN/);
    await f.session.prompt("/provider-refresh");
    await f.session.prompt("FRESH_TRANSPORT_WITH_OPAQUE_HISTORY");
    const fresh = FakeCodexWebSocket.sentBodies.at(-1)!;
    assert.equal(FakeCodexWebSocket.sentBodies.length, 4); assert.equal(f.requests.length, 0);
    assert.equal(fresh.previous_response_id, undefined);
    assert.equal(fresh.input.filter((item: any) => item.type === "compaction").length, 1);
    assert.equal(f.manager.getEntries().filter(entry => entry.type === "compaction").length, 1);
  } finally {
    try { await f.release(); }
    finally { globalThis.WebSocket = originalWebSocket; FakeCodexWebSocket.replies = undefined; FakeCodexWebSocket.sentBodies = []; }
  }
  for (const count of Object.values(owner.diagnostics)) assert.equal(count, 0);
});

for (const transition of ["compatible", "refresh", "resume", "model", "endpoint", "identity", "token-rotation", "local-history-change"] as const) {
  test(`native Codex live continuation obeys ${transition} at the next actual outgoing request`, async () => {
    const originalWebSocket = globalThis.WebSocket;
    FakeCodexWebSocket.sentBodies = []; FakeCodexWebSocket.connections = 0; FakeCodexWebSocket.closes = 0;
    FakeCodexWebSocket.mode = "success"; FakeCodexWebSocket.replies = () => textEvents();
    globalThis.WebSocket = FakeCodexWebSocket as any;
    const f = await fixture(true);
    try {
      f.session.agent.transport = "websocket-cached";
      await f.session.prompt("FIRST_WEBSOCKET_USER");
      if (transition === "refresh") await f.session.prompt("/provider-refresh");
      else if (transition === "resume") { await f.sessionRuntime.switchSession(f.manager.getSessionFile()!); f.session.agent.transport = "websocket-cached"; }
      else if (transition === "model") await f.session.setModel({ ...f.model, id: `${f.model.id}-other` });
      else if (transition === "endpoint") f.changeEndpoint(`${f.model.baseUrl}/other`);
      else if (transition === "identity") f.changeKey(token("two"));
      else if (transition === "token-rotation") f.changeKey(token("one", 2));
      else if (transition === "local-history-change") {
        await f.session.sendCustomMessage({ customType: "local", content: "LOCAL_AUTHORITY", display: true }, { triggerTurn: false });
      }
      await f.session.prompt("SECOND_WEBSOCKET_USER");
      assert.equal(FakeCodexWebSocket.sentBodies.length, 2);
      assert.equal(f.requests.length, 0, "no SSE fallback or probe");
      const next = FakeCodexWebSocket.sentBodies[1];
      const reuse = transition === "compatible" || transition === "local-history-change";
      assert.equal(next.previous_response_id, reuse ? "resp_1" : undefined);
      assert.match(JSON.stringify(next.input), /SECOND_WEBSOCKET_USER/);
      assert.equal(JSON.stringify(next.input).includes("FIRST_WEBSOCKET_USER"), !reuse);
      if (transition === "local-history-change") assert.match(JSON.stringify(next.input), /LOCAL_AUTHORITY/);
      assert.equal(FakeCodexWebSocket.connections, reuse ? 1 : 2);
      const disk = SessionManager.open(f.manager.getSessionFile()!, f.root).getEntries();
      assert.equal(disk.filter((entry: any) => entry.type === "message" && entry.message.role === "user" && JSON.stringify(entry.message.content).includes("SECOND_WEBSOCKET_USER")).length, 1);
    } finally {
      await f.release(); globalThis.WebSocket = originalWebSocket; FakeCodexWebSocket.replies = undefined;
    }
    assert.ok(FakeCodexWebSocket.closes >= 1);
  });
}
