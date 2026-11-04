import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createOwnedTaskFixture } from "./helpers/owned-task-fixture.ts";

test("large cross-model history has bounded production traversal and request allocations", t => {
  const owned = createOwnedTaskFixture("h04-history-counters-");
  t.after(owned.cleanup);
  const startedAt = new Date().toISOString();
  const verifyTemp = "import{tmpdir}from'node:os';import assert from'node:assert/strict';assert.equal(tmpdir(),process.env.TMP);assert.equal(process.env.TEMP,process.env.TMP);assert.equal(process.env.TMPDIR,process.env.TMP);";
  const child = spawnSync(process.execPath, ["--experimental-strip-types", "--import", "data:text/javascript," + encodeURIComponent(verifyTemp),
    fileURLToPath(new URL("../scripts/bench/thinking-history.ts", import.meta.url)), "counts"], {
    cwd: fileURLToPath(new URL("../", import.meta.url)), encoding: "utf8", timeout: 30_000, killSignal: "SIGKILL", maxBuffer: 1024 * 1024,
    env: { ...process.env, TMP: owned.root, TEMP: owned.root, TMPDIR: owned.root },
  });
  writeFileSync(join(owned.root, "resources.json"), JSON.stringify({ root: owned.root, createdSharedParent: owned.createdSharedParent,
    childPid: child.pid, startedAt, code: child.status, signal: child.signal, purpose: "deterministic history allocation counters" }));
  assert.ifError(child.error);
  assert.equal(child.status, 0, child.stderr);
  const lines = child.stdout.trim().split("\n");
  const header = JSON.parse(lines[0]!) as { messages: number; thinkingCodeUnits: number };
  assert.equal(header.messages, 2048);
  assert.equal(header.thinkingCodeUnits, 8411050);
  const reports = lines.slice(1).map(line => JSON.parse(line) as {
    scene: string; counters: Record<string, number>; requests?: number; wireCodeUnits?: number; leakedRequests?: number;
  });
  assert.equal(reports.length, 3);
  for (const report of reports) {
    const projected = report.scene === "anthropic-no-tools";
    const counters = report.counters;
    assert.equal(counters.transformCalls, 1);
    assert.equal(counters.messageVisits, 2048);
    assert.equal(counters.secondMessageVisits, 2048);
    assert.equal(counters.blockVisits, projected ? 1024 : 2048);
    assert.equal(counters.secondBlockVisits, 1024);
    assert.equal(counters.projectedMessageVisits, projected ? 2048 : 0);
    assert.equal(counters.projectedBlockVisits, projected ? 2048 : 0);
    assert.equal(counters.thinkingTrimCalls, 0);
    assert.equal(counters.closures, 0);
    assert.equal(counters.arrays, projected ? 2052 : 1027);
    assert.equal(counters.objects, projected ? 4097 : 2048);
    assert.equal(counters.maps, 1);
    assert.equal(counters.sets, 1);
    if (report.scene !== "transform") {
      assert.equal(counters.capabilityCalls, 1);
      assert.equal(report.requests, 1);
      assert.equal(report.leakedRequests, 0);
      assert.ok(report.wireCodeUnits! < 200_000, "request must not rematerialize omitted thinking");
    }
  }
});
