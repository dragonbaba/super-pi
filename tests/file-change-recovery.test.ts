import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, readFileSync, writeFileSync, mkdtempSync, mkdirSync, rmSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createJiti } from "jiti";
import { mutationFixture as fixture } from "./helpers/mutation-fixture.ts";
import { SessionManager } from "../packages/coding-agent/src/core/session-manager.ts";
import { visibleWidth } from "../packages/tui/src/index.ts";
const { collectChanges, remainingDraft, verifyChange } = await createJiti(import.meta.url).import<any>("../packages/extensions/mutation-guard-write/changes.ts");

function commandUI(f: any, item: string, action: string, editor = "") {
  let input = editor, view = "", notices: string[] = [];
  const runner = f.runner;
  runner.setUIContext({ ...runner.getUIContext(),
    select: async (title: string, choices: string[]) => title === "Session changes" ? choices.find(s => s.startsWith(item + " "))
      : title === "Keep current input or place draft" ? "Append draft" : action,
    getEditorText: () => input, setEditorText: (text: string) => { input = text; },
    notify: (text: string) => { notices.push(text); },
    custom: async (factory: any) => {
      const component = await factory({ terminal: { rows: 24 }, requestRender() {} }, {}, {}, () => {});
      try {
        view = component.render(100).join("\n"); component.handleInput("\u001b[B");
        for (const width of [1, 3, 9, 15]) for (const line of component.render(width)) assert.ok(visibleWidth(line) <= width);
      }
      finally { component.dispose?.(); }
    },
  }, "tui");
  return { input: () => input, view: () => view, notices: () => notices };
}

test("N1 changes verifies a paired postimage without replay/evidence and drafts only remaining items", async t => {
  const f = await fixture(t);
  writeFileSync(join(f.cwd, "stale"), "before");
  f.onRecord(data => { if (data.phase === "result" && data.itemId === "recover:0") writeFileSync(join(f.cwd, "stale"), "external"); });
  const result = await f.call("file_batch", { operations: [
    { operation: "write", mode: "create", path: "created", content: "committed" },
    { operation: "delete", path: "stale" },
    { operation: "write", mode: "create", path: "remaining", content: "desired" },
  ] }, "recover");
  assert.equal(result.isError, true);
  const records = collectChanges(f.session.getBranch(), f.cwd);
  assert.deepEqual(records.map((r: any) => r.status), ["succeeded", "failed_no_change", "not_started"]);
  const beforeCalls = f.session.getBranch().filter((e: any) => e.message?.role === "toolResult").length;
  const ui = commandUI(f, "recover:0", "Verify current state");
  await f.runner.getCommand("changes")!.handler("", f.runner.createContext() as never);
  assert.deepEqual(ui.notices(), []);
  const verification = f.session.getBranch().find((e: any) => e.customType === "file-change-verification-v1") as any;
  assert.equal(verification.data.postimageMatches, true);
  assert.equal(verification.data.sourceEntryId, records[0].entryId);
  assert.equal(f.session.getBranch().filter((e: any) => e.message?.role === "toolResult").length, beforeCalls);
  const draftUI = commandUI(f, "recover:1", "Draft remaining request", "unsent user text");
  await f.runner.getCommand("changes")!.handler("", f.runner.createContext() as never);
  assert.deepEqual(draftUI.notices(), []);
  assert.match(draftUI.input(), /^unsent user text/);
  assert.match(draftUI.input(), /remaining/); assert.match(draftUI.input(), /stale/);
  assert.doesNotMatch(draftUI.input(), /committed/);
  assert.equal(existsSync(join(f.cwd, "remaining")), false);
  assert.equal(readFileSync(join(f.cwd, "created"), "utf8"), "committed");
  const reopened = SessionManager.open(f.session.getSessionFile()!);
  assert.deepEqual(collectChanges(reopened.getBranch(), f.cwd).map((r: any) => r.status), records.map((r: any) => r.status));
  assert.equal(existsSync(join(f.cwd, "remaining")), false);
});

test("N1 unknown state must be observed first; observation does not authorize replay", async t => {
  const f = await fixture(t);
  f.onRecord(data => { if (data.phase === "result") throw new Error("receipt persistence failure"); });
  await f.call("file_batch", { operations: [
    { operation: "write", mode: "create", path: "first", content: "already written" },
    { operation: "write", mode: "create", path: "later", content: "remaining" },
  ] }, "uncertain");
  let ui = commandUI(f, "uncertain:1", "Draft remaining request");
  await f.runner.getCommand("changes")!.handler("", f.runner.createContext() as never);
  assert.match(ui.notices().join("\n"), /verify partial\/unknown/);
  assert.equal(ui.input(), "");
  ui = commandUI(f, "uncertain:0", "Verify current state");
  await f.runner.getCommand("changes")!.handler("", f.runner.createContext() as never);
  assert.deepEqual(ui.notices(), []);
  ui = commandUI(f, "uncertain:1", "Draft remaining request");
  await f.runner.getCommand("changes")!.handler("", f.runner.createContext() as never);
  assert.deepEqual(ui.notices(), []);
  assert.match(ui.input(), /later/); assert.doesNotMatch(ui.input(), /already written/);
  assert.equal(existsSync(join(f.cwd, "later")), false);
});

test("N1 missing/forged history cannot redirect verification to an arbitrary path", async t => {
  const f = await fixture(t);
  const result = await f.call("file_batch", { operations: [{ operation: "write", mode: "create", path: "one", content: "one" }] }, "bound");
  const branch = structuredClone(f.session.getBranch()) as any[];
  const message = branch.find(e => e.message?.role === "toolResult" && e.message.toolCallId === "bound").message;
  message.details.items[0].target = join(f.cwd, "forged");
  const records = collectChanges(branch, f.cwd);
  const forged = records.find((r: any) => r.target.endsWith("forged"));
  if (forged) { assert.ok(forged.unavailable); await assert.rejects(() => verifyChange(forged, async () => { throw new Error("must not reach permission or disk"); }), /cannot authorize/); }
  const truncated = collectChanges(branch.filter(e => e.message?.role !== "assistant"), f.cwd);
  for (const record of truncated) assert.ok(record.unavailable);
  assert.equal(result.isError, false);
});

test("N1 preview is view-only and snapshot draft removes old evidence", async t => {
  const f = await fixture(t);
  await f.call("file_batch", { dryRun: true, operations: [{ operation: "write", mode: "create", path: "new", content: "visible" }] }, "preview");
  let ui = commandUI(f, "preview:0", "View");
  await f.runner.getCommand("changes")!.handler("", f.runner.createContext() as never);
  assert.match(ui.view(), /visible/);
  ui = commandUI(f, "preview:0", "Verify current state");
  await f.runner.getCommand("changes")!.handler("", f.runner.createContext() as never);
  assert.match(ui.notices().join("\n"), /not a mutation receipt/);
  assert.equal(existsSync(join(f.cwd, "new")), false);
  const draft = remainingDraft([{ entryId: "e", toolCallId: "old", itemId: "old:0", operation: "edit", status: "not_started", preview: false,
    original: { path: "a", snapshot: "OLD_SNAPSHOT", edits: [{ kind: "replace", start: "3#OLDHASH", newLines: ["desired"] }] } }], new Set());
  assert.doesNotMatch(draft, /OLD_SNAPSHOT|OLDHASH/); assert.match(draft, /originalLineHint/);
});

test("N1 actual command preserves editor changes made while choosing draft placement", async t => {
  const f = await fixture(t); writeFileSync(join(f.cwd, "stale"), "old");
  f.onRecord(data => { if (data.phase === "result" && data.itemId === "race:0") writeFileSync(join(f.cwd, "stale"), "new"); });
  await f.call("file_batch", { operations: [{ operation: "write", mode: "create", path: "done", content: "done" }, { operation: "delete", path: "stale" }] }, "race");
  let input = "original input"; const notices: string[] = [];
  f.runner.setUIContext({ ...f.runner.getUIContext(),
    select: async (title, options) => {
      if (title === "Session changes") return options.find(s => s.startsWith("race:1 "));
      if (title === "Keep current input or place draft") { input = "concurrent user input"; return "Replace editor"; }
      return "Draft remaining request";
    }, getEditorText: () => input, setEditorText: text => { input = text; }, notify: text => { notices.push(text); },
  }, "tui");
  await f.runner.getCommand("changes")!.handler("", f.runner.createContext() as never);
  assert.equal(input, "concurrent user input"); assert.match(notices.join("\n"), /Editor changed/);
  assert.equal(readFileSync(join(f.cwd, "stale"), "utf8"), "new");
});

test("N1 verification permission invalidates on Session policy changes and outside paths remain denied", async t => {
  const f = await fixture(t);
  await f.call("file_batch", { operations: [{ operation: "write", mode: "create", path: "file", content: "postimage" }] }, "permission");
  const { SessionPermissionController } = await createJiti(import.meta.url).import<any>("../packages/extensions/resource-lifecycle-guard/permission-controller.ts");
  const controller = new SessionPermissionController({ events: { emit() {} }, appendEntry() {} });
  const ctx = f.runner.createContext();
  await controller.restore(ctx);
  const record = collectChanges(f.session.getBranch(), f.cwd)[0];
  const assertAllowed = await controller.authorizeFileObservation(ctx, [record.target]);
  controller.state.setMode("read-only");
  await assert.rejects(() => verifyChange(record, assertAllowed), /obsolete/);
  await assert.rejects(() => controller.authorizeFileObservation(ctx, [join(f.cwd, "..", "outside")]), /outside/);
});

test("N1 bounded history drops missing/ambiguous originals and incomplete batches cannot draft", () => {
  const record = { entryId: "e", toolCallId: "batch", itemId: "batch:1", operation: "write", status: "not_started", preview: false,
    batchSize: 2, original: { path: "p", mode: "create", content: "wanted" } };
  assert.throws(() => remainingDraft([record], new Set()), /history is incomplete/);
  assert.deepEqual(collectChanges(Array.from({ length: 2000 }, (_, i) => ({ id: String(i), type: "custom", data: {} })), "/"), []);
});

test("N1 recovery requires an ordered call/intention/result and does not borrow future history", async t => {
  const f = await fixture(t); writeFileSync(join(f.cwd, "single"), "delete me");
  const single = realpathSync.native(join(f.cwd, "single"));
  await f.call("read", { path: single }, "ordered-read");
  await f.call("delete", { path: single }, "ordered-single");
  await f.call("file_batch", { operations: [{ operation: "write", mode: "create", path: "batch", content: "new" }] }, "ordered-batch");
  const branch = f.session.getBranch() as any[];
  assert.ok(collectChanges(branch, f.cwd).every((r: any) => !r.unavailable));
  const noIntents = branch.filter(e => e.customType !== "file-mutation-progress-v2");
  assert.ok(collectChanges(noIntents, f.cwd).every((r: any) => r.unavailable));
  const futureCalls = branch.filter(e => e.message?.role !== "assistant").concat(branch.filter(e => e.message?.role === "assistant"));
  assert.ok(collectChanges(futureCalls, f.cwd).every((r: any) => r.unavailable));
  const futurePreparation = branch.filter(e => e.customType !== "file-mutation-progress-v2").concat(branch.filter(e => e.customType === "file-mutation-progress-v2" && e.data.phase === "prepared"));
  const oldResults = collectChanges(futurePreparation, f.cwd).filter((r: any) => r.status === "succeeded");
  // Later progress may supersede the result, but cannot retroactively bind that earlier result.
  for (const record of oldResults) {
    const entry = branch.find(e => e.id === record.entryId);
    if (entry.type === "message") assert.ok(record.unavailable);
  }
});

test("N1 relative legacy receipts never retarget a different Session cwd", async t => {
  const f = await fixture(t);
  await f.call("write", { path: "original", content: "written" }, "legacy");
  const branch = structuredClone(f.session.getBranch()) as any[];
  const result = branch.find(e => e.message?.toolCallId === "legacy" && e.message.role === "toolResult");
  assert.equal(result.message.details.target, realpathSync.native(join(f.cwd, "original")));
  result.message.details.target = "original";
  const records = collectChanges(branch.filter(e => e.customType !== "file-mutation-progress-v2"), join(f.cwd, "other-workspace"));
  assert.equal(records.length, 1);
  assert.match(records[0].unavailable, /Originating cwd/);
  assert.equal(records[0].target, "original");
  await assert.rejects(verifyChange(records[0], async () => { assert.fail("must not access reinterpreted path"); }), /cannot authorize/);
});

test("N1 recovery never normalizes a malformed v2 item identifier into another item", async t => {
  const f = await fixture(t);
  await f.call("file_batch", { operations: [{ operation: "write", mode: "create", path: "id-file", content: "new" }] }, "item-id");
  const branch = structuredClone(f.session.getBranch()) as any[];
  const result = branch.find(e => e.customType === "file-mutation-progress-v2" && e.data.phase === "result" && e.data.toolCallId === "item-id");
  result.data.itemId = "item-id:00";
  const malformed = collectChanges(branch, f.cwd).find((record: any) => record.itemId === "item-id:00");
  assert.ok(malformed); assert.ok(malformed.unavailable); assert.equal(malformed.original, undefined);
  await assert.rejects(verifyChange(malformed, async () => { assert.fail("unbound receipt must not observe files"); }), /cannot authorize/);
});

test("N1 verification checks captured authority synchronously after final filesystem reads", async t => {
  const f = await fixture(t);
  await f.call("file_batch", { operations: [{ operation: "write", mode: "create", path: "authority-file", content: "postimage" }] }, "final-authority");
  const record = collectChanges(f.session.getBranch(), f.cwd)[0];
  let checks = 0;
  const assertAllowed = Object.assign(async () => {}, { assertCurrent() { checks++; throw new Error("final authority obsolete"); } });
  await assert.rejects(verifyChange(record, assertAllowed), /final authority obsolete/);
  assert.equal(checks, 1);
});

test("N1 standalone exact and snapshot View retain their actual committed patches", async t => {
  const f = await fixture(t);
  for (const snapshot of [false, true]) {
    const path = snapshot ? "snapshot-view" : "exact-view", id = `${path}-call`;
    writeFileSync(join(f.cwd, path), "one\ntwo\nthree\n");
    const read = await f.call("read", { path }, `${id}-read`);
    const body = read.content.filter(b => b.type === "text").map(b => b.text).join("\n");
    const key = body.slice(body.indexOf("snapshot=") + 9, body.indexOf("snapshot=") + 36), anchor = body.split("\n").find(line => line.startsWith("2#"))?.split("|")[0];
    const args = snapshot ? { path, snapshot: key, edits: [{ kind: "replace", start: anchor, newLines: ["VISIBLE_PATCH"] }] }
      : { path, edits: [{ oldText: "two", newText: "VISIBLE_PATCH" }] };
    const result = await f.call("edit", args, id); assert.equal(result.isError, false, JSON.stringify(result));
    const ui = commandUI(f, `${id}:0`, "View");
    await f.runner.getCommand("changes")!.handler("", f.runner.createContext() as never);
    assert.deepEqual(ui.notices(), []); assert.match(ui.view(), /VISIBLE_PATCH/);
  }
});

test("N1 metadata-only verification rejects replacement during the final permission await", async t => {
  const f = await fixture(t); const source = join(f.cwd, "source"), destination = join(f.cwd, "destination");
  writeFileSync(source, "content");
  await f.call("read", { path: realpathSync.native(source) }, "metadata-read");
  await f.call("move", { path: realpathSync.native(source), destination: join(realpathSync.native(f.cwd), "destination") }, "metadata");
  const record = collectChanges(f.session.getBranch(), f.cwd)[0];
  let assertions = 0;
  await assert.rejects(verifyChange(record, async () => {
    if (++assertions === 4) writeFileSync(destination, "external replacement content");
  }), /Object changed/);
  assert.equal(assertions, 4);
});

test("N1 actual default SDK Session: view/verify/draft do not trigger provider calls or replay on reopen", { timeout: 60000 }, async t => {
  const { createAgentSession } = await import("../packages/coding-agent/src/core/sdk.ts");
  const { DefaultResourceLoader } = await import("../packages/coding-agent/src/core/resource-loader.ts");
  const { SettingsManager } = await import("../packages/coding-agent/src/core/settings-manager.ts");
  const { ALPHA_MODEL, alphaModelRuntime } = await import("./helpers/alpha-session.ts");
  const { createAssistantMessageEventStream } = await import("../packages/ai/src/utils/event-stream.ts");
  const root = mkdtempSync(join(tmpdir(), "sp-n1-sdk-")), cwd = join(root, "work"), agentDir = join(root, "agent");
  mkdirSync(cwd); mkdirSync(agentDir);
  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
  const resourceLoader = new DefaultResourceLoader({ cwd, agentDir, settingsManager, noContextFiles: true, noSkills: true, noThemes: true, noPromptTemplates: true,
    additionalExtensionPaths: [resolve("packages/extensions"), resolve("packages/tool-classification/src/index.ts")] });
  await resourceLoader.reload();
  const manager = SessionManager.create(cwd, join(root, "sessions"));
  let pendingCall: any;
  let providerCalls = 0;
  const runtime = alphaModelRuntime(() => {
    providerCalls++;
    const call = pendingCall; pendingCall = undefined;
    const message: any = { role: "assistant", api: ALPHA_MODEL.api, provider: ALPHA_MODEL.provider, model: ALPHA_MODEL.id, timestamp: 0,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: call ? "toolUse" : "stop", content: call ? [call] : [] };
    const stream = createAssistantMessageEventStream(); stream.push({ type: "start", partial: message }); stream.push({ type: "done", reason: message.stopReason, message }); return stream;
  });
  const options = { cwd, agentDir, settingsManager, resourceLoader, sessionManager: manager, model: ALPHA_MODEL, modelRuntime: runtime, noTools: "builtin" as const };
  let { session } = await createAgentSession(options);
  t.after(async () => { session.dispose(); await new Promise<void>(resolve => setImmediate(resolve)); assert.equal(dirname(resolve(root)), resolve(tmpdir())); rmSync(root, { recursive: true, force: true }); });
  let action = "View", selectedItem = "sdk-preview:0", input = ""; const notices: string[] = [];
  const ui = { ...session.extensionRunner.getUIContext(),
    select: async (title: string, choices: string[]) => title === "Session changes" ? choices.find(s => s.startsWith(selectedItem + " "))
      : title === selectedItem ? action : "仅允许本次",
    getEditorText: () => input, setEditorText: (text: string) => { input = text; }, notify: (text: string) => { notices.push(text); },
    custom: async <T>(factory: any): Promise<T> => { const component = await factory({ terminal: { rows: 24 }, requestRender() {} }, {}, {}, () => {}); try { component.render(17); component.render(80); } finally { component.dispose?.(); } return undefined as T; },
  };
  await session.bindExtensions({ mode: "tui", uiContext: ui });
  session.setActiveToolsByName(["file_batch", "read"]);
  async function call(id: string, args: any) {
    pendingCall = { type: "toolCall", id, name: "file_batch", arguments: args };
    await session.prompt("Run this synthetic file change fixture.");
    await session.agent.waitForIdle();
    return session.messages.find((m: any) => m.role === "toolResult" && m.toolCallId === id) as any;
  }
  const preview = await call("sdk-preview", { dryRun: true, operations: [{ operation: "write", mode: "create", path: "parents/new", content: "preview" }] });
  assert.equal(preview.isError, false, JSON.stringify(preview));
  assert.equal(existsSync(join(cwd, "parents")), false);
  await session.extensionRunner.getCommand("changes")!.handler("", session.extensionRunner.createContext() as never);
  writeFileSync(join(cwd, "stale"), "old");
  const append = manager.appendCustomEntry.bind(manager);
  t.mock.method(manager, "appendCustomEntry", (kind: string, data: any) => {
    const entry = append(kind, data);
    if (kind === "file-mutation-progress-v2" && data.phase === "result" && data.itemId === "sdk-batch:0") writeFileSync(join(cwd, "stale"), "external");
    return entry;
  });
  const result = await call("sdk-batch", { operations: [{ operation: "write", mode: "create", path: "committed", content: "postimage" }, { operation: "delete", path: "stale" }, { operation: "write", mode: "create", path: "remaining", content: "desired" }] });
  assert.equal(result.isError, true);
  const callsBeforeCommands = providerCalls;
  selectedItem = "sdk-batch:0"; action = "Verify current state";
  await session.extensionRunner.getCommand("changes")!.handler("", session.extensionRunner.createContext() as never);
  assert.deepEqual(notices, [], JSON.stringify({ notices, branch: manager.getBranch().map((e: any) => ({ id: e.id, type: e.type, customType: e.customType, phase: e.data?.phase, role: e.message?.role, calls: e.message?.role === "assistant" ? e.message.content : undefined, resultId: e.message?.toolCallId })) }));
  assert.ok(manager.getBranch().some((e: any) => e.customType === "file-change-verification-v1" && e.data.postimageMatches === true), JSON.stringify(collectChanges(manager.getBranch(), cwd)));
  action = "Draft remaining request";
  await session.extensionRunner.getCommand("changes")!.handler("", session.extensionRunner.createContext() as never);
  assert.match(input, /remaining/); assert.equal(existsSync(join(cwd, "remaining")), false);
  assert.deepEqual(notices, []);
  assert.equal(session.agent.state.pendingToolCalls.size, 0); assert.equal((session.extensionRunner as any).finalAuthorizations.size, 0);
  const file = manager.getSessionFile()!;
  session.dispose();
  ({ session } = await createAgentSession({ ...options, sessionManager: SessionManager.open(file) }));
  await session.bindExtensions({ mode: "tui", uiContext: ui });
  action = "View";
  await session.extensionRunner.getCommand("changes")!.handler("", session.extensionRunner.createContext() as never);
  assert.deepEqual(notices, []);
  assert.equal(existsSync(join(cwd, "remaining")), false);
  assert.equal(readFileSync(join(cwd, "committed"), "utf8"), "postimage");
  assert.equal(providerCalls, callsBeforeCommands);
});
