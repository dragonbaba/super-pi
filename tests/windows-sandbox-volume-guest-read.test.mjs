import { PINNED_SANDBOX_TEST_OPTIONS } from "./helpers/windows-sandbox-prerequisites.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { SandboxLifecycle } from "../scripts/acceptance/windows-sandbox-lifecycle.mjs";
import { TaskVolumeOwner, POWERSHELL7_PATH, POWERSHELL7_PREFIX, verifyPowerShell7 } from "../scripts/acceptance/windows-sandbox-volume.mjs";
import { LiveSandboxRuntime, experimentalGuidConfig } from "../scripts/acceptance/windows-sandbox-volume-sharing.mjs";
import { validateGuestReadReceipt } from "../scripts/acceptance/windows-sandbox-volume-guest-read.mjs";
const taskId = "11111111-2222-3333-4444-555555555555", volumePath = "\\\\?\\Volume{aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee}\\";
const exchangeId = "AABBCCDD:0000000000000002";
function receipt() {
    return { protocol: "super-pi-volume-guest-read-v1", taskId, volumePath, exchangeId, fileId: "AABBCCDD:0000000000000003",
        requestedBytes: 32, bytes: 32, matched: true, opened: 2, closed: 2, peak: 2, fileRetained: false, directoryRetained: false,
        fileCloseError: null, directoryCloseError: null, closeUnknown: false };
}
async function fixture() {
    const runtime = new LiveSandboxRuntime(taskId), state = { records: [], calls: [], revoked: 0, cancelled: 0, change: undefined, gate: undefined };
    const driver = { pid: 1, physicallyClosed: false, pending: false, setUnsafeHandler(fn) { this.unsafe = fn; },
        async command(command, observe) {
            state.calls.push(command); this.pending = true;
            try {
                if (command === "read-guest" && state.gate) await state.gate;
                const released = command === "release" || command === "exit";
                const value = { taskId, diskId: taskId, phase: released ? "released" : "prepared-not-share-admitted", error: null,
                    imageCreated: true, imageId: "AABBCCDD:0000000000000001", physicalPath: "\\\\.\\PhysicalDrive77", volumePath, exchangeId,
                    closeUnknown: false, managementClosed: released, detached: released };
                state.change?.(command, value); observe(value); return value;
            } finally { this.pending = false; }
        }, async waitClosed() { this.physicallyClosed = true; return true; } };
    const volume = new TaskVolumeOwner({ driver, taskId, readRuntime: runtime.read, journal: value => state.records.push(value),
        revokeCandidates() { state.revoked++; }, cancelExecution() { state.cancelled++; } });
    await volume.prepare();
    const ids = new Set(), cli = { launch(args) {
        if (args[0] === "start") ids.add(args[2]); else if (args[0] === "stop") ids.delete(args[2]);
        else assert.equal(args[0], "list");
        return { pid: 2, result: { pid: 2, exitCode: 0, signal: null, launchError: null, truncated: false, stderr: "",
            stdout: args[0] === "list" ? JSON.stringify({ WindowsSandboxEnvironments: [...ids].map(Id => ({ Id })) }) : "{}",
            closedUtc: "2026-11-01T00:00:00.000Z" }, async wait() { return "settled"; } };
    } };
    const vm = new SandboxLifecycle({ taskId, cli, config: experimentalGuidConfig(volume), journal() {} }); runtime.bind(vm);
    return { volume, runtime, vm, state, driver, async completeVm() {
        const ticket = await volume.issueExperimentalMapping(vm); await volume.startExperimentalMapping(ticket, vm); assert.equal(await vm.cleanup(), true);
    } };
}

test("fixed guest read requires completed VM and preserves the single bounded receipt", async () => {
    const f = await fixture(); await assert.rejects(f.volume.readGuestOnce(receipt), /completed bound VM/);
    await f.completeVm(); const result = await f.volume.readGuestOnce(receipt);
    assert.equal(Object.isFrozen(result), true); assert.deepEqual(result, receipt());
    assert.equal(f.state.records.at(-1).reading, false); assert.equal(f.state.records.at(-1).guestReadAttempted, true);
    await assert.rejects(f.volume.readGuestOnce(receipt)); await f.volume.release(); f.runtime.dispose();
    assert.deepEqual(f.state.calls, ["prepare", "verify", "verify", "read-guest", "release", "exit"]);
    assert.equal(f.driver.physicallyClosed, true); assert.equal(f.runtime.retainsOwner, false);
});

test("active execution, revocation and in-flight guest read block premature read or volume release", async () => {
    const f = await fixture(); await f.completeVm(); f.vm.execution = {};
    await assert.rejects(f.volume.readGuestOnce(receipt)); assert.equal(f.state.calls.includes("read-guest"), false); f.vm.execution = undefined;
    let finish; f.state.gate = new Promise(resolve => { finish = resolve; });
    const reading = f.volume.readGuestOnce(receipt);
    assert.equal(f.state.records.at(-1).reading, true); await assert.rejects(f.volume.release()); await assert.rejects(f.volume.readGuestOnce(receipt));
    f.runtime.dispose(); finish(); await assert.rejects(reading, /runtime binding lost/);
    assert.equal(f.state.records.at(-1).reading, false); assert.equal(f.state.revoked, 1); await assert.rejects(f.volume.release());
    const revoked = await fixture(); await revoked.completeVm(); revoked.volume.revoke();
    await assert.rejects(revoked.volume.readGuestOnce(receipt)); assert.equal(revoked.state.calls.includes("read-guest"), false);
    await revoked.volume.release(); revoked.runtime.dispose();
});

test("marker rejection can close safely, while missing identity or close evidence retains the volume", async () => {
    for (const mode of ["marker", "identity", "close", "receipt"]) {
        const f = await fixture(); await f.completeVm(); const value = receipt();
        f.state.change = (command, reply) => {
            if (command !== "read-guest") return;
            if (mode === "marker") { reply.error = "storage-operation-failed"; reply.phase = "blocked"; value.matched = false; }
            if (mode === "identity") reply.exchangeId = "AABBCCDD:0000000000000009";
            if (mode === "close") { reply.closeUnknown = true; value.matched = false; value.closed = 1; value.fileRetained = true; value.fileCloseError = 6; value.closeUnknown = true; }
        };
        await assert.rejects(f.volume.readGuestOnce(() => { if (mode === "receipt") throw Error("missing receipt"); return value; }));
        assert.equal(f.state.records.at(-1).reading, false); await assert.rejects(f.volume.readGuestOnce(receipt));
        if (mode === "marker") { await f.volume.release(); f.runtime.dispose(); assert.equal(f.state.revoked, 0); }
        else { await assert.rejects(f.volume.release()); assert.equal(f.state.revoked, 1); assert.equal(f.driver.physicallyClosed, false); }
    }
});

test("receipt validates both close errors and rejects aliases, forged association and impossible counters", () => {
    for (const change of [{ taskId: "wrong" }, { volumePath: "C:\\fallback" }, { extra: true }, { requestedBytes: 4096 },
        { bytes: 33 }, { fileId: "DEADBEEF:0000000000000003" }, { closed: 1 }, { fileCloseError: 6 }, { matched: true, closeUnknown: true }])
        assert.throws(() => validateGuestReadReceipt({ ...receipt(), ...change }, taskId, { volumePath, exchangeId }));
    const failed = { ...receipt(), matched: false, closed: 0, fileRetained: true, directoryRetained: true,
        fileCloseError: 6, directoryCloseError: 5, closeUnknown: true };
    assert.deepEqual(validateGuestReadReceipt(failed, taskId, { volumePath, exchangeId }), failed);
});

test("fixed reader compiles and actual helper functions run with pure storage substitutes", { timeout: 40000, ...PINNED_SANDBOX_TEST_OPTIONS }, t => {
    const workspace = fileURLToPath(new URL("..", import.meta.url)), parent = path.join(workspace, ".artifacts");
    assert.equal(fs.realpathSync(parent), parent); assert.equal(fs.lstatSync(parent).isSymbolicLink(), false);
    const root = path.join(parent, "volume-guest-read-check-" + randomUUID()); fs.mkdirSync(root);
    const identity = fs.lstatSync(root, { bigint: true }), assembly = path.join(root, "volume-native.dll");
    const runs = []; let closed = true;
    t.after(() => {
        assert.equal(closed, true, "Unclosed diagnostic process; retain exact root");
        const actual = fs.lstatSync(root, { bigint: true }); assert.equal(actual.dev, identity.dev); assert.equal(actual.ino, identity.ino);
        assert.equal(actual.isSymbolicLink(), false); assert.equal(fs.realpathSync(root), root); assert.equal(path.dirname(root), parent);
        const names = fs.readdirSync(root); assert.ok(names.length <= 1 && names.every(name => name === "volume-native.dll"));
        const files = names.map(name => { const file = path.join(root, name), stat = fs.lstatSync(file, { bigint: true });
            assert.equal(stat.isFile(), true); assert.equal(stat.isSymbolicLink(), false); assert.equal(stat.nlink, 1n); assert.ok(stat.size <= 131072n);
            return { file, dev: String(stat.dev), ino: String(stat.ino), size: String(stat.size) }; });
        const evidence = JSON.stringify({ kind: "guest-read-offline-evidence", root, identity: { dev: String(identity.dev), ino: String(identity.ino) }, files, runs }) + "\n";
        assert.ok(Buffer.byteLength(evidence) <= 12288); const bytes = Buffer.from(evidence);
        for (let offset = 0; offset < bytes.length;) { const n = fs.writeSync(1, bytes, offset, bytes.length - offset); assert.ok(n > 0); offset += n; }
        for (const item of files) { const stat = fs.lstatSync(item.file, { bigint: true });
            assert.equal(String(stat.dev), item.dev); assert.equal(String(stat.ino), item.ino); assert.equal(String(stat.size), item.size);
            assert.equal(stat.isSymbolicLink(), false); fs.unlinkSync(item.file); }
        fs.rmdirSync(root); assert.equal(fs.existsSync(root), false);
        fs.writeSync(1, JSON.stringify({ kind: "guest-read-offline-cleanup", rootRemoved: true, filesRemoved: files.length }) + "\n");
    });
    function run(executable, args) {
        closed = false; const r = spawnSync(executable, args, { cwd: root, windowsHide: true, timeout: 15000, maxBuffer: 8192 });
        closed = Number.isInteger(r.status) || typeof r.signal === "string";
        runs.push({ pid: r.pid, status: r.status, signal: r.signal, error: r.error?.code ?? null,
            stdoutBytes: r.stdout?.length ?? 0, stderrBytes: r.stderr?.length ?? 0,
            stdoutBase64: r.stdout?.subarray(0, 2048).toString("base64") ?? "", stderrBase64: r.stderr?.subarray(0, 1024).toString("base64") ?? "",
            truncated: (r.stdout?.length ?? 0) > 2048 || (r.stderr?.length ?? 0) > 1024 });
        assert.equal(r.error, undefined); assert.equal(r.status, 0); assert.equal(r.signal, null); assert.equal(r.stderr.length, 0);
        assert.ok(r.stdout.length <= 2048); return r.stdout;
    }
    verifyPowerShell7(); const compiler = "C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe";
    assert.equal(createHash("sha256").update(fs.readFileSync(compiler)).digest("hex"), "eca02e6b15cde93009a59a3d129d5a77fb5008f2e1cf62cf573b6737c747ecc3");
    run(compiler, ["/nologo", "/target:library", "/platform:x64", "/out:" + assembly,
        path.join(workspace, "scripts/acceptance/windows-sandbox-volume-native.cs")]);
    assert.ok(fs.statSync(assembly).size <= 131072);
    const bytes = run(POWERSHELL7_PATH, [...POWERSHELL7_PREFIX, "-File", path.join(workspace, "tests/fixtures/windows-sandbox-volume-guest-read-check.ps1"),
        "-HelperPath", path.join(workspace, "scripts/acceptance/windows-sandbox-volume-helper.ps1"), "-NativeAssembly", assembly]);
    const result = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes).replace(/^\uFEFF/, ""));
    assert.equal(result.cases, 24); assert.equal(result.nativeConstructors, 0); assert.equal(result.realStorageOperations, 0); assert.equal(result.businessHandles, 0);
    assert.equal(result.helperParsed, true); validateGuestReadReceipt(result.success, taskId, { volumePath, exchangeId });
});
