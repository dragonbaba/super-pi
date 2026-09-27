import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, readFileSync, writeFileSync, mkdtempSync, mkdirSync, rmSync, realpathSync, unlinkSync, symlinkSync, renameSync } from "node:fs";
import fsPromises, { open } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { protectWindowsFixture } from "./helpers/native-metadata-fixture.ts";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createJiti } from "jiti";
import { createHash } from "node:crypto";
import { mutationFixture as fixture, MutationWriteGuard } from "./helpers/mutation-fixture.ts";
import { SessionManager } from "../packages/coding-agent/src/core/session-manager.ts";
import { visibleWidth } from "../packages/tui/src/index.ts";
const { collectChanges, collectVerifiedChanges, remainingDraft, verifyChange } = await createJiti(import.meta.url).import<any>("../packages/extensions/mutation-guard-write/changes.ts");
const { restoreMutationEvidenceFromBranch } = await createJiti(import.meta.url).import<any>("../packages/extensions/mutation-guard-write/session-evidence.ts");

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

test("N1 recovery argument budget preserves newest real near-limit writes", async t => {
  const f = await fixture(t);
  for (let index = 0; index < 5; index++) {
    const result = await f.call("write", { path: `large-${index}`, content: String(index).repeat(1024 * 1024 - 1000) }, `large-${index}`);
    assert.equal(result.isError, false);
  }
  const records = collectChanges(f.session.getBranch(), f.cwd);
  assert.equal(records.length, 5); assert.ok(records[0].unavailable);
  for (const record of records.slice(1)) assert.equal(record.unavailable, undefined);
  assert.equal((await verifyChange(records[4], async () => {})).postimageMatches, true);
});

test("N1 oversized legacy receipt IDs refuse before map keys or recovery IDs", async t => {
  const f = await fixture(t); await f.call("write", { path: "legacy", content: "written" }, "legacy");
  const entry = JSON.parse(JSON.stringify(f.session.getBranch().find((e: any) => e.message?.role === "toolResult")));
  assert.equal(entry.message.details.mutationReceiptVersion, 1); entry.message.toolCallId = "x".repeat(2_000_000);
  const get = Map.prototype.get; let oversized = 0;
  t.mock.method(Map.prototype, "get", function(this: Map<unknown, unknown>, key: unknown) { if (typeof key === "string" && key.length > 512) oversized++; return get.call(this, key); });
  assert.deepEqual(collectChanges([entry], f.cwd), []); assert.equal(oversized, 0);
});

test("N1 older synthesized preparations cannot evict newer completed changes", async t => {
  const f = await fixture(t);
  for (let batch = 0; batch < 9; batch++) {
    const operations = Array.from({ length: 16 }, (_, index) => ({ operation: "write", mode: "create", path: `old-${batch}-${index}`, content: "old" }));
    assert.equal((await f.call("file_batch", { operations }, `old-${batch}`)).isError, false);
  }
  // Imported interruption snapshots retain actual request-bound preparation only.
  const branch = f.session.getBranch().filter((entry: any) => entry.message?.role === "assistant" || entry.data?.phase === "prepared");
  for (let index = 0; index < 5; index++) {
    const before = f.session.getBranch().length;
    assert.equal((await f.call("write", { path: `new-${index}`, content: "new" }, `new-${index}`)).isError, false);
    branch.push(...f.session.getBranch().slice(before));
  }
  const records = collectChanges(branch, f.cwd);
  assert.equal(records.length, 128);
  assert.deepEqual(records.slice(-5).map((record: any) => record.toolCallId), ["new-0", "new-1", "new-2", "new-3", "new-4"]);
  for (const record of records.slice(-5)) {
    assert.equal(record.status, "succeeded"); assert.equal(record.unavailable, undefined);
    assert.equal((await verifyChange(record, async () => {})).postimageMatches, true);
  }
});

test("N1 real observation authority checks stay bounded across 32 MiB hashing and 32 parents", async t => {
  const f = await fixture(t), parents: string[] = []; let target = realpathSync.native(f.cwd);
  for (let index = 0; index < 32; index++) { target = join(target, `p${index}`); mkdirSync(target); parents.push(target); }
  target = join(target, "file"); const content = Buffer.alloc(32 * 1024 * 1024, 65); writeFileSync(target, content);
  const { SessionPermissionController } = await createJiti(import.meta.url).import<any>("../packages/extensions/resource-lifecycle-guard/permission-controller.ts");
  const controller = new SessionPermissionController({ events: { emit() {} }, appendEntry() {} }), ctx = f.runner.createContext(); await controller.restore(ctx);
  let assessments = 0; const assess = controller.state.assessTarget;
  t.mock.method(controller.state, "assessTarget", function(this: any, ...args: any[]) { assessments++; return assess.apply(this, args); });
  const allowed = await controller.authorizeFileObservation(ctx, [target, ...parents]);
  let synchronousChecks = 0; const current = allowed.assertCurrent;
  t.mock.method(allowed, "assertCurrent", () => { synchronousChecks++; current(); });
  const record = { target, original: { path: target }, preview: false, postimage: createHash("sha256").update(content).digest("hex"), receipt: { createdDirectories: parents.map(path => ({ path, status: "retained" })) } };
  assert.equal((await verifyChange(record, allowed)).postimageMatches, true);
  assert.ok(assessments > 33 && assessments < 1300, `full path assessments=${assessments}`);
  assert.ok(synchronousChecks >= 513); t.diagnostic(JSON.stringify({ verificationBytes: content.length, parents: parents.length, fullPathAssessments: assessments, synchronousChecks }));
  controller.state.setMode("read-only"); await assert.rejects(verifyChange(record, allowed), /obsolete/);
});

for (const cancelled of [false, true]) test(`N1 failed execution-time dry run remains a view-only preview, cancelled=${cancelled}`, async t => {
  const f = await fixture(t), { BatchInvocation } = await createJiti(import.meta.url).import<any>("../packages/extensions/mutation-guard-write/file-batch.ts");
  const execute = BatchInvocation.prototype.execute; let injected = false;
  t.mock.method(BatchInvocation.prototype, "execute", function(this: any, pi: any, signal: AbortSignal) {
    injected = true;
    if (cancelled) { const controller = new AbortController(); controller.abort(); signal = controller.signal; }
    else writeFileSync(join(f.cwd, "first"), "external");
    return execute.call(this, pi, signal);
  });
  const result = await f.call("file_batch", { dryRun: true, operations: [{ operation: "write", mode: "create", path: "first", content: "planned" }, { operation: "write", mode: "create", path: "second", content: "planned" }] }, "failed-preview");
  assert.equal(injected, true); assert.equal(result.isError, true); assert.equal((result.details as any).preview, true); assert.match(JSON.stringify(result.content), /Preflight failed.*No changes/);
  assert.equal(existsSync(join(f.cwd, "second")), false); assert.equal(existsSync(join(f.cwd, "first")), !cancelled);
  assert.ok(!f.session.getBranch().some((e: any) => e.customType === "file-mutation-progress-v2"));
  const records = collectChanges(f.session.getBranch(), f.cwd); assert.equal(records.length, 2); assert.ok(records.every((r: any) => r.preview && !r.unavailable));
  await assert.rejects(verifyChange(records[0], async () => assert.fail("preview must not observe")), /cannot authorize/);
  assert.throws(() => remainingDraft(records, new Set()), /No confirmed/);
});

test("N1 partial directory creation without captured identity stays verifiable across exact mirrors", async t => {
  // Jiti captures builtin bindings on first mutation. Isolate this failure
  // injection so earlier tests cannot hide it behind an already-loaded binding.
  if (process.env.SP_N1_CAPTURE_FAILURE_CHILD !== "1") {
    const env: NodeJS.ProcessEnv = { ...process.env, SP_N1_CAPTURE_FAILURE_CHILD: "1" }; delete env.NODE_TEST_CONTEXT;
    const output = execFileSync(process.execPath, ["--experimental-strip-types", "--test", "--test-reporter=tap", "--test-name-pattern=partial directory creation without captured identity", fileURLToPath(import.meta.url)],
      { encoding: "utf8", timeout: 60000, windowsHide: true, env });
    assert.ok(output.includes("# pass 1") && output.includes("# fail 0"), output); return;
  }
  const f = await fixture(t), parent = join(f.cwd, "retained-parent"), path = join(parent, "file"), original = fsPromises.lstat;
  t.diagnostic(`captureFailureFixture=${f.cwd}`);
  let injected = false;
  t.mock.method(fsPromises, "lstat", async function(...args: any[]) {
    if (!injected && resolve(String(args[0])) === resolve(parent) && existsSync(parent)) { injected = true; throw new Error("fixture identity capture failure after mkdir"); }
    return Reflect.apply(original, fsPromises, args);
  }); syncBuiltinESMExports();
  const result = await f.call("write", { path, content: "planned" }, "retained-directory");
  t.mock.restoreAll(); syncBuiltinESMExports();
  assert.equal(injected, true); assert.equal(result.isError, true); assert.equal(existsSync(parent), true); assert.equal(existsSync(path), false);
  const genuine = JSON.parse(JSON.stringify(f.session.getBranch())), records = collectChanges(genuine, f.cwd);
  assert.equal(records.length, 1); assert.equal(records[0].status, "partial"); assert.equal(records[0].unavailable, undefined);
  const ui = commandUI(f, "retained-directory:0", "Verify current state");
  await f.runner.getCommand("changes")!.handler("", f.runner.createContext() as never);
  assert.ok(f.session.getBranch().some((entry: any) => entry.customType === "file-change-verification-v1"), JSON.stringify({ notices: ui.notices(), record: records[0] }));
  for (const both of [false, true]) {
    const branch = structuredClone(genuine);
    for (const entry of branch) {
      const directories = entry.data?.createdDirectories ?? entry.message?.details?.createdDirectories;
      if (directories && (both || entry.type === "custom")) directories[0].identity = {};
    }
    assert.ok(collectChanges(branch, f.cwd)[0].unavailable);
  }
});

test("N1 imported nested request counts and bytes refuse before hash traversal", async t => {
  const f = await fixture(t), path = join(f.cwd, "bounded-arguments"); writeFileSync(path, "before");
  await f.call("read", { path }, "bounded-read");
  await f.call("edit", { path, edits: [{ oldText: "before", newText: "after" }] }, "bounded-arguments");
  const genuine = JSON.parse(JSON.stringify(f.session.getBranch())), prototype = Object.getPrototypeOf(createHash("sha256")), update = prototype.update;
  let largeHashCalls = 0, elementReads = 0;
  t.mock.method(prototype, "update", function(this: unknown, value: unknown, ...args: unknown[]) {
    if (typeof value === "string" && value.length > 256 * 1024) largeHashCalls++;
    return Reflect.apply(update, this, [value, ...args]);
  });
  for (const fault of ["edits", "newLines", "oldText", "line", "path", "purpose"]) {
    const branch = structuredClone(genuine), call = branch.find((entry: any) => entry.message?.content?.some((part: any) => part.id === "bounded-arguments")).message.content.find((part: any) => part.id === "bounded-arguments");
    const array = new Proxy(new Array(1_000_000), { get(target, key, receiver) {
      if (typeof key === "string" && Number.isInteger(Number(key))) { elementReads++; assert.fail("oversized nested array must not be traversed"); }
      return Reflect.get(target, key, receiver);
    } });
    if (fault === "edits") call.arguments.edits = array;
    if (fault === "newLines") call.arguments.edits[0].newLines = array;
    if (fault === "oldText") call.arguments.edits[0].oldText = "x".repeat(2_000_000);
    if (fault === "line") call.arguments.edits[0].newLines = ["x".repeat(2_000_000)];
    if (fault === "path") call.arguments.path = "x".repeat(2_000_000);
    if (fault === "purpose") call.arguments.purpose = "x".repeat(2_000_000);
    const records = collectChanges(branch, f.cwd); assert.equal(records.length, 1); assert.ok(records[0].unavailable, fault);
  }
  assert.equal(elementReads, 0); assert.equal(largeHashCalls, 0); assert.equal(readFileSync(path, "utf8"), "after");
});

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
  const draft = remainingDraft([{ entryId: "e", toolCallId: "old", itemId: "old:0", operation: "edit", status: "not_started", preview: false, target: join(f.cwd, "a"),
    original: { path: "a", snapshot: "OLD_SNAPSHOT", edits: [{ kind: "replace", start: ">>> 3#6D08|old secret", end: ">>> 5#ABCD|end secret", newLines: ["desired"] }] } }], new Set());
  assert.doesNotMatch(draft, /OLD_SNAPSHOT|6D08|ABCD|old secret|end secret/);
  assert.match(draft, /"originalLineHint": 3/); assert.match(draft, /"originalEndLineHint": 5/); assert.doesNotMatch(draft, /null/);
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

test("N1 standalone v2 canonical intents survive cwd override without retargeting", async t => {
  const f = await fixture(t), directory = join(f.cwd, "real"); mkdirSync(directory);
  const written = await f.call("write", { path: "real/written", content: "kept" }, "canonical-write");
  assert.equal(written.isError, false, JSON.stringify(written));
  for (const operation of ["delete", "move"]) {
    const path = `real/${operation}`; writeFileSync(join(f.cwd, path), "source");
    await f.call("read", { path }, `read-${operation}`);
    const result = await f.call(operation, { path, ...(operation === "move" ? { destination: "real/moved" } : {}) }, `canonical-${operation}`);
    assert.equal(result.isError, false, JSON.stringify(result));
  }
  const reopened = SessionManager.open(f.session.getSessionFile()!, undefined, join(f.cwd, "other"));
  const records = collectChanges(reopened.getBranch(), join(f.cwd, "other"));
  assert.equal(records.length, 3);
  for (const record of records) {
    assert.equal(record.unavailable, undefined, JSON.stringify(record));
    assert.equal(dirname(record.target), realpathSync.native(directory));
    await verifyChange(record, async () => {});
  }
  const target = join(directory, "failed"); writeFileSync(target, "before");
  await f.call("read", { path: "real/failed" }, "read-failed");
  f.onRecord(data => { if (data.toolCallId === "canonical-failure" && data.phase === "intent") writeFileSync(target, "changed"); });
  assert.equal((await f.call("delete", { path: "real/failed" }, "canonical-failure")).isError, true);
  const failure = collectChanges(f.session.getBranch(), join(f.cwd, "other")).filter((record: any) => record.toolCallId === "canonical-failure");
  assert.equal(failure[0].status, "failed_no_change");
  assert.ok(remainingDraft(failure, new Set()).includes(JSON.stringify(realpathSync.native(target))));
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

test("N1 standalone create failure binds every original request field before drafting", async t => {
  const f = await fixture(t), path = join(f.cwd, "conflict");
  f.onRecord(data => { if (data.toolCallId === "create-bind" && data.phase === "intent") writeFileSync(path, "external"); });
  assert.equal((await f.call("write", { path: "conflict", content: "original" }, "create-bind")).isError, true);
  const genuine = structuredClone(f.session.getBranch()) as any[];
  const records = collectChanges(genuine, f.cwd); assert.equal(records[0].unavailable, undefined);
  assert.match(remainingDraft(records, new Set()), /original/);
  assert.match(remainingDraft(records, new Set()), /"mode": "create"/);
  for (const missingHash of [false, true]) {
    const branch = structuredClone(genuine), call = branch.find(entry => entry.message?.role === "assistant").message.content[0];
    if (missingHash) branch.find(entry => entry.data?.phase === "intent").data.requestHash = undefined;
    else call.arguments.content = "forged replacement instruction";
    const invalid = collectChanges(branch, f.cwd); assert.ok(invalid[0].unavailable);
    assert.throws(() => remainingDraft(invalid, new Set()), /missing|ambiguous/);
  }
  assert.equal(readFileSync(path, "utf8"), "external");
});

test("N1 duplicate history entry IDs cannot authenticate progress that precedes its call", async t => {
  const f = await fixture(t);
  await f.call("write", { path: "ordered", content: "real" }, "duplicate-history");
  const original = structuredClone(f.session.getBranch()) as any[], call = original.find(entry => entry.message?.role === "assistant");
  const intent = original.find(entry => entry.data?.phase === "intent"), result = original.find(entry => entry.message?.role === "toolResult");
  assert.ok(call && intent && result);
  const branch = Array.from({ length: 12 }, () => ({ id: "duplicate", type: "custom", customType: "unrelated", data: {} }));
  branch.push(intent, { id: "separator", type: "custom", customType: "unrelated", data: {} } as any, call, result);
  const records = collectChanges(branch, f.cwd); assert.equal(records.length, 1); assert.ok(records[0].unavailable);
  await assert.rejects(verifyChange(records[0], async () => { assert.fail("ambiguous history cannot authorize an observation"); }), /cannot authorize/);
});

test("N1 command verifies workspace identity again after a final absent-target observation", async t => {
  // Jiti caches builtin namespace snapshots after the first command. Isolate
  // this precise filesystem interception from other commands in the test file.
  if (process.env.SP_N1_WORKSPACE_OBSERVATION_FIXTURE !== "1") {
    execFileSync(process.execPath, ["--experimental-strip-types", "--test", "--test-name-pattern", "workspace identity again", fileURLToPath(import.meta.url)], {
      windowsHide: true, timeout: 30000, env: { ...process.env, SP_N1_WORKSPACE_OBSERVATION_FIXTURE: "1" }, stdio: "pipe",
    });
    return;
  }
  const f = await fixture(t), path = join(realpathSync.native(f.cwd), "removed"); writeFileSync(path, "original");
  await f.call("read", { path: "removed" }, "workspace-read");
  assert.equal((await f.call("delete", { path: "removed" }, "workspace-delete")).isError, false);
  const originalLstat = fsPromises.lstat, displaced = `${f.cwd}-observation-owned`;
  let absentReads = 0, replaced = false;
  t.mock.method(fsPromises, "lstat", async (...args: Parameters<typeof fsPromises.lstat>) => {
    try { return await Reflect.apply(originalLstat, fsPromises, args); }
    catch (error) {
      // capturePathIdentity fails at realpath first. The first absent lstat is
      // the dangling-link check; the second is verifyChange's final read.
      if (String(args[0]) === path && (error as NodeJS.ErrnoException).code === "ENOENT" && ++absentReads === 2) {
        renameSync(f.cwd, displaced); mkdirSync(f.cwd); replaced = true;
      }
      throw error;
    }
  });
  syncBuiltinESMExports();
  try {
    const ui = commandUI(f, "workspace-delete:0", "Verify current state");
    await f.runner.getCommand("changes")!.handler("", f.runner.createContext() as never);
    assert.equal(replaced, true, JSON.stringify({ absentReads, notices: ui.notices() })); assert.ok(ui.notices().length > 0);
    assert.equal(f.session.getBranch().some((entry: any) => entry.customType === "file-change-verification-v1"), false);
  } finally {
    t.mock.restoreAll(); syncBuiltinESMExports();
    if (replaced) { rmSync(f.cwd, { recursive: true }); renameSync(displaced, f.cwd); }
  }
});

test("N1 new standalone v1 exact/snapshot/overwrite origins bind canonical aliases across cwd reopen", async t => {
  const f = await fixture(t), real = join(f.cwd, "real"); mkdirSync(real);
  symlinkSync(real, join(f.cwd, "alias"), process.platform === "win32" ? "junction" : "dir");
  for (const kind of ["exact", "snapshot", "overwrite"]) {
    writeFileSync(join(real, kind), "one\ntwo\nthree\n");
    const path = `alias/${kind}`, read = await f.call("read", { path }, `origin-read-${kind}`);
    const body = read.content.filter(block => block.type === "text").map(block => block.text).join("\n");
    const snapshot = body.slice(body.indexOf("snapshot=") + 9, body.indexOf("snapshot=") + 36), anchor = body.split("\n").find(line => line.startsWith("2#"))!.split("|")[0];
    const args = kind === "overwrite" ? { path, content: "after" } : kind === "exact" ? { path, edits: [{ oldText: "two", newText: "TWO" }] } : { path, snapshot, edits: [{ kind: "replace", start: anchor, newLines: ["TWO"] }] };
    assert.equal((await f.call(kind === "overwrite" ? "write" : "edit", args, `origin-${kind}`)).isError, false);
  }
  const reopened = SessionManager.open(f.session.getSessionFile()!, undefined, join(f.cwd, "different"));
  const records = collectChanges(reopened.getBranch(), join(f.cwd, "different"));
  assert.equal(records.length, 3);
  for (const record of records) { assert.equal(record.unavailable, undefined, JSON.stringify(record)); assert.equal(dirname(record.target), realpathSync.native(real)); await verifyChange(record, async () => {}); }
  const branch = structuredClone(reopened.getBranch()) as any[], origin = branch.find(entry => entry.data?.phase === "origin");
  origin.data.requestHash = "0".repeat(64);
  assert.ok(collectChanges(branch, f.cwd).find((record: any) => record.toolCallId === origin.data.toolCallId).unavailable);
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

test("N1 standalone progress prefix refuses unexpected phases before the terminal", async t => {
  const f = await fixture(t), path = join(f.cwd, "prefix-conflict"); writeFileSync(path, "old");
  f.onRecord(data => { if (data.phase === "intent") writeFileSync(path, "external"); });
  await f.call("delete", { path }, "prefix-conflict");
  const genuine = JSON.parse(JSON.stringify(f.session.getBranch()));
  assert.equal(collectChanges(genuine, f.cwd)[0].unavailable, undefined);
  for (const phase of ["origin", "prepared", "future-phase", "intent"]) for (const beforeIntent of [false, true]) {
    const branch = structuredClone(genuine), extra = structuredClone(branch.find((entry: any) => entry.data?.phase === "intent"));
    extra.id = `extra-${phase}`; extra.data.phase = phase;
    const at = branch.findIndex((entry: any) => entry.data?.phase === (beforeIntent ? "intent" : "result"));
    assert.ok(at >= 0); branch.splice(at, 0, extra);
    const records = collectChanges(branch, f.cwd); assert.ok(records.length > 0);
    for (const record of records) assert.ok(record.unavailable, `${phase}:${beforeIntent}`);
    assert.throws(() => remainingDraft(records, new Set()), /missing|ambiguous/);
  }
  assert.equal(readFileSync(path, "utf8"), "external");
});

test("N1 later terminal outcomes cannot reuse a completed item's intent", async t => {
  const f = await fixture(t);
  await f.call("file_batch", { operations: [{ operation: "write", mode: "create", path: "done", content: "committed" }] }, "terminal");
  const branch = structuredClone(f.session.getBranch()) as any[];
  const result = branch.find(e => e.customType === "file-mutation-progress-v2" && e.data.phase === "result");
  branch.push({ ...result, id: "forged-later-terminal", data: { ...result.data, status: "failed_no_change", stateChanged: false } });
  const records = collectChanges(branch, f.cwd);
  assert.equal(records.length, 1); assert.ok(records[0].unavailable);
  assert.throws(() => remainingDraft(records, new Set()), /missing|ambiguous/);
  assert.equal(readFileSync(join(f.cwd, "done"), "utf8"), "committed");
});

test("N1 batch recovery requires unique ordered matching preparation and intent", async t => {
  const f = await fixture(t);
  await f.call("file_batch", { operations: [{ operation: "write", mode: "create", path: "bound-target", content: "real" }] }, "phases");
  const original = structuredClone(f.session.getBranch()) as any[];
  for (const fault of ["no-preparation", "no-intent", "duplicate-preparation", "duplicate-intent", "retarget-intent", "wrong-hash"] as const) {
    let branch = structuredClone(original);
    const prepared = branch.find(e => e.data?.phase === "prepared"), intent = branch.find(e => e.data?.phase === "intent");
    if (fault === "no-preparation") branch = branch.filter(e => e !== prepared);
    if (fault === "no-intent") branch = branch.filter(e => e !== intent);
    if (fault === "duplicate-preparation") branch.splice(branch.indexOf(prepared) + 1, 0, { ...prepared, id: "duplicate-preparation" });
    if (fault === "duplicate-intent") branch.splice(branch.indexOf(intent) + 1, 0, { ...intent, id: "duplicate-intent" });
    if (fault === "retarget-intent") intent.data.target = join(f.cwd, "forged");
    if (fault === "wrong-hash") intent.data.requestHash = "0".repeat(64);
    const records = collectChanges(branch, f.cwd);
    assert.equal(records.length, 1, fault); assert.ok(records[0].unavailable, fault);
    await assert.rejects(verifyChange(records[0], async () => { assert.fail("ambiguous binding must not touch disk"); }), /cannot authorize/);
    assert.throws(() => remainingDraft(records, new Set()), /missing|ambiguous/, fault);
  }
  assert.equal(readFileSync(join(f.cwd, "bound-target"), "utf8"), "real");
});

test("N1 unavailable success invalidates the whole remaining batch draft", async t => {
  const f = await fixture(t); f.onRecord(data => { if (data.phase === "result") throw new Error("interrupt"); });
  await f.call("file_batch", { operations: ["first", "later"].map(path => ({ operation: "write", mode: "create", path, content: path })) }, "ambiguous-success");
  const branch = structuredClone(f.session.getBranch()) as any[];
  const aggregate = branch.find(e => e.message?.role === "toolResult" && e.message.toolCallId === "ambiguous-success");
  aggregate.message.details.items[0].status = "succeeded"; aggregate.message.details.items[0].stateChanged = true;
  const noIntent = branch.filter(e => e.data?.phase !== "intent"), records = collectChanges(noIntent, f.cwd);
  assert.equal(records.length, 2); assert.equal(records[0].status, "succeeded"); assert.ok(records[0].unavailable);
  assert.throws(() => remainingDraft(records, new Set()), /missing|ambiguous/);
  assert.equal(existsSync(join(f.cwd, "later")), false);
});

test("N1 missing middle receipt with later activity cannot become unstarted", async t => {
  const f = await fixture(t);
  await f.call("file_batch", { operations: ["first", "middle", "last"].map(path => ({ operation: "write", mode: "create", path, content: path })) }, "missing-middle");
  const branch = (structuredClone(f.session.getBranch()) as any[]).filter(e => e.data?.itemId !== "missing-middle:1"
    && !(e.message?.role === "toolResult" && e.message.toolCallId === "missing-middle"));
  const records = collectChanges(branch, f.cwd);
  assert.equal(records.some((record: any) => record.itemId === "missing-middle:1"), false);
  assert.throws(() => remainingDraft(records, new Set()), /history is incomplete/);
  assert.equal(readFileSync(join(f.cwd, "middle"), "utf8"), "middle");
});

test("N1 negative item activity and aggregate-before-preparation never reconstruct unstarted work", async t => {
  const f = await fixture(t);
  await f.call("file_batch", { operations: [{ operation: "write", mode: "create", path: "executed", content: "actual" }] }, "ambiguous-order");
  const original = structuredClone(f.session.getBranch()) as any[];
  for (const fault of ["negative-index", "early-empty-aggregate", "early-malformed-aggregate"]) {
    const branch = original.filter(entry => entry.data?.phase === "prepared" || entry.message?.role === "assistant");
    const position = branch.findIndex(entry => entry.data?.phase === "prepared");
    if (fault === "negative-index") branch.push({ id: fault, type: "custom", customType: "file-mutation-progress-v2", data: { toolCallId: "ambiguous-order", itemId: "ambiguous-order:-1", phase: "invalid" } });
    else branch.splice(position, 0, { id: fault, type: "message", message: { role: "toolResult", toolName: "file_batch", toolCallId: "ambiguous-order", details: { items: fault === "early-empty-aggregate" ? [] : "invalid" } } });
    const records = collectChanges(branch, f.cwd);
    assert.equal(records.length, 0, fault); assert.throws(() => remainingDraft(records, new Set()), /No confirmed/);
  }
  assert.equal(readFileSync(join(f.cwd, "executed"), "utf8"), "actual");
});

test("N1 malformed progress never implies unstarted and late intent cannot authenticate an earlier terminal", async t => {
  const f = await fixture(t);
  await f.call("file_batch", { operations: [{ operation: "write", mode: "create", path: "ran", content: "real" }] }, "ordering");
  const original = structuredClone(f.session.getBranch()) as any[];
  for (const phase of ["intent", "result", "unknown"]) for (const itemId of [undefined, null, "ordering:01", "ordering:1", "ordering:-1"]) {
    const branch = original.filter(e => e.message?.role === "assistant" || e.data?.phase === "prepared");
    branch.push({ id: "malformed", type: "custom", customType: "file-mutation-progress-v2", data: { phase, toolCallId: "ordering", itemId } });
    assert.deepEqual(collectChanges(branch, f.cwd), [], `${phase}/${itemId}`);
  }
  const intent = original.find(e => e.data?.phase === "intent");
  const reordered = original.filter(e => e !== intent);
  reordered.splice(reordered.findIndex(e => e.message?.role === "toolResult"), 0, intent);
  const records = collectChanges(reordered, f.cwd);
  assert.equal(records.length, 1); assert.ok(records[0].unavailable);
  assert.throws(() => remainingDraft(records, new Set()), /missing|ambiguous/);
  assert.equal(readFileSync(join(f.cwd, "ran"), "utf8"), "real");
});

test("N1 verification history requires complete ordered bound observations, not just matching identifiers", async t => {
  const f = await fixture(t);
  f.onRecord(data => { if (data.phase === "result") throw new Error("interrupted receipt"); });
  await f.call("file_batch", { operations: ["uncertain", "later"].map(path => ({ operation: "write", mode: "create", path, content: path })) }, "observation");
  const branch = structuredClone(f.session.getBranch()) as any[], records = collectChanges(branch, f.cwd);
  const record = records.find((r: any) => r.status === "state_unknown");
  const data = { version: 1, sessionId: f.session.getSessionId(), sourceEntryId: record.entryId, itemId: record.itemId,
    toolCallId: record.toolCallId, observedAt: new Date().toISOString(), ...await verifyChange(record, async () => {}) };
  const entry = { id: "observed", type: "custom", customType: "file-change-verification-v1", data };
  assert.deepEqual([...collectVerifiedChanges([...branch, entry], records, data.sessionId)], [record.itemId]);
  for (const fault of ["before-source", "source-id", "session-id", "time", "no-source", "path", "identity", "parents", "hash", "negative-size", "match", "scope", "duplicate-source", "duplicate-observation"]) {
    const changed = structuredClone(entry), entries = [...branch];
    if (fault === "source-id") changed.data.sourceEntryId = "missing";
    if (fault === "session-id") changed.data.sessionId = "different";
    if (fault === "time") changed.data.observedAt = "invalid";
    if (fault === "no-source") delete changed.data.source;
    if (fault === "path") changed.data.source.path = join(f.cwd, "other");
    if (fault === "identity") delete changed.data.source.identity;
    if (fault === "parents") delete changed.data.parents;
    if (fault === "hash") changed.data.source.sha256 = "not-a-hash";
    if (fault === "negative-size") changed.data.source.identity.size = "-1";
    if (fault === "match") changed.data.postimageMatches = !data.postimageMatches;
    if (fault === "scope") delete changed.data.scope;
    if (fault === "duplicate-source") entries.push(branch.find(e => e.id === record.entryId));
    if (fault === "duplicate-observation") entries.push(changed);
    if (fault === "before-source") entries.unshift(changed); else entries.push(changed);
    assert.equal(collectVerifiedChanges(entries, records, data.sessionId).size, 0, fault);
  }
  // Actual command must not let a four-ID-only persisted entry unlock a draft.
  f.session.appendCustomEntry("file-change-verification-v1", { version: 1, sessionId: data.sessionId, sourceEntryId: record.entryId, itemId: record.itemId, toolCallId: record.toolCallId });
  const ui = commandUI(f, "observation:1", "Draft remaining request");
  await f.runner.getCommand("changes")!.handler("", f.runner.createContext() as never);
  assert.equal(ui.input(), ""); assert.match(ui.notices().join("\n"), /verify partial\/unknown/);
});

test("N1 draft bounds include the source identifier, header and separators", () => {
  const record = { entryId: "e", toolCallId: 'quoted"id', itemId: "draft:0", operation: "write", status: "not_started", preview: false,
    target: resolve("draft"), original: { mode: "create", content: "desired" } };
  assert.ok(remainingDraft([record], new Set()).includes(JSON.stringify(record.toolCallId)));
  for (const toolCallId of ["a".repeat(257), "id\nnew instruction", "id\u202e", "id\u001b"]) {
    assert.throws(() => remainingDraft([{ ...record, toolCallId }], new Set()), /identifier|control/);
  }
  const records = Array.from({ length: 6 }, (_, i) => ({ ...record, itemId: `draft:${i}`, original: { mode: "create", content: "x".repeat(8100) } }));
  assert.throws(() => remainingDraft(records, new Set()), /draft bound/);
});

test("N1 interrupted preparation retains unstarted items and drafts original absolute targets across cwd changes", async t => {
  const f = await fixture(t);
  f.onRecord(data => { if (data.phase === "result") throw new Error("fixture interruption after first mutation"); });
  await f.call("file_batch", { operations: ["first", "second", "third"].map(path => ({ operation: "write", mode: "create", path, content: path })) }, "interrupted");
  const branch = (f.session.getBranch() as any[]).filter(e => !(e.message?.role === "toolResult" && e.message.toolCallId === "interrupted"));
  const records = collectChanges(branch, join(f.cwd, "other-cwd"));
  assert.deepEqual(records.map((record: any) => record.status).sort(), ["not_started", "not_started", "state_unknown"]);
  const uncertain = records.find((record: any) => record.status === "state_unknown");
  await verifyChange(uncertain, async () => {});
  const draft = remainingDraft(records, new Set([uncertain.itemId]));
  const original = realpathSync.native(f.cwd);
  assert.ok(draft.includes(JSON.stringify(join(original, "second"))));
  assert.ok(draft.includes(JSON.stringify(join(original, "third"))));
  assert.doesNotMatch(draft, /other-cwd/);
  assert.equal(existsSync(join(f.cwd, "second")), false); assert.equal(existsSync(join(f.cwd, "third")), false);
});

test("N1 standalone failure View retains the cause", async t => {
  const f = await fixture(t), target = join(realpathSync.native(f.cwd), "failure-view"); writeFileSync(target, "before");
  await f.call("read", { path: target }, "failure-read");
  f.onRecord(data => { if (data.phase === "intent") writeFileSync(target, "external change"); });
  const result = await f.call("delete", { path: target }, "failed-delete");
  assert.equal(result.isError, true);
  const ui = commandUI(f, "failed-delete:0", "View");
  await f.runner.getCommand("changes")!.handler("", f.runner.createContext() as never);
  assert.deepEqual(ui.notices(), []); assert.match(ui.view(), /changed|stale/i);
});

test("N1 partial creation verifies recorded parents even when its target is absent", async t => {
  const f = await fixture(t), target = join(realpathSync.native(f.cwd), "parent/child/file");
  const probe = await open(join(f.cwd, "probe"), "w"), prototype = Object.getPrototypeOf(probe); await probe.close();
  const original = prototype.writeFile; let injected = false;
  t.mock.method(prototype, "writeFile", async function(this: any, value: any, ...args: any[]) {
    if (value === "partial-create-fixture") { injected = true; throw new Error("fixture ENOSPC after parent creation"); }
    return original.call(this, value, ...args);
  });
  const result = await f.call("write", { path: target, content: "partial-create-fixture" }, "parent-effects");
  assert.equal(injected, true); assert.equal(result.isError, true); assert.equal((result.details as any).status, "partial");
  unlinkSync(target);
  const ui = commandUI(f, "parent-effects:0", "Verify current state");
  await f.runner.getCommand("changes")!.handler("", f.runner.createContext() as never);
  assert.deepEqual(ui.notices(), []);
  const observation = (f.session.getBranch() as any[]).find(e => e.customType === "file-change-verification-v1").data;
  assert.equal(observation.source.exists, false); assert.equal(observation.parents.length, 2);
  for (const parent of observation.parents) { assert.equal(parent.exists, true); assert.equal(parent.identity.directory, true); }
});

test("N1 successful creation retains its hash and parents when terminal persistence fails", async t => {
  const f = await fixture(t), target = join(f.cwd, "kept/parents/created");
  f.onRecord(data => { if (data.phase === "result") throw new Error("terminal storage failed"); });
  const result = await f.call("write", { path: target, content: "committed content" }, "creation-record-failed");
  assert.equal(result.isError, true); assert.equal((result.details as any).status, "state_unknown");
  const records = collectChanges(f.session.getBranch(), f.cwd);
  assert.equal(records.length, 1); assert.equal(records[0].unavailable, undefined); assert.ok(records[0].postimage);
  const observed = await verifyChange(records[0], async () => {});
  assert.equal(observed.postimageMatches, true); assert.equal(observed.parents.length, 2);
  writeFileSync(target, "external");
  assert.equal((await verifyChange(records[0], async () => {})).postimageMatches, false);
});

test("N1 actual partial standalone overwrite binds its ordered origin and rejects tampering", async t => {
  const f = await fixture(t), target = join(f.cwd, "partial-overwrite"); writeFileSync(target, "before");
  await f.call("read", { path: target }, "partial-overwrite-read");
  const original = MutationWriteGuard.prototype.write;
  t.mock.method(MutationWriteGuard.prototype, "write", async function(this: any, ...args: any[]) {
    await original.apply(this, args);
    throw new Error(JSON.stringify({ stateChanged: true, category: "PARTIAL_MUTATION", cause: "injected completion failure after real bytes" }));
  });
  const result = await f.call("write", { path: target, content: "desired-overwrite" }, "partial-overwrite");
  assert.equal(result.isError, true); assert.equal(readFileSync(target, "utf8"), "desired-overwrite");
  const records = collectChanges(f.session.getBranch(), f.cwd);
  assert.equal(records.length, 1); assert.equal(records[0].status, "partial"); assert.equal(records[0].unavailable, undefined);
  await verifyChange(records[0], async () => {});
  const forged = JSON.parse(JSON.stringify(f.session.getBranch()));
  for (const entry of forged) if (entry.data?.phase === "origin" || entry.data?.phase === "intent") entry.data.requestHash = "0".repeat(64);
  assert.ok(collectChanges(forged, f.cwd)[0].unavailable);
});

test("N1 committed exact edit cancellation retains a verifiable terminal receipt", async t => {
  const f = await fixture(t), target = join(f.cwd, "cancelled-edit"); writeFileSync(target, "before");
  await f.call("read", { path: target }, "cancelled-edit-read");
  const original = MutationWriteGuard.prototype.writeEditContent;
  t.mock.method(MutationWriteGuard.prototype, "writeEditContent", async function(this: any, ...args: any[]) {
    const result = await original.apply(this, args);
    f.agent.abort();
    return result;
  });
  const result = await f.call("edit", { path: target, edits: [{ oldText: "before", newText: "after" }] }, "cancelled-edit");
  assert.equal(readFileSync(target, "utf8"), "after"); assert.equal(result.isError, true);
  const records = collectChanges(f.session.getBranch(), f.cwd);
  assert.equal(records.length, 1); assert.equal(records[0].status, "partial"); assert.equal(records[0].unavailable, undefined);
  assert.equal((await verifyChange(records[0], async () => {})).postimageMatches, true);
});

test("N1 later changed-target, destination or operation terminals make earlier outcomes unavailable", async t => {
  const f = await fixture(t), path = join(f.cwd, "conflict"); writeFileSync(path, "old");
  f.onRecord(data => { if (data.phase === "intent") writeFileSync(path, "external"); });
  await f.call("delete", { path }, "later-conflict");
  const genuine = JSON.parse(JSON.stringify(f.session.getBranch()));
  assert.equal(collectChanges(genuine, f.cwd)[0].status, "failed_no_change");
  for (const field of ["target", "destination", "operation"]) {
    const branch = JSON.parse(JSON.stringify(genuine));
    const terminal = branch.find((entry: any) => entry.data?.phase === "result");
    const later = structuredClone(terminal); later.id = "later-invalid-mirror";
    later.data[field] = field === "operation" ? "write" : join(f.cwd, "other"); branch.push(later);
    const records = collectChanges(branch, f.cwd); assert.equal(records.length, 1); assert.ok(records[0].unavailable, field);
    assert.throws(() => remainingDraft(records, new Set()), /missing|ambiguous/);
  }
  for (const field of ["toolName", "operation"]) {
    const branch = JSON.parse(JSON.stringify(genuine)), aggregate = branch.find((entry: any) => entry.message?.toolCallId === "later-conflict" && entry.message?.role === "toolResult");
    if (field === "toolName") aggregate.message.toolName = "write"; else aggregate.message.details.operation = "write";
    const records = collectChanges(branch, f.cwd); assert.equal(records.length, 1); assert.ok(records[0].unavailable, field);
    assert.throws(() => remainingDraft(records, new Set()));
  }
});

test("N1 empty, incomplete and malformed aggregate item lists cannot authorize a remaining draft", async t => {
  const f = await fixture(t), path = join(f.cwd, "aggregate-source"); writeFileSync(path, "old");
  f.onRecord(data => { if (data.phase === "intent") writeFileSync(path, "external"); });
  await f.call("file_batch", { operations: [{ operation: "delete", path }, { operation: "write", mode: "create", path: "later", content: "desired" }] }, "aggregate-shape");
  const genuine = JSON.parse(JSON.stringify(f.session.getBranch()));
  for (const fault of ["empty", "missing", "incomplete", "invalid-outcome"]) {
    const branch = structuredClone(genuine), aggregate = branch.find((entry: any) => entry.message?.toolCallId === "aggregate-shape" && entry.message?.role === "toolResult").message.details;
    if (fault === "empty") aggregate.items = [];
    else if (fault === "missing") delete aggregate.items;
    else if (fault === "incomplete") aggregate.items.pop();
    else aggregate.items[0].status = "not-an-outcome";
    const records = collectChanges(branch, f.cwd); assert.ok(records.length > 0);
    assert.throws(() => remainingDraft(records, new Set()), fault);
  }
  assert.equal(existsSync(join(f.cwd, "later")), false); assert.equal(readFileSync(path, "utf8"), "external");
});

test("N1 malformed later custom outcomes invalidate earlier recovery and later valid mirrors", async t => {
  const f = await fixture(t), path = join(f.cwd, "late-malformed"); writeFileSync(path, "old");
  f.onRecord(data => { if (data.phase === "intent") writeFileSync(path, "external"); });
  await f.call("file_batch", { operations: [{ operation: "delete", path }] }, "late-malformed");
  const genuine = JSON.parse(JSON.stringify(f.session.getBranch()));
  assert.equal(collectChanges(genuine, f.cwd)[0].unavailable, undefined);
  for (const beforeMirror of [false, true]) for (const fault of ["outcome", "missing-item", "noncanonical-item", "version", "timestamp"]) {
    const branch = structuredClone(genuine), later = structuredClone(branch.find((entry: any) => entry.data?.phase === "result"));
    later.id = `malformed-${fault}`;
    if (fault === "outcome") later.data.stateChanged = true;
    if (fault === "missing-item") delete later.data.itemId;
    if (fault === "noncanonical-item") later.data.itemId = "late-malformed:00";
    if (fault === "version") delete later.data.mutationReceiptVersion;
    if (fault === "timestamp") delete later.timestamp;
    if (beforeMirror) branch.splice(branch.findIndex((entry: any) => entry.message?.role === "toolResult"), 0, later);
    else branch.push(later);
    const records = collectChanges(branch, f.cwd); assert.ok(records.length > 0);
    for (const record of records) assert.ok(record.unavailable, `${fault}/${beforeMirror}`);
    assert.throws(() => remainingDraft(records, new Set()), /unable to reconstruct/);
  }
  assert.equal(readFileSync(path, "utf8"), "external");
});

test("N1 later preparation/origin/unversioned aggregate invalidate recovered call history", async t => {
  const f = await fixture(t), path = join(f.cwd, "late-activity"); writeFileSync(path, "old");
  f.onRecord(data => { if (data.phase === "intent") writeFileSync(path, "external"); });
  await f.call("file_batch", { operations: [{ operation: "delete", path }] }, "late-activity");
  const genuine = JSON.parse(JSON.stringify(f.session.getBranch()));
  assert.equal(collectChanges(genuine, f.cwd)[0].unavailable, undefined);
  for (const phase of ["prepared", "origin", "unversioned-result"]) {
    const branch = structuredClone(genuine);
    const later = structuredClone(branch.find((entry: any) => phase === "unversioned-result" ? entry.message?.role === "toolResult" : entry.data?.phase === "prepared"));
    later.id = `later-${phase}`;
    if (phase === "unversioned-result") delete later.message.details.mutationReceiptVersion;
    else later.data.phase = phase;
    branch.push(later);
    const records = collectChanges(branch, f.cwd); assert.ok(records.length);
    for (const record of records) assert.ok(record.unavailable, phase);
    assert.throws(() => remainingDraft(records, new Set()));
  }
  assert.equal(readFileSync(path, "utf8"), "external");
});

test("N1 oversized imported item IDs are rejected before suffix materialization", async t => {
  const f = await fixture(t), path = join(f.cwd, "oversized-id"); writeFileSync(path, "old");
  f.onRecord(data => { if (data.phase === "intent") writeFileSync(path, "external"); });
  await f.call("file_batch", { operations: [{ operation: "delete", path }] }, "oversized-id");
  const branch = JSON.parse(JSON.stringify(f.session.getBranch()));
  const later = structuredClone(branch.find((entry: any) => entry.data?.phase === "intent"));
  later.id = "oversized-item"; later.data.itemId = "oversized-id:" + "1".repeat(2_000_000); branch.push(later);
  const slice = String.prototype.slice; let oversizedSlices = 0;
  const get = Map.prototype.get; let oversizedKeys = 0;
  t.mock.method(Map.prototype, "get", function(this: Map<unknown, unknown>, key: unknown) {
    if (typeof key === "string" && key.length > 512) { oversizedKeys++; assert.fail("oversized IDs must not be hashed"); }
    return get.call(this, key);
  });
  t.mock.method(String.prototype, "slice", function(this: string, ...args: any[]) {
    if (this.length > 1_000_000) { oversizedSlices++; assert.fail("oversized suffix must not be materialized"); }
    return Reflect.apply(slice, this, args);
  });
  const records = collectChanges(branch, f.cwd); assert.ok(records.length);
  for (const record of records) assert.ok(record.unavailable);
  assert.throws(() => remainingDraft(records, new Set())); assert.equal(oversizedSlices, 0);
  const { collectStructuredMutationReceipts, restoreMutationEvidenceFromBranch } = await createJiti(import.meta.url).import<any>("../packages/extensions/mutation-guard-write/session-evidence.ts");
  const invalidResult = { id: "invalid-result", timestamp: "0", type: "message", message: { role: "toolResult", toolName: "file_batch", toolCallId: "oversized-id", details: { items: [{ itemId: later.data.itemId }] } } };
  assert.deepEqual(collectStructuredMutationReceipts([later, invalidResult]), []);
  const invalidated: string[] = [];
  await restoreMutationEvidenceFromBranch({ invalidateCanonicalPath(value: string) { invalidated.push(value); } }, f.cwd, [later]);
  assert.deepEqual(invalidated, [later.data.target]); assert.equal(oversizedKeys, 0);
});

test("N1 standalone legacy creation permits one exact mirror and rejects any subsequent call-owned activity", async t => {
  const f = await fixture(t); await f.call("write", { path: "legacy-create", content: "created" }, "legacy-create");
  const genuine = JSON.parse(JSON.stringify(f.session.getBranch()));
  assert.equal(collectChanges(genuine, f.cwd)[0].unavailable, undefined);
  for (const fault of ["unknown-phase", "missing-item", "unversioned", "duplicate-mirror", "changed-mirror"]) {
    const branch = structuredClone(genuine);
    const result = branch.find((entry: any) => entry.message?.role === "toolResult");
    if (fault === "changed-mirror") result.message.details.creation.bytes++;
    else if (fault === "duplicate-mirror" || fault === "unversioned") {
      const later = structuredClone(result); later.id = "extra-result";
      if (fault === "unversioned") delete later.message.details.mutationReceiptVersion;
      branch.push(later);
    } else {
      const later = structuredClone(branch.find((entry: any) => entry.data?.phase === "result")); later.id = "extra-custom";
      if (fault === "unknown-phase") later.data.phase = "future-phase";
      delete later.data.itemId; branch.push(later);
    }
    for (const record of collectChanges(branch, f.cwd)) assert.ok(record.unavailable, fault);
  }
  assert.equal(readFileSync(join(f.cwd, "legacy-create"), "utf8"), "created");
});

test("N1 imported previews cannot display a forged committed result", async t => {
  const f = await fixture(t);
  await f.call("file_batch", { dryRun: true, operations: [{ operation: "write", mode: "create", path: "preview-only", content: "planned" }] }, "preview-only");
  const genuine = JSON.parse(JSON.stringify(f.session.getBranch()));
  assert.equal(collectChanges(genuine, f.cwd)[0].item.status, "preview");
  for (const fault of ["status", "receipt", "changed"]) {
    const branch = structuredClone(genuine), item = branch.find((entry: any) => entry.message?.role === "toolResult").message.details.items[0];
    if (fault === "status") item.status = "succeeded";
    if (fault === "receipt") item.receipt = { created: true, patch: "forged committed patch" };
    if (fault === "changed") item.stateChanged = true;
    assert.deepEqual(collectChanges(branch, f.cwd), [], fault);
  }
  assert.equal(existsSync(join(f.cwd, "preview-only")), false);
});

test("N1 bounded recovery refuses oversized nested assistant content without traversing it", async t => {
  const f = await fixture(t), path = join(f.cwd, "bounded-call"); writeFileSync(path, "old");
  f.onRecord(data => { if (data.phase === "intent") writeFileSync(path, "external"); });
  await f.call("file_batch", { operations: [{ operation: "delete", path }] }, "bounded-call");
  const genuine = JSON.parse(JSON.stringify(f.session.getBranch()));
  for (const kind of ["one-array", "total-blocks", "total-calls"]) {
    const branch = structuredClone(genuine); let visited = 0;
    const count = kind === "one-array" ? 1 : kind === "total-blocks" ? 33 : 5;
    for (let index = 0; index < count; index++) {
      const values = new Array(kind === "one-array" ? 1_000_000 : 128);
      const content = new Proxy(values, { get(target, property, receiver) {
        if (typeof property === "string" && Number.isInteger(Number(property))) {
          visited++; if (kind === "one-array") assert.fail("oversized contents must not be accessed");
          return kind === "total-calls" ? { type: "toolCall", id: `extra-${index}-${property}`, name: "read", arguments: {} } : { type: "text", text: "fixture" };
        }
        return Reflect.get(target, property, receiver);
      } });
      branch.push({ id: `bounded-${index}`, type: "message", message: { role: "assistant", content } });
    }
    const records = collectChanges(branch, f.cwd); assert.ok(records.length > 0);
    assert.ok(visited <= (kind === "one-array" ? 0 : kind === "total-calls" ? 512 : 4096));
    for (const record of records) assert.match(record.unavailable, /inspection limits/);
    assert.throws(() => remainingDraft(records, new Set()));
  }
});

test("N1 custom origin/preparation cannot double as a terminal receipt", async t => {
  const f = await fixture(t); await f.call("write", { path: "origin-only", content: "created once" }, "origin-only");
  const genuine = JSON.parse(JSON.stringify(f.session.getBranch()));
  for (const phase of ["origin", "prepared", "unknown-phase"]) {
    const branch = genuine.filter((entry: any) => entry.message?.role !== "toolResult" && entry.data?.phase !== "intent" && entry.data?.phase !== "result");
    const origin = structuredClone(branch.find((entry: any) => entry.data?.phase === "origin")); assert.ok(origin);
    origin.data = { ...origin.data, phase, mutationReceiptVersion: 2, status: "failed_no_change", stateChanged: false };
    const forged = branch.map((entry: any) => entry.id === origin.id ? origin : entry);
    assert.deepEqual(collectChanges(forged, f.cwd), [], phase);
  }
  assert.equal(readFileSync(join(f.cwd, "origin-only"), "utf8"), "created once");
});

for (const batch of [false, true]) test(`N1 intent-only creation observes every bounded planned parent, batch=${batch}`, async t => {
  const f = await fixture(t), path = join(f.cwd, "intent/parents/file");
  await f.call(batch ? "file_batch" : "write", batch ? { operations: [{ operation: "write", mode: "create", path, content: "written" }] } : { path, content: "written" }, "intent-only");
  const branch = f.session.getBranch().filter((entry: any) => entry.data?.phase !== "result" && entry.message?.role !== "toolResult");
  const records = collectChanges(branch, f.cwd); assert.equal(records.length, 1); assert.equal(records[0].status, "state_unknown");
  const observation = await verifyChange(records[0], async () => {});
  assert.equal(observation.parents.length, 2); assert.ok(observation.parents.every((parent: any) => parent.exists && parent.identity.directory));
  for (const fault of ["omit", "empty", "substitute", "reorder", "preparation"]) {
    const corrupted = JSON.parse(JSON.stringify(branch)), intent = corrupted.find((entry: any) => entry.data?.phase === "intent").data;
    if (fault === "omit") delete intent.directories;
    if (fault === "empty") intent.directories = [];
    if (fault === "substitute") intent.directories[0] = dirname(path);
    if (fault === "reorder") intent.directories.reverse();
    if (fault === "preparation") {
      const prepared = corrupted.find((entry: any) => entry.data?.phase === (batch ? "prepared" : "origin")).data;
      delete (batch ? prepared.items[0] : prepared).directories;
    }
    const invalid = collectChanges(corrupted, f.cwd); assert.ok(invalid[0].unavailable, fault);
    await assert.rejects(verifyChange(invalid[0], async () => {}));
    assert.throws(() => remainingDraft(invalid, new Set([invalid[0].itemId])));
  }
});

for (const batch of [false, true]) test(`N2 intent-only overwrite binds an explicitly empty parent plan, batch=${batch}`, async t => {
  const f = await fixture(t), path = join(f.cwd, "overwrite-intent"); writeFileSync(path, "before");
  await f.call("read", { path }, "overwrite-intent-read");
  const result = await f.call(batch ? "file_batch" : "write", batch ? { operations: [{ operation: "write", mode: "overwrite", path, content: "after" }] } : { path, content: "after" }, "overwrite-intent");
  assert.equal(result.isError, false);
  const branch = f.session.getBranch().filter((entry: any) => entry.data?.phase !== "result" && entry.message?.role !== "toolResult");
  const record = collectChanges(branch, f.cwd)[0]; assert.equal(record.unavailable, undefined); assert.equal(record.status, "state_unknown");
  assert.equal((await verifyChange(record, async () => {})).parents.length, 0); assert.equal(readFileSync(path, "utf8"), "after");
});

test("N1/N2 standalone snapshot post-publication readback failure retains a partial terminal", async t => {
  const f = await fixture(t), path = join(realpathSync.native(f.cwd), "snapshot-partial"); writeFileSync(path, "one\ntwo\n");
  const read = await f.call("read", { path }, "snapshot-partial-read");
  const body = read.content.filter(block => block.type === "text").map(block => block.text).join("\n");
  const snapshot = /snapshot=([A-Za-z0-9_-]+)/.exec(body)![1], anchor = /^2#[A-Fa-f0-9]+/m.exec(body)![0];
  const probe = await open(path, "r"), prototype = Object.getPrototypeOf(probe); await probe.close();
  const original = prototype.read; let replaced = false;
  t.mock.method(prototype, "read", async function(this: any, ...args: any[]) {
    if (!replaced && readFileSync(path, "utf8") === "one\nTWO\n") {
      replaced = true; throw new Error("fixture readback failure after actual publication");
    }
    return original.apply(this, args);
  });
  try {
    const result = await f.call("edit", { path, snapshot, edits: [{ kind: "replace", start: anchor, newLines: ["TWO"] }] }, "snapshot-partial");
    assert.equal(replaced, true); assert.equal(result.isError, true); assert.equal((result.details as any).status, "partial");
    const records = collectChanges(f.session.getBranch(), f.cwd); assert.equal(records.length, 1); assert.equal(records[0].unavailable, undefined);
    await verifyChange(records[0], async () => {}); assert.equal(readFileSync(path, "utf8"), "one\nTWO\n");
  } finally { t.mock.restoreAll(); }
});

test("N1 exact remaining drafts preserve occurrence hints as non-evidence", async t => {
  const f = await fixture(t); writeFileSync(join(f.cwd, "repeated"), "same\nsame\n");
  await f.call("read", { path: "repeated" }, "repeated-read");
  f.onRecord(data => { if (data.phase === "intent") writeFileSync(join(f.cwd, "repeated"), "external\nsame\n"); });
  const result = await f.call("file_batch", { operations: [{ operation: "edit", path: "repeated", edits: [{ oldText: "same", newText: "changed", expectedLine: 2 }] }] }, "occurrence");
  assert.equal(result.isError, true);
  const draft = remainingDraft(collectChanges(f.session.getBranch(), f.cwd), new Set());
  assert.match(draft, /"originalLineHint":\s*2/); assert.match(draft, /line hints are not evidence/); assert.doesNotMatch(draft, /"expectedLine"/);
});

test("N1 POSIX newline paths keep real write and edit receipts reconstructable", { skip: process.platform === "win32" }, async t => {
  const f = await fixture(t), path = "multi\nline\rfile";
  assert.equal((await f.call("write", { path, content: "before" }, "newline-write")).isError, false);
  await f.call("read", { path }, "newline-read");
  assert.equal((await f.call("edit", { path, edits: [{ oldText: "before", newText: "after" }] }, "newline-edit")).isError, false);
  const records = collectChanges(f.session.getBranch(), f.cwd); assert.equal(records.length, 2);
  for (const record of records) assert.equal(record.unavailable, undefined);
  assert.equal((await verifyChange(records[1], async () => {})).postimageMatches, true);
});

test("N1 partial batch creation binds created-directory metadata across the result mirror", async t => {
  const f = await fixture(t), target = join(realpathSync.native(f.cwd), "mirror-parent/child/file");
  const probe = await open(join(f.cwd, "probe"), "w"), prototype = Object.getPrototypeOf(probe); await probe.close();
  const original = prototype.writeFile;
  t.mock.method(prototype, "writeFile", async function(this: any, value: any, ...args: any[]) {
    if (value === "mirror-create-fixture") throw new Error("fixture write failure after parents");
    return original.call(this, value, ...args);
  });
  const result = await f.call("file_batch", { operations: [{ operation: "write", mode: "create", path: target, content: "mirror-create-fixture" }] }, "parent-mirror");
  assert.equal(result.isError, true);
  const genuine = structuredClone(f.session.getBranch()) as any[];
  const records = collectChanges(genuine, f.cwd); assert.equal(records[0].status, "partial"); assert.equal(records[0].unavailable, undefined);
  const observation = await verifyChange(records[0], async (path: string) => path);
  assert.equal(observation.parents.length, 2);
  for (const fault of ["omit", "path", "identity"]) {
    // Disk/imported JSON has independent mirrored objects, not the live Session's
    // shared directory array references retained by structuredClone.
    const branch = JSON.parse(JSON.stringify(genuine)), receipt = branch.find((entry: any) => entry.message?.role === "toolResult" && entry.message.toolCallId === "parent-mirror").message.details.items[0].receipt;
    const owner = receipt.creation ?? receipt;
    assert.equal(owner.createdDirectories.length, 2);
    if (fault === "omit") delete owner.createdDirectories;
    if (fault === "path") owner.createdDirectories[0].path = join(f.cwd, "wrong-parent");
    if (fault === "identity") owner.createdDirectories[0].identity.inode = "999999";
    const invalid = collectChanges(branch, f.cwd); assert.ok(invalid[0].unavailable, fault);
    await assert.rejects(verifyChange(invalid[0], async () => { assert.fail("unbound side effects cannot authorize verification"); }), /cannot authorize/);
    assert.throws(() => remainingDraft(invalid, new Set([invalid[0].itemId])), /missing|ambiguous/);
  }
});

for (const batch of [false, true]) for (const kind of ["exact", "snapshot"]) test(`N2 retained ${kind}-edit candidate consumes read evidence, batch=${batch}`, async t => {
  const f = await fixture(t), target = join(realpathSync.native(f.cwd), "retained-exact"); writeFileSync(target, "before");
  await protectWindowsFixture(target); const read = await f.call("read", { path: target }, "retained-read");
  const body = read.content.filter(block => block.type === "text").map(block => block.text).join("\n");
  const probe = await open(target, "r"), prototype = Object.getPrototypeOf(probe); await probe.close();
  const post = Worker.prototype.postMessage;
  t.mock.method(prototype, "sync", async function() { throw new Error("fixture retained exact staging sync failure"); });
  t.mock.method(Worker.prototype, "postMessage", function(this: Worker, input: any) {
    if (input.operation === "remove") input.expected = { ...input.expected, inode: "0" };
    return post.call(this, input);
  });
  const args = { path: target, edits: [{ oldText: "before", newText: "after" }] };
  const firstArgs = kind === "exact" ? args : { path: target, snapshot: body.slice(body.indexOf("snapshot=") + 9, body.indexOf("snapshot=") + 36),
    edits: [{ kind: "replace", start: body.split("\n").find(line => line.startsWith("1#"))!.split("|")[0], newLines: ["after"] }] };
  const first = await f.call(batch ? "file_batch" : "edit", batch ? { operations: [{ operation: "edit", ...firstArgs }] } : firstArgs, "retained-first");
  t.mock.restoreAll(); assert.equal(first.isError, true);
  const retained = (await fsPromises.readdir(dirname(target))).filter(name => name.startsWith(".pi-file-commit-"));
  assert.equal(retained.length, 1); assert.equal(readFileSync(join(dirname(target), retained[0]!), "utf8"), "after");
  const restored = new MutationWriteGuard();
  await restoreMutationEvidenceFromBranch(restored, f.cwd, SessionManager.open(f.session.getSessionFile()!).getBranch());
  await assert.rejects(restored.write(f.cwd, target, "restored forbidden", 99), /READ_REQUIRED/);
  await assert.rejects(restored.authorizeEdit(f.cwd, target, args.edits, 99, "before"), /READ_REQUIRED/);
  const retry = await f.call("edit", args, "retained-retry");
  assert.equal(retry.isError, true); assert.ok(JSON.stringify(retry).includes("READ_REQUIRED"), JSON.stringify(retry));
  const overwrite = await f.call("write", { path: target, content: "other" }, "retained-overwrite");
  assert.equal(overwrite.isError, true); assert.ok(JSON.stringify(overwrite).includes("READ_REQUIRED"), JSON.stringify(overwrite));
  assert.deepEqual((await fsPromises.readdir(dirname(target))).filter(name => name.startsWith(".pi-file-commit-")), retained);
  assert.equal(readFileSync(target, "utf8"), "before");
  await f.call("read", { path: target }, "retained-fresh-read");
  const fresh = await f.call("edit", args, "retained-fresh-edit");
  assert.equal(fresh.isError, false, JSON.stringify(fresh)); assert.equal(readFileSync(target, "utf8"), "after");
});

test("N2 standalone overwrite intents accept only fixed supplied strategies, including intent-only history", async t => {
  const f = await fixture(t), target = join(f.cwd, "strategy-write"); writeFileSync(target, "before");
  await f.call("read", { path: target }, "strategy-read");
  await f.call("write", { path: target, content: "after" }, "strategy-write");
  const genuine = JSON.parse(JSON.stringify(f.session.getBranch()));
  assert.equal(collectChanges(genuine, f.cwd)[0].unavailable, undefined);
  for (const intentOnly of [false, true]) for (const value of ["unknown", null, 7]) {
    const branch = structuredClone(genuine).filter((entry: any) => !intentOnly || entry.data?.phase !== "result" && entry.message?.role !== "toolResult");
    const intent = branch.find((entry: any) => entry.data?.phase === "intent"); intent.data.strategy = value;
    const records = collectChanges(branch, f.cwd); assert.ok(records.length > 0);
    for (const record of records) assert.ok(record.unavailable, `${intentOnly}:${value}`);
    assert.throws(() => remainingDraft(records, new Set(records.map((record: any) => record.itemId))));
  }
  assert.equal(readFileSync(target, "utf8"), "after");
});

test("N2 mirrored terminals bind commit outcome, strategy and retained candidate", async t => {
  const f = await fixture(t), target = join(realpathSync.native(f.cwd), "commit-mirror"); writeFileSync(target, "before");
  await protectWindowsFixture(target); await f.call("read", { path: target }, "commit-mirror-read");
  const probe = await open(target, "r"), prototype = Object.getPrototypeOf(probe); await probe.close();
  const post = Worker.prototype.postMessage; let failed = false;
  t.mock.method(prototype, "sync", async function() { failed = true; throw new Error("fixture staging sync failure"); });
  t.mock.method(Worker.prototype, "postMessage", function(this: Worker, input: any) {
    if (input.operation === "remove") input.expected = { ...input.expected, inode: "0" };
    return post.call(this, input);
  });
  const result = await f.call("file_batch", { operations: [{ operation: "write", mode: "overwrite", path: target, content: "after" }] }, "commit-mirror");
  t.mock.restoreAll(); assert.equal(failed, true); assert.equal(result.isError, true);
  const genuine = JSON.parse(JSON.stringify(f.session.getBranch())), record = collectChanges(genuine, f.cwd)[0];
  assert.equal(record.unavailable, undefined); assert.ok(record.receipt.commit.retainedTemporary);
  assert.equal(readFileSync(record.receipt.commit.retainedTemporary, "utf8"), "after");
  await verifyChange(record, async () => {});
  for (const field of ["retainedTemporary", "outcome", "strategy", "cleanupReason", "omit"]) {
    const branch = JSON.parse(JSON.stringify(genuine));
    const receipt = branch.find((entry: any) => entry.message?.toolCallId === "commit-mirror" && entry.message?.role === "toolResult").message.details.items[0].receipt;
    if (field === "omit") delete receipt.commit;
    else receipt.commit[field] = field === "retainedTemporary" ? join(dirname(target), ".pi-file-commit-123-0123456789abcdef01234567.tmp")
      : field === "outcome" ? "unknown" : field === "strategy" ? "protected_in_place" : "different cleanup";
    const invalid = collectChanges(branch, f.cwd); assert.ok(invalid[0].unavailable, field);
    await assert.rejects(verifyChange(invalid[0], async () => { assert.fail("unbound commit cannot authorize verification"); }));
    assert.throws(() => remainingDraft(invalid, new Set([invalid[0].itemId])));
  }
  assert.equal(readFileSync(target, "utf8"), "before");
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
