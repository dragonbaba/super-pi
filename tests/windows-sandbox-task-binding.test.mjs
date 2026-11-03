import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, open, lstat, realpath, unlink, rmdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { setImmediate as tick } from "node:timers/promises";
import { parseSandboxTaskRequest, sandboxGuestCwd, WINDOWS_SANDBOX_PROFILE } from "../packages/coding-agent/src/core/sandbox/task-request.ts";
import { SandboxTaskBinding } from "../packages/coding-agent/src/core/sandbox/task-binding.ts";
import { SessionFiles } from "../packages/coding-agent/src/core/files/session-files.ts";
import { SessionExecutionBoundary } from "../packages/coding-agent/src/core/execution-boundary.ts";
import { createEventBus } from "../packages/coding-agent/src/core/event-bus.ts";
import { NATIVE_FILE_REVISION } from "../packages/coding-agent/src/core/files/file-host.ts";
import { nativeFileDiagnostics } from "../packages/coding-agent/src/core/files/native-file-client.ts";
import { NestedToolDispatch } from "../packages/agent/src/nested-tool-dispatch.ts";

// New request/binding contract only. Real SessionFiles/revision source/dispatcher
// classes with a controlled host registry and installed read implementation.
// No permission-controller decision, guest, process launch or host mutation is tested.
const fixture = { root: undefined, leaf: undefined, rootId: undefined, leafId: undefined,
  parent: undefined, handle: undefined, closeAttempted: false, closeConfirmed: false, readingSafe: true };
const same = (a, b) => a.dev === b.dev && a.ino === b.ino;
const text = "task input";
const counts = { fixtureOpens: 0, fixtureCloses: 0, reads: 0, callbacks: 0, childInvocations: 0, bindings: 0, refused: 0, removed: 0 };
async function createFixture() {
  fixture.parent = await realpath(tmpdir());
  fixture.root = await mkdtemp(join(fixture.parent, "sp-task-binding-"));
  console.log(JSON.stringify({ createdRoot: fixture.root }));
  fixture.rootId = await lstat(fixture.root, { bigint: true });
  fixture.leaf = join(fixture.root, "notes.txt");
  fixture.handle = await open(fixture.leaf, "wx"); counts.fixtureOpens++;
  try {
    fixture.leafId = await fixture.handle.stat({ bigint: true });
    await fixture.handle.writeFile(text);
    fixture.leafId = await fixture.handle.stat({ bigint: true });
  } finally {
    fixture.closeAttempted = true;
    await fixture.handle.close();
    fixture.closeConfirmed = true; fixture.handle = undefined; counts.fixtureCloses++;
  }
  console.log(JSON.stringify({ root: fixture.root, rootId: [String(fixture.rootId.dev), String(fixture.rootId.ino)],
    leaf: fixture.leaf, leafId: [String(fixture.leafId.dev), String(fixture.leafId.ino)] }));
}
async function removeFixture() {
  assert.ok(fixture.readingSafe && fixture.closeConfirmed && !fixture.handle, "Keep original fixture responsibility after unresolved read/close.");
  assert.ok(same(fixture.rootId, await lstat(fixture.root, { bigint: true })));
  assert.equal(dirname(resolve(fixture.root)), fixture.parent); assert.equal(await realpath(fixture.root), fixture.root);
  const leaf = await lstat(fixture.leaf, { bigint: true });
  assert.ok(same(fixture.leafId, leaf) && leaf.isFile() && !leaf.isSymbolicLink() && leaf.nlink === 1n);
  assert.equal(dirname(resolve(fixture.leaf)), fixture.root); assert.equal(await realpath(fixture.leaf), fixture.leaf);
  await unlink(fixture.leaf); counts.removed++;
  await assert.rejects(lstat(fixture.leaf), { code: "ENOENT" });
  assert.ok(same(fixture.rootId, await lstat(fixture.root, { bigint: true })));
  await rmdir(fixture.root); counts.removed++;
  await assert.rejects(lstat(fixture.root), { code: "ENOENT" });
}
function request(snapshot) {
  return { version: 1, profile: WINDOWS_SANDBOX_PROFILE.id, command: "Get-Content notes.txt", cwd: ".", timeoutMs: 2000,
    inputs: [{ path: "notes.txt", snapshot }],
    writes: [{ path: "notes.txt", operation: "modify", snapshot }, { path: "result.txt", operation: "add", snapshot: null }] };
}
function released(binding, sourceDisposals = 1) {
  const d = binding.diagnostics;
  assert.equal(d.pending, false); assert.equal(d.retainedSource, false); assert.equal(d.retainedSourceCheck, false);
  assert.equal(d.retainedRequest, false); assert.equal(d.receiptReferences, 0); assert.equal(d.toolReferences, 0);
  assert.equal(d.weakReferences, 0); assert.equal(d.metadataChars, 0); assert.equal(d.boundaryGeneration, -1);
  assert.equal(d.sourceDisposals, sourceDisposals);
  if (sourceDisposals) {
    assert.equal(d.source.weakReferences, 0); assert.equal(d.source.retainedVerifier, false); assert.equal(d.source.retainedMetadata, 0);
  } else assert.equal(d.source, undefined);
}
function refused(work) { assert.throws(work); counts.refused++; }
function finishErrors(failed, failure, cleanupErrors, message) {
  if (failed && cleanupErrors.length) throw new AggregateError([failure, ...cleanupErrors], message);
  if (failed) throw failure;
  if (cleanupErrors.length) throw new AggregateError(cleanupErrors, message);
}
async function runCases() {
  const events = createEventBus(), boundary = new SessionExecutionBoundary(), controller = new AbortController();
  const state = { active: true, session: "sandbox_task_contract" };
  const runtime = { executionBoundary: boundary, assertActive() { assert.equal(state.active, true); },
    trackEventBusSubscription(unsubscribe) { return unsubscribe; }, appendEntry() { throw new Error("Unexpected host write."); } };
  const files = new SessionFiles(runtime, events);
  runtime.nativeFiles = files;
  const ctx = { cwd: fixture.root, sessionManager: { getSessionId() { return state.session; } }, signal: controller.signal };
  const tools = { read: { async execute() { return { content: [{ type: "text", text }] }; } } };
  files.install(tools);
  const neverExecute = async () => { throw new Error("No shell or mutation dispatch in this contract."); };
  const catalog = [{ name: "powershell", execute: neverExecute }, { name: "file_batch", execute: neverExecute }];
  const dispatch = new NestedToolDispatch("sandbox-parent", () => catalog, async () => {
    counts.childInvocations++; throw new Error("Unexpected child invocation.");
  }, controller.signal);
  const bindings = [];
  let source, otherDispatch, evidence, failed = false, failure;
  const cleanupErrors = [];
  try {
    const emptyIntent = parseSandboxTaskRequest({ version: 1, profile: WINDOWS_SANDBOX_PROFILE.id,
      command: "Get-Date", cwd: ".", timeoutMs: 2000, inputs: [], writes: [] });
    const emptyState = { pending: 0, inFlight: 0, revisions: 0, closed: false };
    assert.deepEqual(files.getDiagnostics(), emptyState);
    const empty = new SandboxTaskBinding(emptyIntent, files, ctx, dispatch, "sandbox-parent", controller.signal, runtime);
    bindings.push(empty); counts.bindings++;
    assert.equal(await empty.run(async borrowed => {
      counts.callbacks++; assert.equal(borrowed.runtime, runtime); assert.equal(borrowed.assertInputsCurrent(), true);
      assert.deepEqual(files.getDiagnostics(), emptyState); return "no-input";
    }), "no-input");
    released(empty, 0); assert.deepEqual(files.getDiagnostics(), emptyState);

    fixture.readingSafe = false; counts.reads++;
    const read = await tools.read.execute("task-source-read", { path: "notes.txt" }, undefined, undefined, ctx);
    const snapshot = read[NATIVE_FILE_REVISION]; assert.match(snapshot, /^snap_[A-Za-z0-9_-]{22}$/);
    fixture.readingSafe = true;
    source = files.pinReadRevisions(ctx);
    const revisions = source.revisions, original = revisions.get(snapshot);
    assert.ok(original && original.canonicalPath === fixture.leaf && original.identity.size === 10n);

    const raw = request(snapshot), intent = parseSandboxTaskRequest(raw);
    raw.command = "changed"; raw.inputs[0].path = "changed.txt"; raw.writes.length = 0;
    assert.equal(intent.command, "Get-Content notes.txt"); assert.equal(intent.inputs[0].path, "notes.txt");
    assert.equal(intent.writes.length, 2); assert.ok(Object.isFrozen(intent.inputs[0]));
    assert.equal(sandboxGuestCwd(intent), "C:\\SuperPiVolume\\workspace");
    assert.equal(sandboxGuestCwd(parseSandboxTaskRequest({ ...request(snapshot), cwd: "src" })), "C:\\SuperPiVolume\\workspace\\src");
    const invalid = [
      { ...request(snapshot), authorized: true },
      { ...request(snapshot), profile: "trusted-host" },
      { ...request(snapshot), command: "x".repeat(8193) },
      { ...request(snapshot), command: "\ud800" },
      { ...request(snapshot), timeoutMs: 30001 },
      { ...request(snapshot), cwd: "../outside" },
      { ...request(snapshot), writes: [{ path: "notes.txt", operation: "modify", snapshot: "snap_AAAAAAAAAAAAAAAAAAAAAA" }] },
      { ...request(snapshot), writes: [{ path: "notes.txt", operation: "add", snapshot: null }] },
      { ...request(snapshot), inputs: [{ path: "secret.key", snapshot }], writes: [] },
      { ...request(snapshot), inputs: [{ path: "a", snapshot }, { path: "a/b", snapshot }], writes: [] },
      { ...request(snapshot), inputs: [{ path: "notes.txt", snapshot }, { path: "NOTES.txt", snapshot }], writes: [] },
    ];
    for (const value of invalid) refused(() => parseSandboxTaskRequest(value));
    let getterCalls = 0;
    const getter = request(snapshot);
    Object.defineProperty(getter, "command", { enumerable: true, get() { getterCalls++; return "bad"; } });
    refused(() => parseSandboxTaskRequest(getter));
    assert.equal(getterCalls, 0);

    const make = (signal = controller.signal, selected = intent, execution = dispatch) => {
      const binding = new SandboxTaskBinding(selected, files, ctx, execution, "sandbox-parent", signal, runtime);
      bindings.push(binding); counts.bindings++; return binding;
    };
    refused(() => new SandboxTaskBinding(JSON.parse(JSON.stringify(intent)), files, ctx, dispatch, "sandbox-parent", controller.signal, runtime));
    refused(() => new SandboxTaskBinding(intent, files, ctx, dispatch, "wrong-parent", controller.signal, runtime));
    refused(() => make(controller.signal, parseSandboxTaskRequest(request("snap_AAAAAAAAAAAAAAAAAAAAAA"))));

    const normal = make();
    assert.equal(await normal.run(async borrowed => {
      counts.callbacks++; assert.equal(borrowed.files, files); assert.equal(borrowed.ctx, ctx); assert.equal(borrowed.runtime, runtime);
      assert.equal(borrowed.execution, dispatch); assert.equal(borrowed.signal, controller.signal);
      assert.equal(borrowed.assertInputsCurrent(), true); return 42;
    }), 42);
    released(normal);
    await assert.rejects(normal.run(neverExecute)); counts.refused++;

    const thrown = make();
    let sawFalsy = false;
    try { await thrown.run(async () => { counts.callbacks++; throw 0; }); } catch (error) { assert.equal(error, 0); sawFalsy = true; }
    assert.ok(sawFalsy); released(thrown);

    const changedMethod = make(), method = dispatch.callTool;
    dispatch.callTool = neverExecute;
    refused(changedMethod.assertSessionCurrent); released(changedMethod);
    dispatch.callTool = method;

    const changedTool = make(), shell = catalog[0];
    catalog[0] = { name: "powershell", execute: neverExecute };
    refused(changedTool.assertSessionCurrent); released(changedTool); catalog[0] = shell;

    otherDispatch = new NestedToolDispatch("sandbox-parent", () => catalog, neverExecute, controller.signal);
    const closedParent = make(controller.signal, intent, otherDispatch);
    await otherDispatch.close();
    refused(closedParent.assertSessionCurrent); released(closedParent);

    const changedSession = make();
    state.session = "another_session";
    refused(changedSession.assertSessionCurrent); released(changedSession);
    state.session = "sandbox_task_contract";

    const cancelled = new AbortController(), pending = make(cancelled.signal);
    let finish, borrowedWhilePending;
    const gate = new Promise(resolveGate => { finish = resolveGate; });
    const result = pending.run(async borrowed => { counts.callbacks++; borrowedWhilePending = borrowed; await gate; });
    // Observe this exact result before assertions can fail; always release its gate
    // and await settlement before the outer owner cleanup can begin.
    const observed = result.then(value => ({ ok: true, value }), error => ({ ok: false, error }));
    let pendingFailed = false, pendingFailure;
    const settlementErrors = [];
    try {
      assert.equal(pending.diagnostics.pending, true);
      cancelled.abort(); pending.dispose();
      assert.equal(pending.diagnostics.state, "closing"); assert.equal(pending.diagnostics.retainedSource, true);
      refused(borrowedWhilePending.assertSessionCurrent);
    } catch (error) { pendingFailed = true; pendingFailure = error;
    } finally {
      finish();
      const settled = await observed;
      try {
        assert.equal(settled.ok, false, "The cancelled original borrow must reject.");
        assert.ok(settled.error instanceof Error && /SANDBOX_BINDING_STALE|aborted/i.test(settled.error.message));
        counts.refused++;
      } catch (error) { settlementErrors.push(error); }
      borrowedWhilePending = undefined;
      try { released(pending); } catch (error) { settlementErrors.push(error); }
    }
    finishErrors(pendingFailed, pendingFailure, settlementErrors, "Pending assertions and original settlement failed.");

    const consumed = make(), stale = make();
    assert.equal(await consumed.run(async borrowed => {
      counts.callbacks++; borrowed.assertInputsCurrent();
      revisions.forget(snapshot); // Simulates receipt consumption, not a host write.
      assert.equal(borrowed.assertSessionCurrent(), true); return "consumed";
    }), "consumed");
    released(consumed);
    await assert.rejects(stale.run(neverExecute)); counts.refused++; released(stale);
    const oldBoundary = make(controller.signal, emptyIntent);
    await boundary.transition(() => undefined);
    await assert.rejects(oldBoundary.run(neverExecute)); counts.refused++; released(oldBoundary, 0);
    assert.equal(counts.childInvocations, 0);
    evidence = { weak: [new WeakRef(intent), new WeakRef(normal), new WeakRef(files), new WeakRef(ctx), new WeakRef(dispatch)],
      lifecycleCases: 11, invalidRequests: invalid.length + 1, sourceAfterDispose: normal.diagnostics.source };
  } catch (error) { failed = true; failure = error;
  } finally {
    const clean = async action => { try { await action(); } catch (error) { cleanupErrors.push(error); } };
    for (const binding of bindings) await clean(() => binding.dispose());
    await clean(() => source?.dispose());
    await clean(() => otherDispatch?.close()); await clean(() => dispatch.close());
    await clean(() => files.dispose()); await clean(() => boundary.dispose()); await clean(() => events.clear());
    await clean(() => assert.deepEqual(files.getDiagnostics(), { pending: 0, inFlight: 0, revisions: 0, closed: true }));
    await clean(() => assert.equal(boundary.participantCount, 0)); await clean(() => assert.equal(boundary.hasDeadline, false));
  }
  finishErrors(failed, failure, cleanupErrors, "Binding cases and registered owner cleanup failed.");
  return evidence;
}
test("bounded sandbox intent and original parent binding", async () => {
  const workerBefore = nativeFileDiagnostics();
  let evidence, failed = false, failure, cleanupFailed = false, cleanupFailure;
  try {
    await createFixture(); evidence = await runCases();
  } catch (error) { failed = true; failure = error;
  } finally {
    if (fixture.root) try { await removeFixture(); }
    catch (error) { cleanupFailed = true; cleanupFailure = error; }
  }
  if (failed && cleanupFailed) throw new AggregateError([failure, cleanupFailure], "Binding contract and exact fixture cleanup failed.");
  if (failed) throw failure;
  if (cleanupFailed) throw cleanupFailure;
  let gc = null;
  if (typeof globalThis.gc === "function") {
    for (let round = 0; round < 4; round++) { await tick(); globalThis.gc(); await tick(); }
    const live = evidence.weak.filter(value => value.deref() !== undefined).length;
    assert.equal(live, 0); gc = { rounds: 4, targets: evidence.weak.length, live };
  }
  const worker = nativeFileDiagnostics();
  assert.equal(worker.workerStarts - workerBefore.workerStarts, 0);
  assert.equal(worker.calls - workerBefore.calls, 0); assert.equal(worker.pending, 0);
  assert.equal(counts.fixtureOpens, 1); assert.equal(counts.fixtureCloses, 1);
  assert.equal(counts.reads, 1); assert.equal(counts.removed, 2); assert.equal(counts.childInvocations, 0);
  assert.equal(counts.bindings, 11); assert.equal(counts.callbacks, 5); assert.equal(counts.refused, 24);
  const line = JSON.stringify({ ...counts, lifecycleCases: evidence.lifecycleCases, invalidRequests: evidence.invalidRequests,
    gc, workerStarts: 0, workerCalls: 0, sourceReleased: evidence.sourceAfterDispose,
    root: fixture.root, leaf: fixture.leaf, permissionOrGuestExecutionVerified: false, implicitOsIoInstrumented: false });
  assert.ok(Buffer.byteLength(line) <= 2048); console.log(line);
});
