import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { spawnSync } from "node:child_process";
import { FILE_PROTOCOL, DENIED_NAMES, validateFileReceipt, fileVerdict, snapshotFixture, verifyFixture, readBoundedFile } from "../scripts/acceptance/windows-sandbox-files.mjs";
import { SandboxLifecycle, CapturedProcess } from "../scripts/acceptance/windows-sandbox-lifecycle.mjs";
import { sha256 } from "../scripts/acceptance/windows-sandbox-package.mjs";
const taskId = "11111111-2222-3333-4444-555555555555";
const ok = (stdout = "") => ({ exitCode: 0, signal: null, launchError: null, truncated: false, stdout, stderr: "" });
const denied = name => ({ name, opened: false, openError: 5, closeError: null });
function receipt() { return { protocol: FILE_PROTOCOL, taskId, pid: 222, sessionId: 0, system: true, error: null,
    inputReadMatched: true, outputMatched: true, complete: true, ro: denied("ro-append"), denied: DENIED_NAMES.map(denied) }; }
function record() { return { receipt: receipt(), hostChecks: Array.from({ length: 5 }, () => ({ status: "unchanged" })), outputMatched: true,
    error: null, cleanupError: null, helperPendingPid: null, artifactsRemoved: true, closed: true, wrapperExitCode: 0,
    lifecycle: { state: "closed", stopAttempted: true, controlPending: false, executionPending: false, connectionPending: false, calls: [{ kind: "exec", result: ok() }] } }; }
test("file mapping evidence requires controls and exact errors; a successful open stays a failure after later errors", () => {
    validateFileReceipt(receipt(), taskId); assert.equal(fileVerdict(record()), "limited-pass");
    for (const code of [2, 3]) { const r = record(); r.receipt.denied[0].openError = code; assert.equal(fileVerdict(r), "limited-pass"); }
    for (const mutate of [r => r.error = "missing result", r => r.receipt.ro.openError = 2, r => r.receipt.denied[0].openError = 32,
        r => r.receipt.denied[0].openError = 112, r => r.receipt.complete = false, r => r.receipt.inputReadMatched = false,
        r => r.receipt.outputMatched = false, r => r.outputMatched = false, r => r.hostChecks[0].status = "unavailable",
        r => r.hostChecks.pop(), r => r.closed = false, r => r.artifactsRemoved = false, r => r.wrapperExitCode = 1,
        r => r.lifecycle.executionPending = true, r => r.lifecycle.stopAttempted = false, r => r.cleanupError = "pending"]) {
        const r = record(); mutate(r); assert.equal(fileVerdict(r), "inconclusive");
    }
    for (const choose of [r => r.ro, r => r.denied[0]]) {
        const r = record(), opened = choose(r.receipt); opened.opened = true; opened.openError = null; opened.closeError = 5;
        r.receipt.complete = false; r.receipt.error = "IOException"; r.error = "late failure"; r.artifactsRemoved = false;
        validateFileReceipt(r.receipt, taskId); assert.equal(fileVerdict(r), "boundary-failure");
    }
    const changed = record(); changed.receipt = null; changed.error = "missing guest result"; changed.hostChecks[0].status = "changed";
    assert.equal(fileVerdict(changed), "boundary-failure");
    for (const mutate of [r => r.taskId = "other", r => r.system = false, r => r.denied[0].name = "wrong", r => r.denied[0].openError = "5",
        r => r.denied[0].openError = null, r => r.denied[0].closeError = 5, r => r.ro.opened = true, r => r.privateContents = "unexpected"]) {
        const r = receipt(); mutate(r); assert.throws(() => validateFileReceipt(r, taskId));
    }
});
class Call extends EventEmitter { pid = 123; wait = CapturedProcess.prototype.wait; constructor(result) { super(); this.result = result; } }
test("fixed file entry is bound to the owned System instance and cleanup", async () => {
    let id, running = false;
    const cli = { launch(args) {
        if (args[0] === "start") { id = args[2]; running = true; return new Call(ok()); }
        if (args[0] === "stop") { running = false; return new Call(ok()); }
        if (args[0] === "list") return new Call(ok(JSON.stringify({ WindowsSandboxEnvironments: running ? [{ Id: id }] : [] })));
        assert.deepEqual(args, ["exec", "--id", id, "-c", '"C:\\SuperPiFiles\\Input\\probe.exe"', "-d", "C:\\SuperPiFiles\\Input", "-r", "System", "--raw"]);
        return new Call(ok('{"ExitCode":0}'));
    } };
    const owner = new SandboxLifecycle({ cli, config: "fixture", journal() {} });
    await assert.rejects(owner.executeFileProbe(), /owned registration/); await owner.start(); await owner.executeFileProbe();
    assert.equal(await owner.cleanup(), true); assert.equal(owner.execution, undefined); assert.equal(owner.stopAttempted, true);
});
test("host sentinel checks detect content and length changes; fixed guest compiles without host execution", { skip: process.platform !== "win32" }, t => {
    const repository = fileURLToPath(new URL("../", import.meta.url)), compiler = "C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe";
    assert.equal(sha256(compiler), "eca02e6b15cde93009a59a3d129d5a77fb5008f2e1cf62cf573b6737c747ecc3");
    const parent = fs.realpathSync(path.join(repository, ".artifacts")), root = path.join(parent, "wsb-files-check-" + randomUUID());
    fs.mkdirSync(root); const identity = fs.lstatSync(root, { bigint: true }), executable = path.join(root, "probe.exe"), canary = path.join(root, "canary.bin"); let binary, canaryIdentity;
    try {
        fs.writeFileSync(canary, Buffer.alloc(32, 1), { flag: "wx" }); canaryIdentity = fs.lstatSync(canary, { bigint: true });
        const before = snapshotFixture(canary, 32); assert.equal(verifyFixture(before).status, "unchanged");
        for (const observation of ["open-length", "read-length", "identity", "missing", "unknown-io"]) {
            let stats = 0, closes = 0;
            const io = { ...fs, openSync(file, flags) {
                if (observation === "missing" || observation === "unknown-io") throw Object.assign(new Error("controlled IO"), { code: observation === "missing" ? "ENOENT" : "EIO" });
                return fs.openSync(file, flags);
            }, fstatSync(fd, options) {
                const value = fs.fstatSync(fd, options); stats++;
                if (observation === "open-length" || observation === "read-length" && stats === 2) value.size++;
                if (observation === "identity") value.ino++;
                return value;
            }, closeSync(fd) { fs.closeSync(fd); closes++; throw new Error("later close error"); } };
            const check = verifyFixture(before, io), r = record(); r.receipt = null; r.error = "missing guest result"; r.hostChecks[0] = check;
            assert.equal(check.status, observation === "unknown-io" ? "unavailable" : "changed");
            assert.equal(fileVerdict(r), observation === "unknown-io" ? "inconclusive" : "boundary-failure");
            assert.equal(closes, ["missing", "unknown-io"].includes(observation) ? 0 : 1);
        }
        fs.writeFileSync(canary, Buffer.alloc(32, 2)); assert.equal(verifyFixture(before).status, "changed");
        fs.appendFileSync(canary, Buffer.from([3])); assert.equal(verifyFixture(before).reason, "length"); assert.throws(() => readBoundedFile(canary, 32), /length/);
        const compiled = spawnSync(compiler, ["/nologo", "/target:exe", "/platform:x64", "/reference:System.Web.Extensions.dll", "/out:" + executable,
            path.join(repository, "scripts", "acceptance", "windows-sandbox-files.cs")], { cwd: root, windowsHide: true, encoding: "utf8", timeout: 30000, maxBuffer: 16 * 1024 });
        if (fs.existsSync(executable)) binary = fs.lstatSync(executable, { bigint: true });
        assert.ifError(compiled.error); assert.equal(compiled.status, 0, compiled.stdout + compiled.stderr);
        t.diagnostic(JSON.stringify({ root, compilerPid: compiled.pid, probeSha256: sha256(executable) }));
    } finally {
        const actual = fs.lstatSync(root, { bigint: true }); assert.ok(actual.isDirectory() && !actual.isSymbolicLink() && actual.dev === identity.dev && actual.ino === identity.ino);
        assert.equal(fs.realpathSync(root), root); assert.equal(path.dirname(root), parent);
        for (const [file, recorded] of [[executable, binary], [canary, canaryIdentity]]) if (recorded) {
            const current = fs.lstatSync(file, { bigint: true }); assert.ok(current.isFile() && !current.isSymbolicLink() && current.dev === recorded.dev && current.ino === recorded.ino); fs.unlinkSync(file);
        }
        fs.rmdirSync(root); assert.equal(fs.existsSync(root), false); t.diagnostic("Owned check files removed; guest was not executed.");
    }
});
