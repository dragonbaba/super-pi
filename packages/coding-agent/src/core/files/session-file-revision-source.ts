import type { ExtensionContext, ExtensionRuntime } from "../extensions/types.ts";
import { SessionExecutionBoundary } from "../execution-boundary.ts";
import type { SessionFiles } from "./session-files.ts";
import type { FileService } from "./file-service.ts";
import { FileRevisions } from "./snapshot-line-edit.ts";

const assertBoundary = SessionExecutionBoundary.prototype.assertCurrent;
const revisionGeneration = Object.getOwnPropertyDescriptor(FileRevisions.prototype, "generation")!.get!;
const boundaryGeneration = Object.getOwnPropertyDescriptor(SessionExecutionBoundary.prototype, "generation")!.get!;
const assertSignal = AbortSignal.prototype.throwIfAborted;
const STALE = "[STALE_STATE] Original read revision source is no longer current.";
export type AssertReadSource = (owner: SessionFiles, service: FileService, ctx: ExtensionContext,
  runtime: ExtensionRuntime, boundary: SessionExecutionBoundary, generation: number,
  signal: AbortSignal | undefined, cwd: string, sessionId: string) => void;

/** Lifecycle bridge, not path authorization or receipt authenticity against host code.
 * It does no I/O, issuance or refresh. Callers own any strong reference borrowed from
 * revisions; retaining this source alone does not retain service/receipt/source bytes.
 * Context/runtime callbacks are trusted host code, not an adversarial isolation boundary.
 */
export class SessionFileRevisionSource {
  #owner?: WeakRef<SessionFiles>;
  #service?: WeakRef<FileService>;
  #revisions?: WeakRef<FileRevisions>;
  #ctx?: WeakRef<ExtensionContext>;
  #runtime?: WeakRef<ExtensionRuntime>;
  #boundary?: WeakRef<SessionExecutionBoundary>;
  #signal?: WeakRef<AbortSignal>;
  #hadSignal = false;
  #verify?: AssertReadSource;
  #generation = 0;
  #boundaryGeneration = 0;
  #cwd = "";
  #sessionId = "";
  #state = "active";
  #checking = false;
  #checks = 0;
  constructor(owner: SessionFiles, service: FileService, ctx: ExtensionContext,
    runtime: ExtensionRuntime, verify: AssertReadSource) {
    try {
      const revisions = service.revisions, boundary = runtime.executionBoundary, signal = ctx.signal;
      this.#owner = new WeakRef(owner); this.#service = new WeakRef(service);
      this.#revisions = new WeakRef(revisions); this.#ctx = new WeakRef(ctx);
      this.#runtime = new WeakRef(runtime); this.#boundary = new WeakRef(boundary);
      this.#hadSignal = signal !== undefined;
      if (signal !== undefined) this.#signal = new WeakRef(signal);
      this.#verify = verify;
      this.#generation = revisionGeneration.call(revisions);
      this.#boundaryGeneration = boundaryGeneration.call(boundary);
      this.#cwd = service.cwd; this.#sessionId = service.sessionId;
      this.current();
    } catch (error) { this.#release("invalid"); throw error; }
  }
  #release(state: string): void {
    this.#state = state;
    this.#owner = undefined; this.#service = undefined; this.#revisions = undefined;
    this.#ctx = undefined; this.#runtime = undefined; this.#boundary = undefined;
    this.#signal = undefined; this.#verify = undefined; this.#hadSignal = false;
    this.#cwd = ""; this.#sessionId = "";
  }
  readonly current = (): true => {
    this.#checks++;
    if (this.#state !== "active" || this.#checking) {
      this.#release("invalid"); throw new Error(STALE);
    }
    this.#checking = true;
    try {
      const owner = this.#owner?.deref(), service = this.#service?.deref(), revisions = this.#revisions?.deref();
      const ctx = this.#ctx?.deref(), runtime = this.#runtime?.deref(), boundary = this.#boundary?.deref();
      const signal = this.#signal?.deref();
      if (!owner || !service || !revisions || !ctx || !runtime || !boundary
        || this.#hadSignal && !signal || service.revisions !== revisions
        || revisionGeneration.call(revisions) !== this.#generation) throw new Error(STALE);
      if (signal) assertSignal.call(signal);
      assertBoundary.call(boundary, this.#boundaryGeneration);
      this.#verify!(owner, service, ctx, runtime, boundary, this.#generation, signal, this.#cwd, this.#sessionId);
      // Reentry/revoke and synchronous host callbacks cannot revive a released source.
      if (this.#state !== "active" || service.revisions !== revisions
        || revisionGeneration.call(revisions) !== this.#generation
        || runtime.executionBoundary !== boundary) throw new Error(STALE);
      assertBoundary.call(boundary, this.#boundaryGeneration);
      if (signal) assertSignal.call(signal);
      return true;
    } catch (error) { this.#release("invalid"); throw error; }
    finally { this.#checking = false; }
  };
  get revisions(): FileRevisions {
    this.current();
    const revisions = this.#revisions?.deref();
    if (!revisions) { this.#release("invalid"); throw new Error(STALE); }
    return revisions;
  }
  get diagnostics() {
    return Object.freeze({ state: this.#state, checks: this.#checks,
      weakReferences: (this.#owner ? 1 : 0) + (this.#service ? 1 : 0) + (this.#revisions ? 1 : 0)
        + (this.#ctx ? 1 : 0) + (this.#runtime ? 1 : 0) + (this.#boundary ? 1 : 0) + (this.#signal ? 1 : 0),
      retainedVerifier: this.#verify !== undefined, retainedMetadata: this.#cwd.length + this.#sessionId.length });
  }
  revoke(): void { this.#release("revoked"); }
  dispose(): void { this.#release("disposed"); }
}
