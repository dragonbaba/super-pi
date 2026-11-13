import type { ReadonlySessionManager } from "../session-manager.ts";
import { copyBatchInput, type BatchInput } from "./file-batch-protocol.ts";
import { copyNativeInvocation } from "./file-operation-input.ts";
import { mutationRequestHash } from "./file-invocation.ts";
import { fileSourceArguments } from "./file-source-arguments.ts";
import { assertIndependent } from "./file-path-conflicts.ts";
import { PreviewBudget, displayMetadata } from "./change-preview.ts";
import { directoryKey, summarizeCreatedDirectories, type CreatedDirectory } from "./file-creation.ts";
import { boundedReason } from "./file-tree-core.mjs";
import type { FileMutationService, PreparedFileItem, FileOperation, FileOperationInput, FileExecutionHooks, ExecutePreparedFile, FileReceipt } from "./file-service.ts";
import { FileResultWriter, type AppendFileResultEntry, type FileResultSession } from "./file-result-store.ts";
import { FILE_MUTATION_CALL_ENTRY, type FileResultOperation, type FileResultPayload } from "./file-result-protocol.ts";
import { FILE_RESULT_FAILURE_SAMPLES, FILE_RESULT_PREVIEW_SAMPLES, FILE_RESULT_INLINE_BYTES, FILE_RESULT_INLINE_ITEMS } from "./file-operation-limits.mjs";
import type { PathIdentity } from "./native-file-core.ts";

export type PreparedMutationItem = PreparedFileItem & { itemId: string; preparedId?: string };
const INPUT_FIELDS = ["content", "destination", "snapshot", "edits", "recursive", "overwrite", "purpose"] as const;
const RECEIPT_FIELDS = ["operation", "target", "destination", "status", "stateChanged", "requiresVerification", "sha256", "previousSha256",
  "sourceIdentity", "created", "bytes", "files", "directories", "skippedLinks", "coverageComplete", "revision", "revisionContinuation", "snapshot",
  "changedBytes", "replacements", "deduplicatedEdits", "category", "stopInvocation"] as const;

/** Locate the exact persisted source on this branch. No synthetic call or guessed leaf. */
export function findFileMutationCall(session: FileResultSession, id: string, operation: FileResultOperation, hash: string): string {
  let current = session.getLeafId(), remaining = session.getEntryCount() + 1;
  while (current && remaining-- > 0) {
    const entry = session.getEntry(current);
    if (!entry) break;
    let call: any;
    if (entry.type === "message" && entry.message.role === "assistant" && Array.isArray(entry.message.content)) {
      for (const block of entry.message.content) if (block.type === "toolCall" && block.id === id) {
        // Experimental host dispatch publishes an empty association, while its
        // caller may already have persisted the actual request. Never treat the
        // association as a replacement request or skip a real mismatched call.
        if (entry.message.api === "host-operation" && entry.message.provider === "host" && entry.message.model === "local-operation"
          && block.arguments && typeof block.arguments === "object" && Object.keys(block.arguments).length === 0) continue;
        if (call) throw new Error("[FILE_RESULT_INVALID] Duplicate source call.");
        call = block;
      }
    } else if (entry.type === "custom" && entry.customType === FILE_MUTATION_CALL_ENTRY) {
      const data = entry.data as any;
      if (data?.version === 3 && data.origin === "host-operation" && data.call?.id === id) call = data.call;
    } else if (entry.type === "custom" && entry.customType === "codemode-tool-call-v1") {
      const data = entry.data as any;
      if (data?.version === 1 && data.call?.id === id && typeof data.parentToolCallId === "string"
        && id.startsWith(data.parentToolCallId + ":nested:")) call = data.call;
    }
    if (call) {
      if (call.name !== operation || mutationRequestHash(operation, fileSourceArguments(operation, call.arguments)) !== hash) throw new Error("[FILE_RESULT_INVALID] Source request changed.");
      return current;
    }
    current = entry.parentId;
  }
  throw new Error("[FILE_RESULT_INVALID] Persist the original file call before execution.");
}

/** One invocation owns immutable plans until transfer, failure or lifecycle release.
 * Public execution switches to this owner only with the matching policy/MXC routes. */
export class FileMutation {
  readonly items: PreparedMutationItem[] = [];
  readonly operation: FileResultOperation;
  readonly id: string;
  readonly requestHash: string;
  readonly dryRun: boolean;
  private service: FileMutationService | undefined;
  private input: BatchInput | readonly Readonly<FileOperationInput>[] | undefined;
  private state: "new" | "preparing" | "ready" | "executing" | "released" = "new";
  private revoked = false;
  constructor(service: FileMutationService, id: string, operation: FileResultOperation, raw: unknown) {
    this.service = service; this.id = id; this.operation = operation;
    this.requestHash = mutationRequestHash(operation, raw);
    if (operation === "file_batch") { const input = copyBatchInput(raw, service.inputKind === "sandbox" ? "sandbox" : true); this.input = input; this.dryRun = input.dryRun === true; }
    else if (operation === "copy" || operation === "delete" || operation === "move") {
      const input = copyNativeInvocation(operation, raw); this.input = input.items; this.dryRun = input.dryRun;
    } else { this.input = [service.copyInput ? service.copyInput(operation, raw) : raw as FileOperationInput]; this.dryRun = false; }
  }
  assertLive(): void { if (this.revoked || !this.service || this.state === "released") throw new Error("[STALE_STATE] File mutation was released."); }
  async prepare(signal?: AbortSignal): Promise<void> {
    if (this.state !== "new") throw new Error("File mutation preparation is single-use.");
    this.state = "preparing";
    const budget = new PreviewBudget(), batch = this.operation === "file_batch" ? this.input as BatchInput : undefined;
    const list = batch?.operations ?? this.input as readonly FileOperationInput[];
    let index = 0;
    try {
      await this.service!.beginMutation?.(this.operation, this.id, this.requestHash, list, this.dryRun, signal);
      for (; index < list.length; index++) {
        this.assertLive(); signal?.throwIfAborted();
        const source = list[index] as FileOperationInput, operation = batch ? batch.operations[index].operation : this.operation as FileOperation;
        // Setup projection is per tool target, never per directory leaf or result page.
        const input: FileOperationInput = { path: source.path };
        for (const key of INPUT_FIELDS) {
          if (source[key] !== undefined) (input as unknown as Record<string, unknown>)[key] = source[key];
        }
        const item = await this.service!.prepareV3(operation, input, signal, batch?.operations[index].mode, budget) as PreparedMutationItem;
        item.itemId = `${this.id}:${index}`; this.items.push(item);
      }
      this.assertLive(); signal?.throwIfAborted();
      // The shared trie sees directory child identities too, without duplicating the inventory.
      assertIndependent(this.items);
      this.state = "ready"; this.input = undefined;
    } catch (error) {
      this.dispose(); throw new Error(`${this.id}:${index}: ${error instanceof Error ? error.message : String(error)}\nPreflight failed; no item executed.`, { cause: error });
    }
  }
  release(): void { this.revoked = true; if (this.state !== "preparing" && this.state !== "executing") this.dispose(); }
  private dispose(): void {
    for (const item of this.items) this.service?.release(item);
    this.items.length = 0; this.input = undefined; this.service = undefined; this.state = "released"; this.revoked = true;
  }
  readonly describePreflight = (): string => {
    this.assertLive();
    let text = `Prepared ${this.items.length} independent top-level targets. Apply revalidates every target before any effect.`;
    for (let index = 0; index < this.items.length; index++) {
      const item = this.items[index], tree = item.tree;
      text += `\n${index + 1}. ${item.operation}: ${displayMetadata(item.target)}`;
      if (tree?.destination) text += ` → ${displayMetadata(tree.destination)}`;
      if (tree) text += `; ${tree.tree.files} files, ${tree.tree.directories} directories, ${tree.tree.bytes} bytes, ${tree.tree.skippedLinks} skipped links`
        + (item.input.recursive ? "; recursive" : "") + (item.input.overwrite ? `; overwrite existing regular file (${tree.destinationIdentity?.size ?? "0"} bytes)` : "; exclusive destination");
      if (item.creation) text += `; ${tree ? "destination" : "new file"}, ${item.creation.directories.length} missing parent directories`;
      const metadata = item.snapshot?.metadata ?? tree?.overwriteCommit?.metadata;
      if (metadata) text += `; ${metadata.strategy}${metadata.reason ? ": " + displayMetadata(boundedReason(metadata.reason)) : ""}`;
    }
    return text;
  };
  async execute(session: ReadonlySessionManager, append: AppendFileResultEntry, hooks: FileExecutionHooks) {
    this.assertLive(); if (this.state !== "ready") throw new Error("File mutation must be prepared and is single-use.");
    this.state = "executing";
    const execution = new FileMutationExecution(this, this.service!, session, append, hooks);
    try { return await execution.execute(); } finally { execution.dispose(); this.dispose(); }
  }
}

/** Whitelist metadata only. Never retain diff/body, arbitrary worker fields or
 * per-file directory receipts in session journal/result summaries. */
export function projectMutationReceipt(receipt: Record<string, unknown>): Omit<FileResultPayload, "phase"> {
  const result: Record<string, unknown> = {};
  for (const key of RECEIPT_FIELDS) if (receipt[key] !== undefined) result[key] = receipt[key];
  const commit = receipt.commit as FileReceipt["commit"];
  if (commit) result.commit = { strategy: commit.strategy, compatibilityReason: commit.compatibilityReason && boundedReason(commit.compatibilityReason),
    outcome: commit.outcome, fileSynced: commit.fileSynced, directorySynced: commit.directorySynced,
    retainedTemporary: commit.retainedTemporary, cleanupReason: commit.cleanupReason && boundedReason(commit.cleanupReason) };
  const creation = receipt.creation as { bytes?: number; addedLines?: number; createdDirectories?: CreatedDirectory[]; createdDirectoryCount?: number; manifestSha256?: string } | undefined;
  if (creation?.createdDirectories) {
    const bounded = summarizeCreatedDirectories(creation, creation.createdDirectories);
    result.creation = creation.manifestSha256 ? { ...bounded, manifestSha256: creation.manifestSha256 } : bounded;
    if (bounded.createdDirectoriesOmitted) result.coverageComplete = false;
  } else if (Array.isArray(receipt.createdDirectories)) {
    const bounded = summarizeCreatedDirectories(receipt, receipt.createdDirectories);
    result.createdDirectories = bounded.createdDirectories; result.createdDirectoryCount = bounded.createdDirectoryCount;
    result.createdDirectoriesOmitted = bounded.createdDirectoriesOmitted;
    if (bounded.createdDirectoriesOmitted) result.coverageComplete = false;
  }
  const reason = receipt.reason ?? receipt.cause;
  if (typeof reason === "string") result.reason = boundedReason(reason);
  return result;
}

class FileMutationExecution {
  private readonly mutation: FileMutation;
  private readonly service: FileMutationService;
  private readonly session: ReadonlySessionManager;
  private readonly append: AppendFileResultEntry;
  private readonly hooks: FileExecutionHooks;
  private readonly fileHooks: FileExecutionHooks;
  private readonly sharedDirectories = new Map<string, PathIdentity>();
  private writer: FileResultWriter | undefined;
  private current = -1;
  private started = 0;
  private succeeded = 0;
  private failed = 0;
  private partial = 0;
  private unknown = 0;
  private cancelled = 0;
  private bytes = 0;
  private files = 0;
  private directories = 0;
  private skippedLinks = 0;
  private readonly previewSamples: Record<string, unknown>[] = [];
  private previewSampleBytes = 0;
  private previewDirectories: Set<string> | undefined;
  private requiresVerification = false;
  private coverageComplete = true;
  private reason: string | undefined;
  private resultRef: string | undefined;
  private items: Record<string, unknown>[] | undefined;
  private inlineBytes = 0;
  private readonly failures: Record<string, unknown>[] = [];
  private failureCount = 0;
  private failureBytes = 0;
  private singlePreviewDiff: string | undefined;
  constructor(mutation: FileMutation, service: FileMutationService, session: ReadonlySessionManager, append: AppendFileResultEntry, hooks: FileExecutionHooks) {
    this.mutation = mutation; this.service = service; this.session = session; this.append = append; this.hooks = hooks;
    this.fileHooks = { assertCurrent: this.assertCurrent, record: this.recordEffect, signal: hooks.signal, batch: true,
      sharedDirectories: this.sharedDirectories, continuationOwner: hooks.continuationOwner, preflightOnly: mutation.dryRun,
      authorizationGeneration: hooks.authorizationGeneration };
    if (mutation.items.length <= FILE_RESULT_INLINE_ITEMS) this.items = [];
    if (mutation.dryRun) this.previewDirectories = new Set();
    if (mutation.operation !== "file_batch" && mutation.items.length === 1) this.singlePreviewDiff = mutation.items[0].preview?.diff;
  }
  readonly assertCurrent = (): void => { this.mutation.assertLive(); this.hooks.signal?.throwIfAborted(); this.hooks.assertCurrent(); };
  readonly recordEffect = (entry: Record<string, unknown>): void => {
    if (entry.phase === "result") this.writer!.commit(projectMutationReceipt(entry));
    else if (entry.phase === "commit_prepared") {
      const metadata = this.mutation.items[this.current].snapshot?.metadata;
      if (!metadata || entry.strategy !== metadata.strategy || entry.compatibilityReason !== metadata.reason) throw new Error("[STALE_STATE] Prepared commit selection changed.");
    }
  };
  private remember(row: Record<string, unknown>): void {
    if (this.items) {
      this.inlineBytes += Buffer.byteLength(JSON.stringify(row));
      if (this.inlineBytes <= FILE_RESULT_INLINE_BYTES) this.items.push(row);
      else this.items = undefined;
    }
    if (row.status !== "succeeded" && row.status !== "preview" && row.status !== "not_started") {
      this.failureCount++;
      if (this.failures.length < FILE_RESULT_FAILURE_SAMPLES) {
        const bytes = Buffer.byteLength(JSON.stringify(row));
        if (this.failureBytes + bytes <= FILE_RESULT_INLINE_BYTES) { this.failureBytes += bytes; this.failures.push(row); }
      }
    }
  }
  private preparation(item: PreparedMutationItem): Omit<FileResultPayload, "phase"> {
    const tree = item.tree;
    return { operation: item.operation, inputHash: item.requestHash, target: item.target, destination: tree?.destination,
      recursive: item.input.recursive, overwrite: item.input.overwrite,
      moveStrategy: item.remote?.prepared.header.moveStrategy ?? (item.operation === "move" && tree?.source.directory ? "copy_unlink_verified" : undefined),
      source: item.identity, sourceParent: tree?.sourceParent ?? item.snapshot?.parent ?? item.remote?.prepared.header.sourceParent ?? item.creation?.ancestor,
      destinationParent: tree?.destinationParent, destinationIdentity: tree?.destinationIdentity,
      previousSha256: tree?.overwriteCommit?.previousSha256 ?? item.snapshot?.receipt.sha256 ?? item.remote?.validated?.previousSha256 ?? item.remote?.prepared.header.text?.previousSha256,
      sourceSha256: tree?.sourceHash ?? item.remote?.validated?.sourceSha256,
      strategy: tree?.overwriteCommit?.metadata.strategy ?? item.snapshot?.metadata?.strategy
        ?? (item.remote?.prepared.header.destinationIdentity || item.remote?.prepared.header.text?.exists ? "staged_replace" : undefined),
      compatibilityReason: tree?.overwriteCommit?.metadata.reason ?? item.snapshot?.metadata?.reason,
      plannedDirectoryCount: item.creation?.directories.length, creationAncestor: item.creation?.ancestor,
      manifest: item.remote?.manifest,
      files: tree?.tree.files, directories: tree?.tree.directories, bytes: tree?.tree.bytes, skippedLinks: tree?.tree.skippedLinks };
  }
  readonly run = async (execute: ExecutePreparedFile): Promise<void> => {
    const { mutation } = this;
    for (const item of mutation.items) await this.service.revalidate(item, this.fileHooks);
    this.assertCurrent();
    if (mutation.dryRun) {
      for (let index = 0; index < mutation.items.length; index++) {
        const item = mutation.items[index];
        const files = item.tree?.tree.files ?? 1, skippedLinks = item.tree?.tree.skippedLinks ?? 0;
        let directories = item.tree?.tree.directories ?? 0;
        if (item.creation) for (const path of item.creation.directories) {
          const key = directoryKey(path);
          if (!this.previewDirectories!.has(key)) { this.previewDirectories!.add(key); directories++; }
        }
        const bytes = item.tree?.tree.bytes ?? item.remote?.prepared.header.text?.bytes ?? item.preview?.bytes ?? 0;
        this.files += files; this.directories += directories; this.skippedLinks += skippedLinks; this.bytes += bytes; this.coverageComplete &&= skippedLinks === 0;
        if (this.items || this.previewSamples.length < FILE_RESULT_PREVIEW_SAMPLES) {
          const row = { index, itemId: item.itemId, operation: item.operation, target: item.target, destination: item.tree?.destination,
            status: "preview", stateChanged: false, files, directories, bytes, skippedLinks };
          if (this.items) this.remember(row);
          if (this.previewSamples.length < FILE_RESULT_PREVIEW_SAMPLES) {
            const size = Buffer.byteLength(JSON.stringify(row));
            if (this.previewSampleBytes + size <= FILE_RESULT_INLINE_BYTES) { this.previewSampleBytes += size; this.previewSamples.push(row); }
          }
        }
      }
      return;
    }
    const source = findFileMutationCall(this.session, mutation.id, mutation.operation, mutation.requestHash);
    this.writer = new FileResultWriter({ callEntryId: source, toolCallId: mutation.id, operation: mutation.operation,
      requestHash: mutation.requestHash, itemCount: mutation.items.length }, this.append, this.session);
    for (let index = 0; index < mutation.items.length; index++) {
      this.assertCurrent(); const item = mutation.items[index]; item.preparedId = this.writer.prepare(index, this.preparation(item));
    }
    this.writer.ready(this.hooks.authorizationGeneration ?? 0);
    this.fileHooks.resultReadyHash = this.writer.manifestReadyHash;
    for (this.current = 0; this.current < mutation.items.length; this.current++) {
      this.assertCurrent();
      const item = mutation.items[this.current];
      this.fileHooks.resultIntentId = this.writer.intent(this.current, item.preparedId!); this.started++;
      const receipt = await execute(item, mutation.id, this.fileHooks, item.itemId);
      const metadata = projectMutationReceipt(receipt);
      if (this.writer.diagnostics.poisoned) {
        // No automatic replay or private version survives loss of the terminal journal.
        this.service.revisions.invalidatePath(item.target);
        const destination = item.paths[1]; if (destination) this.service.revisions.invalidatePath(destination);
        throw new Error("[FILE_RESULT_LOST] Outcome publication failed; verify the in-flight item before continuing.");
      }
      try { this.writer.result(this.current, metadata); }
      catch (error) {
        this.service.revisions.invalidatePath(item.target); if (item.paths[1]) this.service.revisions.invalidatePath(item.paths[1]); throw error;
      }
      switch (receipt.status) {
        case "succeeded": this.succeeded++; break;
        case "partial": this.partial++; break;
        case "state_unknown": this.unknown++; break;
        case "cancelled": this.cancelled++; break;
        default: this.failed++; break;
      }
      if (typeof receipt.bytes === "number") this.bytes += receipt.bytes;
      else if (typeof (receipt.creation as any)?.bytes === "number") this.bytes += (receipt.creation as any).bytes;
      if (typeof receipt.files === "number") this.files += receipt.files;
      else if ((item.operation === "write" || item.operation === "edit") && receipt.stateChanged === true) this.files++;
      if (typeof receipt.directories === "number") this.directories += receipt.directories;
      if (receipt.creation) {
        const creation = receipt.creation as { createdDirectoryCount?: number; createdDirectories?: unknown[] };
        this.directories += creation.createdDirectoryCount ?? creation.createdDirectories?.length ?? 0;
      }
      if (typeof receipt.skippedLinks === "number") this.skippedLinks += receipt.skippedLinks;
      this.requiresVerification ||= receipt.requiresVerification === true;
      this.coverageComplete &&= metadata.coverageComplete !== false && receipt.status !== "partial" && receipt.status !== "state_unknown";
      this.remember({ index: this.current, itemId: item.itemId, ...metadata });
      if (receipt.stopInvocation === true || receipt.status === "state_unknown" || receipt.status === "cancelled" || mutation.operation === "file_batch" && receipt.status !== "succeeded") break;
    }
    this.resultRef = this.writer.finish();
  };
  async execute() {
    try { await this.service.withPreparedItems(this.mutation.items, this.run, this.fileHooks); }
    catch (error) {
      this.reason = boundedReason(error instanceof Error ? error.message : String(error));
      if (this.writer) {
        if (this.writer.diagnostics.records) this.resultRef = this.writer.reference();
        // A failure after intent is conservatively unknown even if a lower layer
        // returned bytes; never report an unwritten terminal outcome as confirmed.
        const terminal = this.succeeded + this.failed + this.partial + this.unknown + this.cancelled;
        if (this.started > terminal) {
          this.unknown++; this.requiresVerification = true; this.coverageComplete = false;
          const item = this.mutation.items[this.started - 1];
          this.remember({ index: this.started - 1, itemId: item.itemId, operation: item.operation, target: item.target, destination: item.paths[1],
            status: "state_unknown", stateChanged: "unknown", requiresVerification: true, reason: this.reason });
        }
        else if (!this.writer.diagnostics.poisoned) {
          try { this.resultRef = this.writer.finish(this.reason); } catch { this.coverageComplete = false; }
        }
      }
      this.coverageComplete = false;
    }
    const mutation = this.mutation, notStarted = mutation.items.length - this.started;
    if (!mutation.dryRun && this.items) for (let index = this.started; index < mutation.items.length; index++) {
      const item = mutation.items[index];
      this.remember({ index, itemId: item.itemId, operation: item.operation, target: item.target, destination: item.paths[1], status: "not_started", stateChanged: false });
    }
    const failed = this.failed + this.partial + this.unknown + this.cancelled;
    const text = mutation.dryRun && !this.reason ? `Preflight passed for ${mutation.items.length} items. No changes; apply prepares and authorizes again.`
      : `${mutation.operation}: ${this.succeeded} succeeded, ${this.failed} failed, ${this.partial} partial, ${this.unknown} unknown, ${this.cancelled} cancelled, ${notStarted} not started.`;
    const summary = text + (this.reason ? `\n${displayMetadata(this.reason)}` : "") + (this.resultRef ? `\nResult records: ${this.resultRef}` : "");
    const single = mutation.operation !== "file_batch" && mutation.items.length === 1 && this.items?.length === 1 ? this.items[0] : undefined;
    const display = single && this.singlePreviewDiff ? summary + "\n" + this.singlePreviewDiff : summary;
    return { content: [{ type: "text" as const, text: display }], details: {
      ...single, mutationReceiptVersion: 3, operation: mutation.operation, preview: mutation.dryRun,
      itemCount: mutation.items.length, succeeded: this.succeeded, failed: this.failed, partial: this.partial, unknown: this.unknown, cancelled: this.cancelled,
      notStarted: mutation.dryRun ? 0 : notStarted, bytes: this.bytes, files: this.files, directories: this.directories, skippedLinks: this.skippedLinks, requiresVerification: this.requiresVerification,
      previewSamples: mutation.dryRun ? this.previewSamples : undefined,
      previewSamplesOmitted: mutation.dryRun ? mutation.items.length - this.previewSamples.length : undefined,
      coverageComplete: this.coverageComplete, complete: !this.reason, resultRef: this.resultRef,
      items: this.items, itemsOmitted: this.items === undefined, failureSamples: this.failures, failuresOmitted: this.failureCount - this.failures.length,
      collapsedSummary: summary, expandedSummary: display,
      ok: !this.reason && !failed && (mutation.dryRun || !notStarted), reason: this.reason,
    }, isError: !!this.reason || failed > 0 || !mutation.dryRun && notStarted > 0 };
  }
  dispose(): void { this.writer?.dispose(); this.writer = undefined; this.sharedDirectories.clear(); this.singlePreviewDiff = undefined;
    this.previewDirectories?.clear(); this.previewDirectories = undefined; }
}
