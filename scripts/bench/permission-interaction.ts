import assert from "node:assert/strict";
import { Session } from "node:inspector";
import { promisify } from "node:util";
import { setImmediate as nextTask } from "node:timers/promises";
import { execFileSync } from "node:child_process";
import { createExtensionRuntime, ExtensionRunner, loadExtensionFromFactory } from "../../packages/coding-agent/src/core/extensions/index.ts";
import { createEventBus } from "../../packages/coding-agent/src/core/event-bus.ts";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.ts";
import { ExtensionSelectorComponent } from "../../packages/coding-agent/src/modes/interactive/components/extension-selector.ts";
import { initTheme } from "../../packages/coding-agent/src/modes/interactive/theme/theme.ts";
import { InteractiveMode } from "../../packages/coding-agent/src/modes/interactive/interactive-mode.ts";
import { SessionPermissionController } from "../../packages/extensions/resource-lifecycle-guard/permission-controller.ts";
import { TuiAltScreen } from "../../packages/tui/src/tui-alt-screen.ts";
import { Container, VStack, Text } from "@super-pi/tui";
import { FakeScheduler, FakeTerminal } from "../../tests/helpers/runtime-instrumentation.ts";

if (!global.gc) throw new Error("Run this bounded fixture with --expose-gc");
initTheme("dark");
const source = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const scheduler = new FakeScheduler();
const runtime = createExtensionRuntime();
const references: WeakRef<object>[] = [];
let prompts = 0, renders = 0, cacheBuilds = 0, maxRows = 0, maxCacheLines = 0, maxCacheCodeUnits = 0;
let permission!: SessionPermissionController;
const extension = await loadExtensionFromFactory(pi => {
 pi.appendEntry = () => {};
 permission = new SessionPermissionController(pi);
 pi.on("tool_call", async (event, ctx) => {
  references.push(new WeakRef(ctx));
  return permission.authorizeToolCall(event, ctx);
 });
}, process.cwd(), createEventBus(), runtime);
const terminal = new FakeTerminal(64, 16);
let terminalInput!: (data: string) => void;
(terminal as any).start = (onInput: (data: string) => void) => { terminalInput = onInput; };
const ui = new TuiAltScreen(terminal);
const mode: any = Object.create(InteractiveMode.prototype);
mode.ui = ui; mode.editor = new Container(); mode.editorContainer = new Container(); mode.disposeActiveSelector = () => {};
ui.setLayoutRoot(new VStack([{ component: new Text("history"), minSize: 1 },
 { component: mode.editorContainer, minSize: 3 }, { component: new Text("footer\n".repeat(7)), minSize: 7 }]));
ui.start();
const runner = new ExtensionRunner([extension], runtime, process.cwd(), SessionManager.inMemory(), {} as never,
 { scheduler, hookTimeouts: { safety: { timeoutMs: 30_000 } } });
runner.setUIContext({ ...runner.getUIContext(), select: async (title, choices, opts) => {
 prompts++;
 const pending = mode.showExtensionSelector(title, choices, opts);
 const selector: any = mode.extensionSelector;
 references.push(new WeakRef(selector));
 let cached: unknown;
 for (let i = 0; i < 20; i++) {
  terminalInput(i % 2 ? "j" : "k");
  terminal.columns = i < 10 ? 64 : 48;
  ui.renderNow(true); await ui.flushTerminalFrames();
  renders++; maxRows = Math.max(maxRows, selector.viewportRows + 5);
  terminal.writes.length = 0;
  if (selector.detailLines !== cached) {
   cacheBuilds++; cached = selector.detailLines;
   maxCacheLines = Math.max(maxCacheLines, selector.detailLines.length);
   let units = 0; for (const line of selector.detailLines) units += line.length;
   maxCacheCodeUnits = Math.max(maxCacheCodeUnits, units);
  }
 }
 scheduler.advanceBy(60_000);
 terminalInput("\x1b[C");
 assert.ok(selector.detailOffset > 0);
 terminalInput("k"); terminalInput("\n");
 const result = await pending;
 assert.equal(selector.details, undefined); assert.equal(selector.detailLines.length, 0);
 assert.equal(mode.extensionSelector, undefined); assert.equal(mode.extensionSelectorOverlay, undefined);
 return result;
}}, "tui");
await permission.restore(runner.createContext());
permission.state.setMode("read-only");
const input = { path: "permission-profile-never-written.txt", content: "x".repeat(1024 * 1024) + "中END" };
async function batch(count: number): Promise<void> {
 for (let index = 0; index < count; index++) await runner.emitToolCall({ type: "tool_call", toolName: "write", toolCallId: `fixture-${index}`, input } as never);
}
await batch(10); // fixed warmup
await nextTask(); global.gc();
const before = process.memoryUsage().heapUsed;
const inspector = new Session(); inspector.connect();
const post = promisify(inspector.post.bind(inspector)) as (name: string, args?: object) => Promise<any>;
await post("HeapProfiler.startSampling", { samplingInterval: 32768 });
const started = performance.now();
await batch(100); // fixed workload; no repeated sampling
const elapsedMs = performance.now() - started;
const sample = await post("HeapProfiler.stopSampling"); inspector.disconnect();
let sampledBytes = 0;
function count(node: any): void { sampledBytes += node.selfSize; for (const child of node.children) count(child); }
count(sample.profile.head);
await ui.stop(); terminal.writes.length = 0;
await nextTask(); global.gc(); await nextTask(); global.gc();
const liveReferences = references.reduce((sum, reference) => sum + Number(reference.deref() !== undefined), 0);
assert.equal(liveReferences, 0);
assert.equal(scheduler.highWaterMark.current, 0);
assert.equal((runner as any).toolCallDeadlines, undefined);
assert.equal((runner as any).toolCallDialogOwner, undefined);
assert.equal(runner.hookDeliveryStats.timeouts, 0);
assert.equal(cacheBuilds, prompts * 2); assert.ok(maxRows <= 16);
assert.ok(maxCacheLines <= 4096); assert.ok(maxCacheCodeUnits <= 24 * 1024);
console.log(JSON.stringify({ source, node: process.version, platform: process.platform, warmup: 10, measuredApprovals: 100,
 elapsedMs, sampledBytes, sampledBytesPerApproval: sampledBytes / 100, postGcHeapDelta: process.memoryUsage().heapUsed - before,
 prompts, renders, cacheBuilds, maxRows, maxCacheLines, maxCacheCodeUnits, payloadCodeUnits: input.content.length, timerHighWaterMark: scheduler.highWaterMark.maximum,
 pendingTimers: scheduler.highWaterMark.current, liveReferences, activePromptOwners: 0, timeouts: 0 }));
