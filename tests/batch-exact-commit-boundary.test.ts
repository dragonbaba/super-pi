import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { mutationFixture } from "./helpers/mutation-fixture.ts";
import { exactCommitBarrier } from "./helpers/exact-commit-barrier.ts";
import { SessionManager } from "../packages/coding-agent/src/core/session-manager.ts";
import { collectStructuredMutationReceipts } from "../packages/extensions/mutation-guard-write/session-evidence.ts";

for (const action of ["control", "permission", "cancel"]) test(`batch exact final hash boundary: ${action}`, { timeout: 10000 }, async t => {
  const f = await mutationFixture(t); const path = join(f.cwd, "exact.txt"); writeFileSync(path, "before\n");
  assert.equal((await f.call("read", { path: "exact.txt" }, "read-exact")).isError, false);
  await f.freezeTurn();
  const barrier = exactCommitBarrier(t, path);
  const pending = f.call("file_batch", { operations: [
    { operation: "write", mode: "create", path: "first.txt", content: "first" },
    { operation: "edit", path: "exact.txt", edits: [{ oldText: "before", newText: "after" }] },
    { operation: "write", mode: "create", path: "last.txt", content: "last" },
  ] }, `batch-${action}`);
  try {
    await barrier.wait(pending);
    assert.equal(readFileSync(join(f.cwd, "first.txt"), "utf8"), "first");
    if (action === "permission") await f.runner.getCommand("permissions")!.handler("read-only", f.runner.createContext() as never);
    if (action === "cancel") f.agent.abort();
  } finally { barrier.resume(); }
  const result = await pending; const details = result.details as any;
  assert.equal(barrier.issuedWrites, action === "control" ? 1 : 0, "count writes issued after final hash, not post-write cancellation");
  assert.equal(readFileSync(path, "utf8"), action === "control" ? "after\n" : "before\n");
  assert.equal(existsSync(join(f.cwd, "last.txt")), action === "control");
  assert.deepEqual(details.items.map((item: any) => item.status), action === "control" ? ["succeeded", "succeeded", "succeeded"] : ["succeeded", action === "cancel" ? "cancelled" : "failed_no_change", "not_started"]);
  assert.equal(details.succeeded, action === "control" ? 3 : 1);
  assert.equal(details.failed, action === "control" ? 0 : 1);
  assert.equal(details.notStarted, action === "control" ? 0 : 1);
  if (action !== "control") assert.equal(details.items[1].stateChanged, false);
  assert.equal(f.agent.state.pendingToolCalls.size, 0); assert.equal(f.agent.state.isStreaming, false);
  assert.equal((f.runner as any).finalAuthorizations.size, 0);
  const reopened = SessionManager.open(f.session.getSessionFile()!);
  const receipts = collectStructuredMutationReceipts(reopened.getBranch()).filter(item => item.toolCallId === `batch-${action}`);
  assert.equal(receipts.filter((item: any) => item.itemId === `batch-${action}:0` && item.status === "succeeded").length, 1);
  assert.equal(readFileSync(path, "utf8"), action === "control" ? "after\n" : "before\n");
  assert.equal(existsSync(join(f.cwd, "last.txt")), action === "control");
  if (action !== "control") {
    await f.runner.getCommand("permissions")!.handler("workspace-write", f.runner.createContext() as never);
    // One completed target remains charged; failed/unstarted reservations release.
    const operations = Array.from({ length: 16 }, (_, i) => ({ operation: "write", mode: "create", path: `probe-${i}`, content: "" }));
    assert.equal((await f.call("file_batch", { operations: operations.slice(0, 15), dryRun: true }, "budget-15")).isError, false);
    assert.equal((await f.call("file_batch", { operations, dryRun: true }, "budget-16")).isError, true);
    assert.equal(existsSync(join(f.cwd, "probe-0")), false);
  }
});
