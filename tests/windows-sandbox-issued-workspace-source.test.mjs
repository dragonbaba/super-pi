// New §56 issuance integration evidence only; preserves the failed §55 run and file.
import assert from "node:assert/strict";
import test, { before, after, afterEach } from "node:test";
import { mkdtemp, mkdir, open, lstat, realpath, unlink, rmdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname, resolve, parse, relative } from "node:path";
import { registerHooks } from "node:module";
import { setImmediate as tick } from "node:timers/promises";
import { types } from "node:util";
import { SessionFiles } from "../packages/coding-agent/src/core/files/session-files.ts";
import { SessionExecutionBoundary } from "../packages/coding-agent/src/core/execution-boundary.ts";
import { createEventBus } from "../packages/coding-agent/src/core/event-bus.ts";
import { NATIVE_FILE_REVISION } from "../packages/coding-agent/src/core/files/file-host.ts";
import { nativeFileDiagnostics } from "../packages/coding-agent/src/core/files/native-file-client.ts";
import { SessionPermissionState } from "../packages/extensions/resource-lifecycle-guard/permission-state.ts";
import { SessionInputWorkspacePermission } from "../packages/coding-agent/src/core/files/session-input-workspace-permission.ts";
import { INPUT_LIMITS } from "../scripts/acceptance/windows-sandbox-input-snapshot.mjs";
import { WindowsSourceReader } from "../scripts/acceptance/windows-sandbox-source-reader.mjs";
import { WindowsSourceNative } from "../scripts/acceptance/windows-sandbox-source-native.mjs";
import { WindowsWorkspaceSourceReader } from "../scripts/acceptance/windows-sandbox-workspace-source-reader.mjs";

const sourceUrls = new Map(["input-workspace-grant-lease", "session-input-read-permission"].map(name =>
    [`@super-pi/coding-agent/internal/files/${name}`, new URL(`../packages/coding-agent/src/core/files/${name}.ts`, import.meta.url).href]));
const loader = registerHooks({ resolve(specifier, context, next) {
    const url = sourceUrls.get(specifier); return url ? { url, shortCircuit: true } : next(specifier, context);
} });
let SessionPermissionController;
try { ({ SessionPermissionController } = await import("../packages/extensions/resource-lifecycle-guard/permission-controller.ts")); }
finally { loader.deregister(); }
const originalPrepare = SessionPermissionController.prototype.prepareInputWorkspaceRead;
const originalIssued = SessionPermissionState.prototype.getIssuedWorkspaceIdentity;
const originalAssessments = new WeakMap();
const id = stat => ({ dev: stat.dev, ino: stat.ino });
const fileId = stat => ({ ...id(stat), size: stat.size, mtimeNs: stat.mtimeNs, ctimeNs: stat.ctimeNs });
const same = (a, b) => a.dev === b.dev && a.ino === b.ino;
const loggedId = value => value ? { dev: String(value.dev), ino: String(value.ino) } : null;
const text = "alpha", sessionId = "issued_workspace_source", uuid = "11111111-2222-4333-8444-555555555555";
let parent, root, work, leaf, rootId, workId, leafId, anchor, bootstrap, bootstrapReport, bootstrapError;
let bootstrapDisposeAttempted = false;
const nodes = [], wrappers = new Set(), hosts = new Set(), pending = new Set(), errors = [], actualUnknown = [], modelUnknown = [];
const realRecords = [], modelRecords = [];
let safe = true, acquire = true, fixtureHandle, fixtureOpen = 0, fixtureCloseAttempted = 0, fixtureClosed = 0;
let issuances = 0, prepares = 0, assessments = 0, registered = 0, realReaders = 0, modelReaders = 0, reportBytes = 0, hostRequests = 0, originalIssuances = 0, modeledReadBytes = 0;
const workerBefore = nativeFileDiagnostics();
function live() { assert.ok(safe && acquire, "no new acquisition after unsafe fixture/actual cleanup"); }
function report(value) { const line = JSON.stringify(value); reportBytes += Buffer.byteLength(line) + 1; assert.ok(reportBytes <= 24576); console.log(line); }
function loggedValue(value, limit) {
    if (value === undefined) return { type: "undefined" };
    if (value === null || typeof value === "boolean") return value;
    if (typeof value === "string") return { type: "string", value: value.slice(0, limit), chars: value.length };
    if (typeof value === "number") return Number.isFinite(value) ? value : { type: "number", value: String(value) };
    return { type: typeof value };
}
function loggedError(value) {
    if (!types.isNativeError(value)) return loggedValue(value, 640);
    return { type: "nativeError", name: loggedValue(Object.getOwnPropertyDescriptor(value, "name")?.value ?? "Error", 64),
        code: loggedValue(Object.getOwnPropertyDescriptor(value, "code")?.value, 128),
        message: loggedValue(Object.getOwnPropertyDescriptor(value, "message")?.value, 640) };
}
function countedAssessment(path, cwd) { live(); assert.ok(assessments < 128); assessments++; return originalAssessments.get(this).call(this, path, cwd); }
function countedPrepare(ctx, paths) { live(); assert.ok(prepares < 40); prepares++; return originalPrepare.call(this, ctx, paths); }
async function run(value) { const promise = value.prepare(); pending.add(promise); try { return await promise; } finally { pending.delete(promise); } }
function create(f, ops, input = inputFor(f), selectedAnchor = anchor) {
    live(); const value = new WindowsWorkspaceSourceReader(input, selectedAnchor, f.owner, f.ctx, ops);
    wrappers.add({ value, ownerId: ++registered, model: !!ops, attempted: false, initialized: false }); return value;
}
function initialize(value) {
    live(); const record = [...wrappers].find(item => item.value === value); assert.ok(record && !record.initialized); record.initialized = true;
    if (record.model) { assert.ok(modelReaders < 12); modelReaders++; modelRecords.push(record); }
    else { assert.ok(realReaders < 3); realReaders++; realRecords.push(record); }
    return value.initialize();
}
function release(record) {
    if (record.attempted) return; record.attempted = true;
    const complete = record.value.dispose(), d = record.value.diagnostics;
    if (!complete || d.cleanup !== "complete") {
        if (record.model) modelUnknown.push(record.value);
        else { safe = false; acquire = false; actualUnknown.push(record.value); }
    }
    wrappers.delete(record);
}
async function drain() {
    for (const p of pending) try { await p; } catch { /* Caller observed the original error. */ }
    for (const record of wrappers) try { release(record); }
    catch (error) { safe = false; acquire = false; errors.push({ stage: "reader cleanup", error }); }
    for (const record of hosts) try { await record.dispose(); }
    catch (error) { safe = false; acquire = false; errors.push({ stage: "host cleanup", error }); }
}
afterEach(drain);
function actualReport(record) {
    let d, failure; const missing = [], reportingErrors = [];
    try { d = record.value.diagnostics; }
    catch (error) { errors.push({ stage: "actual owner diagnostics", error }); reportingErrors.push(loggedError(error)); }
    try { failure = record.value.failure; }
    catch (error) { errors.push({ stage: "actual owner failure", error }); reportingErrors.push(loggedError(error)); }
    if (!d) missing.push("diagnostics");
    if (!d?.reader) missing.push("reader");
    if (!d?.operations) missing.push("operations");
    if (!d?.operations?.native) missing.push("operations.native");
    if (!failure) missing.push("failure");
    const unresolved = failure?.native?.unresolved;
    return { ownerId: record.ownerId, releaseAttempted: record.attempted, initialized: record.initialized,
        status: d?.status ?? null, cleanup: d?.cleanup ?? null, missing,
        deliveredBytes: d?.deliveredBytes ?? null, clearedBorrowedBytes: d?.clearedBorrowedBytes ?? null,
        retainedReader: d?.retainedReader ?? null, retainedOperations: d?.retainedOperations ?? null,
        retainedCanonical: d?.retainedCanonical ?? null, reader: d?.reader ?? null, native: d?.operations?.native ?? null,
        operationFailed: failure?.failed ?? null, operationError: loggedError(failure?.error),
        cleanupFailed: failure?.cleanupFailed ?? null, cleanupError: loggedError(failure?.cleanupError), reportingErrors,
        unresolved: unresolved ? unresolved.map((slot, slotIndex) => ({ slotIndex,
            handle: typeof slot.handle === "bigint" ? slot.handle.toString() : loggedValue(slot.handle, 128),
            status: slot.status ?? null, information: typeof slot.information === "bigint" ? slot.information.toString() : null,
            guidPath: typeof slot.guidPath === "string" ? slot.guidPath.slice(0, 512) : null,
            attempted: slot.attempted, closeable: slot.closeable, closeFailed: slot.closeFailed, closeError: loggedError(slot.closeError) })) : null };
}
async function identified(path, kind, parentPath, known) {
    const record = { path, kind, parent: parentPath, identity: undefined, created: true, removeAttempted: false, removed: false };
    nodes.push(record); report({ created: path, kind });
    record.identity = id(known ? await known() : await lstat(path, { bigint: true }));
    report({ identified: path, identity: loggedId(record.identity) }); return record.identity;
}
before(async () => {
    assert.equal(process.platform, "win32"); assert.equal(process.arch, "x64"); assert.equal(typeof global.gc, "function");
    try {
        parent = await realpath(tmpdir()); root = await mkdtemp(join(parent, "sp-issued-workspace-"));
        rootId = await identified(root, "directory", parent);
        work = join(root, "work"); await mkdir(work); workId = await identified(work, "directory", root);
        leaf = join(work, "source.txt"); fixtureHandle = await open(leaf, "wx"); fixtureOpen++;
        let failed = false, error, closeFailed = false, closeError;
        try { leafId = await identified(leaf, "file", work, () => fixtureHandle.stat({ bigint: true })); await fixtureHandle.writeFile(text); }
        catch (actual) { failed = true; error = actual; }
        fixtureCloseAttempted++;
        try { await fixtureHandle.close(); fixtureClosed++; fixtureHandle = undefined; }
        catch (actual) { safe = false; closeFailed = true; closeError = actual; }
        if (failed && closeFailed) throw new AggregateError([error, closeError], "fixture operation and close");
        if (failed) throw error; if (closeFailed) throw closeError;
        const drive = parse(root).root, identity = id(await lstat(drive, { bigint: true }));
        bootstrap = new WindowsSourceNative();
        try { anchor = { drive, identity, volumePath: bootstrap.volumeForDrive(drive) }; }
        finally {
            bootstrapDisposeAttempted = true;
            try { bootstrap.dispose(); bootstrapReport = bootstrap.diagnostics; bootstrap = undefined; }
            catch (error) { safe = false; acquire = false; bootstrapError = error; errors.push({ stage: "bootstrap release", error }); }
        }
        if (bootstrap) throw bootstrapError;
    } catch (error) { acquire = false; if (nodes.some(node => !node.identity) || fixtureHandle) safe = false; errors.push({ stage: "fixture setup", error }); throw error; }
});
after(async () => {
    await drain();
    if (safe) for (let i = nodes.length - 1; i >= 0; i--) {
        const node = nodes[i];
        if (!node.identity) { safe = false; break; }
        try {
            const current = await lstat(node.path, { bigint: true });
            assert.ok(same(current, node.identity) && !current.isSymbolicLink());
            assert.equal(node.kind === "file" ? current.isFile() : current.isDirectory(), true);
            assert.equal(dirname(resolve(node.path)), node.parent); assert.equal(await realpath(node.path), node.path);
            if (i > 0) { const outer = nodes[i - 1], actual = await lstat(outer.path, { bigint: true }); assert.ok(same(actual, outer.identity) && actual.isDirectory() && !actual.isSymbolicLink()); assert.equal(await realpath(outer.path), outer.path); }
            node.removeAttempted = true;
            if (node.kind === "file") await unlink(node.path); else await rmdir(node.path);
            node.removed = true; await assert.rejects(lstat(node.path), { code: "ENOENT" });
        } catch (error) { safe = false; errors.push({ stage: "recorded node cleanup", error }); break; }
    }
    const worker = nativeFileDiagnostics();
    // Failure/partial initialization is data first. No success assertion or
    // unguarded missing-reader dereference may hide the final responsibility report.
    const realReports = realRecords.map(actualReport), missingCounters = [];
    let opened = 0, closed = 0, closeAttempts = 0, calls = 0, bytes = 0, scratch = bootstrapReport?.allocatedScratch ?? 0;
    let releasedScratch = bootstrapReport?.releasedScratch ?? 0, delivered = 0, rejectedReadCleared = 0;
    function counter(value, ownerId, name) {
        if (Number.isSafeInteger(value) && value >= 0) return value;
        missingCounters.push({ ownerId, name }); return 0;
    }
    for (const report of realReports) {
        const r = report.reader, n = report.native, key = report.ownerId;
        opened += counter(r?.opened, key, "opened"); closed += counter(r?.closed, key, "closed");
        closeAttempts += counter(r?.closeAttempts, key, "closeAttempts"); calls += counter(n?.calls, key, "nativeCalls");
        bytes += counter(n?.readBytes, key, "readBytes"); scratch += counter(n?.allocatedScratch, key, "allocatedScratch");
        releasedScratch += counter(n?.releasedScratch, key, "releasedScratch");
        delivered += counter(report.deliveredBytes, key, "deliveredBytes");
        rejectedReadCleared += counter(report.clearedBorrowedBytes, key, "clearedBorrowedBytes");
    }
    report({ nodes: nodes.map(node => ({ ...node, identity: loggedId(node.identity) })), safe, fixtureOpen, fixtureCloseAttempted, fixtureClosed,
        fixtureHandleRetained: !!fixtureHandle, hostRequests, originalIssuances, issuances, logicalReceiptBytes: issuances * 5, wrapperIssuances: 0,
        prepares, assessments, registered, liveWrappers: wrappers.size, pending: pending.size, hosts: hosts.size,
        realReaders, modelReaders, actualUnknown: actualUnknown.length, modeledUnknown: modelUnknown.length,
        actualOwners: realReports, missingCounters,
        modeledReadBytes, modeledOwners: modelRecords.map(record => ({ ownerId: record.ownerId, status: record.value.status,
            cleanup: record.value.diagnostics.cleanup, operations: record.value.diagnostics.operations?.native ?? null })),
        opened, closed, closeAttempts, nativeCalls: calls, bootstrapCalls: bootstrapReport?.calls, nativeBytes: bytes,
        deliveredNativeBytes: delivered, rejectedNativeReadCleared: rejectedReadCleared, allocatedScratch: scratch, releasedScratch,
        bootstrap: bootstrapReport ?? null, bootstrapDisposeAttempted, bootstrapRetained: !!bootstrap, bootstrapError: loggedError(bootstrapError),
        workerStartsDelta: worker.workerStarts - workerBefore.workerStarts, workerCallsDelta: worker.calls - workerBefore.calls,
        workerPending: worker.pending, implicitNodeOsIoFullyInstrumented: false, errors: errors.map(item => ({ stage: item.stage, error: loggedError(item.error) })) });
    if (errors.length === 1) throw errors[0].error;
    if (errors.length > 1) throw new AggregateError(errors.map(item => item.error), "original cleanup errors");
    assert.deepEqual(missingCounters, []);
    for (const owner of realReports) {
        assert.deepEqual(owner.missing, []); const r = owner.reader, n = owner.native;
        assert.ok(r.peakHandles <= 82 && r.openAttempts <= 256 && n.calls <= 8192 && n.readCalls <= 4096);
        assert.equal(r.activeHandles, 0); assert.equal(n.retainedScratch, 0); assert.equal(n.allocatedScratch, n.releasedScratch);
        assert.deepEqual(owner.unresolved, []); assert.equal(owner.cleanup, "complete");
    }
    assert.ok(safe && nodes.length === 3 && nodes.every(node => node.removed));
    assert.equal(fixtureOpen, 1); assert.equal(fixtureClosed, 1); assert.equal(fixtureCloseAttempted, 1);
    assert.equal(realReaders, 3); assert.equal(realReports.length, 3); assert.equal(bytes, 15); assert.equal(opened, closed); assert.equal(closeAttempts, closed);
    assert.equal(delivered, 10); assert.equal(rejectedReadCleared, 5);
    assert.equal(scratch, 9056); assert.equal(releasedScratch, 9056);
    assert.equal(bootstrap, undefined); assert.equal(bootstrapReport.retainedScratch, 0); assert.equal(bootstrapReport.releasedScratch, 2264);
    assert.equal(bootstrapReport.calls, 1); assert.ok(calls <= 24576 && opened <= 768);
    assert.ok(hostRequests <= 12 && originalIssuances <= 12 && issuances <= 12 && prepares <= 40 && assessments <= 128 && modelReaders <= 12);
    assert.ok(modeledReadBytes <= 64);
    assert.equal(actualUnknown.length, 0); assert.equal(pending.size, 0); assert.equal(hosts.size, 0); assert.equal(wrappers.size, 0);
    assert.equal(worker.workerStarts - workerBefore.workerStarts, 0); assert.equal(worker.calls - workerBefore.calls, 0); assert.equal(worker.pending, 0);
});

async function host({ ancestor = false, read = true, attach = true } = {}) {
    live(); assert.ok(hostRequests < 12); hostRequests++; const cwd = ancestor ? root : work, events = createEventBus(), boundary = new SessionExecutionBoundary();
    const state = { active: true, sessionId, hook: undefined };
    const runtime = { executionBoundary: boundary, assertActive() { state.hook?.(); assert.ok(state.active); },
        trackEventBusSubscription(value) { return value; }, appendEntry() { throw new Error("unexpected journal"); } };
    const ctx = { cwd, signal: undefined, sessionManager: { getSessionId() { return state.sessionId; }, getBranch() { return []; } }, ui: { setStatus() {} } };
    let owner, controller, ownerAttempted = false, boundaryAttempted = false, ownerClosed = false, boundaryClosed = false;
    const failures = [], record = { dispose }; hosts.add(record);
    async function dispose() {
        state.hook = undefined;
        if (!ownerAttempted) { ownerAttempted = true; try { if (owner) await owner.dispose(); ownerClosed = !owner || owner.getDiagnostics().closed; } catch (error) { failures.push(error); } }
        if (!boundaryAttempted) { boundaryAttempted = true; try { await boundary.dispose(); boundaryClosed = boundary.participantCount === 0; } catch (error) { failures.push(error); } }
        events.clear(); if (ownerClosed && boundaryClosed) hosts.delete(record); else { safe = false; acquire = false; }
        if (failures.length) throw new AggregateError(failures, "host cleanup");
        assert.ok(ownerClosed && boundaryClosed);
    }
    try {
        owner = new SessionFiles(runtime, events);
        controller = new SessionPermissionController({ registerExecutionOwner(name, participant) { return boundary.register(name, participant); },
            events: { emit() {} }, appendEntry() { throw new Error("unexpected permission journal"); } });
        assert.ok(originalIssuances < 12); await controller.restore(ctx); originalIssuances++;
        const issued = originalIssued.call(controller.state, controller.state.primary);
        assert.ok(issued && Object.isFrozen(issued)); assert.deepEqual(issued.identity, ancestor ? rootId : workId);
        originalAssessments.set(controller.state, controller.state.assessTarget);
        controller.state.assessTarget = countedAssessment; controller.prepareInputWorkspaceRead = countedPrepare;
        if (attach) owner.setCompatibilityBoundary(controller);
        const tools = { read: { async execute() { return { content: [{ type: "text", text }] }; } } }; owner.install(tools);
        let revisions, receipt, revision;
        if (read) {
            assert.ok(issuances < 12); issuances++;
            const result = await tools.read.execute("workspace-fixture", { path: relative(cwd, leaf) }, undefined, undefined, ctx);
            revision = result[NATIVE_FILE_REVISION]; assert.match(revision, /^snap_[A-Za-z0-9_-]{22}$/);
            const source = owner.pinReadRevisions(ctx);
            try { revisions = source.revisions; receipt = revisions.get(revision); } finally { source.dispose(); }
            assert.equal(receipt.mode, "full"); assert.equal(receipt.bytes.toString(), text); assert.equal(receipt.canonicalPath, leaf); assert.ok(same(receipt.identity, leafId));
        }
        return { owner, controller, runtime, boundary, ctx, state, revisions, receipt, revision, dispose };
    } catch (error) { acquire = false; try { await dispose(); } catch (cleanup) { throw new AggregateError([error, cleanup], "host setup/cleanup"); } throw error; }
}
function inputFor(f) {
    return { taskId: uuid, snapshotId: uuid, sessionId, epoch: f.revisions.generation,
        sourceRoot: { path: work, identity: { ...workId } }, budget: { ...INPUT_LIMITS },
        entries: [{ path: "source.txt", classification: "ordinary", expose: true, operation: "modify", parents: [],
            revision: f.revision, identity: fileId(f.receipt.identity), sha256: f.receipt.sha256 }] };
}
function released(value) {
    const d = value.diagnostics;
    assert.equal(d.retainedSource, false); assert.equal(d.retainedLease, false); assert.equal(d.retainedPermission, false);
    assert.equal(d.retainedReader, false); assert.equal(d.retainedAuthority, false); assert.equal(d.retainedOperations, false);
    if (d.permission) { assert.equal(d.permission.weakReferences, 0); assert.equal(d.permission.retainedGrant, false); }
}
function readAll(value, bytes = Buffer.alloc(5)) {
    try {
        const token = value.open("source.txt"); let offset = 0;
        while (offset < 5) {
            const remaining = 5 - offset, count = value.read(token, bytes, offset, remaining);
            assert.ok(Number.isInteger(count) && count > 0 && count <= remaining, "bounded read must make progress"); offset += count;
        }
        value.close(token); return bytes;
    } catch (error) { bytes.fill(0); throw error; }
}
function modelOps() {
    let next = 0n, calls = 0, reads = 0, bytes = 0, closes = 0, disposals = 0;
    const handles = new Map(), attempts = new Map(), borrowed = [];
    const ops = { openHook: undefined, inspectHook: undefined, readHook: undefined, closeHook: undefined, disposeHook: undefined,
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
        read(handle, target, offset, length) {
            calls++; reads++; const value = handles.get(handle), count = Math.min(2, length);
            assert.ok(modeledReadBytes + count <= 64); modeledReadBytes += count;
            target.write(text.slice(value.position, value.position + count), offset, count, "ascii"); value.position += count; bytes += count;
            borrowed.push(target); ops.readHook?.(); return count;
        },
        close(handle) { closes++; attempts.set(handle, (attempts.get(handle) ?? 0) + 1); ops.closeHook?.(handle, handles.get(handle)); assert.equal(handles.delete(handle), true); return true; },
        dispose() { disposals++; ops.disposeHook?.(); },
        get diagnostics() { return { calls, readCalls: reads, readBytes: bytes, closeCalls: closes, active: handles.size, disposals }; },
        handles, attempts, borrowed };
    return ops;
}
async function gated(f, internal, action) {
    const target = internal ? f.controller.state : f.controller, key = internal ? "assessTarget" : "prepareInputWorkspaceRead", original = target[key];
    const entered = Promise.withResolvers(), releaseGate = Promise.withResolvers(); let held = false, returnedGrant;
    target[key] = async function(...args) {
        const result = await original.apply(this, args);
        if (!held) { held = true; if (!internal) returnedGrant = result; entered.resolve(); await releaseGate.promise; }
        return result;
    };
    const value = create(f), outcome = run(value).then(result => ({ result }), error => ({ rejected: true, error }));
    try {
        await Promise.race([entered.promise, outcome.then(result => { throw new Error("settled before gate", { cause: result }); })]);
        await action(value);
    } finally { releaseGate.resolve(); target[key] = original; }
    const result = await outcome; assert.equal(result.rejected, true); released(value);
    assert.equal(value.diagnostics.pending, false); assert.equal(value.diagnostics.permission.pending, false);
    if (returnedGrant) { assert.equal(returnedGrant.diagnostics.policyDisposals, 1); assert.equal(returnedGrant.diagnostics.weakReferences, 0); }
}
async function outerGate(f, action) {
    const original = SessionInputWorkspacePermission.prototype.prepare;
    const entered = Promise.withResolvers(), releaseGate = Promise.withResolvers(); let returnedPermission;
    SessionInputWorkspacePermission.prototype.prepare = async function(checkOriginal) {
        const result = await original.call(this, checkOriginal); returnedPermission = this;
        assert.equal(this.diagnostics.state, "ready"); assert.equal(this.diagnostics.pending, false);
        entered.resolve(); await releaseGate.promise; return result;
    };
    const value = create(f), outcome = run(value).then(result => ({ result }), error => ({ rejected: true, error }));
    try {
        await Promise.race([entered.promise, outcome.then(result => { throw new Error("wrapper settled before completed bridge gate", { cause: result }); })]);
        assert.equal(value.diagnostics.pending, true); await action(value);
    } finally { releaseGate.resolve(); SessionInputWorkspacePermission.prototype.prepare = original; }
    const result = await outcome; assert.equal(result.rejected, true); released(value);
    assert.equal(value.diagnostics.pending, false); assert.equal(returnedPermission.diagnostics.pending, false);
    assert.equal(returnedPermission.diagnostics.grantDisposals, 1); assert.equal(returnedPermission.diagnostics.grant.policyDisposals, 1);
}

function changedInode(grant) {
    const original = grant.inode, changed = original === 1 ? 2 : 1;
    assert.notEqual(changed, original); return { original, changed };
}

test("issued workspace 1: exact issued sourceRoot and ancestor bind real directory handles", async () => {
    for (const ancestor of [false, true]) {
        const f = await host({ ancestor }), issued = originalIssued.call(f.controller.state, f.controller.state.primary);
        const value = create(f); await run(value); initialize(value);
        const bytes = readAll(value);
        try { assert.equal(bytes.toString(), text); } finally { bytes.fill(0); }
        assert.deepEqual(value.settle(), { status: "settled", cleanup: "complete" }); released(value);
        assert.equal(value.diagnostics.operations.matches, 1);
        report({ originalIssuedGrant: ancestor ? "ancestor" : "sourceRoot", identity: loggedId(issued.identity),
            legacySafe: Number.isSafeInteger(issued.inode), matches: 1, reader: value.diagnostics.reader, operations: value.diagnostics.operations });
        release([...wrappers].find(record => record.value === value)); await f.dispose();
    }
});

test("issued workspace 2: pending and completed async returns plus final receipt callbacks reject changes", async () => {
    const f = await host();
    try { await gated(f, true, () => { f.ctx.signal = new AbortController().signal; }); }
    finally { f.ctx.signal = undefined; }
    await gated(f, false, value => { value.revoke(); assert.equal(value.diagnostics.pending, true); });
    const outer = await host(), grant = outer.controller.state.primary, mutation = changedInode(grant);
    try { await outerGate(outer, () => { grant.inode = mutation.changed; }); } finally { grant.inode = mutation.original; }
    try { await outerGate(outer, () => { outer.owner.accepting = false; }); } finally { outer.owner.accepting = true; }
    await outerGate(outer, () => { outer.revisions.forget(outer.revision); });
    for (const kind of ["owner", "grant"]) {
        const value = create(f); await run(value);
        const descriptor = Object.getOwnPropertyDescriptor(f.receipt, "sha256"), originalGrant = f.controller.state.primary;
        const edit = changedInode(originalGrant), accepting = f.owner.accepting; let reads = 0;
        Object.defineProperty(f.receipt, "sha256", { configurable: true, get() {
            if (++reads === 4) { if (kind === "owner") f.owner.accepting = false; else originalGrant.inode = edit.changed; }
            return descriptor.value;
        } });
        try {
            assert.throws(() => value.initialize()); assert.equal(reads, 4); released(value);
            assert.equal(value.diagnostics.reader, undefined); assert.equal(value.diagnostics.operations, undefined);
        } finally { Object.defineProperty(f.receipt, "sha256", descriptor); originalGrant.inode = edit.original; f.owner.accepting = accepting; }
        assert.throws(() => value.initialize());
    }
    report({ actualPendingGates: 2, completedBridgeOuterGates: 3, finalReceiptCallbacks: 2,
        bridgeReadyBeforeOuterDelivery: true, lateGrantDisposals: 1, latePolicyDisposals: 1, nativeAllocated: false });
});

test("issued workspace 3: real post-read rejection clears this slice and preserves earlier caller bytes", async () => {
    const f = await host(), originalRead = WindowsSourceReader.prototype.read;
    for (const history of [false, true]) {
        const value = create(f, history ? modelOps() : undefined); await run(value); initialize(value);
        const token = value.open("source.txt"), bytes = Buffer.alloc(9, 0x7a); let returned = false, previous, returnedCount, returnedText;
        if (history) { previous = Buffer.alloc(2); assert.equal(value.read(token, previous, 0, 2), 2); assert.equal(previous.toString(), "al"); }
        const grant = f.controller.state.primary, edit = changedInode(grant);
        WindowsSourceReader.prototype.read = function(...args) {
            const count = originalRead.apply(this, args);
            assert.ok(Number.isInteger(count) && count > 0 && count <= args[3]);
            returnedCount = count; returnedText = args[1].subarray(args[2], args[2] + count).toString("ascii");
            returned = true; return count;
        };
        f.state.hook = () => { if (returned) grant.inode = edit.changed; };
        try {
            const length = history ? 3 : 5;
            assert.throws(() => value.read(token, bytes, 2, length)); assert.equal(returned, true);
            assert.equal(returnedCount, history ? 2 : 5); assert.equal(returnedText, history ? "ph" : text);
            assert.ok(bytes.subarray(2, 2 + length).every(v => v === 0));
            assert.ok(bytes.subarray(0, 2).every(v => v === 0x7a)); assert.ok(bytes.subarray(2 + length).every(v => v === 0x7a));
            assert.equal(value.diagnostics.clearedBorrowedBytes, length); assert.equal(value.diagnostics.reader.clearedBorrowedBytes, 0);
            if (previous) assert.equal(previous.toString(), "al");
            released(value); report({ postRead: history ? "model-history" : "real", returnedCount, returnedText, outerCleared: length,
                originalReaderCleared: 0, priorCallerBytesRevoked: false });
        } finally { WindowsSourceReader.prototype.read = originalRead; f.state.hook = undefined; grant.inode = edit.original; bytes.fill(0); previous?.fill(0); }
    }
});

test("issued workspace 4: identity, reentry, Unknown and final-close failure preserve exact responsibility", async () => {
    const f = await host({ ancestor: true });
    for (const kind of ["grant-inode", "source-root"]) {
        const ops = modelOps();
        ops.openHook = (_slot, value) => { if (value.dosPath === "\\\\?\\" + (kind === "grant-inode" ? root : work)) value.identity.ino++; };
        const value = create(f, ops); await run(value); assert.throws(() => initialize(value), /identity/);
        assert.equal(ops.diagnostics.readBytes, 0); assert.equal(ops.diagnostics.active, 0); released(value);
    }
    for (const kind of ["reentry", "revoke"]) {
        const ops = modelOps(), value = create(f, ops); await run(value); initialize(value);
        const token = value.open("source.txt"), bytes = Buffer.alloc(5, 0x7a);
        ops.readHook = () => {
            if (kind === "reentry") { try { value.stat(token); } catch {} } else value.revoke();
            assert.equal(ops.diagnostics.closeCalls, 0);
        };
        try { assert.throws(() => value.read(token, bytes, 0, 5)); assert.ok(bytes.every(v => v === 0)); }
        finally { bytes.fill(0); }
        assert.equal(ops.diagnostics.active, 0); assert.ok([...ops.attempts.values()].every(n => n === 1)); released(value);
    }
    for (const kind of ["partial", "pending", "close", "dispose"]) {
        const ops = modelOps(), value = create(f, ops); await run(value);
        if (kind === "partial" || kind === "pending") {
            ops.openHook = (slot, metadata) => {
                if (metadata.dosPath !== "\\\\?\\" + work) return;
                if (kind === "pending") { slot.closeable = false; slot.status = 0x103; }
                throw undefined;
            };
            ops.closeHook = (_handle, metadata) => { if (kind === "partial" && metadata.dosPath === "\\\\?\\" + work) throw 0; };
            assert.throws(() => initialize(value));
        } else {
            initialize(value); const bytes = readAll(value); bytes.fill(0);
            if (kind === "close") ops.closeHook = (_handle, metadata) => { if (metadata.dosPath === "\\\\?\\" + work) throw null; };
            else ops.disposeHook = () => { throw 0; };
            assert.throws(() => value.settle());
        }
        const d = value.diagnostics, failure = value.failure, before = ops.diagnostics;
        assert.equal(d.status, "unknown"); assert.equal(d.cleanup, "unknown"); assert.equal(d.retainedReader, true); assert.equal(d.retainedOperations, true);
        assert.equal(value.dispose(), false); assert.equal(value.dispose(), false); assert.deepEqual(ops.diagnostics, before);
        const afterFailure = value.failure;
        assert.equal(afterFailure.error, failure.error); assert.equal(afterFailure.cleanupError, failure.cleanupError);
        assert.deepEqual(afterFailure.native.unresolved, failure.native.unresolved);
        for (let i = 0; i < failure.native.unresolved.length; i++) {
            assert.equal(afterFailure.native.unresolved[i].token, failure.native.unresolved[i].token);
            assert.equal(afterFailure.native.unresolved[i].handle, failure.native.unresolved[i].handle);
        }
        assert.ok([...ops.attempts.values()].every(n => n === 1));
        if (kind === "dispose") { assert.equal(before.active, 0); assert.equal(before.disposals, 1); assert.equal(failure.cleanupFailed, true); assert.equal(failure.cleanupError, 0); }
        if (kind === "pending") assert.ok(failure.native.unresolved.some(slot => slot.status === 0x103 && slot.attempted === false));
        if (kind === "partial" || kind === "close") assert.ok(failure.native.unresolved.some(slot => slot.closeFailed && slot.closeError === (kind === "partial" ? 0 : null)));
        if (kind === "partial" || kind === "pending") { assert.equal(failure.failed, true); assert.equal(failure.error, undefined); }
        report({ modeledUnknown: kind, originalResponsibilityRetained: true, active: before.active, closeAttempts: before.closeCalls, disposals: before.disposals });
    }
    for (const kind of ["owner", "grant"]) {
        const ops = modelOps(), value = create(f, ops); await run(value); initialize(value);
        const bytes = readAll(value); bytes.fill(0);
        const grant = f.controller.state.primary, edit = changedInode(grant), accepting = f.owner.accepting;
        ops.disposeHook = () => { if (kind === "owner") f.owner.accepting = false; else grant.inode = edit.changed; };
        let caught = false, originalError;
        try { value.settle(); } catch (error) { caught = true; originalError = error; }
        finally { f.owner.accepting = accepting; grant.inode = edit.original; }
        assert.equal(caught, true); assert.equal(value.status, "rejected"); assert.equal(value.diagnostics.cleanup, "complete");
        assert.equal(value.failure.failed, true); assert.equal(value.failure.error, originalError); released(value);
        assert.equal(ops.diagnostics.active, 0); assert.equal(ops.diagnostics.disposals, 1);
        const counts = ops.diagnostics; assert.equal(value.dispose(), true); assert.equal(value.dispose(), true); assert.deepEqual(ops.diagnostics, counts);
        report({ postCloseGuardRejected: kind, cleanup: "complete", originalErrorRetained: true, closeOrDisposeRetried: false });
    }
    report({ modelIdentityRejections: 2, modelBusyUnwinds: 2, modeledUnknowns: 4, modelFinalClosedRejections: 2 });
});

test("issued workspace 5: prepared composition releases retired host, receipt, original grant and sidecar", async () => {
    let f = await host(), input = inputFor(f);
    const value = create(f, undefined, input); await run(value);
    const refs = [f.owner, f.runtime, f.boundary, f.ctx, f.revisions, f.receipt, f.receipt.bytes,
        f.controller, f.controller.state, f.controller.state.primary,
        originalIssued.call(f.controller.state, f.controller.state.primary), input].map(item => new WeakRef(item));
    await f.dispose(); f = undefined; input = undefined;
    for (let i = 0; i < 4; i++) { await tick(); global.gc(); }
    const liveTargets = refs.reduce((sum, ref) => sum + Number(ref.deref() !== undefined), 0);
    assert.equal(value.status, "prepared"); assert.equal(liveTargets, 0);
    assert.throws(() => value.initialize()); released(value); assert.equal(value.diagnostics.reader, undefined);
    report({ controlledGcRounds: 4, weakTargets: refs.length, includesOriginalIssuedSidecar: true,
        liveTargets, preparedWrapperAlive: true, released: value.diagnostics });
});
