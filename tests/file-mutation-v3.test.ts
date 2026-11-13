import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile, mkdir, readFile, lstat } from "node:fs/promises";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SessionManager } from "../packages/coding-agent/src/core/session-manager.ts";
import { FileService } from "../packages/coding-agent/src/core/files/file-service.ts";
import { FileMutation } from "../packages/coding-agent/src/core/files/file-mutation.ts";
import { FileResultReader } from "../packages/coding-agent/src/core/files/file-result-store.ts";
import { FILE_RESULT_ENTRY } from "../packages/coding-agent/src/core/files/file-result-protocol.ts";
import { FILE_RESULT_PAGE_BYTES } from "../packages/coding-agent/src/core/files/file-operation-limits.mjs";
import { FileChangesV3 } from "../packages/coding-agent/src/core/files/file-changes-v3.ts";
import { nativeFileSession } from "./helpers/sandbox-file-session.ts";

async function fixture(t: test.TestContext) {
  const cwd = await mkdtemp(join(tmpdir(), "file-mutation-v3-")); t.after(() => rm(cwd, { recursive: true, force: true }));
  const session = SessionManager.inMemory(cwd), service = new FileService(cwd, session.getSessionId());
  t.after(() => service.dispose());
  return { cwd, session, service,
    mutation(operation: ConstructorParameters<typeof FileMutation>[2], input: unknown, id = "call-1") {
      session.appendMessage({ role: "assistant", content: [{ type: "toolCall", id, name: operation, arguments: input }], timestamp: 0 } as any);
      return new FileMutation(service, id, operation, input);
    } };
}
function current(): void {}
function unexpectedLegacy(): never { throw new Error("v3 must not publish legacy journal records"); }
for (const operation of ["copy", "move"] as const) for (const batch of [false, true]) for (const dryRun of [false, true]) {
  test(`${operation} ${batch ? "file_batch" : "array"} ${dryRun ? "dryRun" : "apply"} rejects missing parents before earlier effects`, async t => {
    const f = await fixture(t); await writeFile(join(f.cwd, "source"), "kept");
    const input = batch ? { dryRun, operations: [
      { operation: "write", path: "missing/seed", mode: "create", content: "first" },
      { operation, path: "source", destination: "missing/target" },
    ] } : { dryRun, items: [{ path: "source", destination: "first" }, { path: "source", destination: "missing/deep/target" }] };
    const mutation = f.mutation(batch ? "file_batch" : operation, input);
    await assert.rejects(mutation.prepare(), /\[destination_parent_missing\]/);
    await assert.rejects(lstat(join(f.cwd, "missing")), { code: "ENOENT" });
    await assert.rejects(lstat(join(f.cwd, "first")), { code: "ENOENT" });
    assert.equal(await readFile(join(f.cwd, "source"), "utf8"), "kept");
  });
}

test("native directory move records its checked copy strategy before effects", async t => {
  const root = await mkdtemp(join(tmpdir(), "directory-strategy-v3-")), f = nativeFileSession(root), definitions: any = {};
  t.after(async () => { await f.close(); await rm(root, { recursive: true, force: true }); }); f.files.install(definitions);
  await mkdir(join(root, "source"), { mode: 0o700 }); await writeFile(join(root, "source/file"), "kept");
  const result = await f.invoke(definitions, "move", { path: "source", destination: "moved" }); assert.equal(result.isError, false, JSON.stringify(result));
  const reader = new FileResultReader(f.manager); t.after(() => reader.dispose()); const page = reader.read(result.details.resultRef);
  const prepared = page.records.find(row => row.record.phase === "prepared")!; assert(prepared);
  assert.equal(prepared.record.moveStrategy, "copy_unlink_verified"); assert.equal((prepared.record.source as any).directory, true);
  assert.equal(await readFile(join(root, "moved/file"), "utf8"), "kept"); await assert.rejects(lstat(join(root, "source")), { code: "ENOENT" });
});

test("bounded native created-parent facts keep complete counts and allow the next batch item", async t => {
  const root = await mkdtemp(join(tmpdir(), "parent-facts-v3-")), f = nativeFileSession(root), definitions: any = {};
  t.after(async () => { await f.close(); await rm(root, { recursive: true, force: true }); }); f.files.install(definitions);
  const existing = Array(24).fill("existing-segment").join("/"); await mkdir(join(root, existing), { recursive: true });
  const target = existing + "/" + Array(32).fill("missing").join("/") + "/target";
  const result = await f.invoke(definitions, "file_batch", { operations: [
    { operation: "write", path: target, mode: "create", content: "kept" },
    { operation: "write", path: "following", mode: "create", content: "next" },
  ] });
  assert.equal(result.isError, false, JSON.stringify({ failed: result.details.failed, unknown: result.details.unknown, notStarted: result.details.notStarted, reason: result.details.reason }));
  assert.equal(result.details.succeeded, 2); assert.equal(result.details.coverageComplete, false);
  assert.equal(result.details.directories, 32); assert.equal(await readFile(join(root, target), "utf8"), "kept");
  assert.equal(await readFile(join(root, "following"), "utf8"), "next");
  const reader = new FileResultReader(f.manager); t.after(() => reader.dispose()); let cursor: string | undefined, found = false;
  do {
    const page = reader.read(result.details.resultRef, cursor); assert(Buffer.byteLength(JSON.stringify(page)) <= FILE_RESULT_PAGE_BYTES);
    for (const row of page.records) if (row.record.phase === "result" && row.record.index === 0) {
      const creation = row.record.creation as any; assert.equal(creation.createdDirectoryCount, 32);
      assert(creation.createdDirectories.length <= 8); assert.equal(creation.createdDirectoriesOmitted, 32 - creation.createdDirectories.length); found = true;
    }
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  assert(found);
});

test("v3 binds the dispatcher's existing numeric repair without changing original history", async t => {
  const f = await fixture(t); await writeFile(join(f.cwd, "123"), "original");
  const raw = { path: 123, destination: 456 }, id = "numeric-move";
  const source = f.session.appendMessage({ role: "assistant", content: [{ type: "toolCall", id, name: "move", arguments: raw }], timestamp: 0 } as any);
  const mutation = new FileMutation(f.service, id, "move", { path: "123", destination: "456" }); await mutation.prepare();
  const result = await mutation.execute(f.session, (kind, data) => f.session.appendCustomEntry(kind, data), { assertCurrent: current, record: unexpectedLegacy });
  assert.equal(result.isError, false, JSON.stringify(result)); assert.equal(await readFile(join(f.cwd, "456"), "utf8"), "original");
  const changes = new FileChangesV3(f.session); t.after(() => changes.dispose()); changes.open(result.details.resultRef!);
  assert.equal(changes.nextItems().records[0].original.path, "123");
  const original = f.session.getEntry(source) as any; assert.equal(original.message.content[0].arguments.path, 123);
});

test("native targets cross inline and page boundaries while publishing every terminal state", async t => {
  const f = await fixture(t), paths = [], count = 70;
  for (let index = 0; index < count; index++) { const path = "file-" + index; await writeFile(join(f.cwd, path), "x"); paths.push(path); }
  const mutation = f.mutation("delete", { paths }); await mutation.prepare();
  const result = await mutation.execute(f.session, (kind, data) => f.session.appendCustomEntry(kind, data), { assertCurrent: current, record: unexpectedLegacy });
  assert.equal(result.isError, false, JSON.stringify(result)); assert.equal(result.details.succeeded, count);
  assert.equal(result.details.itemsOmitted, true); assert.equal(result.details.items, undefined);
  assert(Buffer.byteLength(JSON.stringify(result)) < FILE_RESULT_PAGE_BYTES);
  const reader = new FileResultReader(f.session); t.after(() => reader.dispose());
  let cursor: string | undefined, terminal = 0, sawLast = false, coverage = false;
  do {
    const page = reader.read(result.details.resultRef!, cursor, 128);
    assert(Buffer.byteLength(JSON.stringify(page)) <= FILE_RESULT_PAGE_BYTES);
    for (const row of page.records) if (row.record.phase === "result") { terminal++; sawLast ||= row.record.index === count - 1 && row.record.status === "succeeded"; }
    coverage = page.coverageComplete; cursor = page.nextCursor ?? undefined;
  } while (cursor);
  assert.equal(terminal, count); assert(sawLast); assert(coverage);
});

test("independent arrays continue ordinary failures; ordered file_batch stops with an explicit suffix", async t => {
  for (const batch of [false, true]) {
    const f = await fixture(t); await mkdir(join(f.cwd, "source")); await mkdir(join(f.cwd, "destination"));
    for (const path of ["a", "b", "c"]) await writeFile(join(f.cwd, "source", path), path);
    const items = ["a", "b", "c"].map(path => ({ path: "source/" + path, destination: "destination/" + path }));
    const input = batch ? { operations: items.map(item => ({ operation: "copy", ...item })) } : { items };
    const mutation = f.mutation(batch ? "file_batch" : "copy", input); await mutation.prepare();
    const append = (kind: string, data: any) => {
      const payload = JSON.parse(data.payload); const id = f.session.appendCustomEntry(kind, data);
      if (payload.phase === "intent" && payload.index === 1) writeFileSync(join(f.cwd, "source", "b"), "changed after ready");
      return id;
    };
    const result = await mutation.execute(f.session, append, { record: unexpectedLegacy, assertCurrent: current });
    assert.equal(result.isError, true); assert.equal(result.details.succeeded, batch ? 1 : 2); assert.equal(result.details.failed, 1);
    assert.equal(result.details.notStarted, batch ? 1 : 0);
    assert.equal(result.details.items![1].status, "failed_no_change");
    assert.equal(result.details.items![2].status, batch ? "not_started" : "succeeded");
    assert.equal(await readFile(join(f.cwd, "source", "b"), "utf8"), "changed after ready");
  }
});

test("whole-call preflight rejects a protected later item before any effect", async t => {
  const f = await fixture(t); await writeFile(join(f.cwd, "a"), "a"); await mkdir(join(f.cwd, "bad")); await mkdir(join(f.cwd, "bad", ".git"));
  const mutation = f.mutation("delete", { paths: ["a", "bad"], recursive: true });
  await assert.rejects(mutation.prepare(), /protected/);
  assert.equal(await readFile(join(f.cwd, "a"), "utf8"), "a");
  assert.equal(f.session.getEntries().filter(entry => entry.type === "custom" && entry.customType === FILE_RESULT_ENTRY).length, 0);
});

test("dryRun has no journal or directories and cannot issue an execution resultRef", async t => {
  const f = await fixture(t);
  const mutation = f.mutation("file_batch", { operations: [{ operation: "write", path: "new/one", mode: "create", content: "one" }], dryRun: true });
  await mutation.prepare();
  const result = await mutation.execute(f.session, () => { throw new Error("dryRun cannot append"); }, { assertCurrent: current, record: unexpectedLegacy });
  assert.equal(result.isError, false); assert.equal(result.details.resultRef, undefined); assert.equal(result.details.preview, true);
  assert.equal(result.details.files, 1); assert.equal(result.details.directories, 1);
  assert.equal(result.details.bytes, 3); assert.equal(result.details.files, 1);
  await assert.rejects(lstat(join(f.cwd, "new")), { code: "ENOENT" });
});

test("large dryRun reports every target's totals with bounded path samples and no journal", async t => {
  const f = await fixture(t), items = [];
  for (let index = 0; index < 70; index++) { const path = "source-" + index; await writeFile(join(f.cwd, path), "abc"); items.push({ path, destination: "copy-" + index }); }
  const mutation = f.mutation("copy", { items, dryRun: true }); await mutation.prepare();
  const result = await mutation.execute(f.session, () => { throw new Error("dryRun cannot append"); }, { assertCurrent: current, record: unexpectedLegacy });
  assert.equal(result.isError, false); assert.equal(result.details.itemCount, 70); assert.equal(result.details.files, 70); assert.equal(result.details.bytes, 210);
  assert.equal(result.details.itemsOmitted, true); assert.equal(result.details.previewSamples?.length, 8); assert.equal(result.details.previewSamplesOmitted, 62);
  assert.equal(f.session.getEntryCount(), 1); await assert.rejects(lstat(join(f.cwd, "copy-0")), { code: "ENOENT" });
});
