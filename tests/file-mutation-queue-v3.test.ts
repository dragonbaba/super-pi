import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { withFileMutationQueue, withFileMutationQueues } from "../packages/coding-agent/src/core/tools/file-mutation-queue.ts";
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

test("all-path reservations serialize overlapping owners, allow independent work and release on throw", async t => {
  const root = await mkdtemp(join(tmpdir(), "file-queue-v3-")); t.after(() => rm(root, { recursive: true, force: true }));
  const a = join(root, "a"), b = join(root, "b"), c = join(root, "c");
  const entered = deferred(), release = deferred(), independent = deferred();
  const events: string[] = [];
  const first = withFileMutationQueues([b, a], async () => { events.push("first"); entered.resolve(); await release.promise; throw new Error("first failure"); });
  const rejected = assert.rejects(first, /first failure/);
  await entered.promise;
  const second = withFileMutationQueues([a, b], async () => { events.push("second"); });
  const third = withFileMutationQueue(c, async () => { events.push("independent"); independent.resolve(); });
  await independent.promise; assert.deepEqual(events, ["first", "independent"]);
  release.resolve(); await Promise.all([rejected, second, third]);
  assert.deepEqual(events, ["first", "independent", "second"]);
  await withFileMutationQueues([a, a, b], async () => { await writeFile(a, "after release"); });
});

test("large lock setup has no recursive callback depth or item count admission", async t => {
  const root = await mkdtemp(join(tmpdir(), "file-queue-many-")); t.after(() => rm(root, { recursive: true, force: true }));
  const paths: string[] = []; for (let index = 0; index < 2000; index++) paths.push(join(root, String(index)));
  let executed = 0;
  await withFileMutationQueues(paths, async () => { executed++; });
  assert.equal(executed, 1);
});
