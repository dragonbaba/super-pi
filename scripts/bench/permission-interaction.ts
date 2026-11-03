import assert from "node:assert/strict";
import { Session } from "node:inspector";
import { promisify } from "node:util";
import { setImmediate as nextTask } from "node:timers/promises";
import { execFileSync } from "node:child_process";
import { createExtensionRuntime, ExtensionRunner, loadExtensionFromFactory } from "../../packages/coding-agent/src/core/extensions/index.ts";
import { createEventBus } from "../../packages/coding-agent/src/core/event-bus.ts";
import { SessionExecutionBoundary } from "../../packages/coding-agent/src/core/execution-boundary.ts";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.ts";
import { ExtensionSelectorComponent } from "../../packages/coding-agent/src/modes/interactive/components/extension-selector.ts";
import { initTheme } from "../../packages/coding-agent/src/modes/interactive/theme/theme.ts";
import { InteractiveMode } from "../../packages/coding-agent/src/modes/interactive/interactive-mode.ts";
import { SessionPermissionController } from "../../packages/extensions/resource-lifecycle-guard/permission-controller.ts";
import { assertBrowserExecAuthorization, consumeBrowserExecAuthorization } from "../../packages/extensions/resource-lifecycle-guard/permission-contract.ts";
import { consumeStructuredReadonlyWorkspacePolicy } from "../../packages/extensions/structured-readonly-command/delegation.ts";
import { consumeDelegatedTaskPolicies } from "../../packages/extensions/subagent/delegation.ts";
import { consumeFixAuthorization, assertFixAuthorization } from "../../packages/lsp/src/fix-authorization.ts";
import { resolve } from "node:path";
import { TuiAltScreen } from "../../packages/tui/src/tui-alt-screen.ts";
import { Container, VStack, Text } from "@super-pi/tui";
import { FakeScheduler, FakeTerminal } from "../../tests/helpers/runtime-instrumentation.ts";

if (!global.gc) throw new Error("Run this bounded fixture with --expose-gc");
if (process.argv.includes("--transition")) {
 const references: WeakRef<object>[] = [];
 let checks = 0, revocations = 0, drains = 0;
 const profiler = new Session(); profiler.connect();
 const sample = promisify(profiler.post.bind(profiler)) as (name: string, args?: object) => Promise<any>;
 async function measure(mode: string): Promise<void> {
  const boundary = new SessionExecutionBoundary();
  references.push(new WeakRef(boundary), new WeakRef(boundary.signal));
  for (let i = 0; i < 2; i++) {
   const owner = { revoke() { revocations++; }, async drain() { drains++; } };
   references.push(new WeakRef(owner)); boundary.register(String(i), owner);
  }
  for (let i = 0; i < 10_000; i++) { boundary.assertCurrent(); checks++; }
  const publish = () => { if (mode === "failure") throw new Error("controlled publication failure"); };
  references.push(new WeakRef(publish));
  const pending = boundary.transition(publish);
  if (mode === "failure") await assert.rejects(pending, /controlled publication/);
  else if (mode === "dispose") { await boundary.dispose(); await pending; }
  else await pending;
  await boundary.dispose();
  assert.equal(boundary.participantCount, 0); assert.equal(boundary.hasDeadline, false); assert.equal(boundary.isDraining, false);
 }
 await sample("HeapProfiler.startSampling", { samplingInterval: 1024, includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true });
 for (const mode of ["complete", "failure", "dispose"]) await measure(mode);
 const { profile } = await sample("HeapProfiler.stopSampling"); profiler.disconnect();
 let sampledBytes = 0; const nodes = [profile.head];
 while (nodes.length) { const node = nodes.pop(); sampledBytes += node.selfSize; for (const child of node.children) nodes.push(child); }
 profile.head.children.length = 0; if (profile.samples) profile.samples.length = 0;
 await nextTask(); global.gc(); await nextTask(); global.gc();
 const liveReferences = references.reduce((count, ref) => count + Number(ref.deref() !== undefined), 0);
 assert.equal(liveReferences, 0); assert.equal(checks, 30_000); assert.equal(revocations, 10); assert.equal(drains, 10);
 assert.ok(sampledBytes < 4 * 1024 * 1024, `Transition allocation regression: ${sampledBytes}`);
 console.log(JSON.stringify({ fixture: "native-execution-boundary", checks, transitions: 3, revocations, drains, participantsPeak: 2,
  references: references.length, liveReferences, deadlinesAfterRelease: 0, sampledBytes, allocationLimit: 4 * 1024 * 1024,
  scope: "coordinator admission/lifecycle only; no actual tool processes or streaming updates" }));
 process.exit(0);
}
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
if (process.argv.includes("--delegation")) {
 permission.state.setMode("full-access"); permission.state.setApprovalPolicy("never-ask");
 const profile = new Session(); profile.connect();
 const sample = promisify(profile.post.bind(profile)) as (name: string, args?: object) => Promise<any>;
 const grants: WeakRef<object>[] = [];
 const combinedSignals: WeakRef<AbortSignal>[] = [];
 const caller = new AbortController();
 const cases = [
  { name: "browser_exec", input: { code: "print('not executed')" }, consume: (value: object) => {
   const grant = consumeBrowserExecAuthorization(value, "delegation");
   assertBrowserExecAuthorization(grant, value, "delegation"); assertBrowserExecAuthorization(grant, value, "delegation");
   return grant;
  } },
  { name: "structured_readonly_command", input: { command: "git", args: ["status"], cwd: process.cwd() }, consume: (value: object) => consumeStructuredReadonlyWorkspacePolicy(value, "delegation") },
  { name: "subagent", input: { agent: "controlled", task: "not executed", cwd: process.cwd() }, consume: (value: object) => consumeDelegatedTaskPolicies(value, [process.cwd()], process.cwd(), "delegation")[0] },
  { name: "lsp_fix", input: { path: "scripts/bench/permission-interaction.ts", write: true }, consume: (value: object) => {
   const grant = consumeFixAuthorization(value, "delegation");
   assertFixAuthorization(grant, resolve("scripts/bench/permission-interaction.ts")); return grant;
  } },
 ];
 async function consumeBatch(): Promise<void> {
  for (let round = 0; round < 4; round++) {
   for (const item of cases) {
   const args = { ...item.input };
   const decision = await runner.emitToolCall({ type: "tool_call", toolName: item.name, toolCallId: "delegation", input: args } as never);
   assert.equal(decision?.finalAuthorization?.consume(args, "delegation", item.name), args);
   const grant = item.consume(args); assert.ok(grant); grant.assertCurrent(); grants.push(new WeakRef(grant));
   combinedSignals.push(new WeakRef(AbortSignal.any([caller.signal, grant.revocationSignal])));
   for (const key of Object.getOwnPropertySymbols(args)) assert.equal((args as any)[key], undefined);
   }
   await runtime.executionBoundary.transition(() => undefined);
  }
 }
 await sample("HeapProfiler.startSampling", { samplingInterval: 32768 });
 let allocation: any;
 try { await consumeBatch(); allocation = await sample("HeapProfiler.stopSampling"); }
 finally { profile.disconnect(); }
 const retained = { code: "print('unconsumed approval')" };
 assert.ok((await runner.emitToolCall({ type: "tool_call", toolName: "browser_exec", toolCallId: "delegation", input: retained } as never))?.finalAuthorization);
 const issuer = new WeakRef(permission);
 runner.invalidate(); permission = undefined as never;
 await runtime.executionBoundary.dispose(); assert.equal(runtime.executionBoundary.participantCount, 0);
 await ui.stop(); terminal.writes.length = 0;
 await nextTask(); global.gc(); await nextTask(); global.gc();
 assert.equal(issuer.deref(), undefined, "an unconsumed attachment must not retain its session/controller");
 const liveGrants = grants.reduce((sum, value) => sum + Number(value.deref() !== undefined), 0);
 const liveContexts = references.reduce((sum, value) => sum + Number(value.deref() !== undefined), 0);
 const liveCombinedSignals = combinedSignals.reduce((sum, value) => sum + Number(value.deref() !== undefined), 0);
 assert.equal(liveCombinedSignals, 0);
 assert.equal(liveGrants, 0); assert.equal(liveContexts, 0); assert.equal(prompts, 0); assert.equal(scheduler.highWaterMark.current, 0);
 assert.throws(() => consumeBrowserExecAuthorization(retained, "delegation"), /authority changed/);
 for (const key of Object.getOwnPropertySymbols(retained)) assert.equal((retained as any)[key], undefined);
 let sampledBytes = 0;
 function sum(node: any): void { sampledBytes += node.selfSize; for (const child of node.children) sum(child); }
 sum(allocation.profile.head);
 assert.ok(sampledBytes <= 16 * 1024 * 1024, `Delegation allocation regression: ${sampledBytes}`);
 console.log(JSON.stringify({ source, node: process.version, platform: process.platform, approved: cases.length * 4 + 1, measuredApprovals: cases.length * 4, consumed: cases.length * 4,
  transitions: 4, executionOwnersAfterDispose: 0, unconsumedAfterIssuerRelease: "rejected", issuerAlive: false, liveGrants, liveContexts, liveCombinedSignals, prompts, pendingTimers: scheduler.highWaterMark.current,
  sampledBytes, allocationLimit: 16 * 1024 * 1024, coverage: "authorization/consumption only; no tool execution, UI approval or worker allocation" }));
 process.exit(0);
}
permission.state.setMode("read-only");
const input = { path: "permission-profile-never-written.txt", content: "x".repeat(1024 * 1024) + "中END" };
async function batch(count: number): Promise<void> {
 for (let index = 0; index < count; index++) {
  const result = await runner.emitToolCall({ type: "tool_call", toolName: "write", toolCallId: `fixture-${index}`, input } as never);
  result?.finalAuthorization?.release(); // Approval-only benchmark never invokes the write.
 }
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
