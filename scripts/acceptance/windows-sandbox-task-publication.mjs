// Host publication of a bounded task package, not a new authorization mechanism.
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { assertSandboxTaskRequest } from "../../packages/coding-agent/src/core/sandbox/task-request.ts";
import { TaskPackageBuilder, TASK_PACKAGE_LIMITS } from "../../packages/coding-agent/src/core/sandbox/task-package.ts";
import { WindowsWorkspaceInputCapture } from "./windows-sandbox-workspace-input-capture.mjs";
import { nativePrivateIdentity } from "./windows-sandbox-volume-candidate-private.mjs";

const need = (ok, why) => { if (!ok) throw new Error(why); };
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const status = Object.getOwnPropertyDescriptor(WindowsWorkspaceInputCapture.prototype, "status").get;
const diagnostics = Object.getOwnPropertyDescriptor(WindowsWorkspaceInputCapture.prototype, "diagnostics").get;
const methods = Object.freeze(Object.fromEntries(["copyFile", "publishMetadata", "renewPublication",
    "assertPublicationCurrent", "revoke", "dispose"].map(name => [name, WindowsWorkspaceInputCapture.prototype[name]])));
const fields = (value, keys) => need(value && !Array.isArray(value) && Object.keys(value).sort().join(",") === keys, "Task installation receipt schema");
const same = (a, b) => nativePrivateIdentity(a) === nativePrivateIdentity(b) && a.size === b.size
    && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;

/** The trusted parent supplies the original live SandboxTaskBorrow. Its shape is
 * not provenance. Nonempty content comes exclusively from the original capture;
 * an empty request has no capture and still uses the original session guards. */
export class TaskInputPublication {
    #root; #rootId; #borrow; #taskId; #snapshotId; #capture; #metadata; #tool; #package;
    #attempted = false; #pending = false; #revoked = false; #disposed = false; #disposeAttempted = false;
    #fd; #closeAttempted = false; #opened = 0; #closed = 0; #allocated = 0; #cleared = 0;
    #phase = 0; #failed = false; #error; #closeFailed = false; #closeError;
    #receiptAttempted = false; #receiptFd; #receiptOpened = 0; #receiptClosed = 0; #receiptCloseAttempted = false; #receiptIdentity;
    #captureFinal; #builderFinal; #copyBytes = 0; #copyCleared = 0;
    constructor(root, rootId, capture, tool, borrow, taskId, snapshotId) {
        assertSandboxTaskRequest(borrow.request);
        need(Object.isFrozen(borrow) && typeof borrow.assertInputsCurrent === "function"
            && typeof borrow.assertSessionCurrent === "function", "Original parent borrow required");
        borrow.assertInputsCurrent();
        if (borrow.request.inputs.length) need(status.call(capture) === "captured", "Original captured input required");
        else need(capture === undefined, "An empty request must not manufacture a capture");
        need(typeof taskId === "string" && /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(taskId)
            && typeof snapshotId === "string" && /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(snapshotId), "Task association");
        need(tool && typeof tool.sha256 === "string" && /^[0-9a-f]{64}$/.test(tool.sha256)
            && typeof tool.identity === "string" && /^[0-9A-F]{8}:[0-9A-F]{16}$/.test(tool.identity)
            && Number.isSafeInteger(tool.bytes) && tool.bytes > 0 && tool.bytes <= TASK_PACKAGE_LIMITS.runnerBytes, "Task runner declaration");
        this.#root = root; this.#rootId = rootId; this.#capture = capture; this.#borrow = borrow;
        this.#taskId = taskId; this.#snapshotId = snapshotId;
        this.#tool = Object.freeze({ sha256: tool.sha256, identity: tool.identity, bytes: tool.bytes });
        this.#checkRoot();
    }
    #live() { need(!this.#revoked && !this.#disposed && !this.#disposeAttempted, "Task publication inactive"); }
    #checkRoot() {
        this.#live();
        const stat = fs.lstatSync(this.#root, { bigint: true });
        need(stat.isDirectory() && !stat.isSymbolicLink() && nativePrivateIdentity(stat) === this.#rootId
            && path.resolve(this.#root) === this.#root && fs.realpathSync(this.#root) === this.#root, "Original task root changed");
    }
    #current() {
        this.#live(); this.#borrow.assertInputsCurrent();
        if (this.#capture) need(this.#metadata && methods.assertPublicationCurrent.call(this.#capture, this.#metadata) === true,
            "Original task capture changed");
        this.#live(); return true;
    }
    async prepare() {
        this.#live(); need(!this.#attempted && !this.#pending, "Task publication single use");
        this.#attempted = true; this.#pending = true;
        let bytes, builder, failed = false, failure;
        const descriptors = [];
        try {
            this.#borrow.assertInputsCurrent();
            if (this.#capture) {
                this.#metadata = await methods.publishMetadata.call(this.#capture);
                this.#live(); this.#borrow.assertInputsCurrent();
                need(this.#metadata.taskId === this.#taskId && this.#metadata.snapshotId === this.#snapshotId
                    && this.#metadata.entries.length === this.#borrow.request.inputs.length, "Original capture association");
                for (let index = 0; index < this.#metadata.entries.length; index++) {
                    const row = this.#metadata.entries[index], selected = this.#borrow.request.inputs[index];
                    need(row.expose === true && row.path === selected.path && row.revision === selected.snapshot
                        && typeof row.identity?.size === "bigint" && row.identity.size >= 0n && row.identity.size <= 4096n,
                        "Original selected input required");
                    descriptors.push({ path: row.path, bytes: Number(row.identity.size), sha256: row.sha256 });
                }
            }
            builder = new TaskPackageBuilder(this.#borrow.request, this.#taskId, this.#snapshotId, descriptors);
            for (let index = 0; index < descriptors.length; index++) {
                let copy;
                try {
                    copy = await methods.copyFile.call(this.#capture, index); this.#copyBytes += copy.length;
                    this.#live(); this.#borrow.assertInputsCurrent(); builder.append(index, copy);
                } finally { if (copy) { copy.fill(0); this.#copyCleared += copy.length; copy = undefined; } }
            }
            bytes = builder.finish(); this.#allocated += bytes.length;
            this.#current(); this.#checkRoot();
            const file = path.join(this.#root, "task-package.bin");
            this.#fd = fs.openSync(file, "wx", 0o600); this.#opened++;
            const original = fs.fstatSync(this.#fd, { bigint: true }), identity = nativePrivateIdentity(original);
            need(original.isFile() && original.nlink === 1n && original.size === 0n
                && identity.slice(0, 9) === this.#rootId.slice(0, 9), "New task carrier shape");
            need(fs.writeSync(this.#fd, bytes, 0, bytes.length, 0) === bytes.length, "Short task carrier write");
            fs.fsyncSync(this.#fd);
            const after = fs.fstatSync(this.#fd, { bigint: true });
            need(nativePrivateIdentity(after) === identity && after.size === BigInt(bytes.length) && after.nlink === 1n,
                "Task carrier changed");
            this.#package = Object.freeze({ identity, bytes: bytes.length, sha256: hash(bytes) });
            this.#current();
        } catch (error) {
            failed = true; failure = error; this.#failed = true; this.#error = error; this.#revoked = true;
        } finally {
            if (this.#fd !== undefined && !this.#closeAttempted) {
                this.#closeAttempted = true;
                try { fs.closeSync(this.#fd); this.#fd = undefined; this.#closed++; }
                catch (error) { this.#closeFailed = true; this.#closeError = error; this.#revoked = true; }
            }
            if (bytes) { bytes.fill(0); this.#cleared += bytes.length; bytes = undefined; }
            if (builder) { builder.dispose(); this.#builderFinal = builder.diagnostics; builder = undefined; }
            descriptors.length = 0; this.#pending = false;
        }
        if (failed && this.#closeFailed) throw new AggregateError([failure, this.#closeError], "Task publication and close failed");
        if (failed) throw failure;
        if (this.#closeFailed) throw this.#closeError;
        this.#current(); this.#checkRoot(); return this;
    }
    get declaration() {
        this.#current(); need(this.#package && !this.#pending && this.#fd === undefined, "Task carrier unresolved");
        return Object.freeze({ protocol: "super-pi-task-publication-v1", taskId: this.#taskId, snapshotId: this.#snapshotId,
            timeoutMs: this.#borrow.request.timeoutMs, package: this.#package, tool: this.#tool });
    }
    readInstallation(expected) {
        this.#current();
        need(!this.#pending && this.#fd === undefined && !this.#receiptAttempted && this.#phase === 1, "One task installation receipt");
        this.#receiptAttempted = true;
        let bytes, result, failed = false, failure;
        try {
            this.#checkRoot();
            const file = path.join(this.#root, "task-input-receipt.json");
            const before = fs.lstatSync(file, { bigint: true });
            need(before.isFile() && !before.isSymbolicLink() && before.nlink === 1n && before.size > 0n && before.size <= 4096n
                && fs.realpathSync(file) === file, "Task installation receipt shape");
            this.#receiptFd = fs.openSync(file, "r"); this.#receiptOpened = 1;
            const opened = fs.fstatSync(this.#receiptFd, { bigint: true });
            this.#receiptIdentity = nativePrivateIdentity(opened);
            need(opened.isFile() && opened.nlink === 1n && same(before, opened)
                && this.#receiptIdentity.slice(0, 9) === this.#rootId.slice(0, 9), "Task receipt changed on open");
            bytes = Buffer.alloc(Number(opened.size)); this.#allocated += bytes.length;
            need(fs.readSync(this.#receiptFd, bytes, 0, bytes.length, 0) === bytes.length, "Short task receipt");
            need(same(opened, fs.fstatSync(this.#receiptFd, { bigint: true })), "Task receipt changed while reading");
            result = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
            fields(result, "buffers,exchangeId,failure,handles,ids,installed,packageSha256,protocol,runnerSha256,snapshotId,taskId,volumePath");
            fields(result.ids, "package,packageCarrier,runner,runnerCarrier,tools,workspace");
            fields(result.handles, "closeUnknown,closed,errors,opened,peak,retained");
            fields(result.buffers, "allocated,cleared"); fields(result.failure, "capture,close,operation");
            need(result.protocol === "super-pi-task-install-v1" && result.taskId === this.#taskId && result.taskId === expected.taskId
                && result.snapshotId === this.#snapshotId && result.volumePath === expected.volumePath
                && result.exchangeId === expected.exchangeId && result.installed === true
                && result.packageSha256 === this.#package.sha256 && result.runnerSha256 === this.#tool.sha256, "Task installation association");
            need(result.ids.packageCarrier === this.#package.identity && result.ids.runnerCarrier === this.#tool.identity,
                "Original task carriers changed");
            const ids = [result.exchangeId, result.ids.workspace, result.ids.tools, result.ids.package, result.ids.runner];
            need(ids.every(value => typeof value === "string" && /^[0-9A-F]{8}:[0-9A-F]{16}$/.test(value)
                && value.slice(0, 9) === result.exchangeId.slice(0, 9)) && new Set(ids).size === 5, "Task destination identities");
            const handles = result.handles;
            need(handles.opened === 7 && handles.closed === 7 && handles.peak === 4 && handles.closeUnknown === false
                && Array.isArray(handles.retained) && handles.retained.length === 7 && handles.retained.every(value => value === null)
                && Array.isArray(handles.errors) && handles.errors.length === 7 && handles.errors.every(value => value === null),
                "Task native installation closure");
            need(result.buffers.allocated === this.#package.bytes + this.#tool.bytes && result.buffers.cleared === result.buffers.allocated
                && Object.values(result.failure).every(value => value === null), "Task native buffer settlement");
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
            if (bytes) { bytes.fill(0); this.#cleared += bytes.length; bytes = undefined; }
        }
        if (failed && this.#closeFailed) throw new AggregateError([failure, this.#closeError], "Task receipt and close failed");
        if (failed) throw failure;
        if (this.#closeFailed) throw this.#closeError;
        this.#current(); return result;
    }
    async renew(phase) {
        this.#current();
        need(!this.#pending && this.#package && ["install", "dispatch", "execute"][this.#phase] === phase, "Task publication phase");
        this.#phase++; this.#pending = true;
        try {
            if (this.#capture) await methods.renewPublication.call(this.#capture);
            this.#current(); return true;
        } catch (error) { if (!this.#failed) { this.#failed = true; this.#error = error; } this.#revoked = true; throw error; }
        finally { this.#pending = false; }
    }
    assertCurrent() {
        need(!this.#pending && this.#fd === undefined && this.#receiptFd === undefined, "Task publication operation pending");
        return this.#current();
    }
    revoke() { this.#revoked = true; if (this.#capture) methods.revoke.call(this.#capture); }
    dispose() {
        if (this.#disposed) return;
        need(!this.#pending && this.#fd === undefined && this.#receiptFd === undefined && !this.#closeFailed && !this.#disposeAttempted,
            "Task publication responsibility unresolved");
        this.#disposeAttempted = true; this.#revoked = true;
        if (this.#capture) {
            need(methods.dispose.call(this.#capture) === true, "Original task capture cleanup unresolved");
            this.#captureFinal = diagnostics.call(this.#capture);
        }
        this.#capture = undefined; this.#metadata = undefined; this.#tool = undefined; this.#package = undefined; this.#borrow = undefined;
        this.#root = undefined; this.#rootId = undefined; this.#taskId = undefined; this.#snapshotId = undefined; this.#disposed = true;
    }
    get failure() { return { failed: this.#failed, error: this.#error, closeFailed: this.#closeFailed, closeError: this.#closeError }; }
    get diagnostics() {
        return { pending: this.#pending, revoked: this.#revoked, disposed: this.#disposed, phase: this.#phase,
            opened: this.#opened + this.#receiptOpened, closed: this.#closed + this.#receiptClosed,
            closeAttempts: Number(this.#closeAttempted) + Number(this.#receiptCloseAttempted),
            retainedFd: this.#fd !== undefined || this.#receiptFd !== undefined, fd: this.#fd ?? this.#receiptFd ?? null,
            receiptIdentity: this.#receiptIdentity ?? null, allocatedBytes: this.#allocated, clearedBytes: this.#cleared,
            copiedBytes: this.#copyBytes, copyClearedBytes: this.#copyCleared, builder: this.#builderFinal,
            retainedBorrow: this.#borrow !== undefined, retainedMetadata: !!this.#metadata, retainedPackage: !!this.#package,
            retainedCapture: this.#capture !== undefined, capture: this.#capture ? diagnostics.call(this.#capture) : this.#captureFinal,
            operationFailed: this.#failed, closeFailed: this.#closeFailed };
    }
}
