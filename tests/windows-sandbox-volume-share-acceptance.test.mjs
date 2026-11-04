import { WINDOWS_PATH_TEST_OPTIONS } from "./helpers/windows-sandbox-prerequisites.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { EventEmitter } from "node:events";
import { PrivateReceiptReader, sourceManifest, sourceReceipt, hostLaunchGuard, SHARING_SOURCES, SHARING_ROOT } from "../scripts/acceptance/windows-sandbox-volume-share-acceptance.mjs";
import { SharingLifetime } from "../scripts/acceptance/windows-sandbox-volume-session.mjs";
import { POWERSHELL7_PATH } from "../scripts/acceptance/windows-sandbox-volume.mjs";
import { sharingReport, preflightSnapshot, helperSnapshots, volumeSnapshot, vmSnapshot, operationErrorSnapshot } from "../scripts/acceptance/windows-sandbox-volume-share.mjs";
const taskId = "11111111-2222-3333-4444-555555555555", name = "volume-guest-read.json", root = SHARING_ROOT, rootId = "3938676073:9007199254740991";
function fixture(text = '{"ok":true}', leafName = name) {
    const bytes = Buffer.isBuffer(text) ? text : Buffer.from(text), state = { closed: 0, reads: 0, opened: 0, buffers: [], unknown: [], mismatch: false, short: false, failRead: undefined, failClose: undefined };
    const stat = (directory, ino = directory ? 9007199254740991n : 9007199254740990n) => ({ dev: 3938676073n, ino, size: directory ? 0n : BigInt(bytes.length),
        nlink: 1n, mtimeNs: 1n, ctimeNs: 1n, isDirectory: () => directory, isFile: () => !directory, isSymbolicLink: () => false });
    const io = {
        lstatSync(file) { assert.ok(file === root || file === path.join(root, leafName)); return stat(file === root); },
        realpathSync: file => file,
        openSync(file, flags) { assert.equal(file, path.join(root, leafName)); assert.equal(flags, "r"); state.opened++; return 17; },
        fstatSync(fd) { assert.equal(fd, 17); return stat(false, state.mismatch ? 12n : undefined); },
        readSync(fd, buffer, offset, length) { assert.equal(fd, 17); state.reads++; state.buffers.push(buffer); if (state.failRead) throw state.failRead;
            if (state.short) return 0; return bytes.copy(buffer, offset, offset, offset + length); },
        closeSync(fd) { assert.equal(fd, 17); if (state.failClose) throw state.failClose; state.closed++; },
    };
    return { state, io, reader: new PrivateReceiptReader(root, rootId, state.unknown, io) };
}
test("private receipt is read once with independent close evidence and cleared bounded storage", WINDOWS_PATH_TEST_OPTIONS, t => {
    const f = fixture(); assert.deepEqual(f.reader.read(name), { ok: true });
    assert.deepEqual(f.reader.counters, { opened: 1, closed: 1, active: 0, peak: 1, bytesRead: 11, bytesAllocated: 11 });
    assert.ok(f.state.buffers.every(buffer => buffer.every(byte => byte === 0)));
    assert.throws(() => f.reader.read(name), /admission/); assert.equal(f.state.opened, 1);
    t.diagnostic(JSON.stringify({ realHandles: 0, fakeOpened: 1, fakeClosed: 1, peak: 1, allocated: 11, buffersCleared: true }));
});
test("private receipt rejects shape, identity, size, short read and invalid UTF-8 without expanding scope", WINDOWS_PATH_TEST_OPTIONS, () => {
    const unknown = fixture(); assert.throws(() => unknown.reader.read("user.txt"), /admission/); assert.equal(unknown.state.opened, 0);
    const oversized = fixture("x".repeat(4097)); assert.throws(() => oversized.reader.read(name), /size/); assert.equal(oversized.state.opened, 0);
    const redirected = fixture(); redirected.io.realpathSync = file => file + "-other"; assert.throws(() => redirected.reader.read(name), /root/); assert.equal(redirected.state.opened, 0);
    for (const mode of ["identity", "short", "utf8", "json", "leaf"]) {
        const f = fixture(mode === "utf8" ? Buffer.from([255]) : mode === "json" ? "{" : undefined);
        if (mode === "identity") f.state.mismatch = true;
        if (mode === "short") f.state.short = true;
        if (mode === "leaf") { const original = f.io.lstatSync; let leaf = 0; f.io.lstatSync = file => {
            const result = original(file); if (file !== root && ++leaf === 2) result.ino = 33n; return result;
        }; }
        assert.throws(() => f.reader.read(name)); assert.equal(f.state.closed, 1, mode); assert.equal(f.reader.counters.active, 0, mode);
        assert.ok(f.state.buffers.every(buffer => buffer.every(byte => byte === 0)));
    }
    const absent = fixture(), missing = Object.assign(Error("initial absence"), { code: "ENOENT" }), leaf = "volume-error-exit.json";
    const initial = absent.io.lstatSync; absent.io.lstatSync = file => { if (file === path.join(root, leaf)) throw missing; return initial(file); };
    assert.equal(absent.reader.read(leaf, true), undefined); assert.equal(absent.state.opened, 0);
    const jsonNull = fixture("null", leaf); const value = jsonNull.reader.read(leaf, true);
    assert.equal(value, null); assert.notEqual(value, undefined); assert.throws(() => operationErrorSnapshot(value, "exit"), /schema/);
    for (const stage of ["root", "open", "after-read"]) {
        const f = fixture(), fail = Object.assign(Error(stage + " disappeared"), { code: "ENOENT" });
        const lstat = f.io.lstatSync; let leaves = 0;
        f.io.lstatSync = file => {
            if (stage === "root" && file === root || stage === "after-read" && file !== root && ++leaves === 2) throw fail;
            return lstat(file === path.join(root, leaf) ? path.join(root, name) : file);
        };
        f.io.openSync = () => { if (stage === "open") throw fail; f.state.opened++; return 17; };
        assert.throws(() => f.reader.read(leaf, true), error => error === fail);
        assert.equal(f.state.closed, stage === "after-read" ? 1 : 0);
    }
});
test("private receipt preserves original read error and separately retains an unknown close descriptor", WINDOWS_PATH_TEST_OPTIONS, () => {
    for (const readFailed of [false, true]) {
        const f = fixture(), original = Object.assign(Error("original read error"), { code: "EIO" }), close = Object.assign(Error("close error"), { code: "EBADF" });
        f.state.failRead = readFailed ? original : undefined; f.state.failClose = close;
        assert.throws(() => f.reader.read(name), error => error === (readFailed ? original : close));
        assert.deepEqual(f.state.unknown, [{ fd: 17, name, code: "EBADF", message: "close error" }]);
        assert.equal(f.reader.counters.opened, 1); assert.equal(f.reader.counters.closed, 0); assert.equal(f.reader.counters.active, 1);
        assert.throws(() => f.reader.read("volume-error-exit.json"), /admission/); assert.equal(f.state.opened, 1);
        assert.ok(f.state.buffers.every(buffer => buffer.every(byte => byte === 0)));
    }
});
test("source manifest guards the final manager factory and bounds adapter encoding samples", async t => {
    const bundle = sourceManifest(file => Buffer.from(file));
    assert.equal(bundle.manifest.files.length, 21); assert.equal(new Set(SHARING_SOURCES).size, 21);
    assert.equal(bundle.sha256, createHash("sha256").update(Buffer.from(JSON.stringify(bundle.manifest), "utf8")).digest("hex"));
    assert.notEqual(bundle.sha256, sourceManifest(file => Buffer.from(file + "x")).sha256);
    assert.throws(() => sourceManifest(() => Buffer.alloc(131073)), /bound/);
    for (const mode of ["changed-source", "cancelled", "changed-tool", "unchanged"]) {
        const report = sharingReport(taskId, root, rootId), bus = new EventEmitter(), stream = new EventEmitter(), signal = new AbortController();
        let current = bundle.sha256, factories = 0, disposed = 0, reserved = false;
        const task = { cancel() {}, unsafe() {}, quiescent: () => true, dispose() { disposed++; } };
        const save = () => { if (report.physical?.pending[0]?.phase === "reserved") {
            reserved = true; if (mode === "changed-source") current = "0".repeat(64); if (mode === "cancelled") signal.abort();
        } };
        const lifetime = new SharingLifetime({ bus, stream, report, save, task });
        const guard = hostLaunchGuard(task, signal.signal, bundle.sha256, POWERSHELL7_PATH, {
            sourceManifest() { assert.equal(reserved, true); return { sha256: current }; },
            verifyPowerShell7() { if (mode === "changed-tool") throw Error("pinned tool changed"); },
            hashFile() { throw Error("unexpected compiler branch"); },
        });
        const factory = () => { factories++; return Object.assign(new EventEmitter(), { pid: 31, result: { stdout: "", stderr: "" } }); };
        if (mode === "unchanged") lifetime.launch("manager", factory, guard);
        else assert.throws(() => lifetime.launch("manager", factory, guard));
        assert.equal(factories, mode === "unchanged" ? 1 : 0, mode); assert.equal(report.physical.notStarted, mode === "unchanged" ? 0 : 1, mode);
        lifetime.beginCompletion(); report.artifactsRemoved = true; lifetime.closeTaskBinding(); lifetime.finish();
        await new Promise(resolve => setImmediate(resolve)); assert.equal(lifetime.retainsTask, false); assert.equal(disposed, 1);
    }
    const directory = fileURLToPath(new URL("../scripts/acceptance/", import.meta.url));
    for (const file of SHARING_SOURCES.filter(file => file.endsWith(".mjs"))) {
        const source = fs.readFileSync(path.join(directory, file), "utf8");
        for (const match of source.matchAll(/^import .+ from "\.\/(.+)";/gm)) assert.ok(SHARING_SOURCES.includes(match[1]), file + " -> " + match[1]);
    }
    const report = sharingReport(taskId, root, rootId), volumePath = "\\\\?\\Volume{aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee}\\", exchangeId = "FFFFFFFF:FFFFFFFFFFFFFFFF";
    const preflight = { protocol: "super-pi-native-preflight-v1", powershell: "7.6.9", x64: true, administratorToken: true, privilege: "SeManageVolumePrivilege",
        privilegeState: "已禁用", storageVersion: "2.0.0.0", commands: 7, format: "NTFS", requiredBytes: 168820736, availableBytes: Number.MAX_SAFE_INTEGER };
    report.preflight = preflightSnapshot(preflight); report.sources = sourceReceipt(bundle, "f".repeat(64));
    report.helperCalls = helperSnapshots(["pwsh.exe", "csc.exe"].map((executable, index) => ({ executable, pid: 4294967295, outcome: "settled", killRequested: false,
        result: { exitCode: 0, signal: null, launchError: null, stdoutSeen: index ? 0 : Buffer.byteLength(JSON.stringify(preflight)), stderrSeen: 0, truncated: false,
            stdout: index ? "" : JSON.stringify(preflight), stderr: "" } })));
    report.prepared = { imageId: "FFFFFFFF:FFFFFFFFFFFFFFFE", diskId: taskId, physicalPath: "\\\\.\\PhysicalDrive4294967295", volumePath, exchangeId, capacity: 134217728, imageBudget: 135266304 };
    report.volume = volumeSnapshot({ state: "released", helperPid: 4294967295, helperClosed: true, pending: false, reading: false, closeUnknown: false, revoked: false,
        experimentalMappingState: "released", experimentalInstanceId: taskId, facts: { ...report.prepared, phase: "released", error: null, detached: true, managementClosed: true, closeUnknown: false },
        transport: { exitCode: 0, signal: null, buffersReleased: true, stderr: { encoding: "uninterpreted", rawBase64: "", seenBytes: 0, capturedBytes: 0, truncated: false } } });
    report.vm = vmSnapshot({ taskId, instanceId: taskId, state: "closed", startAttempted: true, startSettled: true, registered: true, stopAttempted: true,
        controlPending: false, executionPending: false, connectionPending: false, cleanupError: null, calls: Array(96), configSha256: "f".repeat(64) });
    report.guestExit = { source: "guest-report", interfaceSource: "platform-interface", exitCode: 0 };
    report.guestRead = { protocol: "super-pi-volume-guest-read-v1", taskId, volumePath, exchangeId, fileId: "FFFFFFFF:FFFFFFFFFFFFFFFD", requestedBytes: 32,
        bytes: 32, matched: true, opened: 2, closed: 2, peak: 2, fileRetained: false, directoryRetained: false, fileCloseError: null, directoryCloseError: null, closeUnknown: false };
    report.privateReceipts = { opened: 1, closed: 1, active: 0, peak: 1, bytesRead: 4096, bytesAllocated: 4096 };
    report.physical = { reservations: 99, attached: 99, notStarted: 0, observedStarted: 99, launchUnknown: 0, physicallyClosed: 99,
        resultCharacters: 3211264, pending: [], cliReservations: 96, cliRecords: 96 };
    report.lastCli = { kind: "list", pid: 4294967295, exitCode: 0, signal: null, launchError: null, stdoutSeen: 33, stderrSeen: 0, truncated: false,
        stdoutPrefix: '{"WindowsSandboxEnvironments":[]}', stderrPrefix: "", prefixesOnly: true };
    report.files = ["volume-native.dll", "volume-guest-read.json", "volume-helper.json", "lifecycle.json"].map(name => ({ name, id: rootId,
        bytes: name.endsWith("dll") ? 131072 : name === "volume-guest-read.json" ? 4096 : 8192 }));
    report.reportedUtc = new Date().toISOString(); report.sequencePassed = true; report.released = true;
    const pretty = Buffer.byteLength(JSON.stringify(report, null, 2)), compact = Buffer.byteLength(JSON.stringify(report) + "\n");
    assert.ok(pretty <= 8192); assert.ok(compact <= 7680);
    const error = operationErrorSnapshot({ command: "read-guest", classification: "storage-operation-failed", exception: "System.IO.IOException", phase: "prepared",
        hresult: -2147024809, nativeCode: 4294967295, message: "\u0000错".repeat(200) }, "read-guest");
    report.operationErrors.push(error); report.receiptUnknownHandles.push({ fd: 2147483647, name, code: "EBADF", message: "close unknown" });
    report.error = "\u0000错".repeat(10); report.cleanupError = "receipt close unknown"; report.retained = true; report.sequencePassed = false;
    const failure = Buffer.byteLength(JSON.stringify(report, null, 2)); assert.ok(failure <= 8192);
    t.diagnostic(JSON.stringify({ sourceFiles: 18, completePrettyBytes: pretty, completeEvidenceBytes: compact, encodedFailureBytes: failure,
        journalLimit: 8192, evidenceLimit: 7680, realProcesses: 0, realReceiptHandles: 0, filesystemWrites: 0 }));
});
