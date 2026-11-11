import { Type } from "typebox";
import { Value } from "typebox/value";
import { relative, isAbsolute, sep } from "node:path";
import { PublicEditOperationParameters, PublicEditParameters, EditParameters, SnapshotEditParameters, NativeWriteParameters, validatePublicSnapshotAnchors } from "./file-parameters.ts";
import type { PreparedFileItem } from "./file-service.ts";

export const MAX_BATCH_ITEMS = 16;

const ItemParameters = Type.Object({
  operation: Type.String({ enum: ["edit", "write", "delete", "move"] }),
  path: Type.String({ minLength: 1, maxLength: 4096 }),
  mode: Type.Optional(Type.String({ enum: ["create", "overwrite"], description: "Required for write: create refuses any existing target; overwrite requires a current read or clean own committed version." })),
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

export type Operation = "edit" | "write" | "delete" | "move";
export interface BatchInput { operations: Array<{ operation: Operation; path: string; mode?: "create" | "overwrite"; content?: string; destination?: string; snapshot?: string; edits?: any[] }>; dryRun?: boolean; purpose?: string }

type Item = Pick<PreparedFileItem, "target" | "paths" | "creation" | "identity"> & { itemId: string };

function pathKey(path: string): string { return path.normalize("NFC").toLowerCase(); }
function pathConflicts(left: string, right: string, prospective: boolean): boolean {
  if (prospective) { left = pathKey(left); right = pathKey(right); }
  const path = relative(left, right);
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}
export function assertIndependent(items: readonly Item[]): void {
  for (let i = 0; i < items.length; i++) for (let j = 0; j < i; j++) {
    const a = items[i], b = items[j];
    if (process.platform !== "win32" && a.creation && b.creation) {
      for (const left of a.creation.directories) for (const right of b.creation.directories) {
        if (left !== right && pathKey(left) === pathKey(right)) throw new Error(`[BATCH_CONFLICT] ${a.itemId} and ${b.itemId} use ambiguous spellings for a missing shared parent; use identical spelling.`);
      }
    }
    if (a.identity && b.identity && a.identity.device === b.identity.device && a.identity.inode === b.identity.inode) throw new Error(`[BATCH_CONFLICT] ${a.itemId} and ${b.itemId} share a file identity.`);
    for (const left of a.paths) for (const right of b.paths) {
      const prospective = !(a.identity && left === a.target && b.identity && right === b.target);
      if (pathConflicts(left, right, prospective) || pathConflicts(right, left, prospective)) throw new Error(`[BATCH_CONFLICT] ${a.itemId} and ${b.itemId} overlap; split dependent changes into verified stages.`);
    }
  }
}
export function copyBatchInput(value: unknown, allowWriteSnapshot = false): BatchInput {
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
      if (item.snapshot !== undefined && (!allowWriteSnapshot || item.mode !== "overwrite")) throw new Error("[TOOL_ARGS_INVALID] Explicit write snapshot requires native overwrite mode.");
      const write = { path: item.path, content: item.content, ...(item.snapshot !== undefined ? { snapshot: item.snapshot } : {}) };
      if (!Value.Check(NativeWriteParameters, write) || Object.keys(item).some(key => !["operation", "path", "mode", "content"].includes(key) && !(allowWriteSnapshot && key === "snapshot"))) throw new Error("[TOOL_ARGS_INVALID] Invalid write item fields.");
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
