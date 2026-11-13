import assert from "node:assert/strict";
import test, { after, mock } from "node:test";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, realpathSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Type } from "typebox";
import { createAgentSession } from "../packages/coding-agent/src/core/sdk.ts";
import { DefaultResourceLoader } from "../packages/coding-agent/src/core/resource-loader.ts";
import { SettingsManager } from "../packages/coding-agent/src/core/settings-manager.ts";
import { SessionManager } from "../packages/coding-agent/src/core/session-manager.ts";
import { ALPHA_MODEL, alphaModelRuntime } from "./helpers/alpha-session.ts";
import { createAssistantMessageEventStream } from "../packages/ai/src/utils/event-stream.ts";
import { isMutationEffectCommit } from "./helpers/file-mutation-progress.ts";
import { FILE_RESULT_ENTRY } from "../packages/coding-agent/src/core/files/file-result-protocol.ts";

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
  session.setActiveToolsByName(["read", "edit", "write", "copy", "delete", "move", "file_batch", "goal_complete", "run_tests"]);
  let calls = 0;
  async function call(name: string, args: any) {
    await runner.emit({ type: "turn_start" } as never); const id = `false-${++calls}`;
    manager.appendMessage({ role: "assistant", content: [{ type: "toolCall", id, name, arguments: args }], timestamp: 0 } as never);
    session.agent.state.messages = [...session.agent.state.messages, { role: "assistant", content: [{ type: "toolCall", id, name, arguments: args }], timestamp: 0 } as never];
    const result = await session.agent.dispatchHostTool({ type: "toolCall", id, name, arguments: args });
    session.agent.state.messages = [...session.agent.state.messages, result]; return result;
  }
  async function say(text: string, content = [{ type: "text", text }] as any[]) {
    const expected = structuredClone(content);
    session.agent.streamFunction = (() => {
      const message: any = { role: "assistant", api: "fixture", provider: "fixture", model: "fixture", timestamp: 0, stopReason: "stop", content, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
      const stream = createAssistantMessageEventStream(); stream.push({ type: "start", partial: message }); stream.push({ type: "done", reason: "stop", message }); return stream;
    }) as any;
    // Same task: no new interactive input boundary to reset obligations.
    let delivered: unknown;
    const stop = session.subscribe((event: any) => {
      if (event.type === "message_end" && event.message.role === "assistant") delivered = structuredClone(event.message.content);
    });
    try { await session.agent.continue(); await session.agent.waitForIdle(); } finally { stop(); }
    assert.deepEqual(delivered, expected);
    const last = session.agent.state.messages.at(-1) as any;
    assert.deepEqual(last.content, expected);
    const branch = manager.getBranch(); let persisted: any;
    for (let i = branch.length - 1; i >= 0; i--) {
      const entry = branch[i]!;
      if (entry.type === "message" && entry.message.role === "assistant") { persisted = entry; break; }
    }
    assert.ok(persisted);
    assert.deepEqual(persisted.message.content, expected);
    return last.content.filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n");
  }
  return { cwd, manager, session, runner, call, say, goals: () => goals };
}
test("a batch beyond the retired inline count repairs its preflight failure on retry", async t => {
  const f = await fixture(t), operations = [];
  for (let index = 0; index < 17; index++) {
    operations.push({ operation: "copy", path: "source-" + index, destination: "target-" + index });
    if (index < 16) writeFileSync(join(f.cwd, "source-" + index), String(index));
  }
  assert.equal((await f.call("file_batch", { operations })).isError, true); assert.equal((await f.call("goal_complete", {})).isError, true);
  writeFileSync(join(f.cwd, "source-16"), "16");
  assert.equal((await f.call("file_batch", { operations })).isError, false);
  assert.equal((await f.call("goal_complete", {})).isError, false, "No retired 16-item fallback may leave a cwd obligation");
});

for (const batch of [false, true]) test(`incomplete preparation keeps every requested destination pending, batch=${batch}`, async t => {
  const f = await fixture(t); writeFileSync(join(f.cwd, "first-source"), "one"); writeFileSync(join(f.cwd, "second-source"), "two");
  const append = f.manager.appendCustomEntry.bind(f.manager); let failed = false;
  t.mock.method(f.manager, "appendCustomEntry", function(type: string, data: any) {
    if (type === FILE_RESULT_ENTRY && !failed) {
      const payload = JSON.parse(data.payload);
      if (payload.phase === "prepared" && payload.index === 1) { failed = true; throw Object.assign(new Error("fixture ENOSPC"), { code: "ENOSPC" }); }
    }
    return append(type, data);
  });
  const items = [{ path: "first-source", destination: " first-copy" }, { path: "second-source", destination: " second-copy" }];
  const result = await f.call(batch ? "file_batch" : "copy", batch ? { operations: items.map(item => ({ operation: "copy", ...item })) } : { items });
  assert(failed); assert.equal(result.isError, true); assert.equal(typeof result.details.resultRef, "string");
  assert.equal(existsSync(join(f.cwd, " first-copy")), false); assert.equal(existsSync(join(f.cwd, " second-copy")), false);
  assert.equal((await f.call("goal_complete", {})).isError, true);
  assert.equal((await f.call("copy", items[0])).isError, false);
  assert.equal((await f.call("goal_complete", {})).isError, true, "Repairing the published preparation cannot erase the unprepared item");
  assert.equal((await f.call("copy", items[1])).isError, false);
  assert.equal((await f.call("goal_complete", {})).isError, false, "Both actual destinations now repair the known unstarted work");
});

for (const batch of [false, true]) test(`successful copy repairs its destination but preserves source failures, batch=${batch}`, async t => {
  const f = await fixture(t), source = join(f.cwd, "source"), destination = join(f.cwd, "copied");
  writeFileSync(source, "before"); writeFileSync(destination, "old");
  for (const path of ["source", "copied"]) assert.equal((await f.call("write", { path, mode: "overwrite", content: "not applied" })).isError, true);
  assert.equal((await f.call("goal_complete", {})).isError, true);
  const copy = (path: string, destination: string, overwrite = false) => batch
    ? f.call("file_batch", { operations: [{ operation: "copy", path, destination, overwrite }] })
    : f.call("copy", { path, destination, overwrite });
  assert.equal((await copy("source", "copied", true)).isError, false);
  assert.equal(readFileSync(source, "utf8"), "before"); assert.equal(readFileSync(destination, "utf8"), "before");
  assert.equal((await f.call("goal_complete", {})).isError, true, "Reading a source cannot repair its failed write");
  writeFileSync(join(f.cwd, "replacement"), "fixed");
  const repaired = await copy("replacement", "source", true); assert.equal(repaired.isError, false, JSON.stringify(repaired));
  assert.equal((await f.call("goal_complete", {})).isError, false, "The destination failure was repaired by copy");
  assert.equal((await copy("missing", "retry")).isError, true); assert.equal((await f.call("goal_complete", {})).isError, true);
  assert.equal((await copy("source", "retry")).isError, false); assert.equal((await f.call("goal_complete", {})).isError, false, "Copy retry repairs its own destination obligation");
});

test("native previews leave no mutation obligations and cannot clear a prior failure", async t => {
  const f = await fixture(t), source = join(f.cwd, "source"); writeFileSync(source, "unchanged");
  for (const [name, input] of [
    ["delete", { path: "source", dryRun: true }],
    ["delete", { paths: ["source"], dryRun: true }],
    ["move", { path: "source", destination: "target", dryRun: true }],
    ["move", { items: [{ path: "source", destination: "target" }], dryRun: true }],
  ] as const) {
    const result = await f.call(name, input);
    assert.equal(result.isError, false, JSON.stringify(result)); assert.equal(result.details.preview, true); assert.equal(result.details.resultRef, undefined);
    assert.equal(readFileSync(source, "utf8"), "unchanged"); assert.equal((await f.call("goal_complete", {})).isError, false);
  }
  assert.equal((await f.call("delete", { path: "missing", dryRun: true })).isError, true);
  assert.equal((await f.call("goal_complete", {})).isError, true);
  assert.equal((await f.call("delete", { path: "source", dryRun: true })).isError, false);
  assert.equal((await f.call("goal_complete", {})).isError, true, "A successful preview does not repair an unrelated failure");
});

test("array copy preflight failure blocks completion until the same destinations succeed", async t => {
  const f = await fixture(t); writeFileSync(join(f.cwd, "first-source"), "one");
  const input = { items: [{ path: "first-source", destination: " first-copy" }, { path: "later-source", destination: "later-copy" }] };
  assert.equal((await f.call("copy", input)).isError, true);
  assert.equal((await f.call("goal_complete", {})).isError, true, "A failed array copy cannot be reported complete");
  writeFileSync(join(f.cwd, "later-source"), "two");
  const result = await f.call("copy", input); assert.equal(result.isError, false, JSON.stringify(result));
  assert.equal(readFileSync(join(f.cwd, " first-copy"), "utf8"), "one"); assert.equal(readFileSync(join(f.cwd, "later-copy"), "utf8"), "two");
  assert.equal((await f.call("goal_complete", {})).isError, false, "Successful destinations repair the preflight failures");
});

for (const operation of ["delete", "move"] as const) test(`array ${operation} preflight failure is repaired by a successful retry`, async t => {
  const f = await fixture(t); writeFileSync(join(f.cwd, " first-source"), "one");
  const input = operation === "delete" ? { paths: [" first-source", "later-source"] }
    : { items: [{ path: " first-source", destination: "first-target" }, { path: "later-source", destination: " later-target" }] };
  assert.equal((await f.call(operation, input)).isError, true); assert.equal((await f.call("goal_complete", {})).isError, true);
  writeFileSync(join(f.cwd, "later-source"), "two");
  const result = await f.call(operation, input); assert.equal(result.isError, false, JSON.stringify(result));
  assert.equal((await f.call("goal_complete", {})).isError, false, "Successful item paths repair their own failure scopes");
});

for (const kind of ["preflight", "partial", "unknown", "cancel", "delete", "move", "success", "dry-run"]) test(`R4 default Agent preserves replies and structured goal checks: ${kind}`, async t => {
  const f = await fixture(t); writeFileSync(join(f.cwd, "current"), "before");
  const append = f.manager.appendCustomEntry.bind(f.manager); let fired = false;
  t.mock.method(f.manager, "appendCustomEntry", function(type: string, data: any) {
    if (isMutationEffectCommit(type, data) && !fired) {
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
  const blocks: any[] = kind === "preflight" ? [
    { type: "thinking", thinking: "fixture", thinkingSignature: "fixture-signature" },
    { type: "text", text: "已完成。Done, completed, fixed; all tests passed.\n" },
    { type: "text", text: "x".repeat(1_000_010) }, { type: "text", text: "\n原始尾部。" },
  ] : [{ type: "text", text: "已完成，全部通过。" }];
  const complete = await f.say("", blocks);
  assert.equal(complete, blocks.filter(block => block.type === "text").map(block => block.text).join("\n"));
  assert.equal(f.manager.getBranch().some((entry: any) => entry.customType === "false-success-intervention-v1"), false);
  const goal = await f.call("goal_complete", {});
  t.diagnostic(JSON.stringify({ kind, error: result.isError, preservedReplyChars: complete.length, goalError: goal.isError, goals: f.goals() }));
  assert.equal(goal.isError === true, blocked);
  const audits = f.manager.getBranch().filter((entry: any) => entry.customType === "false-success-intervention-v1") as any[];
  assert.equal(audits.length, blocked ? 1 : 0);
  if (blocked) assert.equal(audits[0].data.kind, "goal_completion_blocked");
  assert.equal(f.goals(), blocked ? 0 : 1);
});

test("R4 incomplete disclosure, unrelated success and same-target repair", async t => {
  const f = await fixture(t); writeFileSync(join(f.cwd, "current"), "before"); let fired = false;
  const append = f.manager.appendCustomEntry.bind(f.manager);
  t.mock.method(f.manager, "appendCustomEntry", function(type: string, data: any) { const r = append(type, data); if (!fired && isMutationEffectCommit(type, data)) { fired = true; writeFileSync(join(f.cwd, "current"), "changed"); } return r; });
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
  t.mock.method(f.manager, "appendCustomEntry", function(type: string, data: any) { if (fail && isMutationEffectCommit(type, data)) { fail = false; throw new Error("lost result"); } return append(type, data); });
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
  assert.equal(await f.say("已完成。"), "已完成。");
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
  assert.equal(await f.say("已完成。"), "已完成。");
  assert.equal((await f.call("goal_complete", {})).isError, true);
});

for (const args of [null, { operations: [{ operation: "invalid", path: "file" }] }]) test(`R4 invalid raw arguments still block goal completion: ${args === null ? "null" : "operation"}`, async t => {
  const f = await fixture(t);
  assert.equal((await f.call("file_batch", args)).isError, true);
  assert.equal(await f.say("已完成。"), "已完成。");
  assert.equal((await f.call("goal_complete", {})).isError, true);
});
