import { constants } from "node:fs";
import process from "node:process";
import { access, readFile } from "node:fs/promises";
import type { EditOperations, ExtensionAPI } from "@super-pi/coding-agent";
import {
  createEditToolDefinition,
  withFileMutationQueue,
} from "@super-pi/coding-agent";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import type { GuardedEdit, MutationEditAuthorization, MutationPathApproval } from "./core.ts";
import {
  executeSnapshotLineEdit,
  MAX_SNAPSHOT_LINE_EDITS,
  resetSnapshotLineStore,
  resolveSnapshotCanonicalTarget,
  type SnapshotLineEdit,
} from "./snapshot-line-edit.ts";
import { MUTATION_RECEIPT_VERSION, MutationWriteGuard, resolveToolPath, sha256 } from "./core.ts";
import { diagnoseFailedEdit } from "./edit-diagnostics.ts";
import { SHA256_PATTERN } from "./regex.ts";
import { restoreSnapshotReadText } from "./snapshot-line-protocol.ts";
import { primaryReadResultText, restoreMutationEvidenceFromBranch } from "./session-evidence.ts";
import { consumePermissionPathApproval } from "../resource-lifecycle-guard/permission-contract.ts";

const GuardedReplaceParameters = Type.Object({
  oldText: Type.String({ description: "Exact text to replace; repeated text needs range evidence or expectedLine." }),
  newText: Type.String({ description: "Replacement text." }),
  expectedLine: Type.Optional(Type.Integer({
    minimum: 1,
    description: "1-indexed line disambiguating repeated oldText.",
  })),
}, { additionalProperties: false });

const EditParameters = Type.Object({
  path: Type.String({ description: "Path to the existing file to edit (relative or absolute)" }),
  edits: Type.Array(GuardedReplaceParameters, {
    minItems: 1,
    maxItems: 20,
    description: "Non-overlapping replacements against one queued snapshot.",
  }),
  purpose: Type.Optional(Type.String({
    maxLength: 800,
    description: "Permission context: change, need, effects, and rollback.",
  })),
}, { additionalProperties: false });

type GuardedEditInput = Static<typeof EditParameters>;
const SNAPSHOT_LINE_REFERENCE_PATTERN = "^(?![\\s\\S]*[\\r\\n])[ \\t]*(?:[1-9]\\d*#[A-F0-9]{4}(?:\\|[^\\r\\n]*)?|>>> [1-9]\\d*#[A-F0-9]{4}\\|[^\\r\\n]*)[ \\t]*$";
const SNAPSHOT_LINE_REFERENCE_REGEX = new RegExp(SNAPSHOT_LINE_REFERENCE_PATTERN, "u");

const SnapshotLineEditParameters = Type.Object({
  kind: Type.Union([
    Type.Literal("replace"),
    Type.Literal("delete"),
    Type.Literal("insert_before"),
    Type.Literal("insert_after"),
  ], { description: "Line operation against the immutable snapshot." }),
  start: Type.String({ pattern: SNAPSHOT_LINE_REFERENCE_PATTERN, description: "Exact LINE#ID anchor, optionally copied with its known single-line read/mismatch display wrapper." }),
  end: Type.Optional(Type.String({ pattern: SNAPSHOT_LINE_REFERENCE_PATTERN, description: "Inclusive final LINE#ID anchor for replace/delete, optionally with its known single-line display wrapper." })),
  newLines: Type.Optional(Type.Array(Type.String(), {
    maxItems: 4000,
    description: "Replacement or insertion as physical lines; use an empty string element for a blank line.",
  })),
}, { additionalProperties: false });

const SnapshotEditParameters = Type.Object({
  path: Type.String({ description: "Exact existing file path from the snapshot read." }),
  snapshot: Type.String({
    pattern: "^snap_[A-Za-z0-9_-]{22}$",
    description: "Opaque snapshot ID returned by read for this exact file version.",
  }),
  edits: Type.Array(SnapshotLineEditParameters, {
    minItems: 1,
    maxItems: MAX_SNAPSHOT_LINE_EDITS,
    description: "Non-overlapping LINE#ID operations; every anchor must be copied from the immutable read and remain inside its editable range.",
  }),
  purpose: Type.Optional(Type.String({
    maxLength: 800,
    description: "Permission context: change, need, effects, and rollback.",
  })),
}, { additionalProperties: false });
type SnapshotEditInput = Static<typeof SnapshotEditParameters>;

const PublicEditOperationParameters = Type.Object({
  oldText: Type.Optional(Type.String({ description: "Exact-mode source text; do not combine with LINE#ID fields." })),
  newText: Type.Optional(Type.String({ description: "Exact-mode replacement text." })),
  expectedLine: Type.Optional(Type.Integer({ minimum: 1, description: "Exact-mode 1-indexed disambiguation line." })),
  kind: Type.Optional(Type.String({
    enum: ["replace", "delete", "insert_before", "insert_after"],
    description: "Snapshot LINE#ID operation kind.",
  })),
  start: Type.Optional(Type.String({ description: "Exact snapshot LINE#ID copied from read, for example 33#6D08; never pass source text or a line number alone." })),
  end: Type.Optional(Type.String({ description: "Inclusive LINE#ID end for replace/delete only; omit for insert_before/insert_after." })),
  newLines: Type.Optional(Type.Array(Type.String(), {
    maxItems: 4000,
    description: "Snapshot replacement or insertion as physical lines.",
  })),
}, { additionalProperties: false });

const PublicEditParameters = Type.Object({
  path: Type.String({ description: "Path to the existing file to edit (relative or absolute)." }),
  snapshot: Type.Optional(Type.String({
    pattern: "^snap_[A-Za-z0-9_-]{22}$",
    description: "Snapshot ID for LINE#ID mode; omit for exact oldText mode.",
  })),
  edits: Type.Array(PublicEditOperationParameters, {
    minItems: 1,
    maxItems: MAX_SNAPSHOT_LINE_EDITS,
    description: "Use either snapshot LINE#ID fields or exact oldText/newText fields in one call; never mix modes.",
  }),
  purpose: Type.Optional(Type.String({
    maxLength: 800,
    description: "Permission context: change, need, effects, and rollback.",
  })),
}, {
  additionalProperties: false,
  description: "Prefer snapshot LINE#ID edits after read; use exact oldText replacements when no snapshot is available.",
});
type PublicEditInput = Static<typeof PublicEditParameters>;

function hasSnapshotOperationFields(edit: Static<typeof PublicEditOperationParameters>): boolean {
  return edit.kind !== undefined || edit.start !== undefined || edit.end !== undefined || edit.newLines !== undefined;
}

function validatePublicSnapshotAnchors(input: PublicEditInput): void {
  for (let index = 0; index < input.edits.length; index++) {
    const edit = input.edits[index];
    if (typeof edit.start === "string" && !SNAPSHOT_LINE_REFERENCE_REGEX.test(edit.start)) {
      throw new Error(`[SNAPSHOT_EDIT_INVALID] edits[${index}].start must be an exact LINE#ID copied from read, for example "33#6D08"; source text and line numbers alone are invalid.`);
    }
    if (typeof edit.end === "string" && !SNAPSHOT_LINE_REFERENCE_REGEX.test(edit.end)) {
      throw new Error(`[SNAPSHOT_EDIT_INVALID] edits[${index}].end must be an exact LINE#ID copied from read, for example "33#6D08"; source text and line numbers alone are invalid.`);
    }
  }
}
const WriteParameters = Type.Object({
  path: Type.String({ description: "File path" }),
  content: Type.String({ description: "File content" }),
  purpose: Type.Optional(Type.String({
    maxLength: 800,
    description: "Permission context: change, need, effects, and rollback.",
  })),
}, { additionalProperties: false });

type GuardedWriteInput = Static<typeof WriteParameters>;

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
}

const EDIT_INDEX_PATTERN = /edits\[(\d+)\]/u;

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
    return `[${category}] No qualifying prior read covers this edit.\nRetry: read the exact target range, then retry.`;
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
        "With snapshot, copy its ID and LINE#ID anchors: insert_before/insert_after={kind,start,newLines} and must omit end; replace={kind,start,end?,newLines}; delete={kind,start,end?}. Each newLines item is one physical line.",
        "Without snapshot, exact oldText/newText still requires the same completed read evidence; keep oldText unique. Include purpose for protected targets.",
      ],
      parameters: PublicEditParameters,
      executionMode: "sequential",
      async execute(toolCallId, input: PublicEditInput, signal, _onUpdate, ctx) {
        if (typeof input.snapshot !== "string") {
          for (let index = 0; index < input.edits.length; index++) {
            if (hasSnapshotOperationFields(input.edits[index])) {
              throw new Error(`[SNAPSHOT_REQUIRED] edits[${index}] uses snapshot fields. Call read in a completed tool turn, then pass its Snapshot edit ID and LINE#ID anchors.`);
            }
          }
          if (!Value.Check(EditParameters, input)) {
            throw new Error("Invalid edit input: exact mode requires only oldText/newText operations.");
          }
          return ordinaryEdit.execute(toolCallId, input as GuardedEditInput, signal, _onUpdate, ctx);
        }
        validatePublicSnapshotAnchors(input);
        if (!Value.Check(SnapshotEditParameters, input)) {
          throw new Error("Invalid edit input: snapshot mode requires only kind/start/end/newLines operations.");
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
              text: `Successfully applied ${details.replacements} snapshot LINE#ID operation(s) to ${snapshotInput.path}.`,
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
      "Overwrite requires a prior complete read; partial, same-turn, or stale evidence fails. Include purpose for protected targets.",
    ],
    parameters: WriteParameters,
    executionMode: "sequential",
    async execute(toolCallId, input: GuardedWriteInput, signal, _onUpdate, ctx) {
      const { path, content } = input;
      const absolutePath = resolveToolPath(ctx.cwd, path);
      const pathApproval = consumePermissionPathApproval(input, toolCallId, "write") as MutationPathApproval | undefined;
      const details = await withFileMutationQueue(
        absolutePath,
        () => guard.write(ctx.cwd, path, content, turnGeneration, signal, pathApproval),
      );
      return {
        content: [{ type: "text" as const, text: `Successfully wrote ${content.length} bytes to ${path}` }],
        details,
      };
    },
  });
}
