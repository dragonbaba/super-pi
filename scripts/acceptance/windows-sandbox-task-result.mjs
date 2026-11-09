import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { TASK_PACKAGE_LIMITS, TASK_RESULT_MAGIC } from "./retired-sandbox/task-package.ts";
import { nativePrivateIdentity } from "./windows-sandbox-volume-candidate-private.mjs";

const need = (value, why) => { if (!value) throw new Error(why); };
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const fields = (value, keys) => need(value && !Array.isArray(value) && Object.keys(value).sort().join(",") === keys, "Task result receipt schema");
const same = (a, b) => nativePrivateIdentity(a) === nativePrivateIdentity(b) && a.size === b.size
    && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
const FLAG_MASK = 1023;
const SETTLED_FLAGS = 1 | 2 | 32 | 64 | 128 | 256 | 512;

/** Strict untrusted data parsing. VM closure and original permissions are external
 * host facts; even a perfectly formed result does not authorize a host write.
 * Output views borrow the one supplied carrier and must not outlive its owner. */
export function parseTaskResult(bytes, taskId, snapshotId, timeoutMs) {
    need(Buffer.isBuffer(bytes) && bytes.length >= 128 && bytes.length <= TASK_PACKAGE_LIMITS.resultBytes, "Task result byte bound");
    need(typeof taskId === "string" && typeof snapshotId === "string"
        && /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(taskId)
        && /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(snapshotId), "Original task identity");
    // latin1 preserves high bits; Node's ascii decoder would mask them and accept aliases.
    need(bytes.toString("latin1", 0, 8) === TASK_RESULT_MAGIC && bytes.readUInt32LE(8) === bytes.length
        && bytes.readUInt32LE(12) === 128 && bytes.toString("latin1", 16, 52) === taskId
        && bytes.toString("latin1", 52, 88) === snapshotId && bytes.readUInt32LE(124) === 0, "Task result association/header");
    need(Number.isInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 30000, "Original task deadline");
    const exitCode = bytes.readInt32LE(88), flags = bytes.readUInt32LE(92);
    need((flags & ~FLAG_MASK) === 0 && (flags & SETTLED_FLAGS) === SETTLED_FLAGS, "Task result claims unsettled execution");
    const stdoutBytes = bytes.readUInt32LE(96), stderrBytes = bytes.readUInt32LE(100);
    const stdoutSeen = bytes.readBigUInt64LE(104), stderrSeen = bytes.readBigUInt64LE(112), elapsedMs = bytes.readUInt32LE(120);
    need(stdoutBytes <= 32768 && stderrBytes <= 32768 && 128 + stdoutBytes + stderrBytes === bytes.length
        && stdoutSeen <= BigInt(Number.MAX_SAFE_INTEGER) && stderrSeen <= BigInt(Number.MAX_SAFE_INTEGER), "Task stream bounds");
    need(stdoutBytes === Number(stdoutSeen < 32768n ? stdoutSeen : 32768n)
        && stderrBytes === Number(stderrSeen < 32768n ? stderrSeen : 32768n)
        && !!(flags & 8) === (stdoutSeen > 32768n) && !!(flags & 16) === (stderrSeen > 32768n), "Task stream truncation consistency");
    const timedOut = !!(flags & 4);
    need(elapsedMs <= timeoutMs + 10000 && (!timedOut || elapsedMs >= timeoutMs), "Task result deadline consistency");
    return Object.freeze({ source: "guest-report", state: timedOut ? "timed_out" : "exited", exitCode, timedOut, elapsedMs,
        flags, commandStarted: true, guestTreeSettlementClaimed: true,
        stdoutSeen: Number(stdoutSeen), stderrSeen: Number(stderrSeen),
        stdoutTruncated: !!(flags & 8), stderrTruncated: !!(flags & 16),
        stdout: bytes.subarray(128, 128 + stdoutBytes), stderr: bytes.subarray(128 + stdoutBytes) });
}

/** Two synchronous private-file reads after the original VM is physically closed.
 * Each descriptor has its own once-only close attempt. Unknown close retains the
 * original descriptor and owner; there is no retry or alternate-path fallback. */
export class TaskResultReader {
    #owner; #vm; #taskId; #snapshotId; #root; #rootId; #volumePath; #exchangeId; #timeoutMs;
    #attempted = false; #busy = false; #disposed = false; #closeUnknown = false;
    #records = []; #bytes; #value; #native; #allocated = 0; #cleared = 0; #opened = 0; #closed = 0; #calls = 0;
    #failed = false; #error; #closeError; #closeAttempts = 0;
    constructor({ owner, vm, taskId, snapshotId, root, rootId, volumePath, exchangeId, timeoutMs }) {
        need(owner && vm && typeof taskId === "string" && typeof snapshotId === "string"
            && /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(taskId)
            && /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(snapshotId)
            && typeof root === "string" && path.resolve(root) === root
            && /^[0-9A-F]{8}:[0-9A-F]{16}$/.test(rootId) && /^[0-9A-F]{8}:[0-9A-F]{16}$/.test(exchangeId)
            && Number.isInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 30000, "Task result reader binding");
        this.#owner = owner; this.#vm = vm; this.#taskId = taskId; this.#snapshotId = snapshotId;
        this.#root = root; this.#rootId = rootId; this.#volumePath = volumePath; this.#exchangeId = exchangeId; this.#timeoutMs = timeoutMs;
    }
    matches(owner, vm, taskId, snapshotId, volumePath, exchangeId, timeoutMs) {
        return !this.#disposed && this.#owner === owner && this.#vm === vm && this.#taskId === taskId && this.#snapshotId === snapshotId
            && this.#volumePath === volumePath && this.#exchangeId === exchangeId && this.#timeoutMs === timeoutMs;
    }
    #call(validate, name, ...args) {
        validate(); this.#calls++;
        const value = fs[name](...args);
        validate(); return value;
    }
    #rootCurrent(validate) {
        const stat = this.#call(validate, "lstatSync", this.#root, { bigint: true });
        need(stat.isDirectory() && !stat.isSymbolicLink() && nativePrivateIdentity(stat) === this.#rootId
            && this.#call(validate, "realpathSync", this.#root) === this.#root, "Task result private root changed");
    }
    #read(name, maximum, validate) {
        this.#rootCurrent(validate);
        need(this.#records.length < 2 && !this.#closeUnknown, "Task private read count/closure");
        const file = path.join(this.#root, name);
        const before = this.#call(validate, "lstatSync", file, { bigint: true });
        need(before.isFile() && !before.isSymbolicLink() && before.nlink === 1n && before.size > 0n && before.size <= BigInt(maximum)
            && this.#call(validate, "realpathSync", file) === file, "Task result carrier shape");
        const record = { name, id: undefined, fd: undefined, closeAttempted: false, closed: false, error: undefined, closeError: undefined };
        this.#records.push(record);
        let bytes, id, failed = false, failure;
        try {
            validate(); this.#calls++;
            record.fd = fs.openSync(file, "r"); this.#opened++; // Adopt before any guard can fail.
            validate();
            const opened = this.#call(validate, "fstatSync", record.fd, { bigint: true });
            id = nativePrivateIdentity(opened);
            record.id = id;
            need(opened.isFile() && opened.nlink === 1n && same(before, opened) && id.slice(0, 9) === this.#rootId.slice(0, 9)
                && id !== this.#rootId, "Task private file changed on open");
            bytes = Buffer.alloc(Number(opened.size)); this.#allocated += bytes.length;
            need(this.#call(validate, "readSync", record.fd, bytes, 0, bytes.length, 0) === bytes.length, "Short task private read");
            need(same(opened, this.#call(validate, "fstatSync", record.fd, { bigint: true })), "Task private file changed while reading");
            this.#rootCurrent(validate);
        } catch (error) { failed = true; failure = error; record.error = error;
        } finally {
            if (record.fd !== undefined && !record.closeAttempted) {
                record.closeAttempted = true; this.#closeAttempts++; this.#calls++;
                try { fs.closeSync(record.fd); record.fd = undefined; record.closed = true; this.#closed++; }
                catch (error) { this.#closeUnknown = true; this.#closeError = error; record.closeError = error; }
            }
        }
        if (failed || this.#closeUnknown) {
            if (bytes) { bytes.fill(0); this.#cleared += bytes.length; bytes = undefined; }
            if (failed && this.#closeUnknown) throw new AggregateError([failure, record.closeError], "Task result read and close failed");
            if (failed) throw failure;
            throw record.closeError;
        }
        return { bytes, id };
    }
    read(validate) {
        need(!this.#attempted && !this.#disposed && !this.#busy && typeof validate === "function", "Task result reader single use");
        this.#attempted = true; this.#busy = true;
        let receiptBytes, carrierBytes;
        try {
            const receipt = this.#read("task-result-receipt.json", 4096, validate);
            receiptBytes = receipt.bytes;
            const data = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(receiptBytes));
            fields(data, "buffers,bytes,captured,carrierId,exchangeId,failure,handles,io,nativeOperations,protocol,retainsOperations,sha256,snapshotId,sourceId,taskId,volumePath");
            fields(data.handles, "closeUnknown,closed,errors,opened,peak,retained"); fields(data.buffers, "allocated,cleared");
            fields(data.failure, "capture,close,operation"); fields(data.io, "flush,read,write");
            need(data.protocol === "super-pi-task-result-capture-v1" && data.taskId === this.#taskId
                && data.snapshotId === this.#snapshotId && data.volumePath === this.#volumePath && data.exchangeId === this.#exchangeId
                && data.captured === true && Number.isInteger(data.bytes) && data.bytes >= 128 && data.bytes <= TASK_PACKAGE_LIMITS.resultBytes
                && typeof data.sha256 === "string" && /^[0-9a-f]{64}$/.test(data.sha256), "Native task result association");
            need(typeof data.sourceId === "string" && /^[0-9A-F]{8}:[0-9A-F]{16}$/.test(data.sourceId)
                && data.sourceId.slice(0, 9) === this.#exchangeId.slice(0, 9) && data.sourceId !== this.#exchangeId
                && typeof data.carrierId === "string" && /^[0-9A-F]{8}:[0-9A-F]{16}$/.test(data.carrierId)
                && data.carrierId.slice(0, 9) === this.#rootId.slice(0, 9) && data.carrierId !== this.#rootId, "Task result native identities");
            const h = data.handles;
            need(h.opened === 3 && h.closed === 3 && h.peak === 2 && h.closeUnknown === false
                && Array.isArray(h.retained) && h.retained.length === 3 && h.retained.every(value => value === null)
                && Array.isArray(h.errors) && h.errors.length === 3 && h.errors.every(value => value === null)
                && data.buffers.allocated === data.bytes && data.buffers.cleared === data.bytes
                && data.retainsOperations === false && Object.values(data.failure).every(value => value === null)
                && data.nativeOperations === 18,
                "Task result native settlement");
            for (const key of ["read", "write", "flush"]) {
                const io = data.io[key];
                need(Array.isArray(io) && io.length === 3 && io[0] === true && io[1] === null
                    && io[2] === (key === "flush" ? 0 : data.bytes), "Task result native IO");
            }
            const carrier = this.#read("task-result.bin", TASK_PACKAGE_LIMITS.resultBytes, validate);
            carrierBytes = carrier.bytes;
            need(carrier.id === data.carrierId && carrierBytes.length === data.bytes && hash(carrierBytes) === data.sha256,
                "Task result carrier digest/identity");
            const value = parseTaskResult(carrierBytes, this.#taskId, this.#snapshotId, this.#timeoutMs);
            validate(); this.#rootCurrent(validate); validate();
            this.#bytes = carrierBytes; carrierBytes = undefined;
            this.#value = value;
            for (const io of Object.values(data.io)) Object.freeze(io);
            Object.freeze(data.handles.retained); Object.freeze(data.handles.errors);
            for (const row of [data.handles, data.buffers, data.failure, data.io, data]) Object.freeze(row);
            this.#native = data;
            return value;
        } catch (error) { this.#failed = true; this.#error = error; throw error;
        } finally {
            if (receiptBytes) { receiptBytes.fill(0); this.#cleared += receiptBytes.length; receiptBytes = undefined; }
            if (carrierBytes) { carrierBytes.fill(0); this.#cleared += carrierBytes.length; carrierBytes = undefined; }
            this.#busy = false;
        }
    }
    get nativeReceipt() { return this.#native; }
    get value() { need(!this.#disposed && this.#value, "Task result unavailable"); return this.#value; }
    get failure() { return { failed: this.#failed, error: this.#error, closeUnknown: this.#closeUnknown, closeError: this.#closeError }; }
    dispose() {
        if (this.#disposed) return;
        need(!this.#busy && !this.#closeUnknown && this.#records.every(row => row.fd === undefined), "Task result descriptor responsibility unresolved");
        if (this.#bytes) { this.#bytes.fill(0); this.#cleared += this.#bytes.length; this.#bytes = undefined; }
        this.#value = undefined; this.#native = undefined; this.#owner = undefined; this.#vm = undefined; this.#root = undefined;
        this.#rootId = undefined; this.#volumePath = undefined; this.#exchangeId = undefined; this.#taskId = undefined;
        this.#snapshotId = undefined; this.#timeoutMs = undefined; this.#records.length = 0; this.#disposed = true;
    }
    get diagnostics() {
        return { attempted: this.#attempted, pending: this.#busy, disposed: this.#disposed, closeUnknown: this.#closeUnknown,
            opened: this.#opened, closed: this.#closed, closeAttempts: this.#closeAttempts,
            allocatedBytes: this.#allocated, clearedBytes: this.#cleared, retainedBytes: this.#bytes?.length ?? 0,
            retainedFd: this.#records.some(row => row.fd !== undefined), retainedOwner: !!this.#owner, retainedVm: !!this.#vm,
            retainedResult: !!this.#value, records: this.#records.length, ioCalls: this.#calls, failed: this.#failed,
            handles: this.#records.map(row => ({ name: row.name, id: row.id ?? null, fd: row.fd ?? null,
                closeAttempted: row.closeAttempted, closed: row.closed })) };
    }
}
