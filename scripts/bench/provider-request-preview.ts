import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Session } from "node:inspector/promises";
import { setImmediate } from "node:timers/promises";
import { InMemoryCredentialStore } from "../../packages/ai/src/auth/credential-store.ts";
import { createAgentSession } from "../../packages/coding-agent/src/core/sdk.ts";
import { emitSessionShutdownEvent } from "../../packages/coding-agent/src/core/extensions/runner.ts";
import { loadExtensionFromFactory } from "../../packages/coding-agent/src/core/extensions/loader.ts";
import { createEventBus } from "../../packages/coding-agent/src/core/event-bus.ts";
import { DefaultResourceLoader } from "../../packages/coding-agent/src/core/resource-loader.ts";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.ts";
import { SettingsManager } from "../../packages/coding-agent/src/core/settings-manager.ts";
import { ModelRuntime } from "../../packages/coding-agent/src/core/model-runtime.ts";
import extension from "../../packages/openai-server-compaction/src/index.ts";
import { createProviderAwareCompactionExtension } from "../../packages/provider-aware-compaction/src/index.ts";
import { prepareCompaction } from "../../packages/coding-agent/src/core/compaction/compaction.ts";
import fastExtension from "../../packages/openai-fast-mode/src/index.ts";
import { saveFastModeConfig, fastModeConfigPath } from "../../packages/openai-fast-mode/src/config.ts";

// Manual, 32 previews through SDK builder -> real context/payload hooks. No network or CI matrix.
const gc = (globalThis as { gc?: () => void }).gc;
assert.ok(gc, "run with --expose-gc");
const authHeaders = process.argv.includes("--auth-headers");
const providerAware = process.argv.includes("--provider-aware");
const policyFile = providerAware && process.argv.includes("--policy-file");
const fastMode = process.argv.includes("--fast-mode");
const root = mkdtempSync(join(tmpdir(), "sp-provider-preview-"));
console.error(`ownedFixture=${root}`);
const oldAgentDir = process.env.SP_CODING_AGENT_DIR;
if (fastMode || policyFile) {
  process.env.SP_CODING_AGENT_DIR = root;
  mkdirSync(join(root, "config"));
  if (fastMode) saveFastModeConfig({ enabled: true }, fastModeConfigPath(root));
  if (policyFile) writeFileSync(join(root, "config", "provider-aware-compaction.json"), JSON.stringify({ policies: ["kimi-self-preserve-32k-v1"] }));
}
const model: any = { id: "gpt-5.1", name: "offline", api: "openai-responses", provider: "openai",
  baseUrl: "https://api.openai.com/v1", input: ["text"], reasoning: false, contextWindow: 64000, maxTokens: 512,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
if (providerAware) { model.provider = "kimi-coding"; model.id = "k3-256k"; }
if (fastMode) { model.provider = "openai-codex"; model.api = "openai-codex-responses"; model.id = "gpt-5.1-codex"; }
const settings = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false });
let lookups = 0, hooks = 0, identities = 0, markers = 0, expected: any;
let trackPrepared = false, failSummary = false, shutdown = false;
const preparedRefs: WeakRef<object>[] = [];
const invalidPreparationRefs: WeakRef<object>[] = [];
const factoryInputRefs: WeakRef<object>[] = [];
function trackedAwareFactory(options: NonNullable<Parameters<typeof createProviderAwareCompactionExtension>[0]>) {
  factoryInputRefs.push(new WeakRef(options));
  if (options.policies) factoryInputRefs.push(new WeakRef(options.policies));
  return createProviderAwareCompactionExtension(options);
}
const awareExtension = trackedAwareFactory({
  policies: policyFile ? undefined : ["kimi-self-preserve-32k-v1"],
  originalPrefixCompactFn: async input => {
    hooks++;
    if (input.model === expected.model && input.headers === expected.headers && input.env === expected.env) identities++;
    if (failSummary) throw new Error("synthetic summary failure");
    return { summary: "synthetic", firstKeptEntryId: input.preparation.firstKeptEntryId, tokensBefore: input.preparation.tokensBefore };
  },
  compactFn: async preparation => {
    hooks++;
    return { summary: "synthetic", firstKeptEntryId: preparation.firstKeptEntryId, tokensBefore: preparation.tokensBefore };
  },
});
runtime.getAuth = async () => { lookups++; return { auth: { apiKey: "synthetic", baseUrl: model.baseUrl,
  headers: authHeaders || providerAware ? { "OpenAI-Project": null, "OpenAI-Organization": "synthetic" } : undefined },
  env: providerAware ? { FIXTURE: "true" } : undefined, source: "api_key" }; };
runtime.getModel = () => model;
runtime.hasConfiguredAuth = () => true;
const resources = new DefaultResourceLoader({ cwd: root, agentDir: root, settingsManager: settings,
  noExtensions: false, noSkills: true, noContextFiles: true, noThemes: true, noPromptTemplates: true,
  extensionFactories: [pi => {
    if (providerAware) {
      awareExtension({ ...pi, registerCompactionStrategy: strategy => pi.registerCompactionStrategy!({ ...strategy, prepare: ctx => {
        const prepared = strategy.prepare(ctx);
        if (trackPrepared && prepared) preparedRefs.push(new WeakRef(prepared));
        return prepared;
      } }) });
      return;
    }
    if (fastMode) fastExtension(pi, "0.84.1");
    extension(pi);
    pi.on("context", () => undefined);
    pi.on("before_provider_request", event => { hooks++; if (event.requestAuth === expected) identities++; });
  }] });
let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
const refs: WeakRef<object>[] = [];
const profiler = new Session();
const stateRefs: WeakRef<object>[] = [];
const originalMapSet = Map.prototype.set;
const originalReflectGet = Reflect.get, originalReflectSet = Reflect.set, originalReflectDelete = Reflect.deleteProperty;
const fastSymbol = Symbol.for("pi.openai-fast-mode.runtime-state.v2");
let symbolAccesses = 0;
if (fastMode) {
  // Observe existing production state allocation without exposing it through a new API.
  Map.prototype.set = function (key, value) {
    if (value && typeof value === "object" && typeof value.enabled === "boolean" &&
      (Object.keys(value).length === 1 || value.schemaVersion === 1 && value.sessionId === key) &&
      !stateRefs.some(ref => ref.deref() === value)) stateRefs.push(new WeakRef(value));
    return originalMapSet.call(this, key, value);
  };
  Reflect.get = function (target, key, receiver) { if (key === fastSymbol) symbolAccesses++; return originalReflectGet(target, key, receiver ?? target); };
  Reflect.set = function (target, key, value, receiver) { if (key === fastSymbol) symbolAccesses++; return originalReflectSet(target, key, value, receiver ?? target); };
  Reflect.deleteProperty = function (target, key) { if (key === fastSymbol) symbolAccesses++; return originalReflectDelete(target, key); };
}
try {
  await resources.reload();
  ({ session } = await createAgentSession({ cwd: root, agentDir: root, resourceLoader: resources, settingsManager: settings,
    sessionManager: SessionManager.inMemory(root), modelRuntime: runtime, model, noTools: "all" }));
  await session.bindExtensions({});
  for (let i = 0; providerAware && i < 3; i++) session.sessionManager.appendMessage({ role: "user", content: "fixture ".repeat(1024), timestamp: i });
  const preparation = providerAware ? prepareCompaction(session.sessionManager.getBranch(), { enabled: true, keepRecentTokens: 128, reserveTokens: 128 })! : undefined;
  async function preview(track: boolean, signal?: AbortSignal) {
    if (authHeaders) {
      // Both native entry points, bounded auth provider; no stream/network request.
      for (const method of ["_getRequiredRequestAuth", "_getSummarizationRequestAuth"]) {
        const result = await (session as any)[method](model);
        if (result.headers?.["OpenAI-Project"] === null) markers++;
        if (track) for (const value of [result, result.model, result.headers]) refs.push(new WeakRef(value));
      }
      return;
    }
    const auth = Object.freeze({ model: { ...model, baseUrl: "https://api.openai.com/selected" },
      apiKey: "synthetic", headers: Object.freeze({ "OpenAI-Project": null }), env: Object.freeze({ FIXTURE: "true" }) });
    expected = auth;
    if (track) for (const value of [auth, auth.model, auth.headers, auth.env]) refs.push(new WeakRef(value));
    trackPrepared = track;
    try {
    const result = providerAware
      ? await session!.extensionRunner.emit({ type: "session_before_compact", preparation: preparation!, branchEntries: session!.sessionManager.getBranch(),
        auth, reason: "manual", willRetry: false, signal: signal ?? resources.getExtensions().runtime.executionBoundary.signal })
      : await session!.buildProviderRequestPayload({ systemPrompt: "offline", messages: [{ role: "user", content: "fixture ".repeat(1024), timestamp: 1 }], auth } as any);
    assert.ok(result);
    if (fastMode) assert.equal((result as any).service_tier, "priority");
    if (track) refs.push(new WeakRef(result));
    } finally { expected = undefined; trackPrepared = false; }
  }
  for (let i = 0; i < 4; i++) await preview(false);
  lookups = hooks = identities = markers = 0;
  gc(); profiler.connect();
  await profiler.post("HeapProfiler.startSampling", { samplingInterval: 4096, includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true });
  const times = new Float64Array(32);
  for (let i = 0; i < times.length; i++) { const start = performance.now(); await preview(true); times[i] = performance.now() - start; }
  const { profile } = await profiler.post("HeapProfiler.stopSampling");
  const pending = [profile.head], sites: { site: string; bytes: number }[] = [];
  let bytes = 0;
  while (pending.length) {
    const node = pending.pop()!; bytes += node.selfSize;
    if (node.selfSize) sites.push({ site: `${node.callFrame.functionName} ${node.callFrame.url}:${node.callFrame.lineNumber + 1}`, bytes: node.selfSize });
    for (const child of node.children) pending.push(child);
  }
  sites.sort((a, b) => b.bytes - a.bytes); times.sort();
  const measured = { hooks, identities, lookups, markers };
  assert.equal(hooks, authHeaders ? 0 : 32);
  if (!providerAware) { assert.equal(identities, authHeaders ? 0 : 32); assert.equal(lookups, authHeaders ? 64 : 0); }
  if (providerAware) {
    assert.equal(preparedRefs.length, 32); assert.equal(identities, 32); assert.equal(lookups, 0);
    failSummary = true; await preview(true); failSummary = false;
    const cancelled = new AbortController(); cancelled.abort();
    await assert.rejects(preview(true, cancelled.signal), /abort/i);
    let mode = "conflict", finishInvalid: (() => void) | undefined;
    await loadExtensionFromFactory(api => api.registerCompactionStrategy!({ id: "benchmark-control", prepare: (() => {
      if (mode === "conflict") {
        const candidate = () => undefined; preparedRefs.push(new WeakRef(candidate)); return candidate;
      }
      const invalid = new Promise<void>(resolve => { finishInvalid = resolve; });
      invalidPreparationRefs.push(new WeakRef(invalid)); return invalid;
    }) as never }), root, createEventBus(), resources.getExtensions().runtime, "benchmark-control");
    await assert.rejects(preview(true), /Conflicting compaction strategies/);
    mode = "async";
    await assert.rejects(preview(true), /prepare synchronously/);
    let drained = false;
    const draining = session.extensionRunner.drainExecution().then(() => { drained = true; });
    await setImmediate(); assert.equal(drained, false);
    finishInvalid!(); finishInvalid = undefined; await draining;
  }
  await setImmediate();
  for (let i = 0; i < 4; i++) { gc(); await setImmediate(); }
  let retained = 0;
  for (const ref of refs) if (ref.deref()) retained++;
  assert.equal(retained, 0);
  assert.equal(preparedRefs.filter(ref => ref.deref()).length, 0);
  assert.equal(invalidPreparationRefs.filter(ref => ref.deref()).length, 0);
  assert.equal(factoryInputRefs.filter(ref => ref.deref()).length, 0, "the live factory must release caller-owned options and preset arrays");
  assert.ok(session.extensionRunner, "the session and extension runner remain alive during release check");
  if (fastMode) {
    await emitSessionShutdownEvent(session.extensionRunner, { type: "session_shutdown", reason: "exit" }); shutdown = true;
    for (let i = 0; i < 4; i++) { await setImmediate(); gc(); }
    assert.equal(stateRefs.length, 1);
    assert.equal(stateRefs.filter(ref => ref.deref()).length, 0, "Fast state released while runner remains alive");
  }
  if (providerAware) {
    await emitSessionShutdownEvent(session.extensionRunner, { type: "session_shutdown", reason: "exit" }); shutdown = true;
    session.dispose();
    assert.equal(resources.getExtensions().runtime.compactionStrategies.size, 0);
  }
  console.log(JSON.stringify({ mode: fastMode ? "fast-mode" : providerAware ? "provider-aware" : authHeaders ? "auth-headers" : "preview", iterations: times.length, ...measured, trackedReferences: refs.length, retained,
    ...(providerAware ? { policyFile, preparedClosures: preparedRefs.length, preparedRetained: 0, failureAndAbort: 2, conflictAndInvalidAsync: 2,
      invalidAsyncRetained: 0, registrationsAfterDispose: 0 } : {}),
    ...(providerAware ? { factoryInputs: factoryInputRefs.length, factoryInputsRetained: 0 } : {}),
    ...(fastMode ? { symbolAccesses, fastStatesCreated: stateRefs.length, fastStatesRetainedAfterShutdown: 0 } : {}),
    sampledBytesPerPreview: bytes / times.length, p95Ms: times[30], sites: sites.slice(0, 5), node: process.version }));
} finally {
  profiler.disconnect();
  try { if (session && !shutdown) await emitSessionShutdownEvent(session.extensionRunner, { type: "session_shutdown", reason: "exit" }); }
  finally {
    session?.dispose();
    Map.prototype.set = originalMapSet;
    Reflect.get = originalReflectGet; Reflect.set = originalReflectSet; Reflect.deleteProperty = originalReflectDelete;
    if (fastMode || policyFile) {
      if (oldAgentDir === undefined) Reflect.deleteProperty(process.env, "SP_CODING_AGENT_DIR");
      else process.env.SP_CODING_AGENT_DIR = oldAgentDir;
    }
    rmSync(root, { recursive: true, force: true });
    assert.equal(existsSync(root), false);
    console.error(`removedFixture=${root}`);
  }
}
