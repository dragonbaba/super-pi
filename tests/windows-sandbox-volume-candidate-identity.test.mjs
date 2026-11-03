import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID, createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { nativePrivateIdentity } from "../scripts/acceptance/windows-sandbox-volume-candidate-private.mjs";
import { verifyPowerShell7, POWERSHELL7_PATH, POWERSHELL7_PREFIX } from "../scripts/acceptance/windows-sandbox-volume.mjs";

test("one registered private file has the same exact Node and native Windows identity", { timeout: 40000 }, t => {
    assert.equal(process.platform, "win32"); assert.equal(process.version, "v26.13.0");
    const workspace = fileURLToPath(new URL("..", import.meta.url)), parent = path.join(workspace, ".artifacts");
    assert.equal(fs.realpathSync(parent), parent); assert.equal(fs.lstatSync(parent).isSymbolicLink(), false);
    const root = path.join(parent, "candidate-identity-" + randomUUID());
    let rootCreated = false, rootId = null;
    const file = path.join(root, "identity.bin"), assembly = path.join(root, "identity-check.dll");
    const files = [], runs = [], node = { pid: process.pid, fd: null, opened: false, created: false,
        operationFailed: false, operationError: null, closeAttempts: 0, closeFailed: false, closeError: null,
        closed: false, writeCount: null, flushed: false, before: null, after: null };
    let processesClosed = true, nativeStarted = false, nativeKnownClosed = false, identityVerified = false, native = null;
    const describe = error => error instanceof Error ? { name: error.name, code: error.code ?? null, message: error.message.slice(0, 160) }
        : { type: typeof error, value: String(error).slice(0, 160) };
    const shape = stat => ({ id: nativePrivateIdentity(stat), dev: String(stat.dev), ino: String(stat.ino), size: String(stat.size),
        links: String(stat.nlink), mtimeNs: String(stat.mtimeNs), ctimeNs: String(stat.ctimeNs) });
    function checkRoot() {
        const stat = fs.lstatSync(root, { bigint: true });
        assert.equal(stat.isDirectory(), true); assert.equal(stat.isSymbolicLink(), false); assert.equal(nativePrivateIdentity(stat), rootId);
        assert.equal(fs.realpathSync(root), root); assert.equal(path.dirname(root), parent);
    }
    function register(target, maximum) {
        checkRoot(); const stat = fs.lstatSync(target, { bigint: true });
        assert.equal(stat.isFile(), true); assert.equal(stat.isSymbolicLink(), false); assert.equal(stat.nlink, 1n);
        assert.ok(stat.size <= BigInt(maximum)); assert.equal(fs.realpathSync(target), target);
        const record = { path: target, maximum, ...shape(stat) }; files.push(record); return record;
    }
    function emit(value, maximum) {
        const bytes = Buffer.from(JSON.stringify(value) + "\n"); assert.ok(bytes.length <= maximum);
        try { for (let offset = 0; offset < bytes.length;) {
            const written = fs.writeSync(1, bytes, offset, bytes.length - offset); assert.ok(written > 0); offset += written;
        } } finally { bytes.fill(0); }
    }
    t.after(() => {
        if (!rootCreated) return;
        let inspectionError = null;
        try {
            checkRoot();
            if (processesClosed && !files.some(item => item.path === assembly) && fs.existsSync(assembly)) register(assembly, 16384);
            const names = fs.readdirSync(root); assert.ok(names.length <= 2);
            assert.deepEqual(names.sort(), files.map(item => path.basename(item.path)).sort());
            for (const record of files) {
                const current = fs.lstatSync(record.path, { bigint: true });
                assert.equal(nativePrivateIdentity(current), record.id); assert.equal(current.isSymbolicLink(), false);
                assert.equal(current.isFile(), true); assert.equal(current.nlink, 1n); assert.ok(current.size <= BigInt(record.maximum));
                assert.equal(fs.realpathSync(record.path), record.path); record.finalSize = String(current.size);
            }
        } catch (error) { inspectionError = describe(error); }
        emit({ kind: "candidate-identity-evidence", root, rootId, processesClosed, nativeStarted, nativeKnownClosed, identityVerified,
            node, native, files, runs, inspectionError }, 12288);
        assert.equal(processesClosed, true, "Unresolved owned process; preserve root");
        assert.ok(!nativeStarted || nativeKnownClosed, "Native close not established; preserve root");
        assert.ok(!nativeStarted || identityVerified, "Cross-interface identity not established; preserve root");
        assert.ok(!node.opened || node.closed, "Node close unknown; preserve root");
        assert.equal(inspectionError, null, "Unknown artifact identity; preserve root");
        let removed = 0;
        try {
            for (const record of files) {
                checkRoot(); const current = fs.lstatSync(record.path, { bigint: true });
                assert.equal(nativePrivateIdentity(current), record.id); assert.equal(String(current.size), record.finalSize);
                assert.equal(current.isFile(), true); assert.equal(current.isSymbolicLink(), false); assert.equal(current.nlink, 1n);
                assert.equal(fs.realpathSync(record.path), record.path); fs.unlinkSync(record.path); removed++;
            }
            checkRoot(); fs.rmdirSync(root); assert.equal(fs.existsSync(root), false);
        } catch (error) {
            emit({ kind: "candidate-identity-cleanup", rootRemoved: false, filesRemoved: removed, error: describe(error) }, 1024); throw error;
        }
        emit({ kind: "candidate-identity-cleanup", rootRemoved: true, filesRemoved: removed }, 1024);
    });
    function run(role, executable, args) {
        const record = { role, requestedUtc: new Date().toISOString(), phase: "requested-unknown", pid: null,
            status: null, signal: null, error: null, stdout: null, stderr: null, stdoutBytes: null, stderrBytes: null, truncated: null };
        runs.push(record); processesClosed = false; let result;
        try { result = spawnSync(executable, args, { cwd: root, windowsHide: true, timeout: 15000, maxBuffer: 4096 }); }
        catch (error) { record.error = describe(error); record.phase = "call-threw-unknown"; throw error; }
        processesClosed = Number.isInteger(result.status) || typeof result.signal === "string";
        Object.assign(record, { phase: processesClosed ? "closed" : "unresolved", pid: result.pid ?? null, status: result.status,
            signal: result.signal, error: result.error ? describe(result.error) : null,
            stdoutBytes: result.stdout?.length ?? 0, stderrBytes: result.stderr?.length ?? 0,
            stdout: result.stdout?.subarray(0, 4096).toString("utf8") ?? "", stderr: result.stderr?.subarray(0, 1024).toString("utf8") ?? "",
            truncated: (result.stdout?.length ?? 0) > 4096 || (result.stderr?.length ?? 0) > 1024 });
        return { result, record };
    }
    function cleanProcess(result) {
        assert.equal(result.error, undefined); assert.equal(result.status, 0); assert.equal(result.signal, null);
        assert.equal(result.stderr.length, 0); assert.ok(result.stdout.length <= 4096);
    }
    fs.mkdirSync(root); rootCreated = true;
    rootId = nativePrivateIdentity(fs.lstatSync(root, { bigint: true }));
    verifyPowerShell7();
    const compiler = "C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe";
    assert.equal(createHash("sha256").update(fs.readFileSync(compiler)).digest("hex"), "eca02e6b15cde93009a59a3d129d5a77fb5008f2e1cf62cf573b6737c747ecc3");
    const compiled = run("compile", compiler, ["/nologo", "/target:library", "/platform:x64", "/out:" + assembly,
        path.join(workspace, "tests/fixtures/windows-sandbox-volume-candidate-identity-check.cs")]);
    cleanProcess(compiled.result); const assemblyRecord = register(assembly, 16384);
    assert.ok(Number(assemblyRecord.size) > 0);
    const bytes = Buffer.alloc(32, 0x5a); let failed = false, failure, closeFailed = false, closeFailure;
    try {
        checkRoot(); node.fd = fs.openSync(file, "wx", 0o600); node.opened = true; node.created = true;
        const opened = fs.fstatSync(node.fd, { bigint: true });
        assert.equal(opened.isFile(), true); assert.equal(opened.nlink, 1n); assert.equal(opened.size, 0n);
        const fileRecord = register(file, 32); assert.equal(fileRecord.id, nativePrivateIdentity(opened));
        node.writeCount = fs.writeSync(node.fd, bytes, 0, 32, 0); assert.equal(node.writeCount, 32);
        fs.fsyncSync(node.fd); node.flushed = true;
        const before = fs.fstatSync(node.fd, { bigint: true }); node.before = shape(before);
        assert.equal(node.before.id, fileRecord.id); assert.equal(before.size, 32n); assert.equal(before.nlink, 1n);
        verifyPowerShell7(); checkRoot(); nativeStarted = true;
        const observed = run("native-metadata", POWERSHELL7_PATH, [...POWERSHELL7_PREFIX, "-File",
            path.join(workspace, "tests/fixtures/windows-sandbox-volume-candidate-identity-check.ps1"),
            "-AssemblyPath", assembly, "-FilePath", file]);
        if (observed.result.stdout?.length > 0 && observed.result.stdout.length <= 2048) {
            native = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(observed.result.stdout));
            assert.equal(native.ProcessId, observed.result.pid);
            nativeKnownClosed = native.Opened === false ? native.CloseAttempts === 0 && native.Closed === false && native.CloseFailed === false
                : native.Opened === true && native.CloseAttempts === 1 && native.Closed === true && native.CloseFailed === false;
        }
        cleanProcess(observed.result); assert.ok(native); assert.equal(native.OperationFailed, false);
        assert.equal(native.Opened, true); assert.equal(nativeKnownClosed, true); assert.equal(native.CloseCode, null);
        assert.equal(native.Identity, node.before.id); assert.equal(native.Bytes, 32); assert.equal(native.Links, 1);
        assert.equal(native.FinalPath.toLowerCase(), ("\\\\?\\" + file).toLowerCase());
        assert.equal(native.Attributes & (0x10 | 0x200 | 0x400 | 0x800 | 0x4000), 0);
        const after = fs.fstatSync(node.fd, { bigint: true }); node.after = shape(after);
        assert.deepEqual(node.after, node.before); assert.equal(after.isFile(), true);
        assert.equal(nativePrivateIdentity(fs.lstatSync(file, { bigint: true })), node.before.id); checkRoot(); identityVerified = true;
    } catch (error) { failed = true; failure = error; node.operationFailed = true; node.operationError = describe(error); }
    finally {
        bytes.fill(0);
        if (node.opened) {
            node.closeAttempts = 1;
            try { fs.closeSync(node.fd); node.closed = true; }
            catch (error) { closeFailed = true; closeFailure = error; node.closeFailed = true; node.closeError = describe(error); }
        }
    }
    if (failed && closeFailed) throw new AggregateError([failure, closeFailure], "Identity operation and Node close failed");
    if (failed) throw failure; if (closeFailed) throw closeFailure;
    assert.equal(bytes.every(value => value === 0), true); assert.equal(node.closeAttempts, 1); assert.equal(node.closed, true);
});
