// Cold writeback acceptance after the preserved §65 diagnostic-layer failure.
import { createHash } from "node:crypto";
import { TaskVolumeOwner } from "./windows-sandbox-volume.mjs";
import { WindowsWorkspaceInputCapture } from "./windows-sandbox-workspace-input-capture.mjs";
import { CapturedInputPublication } from "./windows-sandbox-input-publication.mjs";
import { experimentalGuidConfig } from "./windows-sandbox-volume-sharing.mjs";
import { CANDIDATE_LIMITS } from "./windows-sandbox-candidates.mjs";
import { syncCandidateEvidence } from "./windows-sandbox-volume-candidate-session.mjs";
import { volumeBinding, vmQuiescent } from "./windows-sandbox-volume-share.mjs";
import { boundedText } from "./windows-sandbox-volume-session.mjs";
import { inputReport as executionReport, executeInputWorker } from "./windows-sandbox-input-execution-session.mjs";
export { inputTask, inputHelpers, finishInputCandidates, INPUT_NORMAL_FILES } from "./windows-sandbox-input-execution-session.mjs";

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

export function inputReport(taskId, snapshotId, root, rootId) {
    const report = executionReport(taskId, snapshotId, root, rootId);
    report.protocol = "super-pi-input-writeback-v1";
    return report;
}

// Diagnostics are evidence from the original owner, never authorization. Actual
// publication, dispatch and execution still use the original identity checks.
function requirePermissionShape(permission) {
    const grant = permission?.grant;
    const integers = (value, names) => names.every(name => Number.isSafeInteger(value?.[name]) && value[name] >= 0);
    const booleans = (value, names) => names.every(name => typeof value?.[name] === "boolean");
    need(typeof permission?.state === "string"
        && integers(permission, ["checks", "renewals", "grantDisposals", "weakReferences", "metadataChars", "paths"])
        && booleans(permission, ["pending", "retainedPrepare", "retainedVerifier", "retainedGrant", "retainedBinding"]),
        "Original session permission diagnostic schema");
    need(typeof grant?.state === "string"
        && integers(grant, ["observations", "checks", "paths", "pathChars", "grants", "grantChars", "weakReferences", "policyDisposals"])
        && booleans(grant, ["pending", "originalIssuance", "retainedObserver", "retainedVerifier"]),
        "Original inner grant diagnostic schema");
}
function permissionSummary(permission) {
    if (!permission) return null;
    const pick = (value, names) => Object.fromEntries(names.map(name => [name, value[name] ?? null]));
    return { ...pick(permission, ["state", "pending", "checks", "renewals", "grantDisposals", "weakReferences", "metadataChars", "paths",
        "retainedPrepare", "retainedVerifier", "retainedGrant", "retainedBinding"]),
        grant: permission.grant ? pick(permission.grant, ["state", "pending", "observations", "checks", "paths", "pathChars", "grants",
            "grantChars", "weakReferences", "originalIssuance", "retainedObserver", "retainedVerifier", "policyDisposals"]) : null };
}
function requirePublicationPrepared(value) {
    const d = publicationState.call(value), c = d.capture, r = c?.reader, permission = r?.permission;
    requirePermissionShape(permission);
    need(!d.disposed && d.retainedCapture && !d.pending && !d.retainedFd && !d.operationFailed && !d.closeFailed
        && d.phase === 0 && d.opened === 1 && d.closed === 1 && d.closeAttempts === 1
        && d.allocatedBytes === 5 && d.clearedBytes === 5
        && c.status === "captured" && c.cleanup === "complete" && !c.busy && !c.pending
        && r.retainedPermission && !r.busy && !r.pending,
        "Original input publication preparation");
    need(permission.state === "ready" && !permission.pending && permission.retainedPrepare && permission.retainedVerifier
        && permission.retainedGrant && permission.retainedBinding && permission.grantDisposals === 0
        && permission.paths > 0 && permission.weakReferences > 0 && permission.metadataChars > 0,
        "Original session permission not ready before manager");
    const grant = permission.grant;
    need(grant.state === "ready" && !grant.pending && grant.grants === 1 && grant.originalIssuance
        && grant.paths > 0 && grant.pathChars > 0 && grant.grantChars > 0 && grant.weakReferences > 0
        && grant.retainedObserver && grant.retainedVerifier && grant.policyDisposals === 0,
        "Original inner grant not ready before manager");
    return permissionSummary(permission);
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
            permission: permissionSummary(r?.permission) } : null };
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
        && n?.opened > 0 && n.closed === n.opened && n.closeAttempts === n.opened && n.activeHandles === 0
        && n.readCalls === 1 && n.readBytes === 5 && n.contentOpens === 1
        && !n.retainedContext && !n.retainedOperations && !n.retainedGuard && n.retainedSlots === 0,
        "Original source reader settlement");
    const permission = r.permission;
    requirePermissionShape(permission);
    need(permission.state === "disposed" && !permission.pending && permission.renewals === 6
        && permission.grantDisposals === 1 && permission.weakReferences === 0 && permission.metadataChars === 0 && permission.paths === 0
        && !permission.retainedPrepare && !permission.retainedVerifier && !permission.retainedGrant && !permission.retainedBinding,
        "Original session permission settlement");
    const grant = permission.grant;
    need(grant.state === "disposed" && !grant.pending && grant.grants === 0 && grant.grantChars === 0
        && grant.paths === 0 && grant.pathChars === 0 && grant.weakReferences === 0 && !grant.originalIssuance
        && !grant.retainedObserver && !grant.retainedVerifier && grant.policyDisposals === 1 && grant.policy === undefined,
        "Original inner grant settlement");
    need(n.native?.disposed && !n.native.retainedOperations && !n.native.retainedGuard && !n.native.retainedGrant
        && n.native.native?.allocatedScratch > 0 && n.native.native.releasedScratch === n.native.native.allocatedScratch
        && n.native.native.retainedScratch === 0 && !n.native.native.retainedBindings,
        "Original source native scratch settlement");
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
        report.input = { preparedPermission: requirePublicationPrepared(task.publication) }; options.save();
        options.attachManager(declaration);
        report.prepared = volumeBinding(await task.volume.prepare());
        task.vm = options.buildVm(experimentalGuidConfig(task.volume)); task.runtime.bind(task.vm);
        const installed = await TaskVolumeOwner.prototype.installCapturedInputOnce.call(task.volume, task.publication, task.vm);
        report.input = { ...report.input, installed, publication: publicationSummary(task.publication) }; task.save();
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
