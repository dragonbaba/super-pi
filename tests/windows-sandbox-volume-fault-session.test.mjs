import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { CapturedProcess, SandboxLifecycle } from "../scripts/acceptance/windows-sandbox-lifecycle.mjs";
import { ManagerLossFactory, VolumeProtocol } from "../scripts/acceptance/windows-sandbox-volume.mjs";
import { SharingLifetime, sessionJournal, snapshotSessionFiles } from "../scripts/acceptance/windows-sandbox-volume-session.mjs";
import { FaultSession, FaultArtifacts } from "../scripts/acceptance/windows-sandbox-volume-fault-session.mjs";
import { faultReport, faultDiagnosticArguments, FAULT_SOURCES, faultSourceManifest } from "../scripts/acceptance/windows-sandbox-volume-fault-acceptance.mjs";
import { SHARING_ROOT } from "../scripts/acceptance/windows-sandbox-volume-share-acceptance.mjs";
import { preflightSnapshot, vmSnapshot } from "../scripts/acceptance/windows-sandbox-volume-share.mjs";
const taskId = "11111111-1111-4111-8111-111111111111", instanceId = "22222222-2222-4222-8222-222222222222";
const rootId = "12345678:0000000000000001", imageId = "12345678:0000000000000002";
const volumePath = "\\\\?\\Volume{33333333-3333-4333-8333-333333333333}\\";
const binding = { taskId, instanceId, rootId, imageId, imageBytes: 134218240, volumePath };
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
function rawReceipt() {
    return JSON.stringify({ protocol: "super-pi-manager-loss-diagnostic-v1", ...binding, diskId: taskId,
        virtualBytes: 134217728, subtype: 2, isLoaded: false, guid: { opened: false, error: 2 },
        handles: [["root","65",1,true,false,null,false,null],["image","66",1,true,false,null,false,null],["vhd-info","67",1,true,false,null,false,null]] }) + "\n";
}
function memory(hooks = {}) {
    const files = new Map([["task.vhd", { ino: 2n, size: binding.imageBytes }], ["volume-native.dll", { ino: 3n, size: 28672 }],
        ["volume-helper.json", { ino: 4n, size: 1200 }], ["lifecycle.json", { ino: 5n, size: 1 }]]);
    const model = { files, rootPresent: true, rootIno: 1n, calls: [], removed: [], writeBorrowed: null, readBorrowed: null,
        bytes: null, writeCloses: 0, readCloses: 0, journalPeak: 0, journalWrites: 0, tick: 1n, fd: null, mode: null };
    function stat(name) {
        if (name === null) {
            if (!model.rootPresent) throw Object.assign(Error("absent"), { code: "ENOENT" });
            return { dev: 0x12345678n, ino: model.rootIno, size: 0n, nlink: 1n, isDirectory: () => true, isFile: () => false, isSymbolicLink: () => false };
        }
        const item = files.get(name); if (!item) throw Object.assign(Error("absent leaf"), { code: "ENOENT" });
        return { dev: 0x12345678n, ino: item.ino, size: BigInt(item.size), nlink: item.links ?? 1n,
            mtimeNs: item.time ?? 1n, ctimeNs: item.change ?? 2n,
            isDirectory: () => false, isFile: () => true, isSymbolicLink: () => false };
    }
    const leaf = p => { assert.ok(p === SHARING_ROOT || p.startsWith(SHARING_ROOT + "\\")); return p === SHARING_ROOT ? null : p.slice(SHARING_ROOT.length + 1); };
    const io = {};
    const touch = (name, receiver) => { assert.equal(receiver, io); model.calls.push(name); hooks.io?.(name, model); };
    io.lstatSync = function(p) { touch("lstat", this); return stat(leaf(p)); };
    io.realpathSync = function(p) { touch("realpath", this); leaf(p); return p; };
    io.readdirSync = function(p) { touch("readdir", this); assert.equal(p, SHARING_ROOT); return [...files.keys()]; };
    io.openSync = function(p, flags) {
        touch("open:" + flags, this); assert.equal(leaf(p), "fault-diagnostic.json"); assert.equal(model.fd, null);
        model.mode = flags; model.fd = flags === "wx" ? 0 : 1;
        if (flags === "wx") { assert.equal(files.has("fault-diagnostic.json"), false); files.set("fault-diagnostic.json", { ino: 6n, size: 0 }); }
        else assert.equal(flags, "r"); return model.fd;
    };
    io.fstatSync = function(fd) { touch("fstat", this); assert.equal(fd, model.fd); return stat("fault-diagnostic.json"); };
    io.writeSync = function(fd, bytes, offset, length, position) {
        touch("write", this); assert.equal(fd, model.fd); assert.equal(position, offset); model.writeBorrowed = bytes;
        model.bytes ??= Buffer.alloc(bytes.length); const count = Math.min(length, hooks.writeChunk ?? length);
        bytes.copy(model.bytes, offset, offset, offset + count); files.get("fault-diagnostic.json").size += count; return count;
    };
    io.fsyncSync = function(fd) { touch("fsync", this); assert.equal(fd, model.fd); };
    io.readSync = function(fd, bytes, offset, length, position) {
        touch("read", this); assert.equal(fd, model.fd); assert.equal(position, offset); model.readBorrowed = bytes;
        const count = Math.min(length, hooks.readChunk ?? length); model.bytes.copy(bytes, offset, offset, offset + count); return count;
    };
    io.closeSync = function(fd) {
        if (model.mode === "wx") model.writeCloses++; else model.readCloses++;
        touch("close:" + model.mode, this); assert.equal(fd, model.fd); model.fd = null;
    };
    io.unlinkSync = function(p) { const name = leaf(p); touch("unlink:" + name, this); assert.ok(files.delete(name)); model.removed.push(name); };
    io.rmdirSync = function(p) { touch("rmdir", this); assert.equal(p, SHARING_ROOT); assert.equal(files.size, 0); model.rootPresent = false; };
    const resource = { journal(report) {
        hooks.journal?.(report, model); const text = JSON.stringify(report, null, 2), bytes = Buffer.byteLength(text);
        assert.ok(bytes <= 8192); model.journalPeak = Math.max(model.journalPeak, bytes); model.journalWrites++;
        files.set("lifecycle.json", { ino: 5n, size: bytes, time: ++model.tick, change: model.tick });
    } };
    return { io, model, resource };
}
// No CapturedProcess constructor/spawn is called: these are explicitly prototype-only
// transport fixtures. The real protocol, VM, lifetime, owners and cleanup contract run.
function capture(pid, text = "", pending = false) {
    const call = Object.setPrototypeOf(new EventEmitter(), CapturedProcess.prototype);
    call.pid = pid; call.child = pending ? {} : undefined;
    function settle() {
        call.child = undefined; call.out = undefined; call.err = undefined;
        call.result = { pid, exitCode: 0, signal: null, launchError: null, closedUtc: "2026-11-02T00:00:00.000Z",
            stdout: text, stderr: "", stdoutSeen: Buffer.byteLength(text), stderrSeen: 0, truncated: false };
        call.emit("settled");
    }
    if (!pending) settle();
    return { call, settle };
}
function fixture(hooks = {}) {
    const mem = memory(hooks), bus = new EventEmitter(), stream = new EventEmitter(), lines = [], captures = [], holds = new Set();
    let task, vm, pid = 2000, killCount = 0, running = false, factory, requested = 0;
    const report = faultReport(taskId, rootId), save = sessionJournal(mem.resource, report, () => task.unsafe());
    report.sources = { bundleSha256: "a".repeat(64), files: FAULT_SOURCES.length, nativeSha256: "b".repeat(64),
        powershellSha256: "c".repeat(64), compilerSha256: "d".repeat(64), cliSha256: "e".repeat(64), nodeVersion: "v26.13.0", nodeSha256: "f".repeat(64) };
    report.nativeId = "12345678:0000000000000003";
    report.preflight = preflightSnapshot({ protocol: "super-pi-native-preflight-v1", powershell: "7.6.9", x64: true,
        administratorToken: true, privilege: "SeManageVolumePrivilege", privilegeState: "Enabled", storageVersion: "2.0.0.0",
        commands: 7, format: "NTFS", availableBytes: 999999999999, requiredBytes: 168820736 });
    stream.write = (line, callback) => {
        lines.push(line); hooks.output?.(lines.length, bus, mem.model, report);
        queueMicrotask(() => callback(hooks.outputFail === lines.length ? Error("output failed") : undefined)); return true;
    };
    task = new FaultSession(report, save, rootId, mem.io);
    const lifetime = new SharingLifetime({ bus, stream, report, save, task, profile: "fault",
        timers: { setInterval(fn) { holds.add(fn); return fn; }, clearInterval(fn) { holds.delete(fn); } } });
    task.bindLifetime(lifetime);
    const child = new EventEmitter(); child.pid = 1234; child.exitCode = null; child.signalCode = null; child.killed = false;
    child.stdin = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
    child.stdin.write = (text, callback) => {
        const request = JSON.parse(text); requested++;
        assert.ok(["prepare", "verify"].includes(request.command));
        child.stdout.emit("data", Buffer.from(JSON.stringify({ protocol: "super-pi-volume-v1", taskId, diskId: taskId, sequence: request.sequence,
            kind: "reply", phase: "prepared-not-share-admitted", capacity: 134217728, imageBudget: 135266304, shareAdmission: false,
            closeUnknown: false, detached: false, managementClosed: false, imageCreated: true, error: null,
            imageId, exchangeId: "87654321:0000000000000003", physicalPath: "\\\\.\\PhysicalDrive2", volumePath }) + "\n")); callback?.();
    };
    const close = () => { child.exitCode = null; child.signalCode = "SIGTERM"; child.emit("close", null, "SIGTERM"); };
    child.kill = signal => { assert.equal(signal, "SIGTERM"); killCount++; child.killed = true; queueMicrotask(close); return true; };
    factory = new ManagerLossFactory({ taskId, launch: () => child, wrap: (p, id) => new VolumeProtocol(p, id),
        persist(kind, value) { report.fault = value; hooks.persist?.(kind, bus, report); save(); } });
    task.bindFactory(factory);
    const guard = { owner: task, signal: task.signal, validate: owner => owner === task };
    for (const kind of ["preflight", "compile"]) {
        const { call } = capture(pid++); captures.push(call); lifetime.launch(kind, () => call, guard);
        report.helperCalls.push({ kind, pid: call.pid, exitCode: 0, stdoutBytes: kind === "preflight" ? 300 : 0, stderrBytes: 0 }); save();
    }
    task.attach(lifetime.launch("manager", () => factory.launch(), guard));
    const driver = task.driver, volume = task.volume, runtime = task.runtime;
    const cli = { launch(args, original) {
        assert.ok(["list", "start", "stop"].includes(args[0]));
        if (args[0] === "start") running = true; if (args[0] === "stop") running = false;
        const text = args[0] === "list" ? JSON.stringify({ WindowsSandboxEnvironments: running ? [{ Id: instanceId }] : [] }) : "{}";
        const { call } = capture(pid++, text); captures.push(call);
        return lifetime.launch(args[0], () => call, original ?? guard);
    } };
    async function trigger() {
        await task.trigger(config => {
            vm = new SandboxLifecycle({ cli, config, taskId, journal(value) { report.vm = vmSnapshot(value); save(); } }); vm.id = instanceId; return vm;
        });
    }
    let diagnostic;
    async function diagnose() {
        return await task.diagnose(() => lifetime.launch("diagnostic", () => {
            diagnostic = capture(pid++, rawReceipt(), hooks.pendingDiagnostic); captures.push(diagnostic.call);
            if (hooks.pendingDiagnostic) queueMicrotask(() => bus.emit("SIGINT"));
            return diagnostic.call;
        }, task.diagnosticAuthorization(() => hooks.verify?.(bus, mem.model))));
    }
    return { ...mem, bus, stream, report, save, task, lifetime, factory, child, driver, volume, runtime, captures, lines, holds,
        trigger, diagnose, get vm() { return vm; }, get diagnostic() { return diagnostic; },
        counts: () => ({ killCount, requested, captures: captures.length }),
        clearFakeMemory() { mem.model.bytes?.fill(0); holds.clear(); } };
}
const tick = () => new Promise(resolve => setImmediate(resolve));
test("complete fault composition preserves failure and clears exact byte/reference ownership", async () => {
    const f = fixture(); await f.trigger(); const evidence = await f.diagnose();
    const driver = f.driver, result = await f.task.complete(evidence); await tick();
    assert.equal(result.faultAcceptancePassed, true); assert.equal(result.taskPassed, false);
    assert.equal(result.taskRejected && result.unsafe && result.cancelled && result.artifactsRemoved, true);
    assert.equal(result.userCancelled, false); assert.equal(f.volume.state, "blocked"); await assert.rejects(f.volume.release());
    assert.deepEqual(f.counts(), { killCount: 1, requested: 4, captures: 9 });
    assert.equal(f.lifetime.released, true); assert.equal(f.lifetime.retainsTask, false); assert.equal(f.lifetime.trackedCount, 0);
    assert.equal(f.runtime.retainsOwner, false); assert.equal(f.factory.snapshot.callbacksHeld, false);
    assert.equal(driver.childReleased && driver.diagnostics.buffersReleased, true);
    assert.equal(f.task.snapshot.referencesHeld, false); assert.equal(f.task.snapshot.receivedBytes, Buffer.byteLength(rawReceipt()));
    assert.equal(f.task.snapshot.receivedBytes, f.task.snapshot.clearedBytes); assert.equal(f.task.snapshot.retainedBytes, 0);
    assert.ok(f.model.writeBorrowed.every(x => x === 0)); assert.ok(f.model.readBorrowed.every(x => x === 0));
    assert.equal(f.model.writeCloses, 1); assert.equal(f.model.readCloses, 1); assert.equal(f.model.fd, null);
    assert.deepEqual(f.model.removed, ["task.vhd", "volume-native.dll", "volume-helper.json", "fault-diagnostic.json", "lifecycle.json"]);
    const s = f.task.snapshot; assert.equal(s.artifacts.disposed && s.receipt.state === "disposed" && s.channel.state === "disposed", true);
    assert.equal(s.contract.state, "model-complete"); assert.equal(s.contract.contextHeld || s.contract.observerHeld, false);
    assert.equal(s.contract.copyBytesAllocated, 14 * Buffer.byteLength(rawReceipt()));
    assert.equal(s.contract.copyBytesAllocated, s.contract.copyBytesCleared);
    assert.equal(f.bus.listenerCount("SIGINT") + f.bus.listenerCount("SIGTERM") + f.stream.listenerCount("error"), 0);
    assert.equal(f.child.listenerCount("close") + f.child.listenerCount("error") + f.child.stdout.listenerCount("data"), 0);
    assert.equal(f.holds.size, 0); assert.equal(f.lines.length, 3);
    assert.equal(Buffer.from(JSON.parse(f.lines[0]).base64, "base64").toString(), rawReceipt());
    assert.ok(Buffer.byteLength(f.lines[0]) <= 6144 && Buffer.byteLength(f.lines[1]) <= 7680 && Buffer.byteLength(f.lines[2]) <= 512);
    assert.ok(f.model.journalPeak <= 8192); assert.equal(s.artifacts.calls, 142);
    console.log(JSON.stringify({ kind: "fault-model-counters", ...f.counts(), artifactFs: s.artifacts.calls,
        rawBytes: s.receivedBytes, copyBytes: s.contract.copyBytesAllocated, clearedBytes: s.clearedBytes,
        journalPeak: f.model.journalPeak, outputBytes: f.lines.map(line => Buffer.byteLength(line)) }));
    f.clearFakeMemory();
});
test("readback full fingerprint rejects same ID changes between read and freeze", async () => {
    for (const key of ["size", "time", "change"]) {
        const f = fixture(); await f.trigger(); const evidence = await f.diagnose();
        const leaf = f.model.files.get("fault-diagnostic.json"); leaf[key] = key === "size" ? leaf.size + 1 : 99n;
        await f.task.complete(evidence);
        assert.equal(f.report.faultAcceptancePassed, false); assert.equal(f.model.removed.length, 0);
        assert.equal(f.task.snapshot.receivedBytes, 0); assert.equal(f.lines.length, 0); assert.equal(f.lifetime.released, false); f.clearFakeMemory();
    }
});
test("user stop after internal cancellation forbids diagnostic and cancels in-flight wait without killing", async () => {
    const f = fixture(); await f.trigger(); assert.equal(f.report.cancelled, true); f.bus.emit("SIGINT");
    assert.equal(f.report.userCancelled, true); assert.equal(f.task.signal.aborted, true); await assert.rejects(f.diagnose());
    assert.equal(f.counts().captures, 8); assert.equal(f.counts().killCount, 1); f.clearFakeMemory();
    const g = fixture({ pendingDiagnostic: true }); await g.trigger(); await assert.rejects(g.diagnose());
    assert.equal(g.report.userCancelled, true); assert.equal(g.task.snapshot.channel.state, "blocked");
    g.diagnostic.settle(); await assert.rejects(g.diagnose());
    assert.equal(g.task.snapshot.channel.state, "blocked"); assert.equal(g.model.files.has("fault-diagnostic.json"), false);
    assert.equal(g.counts().killCount, 1); assert.throws(() => g.task.dispose()); g.clearFakeMemory();
});
test("final diagnostic guard runs after reservation and rejects revoked source or original process association", async () => {
    for (const mode of ["source", "stop", "result"]) {
        let f;
        f = fixture({ verify(bus) {
            assert.equal(f.report.physical.pending.at(-1).kind, "diagnostic");
            if (mode === "source") throw Error("source changed");
            if (mode === "stop") bus.emit("SIGINT");
            if (mode === "result") f.vm.calls[0].result = { ...f.vm.calls[0].result };
        } });
        await f.trigger(); await assert.rejects(f.diagnose());
        assert.equal(f.counts().captures, 8); assert.equal(f.model.files.has("fault-diagnostic.json"), false);
        assert.equal(f.report.physical.notStarted, 1); f.clearFakeMemory();
    }
});
test("write/read unknown close retains exact descriptor and buffer without cleanup or dispose", async () => {
    for (const point of ["close:wx", "close:r"]) {
        const f = fixture({ io(name) { if (name === point) throw 0; } }); await f.trigger();
        await assert.rejects(f.diagnose(), error => error === 0);
        const s = f.task.snapshot, responsibility = point === "close:wx" ? s.receipt : s.artifacts;
        assert.equal(responsibility.unknown, true); assert.equal(f.model.fd, point === "close:wx" ? 0 : 1);
        assert.ok(responsibility.retainedBytes > 0); assert.throws(() => f.task.dispose()); assert.equal(f.model.removed.length, 0);
        assert.equal(f.model.writeCloses, 1); assert.equal(f.model.readCloses, point === "close:r" ? 1 : 0); f.clearFakeMemory();
    }
});
test("output failure or user stop prevents transfer/deletion; footer failure retains outer owner", async () => {
    for (const index of [1,2,3]) {
        const f = fixture({ outputFail: index }); await f.trigger(); const evidence = await f.diagnose(); await f.task.complete(evidence);
        assert.equal(f.report.faultAcceptancePassed, false); assert.equal(f.lifetime.released, false); assert.throws(() => f.task.dispose());
        assert.equal(f.model.removed.length, index === 3 ? 5 : 0); assert.equal(f.task.snapshot.receivedBytes > 0, index === 3); f.clearFakeMemory();
    }
    const f = fixture({ output(index, bus) { if (index === 1) bus.emit("SIGTERM"); } });
    await f.trigger(); const evidence = await f.diagnose(); await f.task.complete(evidence);
    assert.equal(f.model.removed.length, 0); assert.equal(f.task.snapshot.receivedBytes, 0); assert.equal(f.report.userCancelled, true); f.clearFakeMemory();
});
test("five-leaf failure preserves remaining identities and never retries or resumes", async () => {
    const leaves = ["task.vhd", "volume-native.dll", "volume-helper.json", "fault-diagnostic.json", "lifecycle.json"];
    for (const [index, leaf] of leaves.entries()) {
        const f = fixture({ io(name) { if (name === "unlink:" + leaf) throw Error("fixed removal failure"); } });
        await f.trigger(); const evidence = await f.diagnose(); await f.task.complete(evidence);
        assert.deepEqual(f.model.removed, leaves.slice(0, index)); assert.equal(f.model.rootPresent, true);
        assert.equal(f.report.faultAcceptancePassed, false); assert.equal(f.task.snapshot.retainedBytes, Buffer.byteLength(rawReceipt()));
        const count = f.model.calls.length; await assert.rejects(f.task.complete(evidence)); assert.equal(f.model.calls.length, count);
        assert.throws(() => f.task.dispose()); f.clearFakeMemory();
    }
});
test("fault role budget and source/entry bounds do not enable ordinary cleanup or guest execution", async () => {
    const f = fixture(); let launches = 0;
    assert.throws(() => f.lifetime.launch("exec", () => { launches++; }));
    assert.throws(() => f.lifetime.launch("preflight", () => { launches++; })); assert.equal(launches, 0);
    assert.throws(() => snapshotSessionFiles(SHARING_ROOT, rootId, f.io, "fault"));
    const bundle = faultSourceManifest(() => Buffer.from("source")); assert.equal(bundle.manifest.files.length, new Set(FAULT_SOURCES).size);
    assert.throws(() => faultSourceManifest(() => Buffer.alloc(131073)));
    const args = faultDiagnosticArguments(binding, "f".repeat(64)); assert.ok(args.includes("-RunDiagnostic")); assert.ok(args.includes(String(binding.imageBytes)));
    const entry = fs.readFileSync(new URL("../scripts/acceptance/windows-sandbox-volume-fault-acceptance.mjs", import.meta.url), "utf8");
    assert.equal(entry.includes("OwnedHelperRunner"), false); assert.equal(entry.includes("--run-fault-once"), true);
    assert.equal(entry.includes("windows-sandbox-volume-fault-diagnostic.cs"), true);
    assert.equal(entry.includes(".kill("), false);
    f.clearFakeMemory();
});
