import assert from "node:assert/strict";
import test, { before, after, afterEach } from "node:test";
import { mkdtemp, mkdir, lstat, realpath, rmdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { registerHooks } from "node:module";
import { setImmediate as tick } from "node:timers/promises";
import { types } from "node:util";
import { InputWorkspaceGrantLease, freezeInputWorkspaceBinding } from "../packages/coding-agent/src/core/files/input-workspace-grant-lease.ts";
import { SessionPermissionState } from "../packages/extensions/resource-lifecycle-guard/permission-state.ts";
import { SESSION_PERMISSION_STATE_TYPE } from "../packages/extensions/resource-lifecycle-guard/permission-contract.ts";
import { nativeFileDiagnostics } from "../packages/coding-agent/src/core/files/native-file-client.ts";

const sources = new Map(["input-workspace-grant-lease", "session-input-read-permission"].map(name =>
    [`@super-pi/coding-agent/internal/files/${name}`, new URL(`../packages/coding-agent/src/core/files/${name}.ts`, import.meta.url).href]));
const loader = registerHooks({ resolve(specifier, context, next) {
    const url = sources.get(specifier); return url ? { url, shortCircuit: true } : next(specifier, context);
} });
let SessionPermissionController;
try { ({ SessionPermissionController } = await import("../packages/extensions/resource-lifecycle-guard/permission-controller.ts")); }
finally { loader.deregister(); }
const originalPrepare = InputWorkspaceGrantLease.prototype.prepare;
const controllerPrepare = SessionPermissionController.prototype.prepareInputWorkspaceRead;
const issued = SessionPermissionState.prototype.getIssuedWorkspaceIdentity;
const originalAssess = new WeakMap(), leases = new Set(), pending = new Set(), hosts = new Set(), errors = [], nodes = [];
let parent, root, work, rootId, workId, lastLease;
let safe = true, acquire = true, issueRequests = 0, issuedGrants = 0, comparisonRequests = 0, prepareRequests = 0, renewRequests = 0;
let assessments = 0, registered = 0, reportBytes = 0;
const workerBefore = nativeFileDiagnostics();
const id = info => ({ dev: info.dev, ino: info.ino });
const same = (a, b) => a.dev === b.dev && a.ino === b.ino;
const loggedId = value => value ? { dev: value.dev.toString(), ino: value.ino.toString() } : null;
function live() { assert.ok(safe && acquire, "no acquisitions after unresolved fixture"); }
function report(value) { const line = JSON.stringify(value); reportBytes += Buffer.byteLength(line) + 1; assert.ok(reportBytes <= 16384); console.log(line); }
function loggedValue(value, limit) {
    if (value === undefined) return { type: "undefined" };
    if (value === null || typeof value === "boolean") return value;
    if (typeof value === "string") return { type: "string", value: value.slice(0, limit), chars: value.length };
    if (typeof value === "number") return Number.isFinite(value) ? value : { type: "number", value: String(value) };
    return { type: typeof value };
}
function loggedError(error) {
    if (!types.isNativeError(error)) return loggedValue(error, 640);
    return { type: "nativeError", name: loggedValue(Object.getOwnPropertyDescriptor(error, "name")?.value ?? "Error", 64),
        code: loggedValue(Object.getOwnPropertyDescriptor(error, "code")?.value, 128),
        message: loggedValue(Object.getOwnPropertyDescriptor(error, "message")?.value, 640) };
}
InputWorkspaceGrantLease.prototype.prepare = function() {
    leases.add(this); registered++; lastLease = this; return originalPrepare.call(this);
};
function countedAssess(path, cwd) { live(); assert.ok(assessments < 128); assessments++; return originalAssess.get(this).call(this, path, cwd); }
async function tracked(promise) { pending.add(promise); try { return await promise; } finally { pending.delete(promise); } }
function prepare(f, paths = [work]) { live(); assert.ok(prepareRequests < 24); prepareRequests++; return tracked(controllerPrepare.call(f.controller, f.ctx, paths)); }
function renew(lease) { live(); assert.ok(renewRequests < 8); renewRequests++; return tracked(lease.renew()); }
async function add(f, path = root) {
    live(); assert.ok(issueRequests < 16); issueRequests++;
    const grant = await f.controller.state.addWorkspace(path, f.ctx.cwd);
    assert.ok(issued.call(f.controller.state, grant)); issuedGrants++; return grant;
}
async function comparePrimary(f) {
    live(); assert.ok(comparisonRequests < 8); comparisonRequests++;
    await f.controller.state.restore(f.ctx.cwd, []);
}
async function host(branch = []) {
    live(); const local = { hook: undefined, branch };
    const ctx = { cwd: work, signal: undefined, sessionManager: {
        getSessionId() { local.hook?.(); return "grant_identity"; }, getBranch() { return local.branch; } }, ui: { setStatus() {} } };
    const controller = new SessionPermissionController({ events: { emit() {} }, appendEntry() { throw new Error("unexpected journal"); } });
    const record = { dispose() { local.hook = undefined; controller.invalidate(); hosts.delete(record); } }; hosts.add(record);
    try {
        assert.ok(issueRequests < 16); issueRequests++;
        await controller.restore(ctx); assert.ok(issued.call(controller.state, controller.state.primary)); issuedGrants++;
        originalAssess.set(controller.state, controller.state.assessTarget); controller.state.assessTarget = countedAssess;
        return { controller, ctx, local, dispose: record.dispose };
    } catch (error) { acquire = false; record.dispose(); throw error; }
}
function released(lease) {
    const d = lease.diagnostics;
    assert.equal(d.weakReferences, 0); assert.equal(d.originalIssuance, false); assert.equal(d.grants, 0); assert.equal(d.paths, 0);
    assert.equal(d.grantChars, 0); assert.equal(d.retainedObserver, false); assert.equal(d.retainedVerifier, false);
}
async function drain() {
    for (const promise of pending) try { await promise; } catch { /* Original caller observes the error. */ }
    for (const lease of leases) lease.dispose(); leases.clear(); lastLease = undefined;
    for (const record of hosts) record.dispose();
}
afterEach(drain);
async function identify(path, parentPath) {
    const node = { path, parent: parentPath, identity: undefined, created: true, removeAttempted: false, removed: false };
    nodes.push(node); report({ created: path });
    node.identity = id(await lstat(path, { bigint: true })); report({ identified: path, identity: loggedId(node.identity) }); return node.identity;
}
before(async () => {
    assert.equal(process.platform, "win32"); assert.equal(typeof global.gc, "function");
    try {
        parent = await realpath(tmpdir()); root = await mkdtemp(join(parent, "sp-grant-identity-")); rootId = await identify(root, parent);
        work = join(root, "work"); await mkdir(work); workId = await identify(work, root);
    } catch (error) { acquire = false; if (nodes.some(node => !node.identity)) safe = false; errors.push({ stage: "fixture setup", error }); throw error; }
});
after(async () => {
    try { await drain(); } finally { InputWorkspaceGrantLease.prototype.prepare = originalPrepare; }
    if (safe) for (let i = nodes.length - 1; i >= 0; i--) {
        const node = nodes[i];
        if (!node.identity) { safe = false; break; }
        try {
            const actual = await lstat(node.path, { bigint: true }); assert.ok(same(actual, node.identity) && actual.isDirectory() && !actual.isSymbolicLink());
            assert.equal(await realpath(node.path), node.path); assert.equal(dirname(resolve(node.path)), node.parent);
            if (i > 0) { const outer = nodes[i - 1], current = await lstat(outer.path, { bigint: true }); assert.ok(same(current, outer.identity) && current.isDirectory() && !current.isSymbolicLink()); assert.equal(await realpath(outer.path), outer.path); }
            node.removeAttempted = true; await rmdir(node.path); node.removed = true; await assert.rejects(lstat(node.path), { code: "ENOENT" });
        } catch (error) { safe = false; errors.push({ stage: "recorded directory cleanup", error }); break; }
    }
    const worker = nativeFileDiagnostics();
    report({ nodes: nodes.map(node => ({ ...node, identity: loggedId(node.identity) })), safe,
        issueRequests, issuedGrants, comparisonRequests, prepareRequests, renewRequests, assessments, registered,
        liveLeases: leases.size, pending: pending.size, hosts: hosts.size, contentFiles: 0, contentBytes: 0,
        explicitFixtureOpens: 0, explicitFixtureCloses: 0, receiptIssuances: 0, nativeReaders: 0, captures: 0,
        workerStartsDelta: worker.workerStarts - workerBefore.workerStarts, workerCallsDelta: worker.calls - workerBefore.calls,
        workerPending: worker.pending, implicitNodeMetadataIoFullyInstrumented: false,
        errors: errors.map(item => ({ stage: item.stage, error: loggedError(item.error) })) });
    if (errors.length === 1) throw errors[0].error;
    if (errors.length > 1) throw new AggregateError(errors.map(item => item.error), "original cleanup errors");
    assert.ok(safe && nodes.length === 2 && nodes.every(node => node.removed));
    assert.ok(issueRequests <= 16 && issuedGrants <= 16 && comparisonRequests <= 8 && prepareRequests <= 24 && renewRequests <= 8 && assessments <= 128);
    assert.equal(leases.size, 0); assert.equal(hosts.size, 0); assert.equal(pending.size, 0);
    assert.equal(worker.workerStarts - workerBefore.workerStarts, 0); assert.equal(worker.calls - workerBefore.calls, 0); assert.equal(worker.pending, 0);
});

test("issued identity 1: real original primary/additional carry exact bigint while legacy JSON stays numeric", async () => {
    const f = await host(), primary = f.controller.state.primary, primaryIssued = issued.call(f.controller.state, primary);
    assert.ok(Object.isFrozen(primaryIssued) && Object.isFrozen(primaryIssued.identity));
    assert.deepEqual(primaryIssued.identity, workId); assert.equal(primary.inode, Number(workId.ino));
    assert.deepEqual(Object.keys(primary).sort(), ["canonicalPath", "device", "inode", "requestedPath"]);
    const additional = await add(f), additionalIssued = issued.call(f.controller.state, additional);
    assert.deepEqual(additionalIssued.identity, rootId); assert.equal(issued.call(f.controller.state, { ...additional }), undefined);
    const serialized = f.controller.state.serialized(), json = JSON.stringify(serialized);
    assert.equal(typeof serialized.workspaces[0].inode, "number"); assert.equal(json.includes('"identity":'), false);
    assert.equal(issued.call(f.controller.state, serialized.workspaces[0]), undefined);
    const p = await prepare(f, [work]), a = await prepare(f, [root]);
    assert.deepEqual(p.binding.identity, workId); assert.deepEqual(a.binding.identity, rootId);
    assert.equal(p.diagnostics.originalIssuance, true); assert.equal(a.diagnostics.originalIssuance, true);
    assert.equal(f.controller.state.primary, primary); assert.equal(f.controller.state.additional[0], additional);
    report({ actualPrimary: loggedId(p.binding.identity), actualAdditional: loggedId(a.binding.identity),
        primaryLegacySafe: Number.isSafeInteger(primary.inode), additionalLegacySafe: Number.isSafeInteger(additional.inode),
        primarySelectedForWork: true, additionalSelectedForRoot: true, serializedIdentityOmitted: true });
});
test("issued identity 2: pure boundary data never authenticates a caller's grant", () => {
    const raw = { requestedPath: work, canonicalPath: work, device: Number(workId.dev), inode: 1 };
    assert.deepEqual(freezeInputWorkspaceBinding(raw).identity, { dev: workId.dev, ino: 1n });
    const high = 9007199254740992n, collision = high + 1n;
    const legacy = { ...raw, inode: Number(high) };
    assert.equal(Number(high), Number(collision)); assert.throws(() => freezeInputWorkspaceBinding(legacy));
    const a = { ...legacy, identity: { dev: workId.dev, ino: high } }, b = { ...legacy, identity: { dev: workId.dev, ino: collision } };
    assert.notEqual(freezeInputWorkspaceBinding(legacy, a).identity.ino, freezeInputWorkspaceBinding(legacy, b).identity.ino);
    assert.equal(freezeInputWorkspaceBinding({ ...legacy, inode: Number(0xffffffffffffffffn) },
        { ...legacy, inode: Number(0xffffffffffffffffn), identity: { dev: workId.dev, ino: 0xffffffffffffffffn } }).identity.ino, 0xffffffffffffffffn);
    for (const ino of [0n, -1n, 0x10000000000000000n]) assert.throws(() => freezeInputWorkspaceBinding(legacy, { ...a, identity: { dev: workId.dev, ino } }));
    assert.throws(() => freezeInputWorkspaceBinding(legacy, { ...a, canonicalPath: root }));
    assert.throws(() => freezeInputWorkspaceBinding(legacy, { ...a, identity: { dev: 0x100000000n, ino: high } }));
    let calls = 0; const accessor = { ...a }; Object.defineProperty(accessor, "identity", { get() { calls++; return a.identity; } });
    assert.throws(() => freezeInputWorkspaceBinding(legacy, accessor)); assert.equal(calls, 0);
    const unissuedState = new SessionPermissionState(); assert.equal(issued.call(unissuedState, legacy), undefined);
    report({ pureBoundaryCasesOnly: true, sameLegacyNumberDistinctExactIdentities: true, callerConstructedIdentityIsNotIssuance: true, accessorCalls: calls });
});
test("issued identity 3: checkpoint and persisted additional clones never inherit issuance", async () => {
    const f = await host(), primary = f.controller.state.primary, primaryIssued = issued.call(f.controller.state, primary);
    const additional = await add(f), originalIssued = issued.call(f.controller.state, additional), lease = await prepare(f, [root]);
    const checkpoint = f.controller.state.checkpoint(), serialized = JSON.parse(JSON.stringify(f.controller.state.serialized()));
    assert.equal(issued.call(f.controller.state, checkpoint.workspaces[0]), undefined);
    f.controller.state.restoreCheckpoint(checkpoint);
    const clone = f.controller.state.additional[0]; assert.notEqual(clone, additional); assert.equal(issued.call(f.controller.state, clone), undefined);
    assert.equal(f.controller.state.primary, primary); assert.equal(issued.call(f.controller.state, primary), primaryIssued);
    assert.equal(issued.call(f.controller.state, additional), undefined); assert.throws(() => lease.assertCurrent()); released(lease);
    // Duplicate add observes but refuses; it must not upgrade the installed clone.
    await assert.rejects(add(f), /already added/); assert.equal(issued.call(f.controller.state, clone), undefined);
    if (Number.isSafeInteger(clone.inode)) {
        const oldRule = await prepare(f, [root]); assert.equal(oldRule.diagnostics.originalIssuance, false); assert.deepEqual(oldRule.binding.identity, rootId);
    } else await assert.rejects(prepare(f, [root]), /STALE/);
    const restored = await host([{ type: "custom", customType: SESSION_PERMISSION_STATE_TYPE, data: serialized }]);
    const restoredGrant = restored.controller.state.additional[0]; assert.ok(restoredGrant);
    assert.notEqual(restoredGrant, additional); assert.equal(issued.call(restored.controller.state, restoredGrant), undefined);
    assert.equal(issued.call(restored.controller.state, additional), undefined); assert.equal(issued.call(f.controller.state, primary), primaryIssued);
    if (!Number.isSafeInteger(restoredGrant.inode)) await assert.rejects(prepare(restored, [root]), /STALE/);
    else assert.equal((await prepare(restored, [root])).diagnostics.originalIssuance, false);
    assert.ok(Object.isFrozen(originalIssued)); assert.throws(() => lease.assertCurrent());
    report({ additionalClonesHaveIssuance: false, originalPrimaryPreserved: true,
        restoredAdditionalLegacySafe: Number.isSafeInteger(restoredGrant.inode), newStatDidNotUpgradeClone: true });
});
test("issued identity 4: existing-primary restore compares but never reissues its original identity", async () => {
    const f = await host(), primary = f.controller.state.primary, original = issued.call(f.controller.state, primary);
    const lease = await prepare(f), baseline = lease.binding;
    await comparePrimary(f);
    assert.equal(f.controller.state.primary, primary); assert.equal(issued.call(f.controller.state, primary), original);
    await renew(lease); assert.equal(lease.binding, baseline); assert.deepEqual(baseline.identity, workId);
    const inode = primary.inode, changedInode = inode === 1 ? 2 : 1;
    assert.notEqual(changedInode, inode); primary.inode = changedInode;
    try { assert.throws(() => lease.assertCurrent()); await assert.rejects(comparePrimary(f), /SHELL_CWD_CHANGED/); }
    finally { primary.inode = inode; }
    await comparePrimary(f); assert.equal(issued.call(f.controller.state, primary), original);
    assert.throws(() => lease.assertCurrent()); released(lease);
    report({ comparisonsThisGroup: 3, originalGrantAndSidecarPreserved: true, replacementIssuance: false, detectedChangeDoesNotRevive: true });
});
test("issued identity 5: fixed state lookup, same exact renew and final pure checks survive hostile callbacks", async () => {
    const f = await host(), grant = f.controller.state.primary, original = issued.call(f.controller.state, grant), originalLookup = f.controller.state.getIssuedWorkspaceIdentity;
    f.controller.state.getIssuedWorkspaceIdentity = () => ({ ...original, identity: { dev: workId.dev, ino: workId.ino + 1n } });
    let lease;
    try { lease = await prepare(f); assert.deepEqual(lease.binding.identity, workId); await renew(lease); }
    finally { f.controller.state.getIssuedWorkspaceIdentity = originalLookup; }
    const inode = grant.inode, changedInode = inode === 1 ? 2 : 1; let callbacks = 0;
    assert.notEqual(changedInode, inode);
    f.local.hook = () => { callbacks++; grant.inode = changedInode; };
    try { assert.throws(() => lease.assertCurrent()); } finally { f.local.hook = undefined; grant.inode = inode; }
    assert.equal(callbacks, 1); assert.throws(() => lease.assertGrantIdentity()); released(lease);
    assert.throws(() => { original.identity.ino = workId.ino + 1n; }, TypeError);
    const check = f.controller.state.assessTarget, entered = Promise.withResolvers(), releaseGate = Promise.withResolvers(); let held = false;
    f.controller.state.assessTarget = async function(...args) {
        const result = await check.apply(this, args); if (!held) { held = true; entered.resolve(); await releaseGate.promise; } return result;
    };
    let running;
    try {
        running = prepare(f).then(value => ({ value }), error => ({ rejected: true, error }));
        await Promise.race([entered.promise, running.then(result => { throw new Error("settled before gate", { cause: result }); })]);
        assert.equal(lastLease.diagnostics.pending, true); lastLease.revoke();
    } finally { releaseGate.resolve(); f.controller.state.assessTarget = check; }
    const outcome = await running; assert.equal(outcome.rejected, true); assert.equal(lastLease.diagnostics.pending, false); released(lastLease);
    report({ fixedPrototypeLookup: true, finalContextCallbacks: callbacks, readonlyOriginalIdentity: true, pendingOriginalSettled: true });
});
test("issued identity 6: ready lease weakly pins issuance without retaining retired originals", async () => {
    let f = await host(), paths = [work]; const lease = await prepare(f, paths);
    const refs = [f.controller, f.controller.state, f.ctx, f.controller.state.primary,
        issued.call(f.controller.state, f.controller.state.primary), paths].map(value => new WeakRef(value));
    f.dispose(); f = undefined; paths = undefined;
    for (let i = 0; i < 4; i++) { await tick(); global.gc(); }
    const liveTargets = refs.reduce((sum, ref) => sum + Number(ref.deref() !== undefined), 0);
    assert.equal(lease.diagnostics.state, "ready"); assert.equal(lease.diagnostics.originalIssuance, true); assert.equal(liveTargets, 0);
    assert.throws(() => lease.assertCurrent()); released(lease);
    report({ gcRounds: 4, targets: ["controller", "state", "ctx", "grant", "sidecar", "callerPaths"], liveTargets,
        readyLeaseKeptAlive: true, released: lease.diagnostics });
});
