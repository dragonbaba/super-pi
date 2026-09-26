import { stripVTControlCharacters } from "node:util";
import { open } from "node:fs/promises";
import { generateUnifiedPatch } from "@super-pi/coding-agent";
import { addedContentSummary } from "./file-creation.ts";
import { Text } from "@super-pi/tui";
import { PREVIEW_CONTROL_PATTERN, DISPLAY_METADATA_CONTROL_PATTERN } from "./regex.ts";

export const MAX_PREVIEW_FILE_LINES = 80;
export const MAX_PREVIEW_LINES = 400;
export const MAX_PREVIEW_BYTES = 64 * 1024;
export const MAX_PREVIEW_SOURCE_BYTES = 256 * 1024;

export interface ChangePreview {
  kind: "Added" | "Modified" | "Deleted" | "Moved";
  bytes?: number;
  addedLines?: number;
  diff?: string;
  omitted?: string;
  risk?: string;
  plannedDirectories?: readonly string[];
}

/** Enforce the preview bound on the open object, including growth after preflight stat. */
export async function readPreviewSource(path: string, limit: number, expected: { device: string; inode: string }): Promise<Buffer> {
  if (!Number.isSafeInteger(limit) || limit < 0 || limit > MAX_PREVIEW_SOURCE_BYTES) throw new Error("Invalid preview read bound.");
  const handle = await open(path, "r");
  try {
    const info = await handle.stat({ bigint: true });
    if (!info.isFile() || info.size > BigInt(limit)) throw new Error("[STALE_STATE] Source exceeds the preview working-set limit.");
    if (String(info.dev) !== expected.device || String(info.ino) !== expected.inode) throw new Error("[STALE_STATE] Opened preview object differs from preparation.");
    const size = Number(info.size);
    const bytes = Buffer.allocUnsafe(size + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const next = await handle.read(bytes, offset, bytes.length - offset, null);
      if (!next.bytesRead) break;
      offset += next.bytesRead;
    }
    if (offset !== size || (await handle.stat({ bigint: true })).size !== info.size) throw new Error("[STALE_STATE] Source changed during bounded preview read.");
    return bytes.subarray(0, offset);
  } finally { await handle.close(); }
}

/** Low-frequency preparation/finalization only; never called from a render or progress update. */
export class PreviewBudget {
  lines = MAX_PREVIEW_LINES;
  bytes = MAX_PREVIEW_BYTES;
  omitted = false;

  take(source: string, maxLines = MAX_PREVIEW_FILE_LINES): { text: string; omitted: boolean } {
    const lineLimit = Math.min(maxLines, this.lines);
    let end = 0, bytes = 0, lines = source.length && lineLimit > 0 ? 1 : 0;
    while (end < source.length && lines > 0) {
      const code = source.codePointAt(end)!;
      const width = code > 0xffff ? 2 : 1;
      const size = code <= 0x7f ? 1 : code <= 0x7ff ? 2 : code <= 0xffff ? 3 : 4;
      if (bytes + size > this.bytes) break;
      if (code === 10 && end + 1 < source.length) {
        if (lines === lineLimit) break;
        lines++;
      }
      bytes += size; end += width;
    }
    this.bytes -= bytes;
    this.lines -= end ? lines : 0;
    // Only the bounded prefix is inspected/sanitized, including giant single lines.
    const omitted = end < source.length;
    this.omitted ||= omitted;
    return { text: stripVTControlCharacters(source.slice(0, end)).replace(PREVIEW_CONTROL_PATTERN, ""), omitted };
  }

  diff(preview: ChangePreview, source: string): ChangePreview {
    const bounded = this.take(source);
    preview.diff = bounded.text || undefined;
    if (bounded.omitted) preview.omitted = "Display budget reached; inspect the file with an authorized read for more context.";
    return preview;
  }
}

export function addedPreview(content: string, budget: PreviewBudget): ChangePreview {
  const summary = addedContentSummary(content);
  const preview: ChangePreview = { kind: "Added", ...summary };
  if (summary.addedLines === undefined) return preview;
  if (summary.bytes > MAX_PREVIEW_SOURCE_BYTES) {
    preview.omitted = "Content exceeds preview working set; byte/line summary only.";
    return preview;
  }
  return budget.diff(preview, content.length ? generateUnifiedPatch("created", "", content, 0) : "");
}

export function modifiedPreview(before: string, after: string, budget: PreviewBudget, visible: boolean): ChangePreview {
  const preview: ChangePreview = { kind: "Modified" };
  if (!visible) { preview.omitted = "Source is outside the completed read range; no additional content was disclosed."; return preview; }
  if (Buffer.byteLength(before) + Buffer.byteLength(after) > MAX_PREVIEW_SOURCE_BYTES) {
    preview.omitted = "Candidate exceeds preview working set; inspect a bounded range with read.";
    return preview;
  }
  if (addedContentSummary(before).addedLines === undefined || addedContentSummary(after).addedLines === undefined) {
    preview.bytes = Buffer.byteLength(after);
    preview.omitted = "Non-text content; byte summary only.";
    return preview;
  }
  return budget.diff(preview, generateUnifiedPatch("prepared", before, after, 0));
}

/** Uses only validated edited spans, with no surrounding source context. */
export function snapshotPreview(current: Buffer, edits: readonly { start: number; end: number; replacement: Buffer }[], budget: PreviewBudget): ChangePreview {
  const preview: ChangePreview = { kind: "Modified" };
  let remainingLines = MAX_PREVIEW_FILE_LINES;
  let text = "";
  for (const edit of edits) {
    if (remainingLines <= 0 || budget.bytes <= 0 || budget.lines <= 0) { preview.omitted = "Display budget reached."; break; }
    if (edit.end - edit.start + edit.replacement.byteLength > MAX_PREVIEW_SOURCE_BYTES) { preview.omitted = "Edited span exceeds preview working set."; continue; }
    const patch = generateUnifiedPatch("edited span", current.toString("utf8", edit.start, edit.end), edit.replacement.toString("utf8"), 0);
    const previousLines = budget.lines;
    const part = budget.take(text ? `\n${patch}` : patch, remainingLines);
    text += part.text;
    remainingLines -= previousLines - budget.lines;
    if (part.omitted) { preview.omitted = "Display budget reached."; break; }
  }
  preview.diff = text || undefined;
  return preview;
}

/** Component-owned primitive cache; no result tree, callback or per-update wrapper. */
export class BatchResultText extends Text {
  private source: string | undefined;
  private textChanges = 0;

  setBatchText(text: string): void {
    if (text === this.source) return;
    this.source = text;
    this.textChanges++;
    this.setText(text);
  }

  releasePreview(): void { this.source = undefined; this.setText(""); }

  /** Explicit test/diagnostic access, never invoked from render. */
  getPreviewRenderCounts(): { textChanges: number; retainedCharacters: number } {
    return { textChanges: this.textChanges, retainedCharacters: this.source?.length ?? 0 };
  }
}

export function releaseBatchRenderState(state: any): void {
  state.batchComponent?.releasePreview();
  state.batchComponent = undefined;
}

interface DisplayItem {
  itemId: string; operation: string; target: string; destination?: string; status: string;
  reason?: string; preview?: ChangePreview; receipt?: any;
}

/** Metadata is single-line data; source diff text keeps its own multiline layout. */
function escapeDisplayControl(character: string): string {
  return `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`;
}

export function displayMetadata(value: unknown): string {
  return JSON.stringify(String(value).slice(0, 4096)).slice(1, -1).replace(DISPLAY_METADATA_CONTROL_PATTERN, escapeDisplayControl);
}

function displayCreationCount(value: unknown): string {
  return Number.isSafeInteger(value) && (value as number) >= 0 ? String(value) : "[invalid count]";
}

function directorySummary(budget: PreviewBudget, directories: unknown, planned: boolean): string {
  if (!Array.isArray(directories)) return "";
  let text = "";
  if (directories.length > 32) budget.omitted = true;
  for (let index = 0; index < Math.min(directories.length, 32); index++) {
    if (budget.bytes <= 0 || budget.lines <= 0) { budget.omitted = true; break; }
    const directory = directories[index];
    text += budget.take(planned ? `\nplanned parent: ${displayMetadata(directory)}`
      : `\nparent: ${displayMetadata(directory?.path)} [${displayMetadata(directory?.status)}]`, MAX_PREVIEW_LINES).text;
  }
  return text;
}

export function verificationSummary(observation: unknown): string {
  const budget = new PreviewBudget();
  budget.bytes -= 128; budget.lines -= 2;
  const part = budget.take(JSON.stringify(observation, null, 2), MAX_PREVIEW_LINES);
  return part.text + (part.omitted ? "\n[verification display truncated; complete observation is retained in the Session entry]" : "");
}

/** One bounded presentation at completion. The renderer only selects a string. */
export function batchExpandedSummary(summary: string, items: readonly DisplayItem[], plannedDirectories?: readonly string[]): string {
  const budget = new PreviewBudget();
  budget.bytes -= 128; budget.lines -= 2;
  let text = budget.take(summary, MAX_PREVIEW_LINES).text;
  text += directorySummary(budget, plannedDirectories, true);
  for (const item of items) {
    if (budget.bytes <= 0 || budget.lines <= 0) { budget.omitted = true; break; }
    const receipt = item.receipt;
    // Select content and provenance together: succeeded output is confirmed receipt
    // data; preparation warnings/omissions belong only to an unconfirmed preview.
    const confirmed = item.status === "succeeded";
    const preview = confirmed ? undefined : item.preview;
    let heading = `\n${displayMetadata(item.itemId)}: ${displayMetadata(preview?.kind ?? (receipt?.created ? "Added" : item.operation))} ${displayMetadata(item.target)}`;
    if (item.destination) heading += ` → ${displayMetadata(item.destination)}`;
    heading += ` [${displayMetadata(item.status)}]`;
    const creation = preview?.kind === "Added" ? preview : receipt?.creation;
    if (creation) heading += creation.addedLines === undefined ? ` (${displayCreationCount(creation.bytes)} bytes)` : ` (+${displayCreationCount(creation.addedLines)} -0)`;
    text += budget.take(heading, MAX_PREVIEW_LINES).text;
    if (item.reason) text += budget.take(`\n${displayMetadata(item.reason)}`, MAX_PREVIEW_LINES).text;
    if (preview?.risk) text += budget.take(`\n${preview.risk}`, MAX_PREVIEW_LINES).text;
    if (!plannedDirectories && item.status === "preview") text += directorySummary(budget, preview?.plannedDirectories, true);
    // Completed receipts already own their actual diff. Never derive a diff in render.
    const writeFallback = confirmed && item.operation === "write" && receipt?.patch == null && receipt?.diff == null;
    const diff = confirmed ? receipt?.patch ?? receipt?.diff ?? (writeFallback ? item.preview?.diff : undefined) : preview?.diff;
    if (typeof diff === "string") {
      if (preview && item.status !== "preview" && item.status !== "succeeded") text += budget.take("\nPrepared change only; completion is not confirmed.", MAX_PREVIEW_LINES).text;
      const part = budget.take(`\n${diff}`);
      text += part.text;
      if (part.omitted) text += budget.take("\n[display limited] Difference excerpt omitted; later item outcomes follow when space remains.", MAX_PREVIEW_LINES).text;
    }
    if (preview?.omitted) text += budget.take(`\n[omitted] ${preview.omitted}`, MAX_PREVIEW_LINES).text;
    if (writeFallback && item.preview?.omitted) text += budget.take("\n[display limited] Write succeeded; the stored difference excerpt is incomplete or unavailable.", MAX_PREVIEW_LINES).text;
    const directories = receipt?.creation?.createdDirectories ?? receipt?.createdDirectories;
    text += directorySummary(budget, directories, false);
  }
  if (budget.omitted) text += "\n[remaining display omitted; use /changes to select one file]";
  return text;
}
