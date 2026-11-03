import assert from "node:assert/strict";
import { Session } from "node:inspector/promises";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate } from "node:timers/promises";
import { InMemoryCredentialStore } from "../../packages/ai/src/auth/credential-store.ts";
import { createAgentSession } from "../../packages/coding-agent/src/core/sdk.ts";
import { emitSessionShutdownEvent } from "../../packages/coding-agent/src/core/extensions/runner.ts";
import { DefaultResourceLoader } from "../../packages/coding-agent/src/core/resource-loader.ts";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.ts";
import { SettingsManager } from "../../packages/coding-agent/src/core/settings-manager.ts";
import { ModelRuntime } from "../../packages/coding-agent/src/core/model-runtime.ts";
import extension from "../../packages/openai-server-compaction/src/index.ts";
import { closeOpenAICodexWebSocketSessions, createOpenAICodexTransportOwner, resetOpenAICodexWebSocketDebugStats, streamSimple } from "../../packages/ai/src/api/openai-codex-responses.ts";
import { codexModel, codexToken, responsesContext, sseFrames, textEvents } from "../../tests/helpers/responses-sse-fixture.ts";
import { FakeCodexWebSocket } from "../../tests/helpers/codex-websocket-fixture.ts";

// Bounded manual production probe: synthetic transport, optional SDK fixture, no CI job.
const gc = (globalThis as { gc?: () => void }).gc;
assert.ok(gc, "run with --expose-gc");
let sessionId = "bench-codex-capability";
const responsesDispatch = process.argv.includes("--responses-dispatch");
const sdk = responsesDispatch || process.argv.includes("--sdk");
const websocketOwner = process.argv.includes("--websocket-owner");
const codexOwner = process.argv.includes("--codex-owner") || websocketOwner ? createOpenAICodexTransportOwner() : undefined;
const model = responsesDispatch ? { ...codexModel, id: "gpt-5.1", api: "openai-responses", provider: "openai", baseUrl: "https://api.openai.com/v1" } : codexModel;
let providerRegistrations = 0;
let root: string | undefined, session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined, pi: any;
const legacyKey = Symbol.for("@super-pi/ai/codex-remote-compaction-sessions");
const previous = Object.getOwnPropertyDescriptor(globalThis, legacyKey);
const legacy = new Set([sessionId]);
let legacyReads = 0, requests = 0, hooks = 0, deltas = 0, wrongHeaders = 0;
Object.defineProperty(globalThis, legacyKey, { configurable: true, get() { legacyReads++; return legacy; } });
const events: any[] = textEvents();
events.splice(2, 0, ...Array.from({ length: 7 }, () => ({ ...events[1] })));
const sse = sseFrames(events);
const originalWebSocket = globalThis.WebSocket;
const sockets: FakeCodexWebSocket[] = [];
let responseOutcome = "success", expectedEnabled = false;
if (websocketOwner) {
  assert.equal(sdk, false);
  FakeCodexWebSocket.replies = () => responseOutcome === "failure"
    ? [{ type: "response.failed", response: { error: { code: "offline", message: "synthetic failure" } } }] : events;
  class Socket extends FakeCodexWebSocket {
    private readonly headers: Headers;
    constructor(url: string, options: { headers: Record<string, string> }) { super(url, options); this.headers = new Headers(options.headers); sockets.push(this); }
    override send(body: string) {
      requests++;
      if ((this.headers.get("x-codex-beta-features")?.includes("remote_compaction_v2") ?? false) !== expectedEnabled) wrongHeaders++;
      super.send(body);
    }
  }
  globalThis.WebSocket = Socket as unknown as typeof WebSocket;
}
const refs: WeakRef<object>[] = [];
const profiler = new Session();
async function request(enabled: boolean, track: boolean, outcome = "success") {
  responseOutcome = outcome; expectedEnabled = enabled;
  if (sdk) pi.setCodexRemoteCompactionEnabled?.(enabled);
  const controller = new AbortController();
  const options = {
    apiKey: codexToken(), transport: websocketOwner ? "websocket-cached" as const : "sse" as const, sessionId, maxRetries: 0,
    codexRemoteCompaction: sdk ? undefined : enabled, signal: controller.signal,
    onPayload(payload: any) {
      hooks++; assert.equal(Object.hasOwn(payload, "codexRemoteCompaction"), false);
      if (track) refs.push(new WeakRef(payload));
      if (outcome === "abort") controller.abort();
    },
    fetch: (async (_url, init) => {
      requests++;
      const enabledHeader = new Headers(init?.headers).get("x-codex-beta-features")?.includes("remote_compaction_v2") ?? false;
      if (!responsesDispatch && enabledHeader !== enabled) wrongHeaders++;
      if (outcome === "failure") throw new Error("synthetic failure");
      return new Response(sse, { headers: { "content-type": "text/event-stream" } });
    }) as typeof fetch,
  };
  const active = session ? await session.agent.streamFunction(model, responsesContext, options) : (codexOwner?.streamSimple ?? streamSimple)(model, responsesContext, options);
  for await (const event of active) if (event.type === "text_delta") deltas++;
  const result = await active.result();
  assert.equal(result.stopReason, outcome === "success" ? "stop" : outcome === "abort" ? "aborted" : "error", result.errorMessage);
  if (track) refs.push(new WeakRef(options), new WeakRef(active), new WeakRef(result));
}
try {
  if (sdk) {
    root = mkdtempSync(join(tmpdir(), "sp-codex-capability-")); console.error(`ownedFixture=${root}`);
    const settings = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false }, transport: "sse" });
    const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false });
    runtime.getAuth = async () => ({ auth: { apiKey: codexToken() }, source: "api_key" });
    runtime.getModel = () => model; runtime.hasConfiguredAuth = () => true;
    const resources = new DefaultResourceLoader({ cwd: root, agentDir: root, settingsManager: settings, noExtensions: false,
      noContextFiles: true, noSkills: true, noPromptTemplates: true, noThemes: true,
      extensionFactories: [api => { pi = api; extension(api); }] });
    await resources.reload();
    ({ session } = await createAgentSession({ cwd: root, agentDir: root, settingsManager: settings, resourceLoader: resources,
      sessionManager: SessionManager.inMemory(root), modelRuntime: runtime, model, noTools: "all" }));
    sessionId = session.sessionManager.getSessionId();
    await session.bindExtensions({});
    providerRegistrations = runtime.getRegisteredProviderIds().length;
  }
  await request(true, false);
  requests = hooks = deltas = wrongHeaders = legacyReads = 0;
  gc(); profiler.connect();
  await profiler.post("HeapProfiler.startSampling", { samplingInterval: 4096, includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true });
  const times = new Float64Array(32);
  for (let i = 0; i < times.length; i++) {
    const start = performance.now(); await request(i % 2 === 0, true); times[i] = performance.now() - start;
  }
  const { profile } = await profiler.post("HeapProfiler.stopSampling");
  let bytes = 0;
  const sites: Array<{ name: string; bytes: number }> = [];
  const pending = [profile.head];
  while (pending.length) {
    const node = pending.pop()!; bytes += node.selfSize;
    if (node.selfSize) sites.push({ name: `${node.callFrame.functionName} ${node.callFrame.url}:${node.callFrame.lineNumber + 1}`, bytes: node.selfSize });
    for (const child of node.children) pending.push(child);
  }
  const measured = { requests, hooks, deltas, wrongHeaders, legacyReads };
  assert.equal(requests, 32); assert.equal(hooks, 32); assert.equal(deltas, 256);
  await request(false, true, "failure"); await request(false, true, "abort");
  if (session) await emitSessionShutdownEvent(session.extensionRunner, { type: "session_shutdown", reason: "exit" });
  await codexOwner?.dispose();
  const hostCodexOwner = session?.extensionRunner.getOpenAICodexDispatch().owner;
  closeOpenAICodexWebSocketSessions(sessionId); resetOpenAICodexWebSocketDebugStats(sessionId);
  for (let i = 0; i < 4; i++) { await setImmediate(); gc(); }
  const retained = refs.filter(ref => ref.deref()).length;
  assert.equal(retained, 0);
  if (codexOwner) for (const count of Object.values(codexOwner.diagnostics)) assert.equal(count, 0);
  if (hostCodexOwner) for (const count of Object.values(hostCodexOwner.diagnostics)) assert.equal(count, 0);
  let listeners = 0;
  for (const socket of sockets) for (const set of socket.listeners.values()) listeners += set.size;
  assert.equal(listeners, 0);
  if (!process.argv.includes("--baseline")) { assert.equal(measured.wrongHeaders, 0); assert.equal(measured.legacyReads, 0); }
  times.sort(); sites.sort((a, b) => b.bytes - a.bytes);
  if (responsesDispatch && !process.argv.includes("--baseline")) assert.equal(providerRegistrations, 0);
  console.log(JSON.stringify({ sdk, responsesDispatch, websocketOwner, providerRegistrations, owner: (codexOwner ?? hostCodexOwner)?.diagnostics, listeners, ...measured, failureAndAbort: 2, trackedReferences: refs.length, retained,
    sampledBytesPerRequest: bytes / 32, p95Ms: times[30], leadingSites: sites.slice(0, 3), node: process.version }));
} finally {
  profiler.disconnect();
  try { if (session) await session.extensionRunner.disposeProviderOwners(); await codexOwner?.dispose(); }
  finally {
    session?.dispose();
    globalThis.WebSocket = originalWebSocket;
    FakeCodexWebSocket.replies = undefined;
    FakeCodexWebSocket.sentBodies.length = 0;
    closeOpenAICodexWebSocketSessions(sessionId); resetOpenAICodexWebSocketDebugStats(sessionId);
    if (previous) Object.defineProperty(globalThis, legacyKey, previous); else Reflect.deleteProperty(globalThis, legacyKey);
    if (root) { rmSync(root, { recursive: true, force: true }); assert.equal(existsSync(root), false); console.error(`removedFixture=${root}`); }
  }
}
