import { lstat, readFile } from "node:fs/promises";
import { resolve, relative, isAbsolute, sep } from "node:path";
import { TextDecoder } from "node:util";
import type { ExtensionAPI, ExtensionContext } from "@super-pi/coding-agent";
import { prepareExactEditContent, generateDiffString, generateUnifiedPatch } from "@super-pi/coding-agent";
import { Type } from "typebox";
import { Text } from "@super-pi/tui";
import type { ToolDefinition } from "@super-pi/coding-agent";
import { Value } from "typebox/value";
import { consumePermissionPathApproval, mutationRequestHash, type PermissionPathApproval } from "../resource-lifecycle-guard/permission-contract.ts";
import { MutationWriteGuard, sha256, type GuardedEdit, type MutationEditAuthorization, type MutationPathApproval } from "./core.ts";
import { prepareFileCreation, verifyCreationAncestor, directoryKey, type FileCreationPlan } from "./file-creation.ts";
import { capturePathIdentity, sameIdentity, prepareNativeOperation, revalidateNativePlan, executeNativePlan, type NativePlan, type PathIdentity, type MutationStatus } from "./native-file-core.ts";
import { prepareSnapshotLineMutation, executePreparedSnapshotMutation, type PreparedSnapshotMutation, type SnapshotLineEdit } from "./snapshot-line-edit.ts";
import { PublicEditOperationParameters, PublicEditParameters, EditParameters, SnapshotEditParameters, WriteParameters, validatePublicSnapshotAnchors } from "./mutation-parameters.ts";
import { assessProtectedMutationPath } from "./protected-path-policy.ts";
import { withMutationPaths, MUTATION_PROGRESS_ENTRY, renderFileMutationResult } from "./native-tools.ts";

const PREPARATION = Symbol("file-batch-preparation");
const EXECUTION = Symbol("file-batch-execution");
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
export const MAX_BATCH_ITEMS = 16;

const ItemParameters = Type.Object({
  operation: Type.String({ enum: ["edit", "write", "delete", "move"] }),
  path: Type.String({ minLength: 1, maxLength: 4096 }),
  mode: Type.Optional(Type.String({ enum: ["create", "overwrite"], description: "Required for write: create refuses any existing target; overwrite requires prior full read." })),
  destination: Type.Optional(Type.String({ minLength: 1, maxLength: 4096 })),
  content: Type.Optional(Type.String()),
  snapshot: Type.Optional(Type.String()),
  edits: Type.Optional(Type.Array(PublicEditOperationParameters, { minItems: 1, maxItems: 20 })),
}, { additionalProperties: false });
export const FileBatchParameters = Type.Object({
  operations: Type.Array(ItemParameters, { minItems: 1, maxItems: MAX_BATCH_ITEMS, description: "Fixed-order independent items. Put all edits of one file in one item. No chains, aliases, overlap or automatic reorder." }),
  dryRun: Type.Optional(Type.Boolean({ description: "Preflight only: no mutation, directory creation, evidence or approval token." })),
  purpose: Type.Optional(Type.String({ maxLength: 800 })),
}, { additionalProperties: false });

type Operation = "edit" | "write" | "delete" | "move";
interface BatchInput { operations: Array<{ operation: Operation; path: string; mode?: "create" | "overwrite"; content?: string; destination?: string; snapshot?: string; edits?: any[] }>; dryRun?: boolean; purpose?: string }
interface Item {
  itemId: string;
  operation: Operation;
  input: BatchInput["operations"][number];
  target: string;
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
}
interface ItemResult { itemId: string; operation: Operation; target: string; destination?: string; status: MutationStatus; stateChanged: boolean | "unknown"; reason?: string; receipt?: unknown }

function pathKey(path: string): string { return process.platform === "win32" ? path.toLowerCase() : path; }
function pathConflicts(left: string, right: string): boolean {
  left = pathKey(left); right = pathKey(right);
  const path = relative(left, right);
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}
function assertIndependent(items: readonly Item[]): void {
  for (let i = 0; i < items.length; i++) for (let j = 0; j < i; j++) {
    const a = items[i], b = items[j];
    if (a.identity && b.identity && a.identity.device === b.identity.device && a.identity.inode === b.identity.inode) throw new Error(`[BATCH_CONFLICT] ${a.itemId} and ${b.itemId} share a file identity.`);
    for (const left of a.paths) for (const right of b.paths) if (pathConflicts(left, right) || pathConflicts(right, left)) throw new Error(`[BATCH_CONFLICT] ${a.itemId} and ${b.itemId} overlap; split dependent changes into verified stages.`);
  }
}
function copyInput(value: unknown): BatchInput {
  if (!Value.Check(FileBatchParameters, value)) throw new Error("[TOOL_ARGS_INVALID] Invalid file_batch object or fields.");
  const input = value as BatchInput;
  let bytes = 0;
  const operations: BatchInput["operations"] = [];
  for (const item of input.operations) {
    bytes += Buffer.byteLength(item.content ?? "", "utf8");
    if (item.edits) for (const edit of item.edits) {
      bytes += Buffer.byteLength(edit.oldText ?? "", "utf8") + Buffer.byteLength(edit.newText ?? "", "utf8");
      if (edit.newLines) for (const line of edit.newLines) bytes += Buffer.byteLength(line, "utf8");
    }
    if (bytes > 1024 * 1024) throw new Error("[MUTATION_BUDGET_EXCEEDED] Batch input exceeds 1 MiB of mutation text.");
    const clean: any = {};
    for (const key of Object.keys(item)) if (key !== "operation") clean[key] = (item as any)[key];
    if (item.operation === "write") {
      if (item.mode !== "create" && item.mode !== "overwrite") throw new Error("[TOOL_ARGS_INVALID] Batch write requires explicit create or overwrite mode.");
      const write = { path: item.path, content: item.content };
      if (!Value.Check(WriteParameters, write) || Object.keys(item).some(key => !["operation", "path", "mode", "content"].includes(key))) throw new Error("[TOOL_ARGS_INVALID] Invalid write item fields.");
    } else if (item.operation === "edit") {
      if (!Value.Check(PublicEditParameters, clean)) throw new Error("[TOOL_ARGS_INVALID] Invalid edit item fields.");
      if (item.snapshot) { validatePublicSnapshotAnchors(clean); if (!Value.Check(SnapshotEditParameters, clean)) throw new Error("[TOOL_ARGS_INVALID] Invalid snapshot item."); }
      else if (!Value.Check(EditParameters, clean)) throw new Error("[TOOL_ARGS_INVALID] Mixed or incomplete exact edit item.");
    } else if (Object.keys(item).some(key => !["operation", "path", ...(item.operation === "move" ? ["destination"] : [])].includes(key))) throw new Error("[TOOL_ARGS_INVALID] Invalid native item fields.");
    const edits = item.edits?.map(edit => Object.freeze({ ...edit, ...(edit.newLines ? { newLines: Object.freeze([...edit.newLines]) } : {}) }));
    operations.push(Object.freeze({ ...item, ...(edits ? { edits: Object.freeze(edits) as any } : {}) }));
  }
  return Object.freeze({ operations: Object.freeze(operations) as any, dryRun: input.dryRun, purpose: input.purpose });
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
  readonly assertAuthority = (): void => { if (!this.live || !this.permission?.assertCurrent || this.ctx.cwd !== this.cwd || this.ctx.sessionManager.getSessionId() !== this.sessionId) throw new Error("[POLICY_BLOCKED] Batch authority is unavailable."); this.permission.assertCurrent(); };
  readonly assertItemPath = async (): Promise<string> => {
    this.assertAuthority();
    const item = this.currentItem!;
    return this.guard.assertEditPathAllowed(this.cwd, item.input.path, item.approval);
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
    try {
      for (let index = 0; index < this.input.operations.length; index++) {
        signal?.throwIfAborted();
        const input = this.input.operations[index];
        const path = resolve(this.cwd, input.path);
        const assessment = await assessProtectedMutationPath(this.cwd, path);
        if (!assessment.canonicalTarget) throw new Error("[POLICY_BLOCKED] Unverifiable batch target.");
        const item: Item = { itemId: `${this.id}:${index}`, operation: input.operation, input, target: assessment.canonicalTarget,
          paths: [assessment.canonicalTarget], approval: { canonicalTarget: assessment.canonicalTarget, protectedRoots: assessment.violations } };
        this.items.push(item);
        if (input.operation === "delete" || input.operation === "move") {
          item.native = await prepareNativeOperation(this.cwd, input.operation, input.operation === "move" ? { path: input.path, destination: input.destination } : { path: input.path });
          item.identity = item.native.source;
          if (item.native.destination) item.paths.push(item.native.destination);
          await this.guard.assertNativeEvidence(item.target);
          item.reservation = this.guard.reserveNativeMutation(this.generation, item.target, item.native.destination);
        } else if (input.operation === "write") {
          item.creation = await prepareFileCreation(path, input.mode === "create");
          if (input.mode === "overwrite" && item.creation) throw new Error("[READ_REQUIRED] Overwrite target is missing; use an explicit create item.");
          if (!item.creation) { item.identity = await capturePathIdentity(path); item.parent = await capturePathIdentity(resolve(path, "..")); item.previousSha256 = await this.guard.preflightOverwrite(this.cwd, input.path, this.generation, item.approval); }
          else item.approval.creationPlan = item.creation;
          item.approval.writePreflight = true;
          item.reservation = this.guard.reserveWriteMutation(this.generation, item.target, input.content!, item.creation);
        } else {
          item.identity = await capturePathIdentity(path);
          item.parent = await capturePathIdentity(resolve(path, ".."));
          if (input.snapshot) {
            item.snapshot = await prepareSnapshotLineMutation(this.ctx.sessionManager.getSessionId(), this.cwd, input.path, input.snapshot, input.edits as SnapshotLineEdit[], signal,
              { assertPathAllowed: async () => item.target });
            item.reservation = this.guard.reserveSnapshotEdit(this.generation, item.target, item.snapshot.replacements, item.snapshot.changedBytes);
            item.previousSha256 = item.snapshot.receipt.sha256;
          } else {
            const bytes = await readFile(path);
            const text = decoder.decode(bytes);
            item.exact = await this.guard.authorizeEdit(this.cwd, input.path, input.edits as GuardedEdit[], this.generation, text, item.approval);
            item.reservation = item.exact.reservationId;
            prepareExactEditContent(text, item.exact.edits, input.path);
            item.previousSha256 = sha256(bytes);
          }
        }
        for (const path of item.paths) this.paths.push(path);
      }
      assertIndependent(this.items);
    } catch (error) { this.dispose(); throw error; }
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
    if (this.original && typeof this.original === "object") Object.defineProperty(this.original, PREPARATION, { configurable: true, value: undefined });
    this.original = undefined;
    if (!this.transferred) this.dispose();
  }
  private dispose(): void {
    this.live = false;
    for (const item of this.items) { this.guard.releaseMutation(item.reservation); item.reservation = undefined; if (item.snapshot) item.snapshot.byteEdits.length = 0; }
    this.items.length = 0; this.paths.length = 0; this.currentItem = undefined; this.permission = undefined;
  }

  async execute(pi: ExtensionAPI, signal?: AbortSignal) {
    const results: ItemResult[] = [];
    for (const item of this.items) results.push({ itemId: item.itemId, operation: item.operation, target: item.target, destination: item.native?.destination, status: "not_started", stateChanged: false });
    const sharedDirectories = new Map<string, PathIdentity>();
    try {
      await withMutationPaths(this.paths, async () => {
        for (const item of this.items) { this.currentItem = item; await this.revalidate(item, signal); }
        if (this.input.dryRun) return;
        for (let index = 0; index < this.items.length; index++) {
          const item = this.items[index], result = results[index];
          if (signal?.aborted) { result.status = "cancelled"; result.reason = "Cancelled before item start"; break; }
          this.currentItem = item;
          item.approval.assertCurrent = this.assertAuthority;
          try {
            await this.revalidate(item, signal, sharedDirectories);
            pi.appendEntry(MUTATION_PROGRESS_ENTRY, { toolCallId: this.id, itemId: item.itemId, phase: "intent", operation: item.operation, target: item.target, destination: item.native?.destination });
            let receipt: any;
            if (item.native) receipt = await executeNativePlan(item.native, this.assertAuthority, signal);
            else if (item.snapshot) receipt = { ...await executePreparedSnapshotMutation(item.snapshot, signal, { assertPathAllowed: this.assertItemPath, beforeCommit: this.assertAuthority }), operation: "edit", target: item.target, stateChanged: true, ok: true };
            else if (item.exact) {
              const before = await readFile(item.identity!.path);
              if (sha256(before) !== item.previousSha256) throw new Error("[STALE_STATE] Prepared edit changed.");
              const candidate = prepareExactEditContent(decoder.decode(before), item.exact.edits, item.input.path);
              const diff = generateDiffString(candidate.baseContent, candidate.newContent);
              const patch = generateUnifiedPatch(item.input.path, candidate.baseContent, candidate.newContent);
              this.assertAuthority();
              const previousSha256 = await this.guard.writeEditContent(this.cwd, item.input.path, before, candidate.finalContent, item.reservation, item.approval);
              receipt = { operation: "edit", target: item.target, ok: true, stateChanged: true, previousSha256, sha256: sha256(candidate.finalContent), replacements: item.exact.replacements, diff: diff.diff, patch };
            } else receipt = await this.guard.write(this.cwd, item.input.path, item.input.content!, this.generation, signal, item.approval, item.reservation, sharedDirectories);
            result.receipt = receipt;
            result.status = receipt.status ?? "succeeded";
            result.stateChanged = receipt.stateChanged;
            if (!receipt.ok) result.reason = receipt.cause;
          } catch (error) {
            let detail: any;
            try { detail = JSON.parse(error instanceof Error ? error.message : ""); } catch { /* Non-JSON failure remains bounded below. */ }
            result.status = detail?.stateChanged === true || (error instanceof Error && error.message.includes("[SNAPSHOT_EDIT_PARTIAL]")) ? "partial" : signal?.aborted ? "cancelled" : "failed_no_change";
            result.stateChanged = result.status === "partial";
            result.receipt = detail;
            result.reason = (detail?.cause ?? (error instanceof Error ? error.message : String(error))).slice(0, 800);
          }
          if (result.stateChanged !== false) item.reservation = undefined; // Actual changes retain their budget charge.
          if (item.native && result.stateChanged !== false) {
            await this.guard.invalidate(this.cwd, item.target);
            if (item.native.destination) await this.guard.invalidate(this.cwd, item.native.destination);
          }
          try { pi.appendEntry(MUTATION_PROGRESS_ENTRY, { toolCallId: this.id, phase: "result", mutationReceiptVersion: 2, ...result }); }
          catch { if (result.stateChanged !== false) { result.status = "state_unknown"; result.stateChanged = "unknown"; result.reason = "File changed but receipt recording failed; verify, never automatically retry."; } }
          if (result.status !== "succeeded") break;
        }
      });
    } catch (error) {
      const failedIndex = this.currentItem ? this.items.indexOf(this.currentItem) : 0;
      results[failedIndex].status = signal?.aborted ? "cancelled" : "failed_no_change";
      results[failedIndex].reason = (error instanceof Error ? error.message : String(error)).slice(0, 800);
    } finally { sharedDirectories.clear(); this.dispose(); }
    let succeeded = 0, failed = 0, notStarted = 0;
    let firstReason: string | undefined;
    for (const result of results) { if (result.status === "succeeded") succeeded++; else if (result.status === "not_started") notStarted++; else { failed++; firstReason ??= result.reason; } }
    const preview = this.input.dryRun && failed === 0;
    let summary = preview ? `Preflight passed for ${results.length} items. No changes; apply revalidates and requires current authorization.` : `file_batch: ${succeeded} succeeded, ${failed} failed, ${notStarted} not started.${firstReason ? `\n${firstReason}` : ""}`;
    const collapsedSummary = summary;
    if (!preview) for (const result of results) {
      const receipt = result.receipt as any;
      summary += `\n${result.itemId}: ${result.status === "succeeded" && receipt?.created ? "Added" : result.operation} ${result.target}: ${result.status}`;
      if (result.status === "succeeded" && receipt?.creation) {
        summary += receipt.creation.addedLines === undefined ? ` (${receipt.creation.bytes} bytes)` : ` (+${receipt.creation.addedLines} -0)`;
        if (receipt.creation.createdDirectories.length) summary += `; created ${receipt.creation.createdDirectories.length} parent directories`;
      }
    }
    return { content: [{ type: "text" as const, text: summary }], details: { mutationReceiptVersion: 2, operation: "file_batch", preview, collapsedSummary, succeeded, failed, notStarted, items: results }, isError: failed > 0 };
  }

  private async revalidate(item: Item, signal?: AbortSignal, shared?: Map<string, PathIdentity>): Promise<void> {
    signal?.throwIfAborted(); this.assertAuthority();
    if (item.native) { await revalidateNativePlan(item.native); await this.guard.assertNativeEvidence(item.target); return; }
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
    await invocation.prepare(ctx.signal);
    invocation.attach();
    return { finalAuthorization: invocation };
  });
  pi.registerTool({ name: "file_batch", label: "File batch", description: "Preflight then apply independent edit/write/delete/move items in fixed order. Write requires create or overwrite mode. One batch authorization when needed. Stop on error, preserve per-item outcomes; no transaction, rollback, reorder or replay.",
    parameters: FileBatchParameters, executionMode: "sequential", renderResult: renderBatchResult,
    async execute(_id, input, signal) {
      const invocation = (input as any)[EXECUTION] as BatchInvocation | undefined;
      if (!invocation) throw new Error("[POLICY_BLOCKED] file_batch requires guarded preflight and current batch authorization.");
      return invocation.execute(pi, signal);
    } });
}

export const renderBatchResult: NonNullable<ToolDefinition<any, any>["renderResult"]> = function renderBatchResult(result, options, _theme, context) {
  const component = context.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
  const primary = result.content[0];
  const full = primary?.type === "text" ? primary.text : "";
  component.setText(options.isPartial ? "File batch running" : options.expanded ? full : result.details?.collapsedSummary ?? full);
  return component;
};
