// Low-frequency acceptance composition only. A synchronous trusted host callback
// supplies CURRENT read permission; this is not a production permission adapter.
import { createInputAuthority, OfflineInputSnapshotOwner } from "./windows-sandbox-input-snapshot.mjs";
import { OriginalInputRevisionLease } from "./windows-sandbox-input-revision-lease.mjs";
import { WindowsSourceReader, createWindowsSourceReader } from "./windows-sandbox-source-reader.mjs";
import { SessionFileRevisionSource } from "../../packages/coding-agent/src/core/files/session-file-revision-source.ts";

const sourceRevisions = Object.getOwnPropertyDescriptor(SessionFileRevisionSource.prototype, "revisions").get;
const disposeSource = SessionFileRevisionSource.prototype.dispose;
function need(ok, message) { if (!ok) throw new Error(message); }
function canonicalInput(input) {
    const authority = createInputAuthority(input);
    const entries = Object.freeze(authority.entries.map(entry => Object.freeze({ ...entry, classification: "ordinary" })));
    return Object.freeze({ ...authority.binding, entries, budget: authority.budget });
}

// Private adapter: only the owner constructs/holds it. No reader/input/token escapes.
class CaptureIO {
    #reader; #verify; #lease; #path; #token;
    samePathStats = 0;
    constructor(reader, verify, lease) { this.#reader = reader; this.#verify = verify; this.#lease = lease; }
    current(binding) { return this.#verify(binding); }
    revision(entry, binding) { this.#verify(binding); return this.#lease.revision(entry, binding); }
    directory(name) { return this.#reader.directory(name); }
    file(name) {
        if (this.#token !== undefined) {
            need(name === this.#path, "capture active leaf namespace");
            this.samePathStats++; return this.#reader.stat(this.#token);
        }
        return this.#reader.file(name);
    }
    open(name) {
        need(this.#token === undefined, "capture active leaf");
        // If open throws after acquiring a native slot, reader still owns that slot.
        const token = this.#reader.open(name); this.#path = name; this.#token = token; return token;
    }
    read(token, bytes, offset, length) { need(token === this.#token, "capture token"); return this.#reader.read(token, bytes, offset, length); }
    stat(token) { need(token === this.#token, "capture token"); return this.#reader.stat(token); }
    close(token) {
        need(token === this.#token, "capture token");
        try { return this.#reader.close(token); }
        finally { this.#path = undefined; this.#token = undefined; }
    }
    release() { this.#reader = undefined; this.#verify = undefined; this.#lease = undefined; this.#path = undefined; this.#token = undefined; }
}

export class WindowsInputCapture {
    #inputData; #binding; #entries; #anchor; #source; #sourceCurrent; #authorize; #operations;
    #lease; #reader; #input; #io; #state = "new"; #busy = false; #checking = false; #revoked = false;
    #disposeRequested = false; #cleanup = "complete"; #nativeCleanupAttempted = false;
    #operationFailed = false; #operationError; #cleanupFailed = false; #cleanupError;
    #inputFailure; #nativeFailure; #inputFinal; #readerFinal; #leaseFinal; #sourceFinal;
    #checks = 0; #authorizations = 0; #samePathStats = 0; #exportedBytes = 0; #rejectedCopyBytes = 0;
    constructor(input, anchor, source, authorize, operations) {
        // Ownership of this dedicated source transfers after the brand check, before
        // schema/authority validation. Never dispose the external SessionFiles owner.
        need(source instanceof SessionFileRevisionSource, "capture original source required");
        this.#source = source;
        try {
            this.#sourceCurrent = source.current;
            need(typeof this.#sourceCurrent === "function" && typeof authorize === "function", "capture host guard");
            this.#authorize = authorize;
            this.#inputData = canonicalInput(input);
            const { taskId, snapshotId, sessionId, epoch, sourceRoot, entries } = this.#inputData;
            this.#binding = Object.freeze({ taskId, snapshotId, sessionId, epoch, sourceRoot }); this.#entries = entries;
            // Anchor fields are primitive copied values. Reader validates its schema
            // and budgets before native binding; no caller object is retained.
            need(anchor && Object.keys(anchor).sort().join(",") === "drive,identity,volumePath"
                && anchor.identity && Object.keys(anchor.identity).sort().join(",") === "dev,ino", "capture anchor");
            this.#anchor = Object.freeze({ drive: anchor.drive, volumePath: anchor.volumePath,
                identity: Object.freeze({ dev: anchor.identity?.dev, ino: anchor.identity?.ino }) });
            this.#operations = operations; // Optional, explicitly labelled model ops only.
        } catch (error) {
            disposeSource.call(source); this.#source = undefined; this.#sourceCurrent = undefined;
            throw error;
        }
    }
    #live() { need(!this.#revoked && !this.#disposeRequested, "capture inactive"); }
    #saveError(error) { if (!this.#operationFailed) { this.#operationFailed = true; this.#operationError = error; } }
    // Lease's host guard checks source only: calling the composite guard here
    // would recursively enter the same lease. Source retains only weak originals.
    #sourceGuard = () => { this.#live(); const value = this.#sourceCurrent(); this.#live(); return value; };
    #verify = binding => {
        this.#checks++;
        if (this.#checking) { this.#revoked = true; throw new Error("capture guard reentry"); }
        this.#live(); this.#checking = true;
        try {
            need(this.#lease.current(binding) === true, "capture original lease inactive");
            this.#authorizations++;
            need(this.#authorize(this.#binding, this.#entries) === true, "capture read permission denied");
            this.#live();
            // Recheck original source + receipts AFTER the permission callback.
            need(this.#lease.current(binding) === true, "capture original lease changed"); this.#live(); return true;
        } catch (error) { this.#saveError(error); this.#revoked = true; throw error; }
        finally { this.#checking = false; }
    };
    #clearInput() {
        if (!this.#input) return;
        this.#inputFailure ??= this.#input.failure; // Preserve falsy original errors before disposal.
        this.#input.revoke(); this.#inputFinal = this.#input.diagnostics;
    }
    #closeNative() {
        if (!this.#reader) {
            if (this.#operations && !this.#nativeCleanupAttempted) {
                // Model operations were not installed. They must not contain handles.
                this.#nativeCleanupAttempted = true;
                try { this.#operations.dispose(); this.#operations = undefined; }
                catch (error) { this.#cleanupFailed = true; this.#cleanupError = error; this.#cleanup = "unknown"; }
            }
            return;
        }
        if (!this.#nativeCleanupAttempted) {
            this.#nativeCleanupAttempted = true;
            try { this.#cleanup = this.#reader.closeAll() === true ? "complete" : "unknown"; }
            catch (error) { this.#cleanupFailed = true; this.#cleanupError = error; this.#cleanup = "unknown"; }
        }
        this.#readerFinal = this.#reader.diagnostics; this.#nativeFailure = this.#reader.failure;
        if (this.#readerFinal.cleanup !== "complete") this.#cleanup = "unknown";
    }
    #releaseGuards() {
        if (this.#lease) { this.#lease.dispose(); this.#leaseFinal = this.#lease.diagnostics; this.#lease = undefined; }
        if (this.#source) { disposeSource.call(this.#source); this.#sourceFinal = this.#source.diagnostics; this.#source = undefined; }
        this.#sourceCurrent = undefined; this.#authorize = undefined;
        this.#inputData = undefined; this.#binding = undefined; this.#entries = undefined; this.#anchor = undefined;
    }
    #releaseKnownResources() {
        if (this.#cleanup !== "complete") return;
        this.#io?.release(); this.#io = undefined; this.#reader = undefined; this.#operations = undefined;
        if (this.#input && this.#state !== "captured") {
            this.#input.dispose(); this.#inputFinal = this.#input.diagnostics; this.#input = undefined;
        }
    }
    #reject(error) {
        this.#saveError(error); this.#revoked = true;
        this.#clearInput(); // Clear ALL private bytes before remaining native cleanup.
        this.#closeNative(); this.#releaseGuards();
        this.#state = this.#cleanup === "complete" ? this.#disposeRequested ? "disposed" : "rejected" : "unknown";
        this.#releaseKnownResources();
        return Object.freeze({ status: "rejected", cleanup: this.#cleanup });
    }
    capture() {
        if (this.#busy || this.#checking) { this.#revoked = true; throw new Error("capture reentry"); }
        need(this.#state === "new", "capture single-use"); this.#live(); this.#busy = true; this.#state = "capturing";
        try {
            // Strong revisions reference lasts only for this constructor call.
            this.#lease = new OriginalInputRevisionLease(this.#inputData, sourceRevisions.call(this.#source), this.#sourceGuard);
            this.#verify(this.#binding);
            this.#reader = this.#operations
                ? new WindowsSourceReader(this.#inputData, this.#anchor, this.#verify, this.#operations)
                : createWindowsSourceReader(this.#inputData, this.#anchor, this.#verify);
            this.#operations = undefined; this.#cleanup = "pending";
            this.#reader.initialize();
            this.#io = new CaptureIO(this.#reader, this.#verify, this.#lease);
            this.#input = new OfflineInputSnapshotOwner(this.#inputData, this.#io);
            const result = this.#input.capture(); this.#samePathStats = this.#io.samePathStats;
            if (result !== this.#input) {
                const failure = this.#input.failure;
                if (failure.operationFailed) throw failure.operationError;
                if (failure.closeFailed) throw failure.closeError;
                throw new Error("capture input rejected");
            }
            let returned = false;
            try { this.#cleanup = this.#reader.settle() === true ? "complete" : "unknown"; returned = true; }
            catch (error) {
                const state = this.#reader.diagnostics;
                if (state.activeHandles === 0 && state.cleanup === "pending") {
                    this.#cleanupFailed = true; this.#cleanupError = error; this.#cleanup = "unknown";
                }
                throw error;
            }
            finally {
                // settle may throw before closeAll. If all handles are gone, never
                // retry a potentially failed native dispose. Retain unknown owner.
                if (returned || this.#reader.diagnostics.activeHandles === 0) this.#nativeCleanupAttempted = true;
            }
            this.#readerFinal = this.#reader.diagnostics; this.#nativeFailure = this.#reader.failure;
            need(this.#cleanup === "complete" && this.#readerFinal.cleanup === "complete", "capture native close unknown");
            this.#verify(this.#binding); // Native is closed; this still is not permission.
            this.#state = "captured"; this.#inputFinal = this.#input.diagnostics;
            this.#releaseKnownResources(); this.#inputData = undefined; this.#anchor = undefined;
            return Object.freeze({ status: "captured", cleanup: "complete" });
        } catch (error) { return this.#reject(error); }
        finally { this.#busy = false; }
    }
    copyFile(index) {
        if (this.#busy || this.#checking) { this.#revoked = true; throw new Error("capture reentry"); }
        need(this.#state === "captured", "capture unavailable"); this.#live(); this.#busy = true;
        let bytes;
        try {
            this.#verify(this.#binding); bytes = this.#input.copyFile(index); this.#verify(this.#binding);
            this.#exportedBytes += bytes.length; return bytes; // Caller owns this single copy.
        } catch (error) {
            if (bytes) { bytes.fill(0); this.#rejectedCopyBytes += bytes.length; }
            this.#reject(error); throw error;
        } finally { this.#busy = false; }
    }
    revoke() {
        this.#revoked = true;
        if (this.#busy || this.#checking) return; // Synchronous caller unwinds and owns cleanup.
        this.#clearInput(); this.#closeNative(); this.#releaseGuards();
        this.#state = this.#cleanup === "complete" ? this.#disposeRequested ? "disposed" : "revoked" : "unknown";
        this.#releaseKnownResources();
    }
    dispose() { this.#disposeRequested = true; this.revoke(); return this.#cleanup === "complete" && !this.#busy; }
    get status() { return this.#state; }
    get diagnostics() {
        return { status: this.#state, cleanup: this.#busy ? "pending" : this.#cleanup,
            checks: this.#checks, authorizations: this.#authorizations, samePathStats: this.#samePathStats,
            exportedBytes: this.#exportedBytes, rejectedCopyBytes: this.#rejectedCopyBytes,
            retainedSource: this.#source !== undefined, retainedLease: this.#lease !== undefined,
            retainedReader: this.#reader !== undefined, retainedInput: this.#input !== undefined,
            retainedModelOperations: this.#operations !== undefined,
            retainedAuthorization: this.#authorize !== undefined, retainedInputData: this.#inputData !== undefined,
            input: this.#input?.diagnostics ?? this.#inputFinal, reader: this.#reader?.diagnostics ?? this.#readerFinal,
            lease: this.#lease?.diagnostics ?? this.#leaseFinal, source: this.#source?.diagnostics ?? this.#sourceFinal };
    }
    get failure() {
        return { operationFailed: this.#operationFailed, operationError: this.#operationError,
            cleanupFailed: this.#cleanupFailed, cleanupError: this.#cleanupError,
            input: this.#inputFailure, native: this.#reader?.failure ?? this.#nativeFailure };
    }
}
