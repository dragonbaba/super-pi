import { WINDOWS_PATH_TEST_OPTIONS } from "./helpers/windows-sandbox-prerequisites.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import { SandboxLifecycle, CLI_SHA256 } from "../scripts/acceptance/windows-sandbox-lifecycle.mjs";
import { volumeProfileArguments } from "../scripts/acceptance/windows-sandbox-volume.mjs";
import { PrivateCandidateChannel, nativePrivateIdentity } from "../scripts/acceptance/windows-sandbox-volume-candidate-private.mjs";
import { CANDIDATE_PROTOCOL } from "../scripts/acceptance/windows-sandbox-candidates.mjs";
import { SharingLifetime, sessionJournal, completeSharingSession, snapshotSessionFiles, removeSessionFiles } from "../scripts/acceptance/windows-sandbox-volume-session.mjs";
import { vmSnapshot, preflightSnapshot, helperSnapshots } from "../scripts/acceptance/windows-sandbox-volume-share.mjs";
import { candidateReport, candidateTask, exerciseCandidates, candidateCommand, CANDIDATE_TEXT, CANDIDATE_NORMAL_FILES } from "../scripts/acceptance/windows-sandbox-volume-candidate-session.mjs";
import { candidateSourceManifest, CANDIDATE_SOURCES, candidateCliGuard, requireNormalCandidateFiles } from "../scripts/acceptance/windows-sandbox-volume-candidate-acceptance.mjs";
const taskId = "11111111-2222-3333-4444-555555555555", snapshotId = "22222222-3333-4444-5555-666666666666";
const root = "D:\\RMProjects\\Pi\\.artifacts\\windows-sandbox-acceptance-owner", rootId = "3938676073:18446744073709551615",
    privateRootId = "EAC36D69:FFFFFFFFFFFFFFFF", digest = "a".repeat(64);
const volumePath = "\\\\?\\Volume{aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee}\\", exchangeId = "AABBCCDD:0000000000000002";
const tick = () => new Promise(resolve => setImmediate(resolve)), hash = value => createHash("sha256").update(value).digest("hex");
const encode = value => Buffer.from(JSON.stringify(value));
function callResult(stdout = "{}") { return { exitCode: 0, signal: null, launchError: null, truncated: false,
    stdout, stderr: "", stdoutSeen: Buffer.byteLength(stdout), stderrSeen: 0, closedUtc: "2026-11-01T00:00:00.000Z" }; }
class Call extends EventEmitter {
    constructor(pid, result = callResult()) { super(); this.pid = pid; this.result = result; }
    async wait() { return this.result ? "settled" : "timeout"; }
}
function memory() {
    const entries = new Map([[root, { ino: 0xffffffffffffffffn, size: 0n, directory: true }]]), fds = new Map(), removed = [], borrowed = [];
    let nextIno = 0x0009000000124300n, nextFd = 2147483000; const state = { closeUnknown: false, closes: 0 };
    function add(name, value) {
        const bytes = Buffer.isBuffer(value) ? value : undefined, size = BigInt(bytes?.length ?? value);
        const node = { ino: nextIno++, size, bytes, directory: false, time: 1n }; entries.set(path.join(root, name), node); return node;
    }
    function get(file) { const node = entries.get(file); if (!node) throw Object.assign(Error("absent"), { code: "ENOENT" }); return node; }
    function stat(node) { return { dev: 3938676073n, ino: node.ino, size: node.size, nlink: 1n, mtimeNs: node.time ?? 1n, ctimeNs: node.time ?? 1n,
        isFile: () => !node.directory, isDirectory: () => !!node.directory, isSymbolicLink: () => false }; }
    const io = {
        realpathSync(file) { get(file); return file; }, lstatSync(file) { return stat(get(file)); },
        readdirSync(file) { assert.equal(file, root); return [...entries.keys()].filter(key => key !== root).map(key => path.basename(key)); },
        openSync(file, flags) {
            if (flags === "wx") { assert.equal(entries.has(file), false); add(path.basename(file), Buffer.alloc(0)); }
            else assert.equal(flags, "r");
            const fd = nextFd++; fds.set(fd, get(file)); return fd;
        },
        fstatSync(fd) { assert.ok(fds.has(fd)); return stat(fds.get(fd)); },
        readSync(fd, bytes, offset, length, position) { borrowed.push(bytes); return fds.get(fd).bytes.copy(bytes, offset, position, position + length); },
        writeSync(fd, bytes, offset, length, position) {
            assert.equal(position, 0); const node = fds.get(fd); borrowed.push(bytes);
            node.bytes = Buffer.from(bytes.subarray(offset, offset + length)); node.size = BigInt(length); node.time = 2n; return length;
        },
        fsyncSync(fd) { assert.ok(fds.has(fd)); },
        closeSync(fd) { state.closes++; if (state.closeUnknown) throw Error("private close unknown"); assert.ok(fds.delete(fd)); },
        unlinkSync(file) { const node = get(file); node.bytes?.fill(0); assert.ok(entries.delete(file)); removed.push(path.basename(file)); },
        rmdirSync(file) { assert.equal(entries.size, 1); assert.equal(file, root); assert.ok(entries.delete(file)); },
    };
    return { entries, fds, removed, borrowed, add, get, stat, io, state };
}
function fixture(mode = "normal") {
    const files = memory(), controller = new AbortController(), report = candidateReport(taskId, snapshotId, root, rootId);
    const task = candidateTask(report, controller), runtime = task.runtime, bus = new EventEmitter(), stream = new EventEmitter();
    const state = { journalPeak: 0, writes: [], holds: new Set(), onJournal: null, nativeCommands: [], cliCommands: [], factories: [], captured: null, channel: null,
        registeredVerifies: 0, onRegisteredVerify: null, resumeVerify: null };
    const save = sessionJournal({ journal(value) {
        state.onJournal?.(value); const size = Buffer.byteLength(JSON.stringify(value, null, 2));
        state.journalPeak = Math.max(state.journalPeak, size); files.add("lifecycle.json", size);
    } }, report, () => task.unsafe());
    stream.write = (text, done) => { state.writes.push({ text, done }); done(); return true; };
    const timers = { setInterval(callback, ms) { assert.equal(ms, 60000); const ref = { callback }; state.holds.add(ref); return ref; },
        clearInterval(ref) { assert.ok(state.holds.delete(ref)); } };
    const lifetime = new SharingLifetime({ bus, stream, task, save, report, timers, profile: "candidate" }); let pid = 2147483000;
    report.sources = { bundleSha256: digest, files: 25, nativeSha256: digest, powershellSha256: digest,
        compilerSha256: digest, cliSha256: digest, nodeVersion: "v26.13.0", nodeSha256: digest };
    report.preflight = preflightSnapshot({ protocol: "super-pi-native-preflight-v1", powershell: "7.6.9", x64: true, administratorToken: true,
        privilege: "SeManageVolumePrivilege", privilegeState: "Enabled", storageVersion: "2.0.0.0", commands: 7,
        format: "NTFS", requiredBytes: 168820736, availableBytes: Number.MAX_SAFE_INTEGER });
    const helpers = [];
    for (const [index, kind] of ["preflight", "compile"].entries()) {
        const call = lifetime.launch(kind, () => new Call(++pid, callResult(index ? "" : JSON.stringify({ protocol: "super-pi-native-preflight-v1", ...report.preflight }))));
        helpers.push({ executable: index ? "C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe" : "D:\\PowerShell\\7\\pwsh.exe",
            pid: call.pid, outcome: "settled", killRequested: false, result: call.result });
    }
    report.helperCalls = helperSnapshots(helpers); task.helpers = { active: false, calls: helpers, persist() {}, launch() {} };
    files.add("volume-native.dll", 65536);
    let guestManifest, guestPayload;
    const driver = new EventEmitter();
    Object.assign(driver, { pid: ++pid, physicallyClosed: false, pending: false, setUnsafeHandler(fn) { this.unsafe = fn; } });
    let terminal = false;
    Object.defineProperty(driver, "diagnostics", { get() {
        const text = terminal ? "A".repeat(1366) + "==" : ""; // Full 1024-byte uninterpreted stderr capacity, base64 encoded.
        return { exitCode: driver.physicallyClosed ? 0 : null, signal: null, buffersReleased: driver.physicallyClosed,
            stderr: { encoding: "uninterpreted", rawBase64: text, seenBytes: terminal ? 1024 : 0, capturedBytes: terminal ? 1024 : 0, truncated: false } };
    } });
    function captureReceipt(stage, node) {
        const value = { protocol: "super-pi-candidate-capture-v1", stage, taskId, volumePath, exchangeId,
            carrierId: nativePrivateIdentity(files.stat(node)), bytes: Number(node.size), sha256: hash(node.bytes),
            handles: { opened: stage === "manifest" ? 3 : 5, closed: stage === "manifest" ? 3 : 5,
                peak: stage === "manifest" ? 2 : 4, closeUnknown: false, retained: [] } };
        if (stage === "manifest") value.sourceId = "AABBCCDD:0000000000000003";
        else { value.requestSha256 = hash(files.get(path.join(root, "candidate-request.json")).bytes);
            value.items = [["AABBCCDD:0000000000000004", Number(node.size), hash(node.bytes)]]; }
        return encode(value);
    }
    driver.command = async (command, observe) => {
        state.nativeCommands.push(command); driver.pending = true;
        try {
            const registeredVerify = command === "verify" && task.vm?.state === "registered-not-guest-ready";
            if (registeredVerify) {
                state.registeredVerifies++;
                if (mode === "verify-pending") await new Promise(resolve => { state.resumeVerify = resolve; state.onRegisteredVerify?.(); });
                else state.onRegisteredVerify?.();
            }
            const released = command === "release" || command === "exit";
            if (command === "prepare") files.add("task.vhd", 134218240);
            if (command === "read-candidate-manifest") {
                assert.equal(task.vm.state, "closed"); assert.equal(runtime.read().callsClosed, true);
                if (mode === "error-receipt-missing" || mode === "error-receipt-partial") {
                    if (mode === "error-receipt-partial") files.add("candidate-manifest-error.json", Buffer.from("partial"));
                    terminal = true; driver.unsafe(); throw Error("candidate receipt delivery terminal");
                }
                if (mode === "native-failure") files.add("candidate-manifest-error.json", encode({ capture: "known-closed-failure" }));
                else if (mode !== "error-receipt-missing" && mode !== "native-unknown") {
                    const node = files.add("candidate-manifest.bin", Buffer.from(guestManifest));
                    const receipt = captureReceipt("manifest", node);
                    files.add("candidate-manifest-receipt.json", mode === "bad-receipt" ? Buffer.from("{") : receipt);
                }
            }
            if (command === "read-candidate-batch") {
                const request = JSON.parse(files.get(path.join(root, "candidate-request.json")).bytes);
                assert.equal(request.manifestSha256, hash(guestManifest)); assert.deepEqual(request.paths, ["a.txt"]);
                const node = files.add("candidate-payload.bin", Buffer.from(guestPayload));
                if (mode === "batch-receipt-partial") {
                    files.add("candidate-batch-receipt.json", Buffer.from("partial"));
                    terminal = true; driver.unsafe(); throw Error("batch success receipt delivery terminal");
                }
                files.add("candidate-batch-receipt.json", captureReceipt("batch", node));
            }
            if (command === "release") assert.ok(files.entries.delete(path.join(root, "task.vhd")));
            files.add("volume-helper.json", 600);
            const failed = command === "read-candidate-manifest" && ["native-failure", "error-receipt-missing", "native-unknown"].includes(mode);
            const value = { taskId, diskId: taskId, imageCreated: true, imageId: "EAC36D69:00090000001242FF", physicalPath: "\\\\.\\PhysicalDrive77",
                volumePath, exchangeId, capacity: 134217728, imageBudget: 135266304,
                phase: released ? "released" : failed ? "blocked" : "prepared-not-share-admitted",
                error: failed ? "storage-operation-failed" : null, detached: released, managementClosed: released, closeUnknown: mode === "native-unknown" && failed };
            if (registeredVerify && mode === "verify-identity") value.exchangeId = "AABBCCDD:0000000000000099";
            if (registeredVerify && mode === "verify-failure") value.error = "storage-operation-failed";
            observe(value); return value;
        } finally { driver.pending = false; }
    };
    driver.waitClosed = async () => { driver.physicallyClosed = true; driver.emit("settled"); return true; };
    lifetime.launch("manager", () => driver); task.attach(driver, save);
    const volume = task.volume, ids = new Set();
    const cli = { launch(args, authorization) {
        state.cliCommands.push(args);
        return lifetime.launch(args[0], () => {
            state.factories.push(args[0]);
            if (args[0] === "start") ids.add(args[2]); if (args[0] === "stop") ids.delete(args[2]);
            if (args[0] === "exec") {
                assert.equal(state.registeredVerifies, 1);
                assert.equal(args[4], candidateCommand(taskId, snapshotId));
                assert.equal(args[5], "-d"); assert.equal(args[6], "C:\\SuperPiVolume");
                guestManifest = Buffer.from(JSON.stringify({ protocol: CANDIDATE_PROTOCOL, taskId, snapshotId,
                    candidates: [{ path: "a.txt", operation: "add" }], report: { exitCode: 23 } }) + (mode === "manifest-crlf" ? "\r\n" : ""));
                guestPayload = Buffer.from(CANDIDATE_TEXT);
                if (mode === "high-bit") guestPayload[0] |= 128;
            }
            const stdout = args[0] === "list" ? JSON.stringify({ WindowsSandboxEnvironments: [...ids].map(Id => ({ Id })) })
                : args[0] === "exec" ? JSON.stringify({ ExitCode: mode === "guest-failure" ? 1 : 0 }) : "{}";
            return new Call(++pid, args[0] === "exec" && mode === "pending-exec" ? null : callResult(stdout));
        }, authorization);
    } };
    return { files, controller, report, task, runtime, volume, driver, state, lifetime, bus, stream, save,
        async exercise() {
            const read = volume.readCandidatesOnce;
            volume.readCandidatesOnce = async (...args) => state.captured = await Reflect.apply(read, volume, args);
            const passed = await exerciseCandidates(task, report, controller.signal,
                config => new SandboxLifecycle({ cli, config, taskId, journal(value) { report.vm = vmSnapshot(value); save(); } }),
                current => { files.state.closeUnknown = mode === "private-unknown";
                    return state.channel = new PrivateCandidateChannel({ owner: current.volume, vm: current.vm, taskId, root, rootId: privateRootId, volumePath, exchangeId }, files.io); });
            if (passed) requireNormalCandidateFiles(snapshotSessionFiles(root, rootId, files.io, "candidate"));
            guestManifest?.fill(0); guestPayload?.fill(0); return passed;
        },
        complete: () => completeSharingSession({ report, task, lifetime, save, root, rootId, io: files.io }),
    };
}

test("candidate normal composition captures real core bytes after volume release and cleans eight fixed leaves", WINDOWS_PATH_TEST_OPTIONS, async t => {
    const f = fixture(); assert.equal(await f.exercise(), true, JSON.stringify({ error: f.report.error, cleanup: f.report.cleanupError, peak: f.state.journalPeak }));
    assert.deepEqual(f.state.nativeCommands, ["prepare", "verify", "verify", "verify", "read-candidate-manifest", "read-candidate-batch", "release", "exit"]);
    assert.equal(f.state.registeredVerifies, 1);
    assert.deepEqual(f.state.factories, ["list", "start", "list", "exec", "list", "stop", "list"]);
    assert.equal(f.report.candidate.guest.exitCode, 23); assert.equal(f.report.guestExit.exitCode, 0);
    assert.deepEqual(f.report.candidate.native, { manifest: { opened: 3, closed: 3, peak: 2, closeUnknown: false },
        batch: { opened: 5, closed: 5, peak: 4, closeUnknown: false } });
    assert.equal(Object.isFrozen(f.report.candidate.native.manifest), true); assert.equal(Object.isFrozen(f.report.candidate.native.batch), true);
    assert.equal(f.report.candidate.matchedAfterRelease, true); assert.equal(f.report.candidate.buffersReleased, true);
    assert.equal(f.report.candidateIo.opened, 5); assert.equal(f.report.candidateIo.closed, 5); assert.equal(f.report.candidateIo.peak, 1);
    assert.equal(f.report.candidateIo.calls, 64); assert.equal(f.report.candidateIo.rows.length, 5);
    for (const bytes of f.files.borrowed) assert.equal(bytes.every(value => value === 0), true);
    assert.equal(f.volume.candidateDiagnostics.candidateHeld, false);
    f.stream.write = (text, done) => { f.state.writes.push({ text, done }); return false; };
    const finishing = f.complete(); assert.equal(f.files.removed.length, 0); f.state.writes[0].done(); await tick();
    assert.equal(f.report.artifactsRemoved, true); assert.equal(f.lifetime.retainsTask, true); f.state.writes[1].done(); await finishing; await tick();
    assert.equal(f.report.passed, true); assert.equal(f.files.removed.length, 8); assert.equal(f.files.removed.at(-1), "lifecycle.json");
    assert.equal(f.files.entries.size, 0); assert.equal(f.files.fds.size, 0); assert.equal(f.lifetime.retainsTask, false);
    assert.equal(f.runtime.retainsOwner, false); assert.equal(f.task.volume, undefined); assert.equal(f.task.channel, undefined);
    assert.equal(f.state.channel.diagnostics.contextHeld, false); assert.equal(f.bus.listenerCount("SIGINT"), 0);
    assert.equal(f.stream.listenerCount("error"), 0); assert.equal(f.state.holds.size, 0);
    t.diagnostic(JSON.stringify({ cli: 7, managerCommands: 8, physicalObjects: 10, filesRemoved: 8, privateOpened: 5, privatePeak: 1,
        journalPeak: f.state.journalPeak, mainBytes: Buffer.byteLength(f.state.writes[0].text), footerBytes: Buffer.byteLength(f.state.writes[1].text), realOperations: 0 }));
});
test("registered volume verification rejects changed bindings and failed or late replies before any exec", async t => {
    const rows = [];
    for (const mode of ["verify-identity", "verify-failure", "verify-pending"]) {
        const f = fixture(mode);
        let reached;
        const waiting = mode === "verify-pending" ? new Promise(resolve => { reached = resolve; }) : undefined;
        f.state.onRegisteredVerify = reached ?? null;
        const exercising = f.exercise();
        if (waiting) {
            await waiting; assert.equal(f.driver.pending, true); assert.equal(f.state.registeredVerifies, 1);
            f.driver.unsafe(); assert.equal(f.controller.signal.aborted, true);
            assert.equal(f.volume.state, "blocked"); assert.equal(f.state.factories.includes("exec"), false);
            await assert.rejects(f.volume.release(), /cleanup unknown/);
            f.state.resumeVerify(); f.state.resumeVerify = null; f.state.onRegisteredVerify = null;
        }
        assert.equal(await exercising, false); assert.equal(f.state.registeredVerifies, 1);
        assert.equal(f.state.factories.includes("exec"), false); assert.equal(f.report.revoked, true);
        assert.equal(f.controller.signal.aborted, true); assert.equal(f.volume.state, "blocked");
        assert.equal(f.driver.pending, false); assert.equal(f.driver.physicallyClosed, false);
        assert.equal(f.state.nativeCommands.includes("release"), false);
        assert.equal(f.state.nativeCommands.some(x => x.startsWith("read-candidate-")), false);
        await f.complete(); await tick();
        assert.equal(f.report.retained, true); assert.equal(f.lifetime.retainsTask, true); assert.equal(f.files.removed.length, 0);
        assert.equal(f.task.volume, f.volume); assert.equal(f.task.driver, f.driver); assert.equal(f.state.holds.size, 1);
        assert.equal(f.report.outputBoundFailed, false); assert.equal(f.report.journalFailed, false);
        const main = Buffer.byteLength(f.state.writes[0].text), footer = Buffer.byteLength(f.state.writes[1].text);
        assert.ok(f.state.journalPeak <= 8192); assert.ok(main <= 7680); assert.ok(footer <= 512);
        rows.push({ mode, registeredVerifies: 1, execFactories: 0, journalPeak: f.state.journalPeak, main, footer });
    }
    t.diagnostic(JSON.stringify(rows));
});
test("registration verification await cannot replace task binding or resume a cancelled or cleaning VM", async () => {
    for (const mode of ["vm", "volume", "driver", "runtime", "cancel", "cleanup", "registration", "task-id", "instance-id"]) {
        const f = fixture(); let originalVm;
        f.state.onRegisteredVerify = () => {
            originalVm = f.task.vm;
            if (["vm", "volume", "driver", "runtime"].includes(mode)) f.task[mode] = { ...f.task[mode] };
            else if (mode === "cancel") f.controller.abort();
            else if (mode === "cleanup") originalVm.cleanupPromise = Promise.resolve(false);
            else if (mode === "task-id") originalVm.taskId = snapshotId;
            else if (mode === "instance-id") originalVm.id = snapshotId;
            else originalVm.registered = false;
        };
        assert.equal(await f.exercise(), false, mode);
        assert.equal(f.state.registeredVerifies, 1); assert.equal(f.state.factories.includes("exec"), false);
        assert.equal(f.state.nativeCommands.some(x => x.startsWith("read-candidate-")), false);
        assert.equal(f.report.retained, true); assert.ok(originalVm);
    }
});
test("known closed candidate failures may release only the volume and retain all partial evidence", WINDOWS_PATH_TEST_OPTIONS, async () => {
    for (const mode of ["bad-receipt", "native-failure", "guest-failure", "high-bit", "manifest-crlf"]) {
        const f = fixture(mode); assert.equal(await f.exercise(), false); assert.equal(f.report.retained, true);
        assert.equal(f.report.released, true, mode); assert.equal(f.driver.physicallyClosed, true);
        await f.complete(); assert.equal(f.files.removed.length, 0); assert.equal(f.report.passed, false);
        assert.equal(f.lifetime.retainsTask, true); assert.equal(f.state.holds.size, 1); assert.throws(() => f.task.dispose(), /retained/);
        if (mode === "native-failure") assert.equal(JSON.parse(f.files.get(path.join(root, "candidate-manifest-error.json")).bytes).capture, "known-closed-failure");
        if (mode === "manifest-crlf") {
            assert.match(f.report.error, /Capture manifest invalid/); assert.equal(f.task.checked, undefined);
            assert.equal(f.volume.candidateDiagnostics.candidate.retainedContext, false);
            assert.equal(f.volume.candidateDiagnostics.candidate.retainedPayloadBytes, 0);
        }
        if (mode === "high-bit") {
            assert.equal(f.task.checked, undefined); assert.equal(f.volume.candidateDiagnostics.candidateHeld, false);
            assert.equal(f.state.captured.diagnostics.retainedContext, false); assert.equal(f.state.captured.diagnostics.retainedPayloadBytes, 0);
            assert.equal(f.state.captured.diagnostics.retainedRequestBytes, 0); assert.equal(f.report.candidate.buffersReleased, true);
            assert.throws(() => f.state.captured.captureCounts, /unavailable/);
        }
    }
});
test("private/native close unknown and pending VM keep exact owners and never send disk release", WINDOWS_PATH_TEST_OPTIONS, async () => {
    for (const mode of ["private-unknown", "native-unknown", "pending-exec", "error-receipt-missing", "error-receipt-partial", "batch-receipt-partial"]) {
        const f = fixture(mode); assert.equal(await f.exercise(), false);
        assert.equal(f.state.nativeCommands.includes("release"), false, mode);
        await f.complete(); assert.equal(f.files.removed.length, 0); assert.equal(f.lifetime.retainsTask, true); assert.equal(f.state.holds.size, 1);
        assert.equal(f.task.driver, f.driver); assert.equal(f.task.volume, f.volume);
        if (mode === "private-unknown") {
            assert.equal(f.files.fds.size, 1); assert.equal(f.files.state.closes, 1);
            assert.equal(f.report.candidateIo.uncertain.length, 1); assert.equal(f.report.candidateStage.leaseHeld, true);
        }
        if (mode === "error-receipt-missing") assert.equal(f.files.entries.has(path.join(root, "candidate-manifest-error.json")), false);
        if (mode === "error-receipt-partial") assert.equal(f.files.get(path.join(root, "candidate-manifest-error.json")).bytes.toString(), "partial");
        if (mode === "batch-receipt-partial") {
            assert.equal(f.report.candidateIo.rows.length, 3); assert.equal(f.report.volume.transport.stderr.capturedBytes, 1024);
            assert.equal(f.files.get(path.join(root, "candidate-batch-receipt.json")).bytes.toString(), "partial");
        }
    }
});
test("profile, literal command and last dispatch guard preserve exclusive bounded authority", async () => {
    assert.deepEqual(volumeProfileArguments({}), []); assert.deepEqual(volumeProfileArguments({ candidateCapture: true }), ["-CandidateCapture"]);
    assert.deepEqual(volumeProfileArguments({ capacityProbeSha256: digest }), ["-CapacityProbeSha256", digest]);
    for (const input of [{ candidateCapture: 1 }, { candidateCapture: true, capacityProbeSha256: digest }, { capacityProbeSha256: "bad" }])
        assert.throws(() => volumeProfileArguments(input));
    const command = candidateCommand(taskId, snapshotId);
    assert.equal((command.match(/&&/g) ?? []).length, 2); assert.ok(command.indexOf("payload\\a.txt") < command.indexOf("candidates.json"));
    assert.ok(command.includes('echo super-pi-candidate-v1&&')); assert.ok(command.endsWith('"exitCode":23}}'));
    for (const bad of [taskId + "\n", taskId + "&", "%PATH%", taskId.toUpperCase().replace("1111", "AAAA")]) assert.throws(() => candidateCommand(bad, snapshotId));
    for (const mode of ["replace-vm", "revoke"]) {
        const f = fixture(); let injected = false;
        f.state.onJournal = value => { if (!injected && value.physical?.pending.at(-1)?.kind === "exec") {
            injected = true; if (mode === "replace-vm") f.task.vm = { ...f.task.vm }; else f.volume.revoke();
        } };
        assert.equal(await f.exercise(), false); assert.equal(f.state.factories.includes("exec"), false); assert.equal(f.report.retained, true);
    }
});
test("candidate cleanup profile admits bounded partial leaves but normal success requires all exact eight", WINDOWS_PATH_TEST_OPTIONS, () => {
    const m = memory(); for (const name of CANDIDATE_NORMAL_FILES) m.add(name, name === "candidate-payload.bin" ? 16384 : 4096);
    const normal = snapshotSessionFiles(root, rootId, m.io, "candidate"); requireNormalCandidateFiles(normal);
    assert.throws(() => snapshotSessionFiles(root, rootId, m.io, "sharing"));
    m.add("candidate-manifest-error.json", 4096); const partial = snapshotSessionFiles(root, rootId, m.io, "candidate");
    assert.throws(() => requireNormalCandidateFiles(partial));
    m.add("task.vhd", 134218240); assert.throws(() => removeSessionFiles(root, rootId, partial, m.io, {}, "candidate"));
    assert.equal(m.removed.length, 0); m.entries.delete(path.join(root, "task.vhd"));
    m.add("candidate-payload.bin", 16385); assert.throws(() => snapshotSessionFiles(root, rootId, m.io, "candidate"));
    m.add("candidate-payload.bin", 16384); const now = snapshotSessionFiles(root, rootId, m.io, "candidate");
    assert.equal(removeSessionFiles(root, rootId, now, m.io, {}, "candidate"), 9); assert.equal(m.entries.size, 0);
});
test("candidate source closure and post-reservation source guard use actual new dependencies", async () => {
    const bundle = candidateSourceManifest(name => Buffer.from(name));
    assert.equal(CANDIDATE_SOURCES.length, 25); assert.equal(new Set(CANDIDATE_SOURCES).size, 25);
    const directory = fileURLToPath(new URL("../scripts/acceptance/", import.meta.url));
    for (const name of CANDIDATE_SOURCES.filter(name => name.endsWith(".mjs")))
        for (const match of fs.readFileSync(path.join(directory, name), "utf8").matchAll(/^import .+ from "\.\/(.+)";/gm))
            assert.ok(CANDIDATE_SOURCES.includes(match[1]), name + " -> " + match[1]);
    for (const mode of ["source", "cli", "permission", "valid"]) {
        const f = fixture(); let factory = 0, reserved = false;
        f.state.onJournal = value => { if (value.physical?.pending.at(-1)?.kind === "exec") reserved = true; };
        const guard = candidateCliGuard(f.task, bundle.sha256, { owner: f.task, validate: owner => owner === f.task && mode !== "permission" }, {
            candidateSourceManifest() { assert.equal(reserved, true); return { sha256: mode === "source" ? "0".repeat(64) : bundle.sha256 }; },
            hashFile() { return mode === "cli" ? "0".repeat(64) : CLI_SHA256; },
        });
        const launch = () => f.lifetime.launch("exec", () => { factory++; return new Call(200); }, guard);
        if (mode === "valid") launch(); else assert.throws(launch);
        assert.equal(factory, mode === "valid" ? 1 : 0);
    }
});
test("full normal and retained reports remain bounded with actual candidate fields and escaped failure text", async t => {
    const rows = [];
    for (const mode of ["normal", "private-unknown", "native-failure", "error-receipt-missing", "batch-receipt-partial"]) {
        const f = fixture(mode); await f.exercise();
        f.report.hostPid = 2147483647;
        if (mode !== "normal") {
            f.report.error = '"\\\u0000'.repeat(12); f.report.cleanupError = "\\\"".repeat(16);
            if (f.report.candidateIo) for (const row of f.report.candidateIo.rows) {
                if (row[8]) row[8] = ["object", "Error", "\\\"".repeat(12), "EIO"];
                if (row[9]) row[9] = ["object", "Error", "\\\"".repeat(12), "EIO"];
            }
        }
        f.save(); await f.complete(); await tick();
        assert.equal(f.report.outputBoundFailed, false); assert.equal(f.report.journalFailed, false);
        const main = Buffer.byteLength(f.state.writes[0].text), footer = Buffer.byteLength(f.state.writes[1].text);
        assert.ok(f.state.journalPeak <= 8192); assert.ok(main <= 7680); assert.ok(footer <= 512);
        rows.push({ mode, journalPeak: f.state.journalPeak, main, footer });
    }
    t.diagnostic(JSON.stringify(rows));
});
