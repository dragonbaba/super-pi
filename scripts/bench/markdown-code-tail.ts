import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { Session } from "node:inspector/promises";
import { setImmediate as nextTurn } from "node:timers/promises";
import { Markdown, type MarkdownTheme } from "../../packages/tui/src/components/markdown.ts";
import { readIntegerOption } from "./benchmark.ts";

const gc = globalThis.gc;
assert.ok(gc, "Run with --expose-gc");
const identity = (text: string): string => text;
const THEME: MarkdownTheme = { heading: identity, link: identity, linkUrl: identity, code: identity, codeBlock: identity,
  codeBlockBorder: identity, quote: identity, quoteBorder: identity, hr: identity, listBullet: identity,
  bold: identity, italic: identity, strikethrough: identity, underline: identity };
const rows = readIntegerOption("--rows", 10000), updates = readIntegerOption("--updates", 80), width = 120;
const fence = String.fromCharCode(96).repeat(3);
let source = fence + "\n";
for (let index = 0; index < rows; index++) source += `row_${index}\n`;
const states = [source + fence[0], source + fence.slice(0, 2), source + fence, source + fence + "\n"];
let markdown: Markdown | undefined = new Markdown(states[0]!,0,0,THEME,undefined,{incrementalRenderCache:true});
let lines: string[] | undefined;
for (const state of states) {
  markdown.setText(state); lines = markdown.render(width);
  assert.equal(lines.length, rows + 2);
  for (let index = 0; index < rows; index++) assert.equal(lines[index + 1], `  row_${index}`.padEnd(width));
}
const references: WeakRef<object>[] = [new WeakRef(markdown)], times = new Float64Array(updates);
const expectedLastLine = `  row_${rows - 1}`.padEnd(width);
const profiler = new Session(); profiler.connect(); gc();
const heapBefore = process.memoryUsage().heapUsed; let peakHeap = heapBefore, sampled;
try {
  await profiler.post("HeapProfiler.startSampling", { samplingInterval: 4096, includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true });
  for (let index = 0; index < updates; index++) {
    const start = performance.now(); markdown.setText(states[index % states.length]!); lines = markdown.render(width);
    times[index] = performance.now() - start;
    assert.equal(lines.length, rows + 2); assert.equal(lines[rows], expectedLastLine);
    references.push(new WeakRef(lines)); peakHeap = Math.max(peakHeap, process.memoryUsage().heapUsed);
  }
  sampled = await profiler.post("HeapProfiler.stopSampling");
} finally { profiler.disconnect(); }
const digest = createHash("sha256"); for (const line of lines!) { digest.update(line); digest.update("\n"); }
markdown.setText(""); assert.deepEqual(markdown.render(width), []); markdown.invalidate();
markdown = undefined; lines = undefined;
for (let index = 0; index < 6; index++) { await nextTurn(); gc(); }
let retained = 0; for (const reference of references) if (reference.deref()) retained++;
assert.equal(retained, 0);
let sampledBytes = 0; const stack = [sampled!.profile.head], sites: { name: string; bytes: number }[] = [];
while (stack.length) { const node = stack.pop()!; sampledBytes += node.selfSize;
  if (node.selfSize) sites.push({ name: node.callFrame.functionName, bytes: node.selfSize });
  for (const child of node.children ?? []) stack.push(child);
}
sites.sort((left, right) => right.bytes - left.bytes); times.sort();
console.log(JSON.stringify({ rows, updates, renderedLines: rows + 2, sourceCharacters: states[0]!.length,
  finalHash: digest.digest("hex"), p50Ms: times[Math.floor(updates * .5)], p95Ms: times[Math.min(updates - 1,Math.floor(updates * .95))],
  sampledBytes, heapBefore, observedPeakHeap: peakHeap, controlledGcHeap: process.memoryUsage().heapUsed,
  trackedReferences: references.length, retained, leadingSites: sites.slice(0,8), node: process.version }));
