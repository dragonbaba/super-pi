import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import zlib from "node:zlib";
import { EventEmitter } from "node:events";
import { InMemoryCredentialStore } from "../../packages/ai/src/auth/credential-store.ts";
import { openaiCodexOAuth } from "../../packages/ai/src/auth/oauth/openai-codex.ts";
import { resolveProviderAuth } from "../../packages/ai/src/auth/resolve.ts";
import extension from "../../packages/openai-server-compaction/src/index.ts";
import { streamOpenAIResponsesWithPhase2B } from "../../packages/openai-server-compaction/src/custom-stream.ts";
import { DefaultResourceLoader } from "../../packages/coding-agent/src/core/resource-loader.ts";
import { createAgentSession } from "../../packages/coding-agent/src/core/sdk.ts";
import { AgentSessionRuntime } from "../../packages/coding-agent/src/core/agent-session-runtime.ts";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.ts";
import { SettingsManager } from "../../packages/coding-agent/src/core/settings-manager.ts";
import { ModelRuntime } from "../../packages/coding-agent/src/core/model-runtime.ts";
import { responsesUsage, sseFrames, textEvents } from "../helpers/responses-sse-fixture.ts";
import { FakeCodexWebSocket } from "../helpers/codex-websocket-fixture.ts";
import { createOpenAIWebSocketStreamFn, releaseWsSession } from "../../packages/openai-server-compaction/src/openai-ws-stream.ts";

const token = (account = "one", generation = 1) => `header.${Buffer.from(JSON.stringify({ sub: "user", generation,
  "https://api.openai.com/auth": { chatgpt_account_id: account } })).toString("base64url")}.signature`;
const artifact = { type: "compaction", encrypted_content: "OPAQUE_LIFECYCLE_SENTINEL" };
const response = (events: unknown[]) => new Response(sseFrames(events), { headers: { "content-type": "text/event-stream" } });

test("direct Responses WebSocket uses the configured endpoint and effective routing headers", async () => {
  const connections: Array<{ url: string; headers: Record<string, string> }> = [];
  const bodies: any[] = [];
  let reportedTier = "fast";
  class Socket extends EventEmitter {
    readyState = 1;
    send(body: string) { bodies.push(JSON.parse(body)); queueMicrotask(() => {
      const events: any[] = structuredClone(textEvents());
      events.at(-1).response.service_tier = reportedTier;
      events.at(-1).response.usage = { input_tokens: 1000000, output_tokens: 1000000, total_tokens: 2000000 };
      for (const event of events) this.emit("message", JSON.stringify(event));
    }); }
    close() { this.readyState = 3; }
    terminate() { this.close(); }
  }
  const stream = createOpenAIWebSocketStreamFn({ socketFactory: async (url, options) => {
    connections.push({ url, headers: options.headers }); return new Socket();
  } });
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
  } finally { releaseWsSession("audit-direct-ws"); }
});

async function fixture(codex = false, fail?: "remote" | "summary", modelId = "gpt-5.1", extra?: {
  headers?: (headers: Record<string, string | null | undefined>) => void;
  tool?: (session: any) => Promise<void>;
  customEnd?: () => Promise<void>;
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
    noExtensions: false, extensionFactories: [(pi: any) => {
      extension(pi);
      pi.on("before_provider_headers", (event: any) => { headerCalls++; extra?.headers?.(event.headers); });
      pi.on("message_end", async (event: any) => { if (event.message.role === "custom") await extra?.customEnd?.(); });
    }], noContextFiles: true, noSkills: true, noPromptTemplates: true, noThemes: true });
  await resourceLoader.reload();
  const manager = SessionManager.create(root, root);
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
      noExtensions: false, extensionFactories: [extension], noContextFiles: true, noSkills: true, noPromptTemplates: true, noThemes: true });
    await loader.reload();
    const created = await createAgentSession({ cwd: target.cwd, agentDir: target.agentDir, settingsManager: settings,
      sessionManager: target.sessionManager, sessionStartEvent: target.sessionStartEvent, resourceLoader: loader,
      model, modelRuntime: runtime, noTools: "all" });
    return { ...created, services: { cwd: target.cwd, agentDir: target.agentDir } as any, diagnostics: [] };
  });
  sessionRuntime.setRebindSession(async active => { await active.bindExtensions({}); });
  return { get session() { return sessionRuntime.session; }, get manager() { return sessionRuntime.session.sessionManager; }, sessionRuntime, requests, refreshRequests, model, root,
    setAuthResolver(resolver: () => Promise<any>) { runtime.getAuth = resolver; },
    requestTool() { callTool = true; }, get headerCalls() { return headerCalls; },
    changeKey(value: string) { key = value; }, changeEndpoint(value: string) { endpoint = value; },
    clearFailure() { fail = undefined; },
    async release() { await sessionRuntime.dispose(); globalThis.fetch = originalFetch; rmSync(root, { recursive: true, force: true }); } };
}

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

test("regular request scope uses the already-resolved credential without a second registry lookup", async () => {
  const f = await fixture();
  let lookups = 0;
  f.setAuthResolver(async () => ({ auth: { apiKey: ++lookups === 1 ? "first-effective-key" : "later-key", baseUrl: "https://api.openai.com/selected" }, source: "api_key" }));
  try {
    await f.session.prompt("ONE_AUTH_SNAPSHOT");
    assert.equal(lookups, 1);
    assert.equal(f.requests.length, 1);
    assert.equal(f.requests[0].authorization, "Bearer first-effective-key");
    assert.match(f.requests[0].url, /\/selected\//);
  } finally { await f.release(); }
});

test("session replacement while an idle custom extension callback is awaited cannot write into the incoming session", async () => {
  let entered!: () => void, release!: () => void;
  const ready = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const f = await fixture(false, undefined, "gpt-5.1", { customEnd: async () => { entered(); await gate; } });
  try {
    await f.session.prompt("establish boundary"); await f.session.compact();
    const oldFile = f.manager.getSessionFile()!;
    const sent = f.session.sendCustomMessage({ customType: "local", content: "OLD_OWNER_CUSTOM", display: true }, { triggerTurn: false });
    await ready;
    await f.sessionRuntime.newSession();
    release(); await sent;
    await f.session.prompt("INCOMING_REQUEST");
    assert.doesNotMatch(JSON.stringify(f.requests.at(-1)!.payload.input), /OLD_OWNER_CUSTOM/);
    assert.equal(f.manager.getEntries().some((e: any) => e.type === "custom_message"), false);
    assert.equal(SessionManager.open(oldFile, f.root).getEntries().filter((e: any) => e.type === "custom_message" && e.content === "OLD_OWNER_CUSTOM").length, 1);
  } finally { release(); await f.release(); }
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
