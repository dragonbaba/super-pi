import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { realpathSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { resolve } from "node:path";
import { after, mock, type TestContext } from "node:test";
import { MutationWriteGuard } from "./mutation-fixture.ts";

// Jiti retains builtin function references. Install one test-process dispatcher;
// each test owns its gate, and teardown drops that reference even on failure.
let active: ReturnType<typeof createBarrier> | undefined;
const read = fs.readFile, write = fs.writeFile;
mock.method(fs, "readFile", async function(...args: any[]) {
  const bytes = await Reflect.apply(read, fs, args);
  await active?.afterRead(String(args[0]));
  return bytes;
});
mock.method(fs, "writeFile", function(...args: any[]) {
  active?.beforeWrite(String(args[0]));
  return Reflect.apply(write, fs, args);
});
syncBuiltinESMExports();
after(() => { active = undefined; mock.restoreAll(); syncBuiltinESMExports(); });

function createBarrier(target: string) {
  const canonicalTarget = realpathSync.native(target);
  let insideCommit = false, reached = false, issuedWrites = 0, completedHashReads = 0;
  let announce!: () => void, resume!: () => void;
  const arrival = new Promise<void>(resolve => { announce = resolve; });
  const gate = new Promise<void>(resolve => { resume = resolve; });
  return {
    resume, enter() { insideCommit = true; }, leave() { insideCommit = false; },
    async afterRead(path: string) {
      if (insideCommit && !reached && path === canonicalTarget) {
        reached = true; completedHashReads++; announce(); await gate;
      }
    },
    beforeWrite(path: string) { if (path === canonicalTarget) issuedWrites++; },
    get issuedWrites() { return issuedWrites; },
    get completedHashReads() { return completedHashReads; },
    async wait(pending: Promise<unknown>) {
      await Promise.race([arrival, pending.then(result => { assert.fail("tool completed before final hash-read barrier: " + JSON.stringify(result)); })]);
      assert.equal(completedHashReads, 1); assert.equal(issuedWrites, 0);
    },
  };
}

/** Real Agent, guard and filesystem; only the completed final hash read is held. */
export function exactCommitBarrier(t: TestContext, target: string) {
  assert.equal(active, undefined, "barriers must run serially");
  const barrier = createBarrier(target); active = barrier;
  const commit = MutationWriteGuard.prototype.writeEditContent;
  t.mock.method(MutationWriteGuard.prototype, "writeEditContent", async function(this: any, ...args: any[]) {
    if (resolve(args[0], args[1]) !== target) return commit.apply(this, args);
    barrier.enter();
    try { return await commit.apply(this, args); } finally { barrier.leave(); }
  });
  t.after(() => { barrier.resume(); active = undefined; });
  return barrier;
}
