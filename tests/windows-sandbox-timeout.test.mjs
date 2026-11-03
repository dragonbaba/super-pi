import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { observeExecutionTimeout, timeoutPassed } from "../scripts/acceptance/windows-sandbox-timeout.mjs";
import { CANCEL_PROTOCOL, finishCancellationArtifacts } from "../scripts/acceptance/windows-sandbox-cancel.mjs";
import { SandboxLifecycle, CapturedProcess } from "../scripts/acceptance/windows-sandbox-lifecycle.mjs";
const taskId = "11111111-2222-3333-4444-555555555555";
const ready = () => ({ protocol: CANCEL_PROTOCOL, taskId, pid: 222, sessionId: 0, system: true, lifetimeMs: 60000 });
const ok = (stdout = "", exitCode = 0) => ({ exitCode, signal: null, launchError: null, truncated: false, stdout, stderr: "", pid: 123, closedUtc: "2026-11-01T00:00:00Z" });
function record() {
    return { taskId, execBudgetMs: 10000, ready: ready(), readyElapsedMs: 250, timeoutElapsedMs: 10001, executionTotalMs: 11000,
        externalCancelled: false, readyBeforeTimeout: true, logicalTimeout: true, executionPendingAtTimeout: true,
        closed: true, artifactsRemoved: true, error: null, cleanupError: null, helperPendingPid: null,
        lifecycle: { taskId, state: "closed", startSettled: true, registered: true, stopAttempted: true,
            controlPending: false, executionPending: false, connectionPending: false,
            calls: [{ kind: "start", result: ok() }, { kind: "exec", outcome: "timeout/settled", result: ok("stopped", 1) },
                { kind: "stop", result: ok() }, { kind: "list", result: ok('{"WindowsSandboxEnvironments":[]}') }] } };
}
test("independent timeout requires earlier readiness, its own deadline, physical close and full cleanup within the window", () => {
    assert.equal(timeoutPassed(record()), true);
    for (const mutate of [r => r.execBudgetMs = 30000, r => r.ready = null, r => r.ready.taskId = "wrong", r => r.readyElapsedMs = 10000,
        r => r.readyBeforeTimeout = false, r => r.externalCancelled = true, r => r.logicalTimeout = false, r => r.executionPendingAtTimeout = false,
        r => r.timeoutElapsedMs = 9999, r => r.executionTotalMs = 30000, r => r.executionTotalMs = 10000, r => r.error = "ready failed",
        r => r.lifecycle.calls[1].outcome = "cancelled/settled", r => r.lifecycle.calls[1].result.closedUtc = null,
        r => r.lifecycle.calls[1].result.exitCode = null, r => r.lifecycle.calls[1].result = ok("unknown-schema"),
        r => r.lifecycle.calls[1].result.truncated = true, r => r.lifecycle.calls[2].result.exitCode = 1, r => r.lifecycle.executionPending = true,
        r => r.lifecycle.stopAttempted = false, r => r.helperPendingPid = 123, r => r.cleanupError = "pending", r => r.artifactsRemoved = false]) {
        const r = record(); mutate(r); assert.equal(timeoutPassed(r), false);
    }
    for (const code of [73, 125, 126]) for (const cliCode of [0, 1]) for (const prefix of ["", "\uFEFF"]) {
        const r = record(); r.lifecycle.calls[1].result = ok(prefix + JSON.stringify({ ExitCode: code }), cliCode); assert.equal(timeoutPassed(r), false);
    }
    const r = record(); r.artifactsRemoved = false; let clock = 29900;
    finishCancellationArtifacts(r, { remove() { clock = 30100; }, journal() { throw Error("unexpected"); } }, { state: "closed" }, false, 0, () => clock);
    assert.equal(r.artifactsRemoved, true); assert.equal(r.executionTotalMs, 30100); assert.equal(timeoutPassed(r), false);
});
class Call extends EventEmitter { pid = 123; wait = CapturedProcess.prototype.wait; constructor(result) { super(); this.result = result; } finish(result) { this.result = result; this.emit("settled"); } }
test("driver wiring observes the actual wait timer, rejects logically late readiness, and drains or retains the owned exec", async () => {
    async function scenario(settle, lateReady) {
        let id, running = false, stopped = false; const exec = new Call(), state = {}, controller = new AbortController();
        const cli = { launch(args) {
            if (args[0] === "start") { id = args[2]; running = true; return new Call(ok()); }
            if (args[0] === "stop") { stopped = true; running = false; if (settle) setTimeout(() => exec.finish(ok("stopped", 1)), 1); return new Call(ok()); }
            if (args[0] === "list") return new Call(ok(JSON.stringify({ WindowsSandboxEnvironments: running ? [{ Id: id }] : [] })));
            assert.deepEqual(args, ["exec", "--id", id, "-c", '"C:\\SuperPiCancel\\Input\\probe.exe"', "-d", "C:\\SuperPiCancel\\Input", "-r", "System", "--raw"]); return exec;
        } };
        const owner = new SandboxLifecycle({ cli, taskId, config: "fixture", journal() {}, limits: { callMs: 100, startMs: 100, execMs: 10, settleMs: settle ? 100 : 1, exitMs: 100, pollMs: 1 } });
        await owner.start(); const r = { taskId, execBudgetMs: 10 }; let clockCall = 0;
        const observed = observeExecutionTimeout(owner, r, controller.signal, async () => { if (lateReady) await state.execution; return ready(); }, state,
            () => [0, 1, 10][clockCall++]);
        if (lateReady) await assert.rejects(observed, /before logical timeout/); else { await observed; assert.equal(r.logicalTimeout, true); assert.equal(r.executionPendingAtTimeout, true); }
        assert.equal(controller.signal.aborted, false); assert.equal(state.slot.entry.outcome, "timeout"); assert.ok(owner.execution);
        assert.equal(await owner.cleanup(), settle); assert.equal(stopped, true);
        if (settle) { assert.equal(owner.execution, undefined); assert.equal(state.slot.entry.outcome, "timeout/settled"); assert.equal(owner.state, "closed"); }
        else { assert.equal(owner.state, "blocked-cleanup"); assert.ok(owner.execution); exec.finish(ok("release fixture", 1)); }
        assert.equal(exec.listenerCount("settled"), 0); assert.equal(await owner.cleanup(), settle);
    }
    await scenario(true, false); await scenario(false, false); await scenario(true, true);
});
