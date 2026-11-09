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
