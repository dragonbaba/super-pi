import assert from "node:assert/strict";
import test, { before, after } from "node:test";
import { mkdtemp, mkdir, open, lstat, realpath, unlink, rmdir, symlink, link } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname, resolve, parse } from "node:path";
import { createHash } from "node:crypto";
import { setImmediate as tick } from "node:timers/promises";
import { INPUT_LIMITS } from "../scripts/acceptance/windows-sandbox-input-snapshot.mjs";
import { WindowsSourceNative } from "../scripts/acceptance/windows-sandbox-source-native.mjs";
import { WindowsSourceReader, createWindowsSourceReader } from "../scripts/acceptance/windows-sandbox-source-reader.mjs";
import { nativeFileDiagnostics } from "../packages/coding-agent/src/core/files/native-file-client.ts";

const data = Buffer.from("alpha"), sha = createHash("sha256").update(data).digest("hex");
const id = value => ({ dev: value.dev, ino: value.ino });
const fileId = value => ({ ...id(value), size: value.size, mtimeNs: value.mtimeNs, ctimeNs: value.ctimeNs });
const same = (a, b) => a.dev === b.dev && a.ino === b.ino;
const UUID = "11111111-1111-4111-8111-111111111111";
const REVISION = "snap_abcdefghijklmnopqrstuv";
let parent, root, inner, outside, source, anchor, resourcesSafe = true, acquireAllowed = true, realReaders = 0, nativeReadBytes = 0;
let fixtureOpenAttempts = 0, fixtureCloseAttempts = 0, fixtureClosed = 0, fixtureActive = 0, fixturePeak = 0;
let bootstrap, bootstrapDiagnostics;
const created = [], realReports = [], creationFailures = [], fixtureFailures = [], cleanupFailures = [], unresolvedReaders = [];
const workersBefore = nativeFileDiagnostics();
let reportBytes = 0;
let realCallerAllocated = 0, realCallerCleared = 0;
function report(value) {
    const text = JSON.stringify(value); reportBytes += Buffer.byteLength(text) + 1;
    assert.ok(reportBytes <= 24576, "owned report output budget"); console.log(text);
}

function live() { assert.ok(resourcesSafe && acquireAllowed, "failed or unresolved resource: no further acquisition"); }
function registration(path, kind) {
    const record = { path, kind, stage: "planned", created: false, identity: undefined, released: false, cleanupAttempted: false };
    created.push(record); return record;
}
async function creationFailure(record, stage, error) {
    acquireAllowed = false; creationFailures.push({ record, stage, error });
    record.stage = record.created ? record.identity ? "identified-with-failure" : "created-unidentified" : "create-unconfirmed";
    if (!record.created) {
        try { await lstat(record.path); }
        catch (absenceError) {
            if (absenceError?.code === "ENOENT") { record.stage = "confirmed-absent"; record.released = true; }
            else cleanupFailures.push({ path: record.path, stage: "confirm-absence", error: absenceError });
        }
    }
    report({ creationFailed: { path: record.path, stage, created: record.created,
        identified: record.identity !== undefined, absenceConfirmed: record.stage === "confirmed-absent" } });
}
async function directory(path, existing = false) {
    live(); const record = registration(path, "directory"); record.created = existing;
    try {
        if (!existing) { await mkdir(path); record.created = true; }
        record.stage = "created"; record.identity = id(await lstat(path, { bigint: true })); record.stage = "identified";
        return record;
    } catch (error) { await creationFailure(record, record.created ? "directory-identity" : "mkdir", error); throw error; }
}
async function exactRemove(record) {
    assert.equal(resourcesSafe, true); assert.ok(record.identity && !record.released && !record.cleanupAttempted);
    record.cleanupAttempted = true;
    for (let ancestor = record.path === root ? undefined : dirname(record.path); ancestor; ancestor = ancestor === root ? undefined : dirname(ancestor)) {
        const original = created.find(item => item.path === ancestor && item.kind === "directory");
        assert.ok(original?.identity && !original.released);
        const observed = await lstat(ancestor, { bigint: true });
        assert.ok(same(observed, original.identity) && observed.isDirectory() && !observed.isSymbolicLink());
        assert.equal(await realpath(ancestor), ancestor);
    }
    const actual = await lstat(record.path, { bigint: true }); assert.ok(same(actual, record.identity));
    const absolute = resolve(record.path);
    assert.ok(absolute === root || absolute.startsWith(root + "\\"));
    if (record.kind === "directory") {
        assert.ok(actual.isDirectory() && !actual.isSymbolicLink()); await rmdir(record.path);
    } else {
        assert.equal(actual.isSymbolicLink(), record.kind === "link"); await unlink(record.path);
    }
    record.released = true; record.stage = "removed"; await assert.rejects(lstat(record.path), { code: "ENOENT" });
}
async function fixtureHandle(path, flags, action) {
    live(); fixtureOpenAttempts++;
    const handle = await open(path, flags); fixtureActive++; fixturePeak = Math.max(fixturePeak, fixtureActive);
    let operationFailed = false, operationError, closeFailed = false, closeError, value;
    try { value = await action(handle); } catch (error) { operationFailed = true; operationError = error; }
    fixtureCloseAttempts++;
    try { await handle.close(); fixtureClosed++; fixtureActive--; }
    catch (error) { closeFailed = true; closeError = error; resourcesSafe = false; }
    if (operationFailed || closeFailed) {
        acquireAllowed = false; fixtureFailures.push({ path, handle: closeFailed ? handle : undefined,
            operationFailed, operationError, closeFailed, closeError });
    }
    if (operationFailed && closeFailed) throw new AggregateError([operationError, closeError], "fixture operation and close");
    if (operationFailed) throw operationError;
    if (closeFailed) throw closeError;
    return value;
}
async function temporaryLink(name, target, kind, action) {
    live(); const path = join(root, name), record = registration(path, kind === "hard" ? "file" : "link");
    try {
        if (kind === "hard") await link(target, path);
        else await symlink(target, path, kind); // No skip or fallback if symlink privilege is unavailable.
        record.created = true; record.stage = "created";
        record.identity = id(await lstat(path, { bigint: true })); record.stage = "identified";
    } catch (error) {
        await creationFailure(record, record.created ? "link-identity" : "link-create", error); throw error;
    }
    let failed = false, failure, cleanupFailed = false, cleanupError;
    try { await action(path); } catch (error) { failed = true; failure = error; acquireAllowed = false; }
    if (resourcesSafe) try { await exactRemove(record); }
    catch (error) { cleanupFailed = true; cleanupError = error; acquireAllowed = false; cleanupFailures.push({ path, stage: "link-remove", error }); }
    if (failed && cleanupFailed) throw new AggregateError([failure, cleanupError], "link scene and cleanup");
    if (failed) throw failure;
    if (cleanupFailed) throw cleanupError;
}
before(async () => {
    assert.equal(process.platform, "win32"); assert.equal(process.arch, "x64");
    assert.equal(typeof global.gc, "function");
    parent = await realpath(tmpdir()); root = await mkdtemp(join(parent, "sp-source-"));
    report({ createdRoot: root });
    await directory(root, true); assert.equal(dirname(resolve(root)), parent);
    inner = join(root, "inner"); outside = join(inner, "outside");
    await directory(inner); await directory(outside);
    source = join(inner, "source.txt");
    const record = registration(source, "file");
    try {
        await fixtureHandle(source, "wx", async handle => {
            record.created = true; record.stage = "created";
            record.identity = id(await handle.stat({ bigint: true })); record.stage = "identified"; await handle.writeFile(data);
        });
    } catch (error) {
        await creationFailure(record, !record.created ? "leaf-create" : !record.identity ? "leaf-identity" : "leaf-write-or-close", error); throw error;
    }
    const drive = parse(root).root, identity = id(await lstat(drive, { bigint: true }));
    // Bootstrap is inside this sole reviewed command; one mapping query, no open.
    bootstrap = new WindowsSourceNative();
    try { anchor = { drive, volumePath: bootstrap.volumeForDrive(drive), identity }; }
    finally { bootstrap.dispose(); bootstrapDiagnostics = bootstrap.diagnostics; bootstrap = undefined; }
});
after(async () => {
    if (resourcesSafe) for (let i = created.length - 1; i >= 0; i--) {
        const record = created[i];
        if (!record.released && record.identity && !record.cleanupAttempted) {
            try { await exactRemove(record); }
            catch (error) { cleanupFailures.push({ path: record.path, stage: "final-remove", error }); }
        }
    }
    const registry = created.map(record => ({ path: record.path, kind: record.kind, stage: record.stage,
        created: record.created, identified: record.identity !== undefined, released: record.released, cleanupAttempted: record.cleanupAttempted }));
    report({ cleanupRegistry: registry, creationFailures: creationFailures.length, cleanupFailures: cleanupFailures.length,
        fixtureFailures: fixtureFailures.length, unresolvedReaderCount: unresolvedReaders.length, resourcesSafe });
    assert.equal(resourcesSafe, true, "retain exact paths/owners after unknown close");
    assert.equal(fixtureActive, 0); assert.equal(fixtureCloseAttempts, fixtureClosed);
    assert.equal(cleanupFailures.length, 0); assert.ok(created.every(record => record.released));
    assert.ok(realReaders <= 16 && nativeReadBytes <= 128);
    assert.ok(fixtureOpenAttempts <= 3 && fixturePeak <= 1);
    assert.equal(realCallerAllocated, realCallerCleared);
    data.fill(0);
    const workersAfter = nativeFileDiagnostics();
    assert.equal(workersAfter.workerStarts - workersBefore.workerStarts, 0);
    assert.equal(workersAfter.calls - workersBefore.calls, 0); assert.equal(workersAfter.pending, 0);
    report({ root, source, registeredNodes: created.length, releasedNodes: created.filter(item => item.released).length,
        realReaders, nativeReadBytes, maximumReaders: 16, maximumNativeReadBytes: 128,
        receiptIssuances: 0, workerStartsDelta: workersAfter.workerStarts - workersBefore.workerStarts,
        workerCallsDelta: workersAfter.calls - workersBefore.calls, workerPending: workersAfter.pending,
        businessChildCalls: "none in audited source; not OS process instrumentation", fixtureOpenAttempts,
        fixtureCloseAttempts, fixtureClosed, fixtureActive, fixturePeak, bootstrapDiagnostics,
        realCallerAllocated, realCallerCleared, implicitNodeOsIoInstrumented: false, realReports });
});

async function inputFor({ sourceRoot = root, relative = "inner/source.txt", actual = source, parentPath = "inner", parentActual = inner,
    expose = true, operation = "modify" } = {}) {
    live();
    const rootStat = await lstat(sourceRoot, { bigint: true }), stat = await lstat(actual, { bigint: true });
    return { taskId: UUID, snapshotId: UUID, sessionId: "native_source", epoch: 0,
        sourceRoot: { path: sourceRoot, identity: id(rootStat) }, budget: { ...INPUT_LIMITS },
        entries: [{ path: relative, classification: "ordinary", expose, operation, revision: REVISION,
            identity: fileId(stat), sha256: sha, parents: parentPath ? [{ path: parentPath, identity: id(await lstat(parentActual, { bigint: true })) }] : [] }] };
}
function useReal(input, action, guard = () => true, selectedAnchor = anchor) {
    live(); assert.ok(realReaders < 16); realReaders++;
    const reader = createWindowsSourceReader(input, selectedAnchor, guard);
    try { return action(reader); }
    catch (error) { acquireAllowed = false; throw error; }
    finally {
        const closed = reader.closeAll();
        if (!closed) { resourcesSafe = false; unresolvedReaders.push(reader); }
        const report = reader.diagnostics; realReports.push(report); nativeReadBytes += report.native?.readBytes ?? 0;
        assert.equal(closed, true, "native close unknown; retain owner and exact fixture paths");
        assert.equal(report.activeHandles, 0); assert.equal(report.opened, report.closed);
        assert.equal(report.closeAttempts, report.closed); assert.ok(report.peakHandles <= 82);
        assert.equal(report.retainedSlots, 0); assert.equal(report.retainedContext, false);
        assert.equal(report.retainedGuard, false); assert.equal(report.retainedOperations, false);
        assert.equal(report.native.retainedScratch, 0); assert.equal(report.native.allocatedScratch, report.native.releasedScratch);
        assert.ok(report.native.calls <= 8192 && report.openAttempts <= 256);
    }
}
function completeRead(reader, length = 5) {
    const token = reader.open("inner/source.txt"), bytes = Buffer.alloc(length);
    realCallerAllocated += length;
    try {
        const before = reader.stat(token); let offset = 0;
        while (offset < bytes.length) offset += reader.read(token, bytes, offset, Math.min(2, bytes.length - offset));
        assert.deepEqual(reader.stat(token), before); assert.equal(reader.close(token), true);
        assert.equal(createHash("sha256").update(bytes).digest("hex"), sha); assert.deepEqual(bytes, data);
    } finally { bytes.fill(0); realCallerCleared += length; assert.ok(bytes.every(value => value === 0)); }
}

test("source 1: actual GUID ancestor chain, native metadata/hash and short slices", async () => {
    const input = await inputFor();
    useReal(input, reader => {
        reader.initialize();
        assert.deepEqual(reader.directory("").identity, input.sourceRoot.identity);
        assert.deepEqual(reader.file("inner/source.txt").identity, input.entries[0].identity);
        completeRead(reader);
        assert.equal(reader.settle(), true);
        assert.equal(reader.diagnostics.verifiedContents, 1);
        assert.equal(reader.diagnostics.readCalls, 3);
        assert.equal(reader.diagnostics.readBytes, 5);
    });
});

test("source 2: original anchor/root/metadata and exact case are not refreshed", async () => {
    const wrongAnchor = { ...anchor, identity: { ...anchor.identity, ino: anchor.identity.ino + 1n } };
    useReal(await inputFor(), reader => assert.throws(() => reader.initialize()), () => true, wrongAnchor);
    const wrongRoot = await inputFor(); wrongRoot.sourceRoot.identity.ino++;
    useReal(wrongRoot, reader => assert.throws(() => reader.initialize()));
    const wrongFile = await inputFor(); wrongFile.entries[0].identity.ctimeNs++;
    useReal(wrongFile, reader => { reader.initialize(); assert.throws(() => reader.open("inner/source.txt")); });
    const alias = await inputFor({ relative: "inner/Source.txt" });
    useReal(alias, reader => { reader.initialize(); assert.throws(() => reader.open("inner/Source.txt")); });
});

test("source 3: actual junction is rejected strictly above source root and within root", async () => {
    await temporaryLink("junction", inner, "junction", async junction => {
        const ancestor = await inputFor({ sourceRoot: outside, relative: "source.txt", parentPath: "" });
        ancestor.entries = []; // This scene only tests a real, existing source-root chain.
        ancestor.sourceRoot.path = join(junction, "outside"); // The reparse point is a strict ancestor of the actual empty directory.
        useReal(ancestor, reader => assert.throws(() => reader.initialize(), /reparse|canonical/));
        const child = await inputFor({ relative: "junction/source.txt", parentPath: "junction" });
        useReal(child, reader => { reader.initialize(); assert.throws(() => reader.open("junction/source.txt"), /reparse|canonical/); });
    });
});

test("source 4: actual leaf symlink cannot stand in for original file", async () => {
    await temporaryLink("leaf-link.txt", source, "file", async () => {
        const input = await inputFor({ relative: "leaf-link.txt", parentPath: "" });
        useReal(input, reader => { reader.initialize(); assert.throws(() => reader.open("leaf-link.txt"), /reparse|canonical|metadata/); });
    });
});

test("source 5: actual hardlink count is rejected with a fresh independent scene baseline", async () => {
    await temporaryLink("hard.txt", source, "hard", async () => {
        const input = await inputFor(); assert.equal((await lstat(source, { bigint: true })).nlink, 2n);
        useReal(input, reader => { reader.initialize(); assert.throws(() => reader.open("inner/source.txt"), /link/); });
    });
});

test("source 6: existing writer conflicts and post-read guard failure clears the borrowed slice", async () => {
    await fixtureHandle(source, "r+", async () => {
        const input = await inputFor();
        useReal(input, reader => {
            reader.initialize();
            assert.throws(() => reader.open("inner/source.txt"), error => error.nativeStatus === (0xc0000043 | 0));
        });
    });
    const input = await inputFor(); let remaining = Infinity;
    useReal(input, reader => {
        reader.initialize(); const token = reader.open("inner/source.txt"), bytes = Buffer.alloc(9, 0x7f);
        realCallerAllocated += bytes.length;
        try {
            remaining = 1; assert.throws(() => reader.read(token, bytes, 2, 5), /host inactive/);
            assert.deepEqual(bytes, Buffer.from([127, 127, 0, 0, 0, 0, 0, 127, 127]));
            assert.equal(reader.diagnostics.clearedBorrowedBytes, 5);
            assert.equal(reader.diagnostics.native.readBytes, 5);
        } finally { bytes.fill(0); realCallerCleared += bytes.length; assert.ok(bytes.every(value => value === 0)); }
    }, () => --remaining >= 0);
});

// Explicitly synthetic operations below: no real HANDLE, Windows API or close
// failure is injected. They test ownership and control flow only.
const modelAnchor = { drive: "C:\\", volumePath: "\\\\?\\Volume{11111111-1111-4111-8111-111111111111}\\", identity: { dev: 1n, ino: 1n } };
function modelInput() {
    return { taskId: UUID, snapshotId: UUID, sessionId: "model", epoch: 0, sourceRoot: { path: "C:\\Synthetic", identity: { dev: 1n, ino: 2n } },
        budget: { ...INPUT_LIMITS }, entries: [{ path: "source.txt", classification: "ordinary", expose: true, operation: "modify",
            revision: REVISION, identity: { dev: 1n, ino: 3n, size: 5n, mtimeNs: 1000n, ctimeNs: 1000n }, sha256: sha, parents: [] }] };
}
function modelOps() {
    let calls = 0, next = 0n, closes = 0, disposed = false, readBytes = 0;
    const handles = new Map();
    const ops = {
        inspectHook: undefined, closeHook: undefined, openHook: undefined, readHook: undefined, missingName: undefined, missingStatus: (0xc0000034 | 0),
        volumeForDrive() { calls++; return modelAnchor.volumePath; },
        open(slot, parent, name, kind) {
            calls++;
            if (name === ops.missingName) { slot.status = ops.missingStatus; return false; }
            const handle = ++next, base = parent ? handles.get(parent) : undefined;
            const file = kind !== "directory", ino = base ? (file ? 3n : 2n) : 1n;
            const value = { handle, kind: file ? "file" : "directory", attributes: file ? 128 : 16, reparseTag: 0, nlink: 1,
                identity: { dev: 1n, ino, size: file ? 5n : 0n, mtimeNs: 1000n, ctimeNs: 1000n },
                guidPath: base ? base.guidPath + (base.guidPath.endsWith("\\") ? "" : "\\") + name : modelAnchor.volumePath,
                dosPath: base ? base.dosPath + (base.dosPath.endsWith("\\") ? "" : "\\") + name : "\\\\?\\C:\\", position: 0 };
            handles.set(handle, value); slot.handle = handle; slot.closeable = true; slot.status = 0; slot.information = 1n;
            ops.openHook?.(slot); return true;
        },
        inspect(handle) { calls++; const value = handles.get(handle); ops.inspectHook?.(value); return { ...value, identity: { ...value.identity } }; },
        read(handle, bytes, offset, length) {
            calls++; const value = handles.get(handle), count = Math.min(2, length);
            data.copy(bytes, offset, value.position, value.position + count); value.position += count; readBytes += count;
            ops.readHook?.(); return count;
        },
        close(handle) { closes++; ops.closeHook?.(handle); assert.equal(handles.delete(handle), true); return true; },
        dispose() { disposed = true; },
        get diagnostics() { return { calls, closeCalls: closes, readBytes, handles: handles.size, disposed }; },
    };
    return ops;
}
function releaseModel(reader) {
    assert.equal(reader.dispose(), true); const result = reader.diagnostics;
    assert.equal(result.activeHandles, 0); assert.equal(result.retainedSlots, 0);
    assert.equal(result.retainedContext, false); assert.equal(result.retainedOperations, false);
    assert.equal(result.retainedGuard, false); assert.equal(result.retainedBorrowedBuffers, 0); assert.equal(result.retainedContentStates, 0);
}

test("source 7: pre-native budgets, unapproved reads, partial opens and falsy/reentrant guards", () => {
    for (const metadataOnly of [false, true]) {
        const reader = new WindowsSourceReader(modelInput(), modelAnchor, () => true, modelOps()); reader.initialize();
        if (metadataOnly) reader.file("source.txt");
        assert.throws(() => reader.settle(), /unread exposed/); releaseModel(reader);
    }
    const onceOps = modelOps(), once = new WindowsSourceReader(modelInput(), modelAnchor, () => true, onceOps);
    once.initialize(); const onceToken = once.open("source.txt"), onceBytes = Buffer.alloc(5);
    try {
        let position = 0; while (position < 5) position += once.read(onceToken, onceBytes, position, 5 - position);
        once.close(onceToken); const beforeReopen = onceOps.diagnostics.calls;
        assert.throws(() => once.open("source.txt"), /single-use/); assert.equal(onceOps.diagnostics.calls, beforeReopen);
    } finally { onceBytes.fill(0); releaseModel(once); }
    const deep = modelInput(); deep.sourceRoot.path = "C:\\" + Array(33).fill("a").join("\\");
    const untouched = modelOps(); assert.throws(() => new WindowsSourceReader(deep, modelAnchor, () => true, untouched), /ancestor budget/);
    assert.equal(untouched.diagnostics.calls, 0);
    const hidden = modelInput(); hidden.entries[0].expose = false;
    const hiddenOps = modelOps(), hiddenReader = new WindowsSourceReader(hidden, modelAnchor, () => true, hiddenOps);
    hiddenReader.initialize(); const before = hiddenOps.diagnostics.calls;
    assert.throws(() => hiddenReader.open("source.txt"), /unapproved/); assert.equal(hiddenOps.diagnostics.calls, before); releaseModel(hiddenReader);
    const missingOps = modelOps(), missing = new WindowsSourceReader(modelInput(), modelAnchor, () => true, missingOps);
    missing.initialize(); const missingCalls = missingOps.diagnostics.calls;
    assert.throws(() => missing.file("not-approved.txt"), /unapproved/); assert.equal(missingOps.diagnostics.calls, missingCalls); releaseModel(missing);
    for (const original of [undefined, null, 0]) {
        const ops = modelOps(), reader = new WindowsSourceReader(modelInput(), modelAnchor, () => { throw original; }, ops);
        let caught = false; try { reader.initialize(); } catch (error) { caught = true; assert.equal(error, original); }
        assert.ok(caught); assert.equal(reader.failure.operationFailed, true); assert.equal(reader.failure.operationError, original);
        assert.equal(ops.diagnostics.calls, 0); releaseModel(reader);
    }
    const partialOps = modelOps(); partialOps.inspectHook = value => { if (value.identity.ino === 2n) throw undefined; };
    const partial = new WindowsSourceReader(modelInput(), modelAnchor, () => true, partialOps);
    let partialThrown = false; try { partial.initialize(); } catch (error) { partialThrown = true; assert.equal(error, undefined); }
    assert.ok(partialThrown); assert.equal(partial.diagnostics.opened, 2); releaseModel(partial); assert.equal(partialOps.diagnostics.closeCalls, 2);
    const adoptOps = modelOps(); adoptOps.openHook = slot => { if (slot.handle === 2n) throw null; };
    const adopted = new WindowsSourceReader(modelInput(), modelAnchor, () => true, adoptOps);
    let adoptThrown = false; try { adopted.initialize(); } catch (error) { adoptThrown = true; assert.equal(error, null); }
    assert.ok(adoptThrown); assert.equal(adopted.failure.operationError, null); assert.equal(adopted.diagnostics.opened, 2);
    releaseModel(adopted); assert.equal(adoptOps.diagnostics.closeCalls, 2);
    let reentrant;
    reentrant = new WindowsSourceReader(modelInput(), modelAnchor, () => { try { reentrant.directory(""); } catch {} return true; }, modelOps());
    assert.throws(() => reentrant.initialize(), /host inactive/); releaseModel(reentrant);
    const offsetOps = modelOps(), offset = new WindowsSourceReader(modelInput(), modelAnchor, () => true, offsetOps);
    offset.initialize(); const token = offset.open("source.txt"), bytes = Buffer.alloc(6);
    try { assert.throws(() => offset.read(token, bytes, 0, 6), /read budget/); assert.equal(offsetOps.diagnostics.readBytes, 0); }
    finally { bytes.fill(0); releaseModel(offset); }
    for (const absent of [true, false]) {
        const input = modelInput(); input.entries.push({ path: "new.txt", classification: "ordinary", expose: false,
            operation: "add", revision: null, identity: null, sha256: null, parents: [] });
        const ops = modelOps(); ops.missingName = "new.txt";
        if (!absent) ops.missingStatus = (0xc0000022 | 0);
        const reader = new WindowsSourceReader(input, modelAnchor, () => true, ops); reader.initialize();
        if (absent) assert.equal(reader.file("new.txt"), null);
        else assert.throws(() => reader.file("new.txt"), /component absent/);
        releaseModel(reader);
    }
    const hashInput = modelInput(); hashInput.entries[0].sha256 = "0".repeat(64);
    const hashReader = new WindowsSourceReader(hashInput, modelAnchor, () => true, modelOps()); hashReader.initialize();
    const hashToken = hashReader.open("source.txt"), borrowed = Buffer.alloc(5);
    try {
        assert.equal(hashReader.read(hashToken, borrowed, 0, 2), 2);
        assert.equal(hashReader.read(hashToken, borrowed, 2, 2), 2);
        assert.throws(() => hashReader.read(hashToken, borrowed, 4, 1), /original hash/);
        assert.equal(borrowed.subarray(0, 4).toString(), "alph"); assert.equal(borrowed[4], 0);
    } finally { borrowed.fill(0); releaseModel(hashReader); }
});

test("source 8: model-only Unknown keeps original responsibility; settled readers release references", async t => {
    const ops = modelOps(), reader = new WindowsSourceReader(modelInput(), modelAnchor, () => true, ops);
    reader.initialize();
    ops.inspectHook = value => { if (value.kind === "file") throw undefined; };
    ops.closeHook = handle => { if (handle === 3n) throw 0; };
    let caught = false; try { reader.open("source.txt"); } catch (error) { caught = true; assert.equal(error, undefined); }
    assert.ok(caught); assert.equal(reader.closeAll(), false);
    const failure = reader.failure, unresolved = failure.unresolved;
    assert.equal(failure.operationFailed, true); assert.equal(failure.operationError, undefined);
    assert.equal(unresolved.length, 1); assert.equal(unresolved[0].handle, 3n);
    assert.equal(unresolved[0].attempted, true); assert.equal(unresolved[0].closeFailed, true); assert.equal(unresolved[0].closeError, 0);
    const closeCalls = ops.diagnostics.closeCalls;
    assert.equal(reader.dispose(), false); assert.equal(ops.diagnostics.closeCalls, closeCalls);
    assert.equal(reader.diagnostics.retainedOperations, true); assert.equal(reader.diagnostics.cleanup, "unknown");
    const pendingOps = modelOps(); pendingOps.openHook = slot => {
        if (slot.handle === 2n) { slot.closeable = false; slot.status = 0x103; throw "model-pending"; }
    };
    const pendingReader = new WindowsSourceReader(modelInput(), modelAnchor, () => true, pendingOps);
    assert.throws(() => pendingReader.initialize(), error => error === "model-pending");
    assert.equal(pendingReader.closeAll(), false);
    const pendingSlot = pendingReader.failure.unresolved[0];
    assert.equal(pendingSlot.handle, 2n); assert.equal(pendingSlot.status, 0x103); assert.equal(pendingSlot.closeable, false);
    assert.equal(pendingSlot.attempted, false); assert.equal(pendingOps.diagnostics.closeCalls, 1);
    assert.equal(pendingReader.dispose(), false); assert.equal(pendingOps.diagnostics.closeCalls, 1);
    assert.throws(() => pendingReader.initialize());
    function gcFixture() {
        const input = modelInput(), operations = modelOps(), guard = () => true;
        const held = new WindowsSourceReader(input, modelAnchor, guard, operations); held.initialize();
        const weak = [new WeakRef(input), new WeakRef(operations), new WeakRef(guard)];
        releaseModel(held); return { held, weak };
    }
    const released = gcFixture();
    for (let round = 0; round < 4; round++) { await tick(); global.gc(); await tick(); }
    assert.equal(released.weak.filter(ref => ref.deref() !== undefined).length, 0);
    assert.equal(released.held.diagnostics.retainedOperations, false);
    t.diagnostic(JSON.stringify({ modelUnknownHandles: unresolved.length, modelPendingHandles: 1,
        knownActualUnknownHandles: unresolvedReaders.reduce((count, item) => count + item.diagnostics.activeHandles, 0),
        closeAttemptsNotRetried: closeCalls, liveReleasedTargets: 0, retainedSettledReader: true }));
});
