import assert from "node:assert/strict";
import test, { mock } from "node:test";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { mkdirSync, writeFileSync, readFileSync, realpathSync, symlinkSync, unlinkSync, renameSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createJiti } from "jiti";
import { mutationFixture, MutationWriteGuard } from "./helpers/mutation-fixture.ts";
import { SessionManager } from "../packages/coding-agent/src/core/session-manager.ts";
const { restoreMutationEvidenceFromBranch } = await createJiti(import.meta.url).import<any>("../packages/extensions/mutation-guard-write/session-evidence.ts");
for (const change of ["alias", "object"]) test(`read execution to result evidence drift: ${change}`, async t => {
  const f = await mutationFixture(t), cwd = realpathSync.native(f.cwd), alias = join(cwd, "alias"), a = join(cwd, "one/inner/file"), b = join(cwd, "two/inner/file");
  for (const dir of ["one", "two"]) { mkdirSync(join(cwd, dir, "inner"), { recursive: true }); writeFileSync(join(cwd, dir, "inner/file"), "same"); }
  symlinkSync(join(cwd, "one"), alias, process.platform === "win32" ? "junction" : "dir");
  const after = f.agent.afterToolCall!;
  f.agent.afterToolCall = async context => { if (context.toolCall.name === "read") {
    if (change === "alias") { unlinkSync(alias); symlinkSync(join(cwd, "two"), alias, process.platform === "win32" ? "junction" : "dir"); }
    else { renameSync(a, a + "-old"); writeFileSync(a, "same"); }
  } return after(context); };
  const read = await f.call("read", { path: "alias/inner/file" }, "read-drift"); assert.equal(read.isError, false); f.agent.afterToolCall = after;
  if (change === "alias") { unlinkSync(alias); symlinkSync(join(cwd, "one"), alias, process.platform === "win32" ? "junction" : "dir"); }
  const target = change === "alias" ? b : a, branch = SessionManager.open(f.session.getSessionFile()!).getBranch();
  const restored = new MutationWriteGuard(); await restoreMutationEvidenceFromBranch(restored, f.cwd, branch);
  let restoredDenied = false; try { await restored.write(f.cwd, target, "forbidden", 99); } catch { restoredDenied = true; }
  writeFileSync(target, "same");
  const live = await f.call("write", { path: target, content: "forbidden" }, "denied");
  assert.equal(live.isError, true); assert.equal(restoredDenied, true); assert.equal(readFileSync(target, "utf8"), "same");
});
for (const repair of ["number", "markdown", "offset"]) test(`validated read evidence survives reopen: ${repair}`, async t => {
  const f = await mutationFixture(t), cwd = realpathSync.native(f.cwd), path = join(cwd, "123"); writeFileSync(path, "same");
  const args = repair === "number" ? { path: 123 } : repair === "markdown" ? { path: "[123](https://123)" } : { path: "123", offset: 99 };
  const result = await f.call("read", args, "repaired"); assert.equal(result.isError, false, JSON.stringify(result));
  const restored = new MutationWriteGuard(); await restoreMutationEvidenceFromBranch(restored, f.cwd, SessionManager.open(f.session.getSessionFile()!).getBranch());
  assert.equal((await restored.write(f.cwd, path, "after", 99)).ok, true);
});
for (const spelling of ["case", "unicode"]) test(`legacy plain read follows filesystem spelling identity: ${spelling}`, async t => {
  const f = await mutationFixture(t), cwd = realpathSync.native(f.cwd), real = spelling === "case" ? "MiXeD" : "e\u0301", input = spelling === "case" ? "mixed" : "é";
  const path = join(cwd, real); writeFileSync(path, "same");
  if (!existsSync(join(cwd, input))) { t.skip("filesystem distinguishes this spelling"); return; }
  await f.call("read", { path: input }, "legacy");
  const branch = JSON.parse(JSON.stringify(SessionManager.open(f.session.getSessionFile()!).getBranch()));
  for (const entry of branch) if (entry.message?.toolName === "read") { delete entry.message.details.mutationReadEvidence; delete entry.message.details.mutationReadSource; }
  const restored = new MutationWriteGuard(); await restoreMutationEvidenceFromBranch(restored, f.cwd, branch);
  assert.equal((await restored.write(f.cwd, path, "after", 99)).ok, true);
});

for (const change of ["alias", "object"]) test(`descriptor close to snapshot annotation drift: ${change}`, async t => {
  const f = await mutationFixture(t), cwd = realpathSync.native(f.cwd), alias = join(cwd, "alias");
  for (const dir of ["one", "two"]) { mkdirSync(join(cwd, dir, "inner"), { recursive: true }); writeFileSync(join(cwd, dir, "inner/file"), "same\n"); }
  symlinkSync(join(cwd, "one"), alias, process.platform === "win32" ? "junction" : "dir");
  const target = join(cwd, "one/inner/file"), original = fs.open;
  let drifted = false;
  mock.method(fs, "open", async function(...args: Parameters<typeof fs.open>) {
    const handle = await original(...args);
    if (!drifted && String(args[0]) === target) {
      const close = handle.close.bind(handle);
      handle.close = async () => { await close(); if (drifted) return; drifted = true;
        if (change === "alias") { unlinkSync(alias); symlinkSync(join(cwd, "two"), alias, process.platform === "win32" ? "junction" : "dir"); }
        else { renameSync(target, target + "-old"); writeFileSync(target, "same\n"); }
      };
    }
    return handle;
  });
  syncBuiltinESMExports();
  try {
    const result = await f.call("read", { path: "alias/inner/file" }, "before-annotation");
    assert.equal(drifted, true); assert.equal(result.isError, false);
    assert.equal(JSON.stringify(result.content).includes("snapshot="), false);
    assert.equal((result.details as any).mutationReadEvidence.rejected, true);
    for (const dir of ["one", "two"]) assert.equal(readFileSync(join(cwd, dir, "inner/file"), "utf8"), "same\n");
  } finally { mock.restoreAll(); syncBuiltinESMExports(); }
});
