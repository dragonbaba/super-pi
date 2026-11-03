import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createHash, randomUUID } from "node:crypto";
import { POWERSHELL7_PATH, POWERSHELL7_PREFIX, verifyPowerShell7 } from "../scripts/acceptance/windows-sandbox-volume.mjs";

test("fixed manifest capture compiles and exercises only injected I/O and pure metadata", { timeout: 40000 }, t => {
    const workspace = fileURLToPath(new URL("..", import.meta.url)), parent = path.join(workspace, ".artifacts");
    assert.equal(fs.realpathSync(parent), parent); assert.equal(fs.lstatSync(parent).isSymbolicLink(), false);
    const root = path.join(parent, "volume-candidate-manifest-check-" + randomUUID()); fs.mkdirSync(root);
    const identity = fs.lstatSync(root, { bigint: true }), assembly = path.join(root, "candidate-manifest-check.dll");
    const runs = []; let closed = true;
    t.after(() => {
        let files = null, inspectionError;
        if (closed) {
            try {
                const actual = fs.lstatSync(root, { bigint: true }); assert.equal(actual.dev, identity.dev); assert.equal(actual.ino, identity.ino);
                assert.equal(actual.isSymbolicLink(), false); assert.equal(fs.realpathSync(root), root); assert.equal(path.dirname(root), parent);
                const names = fs.readdirSync(root); assert.ok(names.length <= 1 && names.every(name => name === "candidate-manifest-check.dll"));
                files = names.map(name => { const file = path.join(root, name), stat = fs.lstatSync(file, { bigint: true });
                    assert.equal(stat.isFile(), true); assert.equal(stat.isSymbolicLink(), false); assert.equal(stat.nlink, 1n); assert.ok(stat.size <= 65536n);
                    return { file, dev: String(stat.dev), ino: String(stat.ino), size: String(stat.size) }; });
            } catch (error) { inspectionError = error; }
        }
        const evidence = Buffer.from(JSON.stringify({ kind: "candidate-manifest-offline-evidence", root, identity: { dev: String(identity.dev), ino: String(identity.ino) },
            processesClosed: closed, inspectionError: inspectionError ? String(inspectionError.message).slice(0, 256) : null, files, runs }) + "\n");
        assert.ok(evidence.length <= 12288);
        for (let offset = 0; offset < evidence.length;) { const n = fs.writeSync(1, evidence, offset, evidence.length - offset); assert.ok(n > 0); offset += n; }
        assert.equal(closed, true, "Unclosed check process; retain recorded root"); if (inspectionError) throw inspectionError;
        let removed = 0;
        try {
            for (const item of files) { const stat = fs.lstatSync(item.file, { bigint: true });
                assert.equal(String(stat.dev), item.dev); assert.equal(String(stat.ino), item.ino); assert.equal(String(stat.size), item.size);
                assert.equal(stat.isSymbolicLink(), false); assert.equal(stat.nlink, 1n); assert.equal(fs.realpathSync(item.file), item.file);
                fs.unlinkSync(item.file); removed++; }
            const actual = fs.lstatSync(root, { bigint: true }); assert.equal(actual.dev, identity.dev); assert.equal(actual.ino, identity.ino);
            assert.equal(actual.isSymbolicLink(), false); assert.equal(fs.realpathSync(root), root);
            fs.rmdirSync(root); assert.equal(fs.existsSync(root), false);
        } catch (error) {
            fs.writeSync(1, JSON.stringify({ kind: "candidate-manifest-offline-cleanup", rootRemoved: false, retained: true, filesRemoved: removed, error: String(error.message).slice(0, 128) }) + "\n");
            throw error;
        }
        fs.writeSync(1, JSON.stringify({ kind: "candidate-manifest-offline-cleanup", rootRemoved: true, filesRemoved: removed }) + "\n");
    });
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
    verifyPowerShell7();
    const compiler = "C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe";
    assert.equal(createHash("sha256").update(fs.readFileSync(compiler)).digest("hex"), "eca02e6b15cde93009a59a3d129d5a77fb5008f2e1cf62cf573b6737c747ecc3");
    run("compile", compiler, ["/nologo", "/target:library", "/platform:x64", "/out:" + assembly,
        path.join(workspace, "scripts/acceptance/windows-sandbox-volume-native.cs"),
        path.join(workspace, "scripts/acceptance/windows-sandbox-volume-candidate-manifest.cs"),
        path.join(workspace, "tests/fixtures/windows-sandbox-volume-candidate-manifest-check.cs")]);
    assert.ok(fs.statSync(assembly).size <= 65536);
    const script = "$ErrorActionPreference='Stop'; if($PSVersionTable.PSVersion.Major -ne 7 -or $PSVersionTable.PSEdition -cne 'Core' -or -not [Environment]::Is64BitProcess){throw 'PS7 x64 required'}; [Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); [void][Reflection.Assembly]::LoadFile([IO.Path]::Combine([Environment]::CurrentDirectory,'candidate-manifest-check.dll')); [Console]::WriteLine([CandidateManifestChecks]::Run())";
    const bytes = run("pure-check", POWERSHELL7_PATH, [...POWERSHELL7_PREFIX, "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")]);
    const result = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes).replace(/^\uFEFF/, ""));
    assert.deepEqual(result, { cases: 50, nativeDiskInstances: 0, nativeAdapterCalls: 0, fixedHandleSlots: 3, peakFakeHandles: 2,
        maximumScratchBytes: 4096, maximumUnresolvedHandles: 2, failedClosesRetried: 0 });
});

