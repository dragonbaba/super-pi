import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import childProcess from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { syncBuiltinESMExports } from 'node:module';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import fs from 'node:fs';
import { finished } from 'node:stream/promises';
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
const localPath = 'packages/coding-agent/src/core/tools/bash.ts';
const localSources = {
  baseline: execFileSync('git', ['show', `${baseline}:${localPath}`], { cwd: root, encoding: 'utf8' }),
  candidate: readFileSync(join(root, localPath), 'utf8'),
};
const moduleCleanup = [];
async function load(source, label, path = sourcePath, exportName = 'executeBashWithOperations') {
  const sourceUrl = pathToFileURL(join(root, path));
  const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText
    .replace(/from "([^"]+)"/g, (_match, specifier) => `from ${JSON.stringify(specifier.startsWith('.') ? new URL(specifier, sourceUrl).href : import.meta.resolve(specifier))}`);
  const directory = mkdtempSync(join(tmpdir(), 'pi-bash-ansi-bench-'));
  try {
    const path = join(directory, `${label}.mjs`); writeFileSync(path, compiled);
    return (await import(pathToFileURL(path).href))[exportName];
  } finally {
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
    rmSync(directory, { recursive: true, force: true });
    assert.equal(existsSync(directory), false);
    moduleCleanup.push({ label, directory, existsAfterCleanup: false });
  }
}
const implementations = { baseline: await load(sources.baseline, 'baseline'), candidate: await load(sources.candidate, 'candidate') };
const localOperations = {};
for (const label of ['baseline', 'candidate']) {
  const create = await load(localSources[label], label, localPath, 'createLocalShellOperations');
  localOperations[label] = create('benchmark pipes', () => ({ shell: process.execPath, args: [] }));
}
initTheme('dark');
const ui = { requestRender() {} };
const cases = {
  plain: [Buffer.from('plain 中文😀 output\n')],
  colored: [Buffer.from('\x1b[31mcolored 中文😀 output\x1b[0m\n')],
  split: [Buffer.from('\x1b[3'), Buffer.from('1m中文😀\x1b]title'), Buffer.from('\x1b'), Buffer.from('\\\n')],
  interactive: [Buffer.from('\x1b[31mcolored 中文😀 output\x1b[0m\n')],
  interleaved: [Buffer.from('\x1b]title'), Buffer.from('diagnostic\n'), Buffer.from('\x07out\n'), Buffer.from('err\n')],
  spill: [Buffer.from('private output\n'.repeat(80))],
};
cases.localPipes = cases.interleaved;
const streamSources = ['stdout', 'stderr', 'stdout', 'stderr'];
const chunksPerCommand = 100;
const nativeSpawn = childProcess.spawn;
const nativeCreateWriteStream = fs.createWriteStream;
let lastSpillStream;
let spillFilesCreated = 0, spillFilesReleased = 0;
let maxSpillQueuedBytes = 0;
// One harness reference per command. Clear it even when a producer rejects.
function trackSpill(...args) {
  assert.equal(lastSpillStream, undefined);
  lastSpillStream = nativeCreateWriteStream(...args);
  spillFilesCreated++;
  return lastSpillStream;
}
async function releaseSpill(candidate) {
  const stream = lastSpillStream;
  if (!stream) return;
  try {
    if (candidate) assert.equal(stream.closed, true, 'candidate returns only after physical close');
    if (!stream.writableEnded) stream.end();
    try { await finished(stream, { cleanup: true }); } catch { /* producer error was checked separately */ }
    assert.equal(stream.closed, true);
    assert.equal(stream.writableLength, 0);
    for (const event of ['open', 'error', 'close', 'finish']) assert.equal(stream.listenerCount(event), 0);
  } finally {
    if (existsSync(stream.path)) fs.unlinkSync(stream.path);
    assert.equal(existsSync(stream.path), false);
    lastSpillStream = undefined;
    spillFilesReleased++;
  }
}
let lastChild;
// Real local backend/listeners and Node streams; only process creation is a
// deterministic fixture. No mock call recorder retains every child/write.
function spawnFixture() {
  const stdout = new PassThrough(), stderr = new PassThrough();
  const child = Object.assign(new EventEmitter(), { stdout, stderr, exitCode: null, signalCode: null });
  lastChild = child;
  queueMicrotask(() => {
    child.emit('spawn');
    for (let index = 0; index < chunksPerCommand; index++) {
      const source = streamSources[index % streamSources.length];
      child[source].write(cases.localPipes[index % cases.localPipes.length]);
    }
    stdout.end(); stderr.end();
    setImmediate(() => { child.exitCode = 0; child.emit('exit', 0, null); child.emit('close', 0, null); });
  });
  return child;
}
async function workload(execute, scenario, commands, local) {
  const chunks = cases[scenario];
  let deliveries = 0, visibleUnits = 0;
  for (let command = 0; command < commands; command++) {
    const component = scenario === 'interactive' ? new BashExecutionComponent('fixture', ui) : undefined;
    try {
      const result = await execute('fixture', root, scenario === 'localPipes' ? local : { async exec(_command, _cwd, { onData }) {
        for (let index = 0; index < chunksPerCommand; index++) onData(chunks[index % chunks.length], scenario === 'interleaved' ? streamSources[index % streamSources.length] : undefined);
        return { exitCode: 0 };
      } }, { onChunk(text) {
        deliveries++; visibleUnits += text.length;
        if (lastSpillStream) maxSpillQueuedBytes = Math.max(maxSpillQueuedBytes, lastSpillStream.writableLength);
        component?.appendOutput(text); component?.render(100);
      } });
      if (scenario === 'spill') {
        assert.equal(result.fullOutputPath, lastSpillStream.path);
        // Baseline returned before close; wait on both sides for equal completed-output work.
        await releaseSpill(execute === implementations.candidate);
      } else assert.equal(result.fullOutputPath, undefined);
      assert.equal(result.cancelled, false);
      if (scenario === 'localPipes') {
        assert.equal(lastChild.stdout.listenerCount('data'), 0); assert.equal(lastChild.stderr.listenerCount('data'), 0);
        for (const event of ['spawn', 'exit', 'close', 'error']) assert.equal(lastChild.listenerCount(event), 0);
        lastChild = undefined;
      }
      component?.setComplete(result.exitCode, result.cancelled);
    } finally { await releaseSpill(execute === implementations.candidate); component?.setComplete(undefined, true); component?.[RELEASE_COMPONENT_RENDER_CACHE](); }
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
async function lifecycle(execute, label, spilling = false) {
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
        late.push(onData);
        if (spilling) onData(Buffer.from('spill\n'.repeat(12000)), 'stdout');
        onData(Buffer.from('ok\x1b]unfinished'), 'stdout');
        onData(Buffer.from('diagnostic\x1b[3'), 'stderr');
        if (outcome === 'cancel') { controller.abort(); throw new Error('aborted'); }
        if (outcome === 'error') throw new Error('producer failed');
        return { exitCode: 0 };
      } }, { signal: controller.signal, onChunk });
      assert.notEqual(outcome, 'error'); assert.equal(result.cancelled, outcome === 'cancel');
    } catch (error) { assert.equal(outcome, 'error'); assert.match(error.message, /producer failed/); }
    finally {
      if (lastSpillStream) weak.push({ kind: 'stream', ref: new WeakRef(lastSpillStream) });
      await releaseSpill(label === 'candidate');
    }
  }
  try { for (let round = 0; round < 4; round++) for (const outcome of ['success', 'error', 'cancel']) await command(outcome); }
  finally { globalThis.TextDecoder = NativeDecoder; AnsiStreamFilter.prototype.write = write; }
  await collect();
  const retained = {};
  for (const item of weak) if (item.ref.deref()) retained[item.kind] = (retained[item.kind] ?? 0) + 1;
  if (label === 'candidate') {
    assert.deepEqual(retained, {});
    for (const callback of late) { callback(Buffer.from('late'), 'stdout'); callback(Buffer.from('late'), 'stderr'); }
  }
  late.length = 0; await collect();
  const afterProducerRelease = weak.filter(item => item.ref.deref() !== undefined).length;
  assert.equal(afterProducerRelease, 0);
  return { commands: 12, outcomes: ['success', 'error', 'cancel'], weakReferences: weak.length, retainedWithProducerCallback: retained, afterProducerRelease };
}
const lifecycleResults = {};
fs.createWriteStream = trackSpill; syncBuiltinESMExports();
try {
for (const label of ['baseline', 'candidate']) lifecycleResults[label] = await lifecycle(implementations[label], label);
for (const label of ['baseline', 'candidate']) lifecycleResults[`${label}Spill`] = await lifecycle(implementations[label], label, true);
} finally { fs.createWriteStream = nativeCreateWriteStream; syncBuiltinESMExports(); }

function countHotSites(source, targets = ['onData', 'appendText']) {
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
    if (ts.isVariableDeclaration(node) && targets.includes(node.name.getText(parsed)) && node.initializer && ts.isArrowFunction(node.initializer)) count(node.initializer.body);
    ts.forEachChild(node, find);
  }
  find(parsed); return counts;
}
const structural = { baseline: countHotSites(sources.baseline), candidate: countHotSites(sources.candidate) };
assert.deepEqual(structural.candidate, { callbacks: 0, objects: 0, arrays: 0, constructors: 0 });
structural.localForwarding = countHotSites(localSources.candidate, ['onStdoutData', 'onStderrData']);
assert.deepEqual(structural.localForwarding, { callbacks: 0, objects: 0, arrays: 0, constructors: 0 });
childProcess.spawn = spawnFixture; fs.createWriteStream = trackSpill; syncBuiltinESMExports();
try {
for (const label of ['baseline', 'candidate']) for (const scenario of Object.keys(cases)) await workload(implementations[label], scenario, 5, localOperations[label]);
const results = [];
for (let run = 0; run < 3; run++) for (const scenario of Object.keys(cases)) {
  for (const label of run % 2 ? ['candidate', 'baseline'] : ['baseline', 'candidate']) {
    const commands = scenario === 'interactive' ? 10 : 200;
    await collect();
    const beforeHeap = process.memoryUsage().heapUsed, durations = [];
    for (let index = 0; index < 20; index++) {
      const start = performance.now(); await workload(implementations[label], scenario, 1, localOperations[label]);
      durations.push((performance.now() - start) / chunksPerCommand);
    }
    durations.sort((a, b) => a - b);
    const profiler = new Session(); profiler.connect();
    let profile, counters;
    try {
      await profiler.post('HeapProfiler.startSampling', { samplingInterval: 1024, includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true });
      counters = await workload(implementations[label], scenario, commands, localOperations[label]);
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
const report = { baseline, sourceHashes: { baseline: hash(sources.baseline), candidate: hash(sources.candidate), localBaseline: hash(localSources.baseline), localCandidate: hash(localSources.candidate), ansi: hash(readFileSync(new URL('../../packages/coding-agent/src/utils/ansi.ts', import.meta.url))) },
  moduleCleanup, spillCleanup: { created: spillFilesCreated, released: spillFilesReleased,
    maxSpillQueuedBytes, retainedStreams: Number(lastSpillStream !== undefined) },
  node: process.version, platform: process.platform, cpu: cpus()[0]?.model, samplingInterval: 1024, structural, lifecycle: lifecycleResults,
  notes: ['JS allocations including collected objects; native allocations are not measured.', 'Heap readings include profiler/harness and are observations, not a continuous peak.', 'Incorrect baseline output is not equal-output speed evidence.', 'Interactive fixture uses real BashExecutionComponent rendering but no physical terminal.', 'localPipes uses each revision of createLocalShellOperations, real Node pipes and executor, but simulated process spawn.'], results };
if (output) writeFileSync(join(output, 'summary.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
} finally { childProcess.spawn = nativeSpawn; fs.createWriteStream = nativeCreateWriteStream; syncBuiltinESMExports(); lastChild = undefined; }
