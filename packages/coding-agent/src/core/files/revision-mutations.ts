import { dirname } from "node:path";
import { TextDecoder } from "node:util";
import { detectLineEnding, normalizeToLF } from "../tools/edit-diff.ts";
import { capturePathIdentity } from "./native-file-core.ts";
import { modifiedPreview, PreviewBudget, MAX_PREVIEW_SOURCE_BYTES, type ChangePreview } from "./change-preview.ts";
import {
  readSnapshotSource, resolveSnapshotCanonicalTarget,
  type FileRevisions, type PreparedSnapshotMutation,
} from "./snapshot-line-edit.ts";

const MAX_EXACT_SOURCE_BYTES = 2 * 1024 * 1024;
const MAX_EXACT_EDIT_BYTES = 256 * 1024;
export const MAX_WRITE_BYTES = 1024 * 1024;
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

export interface ExactRevisionEdit { oldText: string; newText: string; expectedLine?: number }

function wellFormed(text: string): boolean {
  for (let index = 0; index < text.length; index++) {
    const unit = text.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = text.charCodeAt(++index);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) return false;
  }
  return true;
}

export function validateWriteContent(content: string): void {
  if (!wellFormed(content)) throw new Error("[WRITE_ENCODING] Content contains an unpaired UTF-16 surrogate.");
  if (Buffer.byteLength(content) > MAX_WRITE_BYTES) throw new Error("[WRITE_SCOPE] One write may supply at most 1 MiB of UTF-8 content.");
}

function compareEdits(left: { start: number; end: number }, right: { start: number; end: number }): number {
  return left.start - right.start || left.end - right.end;
}

/** Single invocation; match the original bytes, preserve untouched encoding/BOM/newlines. */
function exactByteEdits(bytes: Buffer, edits: readonly ExactRevisionEdit[]): PreparedSnapshotMutation["byteEdits"] {
  if (bytes.length > MAX_EXACT_SOURCE_BYTES) throw new Error("[EDIT_SCOPE] Exact mode supports sources up to 2 MiB; use a bounded snapshot line edit for larger files.");
  if (!edits.length || edits.length > 20) throw new Error("[EDIT_SCOPE] Provide 1-20 independent exact replacements.");
  const text = decoder.decode(bytes);
  if (text.includes("\0")) throw new Error("[EDIT_ENCODING] Exact mode requires UTF-8 text without NUL bytes.");
  const ending = detectLineEnding(text);
  const prepared: PreparedSnapshotMutation["byteEdits"] = [];
  let changedBytes = 0, inputBytes = 0;
  for (let index = 0; index < edits.length; index++) {
    const edit = edits[index];
    if (!edit.oldText) throw new Error(`[EDIT_TARGET] edits[${index}].oldText must not be empty.`);
    if (!wellFormed(edit.oldText) || !wellFormed(edit.newText)) {
      throw new Error(`[EDIT_ENCODING] edits[${index}] contains an unpaired UTF-16 surrogate; provide complete Unicode characters.`);
    }
    inputBytes += Buffer.byteLength(edit.oldText) + Buffer.byteLength(edit.newText);
    if (inputBytes > MAX_EXACT_EDIT_BYTES) throw new Error("[EDIT_SCOPE] Exact replacement input exceeds 256 KiB.");
    if (edit.expectedLine !== undefined && (!Number.isSafeInteger(edit.expectedLine) || edit.expectedLine < 1)) {
      throw new Error(`[EDIT_TARGET] edits[${index}].expectedLine must be a positive integer.`);
    }
    // Exact spelling first. Only normalize line terminators when the submitted spelling has no match.
    let oldText = edit.oldText;
    if (!text.includes(oldText)) oldText = normalizeToLF(oldText).replaceAll("\n", ending);
    const replacementText = normalizeToLF(edit.newText).replaceAll("\n", ending);
    let selected = -1, matches = 0, offset = 0, line = 1, scan = 0;
    for (;;) {
      const found = text.indexOf(oldText, offset);
      if (found < 0) break;
      while (scan < found) if (text.charCodeAt(scan++) === 10) line++;
      if (edit.expectedLine === undefined || edit.expectedLine === line) { matches++; selected = found; }
      if (matches > 1) break;
      offset = found + 1;
    }
    if (matches !== 1) throw new Error(`[EDIT_TARGET] edits[${index}].oldText ${matches ? "is ambiguous" : "was not found at the requested location"}. Read the target range and use a unique exact span or LINE#ID anchors.`);
    if (oldText === replacementText) continue;
    const start = Buffer.byteLength(text.slice(0, selected)), end = start + Buffer.byteLength(oldText);
    changedBytes += end - start + Buffer.byteLength(replacementText);
    if (changedBytes > MAX_EXACT_EDIT_BYTES) throw new Error("[EDIT_SCOPE] One exact edit call may change at most 256 KiB of source and replacement bytes.");
    const replacement = Buffer.from(replacementText);
    prepared.push({ index, start, end, replacement });
  }
  if (!prepared.length) throw new Error("[EDIT_NO_OP] No requested replacement changes the file.");
  prepared.sort(compareEdits);
  for (let index = 1; index < prepared.length; index++) if (prepared[index].start < prepared[index - 1].end) {
    throw new Error("[EDIT_OVERLAP] Exact replacements overlap in the original revision; combine them into one change.");
  }
  return prepared;
}

/** A revision is a file-version precondition, independent of model turns and display projection. */
export async function prepareRevisionMutation(
  revisions: FileRevisions, sessionId: string, cwd: string, path: string, snapshotId: string,
  change: { edits: readonly ExactRevisionEdit[] } | { content: string }, signal?: AbortSignal, previewBudget = new PreviewBudget(),
): Promise<PreparedSnapshotMutation> {
  signal?.throwIfAborted();
  const canonical = await resolveSnapshotCanonicalTarget(sessionId, cwd, path, snapshotId, revisions);
  const receipt = revisions.get(snapshotId)!;
  const before = await readSnapshotSource(receipt, revisions);
  let byteEdits: PreparedSnapshotMutation["byteEdits"];
  if ("content" in change) {
    validateWriteContent(change.content);
    byteEdits = [{ index: 0, start: 0, end: before.length, replacement: Buffer.from(change.content) }];
  } else byteEdits = exactByteEdits(before, change.edits);
  const chunks: Buffer[] = [];
  let cursor = 0, changedBytes = 0;
  for (const edit of byteEdits) {
    chunks.push(before.subarray(cursor, edit.start), edit.replacement); cursor = edit.end;
    changedBytes += edit.end - edit.start + edit.replacement.length;
  }
  chunks.push(before.subarray(cursor));
  const after = Buffer.concat(chunks);
  if (after.equals(before)) throw new Error("[EDIT_NO_OP] Replacement matches the existing revision.");
  if ("edits" in change && after.length > MAX_EXACT_SOURCE_BYTES) throw new Error("[EDIT_SCOPE] Exact edit result exceeds 2 MiB.");
  const target = await capturePathIdentity(canonical), parent = await capturePathIdentity(dirname(canonical));
  if (target.device !== String(receipt.identity.dev) || target.inode !== String(receipt.identity.ino)
    || target.size !== String(receipt.identity.size) || target.mtime !== String(receipt.identity.mtimeNs)
    || target.ctime !== String(receipt.identity.ctimeNs)) throw new Error("[SNAPSHOT_EDIT_STALE] Revision changed during preparation.");
  signal?.throwIfAborted(); revisions.assertCurrent(receipt);
  // Bounded completed-operation preview. Never retain a second full before/after string in the plan.
  const preview: ChangePreview = before.length + after.length <= MAX_PREVIEW_SOURCE_BYTES
    ? modifiedPreview(decoder.decode(before), decoder.decode(after), previewBudget, true)
    : { kind: "Modified", bytes: after.length, omitted: "Candidate exceeds preview working set; inspect a bounded range with read." };
  return { revisions, target, parent, sessionId, snapshotId, receipt, byteEdits, changedBytes,
    replacements: byteEdits.length, deduplicatedEdits: 0, diff: preview.diff ?? "", patch: preview.diff ?? "", preview };
}
