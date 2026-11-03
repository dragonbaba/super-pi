// One cold actual-input chain. No host fallback and no automatic invocation.
import { createHash } from "node:crypto";
import { SandboxLifecycle } from "./windows-sandbox-lifecycle.mjs";
import { TaskVolumeOwner } from "./windows-sandbox-volume.mjs";
import { WindowsWorkspaceInputCapture } from "./windows-sandbox-workspace-input-capture.mjs";
import { CapturedInputPublication } from "./windows-sandbox-input-publication.mjs";
import { experimentalGuidConfig } from "./windows-sandbox-volume-sharing.mjs";
import { parseFixedEntryExit } from "./windows-sandbox-fixed-acceptance.mjs";
import { CANDIDATE_LIMITS } from "./windows-sandbox-candidates.mjs";
import { candidateTask, candidateReport, syncCandidateEvidence } from "./windows-sandbox-volume-candidate-session.mjs";
import { volumeBinding, vmQuiescent } from "./windows-sandbox-volume-share.mjs";
import { boundedText } from "./windows-sandbox-volume-session.mjs";

const need = (ok, reason) => { if (!ok) throw new Error(reason); };
const hash = value => createHash("sha256").update(value).digest("hex");
const captureState = Object.getOwnPropertyDescriptor(WindowsWorkspaceInputCapture.prototype, "diagnostics").get;
const captureFailure = Object.getOwnPropertyDescriptor(WindowsWorkspaceInputCapture.prototype, "failure").get;
const publicationState = Object.getOwnPropertyDescriptor(CapturedInputPublication.prototype, "diagnostics").get;
const publicationFailure = Object.getOwnPropertyDescriptor(CapturedInputPublication.prototype, "failure").get;
const errorFact = (failed, error) => !failed ? null : [typeof error,
    boundedText(error instanceof Error ? error.name : String(error), 40),
    boundedText(error instanceof Error ? error.message : String(error), 96)];
function sourceFailureFacts(capture) {
    const f = captureFailure.call(capture);
    return { operation: errorFact(f.failed, f.error), cleanup: errorFact(f.cleanupFailed, f.cleanupError),
        inputOperation: errorFact(f.input?.operationFailed, f.input?.operationError),
        inputClose: errorFact(f.input?.closeFailed, f.input?.closeError),
        readerOperation: errorFact(f.reader?.failed, f.reader?.error),
        readerCleanup: errorFact(f.reader?.cleanupFailed, f.reader?.cleanupError) };
}
export const INPUT_NORMAL_FILES = Object.freeze(["volume-native.dll", "offline-worker.exe", "input-source.bin",
    "candidate-input-receipt.json", "candidate-manifest.bin", "candidate-manifest-receipt.json",
    "candidate-request.json", "candidate-payload.bin", "candidate-batch-receipt.json", "volume-helper.json", "lifecycle.json"]);
export function inputReport(taskId, snapshotId, root, rootId) {
    const report = candidateReport(taskId, snapshotId, root, rootId);
    report.protocol = "super-pi-input-execution-v1"; report.input = null; report.host = null;
    return report;
}
export function inputTask(report, controller) {
    const task = candidateTask(report, controller), originalQuiescent = task.quiescent, originalDispose = task.dispose;
    task.capture = undefined; task.publication = undefined; task.hostRetention = undefined; task.hostDone = false;
    task.weak = [];
    task.quiescent = function() {
        const capture = this.capture ? captureState.call(this.capture) : undefined;
        const publication = this.publication ? publicationState.call(this.publication) : undefined;
        return !this.hostRetention && (!capture || !capture.busy && !capture.pending && capture.cleanup === "complete")
            && (!publication || !publication.pending && !publication.retainedFd)
            && originalQuiescent.call(this);
    };
    task.dispose = function() {
        need(!this.capture && !this.publication && !this.hostRetention && this.hostDone, "Input/host ownership remains");
        originalDispose.call(this);
    };
    return task;
}
export function inputHelpers(calls) {
    need(calls.length <= 3, "Input helper bound");
    return calls.map(call => ({ executable: boundedText(call.executable, 32), pid: call.pid, outcome: boundedText(call.outcome, 32),
        killRequested: call.killRequested, result: call.result ? { exitCode: call.result.exitCode, signal: call.result.signal,
            launchError: call.result.launchError ? boundedText(call.result.launchError, 64) : null,
            stdoutSeen: call.result.stdoutSeen, stderrSeen: call.result.stderrSeen, truncated: call.result.truncated,
            stdoutPrefix: boundedText(call.result.stdout, 96), stderrPrefix: boundedText(call.result.stderr, 96), prefixesOnly: true } : null }));
}
function publicationSummary(value) {
    const d = publicationState.call(value), c = d.capture, r = c?.reader, n = r?.reader;
    return { phase: d.phase, disposed: d.disposed, retainedCapture: d.retainedCapture, pending: d.pending, retainedFd: d.retainedFd,
        opened: d.opened, closed: d.closed, closeAttempts: d.closeAttempts,
        allocated: d.allocatedBytes, cleared: d.clearedBytes, receiptIdentity: d.receiptIdentity,
        capture: c ? { status: c.status, cleanup: c.cleanup, retainedReader: c.retainedReader, retainedInput: c.retainedInput,
            renewals: c.renewals, publicationRenewals: c.publicationRenewals, copies: c.copyRequests, metadata: c.publishedMetadata,
            copyAllocated: c.copyAllocatedBytes, copyDelivered: c.deliveredCopyBytes,
            inputAllocated: c.input?.allocatedBytes, inputCleared: c.input?.clearedBytes, inputRetained: c.input?.retainedBytes,
            native: n ? { opened: n.opened, closed: n.closed, closeAttempts: n.closeAttempts, active: n.activeHandles,
                contentOpens: n.contentOpens, readCalls: n.readCalls, bytes: n.readBytes,
                scratchAllocated: n.native?.native?.allocatedScratch, scratchReleased: n.native?.native?.releasedScratch } : null,
            permission: r?.permission ? { weakReferences: r.permission.weakReferences, grants: r.permission.grants } : null } : null };
}
function requirePublicationReleased(value) {
    const d = publicationState.call(value), c = d.capture, r = c?.reader, n = r?.reader;
    need(d.disposed && !d.retainedCapture && !d.pending && !d.retainedFd && !d.operationFailed && !d.closeFailed
        && d.phase === 3 && d.opened === 2 && d.closed === 2 && d.closeAttempts === 2
        && d.allocatedBytes > 5 && d.allocatedBytes <= 4101 && d.clearedBytes === d.allocatedBytes,
        "Input publication descriptor/buffer settlement");
    need(c?.status === "disposed" && c.cleanup === "complete" && !c.retainedReader && !c.retainedInput && !c.retainedIO
        && !c.retainedCanonical && !c.retainedBinding && !c.retainedMetadata && c.retainedCopySlots === 0
        && c.renewals === 6 && c.publicationRenewals === 3 && c.copyRequests === 1 && c.publishedMetadata
        && c.copyAllocatedBytes === 5 && c.deliveredCopyBytes === 5 && c.rejectedCopyBytes === 0
        && c.input?.allocatedBytes === 5 && c.input.clearedBytes === 5 && c.input.retainedBytes === 0,
        "Original captured input settlement");
    need(r?.cleanup === "complete" && !r.retainedSource && !r.retainedLease && !r.retainedPermission
        && !r.retainedReader && !r.retainedOperations && !r.retainedAuthority && !r.retainedCanonical
        && r.permission?.weakReferences === 0 && r.permission.grants === 0
        && n?.opened > 0 && n.closed === n.opened && n.closeAttempts === n.opened && n.activeHandles === 0
        && n.readCalls === 1 && n.readBytes === 5 && n.contentOpens === 1
        && !n.retainedContext && !n.retainedOperations && !n.retainedGuard && n.retainedSlots === 0,
        "Original source/permission settlement");
    need(n.native?.disposed && !n.native.retainedOperations && !n.native.retainedGuard && !n.native.retainedGrant
        && n.native.native?.allocatedScratch > 0 && n.native.native.releasedScratch === n.native.native.allocatedScratch
        && n.native.native.retainedScratch === 0 && !n.native.native.retainedBindings,
        "Original source native scratch settlement");
}
export async function executeInputWorker(task, snapshotId, signal) {
    const { vm, volume, runtime, driver } = task;
    need(vm instanceof SandboxLifecycle && !signal.aborted && /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(snapshotId),
        "Original input VM and snapshot required");
    await TaskVolumeOwner.prototype.renewInputExecution.call(volume, vm);
    const instanceId = vm.id, taskId = vm.taskId;
    const validate = current => current === vm && current.id === instanceId && current.taskId === taskId && !signal.aborted
        && current.state === "executing-volume-input" && !current.cleanupPromise && !current.active && !current.execution && !current.connection
        && task.vm === vm && task.volume === volume && task.runtime === runtime && task.driver === driver
        && TaskVolumeOwner.prototype.assertInputExecution.call(volume, vm) === true;
    const command = '"C:\\SuperPiVolume\\tools\\offline-worker.exe" ' + taskId + " " + snapshotId;
    vm.state = "executing-volume-input"; vm.save();
    const result = await SandboxLifecycle.prototype.invoke.call(vm, "exec", ["exec", "--id", instanceId, "-c", command,
        "-d", "C:\\SuperPiVolume\\workspace", "-r", "System", "--raw"], vm.limits.execMs, signal, validate);
    vm.state = "volume-input-returned"; vm.save();
    return { source: "guest-report", interfaceSource: "platform-interface", exitCode: parseFixedEntryExit(result) };
}
export async function produceInputCandidates(task, report, signal, capture, revision, options) {
    // Ownership is adopted before the first await, even when capture itself fails.
    need(!task.capture && !task.publication, "Original input owner already attached");
    task.capture = capture; task.weak.push(new WeakRef(capture));
    let failed = false, failure, closed = false;
    const fail = (error, cleanup = false) => {
        if (!failed) { failed = true; failure = error; }
        report[cleanup ? "cleanupError" : "error"] ??= boundedText(error instanceof Error ? error.message : String(error));
        report.retained = true; report.retentionReason ??= "input-execution-not-confirmed";
    };
    try {
        need(!signal.aborted, "Cancelled before source capture");
        const captured = await WindowsWorkspaceInputCapture.prototype.capture.call(capture);
        if (captured.status !== "captured" || captured.cleanup !== "complete") {
            const original = captureFailure.call(capture);
            if (original.failed) throw original.error;
            if (original.cleanupFailed) throw original.cleanupError;
            throw new Error("Original source capture incomplete");
        }
        task.publication = new CapturedInputPublication(options.root, options.rootId, capture, options.tool);
        task.capture = undefined; task.weak.push(new WeakRef(task.publication));
        await CapturedInputPublication.prototype.prepare.call(task.publication);
        const declaration = Object.getOwnPropertyDescriptor(CapturedInputPublication.prototype, "declaration").get.call(task.publication);
        need(declaration.taskId === report.taskId && declaration.snapshotId === report.snapshotId, "Input declaration association");
        options.attachManager(declaration);
        report.prepared = volumeBinding(await task.volume.prepare());
        task.vm = options.buildVm(experimentalGuidConfig(task.volume)); task.runtime.bind(task.vm);
        const installed = await TaskVolumeOwner.prototype.installCapturedInputOnce.call(task.volume, task.publication, task.vm);
        report.input = { installed, publication: publicationSummary(task.publication) }; task.save();
        const ticket = await task.volume.issueExperimentalMapping(task.vm);
        await task.volume.startExperimentalMapping(ticket, task.vm, signal);
        report.guestExit = await executeInputWorker(task, report.snapshotId, signal);
        need(report.guestExit.exitCode === 0, "Offline worker reported failure");
    } catch (error) {
        fail(error); report.input ??= {};
        // Preserve independent original failure facts before known-closed owners
        // release their references; falsy throws still carry a positive flag.
        report.input.sourceFailure = sourceFailureFacts(capture);
        if (task.publication) {
            const f = publicationFailure.call(task.publication);
            report.input.publicationFailure = { operation: errorFact(f.failed, f.error), close: errorFact(f.closeFailed, f.closeError) };
        }
    }
    try {
        if (task.vm) need(await task.vm.cleanup(), "Input VM cleanup unresolved");
        closed = vmQuiescent(task); need(closed, "Input VM/CLI closure not established");
    } catch (error) { fail(error, true); }
    if (closed && !failed && !signal.aborted) {
        try {
            task.channel = options.buildChannel(task);
            const binding = task.volume.facts;
            task.checked = await task.volume.readCandidatesOnce({ taskId: report.taskId, snapshotId: report.snapshotId, instanceId: task.vm.id,
                volumePath: binding.volumePath, exchangeId: binding.exchangeId, budget: { ...CANDIDATE_LIMITS },
                allowed: [{ path: "new.txt", operation: "add", revision: null }, { path: "source.txt", operation: "modify", revision }] }, task.channel.interface);
            task.weak.push(new WeakRef(task.checked));
            const records = task.checked.records, expected = [["new.txt", "add", "derived:alpha\r\n"], ["source.txt", "modify", "alpha-guest\r\n"]];
            need(records.length === 2, "Two actual guest candidates required");
            for (let index = 0; index < 2; index++) need(records[index].path === expected[index][0]
                && records[index].operation === expected[index][1] && records[index].bytes === Buffer.byteLength(expected[index][2])
                && records[index].sha256 === hash(expected[index][2]), "Guest candidate result changed");
            report.candidate = { status: task.checked.status, source: "host-captured-guest-data",
                records: records.map(record => ({ path: record.path, operation: record.operation, bytes: record.bytes, sha256: record.sha256, identity: record.identity })),
                guest: task.checked.guestReport, native: task.checked.captureCounts, buffersReleased: false };
        } catch (error) { fail(error); }
        finally { syncCandidateEvidence(task, report); }
    }
    try {
        need(vmQuiescent(task), "Cannot release input volume before VM/CLI closure");
        if (task.volume) report.released = await task.volume.release();
    } catch (error) { fail(error, true); }
    try {
        if (task.publication) {
            const d = publicationState.call(task.publication);
            need(!d.pending && !d.retainedFd && d.capture?.cleanup === "complete", "Input publication cleanup unresolved");
            CapturedInputPublication.prototype.dispose.call(task.publication);
            report.input ??= {};
            report.input.publication = publicationSummary(task.publication);
            if (!failed) requirePublicationReleased(task.publication);
            task.publication = undefined;
        }
        if (task.capture) {
            const d = captureState.call(task.capture);
            need(!d.busy && !d.pending && d.cleanup === "complete", "Original input source cleanup unresolved");
            need(WindowsWorkspaceInputCapture.prototype.dispose.call(task.capture) === true, "Source cleanup not complete");
            task.capture = undefined;
        }
    } catch (error) { fail(error, true); }
    report.cancelled ||= signal.aborted;
    if (report.cancelled && !failed) fail(new Error("Input execution cancelled"));
    if (failed) throw failure;
    need(report.released && !task.volume.inputReferencesHeld && task.checked, "Released input chain required before host apply");
    return { candidate: task.checked, binding: { taskId: report.taskId, snapshotId: report.snapshotId, instanceId: task.vm.id,
        volumePath: report.prepared.volumePath, exchangeId: report.prepared.exchangeId } };
}
export function finishInputCandidates(task, report) {
    if (!task.checked) return;
    const checked = task.checked;
    task.volume.disposeCandidates();
    need(checked.diagnostics.retainedPayloadBytes === 0 && checked.diagnostics.retainedRequestBytes === 0
        && !checked.diagnostics.retainedContext, "Actual candidate buffers remain");
    if (report.candidate) report.candidate.buffersReleased = true;
    task.checked = undefined;
    syncCandidateEvidence(task, report);
}
