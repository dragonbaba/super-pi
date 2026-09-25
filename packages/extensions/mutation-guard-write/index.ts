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
import { restoreSnapshotReadText } from "./snapshot-line-protocol.ts";
import { primaryReadResultText, restoreMutationEvidenceFromBranch, recordBatchMutationEvidence } from "./session-evidence.ts";
import { consumePermissionPathApproval } from "../resource-lifecycle-guard/permission-contract.ts";
import { registerNativeTools, MUTATION_PROGRESS_ENTRY, renderFileMutationResult } from "./native-tools.ts";
import { registerFileBatch } from "./file-batch.ts";

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
  const text = restoreSnapshotReadText(displayedText);
  const startLine = typeof input.offset === "number" && Number.isFinite(input.offset)
    ? Math.max(1, Math.floor(input.offset))
    : 1;
  const endLine = typeof input.limit === "number" && Number.isFinite(input.limit)
    ? startLine + Math.max(0, Math.floor(input.limit)) - 1
    : Number.MAX_SAFE_INTEGER;
  return {
    path: input.path,
    text,
    startLine,
    endLine,
    complete: input.offset === undefined && input.limit === undefined,
  };
}

class GuardedEditExecution {
  readonly operations: EditOperations;
  readonly #guard: MutationWriteGuard;
  readonly #cwd: string;
  readonly #input: GuardedEditInput;
  readonly #originalEdits: GuardedEdit[];
  readonly #turnGeneration: number;
  readonly #pathApproval?: MutationPathApproval;
  #previousContent?: Buffer;
  authorization?: MutationEditAuthorization;
  writtenSha256?: string;
  previousSha256?: string;
  writeSucceeded = false;

  constructor(
    guard: MutationWriteGuard,
    cwd: string,
    input: GuardedEditInput,
    turnGeneration: number,
    pathApproval?: MutationPathApproval,
  ) {
    this.#guard = guard;
    this.#cwd = cwd;
    this.#input = input;
    this.#originalEdits = cloneGuardedEdits(input.edits);
    this.#turnGeneration = turnGeneration;
    this.#pathApproval = pathApproval;
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
    this.previousSha256 = await this.#guard.writeEditContent(
      this.#cwd,
      this.#input.path,
      this.#previousContent,
      content,
      this.authorization?.reservationId,
      this.#pathApproval,
    );
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
      await recordBatchMutationEvidence(guard, ctx.cwd, event.input, event.details, event.toolCallId, turnGeneration);
      return;
    }
    const read = observedTextRead(event);
    if (read) {
      try {
        await guard.recordRead(
          ctx.cwd,
          read.path,
          read.text,
          read.startLine,
          read.endLine,
          event.toolCallId,
          turnGeneration,
          read.complete,
        );
      } catch {
        // Guarded mutations fail closed if read evidence cannot be canonicalized.
      }
      return;
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
      const pathApproval = consumePermissionPathApproval(input, toolCallId, "edit") as MutationPathApproval | undefined;
      const nativeInput: GuardedEditInput = {
        path: input.path,
        edits: cloneGuardedEdits(input.edits),
      };
      const execution = new GuardedEditExecution(guard, ctx.cwd, nativeInput, turnGeneration, pathApproval);
      const guardedEdit = createEditToolDefinition(ctx.cwd, { operations: execution.operations });
      try {
        const result = await guardedEdit.execute(toolCallId, nativeInput, signal, onUpdate, ctx);
        if (!result.details) throw new Error("Native edit completed without diff/patch details.");
        return {
          ...result,
          details: {
            ...result.details,
            ok: true,
            mutationReceiptVersion: MUTATION_RECEIPT_VERSION,
            category: "success",
            operation: "edit",
            target: execution.authorization?.target ?? input.path,
            stateChanged: true,
            previousSha256: execution.previousSha256,
            sha256: execution.writtenSha256,
            replacements: execution.authorization?.replacements ?? input.edits.length,
            omittedNoOpEdits: execution.authorization?.omittedNoOpEdits ?? 0,
            estimatedChangedBytes: execution.authorization?.estimatedChangedBytes,
          },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const failure = mutationFailureInfo(error);
        if (!execution.writeSucceeded && failure?.stateChanged !== true) {
          guard.releaseMutation(execution.authorization?.reservationId);
        }
        if (execution.writeSucceeded) {
          await guard.partialEditFailure(ctx.cwd, input.path, message);
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
              beforeCommit: async () => {
                await guard.assertEditPathAllowed(ctx.cwd, snapshotInput.path, pathApproval);
              },
            },
          ));
          return {
            content: [{
              type: "text" as const,
              text: `Successfully applied ${details.replacements} snapshot LINE#ID operation(s) to ${snapshotInput.path}.\nFor a dependent edit, read again and use its snapshot and LINE#ID anchors; pre-mutation snapshots for this file are unusable.`,
            }],
            details: {
              ...details,
              ok: true,
              mutationReceiptVersion: MUTATION_RECEIPT_VERSION,
              category: "success",
              operation: "edit",
              target: snapshotInput.path,
              stateChanged: true,
            },
          };
        } catch (error) {
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
      const pathApproval = consumePermissionPathApproval(input, toolCallId, "write") as MutationPathApproval | undefined;
      const progress = pathApproval?.creationPlan !== undefined;
      const receiptTarget = pathApproval?.creationPlan?.canonicalTarget ?? absolutePath;
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
        if (failure && (progress || failure.stateChanged === true)) {
          const status = failure.stateChanged === true ? "partial" : (failure.status === "cancelled" || signal?.aborted) ? "cancelled" : "failed_no_change";
          const details = { ...failure, operation: "write", target: receiptTarget, mutationReceiptVersion: 2, status, ...(failure.stateChanged === true ? { requiresVerification: true } : {}) };
          if (progress) try { pi.appendEntry(MUTATION_PROGRESS_ENTRY, { ...details, toolCallId, itemId: `${toolCallId}:0`, phase: "result" }); } catch { /* Durable intent remains uncertain. */ }
          return { content: [{ type: "text" as const, text: `write: ${status}; ${path}. [${failure.category}] ${typeof failure.cause === "string" ? failure.cause.slice(0, 800) : ""}${failure.stateChanged === true ? " Verify the file and recorded directories; do not automatically retry." : ""}` }], details, isError: true };
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
        : `Modified ${path} (${Buffer.byteLength(content, "utf8")} bytes)`;
      return {
        content: [{ type: "text" as const, text: summary }],
        details,
      };
    },
  });
}
