import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import { join, basename } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { removeOwnedFixture } from "./helpers/owned-fixture-cleanup.ts";
import { MxcFilePublication } from "../packages/coding-agent/src/core/files/mxc-file-publication.mjs";
import { capturePathIdentity, hashIdentity } from "../packages/coding-agent/src/core/files/file-tree-core.mjs";

function fixture(t: any, io = fs) {
  const root = fs.mkdtempSync(join(tmpdir(), "sp-mxc-copy-")), source = join(root, "source"), destination = join(root, "destination");
  fs.writeFileSync(source, Buffer.alloc(3 * 1024 * 1024 + 7, 0x97)); fs.writeFileSync(destination, "old");
  const fd = fs.openSync(destination, "r"), before = fs.fstatSync(fd, { bigint: true });
  const publication = new MxcFilePublication(destination, fd, before, createHash("sha256").update("old").digest("hex"), undefined, io);
  t.after(() => { try { publication.dispose(); } finally { removeOwnedFixture(root); } });
  return { root, source, destination, publication };
}
test("controlled copy overwrite streams binary data through the text publication owner", async t => {
  const f = fixture(t), source = await capturePathIdentity(f.source), digest = await hashIdentity(source);
  assert.equal(await f.publication.commitCopy(source, digest), digest);
  assert.equal(f.publication.outcome, "committed"); assert.equal(f.publication.requiresVerification, false);
  assert.deepEqual(fs.readFileSync(f.source), fs.readFileSync(f.destination));
  f.publication.dispose(); assert.deepEqual(f.publication.diagnostics, { sourceHandleRetained: false, candidateHandleRetained: false, metadataRetained: false, ioRetained: false });
  assert.deepEqual(fs.readdirSync(f.root).sort(), ["destination", "source"]);
});

for (const operation of ["copy", "text"] as const) for (const boundary of ["parent", "candidate"] as const) test(`controlled ${operation} checks ${boundary} at candidate open before writing private bytes`, { skip: boundary === "parent" && process.platform === "win32" }, async t => {
  const root = fs.realpathSync.native(fs.mkdtempSync(join(tmpdir(), "sp-mxc-open-"))), parent = join(root, "parent"), outside = join(root, "unapproved"), sourcePath = join(root, "source");
  fs.mkdirSync(parent); fs.mkdirSync(outside); fs.writeFileSync(sourcePath, "private source"); fs.writeFileSync(join(parent, "target"), "old");
  const io = Object.create(fs), publications: MxcFilePublication[] = []; let injected = false;
  t.after(() => { for (const owner of publications) { try { owner.dispose(); } catch { /* Retained empty candidate belongs to this exact fixture. */ } } removeOwnedFixture(root); });
  io.openSync = (path: string, flags: any, ...args: any[]) => {
    if (!injected && flags === "wx+" && path.includes(".superpi-write-")) {
      if (boundary === "parent") { fs.renameSync(parent, parent + ".original"); fs.symlinkSync(outside, parent, "dir"); injected = true; }
      else {
        const fd = (fs.openSync as any)(path, flags, ...args);
        try { fs.renameSync(path, join(outside, basename(path))); injected = true; return fd; }
        catch (error) { fs.closeSync(fd); throw error; }
      }
    }
    return (fs.openSync as any)(path, flags, ...args);
  };
  function create() { const target = join(parent, "target"), fd = fs.openSync(target, "r"); const owner = new MxcFilePublication(target, fd, fs.fstatSync(fd, { bigint: true }), createHash("sha256").update("old").digest("hex"), undefined, io); publications.push(owner); return owner; }
  const owner = create(), source = await capturePathIdentity(sourcePath), digest = await hashIdentity(source);
  const expectedFailure = /parent|candidate|ENOENT/i;
  if (operation === "copy") await assert.rejects(owner.commitCopy(source, digest), expectedFailure);
  else assert.throws(() => owner.commitText("private text"), expectedFailure);
  assert(injected); const retained = fs.readdirSync(outside); assert.equal(retained.length, 1);
  assert.equal(fs.readFileSync(join(outside, retained[0]!)).length, 0, "Redirected candidate must contain no private bytes");
  assert.equal(fs.readFileSync(sourcePath, "utf8"), "private source");
  assert.throws(() => owner.dispose(), /ownership changed|ENOENT/); assert.equal(owner.requiresVerification, true);
  assert.deepEqual(owner.diagnostics, { sourceHandleRetained: false, candidateHandleRetained: false, metadataRetained: false, ioRetained: false });
  if (boundary === "parent") { fs.unlinkSync(parent); fs.renameSync(parent + ".original", parent); }
  const next = create();
  if (operation === "copy") assert.equal(await next.commitCopy(source, digest), digest);
  else next.commitText("private text");
  assert.equal(next.outcome, "committed"); next.dispose();
  assert.equal(fs.readFileSync(join(parent, "target"), "utf8"), operation === "copy" ? "private source" : "private text");
});
test("changed source bytes never publish a stale prepared copy candidate", async t => {
  const io = Object.create(fs); let sourcePath = "", writes = 0;
  io.writeSync = (...args: any[]) => { const result = (fs.writeSync as any)(...args); if (++writes === 1) fs.writeFileSync(sourcePath, "changed"); return result; };
  const f = fixture(t, io); sourcePath = f.source;
  const source = await capturePathIdentity(f.source), digest = await hashIdentity(source);
  await assert.rejects(f.publication.commitCopy(source, digest), /changed|grew/);
  assert.equal(f.publication.outcome, "not_committed"); assert.equal(fs.readFileSync(f.destination, "utf8"), "old");
  f.publication.dispose(); assert.deepEqual(fs.readdirSync(f.root).sort(), ["destination", "source"]);
});
test("post-publication replacement withholds a successor hash and retains verification state", async t => {
  const io = Object.create(fs);
  io.renameSync = (from: string, to: string) => { fs.renameSync(from, to); fs.writeFileSync(to, "external"); };
  const f = fixture(t, io), source = await capturePathIdentity(f.source), digest = await hashIdentity(source);
  await assert.rejects(f.publication.commitCopy(source, digest), /Published file/);
  assert.equal(f.publication.outcome, "committed"); assert.equal(f.publication.requiresVerification, true);
  assert.equal(fs.readFileSync(f.destination, "utf8"), "external");
  f.publication.dispose(); assert.equal(f.publication.diagnostics.ioRetained, false);
});
