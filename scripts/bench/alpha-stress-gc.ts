import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { writeHeapSnapshot } from 'node:v8';
import { stress } from '../../tests/helpers/alpha-stress-workload.ts';

function option(name: string, fallback: string) { const index = process.argv.indexOf(`--${name}`); return index < 0 ? fallback : process.argv[index + 1]!; }
const mode = option('mode', 'regular') as 'regular' | 'fullscreen';
const cycles = Number(option('cycles', '100'));
const snapshot = option('snapshot', '');
const regexpControl = option('regexp-control', 'off') === 'on';
assert.ok(mode === 'regular' || mode === 'fullscreen');
assert.ok(Number.isInteger(cycles) && cycles >= 5 && cycles <= 100);
assert.ok(global.gc, 'requires controlled GC');
assert.equal(process.env.ALPHA_SANITIZED_HEAP_FIXTURE, '1', 'launch through alpha-bench for an isolated, sanitized environment');
if (snapshot) assert.equal(existsSync(resolve(snapshot)), false, 'never overwrite an existing snapshot');
if (snapshot && regexpControl) assert.equal(existsSync(resolve(`${snapshot}.after-regexp-control`)), false);
const root = mkdtempSync(join(tmpdir(), 'g2s-standalone-gc-'));
const samples = new Float64Array(cycles);
let last: Awaited<ReturnType<typeof stress>> | undefined;
try {
  for (let cycle = 0; cycle <= cycles; cycle++) {
    last = await stress(mode, root);
    for (let round = 0; round < 5; round++) { await new Promise<void>(resolve => setImmediate(resolve)); global.gc(); }
    assert.ok(last.weak.every(reference => reference.deref() === undefined));
    if (cycle) samples[cycle - 1] = process.memoryUsage().heapUsed;
  }
  assert.ok(last);
  if (snapshot) writeHeapSnapshot(resolve(snapshot));
  if (regexpControl) {
    // Diagnostic control only: replace V8's legacy RegExp last-match input.
    // Never run this in production or use it to claim production owner cleanup.
    /(?:)/.test('');
    for (let round = 0; round < 5; round++) { await new Promise<void>(resolve => setImmediate(resolve)); global.gc(); }
    if (snapshot) writeHeapSnapshot(resolve(`${snapshot}.after-regexp-control`));
  }
  console.log(JSON.stringify({
    head: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    dirty: !!execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim(),
    mode, cycles, updatesPerCycle: last.updates, weakReleasedPerCycle: last.weak.length,
    controlledGcHeap: Array.from(samples), heapAbsoluteDelta: samples.at(-1)! - samples[0]!,
    metrics: last.metrics, snapshotWritten: !!snapshot, regexpControlApplied: regexpControl,
    coverage: 'standalone production-shaped UI workload, same isolated HOME, preallocated GC samples, no node:test runner',
  }));
} finally { rmSync(root, { recursive: true, force: true }); }
