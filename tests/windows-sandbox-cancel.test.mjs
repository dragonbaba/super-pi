import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { spawnSync } from "node:child_process";
import { cancellationPassed, validateCancellationReady, finishCancellationArtifacts, CANCEL_PROTOCOL } from "../scripts/acceptance/windows-sandbox-cancel.mjs";
import { SandboxLifecycle, CapturedProcess } from "../scripts/acceptance/windows-sandbox-lifecycle.mjs";
import { sha256 } from "../scripts/acceptance/windows-sandbox-package.mjs";
const taskId = "11111111-2222-3333-4444-555555555555";
const ready = () => ({ protocol: CANCEL_PROTOCOL, taskId, pid: 222, sessionId: 0, system: true, lifetimeMs: 60000 });
const ok = (stdout = "", exitCode = 0) => ({ exitCode, signal: null, launchError: null, truncated: false, stdout, stderr: "", pid: 123, closedUtc: "2026-11-01T00:00:00Z" });
function record() {
    return { taskId, ready: ready(), readyElapsedMs: 250, cancelElapsedMs: 251, executionTotalMs: 500,
        externalCancelled: false, plannedCancel: true, executionPendingAtCancel: true, logicalCancelled: true,
        closed: true, artifactsRemoved: true, error: null, cleanupError: null, helperPendingPid: null,
        lifecycle: { taskId, state: "closed", startSettled: true, registered: true, stopAttempted: true,
            controlPending: false, executionPending: false, connectionPending: false,
            calls: [{ kind: "start", result: ok() }, { kind: "exec", outcome: "cancelled/settled", result: ok("stopped", 1) },
                { kind: "stop", result: ok() }, { kind: "list", result: ok('{"WindowsSandboxEnvironments":[]}') }] } };
}
test("active cancellation needs valid readiness, planned timing and physical close; early/natural/external exits never pass", () => {
    assert.equal(validateCancellationReady(ready(), taskId).pid, 222); assert.equal(cancellationPassed(record()), true);
    for (const change of [{ taskId: "other" }, { pid: 0 }, { system: false }, { sessionId: 1 }, { lifetimeMs: 10 }, { extra: true }]) assert.throws(() => validateCancellationReady({ ...ready(), ...change }, taskId));
    for (const mutate of [r => r.ready = null, r => r.error = "not-ready", r => r.externalCancelled = true, r => r.executionPendingAtCancel = false,
        r => r.plannedCancel = false, r => r.logicalCancelled = false, r => r.cancelElapsedMs = 10000, r => r.executionTotalMs = 30000,
        r => r.executionTotalMs = 250, r => r.lifecycle.calls[1].outcome = "settled", r => r.lifecycle.calls[1].result = ok('{"ExitCode":73}'),
        r => r.lifecycle.calls[1].result = ok('{"ExitCode":73}', 1), r => r.lifecycle.calls[1].result = ok("unknown-schema"),
        r => r.lifecycle.calls[1].result.closedUtc = null, r => r.lifecycle.calls[1].result.truncated = true, r => r.lifecycle.calls[1].result.launchError = "failed",
        r => r.lifecycle.calls[1].result.exitCode = null, r => r.lifecycle.calls[1].result.exitCode = undefined, r => r.lifecycle.calls[1].result.exitCode = "1",
        r => r.lifecycle.executionPending = true, r => r.lifecycle.stopAttempted = false, r => r.lifecycle.calls[2].result.exitCode = 1,
        r => r.closed = false, r => r.artifactsRemoved = false, r => r.helperPendingPid = 123, r => r.cleanupError = "pending"]) {
        const r = record(); mutate(r); assert.equal(cancellationPassed(r), false);
    }
    for (const exitCode of [73, 125, 126]) for (const cliCode of [0, 1]) for (const prefix of ["", "\uFEFF"]) {
        const r = record(); r.lifecycle.calls[1].result = ok(prefix + JSON.stringify({ ExitCode: exitCode }), cliCode);
        assert.equal(cancellationPassed(r), false);
    }
    const cleanupCrossesWindow = record(); cleanupCrossesWindow.artifactsRemoved = false;
    let clock = 29900;
    finishCancellationArtifacts(cleanupCrossesWindow, { remove() { clock = 30100; }, journal() { throw new Error("unexpected"); } }, { state: "closed" }, false, 0, () => clock);
    assert.equal(cleanupCrossesWindow.artifactsRemoved, true); assert.equal(cleanupCrossesWindow.executionTotalMs, 30100);
    assert.equal(cancellationPassed(cleanupCrossesWindow), false); // Exercises the same resource/timing boundary used by the driver.
});
class Call extends EventEmitter { pid = 123; wait = CapturedProcess.prototype.wait; constructor(result) { super(); this.result = result; } finish(result) { this.result = result; this.emit("settled"); } }
test("owned fixed cancel entry drains delayed exec after stop and retains ownership when physical close is missing", async () => {
    async function scenario(settle) {
        let id, running = false, stop = false; const execution = new Call();
        const cli = { launch(args) {
            if (args[0] === "start") { id = args[2]; running = true; return new Call(ok()); }
            if (args[0] === "list") {
                if (stop && settle && !execution.result) setTimeout(() => execution.finish(ok("instance stopped", 1)), 1);
                return new Call(ok(JSON.stringify({ WindowsSandboxEnvironments: running ? [{ Id: id }] : [] })));
            }
            if (args[0] === "stop") { stop = true; running = false; return new Call(ok()); }
            assert.deepEqual(args, ["exec", "--id", id, "-c", '"C:\\SuperPiCancel\\Input\\probe.exe"', "-d", "C:\\SuperPiCancel\\Input", "-r", "System", "--raw"]); return execution;
        } };
        const owner = new SandboxLifecycle({ cli, config: "fixture", journal() {}, limits: { callMs: 100, startMs: 100, execMs: 100, settleMs: settle ? 100 : 1, exitMs: 100, pollMs: 1 } });
        await assert.rejects(owner.executeCancellationProbe(), /owned registration/); await owner.start();
        const controller = new AbortController(), invoked = owner.executeCancellationProbe(controller.signal);
        controller.abort(); await assert.rejects(invoked, /CLI exec: cancelled/); assert.ok(owner.execution);
        assert.equal(await owner.cleanup(), settle); assert.equal(stop, true);
        if (settle) { assert.equal(owner.execution, undefined); assert.equal(owner.state, "closed"); }
        else { assert.equal(owner.state, "blocked-cleanup"); assert.ok(owner.execution); execution.finish(ok("fixture released", 1)); }
        assert.equal(execution.listenerCount("settled"), 0); assert.equal(await owner.cleanup(), settle);
    }
    await scenario(true); await scenario(false);
});
test("fixed waiting guest compiles but is never executed on the host", { skip: process.platform !== "win32" }, t => {
    const repository = fileURLToPath(new URL("../", import.meta.url)), compiler = "C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe";
    assert.equal(sha256(compiler), "eca02e6b15cde93009a59a3d129d5a77fb5008f2e1cf62cf573b6737c747ecc3");
    const parent = fs.realpathSync(path.join(repository, ".artifacts")), root = path.join(parent, "wsb-cancel-compile-" + randomUUID());
    fs.mkdirSync(root); const identity = fs.lstatSync(root, { bigint: true }), executable = path.join(root, "probe.exe"); let binary;
    try {
        const compiled = spawnSync(compiler, ["/nologo", "/target:exe", "/platform:x64", "/reference:System.Web.Extensions.dll", "/out:" + executable,
            path.join(repository, "scripts", "acceptance", "windows-sandbox-cancel.cs")], { cwd: root, windowsHide: true, encoding: "utf8", timeout: 30000, maxBuffer: 16 * 1024 });
        if (fs.existsSync(executable)) binary = fs.lstatSync(executable, { bigint: true });
        assert.ifError(compiled.error); assert.equal(compiled.status, 0, compiled.stdout + compiled.stderr);
        t.diagnostic(JSON.stringify({ root, compilerPid: compiled.pid, probeSha256: sha256(executable) }));
    } finally {
        const actual = fs.lstatSync(root, { bigint: true }); assert.ok(actual.isDirectory() && !actual.isSymbolicLink() && actual.dev === identity.dev && actual.ino === identity.ino);
        assert.equal(fs.realpathSync(root), root); assert.equal(path.dirname(root), parent);
        if (binary) { const current = fs.lstatSync(executable, { bigint: true }); assert.ok(current.isFile() && !current.isSymbolicLink() && current.dev === binary.dev && current.ino === binary.ino); fs.unlinkSync(executable); }
        fs.rmdirSync(root); assert.equal(fs.existsSync(root), false); t.diagnostic("Owned compile artifact removed; guest was not run.");
    }
});
