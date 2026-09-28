import assert from "node:assert/strict";
import test, { after, mock } from "node:test";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { writeFileSync, readFileSync, existsSync, realpathSync, mkdirSync, symlinkSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { mutationFixture, MutationWriteGuard } from "./helpers/mutation-fixture.ts";
import { createJiti } from "jiti";
import { SessionManager } from "../packages/coding-agent/src/core/session-manager.ts";
const { restoreMutationEvidenceFromBranch, recordBatchMutationEvidence, collectStructuredMutationReceipts, recentMutationEntries } = await createJiti(import.meta.url).import<any>("../packages/extensions/mutation-guard-write/session-evidence.ts");
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

test("R3/R4 result lookup is bounded before Session branch materialization", async t => {
  const f = await mutationFixture(t);
  for (let i = 0; i < 1024; i++) f.session.appendCustomEntry("synthetic-history", { index: i });
  let lookups = 0; const get = f.session.getEntry.bind(f.session);
  t.mock.method(f.session, "getEntry", function(id: string) { lookups++; return get(id); });
  t.mock.method(f.session, "getBranch", () => { throw new Error("unbounded branch allocation"); });
  const tail = recentMutationEntries(f.session) as any[];
  assert.equal(lookups, 512); assert.equal(tail.length, 512);
  assert.equal(tail[0].data.index, 512); assert.equal(tail.at(-1).data.index, 1023);
});

for (const operation of ["delete", "move"]) test(`R3 alias read cannot gain evidence on reopen after ${operation}`, async t => {
  const f = await mutationFixture(t), cwd = realpathSync.native(f.cwd), alias = join(cwd, "alias"), a = join(cwd, "one/inner/file"), b = join(cwd, "two/inner/file");
  for (const dir of ["one", "two"]) { mkdirSync(join(cwd, dir, "inner"), { recursive: true }); writeFileSync(join(cwd, dir, "inner/file"), "same"); }
  symlinkSync(join(cwd, "one"), alias, process.platform === "win32" ? "junction" : "dir");
  const read = await f.call("read", { path: "alias/inner/file" }, "alias-read");
  assert.equal(read.isError, false); assert.equal((read.details as any).mutationReadEvidence.target, a);
  f.onRecord(data => { if (data.phase === "result") { unlinkSync(alias); symlinkSync(join(cwd, "two"), alias, process.platform === "win32" ? "junction" : "dir"); } });
  assert.equal((await f.call("file_batch", { operations: [{ operation, path: "alias/inner/file", ...(operation === "move" ? { destination: "moved" } : {}) }] }, "alias-native")).isError, false); f.onRecord(() => {});
  assert.equal(existsSync(a), false); assert.equal(readFileSync(b, "utf8"), "same");
  const branch = SessionManager.open(f.session.getSessionFile()!).getBranch();
  assert.equal((await f.call("write", { path: b, content: "forbidden" }, "live-denied")).isError, true);
  const restored = new MutationWriteGuard(); await restoreMutationEvidenceFromBranch(restored, cwd, branch);
  await assert.rejects(restored.write(cwd, b, "forbidden", 99));
  assert.equal(readFileSync(b, "utf8"), "same");
});

for (const alias of [false, true]) for (const legacy of [false, true]) test(`R3 read receipt compatibility alias=${alias}, legacy=${legacy}`, async t => {
  const f = await mutationFixture(t), cwd = realpathSync.native(f.cwd), target = join(cwd, "real/inner/file");
  mkdirSync(join(cwd, "real/inner"), { recursive: true }); writeFileSync(target, "before");
  if (alias) symlinkSync(join(cwd, "real"), join(cwd, "alias"), process.platform === "win32" ? "junction" : "dir");
  const read = await f.call("read", { path: alias ? "alias/inner/file" : "real/inner/file" }, "receipt");
  assert.equal((read.details as any).mutationReadEvidence.target, target);
  const branch = JSON.parse(JSON.stringify(SessionManager.open(f.session.getSessionFile()!).getBranch()));
  if (legacy) for (const entry of branch) if (entry.message?.toolName === "read") delete entry.message.details.mutationReadEvidence;
  const restored = new MutationWriteGuard(); await restoreMutationEvidenceFromBranch(restored, cwd, branch);
  if (alias && legacy) await assert.rejects(restored.write(cwd, target, "after", 99));
  else assert.equal((await restored.write(cwd, target, "after", 99)).ok, true);
});
