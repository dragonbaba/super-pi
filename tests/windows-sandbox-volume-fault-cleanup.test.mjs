import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { FaultCleanupContract, FAULT_CLEANUP_FILES, faultDiagnosticEnvelope } from "../scripts/acceptance/windows-sandbox-volume-fault-cleanup.mjs";
const taskId = "11111111-2222-3333-4444-555555555555", instanceId = "22222222-3333-4444-5555-666666666666";
const rootId = "AABBCCDD:0000000000000001", imageId = "AABBCCDD:0000000000000002";
const volumePath = "\\\\?\\Volume{aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee}\\";
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
function fixture(t) {
    const refs = Object.fromEntries(["owner", "vm", "driver", "runtime", "diagnostic", "output"].map(key => [key, { role: key, retained: true }]));
    const binding = { taskId, instanceId, rootId, imageId, volumePath, imageBytes: 134218240, managerPid: 101, refs };
    const receipt = { protocol: "super-pi-manager-loss-diagnostic-v1", taskId, instanceId, rootId, imageId, diskId: taskId,
        imageBytes: binding.imageBytes, volumePath, virtualBytes: 134217728, subtype: 2, isLoaded: false,
        guid: { opened: false, error: 2 }, handles: ["root", "image", "vhd-info"].map((role, i) => [role, (256 + i * 4).toString(16).toUpperCase(), 1, true, false, null, false, null]) };
    const state = { refs: { ...refs }, generation: 1,
        fault: { attempts: 1, requestAccepted: true, managerPid: 101, exitCode: null, signal: "SIGTERM",
            unsafe: true, cancelled: true, taskRejected: true, execCount: 0, captureCount: 0 },
        lifecycle: { vmTaskId: taskId, vmInstanceId: instanceId, vmState: "closed", vmAbsent: true, cliCount: 6, cliClosed: 6,
            processCount: 10, processClosed: 10, managerPid: 101, managerClosed: true, diagnosticPid: 102, diagnosticClosed: true,
            pending: 0, unknownHandles: 0, candidateBytes: 0 },
        diagnostic: { raw: undefined, result: { pid: 102, exitCode: 0, signal: null, launchError: null, truncated: false,
            stdoutBytes: 0, stderrBytes: 0, closedUtc: "2026-11-01T23:00:00.000Z" } },
        diagnosticFileSha256: null,
        delivery: { reportSha256: "a".repeat(64), reportBytes: 6000, reportDeliveredBytes: 6000,
            diagnosticWireSha256: null, diagnosticDeliveredBytes: 0, pending: false, failed: false, logFrozen: true },
        root: { id: rootId, present: true },
        files: FAULT_CLEANUP_FILES.map(([name], i) => ({ name, id: "AABBCCDD:" + (i + 2).toString(16).toUpperCase().padStart(16, "0"),
            bytes: i === 0 ? binding.imageBytes : name === "volume-native.dll" ? 65536 : 512 })),
    };
    const f = { binding, receipt, state, calls: 0, hook: null, core: undefined,
        refresh() {
            state.diagnostic.raw?.fill(0); state.diagnostic.raw = Buffer.from(JSON.stringify(receipt) + "\n");
            state.diagnostic.result.stdoutBytes = state.diagnostic.raw.length;
            state.diagnosticFileSha256 = hash(state.diagnostic.raw);
            state.files.find(row => row.name === "fault-diagnostic.json").bytes = state.diagnostic.raw.length;
            const wire = faultDiagnosticEnvelope(taskId, state.diagnostic.raw);
            state.delivery.diagnosticWireSha256 = wire.sha256; state.delivery.diagnosticDeliveredBytes = wire.bytes;
        },
    };
    f.refresh();
    f.core = new FaultCleanupContract(binding, () => { f.calls++; f.hook?.(); return state; });
    t.after(() => state.diagnostic.raw.fill(0));
    return f;
}
function settledCopies(core) {
    const d = core.diagnostics;
    assert.equal(d.activeCopyBytes, 0); assert.equal(d.copyBytesAllocated, d.copyBytesCleared); assert.ok(d.peakCopyBytes <= 4096);
}
function rejectsPreparation(f) {
    const before = hash(f.state.diagnostic.raw);
    assert.throws(() => f.core.prepare()); assert.equal(f.core.diagnostics.state, "blocked");
    assert.equal(f.core.diagnostics.contextHeld, true); assert.equal(hash(f.state.diagnostic.raw), before); settledCopies(f.core);
}
test("fault cleanup contract seals one plan, simulates five leaves and releases only its own references", t => {
    const f = fixture(t), originalRaw = hash(f.state.diagnostic.raw), { token, plan } = f.core.prepare();
    assert.equal(plan.contractOnly, true); assert.equal(Object.isFrozen(plan.files), true); assert.equal(Object.isFrozen(plan.files[0]), true);
    f.binding.taskId = instanceId; f.binding.refs.owner = {}; // Captured context remains independent of input containers.
    assert.equal(f.core.consume(token), plan);
    for (const item of plan.files) {
        assert.equal(f.core.beforeLeaf(token, item.name), item);
        f.state.files.shift(); f.core.leafRemoved(token);
    }
    f.core.beforeRoot(token); f.state.root = { present: false, id: null }; f.core.rootRemoved(token);
    const d = f.core.diagnostics;
    assert.equal(d.state, "model-complete"); assert.equal(d.completedLeaves, 5); assert.equal(d.contextHeld, false); assert.equal(d.observerHeld, false);
    assert.equal(d.originalFault.unsafe, true); assert.equal(d.originalFault.taskRejected, true);
    for (const ref of Object.values(f.state.refs)) assert.equal(ref.retained, true);
    assert.equal(hash(f.state.diagnostic.raw), originalRaw); settledCopies(f.core);
    assert.throws(() => f.core.consume(token)); assert.equal(f.core.diagnostics.state, "model-complete");
    t.diagnostic(JSON.stringify({ observations: f.calls, leaves: 5, rawBytes: f.state.diagnostic.raw.length,
        copied: d.copyBytesAllocated, cleared: d.copyBytesCleared, peak: d.peakCopyBytes, realOperations: 0 }));
});
test("all six original host object bindings and exact context identities are required", t => {
    for (const key of ["owner", "vm", "driver", "runtime", "diagnostic", "output"]) {
        const f = fixture(t), { token } = f.core.prepare(); f.state.refs[key] = {};
        assert.throws(() => f.core.consume(token), /replaced/); assert.equal(f.core.diagnostics.contextHeld, true);
    }
    const f = fixture(t); f.state.root.id = imageId; rejectsPreparation(f);
    const g = fixture(t); g.state.lifecycle.vmInstanceId = taskId; rejectsPreparation(g);
});
test("diagnostic identities, attached state, GUID errors and exact one-close rows fail closed", t => {
    const mutations = [
        r => { r.taskId = instanceId; }, r => { r.instanceId = taskId; }, r => { r.diskId = instanceId; },
        r => { r.rootId = imageId; }, r => { r.imageId = rootId; }, r => { r.imageBytes++; },
        r => { r.virtualBytes++; }, r => { r.subtype = 3; }, r => { r.isLoaded = true; },
        r => { r.guid.opened = true; }, r => { r.guid.error = 5; }, r => { r.guid.error = 0; },
        r => { r.handles[1][2] = 2; }, r => { r.handles[2][3] = false; },
        r => { r.handles[2][6] = true; r.handles[2][7] = 0; },
        r => { r.handles[2][1] = r.handles[0][1]; }, r => { r.handles[1][1] = "FFFFFFFFFFFFFFFF"; },
    ];
    for (const mutate of mutations) { const f = fixture(t); mutate(f.receipt); f.refresh(); rejectsPreparation(f); }
});
test("diagnostic process identity, output bounds and raw-file association are independent", t => {
    for (const [key, value] of [["pid", 103], ["exitCode", 1], ["signal", "SIGTERM"], ["launchError", "EIO"],
        ["truncated", true], ["stdoutBytes", 0], ["stderrBytes", 1], ["closedUtc", "unknown"]]) {
        const f = fixture(t); f.state.diagnostic.result[key] = value; rejectsPreparation(f);
    }
    const f = fixture(t); f.state.diagnosticFileSha256 = "b".repeat(64); rejectsPreparation(f);
    const g = fixture(t); g.state.diagnostic.raw[0] = 0xff; rejectsPreparation(g);
    const h = fixture(t); h.receipt.extra = true; h.refresh(); rejectsPreparation(h);
});
test("original failure and every physical responsibility remain independent prerequisites", t => {
    for (const [key, value] of [["managerClosed", false], ["diagnosticClosed", false], ["pending", 1], ["unknownHandles", 1],
        ["candidateBytes", 1], ["vmAbsent", false], ["vmState", "unknown"], ["cliClosed", 5], ["processClosed", 9], ["processCount", 11]]) {
        const f = fixture(t); f.state.lifecycle[key] = value; rejectsPreparation(f);
    }
    for (const [key, value] of [["attempts", 2], ["requestAccepted", false], ["unsafe", false], ["cancelled", false],
        ["taskRejected", false], ["execCount", 1], ["captureCount", 1]]) {
        const f = fixture(t); f.state.fault[key] = value; rejectsPreparation(f);
    }
});
test("a summary hash cannot replace full raw delivery or frozen journal confirmation", t => {
    for (const [key, value] of [["reportDeliveredBytes", 5999], ["diagnosticDeliveredBytes", 0], ["diagnosticWireSha256", "b".repeat(64)],
        ["pending", true], ["failed", true], ["logFrozen", false]]) {
        const f = fixture(t); f.state.delivery[key] = value; rejectsPreparation(f);
    }
    const raw = Buffer.alloc(4096, 0xff);
    try {
        const wire = faultDiagnosticEnvelope(taskId, raw), parsed = JSON.parse(wire.line), roundtrip = Buffer.from(parsed.base64, "base64");
        try { assert.deepEqual(roundtrip, raw); assert.ok(wire.bytes <= 6144); assert.equal(wire.sha256, hash(wire.line)); }
        finally { roundtrip.fill(0); }
        const over = Buffer.alloc(4097); try { assert.throws(() => faultDiagnosticEnvelope(taskId, over)); } finally { over.fill(0); }
        t.diagnostic(JSON.stringify({ maximumRaw: raw.length, wireBytes: wire.bytes, wireLimit: 6144 }));
    } finally { raw.fill(0); }
});
test("five exact leaves, immutable evidence generation and per-step identity are required", t => {
    const mutations = [
        f => f.state.files.pop(), f => f.state.files.push({ name: "extra", id: rootId, bytes: 1 }),
        f => { f.state.files[1].id = imageId; }, f => { f.state.files[2].name = f.state.files[1].name; },
        f => { f.state.files[0].bytes++; }, f => { f.state.files[1].bytes = 131073; },
        f => { f.state.files[3].bytes++; }, f => { f.state.files.reverse(); },
    ];
    for (const mutate of mutations) { const f = fixture(t); mutate(f); rejectsPreparation(f); }
    for (const change of [f => { f.state.generation++; }, f => { f.state.delivery.reportSha256 = "c".repeat(64); },
        f => { f.state.files[4].id = "AABBCCDD:000000000000000F"; }, f => { f.state.files[4].bytes++; }]) {
        const f = fixture(t), { token } = f.core.prepare(); change(f); assert.throws(() => f.core.consume(token)); assert.equal(f.core.diagnostics.contextHeld, true);
    }
});
test("serialized, foreign and replayed tokens cannot authorize a second cleanup plan", t => {
    const f = fixture(t), g = fixture(t), a = f.core.prepare(), b = g.core.prepare();
    assert.throws(() => f.core.consume(b.token)); assert.throws(() => g.core.consume(JSON.parse(JSON.stringify(b.token))));
    const h = fixture(t), c = h.core.prepare(); h.core.consume(c.token);
    assert.throws(() => h.core.consume(c.token)); assert.throws(() => h.core.beforeLeaf(c.token, "task.vhd"));
    const j = fixture(t), d = j.core.prepare(); j.core.consume(d.token); assert.throws(() => j.core.beforeRoot(d.token));
    assert.equal(a.plan.originalFault.taskRejected, true);
});
test("partial cleanup, changed evidence and falsy failure keep responsibility without retry", t => {
    const f = fixture(t), { token } = f.core.prepare(); f.core.consume(token);
    f.core.beforeLeaf(token, "task.vhd"); f.state.files.shift(); f.core.leafRemoved(token);
    let caught = true; try { f.core.reject(false); } catch (error) { caught = error; }
    assert.equal(caught, false); assert.equal(f.core.diagnostics.completedLeaves, 1); assert.equal(f.core.diagnostics.contextHeld, true);
    assert.equal(f.core.diagnostics.failure.type, "boolean"); assert.throws(() => f.core.prepare());
    const g = fixture(t), p = g.core.prepare(); g.core.consume(p.token);
    g.core.beforeLeaf(p.token, "task.vhd"); g.state.files.shift(); g.state.generation++;
    assert.throws(() => g.core.leafRemoved(p.token)); assert.equal(g.core.diagnostics.pendingLeaf, true);
    assert.equal(g.core.diagnostics.completedLeaves, 0); assert.equal(g.core.diagnostics.contextHeld, true);
});
test("observer reentry or getter data never resurrects a consumed or revoked qualification", t => {
    const f = fixture(t), { token } = f.core.prepare(); let attempted = 0;
    f.hook = () => { if (attempted++ === 0) assert.throws(() => f.core.consume(token)); };
    assert.throws(() => f.core.consume(token)); assert.equal(f.core.diagnostics.state, "blocked");
    const g = fixture(t); g.hook = () => { try { g.core.reject(undefined); } catch {} };
    assert.throws(() => g.core.prepare()); assert.equal(g.core.diagnostics.failure.type, "undefined");
    const h = fixture(t); let reads = 0;
    Object.defineProperty(h.state.delivery, "pending", { enumerable: true, get() { reads++; return false; } });
    rejectsPreparation(h); assert.equal(reads, 0);
});
