import { RetryWait, type RetryOperation } from "./transient-retry.ts";

export const MAX_PENDING_CALLS = 256;
export const MAX_RELEASED_CALLS = 4096;
export const MAX_CALL_ID_CHARACTERS = 512;

export class PendingCall {
  hasChildren = false;
  repairNote: string | undefined;
  nestedKey: string | undefined;
  wait: RetryWait | undefined;
  retryOperation: RetryOperation | undefined;
  key: string;
  readonly parent: string | undefined;
  constructor(key: string, parent: string | undefined) { this.key = key; this.parent = parent; }
}

/** Metadata only: no input graph or result text is stored here. */
export class CallLedger {
  readonly pending = new Map<string, PendingCall>();
  readonly nested = new Map<string, true>();
  readonly released = new Map<string, Map<string, number>>();
  releasedCount = 0;
  capacityRefusals = 0;

  canAdmit(id: string, parent?: string): boolean {
    if (id.length > MAX_CALL_ID_CHARACTERS || (parent?.length ?? 0) > MAX_CALL_ID_CHARACTERS
      || this.pending.has(id) || this.pending.size >= MAX_PENDING_CALLS
      || (parent !== undefined && this.releasedCount >= MAX_RELEASED_CALLS)) {
      this.capacityRefusals++;
      return false;
    }
    return true;
  }

  remember(id: string, key: string, parent?: string): PendingCall {
    const owner = parent === undefined ? undefined : this.pending.get(parent);
    if (owner) owner.hasChildren = true;
    const pending = new PendingCall(key, parent);
    this.pending.set(id, pending);
    return pending;
  }

  rememberRepair(id: string, note: string): void {
    const pending = this.pending.get(id);
    if (pending) pending.repairNote = note.slice(0, 1024);
  }

  finish(id: string): PendingCall | undefined {
    const pending = this.pending.get(id);
    if (!pending) return undefined;
    this.pending.delete(id);
    pending.wait?.cancel();
    pending.wait = undefined;
    if (pending.nestedKey && pending.parent) {
      this.nested.delete(pending.nestedKey);
      let releases = this.released.get(pending.parent);
      if (!releases) { releases = new Map(); this.released.set(pending.parent, releases); }
      if (releases.has(pending.nestedKey) || this.releasedCount < MAX_RELEASED_CALLS) {
        if (!releases.has(pending.nestedKey)) this.releasedCount++;
        releases.set(pending.nestedKey, performance.now());
      }
    }
    return pending;
  }

  end(id: string): void {
    this.finish(id);
    // Parent completion/cancellation releases all of its remaining invocation state.
    for (const child of this.pending.keys()) if (this.pending.get(child)!.parent === id) this.finish(child);
    const releases = this.released.get(id);
    if (releases) this.releasedCount -= releases.size;
    this.released.delete(id);
  }

  clear(): void {
    for (const pending of this.pending.values()) pending.wait?.cancel();
    this.pending.clear(); this.nested.clear(); this.released.clear(); this.releasedCount = 0;
  }
}
