import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createAgentSession } from "../packages/coding-agent/src/core/sdk.ts";
import { DefaultResourceLoader } from "../packages/coding-agent/src/core/resource-loader.ts";
import { SettingsManager } from "../packages/coding-agent/src/core/settings-manager.ts";
import { SessionManager } from "../packages/coding-agent/src/core/session-manager.ts";
import { parseToolResultBudgetCommand, formatToolResultBudgetStatus } from "../packages/coding-agent/src/core/tool-result-budget-status.ts";
import { ALPHA_MODEL, alphaModelRuntime, alphaSession } from "./helpers/alpha-session.ts";
import { streamSimple } from "@super-pi/ai/api/openai-completions";
import { AgentSession, parseSkillBlock } from "../packages/coding-agent/src/core/agent-session.ts";
import * as sessionPatterns from "../packages/coding-agent/src/core/agent-session-regex.ts";
import { alphaMessage } from "./helpers/alpha-stream.ts";
import { Session as InspectorSession } from "node:inspector/promises";
import { AssistantMessageEventStream } from "../packages/ai/src/utils/event-stream.ts";
import { ExtensionHookTimeoutError } from "../packages/coding-agent/src/core/extensions/runner.ts";

for (const action of ["prompt", "continue"]) test(`N4 budget replacement refuses a direct public Agent ${action} before any tool is pending`, async () => {
  const stream = new AssistantMessageEventStream(); let entered!: () => void, finished = false, pending: Promise<void> | undefined;
  const begun = new Promise<void>(resolve => { entered = resolve; });
  const f = await alphaSession({ runtime: alphaModelRuntime(() => { entered(); return stream; }),
    messages: action === "continue" ? [{ role: "user", content: [{ type: "text", text: "fixture" }], timestamp: 1 }] : [] });
  function complete() { if (!finished) { finished = true; stream.push({ type: "done", reason: "stop", message: alphaMessage([{ type: "text", text: "done" }]) }); } }
  try {
    f.session.configureToolResultBudget({ enabled: true, budgetTokens: 4096 });
    const owner = (f.session as any)._toolResultPresentation, generation = f.session.toolResultBudgetGeneration;
    pending = action === "prompt" ? f.session.agent.prompt("fixture") : f.session.agent.continue();
    await begun; assert.equal(f.session.isStreaming, false); assert.equal(f.session.agent.state.isStreaming, true);
    assert.equal(f.session.agent.state.pendingToolCalls.size, 0);
    const status = f.session.getToolResultBudgetStatus();
    assert.throws(() => f.session.configureToolResultBudget({ enabled: true, budgetTokens: 2048 }), /current turn settles/);
    assert.equal((f.session as any)._toolResultPresentation, owner); assert.equal(f.session.toolResultBudgetGeneration, generation);
    assert.deepEqual(f.session.getToolResultBudgetStatus(), status); assert.equal(owner.counters.ownerDisposeCalls, 0);
    complete(); await pending; pending = undefined;
    f.session.configureToolResultBudget({ enabled: true, budgetTokens: 2048 }); assert.equal(owner.counters.ownerDisposeCalls, 1);
  } finally { complete(); await pending; await f.release(); }
});

test("N4 Session parsing patterns are reusable module constants with unchanged flags", () => {
  const methods = AgentSession.prototype as any;
  for (let n = 0; n < 20; n++) {
    for (const pattern of Object.values(sessionPatterns)) pattern.lastIndex = 99;
    assert.deepEqual(parseSkillBlock('<skill name="中文" location="/tmp/source">\nbody\n</skill>\n\nuser'), { name: "中文", location: "/tmp/source", content: "body", userMessage: "user" });
    assert.equal(parseSkillBlock("plain text"), null);
    assert.equal(methods._normalizePromptSnippet(" \r\n中文\t  text\r\n"), "中文 text");
    assert.equal(methods.getExtensionSourceLabel("<fixture>"), "extension:fixture");
    assert.equal(methods.getExtensionSourceLabel("fixture.ts"), "extension:fixture");
  }
});

test("N4 explicit budget command validates positive decimal safe integers without a default", () => {
  assert.equal(parseToolResultBudgetCommand(""), "status"); assert.equal(parseToolResultBudgetCommand("status"), "status");
  assert.equal(parseToolResultBudgetCommand("off"), undefined);
  assert.deepEqual(parseToolResultBudgetCommand(" 4096 "), { enabled: true, budgetTokens: 4096 });
  for (const value of ["on", "0", "-1", "1.2", "NaN", "Infinity", "1e3", "0x10", "9007199254740992", "01", "1 2"]) assert.throws(() => parseToolResultBudgetCommand(value), /正整数/);
});

test("N4 default SDK can adjust a blocked result budget and continue without replay or config writes", { timeout: 30000 }, async t => {
  const root = mkdtempSync(join(tmpdir(), "sp-budget-status-")), cwd = join(root, "work"), agentDir = join(root, "agent"); mkdirSync(cwd); mkdirSync(agentDir);
  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
  const initialGlobal = settingsManager.getGlobalSettings(), initialProject = settingsManager.getProjectSettings();
  const resourceLoader = new DefaultResourceLoader({ cwd, agentDir, settingsManager, noContextFiles: true, noSkills: true, noThemes: true, noPromptTemplates: true,
    additionalExtensionPaths: [resolve("packages/extensions"), resolve("packages/tool-classification/src/index.ts")] });
  await resourceLoader.reload();
  const model: any = { ...ALPHA_MODEL, api: "openai-completions", compat: { maxTokensField: "max_tokens" } };
  let requests = 0, writePlanned = true, lastWire = "";
  const fakeFetch: typeof fetch = async (_url, init) => {
    requests++; assert.equal(typeof init?.body, "string"); lastWire = init!.body as string;
    const call = writePlanned; writePlanned = false;
    const delta = call ? { tool_calls: [{ index: 0, id: "created-once", type: "function", function: { name: "write", arguments: JSON.stringify({ path: "created.txt", content: "完成 exactly once" }) } }] }
      : { content: "Recorded result acknowledged without another tool call." };
    const event = { id: "offline", object: "chat.completion.chunk", created: 1, model: model.id, choices: [{ index: 0, delta, finish_reason: null }] };
    const end = { ...event, choices: [{ index: 0, delta: {}, finish_reason: call ? "tool_calls" : "stop" }] };
    return new Response(`data: ${JSON.stringify(event)}\n\ndata: ${JSON.stringify(end)}\n\ndata: [DONE]\n\n`, { headers: { "Content-Type": "text/event-stream" } });
  };
  const runtime = alphaModelRuntime((m: any, c: any, o: any) => streamSimple(m, c, { ...o, apiKey: "offline-fixture", fetch: fakeFetch, maxRetries: 0 }));
  const manager = SessionManager.create(cwd, join(root, "sessions"));
  const { session } = await createAgentSession({ cwd, agentDir, settingsManager, resourceLoader, sessionManager: manager, model, modelRuntime: runtime,
    noTools: "builtin", toolResultPresentation: { enabled: true, budgetTokens: 1 } });
  t.after(async () => { session.dispose(); await new Promise<void>(resolve => setImmediate(resolve)); assert.equal(dirname(root), tmpdir()); rmSync(root, { recursive: true, force: true }); });
  await session.bindExtensions({ mode: "tui", uiContext: { ...session.extensionRunner.getUIContext(), select: async () => "仅允许本次" } });
  assert.equal(session.getToolResultBudgetStatus().state, "enabled");
  await session.prompt("Create the specified isolated fixture file."); await session.agent.waitForIdle();
  assert.equal(readFileSync(join(cwd, "created.txt"), "utf8"), "完成 exactly once");
  assert.equal(requests, 1, "too-small blocks the next serialized request, after the real file effect");
  assert.equal(session.getToolResultBudgetStatus().state, "budget-too-small");
  assert.match(formatToolResultBudgetStatus(session.getToolResultBudgetStatus()), /预算过小/);
  const oldOwner = (session as any)._toolResultPresentation, scans = oldOwner.counters.fullSourceEstimatorScans;
  for (let n = 0; n < 1000; n++) session.getToolResultBudgetStatus();
  assert.equal(oldOwner.counters.fullSourceEstimatorScans, scans, "status snapshots never scan history/results");
  assert.throws(() => session.configureToolResultBudget({ enabled: true, budgetTokens: 0 }), /positive safe integer/);
  assert.equal((session as any)._toolResultPresentation, oldOwner, "invalid configuration is atomic");
  session.configureToolResultBudget({ enabled: true, budgetTokens: 4096 });
  assert.equal(oldOwner.counters.ownerDisposeCalls, 1); assert.equal(oldOwner.counters.projectionRecordEntries, 0); assert.equal(oldOwner.counters.retainedProjectionCodeUnits, 0);
  assert.equal(session.getToolResultBudgetStatus().scope, "session-override");
  await session.prompt("Continue using the completed write. Do not repeat it."); await session.agent.waitForIdle();
  assert.equal(requests, 2); assert.equal(session.getToolResultBudgetStatus().lastRequest, "applied");
  assert.match(lastWire, /created-once/);
  assert.equal(session.messages.filter((message: any) => message.role === "toolResult" && message.toolCallId === "created-once").length, 1);
  assert.equal(SessionManager.open(manager.getSessionFile()!).getBranch().filter((entry: any) => entry.message?.toolCallId === "created-once").length, 1);
  assert.equal(readFileSync(join(cwd, "created.txt"), "utf8"), "完成 exactly once");
  session.configureToolResultBudget({ enabled: true }); assert.equal(session.getToolResultBudgetStatus().state, "enabled-unconfigured");
  session.configureToolResultBudget(undefined); assert.equal(session.getToolResultBudgetStatus().state, "disabled");
  assert.equal(session.getToolResultBudgetStatus().retainedRecords, 0); assert.equal(session.getToolResultBudgetStatus().retainedCodeUnits, 0);
  assert.equal((session as any)._toolResultUiCanonicalMessages, undefined); assert.equal((session as any)._toolResultUiCanonicalMessagesTail, undefined);
  assert.deepEqual(settingsManager.getGlobalSettings(), initialGlobal); assert.deepEqual(settingsManager.getProjectSettings(), initialProject);
  assert.equal(session.agent.state.pendingToolCalls.size, 0); assert.equal((session.extensionRunner as any).finalAuthorizations?.size ?? 0, 0);
});

test("N4 actual read hook layout failure replaces previous applied request status", async () => {
  const { costSession, costCall } = await import("./helpers/next-phase-session.ts");
  const f = await costSession({ budget: 512, extensions: [(pi: any) => {
    pi.on("tool_result", (event: any) => event.toolName === "read" ? { content: [{ type: "text", readBoundary: "lines", text: "1#1234|incomplete hook layout\n".repeat(1000) }] } : undefined);
  }] });
  try {
    writeFileSync(join(f.cwd, "read-layout"), "actual source\n");
    await f.run([], "Record the initial valid request.");
    assert.equal(f.session.getToolResultBudgetStatus().lastRequest, "applied");
    const before = f.metrics.requests;
    await f.run([[costCall("invalid-layout", "read", { path: "read-layout" })]]);
    assert.equal(f.metrics.requests, before + 1, "result projection blocks the next provider request");
    assert.equal(f.metrics.reads, 1); assert.equal(f.result("invalid-layout").isError, false);
    const status = f.session.getToolResultBudgetStatus(); assert.equal(status.lastRequest, "preparation-failed");
    assert.match(formatToolResultBudgetStatus(status), /结果投影准备失败/);
    assert.equal(status.state, "enabled"); assert.equal(readFileSync(join(f.cwd, "read-layout"), "utf8"), "actual source\n");
  } finally { await f.release(); }
});

test("N4 real interactive budget command and settings refuse active tools without a misleading selected value", async t => {
  let release = () => {}, started = () => {};
  const gate = new Promise<void>(resolve => { release = resolve; }), begun = new Promise<void>(resolve => { started = resolve; });
  const f = await alphaSession({ g2: false, customTools: [{ name: "wait_budget", label: "Wait", description: "owned budget UI fixture",
    parameters: { type: "object", properties: {}, additionalProperties: false }, execute: async () => { started(); await gate; return { content: [{ type: "text", text: "complete" }], details: {} }; } }] });
  t.after(async () => { release(); await f.session.agent.waitForIdle(); await f.release(); });
  const state: string[] = [], errors: string[] = [];
  f.internal.showStatus = (value: string) => state.push(value); f.internal.showError = (value: string) => errors.push(value);
  f.internal.setupEditorSubmitHandler();
  await f.internal.editor.onSubmit("/tool-budget 2048");
  assert.equal(f.session.getToolResultBudgetStatus().budgetTokens, 2048); assert.match(state.at(-1)!, /2048/);
  await f.internal.editor.onSubmit("/tool-budget status"); assert.match(state.at(-1)!, /数值未知/);
  const stableCallback = f.internal.onToolResultBudgetSettingChange;
  f.internal.showSettingsSelector();
  const selector = f.internal.editorContainer.children[0], list = selector.getSettingsList();
  list.handleInput("Tool-result budget");
  const item = list.items.find((item: any) => item.id === "tool-result-budget");
  assert.equal(item.currentValue, "2048");
  const pending = f.session.agent.dispatchHostTool({ type: "toolCall", id: "held-budget-tool", name: "wait_budget", arguments: {} });
  await begun;
  list.handleInput("\r"); // 2048 is not a preset: the proposed next value is off.
  assert.equal(f.session.getToolResultBudgetStatus().budgetTokens, 2048);
  assert.equal(item.currentValue, "2048"); assert.match(errors.at(-1)!, /current turn settles/);
  release(); await pending;
  list.handleInput("\r"); assert.equal(item.currentValue, "off"); assert.equal(f.session.getToolResultBudgetStatus().state, "disabled");
  list.handleInput("\r"); assert.equal(item.currentValue, "1024"); assert.equal(f.session.getToolResultBudgetStatus().budgetTokens, 1024);
  assert.equal(f.internal.onToolResultBudgetSettingChange, stableCallback);
  assert.equal(f.internal.getToolResultDiscoveryLifecycleCounts().totalEntries, 0);
});

for (const activity of ["compact", "branch"] as const) test(`N4 budget changes refuse real in-flight ${activity} atomically`, async () => {
  let entered!: () => void, release!: () => void;
  const begun = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  const f = await alphaSession({ messages: Array.from({ length: 8 }, () => alphaMessage([{ type: "text", text: "history ".repeat(2048) }])),
    settings: { compaction: { enabled: false, keepRecentTokens: 128, reserveTokens: 128 } },
    extensions: [(pi: any) => {
      const hold = async () => { entered(); await gate; return { cancel: true }; };
      pi.on("session_before_compact", hold); pi.on("session_before_tree", hold);
    }] });
  let operation: Promise<unknown> | undefined;
  try {
    assert.equal(await f.mode.init(), true);
    const owner = (f.session as any)._toolResultPresentation, generation = f.session.toolResultBudgetGeneration;
    operation = activity === "compact" ? f.session.compact("fixture") : f.session.navigateTree(f.sessionManager.getEntries()[0].id, { summarize: true });
    await begun; assert.equal(f.session.isCompacting, true); assert.equal(f.session.isStreaming, false);
    assert.throws(() => f.session.configureToolResultBudget({ enabled: true, budgetTokens: 2048 }));
    assert.equal((f.session as any)._toolResultPresentation, owner); assert.equal(f.session.toolResultBudgetGeneration, generation);
    assert.equal(owner.counters.ownerDisposeCalls, 0);
    release();
    if (activity === "compact") await assert.rejects(operation, (error: any) => error.message === "Compaction cancelled");
    else await operation;
    operation = undefined; assert.equal(f.session.isCompacting, false);
    f.session.configureToolResultBudget({ enabled: true, budgetTokens: 2048 }); assert.equal(owner.counters.ownerDisposeCalls, 1);
  } finally { release(); await operation?.catch(() => {}); await f.release(); }
});

for (const rebuild of [false, true]) for (const transform of ["identity", "filter", "clone"] as const) test(`N4 changed budget uses actual next-request provenance: ${transform}, rebuild=${rebuild}`, async t => {
  let requests = 0, executions = 0, wire = "";
  let transformEnabled = false;
  const fetchFixture: typeof fetch = async (_url, init) => {
    wire = init!.body as string; requests++;
    const delta = requests === 1 ? { tool_calls: [{ index: 0, id: "budget-history", type: "function", function: { name: "inspect_budget", arguments: "{}" } }] } : { content: "Observed result." };
    const event = { id: "offline", object: "chat.completion.chunk", created: 1, model: "fixture", choices: [{ index: 0, delta, finish_reason: null }] };
    const end = { ...event, choices: [{ index: 0, delta: {}, finish_reason: requests === 1 ? "tool_calls" : "stop" }] };
    return new Response(`data: ${JSON.stringify(event)}\n\ndata: ${JSON.stringify(end)}\n\ndata: [DONE]\n\n`, { headers: { "Content-Type": "text/event-stream" } });
  };
  const runtime = alphaModelRuntime((model: any, context: any, options: any) => streamSimple({ ...model, api: "openai-completions" }, context, { ...options, apiKey: "offline", fetch: fetchFixture, maxRetries: 0 }));
  // The extension runner defensively clones context before invoking any handler.
  // The identity control therefore has no context hook at all.
  const f = await alphaSession({ runtime, budgetTokens: 1024, allowReplacements: true, extensions: transform === "identity" ? undefined : [(pi: any) => pi.on("context", (event: any) => {
    if (!transformEnabled) return;
    return { messages: transform === "filter" ? event.messages.filter((message: any) => message.role !== "toolResult")
      : event.messages.map((message: any) => message.role === "toolResult" ? { ...message, content: message.content.map((block: any) => ({ ...block })) } : message) };
  })], customTools: [{ name: "inspect_budget", label: "Inspect", description: "budget provenance fixture",
    parameters: { type: "object", properties: {}, additionalProperties: false }, execute: async () => { executions++; return { content: [{ type: "text", text: "完整中文 evidence\n".repeat(10000) }], details: {} }; } }] });
  const profiler = process.env.SP_BUDGET_REDISCOVERY_PROFILE === "1" && transform === "identity" ? new InspectorSession() : undefined;
  const cycles = profiler ? 20 : 3;
  let heapBefore = 0, sampledBytes = 0;
  try {
    assert.equal(await f.mode.init(), true);
    await f.session.prompt("Inspect once."); await f.session.agent.waitForIdle();
    assert.equal(requests, 2); assert.equal(executions, 1);
    const first = f.internal.attachedToolResultDiscoveries.get("budget-history"); let component = first.component;
    let previous = component.getToolResultPresentationDiscovery("budget-history"); assert.ok(previous?.cursor);
    transformEnabled = true;
    global.gc?.(); heapBefore = process.memoryUsage().heapUsed;
    if (profiler) { profiler.connect(); await profiler.post("HeapProfiler.startSampling", { samplingInterval: 1024, includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true }); }
    for (let cycle = 0; cycle < cycles; cycle++) {
    const oldOwner = (f.session as any)._toolResultPresentation;
    await f.internal.editor.onSubmit(`/tool-budget ${cycle % 2 ? 1024 : 2048}`);
    assert.equal(component.getToolResultPresentationDiscovery("budget-history"), undefined); assert.equal(oldOwner.counters.retainedProjectionCodeUnits, 0);
    if (rebuild) {
      const oldComponent = component, pendingGeneration = f.internal.toolResultBudgetUiGeneration;
      f.internal.toggleThinkingBlockVisibility();
      assert.equal(f.internal.toolResultBudgetUiGeneration, pendingGeneration);
      assert.notEqual(pendingGeneration, f.session.toolResultBudgetGeneration);
      assert.equal(f.internal.getToolResultDiscoveryLifecycleCounts().totalEntries, 0);
      const canonical = f.session.messages.find((message: any) => message.role === "toolResult" && message.toolCallId === "budget-history");
      assert.ok(canonical?.role === "toolResult");
      component = f.internal.chatContainer.children.find((child: any) => child.hasToolResultSourceForUi?.("budget-history", canonical.content));
      assert.ok(component); assert.notEqual(component, oldComponent);
    }
    await f.session.prompt("Continue without executing the tool again."); await f.session.agent.waitForIdle();
    assert.equal(requests, cycle + 3); assert.equal(executions, 1); assert.ok(wire.includes("budget-history"));
    const next = f.internal.attachedToolResultDiscoveries?.get("budget-history"), current = component.getToolResultPresentationDiscovery("budget-history");
    if (transform === "identity") { assert.equal(next.component, component); assert.ok(current?.cursor); assert.notEqual(current.cursor, previous.cursor); previous = current; }
    else { assert.equal(next, undefined); assert.equal(current, undefined); }
    const toolMessages = JSON.parse(wire).messages.filter((message: any) => message.role === "tool" && message.tool_call_id === "budget-history");
    assert.equal(toolMessages.length, 1);
    // The real OpenAI adapter repairs an orphaned call with this synthetic error.
    // It must never serialize the filtered canonical result or claim its cursor.
    if (transform === "filter") assert.equal(toolMessages[0].content, "No result provided");
    else assert.ok(JSON.stringify(toolMessages[0].content).includes("完整中文 evidence"));
    assert.equal((f.session as any)._toolBudgetSourceCapturePasses, cycle + 1);
    assert.equal((f.session as any)._toolBudgetProjectedSources, undefined);
    assert.equal(f.internal.toolResultBudgetRediscoveryPasses, cycle + 1);
    const probes = f.internal.toolResultBudgetRediscoveryComponentProbes;
    for (let n = 0; n < 100; n++) f.internal.rediscoverToolResultsAfterBudgetChange();
    assert.equal(f.internal.toolResultBudgetRediscoveryComponentProbes, probes);
    }
    if (transform === "identity" && !profiler) {
      const messages = f.session.messages;
      const replaced = await f.runtime.newSession({ setup: async manager => {
        for (const message of messages) {
          assert.ok(message.role === "user" || message.role === "assistant" || message.role === "toolResult");
          manager.appendMessage(message);
        }
      } });
      assert.equal(replaced.cancelled, false);
      assert.equal(f.internal.toolResultBudgetUiGeneration, f.runtime.session.toolResultBudgetGeneration);
      await f.runtime.session.prompt("Continue in the replacement Session."); await f.runtime.session.agent.waitForIdle();
      const attached = f.internal.attachedToolResultDiscoveries?.get("budget-history");
      assert.ok(attached?.component.getToolResultPresentationDiscovery("budget-history")?.cursor);
      component = attached.component; assert.equal(executions, 1);
    }
    await f.internal.editor.onSubmit("/tool-budget off"); assert.equal(component.getToolResultPresentationDiscovery("budget-history"), undefined);
    assert.equal(f.internal.getToolResultDiscoveryLifecycleCounts().totalEntries, 0);
    assert.ok(formatToolResultBudgetStatus(f.session.getToolResultBudgetStatus()).includes("MCP 输入接收失败"));
  } finally {
    await f.release();
    if (profiler) {
      try {
        const { profile } = await profiler.post("HeapProfiler.stopSampling");
        const stack = [profile.head];
        while (stack.length) { const node = stack.pop()!; sampledBytes += node.selfSize; for (const child of node.children) stack.push(child); }
        profile.head.children.length = 0;
        const samples = (profile as typeof profile & { samples?: unknown[] }).samples;
        if (samples) samples.length = 0;
      } finally { profiler.disconnect(); }
    }
  }
  assert.equal(f.internal.getToolResultDiscoveryLifecycleCounts().totalEntries, 0);
  global.gc?.();
  t.diagnostic(JSON.stringify({ benchmark: "explicit-budget-rediscovery", transform, rebuild, node: process.version, cycles, requests, executions,
    rediscoveryPasses: f.internal.toolResultBudgetRediscoveryPasses, componentProbes: f.internal.toolResultBudgetRediscoveryComponentProbes,
    unchangedGenerationAdditionalProbes: 0, retainedRegistrationsAfterRelease: 0, sampledBytes: profiler ? sampledBytes : null,
    heapBefore, heapAfterRelease: process.memoryUsage().heapUsed, note: "Explicit command/whole request cost; not per-delta cost or a speedup claim." }));
});

for (const failure of ["payload-hook", "runtime"]) test(`N4 budget provenance waits for effective dispatch after ${failure} rejection`, async () => {
  let requests = 0, executions = 0, rejectRequest = false;
  const fetchFixture: typeof fetch = async () => {
    const first = ++requests === 1;
    const delta = first ? { tool_calls: [{ index: 0, id: "dispatch-history", type: "function", function: { name: "inspect_dispatch", arguments: "{}" } }] } : { content: "Observed." };
    const event = { id: "offline", object: "chat.completion.chunk", created: 1, model: "fixture", choices: [{ index: 0, delta, finish_reason: null }] };
    const end = { ...event, choices: [{ index: 0, delta: {}, finish_reason: first ? "tool_calls" : "stop" }] };
    return new Response(`data: ${JSON.stringify(event)}\n\ndata: ${JSON.stringify(end)}\n\ndata: [DONE]\n\n`, { headers: { "Content-Type": "text/event-stream" } });
  };
  const runtime = alphaModelRuntime((model: any, context: any, options: any) => {
    if (rejectRequest && failure === "runtime") throw new Error("fixture before-dispatch runtime failure");
    return streamSimple({ ...model, api: "openai-completions" }, context, { ...options, apiKey: "offline", fetch: fetchFixture, maxRetries: 0 });
  });
  const f = await alphaSession({ runtime, settings: { retry: { enabled: false } }, extensions: failure === "payload-hook" ? [(pi: any) => {
    pi.on("before_provider_request", () => { if (rejectRequest) throw new ExtensionHookTimeoutError("fixture", "before_provider_request", 1); });
  }] : undefined, customTools: [{ name: "inspect_dispatch", label: "Inspect", description: "dispatch fixture", parameters: { type: "object", properties: {} },
    execute: async () => { executions++; return { content: [{ type: "text", text: "完整证据\n".repeat(10000) }] }; } }] });
  try {
    assert.equal(await f.mode.init(), true); await f.session.prompt("Inspect once."); await f.session.agent.waitForIdle();
    const component = f.internal.attachedToolResultDiscoveries.get("dispatch-history").component;
    assert.equal(requests, 2); assert.equal(executions, 1);
    await f.internal.editor.onSubmit("/tool-budget 2048"); rejectRequest = true;
    await f.session.prompt("Continue."); await f.session.agent.waitForIdle();
    assert.equal(requests, 2); assert.equal(component.getToolResultPresentationDiscovery("dispatch-history"), undefined);
    assert.equal(f.session.toolResultBudgetRediscoveryState, "waiting"); assert.equal((f.session as any)._toolBudgetProjectedSources, undefined);
    assert.notEqual(f.internal.toolResultBudgetUiGeneration, f.session.toolResultBudgetGeneration);
    assert.equal((f.session as any)._toolBudgetSourceCapturePasses, 1);
    f.internal.toggleThinkingBlockVisibility(); assert.equal(f.internal.getToolResultDiscoveryLifecycleCounts().totalEntries, 0);
    rejectRequest = false; await f.session.prompt("Retry preparation, keep the completed tool."); await f.session.agent.waitForIdle();
    assert.equal(requests, 3); assert.equal(executions, 1); assert.equal((f.session as any)._toolBudgetSourceCapturePasses, 2);
    assert.equal(f.internal.toolResultBudgetUiGeneration, f.session.toolResultBudgetGeneration);
    assert.equal(f.session.toolResultBudgetRediscoveryState, "none");
    const attached = f.internal.attachedToolResultDiscoveries?.get("dispatch-history");
    if (failure === "runtime") assert.ok(attached?.component.getToolResultPresentationDiscovery("dispatch-history")?.cursor);
    else assert.equal(attached, undefined, "arbitrary payload hooks cannot establish canonical source provenance");
  } finally { await f.release(); }
  assert.equal(f.internal.getToolResultDiscoveryLifecycleCounts().totalEntries, 0);
});

test("N4 unconfigured budget generation settles without per-response status snapshots", async t => {
  let requests = 0;
  const runtime = alphaModelRuntime(() => { requests++; const stream = new AssistantMessageEventStream();
    stream.push({ type: "done", reason: "stop", message: alphaMessage([{ type: "text", text: "done" }]) }); return stream; });
  const f = await alphaSession({ runtime });
  try {
    assert.equal(await f.mode.init(), true); f.session.configureToolResultBudget({ enabled: true });
    const status = f.session.getToolResultBudgetStatus.bind(f.session); let snapshots = 0;
    t.mock.method(f.session, "getToolResultBudgetStatus", () => { snapshots++; return status(); });
    for (let request = 0; request < 5; request++) { await f.session.prompt("fixture"); await f.session.agent.waitForIdle(); }
    assert.equal(requests, 5); assert.equal(f.internal.toolResultBudgetUiGeneration, f.session.toolResultBudgetGeneration);
    for (let probe = 0; probe < 1000; probe++) f.internal.rediscoverToolResultsAfterBudgetChange();
    assert.equal(snapshots, 0); assert.equal((f.session as any)._toolBudgetSourceCapturePasses, 0);
    assert.equal(f.internal.toolResultBudgetRediscoveryPasses, 0); assert.equal(f.internal.getToolResultDiscoveryLifecycleCounts().totalEntries, 0);
  } finally { await f.release(); }
});
