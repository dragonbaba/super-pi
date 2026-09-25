import assert from "node:assert/strict";
import test, { after, mock } from "node:test";
import fs from "node:fs/promises";
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { syncBuiltinESMExports } from "node:module";
import { createJiti } from "jiti";
import { mutationFixture, MutationWriteGuard } from "./helpers/mutation-fixture.ts";
import { FakeScheduler } from "./helpers/runtime-instrumentation.ts";
const { BatchInvocation, getBatchPreparation } = await createJiti(import.meta.url).import<any>("../packages/extensions/mutation-guard-write/file-batch.ts");
let afterIO: ((kind: string, path: string) => void | Promise<void>) | undefined;
let writes: string[] | undefined;
for (const kind of ["realpath", "lstat", "readFile", "mkdir", "writeFile", "link", "unlink", "rename", "open"] as const) {
  const original = fs[kind];
  mock.method(fs, kind, async function(...args: any[]) {
    if (["mkdir", "writeFile", "link", "unlink", "rename"].includes(kind) || kind === "open" && args[1] === "wx") writes?.push(`${kind}:${args[0]}`);
    const result = await Reflect.apply(original, fs, args); await afterIO?.(kind, String(args[0])); return result;
  });
}
syncBuiltinESMExports();
after(() => { afterIO = undefined; writes = undefined; mock.restoreAll(); syncBuiltinESMExports(); });
function anchors(read: any) {
  const text = read.content.filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n"); const i = text.indexOf("snapshot=") + 9;
  return { snapshot: text.slice(i, i + 27), edits: [{ kind: "replace", start: text.split("\n").find((r: string) => r.startsWith("1#"))!.split("|")[0], newLines: ["after"] }] };
}
async function aliasFixture(t: test.TestContext) {
  const f = await mutationFixture(t); const cwd = realpathSync.native(f.cwd), alias = join(cwd, "alias");
  for (const name of ["one", "two"]) { mkdirSync(join(cwd, name, "inner"), { recursive: true }); writeFileSync(join(cwd, name, "inner/file"), "before\n"); await f.call("read", { path: join(cwd, name, "inner/file") }, `read-${name}`); }
  symlinkSync(join(cwd, "one"), alias, process.platform === "win32" ? "junction" : "dir");
  const read = await f.call("read", { path: join(alias, "inner/file") }, "read-alias");
  const hits: string[] = []; writes = hits;
  t.after(() => { afterIO = undefined; writes = undefined; });
  function drift() { unlinkSync(alias); symlinkSync(join(cwd, "two"), alias, process.platform === "win32" ? "junction" : "dir"); }
  return { ...f, cwd, alias, hits, read, drift };
}
for (const kind of ["exact", "overwrite", "snapshot", "create", "delete", "move"]) test(`R1 intent alias drift: ${kind}`, async t => {
  const f = await aliasFixture(t);
  f.onRecord(data => { if (data.phase === "intent" && data.itemId === "batch:1") f.drift(); });
  const path = kind === "create" ? "@alias/inner/new/file" : kind === "delete" || kind === "move" ? "alias/inner/file" : "@alias/inner/file";
  const item = kind === "create" || kind === "overwrite" ? { operation: "write", mode: kind, path, content: "after\n" }
    : kind === "delete" || kind === "move" ? { operation: kind, path, ...(kind === "move" ? { destination: "moved" } : {}) }
    : { operation: "edit", path, ...(kind === "snapshot" ? anchors(f.read) : { edits: [{ oldText: "before", newText: "after" }] }) };
  const result = await f.call("file_batch", { operations: [{ operation: "write", mode: "create", path: "first", content: "first" }, item, { operation: "write", mode: "create", path: "last", content: "last" }] }, "batch");
  t.diagnostic(JSON.stringify({ kind, statuses: (result.details as any)?.items?.map((i: any) => i.status), hits: f.hits, one: readFileSync(join(f.cwd, "one/inner/file"), "utf8"), two: readFileSync(join(f.cwd, "two/inner/file"), "utf8") }));
  assert.equal(result.isError, true); assert.deepEqual((result.details as any).items.map((i: any) => i.status), ["succeeded", "failed_no_change", "not_started"]);
  for (const root of ["one", "two"]) { assert.equal(readFileSync(join(f.cwd, root, "inner/file"), "utf8"), "before\n"); assert.equal(existsSync(join(f.cwd, root, "inner/new")), false); }
  assert.equal(readFileSync(join(f.cwd, "first"), "utf8"), "first"); assert.equal(existsSync(join(f.cwd, "last")), false); assert.equal(existsSync(join(f.cwd, "moved")), false);
});
for (const operation of ["delete", "move"]) test(`R2 assessment to native plan alias drift: ${operation}`, async t => {
  const f = await aliasFixture(t); let swapped = false;
  afterIO = (kind, path) => { if (!swapped && kind === "realpath" && path === join(f.alias, "inner/file")) { swapped = true; f.drift(); } };
  const result = await f.call("file_batch", { operations: [{ operation, path: join(f.alias, "inner/file"), ...(operation === "move" ? { destination: "moved" } : {}) }] });
  afterIO = undefined;
  t.diagnostic(JSON.stringify({ operation, swapped, result, hits: f.hits }));
  assert.equal(swapped, true); assert.equal(result.isError, true); assert.deepEqual(f.hits, []);
  for (const root of ["one", "two"]) assert.equal(readFileSync(join(f.cwd, root, "inner/file"), "utf8"), "before\n");
  assert.equal(existsSync(join(f.cwd, "moved")), false);
});
for (const mode of ["timeout", "cancel"]) for (const snapshots of [false, true]) for (const index of [0, 1, 2]) test(`R5 real tool_call ${mode} with pending item ${index}, snapshots=${snapshots}`, { timeout: 10000 }, async t => {
  const scheduler = new FakeScheduler(); const f = await mutationFixture(t, { scheduler, hookTimeouts: { safety: { timeoutMs: 100 } } });
  await f.freezeTurn();
  const path = join(realpathSync.native(f.cwd), `file${index}`), reads: any[] = []; for (let i = 0; i < 3; i++) { writeFileSync(join(f.cwd, `file${i}`), "before\n"); reads.push(await f.call("read", { path: join(f.cwd, `file${i}`) }, `read${i}`)); }
  // Reads above precede the frozen mutation round.
  await f.freezeTurn();
  let entered!: () => void, resume!: () => void, settled!: () => void;
  const arrival = new Promise<void>(r => { entered = r; }), gate = new Promise<void>(r => { resume = r; }), done = new Promise<void>(r => { settled = r; });
  let invocation: any, raw: any; const prepare = BatchInvocation.prototype.prepare;
  const fragments: any[] = []; const dispose = BatchInvocation.prototype.dispose;
  t.mock.method(BatchInvocation.prototype, "dispose", function(this: any) { for (const item of this.items) if (item.snapshot) fragments.push(item.snapshot.byteEdits); return dispose.call(this); });
  t.mock.method(BatchInvocation.prototype, "prepare", async function(this: any, ...args: any[]) { invocation = this; raw = this.original; try { return await prepare.apply(this, args); } finally { settled(); } });
  let held = false;
  afterIO = async (kind, target) => { if (!held && kind === "readFile" && realpathSync.native(target) === path) { held = true; entered(); await gate; } };
  t.after(() => { resume(); afterIO = undefined; });
  const pending = f.call("file_batch", { operations: [0, 1, 2].map(i => ({ operation: "edit", path: `file${i}`, ...(snapshots ? anchors(reads[i]) : { edits: [{ oldText: "before", newText: "after" }] }) })) }, "timed");
  await Promise.race([arrival, pending.then(result => { assert.fail(JSON.stringify(result)); })]);
  if (mode === "timeout") scheduler.advanceBy(100); else f.agent.abort();
  // Timeout rejects before I/O settles; direct cancellation may await cooperative preparation.
  if (mode === "cancel") resume();
  const result = await pending; assert.equal(result.isError, true); assert.equal(f.runner.hookDeliveryStats.timeouts, mode === "timeout" ? 1 : 0);
  resume(); await done; await new Promise<void>(r => setImmediate(r)); afterIO = undefined;
  t.diagnostic(JSON.stringify({ index, items: invocation.items.length, paths: invocation.paths.length, attached: getBatchPreparation(raw) !== undefined, tasks: scheduler.pendingTasks }));
  assert.equal(invocation.items.length, 0); assert.equal(invocation.paths.length, 0); assert.equal(getBatchPreparation(raw), undefined); assert.equal(scheduler.pendingTasks, 0);
  assert.equal(invocation.original, undefined); for (const fragment of fragments) assert.equal(fragment.length, 0);
  assert.equal(f.agent.state.pendingToolCalls.size, 0); assert.equal((f.runner as any).finalAuthorizations?.size ?? 0, 0);
  for (let i = 0; i < 3; i++) assert.equal(readFileSync(join(f.cwd, `file${i}`), "utf8"), "before\n");
  const operations = Array.from({ length: 16 }, (_, i) => ({ operation: "write", mode: "create", path: `probe/${i}`, content: "" }));
  assert.equal((await f.call("file_batch", { operations, dryRun: true }, "budget")).isError, false);
});

for (const kind of ["exact", "overwrite", "snapshot"]) for (const change of ["alias", "file", "parent"]) for (const protectedPath of [false, true]) test(`R1 final async read ${kind}/${change}/protected=${protectedPath}`, async t => {
  const f = await aliasFixture(t); let path = join(f.alias, "inner/file"), original = join(f.cwd, "one/inner/file");
  if (protectedPath) {
    const dir = join(f.cwd, ".git"); mkdirSync(dir); original = join(dir, "file"); writeFileSync(original, "before\n"); path = original;
    await f.call("read", { path: original }, "protected-read");
  }
  const read = await f.call("read", { path }, "final-read");
  let inside = false, staged = false, changed = false;
  const method = kind === "exact" ? "writeEditContent" : "write";
  if (kind !== "snapshot") {
    const originalMethod = MutationWriteGuard.prototype[method];
    t.mock.method(MutationWriteGuard.prototype, method, async function(this: any, ...args: any[]) { inside = true; try { return await originalMethod.apply(this, args); } finally { inside = false; } });
  }
  afterIO = (operation, target) => {
    if (operation === "open" && target.includes(".pi-snapshot-edit-")) staged = true;
    if (changed || operation !== "readFile" || target !== original || !(kind === "snapshot" ? staged : inside)) return;
    changed = true;
    if (change === "alias" && !protectedPath) f.drift();
    else if (change === "parent") { const parent = resolve(original, ".."); renameSync(parent, parent + "-old"); mkdirSync(parent); writeFileSync(original, "before\n"); }
    else { renameSync(original, original + "-old"); writeFileSync(original, "before\n"); }
  };
  const item = kind === "overwrite" ? { operation: "write", mode: "overwrite", path, content: "after\n" }
    : { operation: "edit", path, ...(kind === "snapshot" ? anchors(read) : { edits: [{ oldText: "before", newText: "after" }] }) };
  const result = await f.call("file_batch", { operations: [item] }, "final"); afterIO = undefined;
  assert.equal(changed, true); assert.equal(result.isError, true, JSON.stringify(result));
  assert.equal(readFileSync(original, "utf8"), "before\n"); assert.equal(readFileSync(join(f.cwd, "two/inner/file"), "utf8"), "before\n");
  assert.equal(f.hits.filter(hit => hit.startsWith("writeFile:") || hit.startsWith("rename:")).length, 0, JSON.stringify(f.hits));
});
for (const mode of ["attach-failure", "prepare-error", "handoff"]) test(`R5 ownership ${mode}`, async t => {
  const f = await mutationFixture(t); await f.freezeTurn(); let invocation: any, raw: any;
  const prepare = BatchInvocation.prototype.prepare;
  t.mock.method(BatchInvocation.prototype, "prepare", async function(this: any, ...args: any[]) { invocation = this; raw = this.original; const result = await prepare.apply(this, args); if (mode === "attach-failure") Object.preventExtensions(raw); return result; });
  const operations: any[] = [{ operation: "write", mode: "create", path: "new/file", content: "x" }];
  if (mode === "prepare-error") operations.push({ operation: "delete", path: "missing" });
  const result = await f.call("file_batch", { operations }, "owner");
  assert.equal(result.isError, mode !== "handoff"); assert.equal(invocation.items.length, 0); assert.equal(invocation.paths.length, 0); assert.equal(invocation.original, undefined); assert.equal(getBatchPreparation(raw), undefined);
  invocation.release(); assert.equal(invocation.items.length, 0);
  assert.equal(existsSync(join(f.cwd, "new/file")), mode === "handoff");
});

test("R5 late cleanup cannot refund a following call's successful charges", { timeout: 10000 }, async t => {
  const scheduler = new FakeScheduler(), f = await mutationFixture(t, { scheduler, hookTimeouts: { safety: { timeoutMs: 100 } } });
  const cwd = realpathSync.native(f.cwd);
  for (let i = 0; i < 3; i++) { writeFileSync(join(cwd, `old${i}`), "before"); await f.call("read", { path: `old${i}` }); }
  await f.freezeTurn();
  let enter!: () => void, resume!: () => void, finish!: () => void;
  const arrival = new Promise<void>(r => { enter = r; }), gate = new Promise<void>(r => { resume = r; }), done = new Promise<void>(r => { finish = r; });
  let held = false; const prepare = BatchInvocation.prototype.prepare;
  t.mock.method(BatchInvocation.prototype, "prepare", async function(this: any, ...args: any[]) { try { return await prepare.apply(this, args); } finally { if (this.id === "late") finish(); } });
  afterIO = async (kind, path) => { if (!held && kind === "readFile" && path === join(cwd, "old2")) { held = true; enter(); await gate; } };
  t.after(() => { resume(); afterIO = undefined; });
  const pending = f.call("file_batch", { operations: [0, 1, 2].map(i => ({ operation: "edit", path: join(cwd, `old${i}`), edits: [{ oldText: "before", newText: "after" }] })) }, "late");
  await arrival; scheduler.advanceBy(100); assert.equal((await pending).isError, true);
  const operations = Array.from({ length: 14 }, (_, i) => ({ operation: "write", mode: "create", path: `new${i}`, content: "done" }));
  assert.equal((await f.call("file_batch", { operations }, "following")).isError, false);
  resume(); await done; afterIO = undefined;
  assert.equal((await f.call("file_batch", { dryRun: true, operations: [0, 1, 2].map(i => ({ operation: "write", mode: "create", path: `excess${i}`, content: "" })) }, "over-budget")).isError, true);
  assert.equal((await f.call("file_batch", { dryRun: true, operations: [0, 1].map(i => ({ operation: "write", mode: "create", path: `allowed${i}`, content: "" })) }, "remaining")).isError, false);
  for (let i = 0; i < 3; i++) assert.equal(readFileSync(join(cwd, `old${i}`), "utf8"), "before");
  for (let i = 0; i < 14; i++) assert.equal(readFileSync(join(cwd, `new${i}`), "utf8"), "done");
  assert.equal(scheduler.pendingTasks, 0); assert.equal(f.agent.state.pendingToolCalls.size, 0);
});

for (const batch of [false, true]) test(`snapshot content changes during final path gate, batch=${batch}`, async t => {
  const f = await mutationFixture(t), target = join(realpathSync.native(f.cwd), "file"); writeFileSync(target, "before\n");
  const read = await f.call("read", { path: target }); let staged = false, finalRead = false, changed = false; const effects: string[] = []; writes = effects;
  afterIO = (kind, path) => {
    if (kind === "open" && path.includes(".pi-snapshot-edit-")) staged = true;
    if (staged && kind === "readFile" && path === target) finalRead = true;
    if (finalRead && !changed && kind === "realpath" && path === target) { changed = true; writeFileSync(target, "concurrent\n"); }
  };
  try {
    const item = { operation: "edit", path: target, ...anchors(read) };
    const result = await f.call(batch ? "file_batch" : "edit", batch ? { operations: [
      { operation: "write", mode: "create", path: "first", content: "first" }, item,
      { operation: "write", mode: "create", path: "last", content: "last" },
    ] } : { path: target, ...anchors(read) }, "snapshot-final-path");
    assert.equal(changed, true); assert.equal(result.isError, true, JSON.stringify(result)); assert.equal(readFileSync(target, "utf8"), "concurrent\n");
    assert.equal(effects.some(effect => effect.startsWith("rename:")), false);
    if (batch) { assert.deepEqual((result.details as any).items.map((item: any) => item.status), ["succeeded", "failed_no_change", "not_started"]); assert.equal(readFileSync(join(f.cwd,"first"),"utf8"),"first");assert.equal(existsSync(join(f.cwd,"last")),false); }
  } finally { afterIO = undefined; writes = undefined; }
});
