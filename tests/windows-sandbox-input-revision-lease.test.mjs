import assert from "node:assert/strict";
import test, { before, after } from "node:test";
import { mkdtemp, open, lstat, realpath, unlink, rmdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setImmediate as tick } from "node:timers/promises";
import { FileRevisions, issueSnapshotForRead } from "../packages/coding-agent/src/core/files/snapshot-line-edit.ts";
import { nativeFileDiagnostics } from "../packages/coding-agent/src/core/files/native-file-client.ts";
import { INPUT_LIMITS, OfflineInputSnapshotOwner } from "../scripts/acceptance/windows-sandbox-input-snapshot.mjs";
import { OriginalInputRevisionLease } from "../scripts/acceptance/windows-sandbox-input-revision-lease.mjs";

// One host-created synthetic root / one five-byte leaf, at most 64 compatibility
// issuance calls (320 logical source bytes). No real project or native worker calls.
// Issuer internals are not instrumented: these are calls/receipt bytes, not OS I/O counts.
const text = "alpha", sessionId = "lease_session";
const taskId = "11111111-2222-3333-4444-555555555555", snapshotId = "22222222-3333-4444-5555-666666666666";
let parent, root, leaf, rootIdentity, leafIdentity, leafCreated = false, issued = 0, releasedRoots = 0, releasedLeaves = 0;
let issuanceUsable = true;
function creationState(handle) {
    return { handle, identity: undefined, closeAttempted: false, closeConfirmed: false,
        operationFailed: false, operationError: undefined, closeFailed: false, closeError: undefined };
}
const creation = creationState(undefined);
// Same helper for the one real creation handle and in-memory dual-failure fixtures.
async function initializeLeaf(state) {
    try {
        state.identity = await state.handle.stat({ bigint: true });
        await state.handle.writeFile(text);
        state.identity = await state.handle.stat({ bigint: true });
    } catch (error) { state.operationFailed = true; state.operationError = error; }
    state.closeAttempted = true;
    try { await state.handle.close(); state.closeConfirmed = true; state.handle = undefined; }
    catch (error) { state.closeFailed = true; state.closeError = error; }
    if (state.operationFailed && state.closeFailed) throw new AggregateError([state.operationError, state.closeError], "creation operation and close failed");
    if (state.operationFailed) throw state.operationError;
    if (state.closeFailed) throw state.closeError;
}
const workerBefore = nativeFileDiagnostics();
const sameObject = (a, b) => a.dev === b.dev && a.ino === b.ino;
const fileIdentity = info => ({ dev: info.dev, ino: info.ino, size: info.size, mtimeNs: info.mtimeNs, ctimeNs: info.ctimeNs });

before(async () => {
    parent = await realpath(tmpdir());
    root = await mkdtemp(join(parent, "sp-input-lease-"));
    console.log(JSON.stringify({ createdSyntheticRoot: root }));
    rootIdentity = await lstat(root, { bigint: true });
    assert.ok(rootIdentity.isDirectory() && !rootIdentity.isSymbolicLink());
    assert.equal(dirname(resolve(root)), parent);
    leaf = join(root, "source.txt");
    creation.handle = await open(leaf, "wx"); leafCreated = true;
    try { await initializeLeaf(creation); }
    finally { leafIdentity = creation.identity; }
});
after(async () => {
    // Identity mismatch is a cleanup failure, never permission to delete another object.
    if (root) {
        assert.ok(!leafCreated || creation.closeConfirmed, `creation close unknown; retain ${root}`);
        assert.ok(issuanceUsable, `issuance incomplete; retain ${root}`);
        assert.ok(rootIdentity, "root identity must have been recorded before cleanup");
        assert.equal(dirname(resolve(root)), parent);
        assert.ok(sameObject(rootIdentity, await lstat(root, { bigint: true })));
        assert.equal(await realpath(root), root);
        if (leafCreated) {
            assert.equal(dirname(resolve(leaf)), root);
            const observed = await lstat(leaf, { bigint: true });
            assert.ok(leafIdentity && sameObject(leafIdentity, observed) && observed.isFile() && !observed.isSymbolicLink());
            await unlink(leaf); releasedLeaves++;
            await assert.rejects(lstat(leaf), { code: "ENOENT" });
        }
        assert.ok(sameObject(rootIdentity, await lstat(root, { bigint: true })));
        await rmdir(root); releasedRoots++;
        await assert.rejects(lstat(root), { code: "ENOENT" });
    }
    const workerAfter = nativeFileDiagnostics();
    assert.equal(workerAfter.workerStarts - workerBefore.workerStarts, 0);
    assert.equal(workerAfter.calls - workerBefore.calls, 0);
    assert.equal(workerAfter.pending, 0);
    console.log(JSON.stringify({ issuance: { calls: issued, receiptBytes: issued * 5, maximumCalls: 64,
        maximumReceiptBytes: 320, root, leaf, releasedRoots, releasedLeaves }, nativeWorkerStartsDelta: 0,
        nativeWorkerCallsDelta: 0, issuerOsIoInstrumented: false, creationCloseAttempted: creation.closeAttempted,
        creationCloseConfirmed: creation.closeConfirmed, creationHandleRetained: creation.handle !== undefined,
        creationOperationFailed: creation.operationFailed, creationCloseFailed: creation.closeFailed }));
});

async function fixture(t, guard = () => true) {
    const owner = new FileRevisions(sessionId);
    if (t) t.after(() => owner.dispose());
    assert.ok(issuanceUsable, "prior issuance incomplete; no further source read");
    assert.ok(issued < 64); issued++; issuanceUsable = false;
    // Known host-written text with no MUTATION_READ_SOURCE: this deliberately tests
    // the existing compatibility issuer, not the complete native read tool pipeline.
    const result = { content: [{ type: "text", text }] };
    const annotation = await issueSnapshotForRead(sessionId, root, { path: "source.txt" }, result, owner);
    assert.ok(annotation);
    const id = /snapshot=(snap_[A-Za-z0-9_-]{22})/.exec(annotation)[1];
    const receipt = owner.get(id);
    assert.equal(receipt.mode, "full"); assert.equal(receipt.bytes.toString(), text);
    assert.equal(receipt.canonicalPath, leaf); assert.ok(sameObject(receipt.identity, leafIdentity));
    issuanceUsable = true;
    const context = { taskId, snapshotId, epoch: owner.generation, sessionId,
        sourceRoot: { path: root, identity: { dev: rootIdentity.dev, ino: rootIdentity.ino } },
        budget: { ...INPUT_LIMITS }, entries: [{ path: "source.txt", operation: "modify", expose: true,
            classification: "ordinary", parents: [], revision: id, identity: fileIdentity(receipt.identity), sha256: receipt.sha256 }] };
    const lease = new OriginalInputRevisionLease(context, owner, guard);
    if (t) t.after(() => lease.dispose());
    return { owner, context, receipt, lease, id };
}
function released(lease) {
    const d = lease.diagnostics;
    assert.equal(d.retainedEntries, 0); assert.equal(d.metadataCharge, 0);
    assert.equal(d.weakReferences, 0); assert.equal(d.retainedGuard, false);
}
function modelReader(f, duringRead, closeUnknown = false) {
    const handles = new Set(), borrowed = [], counts = { open: 0, read: 0, close: 0 };
    const observe = () => ({ canonicalPath: leaf, identity: { ...f.context.entries[0].identity }, kind: "file", nlink: 1, reparseTag: 0 });
    const io = {
        current(binding) { return f.lease.current(binding); },
        revision(entry, binding) { return f.lease.revision(entry, binding); },
        directory(name) { assert.equal(name, ""); return { canonicalPath: root, identity: { ...f.context.sourceRoot.identity }, kind: "directory", reparseTag: 0 }; },
        file(name) { assert.equal(name, "source.txt"); return observe(); },
        open(name) { assert.equal(name, "source.txt"); counts.open++; const token = {}; handles.add(token); return token; },
        read(token, output, offset, length) {
            assert.ok(handles.has(token)); counts.read++; borrowed.push(output);
            const count = Math.min(2, length); output.write(text.slice(offset, offset + count), offset, count, "ascii");
            duringRead?.(); return count;
        },
        stat(token) { assert.ok(handles.has(token)); return observe(); },
        close(token) { assert.ok(handles.has(token)); counts.close++; if (closeUnknown) return false; handles.delete(token); return true; },
    };
    return { io, counts, borrowed, handles };
}

test("lease 1: real compatibility-issued receipt, exact original owner and fixed methods", async t => {
    const f = await fixture(t);
    assert.equal(f.lease.current(f.context), true);
    assert.equal(f.lease.revision(f.context.entries[0], f.context), true);
    const another = new FileRevisions(sessionId); t.after(() => another.dispose());
    assert.throws(() => new OriginalInputRevisionLease(f.context, another, () => true), /lease-baseline/);
    for (const disposed of [false, true]) for (const allNew of [false, true]) {
        const emptyOwner = new FileRevisions(sessionId); if (disposed) emptyOwner.dispose();
        const context = structuredClone(f.context); context.epoch = emptyOwner.generation;
        context.entries = allNew ? [{ ...context.entries[0], operation: "add", expose: false, revision: null, identity: null, sha256: null }] : [];
        assert.throws(() => new OriginalInputRevisionLease(context, emptyOwner, () => true), /lease-existing-required/);
        emptyOwner.dispose();
    }
    f.owner.get = () => { throw new Error("must use original get"); };
    f.owner.assertCurrent = () => { throw new Error("must use original assertCurrent"); };
    f.owner.latest = () => { throw new Error("must not choose latest"); };
    assert.equal(f.lease.current(f.context), true);
    const retained = f.lease.diagnostics;
    f.lease.dispose(); released(f.lease);
    assert.equal(f.receipt.bytes.toString(), text); // Lease never owns or erases receipt bytes.
    t.diagnostic(JSON.stringify({ normal: retained, disposed: f.lease.diagnostics }));
});

test("lease 2: forget, invalidatePath, same-ID replacement and capacity eviction with unchanged epoch", async t => {
    for (const kind of ["forget", "invalidate", "replace", "evict"]) {
        const f = await fixture(t), epoch = f.owner.generation;
        if (kind === "forget") f.owner.forget(f.id);
        if (kind === "invalidate") f.owner.invalidatePath(leaf);
        // Constructed objects are adversarial store mutations, never issued positive evidence.
        if (kind === "replace") f.owner.remember({ ...f.receipt }, epoch);
        if (kind === "evict") for (let i = 0; i < 128; i++) f.owner.remember({ ...f.receipt, id: `negative-${i}`, residentBytes: 0 }, epoch);
        assert.equal(f.owner.generation, epoch);
        assert.equal(f.lease.current(f.context), false, kind); released(f.lease);
    }
});

test("lease 3: clear and dispose advance the generation and irrevocably invalidate the lease", async t => {
    for (const action of ["clear", "dispose"]) {
        const f = await fixture(t), epoch = f.owner.generation;
        f.owner[action](); assert.equal(f.owner.generation, epoch + 1);
        assert.equal(f.lease.current(f.context), false); released(f.lease);
        assert.equal(f.lease.revision(f.context.entries[0], f.context), false);
    }
});

test("lease 4: immutable baseline, receipt fields, task/root association and entry mutations", async t => {
    const mutations = [r => r.id += "x", r => r.sessionId = "other", r => r.canonicalPath += "x",
        r => r.sha256 = "a".repeat(64), ...["dev", "ino", "size", "mtimeNs", "ctimeNs"].map(key => r => r.identity[key]++),
        r => r.mode = "compact", r => r.residentBytes++, r => r.bytes = Buffer.from(r.bytes)];
    for (const mutate of mutations) {
        const f = await fixture(t); mutate(f.receipt);
        assert.equal(f.lease.current(f.context), false); released(f.lease);
    }
    const f = await fixture(t), binding = structuredClone(f.context);
    f.context.entries[0].sha256 = "b".repeat(64);
    assert.equal(f.lease.current(binding), true); // Constructor copied metadata, never follows caller replacement.
    assert.equal(f.lease.revision(f.context.entries[0], binding), false); released(f.lease);
    for (const mutate of [b => b.taskId = snapshotId, b => b.snapshotId = taskId, b => b.sessionId = "other",
        b => b.epoch++, b => b.sourceRoot.path += "x", b => b.sourceRoot.identity.ino++]) {
        const f = await fixture(t), changed = structuredClone(f.context); mutate(changed);
        assert.equal(f.lease.current(changed), false); released(f.lease);
    }
});

test("lease 5: host non-true, throws, synchronous reentry/revoke and owner changes fail closed", async t => {
    for (const value of [false, undefined, Promise.resolve(true)]) {
        let active = true; const f = await fixture(t, () => active ? true : value); active = false;
        assert.equal(f.lease.current(f.context), false); released(f.lease);
    }
    for (const thrown of [new Error("host stale"), null, undefined, 0]) {
        let active = true; const f = await fixture(t, () => { if (!active) throw thrown; return true; }); active = false;
        let caught = false;
        try { f.lease.current(f.context); } catch (error) { caught = true; assert.equal(error, thrown); }
        assert.equal(caught, true); released(f.lease);
    }
    for (const action of ["reentry", "revoke", "forget", "binding"]) {
        let f; f = await fixture(t, () => {
            if (f) {
                if (action === "reentry") assert.equal(f.lease.current(f.context), false);
                if (action === "revoke") f.lease.revoke();
                if (action === "forget") f.owner.forget(f.id);
                if (action === "binding") f.context.taskId = snapshotId;
            }
            return true;
        });
        assert.equal(f.lease.current(f.context), false); released(f.lease);
    }
    // No actual I/O: demonstrate independent original errors and retained close responsibility.
    for (const operationError of [new Error("write failed"), undefined, null, 0]) {
        const closeError = new Error("close failed"); let closeCalls = 0;
        const handle = { async stat() { return { dev: 1n, ino: 2n }; },
            async writeFile() { throw operationError; }, async close() { closeCalls++; throw closeError; } };
        const state = creationState(handle);
        await assert.rejects(initializeLeaf(state), error => error instanceof AggregateError
            && error.errors[0] === operationError && error.errors[1] === closeError);
        assert.equal(state.operationError, operationError); assert.equal(state.closeError, closeError);
        assert.equal(state.operationFailed, true); assert.equal(state.closeFailed, true);
        assert.equal(state.handle, handle); assert.equal(state.closeConfirmed, false); assert.equal(closeCalls, 1);
    }
});

test("lease 6: composition captures bytes, and in-read lease loss rejects and clears the whole capture", async t => {
    const f = await fixture(t), reader = modelReader(f), input = new OfflineInputSnapshotOwner(f.context, reader.io);
    assert.equal(input.capture(), input);
    const copy = input.copyFile(0); assert.equal(copy.toString(), text); copy.fill(0);
    const before = input.diagnostics;
    input.dispose(); f.lease.dispose(); released(f.lease);
    assert.equal(input.diagnostics.retainedBytes, 0); assert.equal(reader.handles.size, 0);
    for (const bytes of reader.borrowed) assert.ok(bytes.every(value => value === 0));
    const changed = await fixture(t), changingReader = modelReader(changed, () => changed.owner.forget(changed.id));
    const rejected = new OfflineInputSnapshotOwner(changed.context, changingReader.io);
    assert.equal(rejected.capture().status, "rejected");
    assert.equal(rejected.diagnostics.allocatedBytes, 5); assert.equal(rejected.diagnostics.clearedBytes, 5);
    assert.equal(rejected.diagnostics.retainedIO, false); assert.equal(changingReader.handles.size, 0);
    for (const bytes of changingReader.borrowed) assert.ok(bytes.every(value => value === 0));
    released(changed.lease); rejected.dispose();
    t.diagnostic(JSON.stringify({ captured: before, afterDispose: input.diagnostics, inReadInvalidation: rejected.diagnostics,
        successfulModelCalls: reader.counts, invalidatedModelCalls: changingReader.counts, actualReaderOsHandles: 0 }));
});

test("lease 7: terminal lease release does not erase the input owner's Unknown close responsibility", async t => {
    const f = await fixture(t), reader = modelReader(f, undefined, true), input = new OfflineInputSnapshotOwner(f.context, reader.io);
    assert.equal(input.capture().cleanup, "unknown"); assert.equal(reader.counts.close, 1);
    const token = input.failure.retainedHandle;
    f.lease.revoke(); f.lease.dispose(); released(f.lease);
    input.dispose(); input.revoke();
    assert.equal(input.failure.retainedHandle, token); assert.equal(reader.counts.close, 1);
    assert.equal(input.diagnostics.retainedIO, true); assert.equal(input.diagnostics.clearedBytes, 5);
    assert.equal(input.diagnostics.retainedBuffers, 0); assert.equal(reader.handles.size, 1);
    assert.equal(f.lease.current(f.context), false);
    t.diagnostic(JSON.stringify({ unknownModel: input.diagnostics, leaseReleased: f.lease.diagnostics, actualOsHandles: 0 }));
});

test("lease 8: disposal releases callback/metadata and weak pins do not retain retired source bytes", async t => {
    assert.equal(typeof global.gc, "function", "the reviewed command requires --expose-gc");
    async function retire() {
        const f = await fixture(undefined);
        const refs = [new WeakRef(f.owner), new WeakRef(f.receipt), new WeakRef(f.receipt.bytes)];
        f.owner.clear();
        // Keep the lease alive across GC; it must not keep the original owner or receipt alive.
        return { lease: f.lease, binding: structuredClone(f.context), refs };
    }
    const retired = await retire();
    for (let i = 0; i < 4; i++) { await tick(); global.gc(); }
    assert.equal(retired.refs.filter(ref => ref.deref() !== undefined).length, 0);
    assert.equal(retired.lease.current(retired.binding), false); released(retired.lease);
    retired.lease.dispose(); released(retired.lease);
    t.diagnostic(JSON.stringify({ controlledGcRounds: 4, retiredReferences: 3, liveRetiredReferences: 0,
        disposed: retired.lease.diagnostics }));
});
