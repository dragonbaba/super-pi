import assert from "node:assert/strict";
import { Session } from "node:inspector/promises";
import { setImmediate as nextTask } from "node:timers/promises";
import { UserMessageComponent } from "../../packages/coding-agent/src/modes/interactive/components/user-message.ts";
import { initTheme } from "../../packages/coding-agent/src/modes/interactive/theme/theme.ts";
import { legacyUserMessage } from "../../tests/helpers/legacy-user-message.ts";
import { RELEASE_COMPONENT_RENDER_CACHE } from "../../packages/tui/src/component-cache.ts";
import type { Component } from "../../packages/tui/src/tui.ts";

const gc = (globalThis as { gc?: () => void }).gc;
assert.ok(gc, "Run with --expose-gc");
initTheme("dark");
const source = "Paragraph 中文 emoji🙂 " .repeat(1200);
const refs: WeakRef<object>[] = [];
let paddedLineCopies = 0;
function ascending(a: number, b: number) { return a - b; }
async function measure(name: string, component: Component) {
  for (let i = 0; i < 128; i++) component.render(100);
  if (name === "previous-box") paddedLineCopies = Math.max(0, component.render(100).length - 2);
  const inspector = new Session(); inspector.connect();
  const samples = new Float64Array(2000);
  try {
    await inspector.post("HeapProfiler.startSampling", { samplingInterval: 1024, includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true });
    let lines = 0;
    for (let i = 0; i < samples.length; i++) { const started = performance.now(); lines += component.render(100).length; samples[i] = performance.now() - started; }
    const { profile } = await inspector.post("HeapProfiler.stopSampling");
    const pending = [profile.head]; let bytes = 0;
    while (pending.length) { const item = pending.pop()!; bytes += item.selfSize; for (const child of item.children) pending.push(child); }
    samples.sort(ascending);
    process.stdout.write(JSON.stringify({ name, renders: samples.length, lines, sampledBytes: bytes, bytesPerRender: bytes / samples.length,
      medianMs: samples[1000], p95Ms: samples[1899] }) + "\n");
  } finally { inspector.disconnect(); }
  const nodes: any[] = [component];
  while (nodes.length) {
    const node = nodes.pop()!;
    refs.push(new WeakRef(node), new WeakRef(node.render(100)));
    for (const child of node.children ?? []) nodes.push(child);
    node[RELEASE_COMPONENT_RENDER_CACHE]?.();
  }
}
await measure("previous-box", legacyUserMessage(source));
await measure("integrated-markdown-with-OSC", new UserMessageComponent(source));
for (let i = 0; i < 5; i++) { await nextTask(); gc(); }
let retained = 0; for (const ref of refs) if (ref.deref()) retained++;
assert.equal(retained, 0);
process.stdout.write(JSON.stringify({ trackedReferences: refs.length, retainedAfterGc: retained, removedBoxesPerMessage: 1,
  eliminatedPaddedLineCopiesPerCachedRender: paddedLineCopies, node: process.version, platform: process.platform }) + "\n");
