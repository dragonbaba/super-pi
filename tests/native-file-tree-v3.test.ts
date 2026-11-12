import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile, readFile, mkdir, lstat, symlink, realpath, rm } from "node:fs/promises";
import { existsSync, writeFileSync } from "node:fs";
import { join, dirname, resolve, relative, isAbsolute } from "node:path";
import { tmpdir } from "node:os";
import { removeOwnedFixture } from "./helpers/owned-fixture-cleanup.ts";
import { prepareNativeTreeOperation, executeNativeTreePlan } from "../packages/coding-agent/src/core/files/native-file-tree.ts";
import { disposeNativeFileWorker } from "../packages/coding-agent/src/core/files/native-file-client.ts";

async function fixture(t: any) {
  const root = await mkdtemp(join(tmpdir(), "sp-native-tree-"));
  t.after(async () => { await disposeNativeFileWorker(); removeOwnedFixture(root); });
  return root;
}
const current = () => {};
test("native tree owner supports recursive copy/move/delete with v3 outcomes", async t => {
  const root = await fixture(t); await mkdir(join(root, "source", "nested"), { recursive: true }); await writeFile(join(root, "source", "nested", "file"), "data");
  const copied = await executeNativeTreePlan(await prepareNativeTreeOperation(root, "copy", { path: "source", destination: "copied" }), current);
  assert.equal(copied.status, "succeeded"); assert.equal(copied.mutationReceiptVersion, 3); assert.equal(copied.files, 1);
  const moved = await executeNativeTreePlan(await prepareNativeTreeOperation(root, "move", { path: "copied", destination: "moved" }), current);
  assert.equal(moved.status, "succeeded"); assert.equal(await readFile(join(root, "moved", "nested", "file"), "utf8"), "data");
  const removed = await executeNativeTreePlan(await prepareNativeTreeOperation(root, "delete", { path: "moved", recursive: true }), current);
  assert.equal(removed.status, "succeeded"); await assert.rejects(lstat(join(root, "moved")), { code: "ENOENT" });
  assert.equal(await readFile(join(root, "source", "nested", "file"), "utf8"), "data");
});
test("native copy overwrite uses its pinned destination and source digest", async t => {
  const root = await fixture(t); await writeFile(join(root, "source"), Buffer.alloc(1024 * 1024 + 13, 0x91)); await writeFile(join(root, "target"), "old");
  await assert.rejects(prepareNativeTreeOperation(root, "copy", { path: "source", destination: "target" }), /destination_exists/);
  const plan = await prepareNativeTreeOperation(root, "copy", { path: "source", destination: "target", overwrite: true });
  const result = await executeNativeTreePlan(plan, current);
  assert.equal(result.status, "succeeded"); assert.equal((result.commit as any).outcome, "committed");
  assert.deepEqual(await readFile(join(root, "source")), await readFile(join(root, "target")));
});
test("native overwrite refuses a changed source or destination after preparation", async t => {
  const root = await fixture(t); await writeFile(join(root, "source"), "source"); await writeFile(join(root, "target"), "old");
  let plan = await prepareNativeTreeOperation(root, "copy", { path: "source", destination: "target", overwrite: true });
  await writeFile(join(root, "source"), "changed source");
  let result = await executeNativeTreePlan(plan, current); assert.equal(result.status, "failed_no_change"); assert.equal(await readFile(join(root, "target"), "utf8"), "old");
  plan = await prepareNativeTreeOperation(root, "copy", { path: "source", destination: "target", overwrite: true });
  await writeFile(join(root, "target"), "external");
  result = await executeNativeTreePlan(plan, current); assert.equal(result.status, "failed_no_change"); assert.equal(await readFile(join(root, "target"), "utf8"), "external");
});
test("native preflight rejects source containment, protected descendants and directory overwrite", async t => {
  const root = await fixture(t); await mkdir(join(root, "source")); await writeFile(join(root, "source", "file"), "data"); await mkdir(join(root, "target"));
  await assert.rejects(prepareNativeTreeOperation(root, "copy", { path: "source", destination: "source/child" }), /CONFLICT/);
  await assert.rejects(prepareNativeTreeOperation(root, "copy", { path: "source", destination: "target", overwrite: true }), /destination_exists/);
  await mkdir(join(root, "source", ".git"));
  await assert.rejects(prepareNativeTreeOperation(root, "delete", { path: "source", recursive: true }), /protected/);
  assert.equal(await readFile(join(root, "source", "file"), "utf8"), "data");
});
test("native copy refuses symlink overwrite targets and revoked authority", async t => {
  const root = await fixture(t); await writeFile(join(root, "source"), "source"); await mkdir(join(root, "outside"));
  await symlink(join(root, "outside"), join(root, "target"), process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(prepareNativeTreeOperation(root, "copy", { path: "source", destination: "target", overwrite: true }), /unsupported/);
  const plan = await prepareNativeTreeOperation(root, "copy", { path: "source", destination: "new" });
  const result = await executeNativeTreePlan(plan, () => { throw new Error("revoked authority"); });
  assert.equal(result.status, "failed_no_change"); await assert.rejects(lstat(join(root, "new")), { code: "ENOENT" });
});

test("real cross-volume files/directories retain changed and newly added source children", { skip: !process.env.SP_FILE_CROSS_VOLUME_ROOT }, async t => {
  const root = await fixture(t), destinationParent = await realpath(process.env.SP_FILE_CROSS_VOLUME_ROOT!);
  const destinationRoot = await mkdtemp(join(destinationParent, "sp-cross-v3-")), owned = await lstat(destinationRoot, { bigint: true });
  t.after(async () => {
    const resolved = await realpath(destinationRoot), info = await lstat(destinationRoot, { bigint: true }), suffix = relative(destinationParent, resolved);
    assert.equal(dirname(resolved), destinationParent); assert(suffix && suffix !== ".." && !suffix.startsWith("..\\") && !suffix.startsWith("../") && !isAbsolute(suffix));
    assert(!info.isSymbolicLink() && info.dev === owned.dev && info.ino === owned.ino);
    await rm(resolved, { recursive: true });
  });
  assert.notEqual((await lstat(root, { bigint: true })).dev, owned.dev, "probe must use different devices");
  await writeFile(join(root, "single"), Buffer.alloc(100003, 0x93));
  const single = await executeNativeTreePlan(await prepareNativeTreeOperation(root, "move", { path: "single", destination: join(destinationRoot, "single") }), current);
  assert.equal(single.status, "succeeded"); assert.equal((await readFile(join(destinationRoot, "single"))).length, 100003);
  await assert.rejects(lstat(join(root, "single")), { code: "ENOENT" });
  for (const fault of ["none", "new-file", "changed-file"] as const) {
    const source = join(root, fault), destination = join(destinationRoot, fault); await mkdir(source);
    await writeFile(join(source, "a"), "a"); await writeFile(join(source, "z"), "z");
    const plan = await prepareNativeTreeOperation(root, "move", { path: source, destination });
    const files = plan.tree.entries.filter(entry => !entry.identity.directory), first = files[0].identity.path, other = files[1].identity.path;
    let injected = false;
    const result = await executeNativeTreePlan(plan, () => {
      if (fault !== "none" && !injected && !existsSync(first) && existsSync(join(destination, relative(source, first)))) {
        injected = true; writeFileSync(fault === "new-file" ? join(source, "new") : other, "external change");
      }
    });
    assert.equal(result.status, fault === "none" ? "succeeded" : "partial", JSON.stringify(result));
    if (fault === "none") await assert.rejects(lstat(source), { code: "ENOENT" });
    else {
      assert(injected); assert.equal(result.requiresVerification, true);
      assert.equal(await readFile(fault === "new-file" ? join(source, "new") : other, "utf8"), "external change");
      if (fault === "changed-file") await assert.rejects(lstat(resolve(destination, relative(source, other))), { code: "ENOENT" });
    }
  }
});
