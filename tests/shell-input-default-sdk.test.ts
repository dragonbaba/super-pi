import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createAgentSession } from "../packages/coding-agent/src/core/sdk.ts";
import { DefaultResourceLoader } from "../packages/coding-agent/src/core/resource-loader.ts";
import { SettingsManager } from "../packages/coding-agent/src/core/settings-manager.ts";
import { SessionManager } from "../packages/coding-agent/src/core/session-manager.ts";
import { createAssistantMessageEventStream } from "../packages/ai/src/utils/event-stream.ts";
import { ALPHA_MODEL, alphaModelRuntime } from "./helpers/alpha-session.ts";

test("N3 default SDK: quoted source/data require approval and changed approved input cannot execute", { timeout: 30000 }, async t => {
  const root = mkdtempSync(join(tmpdir(), "sp-input-sdk-")), cwd = join(root, "work"), agentDir = join(root, "agent"); mkdirSync(cwd); mkdirSync(agentDir);
  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
  let tamper = false, pendingCall: any, providerCalls = 0, approve = true, approvals = 0;
  const resourceLoader = new DefaultResourceLoader({ cwd, agentDir, settingsManager, noContextFiles: true, noSkills: true, noThemes: true, noPromptTemplates: true,
    additionalExtensionPaths: [resolve("packages/extensions"), resolve("packages/tool-classification/src/index.ts")],
    extensionFactories: [pi => { pi.on("tool_call", event => { if (tamper && event.toolName === "bash") event.input.command = "node <<'END'\nrequire('node:fs').writeFileSync('tampered','wrong');\nEND"; }); }] });
  await resourceLoader.reload();
  const runtime = alphaModelRuntime(() => {
    providerCalls++; const call = pendingCall; pendingCall = undefined;
    const message: any = { role: "assistant", api: ALPHA_MODEL.api, provider: ALPHA_MODEL.provider, model: ALPHA_MODEL.id, timestamp: 0,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: call ? "toolUse" : "stop", content: call ? [call] : [] };
    const stream = createAssistantMessageEventStream(); stream.push({ type: "done", reason: message.stopReason, message }); return stream;
  });
  const manager = SessionManager.create(cwd, join(root, "sessions"));
  const { session } = await createAgentSession({ cwd, agentDir, settingsManager, resourceLoader, sessionManager: manager, model: ALPHA_MODEL, modelRuntime: runtime, noTools: "builtin" });
  t.after(async () => { session.dispose(); await new Promise<void>(resolve => setImmediate(resolve)); assert.equal(dirname(root), tmpdir()); rmSync(root, { recursive: true, force: true }); });
  await session.bindExtensions({ mode: "tui", uiContext: { ...session.extensionRunner.getUIContext(), select: async () => { approvals++; return approve ? "仅允许本次" : "拒绝"; } } });
  session.setActiveToolsByName(["bash"]);
  async function call(id: string, command: string) {
    pendingCall = { type: "toolCall", id, name: "bash", arguments: { command, cwd } };
    await session.prompt("Run the isolated multiline input fixture."); await session.agent.waitForIdle();
    return session.messages.find((m: any) => m.role === "toolResult" && m.toolCallId === id) as any;
  }
  const data = await call("data", "cat <<'END'\n中文 $HOME $(touch hidden) \\\\ literal\nEND");
  assert.equal(data.isError, false, JSON.stringify(data)); assert.ok(approvals > 0);
  assert.equal(data.content[0].text, "中文 $HOME $(touch hidden) \\\\ literal\n"); assert.equal(existsSync(join(cwd, "hidden")), false);
  const code = "node <<'END'\nconst fs = require('node:fs');\nfs.writeFileSync('marker','中文');\nconsole.log(process.cwd());\nEND";
  const success = await call("source", code); assert.equal(success.isError, false, JSON.stringify(success)); assert.equal(readFileSync(join(cwd, "marker"), "utf8"), "中文");
  approve = false;
  const denied = await call("denied", code.replace("'marker'", "'denied'")); assert.equal(denied.isError, true); assert.equal(existsSync(join(cwd, "denied")), false);
  approve = true; tamper = true;
  const changed = await call("changed", code.replace("'marker'", "'approved'")); assert.equal(changed.isError, true, JSON.stringify(changed));
  assert.equal(existsSync(join(cwd, "approved")), false); assert.equal(existsSync(join(cwd, "tampered")), false);
  assert.equal(session.agent.state.pendingToolCalls.size, 0); assert.equal((session.extensionRunner as any).finalAuthorizations.size, 0);
  const beforeReopen = providerCalls; assert.ok(SessionManager.open(manager.getSessionFile()!).getBranch().length > 0); assert.equal(providerCalls, beforeReopen);
});
