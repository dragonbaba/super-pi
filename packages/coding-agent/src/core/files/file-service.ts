import { Value } from "typebox/value";
import { dirname, resolve } from "node:path";
import { createHash } from "node:crypto";
import { lstat } from "node:fs/promises";
import { withFileMutationQueues } from "../tools/file-mutation-queue.ts";
import { prepareNativeTreeOperation, revalidateNativeTreePlan, finalizeNativeTreePlan, executeNativeTreePlan, type NativeTreePlan } from "./native-file-tree.ts";
import { validateNativeInvocation } from "./file-operation-input.ts";
import type { PreparedFileWorkerManifest, ValidatedFileWorkerContent } from "./file-worker-plan.mjs";
import type { ManifestArtifact } from "./file-manifest-artifact.mjs";
import {
  PublicEditParameters, NativeWriteParameters, validatePublicEditInput,
  type PublicEditInput,
} from "./file-parameters.ts";
import { resolveToolPath, sha256 } from "./file-path.ts";
import { mutationRequestHash } from "./file-invocation.ts";
import { assessProtectedMutationPath } from "./protected-path-policy.ts";
import {
  prepareFileCreation, executeFileCreation, canonicalCreationDirectories, directoryKey, verifyCreationAncestor,
  addedContentSummary, type FileCreationPlan, type CreationResult,
} from "./file-creation.ts";
import {
  prepareNativeOperation, executeNativePlan, validateNativeInput, revalidateNativePlan, capturePathIdentity, sameIdentity,
  type NativePlan, type PathIdentity, type MutationStatus,
} from "./native-file-core.ts";
import { FileCommitError, commitFailure, commitPreparedFile, type FileCommitReceipt, type FileCommitPlan } from "./file-commit.ts";
import { selectCommitMetadata } from "./file-commit-metadata.ts";
import { PreviewBudget, addedPreview, type ChangePreview } from "./change-preview.ts";
import {
  FileRevisions, prepareSnapshotLineMutation, executePreparedSnapshotMutation, readSnapshotSource,
  MAX_SNAPSHOT_FILE_BYTES, type PreparedSnapshotMutation, type SnapshotLineEdit,
} from "./snapshot-line-edit.ts";
import { prepareRevisionMutation, validateWriteContent, type ExactRevisionEdit } from "./revision-mutations.ts";

export const FILE_MUTATION_PROGRESS_ENTRY = "file-mutation-progress-v2";
export type FileOperation = "edit" | "write" | "copy" | "delete" | "move";
export interface FileOperationInput {
  path: string; purpose?: string; content?: string; destination?: string; snapshot?: string;
  edits?: PublicEditInput["edits"]; recursive?: boolean; overwrite?: boolean;
}
export interface PreparedFileItem {
  operation: FileOperation;
  input: FileOperationInput;
  target: string;
  paths: string[];
  executionPath: string;
  generation: number;
  requestHash: string;
  approval: { canonicalTarget: string; protectedRoots: readonly string[] };
  identity?: PathIdentity;
  creation?: FileCreationPlan;
  native?: NativePlan;
  tree?: NativeTreePlan;
  remote?: { index: number; manifest: Readonly<ManifestArtifact>; prepared: PreparedFileWorkerManifest; validated?: ValidatedFileWorkerContent };
  snapshot?: PreparedSnapshotMutation;
  preview?: ChangePreview;
  artifact?: { bytes: Uint8Array; sha256: string; commit?: FileCommitPlan };
}
export interface FileReceipt {
  mutationReceiptVersion: 2 | 3;
  operation: FileOperation;
  target: string;
  destination?: string;
  ok: boolean;
  status: MutationStatus;
  stateChanged: boolean | "unknown";
  requiresVerification?: boolean;
  commit?: FileCommitReceipt;
  [field: string]: unknown;
}
export interface FileExecutionHooks {
  assertCurrent(): void;
  record(entry: Record<string, unknown>): void;
  signal?: AbortSignal;
  sharedDirectories?: Map<string, PathIdentity>;
  /** Batch preparation owns origin; per-item commit selection has its own phase. */
  batch?: true;
  continuationOwner?: string;
  authorizationGeneration?: number;
  preflightOnly?: boolean;
  resultReadyHash?: string;
  resultIntentId?: string;
}

/** Copy only validated public fields; extension authorization observes the separate original input. */
function copyInput(operation: FileOperation, raw: unknown): FileOperationInput {
  if (operation === "edit") {
    if (!Value.Check(PublicEditParameters, raw)) throw new Error("[TOOL_ARGS_INVALID] Invalid edit fields.");
    validatePublicEditInput(raw);
  } else if (operation === "write") {
    if (!Value.Check(NativeWriteParameters, raw)) throw new Error("[TOOL_ARGS_INVALID] Invalid write fields.");
    validateWriteContent(raw.content);
  } else if (operation === "copy") validateNativeInvocation(operation, raw);
  else validateNativeInput(operation, raw);
  const input = raw as FileOperationInput;
  if (!input.path.trim() || input.path.length > 4096 || input.path.includes("\0")) throw new Error("[TOOL_ARGS_INVALID] Expected one literal file path of 1-4096 characters.");
  let edits: PublicEditInput["edits"] | undefined;
  if (input.edits) {
    edits = [];
    let bytes = 0;
    for (const edit of input.edits) {
      bytes += Buffer.byteLength(edit.oldText ?? "") + Buffer.byteLength(edit.newText ?? "");
      if (edit.newLines) for (const line of edit.newLines) bytes += Buffer.byteLength(line);
      if (bytes > 256 * 1024) throw new Error("[EDIT_SCOPE] Edit input exceeds 256 KiB.");
      edits.push(Object.freeze({ ...edit, ...(edit.newLines ? { newLines: Object.freeze([...edit.newLines]) as unknown as string[] } : {}) }));
    }
    Object.freeze(edits);
  }
  return Object.freeze({ path: input.path, purpose: input.purpose, content: input.content,
    destination: input.destination, snapshot: input.snapshot, edits,
    ...(input.recursive !== undefined ? { recursive: input.recursive } : {}), ...(input.overwrite !== undefined ? { overwrite: input.overwrite } : {}) });
}

/** Stable invocation callbacks. Retains only one plan until execution returns. */
class FileExecution {
  pending: Promise<FileReceipt> | undefined;
  private readonly service: FileService;
  private item!: PreparedFileItem;
  private hooks!: FileExecutionHooks;
  private toolCallId = "";
  private itemId = "";
  private postimage: Buffer | undefined;
  private publication: FileCommitReceipt | CreationResult | undefined;
  constructor(service: FileService) { this.service = service; }
  start(item: PreparedFileItem, id: string, itemId: string, hooks: FileExecutionHooks): Promise<FileReceipt> {
    if (this.pending || this.item) throw new Error("File invocation already has an active effect.");
    this.item = item; this.hooks = hooks; this.toolCallId = id; this.itemId = itemId;
    return this.pending = this.runScoped();
  }
  readonly assertCurrent = (): void => {
    this.service.assertPrepared(this.item); this.hooks.signal?.throwIfAborted(); this.hooks.assertCurrent();
  };
  readonly assertPath = async (): Promise<string> => {
    this.assertCurrent();
    const current = await assessProtectedMutationPath(this.service.cwd, this.item.executionPath, this.item.tree?.protectedPaths[0].followLeaf);
    this.assertCurrent();
    if (!current.canonicalTarget || directoryKey(current.canonicalTarget) !== directoryKey(this.item.target)) throw new Error("[STALE_STATE] Prepared path no longer identifies the approved target.");
    return current.canonicalTarget;
  };
  readonly selected = (metadata: { strategy: string; reason?: string }): void => {
    this.record(this.hooks.batch ? "commit_prepared" : "intent", { strategy: metadata.strategy, compatibilityReason: metadata.reason });
  };
  readonly committedBytes = (bytes: Buffer, commit: FileCommitReceipt): void => { this.postimage = bytes; this.publication = commit; };
  async runScoped(): Promise<FileReceipt> {
    try { return await this.run(); }
    finally {
      this.service.release(this.item); this.item = undefined!; this.hooks = undefined!;
      this.toolCallId = ""; this.itemId = ""; this.pending = undefined;
    }
  }
  record(phase: string, extra?: Record<string, unknown>): void {
    // The v3 invocation already published these phases for the entire call.
    if (this.hooks.batch && (phase === "intent" || phase === "origin")) return;
    const item = this.item;
    this.hooks.record({ toolCallId: this.toolCallId, itemId: this.itemId, phase, operation: item.operation,
      target: item.target, destination: item.tree?.destination ?? item.native?.destination, requestHash: item.requestHash,
      directories: this.hooks.batch ? undefined : item.creation ? canonicalCreationDirectories(item.creation) : item.operation === "write" ? [] : undefined, ...extra });
  }
  async run(): Promise<FileReceipt> {
    const { item, hooks } = this;
    let receipt: FileReceipt;
    try {
      this.assertCurrent();
      await this.assertPath();
      if (!hooks.batch && !item.native) this.record("origin");
      if (hooks.batch || !item.snapshot) this.record("intent");
      if (hooks.batch) await this.service.revalidate(item, hooks);
      if (item.tree) receipt = await executeNativeTreePlan(item.tree, this.assertCurrent, hooks.signal);
      else if (item.artifact) {
        if (createHash("sha256").update(item.artifact.bytes).digest("hex") !== item.artifact.sha256) throw new Error("[STALE_STATE] Artifact changed after preparation");
        const commit = item.artifact.commit ? await commitPreparedFile(item.artifact.commit, item.artifact.bytes,
          { assertPathAllowed: this.assertPath, assertCurrent: this.assertCurrent, signal: hooks.signal }) : undefined;
        const creation = item.creation ? await executeFileCreation(item.creation, item.artifact.bytes, this.assertPath,
          hooks.signal, undefined, hooks.sharedDirectories, this.assertCurrent) : undefined;
        receipt = { mutationReceiptVersion: 2, operation: "write", target: item.target, ok: true, status: "succeeded", category: "success",
          stateChanged: true, commit, creation, sha256: item.artifact.sha256, bytes: item.artifact.bytes.byteLength };
      } else if (item.native) receipt = { ...await executeNativePlan(item.native, this.assertCurrent, hooks.signal) };
      else if (item.creation) {
        const content = item.input.content!;
        const bytes = Buffer.byteLength(content) <= MAX_SNAPSHOT_FILE_BYTES ? Buffer.from(content) : undefined;
        const creation = await executeFileCreation(item.creation, bytes ?? content, this.assertPath,
          hooks.signal, undefined, hooks.sharedDirectories, this.assertCurrent);
        if (bytes) { creation.addedLines = addedContentSummary(content).addedLines; this.postimage = bytes; this.publication = creation; }
        receipt = { mutationReceiptVersion: 2, operation: "write", target: item.target, ok: true, status: "succeeded",
          category: "success", stateChanged: true, created: true, creation, sha256: sha256(item.input.content!) };
      } else {
        const committed = await executePreparedSnapshotMutation(item.snapshot!, hooks.signal,
          { assertPathAllowed: this.assertPath, assertCurrent: this.assertCurrent, commitSelected: this.selected, committedBytes: this.committedBytes });
        receipt = { ...committed, mutationReceiptVersion: 2, operation: item.operation, target: item.target,
          ok: true, category: "success", status: "succeeded", stateChanged: true,
          diff: item.preview?.diff ?? committed.diff, patch: item.preview?.diff ?? committed.patch };
      }
    } catch (error) {
      if (error instanceof FileCommitError) receipt = { ...commitFailure(error), mutationReceiptVersion: 2,
        operation: item.operation, target: item.target } as FileReceipt;
      else {
        let creationFailure: Record<string, unknown> | undefined;
        if (item.creation && error instanceof Error) {
          try { creationFailure = JSON.parse(error.message); } catch { /* Unstructured errors preceded creation. */ }
        }
        const changed = creationFailure?.stateChanged === "unknown" ? "unknown" : creationFailure?.stateChanged === true;
        receipt = { ...creationFailure, mutationReceiptVersion: 2, operation: item.operation, target: item.target,
          ok: false, status: changed === "unknown" ? "state_unknown" : changed ? "partial" : hooks.signal?.aborted ? "cancelled" : "failed_no_change",
          stateChanged: changed, requiresVerification: changed !== false,
          cause: creationFailure?.cause ?? (error instanceof Error ? error.message : String(error)) };
      }
    }
    if (receipt.stateChanged !== false || receipt.commit?.retainedTemporary) {
      if (item.operation !== "copy" || !receipt.ok) this.service.revisions.invalidatePath(item.target);
      const destination = item.tree?.destination ?? item.native?.destination;
      if (destination) this.service.revisions.invalidatePath(destination);
    }
    // Persist bounded recovery facts once; preview/diff bodies belong to the tool result.
    try { this.record("result", { mutationReceiptVersion: 2, status: receipt.status, stateChanged: receipt.stateChanged,
      requiresVerification: receipt.requiresVerification, commit: receipt.commit, sha256: receipt.sha256,
      sourceIdentity: receipt.sourceIdentity, createdDirectories: receipt.createdDirectories
        ?? (receipt.creation as { createdDirectories?: unknown } | undefined)?.createdDirectories,
      reason: typeof receipt.cause === "string" ? receipt.cause.slice(0, 800) : undefined }); }
    catch (error) {
      if (receipt.stateChanged !== false) receipt = { ...receipt, ok: false,
        status: receipt.stateChanged === true ? "partial" : "state_unknown", requiresVerification: true,
        cause: `Operation may have completed but recording failed: ${error instanceof Error ? error.message : String(error)}` };
    }
    try {
      if (receipt.ok && receipt.status === "succeeded" && receipt.stateChanged === true && !receipt.requiresVerification
        && !receipt.commit?.retainedTemporary && (!receipt.commit || receipt.commit.outcome === "committed")
        && (item.operation === "edit" || item.operation === "write")) {
        const revision = this.postimage && this.publication ? await this.service.revisions.continueCommitted(item.target,
          this.postimage, this.publication, item.generation, hooks.continuationOwner ?? this.toolCallId, this.toolCallId, this.assertCurrent, hooks.signal) : undefined;
        receipt.revision = revision; receipt.revisionContinuation = revision ? "available" : "unavailable";
      }
    } finally { this.postimage = undefined; this.publication = undefined; }
    return receipt;
  }
}

/** Session-owned file correctness. Access policy is supplied by the caller's execution boundary. */
export class FileService {
  readonly inputKind = "native" as const;
  readonly copyInput = copyInput;
  readonly revisions: FileRevisions;
  readonly cwd: string;
  readonly sessionId: string;
  private closed = false;
  private readonly prepared = new WeakSet<PreparedFileItem>();
  private readonly executing = new WeakSet<PreparedFileItem>();
  constructor(cwd: string, sessionId: string) {
    this.cwd = cwd; this.sessionId = sessionId; this.revisions = new FileRevisions(sessionId);
  }
  clear(): void { this.revisions.clear(); }
  dispose(): void { this.closed = true; this.revisions.dispose(); }
  assertPrepared(item: PreparedFileItem): void {
    if (this.closed || !this.prepared.has(item) || item.generation !== this.revisions.generation) throw new Error("[STALE_STATE] File invocation was released or its session changed.");
  }
  release(item: PreparedFileItem): void {
    this.prepared.delete(item);
    this.executing.delete(item);
    if (item.snapshot) item.snapshot.byteEdits.length = 0;
    item.artifact = undefined;
    item.tree = undefined;
  }
  /** v3 top-level tree plans and text commit choices are pinned before authorization. */
  async prepareV3(operation: FileOperation, raw: unknown, signal?: AbortSignal, mode?: "create" | "overwrite", previewBudget = new PreviewBudget()): Promise<PreparedFileItem> {
    if (operation === "write" || operation === "edit") {
      const item = await this.prepare(operation, raw, signal, mode, previewBudget);
      try { if (item.snapshot) item.snapshot.metadata = await selectCommitMetadata(item.snapshot.target); return item; }
      catch (error) { this.release(item); throw error; }
    }
    if (this.closed) throw new Error("File service is closed.");
    const tree = await prepareNativeTreeOperation(this.cwd, operation, raw, undefined, signal, false);
    const paths = [tree.source.canonical];
    if (tree.destination) paths.push(tree.destination);
    const item: PreparedFileItem = { operation, input: tree.input, target: tree.source.canonical, paths,
      executionPath: tree.source.path, generation: this.revisions.generation, requestHash: mutationRequestHash(operation, raw),
      approval: tree.protectedPaths[0], identity: tree.source, tree,
      preview: { kind: operation === "delete" ? "Deleted" : operation === "move" ? "Moved" : "Copied", bytes: tree.tree.bytes,
        risk: `${tree.tree.files} files, ${tree.tree.directories} directories, ${tree.tree.skippedLinks} links skipped; source trees and destinations are revalidated before effects.` } };
    signal?.throwIfAborted(); this.prepared.add(item); this.assertPrepared(item); return item;
  }
  /** Internal byte publication. The caller transfers one private bounded buffer; text tool schemas remain unchanged. */
  async prepareArtifact(target: string, bytes: Uint8Array, expectedSha256: string, before: string | null, signal?: AbortSignal): Promise<PreparedFileItem> {
    if (this.closed || bytes.byteLength > 64 * 1024 * 1024 || createHash("sha256").update(bytes).digest("hex") !== expectedSha256) throw new Error("[ARTIFACT_INVALID] Invalid publication bytes");
    signal?.throwIfAborted();
    const executionPath = resolve(this.cwd, target), assessment = await assessProtectedMutationPath(this.cwd, executionPath);
    if (!assessment.canonicalTarget || assessment.violations.length) throw new Error("[ARTIFACT_INVALID] Protected publication path");
    const item: PreparedFileItem = { operation: "write", input: { path: target }, target: assessment.canonicalTarget, paths: [assessment.canonicalTarget],
      executionPath, generation: this.revisions.generation, requestHash: expectedSha256,
      approval: { canonicalTarget: assessment.canonicalTarget, protectedRoots: [] }, artifact: { bytes, sha256: expectedSha256 } };
    try {
      if (before === null) item.creation = await prepareFileCreation(executionPath, true);
      else {
        item.identity = await capturePathIdentity(executionPath);
        item.artifact!.commit = { target: item.identity, parent: await capturePathIdentity(dirname(executionPath)), previousSha256: before,
          metadata: await selectCommitMetadata(item.identity) };
      }
      if (directoryKey(item.creation?.canonicalTarget ?? item.identity!.canonical) !== directoryKey(item.target)) throw new Error("[STALE_STATE] Artifact target changed");
      signal?.throwIfAborted(); this.prepared.add(item); this.assertPrepared(item); return item;
    } catch (error) { this.release(item); throw error; }
  }
  async prepare(operation: FileOperation, raw: unknown, signal?: AbortSignal, mode?: "create" | "overwrite", previewBudget = new PreviewBudget()): Promise<PreparedFileItem> {
    if (this.closed) throw new Error("File service is closed.");
    signal?.throwIfAborted();
    const generation = this.revisions.generation, input = copyInput(operation, raw);
    if (operation === "write" && mode === "create" && input.snapshot !== undefined) throw new Error("[TOOL_ARGS_INVALID] Create cannot carry a read snapshot.");
    const path = operation === "delete" || operation === "move" ? resolve(this.cwd, input.path) : resolveToolPath(this.cwd, input.path);
    const assessment = await assessProtectedMutationPath(this.cwd, path);
    if (!assessment.canonicalTarget) throw new Error("[STALE_STATE] File target cannot be resolved.");
    const item: PreparedFileItem = { operation, input, target: assessment.canonicalTarget, executionPath: path,
      paths: [assessment.canonicalTarget], generation, requestHash: mutationRequestHash(operation, input),
      approval: { canonicalTarget: assessment.canonicalTarget, protectedRoots: assessment.violations } };
    try {
      if (operation === "copy") throw new Error("Copy requires v3 preparation.");
      if (operation === "delete" || operation === "move") {
        item.native = await prepareNativeOperation(this.cwd, operation, operation === "move"
          ? { path: input.path, destination: input.destination } : { path: input.path });
        item.identity = item.native.source;
        if (item.native.destination) item.paths.push(item.native.destination);
        item.preview = { kind: operation === "delete" ? "Deleted" : "Moved", bytes: item.native.source.directory ? undefined : Number(item.native.source.size),
          risk: operation === "delete" ? "Irreversible deletion; no backup or recursive traversal." : "Exclusive link then unlink; partial failure can leave both names. No replacement or automatic replay." };
      } else {
        item.creation = operation === "write" ? await prepareFileCreation(path, mode === "create") : undefined;
        if (item.creation && input.snapshot !== undefined) throw new Error("[SNAPSHOT_EDIT_STALE] Snapshot write requires its original existing target. No change.");
        if (mode === "overwrite" && item.creation) throw new Error("[TARGET_MISSING] Overwrite requires an existing target; use create.");
        if (item.creation) {
          item.preview = addedPreview(input.content!, previewBudget);
          item.preview.plannedDirectories = item.creation.directories;
        } else {
          const id = input.snapshot ?? this.revisions.latest(item.target);
          if (!id) throw new Error("[REVISION_REQUIRED] Read this file to obtain its current revision before editing or replacing it.");
          item.snapshot = operation === "edit" && input.snapshot
            ? await prepareSnapshotLineMutation(this.sessionId, this.cwd, path, id, input.edits as SnapshotLineEdit[], signal,
              { revisions: this.revisions, assertPathAllowed: async () => item.target, previewOnly: true, previewBudget })
            : await prepareRevisionMutation(this.revisions, this.sessionId, this.cwd, path, id,
              operation === "write" ? { content: input.content! } : { edits: input.edits as ExactRevisionEdit[] }, signal, previewBudget);
          item.identity = item.snapshot.target; item.preview = item.snapshot.preview;
        }
      }
      const actual = item.creation?.canonicalTarget ?? item.identity?.canonical;
      if (actual === undefined || directoryKey(actual) !== directoryKey(item.target)) throw new Error("[STALE_STATE] File target changed during preparation.");
      signal?.throwIfAborted();
      this.prepared.add(item); this.assertPrepared(item);
      return item;
    } catch (error) { this.release(item); throw error; }
  }
  async execute(item: PreparedFileItem, toolCallId: string, hooks: FileExecutionHooks, itemId = `${toolCallId}:0`): Promise<FileReceipt> {
    return this.withPreparedItems([item], execute => execute(item, toolCallId, hooks, itemId));
  }
  /** One lock scope for all prepared paths; no target count admission limit. */
  async withPreparedItems<T>(items: readonly PreparedFileItem[], run: (execute: ExecutePreparedFile) => Promise<T>): Promise<T> {
    if (!items.length) throw new Error("Expected nonempty prepared file items.");
    const selected = new Set(items);
    if (selected.size !== items.length) throw new Error("Duplicate prepared file item.");
    for (const item of selected) if (this.executing.has(item)) throw new Error("File invocation is already executing.");
    for (const item of selected) this.executing.add(item);
    const paths = new Set<string>();
    for (const item of selected) for (const path of item.paths) paths.add(directoryKey(path));
    const ordered = [...paths].sort();
    let open = true;
    // One fixed active slot per invocation; callbacks are created once for the
    // whole call, not once per target. Every effect still owns its OS promises.
    const execution = new FileExecution(this);
    const execute: ExecutePreparedFile = (item, id, hooks, itemId) => {
      if (!open || execution.pending || !selected.delete(item)) throw new Error("Prepared file is outside the active lock scope, already consumed or overlaps an active effect.");
      return execution.start(item, id, itemId ?? `${id}:0`, hooks);
    };
    async function runLocked(): Promise<T> {
      try { return await run(execute); }
      finally {
        open = false;
        // A callback cannot release locks while an already-started OS operation still owns them.
        await execution.pending;
      }
    }
    try { return await withFileMutationQueues(ordered, runLocked); }
    finally { open = false; for (const item of selected) this.release(item); selected.clear(); }
  }
  /** Read-only all-item check. Each effect still repeats its own final identity/content checks. */
  async revalidate(item: PreparedFileItem, hooks: FileExecutionHooks): Promise<void> {
    this.assertPrepared(item); hooks.signal?.throwIfAborted(); hooks.assertCurrent();
    const assessment = await assessProtectedMutationPath(this.cwd, item.executionPath, item.tree?.protectedPaths[0].followLeaf);
    if (!assessment.canonicalTarget || directoryKey(assessment.canonicalTarget) !== directoryKey(item.target)) throw new Error("[STALE_STATE] Prepared target changed.");
    if (item.tree) {
      if (item.tree.deferredCopyHash && !hooks.preflightOnly) item.tree = await finalizeNativeTreePlan(item.tree, hooks.assertCurrent, hooks.signal);
      else await revalidateNativeTreePlan(item.tree, hooks.assertCurrent, hooks.signal);
    }
    else if (item.native) await revalidateNativePlan(item.native);
    else if (item.creation) {
      await verifyCreationAncestor(item.creation);
      const absent = [item.creation.path, ...item.creation.directories];
      for (const path of absent) {
        if (path !== item.creation.path && hooks.sharedDirectories?.has(directoryKey(path))) continue;
        try { await lstat(path); throw new Error("[TARGET_APPEARED] Planned file or parent appeared after preparation."); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      }
    } else {
      const plan = item.artifact?.commit ?? item.snapshot!;
      if (!sameIdentity(plan.target, await capturePathIdentity(plan.target.path))
        || !sameIdentity(plan.parent, await capturePathIdentity(plan.parent.path), false)) throw new Error("[STALE_STATE] Prepared file or parent changed.");
      if (item.snapshot) await readSnapshotSource(item.snapshot.receipt, this.revisions);
    }
    this.assertPrepared(item); hooks.signal?.throwIfAborted(); hooks.assertCurrent();
  }
}

export type ExecutePreparedFile = (item: PreparedFileItem, toolCallId: string, hooks: FileExecutionHooks, itemId?: string) => Promise<FileReceipt>;

/** Both execution environments keep one preparation/journal owner. Only the
 * environment's service can execute its plans or issue its own continuation. */
export interface FileMutationService {
  readonly inputKind?: "native" | "sandbox";
  copyInput?(operation: FileOperation, raw: unknown): FileOperationInput;
  readonly cwd: string;
  readonly sessionId: string;
  readonly revisions: Pick<FileRevisions, "generation" | "invalidatePath">;
  beginMutation?(operation: FileOperation | "file_batch", id: string, requestHash: string, input: readonly FileOperationInput[], dryRun: boolean, signal?: AbortSignal): Promise<void>;
  prepareV3: FileService["prepareV3"];
  revalidate: FileService["revalidate"];
  withPreparedItems<T>(items: readonly PreparedFileItem[], run: (execute: ExecutePreparedFile) => Promise<T>, hooks?: FileExecutionHooks): Promise<T>;
  release: FileService["release"];
  closeInvocation?(): Promise<void>;
}
