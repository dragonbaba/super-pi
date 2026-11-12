import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, parse } from "node:path";
import { setImmediate as tick } from "node:timers/promises";
import { stripVTControlCharacters } from "node:util";
import { createOwnedTaskFixture } from "./helpers/owned-task-fixture.ts";
import { alphaSession } from "./helpers/alpha-session.ts";
import { createExtensionRuntime } from "../packages/coding-agent/src/core/extensions/loader.ts";
import { SessionExecutionPolicy, type ExecutionPermissions } from "../packages/coding-agent/src/core/execution-policy.ts";
import { SessionManager } from "../packages/coding-agent/src/core/session-manager.ts";
import { SessionFiles } from "../packages/coding-agent/src/core/files/session-files.ts";
import { createEventBus } from "../packages/coding-agent/src/core/event-bus.ts";
import { disposeNativeFileWorker } from "../packages/coding-agent/src/core/files/native-file-client.ts";
import { createReadToolDefinition } from "../packages/coding-agent/src/core/tools/read.ts";

const owned = createOwnedTaskFixture("host-file-permissions-"), oldTemps = [process.env.TMP, process.env.TEMP, process.env.TMPDIR];
process.env.TMP = owned.root; process.env.TEMP = owned.root; process.env.TMPDIR = owned.root;
assert.equal(await fs.realpath(tmpdir()), await fs.realpath(owned.root));
test.after(() => {
  for (const [index, key] of ["TMP", "TEMP", "TMPDIR"].entries()) {
    if (oldTemps[index] === undefined) delete process.env[key]; else process.env[key] = oldTemps[index];
  }
  owned.cleanup();
});

async function fixture(t: test.TestContext, config: ExecutionPermissions = {}) {
  const root = await fs.realpath(await fs.mkdtemp(join(owned.root, "case-"))), workspace = join(root, "workspace"), outside = join(root, "outside"), added = join(root, "added");
  for (const path of [workspace, outside, added]) await fs.mkdir(path);
  const runtime = createExtensionRuntime(), manager = SessionManager.inMemory(workspace);
  runtime.appendEntry = (type, data) => { manager.appendCustomEntry(type, data); };
  runtime.appendFileEntry = (type, data) => manager.appendCustomEntry(type, data);
  const owner = runtime.nativePermissions = new SessionExecutionPolicy(runtime, "trusted-host", config, "host-write", [added]);
  const files = runtime.nativeFiles = new SessionFiles(runtime, createEventBus()); files.setCompatibilityBoundary(owner);
  const definitions: Record<string, any> = { read: createReadToolDefinition(workspace) }; files.install(definitions);
  const dialogs: string[] = [], notices: string[] = [];
  const ctx: any = { cwd: workspace, hasUI: true, sessionManager: manager, signal: runtime.executionBoundary.signal,
    ui: { select: async (_title: string, choices: string[], opts: any) => { dialogs.push(opts.details); return choices[0]; },
      notify: (message: string) => { notices.push(message); } } };
  let sequence = 0;
  function event(toolName: string, input: object): any { return { type: "tool_call", toolCallId: String(++sequence), toolName, input }; }
  async function call(toolName: string, input: object, afterAuthorize?: () => Promise<void>) {
    const request = event(toolName, input);
    manager.appendMessage({ role: "assistant", content: [{ type: "toolCall", id: request.toolCallId, name: toolName, arguments: input }], timestamp: 0 } as any);
    let invocation: Awaited<ReturnType<SessionFiles["prepareInvocation"]>>;
    try {
      const grant = await owner.authorize(request, ctx, definitions[toolName], false, async () => {
        invocation = await files.prepareInvocation(request, ctx); return invocation?.describePreflight;
      });
      try {
      await afterAuthorize?.();
        grant.consume(input, request.toolCallId, toolName);
        const approved = invocation!.consume(input, request.toolCallId, toolName);
        return await definitions[toolName].execute(request.toolCallId, approved, ctx.signal, undefined, ctx);
      } finally { grant.release(); }
    } finally { invocation?.release(); }
  }
  async function read(path: string) {
    const input = { path }, request = event("read", input), grant = await owner.authorize(request, ctx, definitions.read);
    try { return await definitions.read.execute(request.toolCallId, input, ctx.signal, undefined, ctx); } finally { grant.release(); }
  }
  t.after(async () => { owner.dispose(); await runtime.executionBoundary.dispose(); await files.dispose(); await disposeNativeFileWorker(); });
  return { root, workspace, outside, added, owner, files, manager, ctx, call, read, event, dialogs, notices,
    async resume() { assert.equal(runtime.executionBoundary.requiresUserInput, true); await runtime.executionBoundary.resumeForUser(); ctx.signal = runtime.executionBoundary.signal; } };
}

test("native delete/move and mixed batches ask once outside; primary and added workspaces stay allowed", async t => {
  const f = await fixture(t, { rules: [{ tool: "*", decision: "allow" }] });
  for (const dir of [f.workspace, f.added, f.outside]) await fs.writeFile(join(dir, "delete.txt"), "owned");
  for (const dir of [f.workspace, f.added]) assert.equal((await f.call("delete", { path: join(dir, "delete.txt") })).isError, false);
  assert.equal(f.dialogs.length, 0);
  assert.equal((await f.call("delete", { path: join(f.outside, "delete.txt") })).isError, false);
  assert.equal(f.dialogs.length, 1); assert.match(f.dialogs[0], /工作区外/);
  await fs.writeFile(join(f.outside, "source.txt"), "move me");
  assert.equal((await f.call("move", { path: join(f.outside, "source.txt"), destination: join(f.workspace, "moved.txt") })).isError, false);
  assert.equal(await fs.readFile(join(f.workspace, "moved.txt"), "utf8"), "move me");
  assert.match(f.dialogs[1], /目标:.*moved.txt/);
  await fs.writeFile(join(f.outside, "batch.txt"), "batch");
  const input = { operations: [{ operation: "delete", path: join(f.workspace, "moved.txt") }, { operation: "delete", path: join(f.outside, "batch.txt") }] };
  const count = f.dialogs.length;
  assert.equal((await f.call("file_batch", input)).isError, false);
  assert.equal(f.dialogs.length, count + 1); assert.match(f.dialogs.at(-1)!, /工作区内/); assert.match(f.dialogs.at(-1)!, /工作区外/);
});

test("denied batches have no partial effects; missing UI/never require approval without persistent refusals", async t => {
  const f = await fixture(t);
  const local = join(f.workspace, "keep.txt"), external = join(f.outside, "keep.txt");
  for (const path of [local, external]) await fs.writeFile(path, "keep");
  const input = { operations: [{ operation: "delete", path: local }, { operation: "delete", path: external }] };
  let prompts = 0; f.ctx.ui.select = async (_title: string, choices: string[]) => { prompts++; return choices[1]; };
  await assert.rejects(f.call("file_batch", input), /User declined/);
  await assert.rejects(f.call("file_batch", input), /Explicitly denied/);
  assert.equal(prompts, 1); assert.equal(await fs.readFile(local, "utf8"), "keep"); assert.equal(await fs.readFile(external, "utf8"), "keep");
  for (const config of [{}, { approval: "never" }] as ExecutionPermissions[]) {
    const g = await fixture(t, config); g.ctx.hasUI = config.approval === "never";
    await assert.rejects(g.owner.authorize(g.event("delete", { path: external }), g.ctx), /APPROVAL_REQUIRED/);
    assert.deepEqual(g.owner.listRefusals(g.ctx), []); assert.equal(g.dialogs.length, 0);
  }
});

test("critical targets notify model and user, including redirected metadata; ordinary top-level business paths ask", async t => {
  const f = await fixture(t, { rules: [{ tool: "*", decision: "allow" }] });
  const metadata = join(f.outside, "metadata"); await fs.mkdir(metadata); await fs.writeFile(join(metadata, "config"), "protected");
  const link = join(f.workspace, ".git"); await fs.symlink(metadata, link, process.platform === "win32" ? "junction" : "dir");
  try {
    const critical = [parse(f.root).root, homedir(), f.workspace, f.added, join(link, "config"), join(metadata, "config"), join(f.workspace, ".sp", "new.txt")];
    if (process.platform === "win32") critical.push(process.env.SystemRoot!); else critical.push("/usr");
    for (const target of critical) {
      await assert.rejects(f.owner.authorize(f.event("delete", { path: target }), f.ctx), error => {
        assert.match(String(error), /禁止/); assert.match(String(error), /操作未执行/); assert.match(String(error), /明确告知用户/); return true;
      });
    }
    assert.equal(f.notices.length, critical.length); assert.equal(f.dialogs.length, 0);
    assert.equal(await fs.readFile(join(metadata, "config"), "utf8"), "protected");
    assert.deepEqual(f.owner.listRefusals(f.ctx), []);
    // Policy-only nonexistent target: no filesystem mutation at a real drive root.
    f.ctx.hasUI = false;
    await assert.rejects(f.owner.authorize(f.event("delete", { path: join(parse(f.root).root, "sp-business-policy-fixture") }), f.ctx), /APPROVAL_REQUIRED/);
  } finally { await fs.unlink(link); }
});

test("external existing write/edit/LSP and mixed batches are blocked; previews and new files remain possible", async t => {
  const f = await fixture(t), target = join(f.outside, "existing.txt"); await fs.writeFile(target, "unchanged");
  for (const tool of ["write", "edit", "lsp_fix"]) {
    await assert.rejects(f.owner.authorize(f.event(tool, { path: target, content: "forbidden", edits: [], write: true }), f.ctx), /EXTERNAL_FILE_WRITE_BLOCKED/);
    await f.resume();
  }
  const input = { operations: [{ operation: "write", path: "new.txt", mode: "create", content: "new" },
    { operation: "write", path: target, mode: "overwrite", content: "forbidden" }] };
  await assert.rejects(f.call("file_batch", input), /EXTERNAL_FILE_WRITE_BLOCKED/);
  await assert.rejects(fs.stat(join(f.workspace, "new.txt")), { code: "ENOENT" });
  await f.resume();
  assert.equal(await fs.readFile(target, "utf8"), "unchanged"); assert.deepEqual(f.owner.listRefusals(f.ctx), []); assert.equal(f.dialogs.length, 0);
  (await f.owner.authorize(f.event("file_batch", { ...input, dryRun: true }), f.ctx)).release();
  assert.equal((await f.call("write", { path: join(f.outside, "created.txt"), content: "new" })).isError, false);
  assert.equal(f.dialogs.length, 0);
});

test("new external file authority cannot become overwrite if a file appears before preparation", async t => {
  const f = await fixture(t), target = join(f.outside, "race.txt");
  const result = await f.call("write", { path: target, content: "unexpected overwrite" }, async () => { await fs.writeFile(target, "appeared"); await f.read(target); });
  assert.equal(result.isError, true); assert.match(result.details.reason, /TARGET_APPEARED|STALE_STATE/);
  assert.equal(await fs.readFile(target, "utf8"), "appeared");
});

test("a batch binds every approved canonical path across the dialog", async t => {
  const f = await fixture(t), inner = join(f.workspace, "original"), link = join(f.workspace, "alias");
  for (const base of [inner, f.outside]) {
    await fs.mkdir(join(base, "nested"), { recursive: true }); await fs.writeFile(join(base, "nested", "keep.txt"), "keep");
  }
  await fs.symlink(inner, link, process.platform === "win32" ? "junction" : "dir");
  const first = join(f.outside, "first.txt"); await fs.writeFile(first, "first");
  f.ctx.ui.select = async (_title: string, choices: string[]) => {
    await fs.unlink(link); await fs.symlink(f.outside, link, process.platform === "win32" ? "junction" : "dir"); return choices[0];
  };
  try {
    const result = await f.call("file_batch", { operations: [{ operation: "delete", path: first },
      { operation: "delete", path: join(link, "nested", "keep.txt") }] });
    assert.equal(result.isError, true); assert.match(result.details.reason, /STALE_STATE/); assert.equal(result.details.succeeded, 0);
    assert.equal(await fs.readFile(first, "utf8"), "first");
    assert.equal(await fs.readFile(join(f.outside, "nested", "keep.txt"), "utf8"), "keep");
  } finally { await fs.unlink(link); }
});

test("agent directory modifications ask even inside add-dir; deletes refuse, explicit deny still wins", async t => {
  const f = await fixture(t), agent = join(f.added, "agent"); await fs.mkdir(agent);
  const previous = process.env.SP_CODING_AGENT_DIR; process.env.SP_CODING_AGENT_DIR = agent;
  try {
    await fs.writeFile(join(agent, "config.json"), "{}");
    (await f.owner.authorize(f.event("write", { path: join(agent, "config.json"), content: "{}" }), f.ctx)).release();
    assert.equal(f.dialogs.length, 1); assert.match(f.dialogs[0], /agent 自身目录/);
    await assert.rejects(f.owner.authorize(f.event("delete", { path: join(agent, "config.json") }), f.ctx), /agent 自身目录/);
    assert.equal(f.notices.length, 1);
    const denied = await fixture(t, { rules: [{ tool: "write", decision: "deny" }] });
    await assert.rejects(denied.owner.authorize(denied.event("write", { path: join(agent, "config.json"), content: "{}" }), denied.ctx), /Explicitly denied/);
    assert.equal(denied.dialogs.length, 0);
  } finally { if (previous === undefined) delete process.env.SP_CODING_AGENT_DIR; else process.env.SP_CODING_AGENT_DIR = previous; }
});

test("production selector allows and refuses external deletes and renders sensitive notifications", { timeout: 10000 }, async t => {
  const f = await fixture(t), uiRoot = join(f.root, "ui"); await fs.mkdir(uiRoot);
  const ui = await alphaSession({ mode: "fullscreen", fixtureRoot: uiRoot });
  assert.equal(await ui.mode.init(), true); f.ctx.ui = ui.internal.createExtensionUIContext();
  let promptFrames = 0, noticeFrames = 0;
  ui.sink.physicalMarker = text => {
    const plain = stripVTControlCharacters(text);
    if (plain.includes("允许这次操作")) promptFrames++;
    // Long task-owned Windows paths can wrap the operation onto the next row.
    if (/禁止\s+delete/u.test(plain)) noticeFrames++;
  };
  try {
    for (const allow of [true, false]) {
      const target = join(f.outside, allow ? "allow.txt" : "deny.txt"); await fs.writeFile(target, "owned");
      const pending = f.call("delete", { path: target });
      const refused = allow ? undefined : assert.rejects(pending, /User declined/);
      // Filesystem resolution precedes the dialog. Yield until the production selector exists.
      for (let index = 0; index < 1000 && !ui.internal.extensionSelector; index++) await tick();
      const selector = ui.internal.extensionSelector; assert.ok(selector); const countdown = selector.countdown;
      ui.internal.ui.renderNow(true); await ui.internal.ui.flushTerminalFrames();
      selector.handleInput(allow ? "\x1b[A" : "\x1b[B"); selector.handleInput("\r");
      if (refused) { await refused; assert.equal(await fs.readFile(target, "utf8"), "owned"); }
      else { assert.equal((await pending).isError, false); await assert.rejects(fs.stat(target), { code: "ENOENT" }); }
      assert.equal(ui.internal.extensionSelector, undefined); assert.equal(countdown.intervalId, undefined);
    }
    await assert.rejects(f.owner.authorize(f.event("delete", { path: f.workspace }), f.ctx), /workspace_root/);
    ui.internal.ui.renderNow(true); await ui.internal.ui.flushTerminalFrames();
    assert.ok(promptFrames >= 2); assert.ok(noticeFrames > 0); assert.equal(f.owner.listRefusals(f.ctx).length, 1);
    t.diagnostic(JSON.stringify({ promptFrames, noticeFrames, allowed: 1, refused: 1, sensitive: 1, realCriticalEffects: 0 }));
  } finally { ui.sink.physicalMarker = undefined; await ui.release(); }
});
