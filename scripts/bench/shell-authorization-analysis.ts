import assert from "node:assert/strict";
import { Session } from "node:inspector/promises";
import { setImmediate } from "node:timers/promises";
import { inspectBashResourceLifecycle, inspectHighRiskBashMutation, literalProcessSources, literalStoredScripts } from "../../packages/extensions/resource-lifecycle-guard/core.ts";
import { inspectBashPermissionScope } from "../../packages/extensions/resource-lifecycle-guard/permission-bash.ts";
import { ShellAnalysisOwner, shellAnalysisOwnership, MAX_ANALYSIS_BYTES, MAX_ANALYSIS_ENTRIES } from "../../packages/extensions/resource-lifecycle-guard/shell-analysis.ts";
import { shellAnalysisCounters } from "../../packages/extensions/resource-lifecycle-guard/shell-substitution.ts";
import { codeMethodNameCounters } from "../../packages/extensions/resource-lifecycle-guard/code-method-names.ts";
import { aliasRiskCounters } from "../../packages/extensions/resource-lifecycle-guard/core.ts";

const gc = (globalThis as { gc?: () => void }).gc;
assert.ok(gc, "run with --expose-gc");
const cwd = process.cwd(), iterations = 512, warmup = 64, samplingInterval = 4096;
const literalInputs = process.argv.includes("--literal-inputs");
const substitution = "$(grep -c -E '(class|function|const|var|let) GCSystem\\b' pixi/pixi.js)";
const cases = literalInputs ? [
  ["aliased-process-producer", "shopt -s expand_aliases\nalias echo='printf marker'\nsource <(echo ':')", 2],
  ["sort-terminal-value", "sort -o .git/config --help=x", 1],
  ["sort-ambiguous-output", "sort -o .git/config --i", 1],
  ["nodejs-eval", "nodejs --eval 'unlinkSync(target)'", 1],
  ["python-call-literal", "python -c \"shutil.rmtree.__call__('build')\"", 1],
  ["continued-node-heredoc", "node <\\\n<'EOF'\nunlinkSync(target)\nEOF", 1],
  ["continued-cat-heredoc", "cat <\\\n<'EOF'\nordinary data\nEOF", 1],
  ["ordinary-input-redirection", "wc -l < README.md", 1],
  ["shadowed-process-producer", "echo() { printf '%s\\n' 'sleep 100 &'; }; source <(echo ':')", 1],
  ["find-files0-filename", "find -files0-from -delete", 1],
  ["find-files0-help-data", "find -files0-from --help -delete", 1],
  ["python-versioned-command", "python312 -c 'shutil.rmtree(target)'", 1],
  ["sort-terminal-help", "sort -o .git/config --help", 1],
  ["find-terminal-help", "find --help -fprint .git/config", 1],
  ["unresolved-process-source", "source <(printf '%b' 'sleep 100 &')", 1],
  ["stored-source-overflow", Array.from({length:17}, (_, i) => `X${i}=':'; trap "$X${i}" EXIT`).join("; "), 1],
  ["process-source-overflow", Array(17).fill("source <(echo ':')").join("; "), 1],
  ["coproc-subshell", "coproc ( sleep 100 )", 1],
  ["coproc-existing-boundary", "coproc NAME { sleep 100; }", 1],
  ["positional-backtick-target", 'touch `pwd`/../escaped', 2],
  ["copy-backtick-target", 'cp source `pwd`/../escaped', 2],
  ["redirect-backtick-target", 'printf x > `pwd`/../escaped', 2],
  ["find-backtick-root", 'find `pwd`/../victim -delete', 2],
  ["sort-terminal-mode", "sort --help --output=.git/config", 1],
  ["prompt-transform", 'x=\'$(sleep 100 &)\'; echo "${x@P}"', 1],
  ["quote-transform-control", 'x=\'$(sleep 100 &)\'; echo "${x@Q}"', 1],
  ["ps4-xtrace-boundary", "PS4='$(sleep 100 &)'; set -x; :", 1],
  ["ordinary-file-copy", "exec 3<file; exec 4<&3; source /dev/fd/4", 1],
  ["stored-arithmetic-subscript", "x='a[$(sleep 100 &)]'; echo $((x))", 1],
  ["unquoted-process-subscript", "printf %s a[<(printf ok)]", 1],
  ["literal-bare-arithmetic", "((1+1))", 1],
  ["arithmetic-for-control", "for ((i=0;i<3;i++)); do :; done", 1],
  ["find-delete-then-output", "find scratch -delete -fprint output", 1],
  ["find-fstype-data", "find . -fstype -fprint", 1],
  ["find-backtick-output", 'find . -maxdepth 0 -fprint `pwd`/../outside', 2],
  ["mapfile-callback-followed", "mapfile -C 'sleep 100 &' -c 1 a < f.txt; echo ok", 1],
  ["mapfile-callback-final", "mapfile -C 'sleep 100 &' -c 1 a < f.txt", 1],
  ["readarray-callback-clustered", "readarray -tC 'sleep 100 &' -c 1 a < f.txt", 1],
  ["mapfile-callback-attached", 'mapfile -C"sleep 100 &" -c 1 a < f.txt', 1],
  ["mapfile-without-callback", "mapfile -t a < f.txt", 1],
  ["unsafe-indirect-test", "[[ -v a[x] ]]", 1],
  ["unsafe-single-test", "test -v a[x]", 1],
  ["unsafe-name-operand", "printf -v a[x] '%s' value", 1],
  ["unsafe-let-operand", "let 'x=a[y]'", 1],
  ["unsafe-signed-let-operand", "let '-a[x]'", 1],
  ["unsafe-repeated-printf-destination", "printf -v first -v a[x] '%s' value", 1],
  ["sort-backtick-output", 'sort -o `pwd`/../outside input', 2],
  ["sort-backtick-temporary", 'sort --te=`pwd`/../outside input', 2],
  ["sort-literal-backticks", "sort --out='`pwd`/../outside' input", 1],
  ["function-substitution", "echo ${ printf hi; }", 2],
  ["function-substitution-quoted", 'echo "${ printf hi; }"', 1],
  ["ordered-lookup-state", "rm -r scratch; PATH=/tmp; echo ok", 1],
  ["prior-lookup-state", "PATH=/tmp; rm -r scratch", 1],
  ["nested-lookup-state", "echo ok; PATH=/tmp; echo $(rm -r scratch)", 2],
  ["inherited-script-descriptor", "source /dev/fd/63", 1],
  ["find-target-overflow", `find . ${Array.from({ length: 17 }, (_, i) => `-fprint output-${i}`).join(" ")}`, 1],
  ["sort-abbreviated-output", "sort -T tmp --out=../outside", 1],
  ["sort-unknown-option", "sort -T tmp --unknown-option", 1],
  ["ordered-high-risk-state", "rm -r scratch; printf -v X foo", 1],
  ["sort-equals-compressor", "sort --compress-program=./codec -o output input", 1],
  ["unresolved-trap", 'ACTION=\'sleep 100 &\'; true; trap "$ACTION" EXIT', 1],
  ["sort-option-operand", "sort --random-sort --random-source -o", 1],
  ["sort-temporary-target", "sort -S1K -T ../outside -o output input", 1],
  ["ordered-state", "touch target; printf -v X foo", 1],
  ["find-predicate-operand", "find . -name -fprint", 1],
  ["dynamic-executable", 'CMD=setsid; $CMD -f sleep 100', 1],
  ["literal-process-source", "source <(echo 'printf ok')", 2],
  ["literal-trap", 'ACTION=\'printf ok\'; trap "$ACTION" EXIT', 2],
] as const : [
  ["ordinary", "printf ok", 1],
  ["quoted-16", `printf '%s ' ${Array(16).fill(`"${substitution}"`).join(" ")}`, 2],
  ["unquoted-16", `printf '%s ' ${Array(16).fill(substitution).join(" ")}`, 2],
  ["heredoc-data", `cat > out <<'EOF'\n${"literal data & $HOME\n".repeat(512)}EOF`, 1],
] as const;
const references: WeakRef<object>[] = [];
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
  const before = { ...shellAnalysisCounters }, methodNamesBefore = { ...codeMethodNameCounters }, aliasesBefore = { ...aliasRiskCounters }, ownership = { ...shellAnalysisOwnership };
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
  const methodNameCounters = Object.fromEntries(Object.entries(codeMethodNameCounters).map(([key, value]) => [key, value - methodNamesBefore[key as keyof typeof methodNamesBefore]]));
  const aliasCounters = Object.fromEntries(Object.entries(aliasRiskCounters).map(([key, value]) => [key, value - aliasesBefore[key as keyof typeof aliasesBefore]]));
  assert.equal(aliasCounters.viewsCreated, aliasCounters.viewsReleased); assert.equal(aliasRiskCounters.liveViews, 0);
  if (name === "node-ascii-template-key") for (const value of Object.values(methodNameCounters)) assert.equal(value, 0);
  if (name === "node-ascii-methods" || name === "python-ascii-methods" || name === "python-unrelated-unicode" || name === "nodejs-eval" || name === "nodejs-heredoc" || name === "node-array-string-data") for (const value of Object.values(methodNameCounters)) assert.equal(value, 0);
  assert.equal(counters.prepareCalls, iterations * uniqueSources);
  assert.equal(shellAnalysisOwnership.misses - ownership.misses, iterations * uniqueSources);
  assert.equal(shellAnalysisOwnership.liveOwners, 0);
  assert.equal(shellAnalysisOwnership.liveEntries, 0);
  assert.equal(shellAnalysisOwnership.liveBytes, 0);
  sites.sort((a, b) => b.bytes - a.bytes); times.sort((a, b) => a - b);
  console.log(JSON.stringify({ name, iterations, warmup, samplingInterval, counters, methodNameCounters, aliasCounters,
    cacheHits: shellAnalysisOwnership.hits - ownership.hits, cacheMisses: shellAnalysisOwnership.misses - ownership.misses,
    sampledBytesPerAnalysis: Math.round(sampledBytes / iterations), p50Ms: times[256], p95Ms: times[486], topSites: sites.slice(0, 8) }));
}
for (const lifecycle of ["normal-release", "failure", "cancel", "invalidate"]) {
  analyze("printf lifecycle", lifecycle);
  if (literalInputs) observeStoredSources();
}
await setImmediate(); gc(); await setImmediate(); gc(); await setImmediate();
const liveReferences = references.filter(reference => reference.deref()).length;
assert.equal(liveReferences, 0);
assert.equal(shellAnalysisOwnership.created, shellAnalysisOwnership.released);
console.log(JSON.stringify({ ownership: shellAnalysisOwnership, aliasRiskCounters, weakReferences: references.length, liveReferences,
  literalInputs,
  maxEntriesPerAuthorization: MAX_ANALYSIS_ENTRIES, maxRetainedReferenceBytes: MAX_ANALYSIS_BYTES,
  counterByteUnit: "UTF-16 bytes submitted at real scanner entries; not total character accesses", node: process.version, v8: process.versions.v8, platform: process.platform }));
