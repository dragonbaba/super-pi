import { isAbsolute } from "node:path";
import type { ExtensionContext } from "../extensions/types.ts";
import type { ObservationPermissions } from "./changes.ts";
import type { SessionFiles } from "./session-files.ts";
import type { FileService } from "./file-service.ts";
import { SessionFileRevisionSource } from "./session-file-revision-source.ts";

const assertSignal = AbortSignal.prototype.throwIfAborted;
const STALE = "[STALE_STATE] Input read permission is unavailable or obsolete.";
const sourceRevisions = Object.getOwnPropertyDescriptor(SessionFileRevisionSource.prototype, "revisions")!.get!;

/** Bounded observation targets, not content evidence or a filesystem lock. */
export function freezeInputReadPaths(paths: readonly string[]): readonly string[] {
  if (!Array.isArray(paths) || paths.length < 1 || paths.length > 34) throw new Error(STALE);
  const copy: string[] = [];
  let chars = 0;
  for (const path of paths) {
    if (typeof path !== "string" || !isAbsolute(path) || path.length > 4096 || path.includes("\0")
      || copy.includes(path) || (chars += path.length) > 8192) throw new Error(STALE);
    copy.push(path);
  }
  return Object.freeze(copy);
}

/** Policy validity ONLY. Async path checks are performed by the issuer before
 * publication. assertCurrent does no filesystem I/O and cannot authorize capture
 * or post-close copying without a separately reviewed filesystem renewal boundary.
 */
export class InputReadPolicyLease {
  #ctx?: WeakRef<ExtensionContext>;
  #signal?: WeakRef<AbortSignal>;
  #hadSignal = false;
  #verify?: () => void;
  #cwd = "";
  #sessionId = "";
  #paths: readonly string[] = [];
  #state = "active";
  #checking = false;
  constructor(ctx: ExtensionContext, paths: readonly string[], verify: () => void) {
    try {
      this.#paths = freezeInputReadPaths(paths);
      this.#ctx = new WeakRef(ctx); this.#verify = verify;
      const signal = ctx.signal;
      this.#hadSignal = signal !== undefined;
      if (signal !== undefined) this.#signal = new WeakRef(signal);
      this.#cwd = ctx.cwd; this.#sessionId = ctx.sessionManager.getSessionId();
      if (typeof this.#cwd !== "string" || !this.#cwd.length || this.#cwd.length > 4096
        || typeof this.#sessionId !== "string" || !this.#sessionId.length || this.#sessionId.length > 64) throw new Error(STALE);
      this.assertCurrent();
    } catch (error) { this.#release("invalid"); throw error; }
  }
  get paths(): readonly string[] { return this.#paths; }
  /** Final issuer identity only. The actual issuer supplies the fixed weak
   * controller generation/sequence check; this does not invoke context getters. */
  assertPolicyIdentity(): void {
    if (this.#state !== "active" || this.#checking || !this.#verify) { this.#release("invalid"); throw new Error(STALE); }
    this.#checking = true;
    try {
      this.#verify();
      if (this.#state !== "active") throw new Error(STALE);
    } catch (error) { this.#release("invalid"); throw error; }
    finally { this.#checking = false; }
  }
  assertCurrent(): void {
    if (this.#state !== "active" || this.#checking) { this.#release("invalid"); throw new Error(STALE); }
    this.#checking = true;
    try {
      const ctx = this.#ctx?.deref(), signal = this.#signal?.deref(), verify = this.#verify;
      if (!ctx || !verify || this.#hadSignal && !signal) throw new Error(STALE);
      if (signal) assertSignal.call(signal);
      verify();
      const cwd = ctx.cwd, sessionId = ctx.sessionManager.getSessionId(), currentSignal = ctx.signal;
      verify();
      if (this.#state !== "active" || cwd !== this.#cwd || sessionId !== this.#sessionId || currentSignal !== signal) throw new Error(STALE);
      if (signal) assertSignal.call(signal);
    } catch (error) { this.#release("invalid"); throw error; }
    finally { this.#checking = false; }
  }
  #release(state: string): void {
    this.#state = state; this.#ctx = undefined; this.#signal = undefined; this.#verify = undefined;
    this.#paths = []; this.#cwd = ""; this.#sessionId = ""; this.#hadSignal = false;
  }
  dispose(): void { this.#release("disposed"); }
  get diagnostics() {
    return { state: this.#state, weakReferences: Number(!!this.#ctx) + Number(!!this.#signal),
      retainedVerifier: !!this.#verify, paths: this.#paths.length, metadataChars: this.#cwd.length + this.#sessionId.length };
  }
}

export interface InputReadBoundary extends ObservationPermissions {
  prepareInputRead?(ctx: ExtensionContext, paths: readonly string[]): Promise<InputReadPolicyLease>;
}
export type AssertInputReadOwner = (owner: SessionFiles, service: FileService, ctx: ExtensionContext,
  source: SessionFileRevisionSource, boundary: InputReadBoundary, finalOnly: boolean) => void;

/** Owns the returned policy, but only WEAKLY BORROWS the caller's dedicated source.
 * No service construction, receipt issuance, native capture, or path renewal.
 */
export class SessionInputReadPermission {
  #owner?: WeakRef<SessionFiles>;
  #service?: WeakRef<FileService>;
  #ctx?: WeakRef<ExtensionContext>;
  #signal?: WeakRef<AbortSignal>;
  #hadSignal = false;
  #cwd = "";
  #sessionId = "";
  #source?: WeakRef<SessionFileRevisionSource>;
  #boundary?: WeakRef<InputReadBoundary>;
  #prepare?: NonNullable<InputReadBoundary["prepareInputRead"]>;
  #verify?: AssertInputReadOwner;
  #paths: readonly string[] = [];
  #policy?: InputReadPolicyLease;
  #state = "new";
  #checking = false;
  #pending = false;
  #checks = 0;
  #policyDisposals = 0;
  #failed = false;
  #error: unknown;
  constructor(owner: SessionFiles, service: FileService, ctx: ExtensionContext, source: SessionFileRevisionSource,
    boundary: InputReadBoundary, paths: readonly string[], verify: AssertInputReadOwner) {
    try {
      if (!(source instanceof SessionFileRevisionSource) || typeof boundary.prepareInputRead !== "function") throw new Error(STALE);
      this.#owner = new WeakRef(owner); this.#service = new WeakRef(service); this.#ctx = new WeakRef(ctx);
      const signal = ctx.signal; this.#hadSignal = signal !== undefined;
      if (signal !== undefined) this.#signal = new WeakRef(signal);
      this.#cwd = ctx.cwd; this.#sessionId = ctx.sessionManager.getSessionId();
      if (typeof this.#cwd !== "string" || !this.#cwd.length || this.#cwd.length > 4096
        || typeof this.#sessionId !== "string" || !this.#sessionId.length || this.#sessionId.length > 64) throw new Error(STALE);
      this.#paths = freezeInputReadPaths(paths);
      this.#source = new WeakRef(source);
      this.#boundary = new WeakRef(boundary); this.#prepare = boundary.prepareInputRead; this.#verify = verify;
      this.checkSource();
    } catch (error) { this.#fail(error); throw error; }
  }
  #live(): void {
    if (this.#state !== "new" && this.#state !== "preparing" && this.#state !== "ready") throw new Error(STALE);
  }
  #checkContext(ctx: ExtensionContext): void {
    const signal = this.#signal?.deref();
    if (this.#hadSignal && !signal) throw new Error(STALE);
    if (signal) assertSignal.call(signal);
    const cwd = ctx.cwd, sessionId = ctx.sessionManager.getSessionId(), currentSignal = ctx.signal;
    if (cwd !== this.#cwd || sessionId !== this.#sessionId || currentSignal !== signal) throw new Error(STALE);
    if (signal) assertSignal.call(signal);
    this.#live();
  }
  /** Original lifecycle/namespace only, explicitly not permission. */
  readonly checkSource = (): true => {
    this.#checks++;
    if (this.#checking) { this.#fail(new Error(STALE)); throw this.#error; }
    this.#checking = true;
    try {
      this.#live();
      const owner = this.#owner?.deref(), service = this.#service?.deref(), ctx = this.#ctx?.deref();
      const source = this.#source?.deref(), boundary = this.#boundary?.deref();
      if (!owner || !service || !ctx || !source || !boundary || !this.#verify) throw new Error(STALE);
      this.#checkContext(ctx); source.current(); this.#verify(owner, service, ctx, source, boundary, false);
      this.#checkContext(ctx); this.#verify!(owner, service, ctx, source, boundary, true); this.#live();
      return true;
    } catch (error) { this.#fail(error); throw error; }
    finally { this.#checking = false; }
  };
  async prepare(): Promise<this> {
    if (this.#state !== "new" || this.#pending) { this.#fail(new Error(STALE)); throw this.#error; }
    this.#state = "preparing"; this.#pending = true;
    let policy: InputReadPolicyLease | undefined;
    try {
      this.checkSource();
      const boundary = this.#boundary!.deref(), ctx = this.#ctx!.deref(), prepare = this.#prepare;
      if (!boundary || !ctx || !prepare) throw new Error(STALE);
      // These temporary strong references last until this exact async call settles.
      // Revocation cannot cancel arbitrary in-flight filesystem observation.
      policy = await prepare.call(boundary, ctx, this.#paths);
      this.checkSource();
      if (!(policy instanceof InputReadPolicyLease) || policy.paths.length !== this.#paths.length) throw new Error(STALE);
      for (let i = 0; i < this.#paths.length; i++) if (policy.paths[i] !== this.#paths[i]) throw new Error(STALE);
      assertInputPolicy.call(policy); this.checkSource();
      this.#policy = policy; policy = undefined; this.#state = "ready";
      this.assertCurrent(); return this;
    } catch (error) { this.#fail(error); throw error; }
    finally {
      if (policy instanceof InputReadPolicyLease) { disposeInputPolicy.call(policy); this.#policyDisposals++; }
      this.#pending = false;
    }
  }
  /** Prepared policy validity, not a fresh path observation. */
  readonly assertCurrent = (): true => {
    try {
      if (this.#state !== "ready" || !this.#policy) throw new Error(STALE);
      this.checkSource(); assertInputPolicy.call(this.#policy); this.checkSource();
      return this.assertPolicyIdentity();
    } catch (error) { this.#fail(error); throw error; }
  };
  /** Final pure owner/policy checks after callers' original-receipt callbacks.
   * Does not resample a context or inspect filesystem state. */
  readonly assertPolicyIdentity = (): true => {
    if (this.#checking) { this.#fail(new Error(STALE)); throw this.#error; }
    this.#checking = true;
    try {
      if (this.#state !== "ready" || !this.#policy) throw new Error(STALE);
      const owner = this.#owner?.deref(), service = this.#service?.deref(), ctx = this.#ctx?.deref();
      const source = this.#source?.deref(), boundary = this.#boundary?.deref();
      if (!owner || !service || !ctx || !source || !boundary || !this.#verify) throw new Error(STALE);
      this.#verify(owner, service, ctx, source, boundary, true);
      assertPolicyIdentity.call(this.#policy); this.#live(); return true;
    } catch (error) { this.#fail(error); throw error; }
    finally { this.#checking = false; }
  };
  #fail(error: unknown): void {
    if (!this.#failed) { this.#failed = true; this.#error = error; }
    this.#release("invalid");
  }
  #release(state: string): void {
    this.#state = state;
    if (this.#policy) { disposeInputPolicy.call(this.#policy); this.#policyDisposals++; this.#policy = undefined; }
    this.#owner = undefined; this.#service = undefined; this.#ctx = undefined; this.#source = undefined; this.#boundary = undefined;
    this.#signal = undefined; this.#hadSignal = false; this.#cwd = ""; this.#sessionId = "";
    this.#prepare = undefined; this.#verify = undefined; this.#paths = [];
  }
  revoke(): void { this.#release("revoked"); }
  dispose(): void { this.#release("disposed"); }
  get diagnostics() {
    return { state: this.#state, pending: this.#pending, checks: this.#checks, policyDisposals: this.#policyDisposals,
      weakReferences: Number(!!this.#owner) + Number(!!this.#service) + Number(!!this.#ctx) + Number(!!this.#source) + Number(!!this.#boundary) + Number(!!this.#signal),
      metadataChars: this.#cwd.length + this.#sessionId.length,
      retainedPolicy: !!this.#policy, retainedPrepare: !!this.#prepare, retainedVerifier: !!this.#verify, paths: this.#paths.length };
  }
  get failure() { return { failed: this.#failed, error: this.#error }; }
}

// Fixed original getter used by SessionFiles without retaining a borrowed revision owner.
export function originalSourceRevisions(source: SessionFileRevisionSource): unknown { return sourceRevisions.call(source); }
const disposeInputPolicy = InputReadPolicyLease.prototype.dispose;
const assertInputPolicy = InputReadPolicyLease.prototype.assertCurrent;
const assertPolicyIdentity = InputReadPolicyLease.prototype.assertPolicyIdentity;
