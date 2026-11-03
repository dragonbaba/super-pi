import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { DiagnosticResultChannel, DIAGNOSTIC_CHANNEL_LIMITS } from "../scripts/acceptance/windows-sandbox-volume-diagnostic-channel.mjs";
import { faultDiagnosticEnvelope, validateFaultDiagnosticText } from "../scripts/acceptance/windows-sandbox-volume-fault-cleanup.mjs";
const taskId = "11111111-1111-4111-8111-111111111111", instanceId = "22222222-2222-4222-8222-222222222222";
function context() { return { taskId, instanceId, rootId: "12345678:0000000000000001", imageId: "12345678:0000000000000002",
    imageBytes: 134218240, volumePath: "\\\\?\\Volume{33333333-3333-4333-8333-333333333333}\\" }; }
function receipt() { return { protocol: "super-pi-manager-loss-diagnostic-v1", ...context(), diskId: taskId,
    virtualBytes: 134217728, subtype: 2, isLoaded: false, guid: { opened: false, error: 2 },
    handles: [["root", "65", 1, true, false, null, false, null], ["image", "66", 1, true, false, null, false, null],
        ["vhd-info", "67", 1, true, false, null, false, null]] }; }
const raw = value => Buffer.from(JSON.stringify(value ?? receipt()) + "\n", "utf8");
function originalCall(wait) {
    let calls = 0, kills = 0;
    const call = { pid: 4321, child: { kill() { kills++; } }, out: {}, err: {}, result: undefined,
        wait(ms, signal) { assert.equal(this, call); assert.equal(ms, 15000); calls++; return wait ? wait(signal) : Promise.resolve(call.result ? "settled" : "timeout"); } };
    const close = (bytes = raw(), overrides = {}) => {
        // Exactly the existing CapturedProcess UTF-8 decoding semantics; no actual process is created.
        call.result = { pid: call.pid, exitCode: 0, signal: null, launchError: null, closedUtc: "2026-11-02T00:00:00.000Z",
            stdout: bytes.toString("utf8"), stderr: "", stdoutSeen: bytes.length, stderrSeen: 0, truncated: false, ...overrides };
        call.child = undefined; call.out = undefined; call.err = undefined;
        return call.result;
    };
    return { call, close, counters: () => ({ calls, kills }) };
}
const signal = () => new AbortController().signal;
function released(channel) {
    const s = channel.snapshot; assert.equal(s.state, "disposed"); assert.equal(s.waiting || s.callHeld || s.bindingHeld || s.waitHeld, false);
    assert.equal(s.retainedBytes, 0); assert.equal(s.allocatedBytes, s.clearedBytes + s.transferredBytes); assert.equal(channel.originalError, undefined);
}
test("complete ASCII success transfers the same checked bytes once, or clears them locally", async () => {
    assert.deepEqual(DIAGNOSTIC_CHANNEL_LIMITS, { waitMs: 15000, receiptBytes: 4096, capturedStdoutBytes: 16384, capturedStderrBytes: 16384, reconstructedBytes: 4096 });
    const f = originalCall(), input = context(), channel = new DiagnosticResultChannel(input, f.call), bytes = raw();
    f.close(bytes); input.taskId = instanceId;
    const proof = await channel.waitOnce(signal()); assert.equal(proof.stdoutBytes, bytes.length);
    assert.equal(proof.sha256, createHash("sha256").update(bytes).digest("hex"));
    assert.equal(proof.reconstruction, "complete-ascii-utf8");
    const transferred = channel.takeSuccess(); assert.deepEqual(transferred.bytes, bytes); assert.equal(transferred.proof, proof);
    const envelope = faultDiagnosticEnvelope(taskId, transferred.bytes);
    assert.ok(envelope.bytes <= 6144); const restored = Buffer.from(JSON.parse(envelope.line).base64, "base64");
    assert.deepEqual(restored, bytes); restored.fill(0); bytes.fill(0);
    assert.ok(transferred.bytes.some(b => b !== 0), "independent reconstruction survives source mutation");
    assert.throws(() => channel.takeSuccess()); channel.dispose(); released(channel);
    assert.equal(channel.snapshot.clearedBytes, 0); assert.equal(channel.snapshot.transferredBytes, proof.stdoutBytes);
    transferred.bytes.fill(0); assert.ok(transferred.bytes.every(b => b === 0)); // Receiving fake owner closes its byte responsibility.
    assert.deepEqual(f.counters(), { calls: 1, kills: 0 });
    const discard = originalCall(); discard.close(); const second = new DiagnosticResultChannel(context(), discard.call);
    await second.waitOnce(signal()); second.dispose(); released(second);
    assert.equal(second.snapshot.clearedBytes, second.snapshot.allocatedBytes); assert.equal(second.snapshot.transferredBytes, 0);
});

test("invalid UTF-8, non-ASCII, BOM and newline normalization are never accepted", async () => {
    const good = raw(), cases = [
        Buffer.concat([Buffer.from([0xff]), good]),
        Buffer.concat([Buffer.from([0xc0, 0xaf]), good]),
        Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), good]),
        Buffer.from(good.toString("utf8").replace("root", "røot"), "utf8"),
        Buffer.from(good.toString("utf8").replace(/\n$/, "\r\n"), "utf8"),
        Buffer.from(good.toString("utf8").trimEnd(), "utf8"),
        Buffer.from(" " + good.toString("utf8"), "utf8"),
        Buffer.from(good.map(byte => byte | 128)),
    ];
    for (const bytes of cases) {
        const f = originalCall(); f.close(bytes); const channel = new DiagnosticResultChannel(context(), f.call);
        await assert.rejects(channel.waitOnce(signal())); assert.equal(channel.snapshot.allocatedBytes, 0);
        assert.throws(() => channel.takeSuccess()); channel.dispose(); released(channel); assert.equal(f.counters().kills, 0); bytes.fill(0);
    }
    good.fill(0);
});

test("byte counts, output bounds and physical result failures deny success", async () => {
    const cases = [
        { stdoutSeen: 0 }, { stdoutSeen: 4097 }, { stdoutSeen: 1.5 }, { stdoutSeen: raw().length + 1 },
        { stderrSeen: 1 }, { stderr: "unexpected" }, { truncated: true }, { exitCode: 23 }, { signal: "SIGTERM" },
        { launchError: "ENOENT" }, { pid: 9876 }, { closedUtc: null }, { stdout: null },
    ];
    for (const value of cases) {
        const f = originalCall(); f.close(raw(), value); const channel = new DiagnosticResultChannel(context(), f.call);
        await assert.rejects(channel.waitOnce(signal())); assert.equal(channel.snapshot.failed, true);
        assert.equal(channel.snapshot.allocatedBytes, 0); channel.dispose(); released(channel);
    }
    for (const size of [4096, 4097]) {
        const f = originalCall(); f.close(Buffer.from(" ".repeat(size - 1) + "\n")); const channel = new DiagnosticResultChannel(context(), f.call);
        await assert.rejects(channel.waitOnce(signal())); channel.dispose(); released(channel);
    } // Bound probes are not valid success schemas.
});

test("the shared success schema retains identity, unattached and exact handle closure requirements", async () => {
    const changes = [
        v => { v.taskId = instanceId; }, v => { v.instanceId = taskId; }, v => { v.diskId = instanceId; },
        v => { v.rootId = v.imageId; }, v => { v.imageBytes++; }, v => { v.virtualBytes--; }, v => { v.subtype = 3; },
        v => { v.isLoaded = true; }, v => { v.guid.error = 5; }, v => { v.guid.opened = true; },
        v => { v.handles[0][2] = 2; }, v => { v.handles[1][3] = false; }, v => { v.handles[2][6] = true; },
        v => { v.handles[2][1] = v.handles[1][1]; }, v => { v.extra = true; },
    ];
    for (const change of changes) {
        const value = receipt(); change(value); const f = originalCall(); f.close(raw(value));
        const channel = new DiagnosticResultChannel(context(), f.call);
        await assert.rejects(channel.waitOnce(signal())); assert.equal(channel.snapshot.allocatedBytes, 0); channel.dispose(); released(channel);
    }
    const text = raw().toString("utf8");
    assert.doesNotThrow(() => validateFaultDiagnosticText(text.replace(/\n$/, "\r\n"), context())); // Earlier core compatibility is unchanged.
    assert.throws(() => validateFaultDiagnosticText("x".repeat(4097), context()));
});

test("timeout and cancellation retain the original call and never kill or resume after late close", async () => {
    for (const outcome of ["timeout", "cancelled"]) {
        const f = originalCall(() => Promise.resolve(outcome)), channel = new DiagnosticResultChannel(context(), f.call);
        await assert.rejects(channel.waitOnce(signal()));
        assert.equal(channel.snapshot.callHeld, true); assert.throws(() => channel.dispose(), /unresolved/);
        assert.equal(channel.snapshot.allocatedBytes, 0); assert.deepEqual(f.counters(), { calls: 1, kills: 0 });
        f.close(); await assert.rejects(channel.waitOnce(signal())); assert.throws(() => channel.takeSuccess());
        channel.dispose(); released(channel); assert.deepEqual(f.counters(), { calls: 1, kills: 0 });
    }
    const controller = new AbortController(); controller.abort();
    const done = originalCall(); done.close(); const channel = new DiagnosticResultChannel(context(), done.call);
    await assert.rejects(channel.waitOnce(controller.signal)); channel.dispose(); released(channel);
    const fakeSettled = originalCall(() => Promise.resolve("settled")); fakeSettled.call.result = {};
    const unknown = new DiagnosticResultChannel(context(), fakeSettled.call);
    await assert.rejects(unknown.waitOnce(signal())); assert.throws(() => unknown.dispose()); fakeSettled.close(); unknown.dispose(); released(unknown);
});

test("pending wait, thrown falsy causes and original wait identity keep one responsibility", async () => {
    let resolve; const waiting = new Promise(done => { resolve = done; });
    const f = originalCall(() => waiting), channel = new DiagnosticResultChannel(context(), f.call);
    const pending = channel.waitOnce(signal()), rejected = assert.rejects(pending);
    assert.equal(channel.snapshot.waiting, true); assert.throws(() => channel.dispose()); await assert.rejects(channel.waitOnce(signal()));
    resolve("timeout"); await rejected; f.close(); channel.dispose(); released(channel);
    for (const cause of [undefined, Error("wait failure")]) {
        const failed = originalCall(() => Promise.reject(cause)), retained = new DiagnosticResultChannel(context(), failed.call);
        await assert.rejects(retained.waitOnce(signal()), error => error === cause);
        assert.equal(retained.snapshot.failed, true); assert.equal(retained.originalError, cause);
        assert.throws(() => retained.dispose()); failed.close(); retained.dispose(); released(retained);
    }
    const original = originalCall(); const bound = new DiagnosticResultChannel(context(), original.call);
    original.call.wait = () => { throw Error("replacement must not run"); }; original.close();
    await bound.waitOnce(signal()); assert.deepEqual(original.counters(), { calls: 1, kills: 0 }); bound.dispose(); released(bound);
});

test("getter-bearing data is rejected without executing it and result closure cannot be forged by wait alone", async () => {
    let reads = 0; const input = context();
    Object.defineProperty(input, "taskId", { enumerable: true, get() { reads++; return taskId; } });
    assert.throws(() => new DiagnosticResultChannel(input, originalCall().call)); assert.equal(reads, 0);
    const f = originalCall(), result = f.close();
    Object.defineProperty(result, "stdout", { enumerable: true, get() { reads++; return ""; } });
    const channel = new DiagnosticResultChannel(context(), f.call); await assert.rejects(channel.waitOnce(signal()));
    assert.equal(reads, 0); assert.equal(channel.snapshot.allocatedBytes, 0); channel.dispose(); released(channel);
    for (const field of ["child", "out", "err"]) {
        const f = originalCall(); f.close(); f.call[field] = {};
        const retained = new DiagnosticResultChannel(context(), f.call); await assert.rejects(retained.waitOnce(signal()));
        assert.throws(() => retained.dispose()); assert.equal(retained.snapshot.callHeld, true); assert.equal(f.counters().kills, 0);
        f.call[field] = undefined; retained.dispose(); released(retained);
    }
});

