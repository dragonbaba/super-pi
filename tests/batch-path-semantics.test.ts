import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { existsSync, readFileSync, writeFileSync, mkdirSync, symlinkSync, unlinkSync, realpathSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join, resolve } from "node:path";
import test, { after, mock, type TestContext } from "node:test";
import { createJiti } from "jiti";
import { mutationFixture } from "./helpers/mutation-fixture.ts";
import { SessionManager } from "../packages/coding-agent/src/core/session-manager.ts";
import { collectStructuredMutationReceipts } from "../packages/extensions/mutation-guard-write/session-evidence.ts";

const { BatchInvocation } = await createJiti(import.meta.url).import<any>("../packages/extensions/mutation-guard-write/file-batch.ts");
type Hit = { operation: string; path: string; destination?: string };
let active: { cwd: string; canonical: string; hits: Hit[]; afterMkdir?: () => void; beforeOpen?: () => void } | undefined;
function record(operation: string, path: unknown, destination?: unknown) {
  if (active && typeof path === "string") {
    path = path.replace(active.cwd, active.canonical);
    if (!(path as string).startsWith(active.canonical) || (path as string).startsWith(join(active.canonical, "sessions"))) return;
    active.hits.push({ operation, path: path as string, ...(typeof destination === "string" ? { destination: destination.replace(active.cwd, active.canonical) } : {}) });
  }
}
// One test-process dispatcher: real filesystem calls, no production fault hook.
for (const name of ["writeFile", "link", "unlink", "rename"] as const) {
  const original = fs[name];
  mock.method(fs, name, function(...args: any[]) { record(name, args[0], name === "link" || name === "rename" ? args[1] : undefined); return Reflect.apply(original, fs, args); });
}
const mkdir = fs.mkdir;
mock.method(fs, "mkdir", async function(...args: any[]) {
  record("mkdir", args[0]); const result = await Reflect.apply(mkdir, fs, args); active?.afterMkdir?.(); return result;
});
const open = fs.open;
mock.method(fs, "open", async function(...args: any[]) {
  record(`open:${args[1]}`, args[0]);
  if (args[1] === "wx") active?.beforeOpen?.();
  const handle = await Reflect.apply(open, fs, args);
  const write = handle.writeFile;
  handle.writeFile = function(...values: any[]) { record("handle.writeFile", args[0]); return Reflect.apply(write, handle, values); };
  return handle;
});
syncBuiltinESMExports();
after(() => { active = undefined; mock.restoreAll(); syncBuiltinESMExports(); });

async function tracedFixture(t: TestContext) {
  const f = await mutationFixture(t);
  const hits: Hit[] = [], plans: any[] = [], dialogs: string[] = [];
  const canonical = realpathSync.native(f.cwd);
  active = { cwd: f.cwd, canonical, hits };
  t.after(() => { active = undefined; });
  const dispose = BatchInvocation.prototype.dispose;
  t.mock.method(BatchInvocation.prototype, "dispose", function(this: any) {
    for (const item of this.items) plans.push({ target: item.target, approval: item.approval.canonicalTarget,
      identity: item.identity?.canonical, snapshot: item.snapshot?.receipt.canonicalPath,
      creation: item.creation?.path.replace(f.cwd, canonical), directories: item.creation?.directories.map((p: string) => p.replace(f.cwd, canonical)) ?? [] });
    return dispose.call(this);
  });
  const ui = f.runner.getUIContext();
  f.runner.setUIContext({ ...ui, select: async (title: string, options: string[], config: any) => { dialogs.push(config?.details ?? title); return ui.select(title, options, config); } }, "tui");
  return { ...f, cwd: canonical, hits, plans, dialogs };
}
function snapshot(read: any) {
  const text = read.content.filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n");
  const start = text.indexOf("snapshot=") + 9;
  return { snapshot: text.slice(start, start + 27), edits: [{ kind: "replace", start: text.split("\n").find((r: string) => r.startsWith("1#"))!.split("|")[0], newLines: ["after"] }] };
}
function effects(hits: Hit[]) { return hits.filter(hit => hit.operation !== "open:r"); }
function diagnostic(t: TestContext, f: Awaited<ReturnType<typeof tracedFixture>>, result: any) {
  t.diagnostic(JSON.stringify({ error: result.isError, authorizationDialogs: f.dialogs, plans: f.plans, hits: f.hits,
    outcome: result.details?.items?.map((i: any) => ({ target: i.target, status: i.status })),
    literalParentExists: existsSync(join(f.cwd, "@new")), files: ["name.txt", "@name.txt", "new/file.txt", "@new/file.txt"].map(path => ({ path, text: existsSync(join(f.cwd, path)) ? readFileSync(join(f.cwd, path), "utf8") : null })) }));
}

for (const kind of ["create", "overwrite", "exact", "snapshot"] as const) test(`real batch @ path baseline: ${kind}`, async t => {
  const f = await tracedFixture(t);
  const target = join(f.cwd, kind === "create" ? "new/file.txt" : "name.txt");
  const literal = join(f.cwd, kind === "create" ? "@new/file.txt" : "@name.txt");
  let edit: any;
  if (kind !== "create") {
    writeFileSync(target, "before\n"); writeFileSync(literal, "before\n");
    const read = await f.call("read", { path: target }, "prior-read");
    assert.equal(read.isError, false); edit = snapshot(read);
    assert.equal((await f.call("read", { path: literal }, "literal-prior-read")).isError, false);
  }
  await f.runner.getCommand("permissions")!.handler("read-only", f.runner.createContext() as never);
  const input = { operations: [kind === "create" || kind === "overwrite"
    ? { operation: "write", path: kind === "create" ? "@new/file.txt" : "@name.txt", mode: kind, content: "after\n" }
    : { operation: "edit", path: "@name.txt", ...(kind === "snapshot" ? edit : { edits: [{ oldText: "before", newText: "after" }] }) }] };
  const raw = JSON.stringify(input);
  f.hits.length = 0;
  const result = await f.call("file_batch", input);
  diagnostic(t, f, result);
  assert.equal(result.isError, false, JSON.stringify(result));
  assert.equal(readFileSync(target, "utf8"), "after\n");
  assert.equal(kind === "create" ? existsSync(join(f.cwd, "@new")) : readFileSync(literal, "utf8"), kind === "create" ? false : "before\n");
  assert.equal(f.plans[0].target, target); assert.equal(f.plans[0].approval, target);
  if (kind === "snapshot") assert.equal(f.plans[0].snapshot, target);
  if (kind === "create") { assert.equal(f.plans[0].creation, target); assert.deepEqual(f.plans[0].directories, [join(f.cwd, "new")]); }
  assert.ok(f.dialogs.some(text => text.includes(target)), "real approval dialog names the execution target");
  for (const hit of effects(f.hits)) assert.ok(hit.path === target || hit.path.startsWith(join(f.cwd, "new")) || kind === "snapshot" && (hit.path.startsWith(join(f.cwd, ".pi-snapshot-edit-")) && (!hit.destination || hit.destination === target)), JSON.stringify(hit));
  assert.equal(JSON.stringify(input), raw, "raw request/transcript unchanged");
  const receipts = collectStructuredMutationReceipts(SessionManager.open(f.session.getSessionFile()!).getBranch());
  assert.equal(receipts.filter((r: any) => r.toolCallId === "file_batch").length, 1);
  assert.equal(f.agent.state.pendingToolCalls.size, 0);
});

const forms = [
  ["relative", "name.txt", "name.txt"], ["absolute", "$absolute", "name.txt"],
  ["at", "@name.txt", "name.txt"], ["double-at", "@@name.txt", "@name.txt"],
  ["literal-at", "./@name.txt", "@name.txt"], ["middle-at", "dir/@scope/name.txt", "dir/@scope/name.txt"],
  ["unicode-space", "@中文 space/name.txt", "中文 space/name.txt"], ["at-absolute", "$atAbsolute", "name.txt"],
];
for (const batch of [false, true]) for (const kind of ["create", "overwrite", "exact", "snapshot"]) for (const [label, form, expected] of forms) {
  test(`${batch ? "batch" : "single"} ${kind} path semantics: ${label}`, async t => {
    const f = await tracedFixture(t); const target = join(f.cwd, expected);
    const path = form === "$absolute" ? target : form === "$atAbsolute" ? `@${target}` : form;
    mkdirSync(resolve(target, ".."), { recursive: true });
    const untouched = join(f.cwd, expected === "@name.txt" ? "name.txt" : "@name.txt");
    writeFileSync(untouched, "before\n");
    let anchors: any;
    if (kind !== "create") { writeFileSync(target, "before\n"); anchors = snapshot(await f.call("read", { path: target }, "read")); }
    const item = kind === "create" || kind === "overwrite"
      ? { operation: "write", path, mode: kind, content: "after\n" }
      : { operation: "edit", path, ...(kind === "snapshot" ? anchors : { edits: [{ oldText: "before", newText: "after" }] }) };
    const { operation, mode: _mode, ...single } = item;
    const result = await f.call(batch ? "file_batch" : operation, batch ? { operations: [item] } : single);
    assert.equal(result.isError, false, JSON.stringify(result));
    assert.equal(readFileSync(target, "utf8"), "after\n"); assert.equal(readFileSync(untouched, "utf8"), "before\n");
    if (batch) { assert.equal(f.plans[0].target, target); assert.equal((result.details as any).items[0].target, target); }
    assert.equal(f.agent.state.pendingToolCalls.size, 0);
  });
}

for (const batch of [false, true]) test(`${batch ? "batch" : "single"} native source/destination keep literal @`, async t => {
  const f = await tracedFixture(t);
  for (const path of ["@remove", "remove", "@source", "source", "destination"]) writeFileSync(join(f.cwd, path), path);
  const operations = [{ operation: "delete", path: "@remove" }, { operation: "move", path: "@source", destination: "@destination" }];
  if (batch) assert.equal((await f.call("file_batch", { operations })).isError, false);
  else for (const { operation, ...input } of operations) assert.equal((await f.call(operation, input)).isError, false);
  assert.equal(existsSync(join(f.cwd, "@remove")), false); assert.equal(existsSync(join(f.cwd, "@source")), false);
  assert.equal(readFileSync(join(f.cwd, "@destination"), "utf8"), "@source");
  for (const path of ["remove", "source", "destination"]) assert.equal(readFileSync(join(f.cwd, path), "utf8"), path);
  assert.ok(f.hits.some(hit => hit.operation === "link" && hit.path === join(f.cwd, "@source") && hit.destination === join(f.cwd, "@destination")));
});

test("normalized aliases conflict before effects; distinct literal targets remain independent", async t => {
  const f = await tracedFixture(t);
  for (const paths of [["@new/file", "new/file"], ["@@new/file", "./@new/file"], [`@${join(f.cwd, "new/file")}`, "new/file"]]) {
    f.hits.length = 0;
    const result = await f.call("file_batch", { operations: paths.map(path => ({ operation: "write", mode: "create", path, content: "x" })) });
    assert.equal(result.isError, true); assert.deepEqual(effects(f.hits), []);
    assert.equal(existsSync(join(f.cwd, "new")), false); assert.equal(existsSync(join(f.cwd, "@new")), false);
  }
  const result = await f.call("file_batch", { operations: ["@new/a", "./@new/a"].map(path => ({ operation: "write", mode: "create", path, content: path })) });
  assert.equal(result.isError, false, JSON.stringify(result));
  assert.equal(readFileSync(join(f.cwd, "new/a"), "utf8"), "@new/a");
  assert.equal(readFileSync(join(f.cwd, "@new/a"), "utf8"), "./@new/a");
});

for (const reason of ["deny", "dry-run", "invalid-snapshot", "target-exists", "later-preflight", "changed-request"]) test(`@ no effects before execution: ${reason}`, async t => {
  const f = await tracedFixture(t);
  const operations: any[] = [{ operation: "write", mode: "create", path: "@new/deep/file", content: "x" }];
  if (reason === "deny") { await f.runner.getCommand("permissions")!.handler("read-only", f.runner.createContext() as never); f.deny(); }
  if (reason === "target-exists") { mkdirSync(join(f.cwd, "new/deep"), { recursive: true }); writeFileSync(join(f.cwd, "new/deep/file"), "original"); }
  if (reason === "later-preflight") operations.push({ operation: "delete", path: "absent" });
  if (reason === "invalid-snapshot") { writeFileSync(join(f.cwd, "existing"), "before"); operations.push({ operation: "edit", path: "@existing", snapshot: "invalid", edits: [{ kind: "replace", start: "1#1234", newLines: ["no"] }] }); }
  if (reason === "changed-request") {
    const consume = BatchInvocation.prototype.consume;
    t.mock.method(BatchInvocation.prototype, "consume", function(this: any, args: any, ...rest: any[]) { args.operations[0].path = "@other/file"; return consume.call(this, args, ...rest); });
  }
  f.hits.length = 0;
  const result = await f.call("file_batch", { operations, ...(reason === "dry-run" ? { dryRun: true } : {}) });
  assert.equal(result.isError, reason !== "dry-run", JSON.stringify(result)); assert.deepEqual(effects(f.hits), []);
  assert.equal(existsSync(join(f.cwd, "@new")), false); assert.equal(existsSync(join(f.cwd, "other")), false);
  if (reason === "target-exists") assert.equal(readFileSync(join(f.cwd, "new/deep/file"), "utf8"), "original");
  else assert.equal(existsSync(join(f.cwd, "new")), false);
  assert.equal(f.agent.state.pendingToolCalls.size, 0); assert.equal((f.runner as any).finalAuthorizations?.size ?? 0, 0);
});

for (const kind of ["create", "overwrite", "exact", "snapshot"]) test(`@ alias identity drift at approval: ${kind}`, async t => {
  const f = await tracedFixture(t); const alias = join(f.cwd, "alias");
  for (const root of ["one", "two"]) { mkdirSync(join(f.cwd, root, "inner"), { recursive: true }); writeFileSync(join(f.cwd, root, "inner/file"), "before\n"); }
  symlinkSync(join(f.cwd, "one"), alias, process.platform === "win32" ? "junction" : "dir");
  const read = await f.call("read", { path: join(alias, "inner/file") });
  await f.runner.getCommand("permissions")!.handler("read-only", f.runner.createContext() as never);
  f.onApprove(() => { unlinkSync(alias); symlinkSync(join(f.cwd, "two"), alias, process.platform === "win32" ? "junction" : "dir"); });
  const item = kind === "create" || kind === "overwrite" ? { operation: "write", mode: kind, path: kind === "create" ? "@alias/inner/new/file" : "@alias/inner/file", content: "after" }
    : { operation: "edit", path: "@alias/inner/file", ...(kind === "snapshot" ? snapshot(read) : { edits: [{ oldText: "before", newText: "after" }] }) };
  f.hits.length = 0;
  const result = await f.call("file_batch", { operations: [item] });
  assert.equal(result.isError, true); assert.equal(f.approvals(), 1); assert.deepEqual(effects(f.hits), []);
  for (const root of ["one", "two"]) { assert.equal(readFileSync(join(f.cwd, root, "inner/file"), "utf8"), "before\n"); assert.equal(existsSync(join(f.cwd, root, "inner/new")), false); }
});

for (const action of ["failure", "cancel"]) test(`@ partial batch ${action} retains receipts without replay`, async t => {
  const f = await tracedFixture(t);
  await f.freezeTurn();
  f.onRecord(data => { if (data.phase === "result" && data.itemId === "file_batch:0") { if (action === "cancel") f.agent.abort(); else writeFileSync(join(f.cwd, "new/b"), "external"); } });
  const result = await f.call("file_batch", { operations: ["a", "b", "c"].map(path => ({ operation: "write", mode: "create", path: `@new/${path}`, content: path })) });
  assert.equal(result.isError, true);
  assert.deepEqual((result.details as any).items.map((i: any) => i.status), ["succeeded", action === "cancel" ? "cancelled" : "failed_no_change", "not_started"]);
  assert.equal(readFileSync(join(f.cwd, "new/a"), "utf8"), "a"); assert.equal(existsSync(join(f.cwd, "new/c")), false);
  if (action === "failure") assert.equal(readFileSync(join(f.cwd, "new/b"), "utf8"), "external"); else assert.equal(existsSync(join(f.cwd, "new/b")), false);
  const hits = f.hits.length;
  const reopened = SessionManager.open(f.session.getSessionFile()!);
  for (let i = 0; i < 2; i++) assert.equal(collectStructuredMutationReceipts(reopened.getBranch()).filter((r: any) => r.itemId === "file_batch:0" && r.status === "succeeded").length, 1);
  assert.equal(f.hits.length, hits); assert.equal(existsSync(join(f.cwd, "@new")), false);
  const operations = Array.from({ length: 16 }, (_, i) => ({ operation: "write", mode: "create", path: `@probe/file${i}`, content: "" }));
  assert.equal((await f.call("file_batch", { operations: operations.slice(0, 15), dryRun: true }, "budget-15")).isError, false);
  assert.equal((await f.call("file_batch", { operations, dryRun: true }, "budget-16")).isError, true);
  assert.equal(existsSync(join(f.cwd, "probe")), false);
  assert.equal(f.agent.state.pendingToolCalls.size, 0); assert.equal((f.runner as any).finalAuthorizations?.size ?? 0, 0);
});

for (const action of ["failure", "cancel"]) test(`@ creation ${action} after mkdir reports retained directories`, async t => {
  const f = await tracedFixture(t);
  if (action === "cancel") active!.afterMkdir = () => f.agent.abort();
  else active!.beforeOpen = () => { throw new Error("injected open failure"); };
  const result = await f.call("file_batch", { operations: ["file", "later"].map(path => ({ operation: "write", mode: "create", path: `@new/${path}`, content: path })) });
  assert.equal(result.isError, true); const items = (result.details as any).items;
  assert.equal(items[0].status, "partial"); assert.equal(items[0].stateChanged, true); assert.equal(items[1].status, "not_started");
  assert.equal(items[0].receipt.createdDirectories.length, 1); assert.equal(items[0].receipt.createdDirectories[0].status, "retained");
  assert.equal(existsSync(join(f.cwd, "new")), true); assert.equal(existsSync(join(f.cwd, "@new")), false);
  assert.equal(existsSync(join(f.cwd, "new/file")), false); assert.equal(existsSync(join(f.cwd, "new/later")), false);
});
test("Windows normalized device paths reject before parent creation", { skip: process.platform !== "win32" }, async t => {
  const f = await tracedFixture(t);
  const result = await f.call("file_batch", { operations: ["@new/file", "@COM¹"].map(path => ({ operation: "write", mode: "create", path, content: "" })) });
  assert.equal(result.isError, true); assert.deepEqual(effects(f.hits), []); assert.equal(existsSync(join(f.cwd, "new")), false);
});
