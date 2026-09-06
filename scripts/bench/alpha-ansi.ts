import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { Session } from 'node:inspector/promises';
import { ansiCorpus } from '../../tests/helpers/alpha-ansi.ts';
import { createToolResultPresentationOwner, createToolResultPresentationCounters } from '../../packages/coding-agent/src/core/tool-result-presentation.ts';

const profiler = new Session(); profiler.connect();
const rows: unknown[] = [];
const weak: WeakRef<object>[] = [];
function run(count: number) {
  const counters = createToolResultPresentationCounters();
  const { content } = ansiCorpus(count, -1);
  const message = { role: 'toolResult', toolCallId: 'ansi-bench', toolName: 'g2_raw_result_probe', content, timestamp: 1, isError: false };
  const owner = createToolResultPresentationOwner({ enabled: true, budgetTokens: 1024, counters }, 'ansi-bench')!;
  weak.push(new WeakRef(content), new WeakRef(content[0]!));
  const started = performance.now(); const view = owner.create(content, message.toolCallId)!; owner.release();
  const indexBytes = counters.terminalIndexRetainedBytes;
  let chunks = 0;
  if (view.version === 2) {
    let cursor: string | undefined = view.continuation.cursor;
    while (cursor) { const result = owner.readContinuation(cursor, [message], 1024); assert.notEqual(result.nextCursor, cursor); cursor = result.nextCursor; chunks++; }
  }
  const elapsed = performance.now() - started;
  assert.equal(counters.sourceDigestConstructions, 1);
  assert.equal(counters.fullSourceEstimatorScans, 1);
  assert.ok((indexBytes ?? 0) <= 49152);
  const retained = { exact: counters.terminalExactIntervalsRetained, sparse: counters.terminalSparseCheckpointsRetained };
  owner.dispose();
  assert.equal(counters.terminalIndexRetainedBytes, 0);
  rows.push({ count, elapsed, chunks, indexBytes, retained, counters });
}
try {
  await profiler.post('HeapProfiler.startSampling', { samplingInterval: 1024, includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true });
  for (const count of [1, 4096, 4097, 4098, 8192, 65536]) run(count);
  const heap = await profiler.post('HeapProfiler.stopSampling');
  const sites: { function: string; bytes: number }[] = []; const pending = [heap.profile.head];
  while (pending.length) { const node = pending.pop()!; sites.push({ function: node.callFrame.functionName, bytes: node.selfSize }); pending.push(...node.children); }
  const heaps: number[] = [];
  for (let i = 0; i < 5; i++) { await new Promise<void>(resolve => setImmediate(resolve)); global.gc?.(); heaps.push(process.memoryUsage().heapUsed); }
  assert.ok(global.gc, 'run with --expose-gc'); assert.ok(weak.every(reference => reference.deref() === undefined));
  console.log(JSON.stringify({ head: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), dirty: !!execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim(), rows,
    controlledGcHeap: heaps, weakReleased: weak.length, allocations: sites.sort((a, b) => b.bytes - a.bytes).slice(0, 15) }));
} finally { profiler.disconnect(); }
