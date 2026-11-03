import assert from "node:assert/strict";
import test, { before, after } from "node:test";
import { mkdtemp, open, lstat, realpath, unlink, rmdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setImmediate as tick } from "node:timers/promises";
import { SessionFiles } from "../packages/coding-agent/src/core/files/session-files.ts";
import { SessionExecutionBoundary } from "../packages/coding-agent/src/core/execution-boundary.ts";
import { createEventBus } from "../packages/coding-agent/src/core/event-bus.ts";
import { NATIVE_FILE_REVISION } from "../packages/coding-agent/src/core/files/file-host.ts";
import { nativeFileDiagnostics } from "../packages/coding-agent/src/core/files/native-file-client.ts";
import { INPUT_LIMITS, OfflineInputSnapshotOwner } from "../scripts/acceptance/windows-sandbox-input-snapshot.mjs";
import { OriginalInputRevisionLease } from "../scripts/acceptance/windows-sandbox-input-revision-lease.mjs";

// One recorded synthetic root/5B leaf, at most 32 installed compatibility reads.
// Real SessionFiles + SessionExecutionBoundary; controlled minimal runtime and read
// implementation. This is not the full native read, authorization or Windows safe open.
const text = "alpha", initialSession = "source_session";
let parent, root, leaf, rootIdentity, leafIdentity, leafCreated = false, reads = 0, readingSafe = true;
let releasedRoots = 0, releasedLeaves = 0;
const creation = { handle: undefined, operationFailed: false, operationError: undefined,
    closeFailed: false, closeError: undefined, closeAttempted: false, closeConfirmed: false };
const same = (a, b) => a.dev === b.dev && a.ino === b.ino;
const identity = a => ({ dev: a.dev, ino: a.ino, size: a.size, mtimeNs: a.mtimeNs, ctimeNs: a.ctimeNs });
const workerBefore = nativeFileDiagnostics();
before(async () => {
    parent = await realpath(tmpdir()); root = await mkdtemp(join(parent, "sp-input-session-"));
    console.log(JSON.stringify({ createdSyntheticRoot: root }));
    rootIdentity = await lstat(root, { bigint: true });
    assert.ok(rootIdentity.isDirectory() && !rootIdentity.isSymbolicLink());
    assert.equal(dirname(resolve(root)), parent);
    leaf = join(root, "source.txt"); creation.handle = await open(leaf, "wx"); leafCreated = true;
    try {
        leafIdentity = await creation.handle.stat({ bigint: true });
        await creation.handle.writeFile(text);
        leafIdentity = await creation.handle.stat({ bigint: true });
    } catch (error) { creation.operationFailed = true; creation.operationError = error; }
    creation.closeAttempted = true;
    try { await creation.handle.close(); creation.closeConfirmed = true; creation.handle = undefined; }
    catch (error) { creation.closeFailed = true; creation.closeError = error; }
    if (creation.operationFailed && creation.closeFailed) throw new AggregateError([creation.operationError, creation.closeError], "creation and close failed");
    if (creation.operationFailed) throw creation.operationError;
    if (creation.closeFailed) throw creation.closeError;
});
after(async () => {
    if (root) {
        assert.ok(readingSafe && (!leafCreated || creation.closeConfirmed), `unconfirmed read/close; retain ${root}`);
        assert.ok(rootIdentity && same(rootIdentity, await lstat(root, { bigint: true })));
        assert.equal(dirname(resolve(root)), parent); assert.equal(await realpath(root), root);
        if (leafCreated) {
            const observed = await lstat(leaf, { bigint: true });
            assert.ok(leafIdentity && same(leafIdentity, observed) && observed.isFile() && !observed.isSymbolicLink());
            assert.equal(dirname(resolve(leaf)), root); assert.equal(await realpath(leaf), leaf);
            await unlink(leaf); releasedLeaves++;
            await assert.rejects(lstat(leaf), { code: "ENOENT" });
        }
        assert.ok(same(rootIdentity, await lstat(root, { bigint: true })));
        await rmdir(root); releasedRoots++;
        await assert.rejects(lstat(root), { code: "ENOENT" });
    }
    const workerAfter = nativeFileDiagnostics();
    const workerStartsDelta = workerAfter.workerStarts - workerBefore.workerStarts;
    const workerCallsDelta = workerAfter.calls - workerBefore.calls;
    assert.equal(workerStartsDelta, 0); assert.equal(workerCallsDelta, 0); assert.equal(workerAfter.pending, 0);
    console.log(JSON.stringify({ reads, logicalReceiptBytes: reads * 5, maximumReads: 32, maximumLogicalBytes: 160,
        root, leaf, releasedRoots, releasedLeaves, creationCloseAttempted: creation.closeAttempted,
        creationCloseConfirmed: creation.closeConfirmed, creationHandleRetained: creation.handle !== undefined,
        creationOperationFailed: creation.operationFailed, creationCloseFailed: creation.closeFailed,
        workerStartsDelta, workerCallsDelta, workerPending: workerAfter.pending, issuerOsIoInstrumented: false }));
});
function released(source) {
    assert.equal(source.diagnostics.weakReferences, 0); assert.equal(source.diagnostics.retainedVerifier, false);
    assert.equal(source.diagnostics.retainedMetadata, 0);
}
function stale(source) {
    assert.throws(source.current); released(source);
    assert.throws(() => source.revisions); released(source);
}
function host(t, signal) {
    const events = createEventBus(), executionBoundary = new SessionExecutionBoundary();
    const state = { active: true, session: initialSession, hook: undefined };
    const runtime = { executionBoundary, assertActive() {
        state.hook?.(); if (!state.active) throw new Error("runtime-inactive");
    }, trackEventBusSubscription(unsubscribe) { return unsubscribe; }, appendEntry() { throw new Error("unexpected journal write"); } };
    const owner = new SessionFiles(runtime, events);
    const ctx = { cwd: root, sessionManager: { getSessionId() { return state.session; } }, signal };
    const tools = { read: { async execute() { return { content: [{ type: "text", text }] }; } } };
    owner.install(tools);
    async function dispose() {
        state.hook = undefined;
        await owner.dispose(); await executionBoundary.dispose(); events.clear();
        assert.deepEqual(owner.getDiagnostics(), { pending: 0, inFlight: 0, revisions: 0, closed: true });
        assert.equal(executionBoundary.participantCount, 0); assert.equal(executionBoundary.hasDeadline, false);
    }
    if (t) t.after(dispose);
    async function read(context = ctx) {
        assert.ok(readingSafe && reads < 32); reads++; readingSafe = false;
        const result = await tools.read.execute("source-read", { path: "source.txt" }, undefined, undefined, context);
        const id = result[NATIVE_FILE_REVISION]; assert.match(id, /^snap_[A-Za-z0-9_-]{22}$/);
        readingSafe = true; return id;
    }
    return { owner, runtime, executionBoundary, state, ctx, tools, read, dispose };
}
async function fixture(t, signal) {
    const f = host(t, signal), id = await f.read(), source = f.owner.pinReadRevisions(f.ctx);
    if (t) t.after(() => source.dispose());
    const revisions = source.revisions, receipt = revisions.get(id);
    assert.equal(receipt.mode, "full"); assert.equal(receipt.bytes.toString(), text);
    assert.equal(receipt.canonicalPath, leaf); assert.ok(same(receipt.identity, leafIdentity));
    return { ...f, source, revisions, receipt, id };
}

test("session source 1: no service is created, installed read supplies exact original owner", async t => {
    const f = host(t);
    assert.throws(() => f.owner.pinReadRevisions(f.ctx), /STALE_STATE/);
    assert.deepEqual(f.owner.getDiagnostics(), { pending: 0, inFlight: 0, revisions: 0, closed: false });
    const id = await f.read(), source = f.owner.pinReadRevisions(f.ctx); t.after(() => source.dispose());
    const revisions = source.revisions;
    assert.ok(revisions.get(id)); assert.equal(source.current(), true); assert.equal(source.revisions, revisions);
    f.owner.assertCurrent = () => { throw new Error("instance override must not run"); };
    assert.equal(source.current(), true);
    const active = source.diagnostics; assert.equal(active.weakReferences, 6);
    source.dispose(); released(source); stale(source);
    t.diagnostic(JSON.stringify({ active, disposed: source.diagnostics, serviceCreatedByPin: false }));
});
test("session source 2: runtime failures preserve Error and falsy thrown values and never revive", async t => {
    for (const error of [new Error("runtime-original"), undefined, null, 0]) {
        const f = await fixture(t); f.state.hook = () => { throw error; };
        let caught = false;
        try { f.source.current(); } catch (actual) { caught = true; assert.equal(actual, error); }
        assert.equal(caught, true); released(f.source); f.state.hook = undefined; stale(f.source);
    }
});
test("session source 3: boundary transition, resumption and replacement do not revive the old source", async t => {
    const f = await fixture(t);
    const transition = f.executionBoundary.transition(() => undefined);
    stale(f.source); await transition; stale(f.source);
    await f.read(); const fresh = f.owner.pinReadRevisions(f.ctx); t.after(() => fresh.dispose());
    assert.equal(fresh.current(), true);
    const replacement = new SessionExecutionBoundary(); f.runtime.executionBoundary = replacement;
    stale(fresh); f.runtime.executionBoundary = f.executionBoundary;
    await replacement.dispose(); stale(fresh);
});
test("session source 4: cwd/session changes and public read service replacement reject original identity", async t => {
    for (const change of ["cwd", "session", "service"]) {
        const f = await fixture(t);
        if (change === "cwd") f.ctx.cwd = root + "-other";
        if (change === "session") f.state.session = "other_session";
        if (change === "service") {
            const next = { cwd: root, sessionManager: { getSessionId() { return "other_session"; } }, signal: undefined };
            await f.read(next);
        }
        stale(f.source); f.ctx.cwd = root; f.state.session = initialSession; stale(f.source);
    }
});
test("session source 5: revision/reset/dispose and fixed signal identity including absent signal", async t => {
    for (const change of ["clear", "dispose", "reset", "abort", "replace-signal", "remove-signal", "add-signal"]) {
        const controller = new AbortController(), f = await fixture(t, change === "add-signal" ? undefined : controller.signal);
        assert.equal(f.source.diagnostics.weakReferences, change === "add-signal" ? 6 : 7);
        if (change === "clear") f.revisions.clear();
        if (change === "dispose") await f.owner.dispose();
        if (change === "reset") await f.owner.emit({ type: "session_before_switch" });
        if (change === "abort") controller.abort();
        if (change === "replace-signal" || change === "add-signal") f.ctx.signal = new AbortController().signal;
        if (change === "remove-signal") f.ctx.signal = undefined;
        stale(f.source); f.ctx.signal = change === "add-signal" ? undefined : controller.signal; stale(f.source);
    }
});
test("session source 6: pin and current reentry, getter revocation/close and initialization failure", async t => {
    const f = await fixture(t);
    Object.defineProperty(f.ctx, "signal", { configurable: true, get() {
        assert.throws(() => f.owner.pinReadRevisions(f.ctx), /STALE_STATE/); return undefined;
    } });
    assert.throws(() => f.owner.pinReadRevisions(f.ctx), /STALE_STATE/);
    Object.defineProperty(f.ctx, "signal", { configurable: true, writable: true, value: undefined });
    const next = f.owner.pinReadRevisions(f.ctx);
    let runtimeCalls = 0;
    f.state.hook = () => { if (++runtimeCalls === 2) f.ctx.signal = new AbortController().signal; };
    stale(next); assert.equal(runtimeCalls, 2);
    f.state.hook = undefined; f.ctx.signal = undefined; next.dispose(); released(next);
    for (const action of ["reentry", "revoke", "close", "runtime-invalidate"]) {
        const g = await fixture(t); let pending;
        Object.defineProperty(g.ctx, "cwd", { configurable: true, get() {
            if (action === "reentry") assert.throws(g.source.current, /STALE_STATE/);
            if (action === "revoke") g.source.revoke();
            if (action === "close") pending ??= g.owner.dispose();
            if (action === "runtime-invalidate") g.state.active = false;
            return root;
        } });
        stale(g.source); if (pending) await pending;
    }
    f.state.active = false; assert.throws(() => f.owner.pinReadRevisions(f.ctx), /runtime-inactive/);
});
function inputContext(f) {
    return { taskId: "11111111-2222-3333-4444-555555555555", snapshotId: "22222222-3333-4444-5555-666666666666",
        epoch: f.revisions.generation, sessionId: initialSession, sourceRoot: { path: root, identity: { dev: rootIdentity.dev, ino: rootIdentity.ino } },
        budget: { ...INPUT_LIMITS }, entries: [{ path: "source.txt", expose: true, operation: "modify", classification: "ordinary",
            parents: [], revision: f.id, identity: identity(f.receipt.identity), sha256: f.receipt.sha256 }] };
}
function reader(f, context, lease, invalidate) {
    const token = {}, borrowed = [], counts = { opens: 0, reads: 0, bytes: 0, closes: 0 };
    const observed = () => ({ canonicalPath: leaf, identity: { ...context.entries[0].identity }, kind: "file", nlink: 1, reparseTag: 0 });
    const io = {
        current(binding) { return lease.current(binding); }, revision(entry, binding) { return lease.revision(entry, binding); },
        directory(name) { assert.equal(name, ""); return { canonicalPath: root, identity: { ...context.sourceRoot.identity }, kind: "directory", reparseTag: 0 }; },
        file() { return observed(); }, open() { counts.opens++; return token; },
        read(handle, output, offset, length) {
            assert.equal(handle, token); const count = Math.min(2, length); borrowed.push(output);
            output.write(text.slice(offset, offset + count), offset, count, "ascii"); counts.reads++; counts.bytes += count;
            if (invalidate) f.state.active = false; return count;
        }, stat(handle) { assert.equal(handle, token); return observed(); },
        close(handle) { assert.equal(handle, token); counts.closes++; return true; },
    };
    return { io, borrowed, counts };
}
test("session source 7: real source + original lease + input model clear bytes on success and host invalidation", async t => {
    for (const invalidated of [false, true]) {
        const f = await fixture(t), context = inputContext(f);
        const lease = new OriginalInputRevisionLease(context, f.source.revisions, f.source.current);
        t.after(() => lease.dispose());
        const model = reader(f, context, lease, invalidated), input = new OfflineInputSnapshotOwner(context, model.io);
        const result = input.capture();
        if (invalidated) { assert.equal(result.status, "rejected"); released(f.source); }
        else { const copy = input.copyFile(0); assert.equal(copy.toString(), text); copy.fill(0); }
        input.dispose(); lease.dispose();
        assert.equal(input.diagnostics.allocatedBytes, 5); assert.equal(input.diagnostics.clearedBytes, 5);
        assert.equal(input.diagnostics.retainedBuffers, 0); assert.equal(input.diagnostics.retainedIO, false);
        assert.equal(model.counts.closes, 1); for (const bytes of model.borrowed) assert.ok(bytes.every(value => value === 0));
        t.diagnostic(JSON.stringify({ invalidated, model: model.counts, input: input.diagnostics, source: f.source.diagnostics, actualReaderOsHandles: 0 }));
    }
});
test("session source 8: live source does not retain retired session/runtime/receipt bytes", async t => {
    assert.equal(typeof global.gc, "function");
    async function retire() {
        const f = await fixture(undefined);
        const refs = [f.owner, f.runtime, f.executionBoundary, f.ctx, f.revisions, f.receipt, f.receipt.bytes].map(value => new WeakRef(value));
        await f.dispose();
        return { source: f.source, refs };
    }
    const retired = await retire();
    for (let i = 0; i < 4; i++) { await tick(); global.gc(); }
    const live = retired.refs.filter(ref => ref.deref() !== undefined).length;
    assert.equal(live, 0); stale(retired.source); retired.source.dispose(); released(retired.source);
    t.diagnostic(JSON.stringify({ controlledGcRounds: 4, originalTargets: retired.refs.length, live, disposed: retired.source.diagnostics }));
});
