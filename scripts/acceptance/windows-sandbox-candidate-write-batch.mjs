// Bounded conversion of captured candidate data; no filesystem or mutation authority.
import { createHash } from "node:crypto";
import { CapturedCandidateOwner } from "./windows-sandbox-volume-candidate-contract.mjs";
import { CANDIDATE_LIMITS } from "./windows-sandbox-candidates.mjs";
import { SNAPSHOT_ID_REGEX } from "../../packages/coding-agent/src/core/files/regex.ts";

const originalBinding = Object.getOwnPropertyDescriptor(CapturedCandidateOwner.prototype, "binding").get;
const originalRecords = Object.getOwnPropertyDescriptor(CapturedCandidateOwner.prototype, "records").get;
const originalReport = Object.getOwnPropertyDescriptor(CapturedCandidateOwner.prototype, "guestReport").get;
const originalCopy = CapturedCandidateOwner.prototype.copyBytes;
const consumed = new WeakSet();
function need(value, message) { if (!value) throw new Error(message); }

/** One original capture, one conversion attempt, one transfer to native preparation.
 * Immutable output fields are data only. The original Session's installed native
 * file invocation still owns permission, revalidation and every actual effect. */
export class CapturedWriteBatch {
    #candidate; #binding; #report; #input; #state = "new";
    #copies = 0; #copiedBytes = 0; #roundtripBytes = 0; #clearedBytes = 0; #entries = 0;
    prepare(candidate) {
        need(this.#state === "new", "Candidate write preparation already attempted");
        this.#state = "preparing";
        let operations;
        try {
            // Fixed getters invoke the original class's private brand, not caller properties.
            const binding = originalBinding.call(candidate), records = originalRecords.call(candidate);
            need(!consumed.has(candidate), "Candidate write conversion already attempted");
            consumed.add(candidate);
            need(records.length >= 1 && records.length <= CANDIDATE_LIMITS.entries, "Candidate write count");
            let total = 0;
            for (const record of records) {
                need(Number.isSafeInteger(record.bytes) && record.bytes >= 0 && record.bytes <= CANDIDATE_LIMITS.fileBytes, "Candidate write file budget");
                total += record.bytes; need(total <= CANDIDATE_LIMITS.totalBytes, "Candidate write total budget");
                need(record.operation === "add" ? record.sourceRevision === null
                    : record.operation === "modify" && typeof record.sourceRevision === "string"
                    && record.sourceRevision.length === 27 && SNAPSHOT_ID_REGEX.test(record.sourceRevision), "Candidate write original snapshot");
            }
            operations = [];
            const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
            for (let index = 0; index < records.length; index++) {
                const record = records[index]; let bytes, roundtrip;
                try {
                    bytes = originalCopy.call(candidate, index); this.#copies++; this.#copiedBytes += bytes.length;
                    need(bytes.length === record.bytes && createHash("sha256").update(bytes).digest("hex") === record.sha256, "Candidate write bytes changed");
                    const content = decoder.decode(bytes);
                    const size = Buffer.byteLength(content, "utf8"); need(size === bytes.length, "Candidate write UTF-8 length");
                    roundtrip = Buffer.alloc(size); this.#roundtripBytes += size;
                    need(roundtrip.write(content, "utf8") === size && roundtrip.equals(bytes), "Candidate write UTF-8 roundtrip");
                    operations.push(Object.freeze({ operation: "write", mode: record.operation === "add" ? "create" : "overwrite",
                        path: record.path, content, ...(record.operation === "modify" ? { snapshot: record.sourceRevision } : {}) }));
                } finally {
                    if (bytes) { bytes.fill(0); this.#clearedBytes += bytes.length; }
                    if (roundtrip) { roundtrip.fill(0); this.#clearedBytes += roundtrip.length; }
                }
            }
            need(originalBinding.call(candidate) === binding && originalRecords.call(candidate) === records, "Candidate write capture changed");
            this.#report = originalReport.call(candidate); this.#binding = binding; this.#candidate = candidate;
            this.#entries = operations.length;
            // Native preparation attaches its private symbol to this top-level object.
            this.#input = Object.defineProperty({}, "operations", { value: Object.freeze(operations), enumerable: true,
                writable: false, configurable: false }); operations = undefined;
            this.#state = "ready"; return this;
        } catch (error) {
            if (operations) operations.length = 0;
            this.#clear(); this.#state = "rejected"; throw error;
        }
    }
    #clear() { this.#candidate = undefined; this.#binding = undefined; this.#report = undefined; this.#input = undefined; }
    #current() {
        need(this.#state === "ready" && this.#input, "Candidate write request unavailable");
        need(originalBinding.call(this.#candidate) === this.#binding, "Candidate write capture changed");
    }
    take() {
        try {
            this.#current();
            const result = Object.freeze({ binding: this.#binding, guestReport: this.#report, input: this.#input });
            this.#clear(); this.#state = "transferred"; return result;
        } catch (error) { this.#clear(); this.#state = "rejected"; throw error; }
    }
    dispose() { this.#clear(); this.#state = "disposed"; }
    get diagnostics() {
        return Object.freeze({ status: this.#state, entries: this.#entries, copies: this.#copies,
            copiedBytes: this.#copiedBytes, roundtripBytes: this.#roundtripBytes, clearedBytes: this.#clearedBytes,
            retainedBytes: 0, retainedCandidate: this.#candidate !== undefined, retainedInput: this.#input !== undefined,
            retainedBinding: this.#binding !== undefined, dataOnly: true });
    }
}
