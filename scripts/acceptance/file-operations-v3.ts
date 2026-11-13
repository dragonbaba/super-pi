import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, realpath, mkdir, writeFile, readFile, lstat, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { sandboxFileSession } from "../../tests/helpers/sandbox-file-session.ts";
import { WorkspaceSandboxTools } from "../../packages/coding-agent/src/core/sandbox/workspace-tools.ts";
import { FileChangesV3 } from "../../packages/coding-agent/src/core/files/file-changes-v3.ts";
import { FileResultReader } from "../../packages/coding-agent/src/core/files/file-result-store.ts";
import { FILE_RESULT_PAGE_BYTES, FILE_RPC_REQUEST_BYTES, FILE_RPC_REPLY_BYTES } from "../../packages/coding-agent/src/core/files/file-operation-limits.mjs";

const live = process.platform === "win32" && process.env.SUPERPI_FILE_V3_STRESS === "1";
const selectedOperation = process.env.SUPERPI_FILE_V3_STRESS_OPERATION;
const stressOperations = ["copy", "move", "delete", "file_batch"] as const;
if (selectedOperation && !stressOperations.includes(selectedOperation as any)) throw new Error("Unknown live stress operation");
const probe = process.platform === "win32" && process.env.SUPERPI_FILE_V3_PROBE === "1";
test("real MXC cross-volume files and directories use their independently authorized roots", {
  skip: !probe || !process.env.SP_FILE_CROSS_VOLUME_ROOT, timeout: 60000,
}, async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "file-v3-cross-"))), cwd = join(root, "workspace");
  let cleanup: (() => Promise<void>) | undefined;
  t.after(async () => { try { await cleanup?.(); } finally { await rm(root, { recursive: true, force: true }); } });
  await mkdir(cwd);
  const parent = await realpath(process.env.SP_FILE_CROSS_VOLUME_ROOT!), added = await realpath(await mkdtemp(join(parent, "mxc-cross-")));
  const identity = await lstat(added, { bigint: true });
  const f = sandboxFileSession(cwd, "sandbox-write", [added]);
  const owner = new WorkspaceSandboxTools(cwd, join(root, "runtime"), "sandbox-write", () => f.runtime, { directories: [added], network: "disabled" });
  cleanup = async () => {
    try { await owner.close(); await f.close(); }
    finally {
      const current = await lstat(added, { bigint: true });
      assert.equal(await realpath(added), added); assert.equal(dirname(added), parent);
      assert(!current.isSymbolicLink() && current.dev === identity.dev && current.ino === identity.ino);
      await rm(added, { recursive: true });
    }
  };
  assert.notEqual((await lstat(cwd, { bigint: true })).dev, identity.dev);
  const definitions = owner.install({}); for (const definition of Object.values(definitions)) f.policy.registerDefinition(definition);
  const bytes = Buffer.alloc(100003, 0x93); await writeFile(join(cwd, "source"), bytes);
  const copied = await f.invoke(definitions, "copy", { path: "source", destination: join(added, "copy") }); assert.equal(copied.isError, false, JSON.stringify(copied));
  assert.deepEqual(await readFile(join(added, "copy")), bytes); assert.deepEqual(await readFile(join(cwd, "source")), bytes);
  await mkdir(join(added, "directory")); await writeFile(join(added, "directory", "child"), "nested");
  for (const [path, destination] of [[join(cwd, "source"), join(added, "moved")], [join(added, "directory"), join(cwd, "directory")]]) {
    const result = await f.invoke(definitions, "move", { path, destination }); assert.equal(result.isError, false, JSON.stringify(result));
    await assert.rejects(lstat(path), { code: "ENOENT" });
    const reader = new FileResultReader(f.manager);
    try { assert.equal(reader.read(result.details.resultRef).records.find(row => row.record.phase === "prepared")?.record.moveStrategy, "copy_unlink_verified"); }
    finally { reader.dispose(); }
  }
  assert.deepEqual(await readFile(join(added, "moved")), bytes); assert.equal(await readFile(join(cwd, "directory", "child"), "utf8"), "nested");
  assert.equal(owner.diagnostics.ownedArtifacts, 0);
  t.diagnostic(JSON.stringify({ fixture: "real-MXC-cross-volume", operations: 3, ...owner.diagnostics }));
});

test("real MXC move probe compares primary and additional workspace destinations", { skip: !probe, timeout: 60000 }, async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "file-v3-probe-"))), cwd = join(root, "workspace"), additional = join(root, "added");
  await mkdir(cwd); await mkdir(additional);
  const f = sandboxFileSession(cwd, "sandbox-write", [additional]);
  const owner = new WorkspaceSandboxTools(cwd, join(root, "runtime"), "sandbox-write", () => f.runtime, { directories: [additional], network: "disabled" });
  const definitions = owner.install({}); for (const definition of Object.values(definitions)) f.policy.registerDefinition(definition);
  try {
    const outcomes = [];
    for (const [name, destination] of [["same", join(cwd, "same-target")], ["added", join(additional, "added-target")]]) {
      const path = join(cwd, name); await writeFile(path, "source");
      const result = await f.invoke(definitions, "move", { path, destination });
      outcomes.push({ name, isError: result.isError, status: result.details.status, reason: result.details.items?.[0]?.reason });
      if (!result.isError) { assert.equal(await readFile(destination, "utf8"), "source"); await assert.rejects(lstat(path), { code: "ENOENT" }); }
    }
    t.diagnostic(JSON.stringify({ fixture: "real-MXC-move-probe", outcomes })); assert(outcomes.every(item => !item.isError), JSON.stringify(outcomes));
  } finally { await owner.close(); await f.close(); await rm(root, { recursive: true }); }
});
test(`real MXC session: ${selectedOperation ?? "all four public operations"} covers 2,000 targets, result pages and SHA continuation`, { skip: !live, timeout: 45 * 60 * 1000 }, async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "file-v3-live-"))), cwd = join(root, "workspace"), additional = join(root, "added");
  await mkdir(cwd); await mkdir(additional);
  const f = sandboxFileSession(cwd, "sandbox-write", [additional]);
  const owner = new WorkspaceSandboxTools(cwd, join(root, "runtime"), "sandbox-write", () => f.runtime, { directories: [additional], network: "disabled" });
  const definitions = owner.install({}); f.files.installResultTool(definitions);
  for (const definition of Object.values(definitions)) f.policy.registerDefinition(definition);
  const samples: unknown[] = [], count = 2000;
  try {
    await mkdir(join(cwd, "source")); await mkdir(join(cwd, "copied")); await mkdir(join(additional, "moved")); await mkdir(join(cwd, "batch"));
    const copies = [], moves = [], deletes = [], writes = [];
    for (let index = 0; index < count; index++) {
      const name = `文件-${index}-😀`, source = join("source", name), copied = join("copied", name), moved = join(additional, "moved", name);
      await writeFile(join(cwd, source), "x"); copies.push({ path: source, destination: copied }); moves.push({ path: copied, destination: moved }); deletes.push(moved);
      writes.push({ operation: "write", mode: "create", path: join("batch", name), content: "one" });
    }
    for (const operation of stressOperations) {
      if (selectedOperation && selectedOperation !== operation) continue;
      const started = performance.now(), cpu = process.cpuUsage();
      process.stdout.write(JSON.stringify({ fixture: "real-MXC-2000", operation, phase: "starting", time: new Date().toISOString() }) + "\n");
      const input = operation === "copy" ? { items: copies } : operation === "move" ? { items: moves } : operation === "delete" ? { paths: deletes } : { operations: writes };
      const result = await f.invoke(definitions, operation, input);
      assert.equal(result.isError, false, JSON.stringify(result)); assert.equal(result.details.succeeded, count); assert.equal(result.details.itemsOmitted, true);
      const reader = new FileResultReader(f.manager); let cursor: string | undefined, outcomes = 0, lastSnapshot: string | undefined;
      try {
        do {
          const page = reader.read(result.details.resultRef, cursor, 128); assert(Buffer.byteLength(JSON.stringify(page)) <= FILE_RESULT_PAGE_BYTES);
          for (const row of page.records) if (row.record.phase === "result") {
            assert.equal(row.record.status, "succeeded"); outcomes++;
            if (row.record.index === count - 1) lastSnapshot = row.record.snapshot as string | undefined;
          }
          cursor = page.nextCursor ?? undefined;
        } while (cursor);
      } finally { reader.dispose(); }
      assert.equal(outcomes, count);
      const changes = new FileChangesV3(f.manager); let visited = 0;
      try { changes.open(result.details.resultRef); let more; do { const page = changes.nextItems(); visited += page.records.length; more = page.hasMore; } while (more); }
      finally { changes.dispose(); }
      assert.equal(visited, count);
      for (let index = 0; index < count; index++) {
        const name = `文件-${index}-😀`;
        if (operation === "copy") assert.equal(await readFile(join(cwd, "copied", name), "utf8"), "x");
        if (operation === "move") { assert.equal(await readFile(join(additional, "moved", name), "utf8"), "x"); await assert.rejects(lstat(join(cwd, "copied", name)), { code: "ENOENT" }); }
        if (operation === "delete") await assert.rejects(lstat(join(additional, "moved", name)), { code: "ENOENT" });
        if (operation === "file_batch") assert.equal(await readFile(join(cwd, "batch", name), "utf8"), "one");
      }
      if (operation === "file_batch") {
        assert.match(lastSnapshot!, /^[a-f0-9]{64}$/);
        const targetPath: string = writes[count - 1].path;
        const next = await f.invoke(definitions, "edit", { path: targetPath, snapshot: lastSnapshot, edits: [{ oldText: "one", newText: "two" }] });
        assert.equal(next.isError, false, JSON.stringify(next)); await writeFile(join(cwd, targetPath), "external");
        await assert.rejects(f.invoke(definitions, "edit", { path: targetPath, snapshot: next.details.snapshot, edits: [{ oldText: "two", newText: "unsafe" }] }), /preimage|snapshot|stale/i);
        assert.equal(await readFile(join(cwd, targetPath), "utf8"), "external");
      }
      assert.equal(owner.diagnostics.ownedArtifacts, 0); assert(owner.diagnostics.maxFileRpcRequestBytes <= FILE_RPC_REQUEST_BYTES); assert(owner.diagnostics.maxFileRpcReplyBytes <= FILE_RPC_REPLY_BYTES);
      const sample = { operation, items: count, milliseconds: performance.now() - started, hostCpuMicroseconds: process.cpuUsage(cpu), ...owner.diagnostics };
      samples.push(sample); process.stdout.write(JSON.stringify({ fixture: "real-MXC-2000", phase: "verified", ...sample }) + "\n");
    }
  } finally {
    await owner.close(); await f.close();
    assert.equal(owner.diagnostics.ownedArtifacts, 0); assert.equal(owner.diagnostics.process.active, false); assert.equal(owner.diagnostics.process.retainedStreams, 0);
    assert.equal(owner.diagnostics.root, undefined); await rm(root, { recursive: true });
  }
  t.diagnostic(JSON.stringify({ fixture: "real-MXC-2000", samples, released: true }));
});
