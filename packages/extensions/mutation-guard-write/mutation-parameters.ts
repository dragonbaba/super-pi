import { Type, type Static } from "typebox";
import { MAX_SNAPSHOT_LINE_EDITS, validateInsertionFields, type SnapshotLineEdit } from "./snapshot-line-edit.ts";
import { SNAPSHOT_LINE_REFERENCE_PATTERN, SNAPSHOT_LINE_REFERENCE_REGEX, SNAPSHOT_ID_PATTERN } from "./regex.ts";
export const GuardedReplaceParameters = Type.Object({
  oldText: Type.String({ description: "Exact text to replace; repeated text needs range evidence or expectedLine." }),
  newText: Type.String({ description: "Replacement text." }),
  expectedLine: Type.Optional(Type.Integer({
    minimum: 1,
    description: "1-indexed line disambiguating repeated oldText.",
  })),
}, { additionalProperties: false });

export const EditParameters = Type.Object({
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

export type GuardedEditInput = Static<typeof EditParameters>;
export const SnapshotLineEditParameters = Type.Object({
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

export const SnapshotEditParameters = Type.Object({
  path: Type.String({ description: "Exact existing file path from the snapshot read." }),
  snapshot: Type.String({
    pattern: SNAPSHOT_ID_PATTERN,
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
export type SnapshotEditInput = Static<typeof SnapshotEditParameters>;

export const PublicEditOperationParameters = Type.Object({
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
    description: "Snapshot replacement or insertion as physical lines. Insertion keeps start; include only intended inserted lines, not copied locating context.",
  })),
}, { additionalProperties: false });

export const PublicEditParameters = Type.Object({
  path: Type.String({ description: "Path to the existing file to edit (relative or absolute)." }),
  snapshot: Type.Optional(Type.String({
    pattern: SNAPSHOT_ID_PATTERN,
    description: "Required at the request top level for LINE#ID mode. Copy the snapshot ID paired with these anchors from the completed read; omit for exact oldText mode.",
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
export type PublicEditInput = Static<typeof PublicEditParameters>;

export function hasSnapshotOperationFields(edit: Static<typeof PublicEditOperationParameters>): boolean {
  return edit.kind !== undefined || edit.start !== undefined || edit.end !== undefined || edit.newLines !== undefined;
}

export function validatePublicSnapshotAnchors(input: PublicEditInput): void {
  let problems: string[] | undefined;
  for (let index = 0; index < input.edits.length; index++) {
    const edit = input.edits[index];
    if (edit.oldText !== undefined || edit.newText !== undefined || edit.expectedLine !== undefined) {
      (problems ??= []).push(`[SNAPSHOT_EDIT_INVALID] edits[${index}] mixes exact replacement fields with top-level snapshot. No change.\nRetry: use only kind/start/end/newLines for this snapshot.`);
    } else if (edit.kind === undefined || edit.start === undefined || (edit.kind !== "delete" && edit.newLines === undefined)) {
      const field = edit.kind === undefined ? "kind" : edit.start === undefined ? "start" : "newLines";
      (problems ??= []).push(`[SNAPSHOT_EDIT_INVALID] Missing required field "edits[${index}].${field}" in snapshot mode. No change.\nRetry: complete this operation using the paired snapshot and anchors.`);
    }
    if ((problems?.length ?? 0) >= 3) break;
    if (typeof edit.start === "string" && !SNAPSHOT_LINE_REFERENCE_REGEX.test(edit.start)) {
      (problems ??= []).push(`[SNAPSHOT_EDIT_INVALID] edits[${index}].start must be an exact LINE#ID copied from read, for example "33#6D08"; source text and line numbers alone are invalid.`);
    }
    if ((problems?.length ?? 0) >= 3) break;
    if (edit.kind === "insert_before" || edit.kind === "insert_after") {
      try { validateInsertionFields(edit as SnapshotLineEdit, index); }
      catch (error) { (problems ??= []).push(error instanceof Error ? error.message : String(error)); }
    } else if (typeof edit.end === "string" && !SNAPSHOT_LINE_REFERENCE_REGEX.test(edit.end)) {
      (problems ??= []).push(`[SNAPSHOT_EDIT_INVALID] edits[${index}].end must be an exact LINE#ID copied from read, for example "33#6D08"; source text and line numbers alone are invalid.`);
    }
    if ((problems?.length ?? 0) >= 3) break;
  }
  if (problems) throw new Error(problems.join("\n"));
}

export const WriteParameters = Type.Object({
  path: Type.String({ description: "File path" }),
  content: Type.String({ description: "File content" }),
  purpose: Type.Optional(Type.String({
    maxLength: 800,
    description: "Permission context: change, need, effects, and rollback.",
  })),
}, { additionalProperties: false });

export type GuardedWriteInput = Static<typeof WriteParameters>;

