// Fixed workload and cold orchestration only. This module has no real execution entry point.
import { SandboxLifecycle } from "./windows-sandbox-lifecycle.mjs";
import { parseFixedEntryExit } from "./windows-sandbox-fixed-acceptance.mjs";
import { experimentalGuidConfig } from "./windows-sandbox-volume-sharing.mjs";
import { boundedText } from "./windows-sandbox-volume-session.mjs";
import { summarizeOperationError } from "./windows-sandbox-volume-native-acceptance.mjs";
function need(value, message) { if (!value) throw Error(message); }
export function sharingReport(taskId, root, rootId) {
    return { protocol: "super-pi-volume-share-v1", taskId, artifactRoot: root, rootId, hostPid: process.pid,
        startedUtc: new Date().toISOString(), sources: {}, preflight: null, helperCalls: [], volume: null, prepared: null, vm: null,
        guestExit: null, guestRead: null, physical: null, lastCli: null, operationErrors: [], receiptUnknownHandles: [], files: [], removedFiles: 0,
        error: null, cleanupError: null, cancelled: false, revoked: false, released: false, retained: false, passed: false,
        sequencePassed: false, journalFailed: false, outputBoundFailed: false, outputFailed: false, evidenceEmitted: false,
        cleanupStarted: false, artifactsRemoved: false, taskReferencesReleased: false };
}
export function volumeBinding(value) {
    return value ? { imageId: value.imageId, diskId: value.diskId, physicalPath: value.physicalPath, volumePath: value.volumePath,
        exchangeId: value.exchangeId, capacity: value.capacity, imageBudget: value.imageBudget } : null;
}
export function volumeSnapshot(value) {
    return { state: value.state, helperPid: value.helperPid, helperClosed: value.helperClosed, pending: value.pending,
        reading: value.reading, closeUnknown: value.closeUnknown, revoked: value.revoked,
        mapping: value.experimentalMappingState, instanceId: value.experimentalInstanceId,
        facts: value.facts ? { ...volumeBinding(value.facts), phase: value.facts.phase, error: value.facts.error,
            detached: value.facts.detached, managementClosed: value.facts.managementClosed, closeUnknown: value.facts.closeUnknown } : null,
        transport: value.transport };
}
export function vmSnapshot(value) {
    need(value.calls.length <= 96, "VM record bound");
    return { taskId: value.taskId, instanceId: value.instanceId, state: value.state, startAttempted: value.startAttempted,
        startSettled: value.startSettled, registered: value.registered, stopAttempted: value.stopAttempted,
        controlPending: value.controlPending, executionPending: value.executionPending, connectionPending: value.connectionPending,
        cleanupError: value.cleanupError ? boundedText(value.cleanupError, 96) : null, callRecords: value.calls.length,
        configSha256: value.configSha256 };
}
export function preflightSnapshot(value) {
    need(value.protocol === "super-pi-native-preflight-v1" && /^7\.[0-9.]{1,12}$/.test(value.powershell) && value.x64 === true
        && value.administratorToken === true && value.privilege === "SeManageVolumePrivilege" && value.storageVersion === "2.0.0.0"
        && value.commands === 7 && value.format === "NTFS" && value.requiredBytes === 168820736
        && Number.isSafeInteger(value.availableBytes) && value.availableBytes >= value.requiredBytes, "Fixed storage preflight facts required");
    return { powershell: value.powershell, x64: true, administratorToken: true, privilege: value.privilege,
        privilegeState: boundedText(value.privilegeState, 64), storageVersion: value.storageVersion, commands: 7,
        format: "NTFS", availableBytes: value.availableBytes, requiredBytes: value.requiredBytes };
}
export function helperSnapshots(calls) {
    need(calls.length <= 2, "Sharing helper summary bound");
    return calls.map(call => ({ executable: boundedText(call.executable, 32), pid: call.pid, outcome: boundedText(call.outcome, 32),
        killRequested: call.killRequested, result: call.result ? { exitCode: call.result.exitCode, signal: call.result.signal,
            launchError: call.result.launchError ? boundedText(call.result.launchError, 64) : null,
            stdoutSeen: call.result.stdoutSeen, stderrSeen: call.result.stderrSeen, truncated: call.result.truncated,
            stdoutPrefix: boundedText(call.result.stdout, 64), stderrPrefix: boundedText(call.result.stderr, 64), prefixesOnly: true } : null }));
}
export function operationErrorSnapshot(value, command) {
    const checked = summarizeOperationError(value, command);
    return { command, classification: checked.classification, exception: boundedText(checked.exception, 64), hresult: checked.hresult,
        nativeCode: checked.nativeCode, message: boundedText(checked.message, 96), messageTruncated: checked.messageTruncated || Buffer.byteLength(JSON.stringify(checked.message)) > 96 };
}
export function volumeMarkerCommand(taskId) {
    need(typeof taskId === "string" && /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(taskId) && taskId.length === 36, "Fixed task identity required");
    const marker = taskId.replaceAll("-", "").slice(0, 30);
    return `"C:\\Windows\\System32\\cmd.exe" /d /c >"C:\\SuperPiVolume\\guest-control.bin" echo ${marker}`;
}
export async function executeVolumeMarker(task, signal) {
    const { vm, volume, driver, runtime } = task;
    need(vm instanceof SandboxLifecycle && vm.state === "registered-not-guest-ready" && vm.registered && vm.startSettled && !signal.aborted,
        "Fixed volume write requires owned registration");
    const command = volumeMarkerCommand(vm.taskId);
    const instanceId = vm.id, taskId = vm.taskId;
    const validate = current => current === vm && current.id === instanceId && current.taskId === taskId && !signal.aborted
        && current.state === "executing-volume-marker" && !current.cleanupPromise && !current.active && !current.execution && !current.connection
        && task.vm === vm && task.volume === volume && task.driver === driver && task.runtime === runtime
        && volume.state === "prepared-not-share-admitted" && volume.experimentalMappingState === "dispatched"
        && driver.physicallyClosed === false && driver.pending === false && runtime.read().owner === vm;
    vm.state = "executing-volume-marker"; vm.save();
    need(!signal.aborted && !vm.cleanupPromise, "Fixed volume write cancelled before dispatch");
    const result = await SandboxLifecycle.prototype.invoke.call(vm, "exec", ["exec", "--id", vm.id, "-c", command,
        "-d", "C:\\SuperPiVolume", "-r", "System", "--raw"], vm.limits.execMs, signal, validate);
    vm.state = "volume-marker-returned"; vm.save();
    return { source: "guest-report", interfaceSource: "platform-interface", exitCode: parseFixedEntryExit(result) };
}
export function vmQuiescent(task) {
    const state = task.runtime.read(), vm = task.vm;
    if (!vm) return state.state === "not-started" && state.neverDispatched === true && state.callsClosed === true && state.owner === null;
    if (state.owner !== vm || state.taskId !== vm.taskId || state.instanceId !== vm.id || state.callsClosed !== true) return false;
    return state.state === "closed" && state.instanceAbsent === true || state.state === "not-started" && state.neverDispatched === true;
}
export async function exerciseSharedVolume(task, report, signal, buildVm, readReceipt) {
    let closed = false;
    try {
        need(!signal.aborted, "Cancelled before volume preparation");
        report.prepared = volumeBinding(await task.volume.prepare());
        need(!signal.aborted, "Cancelled after volume preparation");
        task.vm = buildVm(experimentalGuidConfig(task.volume));
        task.runtime.bind(task.vm);
        const ticket = await task.volume.issueExperimentalMapping(task.vm);
        await task.volume.startExperimentalMapping(ticket, task.vm, signal);
        report.guestExit = await executeVolumeMarker(task, signal);
        need(report.guestExit.exitCode === 0, "Guest fixed write reported failure");
    } catch (error) { report.error ??= boundedText(error.message); }
    try {
        if (task.vm) need(await task.vm.cleanup(), "VM cleanup remains unresolved");
        closed = vmQuiescent(task); need(closed, "VM and physical CLI absence not confirmed");
    } catch (error) { report.cleanupError ??= boundedText(error.message); }
    if (closed && !report.error && !report.cleanupError && !signal.aborted) {
        try { report.guestRead = await task.volume.readGuestOnce(readReceipt); }
        catch (error) { report.error ??= boundedText(error.message); }
    }
    try {
        need(vmQuiescent(task), "Cannot release volume before real VM closure");
        report.released = await task.volume.release();
    } catch (error) { report.cleanupError ??= boundedText(error.message); }
    report.cancelled ||= signal.aborted;
    report.sequencePassed = !report.error && !report.cleanupError && !report.cancelled && report.released === true
        && report.guestExit?.exitCode === 0 && report.guestRead?.matched === true;
    return report.sequencePassed;
}
