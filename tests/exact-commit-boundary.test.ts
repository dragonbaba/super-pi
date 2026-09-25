import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { mutationFixture } from "./helpers/mutation-fixture.ts";
import { exactCommitBarrier } from "./helpers/exact-commit-barrier.ts";
import { SessionManager } from "../packages/coding-agent/src/core/session-manager.ts";
import { collectStructuredMutationReceipts } from "../packages/extensions/mutation-guard-write/session-evidence.ts";

for (const action of ["control", "permission", "cancel"]) test(`single exact final hash boundary: ${action}`, { timeout: 10000 }, async t => {
  const f = await mutationFixture(t); const path = join(f.cwd, "exact.txt"); writeFileSync(path, "before\n");
  assert.equal((await f.call("read", { path: "exact.txt" }, "read-exact")).isError, false);
  const barrier = exactCommitBarrier(t, path);
  const pending = f.call("edit", { path: "exact.txt", edits: [{ oldText: "before", newText: "after" }] }, `exact-${action}`);
  try {
    await barrier.wait(pending);
    if (action === "permission") await f.runner.getCommand("permissions")!.handler("read-only", f.runner.createContext() as never);
    if (action === "cancel") f.agent.abort();
  } finally { barrier.resume(); }
  const result = await pending;
  assert.equal(barrier.issuedWrites, action === "control" ? 1 : 0, "count writes actually submitted, not a post-write abort result");
  assert.equal(readFileSync(path, "utf8"), action === "control" ? "after\n" : "before\n");
  assert.equal(result.isError, action !== "control");
  assert.equal(f.agent.state.pendingToolCalls.size, 0); assert.equal(f.agent.state.isStreaming, false);
  assert.equal((f.runner as any).finalAuthorizations?.size ?? 0, 0);
  const reopened = SessionManager.open(f.session.getSessionFile()!);
  const receipts = collectStructuredMutationReceipts(reopened.getBranch());
  assert.equal(receipts.filter(item => item.toolCallId === `exact-${action}`).length, action === "control" ? 1 : 0);
  assert.equal(readFileSync(path, "utf8"), action === "control" ? "after\n" : "before\n");
});
