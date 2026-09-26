import { MUTATION_READ_SOURCE } from "../../coding-agent/src/core/tools/read-window.ts";
import { EditParameters, SnapshotEditParameters, PublicEditParameters, WriteParameters,
  hasSnapshotOperationFields, validatePublicSnapshotAnchors,
  type GuardedEditInput, type SnapshotEditInput, type PublicEditInput, type GuardedWriteInput } from "./mutation-parameters.ts";
import { EDIT_INDEX_PATTERN } from "./regex.ts";
import { constants } from "node:fs";
import process from "node:process";
import { access, readFile } from "node:fs/promises";
import type { EditOperations, ExtensionAPI } from "@super-pi/coding-agent";
import {
  createEditToolDefinition,
  withFileMutationQueue,
} from "@super-pi/coding-agent";
import { Value } from "typebox/value";
import type { GuardedEdit, MutationEditAuthorization, MutationPathApproval } from "./core.ts";
import {
  executeSnapshotLineEdit,
  validateInsertionFields,
  MAX_SNAPSHOT_LINE_EDITS,
  resetSnapshotLineStore,
  resolveSnapshotCanonicalTarget,
  type SnapshotLineEdit,
} from "./snapshot-line-edit.ts";
import { MUTATION_RECEIPT_VERSION, MutationWriteGuard, resolveToolPath, sha256 } from "./core.ts";
import { diagnoseFailedEdit } from "./edit-diagnostics.ts";
import { SHA256_PATTERN } from "./regex.ts";
import { primaryReadResultText, readEvidenceRange, restoreMutationEvidenceFromBranch, recordBatchMutationEvidence, recentMutationEntries } from "./session-evidence.ts";
import { consumePermissionPathApproval } from "../resource-lifecycle-guard/permission-contract.ts";
import { registerNativeTools, MUTATION_PROGRESS_ENTRY, renderFileMutationResult } from "./native-tools.ts";
import { registerFileBatch } from "./file-batch.ts";
import { FileCommitError, commitFailure, commitSummary, type FileCommitReceipt } from "./file-commit.ts";

interface ToolResultEventShape {
  toolName: string;
  toolCallId: string;
  input: unknown;
  content: Array<{ type: string; text?: string }>;
  details?: unknown;
  isError: boolean;
}

interface MutationFailureInfo {
  category?: unknown;
  stateChanged?: unknown;
  cause?: unknown;
  status?: unknown;
  commit?: FileCommitReceipt;
}



function mutationFailureInfo(error: unknown): MutationFailureInfo | undefined {
  if (!(error instanceof Error)) return undefined;
  try {
    return JSON.parse(error.message) as MutationFailureInfo;
  } catch {
    return undefined;
  }
}

function failedEditIndex(failure: MutationFailureInfo | undefined): number | undefined {
  if (typeof failure?.cause !== "string") return undefined;
  const match = EDIT_INDEX_PATTERN.exec(failure.cause);
  if (!match) return undefined;
  const index = Number(match[1]);
  return Number.isSafeInteger(index) ? index : undefined;
}

function diagnosticLocations(diagnostic: string | undefined, editIndex: number | undefined): string | undefined {
  if (!diagnostic || editIndex === undefined) return undefined;
  const prefix = `edits[${editIndex}].oldText exact location(s): line `;
  const start = diagnostic.indexOf(prefix);
  if (start < 0) return undefined;
  const valueStart = start + prefix.length;
  const end = diagnostic.indexOf("\n", valueStart);
  return diagnostic.slice(valueStart, end < 0 ? diagnostic.length : end).trim() || undefined;
}

function conciseMutationFailure(
  message: string,
  failure: MutationFailureInfo | undefined,
  diagnostic: string | undefined,
  editIndex: number | undefined,
): string {
  const category = typeof failure?.category === "string" ? failure.category : undefined;
  const cause = typeof failure?.cause === "string" ? failure.cause : message;
  if (!category) return cause;
  if (category === "EDIT_TARGET_AMBIGUOUS") {
    const locations = diagnosticLocations(diagnostic, editIndex);
    if (locations !== undefined && editIndex !== undefined) {
      return `[${category}] edits[${editIndex}] matched lines ${locations}.\nRetry: add expectedLine or read one exact range.`;
    }
  }
  if (category === "READ_REQUIRED") {
    return `[${category}] No qualifying prior read covers this edit.\nRetry: use dedicated read for the exact target range in an earlier completed tool turn, then edit; Bash, grep, LSP, same-turn and stale evidence do not qualify.`;
  }
  let output = `[${category}] ${cause}`;
  if (failure?.stateChanged === true) output += "\nWarning: the target may have changed; verify it before retrying.";
  return output;
}

function inputPath(input: unknown): string | undefined {
  if (!input || typeof input !== "object" || !("path" in input)) return undefined;
  const value = (input as { path?: unknown }).path;
  return typeof value === "string" ? value : undefined;
}

function resultSha256(details: unknown): string | undefined {
  if (!details || typeof details !== "object") return undefined;
  const value = (details as { sha256?: unknown }).sha256;
  return typeof value === "string" && SHA256_PATTERN.test(value) ? value : undefined;
}

function cloneGuardedEdits(edits: readonly GuardedEdit[]): GuardedEdit[] {
  const cloned: GuardedEdit[] = [];
  for (const edit of edits) {
    cloned.push({ oldText: edit.oldText, newText: edit.newText, expectedLine: edit.expectedLine });
  }
  return cloned;
}
function observedTextRead(event: ToolResultEventShape): {
  path: string;
  text: string;
  startLine: number;
  endLine: number;
  complete: boolean;
} | undefined {
  if (event.toolName !== "read" || event.isError) return undefined;
  if (!event.input || typeof event.input !== "object") return undefined;
  const input = event.input as { path?: unknown; offset?: unknown; limit?: unknown };
  if (typeof input.path !== "string") return undefined;
  const displayedText = primaryReadResultText(event.content, event.details);
  if (displayedText === undefined) return undefined;
  const text = displayedText;
  const range = readEvidenceRange(input, event.details, text);
  return range ? { path: input.path, text, ...range } : undefined;
}

class GuardedEditExecution {
  readonly operations: EditOperations;
  readonly #guard: MutationWriteGuard;
  readonly #cwd: string;
  readonly #input: GuardedEditInput;
  readonly #originalEdits: GuardedEdit[];
  readonly #turnGeneration: number;
  readonly #pathApproval?: MutationPathApproval;
  readonly #signal?: AbortSignal;
  #previousContent?: Buffer;
  authorization?: MutationEditAuthorization;
  writtenSha256?: string;
  previousSha256?: string;
  commit?: FileCommitReceipt;
  writeSucceeded = false;

  constructor(
    guard: MutationWriteGuard,
    cwd: string,
    input: GuardedEditInput,
    turnGeneration: number,
    pathApproval?: MutationPathApproval,
    signal?: AbortSignal,
  ) {
    this.#guard = guard;
    this.#cwd = cwd;
    this.#input = input;
    this.#originalEdits = cloneGuardedEdits(input.edits);
    this.#turnGeneration = turnGeneration;
    this.#pathApproval = pathApproval;
    this.#signal = signal;
    this.operations = {
      access: this.#accessFile.bind(this),
      readFile: this.#readFile.bind(this),
      writeFile: this.#writeFile.bind(this),
    };
  }

  async #accessFile(absolutePath: string): Promise<void> {
    await access(absolutePath, constants.R_OK | constants.W_OK);
  }

  async #readFile(absolutePath: string): Promise<Buffer> {
    const content = await readFile(absolutePath);
    this.authorization = await this.#guard.authorizeEdit(
      this.#cwd,
      this.#input.path,
      this.#originalEdits,
      this.#turnGeneration,
      content.toString("utf8"),
      this.#pathApproval,
    );
    this.#input.edits.splice(0, this.#input.edits.length, ...this.authorization.edits);
    this.#previousContent = content;
    return content;
  }

  async #writeFile(_absolutePath: string, content: string): Promise<void> {
    if (!this.#previousContent) throw new Error("Edit guard lost the original file state.");
    const committed = await this.#guard.writeEditContent(
      this.#cwd,
      this.#input.path,
      this.#previousContent,
      content,
      this.authorization?.reservationId,
      this.#pathApproval,
      this.#signal,
    );
    this.previousSha256 = committed.previousSha256;
    this.commit = committed.commit;
    this.writtenSha256 = sha256(content);
    this.writeSucceeded = true;
  }
}

export default function mutationGuardWriteExtension(pi: ExtensionAPI): void {
  const guard = new MutationWriteGuard();
  const upstreamEdit = createEditToolDefinition(process.cwd());
  let turnGeneration = 0;
  registerNativeTools(pi, guard, () => turnGeneration);
  registerFileBatch(pi, guard, () => turnGeneration);

  function finishEdit(toolCallId: string, target: string, details: any, text: string) {
    const status = details.ok ? "succeeded" : details.stateChanged === "unknown" ? "state_unknown" : details.stateChanged ? "partial" : "failed_no_change";
    const receipt = { ...details, mutationReceiptVersion: 2, operation: "edit", target, status };
    try {
      pi.appendEntry(MUTATION_PROGRESS_ENTRY, { toolCallId, itemId: `${toolCallId}:0`, phase: "result", mutationReceiptVersion: 2,
        operation: "edit", target, status, stateChanged: receipt.stateChanged, sha256: receipt.sha256, commit: receipt.commit });
    } catch {
      if (receipt.stateChanged !== false) {
        receipt.status = "state_unknown"; receipt.stateChanged = "unknown"; receipt.ok = false; receipt.requiresVerification = true;
        guard.invalidateCanonicalPath(target);
        text = "Edit may have committed but receipt recording failed. Verify current state; do not automatically retry.";
      }
    }
    if (receipt.commit) text += `\n${commitSummary(receipt.commit)}`;
    return { content: [{ type: "text" as const, text }], details: receipt, isError: !receipt.ok };
  }

  async function resetAndRestoreEvidence(ctx: {
    cwd: string;
    sessionManager?: { getBranch?: () => readonly unknown[] };
  }): Promise<void> {
    guard.clear();
    turnGeneration = 0;
    const branch = ctx.sessionManager?.getBranch?.() ?? [];
    await restoreMutationEvidenceFromBranch(guard, ctx.cwd, branch);
  }

  pi.on("session_start", async (_event, ctx) => {
    resetSnapshotLineStore();
    await resetAndRestoreEvidence(ctx);
  });
  pi.on("session_tree", async (_event, ctx) => {
    resetSnapshotLineStore();
    await resetAndRestoreEvidence(ctx);
  });
  pi.on("session_shutdown", () => resetSnapshotLineStore());
  pi.on("turn_start", () => {
    turnGeneration += 1;
  });

  pi.on("tool_result", async (rawEvent, ctx) => {
    const event = rawEvent as ToolResultEventShape;
    if (event.toolName === "file_batch") {
      await recordBatchMutationEvidence(guard, ctx.cwd, event.input, event.details, event.toolCallId, turnGeneration, recentMutationEntries(ctx.sessionManager));
      return;
    }
    const read = observedTextRead(event);
    if (read) {
      try {
        const source = (event.content as any)?.[MUTATION_READ_SOURCE];
        if (!source || typeof source.canonicalPath !== "string" || typeof source.addressedPath !== "string" || typeof source.fileGeneration !== "string") throw new Error("Read source identity is unavailable.");
        const target = await guard.recordRead(
          ctx.cwd,
          source.addressedPath,
          read.text,
          read.startLine,
          read.endLine,
          event.toolCallId,
          turnGeneration,
          read.complete,
          source.canonicalPath,
          source,
        );
        const input = event.input as { path: string; offset?: unknown; limit?: unknown };
        return { details: { ...(event.details as object), mutationReadEvidence: { version: 2, toolCallId: event.toolCallId,
          path: input.path, offset: input.offset, limit: input.limit, target } } };
      } catch {
        // A rejected modern read must not fall back to legacy raw-path restoration.
        return { details: { ...(event.details as object), mutationReadEvidence: { version: 2, toolCallId: event.toolCallId, rejected: true } } };
      }
    }

    if ((event.toolName === "edit" || event.toolName === "write") && !event.isError) {
      const path = inputPath(event.input);
      const expectedSha256 = resultSha256(event.details);
      if (!path || !expectedSha256) {
        if (path) await guard.invalidate(ctx.cwd, path);
        return;
      }
      try {
        await guard.recordMutationSnapshot(ctx.cwd, path, expectedSha256, event.toolCallId, turnGeneration);
      } catch {
        // A successful mutation is evidence only when the on-disk snapshot can
        // be read back and hashed; otherwise fail closed for later edits and overwrites.
        await guard.invalidate(ctx.cwd, path);
      }
    }
  });

  function ordinaryEditDefinition(): typeof upstreamEdit {
    return {
    ...upstreamEdit,
    name: "edit",
    label: "edit (mutation guarded)",
    description: "Edit one existing file by exact replacements. Requires prior read evidence for that file; repeated oldText needs one covered range or expectedLine. A verified prior mutation snapshot may qualify. Native uniqueness, overlap, diff, and queue checks remain authoritative.",
    promptSnippet: "Edit a previously read file",
    parameters: EditParameters,
    promptGuidelines: [
      "Read the exact target first unless its verified prior mutation qualifies; repeated text needs exact range evidence or expectedLine.",
      "For protected targets, include purpose with effects and rollback.",
    ],
    executionMode: "sequential",
    async execute(toolCallId, input: GuardedEditInput, signal, onUpdate, ctx) {
      const granted = consumePermissionPathApproval(input, toolCallId, "edit") as MutationPathApproval | undefined;
      const pathApproval = granted ? { ...granted } : undefined;
      const receiptTarget = pathApproval?.canonicalTarget ?? resolveToolPath(ctx.cwd, input.path);
      if (pathApproval) pathApproval.commitSelected = metadata => {
        pi.appendEntry(MUTATION_PROGRESS_ENTRY, { toolCallId, itemId: `${toolCallId}:0`, phase: "intent", operation: "edit", target: receiptTarget,
          strategy: metadata.strategy, compatibilityReason: metadata.reason });
        if (metadata.reason) onUpdate?.({ content: [{ type: "text", text: `Commit selected: ${metadata.reason}` }], details: { diff: "", patch: "" } });
      };
      const nativeInput: GuardedEditInput = {
        path: input.path,
        edits: cloneGuardedEdits(input.edits),
      };
      const execution = new GuardedEditExecution(guard, ctx.cwd, nativeInput, turnGeneration, pathApproval, signal);
      const guardedEdit = createEditToolDefinition(ctx.cwd, { operations: execution.operations });
      try {
        const result = await guardedEdit.execute(toolCallId, nativeInput, signal, onUpdate, ctx);
        if (!result.details) throw new Error("Native edit completed without diff/patch details.");
        return finishEdit(toolCallId, receiptTarget, {
            ...result.details,
            ok: true,
            mutationReceiptVersion: MUTATION_RECEIPT_VERSION,
            category: "success",
            operation: "edit",
            target: pathApproval?.canonicalTarget ?? execution.authorization?.target ?? input.path,
            stateChanged: true,
            previousSha256: execution.previousSha256,
            sha256: execution.writtenSha256,
            replacements: execution.authorization?.replacements ?? input.edits.length,
            omittedNoOpEdits: execution.authorization?.omittedNoOpEdits ?? 0,
            estimatedChangedBytes: execution.authorization?.estimatedChangedBytes,
            commit: execution.commit,
          }, result.content.filter(block => block.type === "text").map(block => block.text).join("\n"));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const failure = mutationFailureInfo(error);
        if (!execution.writeSucceeded && failure?.stateChanged !== true && failure?.stateChanged !== "unknown") {
          guard.releaseMutation(execution.authorization?.reservationId);
        }
        if (failure?.commit) return finishEdit(toolCallId, receiptTarget, { ...failure, ok: false }, conciseMutationFailure(message, failure, undefined, undefined));
        if (execution.writeSucceeded) {
          guard.invalidateCanonicalPath(receiptTarget);
          return finishEdit(toolCallId, receiptTarget, { ok: false, stateChanged: true, requiresVerification: true, commit: execution.commit }, `Edit committed but completion failed: ${message}`);
        }
        const editIndex = failedEditIndex(failure);
        let recovery;
        try {
          recovery = await diagnoseFailedEdit(ctx.cwd, input.path, input.edits, editIndex);
        } catch {
          recovery = undefined;
        }
        if (recovery?.alreadyApplied) {
          return {
            content: [{
              type: "text" as const,
              text: `No edit was needed: all ${input.edits.length} replacement(s) are already applied in ${input.path}.`,
            }],
            details: {
              diff: "",
              patch: "",
              ok: true,
              category: "already_applied",
              operation: "edit",
              target: input.path,
              stateChanged: false,
              replacements: 0,
              alreadyApplied: true,
            },
          };
        }
        throw new Error(conciseMutationFailure(message, failure, recovery?.diagnostic, editIndex));
      }
    },
    };
  }

  function registerSnapshotEdit(): void {
    const ordinaryEdit = ordinaryEditDefinition();
    pi.registerTool({
      name: "edit",
      label: "edit (snapshot LINE#ID guarded)",
      description: "Edit one existing UTF-8 file after a completed dedicated read. Prefer bounded snapshot LINE#ID operations; exact oldText replacements remain available when that read issues no snapshot. Both modes are single-file and guarded.",
      promptSnippet: "Edit one file by immutable LINE#ID anchors or exact replacements",
      promptGuidelines: [
        "Before editing, use dedicated read in a completed prior turn; Bash, grep, LSP, and same-turn reads do not authorize edits.",
        "Combine already-known, non-overlapping edits covered by the same valid snapshot into one call as a logical change, including a declaration rename and known references confirmed to belong to that binding. A successful mutation makes pre-mutation snapshots unusable for that file. For newly discovered changes, complete a new read and use its paired snapshot and LINE#ID anchors; do not issue dependent same-file edits as independent sibling requests. Keep operation and byte limits.",
        "Insertion keeps one start anchor: omit end; newLines contains only intended inserted lines, not copied locating context. Each item is one physical line.",
        "Without snapshot, exact oldText/newText still requires the same completed read evidence; keep oldText unique. Include purpose for protected targets.",
      ],
      parameters: PublicEditParameters,
      executionMode: "sequential",
      async execute(toolCallId, input: PublicEditInput, signal, _onUpdate, ctx) {
        if (typeof input.snapshot !== "string") {
          for (let index = 0; index < input.edits.length; index++) {
            if (hasSnapshotOperationFields(input.edits[index])) {
              throw new Error(`[SNAPSHOT_REQUIRED] Missing top-level "snapshot" for LINE#ID edits (not inside edits[${index}]). No change.\nRetry: copy the snapshot ID paired with these anchors from the completed read. Read again only if that snapshot is unavailable, stale, or does not cover the target.`);
            }
          }
          if (!Value.Check(EditParameters, input)) {
            for (let index = 0; index < input.edits.length; index++) {
              const edit = input.edits[index];
              if (edit.oldText === undefined || edit.newText === undefined) throw new Error(`[TOOL_ARGS_INVALID] Missing required field "edits[${index}].${edit.oldText === undefined ? "oldText" : "newText"}" in exact mode. No change.\nRetry: complete this replacement using qualifying read evidence.`);
            }
            throw new Error("[TOOL_ARGS_INVALID] Invalid exact edit fields. No change.\nRetry: supply only oldText/newText and optional expectedLine operations.");
          }
          return ordinaryEdit.execute(toolCallId, input as GuardedEditInput, signal, _onUpdate, ctx);
        }
        validatePublicSnapshotAnchors(input);
        if (!Value.Check(SnapshotEditParameters, input)) {
          throw new Error("[SNAPSHOT_EDIT_INVALID] Invalid snapshot operation fields. No change.\nRetry: supply only kind/start/end/newLines operations.");
        }
        const snapshotInput = input as SnapshotEditInput;
        const pathApproval = consumePermissionPathApproval(snapshotInput, toolCallId, "edit") as MutationPathApproval | undefined;
        const sessionId = ctx.sessionManager.getSessionId();
        const canonicalTarget = await resolveSnapshotCanonicalTarget(sessionId, ctx.cwd, snapshotInput.path, snapshotInput.snapshot);
        let reservationId: number | undefined;
        try {
          const details = await withFileMutationQueue(canonicalTarget, async () => executeSnapshotLineEdit(
            sessionId,
            ctx.cwd,
            snapshotInput.path,
            snapshotInput.snapshot,
            snapshotInput.edits as SnapshotLineEdit[],
            signal,
            {
              preparedTarget: pathApproval?.preparedIdentity,
              preparedParent: pathApproval?.preparedParent,
              commitSelected: metadata => {
                pi.appendEntry(MUTATION_PROGRESS_ENTRY, { toolCallId, itemId: `${toolCallId}:0`, phase: "intent", operation: "edit", target: canonicalTarget,
                  strategy: metadata.strategy, compatibilityReason: metadata.reason });
                if (metadata.reason) _onUpdate?.({ content: [{ type: "text", text: `Commit selected: ${metadata.reason}` }], details: {} });
              },
              assertPathAllowed: () => guard.assertEditPathAllowed(ctx.cwd, snapshotInput.path, pathApproval),
              reserveMutation: (changedBytes) => {
                reservationId = guard.reserveSnapshotEdit(
                  turnGeneration,
                  canonicalTarget,
                  snapshotInput.edits.length,
                  changedBytes,
                );
                return reservationId;
              },
              assertCurrent: pathApproval?.assertCurrent,
              beforeCommit: async () => {
                await guard.assertEditPathAllowed(ctx.cwd, snapshotInput.path, pathApproval);
              },
            },
          ));
          return finishEdit(toolCallId, canonicalTarget, {
              ...details,
              ok: true,
              mutationReceiptVersion: MUTATION_RECEIPT_VERSION,
              category: "success",
              operation: "edit",
              target: canonicalTarget,
              stateChanged: true,
            }, `Successfully applied ${details.replacements} snapshot LINE#ID operation(s) to ${snapshotInput.path}.\nFor a dependent edit, read again and use its snapshot and LINE#ID anchors; pre-mutation snapshots for this file are unusable.`);
        } catch (error) {
          if (error instanceof FileCommitError) {
            const failure = commitFailure(error);
            if (failure.stateChanged === false) guard.releaseMutation(reservationId);
            else guard.invalidateCanonicalPath(canonicalTarget);
            return finishEdit(toolCallId, canonicalTarget, failure, error.message);
          }
          const message = error instanceof Error ? error.message : String(error);
          if (!message.includes("[SNAPSHOT_EDIT_PARTIAL]")) guard.releaseMutation(reservationId);
          else await guard.invalidate(ctx.cwd, snapshotInput.path);
          throw error;
        }
      },
    });
  }

  registerSnapshotEdit();

  pi.registerTool({
    name: "write",
    label: "write (mutation guarded)",
    description: "Create a file exclusively or overwrite one after a prior full read. Existing content must still match inside the mutation queue.",
    promptSnippet: "Create or overwrite a fully read file",
    promptGuidelines: [
      "For an existing whole-file overwrite, dedicated read must return complete content in an earlier tool turn and still match; truncated, partial, same-turn, Bash, grep, LSP, or stale evidence fails. Use range/snapshot edit for local changes. Missing files use exclusive creation without a read. Include purpose for protected targets.",
    ],
    parameters: WriteParameters,
    renderResult: renderFileMutationResult,
    executionMode: "sequential",
    async execute(toolCallId, input: GuardedWriteInput, signal, _onUpdate, ctx) {
      const { path, content } = input;
      const absolutePath = resolveToolPath(ctx.cwd, path);
      const granted = consumePermissionPathApproval(input, toolCallId, "write") as MutationPathApproval | undefined;
      const pathApproval = granted ? { ...granted } : undefined;
      let progress = pathApproval?.creationPlan !== undefined;
      const receiptTarget = pathApproval?.canonicalTarget ?? absolutePath;
      if (pathApproval) pathApproval.commitSelected = metadata => {
        pi.appendEntry(MUTATION_PROGRESS_ENTRY, { toolCallId, itemId: `${toolCallId}:0`, phase: "intent", operation: "write", target: receiptTarget,
          strategy: metadata.strategy, compatibilityReason: metadata.reason });
        progress = true;
        if (metadata.reason) _onUpdate?.({ content: [{ type: "text", text: `Commit selected: ${metadata.reason}` }], details: {} });
      };
      let details;
      try {
        details = await withFileMutationQueue(
          absolutePath,
          async () => {
            if (progress) pi.appendEntry(MUTATION_PROGRESS_ENTRY, { toolCallId, itemId: `${toolCallId}:0`, phase: "intent", operation: "write", target: receiptTarget, directories: pathApproval!.creationPlan!.directories });
            return guard.write(ctx.cwd, path, content, turnGeneration, signal, pathApproval);
          },
        );
      } catch (error) {
        const cause = error instanceof Error ? error.message : String(error);
        const failure = mutationFailureInfo(error) ?? (progress && (cause === "Operation aborted" || cause.startsWith("[MUTATION_BUDGET_EXCEEDED]") || cause.startsWith("[POLICY_BLOCKED]"))
          ? { category: signal?.aborted ? "CANCELLED" : "PRE_EXECUTION_FAILED", stateChanged: false, cause, status: signal?.aborted ? "cancelled" : "failed_no_change" } : undefined);
        if (failure && (progress || failure.stateChanged === true || failure.stateChanged === "unknown")) {
          const status = failure.stateChanged === "unknown" ? "state_unknown" : failure.stateChanged === true ? "partial" : (failure.status === "cancelled" || signal?.aborted) ? "cancelled" : "failed_no_change";
          const details = { ...failure, ok: false, operation: "write", target: receiptTarget, mutationReceiptVersion: 2, status, ...(failure.stateChanged !== false ? { requiresVerification: true } : {}) };
          if (progress) try { pi.appendEntry(MUTATION_PROGRESS_ENTRY, { ...details, toolCallId, itemId: `${toolCallId}:0`, phase: "result" }); } catch { /* Durable intent remains uncertain. */ }
          return { content: [{ type: "text" as const, text: `write: ${status}; ${path}. [${failure.category}] ${typeof failure.cause === "string" ? failure.cause.slice(0, 800) : ""}${failure.stateChanged !== false ? " Verify current state; do not automatically retry." : ""}${failure.commit ? `\n${commitSummary(failure.commit)}` : ""}` }], details, isError: true };
        }
        throw error;
      }
      if (progress) try {
        pi.appendEntry(MUTATION_PROGRESS_ENTRY, { ...details, target: receiptTarget, mutationReceiptVersion: 2, toolCallId, itemId: `${toolCallId}:0`, phase: "result", status: "succeeded" });
      } catch {
        return { content: [{ type: "text" as const, text: `write: state_unknown; ${path}. File changed but receipt recording failed. Verify current state; do not automatically retry.` }],
          details: { mutationReceiptVersion: 2, operation: "write", target: receiptTarget, status: "state_unknown", stateChanged: "unknown", requiresVerification: true }, isError: true };
      }
      const creation = details.creation;
      const summary = details.created
        ? `Added ${path} (${creation?.addedLines !== undefined ? `+${creation.addedLines} -0` : `${Buffer.byteLength(content, "utf8")} bytes`})${creation?.createdDirectories.length ? `\nCreated directories: ${creation.createdDirectories.length}` : ""}`
        : `Modified ${path} (${Buffer.byteLength(content, "utf8")} bytes)${details.commit ? `\n${commitSummary(details.commit)}` : ""}`;
      return {
        content: [{ type: "text" as const, text: summary }],
        details: { ...details, target: receiptTarget },
      };
    },
  });
}
