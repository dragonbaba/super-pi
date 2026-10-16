import assert from "node:assert/strict";
import { Session } from "node:inspector/promises";
import { setImmediate } from "node:timers/promises";
import { decodeLiteralBase64, inspectBashResourceLifecycle, inspectHighRiskBashMutation, literalProcessSources, literalStoredScripts } from "../../packages/extensions/resource-lifecycle-guard/core.ts";
import { inspectBashPermissionScope } from "../../packages/extensions/resource-lifecycle-guard/permission-bash.ts";
import { ShellAnalysisOwner, shellAnalysisOwnership, MAX_ANALYSIS_BYTES, MAX_ANALYSIS_ENTRIES } from "../../packages/extensions/resource-lifecycle-guard/shell-analysis.ts";
import { shellAnalysisCounters } from "../../packages/extensions/resource-lifecycle-guard/shell-substitution.ts";

const gc = (globalThis as { gc?: () => void }).gc;
assert.ok(gc, "run with --expose-gc");
const cwd = process.cwd(), iterations = 512, warmup = 64, samplingInterval = 4096;
const literalInputs = process.argv.includes("--literal-inputs");
const substitution = "$(grep -c -E '(class|function|const|var|let) GCSystem\\b' pixi/pixi.js)";
const cases = literalInputs ? [
  ["unresolved-trap", 'ACTION=\'sleep 100 &\'; true; trap "$ACTION" EXIT', 1],
  ["node-test-mode", "node --test script.js <<'EOF'\nfs.rmSync(target,{recursive:true})\nEOF", 1],
  ["sort-option-operand", "sort --random-sort --random-source -o", 1],
  ["sort-temporary-target", "sort -S1K -T ../outside -o output input", 1],
  ["heredoc-continuation", "node <<EOF\n// \\\nEOF\nconsole.log(1)\nEOF", 1],
  ["heredoc-joined-marker", "cat <<EOF\ndata\nE\\\nOF\nprintf ok", 1],
  ["node-interactive", "node -i -e 'void 0' <<'EOF'\nconsole.log(1)\nEOF", 1],
  ["keyword-function", "function f() { source /dev/stdin; }; f <<'EOF'\nprintf ok\nEOF", 2],
  ["embedded-mutations-64", `node <<'EOF'\n${"fs.rmSync('./scratch',{recursive:true});".repeat(64)}\nEOF`, 1],
  ["ordered-state", "touch target; printf -v X foo", 1],
  ["find-predicate-operand", "find . -name -fprint", 1],
  ["dynamic-executable", 'CMD=setsid; $CMD -f sleep 100', 1],
  ["expanded-node-input", 'PAYLOAD="console.log(1)"; node <<EOF\n$PAYLOAD\nEOF', 1],
  ["expanded-python-input", "python <<EOF\n$(printf '%s' 'print(1)')\nEOF", 2],
  ["concatenated-delimiter", 'node <<"E""OF"\nconsole.log(1)\nEOF', 1],
  ["superseded-heredoc", "source /dev/stdin <<'A' <<'B'\nsleep 100 &\nA\nprintf ok\nB", 2],
  ["redefined-function", "f(){ source /dev/stdin; }; f(){ cat; }; f <<'EOF'\nsleep 100 &\nEOF", 1],
  ["node-value-free-option", "node --no-warnings script.js <<'EOF'\nfs.rmSync(target,{recursive:true})\nEOF", 1],
  ["persistent-descriptor", "exec 3<<'EOF'\nprintf ok\nEOF\nsource /dev/fd/3", 2],
  ["literal-process-source", "source <(echo 'printf ok')", 2],
  ["python-interactive", "python3 -i -c 'pass' <<'EOF'\nprint(1)\nEOF", 1],
  ["literal-trap", 'ACTION=\'printf ok\'; trap "$ACTION" EXIT', 2],
  ["function-stdin", "f(){ source /dev/stdin; }; f <<'EOF'\nprintf ok\nEOF", 2],
  ["base64-script", "base64 -d <<'EOF' | source /dev/stdin\ncHJpbnRmIG9rCg==\nEOF", 2],
  ["base64-large", `base64 -d <<'EOF' | source /dev/stdin\n${Buffer.from(`printf '%s' '${"x".repeat(16 * 1024)}'`).toString("base64")}\nEOF`, 2],
] as const : [
  ["ordinary", "printf ok", 1],
  ["quoted-16", `printf '%s ' ${Array(16).fill(`"${substitution}"`).join(" ")}`, 2],
  ["unquoted-16", `printf '%s ' ${Array(16).fill(substitution).join(" ")}`, 2],
  ["heredoc-data", `cat > out <<'EOF'\n${"literal data & $HOME\n".repeat(512)}EOF`, 1],
] as const;
const references: WeakRef<object>[] = [];
const decodedBuffers: WeakRef<object>[] = [];
const originalDecode = TextDecoder.prototype.decode;
let maxDecodedBufferBytes = 0;
function observeDecode(this: TextDecoder, input?: Parameters<TextDecoder["decode"]>[0], options?: Parameters<TextDecoder["decode"]>[1]): string {
  if (input && ArrayBuffer.isView(input)) {
    decodedBuffers.push(new WeakRef(input.buffer));
    maxDecodedBufferBytes = Math.max(maxDecodedBufferBytes, input.buffer.byteLength);
  }
  return originalDecode.call(this, input, options);
}
function observeStoredSources(): void {
  const sources = literalStoredScripts('ACTION=\'printf ok\'; trap "$ACTION" EXIT');
  assert.ok(sources); references.push(new WeakRef(sources));
  const processSources = literalProcessSources("source <(echo 'printf ok')");
  assert.ok(processSources); references.push(new WeakRef(processSources));
}

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
if (literalInputs) TextDecoder.prototype.decode = observeDecode;
try {
  for (const lifecycle of ["normal-release", "failure", "cancel", "invalidate"]) {
    analyze(literalInputs ? "base64 -d <<'EOF' | source /dev/stdin\ncHJpbnRmIG9rCg==\nEOF" : "printf lifecycle", lifecycle);
    if (literalInputs) observeStoredSources();
  }
  if (literalInputs) {
    assert.equal(decodeLiteralBase64("/w=="), undefined);
    assert.equal(decodeLiteralBase64("QUFB".repeat(32768))?.length, 96 * 1024);
    assert.equal(decodeLiteralBase64("QUFB".repeat(32769)), undefined);
  }
} finally { TextDecoder.prototype.decode = originalDecode; }
await setImmediate(); gc(); await setImmediate(); gc(); await setImmediate();
const liveReferences = references.filter(reference => reference.deref()).length;
assert.equal(liveReferences, 0);
const liveDecodedBuffers = decodedBuffers.filter(reference => reference.deref()).length;
assert.equal(liveDecodedBuffers, 0);
assert.ok(maxDecodedBufferBytes <= 96 * 1024);
assert.equal(shellAnalysisOwnership.created, shellAnalysisOwnership.released);
console.log(JSON.stringify({ ownership: shellAnalysisOwnership, weakReferences: references.length, liveReferences,
  literalInputs, decodedBuffersObserved: decodedBuffers.length, maxDecodedBufferBytes, liveDecodedBuffers,
  maxEntriesPerAuthorization: MAX_ANALYSIS_ENTRIES, maxRetainedReferenceBytes: MAX_ANALYSIS_BYTES,
  counterByteUnit: "UTF-16 bytes submitted at real scanner entries; not total character accesses", node: process.version, v8: process.versions.v8, platform: process.platform }));
