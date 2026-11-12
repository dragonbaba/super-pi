import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import { join } from "node:path";
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
