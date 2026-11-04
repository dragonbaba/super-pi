import { WINDOWS_PATH_TEST_OPTIONS } from "./helpers/windows-sandbox-prerequisites.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { EventEmitter } from "node:events";
import { SandboxLifecycle, CLI_SHA256, UndispatchedError } from "../scripts/acceptance/windows-sandbox-lifecycle.mjs";
import { TaskVolumeOwner } from "../scripts/acceptance/windows-sandbox-volume.mjs";
import { LiveSandboxRuntime } from "../scripts/acceptance/windows-sandbox-volume-sharing.mjs";
import { SharingLifetime, sessionJournal, completeSharingSession, snapshotSessionFiles, removeSessionFiles } from "../scripts/acceptance/windows-sandbox-volume-session.mjs";
import { volumeSnapshot, vmSnapshot, vmQuiescent, preflightSnapshot } from "../scripts/acceptance/windows-sandbox-volume-share.mjs";
import { capacityReport, capacityHelpers, exerciseCapacity, capacityCommand } from "../scripts/acceptance/windows-sandbox-volume-capacity.mjs";
import { capacitySourceManifest, CAPACITY_SOURCES, capacityCliGuard } from "../scripts/acceptance/windows-sandbox-volume-capacity-acceptance.mjs";
const taskId = "11111111-2222-3333-4444-555555555555", root = "D:\\synthetic\\capacity", rootId = "1:1";
const volumePath = "\\\\?\\Volume{aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee}\\", exchangeId = "AABBCCDD:0000000000000002", digest = "a".repeat(64);
const tick = () => new Promise(resolve => setImmediate(resolve)), allowed = { owner: null, validate: () => true };
function result(stdout = "{}") { return { exitCode: 0, signal: null, launchError: null, truncated: false, stdout, stderr: "", stdoutSeen: Buffer.byteLength(stdout), stderrSeen: 0, closedUtc: "2026-11-01T00:00:00.000Z" }; }
class Call extends EventEmitter { constructor(pid, value = result()) { super(); this.pid = pid; this.result = value; } async wait() { return this.result ? "settled" : "timeout"; } }
function receipt(stage) {
    const bytes = Buffer.alloc(512); bytes.write("SPCF0001"); bytes.write(taskId.replaceAll("-", ""), 8);
    for (const [offset, value] of [[40, 3], [44, 1], [48, 2], [52, 1], [56, 2097152], [60, 1048576], [72, 1], [80, 112], [84, 1048576],
        [92, 1], [96, 1], [112, 1], [116, 1], [180, 1048576], [184, 144], [188, 20000], [192, 1], [196, 1]]) bytes.writeUInt32LE(value, offset);
    return { protocol: "super-pi-volume-capacity-v1", stage, taskId, volumePath, exchangeId, probeSha256: digest, installed: true, readCompleted: stage === "read",
        probeId: "AABBCCDD:0000000000000003", slotId: "AABBCCDD:0000000000000004", sentinelId: "11223344:0000000000000002",
        fillId: stage === "read" ? "AABBCCDD:0000000000000005" : null, fillLength: stage === "read" ? 1048576 : 0, fillAllocation: stage === "read" ? 1048576 : 0,
        resultBase64: stage === "read" ? bytes.toString("base64") : null, sentinelMatched: stage === "read", opened: stage === "read" ? 9 : 5, closed: stage === "read" ? 9 : 5,
        peak: 3, closeErrors: Array(9).fill(null), retainedHandles: Array(9).fill(null), closeUnknown: false };
}
function memory() {
    const entries = new Map([[root, { ino: 1n, size: 0n, directory: true }]]), removed = []; let ino = 10n;
    const add = (name, bytes) => entries.set(path.join(root, name), { ino: ino++, size: BigInt(bytes), directory: false });
    const io = { realpathSync(file) { assert.ok(entries.has(file)); return file; }, lstatSync(file) { const value = entries.get(file); assert.ok(value, file);
        return { ...value, dev: 1n, nlink: 1n, isDirectory: () => value.directory, isFile: () => !value.directory, isSymbolicLink: () => false }; },
        readdirSync(directory) { assert.equal(directory, root); return [...entries.keys()].filter(file => file !== root).map(file => path.basename(file)); },
        unlinkSync(file) { assert.ok(entries.delete(file)); removed.push(path.basename(file)); }, rmdirSync(directory) { assert.equal(entries.size, 1); assert.ok(entries.delete(directory)); } };
    return { entries, add, removed, io };
}
function basic(profile = "capacity") {
    const files = memory(), report = capacityReport(taskId, root, rootId), bus = new EventEmitter(), stream = new EventEmitter();
    const state = { writes: [], holds: new Set(), disposed: 0, onJournal: null, journalPeak: 0 };
    const task = { vm: undefined, cancel() {}, unsafe() {}, quiescent: () => true, dispose() { state.disposed++; } };
    const save = sessionJournal({ journal(value) { state.onJournal?.(value); const bytes = Buffer.byteLength(JSON.stringify(value, null, 2));
        state.journalPeak = Math.max(state.journalPeak, bytes); files.add("lifecycle.json", bytes); } }, report, () => task.unsafe());
    stream.write = (text, done) => { state.writes.push({ text, done }); done(); return true; };
    const timers = { setInterval(callback, ms) { assert.equal(ms, 60000); const handle = { callback }; state.holds.add(handle); return handle; }, clearInterval(handle) { state.holds.delete(handle); } };
    const lifetime = new SharingLifetime({ bus, stream, report, save, task, timers, profile });
    return { files, report, bus, stream, state, task, save, lifetime, complete: () => completeSharingSession({ report, task, lifetime, save, root, rootId, io: files.io }) };
}
function full(mode) {
    const f = basic(), controller = new AbortController(), runtime = new LiveSandboxRuntime(taskId); let pid = 100;
    f.task.runtime = runtime; f.task.cancel = () => { controller.abort(); f.task.volume?.revoke(); }; f.task.unsafe = () => { controller.abort(); f.task.volume?.onUnsafe(); };
    f.files.add("volume-native.dll", 49152); f.files.add("capacity-probe.exe", 19456);
    const bundle = capacitySourceManifest(name => Buffer.from(name)); f.report.sources = { bundleSha256: bundle.sha256, files: 24, nativeSha256: digest, guestSha256: digest,
        powershellSha256: digest, compilerSha256: digest, cliSha256: digest, nodeVersion: "v26.13.0", nodeSha256: digest };
    f.report.preflight = preflightSnapshot({ protocol: "super-pi-native-preflight-v1", powershell: "7.6.9", x64: true, administratorToken: true,
        privilege: "SeManageVolumePrivilege", privilegeState: "Enabled", storageVersion: "2.0.0.0", commands: 7, format: "NTFS", requiredBytes: 168820736, availableBytes: Number.MAX_SAFE_INTEGER });
    const helpers = [];
    for (const [index, kind] of ["preflight", "compile", "compile"].entries()) {
        const call = f.lifetime.launch(kind, () => new Call(++pid)); helpers.push({ executable: index ? "csc.exe" : "pwsh.exe", pid: call.pid, outcome: "settled", killRequested: false, result: call.result });
    }
    f.report.helperCalls = capacityHelpers(helpers);
    const driver = new EventEmitter(); Object.assign(driver, { pid: ++pid, physicallyClosed: false, pending: false, calls: [], setUnsafeHandler(callback) { this.unsafe = callback; } });
    driver.command = async (command, observe) => {
        driver.calls.push(command); const released = command === "release" || command === "exit";
        if (command === "prepare") f.files.add("task.vhd", 134218240);
        if (command === "install-capacity") { f.files.add("capacity-host-sentinel.bin", 32); f.files.add("volume-capacity-install.json", 1400); }
        if (command === "read-capacity") f.files.add("volume-capacity-read.json", 2200);
        if (command === "release") assert.ok(f.files.entries.delete(path.join(root, "task.vhd")));
        f.files.add("volume-helper.json", 600);
        const value = { taskId, diskId: taskId, imageCreated: true, imageId: "11223344:0000000000000001", physicalPath: "\\\\.\\PhysicalDrive77", volumePath, exchangeId,
            capacity: 134217728, imageBudget: 135266304, phase: released ? "released" : "prepared-not-share-admitted", error: null, detached: released, managementClosed: released, closeUnknown: false };
        observe(value); return value;
    };
    driver.waitClosed = async () => { driver.physicallyClosed = true; driver.emit("settled"); return true; };
    f.lifetime.launch("manager", () => driver); f.task.driver = driver;
    const volume = new TaskVolumeOwner({ driver, taskId, readRuntime: runtime.read, journal(value) { f.report.volume = volumeSnapshot(value); f.save(); },
        revokeCandidates() { f.report.revoked = true; }, cancelExecution() { controller.abort(); } }); f.task.volume = volume;
    f.task.quiescent = () => vmQuiescent(f.task) && volume.state === "released" && driver.physicallyClosed && !driver.pending;
    f.task.dispose = () => { runtime.dispose(); f.task.vm = undefined; f.task.volume = undefined; f.task.driver = undefined; f.task.installation = undefined; f.state.disposed++; };
    const ids = new Set(), calls = [], factories = [];
    const cli = { launch(args, authorization) { calls.push(args); const kind = args[0]; return f.lifetime.launch(kind, () => {
        factories.push(kind); if (kind === "start") ids.add(args[2]); if (kind === "stop") ids.delete(args[2]);
        const text = kind === "list" ? JSON.stringify({ WindowsSandboxEnvironments: [...ids].map(Id => ({ Id })) }) : kind === "exec" ? JSON.stringify({ ExitCode: mode === "delivery-failed" ? 72 : 0 }) : "{}";
        return new Call(++pid, mode === "pending-exec" && kind === "exec" ? null : result(text));
    }, authorization); } };
    return { ...f, runtime, driver, volume, calls, factories, controller, exercise: () => exerciseCapacity(f.task, f.report, controller.signal,
        config => new SandboxLifecycle({ cli, config, taskId, journal(value) { f.report.vm = vmSnapshot(value); f.save(); } }),
        stage => { const value = receipt(stage); if (mode === "close-unknown" && stage === "read") { value.closeUnknown = true; value.readCompleted = false; value.closed = 8; value.retainedHandles[8] = "66"; }
            f.report.privateReceipts = { opened: stage === "read" ? 2 : 1, closed: stage === "read" ? 2 : 1, active: 0, peak: 1, bytesRead: stage === "read" ? 3600 : 1400, bytesAllocated: stage === "read" ? 3600 : 1400 }; return value; }, digest) };
}
test("capacity composed sequence completes one fill command, preserves raw report and cleans seven exact leaves", WINDOWS_PATH_TEST_OPTIONS, async t => {
    const f = full(), passed = await f.exercise(); assert.equal(passed, true, JSON.stringify({ error: f.report.error, cleanupError: f.report.cleanupError,
        journalFailed: f.report.journalFailed, journalPeak: f.state.journalPeak, volumeState: f.volume.state, managerCalls: f.driver.calls }));
    assert.deepEqual(f.driver.calls, ["prepare", "install-capacity", "verify", "verify", "read-capacity", "release", "exit"]);
    assert.deepEqual(f.calls.map(value => value[0]), ["list", "start", "list", "exec", "list", "stop", "list"]);
    assert.equal(f.calls.find(value => value[0] === "exec")[4], capacityCommand(taskId)); assert.throws(() => capacityCommand(taskId + "\n"));
    assert.equal(f.report.capacityRead.guestBytes.data.length, 684); assert.equal(f.report.capacityCandidate, true);
    f.stream.write = (text, done) => { f.state.writes.push({ text, done }); return false; };
    const completing = f.complete(); assert.equal(f.files.removed.length, 0); f.state.writes[0].done(); await tick();
    assert.equal(f.report.artifactsRemoved, true); assert.equal(f.state.disposed, 1); assert.equal(f.lifetime.retainsTask, true);
    f.state.writes[1].done(); await completing; await tick();
    assert.equal(f.files.removed.length, 7); assert.equal(f.files.removed.at(-1), "lifecycle.json"); assert.equal(f.files.entries.size, 0);
    assert.equal(f.report.passed, true); assert.equal(f.lifetime.retainsTask, false); assert.equal(f.runtime.retainsOwner, false);
    assert.equal(f.bus.listenerCount("SIGINT"), 0); assert.equal(f.stream.listenerCount("error"), 0); assert.equal(f.state.holds.size, 0);
    t.diagnostic(JSON.stringify({ cli: 7, managerCommands: 7, physicalObjects: 11, removedFiles: 7, outputWrites: 2, journalPeak: f.state.journalPeak,
        mainBytes: Buffer.byteLength(f.state.writes[0].text), footerBytes: Buffer.byteLength(f.state.writes[1].text), realOperations: 0 }));
});
test("capacity final exec guard rejects replaced installation or standalone volume revocation", async () => {
    for (const mode of ["installation", "revoke"]) {
        const f = full(); let injected = false;
        f.state.onJournal = value => { if (!injected && value.physical?.pending.at(-1)?.kind === "exec") { injected = true;
            if (mode === "installation") f.task.installation = { ...f.task.installation }; else f.volume.revoke(); } };
        assert.equal(await f.exercise(), false); assert.equal(injected, true); assert.equal(f.factories.includes("exec"), false);
        assert.equal(f.report.physical.notStarted, 1); assert.equal(f.report.sequencePassed, false);
        await f.complete(); await tick(); assert.equal(f.report.passed, false);
    }
});
test("failed delivery retains diagnostic data while unknown closes or pending exec retain owned resources", WINDOWS_PATH_TEST_OPTIONS, async () => {
    const delivered = full("delivery-failed"); assert.equal(await delivered.exercise(), false); assert.ok(delivered.report.capacityRead.guestBytes.data);
    assert.equal(delivered.report.guestExit.deliveryComplete, false); await delivered.complete(); await tick(); assert.equal(delivered.report.artifactsRemoved, true); assert.equal(delivered.report.passed, false);
    for (const mode of ["close-unknown", "pending-exec"]) {
        const f = full(mode); assert.equal(await f.exercise(), false); await f.complete();
        assert.equal(f.driver.calls.includes("release"), false); assert.equal(f.files.removed.length, 0); assert.equal(f.lifetime.retainsTask, true); assert.equal(f.state.holds.size, 1);
    }
});
test("capacity quotas are three helpers plus one manager plus 95 CLI, with no fifth unresolved factory", WINDOWS_PATH_TEST_OPTIONS, async () => {
    const f = basic(); let factories = 0;
    for (const kind of ["preflight", "compile", "compile", "manager"]) f.lifetime.launch(kind, () => new Call(++factories));
    for (let i = 0; i < 95; i++) f.lifetime.launch("list", () => new Call(++factories));
    for (const kind of ["list", "compile", "manager"]) assert.throws(() => f.lifetime.launch(kind, () => { factories++; }));
    assert.equal(factories, 99); assert.equal(f.report.physical.reservations, 99); await f.complete(); await tick(); assert.equal(f.lifetime.retainsTask, false);
    const pending = basic(); let count = 0;
    for (const kind of ["manager", "start", "exec", "stop"]) pending.lifetime.launch(kind, () => new Call(++count, null), allowed);
    assert.throws(() => pending.lifetime.launch("list", () => { count++; })); assert.equal(count, 4);
    const legacy = basic("sharing"); legacy.lifetime.launch("preflight", () => new Call(1)); legacy.lifetime.launch("compile", () => new Call(2));
    assert.throws(() => legacy.lifetime.launch("compile", () => { throw Error("must not reach"); }), /budget/);
    await legacy.complete(); await tick(); assert.equal(legacy.lifetime.retainsTask, false);
    const integrated = basic(); let physical = 0;
    const cli = { launch() { return integrated.lifetime.launch("list", () => new Call(++physical)); } };
    const vm = new SandboxLifecycle({ cli, taskId, config: "<Configuration/>", journal(value) { integrated.report.vm = vmSnapshot(value); integrated.save(); } });
    integrated.task.vm = vm;
    for (let i = 0; i < 95; i++) await vm.invoke("list", ["list", "--raw"], 1);
    await assert.rejects(vm.invoke("list", ["list", "--raw"], 1), UndispatchedError);
    assert.equal(physical, 95); assert.equal(vm.calls.length, 95); assert.equal(integrated.report.vm.callRecords, 95);
    integrated.lifetime.snapshot(); assert.equal(integrated.report.physical.cliRecords, 95);
    await integrated.complete(); await tick(); assert.equal(integrated.report.artifactsRemoved, true); assert.equal(integrated.lifetime.retainsTask, false);
});
test("capacity cleanup requires the fixed profile and refuses an extra image or changed leaf", WINDOWS_PATH_TEST_OPTIONS, () => {
    const f = memory(); f.add("volume-native.dll", 100); f.add("capacity-probe.exe", 100); f.add("capacity-host-sentinel.bin", 32); f.add("lifecycle.json", 100);
    assert.throws(() => snapshotSessionFiles(root, rootId, f.io)); const manifest = snapshotSessionFiles(root, rootId, f.io, "capacity");
    f.add("task.vhd", 134218240); assert.throws(() => removeSessionFiles(root, rootId, manifest, f.io, {}, "capacity")); f.entries.delete(path.join(root, "task.vhd"));
    f.add("capacity-probe.exe", 100); assert.throws(() => removeSessionFiles(root, rootId, manifest, f.io, {}, "capacity")); assert.equal(f.removed.length, 0);
    const current = snapshotSessionFiles(root, rootId, f.io, "capacity"); assert.equal(removeSessionFiles(root, rootId, current, f.io, {}, "capacity"), 4);
    assert.equal(f.entries.size, 0);
});
test("capacity bundle closes static imports and final CLI source guard runs after reservation", WINDOWS_PATH_TEST_OPTIONS, async () => {
    const bundle = capacitySourceManifest(name => Buffer.from(name)); assert.equal(bundle.manifest.files.length, 27); assert.equal(new Set(CAPACITY_SOURCES).size, 27);
    const directory = fileURLToPath(new URL("../scripts/acceptance/", import.meta.url));
    for (const name of CAPACITY_SOURCES.filter(name => name.endsWith(".mjs"))) for (const match of fs.readFileSync(path.join(directory, name), "utf8").matchAll(/^import .+ from "\.\/(.+)";/gm))
        assert.ok(CAPACITY_SOURCES.includes(match[1]), name + " -> " + match[1]);
    for (const mode of ["source", "cli", "permission", "valid"]) {
        const f = basic(); let factories = 0, reserved = false;
        f.state.onJournal = value => { if (value.physical?.pending.at(-1)?.kind === "exec") reserved = true; };
        const guard = capacityCliGuard(f.task, bundle.sha256, { owner: f.task, validate: owner => owner === f.task && mode !== "permission" }, {
            capacitySourceManifest() { assert.equal(reserved, true); return { sha256: mode === "source" ? "0".repeat(64) : bundle.sha256 }; },
            hashFile() { return mode === "cli" ? "0".repeat(64) : CLI_SHA256; } });
        const launch = () => f.lifetime.launch("exec", () => { factories++; return new Call(1); }, guard);
        if (mode === "valid") launch(); else assert.throws(launch); assert.equal(factories, mode === "valid" ? 1 : 0);
        await f.complete(); await tick(); assert.equal(f.lifetime.retainsTask, false);
    }
});
