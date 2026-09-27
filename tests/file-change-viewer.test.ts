import assert from "node:assert/strict";
import test from "node:test";
import { Session } from "node:inspector/promises";
import { createJiti } from "jiti";
import { visibleWidth, stripTerminalSequences } from "@super-pi/tui";
const { ChangeViewer } = await createJiti(import.meta.url).import<any>("../packages/extensions/mutation-guard-write/changes.ts");

test("N1 full bounded report materializes only visible rows and releases numeric scroll state", async t => {
  let done = 0, renders = 0;
  const view = new ChangeViewer("x".repeat(65536), { terminal: { rows: 24 }, requestRender() { renders++; } }, () => { done++; });
  const profiler = process.env.SP_PREVIEW_PROFILE === "1" ? new Session() : undefined;
  try {
    const first = view.render(1), initial = view.getDiagnostics();
    assert.equal(first.length, 23); assert.equal(initial.rowsMaterialized, 22); assert.ok(initial.graphemesVisited <= 44);
    assert.ok(initial.scrollBytes <= 786444);
    for (let i = 0; i < 20000; i++) assert.equal(view.render(1), first);
    assert.deepEqual(view.getDiagnostics(), initial);
    global.gc?.(); const heapBefore = process.memoryUsage().heapUsed;
    if (profiler) { profiler.connect(); await profiler.post("HeapProfiler.startSampling", { samplingInterval: 1024, includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true }); }
    for (let i = 0; i < 200; i++) {
      view.handleInput(i % 2 ? "\u001b[A" : "\u001b[B");
      const width = i % 3 === 0 ? 1 : i % 3 === 1 ? 3 : 80;
      const lines = view.render(width); assert.ok(lines.length <= 23);
      for (const line of lines) assert.ok(visibleWidth(line) <= width);
    }
    const metrics = view.getDiagnostics(); assert.ok(metrics.rowsMaterialized <= 22 * 201); assert.equal(renders, 200);
    view.handleInput("\u001b"); assert.equal(done, 1);
    const released = view.getDiagnostics();
    assert.equal(released.bodyCodeUnits, 0); assert.equal(released.scrollBytes, 0); assert.equal(released.cachedRows, 0); assert.equal(released.lifecycleReferences, 0);
    let sampledBytes = 0;
    if (profiler) {
      const { profile } = await profiler.post("HeapProfiler.stopSampling"), pending = [profile.head];
      while (pending.length) { const node = pending.pop()!; sampledBytes += node.selfSize; for (const child of node.children) pending.push(child); }
      profile.head.children.length = 0;
      const samples = (profile as typeof profile & { samples?: unknown[] }).samples;
      if (samples) samples.length = 0;
      profiler.disconnect();
      await new Promise<void>(resolve => setImmediate(resolve));
    }
    global.gc?.(); t.diagnostic(JSON.stringify({ benchmark: "N1-change-viewport", node: process.version, stableRenders: 20000, changedViewports: 200,
      stableNewRows: 0, metrics, released, heapBefore, heapAfterRelease: process.memoryUsage().heapUsed, sampledBytes: profiler ? sampledBytes : null }));
  } finally { view.dispose(); profiler?.disconnect(); }
});

test("N1 long-line Up and PageUp reuse bounded row checkpoints", () => {
  const view = new ChangeViewer("x".repeat(65536), { terminal: { rows: 5 }, requestRender() {} }, () => {});
  try {
    view.render(1);
    for (let index = 0; index < 6000; index++) view.handleInput("\u001b[6~");
    const before = view.getDiagnostics().graphemesVisited;
    for (let index = 0; index < 5000; index++) view.handleInput("\u001b[A");
    for (let index = 0; index < 500; index++) view.handleInput("\u001b[5~");
    assert.equal(view.getDiagnostics().graphemesVisited, before, "reverse navigation never replays an indexed line");
    assert.deepEqual(view.render(1).slice(0, 3), ["x", "x", "x"]);
    view.render(3); view.handleInput("\u001b[A");
    const resized = view.getDiagnostics().graphemesVisited;
    for (let index = 0; index < 1000; index++) view.handleInput("\u001b[A");
    assert.equal(view.getDiagnostics().graphemesVisited, resized, "a new width builds one index, then reuses it");
    assert.ok(view.getDiagnostics().scrollBytes <= 786444);
  } finally { view.dispose(); }
  assert.equal(view.getDiagnostics().scrollBytes, 0); assert.equal(view.getDiagnostics().lifecycleReferences, 0);
});

test("N1 viewer neither caches report graphemes globally nor emits tabs", t => {
  const mark = "e" + "\u0301".repeat(60000), cached: string[] = [], set = Map.prototype.set;
  t.mock.method(Map.prototype, "set", function(this: Map<unknown, unknown>, key: unknown, value: unknown) {
    if (typeof key === "string" && key.includes("\u0301")) cached.push(key);
    return set.call(this, key, value);
  });
  const view = new ChangeViewer(mark + "\n\tx\ty", { terminal: { rows: 6 }, requestRender() {} }, () => {});
  try {
    assert.deepEqual(view.render(8).slice(0, 2), [mark, "   x   y"]);
    assert.deepEqual(cached, []);
  } finally { view.dispose(); }
  assert.equal(view.getDiagnostics().bodyCodeUnits, 0); assert.equal(view.getDiagnostics().scrollBytes, 0);
});

for (const size of [255, 256, 300]) test(`N1 grapheme width ${size} neither wraps numeric metadata nor loses following text`, () => {
  const cluster = "\u093e".repeat(size), view = new ChangeViewer(cluster + "abc\nend", { terminal: { rows: 6 }, requestRender() {} }, () => {});
  try {
    assert.equal([...new Intl.Segmenter().segment(cluster)].length, 1);
    assert.deepEqual(view.render(size).slice(0, 3), [cluster, "abc", "end"]);
    view.handleInput("\u001b[B"); assert.deepEqual(view.render(size).slice(0, 2), ["abc", "end"]);
    view.handleInput("\u001b[A"); assert.equal(view.render(size)[0], cluster);
    assert.deepEqual(view.render(3).slice(0, 3).map(stripTerminalSequences), ["", "abc", "end"]);
  } finally { view.dispose(); }
});

test("N1 viewport scroll and resize preserve grapheme boundaries and blank physical lines", () => {
  const view = new ChangeViewer("ab\n\n中文e\u0301🙂\nend", { terminal: { rows: 5 }, requestRender() {} }, () => {});
  try {
    assert.deepEqual(view.render(2).slice(0, 3), ["ab", "", "中"]);
    view.handleInput("\u001b[B"); assert.deepEqual(view.render(2).slice(0, 3), ["", "中", "文"]);
    view.handleInput("\u001b[A"); assert.deepEqual(view.render(2).slice(0, 3), ["ab", "", "中"]);
    for (const width of [1, 3, 8, 1]) for (const line of view.render(width)) assert.ok(visibleWidth(line) <= width);
  } finally { view.dispose(); }
});
