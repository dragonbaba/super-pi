import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createOwnedTaskFixture } from "./helpers/owned-task-fixture.ts";

test("split-turn focus does not repeat large-history conversion or allocate more wrappers", t => {
  const owned = createOwnedTaskFixture("h06-compaction-counters-");
  t.after(owned.cleanup);
  const startedAt = new Date().toISOString();
  const verifyTemp = "import{tmpdir}from'node:os';import assert from'node:assert/strict';assert.equal(tmpdir(),process.env.TMP);assert.equal(process.env.TEMP,process.env.TMP);assert.equal(process.env.TMPDIR,process.env.TMP);";
  const child = spawnSync(process.execPath, ["--experimental-strip-types", "--import", "data:text/javascript," + encodeURIComponent(verifyTemp),
    fileURLToPath(new URL("../scripts/bench/compaction-instructions.ts", import.meta.url)), "counts"], {
    cwd: fileURLToPath(new URL("../", import.meta.url)), encoding: "utf8", timeout: 30_000, killSignal: "SIGKILL", maxBuffer: 1024 * 1024,
    env: { ...process.env, TMP: owned.root, TEMP: owned.root, TMPDIR: owned.root },
  });
  writeFileSync(join(owned.root, "resources.json"), JSON.stringify({ root: owned.root, createdSharedParent: owned.createdSharedParent,
    childPid: child.pid, startedAt, code: child.status, signal: child.signal, purpose: "compaction allocation counters" }));
  assert.ifError(child.error);
  assert.equal(child.status, 0, child.stderr);
  const lines = child.stdout.trim().split("\n");
  assert.equal(lines.length, 2);
  const report = JSON.parse(lines[1]!) as { counters: Record<string, number>; requests: number; wireCodeUnits: number; focusedRequests: number };
  assert.deepEqual(report.counters, { conversions: 2, serializations: 2, convertVisits: 1024, filterVisits: 1024,
    serializedVisits: 1024, objects: 1043, arrays: 13, closures: 6, templates: 1033, joins: 5 });
  assert.equal(report.requests, 2);
  assert.equal(report.focusedRequests, 2);
  assert.equal(report.wireCodeUnits, 2125456);
});
