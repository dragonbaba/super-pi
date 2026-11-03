import { WINDOWS_PATH_TEST_OPTIONS } from "./helpers/windows-sandbox-prerequisites.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { EventEmitter } from "node:events";
import { SandboxLifecycle } from "../scripts/acceptance/windows-sandbox-lifecycle.mjs";
import { TaskVolumeOwner } from "../scripts/acceptance/windows-sandbox-volume.mjs";
import { LiveSandboxRuntime } from "../scripts/acceptance/windows-sandbox-volume-sharing.mjs";
import { SharingLifetime, sessionJournal, completeSharingSession, snapshotSessionFiles, removeSessionFiles, boundedText } from "../scripts/acceptance/windows-sandbox-volume-session.mjs";
import { sharingReport, exerciseSharedVolume, volumeMarkerCommand, volumeSnapshot, vmSnapshot, vmQuiescent, preflightSnapshot, helperSnapshots, operationErrorSnapshot } from "../scripts/acceptance/windows-sandbox-volume-share.mjs";
const taskId = "11111111-2222-3333-4444-555555555555", root = "D:\\synthetic\\owned", rootId = "1:1";
const volumePath = "\\\\?\\Volume{aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee}\\", exchangeId = "AABBCCDD:0000000000000002";
const tick = () => new Promise(resolve => setImmediate(resolve));
const permitted = Object.freeze({ owner: null, validate: () => true }); // Pure quota checks; no VM or process exists.
class Call extends EventEmitter {
    constructor(pid, result) { super(); this.pid = pid; this.result = result; }
    async wait() { return this.result ? "settled" : "timeout"; }
    close(value = result("{}")) { this.result = value; this.emit("settled"); }
}
function result(stdout) { return { exitCode: 0, signal: null, launchError: null, truncated: false, stdout, stderr: "",
    stdoutSeen: Buffer.byteLength(stdout), stderrSeen: 0, closedUtc: "2026-11-01T00:00:00.000Z" }; }
function receipt() { return { protocol: "super-pi-volume-guest-read-v1", taskId, volumePath, exchangeId, fileId: "AABBCCDD:0000000000000003",
    requestedBytes: 32, bytes: 32, matched: true, opened: 2, closed: 2, peak: 2, fileRetained: false, directoryRetained: false,
    fileCloseError: null, directoryCloseError: null, closeUnknown: false }; }
function memoryFiles() {
    const entries = new Map([[root, { ino: 1n, size: 0n, directory: true }]]), removed = []; let next = 10n;
    const add = (name, bytes = 10) => entries.set(path.join(root, name), { ino: next++, size: BigInt(bytes), directory: false });
    const io = {
        realpathSync(file) { assert.ok(entries.has(file)); return file; },
        lstatSync(file) { const value = entries.get(file); assert.ok(value, file); return { ...value, dev: 1n, nlink: 1n,
            isDirectory: () => value.directory, isFile: () => !value.directory, isSymbolicLink: () => false }; },
        readdirSync(directory) { assert.equal(directory, root); return [...entries.keys()].filter(file => file !== root).map(file => path.basename(file)); },
        unlinkSync(file) { assert.ok(entries.delete(file)); removed.push(path.basename(file)); },
        rmdirSync(directory) { assert.equal(entries.size, 1); assert.ok(entries.delete(directory)); },
    };
    return { io, add, entries, removed };
}
function basic() {
    const files = memoryFiles(), bus = new EventEmitter(), stream = new EventEmitter(), report = sharingReport(taskId, root, rootId);
    const state = { writes: [], journalWrites: 0, journalMaxBytes: 0, failJournal: false, onJournal: undefined, cancels: 0, unsafe: 0, ready: true, disposes: 0, holds: new Set() };
    const task = { vm: undefined, cancel() { state.cancels++; }, unsafe() { state.unsafe++; }, quiescent() { return state.ready; }, dispose() { state.disposes++; } };
    const save = sessionJournal({ journal(value) { if (state.failJournal) throw Error("injected journal failure"); state.onJournal?.(value); state.journalWrites++;
        const bytes = Buffer.byteLength(JSON.stringify(value, null, 2)); state.journalMaxBytes = Math.max(state.journalMaxBytes, bytes);
        files.add("lifecycle.json", bytes); } }, report, () => task.unsafe());
    stream.write = (text, done) => { state.writes.push({ text, done }); done(); return true; };
    const timers = { setInterval(callback, ms) { assert.equal(ms, 60000); const handle = { callback }; state.holds.add(handle); return handle; },
        clearInterval(handle) { state.holds.delete(handle); } };
    const lifetime = new SharingLifetime({ bus, stream, report, save, task, timers });
    const complete = () => completeSharingSession({ report, task, lifetime, save, root, rootId, io: files.io });
    return { files, bus, stream, report, state, task, save, lifetime, complete };
}
function full(mode) {
    const f = basic(), runtime = new LiveSandboxRuntime(taskId), controller = new AbortController(); let pid = 100;
    f.files.add("volume-native.dll", 22016); f.state.nativeImagesRemoved = 0;
    f.task.runtime = runtime; f.task.cancel = () => { f.state.cancels++; controller.abort(); f.task.volume?.revoke(); };
    f.task.unsafe = () => { f.state.unsafe++; f.task.volume?.onUnsafe(); };
    const driver = new EventEmitter(); driver.pid = 99; driver.physicallyClosed = false; driver.pending = false;
    driver.calls = []; driver.setUnsafeHandler = callback => { driver.unsafe = callback; };
    driver.command = async (command, observe) => {
        driver.calls.push(command); const released = command === "release" || command === "exit";
        if (command === "prepare") f.files.add("task.vhd", 134218240);
        if (command === "read-guest") f.files.add("volume-guest-read.json", 550);
        if (command === "release") { assert.ok(f.files.entries.delete(path.join(root, "task.vhd"))); f.state.nativeImagesRemoved++; }
        f.files.add("volume-helper.json", 500);
        const value = { taskId, diskId: taskId, imageCreated: true, imageId: "AABBCCDD:0000000000000001", physicalPath: "\\\\.\\PhysicalDrive77",
            volumePath, exchangeId, capacity: 134217728, imageBudget: 135266304, phase: released ? "released" : "prepared-not-share-admitted",
            error: null, detached: released, managementClosed: released, closeUnknown: false };
        observe(value); if (mode === "cancel" && command === "prepare") controller.abort(); return value;
    };
    driver.waitClosed = async () => { driver.physicallyClosed = true; driver.emit("settled"); return true; };
    f.lifetime.launch("manager", () => driver);
    const volume = new TaskVolumeOwner({ driver, taskId, readRuntime: runtime.read,
        journal(value) { f.report.volume = volumeSnapshot(value); f.save(); }, revokeCandidates() { f.report.revoked = true; }, cancelExecution() { controller.abort(); } });
    f.task.volume = volume; f.task.driver = driver;
    f.task.quiescent = () => vmQuiescent(f.task) && volume.state === "released" && driver.physicallyClosed && !driver.pending;
    f.task.dispose = () => { runtime.dispose(); f.task.vm = undefined; f.task.volume = undefined; f.task.driver = undefined; f.state.disposes++; };
    f.state.factoryKinds = [];
    const ids = new Set(), calls = [], cli = { launch(args, authorization) {
        calls.push(args); const kind = args[0];
        return f.lifetime.launch(kind, () => {
            f.state.factoryKinds.push(kind);
            if (kind === "start") ids.add(args[2]); if (kind === "stop") ids.delete(args[2]);
            const text = kind === "list" ? JSON.stringify({ WindowsSandboxEnvironments: [...ids].map(Id => ({ Id })) }) : kind === "exec" ? '{"ExitCode":0}' : "{}";
            return new Call(++pid, mode === "exec-pending" && kind === "exec" || mode === "start-unknown" && kind === "start" ? undefined : result(text));
        }, authorization);
    } };
    const buildVm = config => {
        if (mode === "before-binding") throw Error("injected construction failure before binding");
        return new SandboxLifecycle({ cli, taskId, config, journal(value) { f.report.vm = vmSnapshot(value); f.save(); } });
    };
    return { ...f, volume, driver, runtime, calls, controller,
        exercise: () => exerciseSharedVolume(f.task, f.report, controller.signal, buildVm, receipt) };
}

test("combined fixed sequence waits for actual VM closure, then reads/releases and clears bindings after exact cleanup", WINDOWS_PATH_TEST_OPTIONS, async t => {
    const f = full(); assert.equal(await f.exercise(), true);
    assert.deepEqual(f.driver.calls, ["prepare", "verify", "verify", "read-guest", "release", "exit"]);
    assert.deepEqual(f.calls.map(call => call[0]), ["list", "start", "list", "exec", "list", "stop", "list"]);
    const command = '"C:\\Windows\\System32\\cmd.exe" /d /c >"C:\\SuperPiVolume\\guest-control.bin" echo 111111112222333344445555555555';
    assert.equal(f.calls.find(call => call[0] === "exec")[4], command); assert.equal(volumeMarkerCommand(taskId), command);
    assert.throws(() => volumeMarkerCommand(taskId + "\n")); assert.equal(command.endsWith(" "), false);
    f.stream.write = (text, done) => { f.state.writes.push({ text, done }); return false; };
    const completing = f.complete(); assert.equal(f.files.removed.length, 0); assert.equal(f.state.disposes, 0);
    f.state.writes[0].done(); await tick(); assert.equal(f.files.entries.size, 0); assert.equal(f.state.disposes, 1);
    assert.equal(f.runtime.retainsOwner, false); assert.equal(f.lifetime.retainsTask, true); assert.equal(f.lifetime.released, false);
    assert.equal(f.files.removed.at(-1), "lifecycle.json"); f.state.writes[1].done(); await completing; await tick();
    assert.equal(f.state.nativeImagesRemoved, 1); assert.equal(f.report.removedFiles, 4);
    assert.equal(f.report.passed, true); assert.equal(f.lifetime.retainsTask, false); assert.equal(f.lifetime.trackedCount, 0);
    assert.equal(f.bus.listenerCount("SIGINT"), 0); assert.equal(f.stream.listenerCount("error"), 0); assert.equal(f.state.holds.size, 0);
    assert.equal(f.report.guestExit.source, "guest-report"); assert.equal(f.report.guestRead.matched, true);
    t.diagnostic(JSON.stringify({cliCalls:7,managerCalls:6,physicalObjects:8,outputWrites:2,physicalPendingAfter:0,retainedTaskAfter:false,filesystemOperations:0}));
});

test("binding-before-launch failure and cancellation skip reading but close the actual owned volume", WINDOWS_PATH_TEST_OPTIONS, async () => {
    for (const mode of ["before-binding", "cancel"]) {
        const f = full(mode); assert.equal(await f.exercise(), false);
        assert.deepEqual(f.driver.calls, ["prepare", "release", "exit"]); assert.equal(f.calls.length, 0);
        await f.complete(); await tick(); assert.equal(f.report.passed, false); assert.equal(f.report.artifactsRemoved, true);
        assert.equal(f.lifetime.retainsTask, false); assert.equal(f.runtime.retainsOwner, false);
        assert.equal(f.report.guestRead, null); assert.equal(f.report.vm, null);
    }
});

test("reservation journal reentry cannot bypass the last private start guard", async () => {
    for (const mode of ["revoke", "cleanup", "runtime-dispose"]) {
        const f = full(); let injected = false;
        f.state.onJournal = value => {
            if (injected || value.physical?.pending.at(-1)?.kind !== "start" || value.physical.pending.at(-1)?.phase !== "reserved") return;
            injected = true;
            if (mode === "revoke") f.volume.revoke();
            if (mode === "cleanup") f.task.vm.cleanup();
            if (mode === "runtime-dispose") f.runtime.dispose();
        };
        assert.equal(await f.exercise(), false); assert.equal(injected, true);
        assert.equal(f.state.factoryKinds.includes("start"), false); assert.equal(f.task.vm.startAttempted, false);
        assert.equal(f.report.physical.notStarted, 1, mode); assert.equal(f.report.physical.launchUnknown, 0, mode);
        assert.equal(f.volume.experimentalMappingReferencesHeld, false);
    }
    const f = full(); let injected = false;
    f.state.onJournal = value => {
        if (injected || value.physical?.pending.at(-1)?.kind !== "exec" || value.physical.pending.at(-1)?.phase !== "reserved") return;
        injected = true; f.volume.revoke(); // This API alone does not abort the controller; the private volume state must still deny exec.
    };
    assert.equal(await f.exercise(), false); assert.equal(injected, true); assert.equal(f.controller.signal.aborted, false);
    assert.equal(f.state.factoryKinds.includes("exec"), false); assert.equal(f.report.physical.notStarted, 1);
    assert.equal(f.driver.calls.includes("read-guest"), false); assert.equal(f.report.released, true);
});

test("unknown start or physically pending exec keeps VM, volume and task responsibility even after CLI clients close", async () => {
    for (const mode of ["start-unknown", "exec-pending"]) {
        const f = full(mode); assert.equal(await f.exercise(), false); assert.equal(f.driver.calls.includes("release"), false);
        await f.complete(); assert.equal(f.report.retained, true); assert.equal(f.lifetime.retainsTask, true);
        assert.equal(f.runtime.retainsOwner, true); assert.equal(f.files.removed.length, 0); assert.equal(f.state.holds.size, 1);
        const pending = f.task.vm.active?.operation ?? f.task.vm.execution?.operation;
        pending.close(); f.driver.physicallyClosed = true; f.driver.emit("settled"); await tick();
        assert.equal(f.lifetime.physicalClosed, true); assert.equal(f.lifetime.retainsTask, true); assert.equal(f.runtime.retainsOwner, true);
        assert.equal(f.files.removed.length, 0); assert.equal(f.state.disposes, 0);
        f.bus.emit("SIGINT"); f.bus.emit("SIGTERM"); assert.ok(f.state.cancels <= 1);
    }
});

test("all quota checks precede factories and no fifth unresolved record is hidden", () => {
    const f = basic(); let factories = 0;
    for (let i = 0; i < 96; i++) f.lifetime.launch("list", () => { factories++; return new Call(i + 1, result("{}")); });
    assert.throws(() => f.lifetime.launch("list", () => { factories++; }), /pre-spawn budget/); assert.equal(factories, 96);
    for (const kind of ["preflight", "compile", "manager"]) f.lifetime.launch(kind, () => new Call(++factories, result("{}")));
    assert.equal(f.lifetime.trackedCount, 99); assert.equal(f.report.physical.observedStarted, 99); assert.equal(f.report.physical.cliRecords, 0);
    assert.throws(() => f.lifetime.launch("manager", () => { factories++; })); assert.equal(factories, 99);
    const pending = basic(); let launched = 0;
    for (const kind of ["manager", "start", "exec", "stop"]) pending.lifetime.launch(kind, () => new Call(++launched), permitted);
    assert.throws(() => pending.lifetime.launch("list", () => { launched++; }), /pre-spawn budget/);
    assert.equal(launched, 4); assert.equal(pending.report.physical.pending.length, 4);
    const failed = basic(); failed.state.failJournal = true; let called = false;
    assert.throws(() => failed.lifetime.launch("preflight", () => { called = true; })); failed.lifetime.snapshot();
    assert.equal(called, false); assert.equal(failed.report.physical.notStarted, 1); assert.equal(failed.report.physical.observedStarted, 0);
    const unknown = basic(); assert.throws(() => unknown.lifetime.launch("manager", () => { throw Error("factory outcome unknown"); }));
    assert.equal(unknown.report.physical.launchUnknown, 1); assert.equal(unknown.report.physical.pending[0].phase, "launch-unknown");
    assert.equal(unknown.lifetime.physicalClosed, false); // Missing PID is never evidence that the factory created no process.
});

test("journal/output failures and late closes only update evidence and never restart cleanup", WINDOWS_PATH_TEST_OPTIONS, async () => {
    for (const mode of ["journal", "output"]) {
        const f = basic(); f.report.sequencePassed = true;
        const call = f.lifetime.launch("manager", () => new Call(3)); f.state.ready = false;
        if (mode === "journal") f.state.failJournal = true;
        else f.stream.write = (text, done) => { f.state.writes.push({ text, done }); done(Error("\u0000错".repeat(200))); return false; };
        await f.complete(); assert.equal(f.report.retained, true); assert.equal(f.files.removed.length, 0);
        const count = f.state.writes.length; call.close(); await tick();
        assert.equal(f.report.physical.physicallyClosed, 1); assert.equal(f.state.writes.length, count);
        assert.equal(f.lifetime.retainsTask, true); assert.equal(f.state.disposes, 0); assert.equal(f.state.holds.size, 1);
        assert.ok(f.state.writes.every(write => Buffer.byteLength(write.text) <= 7680));
    }
    for (const phase of ["evidence", "footer"]) {
        const f = full(); await f.exercise(); let late;
        f.stream.write = (text, done) => {
            f.state.writes.push({ text, done });
            if (phase === "footer" && f.state.writes.length === 1) { done(); return true; }
            late = done; f.stream.emit("error", Error("error before write callback")); return false;
        };
        await f.complete(); assert.equal(f.lifetime.physicalClosed, true); assert.ok(f.lifetime.output.pending);
        assert.equal(f.state.holds.size, 1); assert.equal(f.lifetime.retainsTask, true);
        const removed = f.files.removed.length; late(Error("late write callback")); await tick();
        assert.equal(f.lifetime.output.pending, undefined); assert.equal(f.files.removed.length, removed);
        assert.equal(f.lifetime.retainsTask, phase === "evidence"); assert.equal(f.state.holds.size, phase === "evidence" ? 1 : 0);
        assert.equal(f.report.passed, false);
    }
});

test("complete report profiles use real summaries and retain ownership on encoded overflow", WINDOWS_PATH_TEST_OPTIONS, async t => {
    const noisy = "\u0000\u0001错𐐀".repeat(100), measurements = [];
    const sourceNames = ["lifecycle", "volume", "volume-helper", "volume-native", "volume-config", "volume-sharing", "volume-guest-read",
        "volume-session", "volume-share", "volume-share-acceptance"].map(name => "windows-sandbox-" + name);
    const preflight = { protocol: "super-pi-native-preflight-v1", powershell: "7.5.2", x64: true, administratorToken: true,
        privilege: "SeManageVolumePrivilege", privilegeState: noisy, storageVersion: "2.0.0.0", commands: 7, format: "NTFS",
        requiredBytes: 168820736, availableBytes: Number.MAX_SAFE_INTEGER };
    function populate(f, failed) {
        f.report.sources = Object.fromEntries(sourceNames.map(name => [name, "f".repeat(64)]));
        f.report.preflight = preflightSnapshot(preflight);
        f.report.helperCalls = helperSnapshots(["pwsh.exe", "csc.exe"].map(executable => ({ executable, pid: 4294967295,
            outcome: "settled", killRequested: false, result: { ...result(noisy), stderr: noisy, stdoutSeen: 16384, stderrSeen: 16384 } })));
        f.report.volume = volumeSnapshot({ state: failed ? "blocked" : "released", helperPid: 99, helperClosed: !failed, pending: false,
            reading: false, closeUnknown: false, revoked: failed, experimentalMappingState: failed ? "revoked" : "dispatched",
            experimentalInstanceId: f.task.vm.id, facts: { ...f.report.prepared, phase: failed ? "prepared-not-share-admitted" : "released",
                error: null, detached: !failed, managementClosed: !failed, closeUnknown: false },
            transport: { exitCode: failed ? null : 0, signal: null, buffersReleased: !failed,
                stderr: { encoding: "uninterpreted", rawBase64: failed ? Buffer.alloc(1024, 255).toString("base64") : "",
                    seenBytes: failed ? Number.MAX_SAFE_INTEGER : 0, capturedBytes: failed ? 1024 : 0, truncated: failed } } });
        // VM facts came through actual vmSnapshot in the composed lifecycle; never substitute a flat made-up record.
        assert.ok(f.report.vm.configSha256 && f.report.vm.callRecords > 0);
        if (failed) { f.report.error = boundedText(noisy); f.report.cleanupError = boundedText(noisy); }
    }
    for (const profile of ["success", "retained", "output-error-late-close"]) {
        const failed = profile !== "success", f = full(failed ? "exec-pending" : undefined); await f.exercise(); populate(f, failed);
        const before = Buffer.byteLength(JSON.stringify(f.report, null, 2));
        await f.complete();
        const main = JSON.parse(f.state.writes[0].text);
        if (!failed) {
            assert.equal(f.report.passed, true); assert.equal(main.files.length, 4); assert.equal(main.guestRead.bytes, 32);
            assert.equal(main.helperCalls.length, 2); assert.ok(main.preflight && main.vm && main.volume.facts);
        } else {
            assert.equal(f.report.retained, true); assert.equal(f.files.removed.length, 0);
            if (before > 8192) { assert.equal(main.complete, false); assert.equal(f.report.outputBoundFailed, true); }
        }
        let after = Buffer.byteLength(JSON.stringify(f.report, null, 2));
        if (profile === "output-error-late-close") {
            f.stream.emit("error", Error(noisy)); f.task.vm.execution.operation.close({ ...result(noisy), stderr: noisy }); await tick();
            after = Buffer.byteLength(JSON.stringify(f.report, null, 2));
            assert.equal(f.report.outputFailed, true); assert.equal(f.lifetime.retainsTask, true); assert.equal(f.files.removed.length, 0);
        }
        assert.ok(f.state.journalMaxBytes <= 8192); assert.ok(f.state.writes.every(write => Buffer.byteLength(write.text) <= 7680));
        assert.ok(Buffer.byteLength(f.state.writes.at(-1).text) <= 512);
        measurements.push({ profile, attemptedPrettyBytes: before, afterPrettyBytes: after, maxJournalBytes: f.state.journalMaxBytes,
            mainBytes: Buffer.byteLength(f.state.writes[0].text), footerBytes: Buffer.byteLength(f.state.writes.at(-1).text), complete: main.complete !== false });
    }
    // Conservative schema ceiling with all five error receipts, all nine private leaves and actual pending objects.
    // It is deliberately not called a reachable success state; overflow must deliver incomplete evidence and retain the root.
    const ceiling = full("exec-pending"); await ceiling.exercise(); populate(ceiling, true);
    for (const command of ["prepare", "verify", "read-guest", "release", "exit"]) {
        ceiling.report.operationErrors.push(operationErrorSnapshot({ command, classification: "storage-identity-failed", phase: "blocked",
            exception: noisy.slice(0, 128), message: noisy.slice(0, 512), hresult: -2147483648, nativeCode: 4294967295 }, command));
        ceiling.files.add("volume-error-" + command + ".json", 4096);
    }
    ceiling.files.entries.delete(path.join(root, "task.vhd")); ceiling.files.add("volume-guest-read.json", 4096);
    ceiling.report.files = snapshotSessionFiles(root, rootId, ceiling.files.io);
    const ceilingBytes = Buffer.byteLength(JSON.stringify(ceiling.report, null, 2)); await ceiling.complete();
    // Pretty JSON size is not the emitted compact evidence size. A bounded
    // complete report is valid even when its formatted diagnostic exceeds 8 KiB.
    const ceilingEvidence = JSON.parse(ceiling.state.writes[0].text);
    assert.equal(ceilingEvidence.complete === false, ceiling.report.outputBoundFailed);
    assert.equal(ceiling.lifetime.retainsTask, true); assert.equal(ceiling.files.removed.length, 0);
    assert.ok(ceiling.state.journalMaxBytes <= 8192); assert.ok(ceiling.state.writes.every(write => Buffer.byteLength(write.text) <= 7680));
    const bad = basic(); bad.report.extra = "\u0000".repeat(2000); await bad.complete();
    assert.equal(bad.report.journalFailed, true); assert.equal(bad.report.outputBoundFailed, true); assert.equal(bad.files.removed.length, 0);
    assert.equal(bad.lifetime.retainsTask, true);
    t.diagnostic(JSON.stringify({ profiles: measurements, conservativeCeilingAttemptedBytes: ceilingBytes,
        journalLimit:8192,evidenceLimit:7680,footerLimit:512,realProcesses:0 }));
});

test("exact cleanup refuses extra files and changed identities before deleting any leaf", WINDOWS_PATH_TEST_OPTIONS, async () => {
    const files = memoryFiles(); files.add("volume-native.dll", 22016); files.add("lifecycle.json", 200);
    const manifest = snapshotSessionFiles(root, rootId, files.io);
    files.add("user-file.txt", 1); assert.throws(() => removeSessionFiles(root, rootId, manifest, files.io), /Unexpected task file/);
    assert.equal(files.removed.length, 0); files.entries.delete(path.join(root, "user-file.txt"));
    files.add("volume-native.dll", 22016); assert.throws(() => removeSessionFiles(root, rootId, manifest, files.io), /manifest changed/);
    assert.equal(files.removed.length, 0);
    const f = basic(); f.files.add("user-file.txt", 1); await f.complete(); assert.equal(f.files.removed.length, 0);
    assert.equal(f.report.retained, true); assert.equal(f.report.outputBoundFailed, false); assert.equal(f.lifetime.retainsTask, true);
    const image = full(); assert.equal(await image.exercise(), true); image.files.add("task.vhd", 134218240);
    await image.complete(); assert.equal(image.files.removed.length, 0); assert.equal(image.report.artifactsRemoved, false);
    assert.match(image.report.cleanupError, /Unexpected task file/); // Native release must already have deleted the image; never delete it here.
    const partial = full(); assert.equal(await partial.exercise(), true);
    const unlink = partial.files.io.unlinkSync;
    partial.files.io.unlinkSync = file => { if (path.basename(file) === "volume-helper.json") throw Error("injected leaf deletion failure"); unlink(file); };
    await partial.complete();
    assert.equal(partial.report.removedFiles, 2); assert.deepEqual(partial.files.removed, ["volume-native.dll", "volume-guest-read.json"]);
    assert.equal(partial.files.entries.has(path.join(root, "lifecycle.json")), true); assert.equal(partial.report.artifactsRemoved, false);
    assert.equal(partial.report.retained, true); assert.equal(partial.state.disposes, 0); assert.equal(partial.lifetime.retainsTask, true);
    assert.equal(JSON.parse(partial.state.writes.at(-1).text).removedFiles, 2);
    const directory = full(); await directory.exercise(); directory.files.io.rmdirSync = () => { throw Error("injected final rmdir failure"); };
    await directory.complete(); assert.equal(directory.report.removedFiles, 4); assert.equal(directory.files.entries.size, 1);
    assert.equal(directory.files.entries.has(path.join(root, "lifecycle.json")), false); assert.equal(directory.report.artifactsRemoved, false);
    assert.equal(JSON.parse(directory.state.writes.at(-1).text).removedFiles, 4); assert.equal(directory.lifetime.retainsTask, true);
});
