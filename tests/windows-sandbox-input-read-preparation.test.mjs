import assert from "node:assert/strict";
import test, { before, after, afterEach } from "node:test";
import { mkdtemp, open, lstat, realpath, unlink, rmdir } from "node:fs/promises";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { setImmediate as tick } from "node:timers/promises";
import { SessionFiles } from "../packages/coding-agent/src/core/files/session-files.ts";
import { SessionExecutionBoundary } from "../packages/coding-agent/src/core/execution-boundary.ts";
import { createEventBus } from "../packages/coding-agent/src/core/event-bus.ts";
import { NATIVE_FILE_REVISION } from "../packages/coding-agent/src/core/files/file-host.ts";
import { nativeFileDiagnostics } from "../packages/coding-agent/src/core/files/native-file-client.ts";
import { InputReadPolicyLease, freezeInputReadPaths } from "../packages/coding-agent/src/core/files/session-input-read-permission.ts";
import { INPUT_LIMITS } from "../scripts/acceptance/windows-sandbox-input-snapshot.mjs";
import { WindowsInputReadPreparation } from "../scripts/acceptance/windows-sandbox-input-read-preparation.mjs";

// Resolve ONLY the new internal export to the exact source URL already statically
// imported above. No build, old test import, dist fallback for the new class, or probe.
const policyUrl = new URL("../packages/coding-agent/src/core/files/session-input-read-permission.ts", import.meta.url).href;
const loader = registerHooks({ resolve(specifier, context, next) {
    if (specifier === "@super-pi/coding-agent/internal/files/session-input-read-permission") return { url: policyUrl, shortCircuit: true };
    return next(specifier, context);
} });
let SessionPermissionController;
try { ({ SessionPermissionController } = await import("../packages/extensions/resource-lifecycle-guard/permission-controller.ts")); }
finally { loader.deregister(); }
const controllerPrepare = SessionPermissionController.prototype.prepareInputRead;
const text = "alpha", sessionId = "input_read_prepare", uuid = "11111111-2222-4333-8444-555555555555";
const id = stat => ({ dev: stat.dev, ino: stat.ino });
const fileId = stat => ({ ...id(stat), size: stat.size, mtimeNs: stat.mtimeNs, ctimeNs: stat.ctimeNs });
const same = (a, b) => a.dev === b.dev && a.ino === b.ino;
let parent, root, leaf, rootId, leafId, rootCreated = false, leafCreated = false;
let rootRemoved = false, leafRemoved = false, rootRemoveAttempted = false, leafRemoveAttempted = false;
let safe = true, acquire = true, fixtureHandle, fixtureOpens = 0, fixtureCloseAttempts = 0, fixtureClosed = 0;
let issuances = 0, assessments = 0, prepareCalls = 0, reportBytes = 0, registeredPreparations = 0;
const errors = [], preparations = new Set(), hosts = new Set(), pending = new Set();
const originalAssessments = new WeakMap();
const workerBefore = nativeFileDiagnostics();
function countedAssessment(path, cwd) {
    live(); assert.ok(assessments < 256); assessments++;
    return originalAssessments.get(this).call(this, path, cwd);
}
function countedPrepare(context, paths) {
    live(); assert.ok(prepareCalls < 96); prepareCalls++;
    return controllerPrepare.call(this, context, paths);
}
function report(value) {
    const line = JSON.stringify(value); reportBytes += Buffer.byteLength(line) + 1;
    assert.ok(reportBytes <= 16384); console.log(line);
}
function live() { assert.ok(safe && acquire, "no new work after unresolved fixture/session"); }
function track(value) { preparations.add(value); registeredPreparations++; return value; }
function create(f, input = inputFor(f)) { live(); return track(new WindowsInputReadPreparation(input, f.owner, f.ctx)); }
async function run(preparation) {
    const promise = preparation.prepare(); pending.add(promise);
    try { return await promise; } finally { pending.delete(promise); }
}
async function drain() {
    for (const value of preparations) value.dispose();
    preparations.clear();
    // All test-controlled gates are released in their own finally blocks. Logical
    // revoke alone is not treated as cancellation of an in-flight FS observation.
    for (const value of pending) try { await value; } catch { /* original caller observes */ }
    pending.clear();
    for (const value of hosts) try { await value.dispose(); }
    catch (error) { safe = false; acquire = false; errors.push({ stage: "session cleanup", error }); }
}
afterEach(drain);
before(async () => {
    assert.equal(process.platform, "win32"); assert.equal(typeof global.gc, "function");
    try {
        parent = await realpath(tmpdir()); root = await mkdtemp(join(parent, "sp-input-permission-")); rootCreated = true;
        report({ createdRoot: root }); rootId = id(await lstat(root, { bigint: true }));
        assert.equal(dirname(resolve(root)), parent); leaf = join(root, "source.txt");
        fixtureHandle = await open(leaf, "wx"); fixtureOpens++; leafCreated = true;
        let failed = false, failure, closeFailed = false, closeError;
        try { leafId = id(await fixtureHandle.stat({ bigint: true })); await fixtureHandle.writeFile(text); }
        catch (error) { failed = true; failure = error; }
        fixtureCloseAttempts++;
        try { await fixtureHandle.close(); fixtureClosed++; fixtureHandle = undefined; }
        catch (error) { closeFailed = true; closeError = error; safe = false; }
        if (failed || closeFailed) errors.push({ stage: "fixture", failed, failure, closeFailed, closeError });
        if (failed && closeFailed) throw new AggregateError([failure, closeError], "fixture errors");
        if (failed) throw failure; if (closeFailed) throw closeError;
    } catch (error) { acquire = false; errors.push({ stage: "fixture setup", error }); throw error; }
});
after(async () => {
    await drain();
    if (safe) {
        if (leafCreated && leafId) try {
            leafRemoveAttempted = true;
            const parentNow = await lstat(root, { bigint: true }), actual = await lstat(leaf, { bigint: true });
            assert.ok(rootId && same(parentNow, rootId) && parentNow.isDirectory() && !parentNow.isSymbolicLink());
            assert.equal(await realpath(root), root); assert.equal(dirname(resolve(leaf)), root);
            assert.ok(same(actual, leafId) && actual.isFile() && !actual.isSymbolicLink()); assert.equal(await realpath(leaf), leaf);
            await unlink(leaf); leafRemoved = true; await assert.rejects(lstat(leaf), { code: "ENOENT" });
        } catch (error) { errors.push({ stage: "leaf cleanup", error }); }
        if (rootCreated && rootId) try {
            rootRemoveAttempted = true; const actual = await lstat(root, { bigint: true });
            assert.ok(same(actual, rootId) && actual.isDirectory() && !actual.isSymbolicLink());
            assert.equal(dirname(resolve(root)), parent); assert.equal(await realpath(root), root);
            await rmdir(root); rootRemoved = true; await assert.rejects(lstat(root), { code: "ENOENT" });
        } catch (error) { errors.push({ stage: "root cleanup", error }); }
    }
    const workers = nativeFileDiagnostics();
    report({ root, leaf, rootCreated, leafCreated, rootIdentified: !!rootId, leafIdentified: !!leafId,
        rootRemoved, leafRemoved, rootRemoveAttempted, leafRemoveAttempted, safe,
        fixtureOpens, fixtureCloseAttempts, fixtureClosed, fixtureHandleRetained: fixtureHandle !== undefined,
        issuances, logicalReceiptBytes: issuances * 5, preparationIssuances: 0, prepareCalls, assessments,
        registeredPreparations, livePreparations: preparations.size, pending: pending.size, unresolvedHosts: hosts.size,
        nativeReaders: 0, capturedContentBytes: 0, workerStartsDelta: workers.workerStarts - workerBefore.workerStarts,
        workerCallsDelta: workers.calls - workerBefore.calls, workerPending: workers.pending,
        implicitNodeOsIoInstrumented: false, errors: errors.map(value => value.stage) });
    assert.equal(errors.length, 0); assert.equal(safe, true); assert.equal(rootRemoved, true); assert.equal(leafRemoved, true);
    assert.equal(fixtureOpens, 1); assert.equal(fixtureCloseAttempts, 1); assert.equal(fixtureClosed, 1);
    assert.ok(issuances <= 12 && prepareCalls <= 96 && assessments <= 256);
    assert.equal(workers.workerStarts - workerBefore.workerStarts, 0); assert.equal(workers.calls - workerBefore.calls, 0);
    assert.equal(workers.pending, 0); assert.equal(hosts.size, 0); assert.equal(pending.size, 0);
});

async function host({ read = true, attach = true } = {}) {
    live(); const events = createEventBus(), boundary = new SessionExecutionBoundary();
    const state = { active: true, sessionId, hook: undefined };
    const runtime = { executionBoundary: boundary, assertActive() { state.hook?.(); assert.ok(state.active); },
        trackEventBusSubscription(value) { return value; }, appendEntry() { throw new Error("unexpected journal write"); } };
    const ctx = { cwd: root, signal: undefined, sessionManager: { getSessionId() { return state.sessionId; }, getBranch() { return []; } },
        ui: { setStatus() {} } };
    let owner, controller, ownerAttempted = false, boundaryAttempted = false, ownerClosed = false, boundaryClosed = false;
    const disposalErrors = [], record = { dispose }; hosts.add(record);
    async function dispose() {
        state.hook = undefined;
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
        if (ownerClosed && boundaryClosed) hosts.delete(record); else { safe = false; acquire = false; }
        if (disposalErrors.length) throw new AggregateError(disposalErrors, "session cleanup");
        assert.equal(ownerClosed, true); assert.equal(boundaryClosed, true);
    }
    try {
        owner = new SessionFiles(runtime, events);
        controller = new SessionPermissionController({ registerExecutionOwner(name, participant) { return boundary.register(name, participant); },
            events: { emit() {} }, appendEntry() { throw new Error("unexpected permission journal"); } });
        await controller.restore(ctx);
        originalAssessments.set(controller.state, controller.state.assessTarget);
        controller.state.assessTarget = countedAssessment;
        controller.prepareInputRead = countedPrepare;
        if (attach) owner.setCompatibilityBoundary(controller);
        const tools = { read: { async execute() { return { content: [{ type: "text", text }] }; } } }; owner.install(tools);
        let revisions, receipt, revision;
        if (read) {
            assert.ok(issuances < 12); issuances++;
            const result = await tools.read.execute("permission-fixture", { path: "source.txt" }, undefined, undefined, ctx);
            revision = result[NATIVE_FILE_REVISION]; assert.match(revision, /^snap_[A-Za-z0-9_-]{22}$/);
            const source = owner.pinReadRevisions(ctx);
            try { revisions = source.revisions; receipt = revisions.get(revision); }
            finally { source.dispose(); }
            assert.equal(receipt.mode, "full"); assert.equal(receipt.bytes.toString(), text);
            assert.ok(same(receipt.identity, leafId)); assert.equal(receipt.canonicalPath, leaf);
        }
        return { owner, controller, runtime, boundary, ctx, state, revisions, receipt, revision, dispose };
    } catch (error) {
        acquire = false;
        try { await dispose(); } catch (cleanupError) { throw new AggregateError([error, cleanupError], "setup and cleanup"); }
        throw error;
    }
}
function inputFor(f) {
    return { taskId: uuid, snapshotId: uuid, sessionId, epoch: f.revisions.generation,
        sourceRoot: { path: root, identity: { ...rootId } }, budget: { ...INPUT_LIMITS },
        entries: [{ path: "source.txt", classification: "ordinary", expose: true, operation: "modify", parents: [],
            revision: f.revision, identity: fileId(f.receipt.identity), sha256: f.receipt.sha256 }] };
}
function check(value, input) { return value.checkPrepared(input, input.entries); }
function released(value) {
    const d = value.diagnostics;
    assert.equal(d.retainedSource, false); assert.equal(d.retainedLease, false); assert.equal(d.retainedPermission, false);
    assert.equal(d.retainedAuthority, false);
    if (d.source) assert.equal(d.source.weakReferences, 0);
    if (d.permission) { assert.equal(d.permission.weakReferences, 0); assert.equal(d.permission.retainedPolicy, false); }
}
async function gate(f, action) {
    const original = f.controller.prepareInputRead;
    const entered = Promise.withResolvers(), releasedGate = Promise.withResolvers();
    let returnedPolicy;
    f.controller.prepareInputRead = async function(ctx, paths) {
        returnedPolicy = await original.call(this, ctx, paths); entered.resolve(); await releasedGate.promise; return returnedPolicy;
    };
    const input = inputFor(f), value = create(f, input), running = run(value);
    // Attach rejection observation immediately; no unhandled promise interval.
    const outcome = running.then(result => ({ result }), error => ({ rejected: true, error }));
    try {
        await Promise.race([entered.promise, outcome.then(result => { throw new Error("preparation settled before controlled gate", { cause: result }); })]);
        await action(value, input);
    }
    finally { releasedGate.resolve(); f.controller.prepareInputRead = original; }
    const result = await outcome;
    assert.equal(result.rejected, true); assert.equal(value.status, "rejected"); released(value);
    assert.equal(returnedPolicy.diagnostics.state, "disposed");
    assert.equal(value.diagnostics.permission.policyDisposals, 1);
    return result;
}
async function observationGate(f, action) {
    const original = f.controller.state.assessTarget;
    const entered = Promise.withResolvers(), release = Promise.withResolvers();
    let held = false;
    f.controller.state.assessTarget = async function(path, cwd) {
        const result = await original.call(this, path, cwd);
        if (!held) { held = true; entered.resolve(); await release.promise; }
        return result;
    };
    const input = inputFor(f), value = create(f, input), running = run(value);
    const outcome = running.then(result => ({ result }), error => ({ rejected: true, error }));
    try {
        await Promise.race([entered.promise, outcome.then(result => { throw new Error("observation settled before gate", { cause: result }); })]);
        await action(value, input);
    } finally { release.resolve(); f.controller.state.assessTarget = original; }
    const result = await outcome;
    assert.equal(result.rejected, true); released(value); assert.equal(value.diagnostics.permission.pending, false);
    return result;
}

test("read preparation 1: real policy preparation, original namespace and immutable caller snapshot", async () => {
    const f = await host(), original = inputFor(f), expected = structuredClone(original), value = create(f, original);
    original.taskId = "99999999-2222-4333-8444-555555555555"; original.entries[0].path = "mutated.txt";
    assert.deepEqual(await run(value), { status: "prepared", filesystemRenewed: false });
    assert.equal(check(value, expected), true); assert.equal(value.diagnostics.observationPaths, 2);
    const policy = await f.controller.prepareInputRead(f.ctx, [root, leaf]);
    try { assert.ok(policy instanceof InputReadPolicyLease); assert.ok(Object.isFrozen(policy.paths)); policy.assertCurrent(); }
    finally { policy.dispose(); }
    report({ prepared: value.diagnostics, sourceModuleIdentityVerified: true, filesystemRenewed: false });
});
test("read preparation 2: no service, missing/unsupported boundary and actual outside scope refuse", async () => {
    const empty = await host({ read: false, attach: false });
    assert.throws(() => empty.owner.pinInputReadPermission(empty.ctx, {}, [root]), /STALE/);
    assert.deepEqual(empty.owner.getDiagnostics(), { pending: 0, inFlight: 0, revisions: 0, closed: false });
    const f = await host({ attach: false }), input = inputFor(f);
    assert.throws(() => create(f, input), /STALE/);
    f.owner.setCompatibilityBoundary({ authorizeFileObservation() { assert.fail("legacy lifecycle fallback called"); } });
    assert.throws(() => create(f, input), /STALE/);
    const before = assessments;
    await assert.rejects(f.controller.prepareInputRead(f.ctx, [join(parent, "permission-outside.txt")]), /outside/);
    assert.equal(assessments, before + 1); assert.equal(f.owner.getDiagnostics().revisions, 1);
});
test("read preparation 3: original permission, source and receipt are rechecked after the async wait", async () => {
    const f = await host();
    await gate(f, () => { f.controller.state.setMode("read-only"); });
    f.controller.state.setMode("workspace-write");
    await gate(f, () => { f.ctx.signal = new AbortController().signal; }); f.ctx.signal = undefined;
    await gate(f, () => { f.revisions.forget(f.revision); });
    assert.equal(f.owner.getDiagnostics().revisions, 0);
    // This second gate is INSIDE actual authorizeFileObservation, at the real
    // assessTarget result await. It is distinct from a late completed policy.
    const observing = await host();
    await observationGate(observing, () => { observing.controller.state.setMode("read-only"); });
    observing.controller.state.setMode("workspace-write");
    await observationGate(observing, () => { observing.ctx.signal = new AbortController().signal; }); observing.ctx.signal = undefined;
    await observationGate(observing, () => { observing.revisions.forget(observing.revision); });
    assert.equal(observing.owner.getDiagnostics().revisions, 0);
});
test("read preparation 4: failed policy/context/signal/boundary checks cannot revive", async () => {
    const f = await host();
    for (const kind of ["sequence", "signal", "session", "boundary"]) {
        const input = inputFor(f), value = create(f, input); await run(value);
        const checkpoint = f.controller.state.checkpoint(), originalBoundary = f.owner.boundary;
        if (kind === "sequence") f.controller.state.setMode("read-only");
        if (kind === "signal") f.ctx.signal = new AbortController().signal;
        if (kind === "session") f.state.sessionId = "other_session";
        if (kind === "boundary") f.owner.boundary = { authorizeFileObservation: originalBoundary.authorizeFileObservation };
        assert.throws(() => check(value, input)); released(value);
        f.controller.state.restoreCheckpoint(checkpoint); f.ctx.signal = undefined; f.state.sessionId = sessionId; f.owner.boundary = originalBoundary;
        assert.throws(() => check(value, input));
    }
    // In the audited checkSource chain, the seventh runtime assertion is the
    // last external callback. Permission identity must be checked AFTER it.
    const source = f.owner.pinReadRevisions(f.ctx), permission = f.owner.pinInputReadPermission(f.ctx, source, [root, leaf]);
    const originalBoundary = f.owner.boundary; let runtimeChecks = 0;
    try {
        await permission.prepare();
        f.state.hook = () => { if (++runtimeChecks === 7) f.owner.boundary = {}; };
        assert.throws(() => permission.checkSource()); assert.equal(runtimeChecks, 7);
        f.state.hook = undefined; f.owner.boundary = originalBoundary;
        assert.throws(() => permission.checkSource());
    } finally { f.state.hook = undefined; f.owner.boundary = originalBoundary; permission.dispose(); source.dispose(); }
    const directPolicy = await f.controller.prepareInputRead(f.ctx, [root, leaf]);
    const beforePolicy = f.controller.state.checkpoint();
    try {
        f.controller.state.setMode("read-only"); assert.throws(() => directPolicy.assertCurrent());
        f.controller.state.restoreCheckpoint(beforePolicy); assert.throws(() => directPolicy.assertCurrent());
    } finally { f.controller.state.restoreCheckpoint(beforePolicy); directPolicy.dispose(); }
    for (const kind of ["core-final", "outer-final"]) {
        const checkpoint = f.controller.state.checkpoint(), input = inputFor(f);
        let source, permission, value, runtimeChecks = 0;
        try {
            if (kind === "core-final") {
                source = f.owner.pinReadRevisions(f.ctx); permission = f.owner.pinInputReadPermission(f.ctx, source, [root, leaf]);
                await permission.prepare();
            } else { value = create(f, input); await run(value); }
            const lastCallback = kind === "core-final" ? 14 : 36;
            f.state.hook = () => { if (++runtimeChecks === lastCallback) f.controller.state.setMode("read-only"); };
            assert.throws(() => kind === "core-final" ? permission.assertCurrent() : check(value, input));
            assert.equal(runtimeChecks, lastCallback);
            f.state.hook = undefined; f.controller.state.restoreCheckpoint(checkpoint);
            assert.throws(() => kind === "core-final" ? permission.assertCurrent() : check(value, input));
        } finally {
            f.state.hook = undefined; f.controller.state.restoreCheckpoint(checkpoint); permission?.dispose(); source?.dispose(); value?.dispose();
        }
    }
    const controller = new AbortController(); f.ctx.signal = controller.signal;
    const input = inputFor(f), value = create(f, input); await run(value); controller.abort(0);
    let caught = false; try { check(value, input); } catch (error) { caught = true; assert.equal(error, 0); }
    assert.equal(caught, true); assert.equal(value.failure.error, 0); released(value);
});
test("read preparation 5: full binding, entry fields and non-exposed/add observations remain bound", async () => {
    const f = await host(), input = inputFor(f); input.entries[0].expose = false;
    input.entries.push({ path: "new.txt", classification: "ordinary", expose: false, operation: "add", parents: [], revision: null, identity: null, sha256: null });
    const original = f.controller.prepareInputRead; let observed;
    f.controller.prepareInputRead = function(ctx, paths) { observed = paths; return original.call(this, ctx, paths); };
    const value = create(f, input); await run(value);
    assert.deepEqual(observed, [root, leaf, join(root, "new.txt")]); assert.ok(Object.isFrozen(observed)); assert.equal(check(value, input), true);
    for (const kind of ["task", "snapshot", "epoch", "rootIdentity", "expose", "operation", "revision", "identity", "hash", "path", "parents"]) {
        const current = create(f, input); await run(current); const changed = structuredClone(input);
        if (kind === "task") changed.taskId = "99999999-2222-4333-8444-555555555555";
        if (kind === "snapshot") changed.snapshotId = "99999999-2222-4333-8444-555555555555";
        if (kind === "epoch") changed.epoch++;
        if (kind === "rootIdentity") changed.sourceRoot.identity.ino++;
        if (kind === "expose") changed.entries[0].expose = true;
        if (kind === "operation") changed.entries[0].operation = null;
        if (kind === "revision") changed.entries[0].revision = "snap_aaaaaaaaaaaaaaaaaaaaaa";
        if (kind === "identity") changed.entries[0].identity.mtimeNs++;
        if (kind === "hash") changed.entries[0].sha256 = "0".repeat(64);
        if (kind === "path") changed.entries[0].path = "other.txt";
        if (kind === "parents") changed.entries[0].parents.push({ path: "other", identity: { ...rootId } });
        assert.throws(() => check(current, changed), /namespace/); released(current); assert.throws(() => check(current, input));
    }
});
test("read preparation 6: pending revoke/dispose, original falsy errors, swallowed reentry and callback forget", async () => {
    const f = await host();
    for (const kind of ["revoke", "dispose"]) await gate(f, value => { value[kind](); released(value); });
    const original = f.controller.prepareInputRead;
    for (const error of [undefined, null, 0]) {
        f.controller.prepareInputRead = async function() { throw error; };
        const value = create(f); let caught = false;
        try { await run(value); } catch (actual) { caught = true; assert.equal(actual, error); }
        assert.equal(caught, true); assert.equal(value.failure.failed, true); assert.equal(value.failure.error, error); released(value);
    }
    f.controller.prepareInputRead = original;
    const input = inputFor(f), reentry = create(f, input); await run(reentry);
    f.state.hook = () => { try { check(reentry, input); } catch {} };
    assert.throws(() => check(reentry, input)); f.state.hook = undefined; released(reentry); assert.throws(() => check(reentry, input));
    const forgotten = create(f, input); await run(forgotten);
    f.state.hook = () => { f.revisions.forget(f.revision); };
    assert.throws(() => check(forgotten, input)); f.state.hook = undefined; released(forgotten);
});
test("read preparation 7: exact budgets, original lease admission and borrowed source ownership", async () => {
    const f = await host();
    assert.throws(() => freezeInputReadPaths([]));
    assert.throws(() => freezeInputReadPaths([root, root]));
    assert.throws(() => freezeInputReadPaths(Array.from({ length: 35 }, (_, i) => join(root, String(i)))));
    assert.throws(() => freezeInputReadPaths(["C:\\" + "a".repeat(4090), "C:\\" + "b".repeat(4090), "C:\\more"]));
    assert.equal(freezeInputReadPaths(Array.from({ length: 34 }, (_, i) => join(root, String(i)))).length, 34);
    const input = inputFor(f), empty = { ...input, entries: [] };
    assert.throws(() => create(f, empty), /existing-required/);
    const add = { ...input, entries: [{ path: "new.txt", classification: "ordinary", expose: false, operation: "add", parents: [], revision: null, identity: null, sha256: null }] };
    assert.throws(() => create(f, add), /existing-required/);
    const source = f.owner.pinReadRevisions(f.ctx), permission = f.owner.pinInputReadPermission(f.ctx, source, [root, leaf]);
    try {
        await permission.prepare(); permission.dispose();
        assert.equal(source.current(), true); assert.equal(f.owner.getDiagnostics().closed, false);
        await assert.rejects(permission.prepare()); assert.equal(source.current(), true);
    } finally { permission.dispose(); source.dispose(); }
    // Same service, two distinct contexts: the bridge must use pin-time signal,
    // even though the source's own context and signal have remained unchanged.
    const otherCtx = { ...f.ctx }, originalSource = f.owner.pinReadRevisions(f.ctx);
    let independent;
    try {
        independent = f.owner.pinInputReadPermission(otherCtx, originalSource, [root, leaf]);
        const callsBefore = prepareCalls; otherCtx.signal = new AbortController().signal;
        await assert.rejects(independent.prepare()); assert.equal(prepareCalls, callsBefore);
        otherCtx.signal = undefined; await assert.rejects(independent.prepare());
        assert.equal(originalSource.current(), true); assert.equal(independent.diagnostics.metadataChars, 0);
    } finally { independent?.dispose(); originalSource.dispose(); }
});
test("read preparation 8: live prepared wrapper does not retain retired source/controller/input objects", async () => {
    let f = await host(), input = inputFor(f);
    const value = create(f, input); await run(value);
    const refs = [f.owner, f.runtime, f.boundary, f.ctx, f.revisions, f.receipt, f.receipt.bytes, f.controller, input].map(item => new WeakRef(item));
    const binding = structuredClone(input); await f.dispose(); f = undefined; input = undefined;
    for (let i = 0; i < 4; i++) { await tick(); global.gc(); }
    const liveTargets = refs.reduce((count, ref) => count + Number(ref.deref() !== undefined), 0);
    assert.equal(value.status, "prepared"); assert.equal(liveTargets, 0);
    assert.throws(() => check(value, binding)); released(value);
    report({ controlledGcRounds: 4, weakTargets: refs.length, liveTargets, preparedWrapperKeptAlive: true, released: value.diagnostics });
});
