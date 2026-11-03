import { isAbsolute, normalize, parse } from "node:path";
import type { ExtensionContext } from "../extensions/types.ts";
import { InputReadPolicyLease, freezeInputReadPaths } from "./session-input-read-permission.ts";

const STALE = "[STALE_STATE] Original input workspace grant is unavailable or changed.";
const assertPolicy = InputReadPolicyLease.prototype.assertCurrent;
const assertPolicyIdentity = InputReadPolicyLease.prototype.assertPolicyIdentity;
const disposePolicy = InputReadPolicyLease.prototype.dispose;
export interface InputWorkspaceGrant {
  requestedPath: string; canonicalPath: string; device: number; inode: number;
}
export interface InputWorkspaceIssuance extends InputWorkspaceGrant {
  readonly identity: Readonly<{ dev: bigint; ino: bigint }>;
}
export interface InputWorkspaceBinding {
  readonly requestedPath: string; readonly canonicalPath: string;
  readonly device: number; readonly inode: number;
  readonly identity: Readonly<{ dev: bigint; ino: bigint }>;
}
export type AssertInputWorkspace = (issuer: object, grant: InputWorkspaceGrant, slot: number,
  binding: InputWorkspaceBinding, paths: readonly string[], issuance: InputWorkspaceIssuance | undefined) => void;
export type ObserveInputWorkspace = (issuer: object, ctx: ExtensionContext, grant: InputWorkspaceGrant,
  binding: InputWorkspaceBinding, paths: readonly string[], check: () => void) => Promise<void>;

/** Fixed original grant data. Never reconstruct an imprecise grant from a new stat. */
export function freezeInputWorkspaceBinding(grant: InputWorkspaceGrant, issuance?: InputWorkspaceIssuance): InputWorkspaceBinding {
  const requestedPath = inputWorkspaceData(grant, "requestedPath"), canonicalPath = inputWorkspaceData(grant, "canonicalPath");
  const device = inputWorkspaceData(grant, "device"), inode = inputWorkspaceData(grant, "inode");
  if (typeof requestedPath !== "string" || typeof canonicalPath !== "string"
    || requestedPath !== canonicalPath || !isAbsolute(canonicalPath) || canonicalPath.length > 4096
    || normalize(canonicalPath) !== canonicalPath || canonicalPath === parse(canonicalPath).root
    || canonicalPath.includes("\0") || !Number.isSafeInteger(device) || device < 0 || device > 0xffffffff
    || !Number.isInteger(inode) || inode <= 0) throw new Error(STALE);
  let dev: bigint, ino: bigint;
  if (issuance === undefined) {
    if (!Number.isSafeInteger(inode)) throw new Error(STALE);
    dev = BigInt(device); ino = BigInt(inode);
  } else {
    if (inputWorkspaceData(issuance, "requestedPath") !== requestedPath || inputWorkspaceData(issuance, "canonicalPath") !== canonicalPath
      || inputWorkspaceData(issuance, "device") !== device || inputWorkspaceData(issuance, "inode") !== inode) throw new Error(STALE);
    const identity = Object.getOwnPropertyDescriptor(issuance, "identity");
    if (!identity || !("value" in identity) || !identity.value || typeof identity.value !== "object") throw new Error(STALE);
    const d = Object.getOwnPropertyDescriptor(identity.value, "dev"), i = Object.getOwnPropertyDescriptor(identity.value, "ino");
    if (!d || !("value" in d) || !i || !("value" in i) || typeof d.value !== "bigint" || typeof i.value !== "bigint"
      || d.value !== BigInt(device) || d.value < 0n || d.value > 0xffffffffn || i.value <= 0n || i.value > 0xffffffffffffffffn) throw new Error(STALE);
    dev = d.value; ino = i.value;
  }
  return Object.freeze({ requestedPath, canonicalPath, device, inode,
    identity: Object.freeze({ dev, ino }) });
}

/** Original state grants are plain data records. Refuse an accessor instead of
 * executing arbitrary code from a supposedly pure identity phase. */
export function inputWorkspaceData<K extends keyof InputWorkspaceGrant>(grant: InputWorkspaceGrant, key: K): InputWorkspaceGrant[K] {
  const field = Object.getOwnPropertyDescriptor(grant, key);
  if (!field || !("value" in field)) throw new Error(STALE);
  return field.value;
}

/** Low-frequency observation only. No source receipt, native HANDLE, content read,
 * capture or copy authorization is supplied by this lease or its exported data.
 * One original workspace must cover every path. All identities are pinned before
 * the first await. Renewal compares those originals; it never replaces them.
 */
export class InputWorkspaceGrantLease {
  #issuer?: WeakRef<object>;
  #ctx?: WeakRef<ExtensionContext>;
  #grant?: WeakRef<InputWorkspaceGrant>;
  #issuance?: WeakRef<InputWorkspaceIssuance>;
  #hadIssuance = false;
  #policy?: InputReadPolicyLease;
  #binding?: InputWorkspaceBinding;
  #paths: readonly string[] = [];
  #slot = -2;
  #verify?: AssertInputWorkspace;
  #observe?: ObserveInputWorkspace;
  #state = "new";
  #pending = false;
  #checking = false;
  #failed = false;
  #error: unknown;
  #observations = 0;
  #checks = 0;
  #policyDisposals = 0;
  constructor(ctx: ExtensionContext, paths: readonly string[], issuer: object, grant: InputWorkspaceGrant,
    slot: number, policyVerify: () => void, verify: AssertInputWorkspace, observe: ObserveInputWorkspace,
    issuance?: InputWorkspaceIssuance) {
    try {
      this.#binding = freezeInputWorkspaceBinding(grant, issuance);
      this.#hadIssuance = issuance !== undefined;
      if (issuance !== undefined) this.#issuance = new WeakRef(issuance);
      if (!Number.isInteger(slot) || slot < -1 || slot > 15) throw new Error(STALE);
      this.#issuer = new WeakRef(issuer); this.#ctx = new WeakRef(ctx); this.#grant = new WeakRef(grant);
      this.#slot = slot; this.#verify = verify; this.#observe = observe;
      // The policy owns the single frozen path-table copy retained by this lease.
      this.#policy = new InputReadPolicyLease(ctx, paths, policyVerify);
      this.#paths = this.#policy.paths;
      this.assertCurrent();
    } catch (error) { this.#fail(error); throw error; }
  }
  #live(): void {
    if (this.#state !== "new" && this.#state !== "observing" && this.#state !== "ready") throw new Error(STALE);
  }
  #pure(): void {
    this.#live();
    const issuer = this.#issuer?.deref(), grant = this.#grant?.deref(), issuance = this.#issuance?.deref();
    if (!issuer || !grant || this.#hadIssuance && !issuance || !this.#policy || !this.#binding || !this.#verify) throw new Error(STALE);
    assertPolicyIdentity.call(this.#policy);
    this.#verify(issuer, grant, this.#slot, this.#binding, this.#paths, issuance);
    this.#live();
  }
  /** Current identity and policy only; deliberately not filesystem renewal. */
  readonly assertCurrent = (): void => {
    this.#checks++;
    if (this.#checking) { this.#fail(new Error(STALE)); throw this.#error; }
    this.#checking = true;
    try {
      this.#live();
      if (!this.#policy) throw new Error(STALE);
      assertPolicy.call(this.#policy); // May invoke context callbacks.
      this.#pure(); // No context/runtime callbacks after the final identity check.
    } catch (error) { this.#fail(error); throw error; }
    finally { this.#checking = false; }
  };
  /** Pure final identity phase after an enclosing original-receipt callback.
   * This is not filesystem renewal or an independently usable read permission. */
  assertGrantIdentity(): void {
    if (this.#checking) { this.#fail(new Error(STALE)); throw this.#error; }
    this.#checking = true;
    try { this.#pure(); }
    catch (error) { this.#fail(error); throw error; }
    finally { this.#checking = false; }
  }
  prepare(): Promise<this> { return this.#run(true); }
  renew(): Promise<this> { return this.#run(false); }
  async #run(initial: boolean): Promise<this> {
    if (this.#pending || this.#checking || this.#state !== (initial ? "new" : "ready")) {
      this.#fail(new Error(STALE)); throw this.#error;
    }
    this.#pending = true; this.#state = "observing"; this.#observations++;
    try {
      this.assertCurrent();
      const issuer = this.#issuer?.deref(), ctx = this.#ctx?.deref(), grant = this.#grant?.deref();
      const observe = this.#observe, binding = this.#binding, paths = this.#paths;
      if (!issuer || !ctx || !grant || !observe || !binding) throw new Error(STALE);
      // Only this pending observation strongly borrows originals. Revoke/dispose
      // cannot cancel arbitrary filesystem I/O; the original call must settle.
      await observe(issuer, ctx, grant, binding, paths, this.assertCurrent);
      this.assertCurrent(); this.#state = "ready";
      return this;
    } catch (error) { this.#fail(error); throw error; }
    finally { this.#pending = false; }
  }
  /** Immutable data, not an independently usable authority or a native binding.
   * A caller retaining this value owns the lifetime of that external copy. */
  get binding(): InputWorkspaceBinding {
    if (this.#state !== "ready") { this.#fail(new Error(STALE)); throw this.#error; }
    this.assertCurrent(); return this.#binding!;
  }
  #fail(error: unknown): void {
    if (!this.#failed) { this.#failed = true; this.#error = error; }
    this.#release("invalid");
  }
  #release(state: string): void {
    this.#state = state;
    if (this.#policy) { disposePolicy.call(this.#policy); this.#policyDisposals++; }
    this.#policy = undefined; this.#issuer = undefined; this.#ctx = undefined; this.#grant = undefined;
    this.#issuance = undefined; this.#hadIssuance = false;
    this.#binding = undefined; this.#paths = []; this.#slot = -2; this.#verify = undefined; this.#observe = undefined;
  }
  revoke(): void { this.#release("revoked"); }
  dispose(): void { this.#release("disposed"); }
  get diagnostics() {
    return { state: this.#state, pending: this.#pending, observations: this.#observations, checks: this.#checks,
      paths: this.#paths.length, pathChars: this.#paths.reduce((sum, value) => sum + value.length, 0),
      grants: this.#binding ? 1 : 0, grantChars: this.#binding ? this.#binding.requestedPath.length + this.#binding.canonicalPath.length : 0,
      weakReferences: Number(!!this.#issuer) + Number(!!this.#ctx) + Number(!!this.#grant) + Number(!!this.#issuance),
      originalIssuance: this.#hadIssuance,
      retainedObserver: !!this.#observe, retainedVerifier: !!this.#verify, policyDisposals: this.#policyDisposals,
      policy: this.#policy?.diagnostics };
  }
  get failure() { return { failed: this.#failed, error: this.#error }; }
}

// Controller uses the existing bound path validator before selecting its grant.
export { freezeInputReadPaths };
