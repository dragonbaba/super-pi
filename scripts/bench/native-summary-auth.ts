import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Session } from "node:inspector/promises";
import { setImmediate } from "node:timers/promises";
import { InMemoryCredentialStore } from "../../packages/ai/src/auth/credential-store.ts";
import { createAgentSession } from "../../packages/coding-agent/src/core/sdk.ts";
import { DefaultResourceLoader } from "../../packages/coding-agent/src/core/resource-loader.ts";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.ts";
import { SettingsManager } from "../../packages/coding-agent/src/core/settings-manager.ts";
import { ModelRuntime } from "../../packages/coding-agent/src/core/model-runtime.ts";
import { AgentSessionRuntime } from "../../packages/coding-agent/src/core/agent-session-runtime.ts";
import { sseFrames, textEvents } from "../../tests/helpers/responses-sse-fixture.ts";
import compactionExtension from "../../packages/openai-server-compaction/src/index.ts";
import { buildPortableSummaryContext } from "../../packages/openai-server-compaction/src/remote-compaction.ts";
import { SupplementalSummaryScope } from "../../packages/coding-agent/src/core/supplemental-summary.ts";

// Manual, 16 native SDK summaries (or optional portable summaries with --portable).
// Actual request assembly; fetch is strictly local synthetic SSE.
const gc = (globalThis as { gc?: () => void }).gc;
assert.ok(gc, "run with --expose-gc");
const portable = process.argv.includes("--portable");
const hostScope = process.argv.includes("--host-scope");
const previousMode = process.env.SP_OPENAI_SERVER_COMPACTION_SUMMARY_MODE;
const previousModel = process.env.SP_OPENAI_SERVER_COMPACTION_SUMMARY_MODEL;
if (portable) { process.env.SP_OPENAI_SERVER_COMPACTION_SUMMARY_MODE = "always"; process.env.SP_OPENAI_SERVER_COMPACTION_SUMMARY_MODEL = "current"; }
const root = mkdtempSync(join(tmpdir(), "sp-native-summary-"));
console.error(`ownedFixture=${root}`);
const model: any = { id: "gpt-5.1", name: "offline", api: "openai-responses", provider: "openai",
  baseUrl: "https://api.openai.com/v1", headers: { "OpenAI-Project": "old-model-project" }, input: ["text"], reasoning: false,
  contextWindow: 64000, maxTokens: 512, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
const settings = SettingsManager.inMemory({ compaction: { enabled: false, keepRecentTokens: 128, reserveTokens: 128 },
  retry: { enabled: false }, transport: "sse", providerRetry: { maxRetries: 0 } });
const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false });
let localLookups = 0, lookups = 0, requests = 0, wrongEndpoints = 0, mixedHeaders = 0, mixedEnv = 0, headerHooks = 0, tracked = false;
let cancelNext = false, failNext = false;
let portableCalls = 0;
let selectedProbe = false, selectedCalls = 0;
const candidate = { ...model, id: "gpt-summary" };
let activeSession: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
runtime.getAuth = async () => {
  lookups++; const lane = ++localLookups === 1 ? "A" : "B";
  if (selectedProbe && lane === "B") {
    const resolved = { auth: { apiKey: "synthetic-B", baseUrl: "https://api.openai.com/B",
      headers: { "OpenAI-Project": null, "X-Account": "B" } }, env: { LANE: "B" }, source: "api_key" };
    for (const value of [resolved, resolved.auth, resolved.auth.headers, resolved.env]) refs.push(new WeakRef(value));
    return resolved;
  }
  return { auth: { apiKey: `synthetic-${lane}`, baseUrl: `https://api.openai.com/${lane}`,
    headers: lane === "A" ? { "OpenAI-Project": null, "X-Account": "A" } : { "X-Other-Account": "B" } },
    env: lane === "A" ? { LANE: "A" } : { LANE: "B", OTHER_LANE: "B" }, source: "api_key" };
};
runtime.getModel = (_provider, id) => id === candidate.id ? candidate : model;
runtime.hasConfiguredAuth = () => true;
const provider = runtime.getProvider("openai")!, originalStream = provider.streamSimple;
provider.streamSimple = (model, context, options) => {
  if (portable) portableCalls++;
  if (portable && selectedProbe) {
    selectedCalls++;
    assert.equal(model.baseUrl, "https://api.openai.com/B"); assert.equal(options?.env?.LANE, "B");
    assert.equal(options?.apiKey, "synthetic-B"); assert.equal(options?.headers?.["OpenAI-Project"], null);
    refs.push(new WeakRef(model));
  } else if (options?.env?.LANE !== "A" || options?.env?.OTHER_LANE) mixedEnv++;
  if (tracked && options) refs.push(new WeakRef(options));
  if (portable && cancelNext) activeSession!.abortCompaction();
  return originalStream(model, context, options);
};
const refs: WeakRef<object>[] = [];
const originalScopeRun = SupplementalSummaryScope.prototype.run;
SupplementalSummaryScope.prototype.run = function (callback) {
  if (tracked) { refs.push(new WeakRef(this), new WeakRef((this as any).dependencies), new WeakRef(this.stream)); }
  return originalScopeRun.call(this, callback) as never;
};
const originalRuntimeStream = runtime.streamSimple;
runtime.streamSimple = function (...args) {
  const request = args[3];
  if (tracked && request) refs.push(new WeakRef(request), new WeakRef(request.assertCurrent));
  return originalRuntimeStream.apply(this, args);
};
const resources = new DefaultResourceLoader({ cwd: root, agentDir: root, settingsManager: settings,
  noExtensions: true, noSkills: true, noContextFiles: true, noThemes: true, noPromptTemplates: true,
  extensionFactories: [pi => {
    if (portable) compactionExtension(pi);
    pi.on("session_before_compact", event => {
      if (tracked) for (const value of [event.auth!, event.auth!.model, event.auth!.headers!, event.auth!.env!]) refs.push(new WeakRef(value));
    });
    if (hostScope) pi.registerCompactionStrategy!({ id: "benchmark-summary", prepare: () => event =>
      pi.withSupplementalSummary!(event.signal, async stream => {
        const auth = event.auth!;
        const response = await (await stream(auth.model, buildPortableSummaryContext(event), { apiKey: auth.apiKey, headers: auth.headers, env: auth.env })).result();
        if (response.stopReason === "error" || response.stopReason === "aborted") throw new Error(response.errorMessage);
        return { compaction: { summary: "synthetic summary", firstKeptEntryId: event.preparation.firstKeptEntryId, tokensBefore: event.preparation.tokensBefore } };
      }),
    });
    pi.on("before_provider_headers", () => { headerHooks++; if (cancelNext) activeSession!.abortCompaction(); });
  }] });
const previousFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  requests++; if (!String(url).includes("/A/") && !(selectedProbe && String(url).includes("/B/"))) wrongEndpoints++;
  const headers = new Headers(init?.headers);
  if (headers.has("openai-project") || headers.has("x-other-account")) mixedHeaders++;
  if (failNext) return new Response(JSON.stringify({ error: { message: "synthetic rejection", type: "invalid_request_error" } }), { status: 400, headers: { "content-type": "application/json" } });
  if (portable && JSON.parse(String(init?.body)).input?.some((item: any) => item.type === "compaction_trigger")) {
    const item = { type: "compaction", encrypted_content: "synthetic-opaque" };
    return new Response(sseFrames([{ type: "response.output_item.done", output_index: 0, item },
      { type: "response.completed", response: { status: "completed", output: [item] } }]), { headers: { "content-type": "text/event-stream" } });
  }
  return new Response(sseFrames(textEvents()), { headers: { "content-type": "text/event-stream" } });
};
const profiler = new Session();
let owner: AgentSessionRuntime | undefined;
try {
  await resources.reload();
  const { session } = await createAgentSession({ cwd: root, agentDir: root, resourceLoader: resources, settingsManager: settings,
    sessionManager: SessionManager.inMemory(root), modelRuntime: runtime, model, noTools: "all" });
  activeSession = session;
  const factory = (session as any)._createSummarizationStream;
  if (factory) (session as any)._createSummarizationStream = (...args: any[]) => {
    const stream = factory(...args); if (tracked) refs.push(new WeakRef(stream)); return stream;
  };
  owner = new AgentSessionRuntime(session, { cwd: root, agentDir: root } as any);
  await session.bindExtensions({});
  async function summarize() {
    for (let i = 0; i < 3; i++) session.sessionManager.appendMessage({ role: "user", content: "history ".repeat(256), timestamp: i });
    localLookups = 0; await session.compact(portable ? "Preserve the requested constraints." : undefined);
  }
  await summarize();
  lookups = requests = wrongEndpoints = mixedHeaders = mixedEnv = headerHooks = portableCalls = 0; tracked = true;
  gc(); profiler.connect();
  await profiler.post("HeapProfiler.startSampling", { samplingInterval: 4096, includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true });
  const times = new Float64Array(16);
  for (let i = 0; i < times.length; i++) { const start = performance.now(); await summarize(); times[i] = performance.now() - start; }
  const { profile } = await profiler.post("HeapProfiler.stopSampling");
  const pending = [profile.head], sites: { site: string; bytes: number }[] = [];
  let bytes = 0;
  while (pending.length) {
    const node = pending.pop()!; bytes += node.selfSize;
    if (node.selfSize) sites.push({ site: `${node.callFrame.functionName} ${node.callFrame.url}:${node.callFrame.lineNumber + 1}`, bytes: node.selfSize });
    for (const child of node.children) pending.push(child);
  }
  sites.sort((a, b) => b.bytes - a.bytes); times.sort();
  const normal = { lookups, requests, headerHooks, portableCalls, wrongEndpoints, mixedHeaders, mixedEnv };
  const commits = session.sessionManager.getEntries().filter(entry => entry.type === "compaction").length;
  cancelNext = true;
  await assert.rejects(summarize(), /abort|cancel/i);
  assert.equal(requests, normal.requests);
  cancelNext = false; failNext = true;
  await assert.rejects(summarize(), portable ? /cancel/i : /synthetic rejection/);
  assert.equal(requests, normal.requests + 1);
  assert.equal(session.sessionManager.getEntries().filter(entry => entry.type === "compaction").length, commits);
  assert.equal(session.isCompacting, false); assert.equal((session as any)._compactionAbortController, undefined);
  if (portable) {
    failNext = false; selectedProbe = true; process.env.SP_OPENAI_SERVER_COMPACTION_SUMMARY_MODEL = candidate.id;
    const before = lookups;
    await summarize();
    failNext = true; await assert.rejects(summarize(), /cancel/i);
    assert.equal(lookups - before, 4, "one active and one candidate resolution per attempt");
    assert.equal(selectedCalls, 2);
  }
  await setImmediate(); for (let i = 0; i < 4; i++) { gc(); await setImmediate(); }
  let retained = 0; for (const ref of refs) if (ref.deref()) retained++;
  assert.equal(retained, 0); assert.equal(normal.requests, portable ? 32 : 16); assert.equal(normal.headerHooks, 16);
  assert.doesNotMatch(JSON.stringify(session.sessionManager.getEntries()), /synthetic-A|synthetic-B|OTHER_LANE/);
  console.log(JSON.stringify({ mode: hostScope ? "host-scope" : portable ? "portable" : "native", summaries: 16, ...normal, cancelledDispatches: 0, failedDispatches: 1, staleCommits: 0,
    selectedCalls, trackedReferences: refs.length, retained, sampledBytesPerSummary: bytes / 16, p95Ms: times[15], sites: sites.slice(0, 5), node: process.version }));
  assert.ok(session.extensionRunner, "release check keeps the session alive");
  assert.equal(normal.lookups, 16); assert.equal(normal.wrongEndpoints, 0); assert.equal(normal.mixedHeaders, 0); assert.equal(normal.mixedEnv, 0);
} finally {
  profiler.disconnect(); provider.streamSimple = originalStream; runtime.streamSimple = originalRuntimeStream; globalThis.fetch = previousFetch;
  SupplementalSummaryScope.prototype.run = originalScopeRun;
  if (portable) {
    if (previousMode === undefined) Reflect.deleteProperty(process.env, "SP_OPENAI_SERVER_COMPACTION_SUMMARY_MODE"); else process.env.SP_OPENAI_SERVER_COMPACTION_SUMMARY_MODE = previousMode;
    if (previousModel === undefined) Reflect.deleteProperty(process.env, "SP_OPENAI_SERVER_COMPACTION_SUMMARY_MODEL"); else process.env.SP_OPENAI_SERVER_COMPACTION_SUMMARY_MODEL = previousModel;
  }
  try { await owner?.dispose(); }
  finally { rmSync(root, { recursive: true, force: true }); assert.equal(existsSync(root), false); console.error(`removedFixture=${root}`); }
}
