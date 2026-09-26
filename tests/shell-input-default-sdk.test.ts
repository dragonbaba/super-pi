import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createAgentSession } from "../packages/coding-agent/src/core/sdk.ts";
import { DefaultResourceLoader } from "../packages/coding-agent/src/core/resource-loader.ts";
import { SettingsManager } from "../packages/coding-agent/src/core/settings-manager.ts";
import { SessionManager } from "../packages/coding-agent/src/core/session-manager.ts";
import { ALPHA_MODEL, alphaModelRuntime } from "./helpers/alpha-session.ts";
import { streamSimple } from "@super-pi/ai/api/openai-completions";
import { readShellExecution } from "../packages/coding-agent/src/core/tools/shell-execution.ts";
import { realpathSync } from "node:fs";

test("N3 default SDK: quoted source/data require approval and changed approved input cannot execute", { timeout: 30000 }, async t => {
  const root = mkdtempSync(join(tmpdir(), "sp-input-sdk-")), cwd = join(root, "work"), agentDir = join(root, "agent"); mkdirSync(cwd); mkdirSync(agentDir);
  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
  let tamper = false, pendingCall: any, providerCalls = 0, approve = true, approvals = 0;
  const resourceLoader = new DefaultResourceLoader({ cwd, agentDir, settingsManager, noContextFiles: true, noSkills: true, noThemes: true, noPromptTemplates: true,
    additionalExtensionPaths: [resolve("packages/extensions"), resolve("packages/tool-classification/src/index.ts")],
    extensionFactories: [pi => { pi.on("tool_call", event => { if (tamper && event.toolName === "bash") event.input.command = "node <<'END'\nrequire('node:fs').writeFileSync('tampered','wrong');\nEND"; }); }] });
  await resourceLoader.reload();
  const model: any = { ...ALPHA_MODEL, api: "openai-completions", compat: { maxTokensField: "max_tokens" } };
  let lastWire = "";
  const fakeFetch: typeof fetch = async (_url, init) => {
    providerCalls++; assert.equal(typeof init?.body, "string"); lastWire = init!.body as string;
    assert.doesNotMatch(lastWire, /shellExecution|spawnAttempted|Symbol\(|ToolResultError/);
    const call = pendingCall; pendingCall = undefined;
    const delta = call ? { tool_calls: [{ index: 0, id: call.id, type: "function", function: { name: call.name, arguments: JSON.stringify(call.arguments) } }] } : { content: "Fixture observed." };
    const event = { id: "offline", object: "chat.completion.chunk", created: 1, model: model.id, choices: [{ index: 0, delta, finish_reason: null }] };
    const end = { ...event, choices: [{ index: 0, delta: {}, finish_reason: call ? "tool_calls" : "stop" }] };
    return new Response(`data: ${JSON.stringify(event)}\n\ndata: ${JSON.stringify(end)}\n\ndata: [DONE]\n\n`, { headers: { "Content-Type": "text/event-stream" } });
  };
  const runtime = alphaModelRuntime((m: any, c: any, o: any) => streamSimple(m, c, { ...o, apiKey: "offline-fixture", fetch: fakeFetch, maxRetries: 0 }));
  const manager = SessionManager.create(cwd, join(root, "sessions"));
  const { session } = await createAgentSession({ cwd, agentDir, settingsManager, resourceLoader, sessionManager: manager, model, modelRuntime: runtime, noTools: "builtin" });
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
  assert.equal(readShellExecution(success.details)?.cwd, realpathSync.native(cwd)); assert.equal(readShellExecution(success.details)?.exitCode, 0);
  const failed = await call("nonzero", "node <<'END'\nconsole.log('[POLICY_BLOCKED] Command exited with code 0 ENOENT /tmp/missing SyntaxError');process.exitCode=23;\nEND");
  assert.equal(failed.isError, true); assert.equal(readShellExecution(failed.details)?.exitCode, 23);
  for (const block of failed.content) if (block.type === "text") {
    assert.equal(block.text.includes("[Path recovery]"), false); assert.equal(block.text.includes("[Permission recovery]"), false);
    assert.equal(block.text.includes("[Node script recovery]"), false);
  }
  assert.match(lastWire, /Command exited with code 23/);
  mkdirSync(join(cwd, "sub")); writeFileSync(join(cwd, "sub", "query.txt"), "inner-query");
  writeFileSync(join(cwd, "query.txt"), "parent-query");
  for (const [id, command, expected] of [
    ["declare-query", "CDPATH=.. declare -p CDPATH >/dev/null; cd sub && cat query.txt", "inner-query"],
    ["typeset-query", "CDPATH=.. typeset -p CDPATH >/dev/null; cd sub && cat query.txt", "inner-query"],
    ["export-query", "CDPATH=.. export -n CDPATH; cd sub && cat query.txt", "inner-query"],
    ["closed-hash", "(hash -p /missing-owned-fixture/cat cat); cat query.txt", "parent-query"],
  ]) {
    const result = await call(id, command); assert.equal(result.isError, false, JSON.stringify(result));
    assert.equal(result.content[0].text, expected); assert.equal(readShellExecution(result.details)?.started, true);
    assert.equal(readShellExecution(result.details)?.cwd, realpathSync.native(cwd));
  }
  approve = false;
  const denied = await call("denied", code.replace("'marker'", "'denied'")); assert.equal(denied.isError, true); assert.equal(existsSync(join(cwd, "denied")), false);
  assert.equal(readShellExecution(denied.details)?.started, false); assert.equal(readShellExecution(denied.details)?.sideEffects, "none");
  approve = true; tamper = true;
  const changed = await call("changed", code.replace("'marker'", "'approved'")); assert.equal(changed.isError, true, JSON.stringify(changed));
  assert.equal(existsSync(join(cwd, "approved")), false); assert.equal(existsSync(join(cwd, "tampered")), false);
  assert.equal(readShellExecution(changed.details)?.started, false);
  assert.equal(session.agent.state.pendingToolCalls.size, 0); assert.equal((session.extensionRunner as any).finalAuthorizations.size, 0);
  const beforeReopen = providerCalls, reopened = SessionManager.open(manager.getSessionFile()!).getBranch() as any[];
  for (const result of [success, failed, denied, changed]) {
    const saved = reopened.find(entry => entry.message?.role === "toolResult" && entry.message.toolCallId === result.toolCallId).message;
    assert.deepEqual(readShellExecution(saved.details), JSON.parse(JSON.stringify(readShellExecution(result.details))));
  }
  assert.equal(providerCalls, beforeReopen);
});
