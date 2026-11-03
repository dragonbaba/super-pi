// Host-private diagnostic leaf owner. No spawn, volume operation, deletion or automatic retry.
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { DiagnosticResultChannel } from "./windows-sandbox-volume-diagnostic-channel.mjs";
import { nativePrivateIdentity } from "./windows-sandbox-volume-candidate-private.mjs";
import { validateFaultDiagnosticText, faultDiagnosticEnvelope } from "./windows-sandbox-volume-fault-cleanup.mjs";
const need = (condition, message) => { if (!condition) throw Error(message); };
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const METHODS = ["lstatSync", "realpathSync", "openSync", "fstatSync", "writeSync", "fsyncSync", "closeSync"];
const ID = /^[0-9A-F]{8}:[0-9A-F]{16}$/, UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/;
export const DIAGNOSTIC_FILE_LIMITS = Object.freeze({ bytes: 4096, writes: 4, filesystemCalls: 16, descriptors: 1 });
export class DiagnosticReceiptFile {
    #context; #io; #methods; #guard; #channel; #bytes; #proof; #record;
    #state = "new"; #running = false; #unknown = false; #calls = 0; #received = 0; #cleared = 0; #transferred = 0;
    #openCalls = 0; #writeCalls = 0; #flushCalls = 0; #peak = 0;
    constructor(input, guard, io = fs) {
        need(input && Object.keys(input).sort().join(",") === "imageBytes,imageId,instanceId,root,rootId,taskId,volumePath", "Full original diagnostic binding");
        const { root, rootId, taskId, imageId, instanceId, imageBytes, volumePath } = input;
        need(typeof root === "string" && root.length <= 180 && /^[A-Za-z]:\\/.test(root)
            && path.win32.resolve(root) === root, "Canonical private Windows root");
        for (const part of root.slice(3).split("\\"))
            need(/^[A-Za-z0-9._-]{1,64}$/.test(part) && !part.endsWith(".")
                && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part), "Bounded private root component");
        need([rootId, imageId].every(value => typeof value === "string" && ID.test(value))
            && rootId !== imageId && rootId.slice(0, 9) === imageId.slice(0, 9)
            && [taskId, instanceId].every(value => typeof value === "string" && UUID.test(value)) && taskId !== instanceId
            && Number.isInteger(imageBytes) && imageBytes >= 134217728 && imageBytes <= 135266304
            && typeof volumePath === "string" && /^\\\\\?\\Volume\{[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}\}\\$/.test(volumePath)
            && typeof guard === "function", "Host receipt context");
        if (io === fs) need(process.platform === "win32" && process.version === "v26.13.0", "Pinned Windows Node required");
        const methods = {};
        for (const name of METHODS) { need(typeof io[name] === "function", "Receipt filesystem dependency"); methods[name] = io[name]; }
        this.#context = Object.freeze({ root, rootId, taskId, imageId, instanceId, imageBytes, volumePath,
            file: path.win32.join(root, "fault-diagnostic.json") });
        this.#io = io; this.#methods = Object.freeze(methods); this.#guard = guard;
        this.#record = { createAttempted: false, opened: false, fd: undefined, id: undefined, writeCount: 0, flushed: false,
            closed: false, closeAttempts: 0, operationFailed: false, operationError: undefined, closeFailed: false, closeError: undefined };
    }
    get snapshot() { return Object.freeze({ state: this.#state, running: this.#running, unknown: this.#unknown,
        contextHeld: !!this.#context, filesystemHeld: !!this.#io, guardHeld: !!this.#guard, channelHeld: !!this.#channel,
        calls: this.#calls, openCalls: this.#openCalls, writeCalls: this.#writeCalls, flushCalls: this.#flushCalls,
        peakDescriptors: this.#peak, activeDescriptors: this.#record.opened && !this.#record.closed ? 1 : 0,
        receivedBytes: this.#received, allocatedBytes: 0, clearedBytes: this.#cleared, transferredBytes: this.#transferred, retainedBytes: this.#bytes?.length ?? 0,
        record: Object.freeze({ ...this.#record }) }); }
    #failed(error) {
        this.#record.operationFailed = true; this.#record.operationError = error; this.#state = "blocked";
    }
    adopt(channel) {
        need(this.#state === "new" && !this.#running, "Receipt adoption is one-shot");
        this.#state = "adopting"; this.#running = true; this.#channel = channel;
        try {
            // Owner exists before the channel's unique transfer; register bytes before checks or callbacks.
            const transfer = DiagnosticResultChannel.prototype.takeSuccess.call(channel);
            this.#bytes = transfer.bytes; this.#proof = transfer.proof; this.#received = this.#bytes.length;
            need(this.#received > 0 && this.#received <= 4096 && this.#proof.stdoutBytes === this.#received
                && hash(this.#bytes) === this.#proof.sha256, "Original transferred success bytes");
            validateFaultDiagnosticText(this.#bytes.toString("utf8"), this.#context); // Cross-task/root/image/instance binding.
            this.#state = "ready";
        } catch (error) { this.#failed(error); throw error; }
        finally { this.#running = false; }
    }
    #call(name, ...args) {
        need(this.#guard() === true, "Host receipt permission revoked");
        need(this.#calls < 15, "Receipt filesystem budget"); this.#calls++;
        if (name === "openSync") this.#openCalls++;
        if (name === "writeSync") this.#writeCalls++;
        if (name === "fsyncSync") this.#flushCalls++;
        return Reflect.apply(this.#methods[name], this.#io, args);
    }
    #root() {
        const stat = this.#call("lstatSync", this.#context.root, { bigint: true });
        need(stat.isDirectory() && !stat.isSymbolicLink() && nativePrivateIdentity(stat) === this.#context.rootId, "Original private root changed");
        need(this.#call("realpathSync", this.#context.root) === this.#context.root, "Original private root path changed");
    }
    #regular(stat, size) {
        const id = nativePrivateIdentity(stat);
        need(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1n && stat.size === BigInt(size)
            && typeof stat.mtimeNs === "bigint" && typeof stat.ctimeNs === "bigint"
            && id !== this.#context.rootId && id.slice(0, 9) === this.#context.rootId.slice(0, 9), "Receipt identity/type/link/size");
        return id;
    }
    writeOnce() {
        need(this.#state === "ready" && !this.#running, "Receipt write is one-shot");
        this.#state = "writing"; this.#running = true; const record = this.#record;
        try {
            this.#root();
            record.createAttempted = true;
            const fd = this.#call("openSync", this.#context.file, "wx", 0o600);
            record.fd = fd;
            if (!Number.isInteger(fd) || fd < 0 || fd > 0x7fffffff) { this.#unknown = true; throw Error("Unknown receipt descriptor"); }
            record.opened = true; this.#peak = 1; // Includes fd 0, before any later validation.
            const opened = this.#call("fstatSync", fd, { bigint: true }); record.id = nativePrivateIdentity(opened);
            this.#regular(opened, 0);
            need(hash(this.#bytes) === this.#proof.sha256, "Transferred bytes changed before write");
            while (record.writeCount < this.#bytes.length) {
                need(this.#writeCalls < DIAGNOSTIC_FILE_LIMITS.writes, "Receipt short-write budget exhausted");
                const remaining = this.#bytes.length - record.writeCount;
                const written = this.#call("writeSync", fd, this.#bytes, record.writeCount, remaining, record.writeCount);
                need(Number.isInteger(written) && written > 0 && written <= remaining, "Invalid receipt write progress");
                record.writeCount += written; // Bounded short-write progress, never retry a failed syscall.
            }
            this.#call("fsyncSync", fd); record.flushed = true;
            const after = this.#call("fstatSync", fd, { bigint: true });
            need(this.#regular(after, this.#bytes.length) === record.id, "Receipt handle identity changed");
            this.#root();
            const leaf = this.#call("lstatSync", this.#context.file, { bigint: true });
            need(this.#regular(leaf, this.#bytes.length) === record.id && leaf.mtimeNs === after.mtimeNs && leaf.ctimeNs === after.ctimeNs
                && this.#call("realpathSync", this.#context.file) === this.#context.file, "Receipt path changed");
            need(hash(this.#bytes) === this.#proof.sha256, "Transferred bytes changed during write");
        } catch (error) { this.#failed(error); }
        finally {
            if (record.opened) {
                record.closeAttempts = 1; this.#calls++;
                try { Reflect.apply(this.#methods.closeSync, this.#io, [record.fd]); record.closed = true; }
                catch (error) { record.closeFailed = true; record.closeError = error; this.#unknown = true; }
            } // Owned close is allowed after revocation, exactly once.
            this.#running = false;
        }
        this.#state = record.operationFailed || record.closeFailed || this.#unknown ? "blocked" : "written";
        if (record.operationFailed && record.closeFailed) throw new AggregateError([record.operationError, record.closeError], "Receipt operation and close failed");
        if (record.operationFailed) throw record.operationError;
        if (record.closeFailed) throw record.closeError;
        return this.snapshot;
    }
    evidence() {
        need(this.#state === "written" && !this.#running && !this.#unknown && this.#record.closed, "Receipt evidence unavailable");
        this.#running = true;
        try {
            need(this.#guard() === true && hash(this.#bytes) === this.#proof.sha256, "Original receipt bytes or permission changed");
            // Fixed synchronous output only. Raw bytes never escape; no generic callback or async lease.
            return Object.freeze({ proof: this.#proof, file: Object.freeze({ name: "fault-diagnostic.json", id: this.#record.id,
                bytes: this.#bytes.length, sha256: this.#proof.sha256 }), wire: faultDiagnosticEnvelope(this.#context.taskId, this.#bytes) });
        } catch (error) { this.#failed(error); throw error; }
        finally { this.#running = false; }
    }
    takeForCleanup() {
        need(this.#state === "written" && !this.#running && !this.#unknown && this.#record.closed
            && hash(this.#bytes) === this.#proof.sha256, "Original closed receipt transfer unavailable");
        const transfer = Object.freeze({ bytes: this.#bytes, proof: this.#proof });
        this.#transferred = this.#bytes.length; this.#bytes = undefined; this.#state = "transferred";
        return transfer; // The pre-existing outer host owner receives immediately; this is data, never cleanup authority.
    }
    abandon() {
        need(!this.#running && this.#state !== "disposed", "Receipt operation in flight");
        this.#state = "abandoned"; // Irreversible surrender of success, never permission to delete or close again.
    }
    dispose() {
        if (this.#state === "disposed") return;
        need(!this.#running && !this.#unknown && (!this.#record.opened || this.#record.closed)
            && ["new", "blocked", "abandoned", "transferred"].includes(this.#state), "Receipt responsibility or success use remains");
        if (this.#bytes) { this.#bytes.fill(0); this.#cleared += this.#bytes.length; this.#bytes = undefined; }
        this.#context = undefined; this.#io = undefined; this.#methods = undefined; this.#guard = undefined;
        this.#channel = undefined; this.#proof = undefined; this.#record.operationError = undefined; this.#record.closeError = undefined;
        this.#state = "disposed"; // No delete and no release of any outer task or process.
    }
}

