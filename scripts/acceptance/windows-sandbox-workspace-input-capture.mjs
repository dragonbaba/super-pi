// Bounded acceptance composition. One private reader owns the original source,
// receipt lease and workspace grant from preparation through final consumption.
import { createInputAuthority, OfflineInputSnapshotOwner } from "./windows-sandbox-input-snapshot.mjs";
import { WindowsWorkspaceSourceReader } from "./windows-sandbox-workspace-source-reader.mjs";

function need(ok, message) { if (!ok) throw new Error(message); }
const readerDiagnostics = Object.getOwnPropertyDescriptor(WindowsWorkspaceSourceReader.prototype, "diagnostics").get;
const readerFailure = Object.getOwnPropertyDescriptor(WindowsWorkspaceSourceReader.prototype, "failure").get;

// Only this adapter sees its active token. A lower read failure may already have
// closed ALL native resources. Acknowledging that exact token is not another close.
class CaptureIO {
    #reader; #verify; #path; #token;
    samePathStats = 0;
    knownClosedAcknowledgements = 0;
    constructor(reader, verify) { this.#reader = reader; this.#verify = verify; }
    current(binding) { return this.#verify(binding); }
    revision(entry, binding) { this.#verify(binding); return this.#reader.assertRevision(entry, binding); }
    directory(name) { return this.#reader.directory(name); }
    file(name) {
        if (this.#token !== undefined) {
            need(name === this.#path, "workspace capture active leaf namespace");
            this.samePathStats++; return this.#reader.stat(this.#token);
        }
        return this.#reader.file(name);
    }
    open(name) {
        need(this.#token === undefined, "workspace capture active leaf");
        const token = this.#reader.open(name); this.#path = name; this.#token = token; return token;
    }
    read(token, bytes, offset, length) {
        need(token !== undefined && token === this.#token, "workspace capture token");
        return this.#reader.read(token, bytes, offset, length);
    }
    stat(token) {
        need(token !== undefined && token === this.#token, "workspace capture token");
        return this.#reader.stat(token);
    }
    #closedByOriginalOwner() {
        const d = readerDiagnostics.call(this.#reader), f = readerFailure.call(this.#reader);
        return d.cleanup === "complete" && !d.pending && !d.busy
            && d.reader?.cleanup === "complete" && d.reader.activeHandles === 0
            && !d.retainedReader && !d.retainedOperations
            && Array.isArray(f.native?.unresolved) && f.native.unresolved.length === 0;
    }
    #acknowledge() {
        this.knownClosedAcknowledgements++; this.#path = undefined; this.#token = undefined; return true;
    }
    close(token) {
        need(token !== undefined && token === this.#token, "workspace capture token");
        if (this.#closedByOriginalOwner()) return this.#acknowledge();
        try {
            need(this.#reader.close(token) === true, "workspace capture close result");
            this.#path = undefined; this.#token = undefined; return true;
        } catch (error) {
            if (this.#closedByOriginalOwner()) return this.#acknowledge();
            throw error; // Unknown keeps this exact borrowed token and original owner.
        }
    }
    release() {
        need(this.#token === undefined || this.#closedByOriginalOwner(), "workspace capture token remains unresolved");
        this.#reader = undefined; this.#verify = undefined; this.#path = undefined; this.#token = undefined;
    }
}

export class WindowsWorkspaceInputCapture {
    #canonical; #binding; #entries; #metadata; #reader; #input; #io;
    #state = "new"; #busy = false; #pending = false; #sync = false; #checking = false;
    #revoked = false; #disposeRequested = false; #cleanup = "complete"; #cleanupAttempted = false;
    #failed = false; #error; #cleanupFailed = false; #cleanupError;
    #inputFinal; #inputFailure; #readerFinal; #readerFailure;
    #copied = []; #published = false; #renewals = 0; #copyRequests = 0;
    #publicationRenewals = 0;
    #copyAllocatedBytes = 0; #deliveredCopyBytes = 0; #rejectedCopyBytes = 0;
    #samePathStats = 0; #knownClosedAcknowledgements = 0;
    constructor(input, anchor, owner, ctx, modelOperations) {
        try {
            const authority = createInputAuthority(input);
            this.#binding = authority.binding; this.#entries = authority.entries;
            this.#canonical = Object.freeze({ ...authority.binding, budget: authority.budget,
                entries: Object.freeze(authority.entries.map(entry => Object.freeze({ ...entry, classification: "ordinary" }))) });
            this.#metadata = Object.freeze({ ...authority.binding, budget: authority.budget, entries: authority.entries });
            this.#copied = authority.entries.map(() => false);
            this.#reader = new WindowsWorkspaceSourceReader(this.#canonical, anchor, owner, ctx, modelOperations);
        } catch (error) { this.#reject(error); throw error; }
    }
    #live() { need(!this.#revoked && !this.#disposeRequested, "workspace capture inactive"); }
    #save(error) { if (!this.#failed) { this.#failed = true; this.#error = error; } }
    #begin(state) {
        if (this.#busy || this.#pending || this.#checking) {
            const error = new Error("workspace capture reentry"); this.#save(error); this.revoke(); throw error;
        }
        need(this.#state === state, "workspace capture state"); this.#live(); this.#busy = true;
    }
    #verify = binding => {
        if (this.#checking) { this.#revoked = true; throw new Error("workspace capture guard reentry"); }
        this.#live(); this.#checking = true;
        try { this.#reader.assertSnapshot(binding); this.#live(); return true; }
        finally { this.#checking = false; }
    };
    #snapshot() {
        if (this.#input) { this.#inputFinal = this.#input.diagnostics; this.#inputFailure ??= this.#input.failure; }
        if (this.#reader) { this.#readerFinal = readerDiagnostics.call(this.#reader); this.#readerFailure = readerFailure.call(this.#reader); }
        if (this.#io) {
            this.#samePathStats = this.#io.samePathStats;
            this.#knownClosedAcknowledgements = this.#io.knownClosedAcknowledgements;
        }
    }
    #clearPrivate() {
        if (this.#input) { this.#inputFailure ??= this.#input.failure; this.#input.revoke(); this.#inputFinal = this.#input.diagnostics; }
    }
    #close() {
        if (this.#reader && !this.#cleanupAttempted) {
            this.#cleanupAttempted = true;
            try { this.#cleanup = this.#reader.dispose() === true ? "complete" : "unknown"; }
            catch (error) { this.#cleanup = "unknown"; this.#cleanupFailed = true; this.#cleanupError = error; }
        }
        this.#snapshot();
        if (this.#readerFinal && this.#readerFinal.cleanup !== "complete") this.#cleanup = "unknown";
    }
    #releaseKnown() {
        if (this.#cleanup !== "complete") return;
        if (this.#io) { this.#io.release(); this.#io = undefined; }
        if (this.#input) { this.#input.dispose(); this.#inputFinal = this.#input.diagnostics; this.#input = undefined; }
        this.#reader = undefined; this.#canonical = undefined; this.#binding = undefined; this.#entries = undefined; this.#metadata = undefined;
        this.#copied.length = 0;
    }
    #reject(error) {
        this.#save(error); this.#revoked = true;
        this.#clearPrivate(); // No synchronous reader/copy is still using a buffer at this catch.
        this.#close(); this.#releaseKnown();
        this.#state = this.#cleanup === "complete" ? this.#disposeRequested ? "disposed" : "rejected" : "unknown";
        return Object.freeze({ status: "rejected", cleanup: this.#cleanup });
    }
    async #renew() {
        this.#live(); this.#verify(this.#binding); this.#pending = true; this.#renewals++;
        try { await this.#reader.renew(); }
        finally { this.#pending = false; }
        this.#verify(this.#binding); this.#live();
    }
    async capture() {
        this.#begin("new"); this.#state = "preparing";
        try {
            this.#pending = true;
            try { await this.#reader.prepare(); } finally { this.#pending = false; }
            this.#verify(this.#binding); this.#state = "capturing"; this.#sync = true;
            try {
                this.#reader.initialize();
                this.#io = new CaptureIO(this.#reader, this.#verify);
                this.#input = new OfflineInputSnapshotOwner(this.#canonical, this.#io);
                const result = this.#input.capture(), originalFailure = readerFailure.call(this.#reader);
                // An already-closed-token acknowledgement must never hide the
                // original lower reader failure, including undefined/null/0.
                if (originalFailure.failed) throw originalFailure.error;
                if (result !== this.#input) {
                    const failure = this.#input.failure;
                    if (failure.operationFailed) throw failure.operationError;
                    if (failure.closeFailed) throw failure.closeError;
                    throw new Error("workspace capture input rejected");
                }
                this.#verify(this.#binding);
                this.#snapshot(); this.#io.release(); this.#io = undefined;
                const resultClosed = this.#reader.seal();
                need(resultClosed.status === "sealed" && resultClosed.cleanup === "complete", "workspace capture native close unknown");
                this.#cleanup = "complete";
            } finally { this.#sync = false; }
            this.#state = "renewing"; await this.#renew();
            this.#verify(this.#binding); this.#state = "captured"; this.#canonical = undefined; this.#snapshot();
            return Object.freeze({ status: "captured", cleanup: "complete" });
        } catch (error) { return this.#reject(error); }
        finally { this.#pending = false; this.#sync = false; this.#busy = false; }
    }
    async copyFile(index) {
        this.#begin("captured");
        let bytes;
        try {
            need(Number.isInteger(index) && index >= 0 && index < this.#entries.length
                && this.#entries[index].expose && !this.#copied[index], "workspace capture exposure or copy limit");
            this.#copied[index] = true; this.#copyRequests++;
            await this.#renew();
            this.#sync = true; this.#verify(this.#binding);
            bytes = this.#input.copyFile(index); this.#copyAllocatedBytes += bytes.length;
            this.#verify(this.#binding); this.#live();
            this.#deliveredCopyBytes += bytes.length; return bytes; // Caller owns this single successful copy.
        } catch (error) {
            if (bytes) { bytes.fill(0); this.#rejectedCopyBytes += bytes.length; }
            this.#reject(error); throw error;
        } finally { this.#pending = false; this.#sync = false; this.#busy = false; }
    }
    async publishMetadata() {
        this.#begin("captured");
        try {
            need(!this.#published, "workspace capture metadata publication is single-use"); this.#published = true;
            await this.#renew();
            this.#sync = true; this.#verify(this.#binding);
            const metadata = this.#metadata;
            this.#verify(this.#binding); this.#live(); return metadata; // Immutable data, never an authority.
        } catch (error) { this.#reject(error); throw error; }
        finally { this.#pending = false; this.#sync = false; this.#busy = false; }
    }
    async renewPublication() {
        this.#begin("captured");
        try {
            need(this.#published && this.#entries.every((entry, index) => !entry.expose || this.#copied[index])
                && this.#publicationRenewals < 3, "workspace publication phase budget");
            this.#publicationRenewals++;
            await this.#renew(); this.#verify(this.#binding);
            return true; // Renewed original authority; no transferable boolean grant.
        } catch (error) { this.#reject(error); throw error; }
        finally { this.#pending = false; this.#sync = false; this.#busy = false; }
    }
    assertPublicationCurrent(metadata) {
        this.#begin("captured");
        try {
            need(this.#published && metadata === this.#metadata
                && this.#entries.every((entry, index) => !entry.expose || this.#copied[index]),
                "workspace publication original metadata and delivery required");
            this.#verify(this.#binding); this.#live(); return true;
        } catch (error) { this.#reject(error); throw error; }
        finally { this.#busy = false; }
    }
    revoke() {
        this.#revoked = true;
        // A synchronous lower read may still be writing its borrowed buffer.
        // Async waits hold no such borrow, so private captured bytes can clear now.
        // The original reader performs its own busy/pending deferral; invalidate
        // it immediately so a late return cannot become usable on its own.
        if (this.#busy || this.#pending || this.#checking) this.#reader?.revoke();
        if (!this.#sync && !this.#checking) this.#clearPrivate();
        if (this.#busy || this.#pending || this.#checking) return;
        this.#close(); this.#releaseKnown();
        this.#state = this.#cleanup === "complete" ? this.#disposeRequested ? "disposed" : "revoked" : "unknown";
    }
    dispose() { this.#disposeRequested = true; this.revoke(); return this.#cleanup === "complete" && !this.#busy && !this.#pending; }
    get status() { return this.#state; }
    get diagnostics() {
        return { status: this.#state, busy: this.#busy, pending: this.#pending, synchronousBorrow: this.#sync,
            cleanup: this.#busy || this.#pending ? "pending" : this.#cleanup, cleanupAttempted: this.#cleanupAttempted,
            renewals: this.#renewals, copyRequests: this.#copyRequests, publishedMetadata: this.#published,
            publicationRenewals: this.#publicationRenewals,
            copyAllocatedBytes: this.#copyAllocatedBytes, deliveredCopyBytes: this.#deliveredCopyBytes, rejectedCopyBytes: this.#rejectedCopyBytes,
            samePathStats: this.#samePathStats, knownClosedAcknowledgements: this.#knownClosedAcknowledgements,
            retainedReader: !!this.#reader, retainedInput: !!this.#input, retainedIO: !!this.#io,
            retainedCanonical: !!this.#canonical, retainedBinding: !!this.#binding, retainedMetadata: !!this.#metadata,
            retainedCopySlots: this.#copied.length,
            input: this.#input?.diagnostics ?? this.#inputFinal,
            reader: this.#reader ? readerDiagnostics.call(this.#reader) : this.#readerFinal };
    }
    get failure() {
        return { failed: this.#failed, error: this.#error, cleanupFailed: this.#cleanupFailed, cleanupError: this.#cleanupError,
            input: this.#inputFailure, reader: this.#reader ? readerFailure.call(this.#reader) : this.#readerFailure };
    }
}
