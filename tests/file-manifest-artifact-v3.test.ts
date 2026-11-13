import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, realpath, readFile, appendFile, rename, writeFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { removeOwnedFixture } from "./helpers/owned-fixture-cleanup.ts";
import { ManifestArtifactWriter, visitManifestArtifact, releaseManifestArtifact, createOwnedManifestFile, releaseOwnedManifestFile } from "../packages/coding-agent/src/core/files/file-manifest-artifact.mjs";
import { FILE_MANIFEST_RECORD_BYTES } from "../packages/coding-agent/src/core/files/file-operation-limits.mjs";

const name = "a".repeat(32) + "-0.manifest";

test("failed attached writer leaves its assigned artifact for host cleanup and the next invocation", async t => {
  const root = await fixture(t), owned = await createOwnedManifestFile(root, name), writer = await ManifestArtifactWriter.attach(root, owned);
  assert.throws(() => writer.append({ payload: "x".repeat(FILE_MANIFEST_RECORD_BYTES) }), /record budget/);
  await writer.dispose();
  assert.deepEqual(await readdir(root), [name]); await releaseOwnedManifestFile(root, owned);
  const next = await createOwnedManifestFile(root, name), replacement = await ManifestArtifactWriter.attach(root, next);
  replacement.append({ payload: "next invocation" }); await replacement.finish(); await replacement.dispose();
  await releaseOwnedManifestFile(root, next); assert.deepEqual(await readdir(root), []);
});
async function fixture(t: any) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "sp-manifest-v3-")));
  t.after(() => removeOwnedFixture(root)); return root;
}
class Visitor {
  count = 0;
  readonly expected: string;
  constructor(expected: string) { this.expected = expected; }
  onManifestRecord(record: any, index: number) { assert.equal(record.index, index); assert.equal(record.payload, this.expected); this.count++; }
}

test("host assigns artifact identity before worker preparation and can release unacknowledged output exactly", async t => {
  const root = await fixture(t), owned = await createOwnedManifestFile(root, name);
  const writer = await ManifestArtifactWriter.attach(root, owned); writer.append({ index: 0, payload: "prepared" });
  const artifact = await writer.finish(); assert.equal(artifact.device, owned.device); assert.equal(artifact.inode, owned.inode);
  await writer.dispose();
  await assert.rejects(ManifestArtifactWriter.attach(root, owned), /already consumed/);
  // The host can clean this exact preassigned object even if the finished reply was lost.
  await releaseOwnedManifestFile(root, owned); assert.deepEqual(await readdir(root), []);
});

test("host-owned empty artifact replacement is retained rather than accepted or deleted", async t => {
  const root = await fixture(t), owned = await createOwnedManifestFile(root, name);
  await rename(join(root, name), join(root, "original")); await writeFile(join(root, name), "replacement");
  await assert.rejects(ManifestArtifactWriter.attach(root, owned), /changed/);
  await assert.rejects(releaseOwnedManifestFile(root, owned), /ownership changed/);
  assert.equal(await readFile(join(root, name), "utf8"), "replacement");
});
test("temporary manifests stream >2 MiB of Unicode rows without a whole-file result copy", async t => {
  const root = await fixture(t), payload = "汉\\\"".repeat(240), writer = await ManifestArtifactWriter.create(root, name);
  for (let index = 0; index < 2000; index++) writer.append({ index, payload });
  const descriptor = await writer.finish(); assert(descriptor.bytes > 2 * 1024 * 1024);
  const visitor = new Visitor(payload);
  assert.equal(await visitManifestArtifact(root, name, descriptor, visitor), 2000); assert.equal(visitor.count, 2000);
  assert.equal(writer.diagnostics.handleRetained, false); assert.equal(writer.diagnostics.hashRetained, false);
  await writer.dispose(); // Publication transferred the exact descriptor to its invocation owner.
  assert.equal((await readdir(root)).length, 1);
  await releaseManifestArtifact(root, name, descriptor); assert.deepEqual(await readdir(root), []);
});
test("artifact readers reject changed size, changed identity and unassigned paths", async t => {
  const root = await fixture(t), writer = await ManifestArtifactWriter.create(root, name); writer.append({ index: 0, payload: "data" });
  const descriptor = await writer.finish();
  await appendFile(join(root, name), " ");
  await assert.rejects(visitManifestArtifact(root, name, descriptor, new Visitor("data")), /identity changed/);
  await rename(join(root, name), join(root, "owned-original")); await writeFile(join(root, name), "external replacement");
  await assert.rejects(releaseManifestArtifact(root, name, descriptor), /ownership changed/);
  assert.equal(await readFile(join(root, name), "utf8"), "external replacement");
  await assert.rejects(ManifestArtifactWriter.create(root, "../arbitrary"), /not assigned/);
});
test("oversized/aborted preparation poisons and removes only its recorded private file", async t => {
  const root = await fixture(t), writer = await ManifestArtifactWriter.create(root, name);
  assert.throws(() => writer.append({ payload: "x".repeat(FILE_MANIFEST_RECORD_BYTES) }), /record budget/);
  assert.throws(() => writer.append({ payload: "after failure" }), /failed/);
  await writer.dispose(); assert.deepEqual(await readdir(root), []);
  assert.equal(writer.diagnostics.handleRetained, false); assert.equal(writer.diagnostics.authorityRetained, false);
  const abort = new AbortController(), cancelled = await ManifestArtifactWriter.create(root, name, undefined, abort.signal);
  abort.abort(); assert.throws(() => cancelled.append({ payload: "cancelled" }), { name: "AbortError" });
  await cancelled.dispose(); assert.deepEqual(await readdir(root), []);
});
test("cancellation and visitor failures close a manifest read without accepting remaining rows", async t => {
  const root = await fixture(t), writer = await ManifestArtifactWriter.create(root, name);
  for (let index = 0; index < 100; index++) writer.append({ index, payload: "data" });
  const descriptor = await writer.finish(), abort = new AbortController(); let count = 0;
  await assert.rejects(visitManifestArtifact(root, name, descriptor, { onManifestRecord() { count++; abort.abort(); } }, undefined, abort.signal), { name: "AbortError" });
  assert.equal(count, 1);
  await assert.rejects(visitManifestArtifact(root, name, descriptor, { onManifestRecord() { throw new Error("visitor failed"); } }), /visitor failed/);
  await releaseManifestArtifact(root, name, descriptor); assert.deepEqual(await readdir(root), []);
});
