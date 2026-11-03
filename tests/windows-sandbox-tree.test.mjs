import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { spawnSync } from "node:child_process";
import { TREE_PROTOCOL, validateTreeReady, treeCancellationPassed, observeTreeCancellation } from "../scripts/acceptance/windows-sandbox-tree.mjs";
import { CANCEL_PROTOCOL } from "../scripts/acceptance/windows-sandbox-cancel.mjs";
import { SandboxLifecycle, CapturedProcess } from "../scripts/acceptance/windows-sandbox-lifecycle.mjs";
import { sha256 } from "../scripts/acceptance/windows-sandbox-package.mjs";
const taskId = "11111111-2222-3333-4444-555555555555";
const ready = () => ({ protocol: CANCEL_PROTOCOL, taskId, pid: 222, sessionId: 0, system: true, lifetimeMs: 60000 });
const ok = (stdout = "", exitCode = 0) => ({ exitCode, signal: null, launchError: null, truncated: false, stdout, stderr: "", pid: 123, closedUtc: "2026-11-01T00:00:00Z" });
function tree() {
    const nodes = ["parent", "child", "grandchild"].map((role, i) => ({ role, pid: 222 + i, creationTicks: "63900000000000000" + i,
        path: "C:\\SuperPiCancel\\Input\\probe.exe", sessionId: 0, system: true, alive: true }));
    return { protocol: TREE_PROTOCOL, taskId, complete: true, nodes, edges: nodes.slice(1).map((node, i) => ({ parentPid: nodes[i].pid, childPid: node.pid, childCreationTicks: node.creationTicks })) };
}
function record() {
    return { taskId, ready: ready(), treeReady: tree(), readyElapsedMs: 250, cancelElapsedMs: 251, executionTotalMs: 500,
        externalCancelled: false, plannedCancel: true, executionPendingAtCancel: true, logicalCancelled: true,
        closed: true, artifactsRemoved: true, error: null, cleanupError: null, helperPendingPid: null,
        lifecycle: { taskId, state: "closed", startSettled: true, registered: true, stopAttempted: true, controlPending: false, executionPending: false, connectionPending: false,
            calls: [{ kind: "start", result: ok() }, { kind: "exec", outcome: "cancelled/settled", result: ok("stopped", 1) },
                { kind: "stop", result: ok() }, { kind: "list", result: ok('{"WindowsSandboxEnvironments":[]}') }] } };
}
test("tree readiness requires all three live identities and both actual-start edges; partial or mismatched trees never pass", () => {
    validateTreeReady(tree(), taskId, 222); assert.equal(treeCancellationPassed(record()), true);
    for (const mutate of [x => x.complete = false, x => x.taskId = "other", x => x.nodes.pop(), x => x.edges.pop(), x => x.nodes[2].pid = 223,
        x => x.nodes[1].role = "grandchild", x => x.nodes[2].alive = false, x => x.nodes[1].system = false, x => x.nodes[1].sessionId = 1,
        x => x.nodes[2].path = "other.exe", x => x.nodes[0].pid = 123, x => x.nodes[1].creationTicks = "638000000000000000",
        x => x.edges[1].childCreationTicks = "639000000000000009", x => x.edges[1].parentPid = 222, x => x.edges[0].childPid = 224,
        x => x.nodes[0].unknown = true, x => x.nodes[0].creationTicks = "not-time"]) {
        const r = record(); mutate(r.treeReady); assert.throws(() => validateTreeReady(r.treeReady, taskId, 222)); assert.equal(treeCancellationPassed(r), false);
    }
    for (const mutate of [r => r.error = "partial creation", r => r.externalCancelled = true, r => r.executionTotalMs = 30000,
        r => r.artifactsRemoved = false, r => r.lifecycle.executionPending = true, r => r.lifecycle.calls[1].result = ok('{"ExitCode":73}')]) {
        const r = record(); mutate(r); assert.equal(treeCancellationPassed(r), false);
    }
});
class Call extends EventEmitter { pid = 123; wait = CapturedProcess.prototype.wait; constructor(result) { super(); this.result = result; } finish(result) { this.result = result; this.emit("settled"); } }
test("tree cancellation wiring requires complete readiness and still cleans partial trees; missing close retains ownership", async () => {
    async function scenario(settle, complete) {
        let id, running = false, stopped = false; const exec = new Call(), state = {}, controller = new AbortController();
        const cli = { launch(args) {
            if (args[0] === "start") { id = args[2]; running = true; return new Call(ok()); }
            if (args[0] === "stop") { stopped = true; running = false; if (settle) setTimeout(() => exec.finish(ok("stopped", 1)), 1); return new Call(ok()); }
            if (args[0] === "list") return new Call(ok(JSON.stringify({ WindowsSandboxEnvironments: running ? [{ Id: id }] : [] })));
            assert.deepEqual(args, ["exec", "--id", id, "-c", '"C:\\SuperPiCancel\\Input\\probe.exe"', "-d", "C:\\SuperPiCancel\\Input", "-r", "System", "--raw"]); return exec;
        } };
        const owner = new SandboxLifecycle({ cli, taskId, config: "fixture", journal() {}, limits: { callMs: 100, startMs: 100, execMs: 1000, settleMs: settle ? 100 : 1, exitMs: 100, pollMs: 1 } });
        await owner.start(); const r = { taskId, plannedCancel: false }; let clock = 0;
        const observed = observeTreeCancellation(owner, r, controller, async () => { const value = tree(); value.complete = complete; return { ready: ready(), tree: value }; }, state, () => clock++);
        if (complete) { await observed; assert.equal(r.plannedCancel, true); assert.equal(r.logicalCancelled, true); }
        else { await assert.rejects(observed, /Incomplete fixed tree/); assert.equal(r.plannedCancel, false); controller.abort(); }
        await state.execution; assert.equal(await owner.cleanup(), settle); assert.equal(stopped, true);
        if (settle) { assert.equal(owner.execution, undefined); assert.equal(owner.state, "closed"); }
        else { assert.ok(owner.execution); assert.equal(owner.state, "blocked-cleanup"); exec.finish(ok("fixture released", 1)); }
        assert.equal(exec.listenerCount("settled"), 0);
    }
    await scenario(true, true); await scenario(true, false); await scenario(false, true);
});
test("fixed tree guest compiles without executing or creating descendants on the host", { skip: process.platform !== "win32" }, t => {
    const repository = fileURLToPath(new URL("../", import.meta.url)), compiler = "C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe";
    assert.equal(sha256(compiler), "eca02e6b15cde93009a59a3d129d5a77fb5008f2e1cf62cf573b6737c747ecc3");
    const parent = fs.realpathSync(path.join(repository, ".artifacts")), root = path.join(parent, "wsb-tree-check-" + randomUUID());
    fs.mkdirSync(root); const identity = fs.lstatSync(root, { bigint: true }), executable = path.join(root, "probe.exe"); let binary;
    try {
        const result = spawnSync(compiler, ["/nologo", "/target:exe", "/platform:x64", "/reference:System.Web.Extensions.dll", "/out:" + executable,
            path.join(repository, "scripts", "acceptance", "windows-sandbox-tree.cs")], { cwd: root, windowsHide: true, encoding: "utf8", timeout: 30000, maxBuffer: 16 * 1024 });
        if (fs.existsSync(executable)) binary = fs.lstatSync(executable, { bigint: true });
        assert.ifError(result.error); assert.equal(result.status, 0, result.stdout + result.stderr);
        t.diagnostic(JSON.stringify({ root, compilerPid: result.pid, probeSha256: sha256(executable) }));
    } finally {
        const actual = fs.lstatSync(root, { bigint: true }); assert.ok(actual.isDirectory() && !actual.isSymbolicLink() && actual.dev === identity.dev && actual.ino === identity.ino);
        assert.equal(fs.realpathSync(root), root); assert.equal(path.dirname(root), parent);
        if (binary) { const current = fs.lstatSync(executable, { bigint: true }); assert.ok(current.isFile() && !current.isSymbolicLink() && current.dev === binary.dev && current.ino === binary.ino); fs.unlinkSync(executable); }
        fs.rmdirSync(root); assert.equal(fs.existsSync(root), false); t.diagnostic("Owned compile artifact removed; guest never ran on host.");
    }
});
