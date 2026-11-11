import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { WorkspaceSandboxBackend } from "../packages/coding-agent/src/core/sandbox/workspace-backend.ts";
import { removeOwnedFixture } from "./helpers/owned-fixture-cleanup.ts";

for (const failed of [false, true]) test(`MXC close joins the pending operation before releasing resources: failed=${failed}`, async t => {
  const parent = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "mxc-close-")));
  t.after(() => removeOwnedFixture(parent));
  const root = path.join(parent, "owned"); await fs.mkdir(root); await fs.writeFile(path.join(root, "owned.txt"), "fixture");
  const backend = new WorkspaceSandboxBackend(parent, parent, "read-only"), internal = backend as any;
  const stat = await fs.lstat(root, { bigint: true }); internal.root = root; internal.identity = stat.dev + ":" + stat.ino;
  let resolve!: (value: any) => void, reject!: (error: Error) => void;
  const operation = new Promise<any>((yes, no) => { resolve = yes; reject = no; });
  t.mock.method(internal, "run", () => operation);
  const observed = Promise.allSettled([backend.invoke("ls", {})]);
  const close = backend.close(); assert.equal(close, backend.close());
  await fs.stat(root); assert.equal(backend.diagnostics.pending, true);
  await assert.rejects(backend.invoke("ls", {}), /SANDBOX_CLOSED/);
  if (failed) reject(new Error("operation failed")); else resolve({ id: "fixture", ok: true });
  await close; assert.equal((await observed)[0]!.status, failed ? "rejected" : "fulfilled");
  await assert.rejects(fs.stat(root), { code: "ENOENT" });
  assert.equal(backend.diagnostics.pending, false); assert.equal(backend.diagnostics.root, undefined);
  assert.equal(backend.close(), close);
});

test("MXC cleanup retains its exact root after failure and allows explicit cleanup retry", async t => {
  const parent = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "mxc-cleanup-")));
  t.after(() => removeOwnedFixture(parent));
  const root = path.join(parent, "owned"); await fs.mkdir(root);
  const backend = new WorkspaceSandboxBackend(parent, parent, "read-only"), internal = backend as any;
  const stat = await fs.lstat(root, { bigint: true }); internal.root = root; internal.identity = stat.dev + ":" + stat.ino;
  const remove = fs.rm; let failed = false;
  t.mock.method(fs, "rm", async (target: any, options: any) => {
    if (target === root && !failed) { failed = true; throw new Error("fixture sharing violation"); }
    return remove(target, options);
  });
  await assert.rejects(backend.close(), /sharing violation/); assert.equal(backend.diagnostics.root, root);
  await assert.rejects(backend.invoke("ls", {}), /SANDBOX_CLOSED/);
  await backend.close(); assert.equal(backend.diagnostics.root, undefined);
});

test("MXC startup failure does not retry commands or lose owned cleanup resources", async t => {
  const parent = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "mxc-startup-")));
  t.after(() => removeOwnedFixture(parent));
  const backend = new WorkspaceSandboxBackend(parent, parent, "read-only"), internal = backend as any;
  let starts = 0;
  t.mock.method(internal, "start", async () => {
    starts++; const root = await fs.mkdtemp(path.join(parent, "owned-"));
    const stat = await fs.lstat(root, { bigint: true }); internal.root = root; internal.identity = stat.dev + ":" + stat.ino;
    throw new Error("fixture native isolation unavailable");
  });
  await assert.rejects(backend.invoke("ls", {}), /native isolation unavailable/);
  await assert.rejects(backend.invoke("ls", {}), /SANDBOX_CLOSED/); assert.equal(starts, 1);
  const owned = backend.diagnostics.root!; await backend.close(); await assert.rejects(fs.stat(owned), { code: "ENOENT" });
});

for (const stage of ["empty", "prepared", "cleanup-failure"]) test(`MXC startup cancellation requires confirmed cleanup before a fresh request: ${stage}`, async t => {
  const parent = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "mxc-cancel-")));
  const backend = new WorkspaceSandboxBackend(parent, parent, "read-only"), internal = backend as any;
  t.after(async () => { await backend.close(); removeOwnedFixture(parent); });
  const remove = fs.rm; let failCleanup = stage === "cleanup-failure";
  t.mock.method(fs, "rm", async (target: any, options: any) => {
    if (target === backend.diagnostics.root && failCleanup) { failCleanup = false; throw new Error("fixture cleanup failed"); }
    return remove(target, options);
  });
  let starts = 0, executions = 0, entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; }), controller = new AbortController();
  t.mock.method(internal, "start", async (signal: AbortSignal) => {
    starts++;
    if (stage !== "empty" || starts > 1) {
      internal.root = await fs.mkdtemp(path.join(parent, "owned-"));
      const stat = await fs.lstat(internal.root, { bigint: true }); internal.identity = stat.dev + ":" + stat.ino;
      internal.tools = internal.root;
      const workspace = await fs.lstat(parent, { bigint: true });
      internal.roots.push(parent); internal.identities.push(workspace.dev + ":" + workspace.ino);
    }
    if (starts === 1) {
      const aborted = new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }));
      entered(); await aborted; signal.throwIfAborted();
    }
    internal.starts++;
  });
  t.mock.method(internal, "policy", async () => "fixture policy");
  t.mock.method(internal.runner, "run", async () => {
    executions++;
    const request = JSON.parse(await fs.readFile(path.join(internal.tools, "request.json"), "utf8"));
    return { code: 0, stdout: JSON.stringify({ id: request.id, ok: true, text: "fresh request",
      search: { version: 1, operation: "ls", outputMode: "files", scanComplete: true, coverageComplete: true,
        outputTruncated: false, excerptTruncated: false, stopReason: "none", visitedEntries: 0, scannedFiles: 0,
        observedRecords: 0, returnedRecords: 0, outputUnits: 0, skippedTooLarge: 0, skippedNonUtf8: 0, skippedNul: 0,
        excludedProtected: 0, excludedLinks: 0 } }), stderr: "", timedOut: false, truncated: false };
  });
  const pending = backend.invoke("ls", {}, controller.signal);
  const observed = assert.rejects(pending, stage === "cleanup-failure" ? /fixture cleanup failed/ : { name: "AbortError" });
  await started; const partialRoot = backend.diagnostics.root;
  controller.abort(); await observed;
  assert.equal(starts, 1); assert.equal(executions, 0); assert.equal(backend.diagnostics.pending, false);
  if (stage === "cleanup-failure") {
    assert.equal(backend.diagnostics.root, partialRoot);
    await assert.rejects(backend.invoke("ls", {}), /SANDBOX_CLOSED/);
    return;
  }
  assert.equal(backend.diagnostics.root, undefined); assert.equal(internal.roots.length, 0);
  if (partialRoot) await assert.rejects(fs.stat(partialRoot), { code: "ENOENT" });
  assert.equal((await backend.invoke("ls", {})).text, "fresh request");
  assert.equal(starts, 2); assert.equal(executions, 1);
});
