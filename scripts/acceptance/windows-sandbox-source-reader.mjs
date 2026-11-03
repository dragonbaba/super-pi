// Low-frequency acceptance foundation, not a SessionFiles/receipt bridge and not
// an installed OfflineInputSnapshotOwner adapter. The caller owns read buffers.
import { win32 as path } from "node:path";
import { createHash } from "node:crypto";
import { createInputAuthority } from "./windows-sandbox-input-snapshot.mjs";
import { WindowsSourceNative } from "./windows-sandbox-source-native.mjs";

export const SOURCE_LIMITS = Object.freeze({ ancestors: 32, handles: 82, openAttempts: 256,
    readCalls: 4096, readBytes: 16384, treeMetadata: 65536 });
const GUID = /^\\\\\?\\Volume\{[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}\}\\$/;
const MAX_U64 = (1n << 64n) - 1n;
function need(ok, message) { if (!ok) throw new Error(message); }
function same(a, b, file = false) {
    return a.dev === b.dev && a.ino === b.ino && (!file
        || a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs);
}
function rootIdentity(value) {
    need(value && Object.keys(value).sort().join(",") === "dev,ino"
        && typeof value.dev === "bigint" && value.dev >= 0n && value.dev <= 0xffffffffn
        && typeof value.ino === "bigint" && value.ino > 0n && value.ino <= MAX_U64, "source anchor identity");
    return Object.freeze({ dev: value.dev, ino: value.ino });
}

// For real use the operations must be WindowsSourceNative. Injection exists only
// for explicitly labelled lifecycle/error models, not as evidence of Windows I/O.
export class WindowsSourceReader {
    #authority; #anchor; #guard; #ops; #methods; #parts; #allowed; #directories; #contentState;
    #slots = []; #leaf; #state = "new"; #busy = false; #checking = false; #closing = false; #revoked = false;
    #operationFailed = false; #operationError; #unknown = false; #nativeFinal;
    #metrics = { openAttempts: 0, opened: 0, closed: 0, closeAttempts: 0, activeHandles: 0, peakHandles: 0,
        readCalls: 0, readBytes: 0, clearedBorrowedBytes: 0, retainedBorrowedBuffers: 0, metadataCharge: 0,
        contentOpens: 0, verifiedContents: 0 };
    constructor(input, anchor, guard, operations) {
        this.#authority = createInputAuthority(input);
        need(anchor && Object.keys(anchor).sort().join(",") === "drive,identity,volumePath"
            && /^[A-Z]:\\$/.test(anchor.drive) && GUID.test(anchor.volumePath), "source anchor");
        this.#anchor = Object.freeze({ drive: anchor.drive, volumePath: anchor.volumePath, identity: rootIdentity(anchor.identity) });
        const root = this.#authority.binding.sourceRoot;
        need(root.path.startsWith(anchor.drive) && root.identity.dev === anchor.identity.dev, "source anchor/root association");
        this.#parts = root.path.slice(3).split("\\");
        need(this.#parts.length <= SOURCE_LIMITS.ancestors, "source ancestor budget");
        this.#allowed = new Map(this.#authority.entries.map(entry => [entry.path, entry]));
        this.#contentState = new Map(this.#authority.entries.filter(entry => entry.expose).map(entry => [entry.path, "unread"]));
        this.#directories = new Map([["", { expected: root.identity, slot: undefined }]]);
        for (const entry of this.#authority.entries) for (const parent of entry.parents) {
            if (!this.#directories.has(parent.path)) this.#directories.set(parent.path, { expected: parent.identity, slot: undefined });
        }
        // Conservative metadata charge, not a V8/FFI heap measurement.
        let charge = 512 + 2 * (anchor.drive.length + anchor.volumePath.length);
        for (let i = 0; i < this.#parts.length; i++) charge += 384 + 4 * this.#parts.slice(0, i + 1).join("\\").length;
        for (const name of this.#directories.keys()) charge += 384 + 4 * (root.path.length + name.length);
        charge += 512;
        need(charge <= SOURCE_LIMITS.treeMetadata && this.#parts.length + this.#directories.size + 1 <= SOURCE_LIMITS.handles,
            "source tree budget");
        this.#metrics.metadataCharge = charge;
        need(typeof guard === "function" && operations && typeof operations === "object", "source host/operations");
        this.#methods = {};
        for (const name of ["volumeForDrive", "open", "inspect", "read", "close", "dispose"]) {
            need(typeof operations[name] === "function", "source operations"); this.#methods[name] = operations[name];
        }
        this.#guard = guard; this.#ops = operations;
    }
    #call(name, ...args) { return this.#methods[name].call(this.#ops, ...args); }
    #fail(error) {
        if (!this.#operationFailed) { this.#operationFailed = true; this.#operationError = error; }
        this.#revoked = true; if (!this.#unknown) this.#state = "rejected";
    }
    #host() {
        need(!this.#revoked && !this.#unknown && this.#ops, "source inactive");
        if (this.#checking) { this.#revoked = true; throw new Error("source guard reentry"); }
        this.#checking = true;
        try {
            const ok = this.#guard(this.#authority.binding);
            need(ok === true && !this.#revoked && !this.#unknown && this.#ops, "source host inactive");
        } finally { this.#checking = false; }
    }
    #run(action, initializing = false) {
        if (this.#busy || this.#closing) { this.#revoked = true; throw new Error("source reentry"); }
        need(initializing ? this.#state === "new" : this.#state === "ready", "source state");
        this.#busy = true;
        try {
            this.#host(); if (!initializing) this.#verifyDirectories();
            const result = action();
            this.#verifyDirectories(); this.#host(); return result;
        } catch (error) { this.#fail(error); throw error; }
        finally { this.#busy = false; }
    }
    #open(parent, name, kind, guidPath, dosPath, expected, allowMissing = false) {
        need(!this.#leaf && this.#metrics.openAttempts < SOURCE_LIMITS.openAttempts
            && this.#metrics.activeHandles < SOURCE_LIMITS.handles, "source open budget/busy");
        // Allocate and register responsibility before invoking native open.
        const slot = { handle: undefined, closeable: false, attempted: false, closeFailed: false, closeError: undefined,
            status: undefined, information: undefined, guidPath, dosPath, expected, original: undefined,
            kind, position: 0, digest: undefined, expectedHash: undefined, contentPath: undefined, verified: false, token: Object.freeze({}) };
        this.#slots.push(slot); this.#metrics.openAttempts++;
        let opened;
        try { opened = this.#call("open", slot, parent?.handle, name, kind); }
        finally {
            if (slot.handle !== undefined) {
                this.#metrics.opened++; this.#metrics.activeHandles++;
                this.#metrics.peakHandles = Math.max(this.#metrics.peakHandles, this.#metrics.activeHandles);
                if (!slot.closeable) { this.#unknown = true; this.#state = "unknown"; }
            }
        }
        if (!opened) {
            need(allowMissing && slot.handle === undefined && slot.status === (0xc0000034 | 0), "source component absent");
            this.#slots.pop(); return null;
        }
        need(slot.handle !== undefined && slot.closeable, "source missing handle");
        const value = this.#inspect(slot); slot.original = value.identity;
        if (kind !== "directory") this.#leaf = slot;
        return slot;
    }
    #inspect(slot) {
        const value = this.#call("inspect", slot.handle), directory = slot.kind === "directory";
        need(value && value.kind === (directory ? "directory" : "file") && value.reparseTag === 0
            // Only readonly/hidden/system/directory/archive/normal/not-indexed.
            && Number.isInteger(value.attributes) && value.attributes >= 0 && value.attributes <= 0xffffffff
            && (value.attributes & ~0x20b7) === 0 && value.guidPath === slot.guidPath && value.dosPath === slot.dosPath,
        "source type/reparse/canonical");
        need(value.identity.dev === this.#anchor.identity.dev && value.identity.ino > 0n
            && (!slot.expected || same(slot.expected, value.identity, !directory))
            && (!slot.original || same(slot.original, value.identity, true)), "source identity/metadata changed");
        if (!directory) need(value.nlink === 1 && value.identity.size >= 0n
            && value.identity.size <= BigInt(this.#authority.budget.fileBytes), "source link/size");
        else for (const old of this.#slots) if (old !== slot && old.kind === "directory" && old.original) {
            need(!same(old.original, value.identity), "source directory alias");
        }
        return value;
    }
    #verifyDirectories() {
        need(this.#call("volumeForDrive", this.#anchor.drive) === this.#anchor.volumePath, "source drive mapping changed");
        for (const slot of this.#slots) if (slot.kind === "directory" && slot.handle !== undefined) this.#inspect(slot);
    }
    initialize() {
        return this.#run(() => {
            need(this.#call("volumeForDrive", this.#anchor.drive) === this.#anchor.volumePath, "source drive mapping changed");
            const anchor = this.#anchor;
            let guid = anchor.volumePath, dos = "\\\\?\\" + anchor.drive;
            let parent = this.#open(undefined, "\\??\\" + guid.slice(4), "directory", guid, dos, anchor.identity);
            for (const part of this.#parts) {
                guid += (guid.endsWith("\\") ? "" : "\\") + part;
                dos += (dos.endsWith("\\") ? "" : "\\") + part;
                const expected = guid === anchor.volumePath + this.#parts.join("\\") ? this.#authority.binding.sourceRoot.identity : undefined;
                parent = this.#open(parent, part, "directory", guid, dos, expected);
            }
            this.#directories.get("").slot = parent; this.#state = "ready"; return this;
        }, true);
    }
    #directoryName(name) {
        const value = this.#directories?.get(name);
        if (!value) { const error = new Error("source unapproved directory"); this.#fail(error); throw error; }
        return value;
    }
    #entry(name, expose = false) {
        const value = this.#allowed?.get(name);
        if (!value || (expose && (!value.expose || value.operation === "add"))) {
            const error = new Error("source unapproved read/path"); this.#fail(error); throw error;
        }
        return value;
    }
    #parent(name) {
        let current = this.#directories.get("").slot, relative = "";
        if (!name) return current;
        for (const part of name.split("/")) {
            relative += (relative ? "/" : "") + part;
            const record = this.#directoryName(relative);
            if (!record.slot) record.slot = this.#open(current, part, "directory",
                current.guidPath + "\\" + part, current.dosPath + "\\" + part, record.expected);
            current = record.slot; this.#inspect(current);
        }
        return current;
    }
    directory(name) {
        this.#directoryName(name);
        return this.#run(() => {
            const value = this.#inspect(this.#parent(name));
            return { kind: "directory", reparseTag: 0, canonicalPath: path.join(this.#authority.binding.sourceRoot.path, name),
                identity: { dev: value.identity.dev, ino: value.identity.ino } };
        });
    }
    #fileSlot(entry, reading) {
        const split = entry.path.lastIndexOf("/"), parentName = split < 0 ? "" : entry.path.slice(0, split);
        const basename = entry.path.slice(split + 1), parent = this.#parent(parentName);
        const slot = this.#open(parent, basename, reading ? "read" : "metadata", parent.guidPath + "\\" + basename,
            parent.dosPath + "\\" + basename, entry.identity, entry.operation === "add");
        need(entry.operation !== "add" || slot === null, "source add target appeared");
        if (reading) {
            slot.digest = createHash("sha256"); slot.expectedHash = entry.sha256; slot.contentPath = entry.path;
            this.#contentState.set(entry.path, "opened"); this.#metrics.contentOpens++;
            if (slot.expected.size === 0n) this.#finishHash(slot);
        }
        return slot;
    }
    #finishHash(slot) {
        need(slot.digest.digest("hex") === slot.expectedHash, "source original hash changed");
        slot.digest = undefined; slot.verified = true; this.#contentState.set(slot.contentPath, "verified"); this.#metrics.verifiedContents++;
    }
    #fileValue(slot) {
        const value = this.#inspect(slot);
        return { kind: "file", reparseTag: 0, nlink: value.nlink, canonicalPath: value.dosPath.slice(4), identity: value.identity };
    }
    #close(slot) {
        if (slot.handle === undefined) return true;
        if (slot.attempted || !slot.closeable) { this.#unknown = true; this.#state = "unknown"; return false; }
        slot.attempted = true; slot.digest = undefined; this.#metrics.closeAttempts++;
        try {
            need(this.#call("close", slot.handle) === true, "source close result");
            slot.handle = undefined; this.#metrics.closed++; this.#metrics.activeHandles--;
            slot.digest = undefined;
            if (this.#leaf === slot) this.#leaf = undefined;
            // Keep no closed file tokens/path records. Directory slots remain until settlement.
            if (slot.kind !== "directory") this.#slots.splice(this.#slots.indexOf(slot), 1);
            return true;
        } catch (error) {
            slot.closeFailed = true; slot.closeError = error; this.#unknown = true; this.#state = "unknown"; return false;
        }
    }
    file(name) {
        const entry = this.#entry(name);
        return this.#run(() => {
            const slot = this.#fileSlot(entry, false); if (!slot) return null;
            let value;
            try { value = this.#fileValue(slot); }
            catch (error) { this.#fail(error); throw error; }
            finally { if (!this.#close(slot)) throw new Error("source close unknown"); }
            return value;
        });
    }
    open(name) {
        const entry = this.#entry(name, true);
        if (this.#contentState?.get(name) !== "unread") {
            const error = new Error("source content single-use"); this.#fail(error); throw error;
        }
        return this.#run(() => this.#fileSlot(entry, true).token);
    }
    #token(token) {
        need(this.#leaf && this.#leaf.token === token && this.#leaf.handle !== undefined
            && this.#leaf.kind === "read" && !this.#leaf.attempted, "source token"); return this.#leaf;
    }
    stat(token) { return this.#run(() => this.#fileValue(this.#token(token))); }
    read(token, bytes, offset, length) {
        let clear = false;
        try {
            return this.#run(() => {
                const slot = this.#token(token);
                need(Buffer.isBuffer(bytes) && Number.isInteger(offset) && Number.isInteger(length) && offset >= 0
                    && length > 0 && offset + length <= bytes.length, "source borrowed buffer");
                need(slot.position + length <= Number(slot.expected.size) && this.#metrics.readCalls < SOURCE_LIMITS.readCalls
                    && this.#metrics.readBytes + length <= this.#authority.budget.totalBytes, "source read budget");
                this.#inspect(slot); clear = true; this.#metrics.readCalls++;
                const count = this.#call("read", slot.handle, bytes, offset, length);
                need(Number.isInteger(count) && count > 0 && count <= length, "source read count");
                slot.digest.update(bytes.subarray(offset, offset + count));
                slot.position += count; this.#metrics.readBytes += count;
                if (slot.position === Number(slot.expected.size)) this.#finishHash(slot);
                this.#inspect(slot); return count;
            });
        } catch (error) {
            // Native may already have written caller memory when a post-read
            // metadata/guard check fails. Clear the entire requested slice.
            if (clear) { bytes.fill(0, offset, offset + length); this.#metrics.clearedBorrowedBytes += length; }
            throw error;
        }
    }
    close(token) {
        const slot = this.#token(token);
        try {
            if (this.#state === "ready" && !this.#revoked) this.#run(() => {
                this.#inspect(slot); need(slot.verified, "source incomplete content read");
            });
        } finally { if (!this.#close(slot)) throw new Error("source close unknown"); }
        return true;
    }
    closeAll() {
        this.#revoked = true;
        if (this.#busy || this.#closing) return false;
        if (!this.#ops) return !this.#unknown;
        this.#closing = true;
        try {
            // Reverse order, including partial opens; never retry attempted slots.
            for (let i = this.#slots.length - 1; i >= 0; i--) this.#close(this.#slots[i]);
            if (this.#unknown) return false;
            this.#nativeFinal = this.#ops.diagnostics;
            this.#call("dispose"); this.#nativeFinal = this.#ops.diagnostics;
            this.#slots.length = 0; this.#leaf = undefined; this.#methods = undefined; this.#ops = undefined;
            this.#authority = undefined; this.#anchor = undefined; this.#parts = undefined;
            this.#allowed = undefined; this.#directories = undefined; this.#contentState = undefined; this.#guard = undefined;
            this.#state = "closed"; return true;
        } finally { this.#closing = false; }
    }
    // Final validation is explicit and occurs before closeAll. Success is only
    // the conjunction of this check AND confirmed closeAll, never a byte receipt.
    settle() {
        this.#run(() => {
            need(!this.#leaf && this.#metrics.contentOpens === this.#metrics.verifiedContents, "source outstanding/incomplete leaf");
            for (const state of this.#contentState.values()) need(state === "verified", "source unread exposed content");
            for (const entry of this.#authority.entries) {
                const slot = this.#fileSlot(entry, false);
                if (slot && !this.#close(slot)) throw new Error("source close unknown");
            }
        });
        return this.closeAll();
    }
    dispose() { return this.closeAll(); }
    get status() { return this.#state; }
    get diagnostics() { return { ...this.#metrics, status: this.#state, cleanup: this.#unknown ? "unknown" : this.#ops ? "pending" : "complete",
        retainedSlots: this.#slots.length, retainedContext: this.#authority !== undefined, retainedOperations: this.#ops !== undefined,
        retainedGuard: this.#guard !== undefined, retainedContentStates: this.#contentState?.size ?? 0,
        native: this.#ops?.diagnostics ?? this.#nativeFinal }; }
    get failure() { return { operationFailed: this.#operationFailed, operationError: this.#operationError,
        unresolved: this.#slots.filter(slot => slot.handle !== undefined).map(slot => ({ handle: slot.handle,
            token: slot.token, status: slot.status, information: slot.information, guidPath: slot.guidPath,
            attempted: slot.attempted, closeable: slot.closeable, closeFailed: slot.closeFailed, closeError: slot.closeError })) }; }
}

export function createWindowsSourceReader(input, anchor, guard) {
    // Validate all context/path budgets before even binding native functions.
    // The constructor is reused once with inert fixed methods, without any call.
    const validation = new WindowsSourceReader(input, anchor, guard,
        { volumeForDrive() {}, open() {}, inspect() {}, read() {}, close() {}, dispose() {} });
    validation.dispose();
    const ops = new WindowsSourceNative();
    try { return new WindowsSourceReader(input, anchor, guard, ops); }
    catch (error) { ops.dispose(); throw error; }
}
