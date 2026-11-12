import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, readFile, lstat, open, symlink, readdir, link, chmod } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { writeFileSync, lstatSync, renameSync, symlinkSync } from "node:fs";
import fsPromises from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { removeOwnedFixture } from "./helpers/owned-fixture-cleanup.ts";
import { capturePathIdentity, prepareTree, executeTree, writeIdentityTo, hashIdentity, boundedReason } from "../packages/coding-agent/src/core/files/file-tree-core.mjs";
import { commitPreparedFile, FileCommitError, type FileCommitStream } from "../packages/coding-agent/src/core/files/file-commit.ts";
import { selectCommitMetadata } from "../packages/coding-agent/src/core/files/file-commit-metadata.ts";
import { disposeNativeFileWorker } from "../packages/coding-agent/src/core/files/native-file-client.ts";

async function fixture(t: any) {
  const root = await mkdtemp(join(tmpdir(), "sp-tree-v3-"));
  t.after(async () => { await disposeNativeFileWorker(); removeOwnedFixture(root); });
  const source = join(root, "source"), destination = join(root, "destination");
  return { root, source, destination };
}
const current = () => {};

for (const boundary of ["parent", "canonical"] as const) test(`delete retains a replacement during its final ${boundary} check`, async t => {
  const f = await fixture(t); await writeFile(f.source, "prepared");
  const tree = await prepareTree(await capturePathIdentity(f.source), "delete"), parent = await capturePathIdentity(f.root);
  const originalStat = fsPromises.lstat, originalRealpath = fsPromises.realpath;
  let parentChecks = 0, sourceChecks = 0, injected = false;
  function replace() { renameSync(f.source, f.source + ".retained"); writeFileSync(f.source, "unprepared"); injected = true; }
  t.mock.method(fsPromises, "lstat", async (path: any, ...args: any[]) => {
    const stat = await (originalStat as any)(path, ...args);
    if (path === f.root && ++parentChecks === 2 && boundary === "parent") replace();
    return stat;
  });
  t.mock.method(fsPromises, "realpath", async (path: any, ...args: any[]) => {
    const canonical = await (originalRealpath as any)(path, ...args);
    if (path === f.source && ++sourceChecks === 2 && boundary === "canonical") replace();
    return canonical;
  });
  syncBuiltinESMExports(); t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const result = await executeTree(tree, "delete", parent, undefined, undefined, current);
  assert(injected); assert.equal(result.status, "failed_no_change", JSON.stringify(result)); assert.equal(result.stateChanged, false);
  assert.equal(await readFile(f.source, "utf8"), "unprepared"); assert.equal(await readFile(f.source + ".retained", "utf8"), "prepared");
});

test("POSIX tree moves retain private and executable access modes", { skip: process.platform === "win32" }, async t => {
  const f = await fixture(t), parent = await capturePathIdentity(f.root);
  await mkdir(f.source); await chmod(f.source, 0o700);
  await writeFile(join(f.source, "executable"), "executable"); await chmod(join(f.source, "executable"), 0o751);
  let observedPrivate = false;
  const originalOpen = fsPromises.open;
  t.mock.method(fsPromises, "open", async (path: any, ...args: any[]) => {
    if (path === join(f.destination, "executable") && args[0] === "wx+") {
      assert.equal((await lstat(f.destination)).mode & 0o777, 0o700); observedPrivate = true;
    }
    return (originalOpen as any)(path, ...args);
  });
  syncBuiltinESMExports(); t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const tree = await prepareTree(await capturePathIdentity(f.source), "move");
  const moved = await executeTree(tree, "move", parent, f.destination, parent, current, undefined, true);
  assert.equal(moved.status, "succeeded", JSON.stringify(moved)); assert(observedPrivate);
  assert.equal((await lstat(f.destination)).mode & 0o777, 0o700); assert.equal((await lstat(join(f.destination, "executable"))).mode & 0o777, 0o751);
  await writeFile(f.source, "private"); await chmod(f.source, 0o600);
  const file = await executeTree(await prepareTree(await capturePathIdentity(f.source), "move"), "move", parent, f.destination + "-file", parent, current, undefined, true);
  assert.equal(file.status, "succeeded", JSON.stringify(file)); assert.equal((await lstat(f.destination + "-file")).mode & 0o777, 0o600);
});

for (const copyMove of [false, true]) for (const replacement of [false, true]) test(`final source deletion retains destination-check drift, copyMove=${copyMove}, replacement=${replacement}`, async t => {
  const f = await fixture(t); await writeFile(f.source, "original");
  const tree = await prepareTree(await capturePathIdentity(f.source), "move"), parent = await capturePathIdentity(f.root), originalStat = fsPromises.lstat, originalOpen = fsPromises.open;
  let copiedHandleClosed = false, injected = false;
  t.mock.method(fsPromises, "open", async (path: any, ...args: any[]) => {
    const handle = await (originalOpen as any)(path, ...args);
    if (path === f.destination && args[0] === "wx+") {
      const close = handle.close.bind(handle);
      t.mock.method(handle, "close", async () => { await close(); copiedHandleClosed = true; });
    }
    return handle;
  });
  t.mock.method(fsPromises, "lstat", async (path: any, ...args: any[]) => {
    const stat = await (originalStat as any)(path, ...args);
    if (path === f.destination && !injected && (!copyMove || copiedHandleClosed)) {
      if (replacement) renameSync(f.source, f.source + ".retained");
      writeFileSync(f.source, "new source"); injected = true;
    }
    return stat;
  });
  syncBuiltinESMExports(); t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const result = await executeTree(tree, "move", parent, f.destination, parent, current, undefined, copyMove);
  assert(injected); assert.equal(result.status, "partial", JSON.stringify(result)); assert.equal(result.requiresVerification, true);
  assert.equal(await readFile(f.source, "utf8"), "new source");
  assert.equal(await readFile(f.destination, "utf8"), replacement || copyMove ? "original" : "new source");
});

test("copy checks the newly opened destination parent before writing source bytes", async t => {
  const f = await fixture(t), parentPath = join(f.root, "parent"), outside = join(f.root, "unapproved"), destination = join(parentPath, "target");
  await mkdir(parentPath); await mkdir(outside); await writeFile(f.source, "private source");
  const tree = await prepareTree(await capturePathIdentity(f.source), "copy"), sourceParent = await capturePathIdentity(f.root), parent = await capturePathIdentity(parentPath);
  const originalOpen = fsPromises.open; let injected = false;
  t.mock.method(fsPromises, "open", async (path: any, ...args: any[]) => {
    if (path === destination && args[0] === "wx+") {
      renameSync(parentPath, parentPath + ".original"); symlinkSync(outside, parentPath, process.platform === "win32" ? "junction" : "dir"); injected = true;
    }
    return (originalOpen as any)(path, ...args);
  });
  syncBuiltinESMExports(); t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const result = await executeTree(tree, "copy", sourceParent, destination, parent, current);
  assert(injected); assert.equal(result.status, "partial");
  assert.equal(await readFile(join(outside, "target"), "utf8"), "", "Redirected target must receive no source bytes");
  assert.equal(await readFile(f.source, "utf8"), "private source");
});

test("copy accepts a lexical destination alias to its pinned canonical parent", async t => {
  const f = await fixture(t), parent = join(f.root, "parent"), alias = join(f.root, "alias");
  await mkdir(parent); await symlink(parent, alias, process.platform === "win32" ? "junction" : "dir"); await writeFile(f.source, "source");
  const tree = await prepareTree(await capturePathIdentity(f.source), "copy");
  const result = await executeTree(tree, "copy", await capturePathIdentity(f.root), join(alias, "target"), await capturePathIdentity(parent), current);
  assert.equal(result.status, "succeeded", JSON.stringify(result)); assert.equal(await readFile(join(parent, "target"), "utf8"), "source");
});

for (const operation of ["copy", "move"] as const) test(`directory ${operation} refuses a redirected mkdir parent before populating children`, async t => {
  const f = await fixture(t), parentPath = join(f.root, "parent"), outside = join(f.root, "unapproved"), destination = join(parentPath, "target");
  await mkdir(f.source); await mkdir(parentPath); await mkdir(outside); await writeFile(join(f.source, "private"), "private source");
  const tree = await prepareTree(await capturePathIdentity(f.source), operation), sourceParent = await capturePathIdentity(f.root), parent = await capturePathIdentity(parentPath);
  const originalMkdir = fsPromises.mkdir; let injected = false;
  t.mock.method(fsPromises, "mkdir", async (path: any, ...args: any[]) => {
    if (path === destination) {
      renameSync(parentPath, parentPath + ".original"); symlinkSync(outside, parentPath, process.platform === "win32" ? "junction" : "dir"); injected = true;
    }
    return (originalMkdir as any)(path, ...args);
  });
  syncBuiltinESMExports(); t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const result = await executeTree(tree, operation, sourceParent, destination, parent, current, undefined, true);
  assert(injected); assert.equal(result.status, "partial", JSON.stringify(result)); assert.equal(result.requiresVerification, true);
  assert.deepEqual(await readdir(join(outside, "target")), [], "Redirected directory must receive no source children");
  assert.equal(await readFile(join(f.source, "private"), "utf8"), "private source");
});

test("directory copy reports partial coverage when a new child appears during execution", async t => {
  const f = await fixture(t); await mkdir(f.source); await writeFile(join(f.source, "file"), "original");
  const tree = await prepareTree(await capturePathIdentity(f.source), "copy"), parent = await capturePathIdentity(f.root);
  let introduced = false;
  const check = () => {
    // The original file reaching its destination proves the copy is underway.
    if (!introduced) { try { requireCopyEffect(); } catch { return; } introduced = true; writeFileSync(join(f.source, "new-child"), "external"); }
  };
  function requireCopyEffect() { return lstatSync(join(f.destination, "file")); }
  const result = await executeTree(tree, "copy", parent, f.destination, parent, check);
  assert.equal(introduced, true); assert.equal(result.status, "partial"); assert.equal(result.coverageComplete, false); assert.equal(result.requiresVerification, true);
  assert.equal(await readFile(join(f.source, "new-child"), "utf8"), "external");
});
test("shared tree core copies nested binary files with fixed-buffer verification", async t => {
  const f = await fixture(t);
  await mkdir(join(f.source, "nested"), { recursive: true });
  const bytes = Buffer.alloc(200003, 0x8f);
  await writeFile(join(f.source, "nested", "binary"), bytes);
  await writeFile(join(f.source, "empty"), "");
  const tree = await prepareTree(await capturePathIdentity(f.source), "copy");
  const parent = await capturePathIdentity(f.root);
  const result = await executeTree(tree, "copy", parent, f.destination, parent, current);
  assert.equal(result.status, "succeeded"); assert.equal(result.files, 2); assert.equal(result.bytes, bytes.length);
  assert.deepEqual(await readFile(join(f.destination, "nested", "binary")), bytes);
  assert.deepEqual(await readFile(join(f.source, "nested", "binary")), bytes);
  assert.deepEqual(await readdir(f.destination), ["empty", "nested"]);
});

for (const operation of ["copy", "move"] as const) test(`exclusive ${operation} refuses a raced destination file and directory`, async t => {
  const f = await fixture(t);
  for (const directory of [false, true]) {
    const source = f.source + String(directory), destination = f.destination + String(directory);
    if (directory) { await mkdir(source); await writeFile(join(source, "child"), "source"); }
    else await writeFile(source, "source");
    const tree = await prepareTree(await capturePathIdentity(source), operation);
    if (directory) { await mkdir(destination); await writeFile(join(destination, "sentinel"), "external"); }
    else await writeFile(destination, "external");
    const parent = await capturePathIdentity(f.root);
    const result = await executeTree(tree, operation, parent, destination, parent, current);
    assert.equal(result.status, "failed_no_change"); assert.equal(result.stateChanged, false);
    assert.equal(await readFile(directory ? join(destination, "sentinel") : destination, "utf8"), "external");
    assert.equal(await readFile(directory ? join(source, "child") : source, "utf8"), "source");
  }
});

test("directory move migrates each file and removes source directories nonrecursively", async t => {
  const f = await fixture(t); await mkdir(join(f.source, "nested"), { recursive: true });
  await writeFile(join(f.source, "nested", "file"), "source");
  const tree = await prepareTree(await capturePathIdentity(f.source), "move"), parent = await capturePathIdentity(f.root);
  const result = await executeTree(tree, "move", parent, f.destination, parent, current);
  assert.equal(result.status, "succeeded"); assert.equal(result.files, 1);
  assert.equal(await readFile(join(f.destination, "nested", "file"), "utf8"), "source");
  await assert.rejects(lstat(f.source), { code: "ENOENT" });
});

test("recursive delete unlinks a junction without following its target; copy skips it and move refuses it", async t => {
  const f = await fixture(t); await mkdir(f.source); const outside = join(f.root, "outside"); await mkdir(outside);
  await writeFile(join(outside, "sentinel"), "external"); await writeFile(join(f.source, "own"), "own");
  await symlink(outside, join(f.source, "junction"), process.platform === "win32" ? "junction" : "dir");
  const source = await capturePathIdentity(f.source), parent = await capturePathIdentity(f.root);
  await assert.rejects(prepareTree(source, "move"), /contains a link/);
  await assert.rejects(prepareTree(source, "delete"), /recursive: true/);
  const copy = await prepareTree(source, "copy"); assert.equal(copy.skippedLinks, 1);
  const copied = await executeTree(copy, "copy", parent, f.destination, parent, current);
  assert.equal(copied.status, "succeeded"); assert.equal(copied.coverageComplete, false);
  assert.deepEqual(await readdir(f.destination), ["own"]);
  const removed = await executeTree(await prepareTree(source, "delete", true), "delete", parent, undefined, undefined, current);
  assert.equal(removed.status, "succeeded"); assert.equal(await readFile(join(outside, "sentinel"), "utf8"), "external");
});

for (const name of [".git", ".sp"]) test(`whole tree preflight refuses nested ${name} before any effects`, async t => {
  const f = await fixture(t); await mkdir(join(f.source, "nested", name), { recursive: true }); await writeFile(join(f.source, "file"), "original");
  for (const operation of ["copy", "move", "delete"] as const) await assert.rejects(prepareTree(await capturePathIdentity(f.source), operation, true), /protected/);
  assert.equal(await readFile(join(f.source, "file"), "utf8"), "original"); await assert.rejects(lstat(f.destination), { code: "ENOENT" });
});

test("a changed prepared file blocks the whole top-level item before creating its destination", async t => {
  const f = await fixture(t); await mkdir(f.source); await writeFile(join(f.source, "file"), "original");
  const tree = await prepareTree(await capturePathIdentity(f.source), "move"), parent = await capturePathIdentity(f.root);
  await writeFile(join(f.source, "file"), "changed");
  const result = await executeTree(tree, "move", parent, f.destination, parent, current);
  assert.equal(result.status, "failed_no_change"); await assert.rejects(lstat(f.destination), { code: "ENOENT" });
});

test("stream copy detects mid-read source mutation and cancellation with source retained", async t => {
  const f = await fixture(t); await writeFile(f.source, Buffer.alloc(200000, 4));
  const source = await capturePathIdentity(f.source), target = await open(f.destination, "wx+");
  let writes = 0;
  const write = target.write.bind(target);
  target.write = (async (...args: any[]) => { const result = await (write as any)(...args); if (++writes === 1) await writeFile(f.source, "changed"); return result; }) as any;
  try { await assert.rejects(writeIdentityTo(source, target, current), /changed|grew/); }
  finally { await target.close(); }
  assert.equal(await readFile(f.source, "utf8"), "changed");
  const aborted = new AbortController(); aborted.abort();
  await assert.rejects(hashIdentity(await capturePathIdentity(f.source), current, aborted.signal), { name: "AbortError" });
});

test("large binary overwrite streams through the real metadata commit owner", async t => {
  const f = await fixture(t), bytes = Buffer.alloc(3 * 1024 * 1024 + 17, 0xa7);
  await writeFile(f.source, bytes); await writeFile(f.destination, "old");
  const alias = join(f.root, "alias"); await symlink(f.root, alias, process.platform === "win32" ? "junction" : "dir");
  const source = await capturePathIdentity(f.source), destination = await capturePathIdentity(join(alias, "destination"));
  const digest = await hashIdentity(source), before = createHash("sha256").update("old").digest("hex");
  const stream: FileCommitStream = { byteLength: bytes.length, sha256: digest,
    async writeTo(handle, hooks) { assert.equal(await writeIdentityTo(source, handle, hooks.assertCurrent, hooks.signal), digest); } };
  const plan = { target: destination, parent: await capturePathIdentity(f.root), previousSha256: before, metadata: await selectCommitMetadata(destination) };
  const result = await commitPreparedFile(plan, stream, { assertPathAllowed: async () => destination.canonical, assertCurrent: current });
  assert.equal(result.outcome, "committed"); assert.equal(result.fileSynced, true);
  assert.deepEqual(await readFile(f.destination), bytes); assert.deepEqual(await readFile(f.source), bytes);
  assert.deepEqual((await readdir(f.root)).sort(), ["alias", "destination", "source"]);
});

test("a lying stream cannot publish a staged candidate and reports in-place writes conservatively", async t => {
  const f = await fixture(t); await writeFile(f.destination, "old");
  const destination = await capturePathIdentity(f.destination), metadata = await selectCommitMetadata(destination);
  const stream: FileCommitStream = { byteLength: 3, sha256: createHash("sha256").update("new").digest("hex"), async writeTo(handle) { await handle.writeFile("bad"); } };
  const plan = { target: destination, parent: await capturePathIdentity(f.root), previousSha256: createHash("sha256").update("old").digest("hex"), metadata };
  await assert.rejects(commitPreparedFile(plan, stream, { assertPathAllowed: async () => destination.canonical }), error => {
    assert(error instanceof FileCommitError); assert.equal(error.receipt.outcome, metadata.strategy === "staged_replace" ? "not_committed" : "committed"); return true;
  });
  assert.equal(await readFile(f.destination, "utf8"), metadata.strategy === "staged_replace" ? "old" : "bad");
});

test("failure reasons obey UTF-8 byte budgets without splitting surrogate pairs", () => {
  const result = boundedReason("𠮷".repeat(800)); assert.equal(Buffer.byteLength(result), 800); assert.equal(result.length, 400);
});

for (const operation of ["copy", "move", "delete"] as const) test(`one directory ${operation} handles its own regular-file hardlink aliases`, async t => {
  const f = await fixture(t); await mkdir(f.source); await writeFile(join(f.source, "a"), "shared"); await link(join(f.source, "a"), join(f.source, "b"));
  const source = await capturePathIdentity(f.source), parent = await capturePathIdentity(f.root), tree = await prepareTree(source, operation, true);
  const result = await executeTree(tree, operation, parent, operation === "delete" ? undefined : f.destination, operation === "delete" ? undefined : parent, current);
  assert.equal(result.status, "succeeded", JSON.stringify(result)); assert.equal(result.files, 2);
  if (operation !== "delete") for (const name of ["a", "b"]) assert.equal(await readFile(join(f.destination, name), "utf8"), "shared");
  if (operation !== "copy") await assert.rejects(lstat(f.source), { code: "ENOENT" });
});
