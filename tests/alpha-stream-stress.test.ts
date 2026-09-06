import assert from 'node:assert/strict';
import test from 'node:test';
import { Session } from 'node:inspector/promises';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stress } from './helpers/alpha-stress-workload.ts';


for (const mode of ['regular', 'fullscreen'] as const) test(`100000 actual session-to-component updates and frame ownership: ${mode}`, async (t) => {
  let result: Awaited<ReturnType<typeof stress>> | undefined;
  const cycles = Number(process.env.ALPHA_GC_CYCLES ?? 5);
  assert.ok(Number.isInteger(cycles) && cycles >= 5 && cycles <= 100);
  const heapStorage = new Float64Array(cycles);
  let heapCount = 0;
  const profiler = process.env.ALPHA_GC_PROFILE === '1' ? new Session() : undefined;
  const survivors: { function: string; source: string; bytes: number }[] = [];
  const fixtureRoot = process.env.ALPHA_GC_REUSE_HOME === '1' ? mkdtempSync(join(tmpdir(), 'g2s-stress-shared-')) : undefined;
  profiler?.connect();
  try {
  for (let cycle = 0; cycle < (global.gc ? cycles + 1 : 1); cycle++) {
    if (cycle === 1 && profiler) await profiler.post('HeapProfiler.startSampling', { samplingInterval: 16384 });
    result = await stress(mode, fixtureRoot);
    if (global.gc) {
      for (let round = 0; round < 5; round++) { await new Promise<void>(resolve => setImmediate(resolve)); global.gc(); }
      assert.ok(result.weak.every(reference => reference.deref() === undefined));
      if (cycle > 0) heapStorage[heapCount++] = process.memoryUsage().heapUsed; // Fixed storage excludes recorder growth.
    }
  }
  if (profiler && global.gc) {
    // Default sampling excludes collected allocations. Start after warm-up and
    // stop after the final controlled GC; this attributes surviving samples,
    // not all transient allocation and not a complete heap-retainer graph.
    const { profile } = await profiler.post('HeapProfiler.stopSampling');
    const pending = [profile.head];
    while (pending.length) {
      const node = pending.pop()!;
      if (node.selfSize) survivors.push({ function: node.callFrame.functionName,
        source: node.callFrame.url.replace(/^.*[\\/](packages|scripts|tests)[\\/]/, '$1/'), bytes: node.selfSize });
      pending.push(...node.children);
    }
    survivors.sort((a, b) => b.bytes - a.bytes);
  }
  } finally {
    profiler?.disconnect();
    if (fixtureRoot) rmSync(fixtureRoot, { recursive: true, force: true });
  }
  assert.ok(result);
  const heap = Array.from(heapStorage.subarray(0, heapCount)); // Serialize only after measurement.
  if (heap.length) assert.ok(heap.at(-1)! <= heap[0] * 1.1, 'released owners must not accumulate more than 10% heap');
  t.diagnostic(JSON.stringify({ mode, updates: result.updates, updatePromises: result.updatePromises, metrics: result.metrics, weakReleased: global.gc ? result.weak.length : 'requires --expose-gc',
    measuredCycles: heap.length, controlledGcHeap: heap, heapAbsoluteDelta: heap.length ? heap.at(-1)! - heap[0] : null,
    survivingSampleTopSites: profiler ? survivors.slice(0, 20) : undefined,
    homeControl: fixtureRoot ? 'same-isolated-path' : 'unique-isolated-path-per-cycle',
    coverage: 'actual AgentSession emission, InteractiveMode, AssistantMessage, Markdown, retained TUI and strict sink; provider bypassed to prevent observer coalescing' }));
});
