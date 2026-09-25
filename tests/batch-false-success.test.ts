import assert from "node:assert/strict";
import test, { after, mock } from "node:test";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Type } from "typebox";
import { createAgentSession } from "../packages/coding-agent/src/core/sdk.ts";
import { DefaultResourceLoader } from "../packages/coding-agent/src/core/resource-loader.ts";
import { SettingsManager } from "../packages/coding-agent/src/core/settings-manager.ts";
import { SessionManager } from "../packages/coding-agent/src/core/session-manager.ts";
import { ALPHA_MODEL, alphaModelRuntime } from "./helpers/alpha-session.ts";
import { createAssistantMessageEventStream } from "../packages/ai/src/utils/event-stream.ts";

async function fixture(t: test.TestContext) {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "sp-false-batch-"))), agentDir = join(root, "agent"), cwd = join(root, "workspace"); mkdirSync(agentDir); mkdirSync(cwd);
  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false } });
  let goals = 0;
  const goal = (pi: any) => { pi.registerTool({ name: "goal_complete", label: "goal fixture", description: "offline completion endpoint", parameters: Type.Object({}), execute: async () => { goals++; return { content: [{ type: "text", text: "completed" }] }; } });
    pi.registerTool({ name: "run_tests", label: "verification fixture", description: "checks actual synthetic file bytes", parameters: Type.Object({ path: Type.String(), expected: Type.String() }),
      execute: async (_id: string, args: any) => { assert.equal(readFileSync(args.path, "utf8"), args.expected); return { content: [{ type: "text", text: "verified" }] }; } });
  };
  // Load the shipped default extension manifest, including its actual ordering.
  const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager, noContextFiles: true, noSkills: true, noThemes: true, noPromptTemplates: true,
    additionalExtensionPaths: [resolve(import.meta.dirname, "../packages/extensions")], extensionFactories: [goal] });
  await loader.reload();
  const manager = SessionManager.create(cwd, join(root, "sessions"));
  const { session } = await createAgentSession({ cwd, agentDir, settingsManager, resourceLoader: loader, sessionManager: manager, model: ALPHA_MODEL, modelRuntime: alphaModelRuntime(), noTools: "builtin" });
  t.after(async () => { session.dispose(); await new Promise<void>(r => setImmediate(r)); rmSync(root, { recursive: true, force: true }); });
  const runner = session.extensionRunner;
  await session.bindExtensions({ uiContext: { ...runner.getUIContext(), select: async () => "仅允许本次" }, mode: "tui" });
  session.setActiveToolsByName(["read", "edit", "write", "delete", "move", "file_batch", "goal_complete", "run_tests"]);
  let calls = 0;
  async function call(name: string, args: any) {
    await runner.emit({ type: "turn_start" } as never); const id = `false-${++calls}`;
    manager.appendMessage({ role: "assistant", content: [{ type: "toolCall", id, name, arguments: args }], timestamp: 0 } as never);
    session.agent.state.messages = [...session.agent.state.messages, { role: "assistant", content: [{ type: "toolCall", id, name, arguments: args }], timestamp: 0 } as never];
    const result = await session.agent.dispatchHostTool({ type: "toolCall", id, name, arguments: args });
    session.agent.state.messages = [...session.agent.state.messages, result]; return result;
  }
  async function say(text: string) {
    session.agent.streamFunction = (() => {
      const message: any = { role: "assistant", api: "fixture", provider: "fixture", model: "fixture", timestamp: 0, stopReason: "stop", content: [{ type: "text", text }], usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
      const stream = createAssistantMessageEventStream(); stream.push({ type: "start", partial: message }); stream.push({ type: "done", reason: "stop", message }); return stream;
    }) as any;
    // Same task: no new interactive input boundary to reset obligations.
    await session.agent.continue(); await session.agent.waitForIdle();
    const last = session.agent.state.messages.at(-1) as any;
    return last.content.filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n");
  }
  return { cwd, manager, session, runner, call, say, goals: () => goals };
}
for (const kind of ["preflight", "partial", "unknown", "cancel", "delete", "move", "success", "dry-run"]) test(`R4 default Agent completion guard: ${kind}`, async t => {
  const f = await fixture(t); writeFileSync(join(f.cwd, "current"), "before");
  const append = f.manager.appendCustomEntry.bind(f.manager); let fired = false;
  t.mock.method(f.manager, "appendCustomEntry", function(type: string, data: any) {
    if (type === "file-mutation-progress-v2" && data.phase === "result" && !fired) {
      fired = true;
      if (kind === "partial") writeFileSync(join(f.cwd, "current"), "concurrent");
      if (kind === "unknown") throw new Error("injected durable result failure");
      if (kind === "cancel") f.session.agent.abort();
    }
    return append(type, data);
  });
  let result: any;
  if (kind === "delete" || kind === "move") result = await f.call(kind, { path: "missing", ...(kind === "move" ? { destination: "destination" } : {}) });
  else result = await f.call("file_batch", { ...(kind === "dry-run" ? { dryRun: true } : {}), operations: [
    { operation: "write", mode: "create", path: "first", content: "first" },
    kind === "preflight" ? { operation: "delete", path: "missing" } : { operation: "delete", path: "current" },
    { operation: "write", mode: "create", path: "last", content: "last" },
  ] });
  const blocked = kind !== "success" && kind !== "dry-run";
  assert.equal(result.isError, blocked, JSON.stringify(result));
  const complete = await f.say("已完成，全部通过。");
  const goal = await f.call("goal_complete", {});
  t.diagnostic(JSON.stringify({ kind, error: result.isError, completion: complete, goalError: goal.isError, goals: f.goals() }));
  assert.equal(complete.includes("尚未验证"), blocked); assert.equal(goal.isError === true, blocked);
  assert.equal(f.goals(), blocked ? 0 : 1);
});

test("R4 incomplete disclosure, unrelated success and same-target repair", async t => {
  const f = await fixture(t); writeFileSync(join(f.cwd, "current"), "before"); let fired = false;
  const append = f.manager.appendCustomEntry.bind(f.manager);
  t.mock.method(f.manager, "appendCustomEntry", function(type: string, data: any) { const r = append(type, data); if (!fired && data?.phase === "result") { fired = true; writeFileSync(join(f.cwd, "current"), "changed"); } return r; });
  assert.equal((await f.call("file_batch", { operations: [{ operation: "write", mode: "create", path: "first", content: "first" }, { operation: "delete", path: "current" }, { operation: "write", mode: "create", path: "last", content: "last" }] })).isError, true);
  const honest = "尚未完成，后续项目仍需要处理。"; assert.equal(await f.say(honest), honest);
  await f.call("write", { path: "unrelated", content: "ok" });
  assert.equal((await f.call("goal_complete", {})).isError, true);
  assert.equal((await f.call("file_batch", { operations: [{ operation: "delete", path: "current" }, { operation: "write", mode: "create", path: "last", content: "last" }] })).isError, false);
  assert.equal(await f.say("已完成。"), "已完成。"); assert.equal((await f.call("goal_complete", {})).isError, false);
});
test("R4 uncertain result needs authoritative same-scope verification after retry", async t => {
  const f = await fixture(t); const path = join(f.cwd, "target.txt"); let fail = true;
  const append = f.manager.appendCustomEntry.bind(f.manager);
  t.mock.method(f.manager, "appendCustomEntry", function(type: string, data: any) { if (fail && data?.phase === "result") { fail = false; throw new Error("lost result"); } return append(type, data); });
  assert.equal((await f.call("file_batch", { operations: [{ operation: "write", mode: "create", path, content: "one" }] })).isError, true);
  await f.call("read", { path }); assert.equal((await f.call("write", { path, content: "two" })).isError, false);
  assert.equal((await f.call("goal_complete", {})).isError, true);
  const other = join(f.cwd, "other.txt"); await f.call("write", { path: other, content: "ok" });
  assert.equal((await f.call("run_tests", { path: other, expected: "ok" })).isError, false); assert.equal((await f.call("goal_complete", {})).isError, true);
  assert.equal((await f.call("run_tests", { path, expected: "two" })).isError, false); assert.equal((await f.call("goal_complete", {})).isError, false);
});

let afterLink: (() => void) | undefined;
const originalLink = fs.link;
mock.method(fs, "link", async function(...args: Parameters<typeof fs.link>) { await originalLink(...args); afterLink?.(); });
syncBuiltinESMExports();
after(() => { afterLink = undefined; mock.restoreAll(); syncBuiltinESMExports(); });
for (const batch of [false, true]) test(`R4 actual partial move requires both scopes, batch=${batch}`, async t => {
  const f = await fixture(t), source = join(f.cwd, "@source"), destination = join(f.cwd, "@destination");
  writeFileSync(source, "before"); afterLink = () => f.session.agent.abort(); t.after(() => { afterLink = undefined; });
  const args = { path: "@source", destination: "@destination" };
  const result = await f.call(batch ? "file_batch" : "move", batch ? { operations: [{ operation: "move", ...args }] } : args);
  afterLink = undefined;
  const item = batch ? (result.details as any).items[0] : result.details as any;
  assert.equal(item.status, "partial", JSON.stringify(result));
  assert.equal(readFileSync(source, "utf8"), "before"); assert.equal(readFileSync(destination, "utf8"), "before");
  assert.equal((await f.say("已完成。" )).includes("尚未验证"), true);
  assert.equal((await f.call("goal_complete", {})).isError, true);
  await f.call("run_tests", { path: source, expected: "before" });
  assert.equal((await f.call("goal_complete", {})).isError, true);
  await f.call("run_tests", { path: destination, expected: "before" });
  assert.equal((await f.call("goal_complete", {})).isError, false);
});

for (const batch of [false, true]) for (const kind of ["partial", "preflight"]) test(`R4 repaired numeric arguments ${kind}, batch=${batch}`, async t => {
  const f = await fixture(t), source = join(f.cwd, "123"), destination = join(f.cwd, "456");
  if (kind === "partial") writeFileSync(source, "before");
  afterLink = () => f.session.agent.abort(); t.after(() => { afterLink = undefined; });
  const args = { path: 123, destination: 456 };
  const result = await f.call(batch ? "file_batch" : "move", batch ? { operations: [{ operation: "move", ...args }] } : args); afterLink = undefined;
  assert.equal(result.isError, true);
  if (kind === "partial") { assert.equal(readFileSync(source, "utf8"), "before"); assert.equal(readFileSync(destination, "utf8"), "before"); }
  assert.equal((await f.say("已完成。" )).includes("尚未验证"), true);
  assert.equal((await f.call("goal_complete", {})).isError, true);
});
