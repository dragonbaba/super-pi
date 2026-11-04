import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createOwnedTaskFixture } from "./helpers/owned-task-fixture.ts";

for (const failure of ["error", "length", "abort"]) test(`split-turn ${failure} cannot persist a partial AgentSession checkpoint`, t => {
  const owned = createOwnedTaskFixture("h06-compaction-session-");
  t.after(owned.cleanup);
  const startedAt = new Date().toISOString();
  const child = spawnSync(process.execPath, ["--expose-gc", "--experimental-strip-types",
    fileURLToPath(new URL("./helpers/compaction-session-fixture.ts", import.meta.url)), owned.root, failure], {
    cwd: fileURLToPath(new URL("../", import.meta.url)), encoding: "utf8", timeout: 30_000, killSignal: "SIGKILL",
    maxBuffer: 1024 * 1024, env: { ...process.env, TMP: owned.root, TEMP: owned.root, TMPDIR: owned.root },
  });
  writeFileSync(join(owned.root, "resources.json"), JSON.stringify({ root: owned.root, createdSharedParent: owned.createdSharedParent,
    childPid: child.pid, startedAt, code: child.status, signal: child.signal, purpose: "AgentSession compaction " + failure }));
  assert.ifError(child.error);
  assert.equal(child.status, 0, child.stderr + child.stdout);
  const report = JSON.parse(child.stdout.trim().split("\n").at(-1)!) as { failure: string; requests: number; savedCompactions: number; listeners: number };
  assert.equal(report.failure, failure);
  assert.equal(report.requests, 2); assert.equal(report.savedCompactions, 0); assert.equal(report.listeners, 0);
});
