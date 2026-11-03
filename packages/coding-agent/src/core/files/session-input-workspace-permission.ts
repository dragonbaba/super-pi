import type { ExtensionContext } from "../extensions/types.ts";
import type { SessionFiles } from "./session-files.ts";
import type { FileService } from "./file-service.ts";
import { SessionFileRevisionSource } from "./session-file-revision-source.ts";
import { freezeInputReadPaths, type InputReadBoundary, type AssertInputReadOwner } from "./session-input-read-permission.ts";
import { InputWorkspaceGrantLease, type InputWorkspaceBinding } from "./input-workspace-grant-lease.ts";

const STALE = "[STALE_STATE] Original session workspace permission is unavailable.";
const assertSignal = AbortSignal.prototype.throwIfAborted;
const pureGrant = InputWorkspaceGrantLease.prototype.assertGrantIdentity;
const disposeGrant = InputWorkspaceGrantLease.prototype.dispose;
const renewGrant = InputWorkspaceGrantLease.prototype.renew;
const grantBinding = Object.getOwnPropertyDescriptor(InputWorkspaceGrantLease.prototype, "binding")!.get!;
export interface InputWorkspaceBoundary extends InputReadBoundary {
  prepareInputWorkspaceRead?(ctx: ExtensionContext, paths: readonly string[]): Promise<InputWorkspaceGrantLease>;
}

/** Low-frequency bridge. The installed boundary is trusted host integration,
 * not a security boundary against hostile code in this process. A constructor or
 * instanceof check is not provenance: the outer owner obtains this bridge using
 * SessionFiles' fixed method and this bridge calls that owner's original boundary.
 * Owns its returned grant lease; weakly borrows the dedicated source and host.
 */
export class SessionInputWorkspacePermission {
  #owner?: WeakRef<SessionFiles>;
  #service?: WeakRef<FileService>;
  #ctx?: WeakRef<ExtensionContext>;
  #source?: WeakRef<SessionFileRevisionSource>;
  #boundary?: WeakRef<InputWorkspaceBoundary>;
  #signal?: WeakRef<AbortSignal>;
  #hadSignal = false;
  #cwd = "";
  #sessionId = "";
  #paths: readonly string[] = [];
  #prepare?: NonNullable<InputWorkspaceBoundary["prepareInputWorkspaceRead"]>;
  #verify?: AssertInputReadOwner;
  #grant?: InputWorkspaceGrantLease;
  #grantCurrent?: () => void;
  #binding?: InputWorkspaceBinding;
  #state = "new";
  #checking = false;
  #pending = false;
  #failed = false;
  #error: unknown;
  #checks = 0;
  #renewals = 0;
  #grantDisposals = 0;
  #grantFinal?: InputWorkspaceGrantLease["diagnostics"];
  constructor(owner: SessionFiles, service: FileService, ctx: ExtensionContext, source: SessionFileRevisionSource,
    boundary: InputWorkspaceBoundary, paths: readonly string[], verify: AssertInputReadOwner) {
    try {
      if (!(source instanceof SessionFileRevisionSource) || typeof boundary.prepareInputWorkspaceRead !== "function") throw new Error(STALE);
      this.#owner = new WeakRef(owner); this.#service = new WeakRef(service); this.#ctx = new WeakRef(ctx);
      this.#source = new WeakRef(source); this.#boundary = new WeakRef(boundary);
      this.#prepare = boundary.prepareInputWorkspaceRead; this.#verify = verify;
      const signal = ctx.signal; this.#hadSignal = signal !== undefined;
      if (signal !== undefined) this.#signal = new WeakRef(signal);
      this.#cwd = ctx.cwd; this.#sessionId = ctx.sessionManager.getSessionId();
      if (typeof this.#cwd !== "string" || !this.#cwd.length || this.#cwd.length > 4096
        || typeof this.#sessionId !== "string" || !this.#sessionId.length || this.#sessionId.length > 64) throw new Error(STALE);
      this.#paths = freezeInputReadPaths(paths); this.checkSource();
    } catch (error) { this.#fail(error); throw error; }
  }
  #live(): void {
    if (this.#state !== "new" && this.#state !== "preparing" && this.#state !== "ready" && this.#state !== "renewing") throw new Error(STALE);
  }
  #context(ctx: ExtensionContext): void {
    const signal = this.#signal?.deref();
    if (this.#hadSignal && !signal) throw new Error(STALE);
    if (signal) assertSignal.call(signal);
    const cwd = ctx.cwd, sessionId = ctx.sessionManager.getSessionId(), currentSignal = ctx.signal;
    if (cwd !== this.#cwd || sessionId !== this.#sessionId || currentSignal !== signal) throw new Error(STALE);
    if (signal) assertSignal.call(signal);
    this.#live();
  }
  readonly checkSource = (): true => {
    this.#checks++;
    if (this.#checking) { this.#fail(new Error(STALE)); throw this.#error; }
    this.#checking = true;
    try {
      this.#live();
      const owner = this.#owner?.deref(), service = this.#service?.deref(), ctx = this.#ctx?.deref();
      const source = this.#source?.deref(), boundary = this.#boundary?.deref(), verify = this.#verify;
      if (!owner || !service || !ctx || !source || !boundary || !verify) throw new Error(STALE);
      this.#context(ctx); source.current(); verify(owner, service, ctx, source, boundary, false);
      this.#context(ctx); verify(owner, service, ctx, source, boundary, true); this.#live();
      return true;
    } catch (error) { this.#fail(error); throw error; }
    finally { this.#checking = false; }
  };
  async prepare(checkOriginal: () => void): Promise<this> {
    if (this.#state !== "new" || this.#pending || this.#checking || typeof checkOriginal !== "function") {
      this.#fail(new Error(STALE)); throw this.#error;
    }
    this.#pending = true; this.#state = "preparing";
    let grant: InputWorkspaceGrantLease | undefined;
    try {
      this.checkSource(); checkOriginal(); this.#live();
      const boundary = this.#boundary?.deref(), ctx = this.#ctx?.deref(), prepare = this.#prepare;
      if (!boundary || !ctx || !prepare) throw new Error(STALE);
      // Originals and the callback are borrowed only until this exact pending call
      // settles. They are not fields or retained by a continuation after settlement.
      grant = await prepare.call(boundary, ctx, this.#paths);
      checkOriginal(); this.checkSource();
      if (!(grant instanceof InputWorkspaceGrantLease)) throw new Error(STALE);
      const current = grant.assertCurrent;
      current();
      const binding = grantBinding.call(grant) as InputWorkspaceBinding;
      this.#grant = grant; grant = undefined; this.#grantCurrent = current; this.#binding = binding;
      this.#state = "ready"; this.assertCurrent();
      checkOriginal(); this.assertIdentity();
      return this;
    } catch (error) { this.#fail(error); throw error; }
    finally {
      if (grant instanceof InputWorkspaceGrantLease) {
        disposeGrant.call(grant); this.#grantDisposals++; this.#grantFinal = grant.diagnostics;
      }
      this.#pending = false;
    }
  }
  /** Reobserve the SAME original grant after native close. This does not issue a
   * new grant/receipt or authorize later consumption without the outer checks. */
  async renew(checkOriginal: () => void): Promise<this> {
    if (this.#state !== "ready" || this.#pending || this.#checking || typeof checkOriginal !== "function") {
      this.#fail(new Error(STALE)); throw this.#error;
    }
    this.#pending = true; this.#renewals++;
    let grant: InputWorkspaceGrantLease | undefined;
    try {
      this.assertCurrent(); checkOriginal(); this.assertIdentity();
      grant = this.#grant;
      const binding = this.#binding;
      if (!grant || !binding) throw new Error(STALE);
      this.#state = "renewing";
      await renewGrant.call(grant);
      checkOriginal(); this.checkSource();
      if (this.#state !== "renewing" || this.#grant !== grant || grantBinding.call(grant) !== binding) throw new Error(STALE);
      this.#state = "ready";
      this.assertCurrent(); checkOriginal(); this.assertIdentity();
      return this;
    } catch (error) { this.#fail(error); throw error; }
    finally {
      // Revoke may have released the lease while its original observation was
      // pending. Record its eventual settlement without disposing it twice.
      if (grant && this.#grant !== grant) this.#grantFinal = grant.diagnostics;
      this.#pending = false;
    }
  }
  readonly assertCurrent = (): true => {
    try {
      if (this.#state !== "ready" || !this.#grant || !this.#grantCurrent) throw new Error(STALE);
      this.checkSource(); this.#grantCurrent(); this.checkSource();
      return this.assertIdentity();
    } catch (error) { this.#fail(error); throw error; }
  };
  /** No context/runtime/receipt callbacks after the outer final original check. */
  readonly assertIdentity = (): true => {
    if (this.#checking) { this.#fail(new Error(STALE)); throw this.#error; }
    this.#checking = true;
    try {
      if (this.#state !== "ready" || !this.#grant) throw new Error(STALE);
      const owner = this.#owner?.deref(), service = this.#service?.deref(), ctx = this.#ctx?.deref();
      const source = this.#source?.deref(), boundary = this.#boundary?.deref(), verify = this.#verify;
      if (!owner || !service || !ctx || !source || !boundary || !verify) throw new Error(STALE);
      verify(owner, service, ctx, source, boundary, true);
      pureGrant.call(this.#grant); this.#live(); return true;
    } catch (error) { this.#fail(error); throw error; }
    finally { this.#checking = false; }
  };
  get binding(): InputWorkspaceBinding { this.assertIdentity(); return this.#binding!; }
  #fail(error: unknown): void {
    if (!this.#failed) { this.#failed = true; this.#error = error; }
    this.#release("invalid");
  }
  #release(state: string): void {
    this.#state = state;
    if (this.#grant) {
      disposeGrant.call(this.#grant); this.#grantDisposals++; this.#grantFinal = this.#grant.diagnostics;
    }
    this.#grant = undefined; this.#grantCurrent = undefined; this.#binding = undefined;
    this.#owner = undefined; this.#service = undefined; this.#ctx = undefined; this.#source = undefined;
    this.#boundary = undefined; this.#signal = undefined; this.#hadSignal = false;
    this.#cwd = ""; this.#sessionId = ""; this.#paths = []; this.#prepare = undefined; this.#verify = undefined;
  }
  revoke(): void { this.#release("revoked"); }
  dispose(): void { this.#release("disposed"); }
  get diagnostics() {
    return { state: this.#state, pending: this.#pending, checks: this.#checks, renewals: this.#renewals, grantDisposals: this.#grantDisposals,
      weakReferences: Number(!!this.#owner) + Number(!!this.#service) + Number(!!this.#ctx) + Number(!!this.#source)
        + Number(!!this.#boundary) + Number(!!this.#signal),
      metadataChars: this.#cwd.length + this.#sessionId.length, paths: this.#paths.length,
      retainedPrepare: !!this.#prepare, retainedVerifier: !!this.#verify, retainedGrant: !!this.#grant,
      retainedBinding: !!this.#binding, grant: this.#grant?.diagnostics ?? this.#grantFinal };
  }
  get failure() { return { failed: this.#failed, error: this.#error }; }
}
