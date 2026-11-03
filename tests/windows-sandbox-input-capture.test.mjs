import assert from "node:assert/strict";
import test, { before, after, afterEach } from "node:test";
import { mkdtemp, open, lstat, realpath, unlink, rmdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname, resolve, parse } from "node:path";
import { setImmediate as tick } from "node:timers/promises";
import { SessionFiles } from "../packages/coding-agent/src/core/files/session-files.ts";
import { SessionExecutionBoundary } from "../packages/coding-agent/src/core/execution-boundary.ts";
import { createEventBus } from "../packages/coding-agent/src/core/event-bus.ts";
import { NATIVE_FILE_REVISION } from "../packages/coding-agent/src/core/files/file-host.ts";
import { nativeFileDiagnostics } from "../packages/coding-agent/src/core/files/native-file-client.ts";
import { INPUT_LIMITS, OfflineInputSnapshotOwner } from "../scripts/acceptance/windows-sandbox-input-snapshot.mjs";
import { WindowsSourceNative } from "../scripts/acceptance/windows-sandbox-source-native.mjs";
import { WindowsInputCapture } from "../scripts/acceptance/windows-sandbox-input-capture.mjs";

// Exactly one root + one 5B synthetic file. Real SessionFiles/boundary, controlled
// runtime/basic installed read issuer and explicit synchronous permission callback.
// Model ops below NEVER operate on actual HANDLEs. No previous test is imported/run.
const text = "alpha", sessionId = "input_capture", uuid = "11111111-2222-4333-8444-555555555555";
const id = value => ({ dev: value.dev, ino: value.ino });
const fileId = value => ({ ...id(value), size: value.size, mtimeNs: value.mtimeNs, ctimeNs: value.ctimeNs });
const same = (a, b) => a.dev === b.dev && a.ino === b.ino;
let parent, root, leaf, rootId, leafId, anchor, rootCreated = false, leafCreated = false;
let safe = true, acquire = true, fixtureHandle, fixtureOpens = 0, fixtureCloseAttempts = 0, fixtureClosed = 0;
let rootRemoved = false, leafRemoved = false, rootRemoveAttempted = false, leafRemoveAttempted = false;
let issuances = 0, realReaders = 0, nativeBytes = 0, reportBytes = 0, callerCopies = 0, callerCleared = 0;
let bootstrapDiagnostics;
const errors = [], realReports = [], unknownActual = [], unknownModels = [];
const realOwners = [], hostOwners = new Set();
const workerBefore = nativeFileDiagnostics();
function report(value) {
    const line = JSON.stringify(value); reportBytes += Buffer.byteLength(line) + 1;
    assert.ok(reportBytes <= 24576, "owned JSON budget"); console.log(line);
}
function live() { assert.ok(safe && acquire, "no acquisition after unresolved/failing fixture"); }
function registerReal(capture) {
    realOwners.push({ capture, attempted: false }); return capture;
}
function drainReal() {
    for (const record of realOwners) if (!record.attempted) {
        try { releaseReal(record.capture); }
        catch (error) { acquire = false; errors.push({ stage: "registered-capture-cleanup", error }); }
    }
}
afterEach(drainReal);
before(async () => {
    assert.equal(process.platform, "win32"); assert.equal(process.arch, "x64"); assert.equal(typeof global.gc, "function");
    try {
        parent = await realpath(tmpdir()); root = await mkdtemp(join(parent, "sp-input-capture-")); rootCreated = true;
        report({ createdRoot: root }); rootId = id(await lstat(root, { bigint: true }));
        assert.equal(dirname(resolve(root)), parent); leaf = join(root, "source.txt");
        fixtureHandle = await open(leaf, "wx"); fixtureOpens++; leafCreated = true;
        let operationFailed = false, operationError, closeFailed = false, closeError;
        try { leafId = id(await fixtureHandle.stat({ bigint: true })); await fixtureHandle.writeFile(text); }
        catch (error) { operationFailed = true; operationError = error; }
        fixtureCloseAttempts++;
        try { await fixtureHandle.close(); fixtureClosed++; fixtureHandle = undefined; }
        catch (error) { safe = false; closeFailed = true; closeError = error; }
        if (operationFailed || closeFailed) errors.push({ stage: "fixture", operationFailed, operationError, closeFailed, closeError });
        if (operationFailed && closeFailed) throw new AggregateError([operationError, closeError], "fixture operation/close");
        if (operationFailed) throw operationError; if (closeFailed) throw closeError;
        const drive = parse(root).root, identity = id(await lstat(drive, { bigint: true }));
        const bootstrap = new WindowsSourceNative();
        try { anchor = { drive, identity, volumePath: bootstrap.volumeForDrive(drive) }; }
        finally { bootstrap.dispose(); bootstrapDiagnostics = bootstrap.diagnostics; }
    } catch (error) { acquire = false; errors.push({ stage: "create/identify/bootstrap", error }); throw error; }
});
after(async () => {
    drainReal();
    // A failed assertion/setup must not skip another registered owner's cleanup.
    for (const record of hostOwners) try { await record.dispose(); }
    catch (error) { safe = false; acquire = false; errors.push({ stage: "registered-session-cleanup", error }); }
    if (safe) {
        if (leafCreated && leafId) try {
            leafRemoveAttempted = true;
            const parentNow = await lstat(root, { bigint: true }), actual = await lstat(leaf, { bigint: true });
            assert.ok(rootId && same(parentNow, rootId) && parentNow.isDirectory() && !parentNow.isSymbolicLink());
            assert.equal(await realpath(root), root); assert.equal(dirname(resolve(leaf)), root);
            assert.ok(same(actual, leafId) && actual.isFile() && !actual.isSymbolicLink()); assert.equal(await realpath(leaf), leaf);
            await unlink(leaf); leafRemoved = true; await assert.rejects(lstat(leaf), { code: "ENOENT" });
        } catch (error) { errors.push({ stage: "leaf-cleanup", path: leaf, error }); }
        if (rootCreated && rootId) try {
            rootRemoveAttempted = true;
            const actual = await lstat(root, { bigint: true });
            assert.ok(same(actual, rootId) && actual.isDirectory() && !actual.isSymbolicLink());
            assert.equal(dirname(resolve(root)), parent); assert.equal(await realpath(root), root);
            await rmdir(root); rootRemoved = true; await assert.rejects(lstat(root), { code: "ENOENT" });
        } catch (error) { errors.push({ stage: "root-cleanup", path: root, error }); }
    }
    const workers = nativeFileDiagnostics();
    report({ root, leaf, rootCreated, leafCreated, rootIdentified: !!rootId, leafIdentified: !!leafId,
        rootRemoved, leafRemoved, rootRemoveAttempted, leafRemoveAttempted, safe, errors: errors.map(e => ({ stage: e.stage, path: e.path })),
        fixtureOpens, fixtureCloseAttempts, fixtureClosed, fixtureHandleRetained: fixtureHandle !== undefined,
        issuances, logicalReceiptBytes: issuances * 5, wrapperIssuances: 0, realReaders, nativeBytes,
        callerCopies, callerCleared, unknownActual: unknownActual.length, modelUnknownOwners: unknownModels.length,
        registeredRealOwners: realOwners.length, unattemptedRealOwners: realOwners.filter(item => !item.attempted).length,
        unresolvedSessionOwners: hostOwners.size,
        bootstrapDiagnostics, workerStartsDelta: workers.workerStarts - workerBefore.workerStarts,
        workerCallsDelta: workers.calls - workerBefore.calls, workerPending: workers.pending,
        implicitNodeOsIoInstrumented: false, businessChildCalls: "none in audited source", realReports });
    assert.equal(errors.length, 0); assert.equal(safe, true); assert.equal(rootRemoved, true); assert.equal(leafRemoved, true);
    assert.equal(fixtureOpens, 1); assert.equal(fixtureCloseAttempts, 1); assert.equal(fixtureClosed, 1);
    assert.ok(issuances <= 10 && realReaders <= 8 && nativeBytes <= 40); assert.equal(callerCopies, callerCleared);
    assert.equal(workers.workerStarts - workerBefore.workerStarts, 0); assert.equal(workers.calls - workerBefore.calls, 0);
    assert.equal(workers.pending, 0); assert.equal(unknownActual.length, 0);
});

async function host(t) {
    live(); const events = createEventBus(), boundary = new SessionExecutionBoundary();
    const state = { active: true };
    const runtime = { executionBoundary: boundary, assertActive() { assert.ok(state.active); },
        trackEventBusSubscription(value) { return value; }, appendEntry() { throw new Error("unexpected journal write"); } };
    let owner, ownerAttempted = false, boundaryAttempted = false, ownerClosed = false, boundaryClosed = false;
    const disposalErrors = [], record = { dispose };
    hostOwners.add(record);
    const ctx = { cwd: root, sessionManager: { getSessionId() { return sessionId; } }, signal: undefined };
    const tools = { read: { async execute() { return { content: [{ type: "text", text }] }; } } };
    async function dispose() {
        if (!ownerAttempted) {
            ownerAttempted = true;
            try { if (owner) await owner.dispose(); ownerClosed = !owner || owner.getDiagnostics().closed; }
            catch (error) { disposalErrors.push(error); }
        }
        if (!boundaryAttempted) {
            boundaryAttempted = true;
            try { await boundary.dispose(); boundaryClosed = boundary.participantCount === 0; }
            catch (error) { disposalErrors.push(error); }
        }
        events.clear();
        if (ownerClosed && boundaryClosed) hostOwners.delete(record);
        else { safe = false; acquire = false; }
        if (disposalErrors.length) throw new AggregateError(disposalErrors, "original session cleanup errors");
        assert.equal(ownerClosed, true); assert.equal(boundaryClosed, true);
    }
    if (t) t.after(dispose);
    try {
        owner = new SessionFiles(runtime, events); owner.install(tools);
        assert.ok(issuances < 10); issuances++;
        const result = await tools.read.execute("capture-fixture-read", { path: "source.txt" }, undefined, undefined, ctx);
        const revision = result[NATIVE_FILE_REVISION]; assert.match(revision, /^snap_[A-Za-z0-9_-]{22}$/);
        const source = owner.pinReadRevisions(ctx);
        let revisions, receipt;
        try { revisions = source.revisions; receipt = revisions.get(revision); }
        finally { source.dispose(); }
        assert.equal(receipt.mode, "full"); assert.equal(receipt.bytes.toString(), text); assert.equal(receipt.canonicalPath, leaf);
        assert.ok(same(receipt.identity, leafId));
        return { owner, runtime, boundary, ctx, revisions, receipt, revision, state, dispose };
    } catch (error) {
        acquire = false;
        try { await dispose(); } catch (cleanupError) { throw new AggregateError([error, cleanupError], "session setup and cleanup"); }
        throw error;
    }
}
function inputFor(f) {
    return { taskId: uuid, snapshotId: uuid, sessionId, epoch: f.revisions.generation,
        sourceRoot: { path: root, identity: { ...rootId } }, budget: { ...INPUT_LIMITS },
        entries: [{ path: "source.txt", classification: "ordinary", expose: true, operation: "modify", parents: [],
            revision: f.revision, identity: fileId(f.receipt.identity), sha256: f.receipt.sha256 }] };
}
function wrapper(f, authorize = () => true, operations, input = inputFor(f)) {
    live(); const capture = new WindowsInputCapture(input, anchor, f.owner.pinReadRevisions(f.ctx), authorize, operations);
    return operations ? capture : registerReal(capture);
}
function releaseReal(capture) {
    const record = realOwners.find(item => item.capture === capture); assert.ok(record, "original registered capture");
    if (record.attempted) return;
    record.attempted = true;
    let closed = false, disposalFailed = false, disposalError;
    try { closed = capture.dispose(); } catch (error) { disposalFailed = true; disposalError = error; }
    const diag = capture.diagnostics, reader = diag.reader;
    if (!closed || diag.cleanup !== "complete") { safe = false; acquire = false; unknownActual.push(capture); }
    if (disposalFailed) { errors.push({ stage: "capture-dispose", error: disposalError }); throw disposalError; }
    assert.equal(closed, true); assert.equal(diag.cleanup, "complete");
    if (reader) {
        realReaders++; nativeBytes += reader.readBytes; realReports.push(reader);
        assert.ok(realReaders <= 8 && nativeBytes <= 40);
        assert.equal(reader.activeHandles, 0); assert.equal(reader.opened, reader.closed); assert.equal(reader.closeAttempts, reader.closed);
        assert.equal(reader.retainedSlots, 0); assert.equal(reader.retainedGuard, false); assert.equal(reader.retainedOperations, false);
        assert.equal(reader.native.allocatedScratch, reader.native.releasedScratch); assert.equal(reader.native.retainedScratch, 0);
        assert.ok(reader.native.calls <= 8192 && reader.openAttempts <= 256 && reader.peakHandles <= 82);
    }
    if (diag.input) assert.equal(diag.input.retainedBytes, 0);
    assert.equal(diag.retainedSource, false); assert.equal(diag.retainedLease, false); assert.equal(diag.retainedInput, false);
}

test("capture 1: original session lease + actual native capture, same-token stat and one copy", async t => {
    const f = await host(t), original = inputFor(f);
    let permissions = 0;
    const capture = wrapper(f, (binding, entries) => {
        permissions++; assert.ok(Object.isFrozen(binding) && Object.isFrozen(entries) && Object.isFrozen(entries[0]));
        assert.equal(binding.taskId, uuid); assert.equal(binding.snapshotId, uuid); assert.equal(binding.sessionId, sessionId);
        assert.equal(binding.epoch, f.revisions.generation); assert.equal(entries[0].operation, "modify");
        assert.equal(binding.sourceRoot.path, root); assert.equal(entries[0].path, "source.txt"); assert.equal(entries[0].expose, true);
        return true;
    }, undefined, original);
    original.entries[0].path = "changed.txt"; original.sourceRoot.path = "C:\\Changed";
    try {
        assert.deepEqual(capture.capture(), { status: "captured", cleanup: "complete" });
        assert.equal(capture.diagnostics.samePathStats, 1); assert.ok(permissions > 0);
        const bytes = capture.copyFile(0); callerCopies += bytes.length;
        try { assert.equal(bytes.toString(), text); } finally { bytes.fill(0); callerCleared += bytes.length; }
        assert.throws(() => capture.copyFile(0), /copy-limit/);
        assert.equal(capture.diagnostics.reader.status, "closed");
    } finally { releaseReal(capture); }
});

test("capture 2: initial authorization/source/lease/schema refusals never start native I/O", async t => {
    const f = await host(t);
    for (const kind of ["denied", "promise", "source", "epoch", "empty", "add"]) {
        const input = inputFor(f), source = f.owner.pinReadRevisions(f.ctx);
        if (kind === "source") source.revoke(); if (kind === "epoch") input.epoch++;
        if (kind === "empty") input.entries = [];
        if (kind === "add") input.entries = [{ path: "new.txt", parents: [], classification: "ordinary", expose: false,
            operation: "add", revision: null, identity: null, sha256: null }];
        const capture = registerReal(new WindowsInputCapture(input, anchor, source, () => kind === "promise" ? Promise.resolve(true) : kind !== "denied"));
        assert.equal(capture.capture().status, "rejected"); assert.equal(capture.diagnostics.reader, undefined);
        assert.equal(capture.diagnostics.retainedSource, false); assert.equal(source.diagnostics.weakReferences, 0); releaseReal(capture);
    }
    const source = f.owner.pinReadRevisions(f.ctx), invalid = inputFor(f); invalid.entries[0].classification = "secret";
    assert.throws(() => new WindowsInputCapture(invalid, anchor, source, () => true)); assert.equal(source.diagnostics.weakReferences, 0);
    assert.throws(() => new WindowsInputCapture(inputFor(f), anchor, { current() { return true; } }, () => true), /original source/);
    const forgotten = wrapper(f); f.revisions.forget(f.revision);
    assert.equal(forgotten.capture().status, "rejected"); assert.equal(forgotten.diagnostics.reader, undefined); releaseReal(forgotten);
    report({ initialRefusals: 9, nativeReaders: 0, compactBaseline: "unchanged original full-only lease gate; no fabricated compact receipt" });
});

test("capture 3: permission loss immediately after actual read clears all private bytes", async t => {
    const f = await host(t); let capture;
    capture = wrapper(f, () => (capture.diagnostics.reader?.readBytes ?? 0) === 0);
    try {
        assert.equal(capture.capture().status, "rejected"); const d = capture.diagnostics;
        assert.equal(d.reader.readBytes, 5); assert.equal(d.input.allocatedBytes, 5); assert.equal(d.input.clearedBytes, 5);
        assert.equal(d.reader.clearedBorrowedBytes, 5); assert.equal(d.exportedBytes, 0);
        assert.throws(() => capture.copyFile(0)); report({ readAfterRefusal: d.input, borrowedClearOverlapsPrivate: true });
    } finally { releaseReal(capture); }
});

test("capture 4: all native closes are confirmed before final permission can still reject", async t => {
    const f = await host(t); let capture;
    capture = wrapper(f, () => capture.diagnostics.reader?.status !== "closed");
    try {
        assert.equal(capture.capture().status, "rejected"); const d = capture.diagnostics;
        assert.equal(d.reader.status, "closed"); assert.equal(d.reader.activeHandles, 0);
        assert.equal(d.input.clearedBytes, 5); assert.equal(d.input.retainedBytes, 0); assert.equal(d.exportedBytes, 0);
        report({ postCloseRejected: true, input: d.input });
    } finally { releaseReal(capture); }
});

test("capture 5: post-copy permission loss zeroes the actual new copy and private input", async t => {
    const f = await host(t); let capture, rejectedCopy;
    capture = wrapper(f, () => (capture.diagnostics.input?.exportedBytes ?? 0) === 0);
    const originalCopy = OfflineInputSnapshotOwner.prototype.copyFile;
    try {
        assert.equal(capture.capture().status, "captured");
        // Observe the actual returned internal copy, preserving original implementation.
        // Serial test restores this test-only observer before leaving the group.
        OfflineInputSnapshotOwner.prototype.copyFile = function(index) { rejectedCopy = originalCopy.call(this, index); return rejectedCopy; };
        assert.throws(() => capture.copyFile(0), /permission denied/);
        assert.ok(rejectedCopy.every(value => value === 0)); assert.equal(rejectedCopy.length, 5);
        assert.equal(capture.diagnostics.rejectedCopyBytes, 5); assert.equal(capture.diagnostics.exportedBytes, 0);
        assert.equal(capture.diagnostics.input.clearedBytes, 5);
        report({ rejectedCopyObservedZero: rejectedCopy.length, privateCleared: capture.diagnostics.input.clearedBytes });
    } finally { OfflineInputSnapshotOwner.prototype.copyFile = originalCopy; rejectedCopy = undefined; releaseReal(capture); }
});

function modelOps(input) {
    let next = 0n, calls = 0, closes = 0, disposed = false, readBytes = 0, reads = 0, disposeCalls = 0;
    const handles = new Map(), borrowed = [], closeCounts = new Map();
    const ops = {
        openHook: undefined, inspectHook: undefined, closeHook: undefined, disposeHook: undefined,
        volumeForDrive() { calls++; return anchor.volumePath; },
        open(slot) {
            calls++; const handle = ++next, directory = slot.kind === "directory";
            const identity = slot.expected ? { ...slot.expected } : { dev: anchor.identity.dev, ino: 100000n + next };
            if (directory) Object.assign(identity, { size: 0n, mtimeNs: 1000n, ctimeNs: 1000n });
            const value = { kind: directory ? "directory" : "file", openKind: slot.kind, attributes: directory ? 16 : 128,
                identity, reparseTag: 0, nlink: 1, guidPath: slot.guidPath, dosPath: slot.dosPath, position: 0 };
            handles.set(handle, value); slot.handle = handle; slot.closeable = true; slot.status = 0; slot.information = 1n;
            ops.openHook?.(slot, value); return true;
        },
        inspect(handle) { calls++; const value = handles.get(handle); ops.inspectHook?.(value); return { ...value, identity: { ...value.identity } }; },
        read(handle, bytes, offset, length) {
            calls++; reads++; const value = handles.get(handle), count = Math.min(2, length);
            bytes.write(text.slice(value.position, value.position + count), offset, count, "ascii"); value.position += count;
            borrowed.push(bytes); readBytes += count; return count;
        },
        close(handle) {
            closes++; closeCounts.set(handle, (closeCounts.get(handle) ?? 0) + 1);
            ops.closeHook?.(handle, handles.get(handle)); assert.equal(handles.delete(handle), true); return true;
        },
        dispose() { disposeCalls++; ops.disposeHook?.(); disposed = true; },
        get diagnostics() { return { calls, closeCalls: closes, active: handles.size, readBytes, reads, disposed, disposeCalls }; },
        borrowed, closeCounts,
    };
    return ops;
}
test("capture 6: model partial/preflight/leaf/pending Unknown preserves original native responsibility", async t => {
    const f = await host(t);
    for (const scene of ["partial", "preflight", "leaf", "pending"]) {
        const input = inputFor(f), ops = modelOps(input);
        if (scene === "partial" || scene === "pending") ops.openHook = (slot, value) => {
            if (value.dosPath === "\\\\?\\" + root) {
                if (scene === "pending") { slot.closeable = false; slot.status = 0x103; }
                throw undefined;
            }
        };
        if (scene === "preflight") ops.inspectHook = value => { if (value.kind === "file") throw null; };
        ops.closeHook = (_handle, value) => {
            if (scene === "leaf" ? value.openKind === "read" : scene !== "pending" && value.dosPath === "\\\\?\\" + root) throw 0;
        };
        const capture = wrapper(f, () => true, ops, input);
        assert.deepEqual(capture.capture(), { status: "rejected", cleanup: "unknown" }); unknownModels.push(capture);
        const failure = capture.failure, d = capture.diagnostics;
        assert.equal(d.retainedReader, true); assert.equal(d.reader.retainedOperations, true);
        assert.equal(failure.native.unresolved.length, 1); const slot = failure.native.unresolved[0];
        if (scene === "pending") { assert.equal(slot.closeable, false); assert.equal(slot.attempted, false); assert.equal(slot.status, 0x103); }
        else { assert.equal(slot.attempted, true); assert.equal(slot.closeError, 0); }
        if (scene === "partial" || scene === "pending") assert.equal(failure.operationError, undefined);
        if (scene === "preflight") { assert.equal(failure.input.operationError, null); assert.equal(d.input.cleanup, "complete"); }
        if (scene === "leaf") { assert.equal(d.input.cleanup, "unknown"); assert.equal(d.input.clearedBytes, 5); }
        for (const bytes of ops.borrowed) assert.ok(bytes.every(value => value === 0));
        const before = ops.diagnostics.closeCalls; assert.equal(capture.dispose(), false); assert.equal(capture.dispose(), false);
        assert.equal(ops.diagnostics.closeCalls, before); for (const count of ops.closeCounts.values()) assert.equal(count, 1);
        report({ model: scene, unknownSlots: 1, originalFalsyPreserved: true, inputCleanup: d.input?.cleanup,
            inputCleared: d.input?.clearedBytes ?? 0, closeAttempts: before, actualHandles: 0 });
    }
    const input = inputFor(f), disposalOps = modelOps(input);
    disposalOps.disposeHook = () => { throw null; };
    const disposal = wrapper(f, () => true, disposalOps, input);
    assert.deepEqual(disposal.capture(), { status: "rejected", cleanup: "unknown" }); unknownModels.push(disposal);
    const failure = disposal.failure, held = disposal.diagnostics;
    assert.equal(failure.operationFailed, true); assert.equal(failure.operationError, null);
    assert.equal(failure.cleanupFailed, true); assert.equal(failure.cleanupError, null);
    assert.equal(held.reader.activeHandles, 0); assert.equal(failure.native.unresolved.length, 0);
    assert.equal(held.reader.retainedOperations, true); assert.equal(held.input.clearedBytes, 5);
    const closeCalls = disposalOps.diagnostics.closeCalls;
    assert.equal(disposal.dispose(), false); assert.equal(disposal.dispose(), false);
    assert.equal(disposalOps.diagnostics.disposeCalls, 1); assert.equal(disposalOps.diagnostics.closeCalls, closeCalls);
    for (const bytes of disposalOps.borrowed) assert.ok(bytes.every(value => value === 0));
    report({ model: "dispose", unknownHandles: 0, retainedClosedSlots: held.reader.retainedSlots,
        retainedOperations: true, nativeDisposeCalls: 1, cleanupErrorIsNull: true, privateCleared: 5 });

    const settleOps = modelOps(input); let metadataOpens = 0, settleInjected = false;
    settleOps.openHook = slot => {
        if (slot.kind === "metadata" && ++metadataOpens === 4) { settleInjected = true; throw 0; }
    };
    settleOps.closeHook = () => { if (settleInjected) for (const bytes of settleOps.borrowed) assert.ok(bytes.every(value => value === 0)); };
    const settle = wrapper(f, () => true, settleOps, input);
    assert.deepEqual(settle.capture(), { status: "rejected", cleanup: "complete" });
    assert.equal(settleInjected, true); assert.equal(settle.failure.operationError, 0);
    assert.equal(settle.failure.cleanupFailed, false); assert.equal(settle.diagnostics.input.clearedBytes, 5);
    assert.equal(settleOps.diagnostics.active, 0); assert.equal(settleOps.diagnostics.disposeCalls, 1);
    assert.equal(settle.dispose(), true); assert.equal(settleOps.diagnostics.disposeCalls, 1);
    report({ model: "settle-recheck", metadataOpens, clearedBeforeRemainingClose: true, activeHandles: 0 });
});

test("capture 7: model short reads/stat, namespace rejection and falsy/reentrant guards", async t => {
    const f = await host(t), input = inputFor(f), ops = modelOps(input), capture = wrapper(f, () => true, ops, input);
    assert.equal(capture.capture().status, "captured"); assert.equal(capture.diagnostics.samePathStats, 1);
    assert.equal(ops.diagnostics.reads, 3); assert.equal(capture.dispose(), true);
    for (const bytes of ops.borrowed) assert.ok(bytes.every(value => value === 0));
    const wrongOps = modelOps(input); wrongOps.inspectHook = value => { if (value.kind === "file") value.dosPath += "-wrong"; };
    const wrong = wrapper(f, () => true, wrongOps, input); assert.equal(wrong.capture().status, "rejected");
    assert.equal(wrongOps.diagnostics.reads, 0); assert.equal(wrong.dispose(), true);
    for (const original of [undefined, null, 0]) {
        const guardOps = modelOps(input), failed = wrapper(f, () => { throw original; }, guardOps, input);
        assert.equal(failed.capture().status, "rejected"); assert.equal(failed.failure.operationFailed, true);
        assert.equal(failed.failure.operationError, original); assert.equal(guardOps.diagnostics.calls, 0); assert.equal(failed.dispose(), true);
    }
    for (const action of ["reenter", "revoke", "dispose"]) {
        let current; current = wrapper(f, () => {
            if (action === "reenter") { try { current.capture(); } catch {} }
            if (action === "revoke") current.revoke(); if (action === "dispose") current.dispose(); return true;
        }, modelOps(input), input);
        assert.equal(current.capture().status, "rejected"); assert.throws(() => current.capture()); assert.equal(current.dispose(), true);
    }
    for (const action of ["deny", "reenter", "revoke"]) {
        const duringOps = modelOps(input); let during, injected = false;
        during = wrapper(f, () => {
            if (duringOps.diagnostics.readBytes === 0) return true;
            injected = true; assert.equal(during.diagnostics.input.retainedBytes, 5);
            assert.ok(duringOps.diagnostics.active > 0);
            const closes = duringOps.diagnostics.closeCalls;
            if (action === "reenter") { try { during.copyFile(0); } catch {} }
            if (action === "revoke") during.revoke();
            assert.equal(duringOps.diagnostics.closeCalls, closes, "no cleanup inside active reader callback");
            return action !== "deny";
        }, duringOps, input);
        assert.deepEqual(during.capture(), { status: "rejected", cleanup: "complete" }); assert.equal(injected, true);
        assert.equal(duringOps.diagnostics.reads, 1); assert.equal(duringOps.diagnostics.readBytes, 2);
        assert.equal(during.diagnostics.input.clearedBytes, 5); assert.equal(during.diagnostics.exportedBytes, 0);
        for (const bytes of duringOps.borrowed) assert.ok(bytes.every(value => value === 0));
        assert.equal(duringOps.diagnostics.active, 0); assert.throws(() => during.capture()); assert.equal(during.dispose(), true);
        report({ modelDuringRead: action, reads: 1, modelReadBytes: 2, privateCleared: 5, synchronousCleanupDeferred: true });
    }
    const forgetOps = modelOps(input); let forgotten;
    forgotten = wrapper(f, () => {
        if (forgetOps.diagnostics.readBytes > 0) f.revisions.forget(f.revision);
        return true;
    }, forgetOps, input);
    assert.deepEqual(forgotten.capture(), { status: "rejected", cleanup: "complete" });
    assert.match(forgotten.failure.operationError.message, /original lease changed/);
    assert.equal(forgetOps.diagnostics.reads, 1); assert.equal(forgetOps.diagnostics.readBytes, 2);
    assert.equal(forgotten.diagnostics.input.clearedBytes, 5); assert.equal(forgetOps.diagnostics.active, 0);
    assert.equal(f.revisions.get(f.revision), undefined); assert.throws(() => forgotten.capture()); assert.equal(forgotten.dispose(), true);
    report({ modelShortReads: 3, sameTokenStats: 1, wrongNamespaceReads: 0, falsyGuards: 3,
        swallowedReentryDoesNotRevive: true, callbackForgetRejectedByPostLease: true, refreshedReceipts: 0 });
});

test("capture 8: live captured wrapper does not retain retired original session or receipt bytes", async () => {
    async function retire() {
        let f, capture;
        try {
            f = await host(); const input = inputFor(f), authorize = () => true;
            capture = wrapper(f, authorize, undefined, input);
            const refs = [f.owner, f.runtime, f.boundary, f.ctx, f.revisions, f.receipt, f.receipt.bytes, input].map(value => new WeakRef(value));
            assert.equal(capture.capture().status, "captured"); await f.dispose(); return { capture, refs };
        } catch (error) {
            const failures = [error];
            if (capture) try { releaseReal(capture); } catch (cleanupError) { failures.push(cleanupError); }
            if (f) try { await f.dispose(); } catch (cleanupError) { failures.push(cleanupError); }
            if (failures.length > 1) throw new AggregateError(failures, "retirement and independent cleanup");
            throw error;
        }
    }
    const retired = await retire();
    try {
        for (let round = 0; round < 4; round++) { await tick(); global.gc(); await tick(); }
        assert.equal(retired.refs.filter(ref => ref.deref() !== undefined).length, 0);
        assert.equal(retired.capture.diagnostics.input.retainedBytes, 5);
        assert.throws(() => retired.capture.copyFile(0)); assert.equal(retired.capture.diagnostics.input.retainedBytes, 0);
        assert.equal(retired.capture.diagnostics.retainedAuthorization, false);
        report({ controlledGcRounds: 4, originalTargets: 8, liveOriginalTargets: 0, capturedWrapperKeptAlive: true,
            authorizationReferenceReleased: true, privateBytesAfterStaleCopy: 0 });
    } finally { releaseReal(retired.capture); }
});
