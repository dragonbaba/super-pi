// Acceptance-only bridge. The trusted host supplies an existing original owner and
// a synchronous lifecycle guard. No filesystem reader or production hook is installed.
import { win32 as path } from "node:path";
import { FileRevisions } from "../../packages/coding-agent/src/core/files/snapshot-line-edit.ts";
import { createInputAuthority } from "./windows-sandbox-input-snapshot.mjs";

const getReceipt = FileRevisions.prototype.get;
const assertReceipt = FileRevisions.prototype.assertCurrent;
const generation = Object.getOwnPropertyDescriptor(FileRevisions.prototype, "generation").get;
const identityKeys = ["dev", "ino", "size", "mtimeNs", "ctimeNs"];
function sameIdentity(a, b, file = false) {
    if (!a || !b || a.dev !== b.dev || a.ino !== b.ino) return false;
    return !file || identityKeys.every(key => a[key] === b[key]);
}
function sameBinding(a, b) {
    return b !== null && typeof b === "object" && a.taskId === b.taskId && a.snapshotId === b.snapshotId
        && a.sessionId === b.sessionId && a.epoch === b.epoch && a.sourceRoot.path === b.sourceRoot?.path
        && sameIdentity(a.sourceRoot.identity, b.sourceRoot?.identity);
}
function sameEntry(a, b) {
    return b !== null && typeof b === "object" && a.path === b.path && a.revision === b.revision
        && a.operation === b.operation && a.expose === b.expose && a.sha256 === b.sha256
        && (a.identity === null ? b.identity === null : sameIdentity(a.identity, b.identity, true))
        && Array.isArray(b.parents) && a.parents.length === b.parents.length
        && a.parents.every((parent, i) => parent.path === b.parents[i]?.path
            && sameIdentity(parent.identity, b.parents[i]?.identity));
}

/** Membership lease, not a receipt issuer or authenticity boundary against host code.
 * FileRevisions.remember is public. The host must supply the original issued IDs.
 * Weak references avoid extending retired receipt/Buffer lifetime; a host callback
 * must not capture those objects unnecessarily. This lease never reads receipt bytes.
 */
export class OriginalInputRevisionLease {
    #authority; #owner; #pins = []; #guard; #state = "active"; #checking = false;
    #checks = 0; #receiptChecks = 0; #guardCalls = 0; #reason;
    constructor(input, owner, assertHostCurrent) {
        this.#authority = createInputAuthority(input);
        if (!(owner instanceof FileRevisions) || typeof assertHostCurrent !== "function") throw new Error("lease-owner");
        this.#owner = new WeakRef(owner); this.#guard = assertHostCurrent;
        const { binding, entries } = this.#authority;
        // FileRevisions has no public closed-state query. At least one original
        // receipt is required so assertCurrent also proves this owner is not disposed.
        if (!entries.some(entry => entry.operation !== "add")) throw new Error("lease-existing-required");
        if (owner.sessionId !== binding.sessionId || generation.call(owner) !== binding.epoch) throw new Error("lease-owner");
        for (const entry of entries) {
            if (entry.operation === "add") { this.#pins.push(null); continue; }
            const receipt = getReceipt.call(owner, entry.revision);
            if (!receipt || !this.#matches(receipt, entry)) throw new Error("lease-baseline");
            assertReceipt.call(owner, receipt);
            this.#pins.push({ receipt: new WeakRef(receipt), bytes: new WeakRef(receipt.bytes) });
        }
        if (!this.current(binding)) throw new Error("lease-current");
    }
    #matches(receipt, entry) {
        return receipt.id === entry.revision && receipt.sessionId === this.#authority.binding.sessionId
            && receipt.canonicalPath === path.join(this.#authority.binding.sourceRoot.path, entry.path)
            && receipt.sha256 === entry.sha256 && sameIdentity(receipt.identity, entry.identity, true)
            // First bridge accepts only small full receipts, never compact line storage.
            && receipt.mode === "full" && Buffer.isBuffer(receipt.bytes)
            && receipt.bytes.length === Number(entry.identity.size) && receipt.residentBytes === receipt.bytes.length;
    }
    #terminate(state, reason) {
        this.#state = state; this.#reason = reason; this.#pins.length = 0;
        this.#authority = undefined; this.#owner = undefined; this.#guard = undefined;
        return false;
    }
    #checkOwner() {
        const owner = this.#owner?.deref();
        if (!owner || owner.sessionId !== this.#authority.binding.sessionId
            || generation.call(owner) !== this.#authority.binding.epoch) return false;
        for (let i = 0; i < this.#pins.length; i++) {
            const pin = this.#pins[i]; if (!pin) continue;
            const receipt = pin.receipt.deref(); this.#receiptChecks++;
            if (!receipt || getReceipt.call(owner, this.#authority.entries[i].revision) !== receipt
                || !this.#matches(receipt, this.#authority.entries[i]) || pin.bytes.deref() !== receipt.bytes) return false;
            try { assertReceipt.call(owner, receipt); } catch { return false; }
        }
        return true;
    }
    current(binding) {
        this.#checks++;
        if (this.#state !== "active") return false;
        if (this.#checking) return this.#terminate("invalid", "reentry");
        this.#checking = true;
        try {
            if (!sameBinding(this.#authority.binding, binding) || !this.#checkOwner()) return this.#terminate("invalid", "baseline");
            this.#guardCalls++;
            const result = this.#guard(this.#authority.binding);
            // Guard may synchronously revoke, reenter, change the original owner or throw.
            if (this.#state !== "active") return false;
            if (result !== true || !sameBinding(this.#authority.binding, binding)
                || !this.#checkOwner()) return this.#terminate("invalid", "host-current");
            return true;
        } catch (error) {
            this.#terminate("invalid", "exception"); throw error;
        } finally { this.#checking = false; }
    }
    revision(entry, binding) {
        if (!this.current(binding)) return false;
        const expected = this.#authority.entries.find(item => item.path === entry?.path);
        if (!expected || expected.operation === "add" || !sameEntry(expected, entry)) return this.#terminate("invalid", "entry");
        return true;
    }
    get diagnostics() {
        return Object.freeze({ state: this.#state, reason: this.#reason, checks: this.#checks,
            receiptChecks: this.#receiptChecks, guardCalls: this.#guardCalls,
            retainedEntries: this.#authority?.entries.length ?? 0, metadataCharge: this.#authority?.metadataBytes ?? 0,
            weakReferences: (this.#owner ? 1 : 0) + this.#pins.reduce((sum, pin) => sum + (pin ? 2 : 0), 0),
            retainedGuard: this.#guard !== undefined });
    }
    revoke() { this.#terminate("revoked", "revoked"); }
    dispose() { this.#terminate("disposed", "disposed"); }
}
