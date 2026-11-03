// Cold acceptance owner for one captured source and one pinned offline tool.
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { WindowsWorkspaceInputCapture } from "./windows-sandbox-workspace-input-capture.mjs";
import { nativePrivateIdentity } from "./windows-sandbox-volume-candidate-private.mjs";
const need = (ok, why) => { if (!ok) throw new Error(why); };
const captureStatus = Object.getOwnPropertyDescriptor(WindowsWorkspaceInputCapture.prototype, "status").get;
const captureDiagnostics = Object.getOwnPropertyDescriptor(WindowsWorkspaceInputCapture.prototype, "diagnostics").get;
const captureMethods = Object.freeze(Object.fromEntries(["copyFile", "publishMetadata", "renewPublication", "assertPublicationCurrent", "dispose"]
    .map(name => [name, WindowsWorkspaceInputCapture.prototype[name]])));
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
export class CapturedInputPublication {
    #root; #rootId; #capture; #metadata; #tool; #source;
    #attempted = false; #pending = false; #revoked = false; #disposed = false; #disposeAttempted = false;
    #fd; #closeAttempted = false; #opened = 0; #closed = 0; #allocated = 0; #cleared = 0;
    #phase = 0; #failed = false; #error; #closeFailed = false; #closeError;
    #receiptAttempted = false; #receiptFd; #receiptOpened = 0; #receiptClosed = 0; #receiptCloseAttempted = false; #receiptIdentity;
    #captureFinal;
    constructor(root, rootId, capture, tool) {
        need(captureStatus.call(capture) === "captured", "Original captured input required");
        need(tool && typeof tool.sha256 === "string" && /^[0-9a-f]{64}$/.test(tool.sha256)
            && typeof tool.identity === "string" && /^[0-9A-F]{8}:[0-9A-F]{16}$/.test(tool.identity)
            && Number.isInteger(tool.bytes) && tool.bytes > 0 && tool.bytes <= 65536, "Fixed tool declaration");
        this.#root = root; this.#rootId = rootId; this.#capture = capture;
        this.#tool = Object.freeze({ sha256: tool.sha256, identity: tool.identity, bytes: tool.bytes });
        this.#checkRoot();
    }
    #live() { need(!this.#revoked && !this.#disposed && !this.#disposeAttempted, "Input publication inactive"); }
    #checkRoot() {
        this.#live(); const stat = fs.lstatSync(this.#root, { bigint: true });
        need(stat.isDirectory() && !stat.isSymbolicLink() && nativePrivateIdentity(stat) === this.#rootId
            && path.resolve(this.#root) === this.#root && fs.realpathSync(this.#root) === this.#root, "Original private root changed");
    }
    #current() {
        this.#live(); need(this.#metadata, "Input publication not prepared");
        need(captureMethods.assertPublicationCurrent.call(this.#capture, this.#metadata) === true, "Original input lease changed");
        this.#live(); return true;
    }
    async prepare() {
        this.#live(); need(!this.#attempted && !this.#pending, "Input publication single use");
        this.#attempted = true; this.#pending = true; let bytes;
        try {
            this.#metadata = await captureMethods.publishMetadata.call(this.#capture);
            this.#live(); const entries = this.#metadata.entries;
            need(entries.length === 1 && entries[0].path === "source.txt" && entries[0].expose
                && entries[0].operation === "modify" && entries[0].identity.size > 0n
                && entries[0].identity.size <= 4096n, "Fixed captured source required");
            bytes = await captureMethods.copyFile.call(this.#capture, 0); this.#allocated += bytes.length;
            this.#current(); this.#checkRoot();
            need(bytes.length === Number(entries[0].identity.size) && hash(bytes) === entries[0].sha256, "Original captured bytes changed");
            const file = path.join(this.#root, "input-source.bin");
            this.#fd = fs.openSync(file, "wx", 0o600); this.#opened++;
            const original = fs.fstatSync(this.#fd, { bigint: true });
            need(original.isFile() && original.nlink === 1n && original.size === 0n, "New input carrier shape");
            const identity = nativePrivateIdentity(original);
            need(fs.writeSync(this.#fd, bytes, 0, bytes.length, 0) === bytes.length, "Short input carrier write");
            fs.fsyncSync(this.#fd);
            const after = fs.fstatSync(this.#fd, { bigint: true });
            need(nativePrivateIdentity(after) === identity && after.size === BigInt(bytes.length) && after.nlink === 1n, "Input carrier changed");
            this.#source = Object.freeze({ identity, bytes: bytes.length, sha256: entries[0].sha256 });
            this.#current();
        } catch (error) { this.#failed = true; this.#error = error; this.#revoked = true; throw error; }
        finally {
            if (this.#fd !== undefined && !this.#closeAttempted) {
                this.#closeAttempted = true;
                try { fs.closeSync(this.#fd); this.#fd = undefined; this.#closed++; }
                catch (error) { this.#closeFailed = true; this.#closeError = error; this.#revoked = true; }
            }
            if (bytes) { bytes.fill(0); this.#cleared += bytes.length; }
            this.#pending = false;
        }
        if (this.#closeFailed) throw this.#closeError;
        this.#current(); this.#checkRoot(); return this;
    }
    get declaration() {
        this.#current(); need(this.#source && !this.#pending && this.#fd === undefined, "Input carrier unresolved");
        return Object.freeze({ taskId: this.#metadata.taskId, snapshotId: this.#metadata.snapshotId,
            source: this.#source, tool: this.#tool });
    }
    readInstallation(expected) {
        this.#current();
        need(!this.#pending && this.#fd === undefined && !this.#receiptAttempted && this.#phase === 1, "One input receipt read required");
        this.#receiptAttempted = true; let bytes, result, failed = false, failure;
        try {
            this.#checkRoot();
            const file = path.join(this.#root, "candidate-input-receipt.json");
            const before = fs.lstatSync(file, { bigint: true });
            need(before.isFile() && !before.isSymbolicLink() && before.nlink === 1n && before.size > 0n && before.size <= 4096n
                && fs.realpathSync(file) === file, "Input receipt shape");
            this.#receiptFd = fs.openSync(file, "r"); this.#receiptOpened = 1;
            const opened = fs.fstatSync(this.#receiptFd, { bigint: true });
            this.#receiptIdentity = nativePrivateIdentity(opened);
            const same = (a, b) => nativePrivateIdentity(a) === nativePrivateIdentity(b) && a.size === b.size
                && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
            need(opened.isFile() && opened.nlink === 1n && same(before, opened)
                && this.#receiptIdentity.slice(0, 9) === this.#rootId.slice(0, 9), "Input receipt changed on open");
            bytes = Buffer.alloc(Number(opened.size)); this.#allocated += bytes.length;
            need(fs.readSync(this.#receiptFd, bytes, 0, bytes.length, 0) === bytes.length, "Short input receipt");
            need(same(opened, fs.fstatSync(this.#receiptFd, { bigint: true })), "Input receipt changed while reading");
            result = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
            const fields = (value, keys) => need(value && !Array.isArray(value) && Object.keys(value).sort().join(",") === keys, "Input receipt schema");
            fields(result, "buffers,exchangeId,failure,handles,ids,installed,protocol,sourceSha256,taskId,toolSha256,volumePath");
            fields(result.ids, "source,sourceCarrier,tool,toolCarrier,tools,workspace");
            fields(result.handles, "closeUnknown,closed,errors,opened,peak,retained");
            fields(result.buffers, "allocated,cleared"); fields(result.failure, "capture,close,operation");
            need(result.protocol === "super-pi-input-install-v1" && result.taskId === this.#metadata.taskId && result.taskId === expected.taskId
                && result.volumePath === expected.volumePath && result.exchangeId === expected.exchangeId && result.installed === true
                && result.sourceSha256 === this.#source.sha256 && result.toolSha256 === this.#tool.sha256, "Input receipt association");
            need(result.ids.sourceCarrier === this.#source.identity && result.ids.toolCarrier === this.#tool.identity, "Original input/tool carrier changed");
            const ids = [result.exchangeId, result.ids.workspace, result.ids.tools, result.ids.source, result.ids.tool];
            need(ids.every(value => typeof value === "string" && /^[0-9A-F]{8}:[0-9A-F]{16}$/.test(value)
                && value.slice(0, 9) === result.exchangeId.slice(0, 9)) && new Set(ids).size === 5, "Input destination identities");
            const handles = result.handles;
            need(handles.opened === 7 && handles.closed === 7 && handles.peak === 4 && handles.closeUnknown === false
                && Array.isArray(handles.retained) && handles.retained.length === 7 && handles.retained.every(value => value === null)
                && Array.isArray(handles.errors) && handles.errors.length === 7 && handles.errors.every(value => value === null), "Input native closure");
            need(result.buffers.allocated === this.#source.bytes + this.#tool.bytes && result.buffers.cleared === result.buffers.allocated
                && Object.values(result.failure).every(value => value === null), "Input buffer/operation settlement");
            Object.freeze(handles.retained); Object.freeze(handles.errors);
            for (const value of [result.ids, handles, result.buffers, result.failure, result]) Object.freeze(value);
        } catch (error) {
            failed = true; failure = error; if (!this.#failed) { this.#failed = true; this.#error = error; } this.#revoked = true;
        } finally {
            if (this.#receiptFd !== undefined && !this.#receiptCloseAttempted) {
                this.#receiptCloseAttempted = true;
                try { fs.closeSync(this.#receiptFd); this.#receiptFd = undefined; this.#receiptClosed = 1; }
                catch (error) { this.#closeFailed = true; this.#closeError = error; this.#revoked = true; }
            }
            if (bytes) { bytes.fill(0); this.#cleared += bytes.length; }
        }
        if (failed && this.#closeFailed) throw new AggregateError([failure, this.#closeError], "Input receipt operation and close failed");
        if (failed) throw failure;
        if (this.#closeFailed) throw this.#closeError;
        this.#current(); return result;
    }
    async renew(phase) {
        this.#current(); need(!this.#pending && this.#source && ["install", "dispatch", "execute"][this.#phase] === phase, "Fixed publication phase");
        this.#phase++; this.#pending = true;
        try {
            await captureMethods.renewPublication.call(this.#capture);
            this.#current(); return true;
        } catch (error) { if (!this.#failed) { this.#failed = true; this.#error = error; } this.#revoked = true; throw error; }
        finally { this.#pending = false; }
    }
    assertCurrent() { need(!this.#pending && this.#fd === undefined && this.#receiptFd === undefined, "Publication operation pending"); return this.#current(); }
    revoke() { this.#revoked = true; }
    dispose() {
        if (this.#disposed) return;
        need(!this.#pending && this.#fd === undefined && this.#receiptFd === undefined && !this.#closeFailed && !this.#disposeAttempted, "Input responsibility unresolved");
        this.#disposeAttempted = true; this.#revoked = true;
        need(captureMethods.dispose.call(this.#capture) === true, "Original capture cleanup unresolved");
        this.#captureFinal = captureDiagnostics.call(this.#capture);
        this.#capture = undefined; this.#metadata = undefined; this.#tool = undefined; this.#source = undefined;
        this.#root = undefined; this.#rootId = undefined; this.#disposed = true;
    }
    get failure() { return { failed: this.#failed, error: this.#error, closeFailed: this.#closeFailed, closeError: this.#closeError }; }
    get diagnostics() {
        return { pending: this.#pending, revoked: this.#revoked, disposed: this.#disposed, phase: this.#phase,
            opened: this.#opened + this.#receiptOpened, closed: this.#closed + this.#receiptClosed,
            closeAttempts: Number(this.#closeAttempted) + Number(this.#receiptCloseAttempted),
            retainedFd: this.#fd !== undefined || this.#receiptFd !== undefined, fd: this.#fd ?? this.#receiptFd ?? null,
            receiptIdentity: this.#receiptIdentity ?? null, allocatedBytes: this.#allocated, clearedBytes: this.#cleared,
            retainedCapture: this.#capture !== undefined, capture: this.#capture ? captureDiagnostics.call(this.#capture) : this.#captureFinal,
            operationFailed: this.#failed, closeFailed: this.#closeFailed };
    }
}
