import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { createHash } from "node:crypto";
import { PrivateCandidateChannel, nativePrivateIdentity } from "../scripts/acceptance/windows-sandbox-volume-candidate-private.mjs";
import { CapturedCandidateOwner } from "../scripts/acceptance/windows-sandbox-volume-candidate-contract.mjs";
import { CANDIDATE_PROTOCOL, CANDIDATE_LIMITS } from "../scripts/acceptance/windows-sandbox-candidates.mjs";
import { TaskVolumeOwner } from "../scripts/acceptance/windows-sandbox-volume.mjs";
import { SandboxLifecycle } from "../scripts/acceptance/windows-sandbox-lifecycle.mjs";
import { LiveSandboxRuntime, experimentalGuidConfig } from "../scripts/acceptance/windows-sandbox-volume-sharing.mjs";
const taskId = "11111111-2222-3333-4444-555555555555", snapshotId = "22222222-3333-4444-5555-666666666666";
const instanceId = "33333333-4444-5555-6666-777777777777", root = "D:\\private-test-root";
const volumePath = "\\\\?\\Volume{aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee}\\", exchangeId = "11223344:0000000000000001";
const hostDev = 0xaabbccddn, rootId = "AABBCCDD:0000000000000100";
const hash = bytes => createHash("sha256").update(bytes).digest("hex"), encode = value => Buffer.from(JSON.stringify(value));
const empty = bytes => bytes.every(value => value === 0);
function stat(node) {
    return { dev: node.dev, ino: node.ino, nlink: node.links ?? 1n, size: node.size ?? BigInt(node.bytes?.length ?? 0),
        mtimeNs: node.time ?? 1n, ctimeNs: node.time ?? 1n,
        isFile: () => !node.directory, isDirectory: () => !!node.directory, isSymbolicLink: () => !!node.link };
}
function fixture({ payload = Buffer.from("abc"), owner = {}, vm = { taskId, id: instanceId } } = {}) {
    const context = { owner, vm, taskId, root, rootId, volumePath, exchangeId };
    const authority = { taskId, snapshotId, instanceId: vm.id, volumePath, exchangeId,
        budget: { ...CANDIDATE_LIMITS }, allowed: [{ path: "a.txt", operation: "add", revision: null }] };
    const rootNode = { dev: hostDev, ino: 0x100n, directory: true }, files = new Map(), descriptors = new Map();
    const state = { calls: [], reads: [], writes: [], before: undefined, after: undefined, nextFd: 16, cancelled: false, validations: 0, admits: 0 };
    function add(name, ino, bytes) { const node = { name, dev: hostDev, ino, bytes }; files.set(name, node); return node; }
    const manifest = encode({ protocol: CANDIDATE_PROTOCOL, taskId, snapshotId, candidates: [{ path: "a.txt", operation: "add" }], report: { exitCode: 23 } });
    add("candidate-manifest.bin", 0x202n, manifest); add("candidate-payload.bin", 0x204n, payload);
    function receipt(stage, node, requestSha) {
        const value = { protocol: "super-pi-candidate-capture-v1", stage, taskId, volumePath, exchangeId,
            carrierId: nativePrivateIdentity(stat(node)), bytes: node.bytes.length, sha256: hash(node.bytes),
            handles: { opened: stage === "manifest" ? 3 : 5, closed: stage === "manifest" ? 3 : 5,
                peak: stage === "manifest" ? 2 : 4, closeUnknown: false, retained: [] } };
        if (stage === "manifest") value.sourceId = "11223344:0000000000000002";
        else { value.requestSha256 = requestSha; value.items = [["11223344:0000000000000003", node.bytes.length, hash(node.bytes)]]; }
        return encode(value);
    }
    add("candidate-manifest-receipt.json", 0x201n, receipt("manifest", files.get("candidate-manifest.bin")));
    add("candidate-batch-receipt.json", 0x203n, Buffer.from("pending"));
    function fileNode(file) {
        assert.equal(path.win32.dirname(file), root); const name = path.win32.basename(file), node = files.get(name);
        if (!node) throw Object.assign(Error("missing leaf"), { code: "ENOENT" });
        return node;
    }
    const raw = {
        lstatSync(file, options) { assert.equal(options.bigint, true); return stat(file === root ? rootNode : fileNode(file)); },
        realpathSync(file) { assert.ok(file === root || path.win32.dirname(file) === root); return file; },
        openSync(file, flags, mode) {
            assert.equal(path.win32.dirname(file), root); const name = path.win32.basename(file);
            let node;
            if (flags === "wx") {
                assert.equal(name, "candidate-request.json"); assert.equal(mode, 0o600);
                if (files.has(name)) throw Object.assign(Error("exists"), { code: "EEXIST" });
                node = add(name, 0x205n, Buffer.alloc(0));
            } else { assert.equal(flags, "r"); node = fileNode(file); }
            const fd = state.nextFd++; descriptors.set(fd, node); return fd;
        },
        fstatSync(fd, options) { assert.equal(options.bigint, true); assert.ok(descriptors.has(fd)); return stat(descriptors.get(fd)); },
        readSync(fd, bytes, offset, length, position) {
            assert.equal(offset, 0); assert.equal(position, 0); assert.ok(descriptors.has(fd));
            state.reads.push(bytes); return descriptors.get(fd).bytes.copy(bytes, offset, position, position + length);
        },
        writeSync(fd, bytes, offset, length, position) {
            assert.equal(offset, 0); assert.equal(position, 0); const node = descriptors.get(fd); assert.ok(node);
            assert.equal(node.name, "candidate-request.json"); state.writes.push(bytes); node.bytes = Buffer.from(bytes.subarray(0, length));
            node.time = 2n; return length;
        },
        fsyncSync(fd) { assert.ok(descriptors.has(fd)); },
        closeSync(fd) { assert.ok(descriptors.delete(fd)); },
    };
    const io = {};
    for (const [name, fn] of Object.entries(raw)) io[name] = (...args) => {
        state.calls.push({ name, target: args[0] }); state.before?.(name, args);
        const result = fn(...args); return state.after ? state.after(name, args, result) : result;
    };
    const adapter = new PrivateCandidateChannel(context, io), api = adapter.interface;
    let active, admitted;
    function operation(stage, request, overrides = {}) {
        active = Object.freeze({ stage, taskId, instanceId: vm.id, volumePath, exchangeId,
            maximumBytes: stage === "readBatch" ? 16384 : 4096, receiptBytes: 4096, ...overrides }); admitted = false;
        const admit = ticket => { assert.equal(ticket, active); assert.equal(admitted, false); admitted = true; state.admits++; return true; };
        const validate = ticket => { assert.equal(ticket, active); assert.equal(admitted, true); state.validations++;
            if (state.cancelled) throw Error("cancelled private lease"); return true; };
        return api[stage](active, admit, validate, request);
    }
    async function result(op) {
        const [outcome, settled] = await Promise.allSettled([op.outcome, op.settled]); active = undefined;
        assert.equal(settled.status, "fulfilled"); if (outcome.status === "rejected") throw outcome.reason; return outcome.value;
    }
    function updateBatch() {
        files.get("candidate-batch-receipt.json").bytes = receipt("batch", files.get("candidate-payload.bin"), hash(files.get("candidate-request.json").bytes));
    }
    async function prepareRequest() {
        const core = new CapturedCandidateOwner(authority), read = await result(operation("readManifest"));
        try { core.acceptManifest(read.bytes, read.receipt, read.carrierId); return { core, request: core.copyRequestBytes() }; }
        finally { read.bytes.fill(0); read.receipt.fill(0); }
    }
    function dispose() {
        adapter.dispose(); for (const node of files.values()) node.bytes.fill(0);
        files.clear(); assert.equal(descriptors.size, 0);
    }
    return { context, authority, rootNode, files, descriptors, state, io, adapter, api, operation, result, prepareRequest, updateBatch, dispose };
}
async function rejectValue(action) {
    let rejected = false, value;
    try { await action(); } catch (error) { rejected = true; value = error; }
    assert.equal(rejected, true); return value;
}
test("private Windows identity uses exact BigInt widths and rejects narrowing", () => {
    assert.equal(nativePrivateIdentity({ dev: 3938676073n, ino: 0x123456789abcdef0n }), "EAC36D69:123456789ABCDEF0");
    assert.equal(nativePrivateIdentity({ dev: 0xffffffffn, ino: 0xffffffffffffffffn }), "FFFFFFFF:FFFFFFFFFFFFFFFF");
    for (const value of [{ dev: -1n, ino: 1n }, { dev: 0x100000000n, ino: 1n }, { dev: 1n, ino: 0n },
        { dev: 1n, ino: 0x10000000000000000n }, { dev: 1, ino: 1n }, { dev: 1n, ino: 1 }]) assert.throws(() => nativePrivateIdentity(value), /width/);
});
test("fixed private bytes pass the actual core with five descriptors, 64 calls and released references", async () => {
    const f = fixture(), { core, request } = await f.prepareRequest();
    try {
        const written = await f.result(f.operation("writeRequest", request)); assert.equal(written.sha256, hash(request));
        assert.equal(written.bytes, request.length); request.fill(0); f.updateBatch();
        const batch = await f.result(f.operation("readBatch"));
        try { core.acceptBatch(batch.bytes, batch.receipt, batch.carrierId); assert.equal(core.copyBytes(0).toString(), "abc"); }
        finally { batch.bytes.fill(0); batch.receipt.fill(0); }
        assert.deepEqual(f.adapter.snapshot(), { opened: 5, closed: 5, peak: 1, activeHandles: 0, pending: false, uncertainHandles: [] });
        const d = f.adapter.diagnostics;
        assert.equal(d.calls, 64); assert.equal(d.calls, f.state.calls.length);
        assert.equal(d.allocatedBytes, d.clearedBytes + d.transferredBytes); assert.equal(d.retainedBuffers, 0);
        assert.equal(f.state.validations, 62); // 64 calls minus five unconditional closes, plus three final validations.
        assert.equal(f.state.reads.length, 4); assert.equal(f.state.writes.length, 1);
        for (const record of d.records) { assert.equal(record.closeAttempts, 1); assert.equal(record.closed, true); assert.equal(record.closeFailed, false); }
        const created = d.records.find(r => r.name === "candidate-request.json");
        assert.equal(created.created, true); assert.equal(created.flushed, true); assert.equal(created.id, "AABBCCDD:0000000000000205");
        const api = f.api; f.dispose(); assert.equal(api.owner, undefined); assert.equal(api.vm, undefined);
        assert.equal(f.adapter.diagnostics.contextHeld, false); assert.equal(f.adapter.diagnostics.filesystemHeld, false);
        assert.equal(f.adapter.diagnostics.records.length, 0);
    } finally { request.fill(0); core.dispose(); }
});
test("empty payload is accepted without a read, while empty manifest and receipt are rejected", async () => {
    const f = fixture({ payload: Buffer.alloc(0) }), { core, request } = await f.prepareRequest();
    await f.result(f.operation("writeRequest", request)); request.fill(0); f.updateBatch();
    const batch = await f.result(f.operation("readBatch"));
    try { core.acceptBatch(batch.bytes, batch.receipt, batch.carrierId); assert.equal(core.copyBytes(0).length, 0); }
    finally { batch.bytes.fill(0); batch.receipt.fill(0); core.dispose(); }
    assert.equal(f.adapter.diagnostics.calls, 63); assert.equal(f.state.reads.length, 3); f.dispose();
    for (const name of ["candidate-manifest.bin", "candidate-manifest-receipt.json"]) {
        const bad = fixture(); bad.files.get(name).bytes = Buffer.alloc(0);
        await assert.rejects(bad.result(bad.operation("readManifest")), /type\/link\/size/);
        assert.equal(bad.descriptors.size, 0); for (const bytes of bad.state.reads) assert.equal(empty(bytes), true); bad.dispose();
    }
});
test("receipt encoding remains raw so duplicate JSON fields are rejected by the core", async () => {
    const f = fixture(), node = f.files.get("candidate-manifest-receipt.json");
    node.bytes = Buffer.from(node.bytes.toString().replace('"stage":"manifest"', '"stage":"manifest","stage":"manifest"'));
    const original = Buffer.from(node.bytes), result = await f.result(f.operation("readManifest")), core = new CapturedCandidateOwner(f.authority);
    try {
        assert.deepEqual(result.receipt, original);
        assert.throws(() => core.acceptManifest(result.bytes, result.receipt, result.carrierId), /receipt JSON invalid/);
    } finally { original.fill(0); result.bytes.fill(0); result.receipt.fill(0); core.dispose(); f.dispose(); }
});
test("private root, leaf and same-descriptor changes fail without retry or partial transfer", async () => {
    for (const mode of ["root-id", "root-link", "root-path", "leaf-link", "links", "host-volume", "opened-id", "read-time", "after-path", "alias"]) {
        const f = fixture(), name = "candidate-manifest.bin", node = f.files.get(name);
        if (mode === "root-id") f.rootNode.ino++;
        if (mode === "root-link") f.rootNode.link = true;
        if (mode === "leaf-link") node.link = true;
        if (mode === "links") node.links = 2n;
        if (mode === "host-volume") node.dev = 0x11223344n;
        if (mode === "alias") node.ino = f.files.get("candidate-manifest-receipt.json").ino;
        f.state.after = (method, args, value) => {
            if (mode === "root-path" && method === "realpathSync" && args[0] === root) return "D:\\foreign-root";
            if (mode === "opened-id" && method === "fstatSync") return { ...value, ino: value.ino + 1n };
            if (mode === "read-time" && method === "readSync") f.descriptors.get(args[0]).time = 9n;
            if (mode === "after-path" && method === "realpathSync" && args[0].endsWith(name) && f.state.reads.length > 1) return root + "\\foreign.bin";
            return value;
        };
        await assert.rejects(f.result(f.operation("readManifest")));
        assert.equal(f.descriptors.size, 0); assert.equal(f.adapter.diagnostics.transferredBytes, 0);
        for (const bytes of f.state.reads) assert.equal(empty(bytes), true);
        const count = f.state.calls.length; await assert.rejects(f.result(f.operation("readManifest")), /stage admission/);
        assert.equal(f.state.calls.length, count); f.dispose();
    }
});
test("length checks precede allocation and one short read is never retried", async () => {
    for (const name of ["candidate-manifest.bin", "candidate-manifest-receipt.json"]) {
        const f = fixture(); f.files.get(name).size = 4097n;
        await assert.rejects(f.result(f.operation("readManifest")), /type\/link\/size/);
        assert.ok(f.adapter.diagnostics.allocatedBytes <= f.files.get("candidate-manifest-receipt.json").bytes.length);
        assert.equal(f.descriptors.size, 0); f.dispose();
    }
    const f = fixture(); f.state.after = (name, args, result) => name === "readSync" ? result - 1 : result;
    await assert.rejects(f.result(f.operation("readManifest")), /Short private carrier read/);
    assert.equal(f.state.reads.length, 1); assert.equal(f.adapter.diagnostics.records[0].closeAttempts, 1);
    assert.equal(empty(f.state.reads[0]), true); f.dispose();
});
test("all fixed leaf maxima are accepted and batch/request overflow stops before data access", async () => {
    // Raw adapter bounds only: arbitrary bytes here deliberately do not claim core JSON acceptance.
    const f = fixture({ payload: Buffer.alloc(16384, 7) });
    f.files.get("candidate-manifest.bin").bytes = Buffer.alloc(4096, 1);
    f.files.get("candidate-manifest-receipt.json").bytes = Buffer.alloc(4096, 2);
    f.files.get("candidate-batch-receipt.json").bytes = Buffer.alloc(4096, 3);
    const manifest = await f.result(f.operation("readManifest"));
    assert.equal(manifest.bytes.length, 4096); assert.equal(manifest.receipt.length, 4096);
    manifest.bytes.fill(0); manifest.receipt.fill(0);
    const request = Buffer.alloc(4096, 4); await f.result(f.operation("writeRequest", request)); request.fill(0);
    const batch = await f.result(f.operation("readBatch"));
    assert.equal(batch.bytes.length, 16384); assert.equal(batch.receipt.length, 4096);
    batch.bytes.fill(0); batch.receipt.fill(0);
    assert.equal(f.adapter.diagnostics.allocatedBytes, 28672); assert.equal(f.adapter.diagnostics.calls, 64); f.dispose();
    for (const name of ["candidate-batch-receipt.json", "candidate-payload.bin"]) {
        const bad = fixture(), prepared = await bad.prepareRequest();
        await bad.result(bad.operation("writeRequest", prepared.request)); bad.updateBatch();
        bad.files.get(name).size = name.endsWith(".json") ? 4097n : 16385n;
        const before = bad.state.reads.length;
        await assert.rejects(bad.result(bad.operation("readBatch")), /type\/link\/size/);
        assert.ok(bad.state.reads.length - before <= (name.endsWith(".json") ? 0 : 1));
        assert.equal(bad.descriptors.size, 0); prepared.request.fill(0); prepared.core.dispose(); bad.dispose();
    }
    for (const size of [0, 4097]) {
        const bad = fixture(), prepared = await bad.prepareRequest(), before = bad.state.calls.length;
        const request = Buffer.alloc(size);
        await assert.rejects(bad.result(bad.operation("writeRequest", request)), /request buffer bound/);
        assert.equal(bad.state.calls.length, before); assert.equal(bad.files.has("candidate-request.json"), false);
        request.fill(0); prepared.request.fill(0); prepared.core.dispose(); bad.dispose();
    }
});

test("request create, write, flush and close errors preserve exact independent facts and created leaves", async () => {
    for (const mode of ["exists", "write", "short-write", "flush", "close", "write-close", "flush-close", "falsy-both"]) {
        const f = fixture(), { core, request } = await f.prepareRequest();
        if (mode === "exists") f.files.set("candidate-request.json", { name: "candidate-request.json", dev: hostDev, ino: 0x205n, bytes: Buffer.from("untouched") });
        const original = hash(request), writeError = mode === "falsy-both" ? undefined : Error("write failure");
        const closeError = mode === "falsy-both" ? false : Error("close failure");
        f.state.before = name => {
            if (name === "writeSync" && ["write", "write-close", "falsy-both"].includes(mode)) throw writeError;
            if (name === "fsyncSync" && ["flush", "flush-close"].includes(mode)) throw writeError;
            if (name === "closeSync" && ["close", "write-close", "flush-close", "falsy-both"].includes(mode)) throw closeError;
        };
        f.state.after = (name, args, value) => name === "writeSync" && mode === "short-write" ? value - 1 : value;
        const failure = await rejectValue(() => f.result(f.operation("writeRequest", request)));
        const record = f.adapter.diagnostics.records.at(-1);
        assert.equal(record.createAttempted, true); assert.equal(hash(request), original);
        if (mode === "exists") { assert.equal(record.created, false); assert.equal(f.files.get(record.name).bytes.toString(), "untouched"); }
        else { assert.equal(record.created, true); assert.equal(f.files.has(record.name), true); assert.equal(record.closeAttempts, 1); }
        if (["write-close", "flush-close", "falsy-both"].includes(mode)) {
            assert.ok(failure instanceof AggregateError); assert.deepEqual(failure.errors, [writeError, closeError]);
            assert.equal(record.operationFailed, true); assert.equal(record.operationError, writeError);
        }
        const unknown = ["close", "write-close", "flush-close", "falsy-both"].includes(mode);
        assert.equal(record.closeFailed, unknown);
        if (unknown) {
            assert.equal(record.closeError, closeError); assert.equal(f.adapter.snapshot().activeHandles, 1);
            assert.deepEqual(f.adapter.snapshot().uncertainHandles, [{ slot: 0, handle: record.fd.toString(16).toUpperCase() }]);
            assert.throws(() => f.adapter.dispose(), /unresolved/);
        } else { assert.equal(f.descriptors.size, 0); f.dispose(); }
        const before = f.state.calls.length; await assert.rejects(f.result(f.operation("readBatch", request)), /stage admission/);
        assert.equal(f.state.calls.length, before); request.fill(0); core.dispose();
    }
});
test("read close unknown retains one exact fd, clears raw bytes and stops later acquisitions", async () => {
    const f = fixture(); f.state.before = name => { if (name === "closeSync") throw 0; };
    const failure = await rejectValue(() => f.result(f.operation("readManifest"))); assert.equal(failure, 0);
    const d = f.adapter.diagnostics, record = d.records[0];
    assert.equal(record.operationFailed, false); assert.equal(record.closeFailed, true); assert.equal(record.closeError, 0);
    assert.equal(record.closeAttempts, 1); assert.equal(record.name, "candidate-manifest-receipt.json");
    assert.deepEqual(f.adapter.snapshot(), { opened: 1, closed: 0, peak: 1, activeHandles: 1, pending: false, uncertainHandles: [{ slot: 0, handle: "10" }] });
    assert.equal(d.allocatedBytes, d.clearedBytes); assert.equal(d.transferredBytes, 0); assert.equal(empty(f.state.reads[0]), true);
    const calls = f.state.calls.length; await assert.rejects(f.result(f.operation("readManifest")), /stage admission/);
    assert.equal(f.state.calls.length, calls); assert.throws(() => f.adapter.dispose(), /unresolved/);
});
test("lease cancellation before new operations still performs owned cleanup exactly once", async () => {
    for (const method of ["lstatSync", "realpathSync", "openSync", "fstatSync", "readSync", "writeSync", "fsyncSync"]) {
        const f = fixture(); let core, request, cancelAt = -1;
        if (method === "writeSync" || method === "fsyncSync") ({ core, request } = await f.prepareRequest());
        f.state.after = (name, args, value) => {
            if (name === method && cancelAt < 0) { cancelAt = f.state.calls.length; f.state.cancelled = true; }
            return value;
        };
        await assert.rejects(f.result(f.operation(request ? "writeRequest" : "readManifest", request)), /cancelled private lease/);
        assert.ok(cancelAt > 0); for (const call of f.state.calls.slice(cancelAt)) assert.equal(call.name, "closeSync");
        assert.equal(f.descriptors.size, 0); for (const bytes of f.state.reads) assert.equal(empty(bytes), true);
        if (request) request.fill(0); core?.dispose(); f.dispose();
    }
});
test("reentrant admission cannot clear the active stage and invalid tickets never access the filesystem", async () => {
    const f = fixture(); let checked = false, nested;
    f.state.after = (name, args, value) => {
        if (!checked) {
            checked = true; assert.equal(f.adapter.snapshot().pending, true);
            const op = f.api.readManifest({}, () => true, () => true);
            nested = Promise.allSettled([op.outcome, op.settled]);
            assert.equal(f.adapter.snapshot().pending, true); assert.throws(() => f.adapter.dispose(), /unresolved/);
        }
        return value;
    };
    const result = await f.result(f.operation("readManifest")); assert.equal((await nested)[0].status, "rejected");
    result.bytes.fill(0); result.receipt.fill(0); f.dispose();
    for (const mode of ["foreign-task", "foreign-volume", "extra", "false-admit", "false-validate"]) {
        const bad = fixture(), ticket = { stage: "readManifest", taskId, instanceId, volumePath, exchangeId, maximumBytes: 4096, receiptBytes: 4096 };
        if (mode === "foreign-task") ticket.taskId = snapshotId;
        if (mode === "foreign-volume") ticket.volumePath = "D:\\fallback";
        if (mode === "extra") ticket.authorization = true;
        await assert.rejects(bad.result(bad.api.readManifest(ticket, () => mode !== "false-admit", () => mode !== "false-validate")));
        assert.equal(bad.state.calls.length, 0); bad.dispose();
    }
});
test("root snapshot and caller path restrictions cannot be changed after construction", async () => {
    const f = fixture(); f.context.root = "D:\\foreign"; f.context.rootId = "FFFFFFFF:0000000000000001";
    const value = await f.result(f.operation("readManifest"));
    value.bytes.fill(0); value.receipt.fill(0); assert.ok(f.state.calls.length > 0); f.dispose();
    for (const badRoot of ["relative", "\\\\server\\share", "D:\\a\\..\\b", "D:\\a.", "D:\\NUL", "D:\\a:stream"]) {
        const bad = fixture(); assert.throws(() => new PrivateCandidateChannel({ ...bad.context, root: badRoot }, bad.io));
        assert.equal(bad.state.calls.length, 0); bad.dispose();
    }
});
async function realOwner() {
    const runtime = new LiveSandboxRuntime(taskId), calls = [];
    const driver = { pid: 1, physicallyClosed: false, pending: false, setUnsafeHandler(fn) { this.unsafe = fn; },
        async command(command, observe) {
            calls.push(command); this.pending = true;
            try {
                if (command === "read-candidate-batch") this.batch?.();
                const done = command === "release" || command === "exit";
                const value = { taskId, diskId: taskId, phase: done ? "released" : "prepared-not-share-admitted", error: null, imageCreated: true,
                    imageId: "AABBCCDD:0000000000000009", physicalPath: "\\\\.\\PhysicalDrive77", volumePath, exchangeId,
                    closeUnknown: false, managementClosed: done, detached: done };
                observe(value); return value;
            } finally { this.pending = false; }
        }, async waitClosed() { this.physicallyClosed = true; return true; } };
    const volume = new TaskVolumeOwner({ driver, taskId, readRuntime: runtime.read, journal() {}, revokeCandidates() {}, cancelExecution() {} });
    await volume.prepare(); const ids = new Set();
    const cli = { launch(args) {
        if (args[0] === "start") ids.add(args[2]); else if (args[0] === "stop") ids.delete(args[2]); else assert.equal(args[0], "list");
        return { pid: 2, result: { pid: 2, exitCode: 0, signal: null, launchError: null, truncated: false, stderr: "",
            stdout: args[0] === "list" ? JSON.stringify({ WindowsSandboxEnvironments: [...ids].map(Id => ({ Id })) }) : "{}",
            closedUtc: "2026-11-01T00:00:00.000Z" }, async wait() { return "settled"; } };
    } };
    const vm = new SandboxLifecycle({ cli, taskId, config: experimentalGuidConfig(volume), journal() {} }); runtime.bind(vm);
    const ticket = await volume.issueExperimentalMapping(vm); await volume.startExperimentalMapping(ticket, vm); assert.equal(await vm.cleanup(), true);
    return { volume, vm, runtime, driver, calls };
}
test("actual owner consumes this fixed channel and retains unknown private close responsibility", async () => {
    for (const unknown of [false, true]) {
        const owner = await realOwner(), f = fixture({ owner: owner.volume, vm: owner.vm }); owner.driver.batch = f.updateBatch;
        if (unknown) f.state.before = name => { if (name === "closeSync") throw Error("private close unknown"); };
        if (unknown) {
            await assert.rejects(owner.volume.readCandidatesOnce(f.authority, f.api), /close unknown/);
            assert.equal(owner.volume.candidateDiagnostics.leaseHeld, true);
            assert.deepEqual(owner.volume.candidateDiagnostics.snapshot.uncertainHandles, [{ slot: 0, handle: "10" }]);
            await assert.rejects(owner.volume.release()); assert.throws(() => f.adapter.dispose(), /unresolved/);
        } else {
            const checked = await owner.volume.readCandidatesOnce(f.authority, f.api);
            assert.equal(checked.copyBytes(0).toString(), "abc"); assert.equal(checked.guestReport.exitCode, 23);
            assert.equal(owner.volume.candidateDiagnostics.leaseHeld, false);
            for (const bytes of [...f.state.reads, ...f.state.writes]) assert.equal(empty(bytes), true);
            assert.equal(f.adapter.diagnostics.calls, 64); f.dispose();
            await owner.volume.release(); assert.equal(checked.copyBytes(0).toString(), "abc");
            owner.volume.disposeCandidates(); owner.runtime.dispose(); assert.equal(owner.runtime.retainsOwner, false);
        }
    }
});
