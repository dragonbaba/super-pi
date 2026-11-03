// Experimental storage lifecycle only. No WSB execution, mapping, or production entry point.
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { SandboxLifecycle } from "./windows-sandbox-lifecycle.mjs";
import { singleGuidVolumeConfig } from "./windows-sandbox-volume-config.mjs";
import { validateGuestReadReceipt } from "./windows-sandbox-volume-guest-read.mjs";
import { validateCapacityReceipt } from "./windows-sandbox-volume-capacity-receipt.mjs";
import { CapturedCandidateOwner } from "./windows-sandbox-volume-candidate-contract.mjs";

export const POWERSHELL7_PATH = "D:\\PowerShell\\7\\pwsh.exe";
export const POWERSHELL7_SHA256 = "2a6769a3330dc1084d0154bfde7d164ab750ca7f700f313f9d417c1be78b2233";
export const POWERSHELL7_SETTINGS = fileURLToPath(new URL("./windows-sandbox-powershell7.config.json", import.meta.url));
const POWERSHELL7_BASE_SETTINGS = "D:\\PowerShell\\7\\powershell.config.json";
const POWERSHELL7_BASE_SETTINGS_SHA256 = "98c0e5b6ee17eb8b8f4e4940c2b2528689cec8470db4bde427ad16d90d6a52d4";
export const POWERSHELL7_SETTINGS_SHA256 = "7ad7607adf83f5df57f786d85911facef02103f42d3f6b5e1ee1fde2b8778e51";
export const POWERSHELL7_PREFIX = Object.freeze(["-NoLogo", "-NoProfile", "-NonInteractive", "-SettingsFile", POWERSHELL7_SETTINGS]);
export function verifyPowerShell7() {
	need(process.platform === "win32" && createHash("sha256").update(fs.readFileSync(POWERSHELL7_PATH)).digest("hex") === POWERSHELL7_SHA256, "Pinned PowerShell 7 changed");
	const baseline = fs.lstatSync(POWERSHELL7_BASE_SETTINGS);
	need(baseline.isFile() && !baseline.isSymbolicLink() && baseline.size <= 4096
		&& createHash("sha256").update(fs.readFileSync(POWERSHELL7_BASE_SETTINGS)).digest("hex") === POWERSHELL7_BASE_SETTINGS_SHA256, "PowerShell 7 base settings changed; review the preserved policy");
	const config = fs.lstatSync(POWERSHELL7_SETTINGS);
	need(config.isFile() && !config.isSymbolicLink() && config.size <= 256
		&& createHash("sha256").update(fs.readFileSync(POWERSHELL7_SETTINGS)).digest("hex") === POWERSHELL7_SETTINGS_SHA256, "PowerShell 7 no-fallback settings changed");
}

export const VOLUME_LIMITS = Object.freeze({ capacity: 128 * 1024 * 1024, imageBytes: 129 * 1024 * 1024,
	partitionBytes: 126 * 1024 * 1024, nativeBytes: 128 * 1024, journalBytes: 8192, stderrBytes: 1024, messages: 32, commands: 16 });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const VOLUME = /^\\\\\?\\Volume\{[0-9a-fA-F-]{36}\}\\$/;
const FILE_ID = /^[0-9A-F]{8}:[0-9A-F]{16}$/;
function need(condition, message) { if (!condition) throw new Error(message); }
function keys(value, expected) { need(value && !Array.isArray(value) && Object.keys(value).sort().join(",") === expected, "Volume reply schema"); }
function validateReply(reply, taskId, sequence) {
	keys(reply, "capacity,closeUnknown,detached,diskId,error,exchangeId,imageBudget,imageCreated,imageId,kind,managementClosed,phase,physicalPath,protocol,sequence,shareAdmission,taskId,volumePath");
	need(reply.protocol === "super-pi-volume-v1" && reply.taskId === taskId && reply.diskId === taskId && reply.sequence === sequence, "Volume reply association");
	need(["progress", "reply", "fatal"].includes(reply.kind) && typeof reply.phase === "string" && reply.phase.length <= 64, "Volume reply kind");
	need(reply.error === null || ["storage-operation-failed", "storage-identity-failed", "control-or-journal-failed"].includes(reply.error), "Volume error schema");
	for (const key of ["closeUnknown", "detached", "managementClosed", "imageCreated"]) need(typeof reply[key] === "boolean", "Volume flag schema");
	need(reply.capacity === VOLUME_LIMITS.capacity && reply.imageBudget === VOLUME_LIMITS.imageBytes && reply.shareAdmission === false, "Volume capacity/admission");
	for (const key of ["imageId", "exchangeId"]) need(reply[key] === null || typeof reply[key] === "string" && FILE_ID.test(reply[key]), "Volume file identity");
	need(reply.physicalPath === null || typeof reply.physicalPath === "string" && /^\\\\\.\\PhysicalDrive[0-9]{1,10}$/.test(reply.physicalPath), "Physical path schema");
	need(reply.volumePath === null || typeof reply.volumePath === "string" && VOLUME.test(reply.volumePath), "Volume path schema");
	return Object.freeze({ ...reply });
}

// At most one pending bounded command. A logical deadline NEVER kills the manager.
export class VolumeProtocol extends EventEmitter {
	#child; #pid; #taskId; #pending; #sequence = 0; #messages = 0; #line = Buffer.alloc(8192); #length = 0;
	#blocked = false; #exiting = false; #closed = false; #exitResult; #unsafe; #closeWait;
	#stderr = Buffer.alloc(VOLUME_LIMITS.stderrBytes); #stderrLength = 0; #stderrSeen = 0; #stderrBase64 = "";
	#exitCode = null; #signal = null;
	constructor(child, taskId) {
		super(); need(UUID.test(taskId), "Task UUID required"); this.#child = child; this.#pid = child.pid ?? null; this.#taskId = taskId;
		child.stdout.on("data", this.onData); child.stdout.on("end", this.onEnd);
		child.stderr.on("data", this.onStderr); child.stdin.on("error", this.onError); child.on("error", this.onError); child.on("close", this.onClose);
	}
	get pid() { return this.#pid; }
	get childReleased() { return this.#child === undefined; }
	get physicallyClosed() { return this.#closed; }
	get pending() { return this.#pending !== undefined; }
	get blocked() { return this.#blocked; }
	get diagnostics() {
		return { exitCode: this.#exitCode, signal: this.#signal, buffersReleased: this.#line === undefined && this.#stderr === undefined,
			stderr: { encoding: "uninterpreted", rawBase64: this.#stderr ? this.#stderr.toString("base64", 0, this.#stderrLength) : this.#stderrBase64,
				seenBytes: this.#stderrSeen, capturedBytes: this.#stderrLength, truncated: this.#stderrSeen > this.#stderrLength } };
	}
	setUnsafeHandler(callback) { need(this.#unsafe === undefined, "Unsafe handler already bound"); this.#unsafe = callback; if (this.#blocked) callback(); }
	#fail(message, publish = true) {
		const first = !this.#blocked;
		this.#blocked = true;
		if (first && this.#pending) { clearTimeout(this.#pending.timer); this.#pending.reject(new Error(message)); }
		if (publish && first) this.#unsafe?.(); // Physical operation/child is still retained until reply/close.
	}
	onError = () => this.#fail("Volume helper launch/transport failure");
	onStderr = chunk => {
		this.#stderrSeen = Math.min(Number.MAX_SAFE_INTEGER, this.#stderrSeen + chunk.length);
		const count = Math.min(chunk.length, this.#stderr.length - this.#stderrLength);
		chunk.copy(this.#stderr, this.#stderrLength, 0, count); this.#stderrLength += count;
		if (!this.#blocked) this.#fail("Unexpected helper stderr");
	};
	onEnd = () => { if (!this.#exiting) this.#fail("Volume control output lost"); };
	onData = chunk => {
		if (this.#blocked) return;
		try {
			for (let i = 0; i < chunk.length; i++) {
				if (chunk[i] !== 10) {
					need(this.#length < this.#line.length, "Volume output bound"); this.#line[this.#length++] = chunk[i]; continue;
				}
				need(++this.#messages <= VOLUME_LIMITS.messages && this.#pending, "Unexpected volume message");
				const text = new TextDecoder("utf-8", { fatal: true }).decode(this.#line.subarray(0, this.#length)); this.#length = 0;
				const reply = validateReply(JSON.parse(text), this.#taskId, this.#sequence);
				this.#pending.observe(reply);
				if (reply.kind === "fatal") throw new Error("Volume helper control failed");
				if (reply.kind === "reply") {
					const pending = this.#pending; this.#pending = undefined; clearTimeout(pending.timer);
					pending.resolve(reply);
				}
			}
		} catch { this.#fail("Invalid volume protocol or journal callback"); }
	};
	onClose = (code, signal) => {
		this.#exitCode = code; this.#signal = signal;
		this.#closed = true; this.#exitResult = code === 0 && signal === null && this.#exiting && !this.#pending && !this.#blocked;
		if (!this.#exitResult) this.#fail("Volume helper exited unexpectedly", false);
		if (this.#pending) { clearTimeout(this.#pending.timer); this.#pending = undefined; }
		this.#line = undefined; this.#length = 0;
		this.#stderrBase64 = this.#stderr.toString("base64", 0, this.#stderrLength); this.#stderr = undefined;
		this.#child.stdout.off("data", this.onData); this.#child.stdout.off("end", this.onEnd);
		this.#child.stderr.off("data", this.onStderr); this.#child.stdin.off("error", this.onError); this.#child.off("error", this.onError); this.#child.off("close", this.onClose);
		this.#child = undefined;
		const closeWait = this.#closeWait; this.#closeWait = undefined;
		try { if (!this.#exitResult) this.#unsafe?.(); } // Publish only after pending, buffers and listeners are released.
		finally { closeWait?.(); this.emit("settled"); }
	};
	command(command, observe, timeoutMs = 120000) {
		need(!this.#blocked && !this.#closed && !this.#pending && ++this.#sequence <= VOLUME_LIMITS.commands, "Volume command admission blocked");
		need(["prepare", "verify", "probe", "read-guest", "install-capacity", "read-capacity", "install-input", "install-task", "read-task-result", "read-candidate-manifest", "read-candidate-batch", "release", "exit"].includes(command) && typeof observe === "function"
			&& Number.isInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 120000, "Invalid fixed command");
		if (command === "exit") this.#exiting = true;
		return new Promise((resolve, reject) => {
			this.#pending = { resolve, reject, observe, timer: setTimeout(() => this.#fail("Volume operation deadline; owner retained"), timeoutMs) };
			const request = JSON.stringify({ command, taskId: this.#taskId, sequence: this.#sequence });
			this.#child.stdin.write(request + "\n", error => { if (error) this.#fail("Volume control input lost"); });
		});
	}
	waitClosed(timeoutMs = 5000) {
		if (this.#closed) return Promise.resolve(this.#exitResult);
		need(!this.#closeWait && Number.isInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 5000, "Volume close wait admission");
		return new Promise(resolve => {
			const timer = setTimeout(() => { this.#closeWait = undefined; this.#fail("Volume helper close deadline"); resolve(false); }, timeoutMs);
			this.#closeWait = () => { clearTimeout(timer); resolve(this.#exitResult); };
		});
	}
}

// Cold, explicit manager-loss acceptance only. No timers, PID lookup or default trigger.
const managerLossErrorFact = error => {
    try { return Object.freeze({ name: String(error?.name ?? typeof error).slice(0, 64),
        code: error?.code == null ? null : String(error.code).slice(0, 64) }); }
    catch { return Object.freeze({ name: "unreadable-error", code: null }); }
};
// Only the dedicated host factory supplies launch/wrap/persist. No guest-controlled callback.
export class ManagerLossFactory {
    #taskId; #launch; #wrap; #persist; #child; #driver; #binding;
    #phase = "new"; #launchAttempted = false; #armAttempted = false; #verified = false; #revoked = false; #attempts = 0;
    #pid = null; #closed = false; #exitCode = null; #signal = null;
    #requestReturned = null; #requestThrew = false; #requestError; #requestErrorFact = null;
    #errorCount = 0; #firstChildError; #firstChildErrorFact = null; #recordFailed = false; #recordError; #recordErrorFact = null;
    #listenersAttached = false; #disposed = false; #launchSettled = false;
    #recordPending = false; #recordPromise; #recordContinuation; #recordRejected = false; #recordRejection; #recordRejectionFact = null;
    #recordObserverFailed = false; #recordInFlight = false;
    constructor({ taskId, launch, wrap, persist }) {
        need(typeof taskId === "string" && UUID.test(taskId) && typeof launch === "function"
            && typeof wrap === "function" && typeof persist === "function", "Fixed fault factory required");
        this.#taskId = taskId; this.#launch = launch; this.#wrap = wrap; this.#persist = persist;
    }
    get driver() { return this.#driver; } // The original protocol, never the child.
    get snapshot() {
        return Object.freeze({ taskId: this.#taskId, instanceId: this.#binding?.instanceId ?? null, phase: this.#phase,
            launchAttempted: this.#launchAttempted, armAttempted: this.#armAttempted, verified: this.#verified, revoked: this.#revoked,
            attempts: this.#attempts, pid: this.#pid, requestReturned: this.#requestReturned, requestThrew: this.#requestThrew,
            requestError: this.#requestErrorFact, childErrorCount: this.#errorCount, childErrorsTruncated: this.#errorCount > 4, childError: this.#firstChildErrorFact,
            closeObserved: this.#closed, exitCode: this.#exitCode, signal: this.#signal,
            recordFailed: this.#recordFailed, recordError: this.#recordErrorFact, disposed: this.#disposed,
            pendingRecords: this.#recordPending ? 1 : 0, recordPromiseHeld: this.#recordPromise !== undefined,
            recordInFlight: this.#recordInFlight,
            recordRejected: this.#recordRejected, recordRejection: this.#recordRejectionFact, recordObserverFailed: this.#recordObserverFailed,
            childHeld: this.#child !== undefined, driverHeld: this.#driver !== undefined,
            bindingHeld: this.#binding !== undefined, callbacksHeld: !!(this.#launch || this.#wrap || this.#persist) });
    }
    get originalErrors() { return Object.freeze({ request: this.#requestError, child: this.#firstChildError,
        record: this.#recordError, recordRejection: this.#recordRejection }); }
    #settleRecord(rejected, error) {
        this.#recordRejected = rejected;
        if (rejected) { this.#recordRejection = error; this.#recordRejectionFact = managerLossErrorFact(error); }
        this.#recordPromise = undefined; this.#recordContinuation = undefined; this.#recordPending = false;
        // Settlement never restores eligibility and never invokes the journal again.
    }
    #rejectRecord(error) {
        if (!this.#recordFailed) {
            this.#recordFailed = true; if (!this.#disposed) this.#recordError = error; this.#recordErrorFact = managerLossErrorFact(error);
        }
        this.#revoked = true;
    }
    #record(kind) {
        if (this.#recordFailed || !this.#persist) return false;
        if (this.#recordInFlight) { this.#rejectRecord(Error("Fault journal reentry rejected")); return false; }
        this.#recordInFlight = true; // Before any host callback can dispose or reenter observation.
        try {
            const result = this.#persist(kind, this.snapshot);
            if (result instanceof Promise) {
                this.#recordPending = true; this.#recordPromise = result;
                try { this.#recordContinuation = Promise.prototype.then.call(result,
                    () => this.#settleRecord(false), error => this.#settleRecord(true, error)); }
                catch { this.#recordObserverFailed = true; } // Retain unknown observation; never resume or retry.
            }
            need(result === undefined, "Fault journal must settle synchronously");
            return !this.#recordFailed;
        } catch (error) {
            this.#rejectRecord(error);
            return false;
        } finally { this.#recordInFlight = false; }
    }
    #onError = error => {
        // A bounded observation cannot throw into EventEmitter and prevent VolumeProtocol handling.
        this.#errorCount = Math.min(5, this.#errorCount + 1);
        if (this.#errorCount === 1) { this.#firstChildError = error; this.#firstChildErrorFact = managerLossErrorFact(error); }
        this.#revoked = true;
        if (this.#errorCount <= 4) this.#record("child-error");
    };
    #onClose = (code, signal) => {
        if (this.#closed) return;
        const child = this.#child;
        this.#closed = true; this.#exitCode = code; this.#signal = signal; this.#revoked = true;
        try { this.#record("child-close"); }
        finally {
            child.off("error", this.#onError); child.off("close", this.#onClose);
            this.#listenersAttached = false; this.#child = undefined;
        }
    };
    launch() {
        need(!this.#disposed && !this.#revoked && !this.#recordFailed && !this.#launchAttempted && this.#phase === "new", "Fault launch is one-shot");
        this.#launchAttempted = true; this.#phase = "launching";
        try {
            this.#child = this.#launch(); // Own immediately, before registering callbacks or wrapping.
            const child = this.#child;
            need(child && typeof child.on === "function" && typeof child.off === "function" && typeof child.kill === "function", "Original process object required");
            this.#pid = child.pid ?? null;
            child.on("error", this.#onError); child.on("close", this.#onClose); this.#listenersAttached = true;
            this.#driver = this.#wrap(child, this.#taskId);
            need(this.#driver && this.#driver.pid === this.#pid, "Original driver association");
            this.#phase = "watching"; this.#record("bound"); return this.#driver;
        } catch (error) {
            this.#phase = "launch-failed"; this.#revoked = true; throw error;
        } finally { this.#launch = undefined; this.#wrap = undefined; this.#launchSettled = true; }
    }
    #guard(phase) {
        const b = this.#binding, runtime = b?.runtime.read();
        need(!this.#disposed && !this.#revoked && !this.#recordFailed && this.#phase === phase
            && b && b.task.driver === this.#driver && b.task.vm === b.vm && b.task.volume === b.volume && b.task.runtime === b.runtime
            && b.vm.taskId === this.#taskId && b.vm.id === b.instanceId && b.vm.state === "registered-not-guest-ready"
            && b.vm.registered === true && b.vm.startSettled === true && !b.vm.cleanupPromise && !b.vm.active && !b.vm.execution && !b.vm.connection
            && runtime.owner === b.vm && runtime.taskId === this.#taskId && runtime.instanceId === b.instanceId
            && b.volume.state === "prepared-not-share-admitted" && b.volume.experimentalMappingState === "dispatched"
            && this.#driver.physicallyClosed === false && this.#driver.pending === false && this.#driver.blocked === false
            && this.#driver.pid === this.#pid && Number.isInteger(this.#pid) && this.#pid > 0
            && !b.signal.aborted && !this.#closed && this.#child && this.#child.pid === this.#pid
            && this.#child.exitCode === null && this.#child.signalCode === null && this.#child.killed === false,
        "Manager-loss host binding no longer eligible");
    }
    async verifyAndArm(task, signal) {
        need(!this.#disposed && !this.#armAttempted && this.#phase === "watching" && !this.#revoked, "Fault arm is one-shot");
        this.#armAttempted = true; this.#phase = "verifying";
        try {
            const { vm, volume, runtime } = task;
            need(vm && volume && runtime && typeof runtime.read === "function" && typeof volume.verify === "function"
                && signal && typeof signal.aborted === "boolean" && UUID.test(vm.id), "Original verification objects required");
            this.#binding = Object.freeze({ task, vm, volume, runtime, signal, instanceId: vm.id });
            this.#guard("verifying");
            await volume.verify(); // Only this completed operation can set verified; no caller-supplied boolean.
            this.#guard("verifying");
            this.#verified = true; this.#phase = "armed";
        } catch (error) { this.#revoked = true; if (!this.#disposed) this.#phase = "arm-failed"; throw error; }
    }
    request() {
        need(!this.#disposed && this.#phase === "armed" && this.#verified && !this.#attempts && !this.#revoked,
            "Fault request is unavailable");
        this.#attempts = 1; this.#phase = "attempting"; // Consumed before even the journal callback.
        need(this.#record("attempt"), "Fault attempt journal failed; capability consumed");
        const child = this.#child;
        try {
            this.#guard("attempting");
        } catch (error) { this.#revoked = true; if (!this.#disposed) this.#phase = "rejected"; this.#record("rejected"); throw error; }
        // No await, logging, factory or callback between final guard and original child call.
        try {
            const returned = child.kill("SIGTERM");
            need(typeof returned === "boolean", "Unexpected termination request return");
            this.#requestReturned = returned;
        } catch (error) { this.#requestThrew = true; if (!this.#disposed) this.#requestError = error; this.#requestErrorFact = managerLossErrorFact(error); }
        if (!this.#disposed) this.#phase = "requested"; this.#revoked = true; this.#record("request-result");
        return this.snapshot; // A request result is not physical-close evidence.
    }
    revoke() { this.#revoked = true; }
    dispose() {
        if (this.#disposed) return;
        this.#revoked = true;
        need(!this.#launchAttempted || this.#launchSettled, "Launch responsibility has not returned");
        need(!this.#recordInFlight, "Fault journal callback remains in flight");
        need(!this.#recordPending && !this.#recordObserverFailed, "Fault journal settlement remains unknown");
        need(!this.#attempts || this.#closed, "Requested process closure remains unknown");
        need(!this.#child || this.#driver, "Unwrapped process responsibility remains");
        if (this.#listenersAttached) { this.#child.off("error", this.#onError); this.#child.off("close", this.#onClose); }
        this.#listenersAttached = false; this.#child = undefined; this.#driver = undefined; this.#binding = undefined;
        this.#launch = undefined; this.#wrap = undefined; this.#persist = undefined;
        this.#requestError = undefined; this.#firstChildError = undefined; this.#recordError = undefined;
        this.#recordRejection = undefined; this.#recordPromise = undefined; this.#recordContinuation = undefined;
        this.#disposed = true; this.#phase = "disposed";
    }
}


export function volumeProfileArguments({ candidateCapture = false, capacityProbeSha256, inputSourceSha256, inputToolSha256,
    taskPackageSha256, taskRunnerSha256, taskSnapshotId }) {
	need(typeof candidateCapture === "boolean" && !(candidateCapture && capacityProbeSha256 !== undefined), "Exclusive fixed volume profile required");
    if (taskPackageSha256 !== undefined || taskRunnerSha256 !== undefined || taskSnapshotId !== undefined) {
        need(candidateCapture && capacityProbeSha256 === undefined && inputSourceSha256 === undefined && inputToolSha256 === undefined
            && typeof taskPackageSha256 === "string" && /^[0-9a-f]{64}$/.test(taskPackageSha256)
            && typeof taskRunnerSha256 === "string" && /^[0-9a-f]{64}$/.test(taskRunnerSha256)
            && typeof taskSnapshotId === "string" && UUID.test(taskSnapshotId), "Exclusive task package profile required");
        return ["-CandidateCapture", "-TaskPackageSha256", taskPackageSha256, "-TaskRunnerSha256", taskRunnerSha256, "-TaskSnapshotId", taskSnapshotId];
    }
	if (inputSourceSha256 !== undefined || inputToolSha256 !== undefined) {
		need(candidateCapture && capacityProbeSha256 === undefined && typeof inputSourceSha256 === "string"
			&& /^[0-9a-f]{64}$/.test(inputSourceSha256) && typeof inputToolSha256 === "string"
			&& /^[0-9a-f]{64}$/.test(inputToolSha256), "Fixed input/candidate profile required");
		return ["-CandidateCapture", "-InputSourceSha256", inputSourceSha256, "-InputToolSha256", inputToolSha256];
	}
	if (capacityProbeSha256 !== undefined) {
		need(typeof capacityProbeSha256 === "string" && /^[0-9a-f]{64}$/.test(capacityProbeSha256), "Fixed capacity probe digest required");
		return ["-CapacityProbeSha256", capacityProbeSha256];
	}
	return candidateCapture ? ["-CandidateCapture"] : [];
}
function spawnVolumeHelper({ root, taskId, nativeSha256, capacityProbeSha256, candidateCapture = false, inputSourceSha256, inputToolSha256,
    taskPackageSha256, taskRunnerSha256, taskSnapshotId }) {
	const profileArguments = volumeProfileArguments({ candidateCapture, capacityProbeSha256, inputSourceSha256, inputToolSha256,
        taskPackageSha256, taskRunnerSha256, taskSnapshotId });
	need(process.platform === "win32" && UUID.test(taskId) && /^[0-9a-f]{64}$/.test(nativeSha256), "Fixed Windows helper prerequisites");
	verifyPowerShell7();
	need(typeof root === "string" && root.length <= 180 && /^[A-Za-z]:\\/.test(root) && !/[%\[\]\x00-\x1f]/.test(root)
		&& path.resolve(root) === root && fs.realpathSync(root) === root && !fs.lstatSync(root).isSymbolicLink(), "Private volume root required");
	const assembly = path.join(root, "volume-native.dll"), stat = fs.lstatSync(assembly);
	need(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && stat.size <= VOLUME_LIMITS.nativeBytes, "Native assembly bound");
	need(createHash("sha256").update(fs.readFileSync(assembly)).digest("hex") === nativeSha256, "Native assembly hash mismatch");
	if (capacityProbeSha256 !== undefined) {
		const probe = path.join(root, "capacity-probe.exe"), entry = fs.lstatSync(probe);
		need(entry.isFile() && !entry.isSymbolicLink() && entry.nlink === 1 && entry.size > 0 && entry.size <= 65536 && fs.realpathSync(probe) === probe
			&& createHash("sha256").update(fs.readFileSync(probe)).digest("hex") === capacityProbeSha256, "Capacity probe source changed");
	}
	if (inputSourceSha256 !== undefined) {
		for (const [name, maximum, digest] of [["input-source.bin", 4096, inputSourceSha256], ["offline-worker.exe", 65536, inputToolSha256]]) {
			const file = path.join(root, name), entry = fs.lstatSync(file, { bigint: true });
			need(entry.isFile() && !entry.isSymbolicLink() && entry.nlink === 1n && entry.size > 0n && entry.size <= BigInt(maximum)
				&& fs.realpathSync(file) === file && createHash("sha256").update(fs.readFileSync(file)).digest("hex") === digest,
				"Input installation carrier changed");
		}
	}
    if (taskPackageSha256 !== undefined) {
        // The native installer performs the bounded handle read, digest and
        // identity checks before VM admission; do not create another input FD owner here.
        for (const [name, maximum] of [["task-package.bin", 49168], ["task-runner.exe", 65536]]) {
            const file = path.join(root, name), entry = fs.lstatSync(file, { bigint: true });
            need(entry.isFile() && !entry.isSymbolicLink() && entry.nlink === 1n && entry.size > 0n
                && entry.size <= BigInt(maximum) && fs.realpathSync(file) === file, "Task installation carrier shape changed");
        }
    }
	const helper = fileURLToPath(new URL("./windows-sandbox-volume-helper.ps1", import.meta.url));
	const child = spawn(POWERSHELL7_PATH,
		[...POWERSHELL7_PREFIX, "-File", helper, "-Run", "-TaskId", taskId, "-Root", root, "-NativeSha256", nativeSha256, ...profileArguments],
		{ cwd: root, windowsHide: true, shell: false, stdio: ["pipe", "pipe", "pipe"] });
	return child;
}
export function launchVolumeHelper({ root, taskId, nativeSha256, capacityProbeSha256, candidateCapture = false, inputSourceSha256, inputToolSha256,
    taskPackageSha256, taskRunnerSha256, taskSnapshotId }) {
	return new VolumeProtocol(spawnVolumeHelper({ root, taskId, nativeSha256, capacityProbeSha256, candidateCapture, inputSourceSha256, inputToolSha256,
        taskPackageSha256, taskRunnerSha256, taskSnapshotId }), taskId);
}
// The ordinary launch never creates a fault capability or extra listeners.
export function createManagerLossFactory(options, persist) {
	need(options && Object.keys(options).sort().join(",") === "nativeSha256,root,taskId", "Fixed fault-launch options required");
	const { root, taskId, nativeSha256 } = options;
	need(UUID.test(taskId) && typeof persist === "function", "Explicit host fault factory required");
	return new ManagerLossFactory({ taskId, persist,
		launch: () => spawnVolumeHelper({ root, taskId, nativeSha256 }),
		wrap: (child, id) => new VolumeProtocol(child, id) });
}

// readRuntime/journal/revokeCandidates are host-only callbacks; never decoded from guest data.
export class TaskVolumeOwner {
	#driver; #runtime; #journal; #revoke; #cancel; #taskId; #facts; #baseline; #busy = false; #read = false; #closeUnknown = false;
	#state = "new"; #revoked = false; #unsafe = false; #probeAttempted = false; #guestReadAttempted = false;
	#capacityInstallAttempted = false; #capacityReadAttempted = false; #capacityInstallation;
	#candidateAttempted = false; #candidateLease; #candidateCore; #candidateStage = "none";
	#inputAttempted = false; #inputPublication; #inputVm; #inputInstanceId; #inputMethods; #inputReceipt;
	#inputExecutionAttempted = false; #inputExecutionRenewed = false;
    #taskInput = false; #taskSnapshotId; #taskTimeoutMs;
    #taskResultAttempted = false; #taskResultReader; #taskResultState; #taskResultFinal;
	#mappingAttempted = false; #mappingTicket; #mappingVm; #mappingConfig; #mappingHash; #mappingInstanceId = null; #mappingState = "none";
	constructor({ driver, taskId, readRuntime, journal, revokeCandidates, cancelExecution }) {
		need(UUID.test(taskId) && typeof readRuntime === "function" && typeof journal === "function" && typeof revokeCandidates === "function"
			&& typeof cancelExecution === "function", "Host owner required");
		this.#driver = driver; this.#taskId = taskId; this.#runtime = readRuntime; this.#journal = journal; this.#revoke = revokeCandidates;
		this.#cancel = cancelExecution;
		driver.setUnsafeHandler(this.onUnsafe);
	}
    installCapturedInputOnce(publication, vm) {
        return this.#installInput(publication, vm, false);
    }
    installTaskInputsOnce(publication, vm) {
        return this.#installInput(publication, vm, true);
    }
    async #installInput(publication, vm, taskProfile) {
        const runtime = this.#runtime();
        need(!this.#inputAttempted && !this.#mappingAttempted && this.#mappingHealthy()
            && vm instanceof SandboxLifecycle && vm.taskId === this.#taskId && runtime?.owner === vm
            && runtime.taskId === this.#taskId && runtime.instanceId === vm.id
            && runtime.state === "not-started" && runtime.neverDispatched && runtime.callsClosed && !vm.cleanupPromise,
            "Input installation requires one original never-dispatched VM");
        this.#inputAttempted = true; this.#read = true;
        try {
            this.#save();
            // Only the explicit input profile loads source/capture modules. Legacy
            // volume imports keep their existing graph and never bind native input.
            let prototype;
            if (taskProfile) {
                const { TaskInputPublication } = await import("./windows-sandbox-task-publication.mjs");
                prototype = TaskInputPublication.prototype;
            } else {
                const { CapturedInputPublication } = await import("./windows-sandbox-input-publication.mjs");
                prototype = CapturedInputPublication.prototype;
            }
            const declaration = Object.getOwnPropertyDescriptor(prototype, "declaration").get.call(publication);
            need(declaration.taskId === this.#taskId, "Input publication task mismatch");
            if (taskProfile) {
                keys(declaration, "package,protocol,snapshotId,taskId,timeoutMs,tool");
                need(declaration.protocol === "super-pi-task-publication-v1" && UUID.test(declaration.snapshotId)
                    && Number.isInteger(declaration.timeoutMs) && declaration.timeoutMs > 0 && declaration.timeoutMs <= 30000,
                    "Original task publication declaration");
                this.#taskInput = true; this.#taskSnapshotId = declaration.snapshotId; this.#taskTimeoutMs = declaration.timeoutMs;
            }
            this.#inputPublication = publication; this.#inputVm = vm; this.#inputInstanceId = vm.id;
            this.#inputMethods = Object.freeze({ renew: prototype.renew, current: prototype.assertCurrent,
                read: prototype.readInstallation, revoke: prototype.revoke,
                diagnostics: Object.getOwnPropertyDescriptor(prototype, "diagnostics").get });
            await this.#inputMethods.renew.call(publication, "install");
            const current = this.#runtime();
            need(!this.#revoked && !this.#unsafe && this.#read && !this.#busy && !this.#closeUnknown
                && this.#state === "prepared-not-share-admitted" && current.owner === vm && current.instanceId === vm.id
                && current.state === "not-started" && current.neverDispatched && current.callsClosed && !vm.cleanupPromise
                && !this.#mappingAttempted, "Input runtime changed before installation");
            this.#inputMethods.current.call(publication);
            const result = await this.#call(taskProfile ? "install-task" : "install-input");
            for (const key of ["imageId", "diskId", "physicalPath", "volumePath", "exchangeId"])
                need(result[key] === this.#baseline[key], "Input volume identity changed");
            need(result.error === null && result.phase === "prepared-not-share-admitted" && !result.closeUnknown
                && !result.managementClosed && !result.detached && !this.#revoked && !this.#unsafe, "Input installation failed");
            this.#inputMethods.current.call(publication);
            this.#inputReceipt = this.#inputMethods.read.call(publication, {
                taskId: this.#taskId, volumePath: this.#baseline.volumePath, exchangeId: this.#baseline.exchangeId });
            const after = this.#runtime();
            need(after.owner === vm && after.instanceId === this.#inputInstanceId && after.state === "not-started"
                && after.neverDispatched && after.callsClosed && !vm.cleanupPromise && !this.#revoked && !this.#unsafe,
                "Input runtime changed after installation");
            return this.#inputReceipt;
        } catch (error) {
            this.#state = "blocked"; this.#inputMethods?.revoke.call(this.#inputPublication); throw error;
        } finally {
            const d = this.#inputMethods?.diagnostics.call(this.#inputPublication);
            if (!this.#driver.pending && !d?.pending && !d?.retainedFd && !this.#closeUnknown) this.#read = false;
            else { this.#closeUnknown = true; this.onUnsafe(); } // Keep exact publication/descriptor/physical command owner.
            this.#save();
        }
    }
    #inputCurrent(vm) {
        if (!this.#inputAttempted) return true;
        const runtime = this.#runtime();
        need(this.#inputPublication && this.#inputReceipt && this.#inputVm === vm && vm.id === this.#inputInstanceId
            && vm.taskId === this.#taskId && runtime.owner === vm && runtime.instanceId === this.#inputInstanceId
            && runtime.taskId === this.#taskId, "Original input/VM binding changed");
        return this.#inputMethods.current.call(this.#inputPublication);
    }
    async renewInputExecution(vm) {
        need(this.#inputAttempted && !this.#inputExecutionAttempted && this.#mappingHealthy() && this.#mappingState === "dispatched"
            && vm === this.#inputVm && vm.state === "registered-not-guest-ready" && vm.registered && vm.startSettled
            && !vm.cleanupPromise && !vm.active && !vm.execution && !vm.connection, "One registered input execution required");
        this.#inputExecutionAttempted = true;
        this.#inputCurrent(vm); await this.verify();
        await this.#inputMethods.renew.call(this.#inputPublication, "execute");
        need(this.#mappingHealthy() && this.#mappingState === "dispatched" && !vm.cleanupPromise
            && !vm.active && !vm.execution && !vm.connection, "Input execution revoked while renewing");
        this.#inputCurrent(vm); this.#inputExecutionRenewed = true;
    }
    assertInputExecution(vm) {
        need(this.#inputExecutionRenewed && this.#mappingHealthy() && this.#mappingState === "dispatched",
            "Input execution renewal unavailable");
        return this.#inputCurrent(vm);
    }
    get inputInstallation() { return this.#inputReceipt; } // Frozen observed data, not an authorization.
    get inputReferencesHeld() { return !!this.#inputPublication || !!this.#inputVm || !!this.#inputMethods; }
    get taskResultDiagnostics() {
        return { attempted: this.#taskResultAttempted, readerHeld: !!this.#taskResultReader,
            reader: this.#taskResultReader && this.#taskResultState ? this.#taskResultState.call(this.#taskResultReader) : this.#taskResultFinal };
    }
    async readTaskResultOnce(reader, vm, snapshotId) {
        const runtime = this.#runtime();
        need(this.#taskInput && snapshotId === this.#taskSnapshotId && this.#inputExecutionRenewed
            && !this.#taskResultAttempted && !this.#read && !this.#busy && !this.#unsafe && !this.#revoked && !this.#closeUnknown
            && this.#state === "prepared-not-share-admitted" && this.#mappingState === "dispatched"
            && runtime?.state === "closed" && runtime.instanceAbsent === true && runtime.callsClosed === true
            && vm instanceof SandboxLifecycle && runtime.owner === vm && runtime.taskId === this.#taskId
            && runtime.instanceId === this.#mappingInstanceId && vm.id === this.#mappingInstanceId
            && this.#driver.physicallyClosed === false && this.#driver.pending === false, "Task result requires the completed original VM");
        this.#taskResultAttempted = true; this.#taskResultReader = reader; this.#read = true;
        const baseline = this.#baseline;
        try {
            const { TaskResultReader } = await import("./windows-sandbox-task-result.mjs");
            const originalState = Object.getOwnPropertyDescriptor(TaskResultReader.prototype, "diagnostics").get;
            need(TaskResultReader.prototype.matches.call(reader, this, vm, this.#taskId, snapshotId,
                baseline.volumePath, baseline.exchangeId, this.#taskTimeoutMs), "Original task result reader association");
            const initial = originalState.call(reader); // Establish original private brand before retaining its getter.
            this.#taskResultState = originalState;
            need(!initial.attempted && !initial.pending && !initial.retainedFd && !initial.closeUnknown, "Unused task result reader required");
            const validate = () => {
                this.#inputCurrent(vm);
                const current = this.#runtime();
                need(this.#read && this.#taskResultReader === reader && this.#baseline === baseline
                    && !this.#busy && !this.#unsafe && !this.#revoked && !this.#closeUnknown
                    && this.#state === "prepared-not-share-admitted" && this.#mappingState === "dispatched"
                    && this.#driver.pending === false && this.#driver.physicallyClosed === false
                    && current.owner === vm && current.state === "closed" && current.instanceAbsent === true && current.callsClosed === true
                    && current.taskId === this.#taskId && current.instanceId === this.#mappingInstanceId && vm.id === this.#mappingInstanceId
                    && snapshotId === this.#taskSnapshotId, "Task result original lifetime changed");
            };
            validate(); this.#save(); validate();
            const reply = await this.#call("read-task-result");
            for (const key of ["imageId", "diskId", "physicalPath", "volumePath", "exchangeId"])
                if (reply[key] !== baseline[key]) { this.onUnsafe(); throw new Error("Task result volume binding changed"); }
            if (reply.closeUnknown || reply.managementClosed || reply.detached || reply.error === "storage-identity-failed") this.onUnsafe();
            need(reply.error === null && reply.phase === "prepared-not-share-admitted", "Task result native capture failed");
            validate();
            const value = TaskResultReader.prototype.read.call(reader, validate);
            validate(); return value;
        } catch (error) { this.#state = "blocked"; throw error; }
        finally {
            const state = this.#taskResultState?.call(reader);
            if (state) this.#taskResultFinal = state;
            if (!this.#driver.pending && !state?.pending && !state?.retainedFd && !state?.closeUnknown && !this.#closeUnknown) {
                this.#read = false; this.#taskResultReader = undefined; this.#taskResultState = undefined;
            } else { this.#closeUnknown = true; this.onUnsafe(); }
            this.#save();
        }
    }
    #clearInput() {
        this.#inputPublication = undefined; this.#inputVm = undefined; this.#inputMethods = undefined;
        this.#inputReceipt = undefined; this.#inputInstanceId = undefined;
        this.#taskInput = false; this.#taskSnapshotId = undefined; this.#taskTimeoutMs = undefined;
    }
	get state() { return this.#state; }
	get shareAdmission() { return false; } // Cannot be enabled by a caller-supplied boolean or fake ready reply.
	get experimentalShareAdmission() {
		return this.#mappingState === "issued" && this.#mappingHealthy() && this.#mappingRuntime(this.#mappingVm) && this.#mappingConfiguration(this.#mappingVm);
	}
	get experimentalMappingState() { return this.#mappingState; }
	get experimentalMappingReferencesHeld() { return this.#mappingTicket !== undefined || this.#mappingVm !== undefined || this.#mappingConfig !== undefined; }
	get facts() { return this.#facts; }
	#mappingHealthy() {
		return this.#state === "prepared-not-share-admitted" && !this.#busy && !this.#unsafe && !this.#revoked && !this.#read
			&& !this.#closeUnknown && this.#driver.physicallyClosed === false && this.#driver.pending === false;
	}
	#mappingRuntime(vm) {
		const runtime = this.#runtime();
		return vm !== undefined && runtime?.owner === vm && runtime.taskId === this.#taskId && runtime.instanceId === vm.id
			&& vm.id === this.#mappingInstanceId && !vm.cleanupPromise && runtime.state === "not-started" && runtime.neverDispatched === true && runtime.callsClosed === true;
	}
	#clearMapping(state) { this.#mappingTicket = undefined; this.#mappingVm = undefined; this.#mappingConfig = undefined; this.#mappingHash = undefined; this.#mappingState = state; }
	#failMapping() {
		this.#inputMethods?.revoke.call(this.#inputPublication);
		this.#clearMapping("revoked");
		if (!this.#revoked) { this.#revoked = true; try { this.#revoke(); } catch {} try { this.#cancel(); } catch {} }
		try { this.#save(); } catch {}
	}
	#mappingConfiguration(vm) {
		return vm.config === this.#mappingConfig && vm.configSha256 === this.#mappingHash && vm.taskId === this.#taskId && vm.id === this.#mappingInstanceId;
	}
	experimentalMappingPreview() {
		need(this.#mappingHealthy() && this.#baseline, "Mapping preview requires a healthy prepared volume");
		need(this.#baseline.volumePath.length === 49 && /^\\\\\?\\Volume\{[0-9a-fA-F]{8}-(?:[0-9a-fA-F]{4}-){3}[0-9a-fA-F]{12}\}\\$/.test(this.#baseline.volumePath), "Canonical volume GUID required");
		return Object.freeze({ taskId: this.#taskId, imageId: this.#baseline.imageId, diskId: this.#baseline.diskId,
			volumePath: this.#baseline.volumePath, exchangeId: this.#baseline.exchangeId, hostFolder: this.#baseline.volumePath + "exchange" });
	}
	async issueExperimentalMapping(vm) {
		need(!this.#mappingAttempted && vm instanceof SandboxLifecycle && vm.taskId === this.#taskId, "One concrete experimental VM owner required");
		this.#mappingInstanceId = vm.id;
		need(this.#mappingHealthy() && this.#mappingRuntime(vm), "Experimental VM must be bound and never dispatched");
		this.#mappingAttempted = true;
		try {
			this.#mappingConfig = singleGuidVolumeConfig(this.#baseline.volumePath);
			this.#mappingHash = createHash("sha256").update(this.#mappingConfig).digest("hex");
			need(this.#mappingConfiguration(vm), "VM configuration is not the sole bound GUID mapping");
			await this.verify(); this.experimentalMappingPreview();
			this.#inputCurrent(vm);
			need(this.#mappingHealthy() && this.#mappingRuntime(vm) && this.#mappingConfiguration(vm), "Mapping issuance changed while verifying");
			this.#mappingVm = vm; this.#mappingTicket = Object.freeze({}); this.#mappingState = "issued"; this.#save();
			return this.#mappingTicket;
		} catch (error) { this.#failMapping(); throw error; }
	}
	#validateExperimentalDispatch = vm => {
		const runtime = this.#runtime();
		need(this.#mappingTicket !== undefined && this.#mappingVm === vm && this.#mappingState === "dispatch-checked"
			&& this.#mappingHealthy() && this.#mappingConfiguration(vm) && !vm.cleanupPromise && vm.state === "starting"
			&& !vm.active && !vm.execution && !vm.connection && runtime?.owner === vm
			&& runtime.taskId === this.#taskId && runtime.instanceId === this.#mappingInstanceId,
			"Mapping revoked or released before physical dispatch");
		this.#inputCurrent(vm);
		return true;
	};
	#beforeExperimentalDispatch = async vm => {
		const ticket = this.#mappingTicket;
		need(ticket !== undefined && this.#mappingState === "consumed" && this.#mappingVm === vm, "Mapping ticket is not pending for this VM");
		await this.verify();
		if (this.#inputAttempted) await this.#inputMethods.renew.call(this.#inputPublication, "dispatch");
		need(this.#mappingTicket === ticket && this.#mappingVm === vm && this.#mappingState === "consumed"
			&& this.#mappingHealthy() && this.#mappingRuntime(vm) && this.#mappingConfiguration(vm), "Mapping revoked or runtime changed before dispatch");
		this.#mappingState = "dispatch-checked"; this.#save();
		need(this.#mappingHealthy() && this.#mappingRuntime(vm) && this.#mappingConfiguration(vm), "Mapping changed during host journal");
		this.#inputCurrent(vm);
		return Object.freeze({ instanceId: this.#mappingInstanceId, config: this.#mappingConfig, configSha256: this.#mappingHash,
			validate: this.#validateExperimentalDispatch });
	};
	async startExperimentalMapping(ticket, vm, signal) {
		need(ticket !== undefined && ticket === this.#mappingTicket && vm === this.#mappingVm && this.#mappingState === "issued", "Invalid, consumed or revoked mapping ticket");
		this.#mappingState = "consumed"; // A failed preflight/dispatch must never make this token reusable.
		try {
			need(this.#mappingHealthy() && this.#mappingRuntime(vm) && this.#mappingConfiguration(vm), "Mapping changed before start attempt");
			this.#save();
			const id = await SandboxLifecycle.prototype.start.call(vm, signal, this.#beforeExperimentalDispatch);
			need(!this.#unsafe && !this.#revoked && this.#mappingState === "dispatch-checked", "Mapping was revoked while starting");
			this.#clearMapping("dispatched"); this.#save(); return id;
		} catch (error) {
			this.#failMapping();
			throw error;
		}
	}
	#writeJournal() {
		const record = { taskId: this.#taskId, state: this.#state, helperPid: this.#driver.pid, helperClosed: this.#driver.physicallyClosed,
			pending: this.#driver.pending, reading: this.#read, probeAttempted: this.#probeAttempted, guestReadAttempted: this.#guestReadAttempted,
			capacityInstallAttempted: this.#capacityInstallAttempted, capacityReadAttempted: this.#capacityReadAttempted,
			candidateAttempted: this.#candidateAttempted, candidateStage: this.#candidateStage, candidateLeaseHeld: this.#candidateLease !== undefined,
			closeUnknown: this.#closeUnknown, revoked: this.#revoked, experimentalMappingState: this.#mappingState,
			experimentalInstanceId: this.#mappingInstanceId, facts: this.#facts ?? null, transport: this.#driver.diagnostics ?? null };
		need(Buffer.byteLength(JSON.stringify(record)) <= VOLUME_LIMITS.journalBytes, "Owner journal bound"); this.#journal(record);
	}
	#save() {
		try { this.#writeJournal(); } catch (error) { this.#block(); throw error; }
	}
	#block() {
		this.#candidateCore?.revoke();
		this.#inputMethods?.revoke.call(this.#inputPublication);
		const first = !this.#unsafe;
		this.#unsafe = true; this.#state = "blocked"; this.#revoked = true;
		this.#clearMapping(this.#mappingAttempted ? "revoked" : "none");
		if (first) { try { this.#revoke(); } catch {} try { this.#cancel(); } catch {} }
	}
	onUnsafe = () => {
		this.#block();
		try { this.#writeJournal(); } catch {} // No recursive save/recovery on journal failure.
	};
	#quiescent() {
		const runtime = this.#runtime();
		return runtime && runtime.callsClosed === true && (runtime.state === "closed" && runtime.instanceAbsent === true
			|| runtime.state === "not-started" && runtime.neverDispatched === true);
	}
	#observe = reply => {
		this.#facts = reply;
		if (reply.closeUnknown) this.#closeUnknown = true;
		this.#save();
	};
	async #call(command) {
		need(!this.#busy && !this.#unsafe, "Volume operation busy or unsafe"); this.#busy = true;
		try { return await this.#driver.command(command, this.#observe); }
		finally { this.#busy = false; }
	}
	async prepare() {
		need(this.#state === "new" && this.#quiescent() && !this.#revoked, "Volume prepare admission");
		this.#state = "preparing";
		try {
			this.#save(); const result = await this.#call("prepare");
			need(!this.#revoked && !this.#unsafe && result.error === null && result.phase === "prepared-not-share-admitted" && result.imageCreated
				&& !result.closeUnknown && !result.managementClosed && !result.detached && typeof result.physicalPath === "string"
				&& FILE_ID.test(result.imageId) && FILE_ID.test(result.exchangeId) && VOLUME.test(result.volumePath), "Volume preparation not confirmed");
			this.#baseline = result; this.#state = "prepared-not-share-admitted"; this.#save(); return result;
		} catch (error) { this.#state = "blocked"; try { this.#save(); } catch {} throw error; }
	}
	async verify() {
		need(this.#state === "prepared-not-share-admitted" && !this.#revoked && !this.#read, "Volume verification admission");
		try {
			const result = await this.#call("verify");
			for (const key of ["imageId", "diskId", "physicalPath", "volumePath", "exchangeId"]) need(result[key] === this.#baseline[key], "Volume identity changed");
			need(result.error === null && result.phase === "prepared-not-share-admitted" && !result.closeUnknown
				&& !result.managementClosed && !result.detached && !this.#revoked && !this.#unsafe, "Volume verification failed");
			return result;
		} catch (error) { this.onUnsafe(); throw error; }
	}
	beginCandidateRead() {
		need(!this.#candidateLease, "Explicit candidate lease already owns the read");
		need(!this.#busy && !this.#unsafe && !this.#revoked && !this.#read && !this.#closeUnknown
			&& this.#state === "prepared-not-share-admitted" && this.#quiescent(), "Candidate read admission");
		this.#read = true; this.#save();
	}
	async probeOnce() {
		need(!this.#probeAttempted && !this.#busy && !this.#unsafe && !this.#revoked && !this.#read && !this.#closeUnknown
			&& this.#state === "prepared-not-share-admitted" && this.#quiescent(), "Native probe admission");
		this.#probeAttempted = true;
		try {
			this.#save(); // Persist one-shot admission before sending the command.
			const result = await this.#call("probe");
			for (const key of ["imageId", "diskId", "physicalPath", "volumePath", "exchangeId"]) {
				if (result[key] !== this.#baseline[key]) { this.onUnsafe(); throw new Error("Probe volume identity changed"); }
			}
			if (result.closeUnknown || result.managementClosed || result.detached || result.error === "storage-identity-failed") this.onUnsafe();
			need(!this.#unsafe && !this.#revoked && result.error === null && result.phase === "prepared-not-share-admitted", "Native probe failed");
			return result;
		} catch (error) { this.#state = "blocked"; try { this.#save(); } catch {} throw error; }
	}
	async readGuestOnce(readReceipt) {
		const runtime = this.#runtime();
		need(!this.#guestReadAttempted && typeof readReceipt === "function" && !this.#busy && !this.#unsafe && !this.#revoked
			&& !this.#read && !this.#closeUnknown && this.#state === "prepared-not-share-admitted" && this.#mappingState === "dispatched"
			&& runtime?.state === "closed" && runtime.instanceAbsent === true && runtime.callsClosed === true
			&& runtime.owner instanceof SandboxLifecycle && runtime.taskId === this.#taskId
			&& runtime.instanceId === this.#mappingInstanceId, "Guest read requires completed bound VM");
		this.#guestReadAttempted = true; this.#read = true;
		try {
			this.#save();
			need(!this.#revoked && !this.#unsafe && this.#runtime() === runtime, "Guest read admission changed during journal");
			const result = await this.#call("read-guest");
			let receipt;
			try {
				receipt = validateGuestReadReceipt(readReceipt(), this.#taskId, this.#baseline);
				for (const key of ["imageId", "diskId", "physicalPath", "volumePath", "exchangeId"])
					need(result[key] === this.#baseline[key], "Guest read volume identity changed");
				need(this.#runtime() === runtime, "Guest read runtime binding lost");
			} catch (error) { this.onUnsafe(); throw error; }
			this.#closeUnknown ||= result.closeUnknown || receipt.closeUnknown;
			if (this.#closeUnknown || result.managementClosed || result.detached || result.error === "storage-identity-failed") this.onUnsafe();
			need(!this.#unsafe && !this.#revoked && result.error === null && result.phase === "prepared-not-share-admitted" && receipt.matched,
				"Guest read failed or close unknown");
			return receipt;
		} catch (error) { this.#state = "blocked"; throw error; }
		finally { this.#read = false; this.#save(); }
	}
	async #capacityCommand(stage, readReceipt, probeSha256) {
		const runtime = this.#runtime(), install = stage === "install";
		need(typeof readReceipt === "function" && typeof probeSha256 === "string" && /^[0-9a-f]{64}$/.test(probeSha256)
			&& !this.#busy && !this.#unsafe && !this.#revoked && !this.#read && !this.#closeUnknown
			&& this.#state === "prepared-not-share-admitted" && this.#quiescent(), "Capacity operation admission");
		if (install) {
			need(!this.#capacityInstallAttempted && !this.#mappingAttempted && runtime.state === "not-started" && runtime.neverDispatched === true
				&& runtime.owner === null && runtime.taskId === this.#taskId, "Capacity install requires no dispatched VM"); this.#capacityInstallAttempted = true;
		} else {
			need(!this.#capacityReadAttempted && this.#capacityInstallation?.installed === true && this.#mappingState === "dispatched"
				&& runtime.state === "closed" && runtime.instanceAbsent === true && runtime.callsClosed === true
				&& runtime.owner instanceof SandboxLifecycle && runtime.taskId === this.#taskId
				&& runtime.instanceId === this.#mappingInstanceId, "Capacity read requires completed bound VM"); this.#capacityReadAttempted = true;
		}
		this.#read = true;
		try {
			this.#save(); need(!this.#revoked && !this.#unsafe && this.#runtime() === runtime, "Capacity admission changed during journal");
			const result = await this.#call(install ? "install-capacity" : "read-capacity"); let receipt;
			try {
				receipt = validateCapacityReceipt(readReceipt(), stage, this.#taskId, this.#baseline, probeSha256, this.#capacityInstallation);
				for (const key of ["imageId", "diskId", "physicalPath", "volumePath", "exchangeId"]) need(result[key] === this.#baseline[key], "Capacity volume identity changed");
				need(this.#runtime() === runtime, "Capacity runtime binding changed");
			} catch (error) { this.onUnsafe(); throw error; }
			this.#closeUnknown ||= result.closeUnknown || receipt.closeUnknown;
			if (this.#closeUnknown || result.managementClosed || result.detached || result.error === "storage-identity-failed") this.onUnsafe();
			need(!this.#unsafe && !this.#revoked && result.error === null && result.phase === "prepared-not-share-admitted"
				&& (install ? receipt.installed : receipt.readCompleted), "Capacity operation failed or close unknown");
			if (install) this.#capacityInstallation = receipt;
			return receipt;
		} catch (error) { this.#state = "blocked"; throw error; }
		finally { this.#read = false; this.#save(); }
	}
	installCapacityOnce(readReceipt, probeSha256) { return this.#capacityCommand("install", readReceipt, probeSha256); }
	readCapacityOnce(readReceipt, probeSha256) { return this.#capacityCommand("read", readReceipt, probeSha256); }
	#checkCapture(lease) {
		need(this.#candidateLease === lease && this.#read && !this.#busy && !this.#unsafe && !this.#revoked && !this.#closeUnknown
			&& this.#state === "prepared-not-share-admitted" && this.#mappingState === "dispatched"
			&& this.#driver.physicallyClosed === false && this.#driver.pending === false
			&& this.#candidateCore === lease.core && !["revoked", "disposed", "rejected"].includes(lease.core.status)
			&& this.#runtime() === lease.runtime && lease.runtime.owner === lease.vm && lease.vm.taskId === this.#taskId
			&& lease.vm.id === this.#mappingInstanceId, "Candidate lease changed or revoked");
	}
	#validateCandidateIo = ticket => {
		const lease = this.#candidateLease;
		need(lease && lease.ticket === ticket && lease.admitted && lease.ioActive, "Candidate IO ticket inactive");
		this.#checkCapture(lease); return true;
	};
	#admitCandidateIo = ticket => {
		const lease = this.#candidateLease;
		need(lease && lease.ticket === ticket && !lease.admitted && lease.ioActive, "Candidate IO ticket already consumed or foreign");
		this.#checkCapture(lease); lease.admitted = true; return true;
	};
	#captureSnapshot(lease) {
		lease.snapshotAttempted = true; lease.snapshotValid = false;
		try {
		const value = lease.channel.snapshot.call(lease.channel.receiver);
		keys(value, "activeHandles,closed,opened,peak,pending,uncertainHandles");
		for (const key of ["opened", "closed", "peak", "activeHandles"])
			need(Number.isSafeInteger(value[key]) && value[key] >= 0, "Candidate channel counter");
		need(value.opened <= 16 && value.closed <= value.opened && value.activeHandles === value.opened - value.closed
			&& value.peak <= 4 && value.peak <= value.opened && value.activeHandles <= value.peak && typeof value.pending === "boolean"
			&& (value.opened === 0 || value.peak >= 1)
			&& Array.isArray(value.uncertainHandles) && value.uncertainHandles.length <= value.activeHandles, "Candidate channel budget");
		const retained = [];
		for (const item of value.uncertainHandles) {
			keys(item, "handle,slot");
			need(Number.isInteger(item.slot) && item.slot >= 0 && item.slot < 4 && typeof item.handle === "string"
				&& /^[0-9A-F]{1,16}$/.test(item.handle) && !retained.some(previous => previous.slot === item.slot || previous.handle === item.handle),
				"Candidate channel retained slot");
			retained.push(Object.freeze({ slot: item.slot, handle: item.handle }));
		}
		const previous = lease.snapshot;
		need(!previous || value.opened >= previous.opened && value.closed >= previous.closed && value.peak >= previous.peak,
			"Candidate channel counters regressed");
		const fixed = Object.freeze({ opened: value.opened, closed: value.closed, peak: value.peak, activeHandles: value.activeHandles,
			pending: value.pending, uncertainHandles: Object.freeze(retained) });
		lease.snapshot = fixed;
		lease.snapshotStage = lease.stage; lease.snapshotValid = true; lease.snapshotFailure = undefined; lease.snapshotFailureSet = false;
		lease.ioClosed = !fixed.pending && fixed.activeHandles === 0 && fixed.uncertainHandles.length === 0;
		if (!lease.ioClosed) this.#closeUnknown = true;
		return fixed;
		} catch (error) { lease.snapshotFailure = error; lease.snapshotFailureSet = true; throw error; }
	}
	#clearCaptureResult(lease) {
		if (!lease.physicalSettled) return; // A logical error never permits changing borrowed bytes.
		const value = lease.value;
		if (value && typeof value === "object") {
			if (Buffer.isBuffer(value.bytes)) value.bytes.fill(0);
			if (Buffer.isBuffer(value.receipt)) value.receipt.fill(0);
		}
		lease.request?.fill(0); lease.request = undefined; lease.value = undefined;
	}
	async #candidateIo(lease, stage) {
		lease.stage = stage; this.#candidateStage = stage; lease.ioActive = true; lease.admitted = false;
		lease.adapterInvoked = false; lease.snapshotAttempted = false; lease.snapshotValid = false;
		lease.ticket = Object.freeze({ stage, taskId: this.#taskId, instanceId: this.#mappingInstanceId,
			volumePath: this.#baseline.volumePath, exchangeId: this.#baseline.exchangeId,
			maximumBytes: stage === "readBatch" ? 16384 : 4096, receiptBytes: 4096 });
		try {
			this.#save(); this.#checkCapture(lease);
			// Register responsibility before calling a host adapter, including synchronous failure.
			lease.physicalSettled = false; lease.ioClosed = false;
			lease.adapterInvoked = true;
			const operation = lease.channel[stage].call(lease.channel.receiver, lease.ticket,
				this.#admitCandidateIo, this.#validateCandidateIo, lease.request);
			lease.operation = operation;
			const descriptors = operation && typeof operation === "object" ? Object.getOwnPropertyDescriptors(operation) : {};
			const outcome = descriptors.outcome?.value, settled = descriptors.settled?.value;
			// Observe even rejected promises on a malformed returned operation before rejecting its schema.
			lease.outcomeWait = Promise.allSettled([operation instanceof Promise ? operation : outcome instanceof Promise ? outcome : undefined,
				settled instanceof Promise ? settled : undefined]);
			keys(operation, "outcome,settled");
			need(outcome instanceof Promise && settled instanceof Promise, "Candidate operation promises required");
			// Install both rejection handlers immediately, even if one outcome is already rejected.
			const outcomes = await lease.outcomeWait;
			lease.outcomes = outcomes;
			if (outcomes[0].status === "fulfilled") lease.value = outcomes[0].value;
			lease.physicalSettled = outcomes[1].status === "fulfilled";
			need(lease.physicalSettled, "Candidate physical settlement unknown");
			this.#captureSnapshot(lease);
			need(lease.ioClosed, "Candidate channel close unknown");
			if (outcomes[0].status === "rejected") throw outcomes[0].reason;
			this.#checkCapture(lease);
			need(lease.admitted, "Candidate adapter omitted stage admission");
			const result = lease.value;
			if (stage === "writeRequest") {
				keys(result, "bytes,sha256");
				need(result.bytes === lease.request.length && result.sha256 === createHash("sha256").update(lease.request).digest("hex"),
					"Candidate request write not confirmed");
			} else {
				keys(result, "bytes,carrierId,receipt");
				need(Buffer.isBuffer(result.bytes) && Buffer.isBuffer(result.receipt), "Candidate carrier buffers required");
				if (stage === "readManifest") lease.core.acceptManifest(result.bytes, result.receipt, result.carrierId);
				else lease.core.acceptBatch(result.bytes, result.receipt, result.carrierId);
			}
			this.#checkCapture(lease);
		} finally {
			lease.ioActive = false; lease.ticket = undefined;
			// Observe current responsibility on exceptional paths; observation never proves physical settlement.
			if (lease.adapterInvoked && !lease.snapshotAttempted) {
				try { this.#captureSnapshot(lease); } catch {} // Preserve the operation error separately from snapshot failure.
			}
			this.#clearCaptureResult(lease);
			if (lease.physicalSettled && lease.ioClosed) { lease.operation = undefined; lease.outcomes = undefined; lease.outcomeWait = undefined; }
		}
	}
	async #candidateCommand(lease, command) {
		this.#candidateStage = command; this.#save(); this.#checkCapture(lease);
		// The existing driver writes synchronously; no host callback or await occurs before its pipe write.
		const result = await this.#call(command);
		for (const key of ["imageId", "diskId", "physicalPath", "volumePath", "exchangeId"])
			if (result[key] !== this.#baseline[key]) { this.onUnsafe(); throw Error("Candidate volume binding changed"); }
		if (result.closeUnknown || result.managementClosed || result.detached || result.error === "storage-identity-failed") this.onUnsafe();
		need(result.error === null && result.phase === "prepared-not-share-admitted", "Candidate helper capture failed");
		this.#checkCapture(lease);
	}
	get candidateDiagnostics() {
		const lease = this.#candidateLease;
		return Object.freeze({ attempted: this.#candidateAttempted, stage: this.#candidateStage, leaseHeld: lease !== undefined,
			channelHeld: lease?.channel !== undefined, vmHeld: lease?.vm !== undefined, operationHeld: lease?.operation !== undefined,
			requestBytes: lease?.request?.length ?? 0, snapshot: lease?.snapshot ?? null,
			snapshotStage: lease?.snapshotStage ?? null, snapshotCurrent: lease?.snapshotValid === true && lease.snapshotStage === lease.stage,
			snapshotFailed: lease?.snapshotFailureSet === true, physicalSettled: lease?.physicalSettled ?? true,
			candidateHeld: this.#candidateCore !== undefined, candidate: this.#candidateCore?.diagnostics ?? null });
	}
	async readCandidatesOnce(authority, channel) {
		const runtime = this.#runtime();
		need(!this.#candidateAttempted && !this.#candidateLease && !this.#read && !this.#busy && !this.#unsafe && !this.#revoked
			&& !this.#closeUnknown && this.#state === "prepared-not-share-admitted" && this.#mappingState === "dispatched"
			&& runtime?.state === "closed" && runtime.instanceAbsent === true && runtime.callsClosed === true
			&& runtime.owner instanceof SandboxLifecycle && runtime.taskId === this.#taskId
			&& runtime.instanceId === this.#mappingInstanceId && runtime.owner.id === this.#mappingInstanceId
			&& this.#driver.physicallyClosed === false && this.#driver.pending === false, "Candidate capture requires completed bound VM");
		need(authority?.taskId === this.#taskId && authority.instanceId === this.#mappingInstanceId
			&& authority.volumePath === this.#baseline.volumePath && authority.exchangeId === this.#baseline.exchangeId,
			"Candidate authority binding");
		keys(channel, "owner,readBatch,readManifest,snapshot,vm,writeRequest");
		need(channel.owner === this && channel.vm === runtime.owner && ["readManifest", "writeRequest", "readBatch", "snapshot"]
			.every(name => typeof channel[name] === "function"), "Candidate channel owner binding");
		this.#candidateAttempted = true; this.#read = true; this.#candidateStage = "admitting";
		const lease = { runtime, vm: runtime.owner, core: undefined, channel: { receiver: channel, readManifest: channel.readManifest,
			writeRequest: channel.writeRequest, readBatch: channel.readBatch, snapshot: channel.snapshot }, snapshot: undefined,
			stage: "admitting", ticket: undefined, admitted: false, ioActive: false, adapterInvoked: false,
			snapshotAttempted: false, snapshotValid: false, snapshotStage: undefined, snapshotFailure: undefined, snapshotFailureSet: false,
			operation: undefined, outcomes: undefined, outcomeWait: undefined,
			value: undefined, request: undefined, physicalSettled: true, ioClosed: false };
		this.#candidateLease = lease;
		let failed = false, failure, candidate;
		try {
			this.#captureSnapshot(lease);
			need(lease.ioClosed && lease.snapshot.opened === 0, "Candidate channel must be fresh");
			this.#candidateCore = lease.core = new CapturedCandidateOwner({ ...authority, taskId: this.#taskId,
				instanceId: this.#mappingInstanceId, volumePath: this.#baseline.volumePath, exchangeId: this.#baseline.exchangeId });
			this.#save(); this.#checkCapture(lease);
			await this.#candidateCommand(lease, "read-candidate-manifest");
			await this.#candidateIo(lease, "readManifest");
			lease.request = lease.core.copyRequestBytes();
			await this.#candidateIo(lease, "writeRequest");
			await this.#candidateCommand(lease, "read-candidate-batch");
			await this.#candidateIo(lease, "readBatch");
			this.#candidateStage = "checked"; this.#save(); this.#checkCapture(lease);
			candidate = lease.core;
		} catch (error) {
			failed = true; failure = error; lease.core?.revoke(); this.#candidateStage = "failed";
			this.#state = "blocked";
		} finally {
			this.#clearCaptureResult(lease);
			if (lease.physicalSettled && lease.ioClosed && !this.#driver.pending && !this.#closeUnknown) {
				lease.channel = undefined; lease.vm = undefined; lease.runtime = undefined; lease.core = undefined;
				lease.ticket = undefined; lease.operation = undefined; lease.outcomes = undefined; lease.outcomeWait = undefined;
				this.#candidateLease = undefined; this.#read = false;
			} else {
				this.#closeUnknown = true; this.onUnsafe(); // Keep exact channel/operation and borrowed buffers.
			}
			try { this.#save(); } catch (error) { lease.core?.revoke(); candidate?.revoke(); failure = failed
				? new AggregateError([failure, error], "Candidate capture and final journal failed") : error; failed = true; }
		}
		if (failed) throw failure;
		try {
			need(candidate === this.#candidateCore && candidate.status === "candidate-data-checked" && !this.#candidateLease
				&& !this.#read && !this.#revoked && !this.#unsafe && this.#state === "prepared-not-share-admitted"
				&& this.#runtime() === runtime && !this.#driver.pending && !this.#driver.physicallyClosed,
				"Candidate publication revoked");
			this.#candidateStage = "published"; return candidate;
		} catch (error) { candidate?.revoke(); throw error; }
	}
	disposeCandidates() { this.#candidateCore?.dispose(); this.#candidateCore = undefined; }
	endCandidateRead(diagnostics) {
		need(!this.#candidateLease, "Legacy end cannot release explicit candidate lease");
		need(this.#read, "No candidate read lease");
		need(diagnostics && Number.isSafeInteger(diagnostics.activeHandles) && diagnostics.activeHandles >= 0 && Array.isArray(diagnostics.uncertainHandles), "Reader diagnostics required");
		this.#closeUnknown ||= diagnostics.activeHandles !== 0 || diagnostics.uncertainHandles.length !== 0;
		this.#read = false; if (this.#closeUnknown) this.onUnsafe(); else this.#save();
	}
	revoke() { this.#candidateCore?.revoke(); this.#inputMethods?.revoke.call(this.#inputPublication); this.#revoked = true; this.#clearMapping(this.#mappingAttempted ? "revoked" : "none"); this.#revoke(); this.#save(); }
	async release() {
		if (this.#state === "released") return true;
		need(!this.#busy && !this.#unsafe && !this.#read && !this.#closeUnknown && this.#quiescent(), "Volume still in use or cleanup unknown");
		this.#clearMapping(this.#mappingAttempted ? "released" : "none");
		this.#state = "releasing";
		try {
			const result = await this.#call("release");
			need(result.error === null && result.phase === "released" && !result.closeUnknown
				&& (!result.imageCreated || result.managementClosed) && (!this.#baseline || result.detached), "Volume release not confirmed");
			const exited = await this.#call("exit"); need(exited.error === null && await this.#driver.waitClosed(), "Volume helper has not physically closed");
			this.#state = "released"; this.#clearInput(); this.#save(); return true;
		} catch (error) { this.#state = "blocked"; try { this.#save(); } catch {} throw error; }
		// Deliberately never calls candidate.dispose(): checked bytes have an independent lease.
	}
}
