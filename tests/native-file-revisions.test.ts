import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Session as InspectorSession } from "node:inspector/promises";
import { setImmediate as tick } from "node:timers/promises";
import test from "node:test";
import { createReadToolDefinition } from "../packages/coding-agent/src/core/tools/read.ts";
import {
  FileRevisions, issueSnapshotForRead, executeSnapshotLineEdit, resetSnapshotLineStore,
  resolveSnapshotCanonicalTarget,
  executePreparedSnapshotMutation,
} from "../packages/coding-agent/src/core/files/snapshot-line-edit.ts";
import { prepareRevisionMutation } from "../packages/coding-agent/src/core/files/revision-mutations.ts";
import { disposeNativeFileWorker } from "../packages/coding-agent/src/core/files/native-file-client.ts";
import { FileCommitError } from "../packages/coding-agent/src/core/files/file-commit.ts";

async function fixture(t: test.TestContext) {
  const parent = await realpath(tmpdir());
  const cwd = await mkdtemp(join(parent, "sp-native-revision-"));
  const path = join(cwd, "file.txt");
  await writeFile(path, "one\r\ntwo\r\n");
  t.after(async () => { await disposeNativeFileWorker(); assert.equal(dirname(cwd), parent); await rm(cwd, { recursive: true }); });
  const read = createReadToolDefinition(cwd);
  async function capture(revisions: FileRevisions) {
    const result = await read.execute("read", { path }, undefined, undefined, {} as never);
    const annotation = await issueSnapshotForRead("session", cwd, { path }, result, revisions);
    assert.ok(annotation);
    const id = /snapshot=(snap_[\w-]+)/u.exec(annotation)![1];
    const first = result.content[0];
    assert.equal(first.type, "text");
    const anchor = /^(1#[A-F0-9]{4})\|/u.exec(first.text)![1];
    return { id, anchor };
  }
  return { cwd, path, read, capture };
}

test("native revisions isolate owners and permit read/edit without a model turn or display", { timeout: 10_000 }, async t => {
  const f = await fixture(t);
  const a = new FileRevisions("session"), b = new FileRevisions("session");
  t.after(() => { a.dispose(); b.dispose(); });
  const first = await f.capture(a), independent = await f.capture(b);
  await assert.rejects(resolveSnapshotCanonicalTarget("session", f.cwd, f.path, first.id, b), /SNAPSHOT_EDIT_UNKNOWN/u);
  await assert.rejects(resolveSnapshotCanonicalTarget("other", f.cwd, f.path, first.id, a), /SNAPSHOT_EDIT_UNKNOWN/u);
  resetSnapshotLineStore(); // Compatibility reset must not revoke a native owner's revisions.
  const hooks = { revisions: a, assertPathAllowed: () => realpath(f.path) };
  const edit = [{ kind: "replace" as const, start: first.anchor, newLines: ["ONE"] }];
  const result = await executeSnapshotLineEdit("session", f.cwd, f.path, first.id, edit, undefined, hooks);
  assert.equal(result.commit.outcome, "committed");
  assert.equal(await readFile(f.path, "utf8"), "ONE\r\ntwo\r\n");
  assert.equal(a.size, 0); assert.equal(a.residentBytes, 0);
  await assert.rejects(executeSnapshotLineEdit("session", f.cwd, f.path, independent.id, edit, undefined,
    { ...hooks, revisions: b }), /SNAPSHOT_EDIT_STALE/u);
});

test("clear/dispose revoke pending captures and precommit revisions while preserving committed outcomes", { timeout: 10_000 }, async t => {
  const f = await fixture(t), revisions = new FileRevisions("session");
  t.after(() => revisions.dispose());
  const read = await f.read.execute("read", { path: f.path }, undefined, undefined, {} as never);
  const pending = issueSnapshotForRead("session", f.cwd, { path: f.path }, read, revisions);
  revisions.clear();
  assert.equal(await pending, undefined); assert.equal(revisions.size, 0);
  for (const phase of ["beforeCommit", "afterCommit"] as const) {
    const source = await f.capture(revisions);
    const error = await executeSnapshotLineEdit("session", f.cwd, f.path, source.id,
      [{ kind: "replace", start: source.anchor, newLines: ["changed"] }], undefined,
      { revisions, assertPathAllowed: () => realpath(f.path), [phase]: () => revisions.clear() }).then(() => undefined, error => error);
    assert.ok(error instanceof FileCommitError);
    assert.equal(error.receipt.outcome, phase === "beforeCommit" ? "not_committed" : "committed");
    assert.equal(await readFile(f.path, "utf8"), phase === "beforeCommit" ? "one\r\ntwo\r\n" : "changed\r\ntwo\r\n");
    assert.equal(revisions.size, 0); assert.equal(revisions.residentBytes, 0);
  }
  revisions.dispose();
  const result = await f.read.execute("read", { path: f.path }, undefined, undefined, {} as never);
  assert.equal(await issueSnapshotForRead("session", f.cwd, { path: f.path }, result, revisions), undefined);
});

test("native exact revisions preserve BOM/mixed endings and reject ambiguity, overlap and stale overwrite", { timeout: 10_000 }, async t => {
  const f = await fixture(t), revisions = new FileRevisions("session");
  t.after(() => revisions.dispose());
  const original = "\uFEFFsame\r\n中文😀\nsame\r\n";
  await writeFile(f.path, original);
  const source = await f.capture(revisions);
  assert.equal(revisions.latest(await realpath(f.path)), source.id);
  await assert.rejects(prepareRevisionMutation(revisions, "session", f.cwd, f.path, source.id,
    { edits: [{ oldText: "same", newText: "changed" }] }), /ambiguous/u);
  await assert.rejects(prepareRevisionMutation(revisions, "session", f.cwd, f.path, source.id,
    { edits: [{ oldText: "中文😀", newText: "changed" }, { oldText: "😀", newText: "other" }] }), /EDIT_OVERLAP/u);
  await assert.rejects(prepareRevisionMutation(revisions, "session", f.cwd, f.path, source.id,
    { edits: [{ oldText: "\ude00", newText: "x" }] }), /EDIT_ENCODING/u);
  await assert.rejects(prepareRevisionMutation(revisions, "session", f.cwd, f.path, source.id,
    { content: "\ud83d" }), /WRITE_ENCODING/u);
  await assert.rejects(prepareRevisionMutation(revisions, "session", f.cwd, f.path, source.id,
    { edits: [{ oldText: "中文😀", newText: "x".repeat(256 * 1024) }] }), /EDIT_SCOPE/u);
  const plan = await prepareRevisionMutation(revisions, "session", f.cwd, f.path, source.id,
    { edits: [{ oldText: "same", newText: "SAME", expectedLine: 3 }, { oldText: "中文😀", newText: "日本語😀" }] });
  const hooks = { revisions, assertPathAllowed: () => realpath(f.path) };
  try { await executePreparedSnapshotMutation(plan, undefined, hooks); }
  finally { plan.byteEdits.length = 0; }
  assert.equal(await readFile(f.path, "utf8"), "\uFEFFsame\r\n日本語😀\nSAME\r\n");
  const current = await f.capture(revisions);
  const replacement = await prepareRevisionMutation(revisions, "session", f.cwd, f.path, current.id, { content: "replacement\n" });
  await writeFile(f.path, "external\n");
  await assert.rejects(executePreparedSnapshotMutation(replacement, undefined, hooks), /SNAPSHOT_EDIT_STALE/u);
  replacement.byteEdits.length = 0;
  assert.equal(await readFile(f.path, "utf8"), "external\n");
  const final = await f.capture(revisions);
  const overwrite = await prepareRevisionMutation(revisions, "session", f.cwd, f.path, final.id, { content: "replacement\n" });
  try { await executePreparedSnapshotMutation(overwrite, undefined, hooks); }
  finally { overwrite.byteEdits.length = 0; }
  assert.equal(await readFile(f.path, "utf8"), "replacement\n");
  assert.equal(revisions.size, 0);
});

test("native window and cursor reads issue bounded revisions; partial windows and forged metadata do not", { timeout: 15_000 }, async t => {
  const f = await fixture(t), revisions = new FileRevisions("session");
  t.after(() => revisions.dispose());
  const references: WeakRef<object>[] = [];
  const inspector = new InspectorSession(); inspector.connect(); t.after(() => inspector.disconnect());
  await inspector.post("HeapProfiler.startSampling", { samplingInterval: 1024, includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true });
  async function exerciseWindows() {
  for (const repetitions of [50_000, 350_000]) {
    const original = "\uFEFFheading\r\n中文😀\r\nnext\r\n" + "filler\r\n".repeat(repetitions);
    await writeFile(f.path, original);
    const input = { path: f.path, offset: 2, limit: 1 };
    const result = await f.read.execute("read", input, undefined, undefined, {} as never);
    assert.ok(result.details?.window?.cursor);
    assert.equal(await issueSnapshotForRead("session", f.cwd, input,
      { content: [...result.content], details: result.details }, revisions), undefined);
    const annotation = await issueSnapshotForRead("session", f.cwd, input, result, revisions);
    assert.ok(annotation); assert.match(annotation, /editable lines=2-2/u);
    const id = /snapshot=(snap_[\w-]+)/u.exec(annotation)![1];
    const source = revisions.get(id)!;
    assert.equal(source.mode, "compact");
    references.push(new WeakRef(source), new WeakRef(source.visibleLines));
    assert.ok(source.residentBytes <= 128 * 1024);
    const continuationInput = { path: f.path, cursor: result.details.window.cursor, limit: 1 };
    const continuation = await f.read.execute("cursor", continuationInput, undefined, undefined, {} as never);
    assert.match((await issueSnapshotForRead("session", f.cwd, continuationInput, continuation, revisions))!, /editable lines=3-3/u);
    const first = result.content[0]; assert.equal(first.type, "text");
    const start = /^(2#[A-F0-9]{4})\|/u.exec(first.text)![1];
    await executeSnapshotLineEdit("session", f.cwd, f.path, id, [{ kind: "replace", start, newLines: ["changed"] }], undefined,
      { revisions, assertPathAllowed: () => realpath(f.path), previewOnly: true });
    assert.equal(await readFile(f.path, "utf8"), original.replace("中文😀", "changed"));
    revisions.clear();
  }
  }
  await exerciseWindows();
  const { profile } = await inspector.post("HeapProfiler.stopSampling");
  let sampled = 0; const nodes = [profile.head];
  while (nodes.length) { const node = nodes.pop()!; sampled += node.selfSize; for (const child of node.children) nodes.push(child); }
  assert.ok(sampled <= 128 * 1024 * 1024, "fixed whole-chain allocation envelope for two window/cursor/edit scenarios");
  for (let i = 0; i < 4; i++) { await tick(); await inspector.post("HeapProfiler.collectGarbage"); }
  assert.equal(references.filter(ref => ref.deref()).length, 0);
  t.diagnostic(JSON.stringify({ windowReads: 4, committedEdits: 2, references: references.length, live: 0, sampledMainThreadBytes: sampled }));
  await writeFile(f.path, "x".repeat(300_000));
  const partial = await f.read.execute("partial", { path: f.path }, undefined, undefined, {} as never);
  assert.equal(partial.details?.window?.partial, true);
  assert.equal(await issueSnapshotForRead("session", f.cwd, { path: f.path }, partial, revisions), undefined);
  for (const emptyContent of ["", "\uFEFF"]) {
  await writeFile(f.path, emptyContent);
  const empty = await f.read.execute("empty", { path: f.path }, undefined, undefined, {} as never);
  const annotation = await issueSnapshotForRead("session", f.cwd, { path: f.path }, empty, revisions);
  assert.match(annotation!, /empty file/u);
  const id = /snapshot=(snap_[\w-]+)/u.exec(annotation!)![1];
  const plan = await prepareRevisionMutation(revisions, "session", f.cwd, f.path, id, { content: "created\n" });
  try { await executePreparedSnapshotMutation(plan, undefined, { revisions, assertPathAllowed: () => realpath(f.path) }); }
  finally { plan.byteEdits.length = 0; }
  assert.equal(await readFile(f.path, "utf8"), "created\n");
  }
});

test("revision capacity and controlled GC release bounded native source ownership", { timeout: 15_000 }, async t => {
  const f = await fixture(t), inspector = new InspectorSession();
  inspector.connect();
  t.after(() => inspector.disconnect());
  async function exercise() {
    const revisions = new FileRevisions("session"), references: WeakRef<object>[] = [new WeakRef(revisions)];
    await inspector.post("HeapProfiler.startSampling", { samplingInterval: 1024, includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true });
    let first = "";
    for (let i = 0; i < 130; i++) {
      const { id } = await f.capture(revisions);
      if (!first) first = id;
      const receipt = revisions.get(id)!;
      references.push(new WeakRef(receipt));
      if (receipt.mode === "full") references.push(new WeakRef(receipt.bytes));
    }
    assert.equal(revisions.size, 128); assert.equal(revisions.get(first), undefined);
    const receipt = revisions.get((await f.capture(revisions)).id)!;
    // Same source, conservative synthetic accounting: verify the independent byte ceiling.
    for (let i = 0; i < 5; i++) revisions.remember({ ...receipt, id: `bounded-${i}`, residentBytes: 2 * 1024 * 1024 }, revisions.generation);
    assert.equal(revisions.residentBytes, 8 * 1024 * 1024); assert.equal(revisions.size, 4);
    revisions.invalidatePath(await realpath(f.path));
    assert.equal(revisions.size, 0); assert.equal(revisions.latest(await realpath(f.path)), undefined);
    for (const change of [{ edits: [{ oldText: "one", newText: "ONE" }] }, { content: "next\n" }]) {
      const source = await f.capture(revisions);
      const plan = await prepareRevisionMutation(revisions, "session", f.cwd, f.path, source.id, change);
      const hooks = { revisions, assertPathAllowed: () => realpath(f.path) };
      references.push(new WeakRef(plan), new WeakRef(plan.receipt), new WeakRef(plan.byteEdits), new WeakRef(hooks));
      for (const edit of plan.byteEdits) references.push(new WeakRef(edit), new WeakRef(edit.replacement));
      try {
        const committed = await executePreparedSnapshotMutation(plan, undefined, hooks);
        references.push(new WeakRef(committed));
        assert.equal(committed.commit.outcome, "committed");
      } finally { plan.byteEdits.length = 0; }
    }
    const { profile } = await inspector.post("HeapProfiler.stopSampling");
    let sampled = 0;
    const nodes = [profile.head];
    while (nodes.length) { const node = nodes.pop()!; sampled += node.selfSize; for (const child of node.children) nodes.push(child); }
    revisions.clear(); assert.equal(revisions.size, 0); assert.equal(revisions.residentBytes, 0);
    revisions.dispose();
    return { references, sampled };
  }
  const { references, sampled } = await exercise();
  assert.ok(sampled <= 133 * 256 * 1024, "fixed main-thread allocation envelope per capture, including two commits");
  for (let i = 0; i < 4; i++) { await tick(); await inspector.post("HeapProfiler.collectGarbage"); }
  assert.equal(references.filter(ref => ref.deref()).length, 0);
  t.diagnostic(JSON.stringify({ captures: 133, commits: 2, receiptLimit: 128, byteLimit: 8 * 1024 * 1024, references: references.length, live: 0, sampledMainThreadBytes: sampled }));
});
