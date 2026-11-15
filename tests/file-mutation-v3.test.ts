import fsPromises from "node:fs/promises";
import fsSync from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile, mkdir, readFile, lstat } from "node:fs/promises";
import { writeFileSync, symlinkSync, renameSync, unlinkSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { SessionManager } from "../packages/coding-agent/src/core/session-manager.ts";
import { FileService } from "../packages/coding-agent/src/core/files/file-service.ts";
import { FileMutation } from "../packages/coding-agent/src/core/files/file-mutation.ts";
import { completedFileBatchFailure, FileAuthorityError } from "../packages/coding-agent/src/core/files/file-batch-outcome.ts";
import { FileResultReader } from "../packages/coding-agent/src/core/files/file-result-store.ts";
import { FILE_RESULT_ENTRY } from "../packages/coding-agent/src/core/files/file-result-protocol.ts";
import { FILE_RESULT_PAGE_BYTES } from "../packages/coding-agent/src/core/files/file-operation-limits.mjs";
import { FileChangesV3 } from "../packages/coding-agent/src/core/files/file-changes-v3.ts";
import { nativeFileSession } from "./helpers/sandbox-file-session.ts";
import { prepareFileCreation, verifyCreationAncestor, executeFileCreation, FileCreationFailure } from "../packages/coding-agent/src/core/files/file-creation.ts";
import { revalidateTree, executeTree, capturePathIdentity, assertFilePathAfterFailure, assertFilePathAfterFailureSync } from "../packages/coding-agent/src/core/files/file-tree-core.mjs";

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
test("native outside-workspace parent preparation retains write's authorization boundary", async t => {
  const f = await fixture(t), workspace = join(f.cwd, "workspace"); await mkdir(workspace); await writeFile(join(workspace, "source"), "kept");
  const service = new FileService(workspace, "outside-control"); t.after(() => service.dispose());
  const write = await service.prepareV3("write", { path: join(f.cwd, "outside/new/write"), content: "kept" }, undefined, "create");
  assert.deepEqual(write.approval.protectedRoots, ["workspace_escape"]);
  for (const operation of ["copy", "move"] as const) {
    const item = await service.prepareV3(operation, { path: "source", destination: join(f.cwd, `outside/new/${operation}`) });
    assert.deepEqual(item.tree!.protectedPaths[1].protectedRoots, write.approval.protectedRoots);
    assert(item.paths.includes(join(dirname(write.target), operation))); service.release(item);
  }
  service.release(write); await assert.rejects(lstat(join(f.cwd, "outside")), { code: "ENOENT" });
});

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

test("independent arrays and file_batch continue confirmed ordinary failures", async t => {
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
    assert.equal(result.isError, true); assert.equal(result.details.succeeded, 2); assert.equal(result.details.failed, 1);
    assert.equal(result.details.notStarted, 0);
    assert.equal(result.details.items![1].status, "failed_no_change");
    assert.equal(result.details.items![2].status, "succeeded");
    assert.equal(await readFile(join(f.cwd, "source", "b"), "utf8"), "changed after ready");
  }
});

for (const withSuccessor of [true, false]) test(`a retargeted path stops even the final item and releases the next invocation, successor=${withSuccessor}`, async t => {
  const f = await fixture(t), original = join(f.cwd, "original"), replacement = join(f.cwd, "replacement"), retained = join(f.cwd, "retained");
  for (const path of [original, replacement]) { await mkdir(path); await writeFile(join(path, "kept"), "same content"); }
  const mutation = f.mutation("file_batch", { operations: [
    { operation: "write", mode: "create", path: "first", content: "committed" },
    { operation: "delete", path: "original/kept" },
    ...(withSuccessor ? [{ operation: "write", mode: "create", path: "last", content: "unstarted" }] : []),
  ] }); await mutation.prepare();
  const result = await mutation.execute(f.session, (kind, data) => {
    const id = f.session.appendCustomEntry(kind, data), payload = JSON.parse(data.payload);
    if (payload.phase === "intent" && payload.index === 1) { renameSync(original, retained); symlinkSync(replacement, original, process.platform === "win32" ? "junction" : "dir"); }
    return id;
  }, { assertCurrent: current, record: unexpectedLegacy });
  assert.equal(result.details.succeeded, 1, JSON.stringify(result)); assert.equal(result.details.failed, 1); assert.equal(result.details.notStarted, withSuccessor ? 1 : 0);
  assert.equal(result.details.items![1].stopInvocation, true);
  assert.equal(completedFileBatchFailure(result.details), false, "last-item authority loss must still fail its containing script");
  for (const path of [retained, replacement]) assert.equal(await readFile(join(path, "kept"), "utf8"), "same content");
  await assert.rejects(lstat(join(f.cwd, "last")), { code: "ENOENT" });
  const next = f.mutation("write", { path: "next", content: "allowed" }, "next-call"); await next.prepare();
  assert.equal((await next.execute(f.session, (kind, data) => f.session.appendCustomEntry(kind, data), { assertCurrent: current, record: unexpectedLegacy })).isError, false);
});

for (const operation of ["delete", "write"] as const) for (const phase of ["preflight", "item"] as const)
for (const finalItem of [false, true]) for (const replacement of ["dangling-link", "missing"] as const)
test(`native ${operation} distinguishes ${replacement} during ${phase}, final=${finalItem}`, async t => {
  const f = await fixture(t), source = join(f.cwd, "source");
  const append = (kind: string, data: any) => f.session.appendCustomEntry(kind, data), hooks = { assertCurrent: current, record: unexpectedLegacy };
  const setup = f.mutation("write", { path: "source", content: "original" }, "setup"); await setup.prepare(); await setup.execute(f.session, append, hooks);
  const change = operation === "delete" ? { operation, path: "source" } : { operation, mode: "overwrite", path: "source", content: "after" };
  const independent = { operation: "write", mode: "create", path: "independent", content: "kept" };
  const mutation = f.mutation("file_batch", { operations: finalItem ? [independent, change] : [change, independent] }); await mutation.prepare();
  function replace() { unlinkSync(source); if (replacement === "dangling-link") symlinkSync(join(f.cwd, "absent-target"), source, "file"); }
  if (phase === "preflight") replace();
  const result = await mutation.execute(f.session, (kind, data) => {
    const id = append(kind, data), payload = JSON.parse(data.payload);
    if (phase === "item" && payload.phase === "intent" && payload.index === (finalItem ? 1 : 0)) replace();
    return id;
  }, hooks);
  assert.equal(completedFileBatchFailure(result.details), replacement === "missing", JSON.stringify(result));
  assert.equal(result.details.succeeded, replacement === "missing" || phase === "item" && finalItem ? 1 : 0);
  if (replacement === "dangling-link") { assert.match(result.details.reason!, /STALE_STATE/); assert.equal((await lstat(source)).isSymbolicLink(), true); }
});

for (const phase of ["preflight", "item"] as const) for (const finalItem of [false, true])
for (const replacement of ["dangling-link", "missing"] as const)
test(`native copy overwrite destination distinguishes ${replacement} during ${phase}, final=${finalItem}`, async t => {
  const f = await fixture(t), destination = join(f.cwd, "destination"); await writeFile(join(f.cwd, "source"), "source"); await writeFile(destination, "original");
  const copy = { operation: "copy", path: "source", destination: "destination", overwrite: true };
  const independent = { operation: "write", mode: "create", path: "independent", content: "kept" };
  const mutation = f.mutation("file_batch", { operations: finalItem ? [independent, copy] : [copy, independent] }); await mutation.prepare();
  function replace() { unlinkSync(destination); if (replacement === "dangling-link") symlinkSync(join(f.cwd, "absent-target"), destination, "file"); }
  if (phase === "preflight") replace();
  const result = await mutation.execute(f.session, (kind, data) => {
    const id = f.session.appendCustomEntry(kind, data), payload = JSON.parse(data.payload);
    if (phase === "item" && payload.phase === "intent" && payload.index === (finalItem ? 1 : 0)) replace();
    return id;
  }, { assertCurrent: current, record: unexpectedLegacy });
  assert.equal(completedFileBatchFailure(result.details), replacement === "missing", JSON.stringify(result));
  assert.equal(result.details.succeeded, replacement === "missing" || phase === "item" && finalItem ? 1 : 0);
  assert.equal(await readFile(join(f.cwd, "source"), "utf8"), "source");
  if (replacement === "dangling-link") { assert.match(result.details.reason!, /STALE_STATE/); assert.equal((await lstat(destination)).isSymbolicLink(), true); }
});

test("publication wrapping cannot turn authority loss into an ordinary batch failure", async t => {
  const f = await fixture(t), append = (kind: string, data: any) => f.session.appendCustomEntry(kind, data);
  const hooks = { assertCurrent: current, record: unexpectedLegacy };
  const setup = f.mutation("write", { path: "existing", content: "before" }, "setup"); await setup.prepare(); await setup.execute(f.session, append, hooks);
  const mutation = f.mutation("file_batch", { operations: [
    { operation: "write", mode: "overwrite", path: "existing", content: "after" },
    { operation: "write", mode: "create", path: "next", content: "unstarted" },
  ] }); await mutation.prepare();
  const snapshot = mutation.items[0].snapshot!;
  let injected = 0;
  t.mock.method(snapshot.metadata!, "assertCurrent", () => { injected++; throw new FileAuthorityError("Authority changed before publication."); });
  const result = await mutation.execute(f.session, append, hooks);
  assert.equal(injected, 1, "inject on both staged and protected-in-place publication strategies");
  assert.equal(result.details.failed, 1); assert.equal(result.details.notStarted, 1, JSON.stringify(result));
  assert.equal(completedFileBatchFailure(result.details), false);
  assert.equal(await readFile(join(f.cwd, "existing"), "utf8"), "before");
  await assert.rejects(lstat(join(f.cwd, "next")), { code: "ENOENT" });
});

for (const phase of ["preflight", "item"] as const) for (const finalItem of [false, true])
for (const replacement of ["dangling-link", "missing"] as const)
test(`native creation ancestor distinguishes ${replacement} during ${phase}, final=${finalItem}`, async t => {
  const f = await fixture(t), parent = join(f.cwd, "original"); await mkdir(parent);
  const create = { operation: "write", mode: "create", path: "original/new/file", content: "created" };
  const independent = { operation: "write", mode: "create", path: "independent", content: "kept" };
  const mutation = f.mutation("file_batch", { operations: finalItem ? [independent, create] : [create, independent] }); await mutation.prepare();
  function replace() { renameSync(parent, join(f.cwd, "retained")); if (replacement === "dangling-link") symlinkSync(join(f.cwd, "absent-target"), parent, process.platform === "win32" ? "junction" : "dir"); }
  if (phase === "preflight") replace();
  const result = await mutation.execute(f.session, (kind, data) => {
    const id = f.session.appendCustomEntry(kind, data), payload = JSON.parse(data.payload);
    if (phase === "item" && payload.phase === "intent" && payload.index === (finalItem ? 1 : 0)) replace();
    return id;
  }, { assertCurrent: current, record: unexpectedLegacy });
  assert.equal(completedFileBatchFailure(result.details), replacement === "missing", JSON.stringify(result));
  assert.equal(result.details.succeeded, replacement === "missing" || phase === "item" && finalItem ? 1 : 0);
  if (replacement === "dangling-link") assert.match(result.details.reason!, /STALE_STATE/);
  await assert.rejects(lstat(join(f.cwd, "retained/new")), { code: "ENOENT" });
});

for (const phase of ["precheck", "open"]) for (const replacement of ["dangling-link", "missing"]) test(`creation mechanics preserve ${replacement} ancestor provenance during ${phase}`, async t => {
  const f = await fixture(t), parent = join(f.cwd, "original"); await mkdir(parent);
  const plan = (await prepareFileCreation(join(parent, phase === "open" ? "file" : "new/file"), true))!;
  function replace() { renameSync(parent, join(f.cwd, "retained")); if (replacement === "dangling-link") symlinkSync(join(f.cwd, "absent-target"), parent, process.platform === "win32" ? "junction" : "dir"); }
  if (phase === "precheck") { replace(); await assert.rejects(verifyCreationAncestor(plan), (error: any) => { assert.equal(error.stopInvocation === true, replacement === "dangling-link"); return true; }); }
  else {
    const originalOpen = fsPromises.open;
    t.mock.method(fsPromises, "open", async (path: any, ...args: any[]) => { if (path === plan.path) replace(); return (originalOpen as any)(path, ...args); }); syncBuiltinESMExports();
  }
  try {
    await assert.rejects(executeFileCreation(plan, "new", async () => plan.canonicalTarget, undefined, undefined, undefined, undefined, true), (error: any) => {
      assert(error instanceof FileCreationFailure); assert.equal(error.stopInvocation, replacement === "dangling-link"); assert.equal(error.facts.stateChanged, false); return true;
    });
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
});

for (const phase of ["validate", "execute"]) for (const replacement of ["dangling-link", "missing"]) test(`tree identity resolution classifies ${replacement} during ${phase}`, async t => {
  const f = await fixture(t), source = join(f.cwd, "source"); await writeFile(source, "original");
  const item = await f.service.prepareV3("delete", { path: "source" }), originalRealpath = fsPromises.realpath; let injected = false;
  t.mock.method(fsPromises, "realpath", async (path: any, ...args: any[]) => {
    if (!injected && path === source) { injected = true; unlinkSync(source); if (replacement === "dangling-link") symlinkSync(join(f.cwd, "absent-target"), source, "file"); }
    return (originalRealpath as any)(path, ...args);
  }); syncBuiltinESMExports();
  try {
    if (phase === "validate") await assert.rejects(revalidateTree(item.tree!.tree), (error: any) => { assert.equal(error.stopInvocation === true, replacement === "dangling-link"); return true; });
    else { const receipt = await executeTree(item.tree!.tree, "delete", item.tree!.sourceParent, undefined, undefined, current); assert.equal(receipt.status, "failed_no_change"); assert.equal(receipt.stopInvocation === true, replacement === "dangling-link"); }
    assert.equal(injected, true);
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
});

for (const synchronous of [false, true]) for (const replacement of ["dangling-link", "missing"]) test(`failure lookup checks higher ${replacement} ancestry, sync=${synchronous}`, async t => {
  const f = await fixture(t), ancestor = join(f.cwd, "original"), source = join(ancestor, "inner/source"); await mkdir(join(ancestor, "inner"), { recursive: true }); await writeFile(source, "original");
  const identity = await capturePathIdentity(source); renameSync(ancestor, join(f.cwd, "retained")); if (replacement === "dangling-link") symlinkSync(join(f.cwd, "absent-target"), ancestor, process.platform === "win32" ? "junction" : "dir");
  if (synchronous) {
    if (replacement === "dangling-link") assert.throws(() => assertFilePathAfterFailureSync(identity), /STALE_STATE/); else assert.doesNotThrow(() => assertFilePathAfterFailureSync(identity));
  } else if (replacement === "dangling-link") await assert.rejects(assertFilePathAfterFailure(identity), /STALE_STATE/); else await assert.doesNotReject(assertFilePathAfterFailure(identity));
});

for (const synchronous of [false, true]) for (const missing of ["leaf", "parent"]) test(`failure lookup preserves missing ${missing} under an unchanged alias, sync=${synchronous}`, async t => {
  const f = await fixture(t), real = join(f.cwd, "real"), alias = join(f.cwd, "alias"); await mkdir(join(real, "inner"), { recursive: true }); await writeFile(join(real, "inner/source"), "original");
  symlinkSync(real, alias, process.platform === "win32" ? "junction" : "dir"); const identity = await capturePathIdentity(join(alias, "inner/source"));
  if (missing === "leaf") unlinkSync(join(real, "inner/source")); else renameSync(join(real, "inner"), join(real, "retained"));
  if (synchronous) assert.doesNotThrow(() => assertFilePathAfterFailureSync(identity)); else await assert.doesNotReject(assertFilePathAfterFailure(identity));
});

for (const replacement of ["directory", "dangling-link", "missing"]) test(`tree parent validation preserves ${replacement} provenance`, async t => {
  const f = await fixture(t), parent = join(f.cwd, "original"); await mkdir(parent); await writeFile(join(f.cwd, "source"), "original");
  const item = await f.service.prepareV3("copy", { path: "source", destination: "original/target" }), plan = item.tree!, original = fsPromises.realpath; let injected = 0;
  t.mock.method(fsPromises, "realpath", async (path: any, ...args: any[]) => {
    if (path === plan.destinationParent!.path && !injected) {
      renameSync(parent, join(f.cwd, "retained")); injected++;
      if (replacement === "directory") fsSync.mkdirSync(parent);
      else if (replacement === "dangling-link") symlinkSync(join(f.cwd, "absent-target"), parent, process.platform === "win32" ? "junction" : "dir");
    } return (original as any)(path, ...args);
  }); syncBuiltinESMExports();
  try {
    const receipt = await executeTree(plan.tree, "copy", plan.sourceParent, plan.destination, plan.destinationParent, current);
    assert.equal(injected, 1); assert.equal(receipt.status, "failed_no_change"); assert.equal(receipt.stateChanged, false);
    assert.equal(receipt.stopInvocation === true, replacement !== "missing", JSON.stringify(receipt)); assert.equal(await readFile(join(f.cwd, "source"), "utf8"), "original");
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
});

for (const replacement of ["directory-file", "directory-empty", "missing"]) for (const finalItem of [false, true]) test(`native hash failure checks ${replacement} destination parent, final=${finalItem}`, async t => {
  const f = await fixture(t), parent = join(f.cwd, "original"), source = join(f.cwd, "source"); await mkdir(parent); await writeFile(source, "source"); await writeFile(join(parent, "target"), "original");
  const copy = { operation: "copy", path: "source", destination: "original/target", overwrite: true }, independent = { operation: "write", path: "independent", mode: "create", content: "kept" };
  const mutation = f.mutation("file_batch", { operations: finalItem ? [independent, copy] : [copy, independent] }); await mutation.prepare();
  const sourcePath = mutation.items[finalItem ? 1 : 0].tree!.source.path, original = fsPromises.open; let injected = 0;
  t.mock.method(fsPromises, "open", async (path: any, ...args: any[]) => {
    const handle = await (original as any)(path, ...args);
    if (path === sourcePath && !injected) { renameSync(parent, join(f.cwd, "retained")); injected++;
      if (replacement !== "missing") { fsSync.mkdirSync(parent); if (replacement === "directory-file") writeFileSync(join(parent, "target"), "external"); }
    } return handle;
  }); syncBuiltinESMExports();
  try {
    const result = await mutation.execute(f.session, (kind, data) => f.session.appendCustomEntry(kind, data), { assertCurrent: current, record: unexpectedLegacy });
    assert.equal(injected, 1, JSON.stringify(result)); assert.equal(completedFileBatchFailure(result.details), replacement === "missing", JSON.stringify(result)); assert.equal(result.details.succeeded, replacement === "missing" ? 1 : 0);
    assert.equal(await readFile(join(f.cwd, "retained/target"), "utf8"), "original"); assert.equal(await readFile(source, "utf8"), "source");
    const next = f.mutation("write", { path: "after", content: "next" }, "after"); await next.prepare(); assert.equal((await next.execute(f.session, (kind, data) => f.session.appendCustomEntry(kind, data), { assertCurrent: current, record: unexpectedLegacy })).isError, false);
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
});

for (const depth of [0, 2]) for (const phase of ["validate", "execute"]) for (const replacement of ["directory-file", "directory-empty", "missing"]) test(`nested tree ${phase} checks ${replacement} parent on child failure, depth=${depth}`, async t => {
  const f = await fixture(t), parent = join(f.cwd, "original"), suffix = depth ? "nested/inner/source" : "source"; await mkdir(dirname(join(parent, suffix)), { recursive: true }); await writeFile(join(parent, suffix), "original");
  const item = await f.service.prepareV3("delete", { path: "original", recursive: true }), plan = item.tree!, child = plan.tree.entries[plan.tree.entries.length - 1].identity.path, original = fsPromises.lstat; let injected = 0;
  t.mock.method(fsPromises, "lstat", async (path: any, options: any) => {
    if (path === child && !injected) { renameSync(parent, join(f.cwd, "retained")); injected++;
      if (replacement !== "missing") { fsSync.mkdirSync(parent); if (replacement === "directory-file") writeFileSync(join(parent, "source"), "external"); }
    } return (original as any)(path, options);
  }); syncBuiltinESMExports();
  try {
    if (phase === "validate") await assert.rejects(revalidateTree(plan.tree), (error: any) => { assert.equal(error.stopInvocation === true, replacement !== "missing"); return true; });
    else { const receipt = await executeTree(plan.tree, "delete", plan.sourceParent, undefined, undefined, current); assert.equal(receipt.status, "failed_no_change"); assert.equal(receipt.stopInvocation === true, replacement !== "missing", JSON.stringify(receipt)); }
    assert.equal(injected, 1); assert.equal(await readFile(join(f.cwd, "retained", suffix), "utf8"), "original");
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
});

for (const operation of ["delete", "copy"] as const) for (const replacement of ["directory", "missing"]) test(`deep tree ${operation} syscall checks ${replacement} recorded ancestors`, async t => {
  const f = await fixture(t), source = join(f.cwd, "source"), destination = join(f.cwd, "target"); await mkdir(join(source, "nested/inner"), { recursive: true }); await writeFile(join(source, "nested/inner/file"), "original");
  const item = await f.service.prepareV3(operation, { path: "source", ...(operation === "delete" ? { recursive: true } : { destination: "target" }) }), plan = item.tree!;
  const syscall = operation === "delete" ? "unlink" : "open", original = fsPromises[syscall], boundary = operation === "delete" ? plan.tree.entries[plan.tree.entries.length - 1].identity.path : join(plan.destination!, "nested/inner/file"), parent = operation === "delete" ? source : destination; let injected = 0;
  t.mock.method(fsPromises, syscall, async (path: any, ...args: any[]) => {
    if (path === boundary && !injected) { renameSync(parent, join(f.cwd, "retained")); injected++; if (replacement === "directory") fsSync.mkdirSync(parent); }
    return (original as any)(path, ...args);
  }); syncBuiltinESMExports();
  try {
    const receipt = await executeTree(plan.tree, operation, plan.sourceParent, plan.destination, plan.destinationParent, current);
    assert.equal(injected, 1); assert.equal(receipt.stopInvocation === true, replacement === "directory", JSON.stringify(receipt)); assert.equal(receipt.status, operation === "delete" ? "failed_no_change" : "partial");
    assert.equal(await readFile(join(operation === "delete" ? join(f.cwd, "retained") : source, "nested/inner/file"), "utf8"), "original");
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
});

test("synchronous failure lookup uses native canonical spelling", async t => {
  const f = await fixture(t), source = join(f.cwd, "source"); await writeFile(source, "original");
  const identity = await capturePathIdentity(source); unlinkSync(source);
  const original = fsSync.realpathSync, shortSpelling = Object.assign((...args: any[]) => join((original as any)(...args), "alternate-short-spelling"), { native: original.native });
  t.mock.method(fsSync, "realpathSync", shortSpelling); syncBuiltinESMExports();
  try { assert.doesNotThrow(() => assertFilePathAfterFailureSync(identity)); }
  finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
});

for (const operation of ["copy", "move", "delete"] as const) for (const replacement of ["dangling-link", "directory", "missing"])
test(`tree ${operation} syscall failure preserves ${replacement} parent provenance`, async t => {
  const f = await fixture(t), parent = join(f.cwd, "original"), retained = join(f.cwd, "retained"); await mkdir(parent);
  const source = operation === "copy" ? join(f.cwd, "source") : join(parent, "source"), destination = join(parent, "destination"); await writeFile(source, "original");
  const item = await f.service.prepareV3(operation, { path: source, ...(operation !== "delete" ? { destination } : {}) }), plan = item.tree!;
  const syscall = operation === "copy" ? "open" : operation === "move" ? "link" : "unlink", original = fsPromises[syscall]; let injected = 0;
  t.mock.method(fsPromises, syscall, async (...args: any[]) => {
    if (injected === 0 && args[0] === (operation === "copy" ? plan.destination : plan.source.path)) {
      injected++; renameSync(parent, retained);
      if (replacement === "dangling-link") symlinkSync(join(f.cwd, "absent-target"), parent, process.platform === "win32" ? "junction" : "dir");
      else if (replacement === "directory") { await mkdir(parent); throw Object.assign(new Error("fixture denied mutation"), { code: "EACCES" }); }
    }
    return (original as any)(...args);
  }); syncBuiltinESMExports();
  try {
    const receipt = await executeTree(plan.tree, operation, plan.sourceParent, plan.destination, plan.destinationParent, current);
    assert.equal(injected, 1, JSON.stringify(receipt)); assert.equal(receipt.status, "failed_no_change", JSON.stringify(receipt));
    assert.equal(receipt.stateChanged, false); assert.equal(receipt.requiresVerification, undefined);
    assert.equal(receipt.stopInvocation === true, replacement !== "missing", JSON.stringify(receipt));
    assert.equal(await readFile(operation === "copy" ? source : join(retained, "source"), "utf8"), "original");
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
});

for (const phase of ["preflight", "item"]) for (const finalItem of [false, true]) for (const role of ["source", "destination"])
test(`native batch stops on same-path ${role} parent replacement during ${phase}, final=${finalItem}`, async t => {
  const f = await fixture(t), parent = join(f.cwd, "original"); await mkdir(parent); await writeFile(join(parent, "source"), "original");
  await writeFile(join(f.cwd, "source"), "outside source");
  const copy = { operation: "copy", path: role === "source" ? "original/source" : "source", destination: role === "destination" ? "original/copied" : "copied" };
  const independent = { operation: "write", mode: "create", path: "independent", content: "kept" };
  const mutation = f.mutation("file_batch", { operations: finalItem ? [independent, copy] : [copy, independent] }); await mutation.prepare();
  async function replace() { renameSync(parent, join(f.cwd, "retained")); await mkdir(parent); await writeFile(join(parent, "source"), "replacement"); }
  if (phase === "preflight") await replace();
  // Intent callbacks are synchronous; replacement is complete before the next await.
  const result = await mutation.execute(f.session, (kind, data) => {
    const id = f.session.appendCustomEntry(kind, data), payload = JSON.parse(data.payload);
    if (phase === "item" && payload.phase === "intent" && payload.index === (finalItem ? 1 : 0)) { renameSync(parent, join(f.cwd, "retained")); fsSync.mkdirSync(parent); writeFileSync(join(parent, "source"), "replacement"); }
    return id;
  }, { assertCurrent: current, record: unexpectedLegacy });
  assert.equal(completedFileBatchFailure(result.details), false, JSON.stringify(result)); assert.match(result.details.reason!, /STALE_STATE/);
  assert.equal(result.details.succeeded, phase === "item" && finalItem ? 1 : 0);
  assert.equal(await readFile(join(f.cwd, "retained/source"), "utf8"), "original"); assert.equal(await readFile(join(parent, "source"), "utf8"), "replacement");
  const next = f.mutation("write", { path: "after", content: "next" }, "next"); await next.prepare();
  const repaired = await next.execute(f.session, (kind, data) => f.session.appendCustomEntry(kind, data), { assertCurrent: current, record: unexpectedLegacy }); assert.equal(repaired.isError, false);
});

for (const operation of ["write", "edit"] as const) for (const phase of ["preflight", "item"]) for (const finalItem of [false, true])
for (const replacement of ["directory-file", "directory-empty", "missing"])
test(`text ${operation} checks ${replacement} parent before target during ${phase}, final=${finalItem}`, async t => {
  const f = await fixture(t), parent = join(f.cwd, "original"), append = (kind: string, data: any) => f.session.appendCustomEntry(kind, data), hooks = { assertCurrent: current, record: unexpectedLegacy };
  await mkdir(parent);
  const setup = f.mutation("write", { path: "original/source", content: "original" }, "setup"); await setup.prepare(); await setup.execute(f.session, append, hooks);
  const change = operation === "write" ? { operation, path: "original/source", mode: "overwrite", content: "next" } : { operation, path: "original/source", edits: [{ oldText: "original", newText: "next" }] };
  const independent = { operation: "write", mode: "create", path: "independent", content: "kept" };
  const mutation = f.mutation("file_batch", { operations: finalItem ? [independent, change] : [change, independent] }); await mutation.prepare();
  function replace() { renameSync(parent, join(f.cwd, "retained")); if (replacement !== "missing") { fsSync.mkdirSync(parent); if (replacement === "directory-file") writeFileSync(join(parent, "source"), "external"); } }
  if (phase === "preflight") replace();
  const result = await mutation.execute(f.session, (kind, data) => {
    const id = append(kind, data), payload = JSON.parse(data.payload);
    if (phase === "item" && payload.phase === "intent" && payload.index === (finalItem ? 1 : 0)) replace(); return id;
  }, hooks);
  assert.equal(completedFileBatchFailure(result.details), replacement === "missing", JSON.stringify(result));
  assert.equal(result.details.succeeded, replacement === "missing" || phase === "item" && finalItem ? 1 : 0);
  assert.equal(await readFile(join(f.cwd, "retained/source"), "utf8"), "original");
  if (replacement === "directory-file") assert.equal(await readFile(join(parent, "source"), "utf8"), "external");
  const next = f.mutation("write", { path: "after", content: "next" }, "after"); await next.prepare(); assert.equal((await next.execute(f.session, append, hooks)).isError, false);
});

for (const syscall of ["open", "mkdir"] as const) for (const finalItem of [false, true]) for (const replacement of ["dangling-link", "directory", "missing"])
test(`shared creation ${syscall} failure checks ${replacement} parent, final=${finalItem}`, async t => {
  const f = await fixture(t), parent = join(f.cwd, "new"), retained = join(f.cwd, "retained"), target = join(parent, syscall === "open" ? "second" : "deep");
  const second = { operation: "write", mode: "create", path: syscall === "open" ? "new/second" : "new/deep/second", content: "next" };
  const independent = { operation: "write", mode: "create", path: "independent", content: "kept" }, first = { operation: "write", mode: "create", path: "new/first", content: "committed" };
  const mutation = f.mutation("file_batch", { operations: finalItem ? [first, independent, second] : [first, second, independent] }); await mutation.prepare();
  const original = fsPromises[syscall]; let injected = 0, committedMtime: bigint | undefined;
  t.mock.method(fsPromises, syscall, async (path: any, ...args: any[]) => {
    if (injected === 0 && path === target) {
      committedMtime = (await lstat(join(parent, "first"), { bigint: true })).mtimeNs;
      renameSync(parent, retained); injected++;
      if (replacement === "dangling-link") symlinkSync(join(f.cwd, "absent-target"), parent, process.platform === "win32" ? "junction" : "dir");
      else if (replacement === "directory") { fsSync.mkdirSync(parent); throw Object.assign(new Error("fixture denied creation"), { code: "EACCES" }); }
    }
    return (original as any)(path, ...args);
  }); syncBuiltinESMExports();
  try {
    const result = await mutation.execute(f.session, (kind, data) => f.session.appendCustomEntry(kind, data), { assertCurrent: current, record: unexpectedLegacy });
    assert.equal(injected, 1); assert.equal(completedFileBatchFailure(result.details), replacement === "missing", JSON.stringify(result));
    assert.equal(result.details.succeeded, replacement === "missing" || finalItem ? 2 : 1);
    assert.equal(await readFile(join(retained, "first"), "utf8"), "committed"); assert.equal((await lstat(join(retained, "first"), { bigint: true })).mtimeNs, committedMtime);
    const next = f.mutation("write", { path: "after", content: "next" }, "after"); await next.prepare(); assert.equal((await next.execute(f.session, (kind, data) => f.session.appendCustomEntry(kind, data), { assertCurrent: current, record: unexpectedLegacy })).isError, false);
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
});

test("creation wrapper preserves invocation protocol failure", async t => {
  const f = await fixture(t), plan = (await prepareFileCreation(join(f.cwd, "target"), true))!;
  await assert.rejects(executeFileCreation(plan, "next", async () => plan.canonicalTarget, undefined, () => { throw new Error("[FILE_RPC_CLOSED] fixture closed transport"); }, undefined, undefined, true), (error: any) => {
    assert(error instanceof FileCreationFailure); assert.equal(error.facts.stateChanged, false); assert.equal(error.stopInvocation, true); return true;
  });
});

for (const operation of ["write", "copy", "move"]) for (const replacement of [false, true]) for (const finalItem of [false, true]) test(`native shared parent precedes ${operation} target-appeared failure, replacement=${replacement}, final=${finalItem}`, async t => {
  const f = await fixture(t); let injected = 0;
  await writeFile(join(f.cwd, "source"), "source");
  const first = { operation: "write", mode: "create", path: "new/first", content: "committed" }, second = operation === "write" ? { operation, mode: "create", path: "new/second", content: "next" } : { operation, path: "source", destination: "new/second" }, independent = { operation: "write", mode: "create", path: "independent", content: "kept" };
  const mutation = f.mutation("file_batch", { operations: finalItem ? [first, independent, second] : [first, second, independent] }); await mutation.prepare();
  const result = await mutation.execute(f.session, (kind, data) => {
    const id = f.session.appendCustomEntry(kind, data), payload = JSON.parse(data.payload);
    if (payload.phase === "result" && payload.index === 0 && !injected) {
      const parent = join(f.cwd, "new"); if (replacement) { renameSync(parent, join(f.cwd, "retained")); fsSync.mkdirSync(parent); }
      writeFileSync(join(parent, "second"), "external"); injected++;
    } return id;
  }, { assertCurrent: current, record: unexpectedLegacy });
  assert.equal(injected, 1); assert.equal(completedFileBatchFailure(result.details), !replacement, JSON.stringify(result));
  assert.equal(result.details.succeeded, !replacement || finalItem ? 2 : 1);
  assert.equal(await readFile(join(f.cwd, replacement ? "retained/first" : "new/first"), "utf8"), "committed"); assert.equal(await readFile(join(f.cwd, "new/second"), "utf8"), "external");
  assert.equal(await readFile(join(f.cwd, "source"), "utf8"), "source");
});

test("large all-failed batch bounds failure excerpts while retaining every terminal outcome", async t => {
  const f = await fixture(t), operations = [];
  for (let index = 0; index < 40; index++) operations.push({ operation: "delete", path: "missing-" + index });
  const mutation = f.mutation("file_batch", { operations }); await mutation.prepare();
  const result = await mutation.execute(f.session, (kind, data) => f.session.appendCustomEntry(kind, data), { assertCurrent: current, record: unexpectedLegacy });
  assert.equal(result.details.failed, 40); assert.equal(result.details.succeeded, 0); assert.equal(result.details.complete, true);
  assert.equal(result.details.notStarted, 0); assert.equal(result.details.itemsOmitted, true);
  assert.equal(result.details.failureSamples.length, 8); assert.equal(result.details.failuresOmitted, 32);
  assert.match(result.content[0].text, /32 more failures/);
  const reader = new FileResultReader(f.session); t.after(() => reader.dispose());
  let cursor: string | undefined, failures = 0;
  do {
    const page = reader.read(result.details.resultRef!, cursor, 16);
    for (const row of page.records) if (row.record.phase === "result") { assert.equal(row.record.status, "failed_no_change"); failures++; }
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  assert.equal(failures, 40);
});

test("whole-call preflight rejects a protected later item before any effect", async t => {
  const f = await fixture(t); await writeFile(join(f.cwd, "a"), "a"); await mkdir(join(f.cwd, "bad")); await mkdir(join(f.cwd, "bad", ".git"));
  const mutation = f.mutation("delete", { paths: ["a", "bad"], recursive: true });
  await assert.rejects(mutation.prepare(), /protected/);
  assert.equal(await readFile(join(f.cwd, "a"), "utf8"), "a");
  assert.equal(f.session.getEntries().filter(entry => entry.type === "custom" && entry.customType === FILE_RESULT_ENTRY).length, 0);
});

for (const failure of ["missing-later-edit", "ambiguous-edit"] as const) test(`native batch ${failure} preflights first, continues independent items and retries only the corrected item`, async t => {
  const f = await fixture(t), source = failure === "missing-later-edit" ? "a\nb\nc\nd\ne\n" : "shared\nleft\nshared\nright\n";
  const append = (kind: string, data: any) => f.session.appendCustomEntry(kind, data);
  const hooks = { assertCurrent: current, record: unexpectedLegacy };
  const setup = f.mutation("write", { path: "existing.txt", content: source }, "setup"); await setup.prepare();
  const created = await setup.execute(f.session, append, hooks); assert.equal(created.isError, false);
  const edits = failure === "missing-later-edit"
    ? ["a", "b", "c", "d", "absent"].map(oldText => ({ oldText, newText: oldText.toUpperCase() }))
    : [{ oldText: "shared", newText: "changed" }];
  const operations = [
    { operation: "write", path: "new/first.txt", mode: "create", content: "first" },
    { operation: "edit", path: "existing.txt", edits },
    { operation: "write", path: "new/last.txt", mode: "create", content: "last" },
  ];
  const preview = f.mutation("file_batch", { operations, dryRun: true }, "preview-batch"); await preview.prepare();
  const checked = await preview.execute(f.session, append, hooks); assert.equal(checked.details.failed, 1); assert.equal(checked.details.preview, true);
  assert.equal(await readFile(join(f.cwd, "existing.txt"), "utf8"), source);
  await assert.rejects(lstat(join(f.cwd, "new")), { code: "ENOENT" });
  const failed = f.mutation("file_batch", { operations }, "failed-batch"); await failed.prepare();
  await assert.rejects(lstat(join(f.cwd, "new")), { code: "ENOENT" });
  const partial = await failed.execute(f.session, append, hooks);
  assert.equal(partial.details.succeeded, 2); assert.equal(partial.details.failed, 1); assert.equal(partial.details.notStarted, 0);
  assert.deepEqual(partial.details.items!.map(item => item.status), ["succeeded", "failed_no_change", "succeeded"]);
  assert.match(partial.content[0].text, failure === "missing-later-edit" ? /edits\[4\]\.oldText was not found/ : /oldText is ambiguous/);
  assert.doesNotMatch(partial.content[0].text, /first\.txt|last\.txt/);
  assert.equal(await readFile(join(f.cwd, "existing.txt"), "utf8"), source);
  const first = await lstat(join(f.cwd, "new/first.txt")), last = await lstat(join(f.cwd, "new/last.txt"));
  const reader = new FileResultReader(f.session); t.after(() => reader.dispose());
  assert.equal(reader.read(partial.details.resultRef!).records.filter(row => row.record.phase === "result").length, 3);
  const corrected = failure === "missing-later-edit"
    ? ["a", "b", "c", "d", "e"].map(oldText => ({ oldText, newText: oldText.toUpperCase() }))
    : [{ oldText: "shared\nleft", newText: "changed\nleft" }];
  const next = f.mutation("file_batch", { operations: [{ ...operations[1], edits: corrected }] }, "corrected-batch");
  await next.prepare(); const result = await next.execute(f.session, append, hooks);
  assert.equal(result.isError, false, JSON.stringify(result)); assert.equal(result.details.succeeded, 1);
  assert.equal(await readFile(join(f.cwd, "existing.txt"), "utf8"), failure === "missing-later-edit" ? "A\nB\nC\nD\nE\n" : "changed\nleft\nshared\nright\n");
  assert.equal(await readFile(join(f.cwd, "new/first.txt"), "utf8"), "first");
  assert.equal(await readFile(join(f.cwd, "new/last.txt"), "utf8"), "last");
  assert.equal((await lstat(join(f.cwd, "new/first.txt"))).mtimeMs, first.mtimeMs);
  assert.equal((await lstat(join(f.cwd, "new/last.txt"))).mtimeMs, last.mtimeMs);
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

{ const operation = 'copy' as const; test(`native ${operation} arrays share approved missing parents and dryRun creates nothing`, async t => {
  const { cwd: root } = await fixture(t), f = nativeFileSession(root), definitions: any = {};
  t.after(() => f.close()); f.files.install(definitions);
  await writeFile(join(root, "first"), "one"); await writeFile(join(root, "second"), "two");
  const input = { items: [{ path: "first", destination: "new/deep/first" }, { path: "second", destination: "new/deep/second" }] };
  const preview = await f.invoke(definitions, operation, { ...input, dryRun: true });
  assert.equal(preview.isError, false, JSON.stringify(preview)); assert.equal(preview.details.preview, true);
  assert.equal(preview.details.directories, 2); assert.equal(preview.details.resultRef, undefined);
  await assert.rejects(lstat(join(root, "new")), { code: "ENOENT" });
  const applied = await f.invoke(definitions, operation, input);
  assert.equal(applied.isError, false, JSON.stringify(applied)); assert.equal(applied.details.succeeded, 2); assert.equal(applied.details.directories, 2);
  assert.equal(await readFile(join(root, "new/deep/first"), "utf8"), "one"); assert.equal(await readFile(join(root, "new/deep/second"), "utf8"), "two");
  const reader = new FileResultReader(f.manager); t.after(() => reader.dispose());
  const rows = reader.read(applied.details.resultRef).records;
  assert.equal(rows.filter(row => row.record.phase === "prepared" && row.record.plannedDirectoryCount === 2).length, 2);
  const results = rows.filter(row => row.record.phase === "result");
  t.diagnostic(JSON.stringify(results.map(row => ({ index: row.record.index, count: (row.record.creation as any).createdDirectoryCount }))));
  assert.equal((results.find(row => row.record.index === 0)!.record.creation as any).createdDirectoryCount, 2);
  assert.equal((results.find(row => row.record.index === 1)!.record.creation as any).createdDirectoryCount, 0);
}); }

test("native file_batch write, copy and move share one planned parent inventory", async t => {
  const { cwd: root, service } = await fixture(t), f = nativeFileSession(root), definitions: any = {};
  t.after(() => f.close()); f.files.install(definitions);
  await writeFile(join(root, "copy-source"), "copy bytes"); await mkdir(join(root, "move-source")); await writeFile(join(root, "move-source/payload"), "move bytes");
  const description = new FileMutation(service, "describe", "copy", { path: "copy-source", destination: "new/deep/copied" });
  await description.prepare(); assert.match(description.describePreflight(), /destination, 2 missing parent directories/); description.release();
  const result = await f.invoke(definitions, "file_batch", { operations: [
    { operation: "write", path: "new/deep/written", mode: "create", content: "written" },
    { operation: "copy", path: "copy-source", destination: "new/deep/copied" },
    { operation: "move", path: "move-source", destination: "new/deep/moved" },
  ] });
  assert.equal(result.isError, false, JSON.stringify(result)); assert.equal(result.details.succeeded, 3); assert.equal(result.details.directories, 3);
  assert.equal(await readFile(join(root, "new/deep/written"), "utf8"), "written");
  assert.equal(await readFile(join(root, "new/deep/copied"), "utf8"), "copy bytes");
  assert.equal(await readFile(join(root, "new/deep/moved/payload"), "utf8"), "move bytes");
});

test("native array continues after a source changes following parent creation", async t => {
  const { cwd: root } = await fixture(t), f = nativeFileSession(root), definitions: any = {};
  t.after(() => f.close()); f.files.install(definitions);
  await writeFile(join(root, "first"), "one"); await writeFile(join(root, "second"), "two");
  const original = fsPromises.mkdir;
  t.mock.method(fsPromises, "mkdir", async (path: any, ...args: any[]) => {
    const result = await original(path, ...args);
    if (path === join(root, "new/deep")) await writeFile(join(root, "first"), "external change");
    return result;
  });
  syncBuiltinESMExports();
  try {
    const result = await f.invoke(definitions, "copy", { items: [{ path: "first", destination: "new/deep/first" }, { path: "second", destination: "new/deep/second" }] });
    assert.equal(result.details.partial, 1); assert.equal(result.details.unknown, 0); assert.equal(result.details.succeeded, 1);
    const reader = new FileResultReader(f.manager); t.after(() => reader.dispose());
    const failed = reader.read(result.details.resultRef).records.find(row => row.record.phase === "result" && row.record.index === 0)!;
    const creation = failed.record.creation as any;
    assert.equal(creation.createdDirectoryCount, 2); assert.equal(creation.createdDirectories.length, 2);
    assert.equal(await readFile(join(root, "new/deep/second"), "utf8"), "two"); await assert.rejects(lstat(join(root, "new/deep/first")), { code: "ENOENT" });
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
});
