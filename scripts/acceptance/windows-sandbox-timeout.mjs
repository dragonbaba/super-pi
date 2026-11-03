// One fixed waiting process and the owned execution deadline. No planned abort or production integration.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { acquireAcceptanceRoot, FixedCli, SandboxLifecycle, DEFAULT_LIMITS, successful, parseRunning } from "./windows-sandbox-lifecycle.mjs";
import { OwnedHelperRunner } from "./windows-sandbox-clipboard.mjs";
import { windowsSandboxConfig, sha256 } from "./windows-sandbox-package.mjs";
import { parseFixedEntryExit } from "./windows-sandbox-fixed-acceptance.mjs";
import { CANCEL_PROTOCOL, awaitReady, validateCancellationReady, finishCancellationArtifacts } from "./windows-sandbox-cancel.mjs";
const SOURCE = fileURLToPath(new URL("./windows-sandbox-cancel.cs", import.meta.url));
const SOURCE_HASH = "8c5ce684449972baa4231279d24b32c883aba3da3e069a1285a46e934d24da70";
const COMPILER = "C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe";
const COMPILER_HASH = "eca02e6b15cde93009a59a3d129d5a77fb5008f2e1cf62cf573b6737c747ecc3";
const need = (value, error) => { if (!value) throw new Error(error); };
const monotonicNow = () => performance.now();
// The actual driver and the timer/cleanup fixtures share this wiring. State retains the pending promise on every failure.
export async function observeExecutionTimeout(owner, record, signal, readReadiness, state, now = monotonicNow) {
    need(owner.limits.execMs === record.execBudgetMs && !signal.aborted, "Wrong timeout budget or prior cancellation");
    state.dispatchMs = now();
    state.execution = owner.executeCancellationProbe(signal).then(result => state.logical = { result }, error => state.logical = { error: String(error.message) });
    state.slot = owner.execution; need(state.slot, "Exec was not dispatched");
    record.ready = validateCancellationReady(await readReadiness(state.slot, state.dispatchMs), record.taskId);
    record.readyElapsedMs = now() - state.dispatchMs;
    need(!signal.aborted && record.readyElapsedMs >= 0 && record.readyElapsedMs < record.execBudgetMs
        && owner.execution === state.slot && !state.slot.operation.result && state.slot.entry.outcome === "launching" && state.logical === undefined,
        "Readiness was not confirmed before logical timeout");
    record.readyBeforeTimeout = true;
    record.logicalResult = await state.execution;
    record.timeoutElapsedMs = now() - state.dispatchMs; record.timeoutObservedUtc = new Date().toISOString();
    record.logicalTimeout = state.slot.entry.outcome === "timeout";
    record.executionPendingAtTimeout = owner.execution === state.slot && !state.slot.operation.result;
    need(!signal.aborted && record.logicalTimeout && record.executionPendingAtTimeout && record.timeoutElapsedMs >= record.execBudgetMs,
        "Did not observe independent execution timeout");
}
export function timeoutPassed(record) {
    if (!record.ready || record.error || record.cleanupError || record.helperPendingPid !== null || !record.closed || !record.artifactsRemoved
        || record.externalCancelled !== false || record.execBudgetMs !== 10000 || !record.readyBeforeTimeout || !record.logicalTimeout || !record.executionPendingAtTimeout
        || !Number.isFinite(record.readyElapsedMs) || !Number.isFinite(record.timeoutElapsedMs) || !Number.isFinite(record.executionTotalMs)
        || record.readyElapsedMs < 0 || record.readyElapsedMs >= record.execBudgetMs || record.timeoutElapsedMs < record.execBudgetMs
        || record.executionTotalMs < record.timeoutElapsedMs || record.executionTotalMs >= 30000) return false;
    try { validateCancellationReady(record.ready, record.taskId); } catch { return false; }
    const life = record.lifecycle, calls = life?.calls;
    if (!life || life.taskId !== record.taskId || life.state !== "closed" || !life.startSettled || !life.registered || !life.stopAttempted
        || life.controlPending || life.executionPending || life.connectionPending || !Array.isArray(calls)) return false;
    const executions = calls.filter(call => call.kind === "exec"), stops = calls.filter(call => call.kind === "stop");
    if (executions.length !== 1 || stops.length !== 1 || calls.some(call => call.kind !== "exec" && !successful(call.result))) return false;
    const exec = executions[0], result = exec.result;
    if (exec.outcome !== "timeout/settled" || !result || !Number.isInteger(result.pid) || result.pid <= 0 || !result.closedUtc
        || !Number.isInteger(result.exitCode) || result.exitCode < -2147483648 || result.exitCode > 4294967295
        || typeof result.stdout !== "string" || typeof result.stderr !== "string" || result.launchError || result.truncated || result.signal !== null) return false;
    try { if ([73, 125, 126].includes(JSON.parse(result.stdout.replace(/^\uFEFF/, "")).ExitCode)) return false; } catch { }
    if (successful(result)) { try { parseFixedEntryExit(result); } catch { return false; } }
    const last = calls[calls.length - 1];
    try { return last.kind === "list" && parseRunning(last.result).size === 0; } catch { return false; }
}
export async function runTimeoutAcceptance() {
    const resource = acquireAcceptanceRoot();
    const record = { protocol: "super-pi-wsb-timeout-v1", taskId: randomUUID(), execBudgetMs: 10000, sourceSha256: null, compilerSha256: COMPILER_HASH, probeSha256: null,
        ready: null, readyElapsedMs: null, readyBeforeTimeout: false, timeoutElapsedMs: null, timeoutObservedUtc: null, executionTotalMs: null,
        externalCancelled: false, externalCancelledUtc: null, executionPendingAtTimeout: false, logicalTimeout: false, logicalResult: null,
        closed: false, lifecycle: null, helperCalls: [], helperPendingPid: null, error: null, cleanupError: null, artifactRoot: resource.root, artifactsRemoved: false };
    const save = () => resource.journal(record);
    const helpers = new OwnedHelperRunner(resource.root, () => { record.helperCalls = helpers.calls; record.helperPendingPid = helpers.active?.pid ?? null; save(); });
    const controller = new AbortController(), cancel = () => { record.externalCancelled = true; record.externalCancelledUtc ??= new Date().toISOString(); controller.abort(); };
    process.once("SIGINT", cancel); process.once("SIGTERM", cancel);
    let owner; const state = {};
    try {
        need(process.platform === "win32" && sha256(COMPILER) === COMPILER_HASH && sha256(SOURCE) === SOURCE_HASH, "Pinned timeout fixture changed");
        record.sourceSha256 = SOURCE_HASH; save();
        const input = path.join(resource.root, "input"), output = path.join(resource.root, "output"); fs.mkdirSync(input); fs.mkdirSync(output);
        const outputIdentity = fs.lstatSync(output, { bigint: true }), executable = path.join(input, "probe.exe");
        need(!controller.signal.aborted, "Cancelled before compile");
        await helpers.run(COMPILER, ["/nologo", "/target:exe", "/platform:x64", "/reference:System.Web.Extensions.dll", "/out:" + executable, SOURCE], 30000, controller.signal);
        record.probeSha256 = sha256(executable); fs.writeFileSync(path.join(input, "request.json"), JSON.stringify({ protocol: CANCEL_PROTOCOL, taskId: record.taskId }), { flag: "wx" }); save();
        need(!controller.signal.aborted, "Cancelled before instance");
        owner = new SandboxLifecycle({ cli: new FixedCli(), config: windowsSandboxConfig(input, output).replaceAll("SuperPiProbe", "SuperPiCancel"), taskId: record.taskId,
            limits: { ...DEFAULT_LIMITS, execMs: record.execBudgetMs }, workload: { kind: "fixed-wait-timeout", input, output, probeSha256: record.probeSha256 },
            journal(value) { record.lifecycle = value; save(); } });
        await owner.start(controller.signal);
        await observeExecutionTimeout(owner, record, controller.signal,
            (slot, dispatchMs) => awaitReady(output, outputIdentity, owner, slot, controller.signal, dispatchMs), state); save();
    } catch (error) { record.error = String(error.message); }
    finally {
        if (owner) { record.closed = await owner.cleanup(); record.cleanupError = owner.cleanupError ?? null; }
        if (state.execution) await state.execution;
        finishCancellationArtifacts(record, resource, owner, helpers.active, state.dispatchMs);
        process.removeListener("SIGINT", cancel); process.removeListener("SIGTERM", cancel);
    }
    record.passed = timeoutPassed(record); process.stdout.write(JSON.stringify(record) + "\n"); return record;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    need(process.argv.length === 2, "No arguments accepted"); if (!(await runTimeoutAcceptance()).passed) process.exitCode = 1;
}
