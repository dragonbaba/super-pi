import assert from "node:assert/strict";
import test, { before, after, afterEach } from "node:test";
import { mkdtemp, mkdir, lstat, realpath, rmdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { registerHooks } from "node:module";
import { setImmediate as tick } from "node:timers/promises";
import { types as utilTypes } from "node:util";
import { InputWorkspaceGrantLease, freezeInputWorkspaceBinding, freezeInputReadPaths }
    from "../packages/coding-agent/src/core/files/input-workspace-grant-lease.ts";
import { nativeFileDiagnostics } from "../packages/coding-agent/src/core/files/native-file-client.ts";

// Only these internal exports are redirected to their identical source modules.
// No prior test import, build, probe, receipt issuer or native reader is invoked.
const sources = new Map([
    ["@super-pi/coding-agent/internal/files/input-workspace-grant-lease",
        new URL("../packages/coding-agent/src/core/files/input-workspace-grant-lease.ts", import.meta.url).href],
    ["@super-pi/coding-agent/internal/files/session-input-read-permission",
        new URL("../packages/coding-agent/src/core/files/session-input-read-permission.ts", import.meta.url).href],
]);
const loader = registerHooks({ resolve(specifier, context, next) {
    const url = sources.get(specifier); return url ? { url, shortCircuit: true } : next(specifier, context);
} });
let SessionPermissionController;
try { ({ SessionPermissionController } = await import("../packages/extensions/resource-lifecycle-guard/permission-controller.ts")); }
finally { loader.deregister(); }

const originalPrepare = InputWorkspaceGrantLease.prototype.prepare;
const controllerPrepare = SessionPermissionController.prototype.prepareInputWorkspaceRead;
const originalAssessment = new WeakMap();
const leases = new Set(), hosts = new Set(), pending = new Set(), errors = [];
const workersBefore = nativeFileDiagnostics();
let root, work, parent, rootId, workId, rootCreated = false, workCreated = false;
let rootRemoved = false, workRemoved = false, rootRemoveAttempted = false, workRemoveAttempted = false;
let safe = true, acquire = true, observations = 0, assessments = 0, registered = 0, reportBytes = 0;
let lastRegistered, preparedGate;
function live() { assert.ok(safe && acquire, "no further work after unsafe fixture/host setup"); }
function report(value) {
    const line = JSON.stringify(value); reportBytes += Buffer.byteLength(line) + 1;
    assert.ok(reportBytes <= 16384); console.log(line);
}
function countedAssessment(path, cwd) {
    live(); assert.ok(assessments < 256); assessments++;
    return originalAssessment.get(this).call(this, path, cwd);
}
InputWorkspaceGrantLease.prototype.prepare = function() {
    // Registration occurs before this exact initial async observation starts.
    leases.add(this); registered++; lastRegistered = this;
    const promise = originalPrepare.call(this), gate = preparedGate, lease = this;
    if (!gate) return promise;
    return promise.then(async value => {
        gate.entered(lease); await gate.waiting; return value;
    });
};
async function tracked(promise) {
    pending.add(promise);
    try { return await promise; } finally { pending.delete(promise); }
}
function prepare(f, paths = [work]) {
    live(); assert.ok(observations < 64); observations++;
    return tracked(controllerPrepare.call(f.controller, f.ctx, paths));
}
function renew(lease) {
    live(); assert.ok(observations < 64); observations++;
    return tracked(lease.renew());
}
function released(lease) {
    const d = lease.diagnostics;
    assert.equal(d.weakReferences, 0); assert.equal(d.grants, 0); assert.equal(d.paths, 0);
    assert.equal(d.grantChars, 0); assert.equal(d.pathChars, 0);
    assert.equal(d.retainedObserver, false); assert.equal(d.retainedVerifier, false);
}
async function drain() {
    for (const lease of leases) lease.dispose();
    // Every controlled gate is released by its own finally before reaching here.
    for (const promise of pending) try { await promise; } catch { /* original caller observes */ }
    pending.clear(); leases.clear(); lastRegistered = undefined; preparedGate = undefined;
    for (const record of hosts) record.dispose();
}
afterEach(drain);
const id = value => ({ dev: value.dev, ino: value.ino });
const same = (a, b) => a.dev === b.dev && a.ino === b.ino;
const loggedId = value => value ? { dev: value.dev.toString(), ino: value.ino.toString() } : null;
const errorNames = new Map([[Error.prototype, "Error"], [TypeError.prototype, "TypeError"],
    [RangeError.prototype, "RangeError"], [ReferenceError.prototype, "ReferenceError"],
    [SyntaxError.prototype, "SyntaxError"], [AggregateError.prototype, "AggregateError"]]);
function loggedPrimitive(value, limit) {
    if (value === undefined) return { type: "undefined" };
    if (value === null || typeof value === "boolean") return value;
    if (typeof value === "string") return { type: "string", value: value.slice(0, limit), chars: value.length };
    if (typeof value === "number") return Number.isFinite(value) ? value : { type: "number", value: String(value) };
    return { type: typeof value }; // No object conversion, getters, stack or arbitrary toString.
}
function loggedError(error) {
    if (!utilTypes.isNativeError(error)) return loggedPrimitive(error, 640);
    const proto = Object.getPrototypeOf(error);
    const ownName = Object.getOwnPropertyDescriptor(error, "name");
    const message = Object.getOwnPropertyDescriptor(error, "message"), code = Object.getOwnPropertyDescriptor(error, "code");
    return { type: "nativeError", name: loggedPrimitive(ownName?.value ?? errorNames.get(proto) ?? "Error", 64),
        code: loggedPrimitive(code?.value, 128), message: loggedPrimitive(message?.value, 640) };
}
before(async () => {
    assert.equal(process.platform, "win32"); assert.equal(typeof global.gc, "function");
    try {
        parent = await realpath(tmpdir()); root = await mkdtemp(join(parent, "sp-workspace-grant-")); rootCreated = true;
        report({ createdRoot: root }); rootId = id(await lstat(root, { bigint: true }));
        report({ identifiedRoot: root, identity: loggedId(rootId) });
        assert.equal(dirname(resolve(root)), parent);
        work = join(root, "work"); await mkdir(work); workCreated = true;
        report({ createdWork: work });
        workId = id(await lstat(work, { bigint: true }));
        report({ identifiedWork: work, identity: loggedId(workId) });
    } catch (error) {
        acquire = false;
        if (rootCreated && !rootId || workCreated && !workId) safe = false;
        errors.push({ stage: "fixture setup", error }); throw error;
    }
});
async function removeWork() {
    assert.equal(pending.size, 0); assert.equal(workRemoveAttempted, false);
    workRemoveAttempted = true;
    const outer = await lstat(root, { bigint: true }), inner = await lstat(work, { bigint: true });
    assert.ok(rootId && same(outer, rootId) && outer.isDirectory() && !outer.isSymbolicLink());
    assert.ok(workId && same(inner, workId) && inner.isDirectory() && !inner.isSymbolicLink());
    assert.equal(await realpath(root), root); assert.equal(await realpath(work), work);
    assert.equal(dirname(resolve(work)), root);
    await rmdir(work); workRemoved = true; await assert.rejects(lstat(work), { code: "ENOENT" });
}
after(async () => {
    try { await drain(); } finally { InputWorkspaceGrantLease.prototype.prepare = originalPrepare; }
    if (safe) {
        if (workCreated && workId && !workRemoveAttempted) try { await removeWork(); }
        catch (error) { safe = false; errors.push({ stage: "work cleanup", error }); }
        if (rootCreated && rootId && (!workCreated || workRemoved)) try {
            rootRemoveAttempted = true; const value = await lstat(root, { bigint: true });
            assert.ok(same(value, rootId) && value.isDirectory() && !value.isSymbolicLink());
            assert.equal(await realpath(root), root); assert.equal(dirname(resolve(root)), parent);
            await rmdir(root); rootRemoved = true; await assert.rejects(lstat(root), { code: "ENOENT" });
        } catch (error) { safe = false; errors.push({ stage: "root cleanup", error }); }
    }
    const workers = nativeFileDiagnostics();
    report({ root, work, rootCreated, workCreated, rootIdentified: !!rootId, workIdentified: !!workId,
        rootIdentity: loggedId(rootId), workIdentity: loggedId(workId),
        rootRemoveAttempted, workRemoveAttempted, rootRemoved, workRemoved, safe,
        observations, assessments, registeredLeases: registered, liveLeases: leases.size, pending: pending.size, hosts: hosts.size,
        contentFiles: 0, contentBytes: 0, receiptIssuances: 0, nativeReaders: 0, capturedBytes: 0,
        explicitFixtureOpens: 0, explicitFixtureCloses: 0,
        workerStartsDelta: workers.workerStarts - workersBefore.workerStarts,
        workerCallsDelta: workers.calls - workersBefore.calls, workerPending: workers.pending,
        implicitNodeMetadataIoFullyInstrumented: false, errors: errors.map(value => ({ stage: value.stage, error: loggedError(value.error) })) });
    if (errors.length === 1) throw errors[0].error;
    if (errors.length > 1) throw new AggregateError(errors.map(value => value.error), "original fixture errors");
    assert.equal(safe, true); assert.equal(rootRemoved, true); assert.equal(workRemoved, true);
    assert.ok(observations <= 64 && assessments <= 256); assert.equal(hosts.size, 0); assert.equal(pending.size, 0);
    assert.equal(workers.workerStarts - workersBefore.workerStarts, 0); assert.equal(workers.calls - workersBefore.calls, 0);
    assert.equal(workers.pending, 0);
});

async function host(cwd = work) {
    live();
    const state = { sessionId: "input_workspace_grant", hook: undefined };
    const ctx = { cwd, signal: undefined,
        sessionManager: { getSessionId() { state.hook?.(); return state.sessionId; }, getBranch() { return []; } },
        ui: { setStatus() {} } };
    const controller = new SessionPermissionController({ events: { emit() {} }, appendEntry() { throw new Error("unexpected journal"); } });
    const record = { dispose() { state.hook = undefined; controller.invalidate(); hosts.delete(record); } };
    hosts.add(record);
    try {
        await controller.restore(ctx);
        const grant = controller.state.primary;
        // A real imprecise fixture grant is a failure, never a request to find a new directory.
        assert.ok(Number.isSafeInteger(grant.device) && grant.device <= 0xffffffff && grant.device >= 0);
        assert.ok(Number.isSafeInteger(grant.inode) && grant.inode > 0);
        originalAssessment.set(controller.state, controller.state.assessTarget);
        controller.state.assessTarget = countedAssessment;
        return { controller, ctx, state, dispose: record.dispose };
    } catch (error) { acquire = false; record.dispose(); throw error; }
}

test("workspace grant 1: real Controller pins original data and renews actual filesystem observations", async () => {
    const f = await host(), paths = [work, join(work, "prospective.txt")];
    const originalPaths = paths.slice(), promise = prepare(f, paths);
    paths[0] = root; paths.push(join(root, "not-authorized.txt"));
    const lease = await promise;
    assert.ok(lease instanceof InputWorkspaceGrantLease);
    const binding = lease.binding;
    assert.ok(Object.isFrozen(binding) && Object.isFrozen(binding.identity));
    assert.equal(binding.requestedPath, work); assert.equal(binding.canonicalPath, work);
    assert.deepEqual(binding.identity, workId); assert.equal(lease.diagnostics.paths, originalPaths.length);
    const beforeCount = assessments; assert.equal(await renew(lease), lease);
    assert.equal(assessments - beforeCount, 2); assert.equal(lease.diagnostics.observations, 2);
    assert.equal(lease.binding, binding); lease.assertCurrent();
    report({ sameSourceClass: true, originalBindingUnchanged: true, renewedPathAssessments: 2,
        contentOrNativeAuthorization: false, diagnostics: lease.diagnostics });
});

test("workspace grant 2: unsafe numbers, aliases, absent grants and path limits refuse without observation", async () => {
    const f = await host(), grant = f.controller.state.primary, saved = { ...grant };
    const beforeCount = assessments;
    for (const [field, value] of [["inode", Number.MAX_SAFE_INTEGER + 1], ["inode", 0], ["inode", 1.5],
        ["device", -1], ["device", 0x100000000], ["requestedPath", root]]) {
        grant[field] = value;
        try { await assert.rejects(prepare(f)); } finally { Object.assign(grant, saved); }
    }
    f.controller.state.setMode("full-access");
    await assert.rejects(prepare(f, [root]), /existing exact workspace/);
    assert.equal(assessments, beforeCount);
    grant.inode++;
    try { await assert.rejects(prepare(f), /filesystem identity changed/); }
    finally { Object.assign(grant, saved); }
    assert.equal(assessments - beforeCount, 1);
    let accessorCalls = 0;
    const accessor = { ...saved, get inode() { accessorCalls++; return saved.inode; } };
    assert.throws(() => freezeInputWorkspaceBinding(accessor)); assert.equal(accessorCalls, 0);
    const loggingError = new Error("bounded formatter");
    Object.defineProperty(loggingError, "message", { get() { accessorCalls++; throw new Error("must not log via getter"); } });
    assert.deepEqual(loggedError(loggingError).message, { type: "undefined" }); assert.equal(accessorCalls, 0);
    assert.throws(() => freezeInputReadPaths([])); assert.throws(() => freezeInputReadPaths([work, work]));
    assert.throws(() => freezeInputReadPaths(["relative"])); assert.throws(() => freezeInputReadPaths([work + "\0x"]));
    assert.throws(() => freezeInputReadPaths(Array.from({ length: 35 }, (_, index) => join(work, String(index)))));
    assert.equal(freezeInputReadPaths(Array.from({ length: 34 }, (_, index) => join(work, String(index)))).length, 34);
    const exact = ["C:\\" + "a".repeat(4093), "C:\\" + "b".repeat(4093)];
    assert.equal(freezeInputReadPaths(exact).reduce((sum, path) => sum + path.length, 0), 8192);
    assert.throws(() => freezeInputReadPaths([...exact, "C:\\c"]));
    assert.throws(() => freezeInputReadPaths(["C:\\" + "a".repeat(4094)]));
    assert.throws(() => freezeInputWorkspaceBinding({ ...saved, canonicalPath: "C:\\", requestedPath: "C:\\" }));
    assert.throws(() => freezeInputWorkspaceBinding({ ...saved, canonicalPath: "C:\\" + "x".repeat(4094), requestedPath: "C:\\" + "x".repeat(4094) }));
    report({ earlyRefusals: 7, realBigintIdentityRefusals: 1, newAssessments: assessments - beforeCount,
        accessorCalls, integerConversion: "safe original values only" });
});

test("workspace grant 3: original grant fields, additional slot identity and complete path mapping are pinned", async () => {
    const f = await host(), grant = f.controller.state.primary;
    for (const key of ["requestedPath", "canonicalPath", "device", "inode"]) {
        const lease = await prepare(f), saved = grant[key];
        grant[key] = typeof saved === "number" ? saved + 1 : root;
        try { assert.throws(() => lease.assertCurrent()); } finally { grant[key] = saved; }
        assert.throws(() => lease.assertCurrent()); released(lease);
    }
    await f.controller.state.addWorkspace(root, work);
    const additional = await prepare(f, [root]);
    const checkpoint = f.controller.state.checkpoint(), sequence = f.controller.state.sequence;
    const oldGrant = f.controller.state.additional[0];
    f.controller.state.restoreCheckpoint(checkpoint);
    assert.equal(f.controller.state.sequence, sequence); assert.notEqual(f.controller.state.additional[0], oldGrant);
    assert.throws(() => additional.assertCurrent()); released(additional);
    f.controller.state.additional[0] = oldGrant;
    assert.throws(() => additional.assertCurrent());
    const beforeCount = assessments;
    await assert.rejects(prepare(f, [root, work]), /workspace mapping/);
    assert.equal(assessments, beforeCount);
    const mapping = await prepare(f, [root]);
    f.controller.state.additional.unshift({ ...oldGrant });
    try { assert.throws(() => mapping.assertCurrent()); }
    finally { f.controller.state.additional.shift(); }
    assert.throws(() => mapping.assertCurrent()); released(mapping);
});

async function gated(f, change, { lease, restore = () => {} } = {}) {
    let enteredResolve, release;
    const entered = new Promise(resolve => { enteredResolve = resolve; });
    const waiting = new Promise(resolve => { release = resolve; });
    const state = f.controller.state, original = state.assessTarget;
    let first = true;
    state.assessTarget = async function(path, cwd) {
        const result = await original.call(this, path, cwd);
        if (first) { first = false; enteredResolve(); await waiting; }
        return result;
    };
    let promise, rejected;
    try {
        promise = lease ? renew(lease) : prepare(f);
        // Observe rejection immediately, including an unexpected early refusal.
        rejected = promise.then(value => ({ value }), error => ({ error, rejected: true }));
        const arrival = await Promise.race([entered.then(() => true), rejected.then(() => false)]);
        assert.equal(arrival, true, "real assessment reached the only test gate");
        const current = lease ?? lastRegistered;
        assert.equal(current.diagnostics.pending, true);
        change(current); release();
        const result = await rejected; assert.equal(result.rejected, true);
        restore(); assert.equal(current.diagnostics.pending, false);
        assert.throws(() => current.assertCurrent()); released(current);
        return current;
    } finally {
        release(); if (promise) try { await promise; } catch { /* checked above */ }
        state.assessTarget = original; restore();
    }
}

test("workspace grant 4: initial and renewed assessment awaits cannot adopt later policy, signal, namespace or grant", async () => {
    const f = await host(), checkpoint = f.controller.state.checkpoint(), grant = f.controller.state.primary;
    const saved = { ...grant };
    await gated(f, () => { grant.inode++; }, { restore() { Object.assign(grant, saved); } });
    await gated(f, () => f.controller.state.setMode("read-only"), { restore() { f.controller.state.restoreCheckpoint(checkpoint); } });
    await gated(f, () => { f.ctx.signal = new AbortController().signal; }, { restore() { f.ctx.signal = undefined; } });
    for (const kind of ["cwd", "session", "requested"]) {
        const lease = await prepare(f), session = f.state.sessionId;
        await gated(f, () => {
            if (kind === "cwd") f.ctx.cwd = root;
            if (kind === "session") f.state.sessionId = "changed";
            if (kind === "requested") grant.requestedPath = root;
        }, { lease, restore() { f.ctx.cwd = work; f.state.sessionId = session; Object.assign(grant, saved); } });
    }
    for (const kind of ["grant", "revoke"]) {
        let entered, release, promise;
        const arrived = new Promise(resolve => { entered = resolve; });
        const waiting = new Promise(resolve => { release = resolve; });
        preparedGate = { entered, waiting };
        try {
            promise = prepare(f);
            const outcome = promise.then(value => ({ value }), error => ({ rejected: true, error }));
            const arrival = await Promise.race([arrived.then(lease => ({ lease })), outcome]);
            const lease = arrival.lease;
            assert.ok(lease); assert.equal(lease.diagnostics.state, "ready");
            assert.equal(lease.diagnostics.pending, false); // Real prepare completed, Controller await still pending.
            assert.equal(pending.size, 1);
            if (kind === "grant") grant.inode++; else lease.revoke();
            release(); assert.equal((await outcome).rejected, true);
            Object.assign(grant, saved); assert.equal(pending.size, 0);
            assert.equal(lease.diagnostics.policyDisposals, 1); released(lease);
            assert.throws(() => lease.assertCurrent());
        } finally {
            release(); if (promise) try { await promise; } catch { /* original observed above */ }
            preparedGate = undefined; Object.assign(grant, saved);
        }
    }
    report({ assessmentAwaitCases: 6, completedPrepareLateCases: 2, latePolicyDisposedOnce: true, pending: pending.size });
});

test("workspace grant 5: pending revoke/dispose settle once and original falsy errors survive", async () => {
    const f = await host();
    for (const kind of ["revoke", "dispose"]) await gated(f, lease => {
        lease[kind](); assert.equal(lease.diagnostics.pending, true); released(lease);
    });
    for (const error of [undefined, null, 0]) {
        const lease = await prepare(f);
        const original = f.controller.state.assessTarget;
        f.controller.state.assessTarget = async function() { throw error; };
        let caught = false;
        try { await renew(lease); } catch (actual) { caught = true; assert.equal(actual, error); }
        finally { f.controller.state.assessTarget = original; }
        assert.equal(caught, true); assert.equal(lease.failure.failed, true); assert.equal(lease.failure.error, error);
        released(lease); assert.throws(() => lease.assertCurrent()); assert.equal(lease.failure.error, error);
    }
});

test("workspace grant 6: final context callbacks and swallowed reentry cannot bypass pure identity checks", async () => {
    const f = await host(), grant = f.controller.state.primary, inode = grant.inode;
    const final = await prepare(f); let callbacks = 0;
    f.state.hook = () => { callbacks++; grant.inode++; };
    try { assert.throws(() => final.assertCurrent()); }
    finally { f.state.hook = undefined; grant.inode = inode; }
    assert.equal(callbacks, 1); assert.throws(() => final.assertCurrent()); released(final);
    const reentry = await prepare(f);
    f.state.hook = () => { try { reentry.assertCurrent(); } catch {} };
    try { assert.throws(() => reentry.assertCurrent()); } finally { f.state.hook = undefined; }
    assert.throws(() => reentry.assertCurrent()); released(reentry);
    const invalidated = await prepare(f);
    f.state.hook = () => f.controller.invalidate();
    try { assert.throws(() => invalidated.assertCurrent()); } finally { f.state.hook = undefined; }
    released(invalidated);
    report({ lastContextCallback: callbacks, grantChangedAfterPolicyCallbackRejected: true, swallowedReentryRejected: true });
});

test("workspace grant 7: a retained ready lease does not retain retired controller/state/context/grant/input paths", async () => {
    let f = await host(), paths = [work];
    const lease = await prepare(f, paths);
    const refs = [f.controller, f.controller.state, f.ctx, f.controller.state.primary, paths].map(value => new WeakRef(value));
    f.dispose(); f = undefined; paths = undefined;
    for (let i = 0; i < 4; i++) { await tick(); global.gc(); }
    const liveTargets = refs.reduce((sum, ref) => sum + Number(ref.deref() !== undefined), 0);
    assert.equal(lease.diagnostics.state, "ready"); assert.equal(liveTargets, 0);
    assert.throws(() => lease.assertCurrent()); released(lease);
    report({ gcRounds: 4, targets: ["controller", "state", "ctx", "grant", "inputPaths"], liveTargets,
        wrapperKeptAlive: true, released: lease.diagnostics });
});

test("workspace grant 8: exact planned directory cleanup is followed by real missing-workspace renewal refusal", async () => {
    const f = await host(), lease = await prepare(f), beforeCount = assessments;
    try { await removeWork(); }
    catch (error) { safe = false; acquire = false; errors.push({ stage: "planned work cleanup", error }); throw error; }
    await assert.rejects(renew(lease), { code: "ENOENT" });
    assert.equal(assessments - beforeCount, 1); assert.equal(lease.failure.failed, true);
    assert.equal(lease.failure.error.code, "ENOENT"); released(lease); assert.throws(() => lease.assertCurrent());
    report({ workRemovedBeforeRenewal: true, originalMissingWorkspaceRejected: true, renewedAssessments: 1,
        replacementGrantOrDirectoryCreated: false });
});
