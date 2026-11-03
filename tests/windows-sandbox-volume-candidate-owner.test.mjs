import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { SandboxLifecycle } from "../scripts/acceptance/windows-sandbox-lifecycle.mjs";
import { LiveSandboxRuntime, experimentalGuidConfig } from "../scripts/acceptance/windows-sandbox-volume-sharing.mjs";
import { TaskVolumeOwner, VolumeProtocol, VOLUME_LIMITS } from "../scripts/acceptance/windows-sandbox-volume.mjs";
import { CANDIDATE_PROTOCOL, CANDIDATE_LIMITS } from "../scripts/acceptance/windows-sandbox-candidates.mjs";
const taskId = "11111111-2222-3333-4444-555555555555", snapshotId = "22222222-3333-4444-5555-666666666666";
const volumePath = "\\\\?\\Volume{aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee}\\", exchangeId = "AABBCCDD:0000000000000001";
const imageId = "11223344:0000000000000009", sourceId = "AABBCCDD:0000000000000002";
const hash = bytes => createHash("sha256").update(bytes).digest("hex"), encode = value => Buffer.from(JSON.stringify(value));
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const zero = bytes => bytes.every(value => value === 0);
function facts(command, sequence = 1) {
    const done = command === "release" || command === "exit";
    return { protocol: "super-pi-volume-v1", taskId, diskId: taskId, sequence, kind: "reply",
        phase: done ? "released" : "prepared-not-share-admitted", error: null, imageCreated: true, imageId,
        physicalPath: "\\\\.\\PhysicalDrive77", volumePath, exchangeId, closeUnknown: false, managementClosed: done, detached: done,
        capacity: VOLUME_LIMITS.capacity, imageBudget: VOLUME_LIMITS.imageBytes, shareAdmission: false };
}
async function fixture(closeVm = true) {
    const runtime = new LiveSandboxRuntime(taskId), state = { calls: [], records: [], revoked: 0, cancelled: 0, onJournal: undefined, mutate: undefined };
    const driver = { pid: 1, physicallyClosed: false, pending: false, setUnsafeHandler(fn) { this.unsafe = fn; },
        async command(command, observe) {
            state.calls.push(command); this.pending = true;
            try { const result = facts(command); state.mutate?.(command, result); observe(result); return result; }
            finally { this.pending = false; }
        }, async waitClosed() { this.physicallyClosed = true; return true; } };
    const volume = new TaskVolumeOwner({ driver, taskId, readRuntime: runtime.read,
        journal(value) { state.records.push(value); state.onJournal?.(value); },
        revokeCandidates() { state.revoked++; }, cancelExecution() { state.cancelled++; } });
    await volume.prepare(); const ids = new Set();
    const cli = { launch(args) {
        if (args[0] === "start") ids.add(args[2]); else if (args[0] === "stop") ids.delete(args[2]); else assert.equal(args[0], "list");
        return { pid: 2, result: { pid: 2, exitCode: 0, signal: null, launchError: null, truncated: false, stderr: "",
            stdout: args[0] === "list" ? JSON.stringify({ WindowsSandboxEnvironments: [...ids].map(Id => ({ Id })) }) : "{}",
            closedUtc: "2026-11-01T00:00:00.000Z" }, async wait() { return "settled"; } };
    } };
    const vm = new SandboxLifecycle({ cli, taskId, config: experimentalGuidConfig(volume), journal() {} }); runtime.bind(vm);
    if (closeVm) { const ticket = await volume.issueExperimentalMapping(vm); await volume.startExperimentalMapping(ticket, vm); assert.equal(await vm.cleanup(), true); }
    const authority = { taskId, snapshotId, instanceId: vm.id, volumePath, exchangeId, budget: { ...CANDIDATE_LIMITS },
        allowed: [{ path: "a.txt", operation: "add", revision: null }] };
    return { runtime, state, driver, volume, vm, authority };
}
function channel(f) {
    const state = { opened: 0, closed: 0, peak: 0, activeHandles: 0, pending: false, uncertainHandles: [],
        starts: [], tickets: [], buffers: [], borrowed: undefined, requestSha: undefined,
        onStage: undefined, onSnapshot: undefined, snapshotCalls: 0, next: undefined };
    const manifest = () => encode({ protocol: CANDIDATE_PROTOCOL, taskId, snapshotId, candidates: [{ path: "a.txt", operation: "add" }], report: { exitCode: 23 } });
    function receipt(stage, bytes) {
        const value = { protocol: "super-pi-candidate-capture-v1", stage, taskId, volumePath, exchangeId,
            carrierId: "11223344:000000000000000" + (stage === "manifest" ? "1" : "2"), bytes: bytes.length, sha256: hash(bytes),
            handles: { opened: stage === "manifest" ? 3 : 5, closed: stage === "manifest" ? 3 : 5,
                peak: stage === "manifest" ? 2 : 4, closeUnknown: false, retained: [] } };
        if (stage === "manifest") value.sourceId = sourceId;
        else { value.requestSha256 = state.requestSha; value.items = [["AABBCCDD:0000000000000003", bytes.length, hash(bytes)]]; }
        return encode(value);
    }
    function start(stage, ticket, admit, validate, request) {
        state.starts.push(stage); const saved = { ticket, admit, validate }; state.tickets.push(saved);
        assert.equal(ticket.stage, stage); assert.equal(ticket.taskId, taskId); assert.equal(ticket.instanceId, f.vm.id);
        assert.equal(ticket.maximumBytes, stage === "readBatch" ? 16384 : 4096);
        const opened = stage === "writeRequest" ? 1 : 2;
        let value, error;
        try {
            assert.equal(admit(ticket), true);
            assert.throws(() => admit(ticket), /consumed/);
            assert.throws(() => validate({ ...ticket }), /inactive/);
            assert.equal(validate(ticket), true);
            state.onStage?.(stage, saved);
            assert.equal(validate(ticket), true); // Before a second independent physical operation.
            state.opened += opened; state.activeHandles += opened; state.peak = Math.max(state.peak, state.activeHandles);
            if (stage === "writeRequest") {
                state.borrowed = request; state.requestSha = hash(request);
                value = { bytes: request.length, sha256: state.requestSha };
            } else {
                const bytes = stage === "readManifest" ? manifest() : Buffer.from("abc");
                const raw = receipt(stage === "readManifest" ? "manifest" : "batch", bytes);
                state.buffers.push(bytes, raw); value = { bytes, receipt: raw, carrierId: "11223344:000000000000000" + (stage === "readManifest" ? "1" : "2") };
            }
        } catch (cause) { error = cause; }
        const complete = () => { state.closed += state.activeHandles; state.activeHandles = 0; state.pending = false; };
        if (state.next?.stage === stage) return state.next.start({ value, error, complete, saved });
        complete();
        return { outcome: error ? Promise.reject(error) : Promise.resolve(value), settled: Promise.resolve() };
    }
    const io = { owner: f.volume, vm: f.vm,
        readManifest(...args) { return start("readManifest", ...args); },
        writeRequest(...args) { return start("writeRequest", ...args); },
        readBatch(...args) { return start("readBatch", ...args); },
        snapshot() {
            state.snapshotCalls++; state.onSnapshot?.();
            return { opened: state.opened, closed: state.closed, peak: state.peak, activeHandles: state.activeHandles,
                pending: state.pending, uncertainHandles: state.uncertainHandles.map(item => ({ ...item })) };
        } };
    return { io, state };
}
function released(f, c) {
    const d = f.volume.candidateDiagnostics;
    assert.equal(d.leaseHeld, false); assert.equal(d.channelHeld, false); assert.equal(d.vmHeld, false);
    assert.equal(d.operationHeld, false); assert.equal(d.requestBytes, 0);
    for (const bytes of c.state.buffers) assert.equal(zero(bytes), true);
    if (c.state.borrowed) assert.equal(zero(c.state.borrowed), true);
}
test("one real owner lease produces independent candidate bytes and survives disk release", async () => {
    const f = await fixture(), c = channel(f), result = await f.volume.readCandidatesOnce(f.authority, c.io);
    assert.equal(result.status, "candidate-data-checked"); assert.equal(result.guestReport.exitCode, 23);
    assert.equal(result.copyBytes(0).toString(), "abc"); assert.equal(f.volume.candidateDiagnostics.stage, "published");
    assert.deepEqual(c.state.starts, ["readManifest", "writeRequest", "readBatch"]);
    assert.equal(c.state.opened, 5); assert.equal(c.state.closed, 5); assert.equal(c.state.peak, 2);
    released(f, c); await assert.rejects(f.volume.readCandidatesOnce(f.authority, c.io), /completed bound VM/);
    for (const saved of c.state.tickets) { assert.throws(() => saved.validate(saved.ticket), /inactive/); assert.throws(() => saved.admit(saved.ticket), /foreign/); }
    await f.volume.release(); assert.equal(result.copyBytes(0).toString(), "abc");
    f.volume.revoke(); assert.throws(() => result.copyBytes(0)); assert.equal(result.diagnostics.retainedPayloadBytes, 0);
    f.volume.disposeCandidates(); assert.equal(f.volume.candidateDiagnostics.candidateHeld, false); f.runtime.dispose();
    assert.equal(f.runtime.retainsOwner, false);
    assert.deepEqual(f.state.calls, ["prepare", "verify", "verify", "read-candidate-manifest", "read-candidate-batch", "release", "exit"]);
});
test("unstarted or active VM and foreign host authority/channel are rejected before dispatch", async () => {
    for (const mode of ["unstarted", "active", "task", "instance", "volume", "channel-owner", "channel-vm"]) {
        const f = await fixture(mode !== "unstarted"), c = channel(f), before = f.state.calls.length;
        if (mode === "active") f.vm.execution = {};
        if (mode === "task") f.authority.taskId = snapshotId;
        if (mode === "instance") f.authority.instanceId = snapshotId;
        if (mode === "volume") f.authority.volumePath = "\\\\?\\Volume{bbbbbbbb-bbbb-cccc-dddd-eeeeeeeeeeee}\\";
        if (mode === "channel-owner") c.io.owner = {};
        if (mode === "channel-vm") c.io.vm = {};
        await assert.rejects(f.volume.readCandidatesOnce(f.authority, c.io));
        assert.equal(f.state.calls.length, before); assert.equal(c.state.starts.length, 0); assert.equal(c.state.snapshotCalls, 0);
        assert.equal(f.volume.candidateDiagnostics.leaseHeld, false);
    }
});
test("journal reentry before each dispatch or publication revokes without starting a later operation", async () => {
    for (const stage of ["admitting", "read-candidate-manifest", "readManifest", "writeRequest", "read-candidate-batch", "readBatch", "checked", "after-release"]) {
        const f = await fixture(), c = channel(f); let once = false;
        f.state.onJournal = record => {
            if (!once && (stage === "after-release" ? record.candidateStage === "checked" && !record.candidateLeaseHeld : record.candidateStage === stage)) {
                once = true; f.volume.revoke();
            }
        };
        await assert.rejects(f.volume.readCandidatesOnce(f.authority, c.io), /revoked/); assert.equal(once, true); released(f, c);
        const expected = { admitting: 0, "read-candidate-manifest": 0, readManifest: 0, writeRequest: 1,
            "read-candidate-batch": 2, readBatch: 2, checked: 3, "after-release": 3 }[stage];
        assert.equal(c.state.starts.length, expected); assert.equal(f.volume.candidateDiagnostics.candidate.retainedPayloadBytes, 0);
        await f.volume.release(); f.volume.disposeCandidates(); f.runtime.dispose();
    }
});
test("pending read rejects legacy release and retains late bytes until physical settlement", async () => {
    const f = await fixture(), c = channel(f), finish = deferred(), entered = deferred(); let complete;
    c.state.next = { stage: "readManifest", start(op) { complete = op.complete; c.state.pending = true; entered.resolve(op);
        return { outcome: Promise.resolve(op.value), settled: finish.promise }; } };
    const reading = f.volume.readCandidatesOnce(f.authority, c.io); const op = await entered.promise;
    assert.throws(() => f.volume.beginCandidateRead(), /already owns/);
    assert.throws(() => f.volume.endCandidateRead({ activeHandles: 0, uncertainHandles: [] }), /Legacy end/);
    await assert.rejects(f.volume.release()); f.volume.revoke(); f.volume.disposeCandidates();
    assert.equal(f.volume.candidateDiagnostics.leaseHeld, true); assert.equal(zero(op.value.bytes), false);
    assert.throws(() => op.saved.validate(op.saved.ticket), /revoked/);
    complete(); finish.resolve(); await assert.rejects(reading, /revoked/); released(f, c);
    assert.deepEqual(c.state.starts, ["readManifest"]); await f.volume.release(); f.runtime.dispose();
});
test("logical write failure and cancellation preserve the borrowed request until its physical completion", async () => {
    const f = await fixture(), c = channel(f), finish = deferred(), entered = deferred(); let complete;
    c.state.next = { stage: "writeRequest", start(op) { complete = op.complete; c.state.pending = true; entered.resolve();
        return { outcome: Promise.reject(Error("logical write failure")), settled: finish.promise }; } };
    const reading = f.volume.readCandidatesOnce(f.authority, c.io); await entered.promise;
    const original = hash(c.state.borrowed); f.volume.revoke();
    assert.equal(hash(c.state.borrowed), original); assert.equal(zero(c.state.borrowed), false);
    assert.equal(f.volume.candidateDiagnostics.candidate.retainedRequestBytes, 0);
    await assert.rejects(f.volume.release()); complete(); finish.resolve();
    await assert.rejects(reading, /logical write failure/); released(f, c);
    assert.deepEqual(c.state.starts, ["readManifest", "writeRequest"]); await f.volume.release(); f.volume.disposeCandidates(); f.runtime.dispose();
});
test("repeat validation catches revocation between adapter operations and rejects foreign tickets", async () => {
    const first = await fixture(), a = channel(first); await first.volume.readCandidatesOnce(first.authority, a.io);
    const f = await fixture(), c = channel(f);
    c.state.onStage = (stage, saved) => {
        assert.throws(() => saved.admit(a.state.tickets[0].ticket), /consumed|foreign/);
        assert.throws(() => saved.validate(a.state.tickets[0].ticket), /inactive/);
        if (stage === "readManifest") f.volume.revoke();
    };
    await assert.rejects(f.volume.readCandidatesOnce(f.authority, c.io), /revoked/);
    assert.equal(c.state.opened, 0); released(f, c);
    await f.volume.release(); f.volume.disposeCandidates(); f.runtime.dispose();
    await first.volume.release(); first.volume.disposeCandidates(); first.runtime.dispose();
});
test("unknown closes, regressing counters and invalid operations retain exact responsibility", async () => {
    for (const mode of ["unknown", "regression", "sync-throw", "invalid-operation", "invalid-promises", "settled-reject",
        "peak-zero", "snapshot-undefined", "outcome-thenable", "settled-thenable"]) {
        const f = await fixture(), c = channel(f);
        let thenReads = 0, thenCalls = 0;
        if (mode === "unknown" || mode === "regression") c.state.onSnapshot = () => {
            if (mode === "unknown" && c.state.starts.length === 1) {
                c.state.closed = 1; c.state.activeHandles = 1; c.state.uncertainHandles = [{ slot: 0, handle: "ABC" }];
            }
            if (mode === "regression" && c.state.starts.length === 2) { c.state.opened = 1; c.state.closed = 1; c.state.peak = 1; }
        };
        if (mode === "sync-throw") c.io.writeRequest = () => { throw Error("adapter synchronous failure"); };
        if (mode === "invalid-operation") c.io.writeRequest = () => ({ invalid: true });
        if (mode === "invalid-promises") c.io.writeRequest = () => ({ outcome: Promise.reject(Error("malformed outcome")),
            settled: Promise.reject(Error("malformed settlement")), extra: true });
        if (mode === "peak-zero") c.state.onSnapshot = () => { if (c.state.starts.length === 1) c.state.peak = 0; };
        if (mode === "snapshot-undefined") c.state.onSnapshot = () => { if (c.state.starts.length === 1) throw undefined; };
        if (mode.endsWith("-thenable")) {
            const thenable = Object.defineProperty({}, "then", { get() { thenReads++; return () => { thenCalls++; }; } });
            c.io.writeRequest = () => mode === "outcome-thenable" ? { outcome: thenable, settled: Promise.resolve() }
                : { outcome: Promise.reject(Error("genuine rejection beside invalid settlement")), settled: thenable };
        }
        if (mode === "settled-reject") c.state.next = { stage: "writeRequest", start(op) {
            return { outcome: Promise.resolve(op.value), settled: Promise.reject(Error("physical unknown")) };
        } };
        await assert.rejects(f.volume.readCandidatesOnce(f.authority, c.io));
        const d = f.volume.candidateDiagnostics;
        assert.equal(d.leaseHeld, true); assert.equal(d.channelHeld, true); assert.equal(d.vmHeld, true);
        if (mode === "unknown") assert.deepEqual(d.snapshot.uncertainHandles, [{ slot: 0, handle: "ABC" }]);
        if (mode === "settled-reject") {
            assert.equal(d.operationHeld, true); assert.equal(zero(c.state.borrowed), false);
            assert.equal(d.physicalSettled, false); assert.equal(d.snapshotCurrent, true); assert.equal(d.snapshotStage, "writeRequest");
            assert.equal(d.snapshot.activeHandles, 1);
        }
        if (mode === "regression") { assert.equal(d.snapshotCurrent, false); assert.equal(d.snapshotFailed, true); assert.equal(d.snapshotStage, "readManifest"); }
        if (mode === "peak-zero" || mode === "snapshot-undefined") {
            assert.equal(d.snapshotCurrent, false); assert.equal(d.snapshotFailed, true); assert.equal(d.snapshotStage, "admitting");
            assert.deepEqual(c.state.starts, ["readManifest"]);
        }
        assert.equal(thenReads, 0); assert.equal(thenCalls, 0);
        await assert.rejects(f.volume.release());
        f.volume.disposeCandidates(); assert.equal(f.volume.candidateDiagnostics.candidateHeld, false);
        assert.equal(f.volume.candidateDiagnostics.leaseHeld, true);
    }
});
test("falsy rejection values survive known physical completion and simultaneous final journal failure", async () => {
    for (const reason of [undefined, null, 0, false]) for (const failJournal of [false, true]) {
        const f = await fixture(), c = channel(f), journalFailure = Error("final journal failure");
        c.state.next = { stage: "writeRequest", start(op) {
            op.complete(); return { outcome: Promise.reject(reason), settled: Promise.resolve() };
        } };
        if (failJournal) f.state.onJournal = value => { if (value.candidateStage === "failed") throw journalFailure; };
        let rejected = false, actual;
        try { await f.volume.readCandidatesOnce(f.authority, c.io); } catch (value) { rejected = true; actual = value; }
        assert.equal(rejected, true);
        if (failJournal) { assert.ok(actual instanceof AggregateError); assert.deepEqual(actual.errors, [reason, journalFailure]); }
        else assert.equal(actual, reason);
        released(f, c); assert.deepEqual(c.state.starts, ["readManifest", "writeRequest"]);
        if (failJournal) await assert.rejects(f.volume.release());
        else { await f.volume.release(); f.runtime.dispose(); }
        f.volume.disposeCandidates();
    }
});
test("known closed guest-data rejection clears late buffers and permits owned disk cleanup", async () => {
    const f = await fixture(), c = channel(f);
    c.state.next = { stage: "readBatch", start(op) {
        const receipt = JSON.parse(op.value.receipt); receipt.sha256 = "f".repeat(64);
        op.value.receipt.fill(0); op.value.receipt = encode(receipt); c.state.buffers.push(op.value.receipt);
        op.complete(); return { outcome: Promise.resolve(op.value), settled: Promise.resolve() };
    } };
    await assert.rejects(f.volume.readCandidatesOnce(f.authority, c.io), /payload changed/); released(f, c);
    await f.volume.release(); f.volume.disposeCandidates(); f.runtime.dispose();
});
test("journal exceptions retain their cause and final publication cannot outlive candidate disposal", async () => {
    for (const mode of ["journal", "dispose"]) {
        const f = await fixture(), c = channel(f); let once = false;
        f.state.onJournal = value => {
            if (!once && value.candidateStage === "checked") { once = true;
                if (mode === "journal") throw Error("injected candidate journal");
                f.volume.disposeCandidates();
            }
        };
        await assert.rejects(f.volume.readCandidatesOnce(f.authority, c.io), mode === "journal" ? /injected candidate journal/ : /revoked/);
        released(f, c); assert.equal(c.state.opened, c.state.closed);
        if (mode === "journal") await assert.rejects(f.volume.release());
        else { await f.volume.release(); f.runtime.dispose(); }
        f.volume.disposeCandidates();
    }
});
test("existing bounded protocol sends only the two new fixed commands without changing stream handling", async () => {
    const child = new EventEmitter(); child.pid = 3; child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
    child.stdin = new EventEmitter(); const writes = [];
    child.stdin.write = (text, callback) => { writes.push(JSON.parse(text)); callback?.(); };
    const protocol = new VolumeProtocol(child, taskId); protocol.setUnsafeHandler(() => {});
    for (const command of ["read-candidate-manifest", "read-candidate-batch", "exit"]) {
        const pending = protocol.command(command, () => {}, 1000);
        const sent = writes.at(-1); assert.equal(sent.command, command);
        child.stdout.emit("data", encode(facts(command, sent.sequence))); child.stdout.emit("data", Buffer.from("\n"));
        await pending;
    }
    child.emit("close", 0, null); assert.equal(await protocol.waitClosed(), true);
    assert.equal(protocol.childReleased, true); assert.equal(protocol.diagnostics.buffersReleased, true);
    assert.equal(child.stdout.listenerCount("data"), 0);
});
