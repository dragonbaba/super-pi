import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import { join, basename } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { removeOwnedFixture } from "./helpers/owned-fixture-cleanup.ts";
import { MxcFilePublication } from "../packages/coding-agent/src/core/files/mxc-file-publication.mjs";
import { capturePathIdentity, hashIdentity } from "../packages/coding-agent/src/core/files/file-tree-core.mjs";
import { SessionManager } from "../packages/coding-agent/src/core/session-manager.ts";
import { FileResultWriter } from "../packages/coding-agent/src/core/files/file-result-store.ts";
import { FileChangesV3 } from "../packages/coding-agent/src/core/files/file-changes-v3.ts";
import { fileChangeObservationTargets, verifyChange, acceptFileChangeObservations } from "../packages/coding-agent/src/core/files/changes.ts";
import { mutationRequestHash, nativeItemRequestHash } from "../packages/coding-agent/src/core/files/file-invocation.ts";

function fixture(t: any, io = fs, content: Uint8Array | string = Buffer.alloc(3 * 1024 * 1024 + 7, 0x97)) {
  const root = fs.realpathSync.native(fs.mkdtempSync(join(tmpdir(), "sp-mxc-copy-"))), source = join(root, "source"), destination = join(root, "destination");
  fs.writeFileSync(source, content); fs.writeFileSync(destination, "old");
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

test("validated v3 changes can observe a real retained MXC candidate while preserving name and parent bounds", async t => {
  const io = Object.create(fs);
  io.renameSync = () => { throw Object.assign(new Error("injected replacement denial"), { code: "EACCES" }); };
  io.unlinkSync = () => { throw Object.assign(new Error("injected cleanup denial"), { code: "EACCES" }); };
  const f = fixture(t, io, "retained private"), source = await capturePathIdentity(f.source), digest = await hashIdentity(source);
  await assert.rejects(f.publication.commitCopy(source, digest), /replacement denial/);
  assert.throws(() => f.publication.dispose(), /cleanup denial/);
  const retained = f.publication.retainedTemporary!; assert.equal(fs.readFileSync(retained, "utf8"), "retained private");
  const session = SessionManager.inMemory(f.root), input = { path: f.source, destination: f.destination, overwrite: true }, id = "retained-copy";
  const callEntryId = session.appendMessage({ role: "assistant", content: [{ type: "toolCall", id, name: "copy", arguments: input }], timestamp: 0 } as any);
  const writer = new FileResultWriter({ callEntryId, toolCallId: id, operation: "copy", requestHash: mutationRequestHash("copy", input), itemCount: 1 },
    (kind, data) => session.appendCustomEntry(kind, data), session);
  t.after(() => writer.dispose());
  const preparation = writer.prepare(0, { operation: "copy", inputHash: nativeItemRequestHash("copy", input, 0), target: f.source, destination: f.destination, overwrite: true });
  writer.ready(); writer.intent(0, preparation);
  const receipt = { operation: "copy", target: f.source, destination: f.destination, status: "failed_no_change", stateChanged: false, requiresVerification: true,
    commit: { strategy: "staged_replace", outcome: "not_committed", fileSynced: false, directorySynced: false, retainedTemporary: retained, cleanupReason: "injected cleanup denial" } };
  writer.commit(receipt); writer.result(0, receipt); const ref = writer.finish(), changes = new FileChangesV3(session); t.after(() => changes.dispose());
  changes.open(ref); const record = changes.nextItems().records[0]; assert.equal(record.receiptVersion, 3);
  const failures: string[] = []; let targets, observation;
  try { targets = fileChangeObservationTargets(record); } catch (error) { failures.push(String(error)); }
  try { observation = await verifyChange(record, async () => {}); } catch (error) { failures.push(String(error)); }
  assert.deepEqual(failures, [], "Both observation scope and actual verification must accept the publication owner's retained name");
  assert.equal(targets!.at(-1)!.path, retained); assert.equal(observation!.temporary!.sha256, digest);
  assert.equal(acceptFileChangeObservations(record, [observation!.source, observation!.destination!, observation!.temporary!]).temporary!.sha256, digest);
  for (const candidate of [join(f.root, "other-parent", basename(retained)), retained + ".other", join(f.root, "arbitrary.tmp")]) {
    assert.throws(() => fileChangeObservationTargets({ ...record, receipt: { ...receipt, commit: { ...receipt.commit, retainedTemporary: candidate } } }), /Retained candidate/);
  }
  assert.throws(() => fileChangeObservationTargets({ ...record, receiptVersion: 2 }), /Retained candidate/);
});
