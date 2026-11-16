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
