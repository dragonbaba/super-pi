import assert from 'node:assert/strict';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { Session } from 'node:inspector/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';
import { windowsPrivateOutputDiagnostics } from '../../packages/coding-agent/src/utils/windows-private-output.ts';

assert.equal(typeof globalThis.gc, 'function', 'run with --expose-gc');
const root = fileURLToPath(new URL('../../', import.meta.url));
const at = process.argv.indexOf('--baseline'), baseline = at < 0 ? '73a00c92f4038a00b14965e515ef8506ed2ab817' : process.argv[at + 1];
const outputAt = process.argv.indexOf('--output');
const output = outputAt < 0 ? undefined : resolve(process.argv[outputAt + 1]);
if (output) fs.mkdirSync(output, { recursive: true });
const relative = 'packages/coding-agent/src/core/tools/output-accumulator.ts';
const sources = { baseline: execFileSync('git', ['show', `${baseline}:${relative}`], { cwd: root, encoding: 'utf8' }), candidate: fs.readFileSync(join(root, relative), 'utf8') };
const cleanup = [];
async function load(source, label) {
  const sourceUrl = pathToFileURL(join(root, relative));
  const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText
    .replace(/from "([^"]+)"/g, (_match, specifier) => `from ${JSON.stringify(specifier.startsWith('.') ? new URL(specifier, sourceUrl).href : import.meta.resolve(specifier))}`);
  const directory = fs.mkdtempSync(join(tmpdir(), 'pi-private-output-bench-'));
  try { const file = join(directory, label + '.mjs'); fs.writeFileSync(file, compiled); return (await import(pathToFileURL(file).href)).OutputAccumulator; }
  finally { assert.equal(dirname(directory), tmpdir()); fs.rmSync(directory, { recursive: true }); cleanup.push({ directory, exists: fs.existsSync(directory) }); }
}
const classes = { baseline: await load(sources.baseline, 'baseline'), candidate: await load(sources.candidate, 'candidate') };
const chunk = Buffer.alloc(2048, 120), chunks = 100;
let stream, files = 0, removed = 0, maxQueuedBytes = 0;
const create = fs.createWriteStream;
function trackStream(...args) { assert.equal(stream, undefined); stream = create(...args); files++; return stream; }
fs.createWriteStream = trackStream; syncBuiltinESMExports();
async function collect() { for (let index = 0; index < 8; index++) { await new Promise(resolve => setImmediate(resolve)); globalThis.gc(); } }
const weak = [];
async function command(label, outcome = 'success', watch = false) {
  const accumulator = new classes[label]({ tempFilePrefix: 'sp-private-profile' });
  try {
    const before = windowsPrivateOutputDiagnostics().opens;
    for (let index = 0; index < chunks; index++) { accumulator.append(chunk); if (stream) maxQueuedBytes = Math.max(maxQueuedBytes, stream.writableLength); }
    if (process.platform === 'win32' && label === 'candidate') assert.equal(windowsPrivateOutputDiagnostics().opens - before, 2, 'one log + one marker per command, never per chunk');
    if (outcome === 'success') {
      accumulator.finish(); const result = accumulator.snapshot({ persistIfTruncated: true });
      await accumulator.closeTempFile(); assert.equal(fs.statSync(result.fullOutputPath).size, chunks * chunk.length);
    } else if (outcome === 'error') {
      stream.destroy(new Error('fixture stream failure'));
      await new Promise(resolve => setImmediate(resolve));
      await assert.rejects(accumulator.closeTempFile(), /fixture stream failure/);
    }
  } finally {
    const path = accumulator.tempFilePath;
    if (watch) weak.push(new WeakRef(accumulator), new WeakRef(stream));
    await accumulator.discardTempFile();
    assert.equal(fs.existsSync(path), false); assert.equal(fs.existsSync(path + '.sp-owned'), false);
    assert.equal(stream.closed, true); assert.equal(stream.writableLength, 0);
    for (const event of ['error', 'close', 'finish']) assert.equal(stream.listenerCount(event), 0);
    stream = undefined; removed++;
  }
}
function summarize(profile) {
  const pending = [profile.head], sites = new Map(); let bytes = 0;
  while (pending.length) {
    const node = pending.pop(); bytes += node.selfSize;
    if (node.selfSize) { const f = node.callFrame, key = `${f.functionName || '(anonymous)'} ${f.url}:${f.lineNumber + 1}`; sites.set(key, (sites.get(key) ?? 0) + node.selfSize); }
    pending.push(...node.children);
  }
  return { bytes, topSites: [...sites].sort((a, b) => b[1] - a[1]).slice(0, 8) };
}
try {
  const coldStart = performance.now(); await command('candidate'); const firstSpillMs = performance.now() - coldStart;
  for (let index = 0; index < 4; index++) for (const label of ['baseline', 'candidate']) for (const outcome of ['success', 'cancel', 'error']) await command(label, outcome, true);
  await collect(); assert.equal(weak.filter(ref => ref.deref()).length, 0);
  const results = [];
  for (let run = 0; run < 3; run++) for (const label of run % 2 ? ['candidate', 'baseline'] : ['baseline', 'candidate']) {
    await collect(); const durations = [], beforeHeap = process.memoryUsage().heapUsed;
    for (let i = 0; i < 20; i++) { const start = performance.now(); await command(label); durations.push((performance.now() - start) / chunks); }
    durations.sort((a, b) => a - b);
    const profiler = new Session(); profiler.connect(); let profile;
    try {
      await profiler.post('HeapProfiler.startSampling', { samplingInterval: 1024, includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true });
      for (let index = 0; index < 100; index++) await command(label);
      profile = (await profiler.post('HeapProfiler.stopSampling')).profile;
    } finally { profiler.disconnect(); }
    const sampled = summarize(profile), peakObservedHeap = process.memoryUsage().heapUsed;
    if (output) fs.writeFileSync(join(output, `${run}-${label}.heapprofile`), JSON.stringify(profile));
    profile = undefined; await collect();
    results.push({ run, label, inputChunks: 100 * chunks, sampledBytesPerChunk: sampled.bytes / (100 * chunks), ...sampled,
      commandMeanP95MsPerChunk: durations[18], beforeHeap, peakObservedHeap, afterGcHeap: process.memoryUsage().heapUsed });
  }
  const native = windowsPrivateOutputDiagnostics(); assert.equal(native.nativeHandles, 0); assert.equal(native.tokenHandles, 0);
  assert.equal(files, removed);
  const hashes = {};
  for (const file of [relative, 'packages/coding-agent/src/utils/private-output-file.ts', 'packages/coding-agent/src/utils/windows-private-output.ts']) hashes[file] = createHash('sha256').update(fs.readFileSync(join(root, file))).digest('hex');
  const report = { baseline, node: process.version, platform: process.platform, hashes, firstSpillMs, results, native, files, removed, maxQueuedBytes,
    lifecycle: { weakReferences: weak.length, retained: 0, outcomes: ['success', 'cancel', 'error'], streamListenersAfterSettlement: 0, queuedBytesAfterSettlement: 0 }, cleanup,
    notes: ['Real OutputAccumulator and Node file writes; no physical terminal.', 'Samples include existing output copies/truncation and harness. Native allocations are not V8 samples.', 'First-spill timing includes lazy native loading plus a full command; steady samples follow warmup.'] };
  if (output) fs.writeFileSync(join(output, 'summary.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally { fs.createWriteStream = create; syncBuiltinESMExports(); }
