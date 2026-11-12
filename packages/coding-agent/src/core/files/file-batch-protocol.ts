import { Type } from "typebox";
import { Value } from "typebox/value";
import { PublicEditOperationParameters, PublicEditParameters, EditParameters, SnapshotEditParameters, NativeWriteParameters, SandboxWriteParameters, SandboxEditParameters, validatePublicSnapshotAnchors } from "./file-parameters.ts";
import { SHA256_PATTERN } from "./regex.ts";
import { FILE_MUTATION_TEXT_BYTES } from "./file-operation-limits.mjs";
import { validateNativeInvocation } from "./file-operation-input.ts";
export { assertIndependent } from "./file-path-conflicts.ts";

const ItemParameters = Type.Object({
  operation: Type.String({ enum: ["edit", "write", "copy", "delete", "move"] }),
  path: Type.String({ minLength: 1, maxLength: 4096 }),
  mode: Type.Optional(Type.String({ enum: ["create", "overwrite"], description: "Required for write: create refuses any existing target; overwrite requires a current read or clean own committed version." })),
  destination: Type.Optional(Type.String({ minLength: 1, maxLength: 4096 })),
  recursive: Type.Optional(Type.Boolean()),
  overwrite: Type.Optional(Type.Boolean()),
  content: Type.Optional(Type.String()),
  snapshot: Type.Optional(Type.String()),
  edits: Type.Optional(Type.Array(PublicEditOperationParameters, { minItems: 1, maxItems: 20 })),
}, { additionalProperties: false });
export const FileBatchParameters = Type.Object({
  operations: Type.Array(ItemParameters, { minItems: 1, description: "Fixed-order independent items. Put all edits of one file in one item. No chains, aliases, overlap or automatic reorder. Target count is unrestricted; mutation text and transport byte budgets still apply." }),
  dryRun: Type.Optional(Type.Boolean({ description: "Preflight only: no mutation, directory creation, evidence or approval token." })),
  purpose: Type.Optional(Type.String({ maxLength: 800 })),
}, { additionalProperties: false });

export type Operation = "edit" | "write" | "copy" | "delete" | "move";
export interface BatchInput { operations: Array<{ operation: Operation; path: string; mode?: "create" | "overwrite"; content?: string; destination?: string; snapshot?: string; edits?: any[]; recursive?: boolean; overwrite?: boolean }>; dryRun?: boolean; purpose?: string }

const WRITE_FIELDS = new Set(["operation", "path", "mode", "content"]);
const DELETE_FIELDS = new Set(["operation", "path", "recursive"]);
const MOVE_FIELDS = new Set(["operation", "path", "destination"]);
const COPY_FIELDS = new Set(["operation", "path", "destination", "overwrite"]);
type SnapshotInputKind = boolean | "sandbox" | "history";
export function validateBatchInput(value: unknown, allowWriteSnapshot: SnapshotInputKind = false): void { validateOrCopyBatchInput(value, allowWriteSnapshot, false); }
export function copyBatchInput(value: unknown, allowWriteSnapshot: SnapshotInputKind = false): BatchInput { return validateOrCopyBatchInput(value, allowWriteSnapshot, true)!; }
function validateOrCopyBatchInput(value: unknown, allowWriteSnapshot: SnapshotInputKind, copy: boolean): BatchInput | undefined {
  if (!Value.Check(FileBatchParameters, value)) throw new Error("[TOOL_ARGS_INVALID] Invalid file_batch object or fields.");
  const input = value as BatchInput;
  let bytes = 0;
  const operations: BatchInput["operations"] | undefined = copy ? [] : undefined;
  for (const item of input.operations) {
    const sandbox = allowWriteSnapshot === "sandbox" || allowWriteSnapshot === "history" && typeof item.snapshot === "string" && SHA256_PATTERN.test(item.snapshot);
    const keys = Object.keys(item);
    bytes += Buffer.byteLength(item.content ?? "", "utf8");
    if (item.edits) for (const edit of item.edits) {
      bytes += Buffer.byteLength(edit.oldText ?? "", "utf8") + Buffer.byteLength(edit.newText ?? "", "utf8");
      if (edit.newLines) for (const line of edit.newLines) bytes += Buffer.byteLength(line, "utf8");
    }
    if (bytes > FILE_MUTATION_TEXT_BYTES) throw new Error("[MUTATION_BUDGET_EXCEEDED] Batch input exceeds 1 MiB of mutation text.");
    if (item.operation === "write") {
      if (item.mode !== "create" && item.mode !== "overwrite") throw new Error("[TOOL_ARGS_INVALID] Batch write requires explicit create or overwrite mode.");
      if (item.snapshot !== undefined && (!allowWriteSnapshot || item.mode !== "overwrite")) throw new Error("[TOOL_ARGS_INVALID] Explicit write snapshot requires overwrite mode.");
      const write = { path: item.path, content: item.content, ...(item.snapshot !== undefined ? { snapshot: item.snapshot } : {}) };
      if (!Value.Check(sandbox ? SandboxWriteParameters : NativeWriteParameters, write)) throw new Error("[TOOL_ARGS_INVALID] Invalid write item fields.");
      for (const key of keys) if (!WRITE_FIELDS.has(key) && !(allowWriteSnapshot && key === "snapshot")) throw new Error("[TOOL_ARGS_INVALID] Invalid write item fields.");
    } else if (item.operation === "edit") {
      const clean: any = {};
      for (const key of keys) if (key !== "operation") clean[key] = (item as any)[key];
      if (!Value.Check(sandbox ? SandboxEditParameters : PublicEditParameters, clean)) throw new Error("[TOOL_ARGS_INVALID] Invalid edit item fields.");
      if (sandbox) { /* Exact replacements bind the worker's SHA-256 snapshot. */ }
      else if (item.snapshot) { validatePublicSnapshotAnchors(clean); if (!Value.Check(SnapshotEditParameters, clean)) throw new Error("[TOOL_ARGS_INVALID] Invalid snapshot item."); }
      else if (!Value.Check(EditParameters, clean)) throw new Error("[TOOL_ARGS_INVALID] Mixed or incomplete exact edit item.");
    } else {
      const fields = item.operation === "move" ? MOVE_FIELDS : item.operation === "copy" ? COPY_FIELDS : DELETE_FIELDS;
      for (const key of keys) if (!fields.has(key)) throw new Error("[TOOL_ARGS_INVALID] Invalid native item fields.");
      const native: Record<string, unknown> = { path: item.path };
      if (item.destination !== undefined) native.destination = item.destination;
      if (item.recursive !== undefined) native.recursive = item.recursive;
      if (item.overwrite !== undefined) native.overwrite = item.overwrite;
      validateNativeInvocation(item.operation, native);
    }
    if (operations) {
      const edits = item.edits?.map(edit => Object.freeze({ ...edit, ...(edit.newLines ? { newLines: Object.freeze([...edit.newLines]) } : {}) }));
      operations.push(Object.freeze({ ...item, ...(edits ? { edits: Object.freeze(edits) as any } : {}) }));
    }
  }
  return operations ? Object.freeze({ operations: Object.freeze(operations) as any, dryRun: input.dryRun, purpose: input.purpose }) : undefined;
}
