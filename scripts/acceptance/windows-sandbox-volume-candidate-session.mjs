// One fixed synthetic candidate capture chain. Explicit cold acceptance only.
import { createHash } from "node:crypto";
import { SandboxLifecycle } from "./windows-sandbox-lifecycle.mjs";
import { TaskVolumeOwner } from "./windows-sandbox-volume.mjs";
import { LiveSandboxRuntime, experimentalGuidConfig } from "./windows-sandbox-volume-sharing.mjs";
import { parseFixedEntryExit } from "./windows-sandbox-fixed-acceptance.mjs";
import { CANDIDATE_PROTOCOL, CANDIDATE_LIMITS } from "./windows-sandbox-candidates.mjs";
import { boundedText } from "./windows-sandbox-volume-session.mjs";
import { sharingReport, volumeBinding, volumeSnapshot, vmQuiescent } from "./windows-sandbox-volume-share.mjs";
const need = (value, message) => { if (!value) throw Error(message); };
const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/;
export const CANDIDATE_TEXT = "super-pi-candidate-v1\r\n";
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
export const CANDIDATE_NORMAL_FILES = Object.freeze(["volume-native.dll", "candidate-manifest.bin", "candidate-manifest-receipt.json",
    "candidate-request.json", "candidate-payload.bin", "candidate-batch-receipt.json", "volume-helper.json", "lifecycle.json"]);
export const CANDIDATE_CMD_PATH = "C:\\Windows\\System32\\cmd.exe";
export const CANDIDATE_CMD_PREFIX = Object.freeze(["/d", "/a", "/e:on", "/v:off", "/c"]);
export function candidateCommandBody(taskId, snapshotId) {
    need(typeof taskId === "string" && UUID.test(taskId) && typeof snapshotId === "string" && UUID.test(snapshotId), "Fixed candidate UUIDs required");
    const manifest = JSON.stringify({ protocol: CANDIDATE_PROTOCOL, taskId, snapshotId,
        candidates: [{ path: "a.txt", operation: "add" }], report: { exitCode: 23 } });
    // No whitespace before &&: echo must not add a trailing space to the fixed ASCII payload.
    return 'mkdir "payload"&&>"payload\\a.txt" echo super-pi-candidate-v1'
        + '&&<"payload\\a.txt">"candidates.json" set /p SP_FIXED_CANDIDATE=' + manifest;
}
export function candidateCommand(taskId, snapshotId) {
    return '"' + CANDIDATE_CMD_PATH + '" ' + CANDIDATE_CMD_PREFIX.join(" ") + " " + candidateCommandBody(taskId, snapshotId);
}
export function candidateReport(taskId, snapshotId, root, rootId) {
    need(UUID.test(taskId) && UUID.test(snapshotId), "Fixed candidate context");
    const report = sharingReport(taskId, root, rootId);
    report.protocol = "super-pi-volume-candidate-acceptance-v1";
    report.guestRead = undefined;
    report.snapshotId = snapshotId; report.candidate = null; report.candidateIo = null;
    report.candidateStage = null; report.retentionReason = null;
    return report;
}
const errorFact = (failed, error) => !failed ? null : [
    typeof error, boundedText(error instanceof Error ? error.name : String(error), 40),
    boundedText(error instanceof Error ? error.message : String(error), 80),
    error && typeof error.code === "string" ? boundedText(error.code, 32) : null,
];
export function syncCandidateEvidence(task, report) {
    const owner = task.volume?.candidateDiagnostics;
    if (owner) report.candidateStage = { stage: owner.stage, leaseHeld: owner.leaseHeld, physicalSettled: owner.physicalSettled,
        snapshotStage: owner.snapshotStage, snapshotCurrent: owner.snapshotCurrent, snapshotFailed: owner.snapshotFailed };
    if (task.channel) {
        const d = task.channel.diagnostics, s = task.channel.snapshot();
        // Compact fixed rows preserve observed identity and independent operation/close facts; no raw payload or full native error table.
        report.candidateIo = { source: "host-cli-process", opened: s.opened, closed: s.closed, peak: s.peak, pending: s.pending,
            uncertain: s.uncertainHandles, calls: d.calls, allocated: d.allocatedBytes, cleared: d.clearedBytes, transferred: d.transferredBytes,
            rows: d.records.map(r => [r.name, r.id ?? null, r.fd ?? null, r.createAttempted, r.created, r.opened, r.closed, r.closeAttempts,
                errorFact(r.operationFailed, r.operationError), errorFact(r.closeFailed, r.closeError)]),
            recordedBeforeDispose: true };
        task.privateRecorded = true;
    }
}
export function candidateTask(report, controller) {
    const task = {
        runtime: new LiveSandboxRuntime(report.taskId), vm: undefined, volume: undefined, driver: undefined,
        channel: undefined, checked: undefined, privateRecorded: false, helpers: undefined, save: undefined,
        cancel() { controller.abort(); this.volume?.revoke(); },
        unsafe() { controller.abort(); this.volume?.onUnsafe(); },
        quiescent() {
            const s = this.channel?.snapshot(), lease = this.volume?.candidateDiagnostics;
            return !this.helpers?.active && vmQuiescent(this)
                && (!s || !s.pending && s.activeHandles === 0 && s.uncertainHandles.length === 0)
                && (!lease || !lease.leaseHeld && lease.physicalSettled)
                && (this.driver ? this.volume?.state === "released" && this.driver.physicallyClosed && !this.driver.pending : this.volume === undefined);
        },
        attach(driver, save) {
            need(!this.driver && !this.volume, "Candidate manager already bound"); this.driver = driver; this.save = save;
            this.volume = new TaskVolumeOwner({ driver, taskId: report.taskId, readRuntime: this.runtime.read,
                journal: value => { report.volume = volumeSnapshot(value); syncCandidateEvidence(this, report); save(); },
                revokeCandidates() { report.revoked = true; }, cancelExecution() { controller.abort(); report.cancelled = true; } });
        },
        dispose() {
            need(!report.retained && this.quiescent() && (!this.channel || this.privateRecorded), "Candidate task remains retained");
            this.volume?.disposeCandidates();
            if (this.channel) { this.channel.dispose(); this.channel = undefined; }
            this.checked = undefined; this.runtime.dispose();
            if (this.helpers) { this.helpers.calls.length = 0; this.helpers.persist = undefined; this.helpers.launch = undefined; }
            this.helpers = undefined; this.vm = undefined; this.volume = undefined; this.driver = undefined; this.runtime = undefined; this.save = undefined;
        },
    };
    return task;
}
export async function executeCandidateFixture(task, snapshotId, signal) {
    const { vm, volume, driver, runtime } = task;
    need(vm instanceof SandboxLifecycle && vm.state === "registered-not-guest-ready" && vm.registered && vm.startSettled && !signal.aborted,
        "Candidate fixture requires owned registration");
    const taskId = vm.taskId, instanceId = vm.id;
    // One cold phase check after registration. This is not continuous volume monitoring.
    await volume.verify();
    const verifiedRuntime = runtime.read();
    need(task.vm === vm && task.volume === volume && task.driver === driver && task.runtime === runtime
        && vm.state === "registered-not-guest-ready" && vm.registered && vm.startSettled && !vm.cleanupPromise
        && !vm.active && !vm.execution && !vm.connection && !signal.aborted && vm.taskId === taskId && vm.id === instanceId
        && verifiedRuntime.owner === vm && verifiedRuntime.taskId === taskId && verifiedRuntime.instanceId === instanceId
        && volume.state === "prepared-not-share-admitted" && volume.experimentalMappingState === "dispatched"
        && driver.physicallyClosed === false && driver.pending === false,
        "Candidate binding changed during volume verification");
    const command = candidateCommand(taskId, snapshotId);
    const validate = current => current === vm && current.id === instanceId && current.taskId === taskId && !signal.aborted
        && current.state === "executing-volume-candidate" && !current.cleanupPromise && !current.active && !current.execution && !current.connection
        && task.vm === vm && task.volume === volume && task.driver === driver && task.runtime === runtime
        && volume.state === "prepared-not-share-admitted" && volume.experimentalMappingState === "dispatched"
        && driver.physicallyClosed === false && driver.pending === false && runtime.read().owner === vm;
    vm.state = "executing-volume-candidate"; vm.save(); need(!signal.aborted && !vm.cleanupPromise, "Candidate fixture revoked before dispatch");
    const result = await SandboxLifecycle.prototype.invoke.call(vm, "exec", ["exec", "--id", vm.id, "-c", command,
        "-d", "C:\\SuperPiVolume", "-r", "System", "--raw"], vm.limits.execMs, signal, validate);
    vm.state = "volume-candidate-returned"; vm.save();
    return { source: "guest-report", interfaceSource: "platform-interface", exitCode: parseFixedEntryExit(result) };
}
export async function exerciseCandidates(task, report, signal, buildVm, buildChannel) {
    let closed = false;
    const failure = (error, cleanup = false) => {
        report[cleanup ? "cleanupError" : "error"] ??= boundedText(error instanceof Error ? error.message : String(error));
        report.retained = true; report.retentionReason ??= "fixed-artifacts-unconfirmed-or-failed";
    };
    try {
        need(!signal.aborted, "Cancelled before candidate volume preparation");
        report.prepared = volumeBinding(await task.volume.prepare());
        need(!signal.aborted, "Cancelled before candidate VM");
        task.vm = buildVm(experimentalGuidConfig(task.volume)); task.runtime.bind(task.vm);
        const ticket = await task.volume.issueExperimentalMapping(task.vm);
        await task.volume.startExperimentalMapping(ticket, task.vm, signal);
        report.guestExit = await executeCandidateFixture(task, report.snapshotId, signal);
        need(report.guestExit.exitCode === 0, "Guest fixture write reported failure");
    } catch (error) { failure(error); }
    try {
        if (task.vm) need(await task.vm.cleanup(), "Candidate VM cleanup unresolved");
        closed = vmQuiescent(task); need(closed, "Candidate VM and CLI closure not established");
    } catch (error) { failure(error, true); }
    if (closed && !report.error && !report.cleanupError && !signal.aborted) {
        try {
            need(!task.channel && !task.checked, "Candidate channel already bound");
            task.channel = buildChannel(task);
            const binding = task.volume.facts;
            task.checked = await task.volume.readCandidatesOnce({ taskId: report.taskId, snapshotId: report.snapshotId, instanceId: task.vm.id,
                volumePath: binding.volumePath, exchangeId: binding.exchangeId, budget: { ...CANDIDATE_LIMITS },
                allowed: [{ path: "a.txt", operation: "add", revision: null }] }, task.channel.interface);
            const records = task.checked.records;
            need(records.length === 1 && records[0].path === "a.txt" && records[0].operation === "add"
                && records[0].bytes === Buffer.byteLength(CANDIDATE_TEXT), "Fixed candidate shape");
            report.candidate = { status: task.checked.status, source: "host-cli-process", path: records[0].path,
                bytes: records[0].bytes, sha256: records[0].sha256, sourceId: records[0].identity,
                guest: task.checked.guestReport, native: task.checked.captureCounts, matchedAfterRelease: false, buffersReleased: false };
        } catch (error) { failure(error); }
        finally { syncCandidateEvidence(task, report); }
    }
    try {
        need(vmQuiescent(task), "Cannot release candidate volume before VM closure");
        report.released = await task.volume.release();
    } catch (error) { failure(error, true); }
    try {
        if (task.checked && report.released && !report.error && !report.cleanupError && !signal.aborted) {
            const bytes = task.checked.copyBytes(0);
            try {
                need(bytes.toString("utf8") === CANDIDATE_TEXT && hash(bytes) === hash(CANDIDATE_TEXT) && hash(bytes) === report.candidate.sha256
                    && task.checked.guestReport.exitCode === 23, "Fixed candidate bytes or guest claim mismatch");
                report.candidate.matchedAfterRelease = true;
            } finally { bytes.fill(0); }
        }
    } catch (error) { failure(error, true); }
    finally {
        try {
            if (task.checked) {
                const checked = task.checked;
                task.volume.disposeCandidates();
                need(!checked.diagnostics.retainedContext && checked.diagnostics.retainedPayloadBytes === 0
                    && checked.diagnostics.retainedRequestBytes === 0, "Candidate buffers remain");
                if (report.candidate) report.candidate.buffersReleased = true;
                task.checked = undefined;
            }
            syncCandidateEvidence(task, report);
        } catch (error) { failure(error, true); }
    }
    report.cancelled ||= signal.aborted;
    if (report.cancelled) { report.retained = true; report.retentionReason ??= "cancelled-fixed-candidate"; }
    report.sequencePassed = !report.retained && !report.error && !report.cleanupError && !report.cancelled && report.released === true
        && report.candidate?.matchedAfterRelease === true && report.candidate.buffersReleased === true && report.guestExit?.exitCode === 0;
    return report.sequencePassed;
}
