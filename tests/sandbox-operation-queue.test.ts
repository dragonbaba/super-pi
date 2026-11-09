import assert from "node:assert/strict";
import test from "node:test";
import { Session as InspectorSession } from "node:inspector/promises";
import { setImmediate as tick } from "node:timers/promises";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { WorkspaceSandboxTools } from "../packages/coding-agent/src/core/sandbox/workspace-tools.ts";
import { createExtensionRuntime } from "../packages/coding-agent/src/core/extensions/loader.ts";

function fixture() {
  const runtime = createExtensionRuntime();
  const owner = new WorkspaceSandboxTools(process.cwd(), process.cwd(), "read-only", () => runtime);
  const backend = (owner as any).backend, ctx: any = {};
  let calls = 0;
  backend.invoke = async () => { calls++; return { ok: true, text: "fixture", changes: [] }; };
  return { owner, runtime, backend, get calls() { return calls; },
    run(signal?: AbortSignal) { return owner.definition("read")!.execute("read", { path: "fixture" }, signal, undefined, ctx); },
    async close() { await owner.close(); await runtime.executionBoundary.dispose(); } };
}

test("shared MXC queue owns physical execution; queued cancellation never starts a backend call", async () => {
  const f = fixture(); let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const invoke = f.backend.invoke;
  f.backend.invoke = async (...args: any[]) => { const reply = await invoke(...args); await gate; return reply; };
  const first = f.run(), cancel = new AbortController(), second = f.run(cancel.signal);
  const rejected = assert.rejects(second, /cancel queued/);
  await tick(); assert.equal(f.calls, 1); assert.equal(f.owner.diagnostics.queued, 1);
  let drained = false; const drain = f.owner.drain().then(() => { drained = true; });
  cancel.abort(new Error("cancel queued")); await rejected;
  assert.equal(drained, false); assert.equal(f.owner.diagnostics.queued, 0);
  release(); await first; await drain;
  assert.equal(f.calls, 1); assert.equal(f.owner.diagnostics.reservations, 0);
  await f.run(); assert.equal(f.calls, 2); await f.close();
});

test("shared MXC capacity is bounded and shutdown joins the active physical operation", async () => {
  const f = fixture(); let release!: () => void, signal: AbortSignal | undefined;
  const gate = new Promise<void>(resolve => { release = resolve; });
  f.backend.invoke = async (_name: string, _input: object, current: AbortSignal) => {
    signal = current; await gate; current.throwIfAborted(); return { ok: true, text: "fixture" };
  };
  const calls = []; for (let i = 0; i < 65; i++) calls.push(f.run());
  const settled = Promise.allSettled(calls);
  await assert.rejects(f.run(), /capacity exceeded/);
  assert.equal(f.owner.diagnostics.highWaterMark, 1); assert.equal(f.owner.diagnostics.queueHighWaterMark, 64);
  let closed = false; const close = f.owner.close().then(() => { closed = true; });
  await tick(); assert.equal(signal?.aborted, true); assert.equal(closed, false);
  assert.equal(f.owner.diagnostics.queued, 0);
  release(); assert.ok((await settled).every(result => result.status === "rejected")); await close;
  assert.equal(f.owner.diagnostics.active, 0); assert.equal(f.owner.diagnostics.reservations, 0);
  await assert.rejects(f.run(), /scheduler is closed/); await f.close();
});

test("parent pause revokes queued sandbox work and resumes only after the active operation releases", async () => {
  const f = fixture(); let release!: () => void, started = 0;
  const gate = new Promise<void>(resolve => { release = resolve; });
  f.backend.invoke = async (_name: string, _input: object, signal: AbortSignal) => {
    started++; await gate; signal.throwIfAborted(); return { ok: true, text: "fixture" };
  };
  f.runtime.executionBoundary.register("sandbox-fixture", { revoke() {}, drain: () => f.owner.drain() });
  const settled = Promise.allSettled([f.run(), f.run()]);
  const generation = f.runtime.executionBoundary.generation, paused = f.runtime.executionBoundary.pauseForUser();
  await tick(); assert.equal(started, 1); assert.equal(f.owner.diagnostics.queued, 0);
  release(); await paused; assert.ok((await settled).every(result => result.status === "rejected"));
  await assert.rejects(f.run(), /PAUSED|new user instruction/i);
  await f.runtime.executionBoundary.resumeForUser(); assert.notEqual(f.runtime.executionBoundary.generation, generation);
  await f.run(); assert.equal(started, 2); assert.equal(f.owner.diagnostics.reservations, 0); await f.close();
});

test("shared scheduler event methods keep zero closures and idle deferred creation stays in the lifecycle join", () => {
  const source = ts.createSourceFile("scheduler.ts", readFileSync("packages/coding-agent/src/core/tasks/scheduler.ts", "utf8"), ts.ScriptTarget.Latest, true);
  const methods = new Set(["drain", "takeSlot", "removeWaiter", "settleIdle", "releaseCount", "releaseReservation"]);
  let checked = 0;
  function inspect(node: ts.Node) {
    assert.ok(!ts.isArrowFunction(node) && !ts.isFunctionExpression(node), "callback added to scheduler event method");
    if (ts.isNewExpression(node)) assert.notEqual(node.expression.getText(source), "Promise");
    ts.forEachChild(node, inspect);
  }
  function find(node: ts.Node) {
    if (ts.isMethodDeclaration(node) && methods.has(node.name.getText(source))) { inspect(node); checked++; }
    else ts.forEachChild(node, find);
  }
  find(source); assert.equal(checked, methods.size);
});

test("sandbox operation queue allocations and completed owners are released", { skip: !global.gc }, async t => {
  const profiler = new InspectorSession(); profiler.connect(); const f = fixture();
  try {
    for (let i = 0; i < 20; i++) await f.run();
    await profiler.post("HeapProfiler.startSampling", { samplingInterval: 4096 });
    for (let i = 0; i < 1000; i++) await f.run();
    const { profile } = await profiler.post("HeapProfiler.stopSampling");
    let bytes = 0; const nodes = [profile.head]; while (nodes.length) { const node = nodes.pop()!; bytes += node.selfSize; nodes.push(...node.children); }
    const refs: WeakRef<object>[] = [];
    async function cycles() {
      for (let i = 0; i < 16; i++) { const next = fixture(); refs.push(new WeakRef(next.owner)); await next.run(); await next.close(); }
    }
    await cycles(); for (let i = 0; i < 4; i++) { await tick(); global.gc!(); }
    assert.equal(refs.filter(ref => ref.deref()).length, 0);
    assert.equal((f.owner as any).operations.idle, undefined); assert.equal(f.owner.diagnostics.reservations, 0);
    t.diagnostic(JSON.stringify({ requests: 1000, activeMaximum: f.owner.diagnostics.highWaterMark, retainedReservations: 0,
      idleDeferredsDuringRequests: 0, ownerReferences: 16, liveOwnerReferences: 0, sampledBytes: bytes }));
  } finally { profiler.disconnect(); await f.close(); }
});
