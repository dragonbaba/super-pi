import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { costSession, costCall as call, startCostMeasurement, finishCostMeasurement } from "../../tests/helpers/next-phase-session.ts";

function turns(strategy: string, calls: any[]): any[][] { return strategy === "T1" ? calls.map(item => [item]) : [calls]; }
function resultMetrics(f: Awaited<ReturnType<typeof costSession>>, label: string, start: ReturnType<typeof startCostMeasurement>) {
  const timing = finishCostMeasurement(f.metrics, start), { lastWire: _wire, ...metrics } = f.metrics;
  return { matrix: "N4-recovery-context", implementation: process.env.SP_COST_LABEL ?? "candidate", label, ...metrics,
    ...timing, estimator: "super-pi.conservative-v1", actualSerializer: true,
    providerUsage: null, cacheHits: null, actualCost: null, pendingCalls: f.session.agent.state.pendingToolCalls.size };
}

test("N4 cost metrics count the actual Session compaction-start event even when preparation refuses", async () => {
  const f = await costSession();
  try {
    assert.equal(f.metrics.compactions, 0);
    await assert.rejects(f.session.compact("No remote summary for this empty fixture."), /Nothing to compact/);
    assert.equal(f.metrics.compactions, 1); assert.equal(f.metrics.requests, 0);
    assert.equal(f.session.isCompacting, false);
  } finally { await f.release(); }
});

test("N4 estimator timing subtracts only requests inside each measured workload", async () => {
  const f = await costSession();
  try {
    await f.run([[call("setup", "tool_search", { query: "file_batch", limit: 1 })]]);
    assert.equal(f.metrics.estimatorPasses, f.metrics.requests * 2);
    for (let round = 0; round < 2; round++) {
      const requests = f.metrics.requests, start = startCostMeasurement(f.metrics);
      await f.run([]);
      const timing = finishCostMeasurement(f.metrics, start);
      assert.equal(timing.estimatorPasses, (f.metrics.requests - requests) * 2);
      assert.ok(timing.estimatorPasses < f.metrics.estimatorPasses);
      assert.ok(timing.estimatorElapsedMs > 0);
      assert.equal(timing.cpuUs + timing.estimatorCpuUs, timing.inclusiveCpuUs);
      assert.ok(Math.abs(timing.elapsedMs + timing.estimatorElapsedMs - timing.inclusiveElapsedMs) < 0.000001);
    }
  } finally { await f.release(); }
});

test("N4 context matrix: fair T1/T2/T3 short/long/reopen/model-switch/warm activation", { timeout: 180000 }, async t => {
  for (const context of ["short", "long", "reopen", "model-switch", "warm"]) for (const strategy of ["T1", "T2", "T3"]) {
    const f = await costSession({ historyPairs: context === "long" ? 100 : 0 });
    try {
      for (let index = 0; index < 4; index++) writeFileSync(join(f.cwd, `file${index}`), `FIRST-${index}\r\n中文 SECOND-${index}\r\n`);
      const start = startCostMeasurement(f.metrics);
      if (context === "reopen") {
        await f.run([], "Record this session before reopening."); const requests = f.metrics.requests;
        await f.reopen(); assert.equal(f.metrics.requests, requests, "reopening cannot call provider or replay tools");
        assert.equal(f.metrics.toolCalls, 0);
      }
      if (context === "model-switch") await f.switchModel();
      if (strategy === "T3") await f.run([[call("discover", "tool_search", { query: "file_batch", limit: 1 })]]);
      if (context === "warm") {
        // A real prior read activates the same default tool; the cost stays in the task.
        await f.run([[call("warm-read", "read", { path: "file0" })]]);
      }
      await f.run(turns(strategy, [0, 1, 2, 3].map(index => call(`read${index}`, "read", { path: `file${index}` }))));
      const operations = [0, 1, 2, 3].map(index => ({ operation: "edit", path: `file${index}`, edits: [{ oldText: `FIRST-${index}`, newText: `AFTER-${index}` }] }));
      await f.run(strategy === "T3" ? [[call("batch", "file_batch", { operations })]] : turns(strategy, operations.map(({ operation, ...args }, index) => call(`edit${index}`, operation, args))));
      for (const message of f.session.messages) if (message.role === "toolResult") assert.equal(message.isError, false, JSON.stringify(message));
      for (let index = 0; index < 4; index++) assert.equal(readFileSync(join(f.cwd, `file${index}`), "utf8"), `AFTER-${index}\r\n中文 SECOND-${index}\r\n`);
      t.diagnostic(JSON.stringify({ ...resultMetrics(f, `${context}:${strategy}`, start), quality: "four exact updates, CRLF/content preserved", retries: 0, supplementalReads: context === "warm" ? 1 : 0 }));
    } finally { await f.release(); }
    global.gc?.(); t.diagnostic(JSON.stringify({ release: `${context}:${strategy}`, heapAfterFixtureRelease: process.memoryUsage().heapUsed, pendingCalls: 0, removedRoot: !existsSync(f.root) }));
  }
});
