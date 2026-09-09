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
import { FakeScheduler } from "../../tests/helpers/runtime-instrumentation.ts";

if (!global.gc) throw new Error("Run this bounded fixture with --expose-gc");
initTheme("dark");
const source = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const scheduler = new FakeScheduler();
const runtime = createExtensionRuntime();
const references: WeakRef<object>[] = [];
let prompts = 0, renders = 0, cacheBuilds = 0, maxRows = 0;
const extension = await loadExtensionFromFactory(pi => pi.on("tool_call", async (_event, ctx) => {
 references.push(new WeakRef(ctx));
 await ctx.ui.select("controlled approval", ["Approve once", "Deny"], { signal: ctx.signal, details: "中 script & 255\n".repeat(1024) });
}), process.cwd(), createEventBus(), runtime);
const runner = new ExtensionRunner([extension], runtime, process.cwd(), SessionManager.inMemory(), {} as never,
 { scheduler, hookTimeouts: { safety: { timeoutMs: 30_000 } } });
runner.setUIContext({ ...runner.getUIContext(), select: async (title, choices, opts) => {
 prompts++;
 const selector: any = new ExtensionSelectorComponent(title, choices, () => {}, () => {},
  { details: opts?.details, tui: { terminal: { rows: 16, columns: 64 } } as never });
 references.push(new WeakRef(selector));
 let cached: unknown;
 for (let i = 0; i < 20; i++) {
  selector.handleInput(i % 2 ? "j" : "k");
  const lines = selector.render(i < 10 ? 64 : 48);
  renders++; maxRows = Math.max(maxRows, lines.length);
  if (selector.detailLines !== cached) { cacheBuilds++; cached = selector.detailLines; }
 }
 scheduler.advanceBy(60_000);
 selector.dispose();
 assert.equal(selector.details, undefined); assert.equal(selector.detailLines.length, 0);
 return choices[0];
}}, "tui");
async function batch(count: number): Promise<void> {
 for (let index = 0; index < count; index++) await runner.emitToolCall({ type: "tool_call", toolName: "controlled", toolCallId: `fixture-${index}`, input: {} } as never);
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
await nextTask(); global.gc(); await nextTask(); global.gc();
const liveReferences = references.reduce((sum, reference) => sum + Number(reference.deref() !== undefined), 0);
assert.equal(liveReferences, 0);
assert.equal(scheduler.highWaterMark.current, 0);
assert.equal((runner as any).toolCallDeadlines, undefined);
assert.equal((runner as any).toolCallDialogOwner, undefined);
assert.equal(runner.hookDeliveryStats.timeouts, 0);
assert.equal(cacheBuilds, prompts * 2); assert.ok(maxRows <= 16);
console.log(JSON.stringify({ source, node: process.version, platform: process.platform, warmup: 10, measuredApprovals: 100,
 elapsedMs, sampledBytes, sampledBytesPerApproval: sampledBytes / 100, postGcHeapDelta: process.memoryUsage().heapUsed - before,
 prompts, renders, cacheBuilds, maxRows, timerHighWaterMark: scheduler.highWaterMark.maximum,
 pendingTimers: scheduler.highWaterMark.current, liveReferences, activePromptOwners: 0, timeouts: 0 }));
