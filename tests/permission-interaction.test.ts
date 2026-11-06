import { createSessionAllowRule, sessionAllowRuleMatches, simpleCommandPrefix } from "../packages/extensions/resource-lifecycle-guard/permission-rule.ts";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, realpathSync, mkdirSync, symlinkSync, writeFileSync, promises as fsPromises } from "node:fs";
import { EventEmitter, getEventListeners } from "node:events";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { PassThrough } from "node:stream";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createEventBus } from "../packages/coding-agent/src/core/event-bus.ts";
import { SessionExecutionBoundary } from "../packages/coding-agent/src/core/execution-boundary.ts";
import { Session as InspectorSession } from "node:inspector/promises";
import { setImmediate as tick } from "node:timers/promises";
import { wrapRegisteredTool } from "../packages/coding-agent/src/core/extensions/wrapper.ts";
import { createExtensionRuntime, ExtensionRunner, loadExtensionFromFactory } from "../packages/coding-agent/src/core/extensions/index.ts";
import { SessionManager } from "../packages/coding-agent/src/core/session-manager.ts";
import { SessionPermissionController } from "../packages/extensions/resource-lifecycle-guard/permission-controller.ts";
import { consumeBrowserExecAuthorization } from "../packages/extensions/resource-lifecycle-guard/permission-contract.ts";
import { consumeStructuredReadonlyWorkspacePolicy } from "../packages/extensions/structured-readonly-command/delegation.ts";
import structuredReadonlyCommandExtension from "../packages/extensions/structured-readonly-command/index.ts";
import browserUseExtension from "../packages/extensions/browser-use/index.ts";
import { BrowserHarnessVersionGate } from "../packages/extensions/browser-use/core.ts";
import { consumeFixAuthorization, assertFixAuthorization } from "../packages/lsp/src/fix-authorization.ts";
import { consumeDelegatedTaskPolicies } from "../packages/extensions/subagent/delegation.ts";
import { ExtensionSelectorComponent } from "../packages/coding-agent/src/modes/interactive/components/extension-selector.ts";
import { initTheme } from "../packages/coding-agent/src/modes/interactive/theme/theme.ts";
import { FakeScheduler } from "./helpers/runtime-instrumentation.ts";

initTheme("dark");

test("native execution transition revokes all owners, waits for cleanup and invalidates old generations", { timeout: 2000 }, async () => {
 const boundary = new SessionExecutionBoundary();
 const oldGeneration = boundary.generation, oldSignal = boundary.signal;
 let release!: () => void, published = 0, modeReads = 0;
 let planning = false;
 assert.equal(boundary.getToolSelectionMode(), "default");
 const drained = new Promise<void>(resolve => { release = resolve; });
 const order: string[] = [];
 const remove = boundary.register("tasks", { toolSelectionMode() { modeReads++; return planning ? "plan" : undefined; },
  revoke() { order.push("tasks:revoke"); }, drain() { order.push("tasks:drain"); return drained; } });
 boundary.register("files", { revoke() { order.push("files:revoke"); }, async drain() { order.push("files:drain"); } });
 const pending = boundary.transition(() => { assert.throws(() => boundary.assertCurrent(), /BOUNDARY_CHANGED/); planning = true; published++; });
 assert.equal(oldSignal.aborted, true); assert.throws(() => boundary.assertCurrent(), /BOUNDARY_CHANGED/);
 await assert.rejects(boundary.transition(() => assert.fail("must not queue")), /still draining/);
 assert.throws(remove, /Cannot detach/); assert.equal(published, 0);
 assert.equal(boundary.getToolSelectionMode(), "default", "reading during drain does not publish or open admission");
 assert.throws(() => boundary.assertCurrent(), /BOUNDARY_CHANGED/);
 assert.deepEqual(order, ["tasks:revoke", "files:revoke", "tasks:drain", "files:drain"]);
 release(); await pending;
 boundary.assertCurrent(); assert.throws(() => boundary.assertCurrent(oldGeneration), /BOUNDARY_CHANGED/);
 assert.equal(boundary.signal.aborted, false); assert.equal(published, 1); assert.equal(boundary.hasDeadline, false);
 assert.equal(boundary.getToolSelectionMode(), "plan");
 assert.equal(modeReads, 2);
 remove(); await boundary.dispose(); assert.equal(boundary.participantCount, 0);
 assert.equal(boundary.getToolSelectionMode(), "default"); assert.equal(modeReads, 2);
 assert.throws(() => boundary.assertCurrent(), /BOUNDARY_CHANGED/);
});

test("native execution transition failures stay closed and disposal retains only unfinished owners", { timeout: 2000 }, async () => {
 for (const failure of ["revoke", "drain", "publish", "timeout", "dispose"]) {
  const boundary = new SessionExecutionBoundary(failure === "timeout" ? 10 : 1000);
  let release!: () => void, fail = true, published = false, drained = false;
  const held = new Promise<void>(resolve => { release = resolve; });
  boundary.register("owner", {
   revoke() { if (fail && failure === "revoke") throw new Error("controlled revoke"); },
   async drain() { if (fail && (failure === "timeout" || failure === "dispose")) await held; drained = true; if (fail && failure === "drain") throw new Error("controlled drain"); },
  });
  const pending = boundary.transition(() => { if (fail && failure === "publish") throw new Error("controlled publish"); published = true; });
  if (failure === "dispose") { const stopped = boundary.dispose(); release(); await stopped; await pending; assert.equal(published, false); }
  else {
   await assert.rejects(pending, failure === "timeout" ? /DRAIN_TIMEOUT/ : /controlled|revocation failed/);
   assert.throws(() => boundary.assertCurrent(), /BOUNDARY_CHANGED/); assert.equal(published, false); assert.equal(boundary.hasDeadline, false);
   if (failure === "timeout") { assert.equal(boundary.participantCount, 1); await assert.rejects(boundary.transition(() => {}), /still draining/); release(); await new Promise(resolve => setImmediate(resolve)); }
   assert.equal(drained, true); fail = false;
   await boundary.transition(() => { published = true; }); boundary.assertCurrent();
   await boundary.dispose();
  }
  assert.equal(boundary.participantCount, 0); assert.equal(boundary.hasDeadline, false); assert.equal(boundary.isDraining, false);
 }
 const bounded = new SessionExecutionBoundary();
 for (let index = 0; index < 16; index++) bounded.register(String(index), { revoke() {}, async drain() {} });
 assert.throws(() => bounded.register("extra", { revoke() {}, async drain() {} }), /capacity/);
 await bounded.dispose();
 const failedClose = new SessionExecutionBoundary(); let failClose = true;
 failedClose.register("retained", { revoke() {}, async drain() { if (failClose) throw new Error("owned cleanup failed"); } });
 await assert.rejects(failedClose.dispose(), /owned cleanup failed/);
 assert.equal(failedClose.participantCount, 1); assert.throws(() => failedClose.assertCurrent(), /BOUNDARY_CHANGED/);
 failClose = false; await failedClose.dispose(); assert.equal(failedClose.participantCount, 0);
 for (const delayed of [false, true]) {
  const failedRevoke = new SessionExecutionBoundary(delayed ? 10 : 1000);
  let fail = true, release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  failedRevoke.register("retained", { revoke() { if (fail) throw undefined; }, async drain() { if (delayed && fail) await held; } });
  if (delayed) {
   await assert.rejects(failedRevoke.transition(() => {}), /DRAIN_TIMEOUT/);
   const closing = failedRevoke.dispose(); release();
   await assert.rejects(closing, /revocation failed/);
  } else await assert.rejects(failedRevoke.dispose(), /revocation failed/);
  assert.equal(failedRevoke.participantCount, 1);
  fail = false; await failedRevoke.dispose(); assert.equal(failedRevoke.participantCount, 0);
 }
});

test("permission pause closes admission through cleanup and mode changes until explicit user resume", async () => {
 const boundary = new SessionExecutionBoundary();
 let release!: () => void, revoked = 0, drained = 0;
 const gate = new Promise<void>(resolve => { release = resolve; });
 boundary.register("owned", { revoke() { revoked++; }, async drain() { await gate; drained++; } });
 const generation = boundary.beginPreparation(), signal = boundary.signal;
 boundary.pauseForUser(); boundary.pauseForUser();
 assert.equal(signal.aborted, true); assert.equal(boundary.requiresUserInput, true);
 assert.throws(() => boundary.beginPreparation(), /REQUIRES_USER_INPUT/);
 let resumed = false;
 let firstResumedSignal: AbortSignal | undefined;
 const resume = boundary.resumeForUser().then(() => { resumed = true; firstResumedSignal = boundary.signal; });
 const concurrentResume = boundary.resumeForUser();
 await tick(); assert.equal(revoked, 1); assert.equal(resumed, false);
 release(); await tick(); assert.equal(drained, 1); assert.equal(resumed, false, "containing prompt still owns preparation");
 boundary.endPreparation(); await resume; await concurrentResume;
 assert.equal(boundary.signal, firstResumedSignal, "concurrent inputs cannot replace the resumed cancellation owner");
 assert.equal(boundary.requiresUserInput, false); assert.equal(boundary.hasDeadline, false);
 assert.equal(boundary.preparationCount, 0); boundary.assertCurrent();
 assert.throws(() => boundary.assertCurrent(generation), /BOUNDARY_CHANGED/);
 boundary.pauseForUser(); await tick();
 let published = false;
 await boundary.transition(() => { published = true; });
 assert.equal(published, true); assert.equal(boundary.requiresUserInput, true);
 assert.throws(() => boundary.assertCurrent(), /REQUIRES_USER_INPUT/);
 await boundary.resumeForUser(); boundary.assertCurrent();
 await boundary.dispose(); assert.equal(boundary.participantCount, 0); assert.equal(boundary.requiresUserInput, false);
});

test("failed permission pause cleanup cannot reopen admission", async () => {
 const boundary = new SessionExecutionBoundary(10);
 let release!: () => void;
 const gate = new Promise<void>(resolve => { release = resolve; });
 boundary.register("owned", { revoke() {}, drain() { return gate; } });
 boundary.pauseForUser();
 await assert.rejects(boundary.resumeForUser(), /DRAIN_TIMEOUT/);
 assert.equal(boundary.requiresUserInput, true); assert.equal(boundary.hasDeadline, false);
 await assert.rejects(boundary.resumeForUser(), /DRAIN_TIMEOUT/);
 assert.throws(() => boundary.assertCurrent(), /REQUIRES_USER_INPUT/);
 await assert.rejects(boundary.dispose(), /DRAIN_TIMEOUT/);
 release(); await tick();
 assert.equal(boundary.participantCount, 0); assert.equal(boundary.requiresUserInput, false);
 assert.equal((boundary as any).heldCleanup, undefined, "late cleanup after disposal releases the held pause");
 await assert.rejects(boundary.resumeForUser(), /BOUNDARY_CHANGED/);
 await boundary.dispose(); assert.equal(boundary.participantCount, 0); assert.equal(boundary.requiresUserInput, false);
});

test("permission pause admission and cleanup have bounded allocations and release retained owners", async t => {
 const profiler = new InspectorSession(); profiler.connect();
 const refs: WeakRef<object>[] = [];
 let checks = 0, revokes = 0, drains = 0;
 async function exercise() {
  const boundary = new SessionExecutionBoundary();
  const owner = { revoke() { revokes++; }, async drain() { drains++; } };
  boundary.register("owned", owner);
  for (let index = 0; index < 100000; index++) {
   boundary.assertCurrent(); if (boundary.requiresUserInput) throw new Error("Unexpected paused admission"); checks++;
  }
  for (let index = 0; index < 32; index++) {
   refs.push(new WeakRef(boundary.signal));
   boundary.pauseForUser();
   refs.push(new WeakRef((boundary as any).heldCleanup));
   await boundary.resumeForUser();
   assert.equal((boundary as any).heldCleanup, undefined);
   assert.equal(boundary.hasDeadline, false); assert.equal(boundary.isDraining, false);
  }
  boundary.pauseForUser(); await boundary.dispose();
  assert.equal(boundary.participantCount, 0); assert.equal(boundary.preparationCount, 0);
  assert.equal((boundary as any).heldCleanup, undefined);
  refs.push(new WeakRef(owner), new WeakRef(boundary));
 }
 try {
  await profiler.post("HeapProfiler.startSampling", { samplingInterval: 4096, includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true });
  await exercise();
  const { profile } = await profiler.post("HeapProfiler.stopSampling");
  let sampledBytes = 0; const sites: { name: string; bytes: number }[] = [], pending = [profile.head];
  while (pending.length) { const node = pending.pop()!; sampledBytes += node.selfSize; if (node.selfSize) sites.push({ name: node.callFrame.functionName, bytes: node.selfSize }); for (const child of node.children) pending.push(child); }
  for (let index = 0; index < 3; index++) { await tick(); await profiler.post("HeapProfiler.collectGarbage"); }
  assert.equal(refs.filter(ref => ref.deref()).length, 0);
  assert.equal(revokes, 33); assert.equal(drains, 33);
  t.diagnostic(JSON.stringify({ checks, pauseCycles: 33, revokes, drains, releasedReferences: refs.length, sampledBytes,
   leading: sites.sort((a, b) => b.bytes - a.bytes).slice(0, 6) }));
 } finally { profiler.disconnect(); }
});

async function permissionFixture(t: test.TestContext, aliasedRoot = false) {
 const root = mkdtempSync(join(tmpdir(), "pi-permission-wait-")); let cwd = root;
 if (aliasedRoot) { const physical = join(root, "physical"); mkdirSync(physical); cwd = join(root, "alias"); symlinkSync(physical, cwd, process.platform === "win32" ? "junction" : "dir"); }
	t.after(() => rmSync(root, { recursive: true }));
 const runtime = createExtensionRuntime();
 const audits: any[] = [];
 let permission!: SessionPermissionController;
 const extension = await loadExtensionFromFactory((pi) => {
  // Persistence is deliberately observed, not sent to the installed session.
  pi.appendEntry = (_kind: string, data: any) => { if (data?.policyReason) audits.push(data); };
  permission = new SessionPermissionController(pi);
  permission.registerCommands();
  pi.on("tool_call", (event, ctx) => permission.authorizeToolCall(event, ctx));
 }, cwd, createEventBus(), runtime);
 const scheduler = new FakeScheduler();
 const runner = new ExtensionRunner([extension], runtime, cwd, SessionManager.inMemory(cwd), {} as never,
  { scheduler, hookTimeouts: { safety: { timeoutMs: 30_000 } } });
 const abort = new AbortController();
 runner.bindCore({} as never, { getSignal: () => abort.signal } as never);
 let choose!: (value: string | undefined) => void;
 let shown!: () => void;
 const visible = new Promise<void>((resolve) => { shown = resolve; });
 let choices: string[] = [];
 let dialogOptions: any;
 runner.setUIContext({ ...runner.getUIContext(),
  select: async (_title, options, opts) => {
   choices = options; dialogOptions = opts; shown();
   return new Promise<string | undefined>((resolve) => { choose = resolve; });
  },
	}, "tui");
 await permission.restore(runner.createContext());
 // This fixture exercises permission results; consume the runner's epoch guard
 // just as the dispatcher does before the delegated-tool assertions below.
 const call = async (toolName = "browser_exec", input: object = { code: "print('controlled fixture')", purpose: "permission regression" }) => {
  const result = await runner.emitToolCall({ type: "tool_call", toolName, toolCallId: "approval-1", input } as never);
  if (result?.finalAuthorization) {
   try { assert.equal(result.finalAuthorization.consume(input, "approval-1", toolName), input); }
   finally { result.finalAuthorization.release(); }
   assert.equal(result.block, undefined); assert.equal(result.reason, undefined); assert.equal(result.terminate, undefined);
   return undefined;
  }
  return result;
 };
 return { runner, scheduler, permission, visible, call, abort, cwd, root, audits, runtime, choose: (index: number) => choose(choices[index]),
  dialogOptions: () => dialogOptions, choices: () => choices };
}

test("real permission selection outlasts the 30-second machine budget", async (t) => {
	const f = await permissionFixture(t);
 const result = f.call();
 const outcome = result.then((value) => ({ value }), (error) => ({ error }));
 await f.visible;
 f.scheduler.advanceBy(60_000);
 await Promise.resolve();
 f.choose(0);
 assert.deepEqual(await outcome, { value: undefined });
 assert.equal(f.runner.hookDeliveryStats.timeouts, 0);
 assert.equal(f.scheduler.highWaterMark.current, 0);
});

test("invalidating a pending approval revokes its signal and late selection", async (t) => {
	const f = await permissionFixture(t);
 const result = f.call();
 const outcome = result.then(() => "allowed", () => "rejected");
 await f.visible;
 const signal = f.dialogOptions()?.signal;
 f.runner.invalidate();
 f.choose(0);
 assert.equal(await outcome, "rejected");
 assert.equal(signal?.aborted, true);
 assert.equal(f.permission.state.allowRules.length, 0);
 assert.equal(f.scheduler.highWaterMark.current, 0);
});

test("native transitions revoke permission grants and wait for pending confirmation without changing policy", { timeout: 2000 }, async t => {
 const f = await permissionFixture(t);
 const pending = f.call(); const rejected = assert.rejects(pending, /obsolete|EXECUTION_BOUNDARY_CHANGED/);
 await f.visible;
 const before = f.permission.state.serialized(); let published = false;
 const transition = f.runtime.executionBoundary.transition(() => { published = true; });
 await new Promise<void>(resolve => setImmediate(resolve));
 assert.equal(f.dialogOptions().signal.aborted, true);
 assert.equal(published, false, "even a UI ignoring cancellation must settle before publication");
 f.choose(0); await Promise.all([transition, rejected]);
 assert.equal(published, true); assert.deepEqual(f.permission.state.serialized(), before);
 assert.equal(f.permission.state.allowRules.length, 0);
 f.permission.state.setMode("full-access"); f.permission.state.setApprovalPolicy("never-ask");
 const input = { code: "print('not executed')" }; await f.call("browser_exec", input);
 const grant = consumeBrowserExecAuthorization(input, "approval-1"); grant.assertCurrent();
 await f.runtime.executionBoundary.transition(() => undefined);
 assert.equal(grant.revocationSignal.aborted, true); assert.throws(grant.assertCurrent, /authority changed/);
 const fresh = { code: "print('still not executed')" }; await f.call("browser_exec", fresh);
 consumeBrowserExecAuthorization(fresh, "approval-1").assertCurrent();
 f.runner.invalidate(); await f.runtime.executionBoundary.dispose();
 assert.equal(f.runtime.executionBoundary.participantCount, 0); assert.equal(f.scheduler.highWaterMark.current, 0);
});

test("execution transitions wait for actual timed and untimed hooks, dialogs and late grant release", { timeout: 5000 }, async t => {
 const profiler = new InspectorSession(); profiler.connect(); t.after(() => profiler.disconnect());
 const refs: WeakRef<object>[] = [], signals: AbortSignal[] = [];
 const cleanups: Promise<unknown>[] = [], releases: (() => void)[] = [];
 t.after(async () => { for (const release of releases) release(); await Promise.allSettled(cleanups); });
 let released = 0, dialogs = 0;
 async function exercise(kind: "untimed" | "dialog" | "timeout" | "release-failed") {
  const runtime = createExtensionRuntime(), scheduler = new FakeScheduler();
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  releases.push(release);
  const ready = new Promise<void>(resolve => { entered = resolve; });
  const grant = { consume() { assert.fail("late grant must not execute"); }, release() { released++; if (kind === "release-failed") throw undefined; } };
  const extension = await loadExtensionFromFactory(pi => {
   pi.on("tool_call", async (_event, ctx) => {
    refs.push(new WeakRef(ctx)); signals.push(ctx.signal!);
    if (kind === "dialog") { try { await ctx.ui.select("fixture", ["ok"]); } catch {} }
    else { entered(); await gate; }
    return { finalAuthorization: grant };
   });
  }, process.cwd(), createEventBus(), runtime);
  const runner = new ExtensionRunner([extension], runtime, process.cwd(), SessionManager.inMemory(), {} as never,
   { scheduler, hookTimeouts: { safety: { timeoutMs: kind === "untimed" ? 0 : 100 } } });
  runner.setUIContext({ ...runner.getUIContext(), async select() { dialogs++; entered(); await gate; return "ok"; } });
  const call = runner.emitToolCall({ type: "tool_call", toolName: "opaque", toolCallId: kind, input: {} });
  const rejectedCall = assert.rejects(call, /obsolete|timed out/);
  await ready;
  const deadline = [...(runner as any).toolCallDeadlines][0]; refs.push(new WeakRef(deadline));
  if (kind === "timeout" || kind === "release-failed") { scheduler.advanceBy(100); await rejectedCall; }
  else if (kind === "dialog") { scheduler.advanceBy(1000); assert.equal(scheduler.highWaterMark.current, 0); }
  let published = false;
  const transition = runtime.executionBoundary.transition(() => { published = true; });
  cleanups.push(transition); void transition.catch(() => {});
  const failed = kind === "release-failed" ? assert.rejects(transition, /cleanup is unconfirmed/) : undefined;
  await rejectedCall; await tick();
  assert.equal(published, false); assert.equal((runner as any).toolCallDeadlines.size, 1);
  assert.equal(signals.at(-1)!.aborted, true);
  if (kind === "dialog") assert.ok((runner as any).toolCallDialogOwner, "physical dialog keeps its owner after cancellation");
  release();
  if (failed) {
   await failed; assert.equal(published, false); assert.equal((runner as any).toolCallDeadlines.size, 1);
   await assert.rejects(runtime.executionBoundary.dispose(), /cleanup is unconfirmed/);
  } else {
   await transition; assert.equal(published, true); assert.equal((runner as any).toolCallDeadlines?.size ?? 0, 0);
   await runtime.executionBoundary.dispose(); assert.equal(runtime.executionBoundary.participantCount, 0);
  }
  assert.equal(scheduler.highWaterMark.current, 0);
  refs.push(new WeakRef(runtime), new WeakRef(runner), new WeakRef(grant));
  releases.pop(); cleanups.pop();
 }
 await profiler.post("HeapProfiler.startSampling", { samplingInterval: 4096, includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true });
 for (const kind of ["untimed", "dialog", "timeout", "release-failed"] as const) await exercise(kind);
 const { profile } = await profiler.post("HeapProfiler.stopSampling");
 let sampled = 0; const nodes = [profile.head]; while (nodes.length) { const node = nodes.pop()!; sampled += node.selfSize; for (const child of node.children) nodes.push(child); }
 for (let i = 0; i < 3; i++) { await tick(); await profiler.post("HeapProfiler.collectGarbage"); }
 assert.equal(refs.filter(ref => ref.deref()).length, 0); assert.equal(released, 4); assert.equal(dialogs, 1);
 assert.ok(sampled < 4 * 1024 * 1024);
 t.diagnostic(JSON.stringify({ actualHooks: 4, actualDialogs: dialogs, lateGrantReleases: released, retainedCancelledSignals: signals.length, releasedReferences: refs.length, sampledBytes: sampled }));
});

test("shared admission stays closed after a fast service drains and revokes ordinary prepared tools", { timeout: 5000 }, async t => {
 const profiler = new InspectorSession(); profiler.connect(); t.after(() => profiler.disconnect());
 const refs: WeakRef<object>[] = []; let checks = 0, guards = 0, localReady = false;
 let rejectedDeliveries = 0, acceptedReleases = 0, retryReleases = 0;
 async function exercise() {
  const runtime = createExtensionRuntime();
  let assertAdmission!: () => void, release!: () => void, installFailedGrants!: () => void, installSlotGrants!: () => void, fail = true;
  let releaseFails = true, failedReleases = 0, otherReleases = 0;
  const failingGrant = { consume() {}, release() { failedReleases++; if (releaseFails) throw undefined; } };
  const otherGrant = { consume() {}, release() { otherReleases++; } };
  let hookCalls = 0, slotReleases = 0;
  const slotGrants = [0, 1].map(() => ({ consume() {}, release() { slotReleases++; } }));
  const slow = new Promise<void>(resolve => { release = resolve; });
  const extension = await loadExtensionFromFactory(pi => {
   assertAdmission = pi.assertExecutionCurrent!;
   installSlotGrants = () => {
    for (const grant of slotGrants) pi.on("tool_call", event => {
     hookCalls++; if (event.toolCallId === "last-slot") return { finalAuthorization: grant };
    });
   };
   installFailedGrants = () => {
    pi.on("tool_call", () => ({ finalAuthorization: failingGrant }));
    pi.on("tool_call", () => ({ finalAuthorization: otherGrant }));
   };
   pi.registerExecutionOwner!("fast", { revoke() { localReady = false; }, async drain() { localReady = true; } });
   pi.registerExecutionOwner!("slow", { revoke() {}, async drain() { await slow; if (fail) throw new Error("held cleanup"); } });
  }, process.cwd(), createEventBus(), runtime);
  installSlotGrants();
  const runner = new ExtensionRunner([extension], runtime, process.cwd(), SessionManager.inMemory(), {} as never);
  const active: string[] = []; runtime.getActiveTools = () => active;
  let executions = 0;
  const wrapped = wrapRegisteredTool({ definition: { name: "opaque_tool", parameters: {}, async execute() { executions++; return { content: [] }; } } } as never, runner);
  const event = { type: "tool_call", toolName: "opaque_tool", toolCallId: "ordinary", input: {} } as const;
  const first = (await runner.emitToolCall(event))!.finalAuthorization!;
  for (let i = 0; i < 10_000; i++) { assertAdmission(); checks++; }
  let published = 0;
  const change = runtime.executionBoundary.transition(() => { published++; });
  const rejected = assert.rejects(change, /held cleanup/);
  await tick(); assert.equal(localReady, true); assert.equal(published, 0);
  assert.throws(assertAdmission, /BOUNDARY_CHANGED/);
  assert.throws(() => first.consume(event.input, event.toolCallId, event.toolName), /obsolete/);
  await assert.rejects(runner.emitToolCall(event), /BOUNDARY_CHANGED/);
  await assert.rejects(wrapped.execute("late", {}), /BOUNDARY_CHANGED/); assert.equal(executions, 0);
  release(); await rejected; assert.throws(assertAdmission, /BOUNDARY_CHANGED/);
  fail = false; await runtime.executionBoundary.transition(() => { published++; }); assert.equal(published, 1);
  const held: typeof first[] = [];
  for (let i = 0; i < 128; i++) {
   const guard = (await runner.emitToolCall(i === 127 ? { ...event, toolCallId: "last-slot" } : event))!.finalAuthorization!;
   held.push(guard); refs.push(new WeakRef(guard)); guards++;
  }
  const admittedHooks = hookCalls;
  await assert.rejects(runner.emitToolCall(event), /Too many pending/);
  assert.equal(hookCalls, admittedHooks, "capacity is reserved before producing another grant");
  assert.equal(held[0]!.consume(event.input, event.toolCallId, event.toolName), event.input);
  assert.throws(() => held[0]!.consume(event.input, event.toolCallId, event.toolName), /obsolete/);
  await runtime.executionBoundary.transition(() => undefined);
  assert.equal(slotReleases, 2, "the last reserved invocation accepts both of its grants");
  for (const guard of held) assert.throws(() => guard.consume(event.input, event.toolCallId, event.toolName), /obsolete/);
  held.length = 0;
  const fresh = (await runner.emitToolCall(event))!.finalAuthorization!;
  assert.equal(fresh.consume(event.input, event.toolCallId, event.toolName), event.input);
  await wrapped.execute("current", {}); assert.equal(executions, 1);
  assert.equal((first as any).owners, undefined, "a consumed guard cannot keep the live registry alive");
  installFailedGrants();
  const cleanupGuard = (await runner.emitToolCall(event))!.finalAuthorization!;
  await assert.rejects(runtime.executionBoundary.transition(() => assert.fail("cleanup failure cannot publish")), /cleanup (?:is|remains) unconfirmed/);
  assert.equal(failedReleases, 1); assert.equal(otherReleases, 1);
  assert.equal((runner as any).finalAuthorizations.size, 1); assert.throws(assertAdmission, /BOUNDARY_CHANGED/);
  releaseFails = false; await runtime.executionBoundary.transition(() => undefined);
  assert.equal(failedReleases, 2); assert.equal(otherReleases, 1); assert.equal((runner as any).finalAuthorizations, undefined);
  assert.equal((cleanupGuard as any).owners, undefined);
  refs.push(new WeakRef(cleanupGuard), new WeakRef(failingGrant), new WeakRef(otherGrant));
  for (const grant of slotGrants) refs.push(new WeakRef(grant));
  refs.push(new WeakRef(runner), new WeakRef(runtime), new WeakRef(first), new WeakRef(fresh));
  runner.invalidate(); await runtime.executionBoundary.dispose(); assert.equal(runtime.executionBoundary.participantCount, 0);
 }
 async function rejectedDelivery(kind: "capacity" | "conflict" | "late-native") {
  const runtime = createExtensionRuntime(); let failRelease = true, attempts = 0, goodReleases = 0;
  const incoming = { finalAuthority: kind === "conflict" ? true as const : undefined, consume() { assert.fail("rejected grant cannot execute"); },
   release() { attempts++; if (failRelease) throw undefined; } };
  const accepted = Array.from({ length: kind === "capacity" ? 32 : kind === "conflict" ? 1 : 0 }, () => ({
   finalAuthority: kind === "conflict" ? true as const : undefined, consume() { assert.fail("rejected invocation cannot execute"); }, release() { goodReleases++; }
  }));
  const extension = await loadExtensionFromFactory(pi => {
   if (kind === "late-native") return;
   for (const grant of accepted) pi.on("tool_call", () => ({ finalAuthorization: grant }));
   pi.on("tool_call", () => ({ finalAuthorization: incoming }));
   pi.on("tool_call", () => assert.fail("no producer may run after a rejected delivery"));
  }, process.cwd(), createEventBus(), runtime);
  const runner = new ExtensionRunner([extension], runtime, process.cwd(), SessionManager.inMemory(), {} as never);
  let deliver!: () => void;
  if (kind === "late-native") {
   const pending = new Promise<void>(resolve => { deliver = resolve; });
   runtime.nativeFiles = { ownsDefinition() { return true; }, async prepareInvocation() { await pending; return incoming; } } as never;
  }
  try {
   const call = runner.emitToolCall({ type: "tool_call", toolName: "opaque", toolCallId: kind, input: {} });
   const rejectedCall = assert.rejects(call, /cleanup is unconfirmed/);
   if (kind === "late-native") {
    const transition = runtime.executionBoundary.transition(() => assert.fail("late cleanup cannot publish"));
    const rejectedTransition = assert.rejects(transition, /cleanup is unconfirmed/);
    await tick(); assert.equal((runner as any).finalAuthorizations.size, 1);
    assert.equal((runner as any).actualHooks, 1, "native delivery keeps the shared idle wait alive");
    deliver(); await rejectedCall; await rejectedTransition;
   } else {
    await rejectedCall;
    await assert.rejects(runtime.executionBoundary.transition(() => assert.fail("rejected cleanup cannot publish")), /cleanup (?:is|remains) unconfirmed/);
   }
   rejectedDeliveries++;
   const guard = [...(runner as any).finalAuthorizations][0];
   assert.equal(guard.incoming, incoming, "retain the exact failed release rather than a cleanup flag");
   assert.equal((runner as any).finalAuthorizations.size, 1);
   assert.equal((runner as any).actualHooks, 0); assert.equal((runner as any).hooksIdle, undefined);
   assert.equal(goodReleases, accepted.length); acceptedReleases += goodReleases;
   assert.throws(() => runtime.executionBoundary.assertCurrent(), /BOUNDARY_CHANGED/);
   const priorAttempts = attempts; failRelease = false;
   await runtime.executionBoundary.transition(() => undefined);
   assert.equal(attempts, priorAttempts + 1); retryReleases++;
   assert.equal(goodReleases, accepted.length, "successful releases are not repeated on retry");
   assert.equal(guard.incoming, undefined); assert.equal(guard.owners, undefined);
   assert.equal((runner as any).finalAuthorizations, undefined);
   refs.push(new WeakRef(guard), new WeakRef(incoming), new WeakRef(runtime), new WeakRef(runner));
   for (const grant of accepted) refs.push(new WeakRef(grant));
  } finally {
   deliver?.(); failRelease = false; runtime.nativeFiles = undefined;
   await runtime.executionBoundary.dispose();
  }
 }
 await profiler.post("HeapProfiler.startSampling", { samplingInterval: 4096, includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true });
 await exercise();
 for (const kind of ["capacity", "conflict", "late-native"] as const) await rejectedDelivery(kind);
 const { profile } = await profiler.post("HeapProfiler.stopSampling");
 let sampled = 0; const nodes = [profile.head]; while (nodes.length) { const node = nodes.pop()!; sampled += node.selfSize; for (const child of node.children) nodes.push(child); }
 for (let i = 0; i < 3; i++) { await tick(); await profiler.post("HeapProfiler.collectGarbage"); }
 const leading: { name: string; url: string; bytes: number }[] = [];
 const pending = [profile.head]; while (pending.length) { const node = pending.pop()!; if (node.selfSize) leading.push({ name: node.callFrame.functionName, url: node.callFrame.url, bytes: node.selfSize }); for (const child of node.children) pending.push(child); }
 t.diagnostic(JSON.stringify({ leading: leading.sort((a, b) => b.bytes - a.bytes).slice(0, 12) }));
 // Capacity now exercises 128 genuine async hook invocations (two hooks each),
 // rather than ordinary epoch guards. Keep the original lifecycle allowance and
 // a bounded 64 KiB per privileged preparation; hot admission is gated separately.
 assert.equal(refs.filter(ref => ref.deref()).length, 0); assert.ok(sampled < 4 * 1024 * 1024 + guards * 64 * 1024, `sampled ${sampled} bytes`);
 t.diagnostic(JSON.stringify({ sharedAdmissionChecks: checks, peakPreparedTools: guards, rejectedDeliveries, acceptedReleases, retryReleases, releasedReferences: refs.length, sampledBytes: sampled }));
});

test("failed extension initialization removes only its registered execution owner", async () => {
 const runtime = createExtensionRuntime(), events = createEventBus();
 const nativeOwners = runtime.executionBoundary.participantCount;
 await loadExtensionFromFactory(pi => {
  pi.registerExecutionOwner!("existing", { revoke() {}, async drain() {} });
  pi.registerCompactionStrategy!({ id: "existing", prepare: () => undefined });
 }, process.cwd(), events, runtime, "existing");
 await assert.rejects(loadExtensionFromFactory(pi => {
  pi.registerExecutionOwner!("temporary", { toolSelectionMode: () => "plan", revoke() {}, async drain() {} });
  assert.throws(() => pi.registerCompactionStrategy!({ id: "existing", prepare: () => undefined }), /Duplicate/);
  pi.registerCompactionStrategy!({ id: "temporary", prepare: () => undefined });
  assert.equal(runtime.executionBoundary.getToolSelectionMode(), "plan");
  assert.throws(() => pi.registerExecutionOwner!("temporary", { revoke() {}, async drain() {} }), /duplicate/);
  throw new Error("factory failed");
 }, process.cwd(), events, runtime, "failing"), /factory failed/);
 assert.equal(runtime.executionBoundary.participantCount, nativeOwners + 1);
 assert.deepEqual([...runtime.compactionStrategies.keys()], ["existing"]);
 assert.equal(runtime.executionBoundary.getToolSelectionMode(), "default", "failed factory cannot leave a selection declaration");
 const removeInvalid = runtime.executionBoundary.register("invalid-mode", { toolSelectionMode: (() => "unknown") as never, revoke() {}, async drain() {} });
 assert.throws(() => runtime.executionBoundary.getToolSelectionMode(), /Invalid tool selection mode/);
 removeInvalid(); runtime.executionBoundary.assertCurrent();
 await runtime.executionBoundary.transition(() => undefined);
 runtime.invalidate(); await runtime.executionBoundary.dispose();
 assert.equal(runtime.executionBoundary.participantCount, 0);
 assert.equal(runtime.compactionStrategies.size, 0);
});

test("permission details never push controls beyond the terminal viewport", () => {
 const terminal = { rows: 16, columns: 48 };
 const selector = new ExtensionSelectorComponent("Permission: bash", ["Approve once", "Deny"], () => {}, () => {},
  { tui: { terminal } as never, details: ("脚本 ".repeat(1000) + "\n").repeat(10) } as never);
 assert.ok(selector.render(48).length <= terminal.rows);
 terminal.rows = 9;
 const resized = selector.render(24);
 assert.ok(resized.length <= terminal.rows);
 assert.ok(resized.some((line) => line.includes("Approve")));
 selector.dispose();
});


test("concurrent permission requests cannot replace the active selection", async (t) => {
	const f = await permissionFixture(t);
	const first = f.call();
	await f.visible;
	await assert.rejects(f.call(), /Another permission request/);
	f.choose(0);
	assert.equal(await first, undefined);
	assert.equal(f.scheduler.highWaterMark.current, 0);
});

test("real interactive selection isolates cancellation, late clicks and disposal", { timeout: 2000 }, async () => {
	const { InteractiveMode } = await import("../packages/coding-agent/src/modes/interactive/interactive-mode.ts");
	const { Container } = await import("@super-pi/tui");
	const mode: any = Object.create(InteractiveMode.prototype);
	mode.ui = { terminal: { rows: 12, columns: 60 }, setFocus() {}, requestRender() {}, showOverlay() { return { hide() {} }; } };
	mode.editor = new Container(); mode.editorContainer = new Container();
	mode.disposeActiveSelector = () => {};
	const abort = new AbortController();
	const first = mode.showExtensionSelector("first", ["Approve", "Deny"], { signal: abort.signal, details: "FULL-FIRST" });
	const old = mode.extensionSelector;
 await assert.rejects(mode.showExtensionCustom(() => new Container()), /Another dialog/);
 assert.equal(await mode.showExtensionEditor("other"), undefined);
	assert.equal(await mode.showExtensionSelector("second", ["Approve"]), undefined);
	abort.abort();
	assert.equal(await first, undefined);
	const second = mode.showExtensionSelector("second", ["Approve"], { details: "FULL-SECOND" });
	const current = mode.extensionSelector;
	old.handleInput("\n");
	assert.equal(mode.extensionSelector, current);
	current.render(60);
	current.handleInput("\x1b[A");
	current.handleInput("\r");
	assert.equal(await second, "Approve");
	const third = mode.showExtensionSelector("third", ["Approve"], { details: "FULL-THIRD" });
	mode.hideExtensionSelector();
	assert.equal(await third, undefined);
	assert.equal(mode.extensionSelector, undefined);
	assert.equal(mode.extensionSelectorCancel, undefined);
});

test("details cache survives navigation, escapes controls, and releases on close", () => {
	const terminal = { rows: 10, columns: 40 };
	let selected = 0; let cancelled = 0;
	const selector: any = new ExtensionSelectorComponent("permission", ["Approve", "Deny"], () => selected++, () => cancelled++,
		{ tui: { terminal } as never, details: "\x1b[2J" + "中".repeat(2000) + "\nFINAL-DETAIL" });
	selector.render(40);
	const cache = selector.detailLines;
	for (let index = 0; index < 40; index++) { selector.handleInput("j"); selector.render(40); }
	assert.equal(selector.detailLines, cache);
	assert.ok(cache[0].includes("\\u001b"));
	for (let index = 0; index < 100; index++) selector.handleInput("\x1b[6~");
	assert.ok(selector.render(40).some((line: string) => line.includes("FINAL-DETAIL")));
	selector.render(12); selector.handleInput("\n");
	assert.equal(selected, 0, "a clipped viewport cannot approve invisibly");
	terminal.rows = 3;
	selector.render(40); selector.handleInput("\n");
	assert.equal(selected, 0);
	selector.handleInput("\x1b");
	assert.equal(cancelled, 1);
	selector.dispose();
	assert.equal(selector.detailLines.length, 0);
	assert.equal(selector.details, undefined);
	assert.equal(selector.terminal, undefined);
});

test("two stalled tool calls produce two results, zero effects, and correlated compact diagnostics", async () => {
	const { Agent } = await import("../packages/agent/src/agent.ts");
	const { Type } = await import("typebox");
	const { InteractiveMode } = await import("../packages/coding-agent/src/modes/interactive/interactive-mode.ts");
	const { Container } = await import("@super-pi/tui");
	const { createAssistantMessageEventStream } = await import("../packages/ai/src/utils/event-stream.ts");
	const runtime = createExtensionRuntime();
	const scheduler = new FakeScheduler();
	let entered!: () => void;
	const extension = await loadExtensionFromFactory((pi) => pi.on("tool_call", async () => {
		entered(); await new Promise(() => {});
	}), process.cwd(), createEventBus(), runtime);
	const runner = new ExtensionRunner([extension], runtime, process.cwd(), SessionManager.inMemory(), {} as never,
		{ scheduler, hookTimeouts: { safety: { timeoutMs: 30_000 } } });
	const mode: any = Object.create(InteractiveMode.prototype);
	mode.chatContainer = new Container(); mode.ui = { requestRender() {} };
	const diagnostics: string[] = [];
	runner.onError(error => {
		diagnostics.push(error.toolCallId!);
		mode.showExtensionError(error.extensionPath, error.error, error.stack, error.toolCallId);
	});
	let effects = 0, providerResponses = 0, starts = 0, ends = 0, results = 0;
	const agent = new Agent({ streamFn: () => {
		const stream = createAssistantMessageEventStream();
		const withTools = providerResponses++ === 0;
		const message: any = { role: "assistant", api: "fixture", provider: "fixture", model: "fixture", timestamp: 0,
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
			stopReason: withTools ? "toolUse" : "stop",
			content: withTools ? ["call-a", "call-b"].map(id => ({ type: "toolCall", id, name: "controlled", arguments: {} })) : [] };
		stream.push({ type: "start", partial: message });
		stream.push({ type: "done", reason: message.stopReason, message });
		return stream;
	} });
	agent.state.tools = [{ name: "controlled", label: "controlled", description: "fixture", parameters: Type.Object({}),
		execute: async () => { effects++; return { content: [], details: undefined }; } }];
	agent.beforeToolCall = ({ toolCall, args }) => runner.emitToolCall({ type: "tool_call", toolName: toolCall.name,
		toolCallId: toolCall.id, input: args } as never);
	agent.subscribe(event => {
		if (event.type === "tool_execution_start") starts++;
		if (event.type === "tool_execution_end") ends++;
		if (event.type === "message_end" && event.message.role === "toolResult") results++;
	});
	let first!: () => void;
	const firstHook = new Promise<void>(resolve => { first = resolve; });
	let second!: () => void;
	const secondHook = new Promise<void>(resolve => { second = resolve; });
	let calls = 0; entered = () => { if (++calls === 1) first(); else second(); };
	const run = agent.prompt("offline fixture");
	await firstHook; scheduler.advanceBy(30_000);
	await secondHook; scheduler.advanceBy(30_000);
	await run;
	assert.deepEqual({ effects, starts, ends, results }, { effects: 0, starts: 2, ends: 2, results: 2 });
	assert.deepEqual(diagnostics, ["call-a", "call-b"]);
	assert.equal(mode.chatContainer.children.length, 2);
	const collapsed = mode.chatContainer.render(100).join("\n");
	assert.match(collapsed, /call-a/); assert.match(collapsed, /call-b/);
	assert.doesNotMatch(collapsed, /timed out after/);
	mode.chatContainer.children[0].setExpanded(true);
	assert.match(mode.chatContainer.render(100).join("\n"), /timed out after 30000ms/);
	assert.equal(scheduler.highWaterMark.current, 0);
});

test("machine work after a human selection still consumes the remaining deadline", async () => {
	const runtime = createExtensionRuntime(); const scheduler = new FakeScheduler();
	let selected!: () => void; let shown!: () => void;
	const visible = new Promise<void>(resolve => { shown = resolve; });
	const extension = await loadExtensionFromFactory(pi => pi.on("tool_call", async (_event, ctx) => {
		await ctx.ui.select("Approve", ["yes"]);
		await new Promise(() => {});
	}), process.cwd(), createEventBus(), runtime);
	const runner = new ExtensionRunner([extension], runtime, process.cwd(), SessionManager.inMemory(), {} as never,
		{ scheduler, hookTimeouts: { safety: { timeoutMs: 30_000 } } });
	runner.setUIContext({ ...runner.getUIContext(), select: () => { shown(); return new Promise(resolve => { selected = () => resolve("yes"); }); } }, "tui");
	const run = runner.emitToolCall({ type: "tool_call", toolName: "controlled", toolCallId: "after-wait", input: {} } as never);
	const rejected = assert.rejects(run, /timed out after 30000ms/);
	await visible; scheduler.advanceBy(90_000); selected();
	for (let i = 0; i < 8; i++) await Promise.resolve();
	scheduler.advanceBy(29_999); assert.equal(runner.hookDeliveryStats.timeouts, 0);
	scheduler.advanceBy(1); await rejected;
	assert.equal(runner.hookDeliveryStats.timeouts, 1);
	assert.equal(scheduler.highWaterMark.current, 0);
});


test("run abort revokes the real permission wait before a late approval", async (t) => {
 const f = await permissionFixture(t);
 const run = f.call(); const rejection = assert.rejects(run, /abort/i);
 await f.visible; const signal = f.dialogOptions().signal;
 f.abort.abort(); await rejection;
 f.choose(0); await Promise.resolve();
 assert.equal(signal.aborted, true);
 assert.equal(f.permission.state.allowRules.length, 0);
 assert.equal(f.scheduler.highWaterMark.current, 0);
});


test("full explicit-cwd command and write payload remain inspectable", async (t) => {
 for (const toolName of ["bash", "write"]) {
  const f = await permissionFixture(t);
  f.permission.state.setMode("read-only");
  const payload = "x".repeat(6000) + "REVIEW-TAIL";
  const input = toolName === "bash" ? { cwd: f.cwd, command: `node -e '${payload}'` }
   : { path: join(f.cwd, "new.txt"), content: payload };
  const pending = f.call(toolName, input);
  await f.visible;
  try { assert.ok(f.dialogOptions().details.includes("REVIEW-TAIL")); }
  finally { f.choose(0); await pending; }
 }
});

test("complete browser approval includes execution-affecting non-code fields", async (t) => {
 const f = await permissionFixture(t);
 const input = { code: "print('controlled fixture')", session: "controlled-cloud-session", timeoutMs: 12345, purpose: "review regression" };
 const pending = f.call("browser_exec", input);
 await f.visible;
 try {
  const details = f.dialogOptions().details as string;
  assert.ok(details.includes('"session": "controlled-cloud-session"'));
  assert.ok(details.includes('"timeoutMs": 12345'));
  assert.deepEqual(JSON.parse(details.split("完整请求:\n")[1]!), input);
 } finally { f.choose(0); await pending; }
 assert.equal(f.scheduler.highWaterMark.current, 0);
});

test("details support configured paging and display their live countdown", () => {
 const { rows, columns } = { rows: 10, columns: 40 };
 const selector: any = new ExtensionSelectorComponent("permission", ["Approve", "Deny"], () => {}, () => {},
  { tui: { terminal: { rows, columns }, requestRender() {} } as never, timeout: 30_000, details: "ROW\n".repeat(100) });
 try {
  assert.match(selector.render(40).join("\n"), /30s/);
  selector.handleInput("\x1b[6;1~");
  assert.ok(selector.detailOffset > 0);
  selector.countdown.onTick(29);
  assert.match(selector.render(40).join("\n"), /29s/);
 } finally { selector.dispose(); }
});

test("signal-aware machine hooks keep the timeout diagnosis", async () => {
 const runtime = createExtensionRuntime(); const scheduler = new FakeScheduler();
 const extension = await loadExtensionFromFactory(pi => pi.on("tool_call", (_event, ctx) => new Promise((_resolve, reject) => {
  ctx.signal!.addEventListener("abort", () => reject(new Error("handler-local abort")), { once: true });
 })), process.cwd(), createEventBus(), runtime);
 const runner = new ExtensionRunner([extension], runtime, process.cwd(), SessionManager.inMemory(), {} as never,
  { scheduler, hookTimeouts: { safety: { timeoutMs: 30_000 } } });
 const run = runner.emitToolCall({ type: "tool_call", toolName: "controlled", toolCallId: "signal-aware", input: {} } as never);
 const rejection = assert.rejects(run, /timed out/);
 scheduler.advanceBy(30_000); await rejection;
 assert.equal(runner.hookDeliveryStats.timeouts, 1);
});

test("fullscreen dock cannot clip permission controls", { timeout: 5000 }, async () => {
 const { InteractiveMode } = await import("../packages/coding-agent/src/modes/interactive/interactive-mode.ts");
 const { Container, VStack, Text } = await import("@super-pi/tui");
 const { TuiAltScreen } = await import("../packages/tui/src/tui-alt-screen.ts");
 const { FakeTerminal } = await import("./helpers/runtime-instrumentation.ts");
 const terminal = new FakeTerminal(60, 16);
 let input!: (data: string) => void;
 (terminal as any).start = (onInput: (data: string) => void) => { input = onInput; };
 const ui = new TuiAltScreen(terminal);
 const mode: any = Object.create(InteractiveMode.prototype);
 mode.ui = ui; mode.editor = new Container(); mode.editorContainer = new Container(); mode.disposeActiveSelector = () => {};
 ui.setLayoutRoot(new VStack([{ component: new Text("history\n".repeat(4)), minSize: 4, shrink: 0 },
  { component: mode.editorContainer, minSize: 3, shrink: 1 },
  { component: new Text("footer\n".repeat(7)), minSize: 7, shrink: 0 }]));
 ui.start();
 const pending = mode.showExtensionSelector("permission", ["Approve", "Deny"], { details: "LONG\n".repeat(2000) });
 try {
  ui.renderNow(true); await ui.flushTerminalFrames();
  assert.match(terminal.writes.join("").replace(/\x1b\[[0-9;]*m/g, ""), /enter select/);
  input("\x1b[C");
  assert.ok(mode.extensionSelector.detailOffset > 0, "actual fullscreen input must reach the approval pager");
 } finally { mode.hideExtensionSelector(); await pending; await ui.stop(); }
});


test("permission state restore revokes a pending selection immediately", async (t) => {
 const f = await permissionFixture(t);
 const run = f.call(); const rejected = assert.rejects(run, /abort|obsolete/i);
 await f.visible; const signal = f.dialogOptions().signal;
 await f.permission.restore(f.runner.createContext());
 try { assert.equal(signal.aborted, true); }
 finally { f.choose(0); await rejected; }
});

test("multi-megabyte details retain only a bounded wrapping window", () => {
 const selector: any = new ExtensionSelectorComponent("permission", ["Approve", "Deny"], () => {}, () => {},
  { tui: { terminal: { rows: 12, columns: 40 } } as never, details: "x".repeat(2 * 1024 * 1024) + "TAIL" });
 try {
  selector.render(40);
  assert.ok(selector.detailLines.length <= 4096, "wrapped cache must not grow with the complete request");
  assert.ok(selector.detailLines.reduce((sum: number, line: string) => sum + line.length, 0) <= 24 * 1024);
 } finally { selector.dispose(); }
});

test("new hook diagnostics inherit expanded tool output", async () => {
 const { InteractiveMode } = await import("../packages/coding-agent/src/modes/interactive/interactive-mode.ts");
 const { Container } = await import("@super-pi/tui");
 const mode: any = Object.create(InteractiveMode.prototype);
 mode.chatContainer = new Container(); mode.ui = { requestRender() {} }; mode.toolOutputExpanded = true;
 mode.showExtensionError("fixture", "timeout", "EXPANDED-STACK", "call-expanded");
 assert.match(mode.chatContainer.render(100).join("\n"), /EXPANDED-STACK/);
});


test("bounded details paging crosses windows without splitting surrogate pairs", () => {
 const selector: any = new ExtensionSelectorComponent("permission", ["Approve", "Deny"], () => {}, () => {},
  { tui: { terminal: { rows: 12, columns: 40 } } as never, details: "中".repeat(4094) + "😀END" });
 let reachedEnd = false;
 try {
  for (let i = 0; i < 100; i++) {
   const text = selector.render(40).join("\n");
   if (text.includes("😀END")) { reachedEnd = true; break; }
   selector.handleInput("\x1b[6~");
  }
  assert.equal(reachedEnd, true);
  selector.handleInput("\x1b[5~"); selector.render(40);
  assert.equal(selector.detailPage, 0);
 } finally { selector.dispose(); }
});


test("detailed multiline choices occupy one physical footer row", () => {
 const selector = new ExtensionSelectorComponent("approval", ["allow\n".repeat(100), "deny"], () => {}, () => {},
  { tui: { terminal: { rows: 10, columns: 48 }, requestRender() {} } as never, details: "request" });
 try { assert.ok(selector.render(48).join("\n").split("\n").length <= 10); }
 finally { selector.dispose(); }
});

test("policy change while approval waits rejects stale session rules", async (t) => {
 const f = await permissionFixture(t);
 f.permission.state.setMode("read-only");
 const pending = f.call("bash", { command: "node -e 'console.log(1)'" });
 const outcome = pending.then(() => "allowed", () => "rejected");
 await f.visible;
 f.permission.state.setApprovalPolicy("never-ask");
 f.choose(1);
 assert.equal(await outcome, "rejected");
 assert.equal(f.permission.state.allowRules.length, 0);
 assert.equal(f.scheduler.highWaterMark.current, 0);
});


test("permission command immediately revokes a pending prompt", async (t) => {
 const f = await permissionFixture(t);
 const pending = f.call(); const outcome = pending.catch(() => "rejected");
 await f.visible; const signal = f.dialogOptions().signal;
 await f.runner.getCommand("permissions")!.handler("never-ask", f.runner.createContext() as never);
 try { assert.equal(signal.aborted, true); }
 finally { f.choose(0); await outcome; }
 assert.equal(f.scheduler.highWaterMark.current, 0);
});


test("RPC approval title escapes controls without truncating request details", async () => {
 const { formatRpcApprovalTitle } = await import("../packages/coding-agent/src/modes/rpc/rpc-mode.ts");
 const details = "code\u202etarget\u2066\x1b[31m\n" + "x".repeat(6000) + "END";
 const title = formatRpcApprovalTitle("approval", details);
 assert.ok(title.includes("\\u202e")); assert.ok(title.includes("\\u2066"));
 assert.ok(title.includes("\\u001b")); assert.ok(title.endsWith("END"));
 assert.equal(/[\u202a-\u202e\u2066-\u2069\x1b]/.test(title), false);
 assert.equal(formatRpcApprovalTitle("ordinary", undefined), "ordinary");
});


test("subagent approval cannot survive a session restore", async (t) => {
 const f = await permissionFixture(t); f.permission.state.setMode("full-access");
 const pending = f.call("subagent", { agent: "controlled", task: "no execution", cwd: tmpdir() });
 const outcome = pending.then(() => "allowed", () => "rejected");
 await f.visible; const signal = f.dialogOptions()?.signal;
 await f.permission.restore(f.runner.createContext());
 f.choose(0);
 assert.equal(await outcome, "rejected");
 assert.equal(signal?.aborted, true);
 assert.equal(f.scheduler.highWaterMark.current, 0);
});

test("busy permission does not serialize an undisplayable request", async (t) => {
 const f = await permissionFixture(t); f.permission.state.setMode("read-only");
 const pending = f.call(); await f.visible;
 let serializations = 0;
 const input = { path: join(f.cwd, "controlled.txt"), content: "payload", toJSON() { serializations++; return {}; } };
 try { await assert.rejects(f.call("write", input), /awaiting approval/); assert.equal(serializations, 0); }
 finally { f.choose(0); await pending; }
});


test("current subagent approval completes and releases the prompt", async (t) => {
 const f = await permissionFixture(t); f.permission.state.setMode("full-access");
 const pending = f.call("subagent", { agent: "controlled", task: "no execution", cwd: tmpdir() });
 await f.visible; const signal = f.dialogOptions().signal; f.choose(0);
 assert.equal(await pending, undefined);
 assert.equal(signal.aborted, true);
 assert.equal(f.scheduler.highWaterMark.current, 0);
});

test("delegated approvals are single-use and reject changed or restored authority before consumption", async (t) => {
 const f = await permissionFixture(t);
 const cases = [
  { name: "browser_exec", input: { code: "print('no execution')" }, consume: (input: object) => consumeBrowserExecAuthorization(input, "approval-1") },
  { name: "structured_readonly_command", input: { command: "git", args: ["status"], cwd: f.cwd }, consume: (input: object) => consumeStructuredReadonlyWorkspacePolicy(input, "approval-1") },
  { name: "subagent", input: { agent: "controlled", task: "no execution", cwd: f.cwd }, consume: (input: object) => consumeDelegatedTaskPolicies(input, [f.cwd], f.cwd, "approval-1") },
 ];
 for (const item of cases) for (const invalidation of ["none", "narrow", "restore", "transition"] as const) {
  f.permission.state.setMode("full-access"); f.permission.state.setApprovalPolicy("never-ask");
  const input = { ...item.input };
  assert.equal(await f.call(item.name, input), undefined);
  if (invalidation === "narrow") f.permission.state.setMode("read-only");
  if (invalidation === "restore") await f.permission.restore(f.runner.createContext());
  if (invalidation === "transition") await f.runtime.executionBoundary.transition(() => undefined);
  if (invalidation === "none") assert.ok(item.consume(input));
  else assert.throws(() => item.consume(input), /authority changed|authorization.*(stale|current)/i, `${item.name}: ${invalidation}`);
  assert.throws(() => item.consume(input), /missing|invalid|stale/i);
  for (const key of Object.getOwnPropertySymbols(input)) assert.equal((input as any)[key], undefined);
 }
 f.runner.invalidate();
 assert.equal(f.scheduler.highWaterMark.current, 0);
});

test("structured command rechecks authorization after asynchronous preparation before starting Git", async (t) => {
 const f = await permissionFixture(t);
 execFileSync("git", ["init", "--quiet", f.cwd], { timeout: 5000, windowsHide: true });
 let tool: any;
 structuredReadonlyCommandExtension({ registerTool(value: unknown) { tool = value; } } as never);
 for (const narrow of [false, true]) {
  f.permission.state.setMode("full-access"); f.permission.state.setApprovalPolicy("never-ask");
  const input = { command: "git", args: ["status", "--short"], cwd: f.cwd };
  assert.equal(await f.call("structured_readonly_command", input), undefined);
  const running = tool.execute("approval-1", input, undefined, undefined, f.runner.createContext());
  if (narrow) {
   f.permission.state.setMode("read-only");
   await assert.rejects(running, /Permission authority changed/);
  } else assert.equal((await running).details.ok, true);
 }
 f.runner.invalidate();
});


test("browser execution rechecks authority and exact input after preparation and progress callbacks", { timeout: 10000 }, async (t) => {
 const f = await permissionFixture(t);
 const executable = join(f.root, process.platform === "win32" ? "browser-harness.exe" : "browser-harness");
 writeFileSync(executable, "offline browser fixture", { mode: 0o700 });
 const originalCli = process.env.SP_BROWSER_HARNESS_CLI, originalAgent = process.env.SP_CODING_AGENT_DIR;
 process.env.SP_BROWSER_HARNESS_CLI = executable; process.env.SP_CODING_AGENT_DIR = join(f.root, "agent");
 const childProcess = createRequire(import.meta.url)("node:child_process");
 const originalSpawn = childProcess.spawn, originalMkdir = fsPromises.mkdir;
 let boundary = "current", launches = 0;
 childProcess.spawn = (_command: string, args: string[]) => {
  launches++;
  const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() });
  queueMicrotask(() => {
   child.emit("spawn");
   if (args[0] === "--version") {
    child.stdout.write("0.1.13\n");
    if (boundary === "version") f.permission.state.setMode("read-only");
   }
   child.emit("close", 0);
  });
  return child;
 };
 (fsPromises as any).mkdir = async (...args: any[]) => {
  const result = await (originalMkdir as any)(...args);
  if (boundary === "workspace") f.permission.state.setMode("read-only");
  return result;
 };
 syncBuiltinESMExports();
 try {
  for (boundary of ["current", "version", "workspace", "update", "mutated"]) {
   f.permission.state.setMode("full-access"); f.permission.state.setApprovalPolicy("never-ask"); launches = 0;
   const input = { code: "print('offline')", session: "fixture" };
   assert.equal(await f.call("browser_exec", input), undefined);
   let tool: any, shutdown: any;
   browserUseExtension({ registerTool(value: unknown) { tool = value; }, registerCommand() {},
    on(name: string, handler: unknown) { if (name === "session_shutdown") shutdown = handler; } } as never);
   const running = tool.execute("approval-1", input, undefined, () => {
    if (boundary === "update") f.permission.state.setMode("read-only");
    if (boundary === "mutated") input.code = "print('changed after approval')";
   }, f.runner.createContext());
   if (boundary === "current") { assert.equal((await running).details.ok, true); assert.equal(launches, 2); }
   else { await assert.rejects(running, /authority changed|authorization is missing or stale/, boundary); assert.equal(launches, 1); }
   await shutdown();
  }
  // A revocation during the version gate's own asynchronous fingerprint must prevent even --version.
  f.permission.state.setMode("full-access"); launches = 0;
  const input = { code: "print('offline')" }; await f.call("browser_exec", input);
  const grant = consumeBrowserExecAuthorization(input, "approval-1");
  const gate = new BrowserHarnessVersionGate(() => { launches++; throw new Error("unexpected version launch"); });
  const pending = gate.check({ command: executable, source: "configured" }, { cwd: f.cwd, env: {}, assertCurrent: grant.assertCurrent } as any);
  f.permission.state.setMode("read-only");
  await assert.rejects(pending, /authority changed/); assert.equal(launches, 0);
 } finally {
  childProcess.spawn = originalSpawn; fsPromises.mkdir = originalMkdir; syncBuiltinESMExports();
  if (originalCli === undefined) delete process.env.SP_BROWSER_HARNESS_CLI; else process.env.SP_BROWSER_HARNESS_CLI = originalCli;
  if (originalAgent === undefined) delete process.env.SP_CODING_AGENT_DIR; else process.env.SP_CODING_AGENT_DIR = originalAgent;
  f.runner.invalidate();
 }
});

test("permission changes revoke running browser and structured commands without leaving abort listeners", { timeout: 10000 }, async (t) => {
 const f = await permissionFixture(t);
 execFileSync("git", ["init", "--quiet", f.cwd], { timeout: 5000, windowsHide: true });
 const executable = join(f.root, process.platform === "win32" ? "browser-harness.exe" : "browser-harness");
 writeFileSync(executable, "offline browser fixture", { mode: 0o700 });
 const originalCli = process.env.SP_BROWSER_HARNESS_CLI, originalAgent = process.env.SP_CODING_AGENT_DIR;
 process.env.SP_BROWSER_HARNESS_CLI = executable; process.env.SP_CODING_AGENT_DIR = join(f.root, "agent");
 const childProcess = createRequire(import.meta.url)("node:child_process");
 const originalSpawn = childProcess.spawn;
 const originalKill = process.kill;
 process.kill = (() => true) as typeof process.kill;
 const children: any[] = [];
 let change = "policy", changeDone: Promise<void> | undefined;
 childProcess.spawn = (_command: string, args: string[]) => {
  const child = Object.assign(new EventEmitter(), { pid: 424242, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
   kill() { queueMicrotask(() => child.emit("close", 1)); return true; } });
  children.push(child);
  queueMicrotask(() => {
   child.emit("spawn");
   if (args[0] === "/PID") { child.emit("close", 0); return; }
   if (args[0] === "--version") { child.stdout.write("0.1.13\n"); child.emit("close", 0); return; }
   changeDone = change === "policy"
    ? f.runner.getCommand("permissions")!.handler("read-only", f.runner.createContext() as never)
    : f.permission.restore(f.runner.createContext());
   void Promise.resolve(changeDone).then(() => child.emit("close", 0));
  });
  return child;
 };
 syncBuiltinESMExports();
 try {
  for (const kind of ["browser_exec", "structured_readonly_command"]) for (change of ["policy", "restore"]) {
   f.permission.state.setMode("full-access"); f.permission.state.setApprovalPolicy("never-ask");
   let tool: any, shutdown: any;
   const api = { registerTool(value: unknown) { tool = value; }, registerCommand() {},
    on(name: string, handler: unknown) { if (name === "session_shutdown") shutdown = handler; } };
   if (kind === "browser_exec") browserUseExtension(api as never); else structuredReadonlyCommandExtension(api as never);
   const input = kind === "browser_exec" ? { code: "print('offline')", session: "fixture" } : { command: "git", args: ["status", "--short"], cwd: f.cwd };
   await f.call(kind, input);
   const grant = (input as any)[Object.getOwnPropertySymbols(input).find(key => (input as any)[key]?.revocationSignal)!];
   const running = tool.execute("approval-1", input, undefined, undefined, f.runner.createContext());
   if (kind === "browser_exec") {
    const result = await running;
    assert.equal(result.isError, true, `${kind}: ${change}`); assert.equal(result.details.aborted, true);
   } else await assert.rejects(running, /timeout_or_aborted/);
   await changeDone;
   assert.equal(grant.revocationSignal.aborted, true);
   assert.equal(getEventListeners(grant.revocationSignal, "abort").length, 0);
   for (const child of children) { assert.equal(child.stdout.listenerCount("data"), 0); assert.equal(child.stderr.listenerCount("data"), 0); }
   children.length = 0;
   await shutdown?.();
  }
 } finally {
  childProcess.spawn = originalSpawn; process.kill = originalKill; syncBuiltinESMExports();
  if (originalCli === undefined) delete process.env.SP_BROWSER_HARNESS_CLI; else process.env.SP_BROWSER_HARNESS_CLI = originalCli;
  if (originalAgent === undefined) delete process.env.SP_CODING_AGENT_DIR; else process.env.SP_CODING_AGENT_DIR = originalAgent;
  f.runner.invalidate();
 }
});

test("LSP write authorization resolves the requested root instead of the session cwd", async t => {
 const f = await permissionFixture(t, true);
 const outside = join(f.root, "external"); mkdirSync(outside); writeFileSync(join(outside, "example.ts"), "const n = 1;");
 f.permission.state.setMode("workspace-write"); f.permission.state.setApprovalPolicy("never-ask");
 const input = { root: outside, path: "example.ts", write: true };
 assert.equal((await f.call("lsp_fix", input))?.block, true);
 f.permission.state.setMode("full-access");
 assert.equal(await f.call("lsp_fix", input), undefined);
 const approval = consumeFixAuthorization(input, "approval-1");
 assert.equal(approval.canonicalTarget, realpathSync.native(join(outside, "example.ts")));
 assertFixAuthorization(approval, join(outside, "example.ts"));
 assert.throws(() => consumeFixAuthorization(input, "approval-1"), /authorization is missing/);
 await f.permission.restore(f.runner.createContext());
 assert.throws(() => assertFixAuthorization(approval, join(outside, "example.ts")), /authority changed/);
 f.runner.invalidate();
});

test("RPC revocation dismisses only the matching client prompt", async () => {
 const { createRpcDialogPromise } = await import("../packages/coding-agent/src/modes/rpc/rpc-mode.ts");
 const pending = new Map<string, any>(); const events: any[] = [];
 const abort = new AbortController();
 const first = createRpcDialogPromise(pending, event => events.push(event), { signal: abort.signal }, undefined, { method: "select", title: "first", options: [] }, () => "first");
 const second = createRpcDialogPromise(pending, event => events.push(event), undefined, undefined, { method: "select", title: "second", options: [] }, () => "second");
 const firstId = events[0].id; const secondId = events[1].id;
 abort.abort(); assert.equal(await first, undefined);
 const secondOwner = pending.get(secondId); secondOwner.resolve({ id: secondId }); await second;
 assert.deepEqual(events[2], { type: "extension_ui_request", id: firstId, method: "dismiss", reason: "aborted" });
 assert.equal(pending.size, 0); assert.equal(events.length, 3);
});


test("RPC timeout and failed output release their existing request owner", async t => {
 const { createRpcDialogPromise } = await import("../packages/coding-agent/src/modes/rpc/rpc-mode.ts");
 t.mock.timers.enable({ apis: ["setTimeout"] });
 const pending = new Map<string, any>(); const events: any[] = [];
 const result = createRpcDialogPromise(pending, event => events.push(event), { timeout: 10 }, undefined, { method: "select" }, () => "unused");
 t.mock.timers.tick(10); assert.equal(await result, undefined);
 assert.equal(events[1].method, "dismiss"); assert.equal(events[1].reason, "timeout");
 assert.equal(pending.size, 0);
 await assert.rejects(createRpcDialogPromise(pending, () => { throw new Error("controlled output failure"); }, undefined, undefined, { method: "select" }, () => undefined), /output failure/);
 assert.equal(pending.size, 0);
});


test("timed tool hooks refuse uncancellable editor/custom UI before opening", async () => {
 for (const method of ["editor", "custom"] as const) {
  const runtime = createExtensionRuntime(); const scheduler = new FakeScheduler(); let opened = 0;
  const extension = await loadExtensionFromFactory(pi => pi.on("tool_call", async (_event, ctx) => {
   await (ctx.ui[method] as any)("controlled");
  }), process.cwd(), createEventBus(), runtime);
  const runner = new ExtensionRunner([extension], runtime, process.cwd(), SessionManager.inMemory(), {} as never,
   { scheduler, hookTimeouts: { safety: { timeoutMs: 30_000 } } });
  runner.setUIContext({ ...runner.getUIContext(), [method]: async () => { opened++; return undefined; } } as never, "tui");
  await assert.rejects(runner.emitToolCall({ type: "tool_call", toolName: "controlled", toolCallId: method, input: {} } as never), /not supported.*timed tool_call/);
  assert.equal(opened, 0); assert.equal(scheduler.highWaterMark.current, 0);
 }
});


test("RPC error serialization preserves distinct invocation identities", async () => {
 const { formatRpcExtensionError } = await import("../packages/coding-agent/src/modes/rpc/rpc-mode.ts");
 const common = { extensionPath: "controlled", event: "tool_call", error: "same diagnostic" };
 const first = JSON.parse(JSON.stringify(formatRpcExtensionError({ ...common, toolCallId: "first" })));
 const second = JSON.parse(JSON.stringify(formatRpcExtensionError({ ...common, toolCallId: "second" })));
 assert.equal(first.toolCallId, "first"); assert.equal(second.toolCallId, "second");
 assert.equal("toolCallId" in JSON.parse(JSON.stringify(formatRpcExtensionError(common))), false);
});

test("PR2: prefix approval acceptance, scope, persistence and suggestion boundaries", async t => {
 const scope = { backend: "bash" as const, cwd: process.cwd() };
 const rule = createSessionAllowRule("prefix", "ls *", scope);
 for (const value of ["lsof", "lsblk", "ls ./src && touch out", "ls; pwd", 'ls "$(pwd)"', "ls > out", "ls | cat", "./ls", "/untrusted/ls"]) assert.equal(sessionAllowRuleMatches(rule, value, scope), false, value);
 for (const other of [{ ...scope, backend: "powershell" }, { ...scope, cwd: join(scope.cwd, "other") }]) assert.equal(sessionAllowRuleMatches(rule, "ls", other), false);
 for (const tool of ["git", "npm", "pnpm", "yarn", "bun", "cargo", "go", "dotnet", "uv", "pip", "docker", "kubectl"]) {
  assert.equal(simpleCommandPrefix(`${tool} run target`), `${tool} run`); assert.equal(simpleCommandPrefix(`${tool} --version`), undefined); assert.equal(simpleCommandPrefix(tool), undefined);
 }
 for (const tool of ["bash", "sh", "zsh", "pwsh", "powershell", "python", "python3", "python3.12", "node", "deno", "ruby", "perl", "sudo", "doas", "env", "xargs", "timeout", "nice", "npx", "bunx", "pnpx", "uvx", "pipx"]) assert.equal(simpleCommandPrefix(`${tool} script`), undefined, tool);
 for (const tool of ["make", "pytest", "tsc", "jest", "vitest"]) assert.equal(simpleCommandPrefix(`${tool} target`), tool);
 // Each row is one behavior in workspace-write + ask. Commands are never executed.
 for (const [first, kind, command, prefix, asks] of [
  ["npm test", "prefix", "npm test -- --watch=false", undefined, 0],
  ["npm test", "prefix", "npm test && echo done", "npm test", 1],
  ["npm run lint", "prefix", "npm run build", undefined, 0],
  ["npm run lint", "prefix", "npm install lodash", "npm install", 1],
  ["npm run lint", "prefix", "npm run build && rm -rf x", undefined, 1],
  ["npm run lint", "prefix", "npm run build > .git/config", undefined, 1],
  ["make", "prefix", "make test", undefined, 0],
  ["", "", "python3 a.py", undefined, 1],
  ["python3 *", "manual", "python3 b.py", undefined, 0],
  ["python3 *", "manual", `python3 -c "import shutil; shutil.rmtree('x')"`, undefined, 1],
  ["rm *", "manual", "rm -rf node_modules", undefined, 1],
  ["touch ./new.txt", "exact", "touch ./new.txt", undefined, 0],
 ] as const) {
  const f = await permissionFixture(t, true); let shown = 0, selecting = false;
  f.runner.setUIContext({ ...f.runner.getUIContext(), select: async (_title, choices, options) => {
   shown++; assert.ok(choices.includes("将当前完整指令加入 Session 白名单")); const offered = choices.find(value => value.includes("指令前缀"));
   if (offered) assert.match(options?.details ?? "", /复合命令仍需确认/);
   if (!selecting) { assert.equal(offered, prefix ? `将当前指令前缀加入 Session 白名单：${prefix} *` : undefined, command); return "仅允许本次"; }
   const selected = kind === "exact" ? choices.find(value => value.includes("完整指令")) : offered;
   assert.equal(selected, kind === "exact" ? "将当前完整指令加入 Session 白名单" : `将当前指令前缀加入 Session 白名单：${simpleCommandPrefix(first)} *`); return selected;
  } }, "tui");
  if (kind === "manual") await f.runner.getCommand("permissions")!.handler(`add-rule prefix ${first}`, f.runner.createContext() as never);
  else if (first) { selecting = true; if (kind === "exact") f.permission.state.setMode("read-only"); assert.equal(await f.call("bash", { command: first, cwd: "." }), undefined); assert.equal(shown, 1); selecting = false; f.permission.state.setMode("workspace-write"); }
  const before = shown; assert.equal(await f.call("bash", { command }), undefined, command); assert.equal(shown - before, asks, command);
  if (!asks) assert.equal(f.audits.at(-1)?.policyReason, "session_rule_match", command);
  const saved = f.permission.state.allowRules[0]; if (first) {
   assert.equal(saved.kind, kind === "exact" ? "exact" : "prefix"); assert.equal(saved.pattern, kind === "exact" ? first : kind === "manual" ? first.slice(0, -2) : simpleCommandPrefix(first));
   assert.equal(saved.backend, "bash"); assert.equal(saved.cwd, kind === "manual" ? f.cwd : realpathSync.native(f.cwd)); assert.deepEqual(f.permission.state.serialized().allowRules[0], saved); assert.equal(sessionAllowRuleMatches(saved, saved.pattern), true);
   assert.equal(f.permission.state.removeAllowRule(saved.id)?.id, saved.id); assert.equal(f.permission.state.allowRules.length, 0);
  }
 }
});

test("long details display every core choice; stale Enter and pasted Enter cannot approve", () => {
 let approvals = 0;
 const options = ["仅允许本次", "精确白名单", "前缀白名单", "拒绝", "拒绝并说明"];
 const terminal = { rows: 16, columns: 60 };
 const selector = new ExtensionSelectorComponent("操作尚未执行", options, () => approvals++, () => {}, { details: "request\n".repeat(10000), tui: { terminal } as never });
 const lines = selector.render(60).join("\n");
 for (const option of options) assert.ok(lines.includes(option));
 selector.handleInput("\r"); selector.handleInput("\x1b[200~\r\x1b[201~"); assert.equal(approvals, 0);
 selector.handleInput("\x1b[A"); selector.handleInput("\r"); selector.handleInput("\r"); assert.equal(approvals, 1);
 terminal.rows = 4; selector.render(60); selector.handleInput("\x1b[A"); selector.handleInput("\r"); assert.equal(approvals, 1);
 selector.dispose();
});


test("legacy unscoped rules are displayed without a fabricated workspace scope", async t => {
 const f = await permissionFixture(t); let text = "";
 f.permission.state.addAllowRule(createSessionAllowRule("exact", "ls"));
 f.runner.setUIContext({ ...f.runner.getUIContext(), notify: message => { text = message; } }, "tui");
 await f.runner.getCommand("permissions")!.handler("rules", f.runner.createContext() as never);
 assert.match(text, /cwd=unscoped \(legacy\)/); assert.doesNotMatch(text, new RegExp(f.cwd.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});
test("failed tree restore preserves primary identity and blocks until it is verified again", async t => {
 const f = await permissionFixture(t, true); const original = f.permission.state.primary; const replacement = join(f.root, "replacement"); mkdirSync(replacement);
 rmSync(f.cwd); symlinkSync(replacement, f.cwd, process.platform === "win32" ? "junction" : "dir");
 await assert.rejects(f.permission.restore(f.runner.createContext()), error => error instanceof Error && error.message.includes("SHELL_CWD_CHANGED"));
 assert.equal(f.permission.state.primary, original);
 const blocked = await f.call("bash", { command: "pwd", cwd: "." }); assert.equal(blocked?.block, true); assert.ok(blocked?.reason?.includes("SHELL_CWD_CHANGED"));
 rmSync(f.cwd); symlinkSync(original.canonicalPath, f.cwd, process.platform === "win32" ? "junction" : "dir");
 await f.permission.restore(f.runner.createContext()); assert.equal(f.permission.state.primary, original); assert.equal(await f.call("bash", { command: "pwd", cwd: "." }), undefined);
});


test("failed permission status publication keeps restore unavailable", async t => {
 const f = await permissionFixture(t); const ui = f.runner.getUIContext();
 f.runner.setUIContext({ ...ui, setStatus() { throw new Error("controlled status failure"); } }, "tui");
 await assert.rejects(f.permission.restore(f.runner.createContext()), error => error instanceof Error && error.message.includes("controlled status failure"));
 const blocked = await f.call("bash", { command: "pwd", cwd: "." }); assert.equal(blocked?.block, true);
 f.runner.setUIContext(ui, "tui"); await f.permission.restore(f.runner.createContext());
 assert.equal(await f.call("bash", { command: "pwd", cwd: "." }), undefined);
});
