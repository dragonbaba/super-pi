import test from "node:test";
import assert from "node:assert/strict";
import { SandboxLifecycle } from "../scripts/acceptance/windows-sandbox-lifecycle.mjs";
import { TaskVolumeOwner } from "../scripts/acceptance/windows-sandbox-volume.mjs";
import { LiveSandboxRuntime, experimentalGuidConfig } from "../scripts/acceptance/windows-sandbox-volume-sharing.mjs";
import { validateCapacityReceipt, capacityEvidence } from "../scripts/acceptance/windows-sandbox-volume-capacity-receipt.mjs";
import { decodeCapacityDelivery } from "../scripts/acceptance/windows-sandbox-volume-capacity-protocol.mjs";
const taskId = "11111111-2222-3333-4444-555555555555", volumePath = "\\\\?\\Volume{aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee}\\", digest = "a".repeat(64);
const exchangeId = "AABBCCDD:0000000000000002", imageId = "11223344:0000000000000001";
function payload() {
    const bytes = Buffer.alloc(512); bytes.write("SPCF0001"); bytes.write(taskId.replaceAll("-", ""), 8);
    for (const [offset, value] of [[40, 3], [44, 1], [48, 2], [52, 1], [56, 2097152], [60, 1048576], [72, 1], [80, 112], [84, 1048576],
        [92, 1], [96, 1], [112, 1], [116, 1], [180, 1048576], [184, 144], [188, 20000], [192, 1], [196, 1]]) bytes.writeUInt32LE(value, offset);
    return bytes.toString("base64");
}
function receipt(stage = "install") {
    return { protocol: "super-pi-volume-capacity-v1", stage, taskId, volumePath, exchangeId, probeSha256: digest,
        installed: true, readCompleted: stage === "read", probeId: "AABBCCDD:0000000000000003", slotId: "AABBCCDD:0000000000000004",
        sentinelId: "11223344:0000000000000002", fillId: stage === "read" ? "AABBCCDD:0000000000000005" : null,
        fillLength: stage === "read" ? 1048576 : 0, fillAllocation: stage === "read" ? 1048576 : 0,
        resultBase64: stage === "read" ? payload() : null, sentinelMatched: stage === "read", opened: stage === "read" ? 9 : 5,
        closed: stage === "read" ? 9 : 5, peak: 3, closeErrors: Array(9).fill(null), retainedHandles: Array(9).fill(null), closeUnknown: false };
}
async function fixture() {
    const runtime = new LiveSandboxRuntime(taskId), state = { calls: [], records: [], revoked: 0, cancel: 0, gate: null, onJournal: null, mutate: null };
    const driver = { pid: 1, physicallyClosed: false, pending: false, setUnsafeHandler(fn) { this.unsafe = fn; }, async command(command, observe) {
        state.calls.push(command); this.pending = true;
        try {
            if (command.endsWith("capacity") && state.gate) await state.gate;
            const done = command === "release" || command === "exit";
            const value = { taskId, diskId: taskId, phase: done ? "released" : "prepared-not-share-admitted", error: null, imageCreated: true,
                imageId, physicalPath: "\\\\.\\PhysicalDrive77", volumePath, exchangeId, closeUnknown: false, managementClosed: done, detached: done };
            state.mutate?.(command, value); observe(value); return value;
        } finally { this.pending = false; }
    }, async waitClosed() { this.physicallyClosed = true; return true; } };
    const volume = new TaskVolumeOwner({ driver, taskId, readRuntime: runtime.read,
        journal(value) { state.records.push(value); state.onJournal?.(value); }, revokeCandidates() { state.revoked++; }, cancelExecution() { state.cancel++; } });
    await volume.prepare(); const config = experimentalGuidConfig(volume), ids = new Set();
    const cli = { launch(args) {
        if (args[0] === "start") ids.add(args[2]); else if (args[0] === "stop") ids.delete(args[2]); else assert.equal(args[0], "list");
        return { pid: 2, result: { pid: 2, exitCode: 0, signal: null, launchError: null, truncated: false, stderr: "",
            stdout: args[0] === "list" ? JSON.stringify({ WindowsSandboxEnvironments: [...ids].map(Id => ({ Id })) }) : "{}",
            closedUtc: "2026-11-01T00:00:00.000Z" }, async wait() { return "settled"; } };
    } };
    return { runtime, state, driver, volume, bind() {
        const vm = new SandboxLifecycle({ cli, taskId, config, journal() {} }); runtime.bind(vm); return vm;
    }, async closeVm() { const vm = this.bind(), ticket = await volume.issueExperimentalMapping(vm); await volume.startExperimentalMapping(ticket, vm);
        assert.equal(await vm.cleanup(), true); return vm; } };
}
test("capacity install before VM and read after its physical closure consume private receipts once", async () => {
    const f = await fixture(); await assert.rejects(f.volume.readCapacityOnce(() => receipt("read"), digest));
    const installed = await f.volume.installCapacityOnce(receipt, digest); assert.deepEqual(installed, receipt());
    assert.equal(Object.isFrozen(installed.retainedHandles), true); await assert.rejects(f.volume.installCapacityOnce(receipt, digest));
    const vm = await f.closeVm(); vm.execution = {}; await assert.rejects(f.volume.readCapacityOnce(() => receipt("read"), digest)); vm.execution = undefined;
    const result = await f.volume.readCapacityOnce(() => receipt("read"), digest); assert.equal(result.readCompleted, true);
    await assert.rejects(f.volume.readCapacityOnce(() => receipt("read"), digest)); await f.volume.release(); f.runtime.dispose();
    assert.deepEqual(f.state.calls, ["prepare", "install-capacity", "verify", "verify", "read-capacity", "release", "exit"]);
    assert.equal(f.driver.physicallyClosed, true); assert.equal(f.runtime.retainsOwner, false);
});
test("capacity install refuses a bound VM and final journal revocation prevents dispatch", async () => {
    const bound = await fixture(); const vm = bound.bind(); await assert.rejects(bound.volume.installCapacityOnce(receipt, digest));
    assert.deepEqual(bound.state.calls, ["prepare"]); assert.equal(await vm.cleanup(), true); await bound.volume.release(); bound.runtime.dispose();
    const f = await fixture(); let revoked = false;
    f.state.onJournal = value => { if (value.capacityInstallAttempted && !revoked) { revoked = true; f.volume.revoke(); } };
    await assert.rejects(f.volume.installCapacityOnce(receipt, digest), /admission changed/); assert.deepEqual(f.state.calls, ["prepare"]);
    await f.volume.release(); f.runtime.dispose();
});
test("pending capacity installation blocks release and runtime replacement retains responsibility", async () => {
    const f = await fixture(); let finish; f.state.gate = new Promise(resolve => { finish = resolve; });
    const installing = f.volume.installCapacityOnce(receipt, digest); await assert.rejects(f.volume.release());
    const vm = f.bind(); finish(); await assert.rejects(installing, /runtime binding changed/);
    assert.equal(f.state.revoked, 1); assert.equal(f.state.cancel, 1); await assert.rejects(f.volume.release());
    assert.equal(await vm.cleanup(), true); assert.equal(f.volume.state, "blocked");
});
test("capacity unknown closes and malformed identities block disk release after VM closure", async () => {
    for (const mode of ["close", "identity", "malformed"]) {
        const f = await fixture(); await f.volume.installCapacityOnce(receipt, digest); await f.closeVm();
        const value = receipt("read");
        if (mode === "close") { value.readCompleted = false; value.closeUnknown = true; value.closed = 8; value.retainedHandles[8] = "66"; value.closeErrors[8] = null; }
        if (mode === "identity") value.slotId = "AABBCCDD:00000000000000FF";
        if (mode === "malformed") value.authority = true;
        await assert.rejects(f.volume.readCapacityOnce(() => value, digest)); assert.equal(f.state.revoked, 1);
        await assert.rejects(f.volume.release()); assert.equal(f.driver.physicallyClosed, false);
    }
});
test("ordinary capacity failure keeps diagnostic receipts but permits quiescent release", async () => {
    const f = await fixture(); await f.volume.installCapacityOnce(receipt, digest); await f.closeVm();
    const value = receipt("read"); value.readCompleted = false;
    f.state.mutate = (command, reply) => { if (command === "read-capacity") { reply.error = "storage-operation-failed"; reply.phase = "blocked"; } };
    let captured; await assert.rejects(f.volume.readCapacityOnce(() => captured = value, digest));
    assert.equal(captured.resultBase64, value.resultBase64); assert.equal(f.state.revoked, 0);
    await f.volume.release(); f.runtime.dispose(); assert.equal(f.driver.physicallyClosed, true);
});
test("capacity receipt rejects authority, foreign identities and lost handles, and separates data from delivery", () => {
    const facts = { imageId, exchangeId, volumePath }, installed = validateCapacityReceipt(receipt(), "install", taskId, facts, digest);
    const read = () => validateCapacityReceipt(receipt("read"), "read", taskId, facts, digest, installed);
    assert.equal(capacityEvidence(read(), decodeCapacityDelivery(0)).qualified, true);
    assert.equal(capacityEvidence(read(), decodeCapacityDelivery(72)).qualified, false);
    const wrong = receipt("read"); wrong.fillLength = 3145728; wrong.fillAllocation = 3145728;
    assert.equal(capacityEvidence(validateCapacityReceipt(wrong, "read", taskId, facts, digest, installed), decodeCapacityDelivery(0)).qualified, false);
    for (const mutate of [v => v.authority = true, v => v.taskId = "other", v => v.probeSha256 = "b".repeat(64), v => v.sentinelId = "AABBCCDD:0000000000000002",
        v => v.retainedHandles.pop(), v => v.closeErrors[0] = 6, v => v.resultBase64 = "!".repeat(684), v => v.fillAllocation = 134217729,
        v => v.installed = false, v => v.closed = 8]) {
        const value = receipt("read"); mutate(value); assert.throws(() => validateCapacityReceipt(value, "read", taskId, facts, digest, installed));
    }
    const original = receipt(), fixed = validateCapacityReceipt(original, "install", taskId, facts, digest); original.closeErrors[0] = 5;
    assert.equal(fixed.closeErrors[0], null); assert.equal(Object.isFrozen(fixed), true);
});
