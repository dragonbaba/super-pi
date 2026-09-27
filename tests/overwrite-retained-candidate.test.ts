import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, writeFileSync, mkdirSync, symlinkSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { mutationFixture, MutationWriteGuard } from "./helpers/mutation-fixture.ts";
import { protectWindowsFixture } from "./helpers/native-metadata-fixture.ts";
import { SessionManager } from "../packages/coding-agent/src/core/session-manager.ts";
import { disposeNativeFileWorker } from "../packages/extensions/mutation-guard-write/native-file-client.ts";
import { createJiti } from "jiti";
const { collectChanges, remainingDraft, verifyChange } = await createJiti(import.meta.url).import<any>("../packages/extensions/mutation-guard-write/changes.ts");
const { restoreMutationEvidenceFromBranch } = await createJiti(import.meta.url).import<any>("../packages/extensions/mutation-guard-write/session-evidence.ts");

test("N2 actual overwrite through an allowed parent alias retains canonical recovery across Session cwd override", async t => {
  const f = await mutationFixture(t), directory = join(f.cwd, "real"); mkdirSync(directory);
  symlinkSync(directory, join(f.cwd, "alias"), process.platform === "win32" ? "junction" : "dir");
  const target = join(directory, "file"); writeFileSync(target, "before"); await protectWindowsFixture(target);
  assert.equal((await f.call("read", { path: "alias/file" }, "read-alias")).isError, false);
  const result = await f.call("write", { path: "alias/file", content: "after" }, "write-alias");
  assert.equal(result.isError, false, JSON.stringify(result));
  const reopened = SessionManager.open(f.session.getSessionFile()!, undefined, join(f.cwd, "other"));
  const records = collectChanges(reopened.getBranch(), join(f.cwd, "other"));
  assert.equal(records.length, 1); assert.equal(records[0].unavailable, undefined, JSON.stringify(records));
  assert.equal(records[0].target, realpathSync.native(target)); await verifyChange(records[0], async () => {});
  assert.equal(readFileSync(target, "utf8"), "after");
  t.after(disposeNativeFileWorker);
});

test("N2 verified no-change overwrite draft preserves overwrite mode after candidate cleanup", { skip: process.platform !== "win32" }, async t => {
  const f = await mutationFixture(t), path = join(f.cwd, "retry-overwrite"); writeFileSync(path, "before");
  await protectWindowsFixture(path); await f.call("read", { path }, "read-retry");
  const post = Worker.prototype.postMessage;
  t.mock.method(Worker.prototype, "postMessage", function(this: Worker, ...args: any[]) {
    if (args[0]?.operation === "replace") throw Object.assign(new Error("fixture before native publication"), { commitOutcome: "not_committed" });
    return Reflect.apply(post, this, args);
  });
  t.after(disposeNativeFileWorker);
  const result = await f.call("write", { path, content: "desired" }, "cleaned-overwrite");
  assert.equal(result.isError, true); assert.equal((result.details as any).status, "failed_no_change");
  assert.equal((result.details as any).commit.retainedTemporary, undefined);
  const records = collectChanges(SessionManager.open(f.session.getSessionFile()!).getBranch(), f.cwd);
  const draft = remainingDraft(records, new Set()); assert.match(draft, /"mode": "overwrite"/); assert.match(draft, /desired/);
  assert.equal(readFileSync(path, "utf8"), "before");
});

for (const outcome of ["unknown", "committed"]) for (const batch of [false, true]) test(`N2 live overwrite ${outcome} failure clears range evidence, batch=${batch}`, async t => {
  const f = await mutationFixture(t), path = join(f.cwd, "overwrite-outcome"); writeFileSync(path, "before");
  await protectWindowsFixture(path); assert.equal((await f.call("read", { path }, "read-outcome")).isError, false);
  const post = Worker.prototype.postMessage, emit = Worker.prototype.emit;
  let publicationId = 0, publications = 0, publicationWorker: Worker | undefined;
  t.mock.method(Worker.prototype, "postMessage", function(this: Worker, ...args: any[]) {
    if (args[0]?.operation === "replace") {
      publications++;
      if (outcome === "unknown") throw Object.assign(new Error("fixture unconfirmed publication"), { commitOutcome: "unknown" });
      publicationId = args[0].id; publicationWorker = this;
    }
    return Reflect.apply(post, this, args);
  });
  t.mock.method(Worker.prototype, "emit", function(this: Worker, event: string, ...args: any[]) {
    if (event === "message" && this === publicationWorker && args[0]?.id === publicationId) {
      assert.equal(args[0].error, undefined, JSON.stringify(args[0]));
      args[0].error = { message: "fixture failure after actual native publication", commitOutcome: "committed" };
    }
    return Reflect.apply(emit, this, [event, ...args]);
  });
  t.after(disposeNativeFileWorker);
  const result = await f.call(batch ? "file_batch" : "write", batch ? { operations: [{ operation: "write", mode: "overwrite", path, content: "candidate" }] } : { path, content: "candidate" }, "outcome-write");
  assert.equal(result.isError, true); const receipt = batch ? (result.details as any).items[0] : result.details as any;
  assert.equal(receipt.stateChanged, outcome === "unknown" ? "unknown" : true); assert.equal(receipt.requiresVerification, true);
  const expected = outcome === "unknown" ? "before" : "candidate";
  assert.equal(readFileSync(path, "utf8"), expected);
  const exact = await f.call("edit", { path, edits: [{ oldText: "before", newText: "forbidden" }] }, "live-exact-after-outcome");
  assert.equal(exact.isError, true); assert.ok(JSON.stringify(exact).includes("READ_REQUIRED"), JSON.stringify(exact));
  assert.equal(publications, 1); assert.equal(readFileSync(path, "utf8"), expected);
});

for (const batch of [false, true]) test(`N2 overwrite persists verification/no-retry when a no-change failure retains the candidate, batch=${batch}`, async t => {
  const f = await mutationFixture(t), path = join(f.cwd, "overwrite"); writeFileSync(path, "before");
  await protectWindowsFixture(path);
  assert.equal((await f.call("read", { path }, "read-before")).isError, false);
  const post = Worker.prototype.postMessage; let publications = 0;
  t.mock.method(Worker.prototype, "postMessage", function(this: Worker, ...args: any[]) {
    if (args[0]?.operation === "replace") { publications++; throw Object.assign(new Error("fixture verified native no-change failure"), { commitOutcome: "not_committed" }); }
    if (args[0]?.operation === "remove") throw new Error("fixture deletion unavailable; retain candidate");
    return Reflect.apply(post, this, args);
  });
  t.after(disposeNativeFileWorker);
  const result = await f.call(batch ? "file_batch" : "write", batch ? { operations: [
    { operation: "write", mode: "overwrite", path, content: "candidate" },
    { operation: "write", mode: "create", path: "remaining", content: "later" },
  ] } : { path, content: "candidate" }, "retained-write");
  assert.equal(result.isError, true); const outcome = batch ? (result.details as any).items[0] : result.details as any;
  const details = batch ? outcome.receipt : outcome;
  assert.equal(outcome.status, "failed_no_change"); assert.equal(outcome.stateChanged, false);
  assert.equal(outcome.requiresVerification, true); assert.ok(details.commit.retainedTemporary);
  assert.equal(readFileSync(path, "utf8"), "before"); assert.equal(readFileSync(details.commit.retainedTemporary, "utf8"), "candidate");
  const exact = await f.call("edit", { path, edits: [{ oldText: "before", newText: "forbidden" }] }, "live-exact-after-retained");
  assert.equal(exact.isError, true); assert.ok(JSON.stringify(exact).includes("READ_REQUIRED"), JSON.stringify(exact));
  assert.equal(publications, 1); assert.equal(readFileSync(path, "utf8"), "before");
  const restored = new MutationWriteGuard();
  await restoreMutationEvidenceFromBranch(restored, f.cwd, SessionManager.open(f.session.getSessionFile()!).getBranch());
  await assert.rejects(restored.write(f.cwd, path, "restored forbidden", 99), /READ_REQUIRED/);
  await assert.rejects(restored.authorizeEdit(f.cwd, path, [{ oldText: "before", newText: "forbidden" }], 99, "before"), /READ_REQUIRED/);
  if (!batch) assert.match(JSON.stringify(result.content), /Verify current state; do not automatically retry/);
  else assert.equal((result.details as any).items[0].requiresVerification, true);
  const reopened = SessionManager.open(f.session.getSessionFile()!);
  const terminal = reopened.getBranch().find((entry: any) => entry.customType === "file-mutation-progress-v2" && entry.data?.toolCallId === "retained-write" && entry.data?.phase === "result") as any;
  assert.equal(terminal.data.requiresVerification, true); assert.equal(terminal.data.commit.retainedTemporary, details.commit.retainedTemporary);
  const records = collectChanges(reopened.getBranch(), f.cwd);
  assert.equal(records[0].requiresVerification, true);
  assert.ok(records.every((record: any) => !record.unavailable), JSON.stringify(records));
  assert.throws(() => remainingDraft(records, new Set()), /verify partial\/unknown/);
  const observation = await verifyChange(records[0], async () => {});
  assert.equal(observation.temporary.path, details.commit.retainedTemporary); assert.equal(observation.temporary.exists, true);
  assert.match(observation.temporary.sha256, /^[a-f0-9]{64}$/);
  if (batch) {
    const draft = remainingDraft(records, new Set([records[0].itemId]));
    assert.match(draft, /remaining/); assert.doesNotMatch(draft, /candidate|overwrite/);
  } else assert.throws(() => remainingDraft(records, new Set([records[0].itemId])), /No confirmed/);
});
