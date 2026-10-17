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
  ["sort-terminal-help", "sort -o .git/config --help", 1],
  ["find-terminal-help", "find --help -fprint .git/config", 1],
  ["unresolved-process-source", "source <(printf '%b' 'sleep 100 &')", 1],
  ["expanded-shell-source", "source /dev/stdin <<EOF\n$PAYLOAD\nEOF", 1],
  ["forwarded-python-stdin", "python() { command python \"$@\"; }; python <<'EOF'\nshutil.rmtree(target)\nEOF", 1],
  ["forwarded-node-stdin", "node() { command node -- \"$@\"; }; node <<'EOF'\nfs.rmSync(target,{recursive:true})\nEOF", 1],
  ["unknown-function-body", "base64() ( printf '%s\\n' 'sleep 100 &'; ); base64 -d <<'EOF' | source /dev/stdin\ncHJpbnRmIG9r\nEOF", 1],
  ["node-quoted-recursive-option", "node <<'EOF'\nfs.rmSync('scratch',{'recursive':true})\nEOF", 1],
  ["node-known-nonrecursive-options", "node <<'EOF'\nfs.rmSync('scratch',{force:true,recursive:false})\nEOF", 1],
  ["stored-source-overflow", Array.from({length:17}, (_, i) => `X${i}=':'; trap "$X${i}" EXIT`).join("; "), 1],
  ["process-source-overflow", Array(17).fill("source <(echo ':')").join("; "), 1],
  ["shadowed-heredoc-transform", "function base64 { printf '%s\\n' 'sleep 100 &'; }; base64 -d <<'EOF' | source /dev/stdin\ncHJpbnRmIG9r\nEOF", 1],
  ["coproc-shell-heredoc", "coproc bash <<'EOF'\nsleep 100 &\nEOF", 2],
  ["coproc-brace-shell", "coproc {\nbash <<'EOF'\nsleep 100 &\nEOF\n}", 2],
  ["coproc-node-heredoc", "coproc NAME { node; } <<'EOF'\nfs.rmSync(target,{recursive:true})\nEOF", 1],
  ["coproc-data-heredoc", "coproc cat <<'EOF'\nsleep 100 &\nEOF", 1],
  ["coproc-subshell", "coproc ( sleep 100 )", 1],
  ["coproc-existing-boundary", "coproc NAME { sleep 100; }", 1],
  ["node-regex-argument", "node <<'EOF'\nfs.rmSync((/\\)/, '/protected'),{recursive:true})\nEOF", 1],
  ["node-heredoc-unescape", "node <<EOF\n\\`\\${require('fs').rmSync('/protected',{recursive:true})}\\`\nEOF", 1],
  ["node-prof-process", "node --prof-process <<'EOF'\nfs.rmSync('/protected',{recursive:true})\nEOF", 1],
  ["bash-pretty-print", "bash --pretty-print <<'EOF'\nsleep 100 &\nEOF", 1],
  ["bash-pretty-print-plus-n", "bash --pretty-print +n <<'EOF'\nsleep 100 &\nEOF", 1],
  ["bash-pretty-print-interactive", "bash --pretty-print -i <<'EOF'\nsleep 100 &\nEOF", 2],
  ["source-process-substitution", "bash -c 'source <(cat)' <<'EOF'\nsleep 100 &\nEOF", 2],
  ["python-nested-constructor", "python - <<'EOF'\nPath(('/protected')).unlink()\nEOF", 1],
  ["python-unknown-receiver", "python - <<'EOF'\np.unlink('scratch')\nEOF", 1],
  ["node-v8-options", "node --v8-options <<'EOF'\nfs.rmSync('/protected',{recursive:true})\nEOF", 1],
  ["python-double-version", "python -VV <<'EOF'\nPath('/protected').unlink()\nEOF", 1],
  ["python-version-operand", "python -W -VV <<'EOF'\nPath(target).unlink()\nEOF", 1],
  ["node-nested-delete-target", "node - <<'EOF'\nfs.rmSync(('/protected'),{recursive:true})\nEOF", 1],
  ["node-later-recursive-control", "node - <<'EOF'\nfs.rmSync('scratch'); other({recursive:true})\nEOF", 1],
  ["python-multipart-path", "python - <<'EOF'\nPath('.', '/protected').unlink()\nEOF", 1],
  ["python-trailing-comma-path", "python - <<'EOF'\nPath('scratch',).unlink()\nEOF", 1],
  ["positional-backtick-target", 'touch `pwd`/../escaped', 2],
  ["copy-backtick-target", 'cp source `pwd`/../escaped', 2],
  ["redirect-backtick-target", 'printf x > `pwd`/../escaped', 2],
  ["find-backtick-root", 'find `pwd`/../victim -delete', 2],
  ["sort-terminal-mode", "sort --help --output=.git/config", 1],
  ["prompt-transform", 'x=\'$(sleep 100 &)\'; echo "${x@P}"', 1],
  ["quote-transform-control", 'x=\'$(sleep 100 &)\'; echo "${x@Q}"', 1],
  ["ps4-xtrace-boundary", "PS4='$(sleep 100 &)'; set -x; :", 1],
  ["later-heredoc-copy", "exec 3<<'EOF'\nsleep 100 &\nEOF\nexec 4<&3; source /dev/fd/4", 1],
  ["chained-heredoc-copy", "exec 3<<'EOF'\nsleep 100 &\nEOF\nexec 4<&3; exec 5<&4; source /dev/fd/5", 1],
  ["ordinary-file-copy", "exec 3<file; exec 4<&3; source /dev/fd/4", 1],
  ["stored-arithmetic-subscript", "x='a[$(sleep 100 &)]'; echo $((x))", 1],
  ["unquoted-process-subscript", "printf %s a[<(printf ok)]", 1],
  ["literal-bare-arithmetic", "((1+1))", 1],
  ["arithmetic-for-control", "for ((i=0;i<3;i++)); do :; done", 1],
  ["find-delete-then-output", "find scratch -delete -fprint output", 1],
  ["find-fstype-data", "find . -fstype -fprint", 1],
  ["bash-dump-strings", "bash --dump-strings <<'EOF'\nsleep 100 &\nEOF", 1],
  ["node-completion", "node --completion-bash <<'EOF'\nfs.rmSync(target,{recursive:true})\nEOF", 1],
  ["find-backtick-output", 'find . -maxdepth 0 -fprint `pwd`/../outside', 2],
  ["unknown-shell-transform", "cat <<'EOF' | tr X '&' | source /dev/stdin\nsleep 100 X\nEOF", 1],
  ["python-escaped-target", 'python3 <<\'EOF\'\nshutil.rmtree("\\x2egit")\nEOF', 1],
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
  ["function-substitution-heredoc", "echo ${ bash <<'EOF'\nprintf hi\nEOF\n; }", 1],
  ["cr-heredoc-boundary", "cat <<'EOF'\nbody\nE\rOF\nsleep 100 &\nEOF", 1],
  ["cr-shell-heredoc", "source /dev/stdin <<'EOF'\nprintf h\ri\nEOF", 2],
  ["cr-data-heredoc", "cat <<'EOF'\na\rb\nEOF", 1],
  ["shell-noexec-heredoc", "bash -n <<'EOF'\nsleep 100 &\nEOF", 1],
  ["python-help-heredoc", "python3 --help-env <<'EOF'\nshutil.rmtree(target)\nEOF", 1],
  ["heredoc-leading-trivia", "\n# comment\nnode <<'EOF'\nfs.rmSync('./scratch',{recursive:true})\nEOF", 1],
  ["ordered-lookup-state", "rm -r scratch; PATH=/tmp; echo ok", 1],
  ["prior-lookup-state", "PATH=/tmp; rm -r scratch", 1],
  ["nested-lookup-state", "echo ok; PATH=/tmp; echo $(rm -r scratch)", 2],
  ["newline-function", "function f\n{ source /dev/stdin; }; f <<'EOF'\nprintf ok\nEOF", 2],
  ["node-value-free-data", "node --no-addons script.js <<'EOF'\nfs.rmSync(target,{recursive:true})\nEOF", 1],
  ["lost-wrapped-descriptor", "exec 3<<'EOF'\nprintf ok\nEOF\necho ok; bash -c 'source /dev/fd/3'", 2],
  ["known-wrapped-descriptor", "exec 3<<'EOF'\nprintf ok\nEOF\ntrue; bash -c 'source /dev/fd/3'", 3],
  ["disconnected-heredoc-pipe", "cat <<'EOF' >out | source /dev/stdin\nsleep 100 &\nEOF", 1],
  ["restored-heredoc-pipe", "cat <<'EOF' 3>&1 >out >&3 | source /dev/stdin\nprintf ok\nEOF", 2],
  ["inherited-script-descriptor", "source /dev/fd/63", 1],
  // Permission analysis visits the root, sourced setup, and literal alias action.
  ["sourced-alias-setup", "source /dev/stdin <<'SETUP'\nshopt -s expand_aliases; alias node='source /dev/stdin'\nSETUP\nnode <<'EOF'\nsleep 100 &\nEOF", 3],
  ["lost-heredoc-descriptor", "exec 3<<'EOF'\nsleep 100 &\nEOF\necho ok; source /dev/fd/3", 1],
  ["known-heredoc-descriptor", "exec 3<<'EOF'\nprintf ok\nEOF\ntrue; source /dev/fd/3", 2],
  ["alias-heredoc", "shopt -s expand_aliases; BASH_ALIASES[node]='source /dev/stdin'; node <<'EOF'\nsleep 100 &\nEOF", 1],
  ["find-target-overflow", `find . ${Array.from({ length: 17 }, (_, i) => `-fprint output-${i}`).join(" ")}`, 1],
  ["sort-abbreviated-output", "sort -T tmp --out=../outside", 1],
  ["sort-unknown-option", "sort -T tmp --unknown-option", 1],
  ["ordered-high-risk-state", "rm -r scratch; printf -v X foo", 1],
  ["mid-pipeline-heredoc", "printf 'printf ok' | source /dev/stdin | cat <<'EOF' | cat\ndata\nEOF", 1],
  ["sort-equals-compressor", "sort --compress-program=./codec -o output input", 1],
  ["copied-heredoc-source", "source /dev/fd/3 <<'EOF' 3<&0 </dev/null\nprintf ok\nEOF", 2],
  ["copied-heredoc-stdin", "node 3<<'EOF' 0<&3 3<&-\nconsole.log(1)\nEOF", 1],
  ["launcher-node-input", "env LABEL=literal node <<'EOF'\nconsole.log(1)\nEOF", 1],
  ["launcher-shell-input", "timeout 5 bash <<'EOF'\nprintf ok\nEOF", 2],
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
  assert.ok(counters.subscriptTextChars <= counters.substitutionInputBytes / 2);
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
