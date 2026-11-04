import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { tmpdir } from "node:os";
import type { AssistantMessage, Context, SimpleStreamOptions } from "../../packages/ai/src/types.ts";
import { stream } from "../../packages/ai/src/api/anthropic-messages.ts";
import { createAgentSession } from "../../packages/coding-agent/src/core/sdk.ts";
import { prepareCompaction } from "../../packages/coding-agent/src/core/compaction/compaction.ts";
import type { ModelRuntime } from "../../packages/coding-agent/src/core/model-runtime.ts";
import { DefaultResourceLoader } from "../../packages/coding-agent/src/core/resource-loader.ts";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.ts";
import { SettingsManager } from "../../packages/coding-agent/src/core/settings-manager.ts";
import { schemaModel, schemaResponse } from "./anthropic-schema-fixture.ts";
import { compactionFocus } from "./compaction-instructions-fixture.ts";

const root = process.argv[2]!, failure = process.argv[3]!;
assert.equal(tmpdir(), root); assert.equal(process.env.TMP, root);
assert.equal(process.env.TEMP, root); assert.equal(process.env.TMPDIR, root);
assert.ok(["error", "length", "abort"].includes(failure));
const model = schemaModel();
const settings = SettingsManager.inMemory({ compaction: { enabled: false, reserveTokens: 1024, keepRecentTokens: 128 },
  retry: { enabled: false, maxRetries: 0, baseDelayMs: 1 } });
const resources = new DefaultResourceLoader({ cwd: root, agentDir: root, settingsManager: settings,
  noExtensions: true, noContextFiles: true, noSkills: true, noPromptTemplates: true, noThemes: true });
await resources.reload();
const manager = SessionManager.inMemory(root);
function assistant(text: string): AssistantMessage {
  return { role: "assistant", api: model.api, provider: model.provider, model: model.id,
    content: [{ type: "text", text }], stopReason: "stop", timestamp: 1,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
}
manager.appendMessage({ role: "user", content: "Earlier task", timestamp: 0 });
manager.appendMessage(assistant("older history ".repeat(1024)));
manager.appendMessage({ role: "user", content: "Current task", timestamp: 2 });
manager.appendMessage(assistant("prefix history ".repeat(1024)));
manager.appendMessage(assistant("recent suffix ".repeat(16)));
const preparation = prepareCompaction(manager.getBranch(), settings.getCompactionSettings());
assert.ok(preparation?.isSplitTurn);
assert.ok(preparation.messagesToSummarize.length > 0 && preparation.turnPrefixMessages.length > 0);
let requests = 0, authCalls = 0;
const signals: AbortSignal[] = [], responses: Response[] = [];
let releaseReady: (() => void) | undefined;
let rejectFetch: ((reason: unknown) => void) | undefined;
const ready = new Promise<void>(resolve => { releaseReady = resolve; });
function cancelFetch(): void { const reject = rejectFetch; rejectFetch = undefined; reject?.(new Error("fixture cancelled")); }
async function fetchFixture(_url: string | URL | Request, init?: RequestInit): Promise<Response> {
  requests++;
  assert.ok(requests <= 2, "compaction must not add or retry requests");
  if (requests === 2 && failure === "abort") {
    init!.signal!.addEventListener("abort", cancelFetch, { once: true });
    const pending = new Promise<Response>((_resolve, reject) => { rejectFetch = reject; });
    const notify = releaseReady; releaseReady = undefined; notify?.();
    try { return await pending; } finally { init!.signal!.removeEventListener("abort", cancelFetch); }
  }
  const response = requests === 2 && failure === "error" ? new Response("fixture rejected", { status: 400 })
    : new Response(requests === 2 && failure === "length" ? schemaResponse.replace('"end_turn"', '"max_tokens"') : schemaResponse,
      { headers: { "content-type": "text/event-stream" } });
  responses.push(response); return response;
}
const runtime = {
  hasConfiguredAuth: () => true, checkAuth: async () => ({ type: "api_key" }), getCredentialGeneration: () => 0,
  getAuth: async () => { authCalls++; return { auth: { apiKey: "offline-fixture" }, source: "api_key" }; },
  getModel: () => model, getAvailableSnapshot: () => [model], getAvailable: async () => [model], getError: () => undefined,
  usesBuiltinOpenAIResponses: () => false, usesBuiltinOpenAICodex: () => false, isUsingOAuth: () => false, isUsingSubscription: () => false,
  registerProvider() {}, registerNativeProvider() {}, unregisterProvider() {},
  streamSimple: (_model: unknown, context: Context, options: SimpleStreamOptions) => {
    assert.equal(options.apiKey, "offline-fixture");
    if (options.signal) signals.push(options.signal);
    return stream(model, context, { ...options, maxRetries: 0, fetch: fetchFixture });
  },
} as unknown as ModelRuntime;
const { session } = await createAgentSession({ cwd: root, agentDir: root, model, modelRuntime: runtime,
  settingsManager: settings, sessionManager: manager, resourceLoader: resources, noTools: "all" });
let ended = 0;
const unsubscribe = session.subscribe(event => { if (event.type === "compaction_end") { ended++; assert.equal(event.result, undefined); } });
const before = manager.getEntries().length;
try {
  const operation = session.compact(compactionFocus);
  const rejected = assert.rejects(operation, failure === "abort" ? /Compaction cancelled/ : /Turn prefix summarization failed/);
  if (failure === "abort") { await ready; session.abortCompaction(); }
  await rejected;
  assert.equal(requests, 2);
  assert.ok(authCalls >= 1);
  assert.equal(manager.getEntries().length, before);
  assert.equal(manager.getEntries().filter(entry => entry.type === "compaction").length, 0);
  assert.equal(session.isCompacting, false);
  assert.equal(ended, 1);
  assert.equal((session as unknown as { _compactionAbortController?: unknown })._compactionAbortController, undefined);
  // SDK error handling consumes Response.text(); native Fetch leaves that body
  // locked. The adapter owns/relinquishes readers only for successful SSE bodies.
  assert.ok(responses.every(response => response.ok ? !response.body?.locked : response.bodyUsed));
  const listenersBeforeGc = signals.map(signal => getEventListeners(signal, "abort").length);
  const responseRefs = responses.map(response => new WeakRef(response));
  responses.length = 0;
  assert.ok(global.gc);
  // .asResponse() uses the SDK body-abandonment backstop. Keep session/signals
  // alive, but release the fixture's Response owners before measuring cleanup.
  for (let i = 0; i < 8; i++) { await new Promise<void>(resolve => setImmediate(resolve)); global.gc(); }
  assert.ok(responseRefs.every(ref => ref.deref() === undefined));
  assert.ok(signals.every(signal => getEventListeners(signal, "abort").length === 0));
  assert.equal(rejectFetch, undefined);
  console.log(JSON.stringify({ failure, requests, savedCompactions: 0, ended, signals: signals.length,
    listenersBeforeGc, listeners: 0, inputEntries: before }));
} finally { releaseReady = undefined; unsubscribe(); await session.abort(); session.dispose(); }
