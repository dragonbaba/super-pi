import { WINDOWS_BATCH_COMPONENT_PATTERN, WINDOWS_PATH_SEPARATOR_PATTERN } from "./regex.ts";
import { lstat, readFile } from "node:fs/promises";
import { resolve, parse } from "node:path";
import { TextDecoder } from "node:util";
import type { ExtensionAPI, ExtensionContext } from "@super-pi/coding-agent";
import { prepareExactEditContent, generateDiffString, generateUnifiedPatch } from "@super-pi/coding-agent";
import { formatBatchResult, renderBatchResult, type ItemResult } from "@super-pi/coding-agent/internal/files/file-results";
export { renderBatchResult } from "@super-pi/coding-agent/internal/files/file-results";
import { consumePermissionPathApproval, mutationRequestHash, type PermissionPathApproval } from "../resource-lifecycle-guard/permission-contract.ts";
import { MutationWriteGuard, resolveToolPath, sha256, type GuardedEdit, type MutationEditAuthorization, type MutationPathApproval } from "./core.ts";
import { prepareFileCreation, verifyCreationAncestor, directoryKey, canonicalCreationDirectories, type FileCreationPlan } from "./file-creation.ts";
import { selectCommitMetadata } from "./file-commit-metadata.ts";
import { capturePathIdentity, sameIdentity, prepareNativeOperation, revalidateNativePlan, executeNativePlan, type NativePlan, type PathIdentity, type MutationStatus } from "./native-file-core.ts";
import { prepareSnapshotLineMutation, executePreparedSnapshotMutation, type PreparedSnapshotMutation, type SnapshotLineEdit } from "./snapshot-line-edit.ts";
import { assessProtectedMutationPath } from "./protected-path-policy.ts";
import { withMutationPaths, MUTATION_PROGRESS_ENTRY } from "./native-tools.ts";
import { PreviewBudget, addedPreview, modifiedPreview, readPreviewSource, MAX_PREVIEW_SOURCE_BYTES, type ChangePreview } from "./change-preview.ts";
import { FileCommitError, commitFailure, type CommitMetadata } from "./file-commit.ts";

// Default extensions load in separate module-cache scopes; share only the private key, not authority state.
import { FileBatchParameters, copyBatchInput as copyInput, assertIndependent, type BatchInput } from "@super-pi/coding-agent/internal/files/file-batch-protocol";
export { FileBatchParameters, MAX_BATCH_ITEMS } from "@super-pi/coding-agent/internal/files/file-batch-protocol";
type Operation = BatchInput["operations"][number]["operation"];
const PREPARATION = Symbol.for("pi.mutation-guard.file-batch.preparation.v1");
const EXECUTION = Symbol("file-batch-execution");
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
interface Item {
  itemId: string;
  operation: Operation;
  input: BatchInput["operations"][number];
  target: string;
  // Absolute lexical path: interpret edit/write syntax once; retain aliases for identity checks.
  executionPath: string;
  paths: string[];
  identity?: PathIdentity;
  parent?: PathIdentity;
  native?: NativePlan;
  creation?: FileCreationPlan;
  snapshot?: PreparedSnapshotMutation;
  exact?: MutationEditAuthorization;
  previousSha256?: string;
  approval: MutationPathApproval;
  reservation?: number;
  preview?: ChangePreview;
}

export function getBatchPreparation(input: unknown): BatchInvocation | undefined {
  return input && typeof input === "object" ? (input as any)[PREPARATION] : undefined;
}

/** One call owns preparation/reservations. Runner releases it on rejection, error and invalidation. */
export class BatchInvocation {
  readonly finalAuthority = true as const;
  readonly items: Item[] = [];
  readonly paths: string[] = [];
  readonly input: BatchInput;
  readonly requestHash: string;
  readonly cwd: string;
  private readonly sessionId: string;
  private original: unknown;
  private transferred = false;
  private live = true;
  private permission?: PermissionPathApproval;
  private currentItem?: Item;
  private progressPi?: ExtensionAPI;
  private readonly recordCommitSelection = (metadata: Pick<CommitMetadata, "strategy" | "reason">): void => {
    const item = this.currentItem, pi = this.progressPi;
    if (!this.live || !item || !pi) throw new Error("Batch commit selection owner is no longer active.");
    pi.appendEntry(MUTATION_PROGRESS_ENTRY, { toolCallId: this.id, itemId: item.itemId,
      phase: "commit_prepared", operation: item.operation, target: item.target, strategy: metadata.strategy, compatibilityReason: metadata.reason });
  };
  readonly assertAuthority = (): void => { if (!this.live || !this.permission?.assertCurrent || this.ctx.cwd !== this.cwd || this.ctx.sessionManager.getSessionId() !== this.sessionId) throw new Error("[POLICY_BLOCKED] Batch authority is unavailable."); this.permission.assertCurrent(); };
  readonly assertItemPath = async (): Promise<string> => {
    this.assertAuthority();
    const item = this.currentItem!;
    return this.guard.assertEditPathAllowed(this.cwd, item.executionPath, item.approval);
  };

  private readonly guard: MutationWriteGuard;
  private readonly ctx: ExtensionContext;
  readonly id: string;
  readonly generation: number;
  constructor(guard: MutationWriteGuard, ctx: ExtensionContext, id: string, input: unknown, generation: number) {
    this.guard = guard; this.ctx = ctx; this.id = id; this.generation = generation;
    this.original = input;
    this.cwd = ctx.cwd;
    this.sessionId = ctx.sessionManager.getSessionId();
    this.input = copyInput(input);
    this.requestHash = mutationRequestHash("file_batch", this.input);
  }

  async prepare(signal?: AbortSignal): Promise<void> {
    let preparingIndex = 0;
    const previewBudget = new PreviewBudget();
    try {
      for (let index = 0; index < this.input.operations.length; index++) {
        preparingIndex = index;
        signal?.throwIfAborted();
        const input = this.input.operations[index];
        const path = input.operation === "edit" || input.operation === "write"
          ? resolveToolPath(this.cwd, input.path) : resolve(this.cwd, input.path);
        if (process.platform === "win32") {
          const targets = input.destination ? [path, resolve(this.cwd, input.destination)] : [path];
          for (const target of targets) for (const component of target.slice(parse(target).root.length).split(WINDOWS_PATH_SEPARATOR_PATTERN)) {
            if (WINDOWS_BATCH_COMPONENT_PATTERN.test(component)) throw new Error("[BATCH_CONFLICT] Ambiguous Windows path component (device, stream, trailing dot or space) is unsupported.");
          }
        }
        const creation = input.operation === "write" ? await prepareFileCreation(path, input.mode === "create") : undefined;
        const initialIdentity = creation ? undefined : await capturePathIdentity(path);
        const initialParent = creation ? undefined : await capturePathIdentity(resolve(path, ".."));
        const assessment = await assessProtectedMutationPath(this.cwd, path);
        if (!assessment.canonicalTarget) throw new Error("[POLICY_BLOCKED] Unverifiable batch target.");
        if (directoryKey(creation?.canonicalTarget ?? initialIdentity!.canonical) !== directoryKey(assessment.canonicalTarget)) throw new Error("[STALE_STATE] Target changed during assessment.");
        const item: Item = { itemId: `${this.id}:${index}`, operation: input.operation, input, executionPath: path, target: assessment.canonicalTarget,
          paths: [assessment.canonicalTarget], approval: { canonicalTarget: assessment.canonicalTarget, protectedRoots: assessment.violations } };
        this.items.push(item);
        if (input.operation === "delete" || input.operation === "move") {
          item.native = await prepareNativeOperation(this.cwd, input.operation, input.operation === "move" ? { path: input.path, destination: input.destination } : { path: input.path });
          if (directoryKey(item.native.source.canonical) !== directoryKey(item.target)) throw new Error("[STALE_STATE] Native source changed during preparation.");
          item.identity = item.native.source;
          if (item.native.destination) item.paths.push(item.native.destination);
          await this.guard.assertNativeEvidence(item.target);
          signal?.throwIfAborted();
          item.reservation = this.guard.reserveNativeMutation(this.generation, item.target, item.native.destination);
          if (previewBudget) item.preview = { kind: input.operation === "delete" ? "Deleted" : "Moved", bytes: item.native.source.directory ? undefined : Number(item.native.source.size),
            risk: input.operation === "delete" ? `${item.native.source.directory ? "Empty directory" : "File"} deletion is irreversible; no backup.` : "No replacement; exclusive link then unlink is non-atomic and can leave both names." };
        } else if (input.operation === "write") {
          item.creation = creation;
          if (input.mode === "overwrite" && item.creation) throw new Error("[READ_REQUIRED] Overwrite target is missing; use an explicit create item.");
          if (!item.creation) { item.identity = await capturePathIdentity(path); item.parent = await capturePathIdentity(resolve(path, "..")); item.previousSha256 = await this.guard.preflightOverwrite(this.cwd, path, this.generation, item.approval); }
          else item.approval.creationPlan = item.creation;
          if (directoryKey(item.creation?.canonicalTarget ?? item.identity!.canonical) !== directoryKey(item.target)) throw new Error("[STALE_STATE] Write target changed during preparation.");
          item.approval.preparedIdentity = item.identity; item.approval.preparedParent = item.parent;
          signal?.throwIfAborted();
          item.approval.writePreflight = true;
          item.reservation = this.guard.reserveWriteMutation(this.generation, item.target, input.content!, item.creation);
          if (previewBudget) {
            if (item.creation) { item.preview = addedPreview(input.content!, previewBudget); item.preview.plannedDirectories = item.creation.directories; }
            else if (Number(item.identity!.size) + Buffer.byteLength(input.content!) <= MAX_PREVIEW_SOURCE_BYTES) {
              const before = await readPreviewSource(path, MAX_PREVIEW_SOURCE_BYTES - Buffer.byteLength(input.content!), item.identity!);
              if (sha256(before) !== item.previousSha256) throw new Error("[STALE_STATE] Overwrite changed during preview.");
              item.preview = modifiedPreview(decoder.decode(before), input.content!, previewBudget, true);
            } else item.preview = { kind: "Modified", omitted: "Candidate exceeds preview working set; inspect a bounded range with read." };
          }
        } else {
          item.identity = await capturePathIdentity(path);
          item.parent = await capturePathIdentity(resolve(path, ".."));
          if (directoryKey(item.identity.canonical) !== directoryKey(item.target)) throw new Error("[STALE_STATE] Edit target changed during preparation.");
          item.approval.preparedIdentity = item.identity; item.approval.preparedParent = item.parent;
          if (input.snapshot) {
            item.snapshot = await prepareSnapshotLineMutation(this.ctx.sessionManager.getSessionId(), this.cwd, path, input.snapshot, input.edits as SnapshotLineEdit[], signal,
              { assertPathAllowed: async () => item.target, preparedTarget: item.identity, preparedParent: item.parent, previewBudget, previewOnly: this.input.dryRun === true });
            signal?.throwIfAborted();
            item.reservation = this.guard.reserveSnapshotEdit(this.generation, item.target, item.snapshot.replacements, item.snapshot.changedBytes);
            item.previousSha256 = item.snapshot.receipt.sha256;
            item.preview = item.snapshot.preview;
          } else {
            const bytes = await readFile(path);
            const text = decoder.decode(bytes);
            item.exact = await this.guard.authorizeEdit(this.cwd, path, input.edits as GuardedEdit[], this.generation, text, item.approval, signal);
            item.reservation = item.exact.reservationId;
            const candidate = prepareExactEditContent(text, item.exact.edits, input.path);
            item.previousSha256 = sha256(bytes);
            if (previewBudget) item.preview = modifiedPreview(candidate.baseContent, candidate.newContent, previewBudget,
              this.guard.hasFullPreviewEvidence(item.target, item.previousSha256, this.generation));
          }
        }
        // Read-only all-item capability check. Execution still selects and
        // verifies current metadata immediately before the item's mutation.
        if ((input.operation === "edit" || input.operation === "write") && !item.creation) await selectCommitMetadata(item.identity!);
        if (creation) await verifyCreationAncestor(creation);
        else if (!sameIdentity(initialIdentity!, await capturePathIdentity(path)) || !sameIdentity(initialParent!, await capturePathIdentity(initialParent!.path), false)) throw new Error("[STALE_STATE] Identity changed during preparation.");
        signal?.throwIfAborted();
        for (const path of item.paths) this.paths.push(path);
      }
      signal?.throwIfAborted();
      assertIndependent(this.items);
    } catch (error) { this.release(); throw new Error(`${this.id}:${preparingIndex}: ${error instanceof Error ? error.message : String(error)}\nPreflight failed; no batch item executed.`, { cause: error }); }
  }

  attach(): void { Object.defineProperty(this.original, PREPARATION, { configurable: true, value: this }); }
  consume(args: unknown, id: string, name: string, signal?: AbortSignal): unknown {
    signal?.throwIfAborted();
    if (!this.live || args !== this.original || id !== this.id || name !== "file_batch" || mutationRequestHash("file_batch", args) !== this.requestHash) throw new Error("[POLICY_BLOCKED] Batch changed after preflight.");
    this.permission = consumePermissionPathApproval(args, id, "file_batch");
    this.assertAuthority();
    this.transferred = true;
    const privateInput = { ...this.input };
    Object.defineProperty(privateInput, EXECUTION, { value: this });
    return privateInput;
  }
  release(): void {
    const original = this.original;
    this.original = undefined;
    try {
      if (getBatchPreparation(original) === this) Object.defineProperty(original, PREPARATION, { configurable: true, value: undefined });
    } finally { if (!this.transferred) this.dispose(); }
  }
  private dispose(): void {
    this.live = false;
    for (const item of this.items) { this.guard.releaseMutation(item.reservation); item.reservation = undefined; if (item.snapshot) item.snapshot.byteEdits.length = 0; }
    this.items.length = 0; this.paths.length = 0; this.currentItem = undefined; this.permission = undefined; this.progressPi = undefined;
  }

  async execute(pi: ExtensionAPI, signal?: AbortSignal) {
    const results: ItemResult[] = [];
    const plannedDirectories: string[] = [];
    const plannedDirectoryKeys = new Set<string>();
    for (const item of this.items) {
      results.push({ itemId: item.itemId, operation: item.operation, target: item.target, destination: item.native?.destination, status: "not_started", stateChanged: false, preview: item.preview });
      if (this.input.dryRun && item.creation) for (const path of item.creation.directories) {
        const key = directoryKey(path);
        if (!plannedDirectoryKeys.has(key)) { plannedDirectoryKeys.add(key); plannedDirectories.push(path); }
      }
    }
    const sharedDirectories = new Map<string, PathIdentity>();
    try {
      this.progressPi = pi;
      await withMutationPaths(this.paths, async () => {
        for (const item of this.items) { this.currentItem = item; await this.revalidate(item, signal); }
        if (this.input.dryRun) { for (const result of results) result.status = "preview"; return; }
        const preparedTargets = [];
        for (const item of this.items) preparedTargets.push({ itemId: item.itemId, operation: item.operation, target: item.target, destination: item.native?.destination,
          directories: item.creation ? canonicalCreationDirectories(item.creation) : item.operation === "write" ? [] : undefined });
        pi.appendEntry(MUTATION_PROGRESS_ENTRY, { toolCallId: this.id, phase: "prepared", requestHash: this.requestHash, items: preparedTargets });
        for (let index = 0; index < this.items.length; index++) {
          const item = this.items[index], result = results[index];
          if (signal?.aborted) { result.status = "cancelled"; result.reason = "Cancelled before item start"; break; }
          this.currentItem = item;
          item.approval.assertCurrent = this.assertAuthority;
          item.approval.commitSelected = this.recordCommitSelection;
          try {
            pi.appendEntry(MUTATION_PROGRESS_ENTRY, { toolCallId: this.id, itemId: item.itemId, phase: "intent", requestHash: this.requestHash, operation: item.operation, target: item.target, destination: item.native?.destination,
              directories: item.creation ? canonicalCreationDirectories(item.creation) : item.operation === "write" ? [] : undefined });
            await this.revalidate(item, signal, sharedDirectories);
            let receipt: any;
            if (item.native) receipt = await executeNativePlan(item.native, this.assertAuthority, signal);
            else if (item.snapshot) receipt = { ...await executePreparedSnapshotMutation(item.snapshot, signal, { assertPathAllowed: this.assertItemPath, beforeCommit: this.assertAuthority, assertCurrent: this.assertAuthority, commitSelected: item.approval.commitSelected }), operation: "edit", target: item.target, stateChanged: true, ok: true };
            else if (item.exact) {
              const before = await readFile(item.identity!.path);
              if (sha256(before) !== item.previousSha256) throw new Error("[STALE_STATE] Prepared edit changed.");
              const candidate = prepareExactEditContent(decoder.decode(before), item.exact.edits, item.input.path);
              const diff = generateDiffString(candidate.baseContent, candidate.newContent);
              const patch = generateUnifiedPatch(item.input.path, candidate.baseContent, candidate.newContent);
              this.assertAuthority();
              const committed = await this.guard.writeEditContent(this.cwd, item.executionPath, before, candidate.finalContent, item.reservation, item.approval, signal);
              receipt = { operation: "edit", target: item.target, ok: true, stateChanged: true, ...committed, sha256: sha256(candidate.finalContent), replacements: item.exact.replacements, diff: diff.diff, patch };
            } else receipt = await this.guard.write(this.cwd, item.executionPath, item.input.content!, this.generation, signal, item.approval, item.reservation, sharedDirectories);
            result.receipt = receipt;
            result.status = receipt.status ?? "succeeded";
            result.stateChanged = receipt.stateChanged;
            if (!receipt.ok) result.reason = receipt.cause;
          } catch (error) {
            let detail: any;
            if (error instanceof FileCommitError) detail = commitFailure(error);
            else try { detail = JSON.parse(error instanceof Error ? error.message : ""); } catch { /* Non-JSON failure remains bounded below. */ }
            result.status = detail?.stateChanged === "unknown" ? "state_unknown" : detail?.stateChanged === true || (error instanceof Error && error.message.includes("[SNAPSHOT_EDIT_PARTIAL]")) ? "partial" : signal?.aborted ? "cancelled" : "failed_no_change";
            result.stateChanged = result.status === "state_unknown" ? "unknown" : result.status === "partial";
            result.receipt = detail;
            result.reason = (detail?.cause ?? (error instanceof Error ? error.message : String(error))).slice(0, 800);
          }
          const itemReceipt = result.receipt as any;
          if (result.status === "partial" || result.status === "state_unknown" || itemReceipt?.requiresVerification || itemReceipt?.commit?.retainedTemporary) result.requiresVerification = true;
          if (result.stateChanged !== false) item.reservation = undefined; // Actual changes retain their budget charge.
          if (itemReceipt?.commit?.retainedTemporary) this.guard.invalidateCanonicalPath(item.target);
          if (item.native && result.stateChanged !== false) {
            this.guard.invalidateCanonicalPath(item.target);
            if (item.native.destination) this.guard.invalidateCanonicalPath(item.native.destination);
          }
          try {
            // Durable recovery metadata is bounded; diff/patch bodies belong only to the aggregate tool result.
            const receipt = result.receipt as any;
            pi.appendEntry(MUTATION_PROGRESS_ENTRY, { toolCallId: this.id, itemId: result.itemId, phase: "result", mutationReceiptVersion: 2,
              operation: result.operation, target: result.target, destination: result.destination, status: result.status,
              stateChanged: result.stateChanged, reason: result.reason,
              requiresVerification: result.requiresVerification,
              commit: receipt?.commit,
              sha256: receipt?.sha256,
              sourceIdentity: receipt?.sourceIdentity,
              createdDirectories: receipt?.creation?.createdDirectories ?? receipt?.createdDirectories });
          }
          catch { if (result.stateChanged !== false) {
            const committed = itemReceipt?.commit?.outcome === "committed";
            result.status = committed ? "partial" : "state_unknown"; result.stateChanged = committed ? true : "unknown";
            result.requiresVerification = true;
            result.reason = "File changed but receipt recording failed; verify, never automatically retry.";
          } }
          if (result.status !== "succeeded") break;
        }
      });
    } catch (error) {
      const failedIndex = this.currentItem ? this.items.indexOf(this.currentItem) : 0;
      results[failedIndex].status = signal?.aborted ? "cancelled" : "failed_no_change";
      results[failedIndex].reason = (error instanceof Error ? error.message : String(error)).slice(0, 800);
    } finally { sharedDirectories.clear(); this.dispose(); }
    return formatBatchResult(this.input, results, plannedDirectories);
  }

  private async revalidate(item: Item, signal?: AbortSignal, shared?: Map<string, PathIdentity>): Promise<void> {
    signal?.throwIfAborted(); this.assertAuthority();
    if (item.native) { await revalidateNativePlan(item.native); await this.guard.assertNativeEvidence(item.target); return; }
    const currentTarget = await this.guard.assertEditPathAllowed(this.cwd, item.executionPath, item.approval);
    if (directoryKey(currentTarget) !== directoryKey(item.target) || (item.creation && directoryKey(item.creation.canonicalTarget) !== directoryKey(currentTarget))) throw new Error("[STALE_STATE] Prepared execution target changed.");
    if (item.creation) {
      await verifyCreationAncestor(item.creation);
      try { await lstat(item.creation.path); throw new Error("[TARGET_APPEARED] Create target appeared after preflight."); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      for (const directory of item.creation.directories) {
        if (shared?.has(directoryKey(directory))) continue;
        try { await lstat(directory); throw new Error("[STALE_STATE] Planned directory appeared after preflight."); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      }
    } else {
      if (!sameIdentity(item.identity!, await capturePathIdentity(item.identity!.path)) || !sameIdentity(item.parent!, await capturePathIdentity(item.parent!.path), false)) throw new Error("[STALE_STATE] Prepared file or parent changed.");
      if (sha256(await readFile(item.identity!.path)) !== item.previousSha256) throw new Error("[STALE_STATE] Prepared file content changed.");
    }
  }
}

export function registerFileBatch(pi: ExtensionAPI, guard: MutationWriteGuard, generation: () => number): void {
  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName !== "file_batch") return;
    const invocation = new BatchInvocation(guard, ctx, event.toolCallId, event.input, generation());
    try {
      await invocation.prepare(ctx.signal);
      ctx.signal?.throwIfAborted();
      invocation.attach();
      return { finalAuthorization: invocation };
    } catch (error) { invocation.release(); throw error; }
  });
  pi.registerTool({ name: "file_batch", label: "File batch", description: "Preflight then apply independent edit/write/delete/move items in fixed order. Write requires create or overwrite mode. One batch authorization when needed. Stop on error, preserve per-item outcomes; no transaction, rollback, reorder or replay.",
    parameters: FileBatchParameters, executionMode: "sequential", renderResult: renderBatchResult,
    async execute(_id, input, signal) {
      const invocation = (input as any)[EXECUTION] as BatchInvocation | undefined;
      if (!invocation) throw new Error("[POLICY_BLOCKED] file_batch requires guarded preflight and current batch authorization.");
      return invocation.execute(pi, signal);
    } });
}
