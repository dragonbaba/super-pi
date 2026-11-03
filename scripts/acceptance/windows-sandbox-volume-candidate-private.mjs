// Host-private fixed leaves only. Guest-controlled paths remain in the native capture implementation.
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
const need = (condition, message) => { if (!condition) throw Error(message); };
const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/;
const ID = /^[0-9A-F]{8}:[0-9A-F]{16}$/;
const VOLUME = /^\\\\\?\\Volume\{[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}\}\\$/;
const METHODS = ["lstatSync", "realpathSync", "openSync", "fstatSync", "readSync", "writeSync", "fsyncSync", "closeSync"];
const STAGES = ["readManifest", "writeRequest", "readBatch"];
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
function keys(value, expected) {
    need(value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).sort().join(",") === expected, "Private channel schema");
}
export function nativePrivateIdentity(stat) {
    need(stat && typeof stat.dev === "bigint" && stat.dev >= 0n && stat.dev <= 0xffffffffn
        && typeof stat.ino === "bigint" && stat.ino > 0n && stat.ino <= 0xffffffffffffffffn, "Private identity width/type");
    return stat.dev.toString(16).toUpperCase().padStart(8, "0") + ":" + stat.ino.toString(16).toUpperCase().padStart(16, "0");
}
function rootPath(root) {
    need(typeof root === "string" && root.length <= 180 && /^[A-Za-z]:\\/.test(root)
        && path.win32.resolve(root) === root, "Canonical private Windows root");
    for (const segment of root.slice(3).split("\\")) {
        need(/^[A-Za-z0-9._-]{1,64}$/.test(segment) && !segment.endsWith(".")
            && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(segment), "Private root component");
    }
}
export class PrivateCandidateChannel {
    #context; #io; #functions; #interface; #state = 0; #running = false; #disposed = false; #unresolved = false;
    #active; #records = []; #ids = new Set(); #opened = 0; #closed = 0; #peak = 0; #calls = 0;
    #allocated = 0; #cleared = 0; #transferred = 0;
    constructor(input, io = fs) {
        if (io === fs) need(process.platform === "win32" && process.version === "v26.13.0", "Pinned Windows Node runtime required");
        keys(input, "exchangeId,owner,root,rootId,taskId,vm,volumePath");
        rootPath(input.root);
        need(input.owner && typeof input.owner === "object" && input.vm && input.vm.taskId === input.taskId
            && UUID.test(input.taskId) && UUID.test(input.vm.id) && VOLUME.test(input.volumePath) && ID.test(input.exchangeId)
            && ID.test(input.rootId), "Private host binding");
        this.#context = Object.freeze({ owner: input.owner, vm: input.vm, instanceId: input.vm.id, taskId: input.taskId,
            volumePath: input.volumePath, exchangeId: input.exchangeId, root: input.root, rootId: input.rootId });
        this.#io = io; const functions = {};
        for (const name of METHODS) { need(typeof io[name] === "function", "Private filesystem interface"); functions[name] = io[name]; }
        this.#functions = Object.freeze(functions);
        const channel = this;
        this.#interface = Object.freeze({
            get owner() { return channel.#context?.owner; }, get vm() { return channel.#context?.vm; },
            readManifest: this.#readManifest, writeRequest: this.#writeRequest, readBatch: this.#readBatch, snapshot: this.snapshot,
        });
    }
    get interface() { return this.#interface; }
    #readManifest = (ticket, admit, validate) => this.#run("readManifest", ticket, admit, validate);
    #writeRequest = (ticket, admit, validate, request) => this.#run("writeRequest", ticket, admit, validate, request);
    #readBatch = (ticket, admit, validate) => this.#run("readBatch", ticket, admit, validate);
    snapshot = () => {
        const retained = this.#active?.closeFailed ? [{ slot: 0, handle: this.#active.fd.toString(16).toUpperCase() }] : [];
        return Object.freeze({ opened: this.#opened, closed: this.#closed, peak: this.#peak, activeHandles: this.#opened - this.#closed,
            pending: this.#running || this.#unresolved, uncertainHandles: Object.freeze(retained.map(item => Object.freeze(item))) });
    };
    get diagnostics() {
        return Object.freeze({ disposed: this.#disposed, contextHeld: this.#context !== undefined, filesystemHeld: this.#io !== undefined,
            calls: this.#calls, allocatedBytes: this.#allocated, clearedBytes: this.#cleared, transferredBytes: this.#transferred,
            retainedBuffers: 0, records: Object.freeze(this.#records.map(record => Object.freeze({ ...record }))) });
    }
    #call(name, ticket, validate, ...args) {
        need(validate(ticket) === true, "Private lease validation denied"); need(this.#calls < 64, "Private filesystem call budget"); this.#calls++;
        return Reflect.apply(this.#functions[name], this.#io, args);
    }
    #root(ticket, validate) {
        const root = this.#context.root, stat = this.#call("lstatSync", ticket, validate, root, { bigint: true });
        need(stat.isDirectory() && !stat.isSymbolicLink() && nativePrivateIdentity(stat) === this.#context.rootId, "Private root identity changed");
        need(this.#call("realpathSync", ticket, validate, root) === root, "Private root path changed");
    }
    #regular(stat, maximum, empty) {
        need(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1n && typeof stat.size === "bigint"
            && stat.size >= (empty ? 0n : 1n) && stat.size <= BigInt(maximum)
            && typeof stat.mtimeNs === "bigint" && typeof stat.ctimeNs === "bigint", "Private leaf type/link/size");
        const id = nativePrivateIdentity(stat);
        need(id !== this.#context.rootId && id.slice(0, 9) === this.#context.rootId.slice(0, 9), "Private leaf host volume identity");
        return id;
    }
    #same(left, right) {
        return nativePrivateIdentity(left) === nativePrivateIdentity(right) && left.size === right.size
            && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
    }
    #leaf(file, maximum, empty, ticket, validate) {
        const stat = this.#call("lstatSync", ticket, validate, file, { bigint: true });
        this.#regular(stat, maximum, empty);
        need(this.#call("realpathSync", ticket, validate, file) === file, "Private leaf path changed"); return stat;
    }
    #record(name) {
        need(this.#records.length < 5 && !this.#records.some(record => record.name === name), "Private leaf already attempted");
        const record = { name, fd: undefined, id: undefined, createAttempted: false, created: false, opened: false, closed: false, closeAttempts: 0,
            operationFailed: false, operationError: undefined, closeFailed: false, closeError: undefined,
            readCount: null, writeCount: null, flushed: false, bytesAllocated: 0 };
        this.#records.push(record); return record;
    }
    #open(record, file, write, ticket, validate) {
        need(!this.#active && !this.#unresolved && this.#opened < 5, "Private descriptor admission");
        record.createAttempted = write;
        const fd = write ? this.#call("openSync", ticket, validate, file, "wx", 0o600) : this.#call("openSync", ticket, validate, file, "r");
        if (!Number.isInteger(fd) || fd < 0 || fd > 0x7fffffff) {
            this.#unresolved = true; throw Error("Private descriptor return invalid");
        }
        record.fd = fd; record.opened = true; record.created = write;
        this.#active = record; this.#opened++; this.#peak = Math.max(this.#peak, this.#opened - this.#closed);
    }
    #close(record) {
        if (!record.opened) return;
        // Owned-resource cleanup is allowed after revocation; it is never a new acquisition.
        record.closeAttempts = 1; this.#calls++;
        try { Reflect.apply(this.#functions.closeSync, this.#io, [record.fd]); record.closed = true; this.#closed++; this.#active = undefined; }
        catch (error) { record.closeFailed = true; record.closeError = error; }
    }
    #throw(record) {
        if (record.operationFailed && record.closeFailed) throw new AggregateError([record.operationError, record.closeError], "Private operation and close failed");
        if (record.operationFailed) throw record.operationError;
        if (record.closeFailed) throw record.closeError;
    }
    #read(name, maximum, empty, ticket, validate, buffers) {
        const record = this.#record(name), file = path.win32.join(this.#context.root, name); let buffer;
        try {
            this.#root(ticket, validate);
            const before = this.#leaf(file, maximum, empty, ticket, validate);
            this.#open(record, file, false, ticket, validate);
            const opened = this.#call("fstatSync", ticket, validate, record.fd, { bigint: true });
            record.id = this.#regular(opened, maximum, empty);
            need(this.#same(before, opened) && !this.#ids.has(record.id), "Private leaf changed on open or aliased");
            this.#ids.add(record.id);
            buffer = Buffer.alloc(Number(opened.size)); buffers.push(buffer); record.bytesAllocated = buffer.length; this.#allocated += buffer.length;
            if (buffer.length > 0) {
                record.readCount = this.#call("readSync", ticket, validate, record.fd, buffer, 0, buffer.length, 0);
                need(record.readCount === buffer.length, "Short private carrier read");
            } else record.readCount = 0;
            const after = this.#call("fstatSync", ticket, validate, record.fd, { bigint: true });
            this.#regular(after, maximum, empty); need(this.#same(opened, after), "Private leaf changed while reading");
            this.#root(ticket, validate);
            const leaf = this.#leaf(file, maximum, empty, ticket, validate);
            need(this.#same(after, leaf), "Private leaf path identity changed");
        } catch (error) { record.operationFailed = true; record.operationError = error; }
        finally { this.#close(record); }
        this.#throw(record);
        return { bytes: buffer, id: record.id };
    }
    #write(request, ticket, validate) {
        need(Buffer.isBuffer(request) && request.length > 0 && request.length <= 4096, "Private request buffer bound");
        const record = this.#record("candidate-request.json"), file = path.win32.join(this.#context.root, record.name);
        try {
            this.#root(ticket, validate); this.#open(record, file, true, ticket, validate);
            const opened = this.#call("fstatSync", ticket, validate, record.fd, { bigint: true });
            record.id = this.#regular(opened, 0, true);
            need(!this.#ids.has(record.id), "Private request identity alias"); this.#ids.add(record.id);
            record.writeCount = this.#call("writeSync", ticket, validate, record.fd, request, 0, request.length, 0);
            need(record.writeCount === request.length, "Short private request write");
            this.#call("fsyncSync", ticket, validate, record.fd); record.flushed = true;
            const after = this.#call("fstatSync", ticket, validate, record.fd, { bigint: true });
            this.#regular(after, 4096, false);
            need(nativePrivateIdentity(after) === record.id && after.size === BigInt(request.length), "Private request changed while writing");
            this.#root(ticket, validate);
            const leaf = this.#leaf(file, 4096, false, ticket, validate);
            need(this.#same(after, leaf), "Private request path identity changed");
        } catch (error) { record.operationFailed = true; record.operationError = error; }
        finally { this.#close(record); }
        this.#throw(record);
        return { bytes: request.length, sha256: hash(request) };
    }
    #run(stage, ticket, admit, validate, request) {
        let failed = false, failure, result, ownsAttempt = false; const buffers = [];
        try {
            need(!this.#disposed && !this.#running && !this.#unresolved && !this.#active && STAGES[this.#state] === stage
                && typeof admit === "function" && typeof validate === "function", "Private channel stage admission");
            ownsAttempt = true; this.#state = -1; this.#running = true; // Own the attempt before callbacks or filesystem operations.
            keys(ticket, "exchangeId,instanceId,maximumBytes,receiptBytes,stage,taskId,volumePath");
            need(ticket.stage === stage && ticket.taskId === this.#context.taskId && ticket.instanceId === this.#context.instanceId
                && ticket.volumePath === this.#context.volumePath && ticket.exchangeId === this.#context.exchangeId
                && ticket.maximumBytes === (stage === "readBatch" ? 16384 : 4096) && ticket.receiptBytes === 4096, "Private channel ticket binding");
            need(admit(ticket) === true, "Private stage admission denied");
            if (stage === "writeRequest") result = this.#write(request, ticket, validate);
            else {
                const manifest = stage === "readManifest";
                const receipt = this.#read(manifest ? "candidate-manifest-receipt.json" : "candidate-batch-receipt.json", 4096, false, ticket, validate, buffers);
                const payload = this.#read(manifest ? "candidate-manifest.bin" : "candidate-payload.bin", manifest ? 4096 : 16384, !manifest, ticket, validate, buffers);
                result = { bytes: payload.bytes, receipt: receipt.bytes, carrierId: payload.id };
            }
            need(validate(ticket) === true, "Private lease validation denied"); this.#state = STAGES.indexOf(stage) + 1;
        } catch (error) { failed = true; failure = error; }
        finally {
            if (failed) { for (const buffer of buffers) { buffer.fill(0); this.#cleared += buffer.length; } }
            else { for (const buffer of buffers) this.#transferred += buffer.length; }
            if (ownsAttempt) this.#running = false;
        }
        // All operations above are synchronous and no longer use caller buffers. Unknown close stays in snapshot.
        return Object.freeze({ outcome: failed ? Promise.reject(failure) : Promise.resolve(result), settled: Promise.resolve() });
    }
    dispose() {
        need(!this.#running && !this.#active && !this.#unresolved, "Private channel still owns unresolved resources");
        this.#disposed = true; this.#context = undefined; this.#io = undefined; this.#functions = undefined;
        this.#records = []; this.#ids.clear();
    }
}
