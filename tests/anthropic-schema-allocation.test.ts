import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createOwnedTaskFixture } from "./helpers/owned-task-fixture.ts";

test("Anthropic root definitions add no conversion passes, wrappers or deep clones", t => {
  const owned = createOwnedTaskFixture("h05-schema-counters-");
  t.after(owned.cleanup);
  const startedAt = new Date().toISOString();
  const verifyTemp = "import{tmpdir}from'node:os';import assert from'node:assert/strict';assert.equal(tmpdir(),process.env.TMP);assert.equal(process.env.TEMP,process.env.TMP);assert.equal(process.env.TMPDIR,process.env.TMP);";
  const child = spawnSync(process.execPath, ["--experimental-strip-types", "--import", "data:text/javascript," + encodeURIComponent(verifyTemp),
    fileURLToPath(new URL("../scripts/bench/anthropic-schema-definitions.ts", import.meta.url)), "counts"], {
    cwd: fileURLToPath(new URL("../", import.meta.url)), encoding: "utf8", timeout: 30_000, killSignal: "SIGKILL", maxBuffer: 1024 * 1024,
    env: { ...process.env, TMP: owned.root, TEMP: owned.root, TMPDIR: owned.root },
  });
  writeFileSync(join(owned.root, "resources.json"), JSON.stringify({ root: owned.root, createdSharedParent: owned.createdSharedParent,
    childPid: child.pid, startedAt, code: child.status, signal: child.signal, purpose: "schema conversion allocation counters" }));
  assert.ifError(child.error);
  assert.equal(child.status, 0, child.stderr);
  const lines = child.stdout.trim().split("\n");
  const header = JSON.parse(lines[0]!) as { tools: number; definitions: number; schemaCodeUnits: number };
  assert.deepEqual([header.tools, header.definitions, header.schemaCodeUnits], [16, 512, 352503]);
  assert.equal(lines.length, 3);
  for (const line of lines.slice(1)) {
    const report = JSON.parse(line) as { scene: string; counters: Record<string, number>; requests: number; wireCodeUnits: number; definitionsRequests: number };
    const inline = report.scene === "inline";
    assert.deepEqual(report.counters, { convertCalls: inline ? 1 : 2, toolVisits: 16,
      objects: inline ? 117 : 100, arrays: inline ? 26 : 22, closures: inline ? 7 : 5,
      clones: inline ? 1 : 0, serializations: inline ? 3 : 1, maps: inline ? 4 : 2, sets: inline ? 1 : 3 });
    assert.equal(report.requests, 1);
    assert.equal(report.definitionsRequests, 1);
    assert.equal(report.wireCodeUnits, inline ? 353548 : 353353);
  }
});
