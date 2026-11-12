import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter, getEventListeners } from "node:events";
import { setImmediate as tick } from "node:timers/promises";
import { Session as InspectorSession } from "node:inspector/promises";
import { Type } from "typebox";
import { Agent } from "../packages/agent/src/agent.ts";
import { SubagentExecution, SubagentExecutionServer, SubagentParentClient, WORKSPACE_MESSAGE_PREFIX } from "../packages/coding-agent/src/core/files/subagent-execution.ts";
import type { AgentTool } from "../packages/agent/src/types.ts";

function fixture(execute: AgentTool["execute"]) {
  const tool: AgentTool = { name: "read", label: "Read", description: "Owned probe", parameters: Type.Object({ path: Type.String() }), execute };
  const agent = new Agent({ initialState: { tools: [tool] }, streamFn: () => { throw new Error("No provider may start"); } });
  const signal = new AbortController(); let authorizations = 0;
  const session = { getEntry() { return undefined; } };
  agent.beforeToolCall = async () => { authorizations++; return undefined; };
  const owner = new SubagentExecution(agent, new Map([[tool.name, tool as any]]), new Map([[tool.name, tool]]), {
    profile: { mode: "host-write", workspace: process.cwd(), directories: [], generation: 0, cwd: process.cwd(), writable: false },
    toolCallId: "owned-task", tools: ["read"], signal: signal.signal, assertCurrent() { signal.signal.throwIfAborted(); },
  }, session as any);
  return { owner, signal, agent, session, get authorizations() { return authorizations; } };
}
const smallResult = { content: [{ type: "text" as const, text: "owned receipt" }], details: undefined };

function channel(t: test.TestContext, execute: AgentTool["execute"]) {
  const f = fixture(execute), proc: any = new EventEmitter(), failures: string[] = [];
  proc.connected = true;
  proc.send = (raw: string, done: (error: null) => void) => { queueMicrotask(() => (process as EventEmitter).emit("message", raw)); done(null); };
  const oldConnected = Object.getOwnPropertyDescriptor(process, "connected"), oldSend = Object.getOwnPropertyDescriptor(process, "send");
  Object.defineProperty(process, "connected", { value: true, configurable: true });
  Object.defineProperty(process, "send", { value: (raw: string, done: (error: null) => void) => { proc.emit("message", raw); done(null); }, configurable: true });
  const server = new SubagentExecutionServer(f.owner), client = new SubagentParentClient();
  server.attach(proc, reason => { failures.push(reason); process.emit("disconnect"); });
  t.after(async () => {
    client.dispose(); await server.dispose();
    if (oldConnected) Object.defineProperty(process, "connected", oldConnected); else delete (process as any).connected;
    if (oldSend) Object.defineProperty(process, "send", oldSend); else delete (process as any).send;
    assert.equal(proc.listenerCount("message"), 0);
  });
  return { ...f, client, failures };
}

test("child invocation cancellation reaches the parent and waits for actual cleanup", async t => {
  let start!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { start = resolve; }), cleanup = new Promise<void>(resolve => { release = resolve; });
  let parentSignal: AbortSignal | undefined, completed = false;
  const f = channel(t, async (_id, _args, signal) => {
    parentSignal = signal; start(); await cleanup; return smallResult;
  });
  await f.client.initialize();
  const abort = new AbortController();
  const request = f.client.definitions().read.execute("owned", { path: "sample.txt" }, abort.signal, undefined, {} as any);
  const finished = request.then(() => { completed = true; }, () => { completed = true; });
  try {
    await started; abort.abort(); await tick();
    assert.equal(parentSignal?.aborted, true, "cancellation must reach the actual parent tool signal");
    assert.equal(completed, false, "child must wait while the actual tool still owns cleanup");
  } finally { release(); await finished; }
  assert.deepEqual((await request).content, smallResult.content, "a completed native receipt must survive a cancellation race");
  assert.equal((await f.client.definitions().read.execute("next", { path: "sample.txt" }, undefined, undefined, {} as any)).isError, false);
  assert.deepEqual(f.failures, []);
});

test("a locally rejected IPC payload does not consume the next request sequence", async t => {
  const f = channel(t, async () => smallResult); await f.client.initialize();
  const tool = f.client.definitions().read;
  await assert.rejects(tool.execute("oversized", { path: "sample.txt", edits: new Array(6).fill({ newLines: new Array(4000).fill("x") }) }, undefined, undefined, {} as any), /node|20000|budget|complex/i);
  const result = await tool.execute("next", { path: "sample.txt" }, undefined, undefined, {} as any);
  assert.equal(result.isError, false); assert.deepEqual(f.failures, []);
});

test("parent task channel has one request slot and releases cancellation ownership without touching the provider", async () => {
  let release!: () => void, entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const f = fixture(async (_id, _args, signal) => {
    entered(); await new Promise<void>(resolve => { release = resolve; signal!.addEventListener("abort", () => resolve(), { once: true }); });
    return smallResult;
  });
  const before = getEventListeners(f.signal.signal, "abort").length;
  assert.equal((f.owner as any).session, f.session);
  const pending = f.owner.execute("read", { path: "sample.txt" }); await started;
  assert.throws(() => f.owner.execute("read", { path: "sample.txt" }), /already busy/);
  f.signal.abort(); await pending; await f.owner.dispose(); release();
  assert.equal(f.authorizations, 1); assert.equal(f.agent.state.isStreaming, false); assert.equal(before, 1);
  assert.equal(getEventListeners(f.signal.signal, "abort").length, 0);
  for (const field of ["agent", "check", "scope", "pending", "session"]) assert.equal((f.owner as any)[field], undefined);
  assert.equal((f.owner as any).delegationPrefix, "");
  assert.equal((f.owner as any).tools.length + f.owner.descriptors.length, 0);
  assert.throws(() => f.owner.execute("read", { path: "sample.txt" }), /closed/);
  let finish!: (value: typeof smallResult) => void;
  const uncooperative = fixture(() => new Promise(resolve => { finish = resolve; }));
  const ignored = uncooperative.owner.execute("read", { path: "sample.txt" }); await tick();
  const scope = (uncooperative.owner as any).scope;
  assert.equal(scope.cancelGraceMs, 5000); scope.cancelGraceMs = 10; // Same owner, shorter test deadline only.
  const refused = assert.rejects(ignored, /ignored cancellation/);
  uncooperative.signal.abort();
  await assert.rejects(uncooperative.owner.dispose(), /effects may still be running/); await refused;
  finish(smallResult); await tick();
});

test("oversized completed results are bounded before JSON materialization and report possible effects once", async t => {
  let executions = 0, largeSerializations = 0;
  const f = fixture(async () => { executions++; return { content: [{ type: "text", text: "x".repeat(3 * 1024 * 1024) }], details: undefined }; });
  const stringify = JSON.stringify;
  t.mock.method(JSON, "stringify", (value: any, ...args: any[]) => { if (value?.result) largeSerializations++; return (stringify as any)(value, ...args); });
  const proc: any = new EventEmitter(), replies: any[] = [], failures: string[] = [];
  proc.connected = true;
  proc.send = (raw: string, done: (error: null) => void) => { replies.push(JSON.parse(raw.slice(WORKSPACE_MESSAGE_PREFIX.length))); done(null); };
  const server = new SubagentExecutionServer(f.owner); server.attach(proc, reason => { failures.push(reason); });
  try {
    proc.emit("message", WORKSPACE_MESSAGE_PREFIX + stringify({ id: 1, kind: "ready" })); await tick();
    proc.emit("message", WORKSPACE_MESSAGE_PREFIX + stringify({ id: 2, kind: "tool", name: "read", input: { path: "sample.txt" } }));
    for (let index = 0; replies.length < 2 && index < 50; index++) await tick();
    assert.equal(replies.length, 2); assert.equal(replies[1].ok, false); assert.match(replies[1].reason, /Tool finished.*Effects may already exist/);
    assert.equal(executions, 1); assert.equal(largeSerializations, 0); assert.deepEqual(failures, []);
  } finally { await server.dispose(); }
  assert.equal(proc.listenerCount("message"), 0); assert.equal((server as any).owner, undefined);
});

test("delegated request allocations and task references remain bounded after success and disposal", { skip: !global.gc }, async t => {
  const profiler = new InspectorSession(); profiler.connect();
  const f = fixture(async () => smallResult), references: WeakRef<object>[] = [];
  try {
    for (let i = 0; i < 20; i++) await f.owner.execute("read", { path: "sample.txt" });
    await profiler.post("HeapProfiler.startSampling", { samplingInterval: 4096 });
    for (let i = 0; i < 1000; i++) await f.owner.execute("read", { path: "sample.txt" });
    const { profile } = await profiler.post("HeapProfiler.stopSampling");
    let sampled = 0; const nodes = [profile.head]; while (nodes.length) { const node = nodes.pop()!; sampled += node.selfSize; nodes.push(...node.children); }
    await f.owner.dispose();
    async function cycles() {
      for (let i = 0; i < 16; i++) {
        const cycle = fixture(async () => smallResult); references.push(new WeakRef(cycle.owner));
        await cycle.owner.execute("read", { path: "sample.txt" }); await cycle.owner.dispose();
      }
    }
    await cycles(); for (let i = 0; i < 4; i++) { await tick(); global.gc!(); }
    assert.equal(references.filter(ref => ref.deref()).length, 0);
    assert.equal(f.authorizations, 1020); assert.equal((f.owner as any).scope, undefined);
    t.diagnostic(JSON.stringify({ requests: 1000, requestSlot: 1, providerRequests: 0, retainedScopes: 0, taskReferences: 16, liveTaskReferences: 0, sampledBytes: sampled, sampledBytesPerRequest: sampled / 1000 }));
  } finally { profiler.disconnect(); await f.owner.dispose(); }
});
