import type { ToolInvocationAuthorization } from "@super-pi/agent-core";
import type { EventBus } from "../event-bus.ts";
import type { ExtensionContext, ExtensionRuntime, RegisteredCommand, ToolCallEvent, ToolDefinition } from "../extensions/types.ts";
import { createSyntheticSourceInfo } from "../source-info.ts";
import { FileService, FILE_MUTATION_PROGRESS_ENTRY, type FileMutationService, type FileOperation, type FileExecutionHooks } from "./file-service.ts";
import { FileBatchParameters } from "./file-batch-protocol.ts";
import { renderBatchResult } from "./file-results.ts";
import { FileMutation } from "./file-mutation.ts";
import { CopyParameters, DeleteParameters, MoveParameters } from "./file-operation-input.ts";
import { renderWriteResult } from "./write-renderer.ts";
import { PublicEditParameters, NativeWriteParameters, SandboxEditParameters, SandboxWriteParameters } from "./file-parameters.ts";
import { boundedReason } from "./file-tree-core.mjs";
import { consumePermissionPathApproval, mutationRequestHash, type PermissionPathApproval } from "./file-invocation.ts";
import { registerChanges, type ObservationPermissions } from "./changes.ts";
import { issueSnapshotForRead } from "./snapshot-line-edit.ts";
import { directoryKey } from "./file-creation.ts";
import { FILE_OWNER_EVENT } from "./file-host.ts";
import { FileResultReader } from "./file-result-store.ts";
import { FileResultParameters } from "./file-result-protocol.ts";
import type { ReadToolInput } from "../tools/read.ts";
import type { SnapshotReadResult } from "./snapshot-line-edit.ts";
import type { ReadonlySessionManager } from "../session-manager.ts";
import { SessionFileRevisionSource, type AssertReadSource } from "./session-file-revision-source.ts";
import { SessionInputReadPermission, originalSourceRevisions, type InputReadBoundary, type AssertInputReadOwner } from "./session-input-read-permission.ts";
import { SessionInputWorkspacePermission, type InputWorkspaceBoundary } from "./session-input-workspace-permission.ts";

const PREPARATION = Symbol.for("pi.mutation-guard.file-batch.preparation.v1");
const EXECUTION = Symbol("native-file-execution");
const LIFECYCLE_EVENTS = new Set(["session_start", "session_before_switch", "session_before_tree", "session_tree", "session_before_shutdown", "session_shutdown"]);
const MUTATIONS = new Set(["edit", "write", "copy", "delete", "move", "file_batch"]);
const STALE = "[STALE_STATE] File invocation belongs to a released or changed session.";
type FileToolName = FileOperation | "file_batch";
export type SandboxFileServiceFactory = (event: ToolCallEvent, ctx: ExtensionContext, canonicalPaths: readonly string[]) => FileMutationService;

class NativeFileInvocation implements ToolInvocationAuthorization {
  readonly finalAuthority = true;
  readonly id: string;
  readonly name: FileToolName;
  private owner: SessionFiles | undefined;
  private service: FileMutationService | undefined;
  private ctx: ExtensionContext | undefined;
  private original: object | undefined;
  private mutation: FileMutation | undefined;
  private permission: PermissionPathApproval | undefined;
  private hash = "";
  private transferred = false;
  private working = false;
  private revoked = false;
  private disposal: Promise<void> | undefined;
  private readonly generation: number;
  private readonly continuationOwner: string;
  constructor(owner: SessionFiles, service: FileMutationService, event: ToolCallEvent, ctx: ExtensionContext) {
    this.owner = owner; this.service = service; this.original = event.input; this.ctx = ctx;
    this.id = event.toolCallId; this.name = event.toolName as FileToolName; this.generation = service.revisions.generation;
    this.continuationOwner = event.parentToolCallId ?? event.toolCallId;
  }
  readonly assertCurrent = (): void => {
    if (this.revoked || !this.owner || !this.service || !this.ctx) throw new Error(STALE);
    this.owner.assertCurrent(this.service, this.ctx, this.generation);
    this.ctx.signal?.throwIfAborted(); this.permission?.assertCurrent?.();
  };
  readonly record = (entry: Record<string, unknown>): void => {
    if (!this.owner) throw new Error(STALE);
    // Close/reset waits for active effects before switching the journal's session.
    this.owner.record(entry);
  };
  async prepare(): Promise<void> {
    this.working = true;
    try {
      this.assertCurrent();
      this.mutation = new FileMutation(this.service!, this.id, this.name, this.original);
      await this.mutation.prepare(this.ctx!.signal); this.hash = this.mutation.requestHash;
      this.assertCurrent();
      Object.defineProperty(this.original, PREPARATION, { configurable: true, value: this.mutation });
      this.assertCurrent();
    } finally { this.working = false; if (this.revoked) await this.dispose(); }
  }
  readonly describePreflight = (): string => { this.assertCurrent(); return this.mutation!.describePreflight(); };
  preparation(input: unknown, id: string, name: string): FileMutation | undefined {
    this.assertCurrent();
    return input === this.original && id === this.id && name === this.name && !this.transferred ? this.mutation : undefined;
  }
  consume(args: unknown, id: string, name: string, signal?: AbortSignal): unknown {
    try {
      this.assertCurrent(); signal?.throwIfAborted();
      if (this.transferred || args !== this.original || id !== this.id || name !== this.name
        || mutationRequestHash(this.name, args) !== this.hash) throw new Error(STALE);
      this.permission = consumePermissionPathApproval(args, id, this.name);
      if (this.owner!.requiresPermission && !this.permission?.assertCurrent) throw new Error("[POLICY_BLOCKED] Native file operation requires the current compatibility boundary's approval.");
      const target = this.mutation?.items[0]?.target;
      if (this.permission && (!target || directoryKey(this.permission.canonicalTarget) !== directoryKey(target))) throw new Error(STALE);
      const approvedPaths = this.permission?.canonicalPaths;
      if (approvedPaths) {
        let cursor = 0;
        const externalCreates = new Set(this.permission!.newExternalFiles);
        for (const item of this.mutation!.items) {
          for (const path of item.paths) {
            if (cursor >= approvedPaths.length || directoryKey(approvedPaths[cursor++]!) !== directoryKey(path)) throw new Error(STALE);
          }
          if (externalCreates.has(item.target) && !item.creation
            || item.tree?.destination && externalCreates.has(item.tree.destination) && item.tree.destinationIdentity)
            throw new Error("[TARGET_APPEARED] An external create cannot overwrite a file that appeared after authorization.");
        }
        if (cursor !== approvedPaths.length) throw new Error(STALE);
      }
      this.assertCurrent();
      const approved = {};
      Object.defineProperty(approved, EXECUTION, { value: this });
      this.transferred = true;
      return approved;
    } finally { this.release(); }
  }
  release(): void {
    if (this.mutation && this.original && (this.original as any)[PREPARATION] === this.mutation) {
      Object.defineProperty(this.original, PREPARATION, { configurable: true, value: undefined });
    }
    this.original = undefined;
    if (!this.transferred) this.revoke();
  }
  revoke(): void {
    this.revoked = true;
    this.mutation?.release();
    if (!this.working) this.dispose();
  }
  private readonly releaseReferences = (): void => {
    this.owner?.finish(this.id, this);
    if (this.service) this.owner?.releaseSandboxService(this.service);
    this.mutation?.release();
    this.owner = undefined; this.service = undefined; this.ctx = undefined; this.original = undefined;
    this.mutation = undefined; this.permission = undefined; this.hash = "";
  };
  private dispose(): Promise<void> | void {
    if (this.disposal) return this.disposal;
    if (this.service?.closeInvocation) {
      this.disposal = this.service.closeInvocation().finally(this.releaseReferences);
      this.owner?.trackCleanup(this.disposal); return this.disposal;
    }
    this.releaseReferences();
  }
  async waitForDisposal(): Promise<void> { await this.disposal; }
  async execute(signal?: AbortSignal) {
    if (!this.transferred || this.working) throw new Error(STALE);
    this.working = true;
    try {
      this.assertCurrent();
      const hooks: FileExecutionHooks = { assertCurrent: this.assertCurrent, record: this.record, signal, continuationOwner: this.continuationOwner,
        authorizationGeneration: this.permission?.sequence ?? 0 };
      return await this.mutation!.execute(this.ctx!.sessionManager, this.owner!.appendFileEntry, hooks);
    } finally { this.working = false; await this.dispose(); }
  }
}

/** Native state and lifecycle, created before optional extensions and shared by their compatibility adapters. */
export class SessionFiles implements ObservationPermissions {
  command!: RegisteredCommand;
  private readonly runtime: ExtensionRuntime;
  private readonly definitions = new WeakSet<ToolDefinition>();
  private readonly calls = new Map<string, NativeFileInvocation>();
  private readonly inFlight = new Set<Promise<unknown>>();
  private readonly cleanups = new Set<Promise<void>>();
  private readonly stopDiscovery: () => void;
  private service: FileService | undefined;
  private sandboxFactory: SandboxFileServiceFactory | undefined;
  private sandboxObserver: ObservationPermissions["observeFileChange"] | undefined;
  private readonly sandboxServices = new Set<FileMutationService>();
  private cleanupFailure: string | undefined;
  private resultReader: FileResultReader | undefined;
  private resultSessionManager: ReadonlySessionManager | undefined;
  private boundary: ObservationPermissions | undefined;
  private accepting = true;
  private closed = false;
  private disposal: Promise<void> | undefined;
  private resetting: Promise<void> | undefined;
  private pinningReadSource = false;
  private readSourcePinFailed = false;
  constructor(runtime: ExtensionRuntime, events: EventBus) {
    this.runtime = runtime;
    runtime.executionBoundary.register("native-files", { revoke: this.revokeExecution, drain: () => this.reset() });
    this.stopDiscovery = runtime.trackEventBusSubscription(events.on(FILE_OWNER_EVENT, request => { (request as { owner?: SessionFiles }).owner = this; }));
    registerChanges({ registerCommand: (name, options) => { this.command = { ...options, name, sourceInfo: createSyntheticSourceInfo(`<builtin:${name}>`, { source: "builtin" }) }; },
      appendEntry: (kind, data) => runtime.appendEntry(kind, data) }, this);
  }
  get requiresPermission(): boolean { return this.boundary !== undefined || this.runtime.nativePermissions !== undefined; }
  get fileObservationEnvironment(): "sandbox" | "trusted-host" { return this.runtime.parentExecution ? "sandbox" : this.runtime.nativePermissions?.environment ?? "trusted-host"; }
  get hasNativeAuthorization(): boolean { return this.runtime.parentExecution !== undefined || this.boundary !== undefined && this.boundary === this.runtime.nativePermissions; }
  setCompatibilityBoundary(boundary: ObservationPermissions): void {
    if (this.boundary && this.boundary !== boundary) throw new Error("Native files already have an access boundary.");
    this.boundary = boundary;
  }
  ownsDefinition(definition: ToolDefinition | undefined): boolean { return definition !== undefined && this.definitions.has(definition); }
  hasRevision(id: string, canonicalPath: string, sessionId: string): boolean {
    if (this.closed || !this.accepting || this.service?.sessionId !== sessionId) return false;
    const receipt = this.service.revisions.get(id);
    return receipt !== undefined && receipt.canonicalPath === canonicalPath;
  }
  forgetContinuations(owner: string, callId?: string): void { this.service?.revisions.forgetContinuations(owner, callId); }
  hasHandlers(event: string): boolean { return event === "tool_call" || LIFECYCLE_EVENTS.has(event); }
  /** Low-frequency host input preparation only; never creates a service or grants path access. */
  pinReadRevisions(ctx: ExtensionContext): SessionFileRevisionSource {
    if (this.pinningReadSource) { this.readSourcePinFailed = true; throw new Error(STALE); }
    this.pinningReadSource = true; this.readSourcePinFailed = false;
    let source: SessionFileRevisionSource | undefined;
    try {
      const service = this.service;
      if (!service) throw new Error(STALE);
      source = new SessionFileRevisionSource(this, service, ctx, this.runtime, SessionFiles.assertReadSource);
      if (this.readSourcePinFailed) throw new Error(STALE);
      return source;
    } catch (error) { source?.dispose(); throw error; }
    finally { this.pinningReadSource = false; this.readSourcePinFailed = false; }
  }
  private static readonly assertReadSource: AssertReadSource = (owner, service, ctx, runtime, boundary, generation, signal, cwd, sessionId) => {
    assertOriginalSessionCurrent.call(owner, service, ctx, generation);
    // Context getters may synchronously close/reset/reenter. Check private ownership
    // after every external observation has returned, without another context getter.
    runtime.assertActive();
    const currentCwd = ctx.cwd, currentSession = ctx.sessionManager.getSessionId(), currentSignal = ctx.signal;
    // Original signal uses the fixed AbortSignal prototype in the source before/after
    // this callback. Do not add a replaceable signal method call after these samples.
    if (owner.runtime !== runtime || owner.closed || !owner.accepting || owner.service !== service
      || runtime.executionBoundary !== boundary || currentCwd !== cwd || currentSession !== sessionId
      || currentSignal !== signal || service.cwd !== cwd || service.sessionId !== sessionId) throw new Error(STALE);
  };
  /** Low-frequency input preparation. Missing service/explicit permission boundary
   * is a refusal; this path never calls getService or creates read evidence. */
  pinInputReadPermission(ctx: ExtensionContext, source: SessionFileRevisionSource, paths: readonly string[]): SessionInputReadPermission {
    const boundary = this.boundary as InputReadBoundary | undefined;
    if (!this.service || !boundary || typeof boundary.prepareInputRead !== "function") throw new Error(STALE);
    return new SessionInputReadPermission(this, this.service, ctx, source, boundary, paths, SessionFiles.assertInputReadOwner);
  }
  private static readonly assertInputReadOwner: AssertInputReadOwner = (owner, service, ctx, source, boundary, finalOnly) => {
    if (owner.service !== service || owner.boundary !== boundary) throw new Error(STALE);
    if (!finalOnly) {
      if (originalSourceRevisions(source) !== service.revisions) throw new Error(STALE);
      assertOriginalSessionCurrent.call(owner, service, ctx, service.revisions.generation);
      source.current();
    }
    // Pure final phase: never invoke a context/runtime getter after sampling ctx.
    if (owner.closed || !owner.accepting || owner.service !== service || owner.boundary !== boundary
      || originalReadSourceState.call(source).state !== "active") throw new Error(STALE);
  };
  /** Obtain a grant only through this existing service's original installed
   * compatibility boundary. No caller-supplied lease or descriptor is accepted. */
  pinInputWorkspacePermission(ctx: ExtensionContext, source: SessionFileRevisionSource, paths: readonly string[]): SessionInputWorkspacePermission {
    const boundary = this.boundary as InputWorkspaceBoundary | undefined;
    if (!this.service || !boundary || typeof boundary.prepareInputWorkspaceRead !== "function") throw new Error(STALE);
    return new SessionInputWorkspacePermission(this, this.service, ctx, source, boundary, paths, SessionFiles.assertInputReadOwner);
  }
  private getService(ctx: ExtensionContext): FileService {
    this.runtime.assertActive();
    this.runtime.executionBoundary.assertCurrent();
    if (this.closed || !this.accepting) throw new Error(STALE);
    if (this.runtime.parentExecution || this.runtime.nativePermissions?.environment === "sandbox") throw new Error("[SANDBOX_UNSUPPORTED] Native file service is unavailable for sandbox or parent-dispatched workspace operations.");
    const id = ctx.sessionManager.getSessionId();
    if (this.service && (this.service.cwd !== ctx.cwd || this.service.sessionId !== id)) {
      // Direct SDK SessionManager replacement may bypass the event boundary. Never carry
      // revisions across it, and require active operations to drain through normal reset.
      if (this.calls.size || this.inFlight.size) throw new Error(STALE);
      this.service.dispose(); this.service = undefined;
    }
    return this.service ??= new FileService(ctx.cwd, id);
  }
  assertCurrent(service: FileMutationService, ctx: ExtensionContext, generation: number): void {
    this.runtime.assertActive();
    this.runtime.executionBoundary.assertCurrent();
    if (this.closed || !this.accepting || this.service !== service && !this.sandboxServices.has(service) || generation !== service.revisions.generation
      || ctx.cwd !== service.cwd || ctx.sessionManager.getSessionId() !== service.sessionId) throw new Error(STALE);
  }
  record(entry: Record<string, unknown>): void { this.runtime.appendEntry(FILE_MUTATION_PROGRESS_ENTRY, entry); }
  /** Publication returns the ID from the session append itself, never a sampled leaf. */
  appendFileEntry = (kind: string, data: unknown): string => {
    if (!this.runtime.appendFileEntry) throw new Error("[FILE_RESULT_CLOSED] Native journal publication is unavailable.");
    return this.runtime.appendFileEntry(kind, data);
  };
  installResultTool(base: Record<string, ToolDefinition>): void {
    const owner = this;
    const definition: ToolDefinition<any, any> = {
      name: "file_result", label: "file_result", parameters: FileResultParameters, executionMode: "sequential",
      description: "Page structured file mutation records from this session's selected branch using resultRef. Reads session metadata only; does not issue file versions or repeat operations.",
      async execute(_id, input, signal, _update, ctx) {
        owner.runtime.assertActive(); owner.runtime.executionBoundary.assertCurrent(); signal?.throwIfAborted();
        if (owner.closed || !owner.accepting) throw new Error(STALE);
        if (!owner.resultReader || owner.resultSessionManager !== ctx.sessionManager) {
          owner.resultReader?.dispose(); owner.resultReader = new FileResultReader(ctx.sessionManager); owner.resultSessionManager = ctx.sessionManager;
        }
        const args = input as { ref: string; cursor?: string; limit?: number };
        const page = owner.resultReader.read(args.ref, args.cursor, args.limit);
        return { content: [{ type: "text", text: JSON.stringify(page) }], details: page };
      },
    };
    this.definitions.add(definition); base.file_result = definition;
  }
  finish(id: string, invocation?: NativeFileInvocation): void {
    const current = this.calls.get(id);
    if (!current || invocation && current !== invocation) return;
    this.calls.delete(id);
    if (!invocation) current.revoke();
  }
  private async track<T>(pending: Promise<T>): Promise<T> {
    this.inFlight.add(pending);
    try { return await pending; } finally { this.inFlight.delete(pending); }
  }
  private readonly observeCleanupFailure = (error: unknown): void => { this.cleanupFailure = boundedReason(error instanceof Error ? error.message : String(error)); };
  trackCleanup(pending: Promise<void>): void { void this.observeCleanup(pending); }
  private async observeCleanup(pending: Promise<void>): Promise<void> {
    this.cleanups.add(pending);
    try { await this.track(pending); }
    catch (error) { this.observeCleanupFailure(error); }
    finally { this.cleanups.delete(pending); }
  }
  releaseSandboxService(service: FileMutationService): void { this.sandboxServices.delete(service); }
  getPreparedMutation(input: unknown, id: string, name: string): FileMutation | undefined {
    return this.calls.get(id)?.preparation(input, id, name);
  }
  async prepareInvocation(event: ToolCallEvent, ctx: ExtensionContext, canonicalPaths?: readonly string[]): Promise<(ToolInvocationAuthorization & { describePreflight(): string }) | undefined> {
    if (!MUTATIONS.has(event.toolName)) return;
    // A refused or revoked grant releases asynchronously. Do not start a new
    // invocation while that prior owner's artifact cleanup is unconfirmed.
    for (const pending of this.cleanups) await pending;
    if (this.cleanupFailure) throw new Error(this.cleanupFailure);
    if (this.calls.size >= 128 || this.inFlight.size >= 128 || this.calls.has(event.toolCallId)) throw new Error("Native file invocation capacity or duplicate call ID.");
    let service: FileMutationService;
    if (this.runtime.nativePermissions?.environment === "sandbox") {
      if (!this.sandboxFactory || !canonicalPaths) throw new Error("[SANDBOX_UNSUPPORTED] File mutation requires its complete sandbox preflight and policy path table.");
      service = this.sandboxFactory(event, ctx, canonicalPaths); this.sandboxServices.add(service);
    } else service = this.getService(ctx);
    const invocation = new NativeFileInvocation(this, service, event, ctx);
    this.calls.set(event.toolCallId, invocation);
    try { await this.track(invocation.prepare()); return invocation; }
    catch (error) { invocation.release(); await invocation.waitForDisposal(); throw error; }
  }
  install(base: Record<string, ToolDefinition>, captureRevisions = true, preserveProtectedWrite = false): void {
    this.sandboxFactory = undefined; this.sandboxObserver = undefined;
    this.installResultTool(base);
    const owner = this;
    const read = base.read;
    if (read) {
      const execute = read.execute;
      // Mutate this exact fresh definition so the native read's evidence-capture closure stays connected.
      read.execute = async function readWithRevision(id, input, signal, update, ctx, nested) {
        const service = owner.getService(ctx), generation = service.revisions.generation;
        if (owner.inFlight.size >= 128) throw new Error("Too many pending native file reads.");
        async function capture() {
          const result = await execute.call(read, id, input, signal, update, ctx, nested);
          owner.assertCurrent(service, ctx, generation); signal?.throwIfAborted();
          // A literal read-only SDK allowlist cannot consume file revisions. Keep its original
          // one-block read contract and existing Evidence Ledger reuse without extra file capture.
          if (!captureRevisions) return result;
          const annotation = await issueSnapshotForRead(service.sessionId, service.cwd, input as ReadToolInput, result as SnapshotReadResult, service.revisions);
          owner.assertCurrent(service, ctx, generation); signal?.throwIfAborted();
          if (annotation) result.content.push({ type: "text", text: annotation, readBoundary: "metadata" } as any);
          return result;
        }
        return owner.track(capture());
      };
    }
    this.installMutations(base, preserveProtectedWrite, false);
  }
  installSandbox(base: Record<string, ToolDefinition>, factory: SandboxFileServiceFactory, observer?: ObservationPermissions["observeFileChange"]): void {
    this.sandboxFactory = factory; this.sandboxObserver = observer; this.installMutations(base, false, true);
  }
  releaseSandboxFactory(factory: SandboxFileServiceFactory): void {
    if (this.sandboxFactory === factory) { this.sandboxFactory = undefined; this.sandboxObserver = undefined; }
  }
  private installMutations(base: Record<string, ToolDefinition>, preserveProtectedWrite: boolean, sandbox: boolean): void {
    const owner = this;
    for (const name of ["edit", "write", "copy", "delete", "move", "file_batch"] as const) {
      // The explicit experimental journal owns its construction-time write gate.
      if (name === "write" && preserveProtectedWrite) continue;
      const parameters = name === "edit" ? sandbox ? SandboxEditParameters : PublicEditParameters : name === "write" ? sandbox ? SandboxWriteParameters : NativeWriteParameters : name === "file_batch" ? FileBatchParameters
        : name === "copy" ? CopyParameters : name === "move" ? MoveParameters : DeleteParameters;
      const definition: ToolDefinition<any, any> = {
        name, label: sandbox ? name + " (Sandbox)" : name, parameters, executionMode: "sequential", renderResult: name === "write" ? renderWriteResult : renderBatchResult,
        renderCall: base[name]?.renderCall, collapseCallOnResult: name === "write",
        description: name === "edit" ? sandbox ? "Edit one sandbox file using exact unique replacements and its current SHA-256 snapshot. Clean own writes/edits return the successor snapshot. Read current bytes again after a stale snapshot." : "Edit one current file version by exact unique text or observed snapshot LINE#ID anchors. A clean own edit/write retains its version for continued exact-text edits; external changes invalidate it."
          : name === "write" ? sandbox ? "Create a missing UTF-8 sandbox file exclusively, or replace an existing file using its current SHA-256 snapshot. Missing parents may be created; a clean own write/edit returns its successor snapshot." : "Create a missing UTF-8 file exclusively, or replace an existing file using a current read or clean own committed version. Missing parents may be created."
          : name === "delete" ? "Irreversibly delete one target or nonempty paths array. Nonempty directories require recursive: true. Links are unlinked without following them. No target count cap; independent ordinary failures continue. Use resultRef with file_result for full outcomes."
          : name === "move" ? "Move one source/destination or nonempty items array without overwriting, including directories and cross-volume files. Source links refuse preflight; partial effects retain unverified sources. No target count cap or automatic replay; full outcomes are paged by file_result."
          : name === "copy" ? "Copy one source/destination or nonempty items array, including directories. No directory merge; nested links are skipped and counted. overwrite: true only replaces existing regular files through the metadata commit owner. No target count cap; full outcomes are paged by file_result."
          : "Prepare all independent file operations, then apply in fixed order with no target count cap. Write requires create or overwrite mode. Stop on first failure; retain each outcome in resultRef for file_result. No rollback or automatic replay.",
        promptGuidelines: name === "edit" || name === "write" ? sandbox ? ["Use the verified details.snapshot SHA-256 from a read, clean own write/edit, or its file_result record. resultRef and result.ref are references, never file versions. A stale SHA requires read and reconciliation."] : ["Read and edit may share one script without show(). After a clean own edit/write with details.revisionContinuation=available, exact-text edits continue automatically without a reread. New LINE#ID anchors still require read. On external change, conflict, eviction or unavailable continuation, read the exact target; never invent a snapshot or use result.ref as a version."] : undefined,
        async execute(id, input, signal) {
          const invocation = (input as { [EXECUTION]?: NativeFileInvocation } | undefined)?.[EXECUTION];
          if (!invocation || invocation.id !== id || invocation.name !== name || owner.calls.get(id) !== invocation) throw new Error("Native file operation requires its prepared invocation.");
          if (owner.inFlight.size >= 128) { invocation.revoke(); throw new Error("Too many pending native file operations."); }
          return owner.track(invocation.execute(signal));
        },
      };
      this.definitions.add(definition); base[name] = definition;
    }
  }
  async observeFileChange(ctx: ExtensionContext, record: Parameters<NonNullable<ObservationPermissions["observeFileChange"]>>[1]) {
    this.runtime.assertActive(); this.runtime.executionBoundary.assertCurrent();
    if (!this.sandboxObserver) throw new Error("[SANDBOX_UNSUPPORTED] Current-state verification requires the sandbox backend; no host observation was performed.");
    return this.sandboxObserver(ctx, record);
  }
  async authorizeFileObservation(ctx: ExtensionContext, paths: readonly string[]) {
    if (this.boundary) return this.boundary.authorizeFileObservation(ctx, paths);
    const service = this.getService(ctx), generation = service.revisions.generation;
    const assertCurrent = () => this.assertCurrent(service, ctx, generation);
    return Object.assign(async () => assertCurrent(), { assertCurrent });
  }
  async emit(event: { type: string }): Promise<void> {
    if (event.type === "session_shutdown") return this.dispose();
    if (LIFECYCLE_EVENTS.has(event.type)) await this.reset();
  }
  private async reset(): Promise<void> {
    if (this.resetting) return this.resetting;
    const pending = this.drain();
    this.resetting = pending;
    try { await pending; }
    finally { this.calls.clear(); this.service = undefined; this.sandboxServices.clear(); this.resetting = undefined; this.accepting = !this.closed; }
  }
  private readonly revokeExecution = (): void => {
    this.accepting = false;
    this.resultReader?.dispose(); this.resultReader = undefined; this.resultSessionManager = undefined;
    this.service?.dispose();
    for (const invocation of this.calls.values()) invocation.revoke();
  };
  private async drain(): Promise<void> {
    this.revokeExecution();
    for (const pending of this.inFlight) { try { await pending; } catch { /* The original caller receives its failure. */ } }
    if (this.cleanupFailure) throw new Error(this.cleanupFailure);
  }
  dispose(): Promise<void> {
    if (!this.disposal) { this.closed = true; this.stopDiscovery(); this.disposal = this.reset(); this.boundary = undefined; this.sandboxFactory = undefined; this.sandboxObserver = undefined; }
    return this.disposal;
  }
  getDiagnostics() { return { pending: this.calls.size, inFlight: this.inFlight.size, revisions: this.service?.revisions.size ?? 0, closed: this.closed }; }
}
const assertOriginalSessionCurrent = SessionFiles.prototype.assertCurrent;
const originalReadSourceState = Object.getOwnPropertyDescriptor(SessionFileRevisionSource.prototype, "diagnostics")!.get!;
