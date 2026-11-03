// §58 capture/consumption evidence; does not rerun or rewrite §55–57 results.
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
import { INPUT_LIMITS, OfflineInputSnapshotOwner } from "../scripts/acceptance/windows-sandbox-input-snapshot.mjs";
import { WindowsSourceReader } from "../scripts/acceptance/windows-sandbox-source-reader.mjs";
import { WindowsSourceNative } from "../scripts/acceptance/windows-sandbox-source-native.mjs";
import { WindowsWorkspaceSourceReader } from "../scripts/acceptance/windows-sandbox-workspace-source-reader.mjs";

import { WindowsWorkspaceInputCapture } from "../scripts/acceptance/windows-sandbox-workspace-input-capture.mjs";

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
const text = "alpha", sessionId = "workspace_input_capture", uuid = "11111111-2222-4333-8444-555555555555";
let parent, root, work, leaf, rootId, workId, leafId, anchor, bootstrap, bootstrapReport, bootstrapError;
let bootstrapDisposeAttempted = false;
const nodes = [], wrappers = new Set(), hosts = new Set(), pending = new Set(), errors = [], actualUnknown = [], modelUnknown = [];
const realRecords = [], modelRecords = [];
let standaloneAllocatedBytes = 0, standaloneClearedBytes = 0;
let safe = true, acquire = true, fixtureHandle, fixtureOpen = 0, fixtureCloseAttempted = 0, fixtureClosed = 0;
let issuances = 0, prepares = 0, assessments = 0, registered = 0, realReaders = 0, modelReaders = 0, reportBytes = 0, hostRequests = 0, originalIssuances = 0, modeledReadBytes = 0;
const workerBefore = nativeFileDiagnostics();
function live() { assert.ok(safe && acquire, "no new acquisition after unsafe fixture/actual cleanup"); }
function report(value) { const line = JSON.stringify(value); reportBytes += Buffer.byteLength(line) + 1; assert.ok(reportBytes <= 49152); console.log(line); }
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
function countedAssessment(path, cwd) { live(); assert.ok(assessments < 256); assessments++; return originalAssessments.get(this).call(this, path, cwd); }
function countedPrepare(ctx, paths) { live(); assert.ok(prepares < 40); prepares++; return originalPrepare.call(this, ctx, paths); }
async function run(value, method = "capture", ...args) {
    const promise = value[method](...args); pending.add(promise);
    try { return await promise; } finally { pending.delete(promise); }
}
function create(f, ops, input = inputFor(f), kind = "capture") {
    live(); const value = kind === "capture"
        ? new WindowsWorkspaceInputCapture(input, anchor, f.owner, f.ctx, ops)
        : new WindowsWorkspaceSourceReader(input, anchor, f.owner, f.ctx, ops);
    const record = { value, ownerId: ++registered, model: !!ops, attempted: false, kind };
    wrappers.add(record);
    if (ops) { assert.ok(modelReaders < 20); modelReaders++; modelRecords.push(record); }
    else { assert.ok(realReaders < 3); realReaders++; realRecords.push(record); }
    return value;
}
function sourceDiagnostics(record) { return record.kind === "capture" ? record.value.diagnostics.reader : record.value.diagnostics; }
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
    try { d = sourceDiagnostics(record); }
    catch (error) { errors.push({ stage: "actual owner diagnostics", error }); reportingErrors.push(loggedError(error)); }
    try { failure = record.kind === "capture" ? record.value.failure.reader : record.value.failure; }
    catch (error) { errors.push({ stage: "actual owner failure", error }); reportingErrors.push(loggedError(error)); }
    if (!d) missing.push("diagnostics");
    if (!d?.reader) missing.push("reader");
    if (!d?.operations) missing.push("operations");
    if (!d?.operations?.native) missing.push("operations.native");
    if (!failure) missing.push("failure");
    const unresolved = failure?.native?.unresolved;
    return { ownerId: record.ownerId, releaseAttempted: record.attempted, initialized: !!d?.reader,
        capture: record.kind === "capture" ? record.value.diagnostics : null,
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
        parent = await realpath(tmpdir()); root = await mkdtemp(join(parent, "sp-workspace-capture-"));
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
            if (i > 0) {
                const outer = nodes[i - 1], actual = await lstat(outer.path, { bigint: true });
                assert.ok(same(actual, outer.identity) && actual.isDirectory() && !actual.isSymbolicLink());
                assert.equal(await realpath(outer.path), outer.path);
            }
            node.removeAttempted = true;
            if (node.kind === "file") await unlink(node.path); else await rmdir(node.path);
            node.removed = true; await assert.rejects(lstat(node.path), { code: "ENOENT" });
        } catch (error) { safe = false; errors.push({ stage: "recorded node cleanup", error }); break; }
    }
    const actual = realRecords.map(actualReport), missingCounters = [], worker = nativeFileDiagnostics();
    let opened = 0, closed = 0, attempts = 0, calls = 0, bytes = 0, allocated = bootstrapReport?.allocatedScratch ?? 0;
    let freed = bootstrapReport?.releasedScratch ?? 0, delivered = 0, rejected = 0;
    const count = (value, owner, name) => {
        if (Number.isSafeInteger(value) && value >= 0) return value;
        missingCounters.push({ owner, name }); return 0;
    };
    for (const value of actual) {
        const r = value.reader, n = value.native, key = value.ownerId;
        opened += count(r?.opened, key, "opened"); closed += count(r?.closed, key, "closed");
        attempts += count(r?.closeAttempts, key, "closeAttempts"); calls += count(n?.calls, key, "calls");
        bytes += count(n?.readBytes, key, "readBytes"); allocated += count(n?.allocatedScratch, key, "allocatedScratch");
        freed += count(n?.releasedScratch, key, "releasedScratch");
        delivered += count(value.deliveredBytes, key, "deliveredBytes"); rejected += count(value.clearedBorrowedBytes, key, "clearedBorrowedBytes");
    }
    const models = modelRecords.map(record => ({ ownerId: record.ownerId, kind: record.kind,
        cleanup: record.value.diagnostics.cleanup, source: sourceDiagnostics(record)?.reader,
        operations: sourceDiagnostics(record)?.operations?.native,
        capture: record.kind === "capture" ? { input: record.value.diagnostics.input,
            renewals: record.value.diagnostics.renewals, allocated: record.value.diagnostics.copyAllocatedBytes,
            delivered: record.value.diagnostics.deliveredCopyBytes, rejected: record.value.diagnostics.rejectedCopyBytes,
            acknowledgements: record.value.diagnostics.knownClosedAcknowledgements } : null }));
    report({ nodes: nodes.map(node => ({ ...node, identity: loggedId(node.identity) })), safe,
        fixtureOpen, fixtureCloseAttempted, fixtureClosed, fixtureHandleRetained: !!fixtureHandle,
        hostRequests, originalIssuances, issuances, logicalReceiptBytes: issuances * 5, wrapperIssuances: 0,
        prepares, assessments, registered, realReaders, modelReaders, pending: pending.size, liveWrappers: wrappers.size,
        hosts: hosts.size, actualUnknown: actualUnknown.length, modeledUnknown: modelUnknown.length,
        actualOwners: actual, modeledOwners: models, modeledReadBytes, standaloneAllocatedBytes, standaloneClearedBytes, missingCounters,
        opened, closed, closeAttempts: attempts, nativeCalls: calls, nativeBytes: bytes,
        deliveredNativeBytes: delivered, rejectedNativeReadCleared: rejected, allocatedScratch: allocated, releasedScratch: freed,
        bootstrap: bootstrapReport ?? null, bootstrapDisposeAttempted, bootstrapRetained: !!bootstrap, bootstrapError: loggedError(bootstrapError),
        workerStartsDelta: worker.workerStarts - workerBefore.workerStarts, workerCallsDelta: worker.calls - workerBefore.calls,
        workerPending: worker.pending, implicitNodeOsIoFullyInstrumented: false,
        errors: errors.map(item => ({ stage: item.stage, error: loggedError(item.error) })) });
    if (errors.length) throw new AggregateError(errors.map(item => item.error), "original cleanup errors");
    assert.deepEqual(missingCounters, []);
    for (const owner of actual) {
        assert.deepEqual(owner.missing, []); assert.deepEqual(owner.unresolved, []);
        assert.equal(owner.cleanup, "complete"); assert.equal(owner.reader.activeHandles, 0);
        assert.ok(owner.reader.peakHandles <= 82 && owner.reader.openAttempts <= 256 && owner.native.calls <= 8192);
        assert.equal(owner.native.allocatedScratch, owner.native.releasedScratch); assert.equal(owner.native.retainedScratch, 0);
        assert.equal(owner.capture.input.retainedBytes, 0); assert.equal(owner.capture.input.clearedBytes, 5);
    }
    assert.ok(safe && nodes.length === 3 && nodes.every(node => node.removed));
    assert.equal(fixtureOpen, 1); assert.equal(fixtureCloseAttempted, 1); assert.equal(fixtureClosed, 1);
    assert.equal(realReaders, 3); assert.equal(bytes, 15); assert.equal(delivered, 10); assert.equal(rejected, 5);
    assert.equal(opened, closed); assert.equal(attempts, closed); assert.ok(calls <= 24576 && opened <= 768);
    assert.equal(allocated, 9056); assert.equal(freed, 9056); assert.equal(bootstrapReport.calls, 1);
    assert.ok(hostRequests <= 12 && originalIssuances <= 12 && issuances <= 12 && prepares <= 40 && assessments <= 256);
    assert.equal(modelReaders, 18); assert.equal(modeledReadBytes, 79);
    assert.equal(standaloneAllocatedBytes, 10); assert.equal(standaloneClearedBytes, 10);
    assert.equal(actualUnknown.length, 0); assert.equal(modelUnknown.length, 3);
    assert.equal(pending.size, 0); assert.equal(hosts.size, 0); assert.equal(wrappers.size, 0);
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
            assert.ok(modeledReadBytes + count <= 128); modeledReadBytes += count;
            target.write(text.slice(value.position, value.position + count), offset, count, "ascii"); value.position += count; bytes += count;
            borrowed.push(target); ops.readHook?.(); return count;
        },
        close(handle) { closes++; attempts.set(handle, (attempts.get(handle) ?? 0) + 1); ops.closeHook?.(handle, handles.get(handle)); assert.equal(handles.delete(handle), true); return true; },
        dispose() { disposals++; ops.disposeHook?.(); },
        get diagnostics() { return { calls, readCalls: reads, readBytes: bytes, closeCalls: closes, active: handles.size, disposals }; },
        handles, attempts, borrowed };
    return ops;
}

function released(value) {
    const d = value.diagnostics;
    assert.equal(d.retainedReader, false); assert.equal(d.retainedInput, false); assert.equal(d.retainedIO, false);
    assert.equal(d.retainedCanonical, false); assert.equal(d.retainedBinding, false); assert.equal(d.retainedMetadata, false);
    assert.equal(d.retainedCopySlots, 0); assert.equal(d.input?.retainedBytes ?? 0, 0);
    if (d.reader?.permission) { assert.equal(d.reader.permission.weakReferences, 0); assert.equal(d.reader.permission.retainedGrant, false); }
}
function cleared(ops) { for (const bytes of ops.borrowed) assert.ok(bytes.every(byte => byte === 0)); }
function changedInode(grant) {
    const original = grant.inode, changed = original === 1 ? 2 : 1; assert.notEqual(original, changed); return { original, changed };
}
async function gate(f, value, method, layer, action) {
    const target = layer === "assessment" ? f.controller.state
        : layer === "bridge" ? SessionInputWorkspacePermission.prototype : WindowsWorkspaceSourceReader.prototype;
    const key = layer === "assessment" ? "assessTarget" : "renew", original = target[key];
    const entered = Promise.withResolvers(), releaseGate = Promise.withResolvers();
    let held = false, returned;
    target[key] = async function(...args) {
        const result = await original.apply(this, args);
        // Initial prepare has two assessments; only the post-close renewal may pause.
        if (!held && (layer !== "assessment" || value.diagnostics.reader?.status === "sealed")) {
            held = true; returned = this; entered.resolve(); await releaseGate.promise;
        }
        return result;
    };
    const outcome = run(value, method, ...(method === "copyFile" ? [0] : []))
        .then(result => ({ result }), error => ({ rejected: true, error }));
    try {
        await Promise.race([entered.promise, outcome.then(result => { throw new Error("settled before gate", { cause: result }); })]);
        assert.equal(value.diagnostics.pending, true);
        assert.equal(value.diagnostics.reader.reader.activeHandles, 0);
        assert.equal(value.diagnostics.reader.retainedOperations, false);
        await action(value);
    } finally { releaseGate.resolve(); target[key] = original; }
    const result = await outcome;
    if (method === "capture") assert.equal(result.result?.status, "rejected"); else assert.equal(result.rejected, true);
    assert.equal(value.diagnostics.pending, false); assert.equal(value.diagnostics.reader.pending, false);
    assert.equal(value.diagnostics.reader.permission.pending, false);
    assert.equal(value.diagnostics.reader.permission.grant.pending, false);
    if (layer === "bridge") assert.equal(returned.diagnostics.pending, false);
    released(value);
}
test("capture 1: real exact and ancestor grants close before publication and reuse original authority", async () => {
    for (const ancestor of [false, true]) {
        const f = await host({ ancestor }), input = inputFor(f), value = create(f, undefined, input);
        input.entries[0].path = "changed.txt"; input.sourceRoot.identity.ino = 1n; input.budget.fileBytes = 0;
        assert.deepEqual(await run(value), { status: "captured", cleanup: "complete" });
        const d = value.diagnostics; assert.equal(d.reader.status, "sealed"); assert.equal(d.renewals, 1);
        assert.equal(d.reader.reader.activeHandles, 0); assert.equal(d.reader.retainedOperations, false);
        assert.equal(d.input.retainedBytes, 5); assert.equal(d.samePathStats, 1); assert.equal(d.knownClosedAcknowledgements, 0);
        const native = d.reader.operations.native, originalGrant = f.controller.state.primary;
        const metadata = await run(value, "publishMetadata"), bytes = await run(value, "copyFile", 0);
        try {
            assert.equal(bytes.toString(), text); assert.equal(metadata.entries[0].path, "source.txt");
            assert.equal(metadata.entries[0].revision, f.revision); assert.deepEqual(metadata.sourceRoot.identity, workId);
            assert.ok(Object.isFrozen(metadata) && Object.isFrozen(metadata.entries) && Object.isFrozen(metadata.entries[0])
                && Object.isFrozen(metadata.sourceRoot.identity) && Object.isFrozen(metadata.budget));
            assert.equal(value.diagnostics.renewals, 3); assert.equal(value.diagnostics.reader.permission.grant.observations, 4);
            assert.equal(f.controller.state.primary, originalGrant); assert.deepEqual(value.diagnostics.reader.operations.native, native);
            value.revoke(); assert.equal(bytes.toString(), text); released(value);
            assert.equal(value.diagnostics.input.clearedBytes, 5); assert.equal(value.diagnostics.deliveredCopyBytes, 5);
            report({ realCapture: ancestor ? "ancestor" : "exact", renewals: 3, copies: 1, privateCleared: 5,
                nativeClosedBeforeDelivery: true, historicalCallerCopyPreserved: true });
        } finally { bytes.fill(0); }
    }
});
test("capture 2: real post-read revocation acknowledges only the original already-closed token", async () => {
    const f = await host(), value = create(f), original = WindowsSourceReader.prototype.read;
    let returnedBytes = 0;
    WindowsSourceReader.prototype.read = function(...args) {
        const count = original.apply(this, args); returnedBytes += count; value.revoke(); return count;
    };
    let result;
    try { result = await run(value); } finally { WindowsSourceReader.prototype.read = original; }
    assert.deepEqual(result, { status: "rejected", cleanup: "complete" }); assert.equal(returnedBytes, 5);
    assert.equal(value.diagnostics.knownClosedAcknowledgements, 1); assert.equal(value.diagnostics.input.closed, 1);
    assert.equal(value.diagnostics.reader.clearedBorrowedBytes, 5); assert.equal(value.diagnostics.renewals, 0);
    assert.equal(value.failure.failed, true); released(value);
    report({ actualReadReturnedBeforeOuterRefusal: 5, acknowledgedClosedToken: 1, rejectedReadCleared: 5, copies: 0 });
});
test("capture 3: original observations and completed async returns remain revocable", async () => {
    const f = await host();
    const cases = [["capture", "assessment", "revoke"], ["copyFile", "assessment", "revoke"],
        ["publishMetadata", "assessment", "reentry"], ["capture", "bridge", "owner"],
        ["copyFile", "source", "grant"], ["publishMetadata", "bridge", "receipt"]];
    for (const [method, layer, mutation] of cases) {
        const ops = modelOps(), value = create(f, ops);
        if (method !== "capture") assert.equal((await run(value)).status, "captured");
        const grant = f.controller.state.primary, edit = changedInode(grant);
        try {
            await gate(f, value, method, layer, async current => {
                assert.equal(current.diagnostics.input.retainedBytes, 5);
                if (mutation === "revoke") {
                    current.revoke(); assert.equal(current.diagnostics.input.retainedBytes, 0);
                    assert.equal(current.diagnostics.pending, true);
                } else if (mutation === "reentry") {
                    await assert.rejects(current.copyFile(0)); assert.equal(current.diagnostics.input.retainedBytes, 0);
                } else if (mutation === "owner") f.owner.accepting = false;
                else if (mutation === "grant") grant.inode = edit.changed;
                else f.revisions.forget(f.revision);
            });
        } finally { f.owner.accepting = true; grant.inode = edit.original; }
        cleared(ops); assert.equal(ops.diagnostics.active, 0); assert.equal(ops.diagnostics.disposals, 1);
        report({ asyncGate: layer, method, mutation, privateCleared: 5, pendingAfterSettlement: false });
    }
});
test("capture 4: synchronous borrows unwind once and unknown cleanup retains original responsibility", async () => {
    const f = await host();
    for (const kind of ["revoke", "undefined", "close-revoke"]) {
        const ops = modelOps(), value = create(f, ops); let observedBorrow = false;
        if (kind === "close-revoke") ops.closeHook = (_handle, metadata) => {
            if (metadata.kind === "file" && ops.diagnostics.readBytes === 5) value.revoke();
        };
        else ops.readHook = () => {
            observedBorrow = true;
            if (kind === "undefined") throw undefined;
            value.revoke();
            assert.equal(value.diagnostics.synchronousBorrow, true);
            assert.equal(ops.borrowed[0].subarray(0, 2).toString(), "al");
            assert.equal(value.diagnostics.input.retainedBytes, 5);
        };
        assert.deepEqual(await run(value), { status: "rejected", cleanup: "complete" });
        assert.equal(observedBorrow, kind !== "close-revoke"); assert.equal(value.diagnostics.knownClosedAcknowledgements, 1);
        assert.equal(value.failure.failed, true); if (kind === "undefined") assert.equal(value.failure.error, undefined);
        cleared(ops); released(value); assert.ok([...ops.attempts.values()].every(n => n === 1));
    }
    for (const kind of ["pending", "close", "dispose"]) {
        const ops = modelOps(), value = create(f, ops); let failedReadCloses = 0, failedReadHandle;
        if (kind === "pending") ops.openHook = (slot, metadata) => {
            if (metadata.kind === "file") { slot.closeable = false; slot.status = 0x103; throw undefined; }
        };
        if (kind === "close") ops.closeHook = (handle, metadata) => {
            if (metadata.openKind === "read") { failedReadCloses++; failedReadHandle = handle; throw 0; }
        };
        if (kind === "dispose") ops.disposeHook = () => { throw 0; };
        assert.deepEqual(await run(value), { status: "rejected", cleanup: "unknown" });
        const d = value.diagnostics, failure = value.failure, before = ops.diagnostics;
        assert.equal(d.retainedReader, true); assert.equal(d.reader.retainedOperations, true); assert.equal(d.input.retainedBytes, 0);
        assert.equal(d.knownClosedAcknowledgements, 0); assert.equal(value.dispose(), false); assert.equal(value.dispose(), false);
        assert.deepEqual(ops.diagnostics, before);
        assert.equal(value.failure.error, failure.error); assert.equal(value.failure.reader.cleanupError, failure.reader.cleanupError);
        const slots = failure.reader.native.unresolved, afterSlots = value.failure.reader.native.unresolved;
        for (let i = 0; i < slots.length; i++) { assert.equal(afterSlots[i].token, slots[i].token); assert.equal(afterSlots[i].handle, slots[i].handle); }
        if (kind === "pending") assert.ok(slots.some(slot => slot.status === 0x103 && !slot.attempted));
        if (kind === "close") {
            assert.equal(failedReadCloses, 1); assert.equal(before.readBytes, 5);
            assert.ok(slots.some(slot => slot.handle === failedReadHandle && slot.closeFailed && slot.closeError === 0));
            assert.ok(slots.some(slot => slot.token === failure.input.retainedHandle));
            assert.equal(d.retainedIO, true); assert.equal(d.input.cleanup, "unknown");
        }
        if (kind === "dispose") { assert.equal(before.active, 0); assert.equal(before.disposals, 1); assert.equal(failure.reader.cleanupError, 0); }
        cleared(ops); assert.ok([...ops.attempts.values()].every(n => n === 1));
        report({ modeledUnknown: kind, active: before.active, dispositions: before.disposals,
            readBytes: before.readBytes, failedReadCloses, originalSlots: slots.length, retries: 0 });
    }
});
test("capture 5: post-copy full validation clears the new copy and preserves earlier caller-owned copies", async () => {
    const f = await host();
    for (const mutation of ["owner", "grant"]) {
        const ops = modelOps(), value = create(f, ops); assert.equal((await run(value)).status, "captured");
        const original = OfflineInputSnapshotOwner.prototype.copyFile, descriptor = Object.getOwnPropertyDescriptor(f.receipt, "sha256");
        const grant = f.controller.state.primary, edit = changedInode(grant); let allocated, callbackReads = 0;
        OfflineInputSnapshotOwner.prototype.copyFile = function(index) {
            const bytes = original.call(this, index); allocated = bytes;
            Object.defineProperty(f.receipt, "sha256", { configurable: true, get() {
                callbackReads++; if (mutation === "owner") f.owner.accepting = false; else grant.inode = edit.changed;
                return descriptor.value;
            } }); return bytes;
        };
        try { await assert.rejects(run(value, "copyFile", 0)); }
        finally {
            OfflineInputSnapshotOwner.prototype.copyFile = original; Object.defineProperty(f.receipt, "sha256", descriptor);
            f.owner.accepting = true; grant.inode = edit.original;
        }
        assert.ok(callbackReads > 0); assert.equal(allocated.length, 5); assert.ok(allocated.every(byte => byte === 0));
        assert.equal(value.diagnostics.copyAllocatedBytes, 5); assert.equal(value.diagnostics.rejectedCopyBytes, 5);
        assert.equal(value.diagnostics.deliveredCopyBytes, 0); cleared(ops); released(value);
        report({ postCopyReceiptCallback: mutation, newCopyCleared: 5, delivered: 0 });
    }
    const ops = modelOps(), value = create(f, ops); assert.equal((await run(value)).status, "captured");
    const bytes = await run(value, "copyFile", 0), renewals = value.diagnostics.renewals;
    try {
        await assert.rejects(run(value, "copyFile", 0)); assert.equal(value.diagnostics.renewals, renewals);
        assert.equal(bytes.toString(), text); assert.equal(value.diagnostics.deliveredCopyBytes, 5); cleared(ops); released(value);
    } finally { bytes.fill(0); }
});
test("capture 6: sealed readers preserve original settle semantics and captured owners weakly retain retired hosts", async () => {
    const f = await host();
    for (const seal of [false, true]) {
        const ops = modelOps(), value = create(f, ops, inputFor(f), "source");
        await run(value, "prepare"); value.initialize();
        const bytes = Buffer.alloc(5); standaloneAllocatedBytes += bytes.length;
        try {
            const token = value.open("source.txt"); let offset = 0;
            while (offset < bytes.length) {
                const remaining = bytes.length - offset, count = value.read(token, bytes, offset, remaining);
                assert.ok(Number.isInteger(count) && count > 0 && count <= remaining); offset += count;
            }
            assert.equal(bytes.toString(), text); assert.equal(value.close(token), true);
        } finally { bytes.fill(0); standaloneClearedBytes += bytes.length; }
        assert.equal((seal ? value.seal() : value.settle()).status, seal ? "sealed" : "settled");
        assert.equal(value.diagnostics.retainedPermission, seal); assert.equal(value.diagnostics.retainedReader, false);
        const before = ops.diagnostics; assert.throws(() => value.initialize()); assert.deepEqual(ops.diagnostics, before);
        assert.equal(value.diagnostics.retainedPermission, false);
    }
    let retired = await host(), input = inputFor(retired);
    const ops = modelOps(), value = create(retired, ops, input); assert.equal((await run(value)).status, "captured");
    const refs = [retired.owner, retired.runtime, retired.boundary, retired.ctx, retired.revisions, retired.receipt, retired.receipt.bytes,
        retired.controller, retired.controller.state, retired.controller.state.primary,
        originalIssued.call(retired.controller.state, retired.controller.state.primary), input].map(item => new WeakRef(item));
    await retired.dispose(); retired = undefined; input = undefined;
    for (let i = 0; i < 4; i++) { await tick(); global.gc(); }
    const liveTargets = refs.reduce((sum, ref) => sum + Number(ref.deref() !== undefined), 0);
    assert.equal(value.status, "captured"); assert.equal(liveTargets, 0);
    await assert.rejects(run(value, "copyFile", 0)); released(value); cleared(ops);
    report({ controlledGcRounds: 4, weakTargets: refs.length, liveTargets, capturedWrapperAlive: true, originalSidecarIncluded: true });
});
