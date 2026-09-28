import assert from "node:assert/strict";
import { Session } from "node:inspector/promises";
import { releaseComponentRenderCaches } from "../../packages/tui/dist/tui.js";
import type { TUI } from "@super-pi/tui";
import type { ToolDefinition } from "../../packages/coding-agent/src/core/extensions/types.ts";
import { createWriteToolDefinition } from "../../packages/coding-agent/src/core/tools/write.ts";
import { ToolExecutionComponent, type ToolExecutionAllocationMetrics } from "../../packages/coding-agent/src/modes/interactive/components/tool-execution.ts";
import { initTheme } from "../../packages/coding-agent/src/modes/interactive/theme/theme.ts";
import { renderWriteResult } from "../../packages/extensions/mutation-guard-write/write-renderer.ts";

// Focused supplement to the full Agent -> InteractiveMode -> TUI leaf benchmark.
assert.ok(global.gc, "run with --expose-gc");
initTheme("dark");
const metrics: ToolExecutionAllocationMetrics = { updateDisplayCalls: 0, callRendererCalls: 0, resultRendererCalls: 0,
  componentCreations: 0, renderContextObjects: 0, internalWrapperObjects: 0, imageScans: 0, argsSerializations: 0,
  toolArgsGenerationUpdates: 0, toolArgsReplacementUpdates: 0, toolArgsSemanticFallbackComparisons: 0,
  toolArgsMissingGenerationUpdates: 0, toolArgsFinalizations: 0 };
const definition = { ...createWriteToolDefinition(process.cwd()), collapseCallOnResult: true, renderResult: renderWriteResult } as ToolDefinition<any, any>;
const args = { path: "synthetic.ts", content: "// synthetic benchmark\n".repeat(4000) };
const card = new ToolExecutionComponent("write", "bench-write", args, { allocationMetrics: metrics }, definition, { requestRender() {} } as TUI, process.cwd());
card.setArgsComplete();
const call = (card as any).callRendererComponent;
let highlightIdentity = call.cache.highlightedLines;
card.updateResult({ content: [{ type: "text", text: "Added synthetic.ts" }], details: {
  operation: "write", mutationReceiptVersion: 1, ok: true, category: "success", stateChanged: true, created: true,
} }, false, false);
card.render(80);
const callsBefore = metrics.callRendererCalls, resultsBefore = metrics.resultRendererCalls;
global.gc();
const heapBefore = process.memoryUsage().heapUsed;
const inspector = new Session(); inspector.connect();
await inspector.post("HeapProfiler.startSampling", { samplingInterval: 512, includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true });
for (let i = 0; i < 1000; i++) card.render(80);
assert.equal(metrics.callRendererCalls - callsBefore, 0);
assert.equal(metrics.resultRendererCalls - resultsBefore, 0);
for (let i = 0; i < 25; i++) {
  card.setExpanded(true); card.render(40); card.setExpanded(false); card.render(40);
  assert.strictEqual(call.cache.highlightedLines, highlightIdentity);
}
let { profile } = await inspector.post("HeapProfiler.stopSampling");
await inspector.post("HeapProfiler.disable"); inspector.disconnect();
let sampledBytes = 0;
const nodes = [profile.head];
while (nodes.length) { const node = nodes.pop()!; sampledBytes += node.selfSize; for (const child of node.children) nodes.push(child); }
releaseComponentRenderCaches(card);
assert.equal(call.cache, undefined);
assert.equal((card as any).resultRendererComponent.receipt, undefined);
assert.equal((card as any).resultRendererComponent.source, undefined);
highlightIdentity = undefined;
profile = undefined as any;
global.gc();
console.log(JSON.stringify({ node: process.version, platform: process.platform, renders: 1000, toggles: 25,
  highlightRebuildsOnToggle: 0, rendererCallsOnStableRender: 0, retainedDerivedReferencesAfterRelease: 0,
  sampledBytes, heapBefore, heapAfterRelease: process.memoryUsage().heapUsed, metrics }, null, 2));
