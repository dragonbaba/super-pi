import assert from "node:assert/strict";
import { Session } from "node:inspector/promises";
import { existsSync } from "node:fs";
import { costSession, costCall, costModule } from "../../tests/helpers/next-phase-session.ts";

const { ToolExecutionComponent } = await costModule("packages/coding-agent/dist/modes/interactive/components/tool-execution.js");
const { AssistantMessageComponent } = await costModule("packages/coding-agent/dist/modes/interactive/components/assistant-message.js");
const { initTheme } = await costModule("packages/coding-agent/dist/modes/interactive/theme/theme.js");
const { RetainedContainer } = await costModule("packages/tui/dist/components/retained-item.js");
const { ScrollView } = await costModule("packages/tui/dist/components/scroll-view.js");
const { Text, RELEASE_COMPONENT_RENDER_CACHE } = await costModule("packages/tui/dist/index.js");
const { TuiAltScreen } = await costModule("packages/tui/dist/tui-alt-screen.js");
const { TuiRenderInstrumentation } = await costModule("packages/tui/dist/render-instrumentation.js");
initTheme("dark");
class FixtureTerminal {
  columns = 120; rows = 40; kittyProtocolActive = false; gated = false; writes = 0; bytes = 0;
  activeData: string | undefined; activeGeneration = 0; completion: any;
  start() {} stop() {} async drainInput() {} write(data: string) { this.bytes += Buffer.byteLength(data); }
  setFrameWriteCompletionListener(callback: any) { this.completion = callback; }
  writeFrame(data: string, generation: number) { this.writes++; this.bytes += Buffer.byteLength(data); if (this.gated) { this.activeData = data; this.activeGeneration = generation; } else this.completion?.(generation); }
  release() { const generation = this.activeGeneration; this.activeData = undefined; this.activeGeneration = 0; if (generation) this.completion?.(generation); }
  cancelFrameWrite(generation: number) { if (this.activeGeneration === generation) { this.activeData = undefined; this.activeGeneration = 0; } }
  moveBy() {} hideCursor() {} showCursor() {} clearLine() {} clearFromCursor() {} clearScreen() {} setTitle() {} setProgress() {}
}
const f = await costSession(), terminal = new FixtureTerminal(), metrics = new TuiRenderInstrumentation();
const transcript = new RetainedContainer({ instrumentation: metrics }), scroll = new ScrollView(transcript, { follow: "none", primary: true });
const profiler = new Session(); profiler.connect();
let tool: any, assistant: any, tui: any;
try {
  tui = new TuiAltScreen(terminal, false, undefined, { terminalBoundaryTimeoutMs: 20, mouse: false }); tui.setRenderInstrumentation(metrics); tui.setLayoutRoot(scroll);
  const operations = Array.from({ length: 16 }, (_, index) => ({ operation: "write", mode: "create", path: `file${index}`, content: Array.from({ length: 160 }, (_, line) => `English 中文 ${index}:${line}`).join("\n") }));
  await f.run([[costCall("discover", "tool_search", { query: "file_batch", limit: 1 })]]);
  await f.run([[costCall("batch", "file_batch", { operations, dryRun: true })]]);
  const result = f.result("batch"); assert.equal(result.isError, false, JSON.stringify(result));
  for (let index = 0; index < 5000; index++) transcript.addRetainedChild(new Text(`history ${index}`, 0, 0), { id: `history${index}`, version: 1, completed: true });
  const content = "# Long document\n" + "English 中文 paragraph ".repeat(4096) + "\n```ts\n" + "const value = '中文 code';\n".repeat(4096) + "```\nEND-MARKDOWN";
  assistant = new AssistantMessageComponent({ role: "assistant", content: [{ type: "text", text: content }], api: "fixture", provider: "fixture", model: "fixture", timestamp: 0,
    stopReason: "stop", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
  transcript.addRetainedChild(assistant, { id: "long", version: 1, completed: true });
  const definition = f.session.extensionRunner.getAllRegisteredTools().find((entry: any) => entry.definition.name === "file_batch").definition;
  tool = new ToolExecutionComponent("file_batch", "batch", { operations, dryRun: true }, {}, definition, { requestRender() {} }, f.cwd);
  tool.updateResult(result); tool.setExpanded(true); transcript.addRetainedChild(tool, { id: "batch", version: 1, completed: true });
  const expanded = tool.render(120).join("\n"); assert.equal(result.details.items.length, 16);
  assert.ok(expanded.includes("file0"), expanded.slice(-3000)); assert.equal(existsSync(f.cwd + "/file0"), false);
  tui.start();
  for (let index = 0; index < 3; index++) { tui.renderNow(); await tui.flushTerminalFrames(); }
  assert.ok(terminal.writes > 0); assert.ok(metrics.snapshot().rootRenders > 0);
  global.gc?.(); const heapBefore = process.memoryUsage().heapUsed, cpu = process.cpuUsage(), start = performance.now(), timings: number[] = [];
  await profiler.post("HeapProfiler.startSampling", { samplingInterval: 32768 }); metrics.reset();
  for (let index = 0; index < 60; index++) {
    const begin = performance.now(); terminal.columns = index % 3 === 0 ? 80 : index % 3 === 1 ? 120 : 160;
    if (index % 2) scroll.scrollToStart(); else scroll.scrollToEnd();
    tool.setExpanded(index % 4 !== 0); tui.renderNow(); await tui.flushTerminalFrames(); timings.push(performance.now() - begin);
  }
  terminal.gated = true; scroll.scrollToEnd(); terminal.columns = 100; tui.renderNow(); terminal.columns = 90; tui.renderNow();
  const busy = tui.getTerminalFrameQueueSnapshot(); assert.equal(busy.activeWrites, 1); assert.ok(busy.pendingFrames <= 1);
  terminal.release(); terminal.gated = false;
  for (let index = 0; index < 10; index++) { terminal.release(); await new Promise<void>(resolve => setImmediate(resolve)); }
  await tui.flushTerminalFrames(); const flushed = tui.getTerminalFrameQueueSnapshot(); assert.equal(flushed.activeWrites, 0); assert.equal(flushed.pendingFrames, 0);
  terminal.gated = true; terminal.columns = 110; tui.renderNow(); const cancelStart = performance.now(); await tui.stop(); const cancelMs = performance.now() - cancelStart;
  const stopped = tui.getTerminalFrameQueueSnapshot(); assert.equal(stopped.activeWrites, 0); assert.equal(stopped.pendingFrames, 0); assert.equal(terminal.activeData, undefined);
  const { profile } = await profiler.post("HeapProfiler.stopSampling"); let sampledBytes = 0; const nodes = [profile.head];
  while (nodes.length) { const node = nodes.pop()!; sampledBytes += node.selfSize; for (const child of node.children) nodes.push(child); }
  const used = process.cpuUsage(cpu); timings.sort((a, b) => a - b);
  console.log(JSON.stringify({ benchmark: "N4-tui-boundaries", implementation: process.env.SP_COST_LABEL ?? "candidate", node: process.version,
    historyItems: 5000, markdownCodeUnits: content.length, batchPaths: 16, frames: timings.length, elapsedMs: performance.now() - start, cpuUs: used.user + used.system,
    p50Ms: timings[29], p95Ms: timings[56], p99Ms: timings[59], sampledBytes, heapBefore, sampledPeakHeap: process.memoryUsage().heapUsed,
    writes: terminal.writes, terminalBytes: terminal.bytes, metrics: metrics.snapshot(), busy, flushed, stopped, cancelMs,
    measuredScope: "actual retained Alt/ScrollView/Assistant/Tool components; controlled gated Terminal, not OS drain throughput" }));
} finally {
  try {
    await tui?.stop(); tool?.[RELEASE_COMPONENT_RENDER_CACHE]?.(); assistant?.[RELEASE_COMPONENT_RENDER_CACHE]?.();
    scroll[RELEASE_COMPONENT_RENDER_CACHE](); transcript.clear(); tui?.clear(); terminal.release(); terminal.completion = undefined;
  } finally { profiler.disconnect(); tool = undefined; assistant = undefined; await f.release(); }
}
global.gc?.(); console.log(JSON.stringify({ release: "N4-tui-boundaries", heapAfterRelease: process.memoryUsage().heapUsed, retainedChildren: transcript.children.length, terminalReferences: terminal.activeData === undefined ? 0 : 1, removedRoot: !existsSync(f.root) }));
