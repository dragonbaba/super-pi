import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { Session } from 'node:inspector/promises';
import { cpus, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';
import { AnsiStreamFilter } from '../../packages/coding-agent/src/utils/ansi.ts';
import { BashExecutionComponent } from '../../packages/coding-agent/src/modes/interactive/components/bash-execution.ts';
import { initTheme } from '../../packages/coding-agent/src/modes/interactive/theme/theme.ts';
import { RELEASE_COMPONENT_RENDER_CACHE } from '@super-pi/tui';

// All rewriting, buffers and instrumentation are cold harness setup. Baseline
// and candidate execute identical transpilation/import resolution paths.
const root = fileURLToPath(new URL('../../', import.meta.url));
const sourcePath = 'packages/coding-agent/src/core/bash-executor.ts';
const baselineAt = process.argv.indexOf('--baseline');
const baseline = baselineAt < 0 ? '2beef1bad09661b35881294c4c48bfb1397910af' : process.argv[baselineAt + 1];
const outputAt = process.argv.indexOf('--output');
const output = outputAt < 0 ? undefined : resolve(process.argv[outputAt + 1]);
if (output) mkdirSync(output, { recursive: true });
assert.equal(typeof globalThis.gc, 'function', 'run with --expose-gc');
const sourceUrl = pathToFileURL(join(root, sourcePath));
const sources = {
  baseline: execFileSync('git', ['show', `${baseline}:${sourcePath}`], { cwd: root, encoding: 'utf8' }),
  candidate: readFileSync(sourceUrl, 'utf8'),
};
const moduleCleanup = [];
async function load(source, label) {
  const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText
    .replace(/from "([^"]+)"/g, (_match, specifier) => `from ${JSON.stringify(specifier.startsWith('.') ? new URL(specifier, sourceUrl).href : import.meta.resolve(specifier))}`);
  const directory = mkdtempSync(join(tmpdir(), 'pi-bash-ansi-bench-'));
  try {
    const path = join(directory, `${label}.mjs`); writeFileSync(path, compiled);
    return (await import(pathToFileURL(path).href)).executeBashWithOperations;
  } finally {
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
    rmSync(directory, { recursive: true, force: true });
    assert.equal(existsSync(directory), false);
    moduleCleanup.push({ label, directory, existsAfterCleanup: false });
  }
}
const implementations = { baseline: await load(sources.baseline, 'baseline'), candidate: await load(sources.candidate, 'candidate') };
initTheme('dark');
const ui = { requestRender() {} };
const cases = {
  plain: [Buffer.from('plain 中文😀 output\n')],
  colored: [Buffer.from('\x1b[31mcolored 中文😀 output\x1b[0m\n')],
  split: [Buffer.from('\x1b[3'), Buffer.from('1m中文😀\x1b]title'), Buffer.from('\x1b'), Buffer.from('\\\n')],
  interactive: [Buffer.from('\x1b[31mcolored 中文😀 output\x1b[0m\n')],
};
const chunksPerCommand = 100;
async function workload(execute, scenario, commands) {
  const chunks = cases[scenario];
  let deliveries = 0, visibleUnits = 0;
  for (let command = 0; command < commands; command++) {
    const component = scenario === 'interactive' ? new BashExecutionComponent('fixture', ui) : undefined;
    try {
      const result = await execute('fixture', root, { async exec(_command, _cwd, { onData }) {
        for (let index = 0; index < chunksPerCommand; index++) onData(chunks[index % chunks.length]);
        return { exitCode: 0 };
      } }, { onChunk(text) { deliveries++; visibleUnits += text.length; component?.appendOutput(text); component?.render(100); } });
      assert.equal(result.fullOutputPath, undefined); assert.equal(result.cancelled, false);
      component?.setComplete(result.exitCode, result.cancelled);
    } finally { component?.setComplete(undefined, true); component?.[RELEASE_COMPONENT_RENDER_CACHE](); }
  }
  return { inputChunks: commands * chunksPerCommand, deliveries, visibleUnits };
}
function summarize(profile) {
  const pending = [profile.head], sites = new Map(); let sampledBytes = 0;
  while (pending.length) {
    const node = pending.pop(); sampledBytes += node.selfSize;
    if (node.selfSize) {
      const frame = node.callFrame, key = `${frame.functionName || '(anonymous)'} ${frame.url}:${frame.lineNumber + 1}`;
      sites.set(key, (sites.get(key) ?? 0) + node.selfSize);
    }
    pending.push(...node.children);
  }
  return { sampledBytes, samples: profile.samples.length, topSites: [...sites].sort((a, b) => b[1] - a[1]).slice(0, 10) };
}
async function collect() { for (let index = 0; index < 8; index++) { await new Promise(resolve => setImmediate(resolve)); globalThis.gc(); } }

// Deliberately keep the producer's onData after settlement. Neither a captured
// observer nor the decoder/parser should remain reachable through that callback.
async function lifecycle(execute, label) {
  const late = [], weak = [], NativeDecoder = globalThis.TextDecoder, write = AnsiStreamFilter.prototype.write;
  globalThis.TextDecoder = class extends NativeDecoder { constructor(...args) { super(...args); weak.push({ kind: 'decoder', ref: new WeakRef(this) }); } };
  const parsers = new WeakSet();
  AnsiStreamFilter.prototype.write = function(value) {
    if (!parsers.has(this)) { parsers.add(this); weak.push({ kind: 'parser', ref: new WeakRef(this) }); }
    return write.call(this, value);
  };
  async function command(outcome) {
    const controller = new AbortController();
    const observer = { count: 0, onChunk() { this.count++; } };
    const onChunk = observer.onChunk.bind(observer);
    weak.push({ kind: 'observer', ref: new WeakRef(observer) }, { kind: 'callback', ref: new WeakRef(onChunk) });
    try {
      const result = await execute('fixture', root, { async exec(_command, _cwd, { onData }) {
        late.push(onData); onData(Buffer.from('ok\x1b]unfinished'));
        if (outcome === 'cancel') { controller.abort(); throw new Error('aborted'); }
        if (outcome === 'error') throw new Error('producer failed');
        return { exitCode: 0 };
      } }, { signal: controller.signal, onChunk });
      assert.notEqual(outcome, 'error'); assert.equal(result.cancelled, outcome === 'cancel');
    } catch (error) { assert.equal(outcome, 'error'); assert.match(error.message, /producer failed/); }
  }
  try { for (let round = 0; round < 4; round++) for (const outcome of ['success', 'error', 'cancel']) await command(outcome); }
  finally { globalThis.TextDecoder = NativeDecoder; AnsiStreamFilter.prototype.write = write; }
  await collect();
  const retained = {};
  for (const item of weak) if (item.ref.deref()) retained[item.kind] = (retained[item.kind] ?? 0) + 1;
  if (label === 'candidate') { assert.deepEqual(retained, {}); for (const callback of late) callback(Buffer.from('late')); }
  late.length = 0; await collect();
  const afterProducerRelease = weak.filter(item => item.ref.deref() !== undefined).length;
  assert.equal(afterProducerRelease, 0);
  return { commands: 12, outcomes: ['success', 'error', 'cancel'], weakReferences: weak.length, retainedWithProducerCallback: retained, afterProducerRelease };
}
const lifecycleResults = {};
for (const label of ['baseline', 'candidate']) lifecycleResults[label] = await lifecycle(implementations[label], label);

function countHotSites(source) {
  const parsed = ts.createSourceFile('executor.ts', source, ts.ScriptTarget.Latest, true);
  const counts = { callbacks: 0, objects: 0, arrays: 0, constructors: 0 };
  function count(node) {
    if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) counts.callbacks++;
    if (ts.isObjectLiteralExpression(node)) counts.objects++;
    if (ts.isArrayLiteralExpression(node)) counts.arrays++;
    if (ts.isNewExpression(node)) counts.constructors++;
    ts.forEachChild(node, count);
  }
  function find(node) {
    if (ts.isVariableDeclaration(node) && ['onData', 'appendText'].includes(node.name.getText(parsed)) && node.initializer && ts.isArrowFunction(node.initializer)) count(node.initializer.body);
    ts.forEachChild(node, find);
  }
  find(parsed); return counts;
}
const structural = { baseline: countHotSites(sources.baseline), candidate: countHotSites(sources.candidate) };
assert.deepEqual(structural.candidate, { callbacks: 0, objects: 0, arrays: 0, constructors: 0 });
for (const execute of Object.values(implementations)) for (const scenario of Object.keys(cases)) await workload(execute, scenario, 5);
const results = [];
for (let run = 0; run < 3; run++) for (const scenario of Object.keys(cases)) {
  for (const label of run % 2 ? ['candidate', 'baseline'] : ['baseline', 'candidate']) {
    const commands = scenario === 'interactive' ? 10 : 200;
    await collect();
    const beforeHeap = process.memoryUsage().heapUsed, durations = [];
    for (let index = 0; index < 20; index++) {
      const start = performance.now(); await workload(implementations[label], scenario, 1);
      durations.push((performance.now() - start) / chunksPerCommand);
    }
    durations.sort((a, b) => a - b);
    const profiler = new Session(); profiler.connect();
    let profile, counters;
    try {
      await profiler.post('HeapProfiler.startSampling', { samplingInterval: 1024, includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true });
      counters = await workload(implementations[label], scenario, commands);
      profile = (await profiler.post('HeapProfiler.stopSampling')).profile;
    } finally { profiler.disconnect(); }
    const peakObservedHeap = process.memoryUsage().heapUsed;
    const sampled = summarize(profile);
    if (output) writeFileSync(join(output, `${run}-${scenario}-${label}.heapprofile`), JSON.stringify(profile));
    profile = undefined; await collect();
    results.push({ run, scenario, label, ...counters, ...sampled, sampledBytesPerInputChunk: sampled.sampledBytes / counters.inputChunks,
      sampledBytesPerDelivery: sampled.sampledBytes / counters.deliveries, commandMeanMsPerChunkP50: durations[10], commandMeanMsPerChunkP95: durations[18],
      beforeHeap, peakObservedHeap, afterGcHeap: process.memoryUsage().heapUsed });
  }
}
const hash = source => createHash('sha256').update(source).digest('hex');
const report = { baseline, sourceHashes: { baseline: hash(sources.baseline), candidate: hash(sources.candidate), ansi: hash(readFileSync(new URL('../../packages/coding-agent/src/utils/ansi.ts', import.meta.url))) },
  moduleCleanup, node: process.version, platform: process.platform, cpu: cpus()[0]?.model, samplingInterval: 1024, structural, lifecycle: lifecycleResults,
  notes: ['JS allocations including collected objects; native allocations are not measured.', 'Heap readings include profiler/harness and are observations, not a continuous peak.', 'Split baseline is incorrect; compare bytes per input chunk and deliveries, not equal-output speed.', 'Interactive fixture uses real BashExecutionComponent rendering but no physical terminal.'], results };
if (output) writeFileSync(join(output, 'summary.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
