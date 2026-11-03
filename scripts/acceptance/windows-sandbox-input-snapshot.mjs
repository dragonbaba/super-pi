// Offline synchronous contract with an injected, host-owned reader. No real filesystem,
// VM, revision issuance, snapshot publication or FileService commit adapter is installed.
import { createHash } from "node:crypto";
import { win32 as path } from "node:path";

export const INPUT_LIMITS = Object.freeze({ entries: 16, fileBytes: 4096, totalBytes: 16384,
    directories: 49, metadataBytes: 32768 });
const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/;
const HASH = /^[0-9a-f]{64}$/, REVISION = /^snap_[A-Za-z0-9_-]{22}$/;
const MAX_U64 = (1n << 64n) - 1n;
class Refusal extends Error { constructor(code) { super(code); this.code = code; } }
function need(value, code) { if (!value) throw new Refusal(code); }
function fields(value, keys) {
    need(value !== null && typeof value === "object" && !Array.isArray(value)
        && Object.keys(value).sort().join(",") === keys, "schema");
}
function relative(value) {
    need(typeof value === "string" && value.length > 0 && value.length <= 120, "path");
    const parts = value.split("/"); need(parts.length <= 4, "path");
    for (const part of parts) {
        need(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(part) && !part.endsWith(".")
            && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part), "path");
        need(!/^(credentials?|secrets?|id_rsa|id_dsa|id_ecdsa|id_ed25519)(?:\.|$)/i.test(part)
            && !/\.(pem|key|pfx|p12)$/i.test(part), "credential-name");
    }
    return parts;
}
function identity(value, file) {
    fields(value, file ? "ctimeNs,dev,ino,mtimeNs,size" : "dev,ino");
    const copy = {};
    for (const key of file ? ["dev", "ino", "size", "mtimeNs", "ctimeNs"] : ["dev", "ino"]) {
        need(typeof value[key] === "bigint" && value[key] >= 0n && value[key] <= MAX_U64, "identity");
        copy[key] = value[key];
    }
    need(copy.ino > 0n, "identity"); return Object.freeze(copy);
}
function same(a, b, file = false) {
    if (!b || a.dev !== b.dev || a.ino !== b.ino) return false;
    return !file || a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
}
const hash = bytes => createHash("sha256").update(bytes).digest("hex");

export function createInputAuthority(input) {
    fields(input, "budget,entries,epoch,sessionId,snapshotId,sourceRoot,taskId");
    need(typeof input.taskId === "string" && UUID.test(input.taskId)
        && typeof input.snapshotId === "string" && UUID.test(input.snapshotId), "association");
    need(typeof input.sessionId === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(input.sessionId)
        && Number.isSafeInteger(input.epoch) && input.epoch >= 0, "revision-owner");
    fields(input.sourceRoot, "identity,path");
    const root = input.sourceRoot.path;
    need(typeof root === "string" && root.length <= 240 && /^[A-Z]:\\[^\\]/.test(root)
        && path.normalize(root) === root && !root.endsWith("\\"), "source-root");
    // The host workspace name is not a guest-relative filename. Preserve ordinary
    // Unicode, spaces and dot-prefixed project parents; native handle-relative
    // traversal still refuses reparse points, aliases and changed identities.
    for (const component of root.slice(3).split("\\")) {
        need(/^[^<>:"/\\|?*\x00-\x1f]{1,64}$/.test(component) && !/[. ]$/.test(component)
            && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(component), "source-root-component");
    }
    const sourceRoot = Object.freeze({ path: root, identity: identity(input.sourceRoot.identity, false) });
    fields(input.budget, "directories,entries,fileBytes,metadataBytes,totalBytes");
    const budget = {};
    for (const key of Object.keys(INPUT_LIMITS)) {
        need(Number.isSafeInteger(input.budget[key]) && input.budget[key] > 0
            && input.budget[key] <= INPUT_LIMITS[key], "budget"); budget[key] = input.budget[key];
    }
    need(Array.isArray(input.entries) && input.entries.length <= budget.entries, "entry-budget");
    // Conservative charged metadata bytes, not JS heap measurements. Bounds are checked
    // before retaining the next record; no serialization of caller-owned objects is used.
    let metadataBytes = 1024, sourceBytes = 0;
    need(metadataBytes <= budget.metadataBytes, "metadata-budget");
    const entries = [], directories = new Map([["", { path: "", identity: sourceRoot.identity }]]);
    for (const item of input.entries) {
        fields(item, "classification,expose,identity,operation,parents,path,revision,sha256");
        const parts = relative(item.path);
        need(item.classification === "ordinary" && typeof item.expose === "boolean", "read-authorization");
        need(item.operation === null || item.operation === "add" || item.operation === "modify", "operation");
        need(item.operation !== null || item.expose, "unused-entry");
        const lower = item.path.toLowerCase();
        for (const old of entries) {
            const other = old.path.toLowerCase();
            need(lower !== other && !lower.startsWith(other + "/") && !other.startsWith(lower + "/"), "path-conflict");
        }
        need(Array.isArray(item.parents) && item.parents.length === parts.length - 1, "parents");
        let charge = 512 + 2 * item.path.length, parentPath = "";
        for (let i = 0; i < item.parents.length; i++) {
            const parent = item.parents[i]; fields(parent, "identity,path");
            parentPath += (i ? "/" : "") + parts[i]; need(parent.path === parentPath, "parents");
            charge += 128 + 2 * parentPath.length;
        }
        need(metadataBytes + charge <= budget.metadataBytes, "metadata-budget");
        let sourceIdentity = null;
        if (item.operation === "add") {
            need(!item.expose && item.revision === null && item.identity === null && item.sha256 === null, "add-baseline");
        } else {
            need(typeof item.revision === "string" && REVISION.test(item.revision)
                && typeof item.sha256 === "string" && HASH.test(item.sha256), "revision-baseline");
            sourceIdentity = identity(item.identity, true);
            need(sourceIdentity.size <= BigInt(budget.fileBytes)
                && sourceBytes + Number(sourceIdentity.size) <= budget.totalBytes, "source-budget");
            sourceBytes += Number(sourceIdentity.size);
            for (const old of entries) if (old.identity) need(!same(old.identity, sourceIdentity), "source-alias");
        }
        const parents = [];
        for (const parent of item.parents) {
            const key = parent.path.toLowerCase(), id = identity(parent.identity, false), old = directories.get(key);
            if (old) need(old.path === parent.path && same(old.identity, id), "parent-conflict");
            else {
                need(directories.size < budget.directories, "directory-budget");
                for (const directory of directories.values()) need(!same(directory.identity, id), "directory-alias");
                directories.set(key, { path: parent.path, identity: id });
            }
            parents.push(Object.freeze({ path: parent.path, identity: id }));
        }
        entries.push(Object.freeze({ path: item.path, expose: item.expose, operation: item.operation,
            revision: item.revision, identity: sourceIdentity, sha256: item.sha256, parents: Object.freeze(parents) }));
        metadataBytes += charge;
    }
    const binding = Object.freeze({ taskId: input.taskId, epoch: input.epoch, snapshotId: input.snapshotId,
        sessionId: input.sessionId, sourceRoot });
    return { binding, entries: Object.freeze(entries), budget: Object.freeze(budget), metadataBytes,
        sourceBytes, directories: directories.size };
}

// Reader callbacks are synchronous and trusted host adapters, never guest evidence.
// current(binding) checks task/snapshot/root plus epoch == original FileRevisions.generation.
// revision(entry) checks the ORIGINAL receipt object is still live and all copied baseline
// fields match; it must not issue a receipt, choose latest, or refresh a missing baseline.
export class OfflineInputSnapshotOwner {
    #context; #io; #methods; #state = "new"; #revoked = false; #disposed = false; #busy = false;
    #buffers = []; #copied = []; #binding; #records; #handle; #unknown = false;
    #operationError; #closeError; #operationFailed = false; #closeFailed = false;
    #metrics = { ioCalls: 0, opened: 0, closeAttempts: 0, closed: 0, activeHandles: 0, peakHandles: 0,
        readCalls: 0, readBytes: 0, allocatedBytes: 0, clearedBytes: 0, retainedBytes: 0, retainedBuffers: 0,
        exportedBytes: 0, exportedFiles: 0, metadataBytes: 0, sourceBytes: 0, directories: 0 };
    constructor(input, io) {
        this.#context = createInputAuthority(input);
        need(io !== null && typeof io === "object", "reader");
        const methods = {};
        for (const key of ["current", "revision", "directory", "file", "open", "read", "stat", "close"]) {
            need(typeof io[key] === "function", "reader"); methods[key] = io[key];
        }
        this.#io = io; this.#methods = methods;
        for (const key of ["metadataBytes", "sourceBytes", "directories"]) this.#metrics[key] = this.#context[key];
    }
    get status() { return this.#state; }
    get diagnostics() {
        return Object.freeze({ contractOnly: true, ...this.#metrics, retainedContext: this.#context !== undefined,
            retainedIO: this.#io !== undefined, retainedRecords: this.#records?.length ?? 0,
            cleanup: this.#unknown ? "unknown" : this.#busy ? "pending" : "complete",
            operationFailed: this.#operationFailed, closeFailed: this.#closeFailed });
    }
    get failure() { return Object.freeze({ operationFailed: this.#operationFailed, operationError: this.#operationError,
        closeFailed: this.#closeFailed, closeError: this.#closeError, retainedHandle: this.#handle }); }
    #live() { need(!this.#revoked && !this.#disposed, "revoked"); }
    #call(name, ...args) {
        this.#live(); this.#metrics.ioCalls++;
        const value = this.#methods[name].call(this.#io, ...args);
        // open is tracked before checking revocation so a returned handle cannot be lost.
        if (name !== "open") this.#live();
        return value;
    }
    #current() { need(this.#call("current", this.#context.binding) === true, "association-changed"); }
    #directory(relativePath, expected) {
        const observed = this.#call("directory", relativePath);
        fields(observed, "canonicalPath,identity,kind,reparseTag");
        need(observed.kind === "directory" && observed.reparseTag === 0
            && observed.canonicalPath === path.join(this.#context.binding.sourceRoot.path, relativePath)
            && same(expected, identity(observed.identity, false)), "directory-changed");
    }
    #parents(item) {
        this.#directory("", this.#context.binding.sourceRoot.identity);
        for (const parent of item.parents) this.#directory(parent.path, parent.identity);
    }
    #file(item, observed) {
        if (item.operation === "add") { need(observed === null, "target-appeared"); return; }
        fields(observed, "canonicalPath,identity,kind,nlink,reparseTag");
        need(observed.kind === "file" && observed.reparseTag === 0 && observed.nlink === 1
            && observed.canonicalPath === path.join(this.#context.binding.sourceRoot.path, item.path)
            && same(item.identity, identity(observed.identity, true), true), "file-changed");
    }
    #check(item) {
        this.#current(); this.#parents(item); this.#file(item, this.#call("file", item.path));
        if (item.operation !== "add") need(this.#call("revision", item, this.#context.binding) === true, "revision-changed");
    }
    #clearBytes() {
        for (const bytes of this.#buffers) if (bytes) { bytes.fill(0); this.#metrics.clearedBytes += bytes.length; }
        this.#buffers.length = 0; this.#copied.length = 0; this.#metrics.retainedBytes = 0; this.#metrics.retainedBuffers = 0;
        this.#records = undefined; this.#binding = undefined;
    }
    #releaseReader() {
        if (this.#unknown) return; // Original reader/token stay owned; no retry or recovery here.
        this.#context = undefined; this.#io = undefined; this.#methods = undefined;
    }
    #read(item, index) {
        this.#check(item);
        let failed = false, error;
        try {
            const handle = this.#call("open", item.path);
            // Adapter must return a valid token or throw before opening. Partial-open
            // responsibility belongs to that adapter; this model has no real OS open.
            need(handle !== null && handle !== undefined, "handle");
            this.#handle = handle; this.#metrics.opened++; this.#metrics.activeHandles++;
            this.#metrics.peakHandles = Math.max(this.#metrics.peakHandles, this.#metrics.activeHandles);
            this.#live(); this.#file(item, this.#call("stat", handle)); this.#parents(item);
            const length = Number(item.identity.size);
            need(length <= this.#context.budget.fileBytes
                && this.#metrics.retainedBytes + length <= this.#context.budget.totalBytes, "read-budget");
            const bytes = Buffer.alloc(length); this.#buffers[index] = bytes;
            this.#metrics.allocatedBytes += length; this.#metrics.retainedBytes += length; this.#metrics.retainedBuffers++;
            let offset = 0;
            while (offset < length) {
                this.#metrics.readCalls++;
                const count = this.#call("read", handle, bytes, offset, length - offset);
                need(Number.isInteger(count) && count > 0 && count <= length - offset, "short-read");
                offset += count; this.#metrics.readBytes += count;
            }
            need(hash(bytes) === item.sha256, "source-hash");
            this.#file(item, this.#call("stat", handle)); this.#check(item);
        } catch (cause) { failed = true; error = cause; this.#operationFailed = true; this.#operationError = cause; }
        finally {
            if (this.#handle !== undefined) {
                this.#metrics.closeAttempts++;
                try {
                    // Must attempt closure even after revocation; any non-true result is unknown.
                    this.#metrics.ioCalls++;
                    need(this.#methods.close.call(this.#io, this.#handle) === true, "close-result");
                    this.#metrics.closed++; this.#metrics.activeHandles--; this.#handle = undefined;
                } catch (cause) {
                    this.#unknown = true; this.#closeFailed = true; this.#closeError = cause;
                }
            }
        }
        if (this.#unknown) throw new Refusal("close-unknown");
        if (failed) throw error;
        this.#live();
    }
    capture() {
        need(this.#state === "new" && !this.#busy, "single-use"); this.#live();
        this.#busy = true; this.#state = "capturing";
        try {
            this.#current();
            // Whole-batch preflight before the first open or Buffer allocation.
            for (const item of this.#context.entries) this.#check(item);
            this.#current();
            for (let index = 0; index < this.#context.entries.length; index++) {
                const item = this.#context.entries[index];
                if (item.expose) this.#read(item, index);
            }
            for (const item of this.#context.entries) this.#check(item);
            this.#current();
            // Reader callbacks may hold borrowed read buffers until synchronous return.
            // Rehash at the final boundary; an installed adapter must not retain them.
            for (let index = 0; index < this.#context.entries.length; index++) {
                const item = this.#context.entries[index];
                if (item.expose) need(hash(this.#buffers[index]) === item.sha256, "final-hash");
            }
            this.#binding = this.#context.binding; this.#records = this.#context.entries;
            this.#state = "input-captured"; this.#releaseReader(); return this;
        } catch (error) {
            if (!this.#operationFailed && !this.#closeFailed) { this.#operationFailed = true; this.#operationError = error; }
            this.#clearBytes(); this.#state = this.#unknown ? "unknown" : this.#disposed ? "disposed" : this.#revoked ? "revoked" : "rejected";
            this.#releaseReader();
            return Object.freeze({ status: "rejected", reason: error instanceof Refusal ? error.code : "reader-failure",
                cleanup: this.#unknown ? "unknown" : "complete" });
        } finally { this.#busy = false; }
    }
    #usable() { this.#live(); need(this.#state === "input-captured", "unavailable"); }
    get binding() { this.#usable(); return this.#binding; }
    get records() { this.#usable(); return this.#records; }
    copyFile(index) {
        this.#usable(); need(Number.isInteger(index) && index >= 0 && index < this.#records.length
            && this.#records[index].expose && !this.#copied[index], "exposure-or-copy-limit");
        const bytes = this.#buffers[index], copy = Buffer.alloc(bytes.length); copy.set(bytes);
        this.#copied[index] = true; this.#metrics.exportedBytes += copy.length; this.#metrics.exportedFiles++;
        return copy; // Caller owns this one bounded copy, including its cleanup.
    }
    revoke() {
        this.#revoked = true;
        if (!this.#busy) { this.#clearBytes(); this.#releaseReader(); if (!this.#unknown) this.#state = "revoked"; }
    }
    dispose() {
        this.#disposed = true; this.revoke();
        if (!this.#busy && !this.#unknown) {
            this.#state = "disposed"; this.#operationError = undefined; this.#closeError = undefined;
        }
    }
}
