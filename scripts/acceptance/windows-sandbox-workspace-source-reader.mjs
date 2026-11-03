// Acceptance-only grant/source/native composition. A sealed reader retains its
// original guards for the owning capture's renewal; no source ownership escapes.
import { win32 as path } from "node:path";
import { SessionFiles } from "../../packages/coding-agent/src/core/files/session-files.ts";
import { SessionFileRevisionSource } from "../../packages/coding-agent/src/core/files/session-file-revision-source.ts";
import { createInputAuthority } from "./windows-sandbox-input-snapshot.mjs";
import { OriginalInputRevisionLease } from "./windows-sandbox-input-revision-lease.mjs";
import { WindowsSourceReader } from "./windows-sandbox-source-reader.mjs";
import { WindowsSourceNative } from "./windows-sandbox-source-native.mjs";

const pinSource = SessionFiles.prototype.pinReadRevisions;
const pinPermission = SessionFiles.prototype.pinInputWorkspacePermission;
const sourceRevisions = Object.getOwnPropertyDescriptor(SessionFileRevisionSource.prototype, "revisions").get;
const disposeSource = SessionFileRevisionSource.prototype.dispose;
const nativeMethods = Object.freeze(Object.fromEntries(["volumeForDrive", "open", "inspect", "read", "close", "dispose"]
    .map(name => [name, WindowsSourceNative.prototype[name]])));
const nativeDiagnostics = Object.getOwnPropertyDescriptor(WindowsSourceNative.prototype, "diagnostics").get;
const inert = Object.freeze({ volumeForDrive() {}, open() {}, inspect() {}, read() {}, close() {}, dispose() {} });
function validationGuard() { return true; }
function need(ok, reason) { if (!ok) throw new Error(reason); }
function same(a, b) { return a && b && a.dev === b.dev && a.ino === b.ino; }
function pathsFor(authority) {
    const paths = [authority.binding.sourceRoot.path];
    for (const entry of authority.entries) {
        for (const parent of entry.parents) {
            const absolute = path.join(authority.binding.sourceRoot.path, parent.path);
            if (!paths.includes(absolute)) paths.push(absolute);
        }
        paths.push(path.join(authority.binding.sourceRoot.path, entry.path));
    }
    need(paths.length <= 34, "workspace source path budget"); return Object.freeze(paths);
}
function association(authority, anchor, grant) {
    const root = authority.binding.sourceRoot;
    need(grant.requestedPath === grant.canonicalPath && path.parse(grant.canonicalPath).root === anchor.drive
        && root.identity.dev === anchor.identity.dev && grant.identity.dev === anchor.identity.dev,
    "workspace source drive/device association");
    // Exact components, including the separator. C:\\work is not C:\\workspace.
    need(root.path === grant.canonicalPath || root.path.startsWith(grant.canonicalPath + "\\"), "workspace source grant ancestor");
    if (root.path === grant.canonicalPath) need(same(root.identity, grant.identity), "workspace source original expected identity");
    for (const target of pathsFor(authority)) need(target === grant.canonicalPath || target.startsWith(grant.canonicalPath + "\\"),
        "workspace source single grant coverage");
}

// Sole HANDLE owner remains WindowsSourceReader. This adapter borrows its slot
// for one open and stores no slot, HANDLE, token, parent, or caller byte buffer.
class GrantOperations {
    #ops; #methods; #native; #guard; #grant; #matches = 0; #disposed = false; #disposeAttempted = false;
    #disposeFailed = false; #disposeError; #final;
    constructor(ops, native, grant, guard) {
        this.#ops = ops; this.#native = native; this.#grant = grant; this.#guard = guard;
        this.#methods = native ? nativeMethods : Object.freeze(Object.fromEntries(Object.keys(nativeMethods).map(name => {
            need(typeof ops[name] === "function", "workspace source model operation"); return [name, ops[name]];
        })));
    }
    #call(name, args) { return this.#methods[name].apply(this.#ops, args); }
    #check() { need(!this.#disposed && !this.#disposeAttempted && this.#guard() === true, "workspace source operations inactive"); }
    volumeForDrive(drive) {
        this.#check(); const result = this.#call("volumeForDrive", [drive]); this.#check(); return result;
    }
    open(slot, parent, name, kind) {
        this.#check();
        if (kind === "directory" && slot.dosPath === "\\\\?\\" + this.#grant.canonicalPath) {
            need(this.#matches === 0 && (!slot.expected || same(slot.expected, this.#grant.identity)), "workspace source grant slot conflict");
            // Existing sourceRoot/anchor expectation may not be silently replaced.
            slot.expected = this.#grant.identity; this.#matches++;
        }
        if (kind !== "directory") need(this.#matches === 1, "workspace source grant not opened exactly once");
        const result = this.#call("open", [slot, parent, name, kind]); this.#check(); return result;
    }
    inspect(handle) { this.#check(); const result = this.#call("inspect", [handle]); this.#check(); return result; }
    read(handle, bytes, offset, length) {
        this.#check(); need(this.#matches === 1, "workspace source grant read gate");
        const result = this.#call("read", [handle, bytes, offset, length]); this.#check(); return result;
    }
    close(handle) { return this.#call("close", [handle]); }
    dispose() {
        if (this.#disposeAttempted) { if (this.#disposeFailed) throw this.#disposeError; return; }
        this.#disposeAttempted = true;
        try {
            this.#call("dispose", []);
            this.#final = this.#native ? nativeDiagnostics.call(this.#ops) : this.#ops.diagnostics;
            this.#disposed = true; this.#ops = undefined; this.#methods = undefined; this.#guard = undefined; this.#grant = undefined;
        } catch (error) { this.#disposeFailed = true; this.#disposeError = error; throw error; }
    }
    get diagnostics() {
        return { matches: this.#matches, retainedSlots: 0, retainedBorrowedBuffers: 0, retainedOperations: !!this.#ops,
            retainedGuard: !!this.#guard, retainedGrant: !!this.#grant, disposeAttempted: this.#disposeAttempted,
            disposed: this.#disposed, native: this.#ops ? this.#native ? nativeDiagnostics.call(this.#ops) : this.#ops.diagnostics : this.#final };
    }
}

export class WindowsWorkspaceSourceReader {
    #authority; #canonical; #anchor; #source; #lease; #permission; #reader; #operations; #model;
    #state = "new"; #pending = false; #busy = false; #checking = false; #revoked = false; #disposeRequested = false;
    #cleanup = "complete"; #cleanupAttempted = false; #modelDisposeAttempted = false;
    #failed = false; #error; #cleanupFailed = false; #cleanupError;
    #checks = 0; #clearedBorrowedBytes = 0; #deliveredBytes = 0; #renewals = 0;
    #permissionFinal; #sourceFinal; #leaseFinal; #readerFinal; #operationsFinal; #nativeFailure;
    constructor(input, anchor, owner, ctx, modelOperations) {
        try {
            need(owner instanceof SessionFiles, "workspace source original SessionFiles required");
            this.#authority = createInputAuthority(input);
            this.#canonical = Object.freeze({ ...this.#authority.binding, budget: this.#authority.budget,
                entries: Object.freeze(this.#authority.entries.map(entry => Object.freeze({ ...entry, classification: "ordinary" }))) });
            need(anchor && Object.keys(anchor).sort().join(",") === "drive,identity,volumePath", "workspace source anchor schema");
            this.#anchor = Object.freeze({ drive: anchor.drive, volumePath: anchor.volumePath,
                identity: Object.freeze({ dev: anchor.identity?.dev, ino: anchor.identity?.ino }) });
            const validation = new WindowsSourceReader(this.#canonical, this.#anchor, validationGuard, inert);
            validation.dispose(); // No native binding, handles or source access.
            this.#source = pinSource.call(owner, ctx); // Dedicated, never shared with preparation/capture.
            this.#lease = new OriginalInputRevisionLease(this.#canonical, sourceRevisions.call(this.#source), this.#sourceCurrent);
            this.#permission = pinPermission.call(owner, ctx, this.#source, pathsFor(this.#authority));
            this.#model = modelOperations; // Explicit lifecycle/error models only; no handles before initialize.
            this.#checkOriginal(); this.#permission.checkSource(); this.#checkOriginal();
        } catch (error) { this.#reject(error); throw error; }
    }
    #live() { need(!this.#revoked && !this.#disposeRequested, "workspace source inactive"); }
    #save(error) { if (!this.#failed) { this.#failed = true; this.#error = error; } }
    #sourceCurrent = () => { this.#live(); const value = this.#source.current(); this.#live(); return value; };
    #checkOriginal = () => {
        this.#live(); need(this.#lease.current(this.#authority.binding) === true, "workspace source original receipt changed"); this.#live();
    };
    #guard = () => {
        this.#checks++;
        if (this.#checking) { this.#revoked = true; throw new Error("workspace source guard reentry"); }
        this.#checking = true;
        try {
            this.#checkOriginal(); this.#permission.assertCurrent(); this.#checkOriginal();
            this.#permission.assertIdentity(); this.#live(); return true;
        } catch (error) { this.#save(error); this.#revoked = true; throw error; }
        finally { this.#checking = false; }
    };
    async prepare() {
        if (this.#state !== "new" || this.#pending || this.#busy || this.#checking) {
            const error = new Error("workspace source preparation single-use"); this.#revoked = true; this.#save(error);
            if (!this.#pending && !this.#busy && !this.#checking) this.#reject(error);
            throw error;
        }
        this.#pending = true; this.#state = "preparing";
        const permission = this.#permission;
        try {
            this.#checkOriginal(); await permission.prepare(this.#checkOriginal); this.#checkOriginal();
            this.#guard(); association(this.#authority, this.#anchor, permission.binding); this.#guard();
            this.#state = "prepared"; return Object.freeze({ status: "prepared", nativeInitialized: false });
        } catch (error) { this.#reject(error); throw error; }
        finally { this.#pending = false; this.#permissionFinal = permission.diagnostics; }
    }
    #start() {
        if (this.#busy || this.#checking || this.#pending) {
            const error = new Error("workspace source reentry"); this.#save(error); this.#revoked = true; throw error;
        }
        this.#live(); this.#busy = true;
    }
    initialize() {
        this.#start();
        try {
            need(this.#state === "prepared", "workspace source initialize state"); this.#guard();
            const grant = this.#permission.binding;
            association(this.#authority, this.#anchor, grant); this.#guard();
            const ops = this.#model ?? new WindowsSourceNative();
            this.#operations = new GrantOperations(ops, !this.#model, grant, this.#guard); this.#model = undefined;
            this.#cleanup = "pending";
            this.#reader = new WindowsSourceReader(this.#canonical, this.#anchor, this.#guard, this.#operations);
            this.#reader.initialize(); this.#guard(); this.#state = "ready"; return this;
        } catch (error) { this.#reject(error); throw error; }
        finally { this.#busy = false; }
    }
    #run(name, args) {
        this.#start();
        try {
            need(this.#state === "ready", "workspace source reader unavailable"); this.#guard();
            const value = this.#reader[name](...args); this.#guard(); return value;
        } catch (error) { this.#reject(error); throw error; }
        finally { this.#busy = false; }
    }
    directory(name) { return this.#run("directory", [name]); }
    file(name) { return this.#run("file", [name]); }
    open(name) { return this.#run("open", [name]); }
    stat(token) { return this.#run("stat", [token]); }
    close(token) { return this.#run("close", [token]); }
    read(token, bytes, offset, length) {
        this.#start(); let borrowed = false;
        try {
            need(this.#state === "ready", "workspace source read unavailable"); this.#guard();
            need(Buffer.isBuffer(bytes) && Number.isInteger(offset) && Number.isInteger(length) && offset >= 0
                && length > 0 && offset + length <= bytes.length, "workspace source borrowed slice");
            borrowed = true;
            const count = this.#reader.read(token, bytes, offset, length);
            this.#guard(); this.#deliveredBytes += count; return count;
        } catch (error) {
            // The old reader's own catch cannot clear a successful read rejected
            // HERE. Clear before remaining cleanup, including overlapping clears.
            if (borrowed) { bytes.fill(0, offset, offset + length); this.#clearedBorrowedBytes += length; }
            this.#reject(error); throw error;
        } finally { this.#busy = false; }
    }
    settle() { return this.#settle(false); }
    /** All native resources close first. Guards remain owned by this instance;
     * sealed state cannot read/reinitialize and is not a captured publication. */
    seal() { return this.#settle(true); }
    #settle(retainGuards) {
        this.#start();
        try {
            need(this.#state === "ready", "workspace source settle unavailable"); this.#guard();
            let returned = false;
            try { this.#cleanup = this.#reader.settle() === true ? "complete" : "unknown"; returned = true; }
            catch (error) {
                if (this.#reader.diagnostics.activeHandles === 0) {
                    this.#cleanup = "unknown"; this.#cleanupFailed = true; this.#cleanupError = error;
                }
                throw error;
            } finally {
                if (returned || this.#reader.diagnostics.activeHandles === 0) this.#cleanupAttempted = true;
            }
            this.#snapshotNative();
            need(this.#cleanup === "complete" && this.#readerFinal.cleanup === "complete", "workspace source close unknown");
            this.#guard(); this.#state = retainGuards ? "sealed" : "settled";
            if (!retainGuards) this.#releaseGuards();
            this.#releaseKnown();
            return Object.freeze({ status: this.#state, cleanup: "complete" });
        } catch (error) { this.#reject(error); throw error; }
        finally { this.#busy = false; }
    }
    #verifySnapshot(binding, entry, revision) {
        this.#start();
        try {
            need(this.#state === "prepared" || this.#state === "ready" || this.#state === "sealed", "workspace source snapshot state");
            this.#guard();
            need(revision ? this.#lease.revision(entry, binding) === true : this.#lease.current(binding) === true,
                "workspace source original snapshot changed");
            this.#guard(); return true;
        } catch (error) { this.#reject(error); throw error; }
        finally { this.#busy = false; }
    }
    assertSnapshot(binding) { return this.#verifySnapshot(binding, undefined, false); }
    assertRevision(entry, binding) { return this.#verifySnapshot(binding, entry, true); }
    async renew() {
        this.#start();
        const permission = this.#permission;
        try {
            need(this.#state === "sealed" && this.#cleanup === "complete" && !this.#reader && !this.#operations,
                "workspace source renewal requires all native resources closed");
            this.#guard(); this.#pending = true; this.#renewals++;
            await permission.renew(this.#checkOriginal);
            this.#checkOriginal(); this.#guard();
            return Object.freeze({ status: "sealed", cleanup: "complete" });
        } catch (error) { this.#reject(error); throw error; }
        finally {
            this.#pending = false; this.#busy = false;
            if (permission) this.#permissionFinal = permission.diagnostics;
        }
    }
    #snapshotNative() {
        if (this.#reader) { this.#readerFinal = this.#reader.diagnostics; this.#nativeFailure = this.#reader.failure; }
        if (this.#operations) this.#operationsFinal = this.#operations.diagnostics;
    }
    #closeNative() {
        if (!this.#cleanupAttempted && (this.#reader || this.#operations)) {
            this.#cleanupAttempted = true;
            try { this.#cleanup = this.#reader ? this.#reader.closeAll() === true ? "complete" : "unknown" : (this.#operations.dispose(), "complete"); }
            catch (error) { this.#cleanupFailed = true; this.#cleanupError = error; this.#cleanup = "unknown"; }
        }
        if (this.#model && !this.#modelDisposeAttempted) {
            this.#modelDisposeAttempted = true;
            try { this.#model.dispose(); this.#model = undefined; }
            catch (error) { this.#cleanupFailed = true; this.#cleanupError = error; this.#cleanup = "unknown"; }
        }
        this.#snapshotNative();
        if (this.#readerFinal && this.#readerFinal.cleanup !== "complete") this.#cleanup = "unknown";
    }
    #releaseGuards() {
        if (this.#permission) { this.#permission.dispose(); this.#permissionFinal = this.#permission.diagnostics; this.#permission = undefined; }
        if (this.#lease) { this.#lease.dispose(); this.#leaseFinal = this.#lease.diagnostics; this.#lease = undefined; }
        if (this.#source) { disposeSource.call(this.#source); this.#sourceFinal = this.#source.diagnostics; this.#source = undefined; }
        // Unknown retains canonical responsibility alongside its original reader.
        if (this.#cleanup === "complete") { this.#authority = undefined; this.#canonical = undefined; this.#anchor = undefined; }
    }
    #releaseKnown() {
        if (this.#cleanup === "complete") { this.#reader = undefined; this.#operations = undefined; this.#model = undefined; }
    }
    #reject(error) {
        this.#save(error); this.#revoked = true; this.#closeNative(); this.#releaseGuards(); this.#releaseKnown();
        this.#state = this.#cleanup === "complete" ? this.#disposeRequested ? "disposed" : "rejected" : "unknown";
    }
    revoke() {
        this.#revoked = true;
        if (this.#busy || this.#checking || this.#pending) return;
        this.#closeNative(); this.#releaseGuards(); this.#releaseKnown();
        this.#state = this.#cleanup === "complete" ? this.#disposeRequested ? "disposed" : "revoked" : "unknown";
    }
    dispose() { this.#disposeRequested = true; this.revoke(); return this.#cleanup === "complete" && !this.#busy && !this.#pending; }
    get status() { return this.#state; }
    get diagnostics() {
        return { status: this.#state, pending: this.#pending, busy: this.#busy, checks: this.#checks, renewals: this.#renewals,
            cleanup: this.#busy || this.#pending ? "pending" : this.#cleanup, cleanupAttempted: this.#cleanupAttempted,
            deliveredBytes: this.#deliveredBytes, clearedBorrowedBytes: this.#clearedBorrowedBytes, retainedBorrowedBuffers: 0,
            retainedSource: !!this.#source, retainedLease: !!this.#lease, retainedPermission: !!this.#permission,
            retainedReader: !!this.#reader, retainedOperations: !!this.#operations, retainedModel: !!this.#model,
            retainedAuthority: !!this.#authority, retainedCanonical: !!this.#canonical,
            permission: this.#permission?.diagnostics ?? this.#permissionFinal, source: this.#source?.diagnostics ?? this.#sourceFinal,
            lease: this.#lease?.diagnostics ?? this.#leaseFinal, reader: this.#reader?.diagnostics ?? this.#readerFinal,
            operations: this.#operations?.diagnostics ?? this.#operationsFinal };
    }
    get failure() {
        return { failed: this.#failed, error: this.#error, cleanupFailed: this.#cleanupFailed, cleanupError: this.#cleanupError,
            native: this.#reader?.failure ?? this.#nativeFailure };
    }
}
