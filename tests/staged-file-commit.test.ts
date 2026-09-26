import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile, readFile, readdir, rm, rename, link, lstat, realpath } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { commitPreparedFile, FileCommitError, type FileCommitPlan, type FileCommitHooks } from "../packages/extensions/mutation-guard-write/file-commit.ts";
import { capturePathIdentity } from "../packages/extensions/mutation-guard-write/native-file-core.ts";
import { disposeNativeFileWorker, nativeFileRequest } from "../packages/extensions/mutation-guard-write/native-file-client.ts";

async function fixture(t: any, content = "old\r\n完整\r\n") {
  const tempRoot = await realpath(tmpdir());
  const root = await mkdtemp(join(tempRoot, "sp-n2-commit-")), target = join(root, "中文.txt");
  t.after(async () => { await disposeNativeFileWorker(); assert.equal(dirname(root), tempRoot); await rm(root, { recursive: true, force: true }); });
  await writeFile(target, content);
  const plan: FileCommitPlan = { target: await capturePathIdentity(target), parent: await capturePathIdentity(root),
    previousSha256: createHash("sha256").update(content).digest("hex"),
    // Private synthetic files only: this test backend makes no platform metadata guarantee.
    metadata: { strategy: "staged_replace", prepareTemporary: async () => {}, assertCurrent: () => {}, replace: rename, replacementFailureMayChangeState: false,
      removeTemporary: process.platform === "win32" ? async (path, expected) => { await nativeFileRequest("remove", { path, expected }); } : undefined } };
  const hooks: FileCommitHooks = { assertPathAllowed: async () => target };
  return { root, target, plan, hooks, content };
}

test("N2 shared commit publishes a complete BOM/CRLF candidate and releases its temporary", async t => {
  const f = await fixture(t), candidate = Buffer.from("\ufeffnew\r\n完整\r\n");
  const result = await commitPreparedFile(f.plan, candidate, f.hooks);
  assert.equal(result.outcome, "committed"); assert.equal(result.fileSynced, true); assert.equal(result.directorySynced, false);
  assert.deepEqual(await readFile(f.target), candidate);
  assert.notEqual((await capturePathIdentity(f.target)).inode, f.plan.target.inode);
  assert.deepEqual(await readdir(f.root), ["中文.txt"]);
});

test("N2 failed staging/sync/close leaves original target and removes only owned temp", async t => {
  for (const stage of ["write", "sync", "close"] as const) {
    const f = await fixture(t); let injected = false;
    f.plan.metadata.prepareTemporary = async handle => {
      if (stage === "write") {
        const originalWrite = handle.writeFile.bind(handle);
        handle.writeFile = async () => { await originalWrite("partial"); injected = true; throw new Error("fixture ENOSPC after partial temporary write"); };
        return;
      }
      const original = handle[stage].bind(handle);
      let first = true;
      handle[stage] = async () => {
        if (first) { first = false; injected = true; throw new Error(`fixture ${stage} failed`); }
        return original();
      };
    };
    await assert.rejects(commitPreparedFile(f.plan, Buffer.from("new"), f.hooks), (error: unknown) => {
      assert.ok(error instanceof FileCommitError); assert.equal(error.receipt.outcome, "not_committed");
      if (process.platform !== "win32") assert.match(error.receipt.cleanupReason!, /no verified-object deletion primitive/);
      return true;
    });
    assert.equal(injected, true); assert.equal(await readFile(f.target, "utf8"), f.content);
    if (process.platform === "win32") assert.deepEqual(await readdir(f.root), ["中文.txt"]);
  }
});

test("N2 final gates refuse content/identity drift, disappearance and cancellation without fallback", async t => {
  for (const fault of ["content", "identity", "absent", "abort", "authority"] as const) {
    const f = await fixture(t), abort = new AbortController(); let authorized = true, publishes = 0;
    f.hooks.signal = abort.signal;
    f.hooks.assertCurrent = () => { if (!authorized) throw new Error("authority expired"); };
    f.plan.metadata.replace = async (from, to) => { publishes++; await rename(from, to); };
    f.hooks.beforeCommit = async () => {
      if (fault === "content") await writeFile(f.target, "external");
      if (fault === "identity") { await writeFile(join(f.root, "external"), f.content); await rename(join(f.root, "external"), f.target); }
      if (fault === "absent") await rm(f.target);
      if (fault === "abort") abort.abort();
      if (fault === "authority") authorized = false;
    };
    await assert.rejects(commitPreparedFile(f.plan, Buffer.from("forbidden"), f.hooks), (error: unknown) => {
      assert.ok(error instanceof FileCommitError); assert.equal(error.receipt.outcome, "not_committed"); return true;
    });
    assert.equal(publishes, 0);
    if (fault !== "absent") assert.equal(await readFile(f.target, "utf8"), fault === "content" ? "external" : f.content);
    assert.equal((await readdir(f.root)).some(name => name.startsWith(".pi-file-commit-")), process.platform !== "win32");
  }
});

test("N2 temporary name replacement is retained, never deleted as owned cleanup", async t => {
  const f = await fixture(t); let replacement = "";
  f.hooks.beforeCommit = async () => {
    const name = (await readdir(f.root)).find(name => name.startsWith(".pi-file-commit-"))!;
    replacement = join(f.root, name);
    await rename(replacement, join(f.root, "detached-owned"));
    await writeFile(replacement, "external object");
  };
  await assert.rejects(commitPreparedFile(f.plan, Buffer.from("new"), f.hooks), (error: unknown) => {
    assert.ok(error instanceof FileCommitError); assert.equal(error.receipt.retainedTemporary, replacement); return true;
  });
  assert.equal(await readFile(replacement, "utf8"), "external object");
  assert.equal(await readFile(f.target, "utf8"), f.content);
});

test("N2 same-object staged content drift fails before publish", async t => {
  const f = await fixture(t);
  f.hooks.beforeCommit = async () => {
    const name = (await readdir(f.root)).find(name => name.startsWith(".pi-file-commit-"))!;
    await writeFile(join(f.root, name), "evil");
  };
  await assert.rejects(commitPreparedFile(f.plan, Buffer.from("good"), f.hooks), /Staged content changed/);
  assert.equal(await readFile(f.target, "utf8"), f.content);
});

test("N2 staged identity is checked after the final asynchronous source gate", async t => {
  const f = await fixture(t); let checks = 0, foreign = "", published = false;
  f.plan.metadata.assertCurrent = async () => {
    if (++checks !== 2) return;
    const name = (await readdir(f.root)).find(name => name.startsWith(".pi-file-commit-"))!;
    foreign = join(f.root, name);
    await rename(foreign, join(f.root, "owned-detached"));
    await writeFile(foreign, "foreign");
  };
  f.plan.metadata.replace = async () => { published = true; };
  await assert.rejects(commitPreparedFile(f.plan, Buffer.from("new"), f.hooks), /Temporary file identity changed/);
  assert.equal(published, false); assert.equal(await readFile(foreign, "utf8"), "foreign");
  assert.equal(await readFile(f.target, "utf8"), f.content);
});

test("N2 cleanup rechecks the object inside its deletion primitive", { skip: process.platform !== "win32" }, async t => {
  const f = await fixture(t); let foreign = "";
  f.hooks.beforeCommit = () => { throw new Error("stop before publication"); };
  f.plan.metadata.removeTemporary = async (path, expected) => {
    await rename(path, join(f.root, "owned-detached"));
    await writeFile(path, "foreign"); foreign = path;
    await nativeFileRequest("remove", { path, expected });
  };
  await assert.rejects(commitPreparedFile(f.plan, Buffer.from("new"), f.hooks), (error: unknown) => {
    assert.ok(error instanceof FileCommitError); assert.equal(error.receipt.retainedTemporary, foreign); return true;
  });
  assert.equal(await readFile(foreign, "utf8"), "foreign");
});

test("N2 postcommit cancellation/readback failure remains committed; failed platform replacement can be unknown", async t => {
  for (const fault of ["abort", "readback", "platform"] as const) {
    const f = await fixture(t), abort = new AbortController(); f.hooks.signal = abort.signal;
    if (fault === "platform") {
      f.plan.metadata.replacementFailureMayChangeState = true;
      f.plan.metadata.replace = async () => { throw new Error("platform state uncertain"); };
    } else f.hooks.afterCommit = async () => { if (fault === "abort") abort.abort(); else await writeFile(f.target, "external"); };
    await assert.rejects(commitPreparedFile(f.plan, Buffer.from("new"), f.hooks), (error: unknown) => {
      assert.ok(error instanceof FileCommitError); assert.equal(error.receipt.outcome, fault === "platform" ? "unknown" : "committed"); return true;
    });
  }
});

test("N2 preselected compatibility preserves a hardlink and reports its weaker guarantee", async t => {
  const f = await fixture(t); const alias = join(f.root, "other.txt"); await link(f.target, alias);
  f.plan.target = await capturePathIdentity(f.target);
  f.plan.metadata.strategy = "protected_in_place"; f.plan.metadata.reason = "multiple hardlinks";
  f.plan.metadata.replace = async () => { assert.fail("compatibility must not attempt replacement"); };
  const receipt = await commitPreparedFile(f.plan, Buffer.from(""), f.hooks);
  assert.equal(receipt.strategy, "protected_in_place"); assert.equal(receipt.compatibilityReason, "multiple hardlinks");
  assert.equal((await lstat(f.target, { bigint: true })).ino.toString(), f.plan.target.inode);
  assert.equal(await readFile(alias, "utf8"), "");
});

test("N2 in-place commit starts at byte zero even when metadata inspection advances the cursor", async t => {
  const f = await fixture(t);
  f.plan.metadata.strategy = "protected_in_place";
  f.plan.metadata.assertCurrent = async handle => { await handle.read(Buffer.alloc(2), 0, 2, null); };
  const candidate = Buffer.from("new complete value");
  await commitPreparedFile(f.plan, candidate, f.hooks);
  assert.deepEqual(await readFile(f.target), candidate);
});

test("N2 missing parent preserves the temporary cleanup uncertainty", { skip: process.platform === "win32" }, async t => {
  const f = await fixture(t), nested = join(f.root, "nested");
  const { mkdir } = await import("node:fs/promises"); await mkdir(nested);
  await rename(f.target, join(nested, "target"));
  f.target = join(nested, "target"); f.plan.target = await capturePathIdentity(f.target); f.plan.parent = await capturePathIdentity(nested);
  f.hooks.assertPathAllowed = async () => f.target;
  f.hooks.beforeCommit = async () => { await rename(nested, join(f.root, "moved-parent")); };
  await assert.rejects(commitPreparedFile(f.plan, Buffer.from("new"), f.hooks), (error: unknown) => {
    assert.ok(error instanceof FileCommitError); assert.ok(error.receipt.retainedTemporary); assert.ok(error.receipt.cleanupReason); return true;
  });
  assert.ok((await readdir(join(f.root, "moved-parent"))).some(name => name.startsWith(".pi-file-commit-")));
});
