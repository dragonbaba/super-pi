import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createAgentSession } from "../packages/coding-agent/src/core/sdk.ts";
import { DefaultResourceLoader } from "../packages/coding-agent/src/core/resource-loader.ts";
import { SettingsManager } from "../packages/coding-agent/src/core/settings-manager.ts";
import { SessionManager } from "../packages/coding-agent/src/core/session-manager.ts";
import { parseToolResultBudgetCommand, formatToolResultBudgetStatus } from "../packages/coding-agent/src/core/tool-result-budget-status.ts";
import { ALPHA_MODEL, alphaModelRuntime, alphaSession } from "./helpers/alpha-session.ts";
import { streamSimple } from "@super-pi/ai/api/openai-completions";

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
