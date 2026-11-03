// One fixed waiting process, one planned cancellation. No production backend or arbitrary commands.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { acquireAcceptanceRoot, FixedCli, SandboxLifecycle, successful, parseRunning } from "./windows-sandbox-lifecycle.mjs";
import { OwnedHelperRunner } from "./windows-sandbox-clipboard.mjs";
import { windowsSandboxConfig, sha256 } from "./windows-sandbox-package.mjs";
import { parseFixedEntryExit } from "./windows-sandbox-fixed-acceptance.mjs";
export const CANCEL_PROTOCOL = "super-pi-wsb-cancel-v1";
const SOURCE = fileURLToPath(new URL("./windows-sandbox-cancel.cs", import.meta.url));
const COMPILER = "C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe";
const COMPILER_HASH = "eca02e6b15cde93009a59a3d129d5a77fb5008f2e1cf62cf573b6737c747ecc3";
const need = (value, error) => { if (!value) throw new Error(error); };
export function validateCancellationReady(value, taskId) {
    need(value && Object.keys(value).sort().join(",") === "lifetimeMs,pid,protocol,sessionId,system,taskId"
        && value.protocol === CANCEL_PROTOCOL && value.taskId === taskId && Number.isInteger(value.pid) && value.pid > 0
        && value.sessionId === 0 && value.system === true && value.lifetimeMs === 60000, "Invalid fixed cancellation readiness");
    return value;
}
function checkDirectory(directory, identity) {
    const now = fs.lstatSync(directory, { bigint: true });
    need(now.isDirectory() && !now.isSymbolicLink() && now.dev === identity.dev && now.ino === identity.ino && fs.realpathSync(directory) === directory, "Mapped directory identity changed");
}
function readReady(output, identity, taskId) {
    checkDirectory(output, identity);
    const file = path.join(output, "ready.json"), before = fs.lstatSync(file, { bigint: true });
    need(before.isFile() && !before.isSymbolicLink() && before.nlink === 1n && before.size > 0n && before.size <= 1024n && fs.realpathSync(file) === file, "Invalid ready file");
    const fd = fs.openSync(file, "r");
    try {
        const current = fs.fstatSync(fd, { bigint: true }); need(current.dev === before.dev && current.ino === before.ino && current.size === before.size, "Ready file changed");
        const buffer = Buffer.alloc(Number(before.size)); let offset = 0;
        while (offset < buffer.length) { const n = fs.readSync(fd, buffer, offset, buffer.length - offset); need(n > 0, "Short ready file"); offset += n; }
        need(fs.fstatSync(fd, { bigint: true }).size === before.size, "Ready file resized");
        return validateCancellationReady(JSON.parse(buffer.toString("utf8")), taskId);
    } finally { fs.closeSync(fd); }
}
export async function awaitReady(output, identity, owner, execution, signal, dispatchMs) {
    const marker = path.join(output, "ready.complete");
    for (;;) {
        need(!signal.aborted, "Cancelled before readiness");
        need(owner.execution === execution && !execution.operation.result, "Exec ended before active cancellation");
        need(performance.now() - dispatchMs < 10000, "Readiness deadline exceeded");
        checkDirectory(output, identity);
        if (fs.existsSync(marker)) {
            const stat = fs.lstatSync(marker, { bigint: true });
            need(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1n && stat.size === 0n && fs.realpathSync(marker) === marker, "Invalid ready marker");
            return readReady(output, identity, owner.taskId);
        }
        await new Promise(resolve => setTimeout(resolve, 100));
    }
}
export function cancellationPassed(record) {
    if (!record.ready || record.error || record.cleanupError || record.helperPendingPid !== null || !record.closed || !record.artifactsRemoved
        || record.externalCancelled !== false || !record.plannedCancel || !record.executionPendingAtCancel || !record.logicalCancelled
        || !Number.isFinite(record.readyElapsedMs) || !Number.isFinite(record.cancelElapsedMs) || !Number.isFinite(record.executionTotalMs)
        || record.readyElapsedMs < 0 || record.cancelElapsedMs < record.readyElapsedMs || record.cancelElapsedMs >= 10000
        || record.executionTotalMs < record.cancelElapsedMs || record.executionTotalMs >= 30000) return false;
    try { validateCancellationReady(record.ready, record.taskId); } catch { return false; }
    const life = record.lifecycle, calls = life?.calls;
    if (!life || life.taskId !== record.taskId || life.state !== "closed" || !life.startSettled || !life.registered || !life.stopAttempted
        || life.controlPending || life.executionPending || life.connectionPending || !Array.isArray(calls)) return false;
    const executions = calls.filter(call => call.kind === "exec"), stops = calls.filter(call => call.kind === "stop");
    if (executions.length !== 1 || stops.length !== 1 || calls.some(call => call.kind !== "exec" && !successful(call.result))) return false;
    const exec = executions[0], result = exec.result;
    if (exec.outcome !== "cancelled/settled" || !result || !Number.isInteger(result.pid) || result.pid <= 0 || !result.closedUtc
        || !Number.isInteger(result.exitCode) || result.exitCode < -2147483648 || result.exitCode > 4294967295
        || typeof result.stdout !== "string" || typeof result.stderr !== "string" || result.launchError || result.truncated || result.signal !== null) return false;
    // Preserve physical close separately. None of the fixture's own return paths proves cancellation.
    try { if ([73, 125, 126].includes(JSON.parse(result.stdout.replace(/^\uFEFF/, "")).ExitCode)) return false; } catch { }
    if (successful(result)) { try { parseFixedEntryExit(result); } catch { return false; } }
    const last = calls[calls.length - 1];
    try { return last.kind === "list" && parseRunning(last.result).size === 0; } catch { return false; }
}
function monotonicNow() { return performance.now(); }
// The real completion boundary is injectable for a deterministic cleanup-crosses-deadline check.
export function finishCancellationArtifacts(record, resource, owner, helperActive, dispatchMs, now = monotonicNow) {
    if (helperActive || owner && !record.closed) { record.cleanupError ??= "Owned execution remains unresolved"; resource.journal(record); }
    else { try { resource.remove(owner ?? { state: "closed-before-start" }); record.artifactsRemoved = true; } catch (error) { record.cleanupError = String(error.message); } }
    if (dispatchMs !== undefined) record.executionTotalMs = now() - dispatchMs;
}
export async function runCancellationAcceptance() {
    const resource = acquireAcceptanceRoot();
    const record = { protocol: CANCEL_PROTOCOL, taskId: randomUUID(), sourceSha256: null, compilerSha256: COMPILER_HASH, probeSha256: null,
        ready: null, readyElapsedMs: null, cancelElapsedMs: null, cancelRequestedUtc: null, executionTotalMs: null,
        plannedCancel: false, externalCancelled: false, externalCancelledUtc: null, executionPendingAtCancel: false, logicalCancelled: false, logicalResult: null,
        closed: false, lifecycle: null, helperCalls: [], helperPendingPid: null, error: null, cleanupError: null,
        artifactRoot: resource.root, artifactsRemoved: false };
    const save = () => resource.journal(record);
    const helpers = new OwnedHelperRunner(resource.root, () => { record.helperCalls = helpers.calls; record.helperPendingPid = helpers.active?.pid ?? null; save(); });
    const controller = new AbortController(), cancel = () => { record.externalCancelled = true; record.externalCancelledUtc ??= new Date().toISOString(); controller.abort(); };
    process.once("SIGINT", cancel); process.once("SIGTERM", cancel);
    let owner, execution, dispatchMs;
    try {
        need(process.platform === "win32" && sha256(COMPILER) === COMPILER_HASH, "Pinned Windows compiler changed");
        record.sourceSha256 = sha256(SOURCE); save();
        const input = path.join(resource.root, "input"), output = path.join(resource.root, "output"); fs.mkdirSync(input); fs.mkdirSync(output);
        const inputIdentity = fs.lstatSync(input, { bigint: true }), outputIdentity = fs.lstatSync(output, { bigint: true });
        const executable = path.join(input, "probe.exe");
        need(!controller.signal.aborted, "Cancelled before compile");
        await helpers.run(COMPILER, ["/nologo", "/target:exe", "/platform:x64", "/reference:System.Web.Extensions.dll", "/out:" + executable, SOURCE], 30000, controller.signal);
        record.probeSha256 = sha256(executable); fs.writeFileSync(path.join(input, "request.json"), JSON.stringify({ protocol: CANCEL_PROTOCOL, taskId: record.taskId }), { flag: "wx" }); save();
        need(!controller.signal.aborted, "Cancelled before instance preparation");
        checkDirectory(input, inputIdentity); checkDirectory(output, outputIdentity);
        owner = new SandboxLifecycle({ cli: new FixedCli(), config: windowsSandboxConfig(input, output).replaceAll("SuperPiProbe", "SuperPiCancel"), taskId: record.taskId,
            workload: { kind: "fixed-wait-cancel", input, output, probeSha256: record.probeSha256 }, journal(value) { record.lifecycle = value; save(); } });
        await owner.start(controller.signal);
        dispatchMs = performance.now();
        execution = owner.executeCancellationProbe(controller.signal).then(result => ({ result }), error => ({ error: String(error.message) }));
        const launchedExecution = owner.execution; need(launchedExecution, "Exec was not dispatched");
        record.ready = await awaitReady(output, outputIdentity, owner, launchedExecution, controller.signal, dispatchMs); record.readyElapsedMs = performance.now() - dispatchMs;
        need(!controller.signal.aborted && record.readyElapsedMs < 10000 && owner.execution === launchedExecution && !launchedExecution.operation.result, "No live execution at cancellation boundary");
        const entry = owner.execution.entry;
        record.executionPendingAtCancel = true; record.plannedCancel = true; record.cancelElapsedMs = performance.now() - dispatchMs;
        record.cancelRequestedUtc = new Date().toISOString(); controller.abort();
        record.logicalResult = await execution; record.logicalCancelled = entry.outcome === "cancelled"; save();
        need(record.logicalCancelled, "Did not observe planned exec cancellation");
    } catch (error) { record.error = String(error.message); controller.abort(); }
    finally {
        if (owner) { record.closed = await owner.cleanup(); record.cleanupError = owner.cleanupError ?? null; }
        if (execution) await execution;
        finishCancellationArtifacts(record, resource, owner, helpers.active, dispatchMs);
        process.removeListener("SIGINT", cancel); process.removeListener("SIGTERM", cancel);
    }
    record.passed = cancellationPassed(record); process.stdout.write(JSON.stringify(record) + "\n"); return record;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    need(process.argv.length === 2, "No arguments accepted"); if (!(await runCancellationAcceptance()).passed) process.exitCode = 1;
}
