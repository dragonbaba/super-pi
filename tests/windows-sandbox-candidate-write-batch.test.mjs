// Pure captured-data conversion evidence. No Windows resource, permission or host-write execution.
import assert from "node:assert/strict";
import test, { after } from "node:test";
import { createHash } from "node:crypto";
import { setImmediate as tick } from "node:timers/promises";
import { CANDIDATE_PROTOCOL, CANDIDATE_LIMITS } from "../scripts/acceptance/windows-sandbox-candidates.mjs";
import { CapturedCandidateOwner, CAPTURE_PROTOCOL, REQUEST_PROTOCOL } from "../scripts/acceptance/windows-sandbox-volume-candidate-contract.mjs";
import { CapturedWriteBatch } from "../scripts/acceptance/windows-sandbox-candidate-write-batch.mjs";

const taskId = "11111111-2222-3333-4444-555555555555", snapshotId = "22222222-3333-4444-5555-666666666666";
const instanceId = "33333333-4444-5555-6666-777777777777", volumePath = "\\\\?\\Volume{aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee}\\";
const exchangeId = "AABBCCDD:0000000000000001", manifestId = "AABBCCDD:0000000000000002";
const manifestCarrier = "11223344:0000000000000001", batchCarrier = "11223344:0000000000000002";
const revision = "snap_" + "a".repeat(22), hash = bytes => createHash("sha256").update(bytes).digest("hex");
const active = new Set(), completed = [];
let owners = 0, fixtureAllocated = 0, fixtureCleared = 0, payloadBytes = 0, conversions = 0, attempts = 0;
function fixture(rows) {
    assert.ok(owners < 16); owners++;
    const buffers = [], f = { owner: undefined, buffers }; active.add(f);
    function owned(value) { buffers.push(value); fixtureAllocated += value.length; assert.ok(fixtureAllocated <= 65536); return value; }
    const encode = value => owned(Buffer.from(JSON.stringify(value)));
    try {
        const allowed = rows.map((row, index) => ({ path: `file${index}.txt`, operation: row.operation ?? "add",
            revision: row.operation === "modify" ? row.revision ?? revision : null }));
        const owner = f.owner = new CapturedCandidateOwner({ taskId, snapshotId, instanceId, volumePath, exchangeId, budget: { ...CANDIDATE_LIMITS }, allowed });
        const raw = encode({ protocol: CANDIDATE_PROTOCOL, taskId, snapshotId,
            candidates: allowed.map(({ path, operation }) => ({ path, operation })), report: { exitCode: 23 } });
        const manifest = encode({ protocol: CAPTURE_PROTOCOL, stage: "manifest", taskId, volumePath, exchangeId, carrierId: manifestCarrier,
            bytes: raw.length, sha256: hash(raw), sourceId: manifestId, handles: { opened: 3, closed: 3, peak: 2, closeUnknown: false, retained: [] } });
        owner.acceptManifest(raw, manifest, manifestCarrier);
        const request = encode({ protocol: REQUEST_PROTOCOL, taskId, manifestSha256: hash(raw), paths: allowed.map(item => item.path) });
        const chunks = rows.map(row => owned(Array.isArray(row.bytes) ? Buffer.from(row.bytes) : Buffer.from(row.text ?? "", "utf8")));
        const payload = owned(Buffer.concat(chunks)); payloadBytes += payload.length; assert.ok(payloadBytes <= 512);
        const handleCount = 2 + rows.length * 3;
        const batch = encode({ protocol: CAPTURE_PROTOCOL, stage: "batch", taskId, volumePath, exchangeId, carrierId: batchCarrier,
            bytes: payload.length, sha256: hash(payload), requestSha256: hash(request),
            items: chunks.map((bytes, index) => ["AABBCCDD:" + BigInt(index + 3).toString(16).toUpperCase().padStart(16, "0"), bytes.length, hash(bytes)]),
            handles: { opened: handleCount, closed: handleCount, peak: rows.length ? 4 : 1, closeUnknown: false, retained: [] } });
        owner.acceptBatch(payload, batch, batchCarrier);
        return f;
    } catch (error) { dispose(f); throw error; }
}
function dispose(f) {
    f.owner?.dispose();
    if (f.owner) {
        const d = f.owner.diagnostics;
        assert.equal(d.retainedRequestBytes, 0); assert.equal(d.retainedPayloadBytes, 0); assert.equal(d.retainedContext, false);
    }
    for (const bytes of f.buffers) { bytes.fill(0); fixtureCleared += bytes.length; }
    f.buffers.length = 0; active.delete(f);
}
function converter() { assert.ok(conversions < 24); conversions++; return new CapturedWriteBatch(); }
function prepare(value, owner) { assert.ok(attempts < 32); attempts++; return value.prepare(owner); }
function released(value) {
    const d = value.diagnostics;
    assert.equal(d.retainedBytes, 0); assert.equal(d.clearedBytes, d.copiedBytes + d.roundtripBytes);
    assert.equal(d.retainedCandidate, false); assert.equal(d.retainedInput, false); assert.equal(d.retainedBinding, false);
    completed.push(d);
}
after(() => {
    console.log(JSON.stringify({ owners, conversions, attempts, payloadBytes, fixtureAllocated, fixtureCleared,
        activeFixtures: active.size, completed: completed.length, copies: completed.reduce((n, d) => n + d.copies, 0),
        copiedBytes: completed.reduce((n, d) => n + d.copiedBytes, 0), roundtripBytes: completed.reduce((n, d) => n + d.roundtripBytes, 0),
        clearedBytes: completed.reduce((n, d) => n + d.clearedBytes, 0), filesystemOperations: 0, guestExecutions: 0, nativeFileExecutions: 0 }));
    assert.equal(active.size, 0); assert.equal(fixtureCleared, fixtureAllocated);
    assert.ok(owners <= 16 && conversions <= 24 && attempts <= 32 && payloadBytes <= 512);
    assert.equal(owners, 12); assert.equal(conversions, 20); assert.equal(attempts, 25); assert.equal(payloadBytes, 75);
    assert.equal(completed.length, 20); assert.equal(completed.reduce((n, d) => n + d.copies, 0), 14);
    assert.equal(completed.reduce((n, d) => n + d.copiedBytes, 0), 66);
    assert.equal(completed.reduce((n, d) => n + d.roundtripBytes, 0), 58);
    assert.equal(completed.reduce((n, d) => n + d.clearedBytes, 0), 124);
});

test("preserve exact UTF-8 bytes, original snapshot and data-only transfer", () => {
    const texts = ["", "\ufeff中\r\n\u0000😀", "old→new\n"];
    const f = fixture(texts.map((text, index) => ({ text, ...(index === 2 ? { operation: "modify" } : {}) }))), value = converter();
    try {
        prepare(value, f.owner);
        const before = value.diagnostics; assert.equal(before.copies, 3);
        const result = value.take(); assert.equal(result.binding.taskId, taskId); assert.equal(result.guestReport.exitCode, 23);
        assert.equal(result.guestReport.source, "guest-report");
        assert.ok(Object.isFrozen(result.input.operations) && result.input.operations.every(Object.isFrozen));
        assert.ok(Object.isExtensible(result.input));
        assert.throws(() => { result.input.operations = []; });
        assert.throws(() => { delete result.input.operations; });
        const runtimeSymbol = Symbol("runtime attachment");
        Object.defineProperty(result.input, runtimeSymbol, { value: true }); assert.equal(result.input[runtimeSymbol], true);
        assert.deepEqual(result.input.operations.map(item => item.content), texts);
        assert.equal(result.input.operations[0].mode, "create"); assert.equal("snapshot" in result.input.operations[0], false);
        assert.equal(result.input.operations[2].mode, "overwrite"); assert.equal(result.input.operations[2].snapshot, revision);
        assert.throws(() => value.take()); assert.throws(() => prepare(value, f.owner));
        const duplicate = converter(); try { assert.throws(() => prepare(duplicate, f.owner), /already attempted/); } finally { duplicate.dispose(); released(duplicate); }
        f.owner.dispose(); assert.equal(result.input.operations[2].content, texts[2]);
    } finally { value.dispose(); released(value); dispose(f); }
});

test("invalid UTF-8 refuses the entire request and clears both copied and roundtrip bytes", () => {
    for (const bytes of [[0xff], [0xe4, 0xb8], [0xc0, 0x80], [0xed, 0xa0, 0x80]]) {
        const f = fixture([{ text: "safe" }, { bytes }]), value = converter();
        try {
            assert.throws(() => prepare(value, f.owner)); assert.equal(value.diagnostics.status, "rejected");
            assert.equal(value.diagnostics.copies, 2); assert.equal(value.diagnostics.roundtripBytes, 4);
            assert.throws(() => value.take()); assert.throws(() => prepare(value, f.owner));
            const duplicate = converter(); try { assert.throws(() => prepare(duplicate, f.owner), /already attempted/); } finally { duplicate.dispose(); released(duplicate); }
        } finally { value.dispose(); released(value); dispose(f); }
    }
});

test("invalid original snapshot or empty candidates are refused before byte copying", () => {
    for (const rows of [[], [{ operation: "modify", revision: "version_7", text: "x" }], [{ operation: "modify", revision: "x".repeat(27), text: "x" }]]) {
        const f = fixture(rows), value = converter();
        try { assert.throws(() => prepare(value, f.owner)); assert.equal(value.diagnostics.copies, 0); assert.throws(() => value.take()); }
        finally { value.dispose(); released(value); dispose(f); }
    }
});

test("fixed original methods reject spoofed captures and ignore replaced public accessors", () => {
    const f = fixture([{ text: "original", operation: "modify" }]), value = converter();
    try {
        for (const impostor of [{}, Object.create(CapturedCandidateOwner.prototype), new Proxy(f.owner, {})]) {
            const rejected = converter(); try { assert.throws(() => prepare(rejected, impostor)); assert.equal(rejected.diagnostics.copies, 0); }
            finally { rejected.dispose(); released(rejected); }
        }
        Object.defineProperty(f.owner, "binding", { get() { assert.fail("replaceable binding"); } });
        Object.defineProperty(f.owner, "records", { get() { assert.fail("replaceable records"); } });
        f.owner.copyBytes = () => { assert.fail("replaceable copy"); };
        prepare(value, f.owner); const result = value.take();
        assert.equal(result.input.operations[0].content, "original"); assert.equal(result.input.operations[0].snapshot, revision);
    } finally { value.dispose(); released(value); dispose(f); }
});

test("revocation before transfer drops the request; transfer does not turn data into authority", () => {
    for (const afterPrepare of [false, true]) {
        const f = fixture([{ text: "revoked" }]), value = converter();
        try {
            if (afterPrepare) prepare(value, f.owner);
            f.owner.revoke();
            if (afterPrepare) assert.throws(() => value.take()); else assert.throws(() => prepare(value, f.owner));
            assert.equal(value.diagnostics.status, "rejected"); assert.throws(() => value.take());
        } finally { value.dispose(); released(value); dispose(f); }
    }
});

function weakFixture() {
    const f = fixture([{ text: "weak" }]), value = converter();
    try { prepare(value, f.owner); return { weak: new WeakRef(f.owner), value }; }
    finally { value.dispose(); released(value); dispose(f); }
}
test("consumed-owner tracking does not retain a disposed capture", async () => {
    assert.equal(typeof globalThis.gc, "function");
    const { weak, value } = weakFixture();
    for (let round = 0; round < 4; round++) { await tick(); globalThis.gc(); await tick(); }
    assert.equal(weak.deref(), undefined); assert.equal(value.diagnostics.retainedCandidate, false);
    console.log(JSON.stringify({ gcRounds: 4, originalCaptureTargets: 1, liveTargets: 0, converterStillLive: true }));
});
