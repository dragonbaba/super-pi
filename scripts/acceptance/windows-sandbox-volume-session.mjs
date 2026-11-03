// Cold, manual acceptance coordination. No process is created by importing this module.
import fs from "node:fs";
import path from "node:path";
import { NativeOutput } from "./windows-sandbox-volume-native-acceptance.mjs";
import { UndispatchedError, CapturedProcess, SandboxLifecycle } from "./windows-sandbox-lifecycle.mjs";
export const SESSION_LIMITS = Object.freeze({ records: 99, cli: 96, helpers: 2, managers: 1, pending: 4, journal: 8192, evidence: 7680, footer: 512 });
export const CAPACITY_SESSION_LIMITS = Object.freeze({ records: 99, cli: 95, helpers: 3, managers: 1, pending: 4, journal: 8192, evidence: 7680, footer: 512 });
export const INPUT_SESSION_LIMITS = Object.freeze({ records: 99, cli: 95, helpers: 3, managers: 1, pending: 4, journal: 16384, evidence: 15360, footer: 512 });
export const TASK_SESSION_LIMITS = Object.freeze({ records: 99, cli: 94, helpers: 4, managers: 1, pending: 4, journal: 24576, evidence: 23040, footer: 512 });
export const FAULT_SESSION_LIMITS = Object.freeze({ records: 99, cli: 95, helpers: 3, managers: 1, pending: 4, journal: 8192, evidence: 7680, footer: 512 });
const KINDS = new Set(["preflight", "compile", "manager", "list", "start", "exec", "stop"]);
const CLI_KINDS = new Set(["list", "start", "exec", "stop"]);
const SHARING_FILES = new Map([["volume-native.dll", 131072], ["volume-guest-read.json", 4096],
    ...["prepare", "verify", "read-guest", "release", "exit"].map(command => ["volume-error-" + command + ".json", 4096]),
    ["volume-helper.json", 8192], ["lifecycle.json", 8192]]);
const CAPACITY_FILES = new Map([["volume-native.dll", 131072], ["capacity-probe.exe", 65536], ["capacity-host-sentinel.bin", 32],
    ["volume-capacity-install.json", 4096], ["volume-capacity-read.json", 4096],
    ...["prepare", "verify", "install-capacity", "read-capacity", "release", "exit"].map(command => ["volume-error-" + command + ".json", 4096]),
    ["volume-helper.json", 8192], ["lifecycle.json", 8192]]);
const CANDIDATE_FILES = new Map([["volume-native.dll", 131072], ["candidate-manifest.bin", 4096], ["candidate-manifest-receipt.json", 4096],
    ["candidate-request.json", 4096], ["candidate-payload.bin", 16384], ["candidate-batch-receipt.json", 4096],
    ["candidate-manifest-error.json", 4096], ["candidate-batch-error.json", 4096],
    ...["prepare", "verify", "release", "exit"].map(command => ["volume-error-" + command + ".json", 4096]),
    ["volume-helper.json", 8192], ["lifecycle.json", 8192]]);
const INPUT_FILES = new Map([...CANDIDATE_FILES].filter(([name]) => name !== "lifecycle.json").concat([
    ["input-source.bin", 4096], ["offline-worker.exe", 65536], ["candidate-input-receipt.json", 4096],
    ["candidate-input-error.json", 4096], ["lifecycle.json", INPUT_SESSION_LIMITS.journal],
]));
const TASK_FILES = new Map([...CANDIDATE_FILES].filter(([name]) => name !== "lifecycle.json").concat([
    ["task-package.bin", 49168], ["task-runner.exe", 65536],
    ["task-input-receipt.json", 4096], ["task-input-error.json", 4096],
    ["task-result.bin", 65664], ["task-result-receipt.json", 4096], ["task-result-error.json", 4096],
    ["lifecycle.json", TASK_SESSION_LIMITS.journal],
]));
function need(value, message) { if (!value) throw Error(message); }
function profileFiles(profile) {
    need(profile === "sharing" || profile === "capacity" || profile === "candidate" || profile === "input" || profile === "task", "Fixed session profile required");
    return profile === "task" ? TASK_FILES : profile === "input" ? INPUT_FILES : profile === "capacity" ? CAPACITY_FILES : profile === "candidate" ? CANDIDATE_FILES : SHARING_FILES;
}
const closed = call => call?.physicallyClosed === true || !!call?.result;
export function boundedText(value, maximum = 128) {
    const text = String(value ?? "");
    if (Buffer.byteLength(JSON.stringify(text)) <= maximum) return text;
    let low = 0, high = text.length;
    while (low < high) {
        const middle = Math.ceil((low + high) / 2);
        if (Buffer.byteLength(JSON.stringify(text.slice(0, middle) + "…")) <= maximum) low = middle; else high = middle - 1;
    }
    return text.slice(0, low) + "…";
}
export function sessionJournal(resource, report, unsafe, profile = "sharing") {
    need(profile === "sharing" || profile === "input" || profile === "task", "Fixed journal profile required");
    const limits = profile === "task" ? TASK_SESSION_LIMITS : profile === "input" ? INPUT_SESSION_LIMITS : SESSION_LIMITS;
    return () => {
        need(!report.artifactsRemoved && !report.cleanupStarted, "Never recreate removed task records");
        need(!report.journalFailed, "Session journal permanently failed");
        try {
            need(Buffer.byteLength(JSON.stringify(report, null, 2)) <= limits.journal, "Combined journal bound");
            resource.journal(report);
        } catch (error) {
            report.journalFailed = true; report.cleanupError ??= boundedText(error.message);
            unsafe(); throw error;
        }
    };
}
function callSummary(kind, call) {
    const r = call.result;
    return { kind, pid: call.pid ?? null, exitCode: r?.exitCode ?? null, signal: r?.signal ?? null,
        launchError: r?.launchError ? boundedText(r.launchError, 64) : null,
        stdoutSeen: r?.stdoutSeen ?? 0, stderrSeen: r?.stderrSeen ?? 0, truncated: r?.truncated ?? false,
        stdoutPrefix: boundedText(r?.stdout, 96), stderrPrefix: boundedText(r?.stderr, 96), prefixesOnly: true };
}
export class SharingLifetime {
    #records = []; #task; #bus; #save; #report; #output; #timers; #hold; #scheduled = false; #completing = false; #finished = false; #released = false; #taskDisposed = false;
    #helpers = 0; #managers = 0; #cli = 0; #vmRecordCount = 0;
    #profile; #limits;
    constructor({ bus, stream, report, save, task, profile = "sharing", timers = { setInterval, clearInterval } }) {
        if (profile !== "fault") profileFiles(profile); // Fault never enters ordinary file cleanup APIs.
        this.#profile = profile; this.#limits = profile === "task" ? TASK_SESSION_LIMITS : profile === "input" ? INPUT_SESSION_LIMITS : profile === "fault" ? FAULT_SESSION_LIMITS : profile === "capacity" ? CAPACITY_SESSION_LIMITS : SESSION_LIMITS;
        this.#bus = bus; this.#report = report; this.#save = save; this.#task = task; this.#timers = timers;
        this.#output = new NativeOutput(stream, report, this.onOutputFailure); this.#output.onDrained = this.maybeRelease;
        bus.on("SIGINT", this.cancel); bus.on("SIGTERM", this.cancel);
    }
    get output() { return this.#output; }
    get profile() { return this.#profile; }
    get released() { return this.#released; }
    get retainsTask() { return this.#task !== undefined; }
    get trackedCount() { return this.#records.length; }
    get physicalClosed() { return this.#records.every(record => record.phase === "not-started" || record.call && closed(record.call)); }
    cancel = () => {
        if (this.#report.artifactsRemoved) return;
        if (this.#profile === "fault") {
            if (this.#report.userCancelled) return;
            this.#report.userCancelled = true; // Expected internal fault cancellation must not hide a later user stop.
        } else if (this.#report.cancelled) return;
        this.#report.cancelled = true; this.#report.passed = false;
        try { this.#task.cancel(); } catch (error) { this.#report.cleanupError ??= boundedText(error.message); }
        try { this.#save(); } catch {}
    };
    onOutputFailure = () => {
        this.#report.cleanupError = boundedText(this.#report.cleanupError);
        if (!this.#report.artifactsRemoved) {
            try { this.#task.unsafe(); } catch {}
            if (!this.#report.cleanupStarted) { try { this.#save(); } catch {} }
        }
    };
    launch(kind, factory, authorization) {
        const cli = CLI_KINDS.has(kind), manager = kind === "manager";
        try {
            need(!this.#completing && !this.#finished && !this.#report.journalFailed
                && (KINDS.has(kind) || this.#profile === "fault" && kind === "diagnostic" || this.#profile === "task" && kind === "contract") && typeof factory === "function", "Session launch admission");
            if (this.#profile === "fault") {
                need(!this.#report.userCancelled, "User stopped fault session");
                need(kind !== "exec", "Fault scene never dispatches guest execution");
                if (["preflight", "compile", "diagnostic"].includes(kind))
                    need(!this.#records.some(record => record.kind === kind), "Fault helper role already reserved");
            }
            let pending = 0; for (const record of this.#records) if (record.phase !== "not-started" && (!record.call || !closed(record.call))) pending++;
            need(this.#records.length < this.#limits.records && pending < this.#limits.pending
                && (cli ? this.#cli < this.#limits.cli : manager ? this.#managers < this.#limits.managers : this.#helpers < this.#limits.helpers), "Session pre-spawn budget");
        } catch (error) { throw new UndispatchedError(error.message, { cause: error }); }
        // The factory has not been called; the VM must retract its provisional logical record even on a quota rejection.
        if (cli) this.#cli++; else if (manager) this.#managers++; else this.#helpers++;
        const record = { kind, requestedUtc: new Date().toISOString(), phase: "reserved", call: undefined };
        this.#records.push(record);
        try { this.snapshot(); this.#save(); } // Reserve and persist before invoking any spawning constructor.
        catch (error) {
            record.phase = "not-started";
            try { this.snapshot(); } catch {} // Publish known non-dispatch in memory even when the journal is permanently unavailable.
            throw new UndispatchedError(error.message, { cause: error });
        }
        try {
            if (kind === "start" || kind === "exec" || kind === "diagnostic")
                need(authorization && typeof authorization.validate === "function", "Final host dispatch permission required");
            if (authorization) need(!authorization.signal?.aborted && authorization.validate(authorization.owner) === true, "Final host dispatch permission revoked");
        } catch (error) {
            record.phase = "not-started";
            try { this.snapshot(); this.#save(); } catch {}
            throw new UndispatchedError(error.message, { cause: error });
        } // No await or host callback after the final private guard and before factory().
        try {
            const call = factory(); record.call = call; record.phase = "attached";
            if (!closed(call)) call.once("settled", this.onSettled);
            this.snapshot(); this.#save(); return call;
        } catch (error) {
            if (!record.call) record.phase = "launch-unknown"; // A throwing factory cannot prove it created no child.
            this.#report.retained = true; this.#report.error ??= boundedText(error.message);
            try { this.snapshot(); this.#save(); } catch {} throw error;
        }
    }
    faultProcessFacts(task, driver, diagnostic) {
        need(this.#profile === "fault" && this.#task === task && !this.#released && task.driver === driver
            && task.vm instanceof SandboxLifecycle && !this.#report.journalFailed, "Original fault session binding");
        const vm = task.vm, seen = new Set();
        let cliCount = 0, helpers = 0, managers = 0, diagnosticCount = 0, processes = 0;
        for (const record of this.#records) {
            if (record.kind === "diagnostic" && diagnostic === undefined) {
                need(record.phase === "reserved" && record.call === undefined && ++diagnosticCount === 1, "Only current diagnostic reservation");
                continue; // Reserved final guard before the creating constructor, not physical closure.
            }
            const call = record.call;
            need(record.phase === "attached" && call && !seen.has(call), "Unknown/unattached or aliased fault process");
            seen.add(call); processes++;
            if (record.kind === "manager") {
                need(++managers === 1 && call === driver && driver.physicallyClosed && driver.childReleased
                    && !driver.pending && driver.diagnostics.buffersReleased, "Original manager responsibility remains");
                continue;
            }
            need(call instanceof CapturedProcess && Number.isInteger(call.pid) && call.pid > 0 && call.result?.pid === call.pid
                && call.child === undefined && call.out === undefined && call.err === undefined, "Original capture has not physically closed");
            if (CLI_KINDS.has(record.kind)) {
                const entry = vm.calls[cliCount++];
                need(record.kind !== "exec" && entry?.kind === record.kind && entry.pid === call.pid
                    && entry.result === call.result && entry.outcome?.endsWith("settled"), "Original VM call/result association");
            } else {
                need(["preflight", "compile", "diagnostic"].includes(record.kind), "Unexpected fault helper"); helpers++;
                if (record.kind === "diagnostic") need(++diagnosticCount === 1 && call === diagnostic, "Original diagnostic reference");
                else need(call.result.exitCode === 0 && call.result.signal === null && call.result.launchError === null
                    && call.result.truncated === false && call.result.stderrSeen === 0, "Prior helper was unsuccessful");
            }
        }
        need(managers === 1 && cliCount === vm.calls.length && cliCount >= 6 && cliCount <= 95
            && helpers === (diagnostic ? 3 : 2) && (diagnostic ? diagnosticCount === 1 : diagnosticCount <= 1)
            && processes === cliCount + (diagnostic ? 4 : 3) && this.#records.length <= 99, "Fault process budget or coverage");
        return Object.freeze({ cliCount, cliClosed: cliCount, processCount: processes, processClosed: processes,
            managerPid: driver.pid, managerClosed: true, diagnosticPid: diagnostic?.pid ?? null,
            diagnosticClosed: diagnostic !== undefined, pending: diagnostic ? 0 : diagnosticCount });
    }

    snapshot() {
        const pending = []; let attached = 0, notStarted = 0, observedStarted = 0, launchUnknown = 0, physicallyClosed = 0, resultCharacters = 0, lastCli;
        for (const record of this.#records) {
            const call = record.call;
            if (record.phase === "not-started") notStarted++;
            if (record.phase === "launch-unknown") launchUnknown++;
            if (call) {
                attached++; if (Number.isInteger(call.pid) && call.pid > 0) observedStarted++;
                if (closed(call)) physicallyClosed++;
                if (call.result) resultCharacters += (call.result.stdout?.length ?? 0) + (call.result.stderr?.length ?? 0);
                if (CLI_KINDS.has(record.kind)) lastCli = record;
            }
            if (record.phase !== "not-started" && (!call || !closed(call))) pending.push({ kind: record.kind, pid: call?.pid ?? null, requestedUtc: record.requestedUtc, phase: record.phase });
        }
        need(pending.length <= this.#limits.pending && this.#records.length <= this.#limits.records, "Unresolved ownership exceeds report bound");
        this.#vmRecordCount = Math.max(this.#vmRecordCount, this.#task.vm?.calls.length ?? 0);
        need(this.#vmRecordCount <= this.#limits.cli, "VM call record bound");
        this.#report.physical = { reservations: this.#records.length, attached, notStarted, observedStarted, launchUnknown, physicallyClosed,
            resultCharacters, pending, cliReservations: this.#cli, cliRecords: this.#vmRecordCount };
        this.#report.lastCli = lastCli?.call ? callSummary(lastCli.kind, lastCli.call) : null;
    }
    onSettled = () => {
        if (!this.#report.artifactsRemoved && !this.#report.cleanupStarted) {
            try { this.snapshot(); this.#save(); } catch {}
        }
        this.maybeRelease(); // Late close never resumes VM, disk, read or deletion operations.
    };
    hold = () => {}; // Keeps an unresolved task owner alive; no polling or recovery work.
    maybeRelease = () => {
        if (!this.#finished || this.#released || this.#scheduled) return;
        if (this.#output.pending || !this.physicalClosed || !this.#report.artifactsRemoved || !this.#taskDisposed) {
            this.#hold ??= this.#timers.setInterval(this.hold, 60000); return;
        }
        this.#scheduled = true; setImmediate(this.release);
    };
    release = () => {
        this.#scheduled = false;
        if (!this.#finished || this.#output.pending || !this.physicalClosed || !this.#report.artifactsRemoved || !this.#taskDisposed) return;
        this.#bus.off("SIGINT", this.cancel); this.#bus.off("SIGTERM", this.cancel);
        for (const record of this.#records) record.call?.off("settled", this.onSettled);
        if (this.#hold !== undefined) this.#timers.clearInterval(this.#hold);
        this.#records.length = 0; this.#output.dispose(); this.#released = true;
        this.#task = undefined; this.#bus = undefined; this.#save = undefined; this.#report = undefined; this.#timers = undefined; this.#hold = undefined;
    };
    closeTaskBinding() {
        need(this.#completing && !this.#taskDisposed && !this.#output.pending && this.physicalClosed
            && this.#report.artifactsRemoved && this.#task.quiescent(), "Whole task is not ready to release its binding");
        this.#task.dispose(); this.#taskDisposed = true; this.#report.taskReferencesReleased = true;
    }
    beginCompletion() { need(!this.#completing, "Completion already started"); this.#completing = true; this.snapshot(); }
    finish() { this.snapshot(); this.#finished = true; this.maybeRelease(); }
}

function identity(stat) { return String(stat.dev) + ":" + String(stat.ino); }
function rootCheck(io, root, rootId) {
    need(path.isAbsolute(root) && path.resolve(root) === root && io.realpathSync(root) === root, "Canonical owned root required");
    const stat = io.lstatSync(root, { bigint: true });
    need(stat.isDirectory() && !stat.isSymbolicLink() && identity(stat) === rootId, "Owned root identity changed");
}
export function snapshotSessionFiles(root, rootId, io = fs, profile = "sharing") {
    const FILES = profileFiles(profile);
    rootCheck(io, root, rootId); const names = io.readdirSync(root);
    need(names.length <= FILES.size && names.every(name => FILES.has(name)), "Unexpected task file; retain root");
    const manifest = [];
    for (const [name, maximum] of FILES) {
        if (!names.includes(name)) continue;
        const file = path.join(root, name), stat = io.lstatSync(file, { bigint: true });
        need(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1n && stat.size <= BigInt(maximum)
            && io.realpathSync(file) === file, "Task file shape/size changed");
        manifest.push(Object.freeze({ name, id: identity(stat), bytes: Number(stat.size) }));
    }
    return Object.freeze(manifest); // lifecycle.json is deliberately last.
}
export function removeSessionFiles(root, rootId, manifest, io = fs, progress, profile = "sharing") {
    const FILES = profileFiles(profile), current = snapshotSessionFiles(root, rootId, io, profile);
    need(JSON.stringify(current) === JSON.stringify(manifest), "Task manifest changed before cleanup");
    let removed = 0;
    for (const item of manifest) {
        rootCheck(io, root, rootId); const file = path.join(root, item.name), stat = io.lstatSync(file, { bigint: true });
        need(FILES.has(item.name) && identity(stat) === item.id && Number(stat.size) === item.bytes && stat.isFile()
            && !stat.isSymbolicLink() && stat.nlink === 1n && io.realpathSync(file) === file, "Task leaf identity changed");
        io.unlinkSync(file); removed++; if (progress) progress.removedFiles = removed;
    }
    rootCheck(io, root, rootId); io.rmdirSync(root); return removed; // Never recursively delete or recreate records.
}

export function combinedCleanupAllowed(report, task, lifetime) {
    return report.evidenceEmitted && !report.outputFailed && !report.outputBoundFailed && !report.journalFailed && !report.cleanupError
        && !report.retained && !lifetime.output.pending && lifetime.physicalClosed && report.receiptUnknownHandles.length === 0 && task.quiescent();
}
export async function completeSharingSession({ report, task, lifetime, save, root, rootId, io = fs }) {
    const limits = lifetime.profile === "task" ? TASK_SESSION_LIMITS : lifetime.profile === "input" ? INPUT_SESSION_LIMITS : SESSION_LIMITS;
    try {
    lifetime.beginCompletion(); report.reportedUtc = new Date().toISOString(); report.passed = false;
    if (!task.quiescent() || !lifetime.physicalClosed || report.receiptUnknownHandles.length) {
        report.retained = true; report.cleanupError ??= "Combined owner remains unresolved";
    }
    let evidence;
    try { save(); } catch { report.retained = true; } // Last journal write precedes capturing its own final identity.
    if (!report.retained && !report.cleanupError && !report.journalFailed) {
        try { report.files = snapshotSessionFiles(root, rootId, io, lifetime.profile ?? "sharing"); }
        catch (error) { report.retained = true; report.cleanupError = boundedText(error.message); }
    }
    try {
        // The manifest is appended after the last journal save. Bound the bytes actually emitted here;
        // sessionJournal independently bounds every persisted record, including failure-path saves.
        evidence = JSON.stringify(report) + "\n";
        need(Buffer.byteLength(evidence) <= limits.evidence, "Combined evidence bound");
    } catch (error) {
        report.outputBoundFailed = true; report.retained = true; report.cleanupError ??= boundedText(error.message);
        evidence = JSON.stringify({ protocol: report.protocol, taskId: report.taskId, artifactRoot: root, passed: false, complete: false,
            reason: "journal-or-report-bound", physical: report.physical, vm: report.vm, volume: report.volume }) + "\n";
        need(Buffer.byteLength(evidence) <= limits.evidence, "Failure evidence exceeds bound; owner retained");
    }
    try { await lifetime.output.write(evidence); report.evidenceEmitted = true; } catch (error) { lifetime.output.onError(error); }
    if (combinedCleanupAllowed(report, task, lifetime)) {
        try {
            report.cleanupStarted = true;
            report.removedFiles = removeSessionFiles(root, rootId, report.files, io, report, lifetime.profile ?? "sharing"); report.artifactsRemoved = true;
        } catch (error) { report.retained = true; report.cleanupError = boundedText(error.message); }
    } else report.retained = true;
    if (report.artifactsRemoved) {
        try { lifetime.closeTaskBinding(); } catch (error) { report.retained = true; report.cleanupError = boundedText(error.message); }
    }
    report.passed = report.sequencePassed === true && report.artifactsRemoved && report.taskReferencesReleased === true
        && !report.cancelled && !report.error && !report.cleanupError && !report.outputFailed;
    if (!report.artifactsRemoved && !report.cleanupStarted && !report.journalFailed) { try { save(); } catch {} }
    if (!lifetime.output.failed) {
        const footer = JSON.stringify({ kind: lifetime.profile === "task" ? "volume-task-cleanup" : lifetime.profile === "input" ? "volume-input-cleanup" : lifetime.profile === "capacity" ? "volume-capacity-cleanup" : lifetime.profile === "candidate" ? "volume-candidate-cleanup" : "volume-share-cleanup", taskId: report.taskId, passed: report.passed, artifactsRemoved: report.artifactsRemoved,
            retained: report.retained, removedFiles: report.removedFiles, cleanupError: report.cleanupError === null ? null : boundedText(report.cleanupError, 96) }) + "\n";
        need(Buffer.byteLength(footer) <= limits.footer, "Combined footer bound");
        try { await lifetime.output.write(footer); } catch (error) { lifetime.output.onError(error); }
    }
    return report;
    } finally { lifetime.finish(); }
}
