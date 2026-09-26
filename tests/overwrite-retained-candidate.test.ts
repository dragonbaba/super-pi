import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, writeFileSync, mkdirSync, symlinkSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { mutationFixture } from "./helpers/mutation-fixture.ts";
import { protectWindowsFixture } from "./helpers/native-metadata-fixture.ts";
import { SessionManager } from "../packages/coding-agent/src/core/session-manager.ts";
import { disposeNativeFileWorker } from "../packages/extensions/mutation-guard-write/native-file-client.ts";
import { createJiti } from "jiti";
const { collectChanges, verifyChange } = await createJiti(import.meta.url).import<any>("../packages/extensions/mutation-guard-write/changes.ts");

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

test("N2 standalone overwrite persists verification/no-retry when a no-change failure retains the candidate", async t => {
  const f = await mutationFixture(t), path = join(f.cwd, "overwrite"); writeFileSync(path, "before");
  await protectWindowsFixture(path);
  assert.equal((await f.call("read", { path }, "read-before")).isError, false);
  const post = Worker.prototype.postMessage;
  t.mock.method(Worker.prototype, "postMessage", function(this: Worker, ...args: any[]) {
    if (args[0]?.operation === "replace") throw Object.assign(new Error("fixture verified native no-change failure"), { commitOutcome: "not_committed" });
    if (args[0]?.operation === "remove") throw new Error("fixture deletion unavailable; retain candidate");
    return Reflect.apply(post, this, args);
  });
  t.after(disposeNativeFileWorker);
  const result = await f.call("write", { path, content: "candidate" }, "retained-write");
  assert.equal(result.isError, true); const details = result.details as any;
  assert.equal(details.status, "failed_no_change"); assert.equal(details.stateChanged, false);
  assert.equal(details.requiresVerification, true); assert.ok(details.commit.retainedTemporary);
  assert.equal(readFileSync(path, "utf8"), "before"); assert.equal(readFileSync(details.commit.retainedTemporary, "utf8"), "candidate");
  assert.match(JSON.stringify(result.content), /Verify current state; do not automatically retry/);
  const reopened = SessionManager.open(f.session.getSessionFile()!);
  const terminal = reopened.getBranch().find((entry: any) => entry.customType === "file-mutation-progress-v2" && entry.data?.toolCallId === "retained-write" && entry.data?.phase === "result") as any;
  assert.equal(terminal.data.requiresVerification, true); assert.equal(terminal.data.commit.retainedTemporary, details.commit.retainedTemporary);
});
