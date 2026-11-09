// Explicit acceptance coordinator. Production CodeMode does not import this module.
import { createHash } from "node:crypto";
import { parseSandboxTaskRequest } from "./retired-sandbox/task-request.ts";
import { SandboxTaskBinding } from "./retired-sandbox/task-binding.ts";
import { SandboxLifecycle } from "./windows-sandbox-lifecycle.mjs";
import { TaskVolumeOwner } from "./windows-sandbox-volume.mjs";
import { WindowsWorkspaceInputCapture } from "./windows-sandbox-workspace-input-capture.mjs";
import { TaskInputPublication } from "./windows-sandbox-task-publication.mjs";
import { TaskResultReader } from "./windows-sandbox-task-result.mjs";
import { experimentalGuidConfig } from "./windows-sandbox-volume-sharing.mjs";
import { parseFixedEntryExit } from "./windows-sandbox-fixed-acceptance.mjs";
import { CANDIDATE_LIMITS } from "./windows-sandbox-candidates.mjs";
import { candidateTask, candidateReport, syncCandidateEvidence } from "./windows-sandbox-volume-candidate-session.mjs";
import { volumeBinding, vmQuiescent } from "./windows-sandbox-volume-share.mjs";
import { boundedText } from "./windows-sandbox-volume-session.mjs";
export { finishInputCandidates } from "./windows-sandbox-input-execution-session.mjs";

const need = (value, reason) => { if (!value) throw new Error(reason); };
const ENVIRONMENT_BASE64 = /^[A-Za-z0-9+/]+=*$/;
const hash = value => createHash("sha256").update(value).digest("hex");
const state = Class => Object.getOwnPropertyDescriptor(Class.prototype, "diagnostics").get;
const captureState = state(WindowsWorkspaceInputCapture), publicationState = state(TaskInputPublication);
const captureFailure = Object.getOwnPropertyDescriptor(WindowsWorkspaceInputCapture.prototype, "failure").get;
const resultState = state(TaskResultReader), bindingState = state(SandboxTaskBinding);
export const TASK_NORMAL_FILES = Object.freeze(["volume-native.dll", "task-runner.exe", "task-package.bin", "task-input-receipt.json",
    "task-result.bin", "task-result-receipt.json", "candidate-manifest.bin", "candidate-manifest-receipt.json",
    "candidate-request.json", "candidate-payload.bin", "candidate-batch-receipt.json", "volume-helper.json", "lifecycle.json"]);
const PREVIEW_BYTES = 64, PREVIEW_JSON_BYTES = 192;
/** Completion-only preview. Decode a byte prefix, never the entire result body.
 * Replacement decoding also applies if that prefix ends inside a UTF-8 sequence.
 * boundedText sees at most 64 decoded characters, including escaped controls. */
export function taskOutputPreview(bytes) {
    need(Buffer.isBuffer(bytes) && bytes.length <= 32768, "Task preview buffer bound");
    const decodedBytes = Math.min(bytes.length, PREVIEW_BYTES);
    return { text: boundedText(bytes.toString("utf8", 0, decodedBytes), PREVIEW_JSON_BYTES),
        sourceBytes: bytes.length, decodedBytes, omittedBytes: bytes.length - decodedBytes };
}
export const TASK_FIXTURE_COMMAND = "$ErrorActionPreference='Stop'; $text=[IO.File]::ReadAllText('source.txt'); "
    + "if ($text -cne 'alpha') { throw 'Input mismatch' }; $utf8=New-Object System.Text.UTF8Encoding($false); "
    + "[IO.File]::WriteAllText('source.txt',$text+'-guest'+\"`r`n\",$utf8); "
    + "[IO.File]::WriteAllText('new.txt','derived:'+$text+\"`r`n\",$utf8); "
    + "[Console]::Out.Write(\"stdout:alpha 中文`r`n\"); [Console]::Error.Write(\"stderr:fixture`r`n\"); exit 0";
export function taskReport(taskId, snapshotId, root, rootId) {
    return { ...candidateReport(taskId, snapshotId, root, rootId), protocol: "super-pi-generic-task-acceptance-v1",
        input: null, command: null, host: null, binding: null, resultReader: null };
}
export function taskFrame(report, controller, toolchains) {
    const task = candidateTask(report, controller, toolchains), baseQuiescent = task.quiescent, baseDispose = task.dispose;
    task.capture = undefined; task.publication = undefined; task.resultReader = undefined; task.binding = undefined;
    task.hostRetention = undefined; task.hostDone = false; task.weak = [];
    task.quiescent = function() {
        const c = this.capture && captureState.call(this.capture), p = this.publication && publicationState.call(this.publication);
        const r = this.resultReader && resultState.call(this.resultReader), b = this.binding && bindingState.call(this.binding);
        return !this.hostRetention && (!c || !c.busy && !c.pending && c.cleanup === "complete")
            && (!p || !p.pending && !p.retainedFd && !p.closeFailed)
            && (!r || !r.pending && !r.retainedFd && !r.closeUnknown) && (!b || !b.pending) && baseQuiescent.call(this);
    };
    task.dispose = function() {
        need(!this.capture && !this.publication && !this.resultReader && !this.binding && !this.hostRetention && this.hostDone,
            "Task input/result/host responsibility remains"); baseDispose.call(this);
    };
    return task;
}
export function taskHelpers(calls) {
    need(calls.length <= 4, "Task helper bound");
    return calls.map(call => ({ executable: boundedText(call.executable, 32), pid: call.pid, outcome: boundedText(call.outcome, 32),
        killRequested: call.killRequested, result: call.result ? { exitCode: call.result.exitCode, signal: call.result.signal,
            launchError: call.result.launchError ? boundedText(call.result.launchError, 64) : null,
            stdoutSeen: call.result.stdoutSeen, stderrSeen: call.result.stderrSeen, truncated: call.result.truncated,
            stdoutPrefix: boundedText(call.result.stdout, 96), stderrPrefix: boundedText(call.result.stderr, 96), prefixesOnly: true } : null }));
}
function publicationSummary(value) {
    const d = publicationState.call(value), c = d.capture, r = c?.reader, n = r?.reader, p = r?.permission, g = p?.grant;
    return { phase: d.phase, disposed: d.disposed, pending: d.pending, retainedFd: d.retainedFd,
        retainedBorrow: d.retainedBorrow, retainedMetadata: d.retainedMetadata, retainedPackage: d.retainedPackage, retainedCapture: d.retainedCapture,
        opened: d.opened, closed: d.closed, closeAttempts: d.closeAttempts, allocated: d.allocatedBytes, cleared: d.clearedBytes,
        copied: d.copiedBytes, copyCleared: d.copyClearedBytes, receiptIdentity: d.receiptIdentity, builder: d.builder,
        operationFailed: d.operationFailed, closeFailed: d.closeFailed,
        capture: c ? { status: c.status, cleanup: c.cleanup, copies: c.copyRequests, renewals: c.renewals,
            publicationRenewals: c.publicationRenewals, retainedReader: c.retainedReader, retainedInput: c.retainedInput,
            retainedMetadata: c.retainedMetadata, retainedCopySlots: c.retainedCopySlots,
            allocated: c.input?.allocatedBytes, cleared: c.input?.clearedBytes, retainedBytes: c.input?.retainedBytes,
            source: n ? { opened: n.opened, closed: n.closed, closeAttempts: n.closeAttempts, active: n.activeHandles,
                reads: n.readCalls, bytes: n.readBytes, contentOpens: n.contentOpens, retainedSlots: n.retainedSlots,
                retainedContext: n.retainedContext, retainedOperations: n.retainedOperations,
                scratchAllocated: n.native?.native?.allocatedScratch, scratchReleased: n.native?.native?.releasedScratch,
                scratchRetained: n.native?.native?.retainedScratch } : null,
            permission: p ? { state: p.state, pending: p.pending, renewals: p.renewals, weakReferences: p.weakReferences,
                retainedPrepare: p.retainedPrepare, retainedVerifier: p.retainedVerifier, retainedGrant: p.retainedGrant, retainedBinding: p.retainedBinding,
                grant: g ? { state: g.state, grants: g.grants, weakReferences: g.weakReferences, retainedObserver: g.retainedObserver,
                    retainedVerifier: g.retainedVerifier, policyDisposals: g.policyDisposals } : null } : null } : null };
}
function requirePublicationReleased(p) {
    const d = publicationSummary(p), c = d.capture, s = c?.source, permission = c?.permission, grant = permission?.grant;
    need(d.disposed && !d.pending && !d.retainedFd && !d.retainedBorrow && !d.retainedMetadata && !d.retainedPackage && !d.retainedCapture
        && !d.operationFailed && !d.closeFailed && d.opened === 2 && d.closed === 2 && d.closeAttempts === 2 && d.phase === 3
        && d.allocated === d.cleared && d.copied === 5 && d.copyCleared === 5
        && d.builder.retainedBytes === 0 && d.builder.retainedInputRows === 0
        && d.builder.commandScratchBytes === d.builder.commandClearedBytes && d.builder.transferredBytes > 5,
        "Task publication release");
    need(c.status === "disposed" && c.cleanup === "complete" && !c.retainedReader && !c.retainedInput && !c.retainedMetadata
        && c.retainedCopySlots === 0 && c.copies === 1 && c.renewals === 6 && c.publicationRenewals === 3
        && c.allocated === 5 && c.cleared === 5 && c.retainedBytes === 0
        && s.opened > 0 && s.closed === s.opened && s.closeAttempts === s.opened && s.active === 0 && s.reads === 1 && s.bytes === 5
        && s.contentOpens === 1 && s.retainedSlots === 0 && !s.retainedContext && !s.retainedOperations
        && s.scratchAllocated > 0 && s.scratchReleased === s.scratchAllocated && s.scratchRetained === 0,
        "Task original source release");
    need(permission.state === "disposed" && !permission.pending && permission.weakReferences === 0 && permission.renewals === 6
        && !permission.retainedPrepare && !permission.retainedVerifier && !permission.retainedGrant && !permission.retainedBinding
        && grant.state === "disposed" && grant.grants === 0 && grant.weakReferences === 0 && !grant.retainedObserver && !grant.retainedVerifier
        && grant.policyDisposals === 1, "Original input permission release");
}
async function executeTaskRunner(task, snapshotId, request, signal, environment) {
    const { vm, volume, runtime, driver } = task;
    await TaskVolumeOwner.prototype.renewInputExecution.call(volume, vm);
    const instanceId = vm.id, taskId = vm.taskId;
    const validate = current => current === vm && current.id === instanceId && current.taskId === taskId && !signal.aborted
        && current.state === "executing-volume-input" && !current.cleanupPromise && !current.active && !current.execution && !current.connection
        && task.vm === vm && task.volume === volume && task.runtime === runtime && task.driver === driver
        && TaskVolumeOwner.prototype.assertInputExecution.call(volume, vm) === true;
    need(typeof environment === "string" && environment.length <= 24000 && ENVIRONMENT_BASE64.test(environment), "Toolchain environment required");
    const command = '"C:\\SuperPiVolume\\tools\\task-runner.exe" ' + taskId + " " + snapshotId + " --toolchain " + environment;
    vm.state = "executing-volume-input"; vm.save();
    const result = await SandboxLifecycle.prototype.invoke.call(vm, "exec", ["exec", "--id", instanceId, "-c", command,
        "-d", "C:\\SuperPiVolume\\workspace", "-r", "System", "--raw"], request.timeoutMs + 10000, signal, validate);
    vm.state = "volume-input-returned"; vm.save();
    return { source: "platform-interface", wrapperExitCode: parseFixedEntryExit(result) };
}
export async function runOwnedTaskChain(task, report, signal, borrow, options) {
    const failures = [];
    const fail = (error, cleanup = false) => {
        failures.push(error); report[cleanup ? "cleanupError" : "error"] ??= boundedText(error instanceof Error ? error.message : String(error));
        report.retained = true; report.retentionReason ??= "task-chain-incomplete";
    };
    try {
        signal.throwIfAborted(); borrow.assertInputsCurrent();
        const captured = task.capture && await WindowsWorkspaceInputCapture.prototype.capture.call(task.capture);
        if (captured && (captured.status !== "captured" || captured.cleanup !== "complete")) {
            const failure = captureFailure.call(task.capture);
            if (failure.failed) throw failure.error;
            if (failure.cleanupFailed) throw failure.cleanupError;
            throw new Error("Original task capture incomplete");
        }
        borrow.assertInputsCurrent();
        task.publication = new TaskInputPublication(options.root, options.rootId, task.capture, options.tool, borrow, report.taskId, report.snapshotId);
        task.capture = undefined; task.weak.push(new WeakRef(task.publication));
        await TaskInputPublication.prototype.prepare.call(task.publication);
        const declaration = Object.getOwnPropertyDescriptor(TaskInputPublication.prototype, "declaration").get.call(task.publication);
        report.input = { publication: publicationSummary(task.publication), packageBytes: declaration.package.bytes, packageSha256: declaration.package.sha256 };
        options.save(); signal.throwIfAborted(); options.attachManager(declaration);
        report.prepared = volumeBinding(await task.volume.prepare());
        task.vm = options.buildVm(experimentalGuidConfig(task.volume)); task.runtime.bind(task.vm);
        report.input.installed = await TaskVolumeOwner.prototype.installTaskInputsOnce.call(task.volume, task.publication, task.vm);
        task.save();
        const ticket = await task.volume.issueExperimentalMapping(task.vm);
        await task.volume.startExperimentalMapping(ticket, task.vm, signal);
        report.guestExit = await executeTaskRunner(task, report.snapshotId, borrow.request, signal, options.environment);
        need(report.guestExit.wrapperExitCode === 0, "Guest task wrapper failed");
    } catch (error) { fail(error); }
    let closed = false;
    try {
        if (task.vm) need(await task.vm.cleanup(), "Task VM cleanup unresolved");
        closed = vmQuiescent(task); need(closed, "Original VM/CLI closure missing");
    } catch (error) { fail(error, true); }
    // A wrapper may fail after publishing the bounded command result (for
    // example a declared output is absent). Preserve those command diagnostics,
    // while the original wrapper failure still forbids all candidate writeback.
    if (closed && (!failures.length || report.guestExit) && !signal.aborted) {
        try {
            borrow.assertInputsCurrent();
            const facts = task.volume.facts;
            task.resultReader = new TaskResultReader({ owner: task.volume, vm: task.vm, taskId: report.taskId, snapshotId: report.snapshotId,
                root: options.root, rootId: options.rootId, volumePath: facts.volumePath, exchangeId: facts.exchangeId, timeoutMs: borrow.request.timeoutMs });
            task.weak.push(new WeakRef(task.resultReader));
            const result = await TaskVolumeOwner.prototype.readTaskResultOnce.call(task.volume, task.resultReader, task.vm, report.snapshotId);
            // Only the small display prefix is decoded. Counts and digests use
            // the original raw buffer views without materializing a full string.
            const stdoutPreview = taskOutputPreview(result.stdout), stderrPreview = taskOutputPreview(result.stderr);
            report.command = { state: result.state, source: result.source, exitCode: result.exitCode, timedOut: result.timedOut,
                elapsedMs: result.elapsedMs, flags: result.flags, guestTreeSettlementClaimed: result.guestTreeSettlementClaimed,
                decode: "utf8-replacement", previewByteLimit: PREVIEW_BYTES, previewJsonByteLimit: PREVIEW_JSON_BYTES,
                stdout: stdoutPreview.text, stderr: stderrPreview.text,
                previewDecodedBytes: [stdoutPreview.decodedBytes, stderrPreview.decodedBytes],
                previewOmittedBytes: [stdoutPreview.omittedBytes, stderrPreview.omittedBytes],
                stdoutBytes: result.stdout.length, stderrBytes: result.stderr.length, stdoutSeen: result.stdoutSeen, stderrSeen: result.stderrSeen,
                stdoutTruncated: result.stdoutTruncated, stderrTruncated: result.stderrTruncated,
                stdoutSha256: hash(result.stdout), stderrSha256: hash(result.stderr), native: task.resultReader.nativeReceipt };
            report.resultReader = { beforeRelease: resultState.call(task.resultReader) };
            if (options.fixture !== false) need(result.exitCode === 0 && !result.timedOut && !result.stdoutTruncated && !result.stderrTruncated
                && result.stdout.equals(Buffer.from("stdout:alpha 中文\r\n")) && result.stderr.equals(Buffer.from("stderr:fixture\r\n")),
                "Actual command result differs");
            // Completion-only consumer. It must copy only its bounded presentation;
            // the original buffer views are cleared by dispose immediately below.
            options.onResult?.(result);
            const acceptCandidates = !failures.length && result.exitCode === 0 && !result.timedOut && borrow.request.writes.length > 0;
            TaskResultReader.prototype.dispose.call(task.resultReader);
            report.resultReader.afterRelease = resultState.call(task.resultReader);
            const rd = report.resultReader.afterRelease;
            need(rd.disposed && rd.opened === 2 && rd.closed === 2 && rd.closeAttempts === 2 && rd.allocatedBytes === rd.clearedBytes
                && rd.retainedBytes === 0 && !rd.retainedFd && !rd.retainedOwner && !rd.retainedVm && !rd.retainedResult && rd.records === 0,
                "Task result reader release");
            task.resultReader = undefined;
            if (acceptCandidates) {
            task.channel = options.buildChannel(task);
            task.checked = await task.volume.readCandidatesOnce({ taskId: report.taskId, snapshotId: report.snapshotId, instanceId: task.vm.id,
                volumePath: facts.volumePath, exchangeId: facts.exchangeId, budget: { ...CANDIDATE_LIMITS },
                allowed: borrow.request.writes.map(write => ({ path: write.path, operation: write.operation, revision: write.snapshot })) }, task.channel.interface);
            task.weak.push(new WeakRef(task.checked));
            const expected = [["new.txt", "add", "derived:alpha\r\n"], ["source.txt", "modify", "alpha-guest\r\n"]], records = task.checked.records;
            if (options.fixture !== false) {
            need(records.length === 2, "Two actual task candidates required");
            for (let index = 0; index < records.length; index++) need(records[index].path === expected[index][0]
                && records[index].operation === expected[index][1] && records[index].bytes === Buffer.byteLength(expected[index][2])
                && records[index].sha256 === hash(expected[index][2]), "Actual task candidate differs");
            }
            report.candidate = { status: task.checked.status, source: "host-captured-guest-data", buffersReleased: false,
                records: records.map(row => ({ path: row.path, operation: row.operation, bytes: row.bytes, sha256: row.sha256, identity: row.identity })),
                guest: task.checked.guestReport, native: task.checked.captureCounts };
            }
        } catch (error) { fail(error); }
        finally { syncCandidateEvidence(task, report); }
    }
    try {
        if (task.resultReader) {
            report.resultReader ??= {}; report.resultReader.beforeRelease ??= resultState.call(task.resultReader);
            TaskResultReader.prototype.dispose.call(task.resultReader);
            report.resultReader.afterRelease = resultState.call(task.resultReader); task.resultReader = undefined;
        }
    } catch (error) { fail(error, true); }
    try {
        need(vmQuiescent(task), "Cannot release task volume before original VM closure");
        if (task.volume) report.released = await task.volume.release();
    } catch (error) { fail(error, true); }
    try {
        if (task.publication) {
            TaskInputPublication.prototype.dispose.call(task.publication);
            report.input ??= {}; report.input.publication = publicationSummary(task.publication);
            if (!failures.length && options.fixture !== false) requirePublicationReleased(task.publication);
            task.publication = undefined;
        }
    } catch (error) { fail(error, true); }
    report.cancelled ||= signal.aborted;
    if (report.cancelled) fail(new Error("Task cancelled"));
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, "Task execution and cleanup failed");
    need(report.released && !task.volume.inputReferencesHeld && (options.fixture === false || task.checked), "Task ownership must settle before original host writeback");
    return { candidate: task.checked, binding: { taskId: report.taskId, snapshotId: report.snapshotId, instanceId: task.vm.id,
        volumePath: report.prepared.volumePath, exchangeId: report.prepared.exchangeId } };
}
export async function produceTaskCandidates(task, report, signal, capture, revision, original, options) {
    need(!task.capture && !task.publication && !task.binding, "Task input already adopted");
    task.capture = capture; task.weak.push(new WeakRef(capture)); // Adopt before the first await or live binding construction.
    let failed = false, failure, result; const cleanup = [];
    try {
        const request = parseSandboxTaskRequest({ version: 1, profile: "windows-powershell-foreground-v1", command: TASK_FIXTURE_COMMAND,
            cwd: ".", timeoutMs: 10000, inputs: [{ path: "source.txt", snapshot: revision }],
            writes: [{ path: "new.txt", operation: "add", snapshot: null }, { path: "source.txt", operation: "modify", snapshot: revision }] });
        task.binding = new SandboxTaskBinding(request, original.owner, original.ctx, original.execution, original.parentToolCallId, original.signal, original.runtime);
        task.weak.push(new WeakRef(task.binding));
        const combined = AbortSignal.any([signal, original.signal]);
        result = await SandboxTaskBinding.prototype.run.call(task.binding, borrow => runOwnedTaskChain(task, report, combined, borrow, options));
    } catch (error) { failed = true; failure = error; }
    finally {
        if (task.capture) try {
            need(WindowsWorkspaceInputCapture.prototype.dispose.call(task.capture) === true, "Task source disposal unresolved"); task.capture = undefined;
        } catch (error) { cleanup.push(error); }
        if (task.binding) try {
            SandboxTaskBinding.prototype.dispose.call(task.binding); report.binding = bindingState.call(task.binding);
            need(!report.binding.pending && !report.binding.retainedSource && report.binding.weakReferences === 0 && report.binding.metadataChars === 0,
                "Original task binding remains"); task.binding = undefined;
        } catch (error) { cleanup.push(error); }
    }
    if (cleanup.length) throw new AggregateError(failed ? [failure, ...cleanup] : cleanup, "Task binding/source cleanup failed");
    if (failed) throw failure;
    return result;
}
