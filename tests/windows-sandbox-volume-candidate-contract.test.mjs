import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { CANDIDATE_PROTOCOL, CANDIDATE_LIMITS } from "../scripts/acceptance/windows-sandbox-candidates.mjs";
import { CapturedCandidateOwner, CAPTURE_PROTOCOL, REQUEST_PROTOCOL, CAPTURE_LIMITS } from "../scripts/acceptance/windows-sandbox-volume-candidate-contract.mjs";
const taskId = "11111111-2222-3333-4444-555555555555", snapshotId = "22222222-3333-4444-5555-666666666666", instanceId = "33333333-4444-5555-6666-777777777777";
const volumePath = "\\\\?\\Volume{aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee}\\", exchangeId = "AABBCCDD:0000000000000001";
const manifestId = "AABBCCDD:0000000000000002", manifestCarrier = "11223344:0000000000000001", batchCarrier = "11223344:0000000000000002";
const hash = bytes => createHash("sha256").update(bytes).digest("hex"), encode = value => Buffer.from(JSON.stringify(value));
function context(paths = ["a.txt"], operation = "add") {
    return { taskId, snapshotId, instanceId, volumePath, exchangeId, budget: { ...CANDIDATE_LIMITS },
        allowed: paths.map(path => ({ path, operation, revision: operation === "add" ? null : "version_7" })) };
}
function sample(host = context(), chunks = host.allowed.map(() => Buffer.from("abc")), reportExit = 23) {
    const raw = encode({ protocol: CANDIDATE_PROTOCOL, taskId, snapshotId,
        candidates: host.allowed.map(({ path, operation }) => ({ path, operation })), report: { exitCode: reportExit } });
    const manifest = { protocol: CAPTURE_PROTOCOL, stage: "manifest", taskId, volumePath, exchangeId, carrierId: manifestCarrier,
        bytes: raw.length, sha256: hash(raw), sourceId: manifestId, handles: { opened: 3, closed: 3, peak: 2, closeUnknown: false, retained: [] } };
    const payload = Buffer.concat(chunks), request = encode({ protocol: REQUEST_PROTOCOL, taskId, manifestSha256: hash(raw), paths: host.allowed.map(item => item.path) });
    const batch = { protocol: CAPTURE_PROTOCOL, stage: "batch", taskId, volumePath, exchangeId, carrierId: batchCarrier,
        bytes: payload.length, sha256: hash(payload), requestSha256: hash(request),
        items: chunks.map((bytes, index) => ["AABBCCDD:" + BigInt(index + 3).toString(16).toUpperCase().padStart(16, "0"), bytes.length, hash(bytes)]),
        handles: { opened: 2 + host.allowed.reduce((sum, item) => sum + item.path.split("/").length + 2, 0),
            closed: 2 + host.allowed.reduce((sum, item) => sum + item.path.split("/").length + 2, 0),
            peak: Math.max(1, ...host.allowed.map(item => item.path.split("/").length + 3)), closeUnknown: false, retained: [] } };
    return { host, raw, manifest, payload, batch, request, owner: new CapturedCandidateOwner(host) };
}
const prepare = s => s.owner.acceptManifest(s.raw, encode(s.manifest), manifestCarrier);
const finish = s => s.owner.acceptBatch(s.payload, encode(s.batch), batchCarrier);
function released(owner) {
    assert.equal(owner.diagnostics.retainedRequestBytes, 0); assert.equal(owner.diagnostics.retainedPayloadBytes, 0);
    assert.equal(owner.diagnostics.requestBackingBytes, 0); assert.equal(owner.diagnostics.payloadBackingBytes, 0);
    assert.equal(owner.diagnostics.retainedContext, false); assert.throws(() => owner.copyRequestBytes()); assert.throws(() => owner.copyBytes(0));
}
test("capture contract binds host authority and copies private bytes without declaring runtime success", () => {
    const s = sample(context(["a.txt", "dir/b.txt"], "modify"), [Buffer.from("abc"), Buffer.alloc(0)]);
    // A caller-controlled, offset view makes whole-backing mutation safe for this isolated fixture.
    const inputBacking = new ArrayBuffer(128), input = Buffer.from(inputBacking, 17, s.payload.length);
    input.set(s.payload); s.payload = input;
    const ready = prepare(s); assert.equal(ready.status, "request-ready"); assert.equal(ready.requestSha256, hash(s.request));
    const request = s.owner.copyRequestBytes(); assert.deepEqual(request, s.request);
    const anotherRequest = s.owner.copyRequestBytes();
    assert.equal(request.byteOffset, 0); assert.equal(request.buffer.byteLength, request.length);
    assert.notEqual(request.buffer, anotherRequest.buffer); assert.notEqual(request.buffer, s.request.buffer);
    assert.equal(s.owner.diagnostics.requestBackingBytes, ready.bytes);
    assert.deepEqual(Object.keys(JSON.parse(request)), ["protocol", "taskId", "manifestSha256", "paths"]);
    assert.ok(!request.includes(Buffer.from("version_7"))); new Uint8Array(request.buffer).fill(0x78);
    assert.deepEqual(s.owner.copyRequestBytes(), s.request); assert.deepEqual(anotherRequest, s.request); anotherRequest.fill(0);
    s.host.allowed[0].revision = "replaced"; s.host.allowed[0].path = "elsewhere"; s.host.volumePath = "changed";
    const checked = finish(s); new Uint8Array(inputBacking).fill(0x78); s.raw.fill(0); s.batch.items[0][0] = "changed";
    assert.equal(checked.status, "candidate-data-checked"); assert.equal(checked.diagnostics.contractOnly, true);
    assert.equal(checked.records[0].sourceRevision, "version_7"); assert.equal(checked.records[0].path, "a.txt");
    assert.equal(checked.binding.volumePath, volumePath); assert.equal(checked.guestReport.source, "guest-report"); assert.equal(checked.guestReport.exitCode, 23);
    const copy = checked.copyBytes(0), anotherCopy = checked.copyBytes(0); assert.equal(copy.toString(), "abc");
    assert.equal(copy.byteOffset, 0); assert.equal(copy.buffer.byteLength, copy.length);
    assert.notEqual(copy.buffer, anotherCopy.buffer); assert.notEqual(copy.buffer, inputBacking);
    assert.equal(checked.diagnostics.payloadBackingBytes, 3); new Uint8Array(copy.buffer).fill(0x78);
    assert.equal(anotherCopy.toString(), "abc"); anotherCopy.fill(0);
    assert.equal(checked.copyBytes(0).toString(), "abc"); assert.equal(checked.copyBytes(1).length, 0);
    assert.equal(checked.diagnostics.payloadCopies, 1); assert.equal(checked.diagnostics.retainedRequestBytes, 0);
    checked.revoke(); released(checked); checked.dispose(); checked.dispose(); assert.equal(checked.status, "disposed");
});
test("empty capture batch and zero-length files have exact digest and length semantics", () => {
    for (const paths of [[], ["empty.txt"]]) {
        const s = sample(context(paths), paths.map(() => Buffer.alloc(0)), 0); prepare(s); finish(s);
        assert.equal(s.owner.records.length, paths.length); assert.equal(s.owner.diagnostics.retainedPayloadBytes, 0);
        assert.equal(s.batch.sha256, hash(Buffer.alloc(0))); s.owner.dispose(); released(s.owner);
    }
});
test("maximum ASCII paths, private revisions and payload fit unchanged request and receipt bounds", t => {
    const paths = Array.from({ length: 16 }, (_, index) => "a".repeat(29) + "/" + "b".repeat(29) + "/" + "c".repeat(29) + "/" + "d".repeat(28) + index.toString(16).padStart(2, "0"));
    assert.ok(paths.every(path => path.length === 120));
    const host = context(paths, "modify"); for (const item of host.allowed) item.revision = "r".repeat(128);
    const s = sample(host, paths.map((_, index) => Buffer.alloc(1024, index))); prepare(s); finish(s);
    assert.equal(s.owner.records.length, 16); assert.equal(s.owner.diagnostics.retainedPayloadBytes, 16384);
    assert.equal(s.batch.handles.opened, 98); assert.equal(s.batch.handles.peak, 7);
    for (const bytes of [s.request, encode(s.manifest), encode(s.batch)]) assert.ok(bytes.length <= 4096);
    t.diagnostic(JSON.stringify({ requestBytes: s.request.length, manifestReceiptBytes: encode(s.manifest).length,
        batchReceiptBytes: encode(s.batch).length, manifestBytes: s.raw.length, payloadBytes: s.payload.length,
        nativeOperations: 0, maximumPlannedBatchBusinessHandles: 98, maximumPlannedPeak: 7 }));
    s.owner.dispose(); released(s.owner);
});
test("capture authority rejects aliases, protected paths, conflicting targets and forged authority fields", () => {
    for (const path of [".git/config", ".sp/state", "dir/../x", "x\\y", "con.txt", "a.", "a:b", "/x", "a//b", "x".repeat(65), "x/aux"]) assert.throws(() => new CapturedCandidateOwner(context([path])));
    for (const paths of [["A.txt", "a.txt"], ["a", "a/b"]]) assert.throws(() => new CapturedCandidateOwner(context(paths)));
    for (const mutate of [
        h => h.volumePath = "D:\\ordinary\\",
        h => h.exchangeId = { toString: () => exchangeId },
        h => h.allowed[0].revision = "guest",
        h => h.budget.entries = 17,
        h => h.allowed[0].authorized = true,
        h => h.lifecycle = { closed: true },
    ]) { const host = context(); mutate(host); assert.throws(() => new CapturedCandidateOwner(host)); }
});
test("manifest canonical form, host association and permitted operation remain strict", () => {
    const mutators = [
        value => value.snapshotId = instanceId,
        value => value.taskId = instanceId,
        value => value.authorized = true,
        value => value.report.authorized = true,
        value => value.report.exitCode = 1.5,
        value => value.candidates[0].operation = "modify",
        value => value.candidates[0].path = "unallowed.txt",
        value => value.candidates.push({ ...value.candidates[0] }),
    ];
    for (const mutate of mutators) {
        const s = sample(), value = JSON.parse(s.raw); mutate(value); s.raw = encode(value); s.manifest.bytes = s.raw.length; s.manifest.sha256 = hash(s.raw);
        assert.throws(() => prepare(s)); assert.equal(s.owner.status, "rejected"); released(s.owner);
    }
    for (const modify of [raw => Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), raw]), raw => Buffer.concat([raw, Buffer.from("\n")]), raw => Buffer.from(raw.toString().replace('"report":', '"report":{"exitCode":0},"report":'))]) {
        const s = sample(); s.raw = modify(s.raw); s.manifest.bytes = s.raw.length; s.manifest.sha256 = hash(s.raw);
        assert.throws(() => prepare(s)); released(s.owner);
    }
});
test("manifest capture rejects altered bytes, source/carrier identity, unknown closure and extra receipt fields", () => {
    for (const mutate of [
        s => s.raw[0] ^= 1,
        s => s.manifest.sourceId = exchangeId,
        s => s.manifest.sourceId = "FFFFFFFF:0000000000000002",
        s => s.manifest.carrierId = batchCarrier,
        s => s.manifest.taskId = instanceId,
        s => s.manifest.handles.closed = 2,
        s => s.manifest.handles.closeUnknown = true,
        s => s.manifest.handles.retained.push(["file", "12", null]),
        s => s.manifest.handles.peak = 3,
        s => s.manifest.extra = true,
    ]) { const s = sample(); mutate(s); assert.throws(() => prepare(s)); released(s.owner); }
});
test("batch association, ordered item identities, digest and byte boundaries reject without partial candidates", () => {
    for (const mutate of [
        s => s.batch.requestSha256 = "0".repeat(64),
        s => s.batch.carrierId = manifestCarrier,
        s => s.batch.items[0][0] = manifestId,
        s => s.batch.items[0][0] = exchangeId,
        s => s.batch.items[0][0] = "FFFFFFFF:0000000000000003",
        s => s.batch.items[1][0] = s.batch.items[0][0],
        s => s.batch.items.reverse(),
        s => s.batch.items.pop(),
        s => s.batch.items[0][1] = 4097,
        s => s.batch.items[0][1] = -1,
        s => s.batch.items[0][2] = "0".repeat(64),
        s => s.batch.bytes++,
        s => s.payload[0] ^= 1,
        s => s.batch.handles.closed--,
        s => s.batch.handles.closeUnknown = true,
        s => s.batch.handles.opened = s.batch.handles.closed = 99,
        s => s.batch.handles.peak = 8,
        s => s.batch.authorized = true,
    ]) {
        const s = sample(context(["a.txt", "b.txt"]), [Buffer.from("abc"), Buffer.from("defg")]); prepare(s); mutate(s);
        assert.throws(() => finish(s)); assert.equal(s.owner.status, "rejected"); released(s.owner);
    }
    const trailing = sample(); prepare(trailing); trailing.payload = Buffer.concat([trailing.payload, Buffer.from("x")]);
    trailing.batch.bytes = trailing.payload.length; trailing.batch.sha256 = hash(trailing.payload);
    assert.throws(() => finish(trailing)); released(trailing.owner);
});
test("input bounds and malformed receipt encoding clear internal state", () => {
    for (const stage of ["manifest", "batch"]) for (const mode of ["oversize-receipt", "duplicate-key", "invalid-utf8", "bom", "oversize-data"]) {
        const s = sample(); if (stage === "batch") prepare(s);
        const value = stage === "manifest" ? s.manifest : s.batch;
        let receipt = encode(value), data = stage === "manifest" ? s.raw : s.payload;
        if (mode === "oversize-receipt") receipt = Buffer.alloc(CAPTURE_LIMITS.receiptBytes + 1);
        if (mode === "duplicate-key") receipt = Buffer.from(receipt.toString().replace('"taskId":', '"taskId":"wrong","taskId":'));
        if (mode === "invalid-utf8") receipt = Buffer.from([0xff]);
        if (mode === "bom") receipt = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), receipt]);
        if (mode === "oversize-data") data = Buffer.alloc((stage === "manifest" ? 4096 : 16384) + 1);
        assert.throws(() => stage === "manifest" ? s.owner.acceptManifest(data, receipt, manifestCarrier) : s.owner.acceptBatch(data, receipt, batchCarrier));
        released(s.owner);
    }
});
test("single-use stages and revocation prevent further reads while existing caller copies stay caller-owned", () => {
    const before = sample(); before.owner.revoke(); assert.throws(() => prepare(before)); released(before.owner);
    const during = sample(); prepare(during); const request = during.owner.copyRequestBytes(); during.owner.revoke();
    assert.throws(() => finish(during)); released(during.owner); assert.ok(request.length > 0); request.fill(0);
    const s = sample(); prepare(s); assert.throws(() => prepare(s)); finish(s);
    assert.throws(() => finish(s)); const bytes = s.owner.copyBytes(0); s.owner.revoke(); released(s.owner);
    assert.equal(bytes.toString(), "abc"); assert.equal(bytes.buffer.byteLength, bytes.length);
    new Uint8Array(bytes.buffer).fill(0); s.owner.dispose(); released(s.owner);
});
