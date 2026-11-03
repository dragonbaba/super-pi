import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { VolumeProtocol, createManagerLossFactory, ManagerLossFactory } from "../scripts/acceptance/windows-sandbox-volume.mjs";
const taskId = "11111111-1111-4111-8111-111111111111", instanceId = "22222222-2222-4222-8222-222222222222";
function fixture(hooks = {}) {
    const events = [], controller = new AbortController(), child = new EventEmitter();
    child.pid = 1234; child.exitCode = null; child.signalCode = null; child.killed = false;
    child.stdin = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
    let factory, driver, killCount = 0, verifyCount = 0, unsafeCount = 0, settled = 0, pendingReply, launchCount = 0, wrapCount = 0, persistCount = 0;
    function reply(text) {
        const request = JSON.parse(text);
        child.stdout.emit("data", Buffer.from(JSON.stringify({ protocol: "super-pi-volume-v1", taskId, diskId: taskId, sequence: request.sequence,
            kind: "reply", phase: "verified", capacity: 134217728, imageBudget: 135266304, shareAdmission: false,
            closeUnknown: false, detached: false, managementClosed: false, imageCreated: true, error: null,
            imageId: "12345678:0000000000000002", exchangeId: "87654321:0000000000000003",
            physicalPath: "\\\\.\\PhysicalDrive2", volumePath: "\\\\?\\Volume{33333333-3333-4333-8333-333333333333}\\" }) + "\n"));
    }
    child.stdin.write = (text, callback) => { if (hooks.holdVerify) pendingReply = text; else reply(text); callback?.(); };
    child.kill = signal => {
        assert.equal(signal, "SIGTERM"); killCount++; events.push("kill");
        if (hooks.kill) return hooks.kill(child, factory);
        child.killed = true; return true;
    };
    const vm = { id: instanceId, taskId, state: "registered-not-guest-ready", registered: true, startSettled: true };
    const runtime = { read: () => ({ owner: vm, taskId, instanceId }) };
    const volume = { state: "prepared-not-share-admitted", experimentalMappingState: "dispatched",
        verify() { verifyCount++; return hooks.verify ? hooks.verify() : driver.command("verify", () => {}); } };
    const task = { vm, runtime, volume };
    factory = new ManagerLossFactory({ taskId,
        launch() { launchCount++; events.push("launch"); return hooks.launch ? hooks.launch() : child; },
        wrap(original, id) {
            wrapCount++;
            assert.equal(original, child); assert.equal(id, taskId);
            if (hooks.wrap) return hooks.wrap(original, id);
            driver = new VolumeProtocol(original, id);
            driver.setUnsafeHandler(() => { unsafeCount++; volume.state = "blocked"; controller.abort(); });
            driver.on("settled", () => { settled++; }); return driver;
        },
        persist(kind, snapshot) { persistCount++; events.push(kind); assert.equal(snapshot.taskId, taskId); return hooks.persist?.(kind, snapshot, factory, task, controller); } });
    function launch() { task.driver = factory.launch(); return task.driver; }
    function close(code = null, signal = "SIGTERM") {
        child.exitCode = code; child.signalCode = signal; child.emit("close", code, signal);
    }
    function finish() {
        if (!factory.snapshot.closeObserved && !driver?.physicallyClosed) close();
        factory.dispose();
        assert.equal(killCount <= 1, true);
        assert.equal(driver?.physicallyClosed ?? true, true);
        if (driver) assert.equal(driver.diagnostics.buffersReleased, true);
        assert.equal(child.listenerCount("close"), 0); assert.equal(child.listenerCount("error"), 0);
        assert.equal(child.stdout.listenerCount("data"), 0); assert.equal(child.stdout.listenerCount("end"), 0);
        assert.equal(child.stderr.listenerCount("data"), 0); assert.equal(child.stdin.listenerCount("error"), 0);
        const s = factory.snapshot;
        assert.equal(s.childHeld || s.driverHeld || s.bindingHeld || s.callbacksHeld, false);
        assert.equal(s.pendingRecords, 0); assert.equal(s.recordPromiseHeld, false); assert.equal(s.recordInFlight, false); assert.ok(events.length <= 10);
        assert.deepEqual(factory.originalErrors, { request: undefined, child: undefined, record: undefined, recordRejection: undefined });
    }
    return { factory, child, controller, task, vm, volume, runtime, events, launch, close, finish,
        arm: () => factory.verifyAndArm(task, controller.signal),
        reply: () => { assert.ok(pendingReply); reply(pendingReply); pendingReply = undefined; },
        stats: () => ({ killCount, verifyCount, unsafeCount, settled, launchCount, wrapCount, persistCount }) };
}

test("default factory is inert and ordinary protocol has no fault observer", () => {
    const inert = createManagerLossFactory({ taskId, root: "D:\\never-used", nativeSha256: "a".repeat(64) }, () => {});
    assert.equal(inert.snapshot.launchAttempted, false); assert.equal(inert.driver, undefined); inert.dispose();
    assert.throws(() => createManagerLossFactory({ taskId, root: "D:\\never-used", nativeSha256: "a".repeat(64), candidateCapture: true }, () => {}));
    const f = fixture(), child = f.child, driver = new VolumeProtocol(child, taskId);
    assert.equal(child.listenerCount("close"), 1); assert.equal(child.listenerCount("error"), 1);
    f.close(); assert.equal(driver.physicallyClosed, true); assert.equal(driver.childReleased, true);
    assert.equal(f.stats().killCount, 0); f.factory.dispose();
    const revoked = fixture(); revoked.factory.revoke(); assert.throws(() => revoked.launch());
    assert.deepEqual(revoked.events, []); assert.equal(revoked.factory.snapshot.launchAttempted, false);
    assert.deepEqual(revoked.stats(), { killCount: 0, verifyCount: 0, unsafeCount: 0, settled: 0, launchCount: 0, wrapCount: 0, persistCount: 0 });
    assert.equal(revoked.factory.snapshot.childHeld || revoked.factory.snapshot.driverHeld, false);
    assert.equal(revoked.child.listenerCount("close") + revoked.child.listenerCount("error"), 0); revoked.factory.dispose();
});

test("original protocol and one request keep return separate from physical close", async () => {
    const f = fixture(), driver = f.launch();
    assert.equal(f.factory.driver, driver); assert.equal(f.child.listenerCount("close"), 2);
    await f.arm(); assert.equal(f.factory.snapshot.verified, true); assert.equal(f.stats().verifyCount, 1);
    const result = f.factory.request();
    assert.equal(result.requestReturned, true); assert.equal(result.closeObserved, false); assert.equal(driver.physicallyClosed, false);
    assert.deepEqual(f.events, ["launch", "bound", "attempt", "kill", "request-result"]);
    assert.throws(() => f.factory.request()); assert.throws(() => f.factory.dispose(), /closure remains unknown/);
    const wait = driver.waitClosed(); f.close(); assert.equal(await wait, false);
    assert.equal(f.factory.snapshot.closeObserved, true); assert.equal(f.factory.snapshot.childHeld, false);
    assert.equal(driver.physicallyClosed, true); assert.equal(driver.childReleased, true); assert.equal(driver.diagnostics.buffersReleased, true);
    assert.deepEqual(f.stats(), { killCount: 1, verifyCount: 1, unsafeCount: 1, settled: 1, launchCount: 1, wrapCount: 1, persistCount: 4 }); f.finish();
});

test("false return, thrown values and child error never count as close", async () => {
    const original = Object.assign(Error("request"), { code: "EACCES" });
    for (const mode of ["false", "error", "undefined", "event"]) {
        const f = fixture({ kill(child) {
            if (mode === "error") throw original; if (mode === "undefined") throw undefined;
            if (mode === "event") child.emit("error", original);
            return false;
        } }); f.launch(); await f.arm(); const s = f.factory.request();
        assert.equal(s.closeObserved, false); assert.equal(f.factory.driver.physicallyClosed, false);
        assert.equal(s.requestThrew, mode === "error" || mode === "undefined");
        assert.equal(s.requestReturned, mode === "error" || mode === "undefined" ? null : false);
        if (mode === "error") assert.equal(f.factory.originalErrors.request, original);
        if (mode === "event") { assert.equal(f.factory.originalErrors.child, original); assert.equal(s.childErrorCount, 1); }
        assert.throws(() => f.factory.request()); f.finish();
    }
});

test("post-journal final guard rejects original binding and eligibility changes", async () => {
    const mutations = [
        (f, t) => { t.driver = {}; }, (f, t) => { t.vm = {}; }, (f, t) => { t.volume = {}; }, (f, t) => { t.runtime = {}; },
        (f, t) => { t.vm.id = "33333333-3333-4333-8333-333333333333"; }, (f, t) => { t.vm.taskId = instanceId; },
        (f, t) => { t.vm.registered = false; }, (f, t) => { t.vm.cleanupPromise = {}; },
        (f, t, c) => c.abort(), f => f.revoke(),
    ];
    for (const mutate of mutations) {
        const f = fixture({ persist(kind, s, factory, task, controller) { if (kind === "attempt") mutate(factory, task, controller); } });
        f.launch(); await f.arm(); assert.throws(() => f.factory.request());
        assert.equal(f.factory.snapshot.attempts, 1); assert.equal(f.stats().killCount, 0); f.finish();
    }
});

test("verification must settle and recheck across await before arming", async () => {
    for (const mutate of [
        f => f.controller.abort(), f => { f.task.driver = {}; }, f => { f.task.vm = {}; },
        f => { f.task.volume = {}; }, f => { f.task.runtime = {}; }, f => { f.vm.registered = false; },
        f => { f.vm.id = taskId; }, f => f.factory.revoke(),
    ]) {
        const f = fixture({ holdVerify: true }); f.launch(); const armed = f.arm();
        assert.equal(f.factory.driver.pending, true); assert.throws(() => f.factory.request());
        const rejected = assert.rejects(armed); mutate(f); f.reply(); await rejected;
        assert.equal(f.factory.snapshot.verified, false); assert.equal(f.stats().killCount, 0); f.finish();
    }
    const cause = Error("verify failed"), f = fixture({ verify: () => Promise.reject(cause) }); f.launch();
    await assert.rejects(f.arm(), error => error === cause); assert.equal(f.factory.snapshot.verified, false); f.finish();
});

test("journal failures consume attempt permanently, including falsy causes and async callback", async () => {
    for (const cause of [undefined, Error("journal")]) {
        const f = fixture({ persist(kind) { if (kind === "attempt") throw cause; } });
        f.launch(); await f.arm(); assert.throws(() => f.factory.request(), /journal failed/);
        assert.equal(f.factory.snapshot.attempts, 1); assert.equal(f.factory.snapshot.recordFailed, true);
        assert.equal(f.factory.originalErrors.record, cause); assert.equal(f.stats().killCount, 0);
        assert.throws(() => f.factory.request()); f.finish();
    }
    const f = fixture({ persist(kind) { if (kind === "attempt") return Promise.resolve(); } });
    f.launch(); await f.arm(); assert.throws(() => f.factory.request()); assert.equal(f.stats().killCount, 0);
    assert.equal(f.factory.snapshot.pendingRecords, 1); assert.throws(() => f.factory.dispose(), /journal settlement/);
    await Promise.resolve(); assert.equal(f.factory.snapshot.pendingRecords, 0); assert.equal(f.factory.snapshot.recordRejected, false); f.finish();
    for (const cause of [undefined, Error("late journal failure")]) {
        const rejected = fixture({ persist(kind) { if (kind === "attempt") return Promise.reject(cause); } });
        rejected.launch(); await rejected.arm(); assert.throws(() => rejected.factory.request());
        assert.equal(rejected.factory.snapshot.pendingRecords, 1); await Promise.resolve();
        assert.equal(rejected.factory.snapshot.recordRejected, true); assert.equal(rejected.factory.originalErrors.recordRejection, cause);
        assert.throws(() => rejected.factory.request()); assert.equal(rejected.stats().killCount, 0); rejected.finish();
    }
    let resolve; const promise = new Promise(done => { resolve = done; });
    const pending = fixture({ persist(kind) { if (kind === "attempt") return promise; } });
    pending.launch(); await pending.arm(); assert.throws(() => pending.factory.request()); pending.close();
    assert.throws(() => pending.factory.dispose(), /journal settlement/); assert.equal(pending.factory.snapshot.recordPromiseHeld, true);
    resolve(); await Promise.resolve(); pending.finish();
    const asyncCause = Error("async journal body");
    const asyncCallback = fixture({ persist: async () => { throw asyncCause; } }); asyncCallback.launch();
    assert.equal(asyncCallback.factory.snapshot.recordFailed, true); assert.equal(asyncCallback.factory.snapshot.pendingRecords, 1);
    await Promise.resolve(); assert.equal(asyncCallback.factory.originalErrors.recordRejection, asyncCause);
    await assert.rejects(asyncCallback.arm()); assert.equal(asyncCallback.stats().verifyCount, 0); asyncCallback.finish();
});

test("fault observation journal failure cannot block original protocol close handling", async () => {
    for (const phase of ["child-close", "child-error"]) {
        const error = Error("observation journal");
        const f = fixture({ persist(kind) { if (kind === phase) throw error; } }), driver = f.launch();
        await f.arm(); f.factory.request();
        if (phase === "child-error") f.child.emit("error", Error("transport"));
        assert.doesNotThrow(() => f.close());
        assert.equal(driver.physicallyClosed, true); assert.equal(driver.childReleased, true);
        // Existing protocol reports transport failure, then separately reports unexpected close.
        assert.equal(f.stats().unsafeCount, phase === "child-error" ? 2 : 1); assert.equal(f.stats().settled, 1);
        assert.equal(f.factory.originalErrors.record, error); f.finish();
    }
    const cause = Error("async close journal"), f = fixture({ persist(kind) { if (kind === "child-close") return Promise.reject(cause); } });
    const driver = f.launch(); await f.arm(); f.factory.request(); assert.doesNotThrow(() => f.close());
    assert.equal(driver.physicallyClosed, true); assert.equal(f.factory.snapshot.pendingRecords, 1);
    await Promise.resolve(); assert.equal(f.factory.originalErrors.recordRejection, cause); f.finish();
});

test("revoke and unused dispose never terminate or release original protocol responsibility", async () => {
    const revoked = fixture(); revoked.launch(); await revoked.arm(); revoked.factory.revoke();
    assert.throws(() => revoked.factory.request()); assert.equal(revoked.stats().killCount, 0); revoked.finish();
    const f = fixture(), driver = f.launch(); f.factory.dispose();
    assert.equal(f.stats().killCount, 0); assert.equal(driver.physicallyClosed, false); assert.equal(driver.childReleased, false);
    assert.equal(f.child.listenerCount("close"), 1); assert.equal(f.child.listenerCount("error"), 1);
    f.close(); assert.equal(driver.physicallyClosed, true); assert.equal(f.factory.snapshot.closeObserved, false); f.finish();
});

test("attempt journal reentry cannot duplicate the original child call", async () => {
    let reentered = 0;
    const f = fixture({ persist(kind, snapshot, factory) {
        if (kind === "attempt") { assert.equal(snapshot.attempts, 1); assert.throws(() => factory.request()); reentered++; }
    } });
    f.launch(); await f.arm(); f.factory.request(); assert.equal(reentered, 1); assert.equal(f.stats().killCount, 1); f.finish();
});

test("dispose during close or pending verification cannot resurrect capability references", async () => {
    const f = fixture({ persist(kind, snapshot, factory) { if (kind === "child-close") factory.dispose(); } });
    const driver = f.launch(); await f.arm(); f.factory.request(); assert.doesNotThrow(() => f.close());
    assert.equal(driver.physicallyClosed, true); assert.equal(f.factory.snapshot.disposed, false);
    assert.equal(f.factory.snapshot.recordFailed, true); f.finish();
    const pending = fixture({ holdVerify: true }); pending.launch(); const armed = pending.arm();
    const rejected = assert.rejects(armed); pending.factory.dispose(); pending.reply(); await rejected;
    assert.equal(pending.factory.snapshot.phase, "disposed"); assert.equal(pending.factory.snapshot.bindingHeld, false); pending.finish();
    const sync = fixture({ kill(child) { child.emit("close", null, "SIGTERM"); throw Error("after close"); },
        persist(kind, snapshot, factory) { if (kind === "child-close") factory.dispose(); } });
    sync.launch(); await sync.arm(); sync.factory.request();
    assert.equal(sync.factory.snapshot.disposed, false); assert.equal(sync.factory.originalErrors.request.message, "after close"); sync.finish();
    const cause = Error("close async rejection");
    const returned = fixture({ persist(kind, snapshot, factory) {
        if (kind === "child-close") {
            assert.equal(snapshot.recordInFlight, true); assert.throws(() => factory.dispose(), /in flight/);
            return Promise.reject(cause);
        }
    } });
    returned.launch(); await returned.arm(); returned.factory.request(); returned.close();
    assert.equal(returned.factory.snapshot.disposed, false); assert.equal(returned.factory.snapshot.pendingRecords, 1);
    await Promise.resolve(); assert.equal(returned.factory.originalErrors.recordRejection, cause); returned.finish();
    let nested, nestedCalls = 0, resolveNested;
    const pendingRecord = new Promise(resolve => { resolveNested = resolve; });
    nested = fixture({ persist(kind, snapshot, factory) {
        if (kind === "child-error") { nestedCalls++; return Promise.reject(Error("must not execute")); }
        if (kind === "child-close") { nested.child.emit("error", Error("nested observation")); return pendingRecord; }
    } });
    const nestedDriver = nested.launch(); await nested.arm(); nested.factory.request(); nested.close();
    assert.equal(nestedCalls, 0); assert.equal(nested.factory.snapshot.recordFailed, true);
    assert.equal(nested.factory.snapshot.pendingRecords, 1); assert.equal(nestedDriver.physicallyClosed, true);
    assert.throws(() => nested.factory.dispose(), /journal settlement/); resolveNested(); await Promise.resolve(); nested.finish();
});

test("launch failure preserves partial ownership and forbids relaunch", () => {
    const failure = Error("wrapper");
    const f = fixture({ wrap() { throw failure; } }); assert.throws(() => f.launch(), error => error === failure);
    assert.equal(f.factory.snapshot.childHeld, true); assert.throws(() => f.factory.dispose(), /Unwrapped/);
    assert.throws(() => f.launch()); f.close(); f.factory.dispose(); assert.equal(f.factory.snapshot.childHeld, false);
    const bad = fixture({ launch() { throw failure; } }); assert.throws(() => bad.launch(), error => error === failure);
    assert.throws(() => bad.launch()); bad.factory.dispose(); assert.equal(bad.stats().killCount, 0);
    const during = fixture({ persist(kind, s, factory) { if (kind === "bound") factory.dispose(); } });
    const driver = during.launch(); assert.equal(during.factory.snapshot.recordFailed, true);
    assert.equal(driver.childReleased, false); during.finish();
});

test("child error observation is bounded and keeps the first actual error", () => {
    const f = fixture(); f.launch(); const error = Object.assign(Error("first"), { code: "EPIPE" });
    for (let i = 0; i < 9; i++) f.child.emit("error", i === 0 ? error : Error("later"));
    assert.equal(f.factory.snapshot.childErrorCount, 5); assert.equal(f.factory.originalErrors.child, error);
    assert.equal(f.factory.snapshot.childErrorsTruncated, true);
    assert.equal(f.events.filter(kind => kind === "child-error").length, 4);
    assert.equal(f.stats().unsafeCount, 1); f.finish();
});

