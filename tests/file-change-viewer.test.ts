import assert from "node:assert/strict";
import test from "node:test";
import { Session } from "node:inspector/promises";
import { createJiti } from "jiti";
import { visibleWidth } from "@super-pi/tui";
const { ChangeViewer } = await createJiti(import.meta.url).import<any>("../packages/extensions/mutation-guard-write/changes.ts");

test("N1 full bounded report materializes only visible rows and releases numeric scroll state", async t => {
  let done = 0, renders = 0;
  const view = new ChangeViewer("x".repeat(65536), { terminal: { rows: 24 }, requestRender() { renders++; } }, () => { done++; });
  const profiler = process.env.SP_PREVIEW_PROFILE === "1" ? new Session() : undefined;
  try {
    const first = view.render(1), initial = view.getDiagnostics();
    assert.equal(first.length, 23); assert.equal(initial.rowsMaterialized, 22); assert.ok(initial.graphemesVisited <= 44);
    assert.ok(initial.scrollBytes <= 327685);
    for (let i = 0; i < 20000; i++) assert.equal(view.render(1), first);
    assert.deepEqual(view.getDiagnostics(), initial);
    global.gc?.(); const heapBefore = process.memoryUsage().heapUsed;
    if (profiler) { profiler.connect(); await profiler.post("HeapProfiler.startSampling", { samplingInterval: 1024 }); }
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
    }
    global.gc?.(); t.diagnostic(JSON.stringify({ benchmark: "N1-change-viewport", node: process.version, stableRenders: 20000, changedViewports: 200,
      stableNewRows: 0, metrics, released, heapBefore, heapAfterRelease: process.memoryUsage().heapUsed, sampledBytes: profiler ? sampledBytes : null }));
  } finally { view.dispose(); profiler?.disconnect(); }
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
