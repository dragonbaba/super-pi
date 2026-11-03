import { win32 as path } from "node:path";
import type { AgentTool, AgentToolExecutionContext } from "@super-pi/agent-core";
import type { ExtensionContext, ExtensionRuntime } from "../extensions/types.ts";
import { SessionExecutionBoundary } from "../execution-boundary.ts";
import { SessionFiles } from "../files/session-files.ts";
import { SessionFileRevisionSource } from "../files/session-file-revision-source.ts";
import { FileRevisions } from "../files/snapshot-line-edit.ts";
import { assertSandboxTaskRequest, SANDBOX_TASK_LIMITS, type SandboxTaskRequest } from "./task-request.ts";

const pinSource = SessionFiles.prototype.pinReadRevisions;
const ownerState = SessionFiles.prototype.getDiagnostics;
const boundaryGeneration = Object.getOwnPropertyDescriptor(SessionExecutionBoundary.prototype, "generation")!.get!;
const currentBoundary = SessionExecutionBoundary.prototype.assertCurrent;
const sourceRevisions = Object.getOwnPropertyDescriptor(SessionFileRevisionSource.prototype, "revisions")!.get!;
const sourceState = Object.getOwnPropertyDescriptor(SessionFileRevisionSource.prototype, "diagnostics")!.get!;
const disposeSource = SessionFileRevisionSource.prototype.dispose;
const getReceipt = FileRevisions.prototype.get;
const currentReceipt = FileRevisions.prototype.assertCurrent;
const abort = AbortSignal.prototype.throwIfAborted;
type Receipt = NonNullable<ReturnType<FileRevisions["get"]>>;
const STALE = "[SANDBOX_BINDING_STALE] Original parent invocation is unavailable or changed.";
function need(value: unknown): asserts value { if (!value) throw new Error(STALE); }

export interface SandboxTaskBorrow {
  readonly request: SandboxTaskRequest;
  readonly files: SessionFiles;
  readonly runtime: ExtensionRuntime;
  readonly ctx: ExtensionContext;
  readonly execution: AgentToolExecutionContext;
  readonly signal: AbortSignal;
  /** Session/parent liveness only; also valid after original writes consume revisions. */
  readonly assertSessionCurrent: () => true;
  /** Before input capture/dispatch, not after successful writeback consumes a revision. */
  readonly assertInputsCurrent: () => true;
}
/**
 * Cold host integration frame, not a new authorization/VM/task registry.
 * The trusted parent (the future CodeMode host coordinator) must supply the ORIGINAL
 * execute arguments. A constructor, parent ID or callback shape proves no provenance.
 * Ordinary nested shell calls have no parent dispatcher to supply and are unsupported.
 *
 * Owns a dedicated revision-source lease only when inputs are selected; otherwise
 * requires no prior read or FileService. Weakly borrows the existing owners and
 * receipt keys. The callback borrows originals only while run() is pending. The
 * existing input permission, VM owner and nested file_batch retain their own checks.
 * This class performs no I/O, command dispatch, path grant or candidate acceptance.
 */
export class SandboxTaskBinding {
  #request?: SandboxTaskRequest;
  #files?: WeakRef<SessionFiles>;
  #runtime?: WeakRef<ExtensionRuntime>;
  #assertActive?: WeakRef<ExtensionRuntime["assertActive"]>;
  #boundary?: WeakRef<SessionExecutionBoundary>;
  #ctxSignal?: WeakRef<AbortSignal>;
  #generation = -1;
  #session = "";
  #ctx?: WeakRef<ExtensionContext>;
  #execution?: WeakRef<AgentToolExecutionContext>;
  #signal?: WeakRef<AbortSignal>;
  #callTool?: WeakRef<AgentToolExecutionContext["callTool"]>;
  #findTool?: WeakRef<AgentToolExecutionContext["findTool"]>;
  #tools: { name: string; tool: WeakRef<AgentTool<any>>; execute: WeakRef<AgentTool<any>["execute"]> }[] = [];
  #source?: SessionFileRevisionSource;
  #checkSource?: SessionFileRevisionSource["current"];
  #sourceFinal?: SessionFileRevisionSource["diagnostics"];
  #receipts: WeakRef<Receipt>[] = [];
  #cwd = "";
  #parent = "";
  #state = "new";
  #pending = false;
  #used = false;
  #revoked = false;
  #checking = false;
  #checks = 0;
  #inputChecks = 0;
  #sourceDisposals = 0;
  constructor(request: SandboxTaskRequest, files: SessionFiles, ctx: ExtensionContext,
    execution: AgentToolExecutionContext, parentToolCallId: string, signal: AbortSignal, runtime: ExtensionRuntime) {
    try {
      assertSandboxTaskRequest(request);
      need(files instanceof SessionFiles && ctx && execution && typeof parentToolCallId === "string"
        && parentToolCallId.length > 0 && parentToolCallId.length <= 256
        && execution.parentToolCallId === parentToolCallId && typeof execution.callTool === "function"
        && typeof execution.findTool === "function");
      abort.call(signal);
      need(runtime && runtime.nativeFiles === files && typeof runtime.assertActive === "function"
        && runtime.executionBoundary instanceof SessionExecutionBoundary);
      this.#runtime = new WeakRef(runtime); this.#assertActive = new WeakRef(runtime.assertActive);
      this.#boundary = new WeakRef(runtime.executionBoundary);
      this.#generation = boundaryGeneration.call(runtime.executionBoundary);
      const ctxSignal = ctx.signal;
      if (ctxSignal !== undefined) { abort.call(ctxSignal); this.#ctxSignal = new WeakRef(ctxSignal); }
      this.#session = ctx.sessionManager.getSessionId();
      need(typeof this.#session === "string" && this.#session.length > 0 && this.#session.length <= 256);
      this.#request = request; this.#files = new WeakRef(files); this.#ctx = new WeakRef(ctx);
      this.#execution = new WeakRef(execution); this.#signal = new WeakRef(signal);
      this.#callTool = new WeakRef(execution.callTool); this.#parent = parentToolCallId;
      this.#findTool = new WeakRef(execution.findTool);
      for (const name of request.writes.length ? ["powershell", "file_batch"] : ["powershell"]) {
        const tool = execution.findTool(name);
        need(tool && typeof tool.execute === "function" && !tool.orchestration && !tool.interactionBoundary && !tool.modelOnly);
        this.#tools.push({ name, tool: new WeakRef(tool), execute: new WeakRef(tool.execute) });
      }
      this.#cwd = ctx.cwd;
      need(typeof this.#cwd === "string" && this.#cwd.length <= 240 && /^[A-Z]:\\[^\\]/.test(this.#cwd)
        && path.normalize(this.#cwd) === this.#cwd && !this.#cwd.endsWith("\\"));
      if (request.inputs.length) {
        this.#source = pinSource.call(files, ctx); // Never creates or refreshes a read revision.
        this.#checkSource = this.#source.current; // Original instance arrow, not a prototype method.
      }
      this.#state = "ready";
      this.assertSessionCurrent();
      const revisions = this.#source ? sourceRevisions.call(this.#source) as FileRevisions : undefined;
      let bytes = 0;
      for (const input of request.inputs) {
        need(revisions);
        const receipt = getReceipt.call(revisions, input.snapshot);
        need(receipt && receipt.canonicalPath === path.join(this.#cwd, ...input.path.split("/"))
          && typeof receipt.identity.size === "bigint" && receipt.identity.size >= 0n
          && receipt.identity.size <= BigInt(SANDBOX_TASK_LIMITS.inputFileBytes));
        bytes += Number(receipt.identity.size); need(bytes <= SANDBOX_TASK_LIMITS.inputBytes);
        currentReceipt.call(revisions, receipt);
        this.#receipts.push(new WeakRef(receipt));
      }
      this.assertInputsCurrent();
    } catch (error) { this.#release("invalid"); throw error; }
  }
  #live(): void { need(!this.#revoked && (this.#state === "ready" || this.#state === "running")); }
  #assertHostCurrent(): void {
    const runtime = this.#runtime?.deref(), active = this.#assertActive?.deref(), boundary = this.#boundary?.deref();
    const files = this.#files?.deref(), ctx = this.#ctx?.deref(), ctxSignal = this.#ctxSignal?.deref();
    need(runtime && active && boundary && files && ctx && (!this.#ctxSignal || ctxSignal));
    active.call(runtime);
    currentBoundary.call(boundary, this.#generation);
    if (ctxSignal) abort.call(ctxSignal);
    need(runtime.assertActive === active && runtime.executionBoundary === boundary && runtime.nativeFiles === files
      && !ownerState.call(files).closed && ctx.cwd === this.#cwd && ctx.sessionManager.getSessionId() === this.#session
      && ctx.signal === ctxSignal);
    this.#live();
  }
  #invalidate(): void {
    this.#revoked = true;
    if (this.#pending) this.#state = "closing";
    else this.#release("invalid");
  }
  readonly assertSessionCurrent = (): true => {
    this.#checks++;
    if (this.#checking) { this.#invalidate(); throw new Error(STALE); }
    this.#checking = true;
    try {
      this.#live();
      const files = this.#files?.deref(), ctx = this.#ctx?.deref(), execution = this.#execution?.deref();
      const signal = this.#signal?.deref(), callTool = this.#callTool?.deref(), findTool = this.#findTool?.deref();
      const source = this.#source, checkSource = this.#checkSource;
      need(files && ctx && execution && signal && callTool && findTool && this.#request);
      need(this.#request.inputs.length ? source && checkSource && source.current === checkSource : !source && !checkSource);
      abort.call(signal); this.#assertHostCurrent(); checkSource?.();
      const cwd = ctx.cwd, parent = execution.parentToolCallId, method = execution.callTool;
      need(execution.findTool === findTool);
      for (const row of this.#tools) {
        const tool = row.tool.deref(), execute = row.execute.deref();
        need(tool && execute && findTool.call(execution, row.name) === tool && tool.execute === execute
          && !tool.orchestration && !tool.interactionBoundary && !tool.modelOnly);
      }
      // Repeat original host checks for both branches; the optional source also
      // checks its original service. Trusted host callbacks are not a security boundary.
      checkSource?.(); this.#assertHostCurrent(); abort.call(signal); this.#live();
      need(this.#source === source && this.#checkSource === checkSource && (!source || source.current === checkSource)
        && this.#files?.deref() === files && this.#ctx?.deref() === ctx
        && this.#execution?.deref() === execution && this.#signal?.deref() === signal
        && cwd === this.#cwd && parent === this.#parent && method === callTool
        && execution.parentToolCallId === this.#parent && execution.callTool === callTool && execution.findTool === findTool);
      this.#live(); return true;
    } catch (error) { this.#invalidate(); throw error; }
    finally { this.#checking = false; }
  };
  readonly assertInputsCurrent = (): true => {
    this.#inputChecks++; this.assertSessionCurrent();
    try {
      const source = this.#source, request = this.#request!;
      const revisions = source ? sourceRevisions.call(source) as FileRevisions : undefined;
      need(this.#receipts.length === request.inputs.length);
      need(request.inputs.length ? revisions : !source && !this.#checkSource);
      for (let index = 0; index < request.inputs.length; index++) {
        need(revisions);
        const original = this.#receipts[index]!.deref();
        need(original && getReceipt.call(revisions, request.inputs[index]!.snapshot) === original);
        currentReceipt.call(revisions, original);
      }
      this.assertSessionCurrent(); return true;
    } catch (error) { this.#invalidate(); throw error; }
  };
  /** Single transfer to a trusted host coordinator. It must settle its own VM/capture
   * responsibilities before returning; dispose here never pretends to stop them. */
  async run<T>(work: (original: SandboxTaskBorrow) => Promise<T>): Promise<T> {
    need(!this.#used && !this.#pending); this.#used = true; this.#pending = true; this.#state = "running";
    let borrowed: SandboxTaskBorrow | undefined, completed = false;
    try {
      need(typeof work === "function"); this.assertInputsCurrent();
      const files = this.#files!.deref(), ctx = this.#ctx!.deref(), execution = this.#execution!.deref(), signal = this.#signal!.deref();
      const runtime = this.#runtime!.deref();
      need(files && runtime && ctx && execution && signal && this.#request);
      borrowed = Object.freeze({ request: this.#request, files, runtime, ctx, execution, signal,
        assertSessionCurrent: this.assertSessionCurrent, assertInputsCurrent: this.assertInputsCurrent });
      const result = await work(borrowed);
      // Successful original file_batch may have consumed the selected receipts.
      // Its mutation checks, not a post-commit baseline lookup, own correctness.
      this.assertSessionCurrent(); completed = true; return result;
    } finally {
      borrowed = undefined; this.#pending = false; this.#release(completed ? "disposed" : "invalid");
    }
  }
  /** Invalidates admission immediately. A pending borrow remains owned until it settles. */
  dispose(): void {
    this.#revoked = true;
    if (this.#pending) this.#state = "closing";
    else this.#release("disposed");
  }
  #release(state: string): void {
    this.#state = state; this.#revoked = true;
    if (this.#source) {
      disposeSource.call(this.#source); this.#sourceDisposals++;
      this.#sourceFinal = sourceState.call(this.#source);
    }
    this.#source = undefined; this.#checkSource = undefined; this.#request = undefined; this.#receipts.length = 0;
    this.#files = undefined; this.#ctx = undefined; this.#execution = undefined; this.#signal = undefined;
    this.#runtime = undefined; this.#assertActive = undefined; this.#boundary = undefined; this.#ctxSignal = undefined;
    this.#callTool = undefined; this.#findTool = undefined; this.#tools.length = 0;
    this.#cwd = ""; this.#parent = ""; this.#session = ""; this.#generation = -1;
  }
  get diagnostics() {
    return { state: this.#state, pending: this.#pending, used: this.#used, checks: this.#checks, inputChecks: this.#inputChecks,
      sourceDisposals: this.#sourceDisposals, retainedSource: !!this.#source, retainedSourceCheck: !!this.#checkSource, retainedRequest: !!this.#request,
      receiptReferences: this.#receipts.length, toolReferences: this.#tools.length, weakReferences: Number(!!this.#files) + Number(!!this.#ctx)
        + Number(!!this.#execution) + Number(!!this.#signal) + Number(!!this.#callTool) + Number(!!this.#findTool)
        + Number(!!this.#runtime) + Number(!!this.#assertActive) + Number(!!this.#boundary) + Number(!!this.#ctxSignal) + this.#tools.length * 2,
      metadataChars: this.#cwd.length + this.#parent.length + this.#session.length, boundaryGeneration: this.#generation,
      source: this.#source ? sourceState.call(this.#source) : this.#sourceFinal };
  }
}
