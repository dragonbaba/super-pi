import assert from "node:assert/strict";
import { Session } from "node:inspector/promises";
import { setImmediate } from "node:timers/promises";
import { inspectBashResourceLifecycle, inspectHighRiskBashMutation } from "../../packages/extensions/resource-lifecycle-guard/core.ts";
import { inspectBashPermissionScope } from "../../packages/extensions/resource-lifecycle-guard/permission-bash.ts";
import { ShellAnalysisOwner, shellAnalysisOwnership, MAX_ANALYSIS_BYTES, MAX_ANALYSIS_ENTRIES } from "../../packages/extensions/resource-lifecycle-guard/shell-analysis.ts";
import { shellAnalysisCounters } from "../../packages/extensions/resource-lifecycle-guard/shell-substitution.ts";

const gc = (globalThis as { gc?: () => void }).gc;
assert.ok(gc, "run with --expose-gc");
const cwd = process.cwd(), iterations = 512, warmup = 64, samplingInterval = 4096;
const substitution = "$(grep -c -E '(class|function|const|var|let) GCSystem\\b' pixi/pixi.js)";
const cases = [
  ["ordinary", "printf ok", 1],
  ["quoted-16", `printf '%s ' ${Array(16).fill(`"${substitution}"`).join(" ")}`, 2],
  ["unquoted-16", `printf '%s ' ${Array(16).fill(substitution).join(" ")}`, 2],
  ["heredoc-data", `cat > out <<'EOF'\n${"literal data & $HOME\n".repeat(512)}EOF`, 1],
] as const;
const references: WeakRef<object>[] = [];

function analyze(command: string, lifecycle = "complete"): void {
  const owner = new ShellAnalysisOwner(command, cwd, 1);
  try {
    owner.assertCurrent(command, cwd, 1);
    inspectBashResourceLifecycle({ command }, false, owner);
    inspectHighRiskBashMutation({ command }, cwd, "bash", owner);
    inspectBashPermissionScope({ command }, cwd, owner);
    if (lifecycle !== "complete") {
      const prepared = owner.get(command);
      references.push(new WeakRef(owner), new WeakRef(prepared), new WeakRef(prepared.view), new WeakRef(prepared.substitutions.scripts));
      if (lifecycle === "failure") throw new Error("fixture failure");
      if (lifecycle === "cancel") { owner.release(); return; }
      if (lifecycle === "invalidate") owner.assertCurrent(command, cwd, 2);
    }
  } catch (error) {
    if (lifecycle !== "failure" && lifecycle !== "invalidate") throw error;
  } finally {
    owner.release();
    assert.equal(owner.size, 0);
    assert.equal(owner.retainedBytes, 0);
  }
}

for (const [name, command, uniqueSources] of cases) {
  for (let i = 0; i < warmup; i++) analyze(command);
  gc();
  const before = { ...shellAnalysisCounters }, ownership = { ...shellAnalysisOwnership };
  const session = new Session(); session.connect();
  let sampledBytes = 0;
  const sites: { name: string; bytes: number }[] = [];
  const times: number[] = [];
  try {
    await session.post("HeapProfiler.startSampling", { samplingInterval, includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true });
    for (let i = 0; i < iterations; i++) {
      const start = performance.now(); analyze(command); times.push(performance.now() - start);
    }
    const { profile } = await session.post("HeapProfiler.stopSampling");
    const stack = [profile.head];
    while (stack.length) {
      const node = stack.pop()!; sampledBytes += node.selfSize;
      if (node.selfSize) sites.push({ name: node.callFrame.functionName, bytes: node.selfSize });
      for (const child of node.children) stack.push(child);
    }
  } finally { session.disconnect(); }
  const counters = Object.fromEntries(Object.entries(shellAnalysisCounters).map(([key, value]) => [key, value - before[key as keyof typeof before]]));
  assert.equal(counters.prepareCalls, iterations * uniqueSources);
  assert.equal(shellAnalysisOwnership.misses - ownership.misses, iterations * uniqueSources);
  assert.equal(shellAnalysisOwnership.liveOwners, 0);
  assert.equal(shellAnalysisOwnership.liveEntries, 0);
  assert.equal(shellAnalysisOwnership.liveBytes, 0);
  sites.sort((a, b) => b.bytes - a.bytes); times.sort((a, b) => a - b);
  console.log(JSON.stringify({ name, iterations, warmup, samplingInterval, counters,
    cacheHits: shellAnalysisOwnership.hits - ownership.hits, cacheMisses: shellAnalysisOwnership.misses - ownership.misses,
    sampledBytesPerAnalysis: Math.round(sampledBytes / iterations), p50Ms: times[256], p95Ms: times[486], topSites: sites.slice(0, 8) }));
}
for (const lifecycle of ["normal-release", "failure", "cancel", "invalidate"]) analyze("printf lifecycle", lifecycle);
await setImmediate(); gc(); await setImmediate(); gc(); await setImmediate();
const liveReferences = references.filter(reference => reference.deref()).length;
assert.equal(liveReferences, 0);
assert.equal(shellAnalysisOwnership.created, shellAnalysisOwnership.released);
console.log(JSON.stringify({ ownership: shellAnalysisOwnership, weakReferences: references.length, liveReferences,
  maxEntriesPerAuthorization: MAX_ANALYSIS_ENTRIES, maxRetainedReferenceBytes: MAX_ANALYSIS_BYTES,
  counterByteUnit: "UTF-16 bytes submitted at real scanner entries; not total character accesses", node: process.version, v8: process.versions.v8, platform: process.platform }));
