// Low-frequency preparation ONLY. No capture/copy authorization callback is exposed.
import { win32 as path } from "node:path";
import { SessionFiles } from "../../packages/coding-agent/src/core/files/session-files.ts";
import { SessionFileRevisionSource } from "../../packages/coding-agent/src/core/files/session-file-revision-source.ts";
import { createInputAuthority } from "./windows-sandbox-input-snapshot.mjs";
import { OriginalInputRevisionLease } from "./windows-sandbox-input-revision-lease.mjs";

const pinSource = SessionFiles.prototype.pinReadRevisions;
const pinPermission = SessionFiles.prototype.pinInputReadPermission;
const sourceRevisions = Object.getOwnPropertyDescriptor(SessionFileRevisionSource.prototype, "revisions").get;
const disposeSource = SessionFileRevisionSource.prototype.dispose;
function need(ok, reason) { if (!ok) throw new Error(reason); }
function sameId(a, b, file = false) {
    return !!b && a.dev === b.dev && a.ino === b.ino
        && (!file || a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs);
}
function sameBinding(a, b) {
    return !!b && a.taskId === b.taskId && a.snapshotId === b.snapshotId && a.sessionId === b.sessionId
        && a.epoch === b.epoch && a.sourceRoot.path === b.sourceRoot?.path && sameId(a.sourceRoot.identity, b.sourceRoot?.identity);
}
function sameEntries(expected, actual) {
    if (!Array.isArray(actual) || expected.length !== actual.length) return false;
    for (let i = 0; i < expected.length; i++) {
        const a = expected[i], b = actual[i];
        if (!b || a.path !== b.path || a.expose !== b.expose || a.operation !== b.operation || a.revision !== b.revision
            || a.sha256 !== b.sha256 || (a.identity === null ? b.identity !== null : !sameId(a.identity, b.identity, true))
            || !Array.isArray(b.parents) || a.parents.length !== b.parents.length) return false;
        for (let p = 0; p < a.parents.length; p++) if (a.parents[p].path !== b.parents[p]?.path
            || !sameId(a.parents[p].identity, b.parents[p]?.identity)) return false;
    }
    return true;
}
function pathsFor(authority) {
    const paths = [authority.binding.sourceRoot.path];
    for (const entry of authority.entries) {
        for (const parent of entry.parents) {
            const absolute = path.join(authority.binding.sourceRoot.path, parent.path);
            if (!paths.includes(absolute)) paths.push(absolute);
        }
        paths.push(path.join(authority.binding.sourceRoot.path, entry.path));
    }
    need(paths.length <= 34, "input read observation path budget");
    return Object.freeze(paths);
}

export class WindowsInputReadPreparation {
    #authority; #source; #lease; #permission;
    #state = "new"; #pending = false; #checking = false;
    #failed = false; #error; #checks = 0; #paths = 0;
    #permissionFinal; #leaseFinal; #sourceFinal;
    constructor(input, owner, ctx) {
        try {
            need(owner instanceof SessionFiles, "input read original session required");
            const authority = createInputAuthority(input);
            const entries = Object.freeze(authority.entries.map(entry => Object.freeze({ ...entry, classification: "ordinary" })));
            const canonical = Object.freeze({ ...authority.binding, entries, budget: authority.budget });
            this.#authority = authority;
            const paths = pathsFor(authority); this.#paths = paths.length;
            this.#source = pinSource.call(owner, ctx); // Dedicated source owned only here.
            this.#lease = new OriginalInputRevisionLease(canonical, sourceRevisions.call(this.#source), this.#sourceCurrent);
            this.#permission = pinPermission.call(owner, ctx, this.#source, paths); // Weak borrower.
            this.#checkOriginal();
        } catch (error) { this.#reject(error); throw error; }
    }
    #live() { need(this.#state === "new" || this.#state === "preparing" || this.#state === "prepared", "input read preparation inactive"); }
    #sourceCurrent = () => { this.#live(); const value = this.#source.current(); this.#live(); return value; };
    #checkOriginal() {
        this.#live();
        need(this.#lease.current(this.#authority.binding) === true, "input read original lease changed");
        this.#permission.checkSource();
        need(this.#lease.current(this.#authority.binding) === true, "input read original lease changed");
        this.#live();
    }
    async prepare() {
        if (this.#state !== "new" || this.#pending || this.#checking) {
            const error = new Error("input read preparation single-use"); this.#reject(error); throw error;
        }
        this.#pending = true; this.#state = "preparing";
        const permission = this.#permission; // Keeps only this pending owner until settle.
        try {
            this.#checkOriginal(); await permission.prepare(); this.#checkOriginal();
            permission.assertCurrent(); this.#checkOriginal(); this.#state = "prepared";
            this.checkPrepared(this.#authority.binding, this.#authority.entries);
            return Object.freeze({ status: "prepared", filesystemRenewed: false });
        } catch (error) { this.#reject(error); throw error; }
        finally { this.#pending = false; this.#permissionFinal = permission.diagnostics; }
    }
    /** Tests binding + original receipt + prepared policy validity; no filesystem
     * renewal. Deliberately not exposed as a WindowsInputCapture authorization. */
    checkPrepared(binding, entries) {
        this.#checks++;
        if (this.#checking) { const error = new Error("input read preparation reentry"); this.#reject(error); throw error; }
        this.#checking = true;
        try {
            need(this.#state === "prepared", "input read preparation unavailable");
            need(sameBinding(this.#authority.binding, binding) && sameEntries(this.#authority.entries, entries), "input read preparation namespace");
            this.#checkOriginal(); this.#permission.assertCurrent(); this.#checkOriginal();
            this.#permission.assertPolicyIdentity(); // No callbacks after the final original-receipt check.
            return true;
        } catch (error) { this.#reject(error); throw error; }
        finally { this.#checking = false; }
    }
    #release(state) {
        this.#state = state;
        if (this.#permission) { this.#permission.dispose(); this.#permissionFinal = this.#permission.diagnostics; this.#permission = undefined; }
        if (this.#lease) { this.#lease.dispose(); this.#leaseFinal = this.#lease.diagnostics; this.#lease = undefined; }
        if (this.#source) { disposeSource.call(this.#source); this.#sourceFinal = this.#source.diagnostics; this.#source = undefined; }
        this.#authority = undefined;
    }
    #reject(error) { if (!this.#failed) { this.#failed = true; this.#error = error; } this.#release("rejected"); }
    revoke() { this.#release("revoked"); }
    dispose() { this.#release("disposed"); }
    get status() { return this.#state; }
    get diagnostics() {
        return { state: this.#state, pending: this.#pending, checks: this.#checks, observationPaths: this.#paths,
            retainedAuthority: !!this.#authority, retainedSource: !!this.#source, retainedLease: !!this.#lease,
            retainedPermission: !!this.#permission, permission: this.#permission?.diagnostics ?? this.#permissionFinal,
            lease: this.#lease?.diagnostics ?? this.#leaseFinal, source: this.#source?.diagnostics ?? this.#sourceFinal };
    }
    get failure() { return { failed: this.#failed, error: this.#error }; }
}
