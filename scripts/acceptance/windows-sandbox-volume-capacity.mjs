// One fixed capacity workload; cold orchestration only, no real entry or process construction here.
import { SandboxLifecycle } from "./windows-sandbox-lifecycle.mjs";
import { parseFixedEntryExit } from "./windows-sandbox-fixed-acceptance.mjs";
import { experimentalGuidConfig } from "./windows-sandbox-volume-sharing.mjs";
import { boundedText } from "./windows-sandbox-volume-session.mjs";
import { sharingReport, volumeBinding, vmQuiescent, helperSnapshots } from "./windows-sandbox-volume-share.mjs";
import { validateCapacityReceipt, capacityEvidence } from "./windows-sandbox-volume-capacity-receipt.mjs";
import { decodeCapacityDelivery } from "./windows-sandbox-volume-capacity-protocol.mjs";
const need = (value, message) => { if (!value) throw new Error(message); };
export function capacityReport(taskId, root, rootId) {
    const value = sharingReport(taskId, root, rootId); value.protocol = "super-pi-volume-capacity-acceptance-v1";
    value.guestRead = undefined; value.installation = null; value.capacityRead = null; value.capacityCandidate = false; return value;
}
export function capacityHelpers(calls) {
    need(calls.length <= 3, "Capacity helper summary bound");
    return calls.map((call, index) => ({ role: ["preflight", "compile-native", "compile-guest"][index], ...helperSnapshots([call])[0] }));
}
export function capacityReceiptSnapshot(value) {
    const handles = { opened: value.opened, closed: value.closed, peak: value.peak, closeUnknown: value.closeUnknown,
        unresolved: value.retainedHandles.flatMap((handle, slot) => handle === null ? [] : [{ slot, handle, errorCode: value.closeErrors[slot] }]) };
    if (value.stage === "install") return { source: "host-cli-process", installed: value.installed,
        probeId: value.probeId, slotId: value.slotId, sentinelId: value.sentinelId, handles };
    return { source: "host-cli-process", installed: value.installed, readCompleted: value.readCompleted,
        probeId: value.probeId, slotId: value.slotId, sentinelId: value.sentinelId, fillId: value.fillId,
        fillLength: value.fillLength, fillAllocation: value.fillAllocation, sentinelMatched: value.sentinelMatched,
        guestBytes: value.resultBase64 === null ? null : { source: "guest-report", encoding: "base64", bytes: 512, data: value.resultBase64 },
        handles };
}
export function capacityCommand(taskId) {
    need(typeof taskId === "string" && /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(taskId) && taskId !== "00000000-0000-0000-0000-000000000000", "Fixed capacity task required");
    return `"C:\\SuperPiVolume\\capacity-probe.exe" ${taskId}`;
}
export async function executeCapacityProbe(task, signal) {
    const { vm, volume, driver, runtime, installation } = task;
    need(vm instanceof SandboxLifecycle && vm.state === "registered-not-guest-ready" && vm.registered && vm.startSettled && !signal.aborted
        && installation?.installed === true && installation.taskId === vm.taskId, "Capacity exec requires installed owned task");
    const command = capacityCommand(vm.taskId), taskId = vm.taskId, instanceId = vm.id;
    const validate = current => current === vm && current.taskId === taskId && current.id === instanceId && !signal.aborted
        && current.state === "executing-volume-capacity" && !current.cleanupPromise && !current.active && !current.execution && !current.connection
        && task.vm === vm && task.volume === volume && task.driver === driver && task.runtime === runtime && task.installation === installation
        && volume.state === "prepared-not-share-admitted" && volume.experimentalMappingState === "dispatched"
        && driver.physicallyClosed === false && driver.pending === false && runtime.read().owner === vm;
    vm.state = "executing-volume-capacity"; vm.save(); need(!signal.aborted && !vm.cleanupPromise, "Capacity exec cancelled before dispatch");
    const result = await SandboxLifecycle.prototype.invoke.call(vm, "exec", ["exec", "--id", vm.id, "-c", command,
        "-d", "C:\\SuperPiVolume", "-r", "System", "--raw"], vm.limits.execMs, signal, validate);
    vm.state = "volume-capacity-returned"; vm.save(); return decodeCapacityDelivery(parseFixedEntryExit(result));
}
export async function exerciseCapacity(task, report, signal, buildVm, readReceipt, probeSha256) {
    let closed = false;
    const capture = stage => {
        const value = validateCapacityReceipt(readReceipt(stage), stage, report.taskId, task.volume.facts, probeSha256, task.installation);
        report[stage === "install" ? "installation" : "capacityRead"] = capacityReceiptSnapshot(value); return value;
    };
    try {
        need(!signal.aborted, "Cancelled before capacity preparation"); report.prepared = volumeBinding(await task.volume.prepare());
        need(!signal.aborted, "Cancelled before capacity installation"); task.installation = await task.volume.installCapacityOnce(() => capture("install"), probeSha256);
        need(!signal.aborted, "Cancelled before capacity VM binding"); task.vm = buildVm(experimentalGuidConfig(task.volume)); task.runtime.bind(task.vm);
        const ticket = await task.volume.issueExperimentalMapping(task.vm); await task.volume.startExperimentalMapping(ticket, task.vm, signal);
        report.guestExit = await executeCapacityProbe(task, signal);
        need(report.guestExit.deliveryComplete, "Guest result delivery not confirmed");
    } catch (error) { report.error ??= boundedText(error.message); }
    try {
        if (task.vm) need(await task.vm.cleanup(), "Capacity VM cleanup unresolved");
        closed = vmQuiescent(task); need(closed, "Capacity VM/CLI absence not confirmed");
    } catch (error) { report.cleanupError ??= boundedText(error.message); }
    // Failed guest delivery still permits one diagnostic read after actual closure; it never changes the earlier failure to success.
    if (closed && !report.cleanupError && !signal.aborted && task.installation && task.vm?.registered && task.volume.experimentalMappingState === "dispatched") {
        try {
            const receipt = await task.volume.readCapacityOnce(() => capture("read"), probeSha256);
            const evidence = capacityEvidence(receipt, report.guestExit); report.capacityCandidate = evidence.qualified;
            need(evidence.qualified, "Direct write capacity evidence not established");
        } catch (error) { report.error ??= boundedText(error.message); }
    }
    try { need(vmQuiescent(task), "Cannot release capacity volume before VM closure"); report.released = await task.volume.release(); }
    catch (error) { report.cleanupError ??= boundedText(error.message); }
    report.cancelled ||= signal.aborted;
    report.sequencePassed = !report.error && !report.cleanupError && !report.cancelled && report.released === true && report.capacityCandidate === true
        && report.guestExit?.deliveryComplete === true;
    return report.sequencePassed;
}
