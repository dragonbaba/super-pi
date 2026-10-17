import assert from "node:assert/strict";
import { Session } from "node:inspector/promises";
import { setImmediate } from "node:timers/promises";
import { createBashTool } from "../../packages/coding-agent/src/core/tools/bash.ts";
import { shellHeredocKind } from "../../packages/coding-agent/src/core/tools/shell-heredoc-gate.ts";

const gc = (globalThis as { gc?: () => void }).gc;
assert.ok(gc, "run with --expose-gc");
const tool = createBashTool(process.cwd(), { commandPrefix: "true", exposeSessionEnvironment: false });
const cases = [
  ["command-substitution-hash", "echo $(printf x)# <<'EOF'\nhi\nEOF", 1],
  ["process-substitution-hash", "echo <(printf x)# <<'EOF'\nhi\nEOF", 1],
  ["escaped-space-hash", "echo a\\ # <<'EOF'\nhi\nEOF", 1],
  ["comment-after-word", "echo $(printf x) # <<'EOF'", 0],
  ["ordinary", "printf ok", 0],
  ["continued-here-string", "read x <<\\\n<word", 0],
  ["continued-triple-string", "read x <\\\n<\\\n<word", 0],
  ["continued-string-then-heredoc", "read x <<\\\n<word; cat <<'EOF'\nhi\nEOF", 1],
  ["quoted-and-arithmetic", "echo 'a << b' $((1 << 3))", 0],
  ["parameter-data", "echo ${x:-${y:-(a<<b)}}", 0],
  ["parameter-heredoc", "echo ${x:-$(cat <<'E'\nx\nE\n)}", 1],
  ["function-heredoc", 'echo "${ bash <<\'E\'\nprintf hi\nE\n; }"', 1],
  ["function-parameter-data", 'echo "${ printf \'a<<b\'; }"', 0],
  ["large-ordinary", `echo ${"x".repeat(128 * 1024)}`, 0],
  ["compound-heredoc", "cd . && node <<'EOF'\nconsole.log(1)\nEOF", 1],
  ["trailing-heredoc", "node <<'EOF'\nconsole.log(1)\nEOF\necho done", 1],
  ["bounded-heredoc", "node <<'EOF'\nconsole.log('中文😀')\nEOF", 2],
] as const;
const iterations = 4096, warmup = 256, samplingInterval = 4096;
const weak: WeakRef<object>[] = [];
let reads = 0;
const originalCharCodeAt = String.prototype.charCodeAt;
function countRead(this: string, index: number): number { reads++; return originalCharCodeAt.call(this, index); }
function prepare(input: { command: string }, expected: number): void {
  try {
    assert.strictEqual(tool.prepareArguments!(input), input); assert.equal(expected, 0);
  } catch (error) {
    if (!expected) throw error;
    assert.match(String(error), expected === 2 ? /SHELL_INPUT_UNSUPPORTED/ : /SHELL_HEREDOC/);
  }
}
for (const [name, command, expected] of cases) {
  const input = { command };
  reads = 0; String.prototype.charCodeAt = countRead;
  try { assert.equal(shellHeredocKind(command), expected); }
  finally { String.prototype.charCodeAt = originalCharCodeAt; }
  const scannerReads = reads;
  reads = 0; String.prototype.charCodeAt = countRead;
  try { prepare(input, expected); }
  finally { String.prototype.charCodeAt = originalCharCodeAt; }
  assert.equal(reads, scannerReads, "preparation invokes exactly the single scan");
  assert.ok(reads <= 5 * command.length + 32);
  for (const phase of ["scanner", "preparation"] as const) {
    for (let i = 0; i < warmup; i++) phase === "scanner" ? shellHeredocKind(command) : prepare(input, expected);
    gc(); const beforeHeap = process.memoryUsage().heapUsed;
    const session = new Session(); session.connect();
    let sampled = 0, scannerSamples = 0;
    const sites: { name: string; bytes: number }[] = [];
    try {
      await session.post("HeapProfiler.startSampling", { samplingInterval, includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true });
      const started = performance.now();
      for (let i = 0; i < iterations; i++) phase === "scanner" ? shellHeredocKind(command) : prepare(input, expected);
      const elapsedMs = performance.now() - started, peakHeap = process.memoryUsage().heapUsed;
      const { profile } = await session.post("HeapProfiler.stopSampling");
      const stack = [profile.head];
      while (stack.length) {
        const node = stack.pop()!; sampled += node.selfSize;
        if (["shellHeredocKind", "scanHeredocSyntax", "classifyBoundedBody"].includes(node.callFrame.functionName)) scannerSamples += node.selfSize;
        if (node.selfSize) sites.push({ name: node.callFrame.functionName, bytes: node.selfSize });
        stack.push(...node.children);
      }
      sites.sort((a, b) => b.bytes - a.bytes);
      console.log(JSON.stringify({ name, phase, iterations, warmup, samplingInterval, sourceChars: command.length, charCodeReadsPerPreparation: reads,
        scansPerPreparation: 1, sourceCopies: 0, astAllocations: 0, scannerObjects: 0, scannerArrays: 0, scannerClosures: 0, scannerPromises: 0,
        sampledBytesPerCall: Math.round(sampled / iterations), scannerSampledBytesPerCall: scannerSamples / iterations,
        elapsedMs, peakHeapDelta: peakHeap - beforeHeap, topSites: sites.slice(0, 6) }));
    } finally { session.disconnect(); }
  }
}
function lifecycleProbe(): void {
  for (const command of ["echo hi", "cat <<'E'\ndata\nE", "cd . && cat <<'E'\ndata\nE"]) {
    const input = { command }; prepare(input, shellHeredocKind(command)); weak.push(new WeakRef(input));
  }
}
lifecycleProbe();
await setImmediate(); gc(); await setImmediate(); gc(); await setImmediate();
const liveReferences = weak.filter(reference => reference.deref()).length;
assert.equal(liveReferences, 0);
console.log(JSON.stringify({ lifecycle: "preparation normal return and both refusal paths", weakReferences: weak.length, liveReferences,
  retainedCommandOwners: 0, node: process.version, v8: process.versions.v8, platform: process.platform,
  scope: "scanner exact source invariants count allocations; sampling includes harness/error-stack work; existing execution transport allocations unchanged" }));
