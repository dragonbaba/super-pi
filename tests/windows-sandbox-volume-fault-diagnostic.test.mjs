import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createHash, randomUUID } from "node:crypto";
import { POWERSHELL7_PATH, POWERSHELL7_PREFIX, verifyPowerShell7 } from "../scripts/acceptance/windows-sandbox-volume.mjs";

test("fault diagnostic compiles and exercises only injected I/O and pure layouts", { timeout: 40000 }, t => {
    const workspace = fileURLToPath(new URL("..", import.meta.url)), parent = path.join(workspace, ".artifacts");
    assert.equal(fs.realpathSync(parent), parent); assert.equal(fs.lstatSync(parent).isSymbolicLink(), false);
    const root = path.join(parent, "volume-fault-diagnostic-check-" + randomUUID());
    const assembly = path.join(root, "fault-diagnostic-check.dll"), runs = [];
    let closed = true, creationAttempted = false, rootCreated = false, identity;
    function ownedRoot() {
        assert.ok(rootCreated && identity, "Recorded root identity required");
        const actual = fs.lstatSync(root, { bigint: true });
        assert.equal(actual.dev, identity.dev); assert.equal(actual.ino, identity.ino);
        assert.equal(actual.isDirectory(), true); assert.equal(actual.isSymbolicLink(), false);
        assert.equal(fs.realpathSync(root), root); assert.equal(path.dirname(root), parent);
    }
    t.after(() => {
        if (!creationAttempted) return;
        let files = null, inspectionError;
        const complete = runs.every(run => run.phase === "closed" && run.error === null && run.exception === null && run.truncated === false);
        if (closed && complete && rootCreated && identity) {
            try {
                ownedRoot();
                const names = fs.readdirSync(root); assert.ok(names.length <= 1 && names.every(name => name === "fault-diagnostic-check.dll"));
                files = names.map(name => { const file = path.join(root, name), stat = fs.lstatSync(file, { bigint: true });
                    assert.equal(stat.isFile(), true); assert.equal(stat.isSymbolicLink(), false); assert.equal(stat.nlink, 1n); assert.ok(stat.size <= 65536n);
                    return { file, dev: String(stat.dev), ino: String(stat.ino), size: String(stat.size) }; });
            } catch (error) { inspectionError = error; }
        }
        const evidence = Buffer.from(JSON.stringify({ kind: "fault-diagnostic-offline-evidence", root, creationAttempted, rootCreated,
            identity: identity ? { dev: String(identity.dev), ino: String(identity.ino) } : null, evidenceComplete: complete,
            processesClosed: closed, inspectionError: inspectionError ? String(inspectionError.message).slice(0, 256) : null, files, runs }) + "\n");
        assert.ok(evidence.length <= 12288);
        for (let offset = 0; offset < evidence.length;) { const n = fs.writeSync(1, evidence, offset, evidence.length - offset); assert.ok(n > 0); offset += n; }
        assert.equal(closed, true, "Unclosed check process; retain recorded root");
        assert.equal(complete, true, "Incomplete process evidence; retain recorded root");
        assert.ok(rootCreated && identity, "Unconfirmed root identity; retain recorded path"); if (inspectionError) throw inspectionError;
        let removed = 0;
        try {
            for (const item of files) { ownedRoot(); const stat = fs.lstatSync(item.file, { bigint: true });
                assert.equal(String(stat.dev), item.dev); assert.equal(String(stat.ino), item.ino); assert.equal(String(stat.size), item.size);
                assert.equal(stat.isSymbolicLink(), false); assert.equal(stat.nlink, 1n); assert.equal(fs.realpathSync(item.file), item.file);
                fs.unlinkSync(item.file); removed++; }
            ownedRoot();
            fs.rmdirSync(root); assert.equal(fs.existsSync(root), false);
        } catch (error) {
            fs.writeSync(1, JSON.stringify({ kind: "fault-diagnostic-offline-cleanup", rootRemoved: false, retained: true, filesRemoved: removed, error: String(error.message).slice(0, 128) }) + "\n");
            throw error;
        }
        fs.writeSync(1, JSON.stringify({ kind: "fault-diagnostic-offline-cleanup", rootRemoved: true, filesRemoved: removed }) + "\n");
    });
    creationAttempted = true; fs.mkdirSync(root); rootCreated = true;
    identity = fs.lstatSync(root, { bigint: true });
    function run(role, executable, args) {
        const record = { role, requestedUtc: new Date().toISOString(), phase: "requested-unknown", pid: null, status: null, signal: null,
            error: null, exception: null, stdoutBytes: null, stderrBytes: null, stdoutBase64: null, stderrBase64: null, truncated: null };
        runs.push(record); closed = false;
        let result;
        try { result = spawnSync(executable, args, { cwd: root, windowsHide: true, timeout: 15000, maxBuffer: 8192 }); }
        catch (error) {
            record.phase = "call-threw-unknown"; record.error = String(error.code ?? error.name).slice(0, 64);
            record.exception = String(error.message).slice(0, 256); throw error;
        }
        closed = Number.isInteger(result.status) || typeof result.signal === "string";
        Object.assign(record, { phase: closed ? "closed" : "unresolved", pid: result.pid ?? null, status: result.status, signal: result.signal,
            error: result.error?.code ?? null, stdoutBytes: result.stdout?.length ?? 0, stderrBytes: result.stderr?.length ?? 0,
            stdoutBase64: result.stdout?.subarray(0, 2048).toString("base64") ?? "", stderrBase64: result.stderr?.subarray(0, 1024).toString("base64") ?? "",
            truncated: (result.stdout?.length ?? 0) > 2048 || (result.stderr?.length ?? 0) > 1024 });
        assert.equal(result.error, undefined); assert.equal(result.status, 0); assert.equal(result.signal, null);
        assert.equal(result.stderr.length, 0); assert.ok(result.stdout.length <= 2048); return result.stdout;
    }
    const compiler = "C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe";
    assert.equal(createHash("sha256").update(fs.readFileSync(compiler)).digest("hex"), "eca02e6b15cde93009a59a3d129d5a77fb5008f2e1cf62cf573b6737c747ecc3");
    run("compile", compiler, ["/nologo", "/target:library", "/platform:x64", "/out:" + assembly,
        path.join(workspace, "scripts/acceptance/windows-sandbox-volume-fault-diagnostic.cs"),
        path.join(workspace, "tests/fixtures/windows-sandbox-volume-fault-diagnostic-check.cs")]);
    assert.ok(fs.statSync(assembly).size <= 65536);
    const script = "$ErrorActionPreference='Stop'; if($PSVersionTable.PSVersion.Major -ne 7 -or $PSVersionTable.PSEdition -cne 'Core' -or -not [Environment]::Is64BitProcess){throw 'PS7 x64 required'}; [Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); [void][Reflection.Assembly]::LoadFile([IO.Path]::Combine([Environment]::CurrentDirectory,'fault-diagnostic-check.dll')); [Console]::WriteLine([FaultDiagnosticChecks]::Run())";
    verifyPowerShell7();
    const bytes = run("pure-check", POWERSHELL7_PATH, [...POWERSHELL7_PREFIX, "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")]);
    const result = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes).replace(/^\uFEFF/, ""));
    const { receipt, ...counts } = result;
    assert.deepEqual(counts, { cases: 111, nativeAdapterCalls: 0, fixedHandleSlots: 4, peakFakeHandles: 4,
        maximumUnresolvedHandles: 4, maximumScratchBytes: 64, failedClosesRetried: 0 });
    assert.equal(typeof receipt, "string"); assert.ok(Buffer.byteLength(receipt) <= 4096); assert.ok(receipt.endsWith("\n"));
    const parsed = JSON.parse(receipt); assert.equal(JSON.stringify(parsed) + "\n", receipt);
    assert.deepEqual(parsed, { protocol: "super-pi-manager-loss-diagnostic-v1",
        taskId: "11111111-1111-4111-8111-111111111111", instanceId: "22222222-2222-4222-8222-222222222222",
        rootId: "12345678:0000000000000001", imageId: "12345678:0000000000000002",
        diskId: "11111111-1111-4111-8111-111111111111", imageBytes: 134218240,
        volumePath: "\\\\?\\Volume{33333333-3333-4333-8333-333333333333}\\",
        virtualBytes: 134217728, subtype: 2, isLoaded: false, guid: { opened: false, error: 2 },
        handles: [["root", "65", 1, true, false, null, false, null], ["image", "66", 1, true, false, null, false, null],
            ["vhd-info", "67", 1, true, false, null, false, null]] });
});
