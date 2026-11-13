import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile, readFile, mkdir, lstat, symlink, realpath, rm } from "node:fs/promises";
import { existsSync, writeFileSync } from "node:fs";
import fsPromises from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { prepareFileCreation, executeFileCreationDirectories, directoryKey } from "../packages/coding-agent/src/core/files/file-creation.ts";
import { capturePathIdentity } from "../packages/coding-agent/src/core/files/native-file-core.ts";
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
for (const operation of ["copy", "move"] as const) for (const depth of [1, 3]) for (const directory of [false, true]) {
  test(`native ${operation} prepares and creates ${depth} missing parents for a ${directory ? "directory" : "file"}`, async t => {
    const root = await fixture(t), source = join(root, "source"), prefix = depth === 1 ? "new" : "new/second/third";
    if (directory) { await mkdir(source); await writeFile(join(source, "payload"), "kept"); }
    else await writeFile(source, "kept");
    const plan = await prepareNativeTreeOperation(root, operation, { path: "source", destination: prefix + "/target" });
    await assert.rejects(lstat(join(root, "new")), { code: "ENOENT" });
    const result = await executeNativeTreePlan(plan, current);
    assert.equal(result.status, "succeeded", JSON.stringify(result));
    assert.equal((result.creation as any).createdDirectories.length, depth);
    assert.equal(await readFile(join(root, prefix, "target", ...(directory ? ["payload"] : [])), "utf8"), "kept");
    if (operation === "move") await assert.rejects(lstat(source), { code: "ENOENT" });
    else assert.equal(await readFile(directory ? join(source, "payload") : source, "utf8"), "kept");
  });
}
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
test("native missing-parent preflight preserves workspace, protected-path and folded containment boundaries", async t => {
  const root = await fixture(t); await mkdir(join(root, "Source")); await writeFile(join(root, "Source/file"), "kept");
  for (const operation of ["copy", "move"] as const) {
    for (const destination of ["../outside-new-parent/target", ".git/missing/target"]) await assert.rejects(prepareNativeTreeOperation(root, operation, { path: "Source", destination }), /POLICY_BLOCKED/);
    await assert.rejects(prepareNativeTreeOperation(root, operation, { path: "Source", destination: "source/new/target" }), /BATCH_CONFLICT/);
  }
  await assert.rejects(lstat(join(root, ".git")), { code: "ENOENT" }); assert.equal(await readFile(join(root, "Source/file"), "utf8"), "kept");
});
test("native cancellation reports retained created parents and permits a fresh independent request", async t => {
  const root = await fixture(t); await writeFile(join(root, "source"), "kept");
  const plan = await prepareNativeTreeOperation(root, "move", { path: "source", destination: "new/deep/target" });
  const controller = new AbortController(), original = fsPromises.mkdir;
  t.mock.method(fsPromises, "mkdir", async (path: any, ...args: any[]) => {
    const result = await original(path, ...args); if (path === join(root, "new")) controller.abort(new Error("fixture cancellation")); return result;
  });
  syncBuiltinESMExports();
  let result;
  try { result = await executeNativeTreePlan(plan, current, controller.signal); }
  finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
  assert.equal(result.status, "partial"); assert.equal(result.stateChanged, true); assert.equal(result.requiresVerification, true);
  assert.equal((result.creation as any).createdDirectories[0].path, join(await realpath(root), "new"));
  assert.equal((result.creation as any).createdDirectories[0].status, "retained");
  assert.equal(await readFile(join(root, "source"), "utf8"), "kept");
  const next = await executeNativeTreePlan(await prepareNativeTreeOperation(root, "copy", { path: "source", destination: "new/recovered" }), current);
  assert.equal(next.status, "succeeded"); assert.equal(await readFile(join(root, "new/recovered"), "utf8"), "kept");
});
test("native missing parents do not change junction copy/skip or move/refusal behavior", async t => {
  const root = await fixture(t); await mkdir(join(root, "source")); await mkdir(join(root, "outside"));
  await writeFile(join(root, "outside/marker"), "outside kept"); await writeFile(join(root, "source/payload"), "kept");
  await symlink(join(root, "outside"), join(root, "source/link"), process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(prepareNativeTreeOperation(root, "move", { path: "source", destination: "move-parent/target" }), /link|symbolic|unsupported/i);
  await assert.rejects(lstat(join(root, "move-parent")), { code: "ENOENT" });
  const result = await executeNativeTreePlan(await prepareNativeTreeOperation(root, "copy", { path: "source", destination: "copy-parent/target" }), current);
  assert.equal(result.status, "succeeded"); assert.equal(result.skippedLinks, 1); assert.equal(result.coverageComplete, false);
  await assert.rejects(lstat(join(root, "copy-parent/target/link")), { code: "ENOENT" }); assert.equal(await readFile(join(root, "outside/marker"), "utf8"), "outside kept");
});
for (const code of ["EIO", "EACCES"]) test(`native parent recovery reports only possible effects for mkdir ${code}`, async t => {
  const root = await realpath(await fixture(t)); await writeFile(join(root, "source"), "kept");
  const plan = await prepareNativeTreeOperation(root, "copy", { path: "source", destination: "new/deep/target" }), original = fsPromises.mkdir;
  t.mock.method(fsPromises, "mkdir", async (path: any, ...args: any[]) => {
    if (path === join(root, "new")) {
      if (code === "EIO") await original(path, ...args);
      throw Object.assign(new Error("fixture ambiguous parent outcome"), { code });
    }
    return original(path, ...args);
  });
  syncBuiltinESMExports();
  let result;
  try { result = await executeNativeTreePlan(plan, current); }
  finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
  assert.equal(result.status, code === "EIO" ? "state_unknown" : "failed_no_change");
  const directories = (result.creation as any).createdDirectories;
  assert.equal(directories.length, code === "EIO" ? 1 : 0);
  if (code === "EIO") { assert.equal(directories[0].path, join(root, "new")); assert.equal(directories[0].status, "retained"); assert.equal(directories[0].identity, undefined); }
  assert.equal(await readFile(join(root, "source"), "utf8"), "kept");
});

test("shared creation rechecks reused parents before a descendant mkdir", async t => {
  const root = await realpath(await fixture(t)), workspace = join(root, "workspace"), outside = join(root, "outside");
  await mkdir(workspace); await mkdir(outside); await writeFile(join(outside, "marker"), "kept");
  const plan = (await prepareFileCreation(join(workspace, "new/deep/target"), true))!, parent = join(workspace, "new");
  await mkdir(parent); const shared = new Map([[directoryKey(parent), await capturePathIdentity(parent)]]);
  const original = fsPromises.lstat; let redirected = false;
  t.mock.method(fsPromises, "lstat", async (path: any, ...args: any[]) => {
    const info = await original(path, ...args);
    if (path === parent && !redirected) {
      redirected = true;
      await fsPromises.rename(parent, join(workspace, "retained-original"));
      await symlink(outside, parent, process.platform === "win32" ? "junction" : "dir");
    }
    return info;
  });
  syncBuiltinESMExports();
  try {
    let failure: unknown;
    try { await executeFileCreationDirectories(plan, async () => plan.canonicalTarget, undefined, shared, current); } catch (error) { failure = error; }
    let outsideCreated = false;
    try { await lstat(join(outside, "deep")); outsideCreated = true; } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    t.diagnostic(JSON.stringify({ redirected, outsideCreated }));
    assert.match(String(failure), /link|STALE_STATE|unsupported|ordinary/i); assert.equal(outsideCreated, false);
  }
  finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
  assert.equal(redirected, true); await assert.rejects(lstat(join(outside, "deep")), { code: "ENOENT" });
  assert.equal(await readFile(join(outside, "marker"), "utf8"), "kept");
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
