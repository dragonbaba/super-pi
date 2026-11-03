import type { ToolInvocationAuthorization } from "@super-pi/agent-core";
import { Type } from "typebox";
import type { EventBus } from "../event-bus.ts";
import type { ExtensionContext, ExtensionRuntime, RegisteredCommand, ToolCallEvent, ToolDefinition } from "../extensions/types.ts";
import { createSyntheticSourceInfo } from "../source-info.ts";
import { FileService, FILE_MUTATION_PROGRESS_ENTRY, type PreparedFileItem, type FileOperation, type FileExecutionHooks } from "./file-service.ts";
import { FileBatch, FileBatchParameters, renderBatchResult } from "./file-batch.ts";
import { renderWriteResult } from "./write-renderer.ts";
import { PublicEditParameters, NativeWriteParameters } from "./file-parameters.ts";
import { consumePermissionPathApproval, mutationRequestHash, type PermissionPathApproval } from "./file-invocation.ts";
import { registerChanges, type ObservationPermissions } from "./changes.ts";
import { issueSnapshotForRead } from "./snapshot-line-edit.ts";
import { displayMetadata } from "./change-preview.ts";
import { commitSummary } from "./file-commit.ts";
import { directoryKey } from "./file-creation.ts";
import { FILE_OWNER_EVENT } from "./file-host.ts";
import type { ReadToolInput } from "../tools/read.ts";
import type { SnapshotReadResult } from "./snapshot-line-edit.ts";
import { SessionFileRevisionSource, type AssertReadSource } from "./session-file-revision-source.ts";
import { SessionInputReadPermission, originalSourceRevisions, type InputReadBoundary, type AssertInputReadOwner } from "./session-input-read-permission.ts";
import { SessionInputWorkspacePermission, type InputWorkspaceBoundary } from "./session-input-workspace-permission.ts";

const PREPARATION = Symbol.for("pi.mutation-guard.file-batch.preparation.v1");
const EXECUTION = Symbol("native-file-execution");
const LIFECYCLE_EVENTS = new Set(["session_start", "session_before_switch", "session_before_tree", "session_tree", "session_before_shutdown", "session_shutdown"]);
const MUTATIONS = new Set(["edit", "write", "delete", "move", "file_batch"]);
const STALE = "[STALE_STATE] File invocation belongs to a released or changed session.";
type FileToolName = FileOperation | "file_batch";

class NativeFileInvocation implements ToolInvocationAuthorization {
  readonly finalAuthority = true;
  readonly id: string;
  readonly name: FileToolName;
  private owner: SessionFiles | undefined;
  private service: FileService | undefined;
  private ctx: ExtensionContext | undefined;
  private original: object | undefined;
  private item: PreparedFileItem | undefined;
  private batch: FileBatch | undefined;
  private permission: PermissionPathApproval | undefined;
  private hash = "";
  private transferred = false;
  private working = false;
  private revoked = false;
  private readonly generation: number;
  constructor(owner: SessionFiles, service: FileService, event: ToolCallEvent, ctx: ExtensionContext) {
    this.owner = owner; this.service = service; this.original = event.input; this.ctx = ctx;
    this.id = event.toolCallId; this.name = event.toolName as FileToolName; this.generation = service.revisions.generation;
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
      if (this.name === "file_batch") {
        this.batch = new FileBatch(this.service!, this.id, this.original);
        await this.batch.prepare(this.ctx!.signal);
        this.hash = this.batch.requestHash;
        this.assertCurrent();
        Object.defineProperty(this.original, PREPARATION, { configurable: true, value: this.batch });
      } else {
        this.item = await this.service!.prepare(this.name, this.original, this.ctx!.signal);
        this.hash = this.item.requestHash;
      }
      this.assertCurrent();
    } finally { this.working = false; if (this.revoked) this.dispose(); }
  }
  consume(args: unknown, id: string, name: string, signal?: AbortSignal): unknown {
    try {
      this.assertCurrent(); signal?.throwIfAborted();
      if (this.transferred || args !== this.original || id !== this.id || name !== this.name
        || mutationRequestHash(this.name, args) !== this.hash) throw new Error(STALE);
      this.permission = consumePermissionPathApproval(args, id, this.name);
      if (this.owner!.requiresPermission && !this.permission?.assertCurrent) throw new Error("[POLICY_BLOCKED] Native file operation requires the current compatibility boundary's approval.");
      const target = this.item?.target ?? this.batch?.items[0]?.target;
      if (this.permission && (!target || directoryKey(this.permission.canonicalTarget) !== directoryKey(target))) throw new Error(STALE);
      this.assertCurrent();
      const approved = {};
      Object.defineProperty(approved, EXECUTION, { value: this });
      this.transferred = true;
      return approved;
    } finally { this.release(); }
  }
  release(): void {
    if (this.batch && this.original && (this.original as any)[PREPARATION] === this.batch) {
      Object.defineProperty(this.original, PREPARATION, { configurable: true, value: undefined });
    }
    this.original = undefined;
    if (!this.transferred) this.revoke();
  }
  revoke(): void {
    this.revoked = true;
    this.batch?.release();
    if (!this.working) this.dispose();
  }
  private dispose(): void {
    this.owner?.finish(this.id, this);
    if (this.item) this.service?.release(this.item);
    this.batch?.release();
    this.owner = undefined; this.service = undefined; this.ctx = undefined; this.original = undefined;
    this.item = undefined; this.batch = undefined; this.permission = undefined; this.hash = "";
  }
  async execute(signal?: AbortSignal) {
    if (!this.transferred || this.working) throw new Error(STALE);
    this.working = true;
    try {
      this.assertCurrent();
      const hooks: FileExecutionHooks = { assertCurrent: this.assertCurrent, record: this.record, signal };
      if (this.batch) return await this.batch.execute(hooks);
      const receipt = await this.service!.execute(this.item!, this.id, hooks);
      let text = `${receipt.operation} ${displayMetadata(receipt.target)}: ${receipt.status}`;
      if (receipt.destination) text += ` → ${displayMetadata(receipt.destination)}`;
      if (receipt.commit) text += `\n${commitSummary(receipt.commit)}`;
      if (receipt.created) text += "\nAdded file.";
      if (typeof receipt.cause === "string") text += `\n${displayMetadata(receipt.cause.slice(0, 800))}`;
      if (typeof receipt.patch === "string" && receipt.patch) text += `\n${receipt.patch}`;
      return { content: [{ type: "text" as const, text }], details: receipt, isError: !receipt.ok };
    } finally { this.working = false; this.dispose(); }
  }
}

/** Native state and lifecycle, created before optional extensions and shared by their compatibility adapters. */
export class SessionFiles implements ObservationPermissions {
  command!: RegisteredCommand;
  private readonly runtime: ExtensionRuntime;
  private readonly definitions = new WeakSet<ToolDefinition>();
  private readonly calls = new Map<string, NativeFileInvocation>();
  private readonly inFlight = new Set<Promise<unknown>>();
  private readonly stopDiscovery: () => void;
  private service: FileService | undefined;
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
  get requiresPermission(): boolean { return this.boundary !== undefined; }
  get hasNativeAuthorization(): boolean { return this.boundary !== undefined && this.boundary === this.runtime.nativePermissions; }
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
    const id = ctx.sessionManager.getSessionId();
    if (this.service && (this.service.cwd !== ctx.cwd || this.service.sessionId !== id)) {
      // Direct SDK SessionManager replacement may bypass the event boundary. Never carry
      // revisions across it, and require active operations to drain through normal reset.
      if (this.calls.size || this.inFlight.size) throw new Error(STALE);
      this.service.dispose(); this.service = undefined;
    }
    return this.service ??= new FileService(ctx.cwd, id);
  }
  assertCurrent(service: FileService, ctx: ExtensionContext, generation: number): void {
    this.runtime.assertActive();
    this.runtime.executionBoundary.assertCurrent();
    if (this.closed || !this.accepting || this.service !== service || generation !== service.revisions.generation
      || ctx.cwd !== service.cwd || ctx.sessionManager.getSessionId() !== service.sessionId) throw new Error(STALE);
  }
  record(entry: Record<string, unknown>): void { this.runtime.appendEntry(FILE_MUTATION_PROGRESS_ENTRY, entry); }
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
  async prepareInvocation(event: ToolCallEvent, ctx: ExtensionContext): Promise<ToolInvocationAuthorization | undefined> {
    if (!MUTATIONS.has(event.toolName)) return;
    if (this.calls.size >= 128 || this.inFlight.size >= 128 || this.calls.has(event.toolCallId)) throw new Error("Native file invocation capacity or duplicate call ID.");
    const invocation = new NativeFileInvocation(this, this.getService(ctx), event, ctx);
    this.calls.set(event.toolCallId, invocation);
    try { await this.track(invocation.prepare()); return invocation; }
    catch (error) { invocation.release(); throw error; }
  }
  install(base: Record<string, ToolDefinition>, captureRevisions = true, preserveProtectedWrite = false): void {
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
    for (const name of ["edit", "write", "delete", "move", "file_batch"] as const) {
      // The explicit experimental journal owns its construction-time write gate.
      if (name === "write" && preserveProtectedWrite) continue;
      const parameters = name === "edit" ? PublicEditParameters : name === "write" ? NativeWriteParameters : name === "file_batch" ? FileBatchParameters
        : Type.Object({ path: Type.String({ minLength: 1, maxLength: 4096 }), ...(name === "move" ? { destination: Type.String({ minLength: 1, maxLength: 4096 }) } : {}), purpose: Type.Optional(Type.String({ maxLength: 800 })) }, { additionalProperties: false });
      const definition: ToolDefinition<any, any> = {
        name, label: name, parameters, executionMode: "sequential", renderResult: name === "write" ? renderWriteResult : renderBatchResult,
        renderCall: base[name]?.renderCall, collapseCallOnResult: name === "write",
        description: name === "edit" ? "Edit one current read revision by exact unique text or snapshot LINE#ID anchors. Same-script read then edit is supported. External changes invalidate the revision."
          : name === "write" ? "Create a missing UTF-8 file exclusively, or replace an existing file using its current read revision. Existing targets require read first; missing parents may be created."
          : name === "delete" ? "Irreversibly delete one file or empty directory. No recursive deletion or backup."
          : name === "move" ? "Move one file without overwriting. Exclusive link then unlink may leave both names on partial failure."
          : "Prepare then apply up to 16 independent file operations in fixed order. Write requires create or overwrite mode. Stop on failure, retain each outcome; no rollback or automatic replay.",
        promptGuidelines: name === "edit" || name === "write" ? ["A read revision is a file-version precondition. You may read, compute and edit in one CodeMode script without a separate model turn or show(). Read again after mutation or a version conflict."] : undefined,
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
    finally { this.calls.clear(); this.service = undefined; this.resetting = undefined; this.accepting = !this.closed; }
  }
  private readonly revokeExecution = (): void => {
    this.accepting = false;
    this.service?.dispose();
    for (const invocation of this.calls.values()) invocation.revoke();
  };
  private async drain(): Promise<void> {
    this.revokeExecution();
    for (const pending of this.inFlight) { try { await pending; } catch { /* The original caller receives its failure. */ } }
  }
  dispose(): Promise<void> {
    if (!this.disposal) { this.closed = true; this.stopDiscovery(); this.disposal = this.reset(); this.boundary = undefined; }
    return this.disposal;
  }
  getDiagnostics() { return { pending: this.calls.size, inFlight: this.inFlight.size, revisions: this.service?.revisions.size ?? 0, closed: this.closed }; }
}
const assertOriginalSessionCurrent = SessionFiles.prototype.assertCurrent;
const originalReadSourceState = Object.getOwnPropertyDescriptor(SessionFileRevisionSource.prototype, "diagnostics")!.get!;
