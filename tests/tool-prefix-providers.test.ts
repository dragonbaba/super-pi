import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Type } from "typebox";
import { createAgentSession } from "../packages/coding-agent/src/core/sdk.ts";
import type { AgentSession } from "../packages/coding-agent/src/core/agent-session.ts";
import { DefaultResourceLoader } from "../packages/coding-agent/src/core/resource-loader.ts";
import { SessionManager } from "../packages/coding-agent/src/core/session-manager.ts";
import { SettingsManager } from "../packages/coding-agent/src/core/settings-manager.ts";
import { createSyntheticSourceInfo } from "../packages/coding-agent/src/core/source-info.ts";
import type { ExtensionAPI } from "../packages/coding-agent/src/core/extensions/types.ts";
// @ts-expect-error JavaScript extension package.
import { McpBridgeRuntime } from "../packages/mcp-bridge/src/bridge.js";
import { alphaModelRuntime } from "./helpers/alpha-session.ts";
import { historyContent, prefixCases, prefixTransport } from "./helpers/provider-prefix-transport.ts";
import dynamicInstructions from "../packages/dynamic-instructions/src/index.ts";
import { withCurrentContextUsage, withHistoricalContextUsage } from "../packages/ai/src/utils/estimate.ts";
import { epochAssistant } from "./helpers/compaction-epoch-fixture.ts";
import toolClassification from "../packages/tool-classification/src/index.ts";
import { createJiti } from "jiti";

const { default: planMode } = await createJiti(import.meta.url).import<typeof import("../packages/plan-mode/src/plan-mode.ts")>("../packages/plan-mode/src/plan-mode.ts");

for (const { label, model } of prefixCases) test(`${label}: default controls survive discovery and Plan owns its visible selection`, async t => {
  const transport = await prefixTransport(t, model);
  const root = await mkdtemp(join(tmpdir(), "sp-control-prefix-"));
  let owner: AgentSession | undefined;
  t.after(async () => {
    try {
      if (owner) { owner.dispose(); await (owner as any)._codemode.close(); await owner.waitForSessionLeaseRelease(); }
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  const settings = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
  const loader = new DefaultResourceLoader({ cwd: root, agentDir: root, settingsManager: settings,
    noExtensions: true, noContextFiles: true, noSkills: true, noThemes: true, noPromptTemplates: true,
    extensionFactories: [
      pi => planMode(pi, { readSettings: async () => ({ kind: "loaded", settings: { thinkingLevel: "inherit", defaultPlanTools: ["read", "tool_search"] } }) }),
      toolClassification,
    ] });
  await loader.reload();
  const tools = ["fixture_control", "fixture_lookup", "excluded_control"].map(name => ({ name, label: name, description: name,
    modelOnly: name.endsWith("_control"), parameters: Type.Object({}), execute: async () => ({ content: [], details: {} }) }));
  const { session } = await createAgentSession({ cwd: root, agentDir: root, model, resourceLoader: loader, settingsManager: settings,
    sessionManager: SessionManager.inMemory(root), modelRuntime: alphaModelRuntime(transport.stream),
    customTools: tools, excludeTools: ["excluded_control"] });
  owner = session;
  await session.bindExtensions({});
  const probe = async (message: string) => {
    const count = transport.sent.length;
    await session.prompt(message);
    assert.equal(transport.sent.length, count + 1);
    const last = session.messages.at(-1);
    assert.ok(last?.role === "assistant" && last.stopReason === "stop", last?.role === "assistant" ? last.errorMessage : message);
    return transport.sent[count]!;
  };
  const lookup = async (query: string) => {
    const tool = session.agent.state.tools.find(entry => entry.name === "tool_search");
    assert.ok(tool);
    return (await tool.execute("catalog", { query, exact: true })).details as { added: string[]; alreadyActive?: string[] };
  };
  const baseline = await probe("Inspect available controls");
  assert.match(baseline.prefix, /fixture_control/);
  assert.doesNotMatch(baseline.prefix, /excluded_control/);
  assert.deepEqual((await lookup("fixture_lookup")).added, ["fixture_lookup"]);
  assert.deepEqual((await lookup("fixture_control")).alreadyActive, ["fixture_control"]);
  const warm = await probe("Continue after discovery");
  assert.equal(warm.prefix, baseline.prefix);
  assert.deepEqual(historyContent(warm.history).slice(0, baseline.history.length), historyContent(baseline.history));
  const runner = session.extensionRunner!;
  const command = runner.getCommand("plan")!;
  await command.handler("start", runner.createCommandContext());
  const planned = await probe("Explore in Plan");
  assert.equal(session.getToolCatalog().selectionMode, "plan");
  if (model.id === "claude-opus-5") {
    const updates = planned.history.flatMap(message => message.role === "system" && Array.isArray(message.content) ? message.content : []);
    assert.ok(updates.some(block => block.type === "tool_removal" && block.tool.name === "fixture_control"));
    assert.ok(updates.some(block => block.type === "tool_addition" && block.tool.definition?.name === "plan_mode_complete"));
  } else {
    assert.doesNotMatch(planned.prefix, /fixture_control/);
    assert.match(planned.prefix, /plan_mode_complete/);
  }
  assert.deepEqual((await lookup("fixture_control")).added, [], "optional Plan discovery respects the selected tools");
  assert.equal((await probe("Continue planning")).prefix, planned.prefix);
  await command.handler("exit", runner.createCommandContext());
  const restored = await probe("Return to ordinary work");
  assert.equal(restored.prefix, baseline.prefix);
  if (model.id === "claude-opus-5") {
    const updates = restored.history.slice(planned.history.length).flatMap(message => message.role === "system" && Array.isArray(message.content) ? message.content : []);
    assert.ok(updates.some(block => block.type === "tool_addition" && (block.tool.name ?? block.tool.definition?.name) === "fixture_control"));
  }
});

for (const { label, model } of prefixCases) test(`${label}: usage epoch metadata leaves the serialized prefix and history identical`, async t => {
  const transport = await prefixTransport(t, model);
  const old = { ...epochAssistant(512307, 1), api: model.api, provider: model.provider, model: model.id };
  const current = { ...old, timestamp: 2, usage: epochAssistant(1024).usage };
  const messages = [{ role: "user" as const, content: "unchanged original task", timestamp: 0 }, old, current];
  const raw = JSON.stringify(messages);
  const first = await transport.stream(model, { systemPrompt: "Fixed instructions", messages }, {}).result();
  assert.equal(first.stopReason, "stop", first.errorMessage);
  const second = await transport.stream(model, { systemPrompt: "Fixed instructions", messages: [messages[0], withHistoricalContextUsage(old), withCurrentContextUsage(current)] }, {}).result();
  assert.equal(second.stopReason, "stop", second.errorMessage);
  assert.equal(transport.sent.length, 2);
  assert.equal(transport.sent[1]!.prefix, transport.sent[0]!.prefix);
  assert.deepEqual(transport.sent[1]!.history, transport.sent[0]!.history);
  assert.equal(JSON.stringify(messages), raw);
});

for (const { label, model } of prefixCases) test(`${label}: tool catalog transitions preserve actual wire prefix and prior history`, async t => {
  const transport = await prefixTransport(t, model);
  const root = await mkdtemp(join(tmpdir(), "sp-provider-prefix-"));
  let sessionOwner: AgentSession | undefined, bridge: any;
  t.after(async () => {
    try {
      await bridge?.close();
      if (sessionOwner) {
        sessionOwner.dispose(); await (sessionOwner as any)._codemode.close(); await sessionOwner.waitForSessionLeaseRelease();
      }
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  const local = (name: string) => ({ name, label: name, description: name, parameters: Type.Object({}),
    execute: async () => { throw new Error("prefix discovery must never execute tools"); } });
  const a = local("alpha"), b = { ...local("beta"), promptGuidelines: ["Keep the fixture's current contract."] };
  let api!: ExtensionAPI;
  const settings = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
  const loader = new DefaultResourceLoader({ cwd: root, agentDir: root, settingsManager: settings,
    noContextFiles: true, noSkills: true, noThemes: true, noPromptTemplates: true,
    extensionFactories: [pi => {
      pi.registerTool(b);
      api = pi; bridge = new McpBridgeRuntime(pi, "fixture");
      const state = { status: "connected", catalogReady: true, config: { id: "fixture" }, tools: new Map([["query", {}]]), client: { async close() {} } };
      bridge.states.set("fixture", state);
      bridge.registerRemoteTool(state, { name: "query", description: "Initial remote contract", inputSchema: { type: "object" } });
    }],
  });
  await loader.reload();
  t.mock.method(loader, "getSkills", () => ({ skills: [{ name: "fixture-skill", description: "Stable skill contract", baseDir: root,
    filePath: join(root, "SKILL.md"), disableModelInvocation: false, sourceInfo: createSyntheticSourceInfo(join(root, "SKILL.md"), { source: "fixture" }) }], diagnostics: [] }));
  const controls = ["control_a", "control_b"].map(name => ({ ...local(name), modelOnly: true, promptSnippet: `${name} fixture control` }));
  const { session } = await createAgentSession({ cwd: root, agentDir: root, model, resourceLoader: loader, settingsManager: settings,
    sessionManager: SessionManager.inMemory(root), modelRuntime: alphaModelRuntime(transport.stream), noTools: "builtin", customTools: [a, local("bash"), local("read"), ...controls] });
  sessionOwner = session;
  const names = (nested: string[]) => ["control_a", ...nested, "control_b", "codemode"];
  const probe = async (active: string[]) => {
    session.setActiveToolsByName(active);
    const before = transport.sent.length;
    await session.prompt("Inspect the current contracts.");
    const message = session.messages.at(-1)!;
    assert.equal(message.role, "assistant");
    assert.equal((message as any).stopReason, "stop", (message as any).errorMessage);
    assert.equal(transport.sent.length, before + 1, "one successful request, no hidden retry");
    return transport.sent.at(-1)!;
  };
  const first = await probe(names(["alpha"]));
  assert.match(first.prefix, /codemode/);
  assert.match(first.prefix, /control_a/);
  assert.match(first.prefix, /control_b/);
  if (model.id === "claude-opus-5") assert.match(first.prefix, /__pi_deferred_placeholder__/);
  if (model.provider === "openrouter") assert.match(first.prefix, /cache_control/);
  if (model.api === "bedrock-converse-stream") assert.match(first.prefix, /cachePoint/);
  const system = session.agent.state.systemPrompt;
  assert.match(system, /fixture-skill/);
  assert.match(system, /Keep the fixture's current contract/);
  let previous = first;
  const stable = async (active: string[]) => {
    const next = await probe(active);
    assert.ok(next.prefix === first.prefix, `${label} (${active.join(",")}): tool/system/cache wire fields changed`);
    assert.equal(session.agent.state.systemPrompt, system, "equivalent activation must not rewrite the application prompt");
    const earlier = historyContent(previous.history), current = historyContent(next.history);
    assert.deepEqual(current.slice(0, earlier.length), earlier, "earlier conversation content changed");
    assert.ok(next.rawBytes > 0 && next.wireBytes > 0);
    previous = next;
  };
  await stable(names(["alpha", "beta"]));
  await stable(names(["beta", "alpha"]));
  api.registerTool({ ...b, description: "Replaced local contract", parameters: Type.Object({ revised: Type.String() }) });
  assert.equal(session.getToolDefinition("beta")!.description, "Replaced local contract");
  const revisedLocal = session.getToolDefinition("beta")!.parameters;
  assert.ok("required" in revisedLocal);
  assert.deepEqual(revisedLocal.required, ["revised"]);
  await stable(names(["alpha", "beta"]));
  await stable(names(["mcp__fixture__query", "alpha"]));
  bridge.registerRemoteTool(bridge.states.get("fixture"), { name: "query", description: "Refreshed remote contract", inputSchema: {
    type: "object", properties: { revised: { type: "string" } }, required: ["revised"] } });
  const revisedRemote = session.getToolDefinition("mcp__fixture__query")!.parameters;
  assert.ok("required" in revisedRemote);
  assert.deepEqual(revisedRemote.required, ["revised"]);
  await stable(names(["alpha", "mcp__fixture__query"]));
  await stable(names(["alpha"]));
  await stable(names(["alpha", "bash", "read"]));
  // Equivalent direct selection must not depend on caller ordering or gateway position.
  await stable(["codemode", "control_b", "alpha", "control_a"]);
  api.registerTool({ ...b, promptGuidelines: ["Apply the fixture's revised authoritative rule."] });
  const revised = await probe(names(["alpha", "beta"]));
  assert.match(session.agent.state.systemPrompt, /Apply the fixture's revised authoritative rule/);
  assert.doesNotMatch(session.agent.state.systemPrompt, /Keep the fixture's current contract/);
  assert.match(revised.prefix + JSON.stringify(revised.history), /Apply the fixture's revised authoritative rule/,
    "real rule changes must reach every provider, including native inline history");
  t.diagnostic(JSON.stringify({ requests: transport.sent.length, fixedPrefixUtf8Bytes: Buffer.byteLength(first.prefix),
    firstRawBytes: first.rawBytes, firstWireBytes: first.wireBytes }));
});

for (const { label, model } of prefixCases) test(`${label}: compaction restores visible rules without changing the wire prefix`, async t => {
  const transport = await prefixTransport(t, model), root = await mkdtemp(join(tmpdir(), "sp-compacted-prefix-"));
  let owner: AgentSession | undefined;
  t.after(async () => {
    try { if (owner) { owner.dispose(); await (owner as any)._codemode.close(); await owner.waitForSessionLeaseRelease(); } }
    finally { await rm(root, { recursive: true, force: true }); }
  });
  const manager = SessionManager.inMemory(root), settings = SettingsManager.inMemory({ compaction: { enabled: false, keepRecentTokens: 1 }, retry: { enabled: false } });
  const loader = new DefaultResourceLoader({ cwd: root, agentDir: root, settingsManager: settings,
    noContextFiles: true, noSkills: true, noThemes: true, noPromptTemplates: true,
    extensionFactories: [dynamicInstructions, pi => pi.on("session_before_compact", event => ({ compaction: {
      summary: "Offline compaction fixture", firstKeptEntryId: manager.getLeafId()!, tokensBefore: event.preparation.tokensBefore,
    } }))],
  });
  await loader.reload();
  t.mock.method(loader, "getAgentsFiles", () => ({ agentsFiles: [{ path: join(root, "AGENTS.md"), content: "WORKSPACE_RULE_RESTORE_629" }] }));
  const { session } = await createAgentSession({ cwd: root, agentDir: root, model, resourceLoader: loader, settingsManager: settings,
    sessionManager: manager, modelRuntime: alphaModelRuntime(transport.stream), noTools: "all" });
  owner = session;
  await session.prompt("Before compaction");
  assert.equal((session.messages.at(-1) as any).stopReason, "stop");
  const before = transport.sent[0]!;
  assert.match(JSON.stringify(before.history), /WORKSPACE_RULE_RESTORE_629/);
  await session.compact();
  assert.doesNotMatch(JSON.stringify(manager.buildSessionContext().messages), /WORKSPACE_RULE_RESTORE_629/);
  await session.prompt("After compaction");
  assert.equal((session.messages.at(-1) as any).stopReason, "stop");
  assert.equal(transport.sent[1]!.prefix, before.prefix);
  assert.match(JSON.stringify(transport.sent[1]!.history), /WORKSPACE_RULE_RESTORE_629/);
  await session.prompt("Unchanged next turn");
  assert.equal(transport.sent[2]!.prefix, before.prefix);
  assert.equal(transport.sent.length, 3, "one dispatch per regular turn and no provider request for the compaction fixture");
  let replacements = 0;
  for (const entry of manager.getEntries()) if (entry.type === "custom_message" && entry.customType === "dynamic-instructions-v1") replacements++;
  assert.equal(replacements, 2, "reinject once after compaction, never on the next unchanged turn");
});
