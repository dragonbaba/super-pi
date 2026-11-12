import { randomUUID } from "node:crypto";
import { Value } from "typebox/value";
import type { ExtensionContext, ExtensionRuntime, ToolCallEvent } from "../extensions/types.ts";
import type { SessionExecutionBoundary } from "../execution-boundary.ts";
import type { WorkspaceSandboxBackend, WorkspaceFileRpcContext } from "../sandbox/workspace-backend.ts";
import { workspaceMutationItem } from "../sandbox/workspace-paths.ts";
import { SandboxWriteParameters, SandboxEditParameters } from "./file-parameters.ts";
import { validateWriteContent } from "./revision-mutations.ts";
import { mutationRequestHash } from "./file-invocation.ts";
import { planFileRpc, serializeFileRpc, fileRpcItemChunk, type FileRpcEnvelope, type FileRpcPlan, type FileRpcChunk, type FileRpcControl } from "./file-rpc-chunks.ts";
import { fileRpcReplyItems, fileRpcPreparedManifest, fileRpcValidatedContent, fileRpcExecutedReceipt } from "./file-rpc-replies.ts";
import { readFileWorkerManifest, writeFileParentManifest, readFileParentManifest,
  type FileWorkerInput, type FileWorkerRequest, type PreparedFileWorkerManifest } from "./file-worker-plan.mjs";
import type { OwnedManifestFile } from "./file-manifest-artifact.mjs";
import type { FileOperation, FileOperationInput, FileMutationService, PreparedFileItem, FileExecutionHooks, FileReceipt, ExecutePreparedFile } from "./file-service.ts";
import { boundedReason } from "./file-tree-core.mjs";
import { directoryKey, summarizeCreatedDirectories } from "./file-creation-core.mjs";
import type { NativeTreePlan } from "./native-file-tree.ts";
import { FILE_MUTATION_TEXT_BYTES } from "./file-operation-limits.mjs";

export type RunSandboxFilePhase = <T>(signal: AbortSignal, run: () => Promise<T>) => Promise<T>;
const COPY_FIELDS = ["path", "content", "snapshot", "purpose", "edits"] as const;
function copySandboxInput(operation: FileOperation, raw: unknown): FileOperationInput {
  if (operation !== "write" && operation !== "edit") throw new Error("[TOOL_ARGS_INVALID] Tree items require their native scalar/array schema.");
  if (!Value.Check(operation === "write" ? SandboxWriteParameters : SandboxEditParameters, raw)) throw new Error("[TOOL_ARGS_INVALID] Invalid sandbox text parameters.");
  const source = raw as FileOperationInput, result: FileOperationInput = { path: source.path };
  if (!source.path.trim() || source.path.length > 4096 || source.path.includes("\0")) throw new Error("[TOOL_ARGS_INVALID] Invalid sandbox text path.");
  let bytes = 0;
  if (operation === "write") validateWriteContent(source.content!);
  else for (const edit of source.edits!) {
    if (!edit.oldText?.length) throw new Error("[TOOL_ARGS_INVALID] Exact replacements require nonempty oldText.");
    bytes += Buffer.byteLength(edit.oldText) + Buffer.byteLength(edit.newText!);
    if (bytes > FILE_MUTATION_TEXT_BYTES) throw new Error("[MUTATION_BUDGET_EXCEEDED] Sandbox edit input exceeds 1 MiB.");
  }
  for (const key of COPY_FIELDS) if (source[key] !== undefined) (result as unknown as Record<string, unknown>)[key] = source[key];
  if (source.edits) {
    const edits = []; for (const edit of source.edits) edits.push(Object.freeze({ ...edit })); result.edits = Object.freeze(edits) as any;
  }
  return Object.freeze(result);
}

/** SHA-256 worker snapshots are checked on every mutation. This facade holds no
 * native read versions and cannot issue/revive one through a metadata query. */
class SandboxFileGeneration {
  private boundary: SessionExecutionBoundary | undefined;
  constructor(boundary: SessionExecutionBoundary) { this.boundary = boundary; }
  get generation(): number { return this.boundary?.generation ?? -1; }
  invalidatePath(_path: string): void {}
  dispose(): void { this.boundary = undefined; }
}
interface RemoteRow { item: PreparedFileItem; input: FileWorkerInput; prepared: PreparedFileWorkerManifest; }

/** Per-invocation MXC service for the existing SessionFiles authorization,
 * journal and lifecycle owner. Workspace reads/writes never execute on the host;
 * host filesystem access is limited to exact private exchange artifacts. */
export class SandboxFileService implements FileMutationService {
  readonly inputKind = "sandbox" as const;
  readonly copyInput = copySandboxInput;
  readonly cwd: string;
  readonly sessionId: string;
  readonly revisions: SandboxFileGeneration;
  private backend: WorkspaceSandboxBackend | undefined;
  private runPhase: RunSandboxFilePhase | undefined;
  private runtime: ExtensionRuntime | undefined;
  private ctx: ExtensionContext | undefined;
  private signal: AbortSignal | undefined;
  private applySignal: AbortSignal | undefined;
  private canonicalPaths: readonly string[] | undefined;
  private readonly id: string;
  private readonly operation: string;
  private readonly generation: number;
  private context: WorkspaceFileRpcContext | undefined;
  private envelope: FileWorkerRequest | undefined;
  private input: FileWorkerInput[] = [];
  private plan: FileRpcPlan | undefined;
  private rows: Array<RemoteRow | undefined> = [];
  private indexes = new WeakMap<PreparedFileItem, number>();
  private readonly owned = new Map<string, Readonly<OwnedManifestFile>>();
  private selected: Set<PreparedFileItem> | undefined;
  private runCallback: ((execute: ExecutePreparedFile) => Promise<unknown>) | undefined;
  private hooks: FileExecutionHooks | undefined;
  private activeEffect: Promise<FileReceipt> | undefined;
  private validated = false;
  private preparingIndex = 0;
  private executingIndex = 0;
  private dryRun = false;
  private open = false;
  private closed = false;
  private closing: Promise<void> | undefined;

  constructor(backend: WorkspaceSandboxBackend, runPhase: RunSandboxFilePhase, event: ToolCallEvent, ctx: ExtensionContext, runtime: ExtensionRuntime,
    shutdown: AbortSignal, canonicalPaths: readonly string[]) {
    this.backend = backend; this.runPhase = runPhase; this.ctx = ctx; this.runtime = runtime;
    this.cwd = ctx.cwd; this.sessionId = ctx.sessionManager.getSessionId(); this.id = event.toolCallId; this.operation = event.toolName;
    this.canonicalPaths = canonicalPaths; this.generation = runtime.executionBoundary.generation; this.revisions = new SandboxFileGeneration(runtime.executionBoundary);
    this.signal = AbortSignal.any(ctx.signal ? [ctx.signal, runtime.executionBoundary.signal, shutdown] : [runtime.executionBoundary.signal, shutdown]);
  }
  private readonly current = (): void => {
    if (this.closed || !this.runtime || !this.ctx || !this.backend) throw new Error("[STALE_STATE] Sandbox file invocation is closed.");
    this.runtime.assertActive(); this.runtime.executionBoundary.assertCurrent(this.generation); this.signal?.throwIfAborted(); this.applySignal?.throwIfAborted();
    if (this.ctx.cwd !== this.cwd || this.ctx.sessionManager.getSessionId() !== this.sessionId) throw new Error("[STALE_STATE] Sandbox file session changed.");
  };
  async beginMutation(operation: FileOperation | "file_batch", id: string, requestHash: string, input: readonly FileOperationInput[], dryRun: boolean, signal?: AbortSignal): Promise<void> {
    this.current(); signal?.throwIfAborted();
    if (this.envelope || id !== this.id || operation !== this.operation) throw new Error("[FILE_RPC_ORDER] Sandbox preparation is single-use.");
    this.dryRun = dryRun;
    await this.runPhase!(this.signal!, async () => {
    this.context = await this.backend!.openFileRpc(this.signal!); this.current();
    const directories = this.context.workspaces.slice(1); // At most the existing 16 authorized additional roots; invocation setup only.
    let cursor = 0;
    for (const source of input) {
      const name = operation === "file_batch" ? (source as FileOperationInput & { operation: FileOperation }).operation : operation;
      const canonicalSource = this.canonicalPaths![cursor++], canonicalDestination = source.destination === undefined ? undefined : this.canonicalPaths![cursor++];
      // Validate all text bodies before the first transport chunk is prepared.
      if (name === "write" || name === "edit") {
        const clean: Record<string, unknown> = {};
        for (const key of COPY_FIELDS) if (source[key] !== undefined) clean[key] = source[key];
        copySandboxInput(name, clean);
      }
      this.input.push(Object.freeze(workspaceMutationItem(this.context.workspaces[0], name, source, directories, canonicalSource, canonicalDestination)) as FileWorkerInput);
    }
    if (cursor !== this.canonicalPaths!.length) throw new Error("[STALE_STATE] Sandbox approval path table is incomplete.");
    this.canonicalPaths = undefined;
    const envelope: FileRpcEnvelope = { ...this.context, id: randomUUID().replaceAll("-", ""), operation, callId: id, requestHash, generation: this.generation };
    this.envelope = { ...envelope, itemCount: input.length };
    this.plan = planFileRpc(this.envelope, this.input); this.rows = new Array(input.length);
    await this.prepareAll();
    });
  }
  private async allocate(slot: number): Promise<Readonly<OwnedManifestFile>> {
    this.current(); const name = `${this.envelope!.id}-${slot}.manifest`;
    const owned = await this.backend!.createFileManifest(this.context!, name); this.owned.set(name, owned); return owned;
  }
  private async rpc(phase: "prepare" | "validate" | "execute", chunk: FileRpcChunk, control: FileRpcControl): Promise<readonly unknown[]> {
    this.current(); this.hooks?.assertCurrent();
    const encoded = serializeFileRpc(this.envelope!, this.input, chunk, phase, control);
    const reply = await this.backend!.invokeFileRpc(this.context!, this.envelope!, encoded, this.applySignal ?? this.signal!);
    this.current(); this.hooks?.assertCurrent();
    return fileRpcReplyItems(reply, this.envelope!, this.input.length, chunk, phase, encoded);
  }
  private readonly prepareAll = async (): Promise<void> => {
    for (const chunk of this.plan!.chunks) {
      const controls = [];
      for (let index = chunk.start; index < chunk.end; index++) controls.push({ owned: await this.allocate(index) });
      const replies = await this.rpc("prepare", chunk, { prepared: controls });
      for (let offset = 0; offset < replies.length; offset++) {
        const index = chunk.start + offset, input = this.input[index], manifest = fileRpcPreparedManifest(replies[offset], controls[offset].owned);
        const prepared = await readFileWorkerManifest(this.envelope!, input, index, manifest); this.current();
        const header = prepared.header, paths = [header.target]; if (header.destination) paths.push(header.destination);
        const item: PreparedFileItem = { operation: input.operation, input: { path: input.path }, target: header.target, executionPath: header.target, paths,
          requestHash: input.inputHash, generation: this.generation, approval: { canonicalTarget: header.target, protectedRoots: [] }, identity: header.source,
          creation: prepared.creation, remote: { index, manifest, prepared },
          preview: { kind: input.operation === "copy" ? "Copied" : input.operation === "move" ? "Moved" : input.operation === "delete" ? "Deleted" : header.creation ? "Added" : "Modified",
            bytes: header.tree?.bytes ?? header.text?.bytes } };
        if (input.operation === "copy" || input.operation === "move" || input.operation === "delete") item.tree = Object.freeze({ operation: input.operation, cwd: this.cwd,
          input: item.input, source: header.source!, sourceParent: header.sourceParent!, tree: prepared.tree!, destination: header.destination,
          destinationParent: header.destinationParent, destinationIdentity: header.destinationIdentity,
          protectedPaths: Object.freeze([{ canonicalTarget: header.target, protectedRoots: [] }]) } satisfies NativeTreePlan);
        this.rows[index] = { item, input, prepared }; this.indexes.set(item, index);
      }
    }
  };
  async prepareV3(operation: FileOperation, raw: unknown, signal?: AbortSignal): Promise<PreparedFileItem> {
    this.current(); signal?.throwIfAborted();
    const row = this.rows[this.preparingIndex++];
    if (!row || row.item.operation !== operation || row.item.requestHash !== mutationRequestHash(operation, raw)) throw new Error("[STALE_STATE] Prepared sandbox item or request hash changed.");
    row.item.input = raw as FileOperationInput;
    if (row.item.tree) row.item.tree = Object.freeze({ ...row.item.tree, input: row.item.input });
    return row.item;
  }
  private readonly validateAll = async (): Promise<void> => {
    for (const chunk of this.plan!.chunks) {
      const prepared = []; for (let index = chunk.start; index < chunk.end; index++) prepared.push({ manifest: this.rows[index]!.item.remote!.manifest });
      const replies = await this.rpc("validate", chunk, { prepared, preview: this.dryRun });
      for (let offset = 0; offset < replies.length; offset++) {
        const row = this.rows[chunk.start + offset]!, content = fileRpcValidatedContent(replies[offset], row.prepared, this.dryRun);
        row.item.remote!.validated = content;
        if (row.item.tree && content.sourceSha256) row.item.tree = Object.freeze({ ...row.item.tree, sourceHash: content.sourceSha256 });
      }
    }
    this.validated = true;
  };
  async revalidate(item: PreparedFileItem, hooks: FileExecutionHooks): Promise<void> {
    this.current(); hooks.assertCurrent();
    if (!this.selected?.has(item)) throw new Error("[STALE_STATE] Sandbox item is outside its active invocation.");
    if (!this.validated) await this.validateAll();
  }
  private readonly finishEffect = (): void => { this.activeEffect = undefined; };
  private readonly executePrepared: ExecutePreparedFile = (item, id, hooks, itemId) => {
    this.current(); hooks.assertCurrent();
    const index = this.indexes.get(item);
    if (!this.open || this.activeEffect || !this.validated || id !== this.id || itemId !== `${id}:${index}`
      || index !== this.executingIndex || !this.selected?.delete(item)) throw new Error("[FILE_RPC_ORDER] Invalid, reused or overlapping sandbox effect.");
    this.executingIndex++;
    return this.activeEffect = this.runPrepared(item, index, hooks).finally(this.finishEffect);
  };
  private async runPrepared(item: PreparedFileItem, index: number, hooks: FileExecutionHooks): Promise<FileReceipt> {
    const row = this.rows[index]!, remote = item.remote!;
    try {
      const control: Record<string, unknown> = { manifest: remote.manifest, validated: remote.validated };
      if (item.creation?.directories.length) {
        control.effects = await this.allocate(this.input.length + index);
        if (hooks.sharedDirectories?.size) {
          const owned = await this.allocate(2 * this.input.length + index);
          control.shared = await writeFileParentManifest(this.envelope!, index, item.creation, owned, "shared", hooks.sharedDirectories);
        }
      }
      const replies = await this.rpc("execute", fileRpcItemChunk(this.envelope!, this.input, index), {
        prepared: [control], readyHash: hooks.resultReadyHash, intentId: hooks.resultIntentId });
      const receipt = fileRpcExecutedReceipt(replies[0], this.envelope!, row.input, row.prepared, remote.validated, hooks.resultReadyHash!, hooks.resultIntentId!);
      if (receipt.createdParents) {
        const owned = control.effects as OwnedManifestFile;
        if (receipt.createdParents.device !== owned.device || receipt.createdParents.inode !== owned.inode) throw new Error("[FILE_RPC_INVALID] Created-parent output object changed.");
        const parents = await readFileParentManifest(this.envelope!, index, item.creation!, "created", receipt.createdParents); this.current(); hooks.assertCurrent();
        const creation = receipt.creation as { bytes: number; addedLines?: number; createdDirectoryCount?: number; manifestSha256?: string };
        if (creation.createdDirectoryCount !== parents.created.length) throw new Error("[FILE_RPC_INVALID] Created-parent counts differ from the complete inventory.");
        receipt.creation = { ...summarizeCreatedDirectories(creation, parents.created), manifestSha256: receipt.createdParents.sha256 };
        if (receipt.status === "succeeded") for (const parent of parents.created) {
          if (parent.status !== "created" || !parent.identity) throw new Error("[FILE_RPC_INVALID] Successful creation lost its pinned parent identity.");
          hooks.sharedDirectories?.set(directoryKey(parent.path), parent.identity);
        }
      }
      // The shared journal owner records effects before exposing SHA continuation.
      hooks.record({ phase: "result", ...receipt }); return receipt;
    } catch (error) {
      const receipt: FileReceipt = { mutationReceiptVersion: 3, operation: item.operation, target: item.target, destination: item.paths[1], ok: false,
        status: "state_unknown", stateChanged: "unknown", requiresVerification: true, stopInvocation: true,
        reason: boundedReason(error instanceof Error ? error.message : String(error)) };
      try { hooks.record({ phase: "result", ...receipt }); } catch { /* Durable intent remains unknown; the outer writer stops. */ }
      return receipt;
    } finally { this.release(item); }
  }
  private readonly runScope = async (): Promise<unknown> => {
    try { return await this.runCallback!(this.executePrepared); }
    finally {
      this.open = false; try { await this.activeEffect; }
      finally { this.runCallback = undefined; this.hooks = undefined; this.selected?.clear(); this.selected = undefined; }
    }
  };
  async withPreparedItems<T>(items: readonly PreparedFileItem[], run: (execute: ExecutePreparedFile) => Promise<T>, hooks?: FileExecutionHooks): Promise<T> {
    this.current(); if (this.open || this.selected || !items.length || items.length !== this.input.length) throw new Error("[FILE_RPC_ORDER] Invalid sandbox lock scope.");
    this.selected = new Set(items); if (this.selected.size !== items.length) throw new Error("[FILE_RPC_ORDER] Duplicate sandbox item.");
    this.hooks = hooks; this.applySignal = hooks?.signal ? AbortSignal.any([this.signal!, hooks.signal]) : this.signal;
    this.open = true; this.runCallback = run;
    return await this.runPhase!(this.applySignal!, this.runScope) as T;
  }
  release(item: PreparedFileItem): void {
    const index = this.indexes.get(item); if (index !== undefined) this.rows[index] = undefined;
    item.tree = undefined; item.remote = undefined; item.creation = undefined;
  }
  closeInvocation(): Promise<void> { this.closed = true; return this.closing ??= this.releaseAll(); }
  private async releaseAll(): Promise<void> {
    let failure: unknown;
    try {
      for (const owned of this.owned.values()) {
        try { await this.backend!.releaseFileManifest(this.context!, owned); }
        catch (error) { failure ??= error; }
      }
    } finally {
      this.owned.clear(); this.rows = []; this.input = []; this.plan = undefined; this.indexes = new WeakMap(); this.revisions.dispose();
      this.selected?.clear(); this.selected = undefined; this.runCallback = undefined; this.hooks = undefined;
      this.ctx = undefined; this.runtime = undefined; this.signal = undefined; this.applySignal = undefined; this.canonicalPaths = undefined;
      this.envelope = undefined; this.context = undefined; this.backend = undefined; this.runPhase = undefined;
    }
    if (failure) throw failure;
  }
}
