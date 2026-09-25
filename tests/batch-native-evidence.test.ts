import assert from "node:assert/strict";
import test, { after, mock } from "node:test";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { writeFileSync, readFileSync, existsSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { mutationFixture, MutationWriteGuard } from "./helpers/mutation-fixture.ts";
import { createJiti } from "jiti";
import { SessionManager } from "../packages/coding-agent/src/core/session-manager.ts";
const { restoreMutationEvidenceFromBranch, recordBatchMutationEvidence, collectStructuredMutationReceipts } = await createJiti(import.meta.url).import<any>("../packages/extensions/mutation-guard-write/session-evidence.ts");
for (const operation of ["delete", "move"]) for (const path of ["@name", "@@name", "./@name", "$absolute"]) test(`R3 literal ${operation} evidence: ${path}`, async t => {
  const f = await mutationFixture(t); const cwd = realpathSync.native(f.cwd);
  const literal = path === "@@name" ? "@@name" : "@name", other = path === "@@name" ? "@name" : "name";
  const source = join(cwd, literal), unrelated = join(cwd, other), destination = join(cwd, "@destination");
  writeFileSync(source, "source"); writeFileSync(unrelated, "unrelated"); writeFileSync(join(cwd, "destination"), "other destination");
  for (const p of [source, unrelated, join(cwd, "destination")]) assert.equal((await f.call("read", { path: p }, `read-${p}`)).isError, false);
  const result = await f.call("file_batch", { operations: [{ operation, path: path === "$absolute" ? source : path, ...(operation === "move" ? { destination: "@destination" } : {}) }] }, "native");
  assert.equal(result.isError, false); assert.equal(existsSync(source), false);
  if (operation === "move") assert.equal(readFileSync(destination, "utf8"), "source");
  const branch = SessionManager.open(f.session.getSessionFile()!).getBranch();
  const restored = new MutationWriteGuard(); await restoreMutationEvidenceFromBranch(restored, cwd, branch);
  const restoredWrite = await restored.write(cwd, unrelated, "restored", 999); assert.equal(restoredWrite.ok, true);
  // Restore bytes so the live prior-read evidence still qualifies.
  writeFileSync(unrelated, "unrelated");
  const live = await f.call("write", { path: unrelated, content: "live" }, "unrelated-write");
  t.diagnostic(JSON.stringify({ operation, path, liveError: live.isError, sourceExists: existsSync(source), unrelated: readFileSync(unrelated, "utf8") }));
  assert.equal(live.isError, false, JSON.stringify(live)); assert.equal(readFileSync(unrelated, "utf8"), "live");
  assert.equal((await f.call("write", { path: join(cwd, "destination"), content: "still available" }, "destination-write")).isError, false);
});

let afterLink: (() => void) | undefined;
const originalLink = fs.link;
mock.method(fs, "link", async function(...args: Parameters<typeof fs.link>) { await originalLink(...args); afterLink?.(); });
syncBuiltinESMExports();
after(() => { afterLink = undefined; mock.restoreAll(); syncBuiltinESMExports(); });
for (const status of ["succeeded", "partial", "state_unknown", "failed_no_change"]) test(`R3 authoritative native receipt state ${status}`, async t => {
  const f = await mutationFixture(t), cwd = realpathSync.native(f.cwd);
  const source = join(cwd, "@@name"), destination = join(cwd, "@destination"), other = join(cwd, "@name");
  writeFileSync(source, "same"); writeFileSync(other, "other");
  await f.call("read", { path: source }, "source-read"); await f.call("read", { path: other }, "other-read");
  if (status === "partial") afterLink = () => f.agent.abort();
  t.after(() => { afterLink = undefined; });
  f.onRecord(data => {
    if (status === "failed_no_change" && data.phase === "intent") writeFileSync(destination, "racer");
    if (status === "state_unknown" && data.phase === "result") throw new Error("injected receipt failure");
  });
  const input = { operations: [{ operation: "move", path: "@@name", destination: "./@destination" }] };
  const result = await f.call("file_batch", input, "state"); afterLink = undefined; f.onRecord(() => {});
  assert.equal((result.details as any).items[0].status, status, JSON.stringify(result));
  assert.equal(existsSync(source), status === "partial" || status === "failed_no_change");
  assert.equal(readFileSync(destination, "utf8"), status === "failed_no_change" ? "racer" : "same");
  if (!existsSync(source)) writeFileSync(source, "same");
  const branch = SessionManager.open(f.session.getSessionFile()!).getBranch();
  const receipts = collectStructuredMutationReceipts(branch).filter((r: any) => r.toolCallId === "state");
  assert.equal(receipts.length, 1); assert.equal(receipts[0].status, status);
  const restored = new MutationWriteGuard(); await restoreMutationEvidenceFromBranch(restored, cwd, branch);
  for (const guard of [restored]) {
    if (status === "failed_no_change") assert.equal((await guard.write(cwd, source, "replayed", 999)).ok, true);
    else await assert.rejects(guard.write(cwd, source, "replayed", 999), /READ_REQUIRED/);
    assert.equal((await guard.write(cwd, other, "other restored", 999)).ok, true);
  }
  writeFileSync(source, "same"); writeFileSync(other, "other");
  const live = await f.call("write", { path: source, content: "live" }, "write-source");
  assert.equal(live.isError, status !== "failed_no_change", JSON.stringify(live));
  assert.equal((await f.call("write", { path: other, content: "other live" }, "write-other")).isError, false);
});
test("R3 malformed or unpaired native targets cannot invalidate unrelated evidence", async t => {
  const f = await mutationFixture(t), cwd = realpathSync.native(f.cwd), other = join(cwd, "other");
  writeFileSync(other, "before"); await f.call("read", { path: other }, "read");
  const guard = new MutationWriteGuard(); await restoreMutationEvidenceFromBranch(guard, cwd, f.session.getBranch());
  const input = { operations: [{ operation: "delete", path: "@name" }] };
  await recordBatchMutationEvidence(guard, cwd, input, { items: [{ itemId: "fake:0", operation: "delete", target: other, status: "succeeded", stateChanged: true }] }, "fake", 100, f.session.getBranch());
  assert.equal((await guard.write(cwd, other, "after", 101)).ok, true);
});
