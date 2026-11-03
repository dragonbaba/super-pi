// Pure captured-data contract. No filesystem, manager, VM, commit or runtime authority.
// A future owner adapter must establish the real read lease and close every carrier handle.
import { createHash } from "node:crypto";
import { CANDIDATE_LIMITS, validateCandidateRelativePath, parseCandidateManifest } from "./windows-sandbox-candidates.mjs";

export const CAPTURE_PROTOCOL = "super-pi-candidate-capture-v1";
export const REQUEST_PROTOCOL = "super-pi-candidate-read-request-v1";
export const CAPTURE_LIMITS = Object.freeze({ ...CANDIDATE_LIMITS, requestBytes: 4096, receiptBytes: 4096,
    manifestHandles: 3, manifestPeak: 2, batchHandles: 98, batchPeak: 7 });
const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/;
const VOLUME = /^\\\\\?\\Volume\{[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}\}\\$/;
const ID = /^[0-9A-F]{8}:[0-9A-F]{16}$/, HASH = /^[0-9a-f]{64}$/;
const need = (value, message) => { if (!value) throw Error(message); };
const digest = bytes => createHash("sha256").update(bytes).digest("hex");
const integer = (value, maximum) => Number.isSafeInteger(value) && value >= 0 && value <= maximum;
function fields(value, keys) {
    need(value !== null && typeof value === "object" && !Array.isArray(value)
        && Object.keys(value).sort().join(",") === keys, "Capture schema");
}
function copyInput(bytes, maximum) {
    need(Buffer.isBuffer(bytes) && bytes.length <= maximum, "Capture byte budget");
    // No shared Buffer pool: .buffer exposes the entire backing store, not just the visible slice.
    const owned = Buffer.alloc(bytes.length); owned.set(bytes); return owned;
}
function json(bytes, maximum) {
    const owned = copyInput(bytes, maximum);
    try {
        const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(owned), value = JSON.parse(text);
        need(JSON.stringify(value) === text, "Capture canonical JSON"); return value;
    } catch { throw Error("Capture receipt JSON invalid");
    } finally { owned.fill(0); }
}
function authority(input) {
    fields(input, "allowed,budget,exchangeId,instanceId,snapshotId,taskId,volumePath");
    const binding = {};
    for (const key of ["taskId", "snapshotId", "instanceId"]) { need(UUID.test(input[key]) && typeof input[key] === "string", "Capture host ID"); binding[key] = input[key]; }
    need(typeof input.volumePath === "string" && VOLUME.test(input.volumePath) && typeof input.exchangeId === "string" && ID.test(input.exchangeId), "Capture volume binding");
    binding.volumePath = input.volumePath; binding.exchangeId = input.exchangeId;
    fields(input.budget, "entries,fileBytes,manifestBytes,totalBytes");
    const budget = {};
    for (const key of Object.keys(CANDIDATE_LIMITS)) { const value = input.budget[key];
        need(integer(value, CANDIDATE_LIMITS[key]) && value > 0, "Capture host budget"); budget[key] = value; }
    need(Array.isArray(input.allowed) && input.allowed.length <= budget.entries, "Capture allowlist bound");
    const allowed = [];
    for (const item of input.allowed) {
        fields(item, "operation,path,revision"); validateCandidateRelativePath(item.path);
        need(item.operation === "add" ? item.revision === null : item.operation === "modify"
            && typeof item.revision === "string" && /^[A-Za-z0-9:_-]{1,128}$/.test(item.revision), "Capture host revision");
        const lower = item.path.toLowerCase();
        for (const previous of allowed) { const other = previous.path.toLowerCase();
            need(lower !== other && !lower.startsWith(other + "/") && !other.startsWith(lower + "/"), "Capture target conflict"); }
        allowed.push(Object.freeze({ path: item.path, operation: item.operation, revision: item.revision }));
    }
    return Object.freeze({ ...binding, binding: Object.freeze(binding), budget: Object.freeze(budget), allowed: Object.freeze(allowed) });
}
function receipt(bytes, stage, context, observedCarrierId) {
    const value = json(bytes, CAPTURE_LIMITS.receiptBytes);
    fields(value, stage === "manifest"
        ? "bytes,carrierId,exchangeId,handles,protocol,sha256,sourceId,stage,taskId,volumePath"
        : "bytes,carrierId,exchangeId,handles,items,protocol,requestSha256,sha256,stage,taskId,volumePath");
    need(value.protocol === CAPTURE_PROTOCOL && value.stage === stage && value.taskId === context.taskId
        && value.volumePath === context.volumePath && value.exchangeId === context.exchangeId, "Capture receipt binding");
    need(typeof observedCarrierId === "string" && ID.test(observedCarrierId) && value.carrierId === observedCarrierId
        && typeof value.sha256 === "string" && HASH.test(value.sha256), "Capture carrier identity/hash");
    const handles = value.handles, maximum = stage === "manifest" ? CAPTURE_LIMITS.manifestHandles : CAPTURE_LIMITS.batchHandles;
    fields(handles, "closeUnknown,closed,opened,peak,retained");
    need(integer(handles.opened, maximum) && handles.opened > 0 && handles.closed === handles.opened
        && integer(handles.peak, stage === "manifest" ? CAPTURE_LIMITS.manifestPeak : CAPTURE_LIMITS.batchPeak)
        && handles.peak > 0 && handles.peak <= handles.opened && handles.closeUnknown === false
        && Array.isArray(handles.retained) && handles.retained.length === 0, "Capture reader not closed");
    need(integer(value.bytes, stage === "manifest" ? context.budget.manifestBytes : context.budget.totalBytes), "Capture receipt byte budget");
    if (stage === "manifest") need(typeof value.sourceId === "string" && ID.test(value.sourceId)
        && value.sourceId !== context.exchangeId && value.sourceId.slice(0, 9) === context.exchangeId.slice(0, 9), "Capture manifest source volume");
    return value; // Closed success receipts only; unknown/failure remains the real owner's responsibility.
}

export class CapturedCandidateOwner {
    #context; #state = "new"; #revoked = false; #manifestSourceId; #request; #requestSha; #selected; #guestReport;
    #payload; #records; #manifestCounts; #captureCounts; #manifestCopies = 0; #payloadCopies = 0; #clearedBytes = 0;
    constructor(input) { this.#context = authority(input); }
    get status() { return this.#state; }
    get diagnostics() { return Object.freeze({ contractOnly: true, manifestCopies: this.#manifestCopies, payloadCopies: this.#payloadCopies,
        retainedRequestBytes: this.#request?.length ?? 0, retainedPayloadBytes: this.#payload?.length ?? 0,
        requestBackingBytes: this.#request?.buffer.byteLength ?? 0, payloadBackingBytes: this.#payload?.buffer.byteLength ?? 0,
        retainedContext: this.#context !== undefined, clearedBytes: this.#clearedBytes }); }
    #usable(state) { need(!this.#revoked && this.#context && this.#state === state, "Capture owner unavailable"); }
    #clear() {
        for (const bytes of [this.#request, this.#payload]) if (bytes) { this.#clearedBytes += bytes.length; bytes.fill(0); }
        this.#request = undefined; this.#payload = undefined; this.#selected = undefined; this.#records = undefined; this.#guestReport = undefined;
        this.#requestSha = undefined; this.#manifestSourceId = undefined; this.#manifestCounts = undefined; this.#captureCounts = undefined;
    }
    #fail(error) { this.#clear(); this.#context = undefined; this.#state = "rejected"; throw error; }
    acceptManifest(inputBytes, receiptBytes, observedCarrierId) {
        this.#usable("new"); this.#state = "manifest-attempted"; let owned;
        try {
            const context = this.#context, proof = receipt(receiptBytes, "manifest", context, observedCarrierId);
            owned = copyInput(inputBytes, context.budget.manifestBytes); this.#manifestCopies++;
            need(owned.length === proof.bytes && digest(owned) === proof.sha256, "Capture manifest bytes changed");
            need(!(owned.length >= 3 && owned[0] === 0xef && owned[1] === 0xbb && owned[2] === 0xbf), "Capture manifest BOM");
            let data;
            try { data = parseCandidateManifest(owned, context); }
            catch { throw Error("Capture manifest invalid"); }
            this.#manifestSourceId = proof.sourceId;
            this.#selected = Object.freeze(data.candidates.map(item => context.allowed.find(allowed => allowed.path === item.path)));
            this.#guestReport = Object.freeze({ source: "guest-report", exitCode: data.report.exitCode });
            const request = { protocol: REQUEST_PROTOCOL, taskId: context.taskId, manifestSha256: proof.sha256,
                paths: this.#selected.map(item => item.path) };
            const text = JSON.stringify(request), length = Buffer.byteLength(text);
            need(length <= CAPTURE_LIMITS.requestBytes, "Capture request bound");
            this.#request = Buffer.alloc(length); need(this.#request.write(text, "utf8") === length, "Capture request encoding");
            this.#requestSha = digest(this.#request);
            need(!this.#revoked, "Capture revoked during manifest");
            this.#manifestCounts = Object.freeze({ opened: proof.handles.opened, closed: proof.handles.closed,
                peak: proof.handles.peak, closeUnknown: proof.handles.closeUnknown });
            this.#state = "request-ready";
            return Object.freeze({ status: this.#state, requestSha256: this.#requestSha, bytes: this.#request.length, entries: this.#selected.length });
        } catch (error) { return this.#fail(error); }
        finally { if (owned) { this.#clearedBytes += owned.length; owned.fill(0); } }
    }
    copyRequestBytes() { this.#usable("request-ready"); return copyInput(this.#request, CAPTURE_LIMITS.requestBytes); }
    acceptBatch(inputBytes, receiptBytes, observedCarrierId) {
        this.#usable("request-ready"); this.#state = "batch-attempted";
        try {
            const context = this.#context, proof = receipt(receiptBytes, "batch", context, observedCarrierId);
            need(proof.requestSha256 === this.#requestSha && Array.isArray(proof.items)
                && proof.items.length === this.#selected.length, "Capture request association");
            this.#payload = copyInput(inputBytes, context.budget.totalBytes); this.#payloadCopies++;
            need(this.#payload.length === proof.bytes && digest(this.#payload) === proof.sha256, "Capture payload changed");
            const records = []; let offset = 0;
            for (let index = 0; index < proof.items.length; index++) {
                const row = proof.items[index]; need(Array.isArray(row) && row.length === 3, "Capture item schema");
                const [sourceId, length, sha256] = row, target = this.#selected[index];
                need(typeof sourceId === "string" && ID.test(sourceId) && sourceId !== context.exchangeId && sourceId !== this.#manifestSourceId && sourceId.slice(0, 9) === context.exchangeId.slice(0, 9)
                    && !records.some(record => record.identity === sourceId), "Capture item identity");
                need(integer(length, context.budget.fileBytes) && offset + length <= this.#payload.length
                    && typeof sha256 === "string" && HASH.test(sha256), "Capture item byte budget");
                need(digest(this.#payload.subarray(offset, offset + length)) === sha256, "Capture item hash");
                records.push(Object.freeze({ path: target.path, operation: target.operation, sourceRevision: target.revision,
                    bytes: length, sha256, identity: sourceId, offset })); offset += length;
            }
            need(offset === this.#payload.length && !this.#revoked, "Capture trailing bytes or revocation");
            this.#records = Object.freeze(records); this.#clearedBytes += this.#request.length; this.#request.fill(0); this.#request = undefined;
            this.#captureCounts = Object.freeze({ manifest: this.#manifestCounts,
                batch: Object.freeze({ opened: proof.handles.opened, closed: proof.handles.closed,
                    peak: proof.handles.peak, closeUnknown: proof.handles.closeUnknown }) });
            this.#manifestCounts = undefined; this.#selected = undefined; this.#state = "candidate-data-checked"; return this;
        } catch (error) { return this.#fail(error); }
    }
    get binding() { this.#usable("candidate-data-checked"); return this.#context.binding; }
    get records() { this.#usable("candidate-data-checked"); return this.#records; }
    get guestReport() { this.#usable("candidate-data-checked"); return this.#guestReport; }
    get captureCounts() { this.#usable("candidate-data-checked"); return this.#captureCounts; }
    copyBytes(index) {
        this.#usable("candidate-data-checked"); need(Number.isInteger(index) && index >= 0 && index < this.#records.length, "Capture candidate index");
        const item = this.#records[index]; return copyInput(this.#payload.subarray(item.offset, item.offset + item.bytes), this.#context.budget.fileBytes);
    }
    revoke() { this.#revoked = true; this.#clear(); this.#context = undefined; if (this.#state !== "disposed") this.#state = "revoked"; }
    dispose() { this.revoke(); this.#state = "disposed"; }
}
