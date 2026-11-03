// Explicit write-snapshot preflight only. No installed host-write or Sandbox execution claim.
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, realpath, open, lstat, unlink, rmdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { Value } from "typebox/value";
import { WriteParameters, NativeWriteParameters } from "../packages/coding-agent/src/core/files/file-parameters.ts";
import { copyBatchInput } from "../packages/coding-agent/src/core/files/file-batch-protocol.ts";
import { FileService } from "../packages/coding-agent/src/core/files/file-service.ts";
import { mutationRequestHash } from "../packages/coding-agent/src/core/files/file-invocation.ts";
import { FileBatch } from "../packages/coding-agent/src/core/files/file-batch.ts";
import { issueSnapshotForRead } from "../packages/coding-agent/src/core/files/snapshot-line-edit.ts";
import { NATIVE_FILE_REVISION } from "../packages/coding-agent/src/core/files/file-host.ts";
import { nativeFileDiagnostics } from "../packages/coding-agent/src/core/files/native-file-client.ts";
import { collectChanges } from "../packages/coding-agent/src/core/files/changes.ts";

const sessionId = "explicit_write_snapshot";
const identity = value => ({ dev: value.dev, ino: value.ino });
const same = (a, b) => a.dev === b.dev && a.ino === b.ino;
const loggedIdentity = value => value ? { dev: String(value.dev), ino: String(value.ino) } : null;

// Synthetic history only: no filesystem observation, permission or mutation receipt issuance.
function recoveryChecks(snapshot) {
    let calls = 0, entries = 0, bytes = 0, bound = 0, rejected = 0;
    const cwd = resolve("."), target = resolve("recovery-only", "source.txt"), postimage = "c".repeat(64);
    function check(batch, recordedInput, restoredInput, expected) {
        assert.ok(calls < 11); calls++;
        const name = batch ? "file_batch" : "write", callId = `recovery${calls}`, itemId = `${callId}:0`;
        const wrap = input => batch ? { operations: [{ operation: "write", mode: "overwrite", ...input }] } : input;
        const original = wrap(recordedInput), restored = wrap(restoredInput);
        const requestHash = mutationRequestHash(name, original);
        const base = { toolCallId: callId, itemId, operation: "write", target };
        const timestamp = "2026-11-02T00:00:00.000Z";
        const progress = (id, data) => ({ id, timestamp, type: "custom", customType: "file-mutation-progress-v2", data });
        const branch = [
            { id: `${callId}-request`, timestamp, type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: callId, name, arguments: restored }] } },
            progress(`${callId}-origin`, batch
                ? { phase: "prepared", toolCallId: callId, requestHash, items: [{ itemId, operation: "write", target }] }
                : { ...base, phase: "origin", requestHash }),
            progress(`${callId}-intent`, { ...base, phase: "intent", requestHash }),
            progress(`${callId}-result`, { ...base, phase: "result", mutationReceiptVersion: 2, status: "succeeded", stateChanged: true, sha256: postimage }),
        ];
        const size = Buffer.byteLength(JSON.stringify(branch)); assert.ok(size <= 4096);
        entries += branch.length; bytes += size;
        const records = collectChanges(branch, cwd); assert.equal(records.length, 1);
        const record = records[0];
        assert.equal(record.entryId, `${callId}-result`); assert.equal(record.target, target);
        if (expected) {
            bound++;
            assert.equal(record.requestEntryId, `${callId}-request`);
            assert.equal(record.original, batch ? restored.operations[0] : restored);
            assert.equal(record.postimage, postimage); assert.equal(record.unavailable, undefined);
        } else {
            rejected++;
            assert.equal(record.requestEntryId, undefined); assert.equal(record.original, undefined);
            assert.equal(record.postimage, undefined); assert.equal(typeof record.unavailable, "string");
        }
    }
    const legacy = { path: "source.txt", content: "next" }, explicit = { ...legacy, snapshot };
    for (const batch of [false, true]) {
        check(batch, explicit, explicit, true);
        check(batch, explicit, { ...explicit, snapshot: "snap_" + "b".repeat(22) }, false);
        check(batch, explicit, legacy, false);
        check(batch, legacy, legacy, true);
        const invalid = { ...legacy, snapshot: "latest" };
        check(batch, invalid, invalid, false); // Matching hash cannot authorize an invalid schema.
    }
    const invalidCreate = { ...explicit, mode: "create" };
    check(true, invalidCreate, invalidCreate, false);
    console.log(JSON.stringify({ recoveryModel: true, calls, entries, bytes, bound, rejected, filesystemOperations: 0 }));
    assert.equal(calls, 11); assert.equal(entries, 44); assert.ok(bytes <= 45056);
    assert.equal(bound, 4); assert.equal(rejected, 7);
}

test("explicit write snapshot schema, original-version preflight and create refusal", async () => {
    const synthetic = "snap_" + "a".repeat(22);
    assert.equal(Value.Check(NativeWriteParameters, { path: "source.txt", content: "next", snapshot: synthetic }), true);
    assert.equal(Value.Check(WriteParameters, { path: "source.txt", content: "next", snapshot: synthetic }), false);
    for (const snapshot of ["", "latest", synthetic + "x", null, 1]) {
        assert.equal(Value.Check(NativeWriteParameters, { path: "source.txt", content: "next", snapshot }), false);
        assert.throws(() => copyBatchInput({ operations: [{ operation: "write", mode: "overwrite", path: "source.txt", content: "next", snapshot }] }, true));
    }
    assert.throws(() => copyBatchInput({ operations: [{ operation: "write", mode: "create", path: "new.txt", content: "next", snapshot: synthetic }] }, true));
    assert.throws(() => copyBatchInput({ operations: [{ operation: "write", mode: "overwrite", path: "source.txt", content: "next", snapshot: synthetic, destination: "bad" }] }, true));
    const hashInput = { path: "source.txt", content: "next", snapshot: synthetic };
    assert.equal(mutationRequestHash("write", { path: "source.txt", content: "next" }), "80b5943cd8c85e39d1f9476c908dcdcb09e7a5a814c8cc41401d7ae760392df7");
    const originalHash = mutationRequestHash("write", hashInput);
    assert.notEqual(originalHash, mutationRequestHash("write", { ...hashInput, snapshot: "snap_" + "b".repeat(22) }));
    assert.notEqual(originalHash, mutationRequestHash("write", { path: "source.txt", content: "next" }));
    const batchHash = mutationRequestHash("file_batch", { operations: [{ operation: "write", mode: "overwrite", ...hashInput }] });
    assert.notEqual(batchHash, mutationRequestHash("file_batch", { operations: [{ operation: "write", mode: "overwrite", ...hashInput, snapshot: "snap_" + "b".repeat(22) }] }));
    const original = { operations: [{ operation: "write", mode: "overwrite", path: "source.txt", content: "next", snapshot: synthetic }] };
    assert.throws(() => copyBatchInput(original), /TOOL_ARGS_INVALID/);
    assert.throws(() => copyBatchInput({ operations: [{ operation: "write", mode: "overwrite", path: "source.txt", content: "next", snapshot: undefined }] }), /TOOL_ARGS_INVALID/);
    const copied = copyBatchInput(original, true); original.operations[0].snapshot = "snap_" + "b".repeat(22);
    assert.equal(copied.operations[0].snapshot, synthetic); assert.ok(Object.isFrozen(copied.operations[0]));
    assert.equal(copyBatchInput({ operations: [{ operation: "write", mode: "create", path: "new.txt", content: "x" }] }).operations[0].snapshot, undefined);

    recoveryChecks(synthetic);

    let parent, root, leaf, service, handle, safe = true;
    const nodes = [], errors = [], plans = [], batches = [];
    let fixtureOpen = 0, fixtureCloseAttempts = 0, fixtureClosed = 0, fixtureWriteBytes = 0;
    let captures = 0, receiptBytes = 0, prepares = 0, latestCalls = 0, releasedPlans = 0;
    const beforeWorker = nativeFileDiagnostics();
    async function record(path, kind, outer, stat) {
        const node = { path, kind, parent: outer, identity: undefined, removed: false }; nodes.push(node);
        node.identity = identity(stat ? await stat() : await lstat(path, { bigint: true }));
        console.log(JSON.stringify({ created: path, kind, identity: loggedIdentity(node.identity) })); return node;
    }
    async function closeFixture() {
        if (!handle) return;
        fixtureCloseAttempts++;
        try { await handle.close(); fixtureClosed++; handle = undefined; }
        catch (error) { safe = false; errors.push(error); throw error; }
    }
    async function capture(text) {
        assert.ok(captures < 3); captures++; receiptBytes += Buffer.byteLength(text);
        const result = { content: [{ type: "text", text }] };
        await issueSnapshotForRead(sessionId, root, { path: "source.txt" }, result, service.revisions);
        const id = result[NATIVE_FILE_REVISION]; assert.match(id, /^snap_[A-Za-z0-9_-]{22}$/);
        assert.equal(service.revisions.get(id).bytes.toString(), text); return id;
    }
    async function prepare(input, mode) {
        assert.ok(prepares < 12); prepares++;
        const plan = await service.prepare("write", input, undefined, mode); plans.push(plan); return plan;
    }
    function release(plan) {
        service.release(plan); releasedPlans++;
        const index = plans.indexOf(plan); assert.ok(index >= 0); plans.splice(index, 1);
        if (plan.snapshot) assert.equal(plan.snapshot.byteEdits.length, 0);
    }
    let succeeded = false;
    try {
        parent = await realpath(tmpdir()); root = await mkdtemp(join(parent, "sp-explicit-snapshot-"));
        await record(root, "directory", parent);
        leaf = join(root, "source.txt"); handle = await open(leaf, "wx"); fixtureOpen++;
        try {
            await record(leaf, "file", root, () => handle.stat({ bigint: true }));
            await handle.writeFile("alpha"); fixtureWriteBytes += 5;
        } finally { await closeFixture(); }
        service = new FileService(root, sessionId);
        const latest = service.revisions.latest;
        service.revisions.latest = function(path) { latestCalls++; return latest.call(this, path); };
        const old = await capture("alpha");
        handle = await open(leaf, "r+"); fixtureOpen++;
        try {
            assert.ok(same(await handle.stat({ bigint: true }), nodes[1].identity));
            await handle.truncate(0); await handle.writeFile("beta"); fixtureWriteBytes += 4;
        } finally { await closeFixture(); }
        const newest = await capture("beta");
        assert.notEqual(newest, old); assert.equal(latest.call(service.revisions, leaf), newest);
        await assert.rejects(prepare({ path: "source.txt", content: "after", snapshot: old }), /SNAPSHOT_EDIT_STALE/);
        assert.equal(latestCalls, 0); assert.equal(service.revisions.get(old), undefined);
        await assert.rejects(prepare({ path: "source.txt", content: "after", snapshot: old }), /SNAPSHOT_EDIT_UNKNOWN/);
        assert.equal(latestCalls, 0);
        const explicit = await prepare({ path: "source.txt", content: "after", snapshot: newest });
        assert.equal(explicit.snapshot.snapshotId, newest); assert.equal(explicit.snapshot.receipt, service.revisions.get(newest));
        assert.equal(latestCalls, 0); release(explicit);
        const legacy = await prepare({ path: "source.txt", content: "after" });
        assert.equal(legacy.snapshot.snapshotId, newest); assert.equal(latestCalls, 1); release(legacy);
        await assert.rejects(prepare({ path: "missing.txt", content: "after", snapshot: newest }), /SNAPSHOT_EDIT_STALE/);
        await assert.rejects(prepare({ path: "missing.txt", content: "after", snapshot: newest }, "create"), /TOOL_ARGS_INVALID/);
        const addition = await prepare({ path: "missing.txt", content: "after" }, "create");
        assert.ok(addition.creation); release(addition);
        const batch = new FileBatch(service, "explicit-original-batch", { operations: [
            { operation: "write", mode: "create", path: "missing.txt", content: "new" },
            { operation: "write", mode: "overwrite", path: "source.txt", content: "after", snapshot: old },
        ] }); batches.push(batch);
        await assert.rejects(batch.prepare(), /SNAPSHOT_EDIT_UNKNOWN/);
        assert.equal(batch.items.length, 0); assert.equal(latestCalls, 1);
        await assert.rejects(lstat(join(root, "missing.txt")), { code: "ENOENT" });
        const finalBytes = await readFile(leaf);
        try { assert.equal(finalBytes.toString(), "beta"); } finally { finalBytes.fill(0); }
        succeeded = true;
    } catch (error) { errors.push(error); }
    finally {
        if (handle) safe = false; // Preserve original close uncertainty; never retry.
        for (const batch of batches) batch.release();
        for (const plan of plans) service?.release(plan);
        service?.dispose();
        if (safe) for (let index = nodes.length - 1; index >= 0; index--) {
            const node = nodes[index];
            try {
                assert.ok(node.identity);
                const current = await lstat(node.path, { bigint: true });
                assert.ok(same(current, node.identity) && !current.isSymbolicLink());
                assert.equal(node.kind === "file" ? current.isFile() : current.isDirectory(), true);
                assert.equal(dirname(resolve(node.path)), node.parent); assert.equal(await realpath(node.path), node.path);
                if (index > 0) {
                    const outer = await lstat(nodes[0].path, { bigint: true });
                    assert.ok(same(outer, nodes[0].identity) && outer.isDirectory() && !outer.isSymbolicLink());
                }
                if (node.kind === "file") await unlink(node.path); else await rmdir(node.path);
                node.removed = true; await assert.rejects(lstat(node.path), { code: "ENOENT" });
            } catch (error) { errors.push(error); safe = false; break; }
        }
    }
    const worker = nativeFileDiagnostics();
    console.log(JSON.stringify({ succeeded, safe, nodes: nodes.map(node => ({ ...node, identity: loggedIdentity(node.identity) })),
        fixtureOpen, fixtureCloseAttempts, fixtureClosed, fixtureWriteBytes, retainedFixtureHandle: !!handle,
        captures, receiptBytes, prepares, latestCalls, releasedPlans, remainingRevisions: service?.revisions.size,
        executionMethodsRequested: 0, finalTargetsVerified: succeeded, workerStartsDelta: worker.workerStarts - beforeWorker.workerStarts,
        workerCallsDelta: worker.calls - beforeWorker.calls, workerPending: worker.pending,
        implicitNodeOsIoFullyInstrumented: false, errors: errors.map(error => String(error).slice(0, 640)) }));
    if (errors.length) throw new AggregateError(errors, "explicit snapshot preflight or cleanup");
    assert.ok(succeeded && safe && nodes.length === 2 && nodes.every(node => node.removed));
    assert.equal(captures, 2); assert.equal(receiptBytes, 9); assert.equal(prepares, 7);
    assert.equal(fixtureOpen, 2); assert.equal(fixtureCloseAttempts, 2); assert.equal(fixtureClosed, 2);
    assert.equal(fixtureWriteBytes, 9); assert.equal(latestCalls, 1); assert.equal(releasedPlans, 3);
    assert.equal(service.revisions.size, 0); assert.equal(worker.workerStarts - beforeWorker.workerStarts, 0);
    assert.equal(worker.calls - beforeWorker.calls, 0); assert.equal(worker.pending, 0);
});
