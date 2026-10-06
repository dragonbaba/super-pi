import assert from "node:assert/strict";
import { Session } from "node:inspector/promises";
import { setImmediate } from "node:timers/promises";
import { inspectBashResourceLifecycle, inspectHighRiskBashMutation } from "../../packages/extensions/resource-lifecycle-guard/core.ts";
import { inspectBashPermissionScope } from "../../packages/extensions/resource-lifecycle-guard/permission-bash.ts";
import { extractCommandSubstitutions } from "../../packages/extensions/resource-lifecycle-guard/shell-substitution.ts";

// The synchronous production analysis lane; the Agent authorization benchmark
// in tool-lifecycle-postmerge.test.ts covers invocation ownership and release.
const gc = (globalThis as { gc?: () => void }).gc;
assert.ok(gc, "run with --expose-gc");
const cwd = process.cwd();
const substitution = "$(grep -c -E '(class|function|const|var|let) GCSystem\\b' pixi/pixi.js)";
const cases = [
  ["ordinary", "printf ok"],
  ["quoted-16", `printf '%s ' ${Array(16).fill(`"${substitution}"`).join(" ")}`],
  ["unquoted-16", `printf '%s ' ${Array(16).fill(substitution).join(" ")}`],
  ["over-limit-17", `printf '%s ' ${Array(17).fill(substitution).join(" ")}`],
] as const;
const iterations = 512;
const owners: WeakRef<object>[] = [];
let retainedScans = 0;
function analyze(command: string, retainWeakRefs = false): void {
  const input = { command };
  inspectBashResourceLifecycle(input);
  const high = inspectHighRiskBashMutation(input, cwd);
  const scope = inspectBashPermissionScope(input, cwd)!;
  if (retainWeakRefs) {
    const scan = extractCommandSubstitutions(command);
    owners.push(new WeakRef(scan), new WeakRef(scan.scripts), new WeakRef(scope), new WeakRef(scope.targets));
    if (high) owners.push(new WeakRef(high));
    retainedScans++;
    assert.ok(scan.scripts.length <= 16);
  }
}
for (const [name, command] of cases) {
  for (let index = 0; index < 64; index++) analyze(command);
  gc();
  const session = new Session();
  session.connect();
  let sampledBytes = 0;
  const sites: { name: string; bytes: number }[] = [];
  try {
    await session.post("HeapProfiler.startSampling", { samplingInterval: 4096, includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true });
    for (let index = 0; index < iterations; index++) analyze(command);
    const { profile } = await session.post("HeapProfiler.stopSampling");
    const stack = [profile.head];
    while (stack.length) {
      const node = stack.pop()!;
      sampledBytes += node.selfSize;
      if (node.selfSize) sites.push({ name: node.callFrame.functionName, bytes: node.selfSize });
      for (const child of node.children) stack.push(child);
    }
  } finally { session.disconnect(); }
  sites.sort((a, b) => b.bytes - a.bytes);
  const sampledBytesPerAnalysis = Math.round(sampledBytes / iterations);
  // Coarse regression ceilings with headroom for sampling and runtime variation.
  const allocationCeiling = name === "ordinary" ? 64 * 1024 : name === "over-limit-17" ? 320 * 1024 : 384 * 1024;
  assert.ok(sampledBytesPerAnalysis > 0 && sampledBytesPerAnalysis < allocationCeiling, `${name}: allocation budget exceeded`);
  console.log(JSON.stringify({ name, iterations, sampledBytesPerAnalysis, allocationCeiling, topSites: sites.slice(0, 4) }));
  analyze(command, true);
}
await setImmediate();
for (let index = 0; index < 3; index++) { gc(); await setImmediate(); }
let liveReferences = 0;
for (const owner of owners) if (owner.deref()) liveReferences++;
assert.equal(liveReferences, 0, "analysis results must be released after each synchronous call");
console.log(JSON.stringify({ counters: { analysisCalls: cases.length * (64 + iterations + 1), retainedScans, weakReferences: owners.length, liveReferences, substitutionCapacity: 16 }, node: process.version, platform: process.platform }));
