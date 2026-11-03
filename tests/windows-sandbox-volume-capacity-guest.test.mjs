import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createHash, randomUUID } from "node:crypto";
import { initialCapacitySlot, decodeCapacityReport, decodeCapacityDelivery } from "../scripts/acceptance/windows-sandbox-volume-capacity-protocol.mjs";
import { POWERSHELL7_PATH, POWERSHELL7_PREFIX, verifyPowerShell7 } from "../scripts/acceptance/windows-sandbox-volume.mjs";

test("capacity guest protocol compiles and checks pure orchestration without native I/O", { timeout: 40000 }, t => {
    const workspace = fileURLToPath(new URL("..", import.meta.url)), parent = path.join(workspace, ".artifacts");
    assert.equal(fs.realpathSync(parent), parent); assert.equal(fs.lstatSync(parent).isSymbolicLink(), false);
    const root = path.join(parent, "volume-capacity-guest-check-" + randomUUID()); fs.mkdirSync(root);
    const identity = fs.lstatSync(root, { bigint: true }), assembly = path.join(root, "capacity-guest-check.dll");
    const runs = []; let closed = true;
    t.after(() => {
        let files = null, inspectionError;
        if (closed) {
            try {
                const actual = fs.lstatSync(root, { bigint: true }); assert.equal(actual.dev, identity.dev); assert.equal(actual.ino, identity.ino);
                assert.equal(actual.isSymbolicLink(), false); assert.equal(fs.realpathSync(root), root); assert.equal(path.dirname(root), parent);
                const names = fs.readdirSync(root); assert.ok(names.length <= 1 && names.every(name => name === "capacity-guest-check.dll"));
                files = names.map(name => { const file = path.join(root, name), stat = fs.lstatSync(file, { bigint: true });
                    assert.equal(stat.isFile(), true); assert.equal(stat.isSymbolicLink(), false); assert.equal(stat.nlink, 1n); assert.ok(stat.size <= 65536n);
                    return { file, dev: String(stat.dev), ino: String(stat.ino), size: String(stat.size) }; });
            } catch (error) { inspectionError = error; }
        }
        // Always deliver the recorded root and process facts, including unknown status, before refusing cleanup.
        const evidence = Buffer.from(JSON.stringify({ kind: "capacity-guest-offline-evidence", root, identity: { dev: String(identity.dev), ino: String(identity.ino) },
            processesClosed: closed, inspectionError: inspectionError ? String(inspectionError.message).slice(0, 256) : null, files, runs }) + "\n");
        assert.ok(evidence.length <= 12288);
        for (let offset = 0; offset < evidence.length;) { const n = fs.writeSync(1, evidence, offset, evidence.length - offset); assert.ok(n > 0); offset += n; }
        assert.equal(closed, true, "Unclosed check process; retain recorded root"); if (inspectionError) throw inspectionError;
        let removed = 0;
        try {
            for (const item of files) { const stat = fs.lstatSync(item.file, { bigint: true });
                assert.equal(String(stat.dev), item.dev); assert.equal(String(stat.ino), item.ino); assert.equal(String(stat.size), item.size);
                assert.equal(stat.isSymbolicLink(), false); assert.equal(stat.nlink, 1n); assert.equal(fs.realpathSync(item.file), item.file); fs.unlinkSync(item.file); removed++; }
            const actual = fs.lstatSync(root, { bigint: true }); assert.equal(actual.dev, identity.dev); assert.equal(actual.ino, identity.ino);
            assert.equal(actual.isSymbolicLink(), false); assert.equal(fs.realpathSync(root), root); fs.rmdirSync(root); assert.equal(fs.existsSync(root), false);
        } catch (error) {
            fs.writeSync(1, JSON.stringify({ kind: "capacity-guest-offline-cleanup", rootRemoved: false, retained: true, filesRemoved: removed, error: String(error.message).slice(0, 128) }) + "\n");
            throw error;
        }
        fs.writeSync(1, JSON.stringify({ kind: "capacity-guest-offline-cleanup", rootRemoved: true, filesRemoved: removed }) + "\n");
    });
    function run(role, executable, args) {
        const record = { role, requestedUtc: new Date().toISOString(), phase: "requested-unknown", pid: null, status: null, signal: null,
            error: null, exception: null, stdoutBytes: null, stderrBytes: null, stdoutBase64: null, stderrBase64: null, truncated: null };
        runs.push(record); closed = false;
        let r;
        try { r = spawnSync(executable, args, { cwd: root, windowsHide: true, timeout: 15000, maxBuffer: 8192 }); }
        catch (error) {
            record.phase = "call-threw-unknown"; record.error = String(error.code ?? error.name).slice(0, 64);
            record.exception = String(error.message).slice(0, 256); throw error;
        }
        closed = Number.isInteger(r.status) || typeof r.signal === "string";
        Object.assign(record, { phase: closed ? "closed" : "unresolved", pid: r.pid ?? null, status: r.status, signal: r.signal, error: r.error?.code ?? null,
            stdoutBytes: r.stdout?.length ?? 0, stderrBytes: r.stderr?.length ?? 0,
            stdoutBase64: r.stdout?.subarray(0, 2048).toString("base64") ?? "", stderrBase64: r.stderr?.subarray(0, 1024).toString("base64") ?? "",
            truncated: (r.stdout?.length ?? 0) > 2048 || (r.stderr?.length ?? 0) > 1024 });
        assert.equal(r.error, undefined); assert.equal(r.status, 0); assert.equal(r.signal, null); assert.equal(r.stderr.length, 0); assert.ok(r.stdout.length <= 2048); return r.stdout;
    }
    verifyPowerShell7(); const compiler = "C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe";
    assert.equal(createHash("sha256").update(fs.readFileSync(compiler)).digest("hex"), "eca02e6b15cde93009a59a3d129d5a77fb5008f2e1cf62cf573b6737c747ecc3");
    run("compile", compiler, ["/nologo", "/target:library", "/platform:x64", "/out:" + assembly,
        path.join(workspace, "scripts/acceptance/windows-sandbox-volume-capacity-core.cs"), path.join(workspace, "scripts/acceptance/windows-sandbox-volume-capacity-protocol.cs"),
        path.join(workspace, "scripts/acceptance/windows-sandbox-volume-capacity-guest.cs"), path.join(workspace, "tests/fixtures/windows-sandbox-volume-capacity-guest-check.cs")]);
    assert.ok(fs.statSync(assembly).size <= 65536);
    const script = "$ErrorActionPreference='Stop'; if($PSVersionTable.PSVersion.Major -ne 7 -or $PSVersionTable.PSEdition -cne 'Core' -or -not [Environment]::Is64BitProcess){throw 'PS7 x64 required'}; [Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); [void][Reflection.Assembly]::LoadFile([IO.Path]::Combine([Environment]::CurrentDirectory,'capacity-guest-check.dll')); [Console]::WriteLine([CapacityGuestChecks]::Run())";
    const bytes = run("pure-check", POWERSHELL7_PATH, [...POWERSHELL7_PREFIX, "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")]);
    const result = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes).replace(/^\uFEFF/, ""));
    assert.deepEqual(Object.keys(result), ["cases", "nativeCalls", "maxGuestWrites", "buffersCleared", "full", "deadline"]);
    assert.equal(result.cases, 25); assert.equal(result.nativeCalls, 0); assert.equal(result.maxGuestWrites, 2); assert.equal(result.buffersCleared, true);
    const taskId = "12345678-1234-4567-89ab-123456789abc", full = Buffer.from(result.full, "base64"), deadline = Buffer.from(result.deadline, "base64");
    assert.equal(full.toString("base64"), result.full); assert.equal(deadline.toString("base64"), result.deadline);
    const report = decodeCapacityReport(full, taskId);
    assert.equal(report.source, "guest-report"); assert.equal(report.qualifiedWriteCandidate, true); assert.equal(report.lastReturnedWrite.errorCode, 112);
    assert.equal(report.flush.errorCode, null); assert.equal(report.close.errorCode, null); assert.equal(report.attempts, 2);
    assert.equal(decodeCapacityReport(deadline, taskId).qualifiedWriteCandidate, false);
    assert.equal(decodeCapacityDelivery(0).deliveryComplete, true); // Same delivery success for both distinct write outcomes.
    const changed = (offset, value) => { const bytes = Buffer.from(full); bytes.writeUInt32LE(value, offset); return bytes; };
    for (const [offset, value] of [[200, 1], [40, 4], [44, 0], [48, 145], [52, 3], [56, 0], [60, 0], [180, 1], [184, 1], [188, 1], [192, 0], [196, 0], [72, 2], [104, 1], [148, 2]]) {
        assert.throws(() => decodeCapacityReport(changed(offset, value), taskId), undefined, "malformed offset " + offset);
    }
    assert.throws(() => decodeCapacityReport(full, "87654321-1234-4567-89ab-123456789abc"));
    assert.throws(() => decodeCapacityReport(full.subarray(0, 511), taskId));
    assert.throws(() => decodeCapacityReport(initialCapacitySlot(taskId), taskId));
    const dual = Buffer.from(full); dual.writeUInt32LE(0, 96); dual.writeUInt32LE(5, 100); dual.writeUInt32LE(0, 116); dual.writeUInt32LE(6, 120);
    const failedFinalization = decodeCapacityReport(dual, taskId);
    assert.equal(failedFinalization.diskFullWrite, true); assert.equal(failedFinalization.qualifiedWriteCandidate, false);
    assert.equal(failedFinalization.flush.errorCode, 5); assert.equal(failedFinalization.close.errorCode, 6);
    full.fill(0); deadline.fill(0); assert.equal(report.lastReturnedWrite.errorCode, 112); // Decoder retains values, never input bytes.
});


test("delivery decoder accepts only finite reviewed exit states and keeps absent raw errors unknown", () => {
    const initial = initialCapacitySlot("12345678-1234-4567-89ab-123456789abc");
    assert.equal(initial.length, 512); assert.equal(initial.subarray(0, 40).toString("ascii"), "SPCI0001123456781234456789ab123456789abc");
    assert.ok(initial.subarray(40).every(byte => byte === 0));
    assert.throws(() => initialCapacitySlot("00000000-0000-0000-0000-000000000000"));
    for (const code of [65, 66, 68, 69, 70, 72, 73, 74, 76, 77, 78]) {
        const state = decodeCapacityDelivery(code); assert.equal(state.source, "guest-report"); assert.equal(state.interfaceSource, "platform-interface");
        assert.equal(state.state, "delivery-failed"); assert.equal(state.deliveryComplete, false);
        assert.equal(state.writeErrorCode, null); assert.equal(state.flushErrorCode, null); assert.equal(state.closeErrorCode, null);
    }
    assert.equal(decodeCapacityDelivery(66).write, "short"); assert.equal(decodeCapacityDelivery(77).close, "failed-or-unknown");
    for (const code of [96, 97, 98, 99]) assert.equal(decodeCapacityDelivery(code).state, "undelivered");
    for (const code of [1, 64, 67, 71, 75, 79, 255, -1073741819, 3221225477, null, undefined, "0", 0.5, NaN]) {
        assert.equal(decodeCapacityDelivery(code).state, "unknown"); assert.equal(decodeCapacityDelivery(code).deliveryComplete, false);
    }
});
