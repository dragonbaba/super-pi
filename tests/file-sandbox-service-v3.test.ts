import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, realpath, mkdir, writeFile, readFile, lstat, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { sandboxFileSession } from "./helpers/sandbox-file-session.ts";
import { WorkspaceSandboxTools } from "../packages/coding-agent/src/core/sandbox/workspace-tools.ts";
import { capturePathIdentity } from "../packages/coding-agent/src/core/files/file-tree-core.mjs";
import { runFileMutationRequest } from "../packages/coding-agent/src/core/sandbox/mxc-file-mutation-worker.mjs";
import { runFileObservationRequest } from "../packages/coding-agent/src/core/sandbox/mxc-file-observation-worker.mjs";
import { FileChangesV3 } from "../packages/coding-agent/src/core/files/file-changes-v3.ts";
import { FILE_RPC_REQUEST_BYTES, FILE_RPC_REPLY_BYTES } from "../packages/coding-agent/src/core/files/file-operation-limits.mjs";
import fsSync from "node:fs";
import fsPromises from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";

async function fixture(t: test.TestContext, changeReply?: (request: any, reply: any) => void) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "sandbox-session-v3-")));
  let cleanup: (() => Promise<void>) | undefined;
  t.after(async () => { try { await cleanup?.(); } finally { await rm(root, { recursive: true, force: true }); } });
  const cwd = join(root, "workspace"), exchange = join(root, "exchange"); await mkdir(cwd); await mkdir(exchange);
  const f = sandboxFileSession(cwd, "sandbox-write"), owner = new WorkspaceSandboxTools(cwd, root, "sandbox-write", () => f.runtime);
  const backend = (owner as any).backend, identity = await capturePathIdentity(cwd), owned: Map<string, any> = backend.manifests, sends: any[] = [];
  const runtimeRoot = join(root, "runtime"); await mkdir(runtimeRoot); const runtimeIdentity = await capturePathIdentity(runtimeRoot);
  backend.root = runtimeRoot; backend.tools = runtimeRoot; backend.identity = runtimeIdentity.device + ":" + runtimeIdentity.inode;
  backend.exchange = exchange; backend.executable = "fixture-executor"; backend.starts = 1;
  backend.roots.push(cwd); backend.identities.push(identity.device + ":" + identity.inode);
  backend.policy = async () => "fixture-policy"; backend.executorEnvironment = () => ({});
  // Only process launch is replaced. The real backend encodes/sends, meters,
  // parses and binds replies; artifacts use its production ownership registry.
  backend.runner.run = async (_executable: any, _args: any, _cwd: any, _env: any, signal: AbortSignal) => {
    signal.throwIfAborted(); const serialized = await readFile(join(runtimeRoot, "request.json"), "utf8"); assert(Buffer.byteLength(serialized) <= FILE_RPC_REQUEST_BYTES);
    const request = JSON.parse(serialized); sends.push({ phase: request.phase, start: request.start, count: request.items?.length });
    const reply = await (request.rpc === "file-observation-v1" ? runFileObservationRequest(request, serialized)
      : runFileMutationRequest(request, serialized)); assert(Buffer.byteLength(reply) <= FILE_RPC_REPLY_BYTES);
    const parsed = JSON.parse(reply); changeReply?.(request, parsed); const stdout = JSON.stringify(parsed);
    return { code: 0, stdout, stdoutBytes: Buffer.byteLength(stdout), stderr: "", stderrBytes: 0, timedOut: false, truncated: false };
  };
  const definitions = owner.install({}); f.files.installResultTool(definitions);
  for (const definition of Object.values(definitions)) f.policy.registerDefinition(definition);
  cleanup = async () => { await owner.close(); await f.close(); assert.equal(owned.size, 0); };
  return { ...f, cwd, definitions, owner, sends, owned, call: (name: string, input: any) => f.invoke(definitions, name, input) };
}

for (const operation of ["copy", "move"] as const) test(`sandbox ${operation} arrays share missing parents after a read-only dryRun`, async t => {
  const f = await fixture(t);
  await writeFile(join(f.cwd, "first"), "one"); await writeFile(join(f.cwd, "second"), "two");
  const input = { items: [{ path: "first", destination: "new/deep/first" }, { path: "second", destination: "new/deep/second" }] };
  const preview = await f.call(operation, { ...input, dryRun: true });
  assert.equal(preview.isError, false, JSON.stringify(preview)); assert.equal(preview.details.directories, 2);
  assert.equal(f.sends.some(row => row.phase === "execute"), false); await assert.rejects(lstat(join(f.cwd, "new")), { code: "ENOENT" });
  const applied = await f.call(operation, input);
  assert.equal(applied.isError, false, JSON.stringify(applied)); assert.equal(applied.details.succeeded, 2); assert.equal(applied.details.directories, 2);
  assert.equal(await readFile(join(f.cwd, "new/deep/first"), "utf8"), "one"); assert.equal(await readFile(join(f.cwd, "new/deep/second"), "utf8"), "two");
  assert.equal(f.owned.size, 0);
});

test("sandbox file_batch shares write-created parents with later copy and directory move", async t => {
  const f = await fixture(t); await writeFile(join(f.cwd, "copy-source"), "copy bytes");
  await mkdir(join(f.cwd, "move-source")); await writeFile(join(f.cwd, "move-source/payload"), "move bytes");
  const result = await f.call("file_batch", { operations: [
    { operation: "write", mode: "create", path: "new/deep/written", content: "written" },
    { operation: "copy", path: "copy-source", destination: "new/deep/copied" },
    { operation: "move", path: "move-source", destination: "new/deep/moved" },
  ] });
  assert.equal(result.isError, false, JSON.stringify(result)); assert.equal(result.details.succeeded, 3); assert.equal(result.details.directories, 3);
  assert.equal(await readFile(join(f.cwd, "new/deep/copied"), "utf8"), "copy bytes");
  assert.equal(await readFile(join(f.cwd, "new/deep/moved/payload"), "utf8"), "move bytes"); assert.equal(f.owned.size, 0);
});

test("sandbox array continues after a source changes following parent creation", async t => {
  const f = await fixture(t); await writeFile(join(f.cwd, "first"), "one"); await writeFile(join(f.cwd, "second"), "two");
  const original = fsPromises.mkdir;
  t.mock.method(fsPromises, "mkdir", async (path: any, ...args: any[]) => {
    const result = await original(path, ...args);
    if (path === join(f.cwd, "new/deep")) await writeFile(join(f.cwd, "first"), "external change");
    return result;
  });
  syncBuiltinESMExports();
  try {
    const result = await f.call("copy", { items: [{ path: "first", destination: "new/deep/first" }, { path: "second", destination: "new/deep/second" }] });
    assert.equal(result.details.partial, 1); assert.equal(result.details.unknown, 0); assert.equal(result.details.succeeded, 1);
    assert.equal(await readFile(join(f.cwd, "new/deep/second"), "utf8"), "two"); await assert.rejects(lstat(join(f.cwd, "new/deep/first")), { code: "ENOENT" });
    assert.equal(f.owned.size, 0);
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
});

test("sandbox v3 uses the session journal and SHA continuation without native versions", async t => {
  const f = await fixture(t);
  const first = await f.call("write", { path: "deep/one", content: "one" }); assert.equal(first.isError, false, JSON.stringify(first));
  assert.match(first.details.snapshot, /^[a-f0-9]{64}$/); assert.equal(f.owned.size, 0);
  const second = await f.call("edit", { path: "deep/one", snapshot: first.details.snapshot, edits: [{ oldText: "one", newText: "two" }] });
  assert.equal(second.isError, false, JSON.stringify(second)); assert.equal(await readFile(join(f.cwd, "deep/one"), "utf8"), "two");
  const calls = f.sends.length, result = await f.call("file_result", { ref: second.details.resultRef });
  assert.equal(f.sends.length, calls, "metadata query must not start a worker"); assert.equal(result.isError, undefined);
  assert.match(JSON.stringify(result), new RegExp(second.details.snapshot)); assert.equal(f.owned.size, 0);
});

test("sandbox arrays cross transport chunks only after complete preflight and retain every outcome", async t => {
  const f = await fixture(t), paths: string[] = [];
  for (let index = 0; index < 70; index++) { const path = "file-" + index; paths.push(path); await writeFile(join(f.cwd, path), "x"); }
  const result = await f.call("delete", { paths }); assert.equal(result.isError, false, JSON.stringify(result));
  assert.equal(result.details.succeeded, paths.length); assert.equal(result.details.itemsOmitted, true);
  const firstExecute = f.sends.findIndex(row => row.phase === "execute");
  assert(f.sends.slice(0, firstExecute).filter(row => row.phase === "prepare").length > 1);
  assert(f.sends.slice(0, firstExecute).filter(row => row.phase === "validate").length > 1);
  assert.equal(f.sends.filter(row => row.phase === "execute").length, paths.length); assert.equal(f.owned.size, 0);
});

test("sandbox changes verification observes worker bytes and never grants a native file version", async t => {
  const f = await fixture(t), result = await f.call("write", { path: "observed", content: "original" });
  const changes = new FileChangesV3(f.manager); t.after(() => changes.dispose());
  changes.open(result.details.resultRef); const page = changes.nextItems(), record = page.records[0];
  const observed = await f.files.observeFileChange(f.ctx, record); assert.equal(observed.postimageMatches, true);
  await writeFile(join(f.cwd, "observed"), "external change");
  assert.equal((await f.files.observeFileChange(f.ctx, record)).postimageMatches, false);
  assert.equal(f.files.hasRevision(result.details.snapshot, join(f.cwd, "observed"), f.manager.getSessionId()), false);
});

for (const failure of ["index", "snapshot", "transport", "generation", "wire-hash", "ready", "intent", "missing-item", "extra-item", "not-started", "outcome", "native-version", "created-parent-count"] as const) test(`sandbox ${failure} loss after publication stops later effects without replay`, async t => {
  const f = await fixture(t, (request, reply) => {
    if (request.phase !== "execute") return;
    if (failure === "index") reply.items[0].index++;
    if (failure === "snapshot") reply.items[0].receipt.snapshot = "a".repeat(64);
    if (failure === "transport") throw new Error("transport lost after publication");
    if (failure === "generation") reply.generation++;
    if (failure === "wire-hash") reply.wireHash = "a".repeat(64);
    if (failure === "ready") reply.items[0].readyHash = "b".repeat(64);
    if (failure === "intent") reply.items[0].intentId = "deadbeef";
    if (failure === "missing-item") reply.items = [];
    if (failure === "extra-item") reply.items.push(reply.items[0]);
    if (failure === "not-started") reply.items[0].receipt.status = "not_started";
    if (failure === "outcome") reply.items[0].receipt.stateChanged = false;
    if (failure === "native-version") reply.items[0].receipt.revision = "snap_forbidden";
    if (failure === "created-parent-count") {
      delete reply.items[0].receipt.createdParents;
      reply.items[0].receipt.creation.createdDirectories.push({ path: "untrusted parent" });
      reply.items[0].receipt.creation.createdDirectoriesOmitted = -1;
    }
  });
  const result = await f.call("file_batch", { operations: [
    { operation: "write", mode: "create", path: "published", content: "kept" },
    { operation: "write", mode: "create", path: "unstarted", content: "unsafe" },
  ] });
  assert.equal(result.isError, true); assert.equal(result.details.unknown, 1); assert.equal(result.details.notStarted, 1);
  assert.equal(result.details.items[0].snapshot, undefined); assert.equal(f.sends.filter(row => row.phase === "execute").length, 1);
  assert.equal(await readFile(join(f.cwd, "published"), "utf8"), "kept");
  await assert.rejects(readFile(join(f.cwd, "unstarted")), { code: "ENOENT" }); assert.equal(f.owned.size, 0);
});

test("sandbox invalid last preparation rejects the entire invocation before any effect", async t => {
  const f = await fixture(t), paths = [];
  for (let index = 0; index < 70; index++) { const path = "file-" + index; paths.push(path); await writeFile(join(f.cwd, path), "x"); }
  paths.push("missing-last"); await assert.rejects(f.call("delete", { paths }), /ENOENT|no such file|cannot find/i);
  assert.equal(f.sends.filter(row => row.phase === "execute").length, 0); assert.equal(await readFile(join(f.cwd, paths[0]), "utf8"), "x");
  // Refusal cleanup joins before a subsequent unrelated invocation can start.
  assert.equal(f.owned.size, 0); assert.equal((await f.call("write", { path: "after-refusal", content: "allowed" })).isError, false);
});

test("sandbox failed preparation artifact cleanup permits the next independent request", async t => {
  const f = await fixture(t);
  t.mock.method(fsSync, "writeFileSync", () => { throw Object.assign(new Error("ENOSPC preparation inventory"), { code: "ENOSPC" }); });
  syncBuiltinESMExports();
  try { await assert.rejects(f.call("write", { path: "refused", content: "not written" }), /ENOSPC/); }
  finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
  assert.equal(f.owned.size, 0); await assert.rejects(readFile(join(f.cwd, "refused")), { code: "ENOENT" });
  const next = await f.call("write", { path: "next", content: "kept" });
  assert.equal(next.isError, false, JSON.stringify(next)); assert.equal(await readFile(join(f.cwd, "next"), "utf8"), "kept"); assert.equal(f.owned.size, 0);
});
