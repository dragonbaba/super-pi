import { randomBytes } from "node:crypto";
import { chmod, lstat, open, readFile, realpath, rename, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { TextDecoder } from "node:util";
import {
  DEFAULT_MAX_BYTES,
  formatSize,
  generateDiffString,
  generateUnifiedPatch,
  truncateHead,
  type ReadToolDetails,
  type ReadToolInput,
} from "@super-pi/coding-agent";
import { resolveToolPath, sha256 } from "./core.ts";
import {
  computeSnapshotLineId,
  formatSnapshotLine,
  formatSnapshotReadText,
  findUniqueSnapshotLineSuggestion,
  parseSnapshotLineReference,
  stripCopiedSnapshotPrefixes,
  validateSnapshotLineReference,
} from "./snapshot-line-protocol.ts";
import { assertNoNewSyntaxDiagnostics } from "./snapshot-syntax-guard.ts";
import {
  captureCompactSnapshot,
  compactFileLimit,
  type CompactCapturedLine,
} from "./compact-snapshot-capture.ts";
export const SNAPSHOT_EDIT_ANNOTATION_PREFIX = "[Snapshot edit]";
export const MAX_SNAPSHOT_LINE_EDITS = 20;
const MAX_SNAPSHOT_FILE_BYTES = 2 * 1024 * 1024;
const MAX_SNAPSHOT_TOTAL_BYTES = 8 * 1024 * 1024;
const MAX_SNAPSHOT_RECEIPTS = 128;
const MAX_SNAPSHOT_EDIT_BYTES = 256 * 1024;
const SNAPSHOT_ID_PATTERN = /^snap_[A-Za-z0-9_-]{22}$/u;
const strictUtf8Decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

export type SnapshotLineEditKind = "replace" | "delete" | "insert_before" | "insert_after";

export interface SnapshotLineEdit {
  kind: SnapshotLineEditKind;
  start: string;
  end?: string;
  newLines?: string[];
}

interface FileIdentity {
  dev: bigint;
  ino: bigint;
  size: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
}

interface SnapshotReceiptBase {
  id: string;
  sessionId: string;
  canonicalPath: string;
  identity: FileIdentity;
  sha256: string;
  firstSeenLine: number;
  lastSeenLine: number;
  residentBytes: number;
}

interface FullSnapshotReceipt extends SnapshotReceiptBase {
  mode: "full";
  bytes: Buffer;
}


export interface CompactSnapshotReceipt extends SnapshotReceiptBase {
  mode: "compact";
  fileBytes: number;
  totalLines: number;
  bomBytes: 0 | 3;
  visibleLines: CompactCapturedLine[];
  beforeBoundary?: CompactCapturedLine;
  afterBoundary?: CompactCapturedLine;
}

type SnapshotReceipt = FullSnapshotReceipt | CompactSnapshotReceipt;

interface PhysicalLine {
  start: number;
  contentEnd: number;
  end: number;
  eol: "\n" | "\r\n" | "";
}

interface PreparedByteEdit {
  index: number;
  start: number;
  end: number;
  replacement: Buffer;
}

export interface SnapshotReadResult {
  content: Array<{ type: string; text?: string }>;
  details?: ReadToolDetails;
}
export interface SnapshotLineEditResult {
  previousSha256: string;
  sha256: string;
  replacements: number;
  deduplicatedEdits: number;
  changedBytes: number;
  diff: string;
  patch: string;
  firstChangedLine?: number;
  reservationId?: number;
}
export interface SnapshotLineEditHooks {
  assertPathAllowed: () => Promise<string>;
  reserveMutation?: (changedBytes: number) => number;
  beforeCommit?: () => void | Promise<void>;
  afterCommit?: () => void | Promise<void>;
}
interface SnapshotStore {
  schemaVersion: 2;
  snapshots: Map<string, SnapshotReceipt>;
  residentBytes: number;
}

// Keep the durable symbol name so a reload can detect and replace the v1 shape.
const SNAPSHOT_STORE = Symbol.for("pi.mutation-guard.snapshot-line-store.v1");
type SnapshotGlobal = typeof globalThis & { [SNAPSHOT_STORE]?: SnapshotStore };

function snapshotStore(): SnapshotStore {
  const root = globalThis as SnapshotGlobal;
  const current = root[SNAPSHOT_STORE];
  if (current?.schemaVersion === 2
    && current.snapshots instanceof Map
    && Number.isSafeInteger(current.residentBytes)
    && current.residentBytes >= 0) return current;
  const created: SnapshotStore = { schemaVersion: 2, snapshots: new Map(), residentBytes: 0 };
  root[SNAPSHOT_STORE] = created;
  return created;
}

function forgetSnapshot(id: string): void {
  const store = snapshotStore();
  const receipt = store.snapshots.get(id);
  if (!receipt) return;
  store.snapshots.delete(id);
  store.residentBytes = Math.max(0, store.residentBytes - receipt.residentBytes);
}

function rememberSnapshot(receipt: SnapshotReceipt): void {
  const store = snapshotStore();
  while (store.snapshots.size > 0
    && (store.snapshots.size >= MAX_SNAPSHOT_RECEIPTS
      || store.residentBytes + receipt.residentBytes > MAX_SNAPSHOT_TOTAL_BYTES)) {
    const oldest = store.snapshots.keys().next().value;
    if (oldest === undefined) break;
    forgetSnapshot(oldest);
  }
  store.snapshots.set(receipt.id, receipt);
  store.residentBytes += receipt.residentBytes;
}

export function resetSnapshotLineStore(): void {
  const store = snapshotStore();
  store.snapshots.clear();
  store.residentBytes = 0;
}

function identityFromStat(info: Awaited<ReturnType<Awaited<ReturnType<typeof open>>["stat"]>>): FileIdentity {
  const bigint = info as unknown as {
    dev: bigint;
    ino: bigint;
    size: bigint;
    mtimeNs: bigint;
    ctimeNs: bigint;
  };
  return {
    dev: bigint.dev,
    ino: bigint.ino,
    size: bigint.size,
    mtimeNs: bigint.mtimeNs,
    ctimeNs: bigint.ctimeNs,
  };
}

function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameCaptureState(left: FileIdentity, right: FileIdentity): boolean {
  return sameIdentity(left, right)
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}

async function captureStableFile(path: string): Promise<{ canonicalPath: string; identity: FileIdentity; bytes: Buffer }> {
  const canonicalPath = await realpath(resolve(path));
  const handle = await open(canonicalPath, "r");
  try {
    const beforeInfo = await handle.stat({ bigint: true });
    if (!beforeInfo.isFile()) throw new Error("Snapshot edit supports regular files only.");
    if (beforeInfo.size > BigInt(MAX_SNAPSHOT_FILE_BYTES)) {
      throw new Error(`Snapshot edit supports files up to ${formatSize(MAX_SNAPSHOT_FILE_BYTES)}.`);
    }
    const before = identityFromStat(beforeInfo);
    const bytes = await handle.readFile();
    const afterInfo = await handle.stat({ bigint: true });
    const after = identityFromStat(afterInfo);
    if (!sameCaptureState(before, after) || BigInt(bytes.byteLength) !== after.size) {
      throw new Error("File changed while the snapshot was being captured.");
    }
    return { canonicalPath, identity: after, bytes };
  } finally {
    await handle.close();
  }
}

function primaryText(result: SnapshotReadResult): string | undefined {
  if (result.content.length !== 1) return undefined;
  const item = result.content[0];
  return item?.type === "text" && typeof item.text === "string" ? item.text : undefined;
}

interface NativeReadProjection {
  text: string;
  firstLine: number;
  lastLine: number;
  outputLines: number;
}

function nativeReadProjection(bytes: Buffer, input: ReadToolInput): NativeReadProjection | undefined {
  let decoded: string;
  try {
    decoded = strictUtf8Decoder.decode(bytes);
  } catch {
    return undefined;
  }
  if (decoded.includes("\0")) return undefined;
  const allLines = decoded.split("\n");
  const startIndex = input.offset ? Math.max(0, input.offset - 1) : 0;
  if (startIndex >= allLines.length) return undefined;
  const firstLine = startIndex + 1;
  let selectedContent: string;
  let userLimitedLines: number | undefined;
  if (input.limit !== undefined) {
    const endIndex = Math.min(startIndex + input.limit, allLines.length);
    selectedContent = allLines.slice(startIndex, endIndex).join("\n");
    userLimitedLines = endIndex - startIndex;
  } else {
    selectedContent = allLines.slice(startIndex).join("\n");
  }
  const truncation = truncateHead(selectedContent);
  if (truncation.firstLineExceedsLimit) return undefined;
  let text: string;
  let outputLines: number;
  if (truncation.truncated) {
    outputLines = truncation.outputLines;
    const endLine = firstLine + outputLines - 1;
    const nextOffset = endLine + 1;
    text = truncation.content;
    if (truncation.truncatedBy === "lines") {
      text += `\n\n[Showing lines ${firstLine}-${endLine} of ${allLines.length}. Use offset=${nextOffset} to continue.]`;
    } else {
      text += `\n\n[Showing lines ${firstLine}-${endLine} of ${allLines.length} (${formatSize(DEFAULT_MAX_BYTES)} limit). Use offset=${nextOffset} to continue.]`;
    }
  } else if (userLimitedLines !== undefined && startIndex + userLimitedLines < allLines.length) {
    outputLines = userLimitedLines;
    const remaining = allLines.length - (startIndex + userLimitedLines);
    const nextOffset = startIndex + userLimitedLines + 1;
    text = `${truncation.content}\n\n[${remaining} more lines in file. Use offset=${nextOffset} to continue.]`;
  } else {
    outputLines = Math.max(1, allLines.length - startIndex);
    text = truncation.content;
  }
  return { text, firstLine, lastLine: firstLine + outputLines - 1, outputLines };
}

export async function issueSnapshotForRead(
  sessionId: string,
  cwd: string,
  input: ReadToolInput,
  result: SnapshotReadResult,
): Promise<string | undefined> {
  const displayed = primaryText(result);
  if (displayed === undefined) return undefined;
  const target = resolveToolPath(cwd, input.path);
  let fullCapture: Awaited<ReturnType<typeof captureStableFile>> | undefined;
  try {
    fullCapture = await captureStableFile(target);
  } catch {
    // Files above the full-receipt ceiling may still qualify for a compact receipt.
  }
  if (fullCapture) {
    const projection = nativeReadProjection(fullCapture.bytes, input);
    if (!projection || projection.text !== displayed) return undefined;
    const lines = parsePhysicalLines(fullCapture.bytes);
    if (!lines || lines.length === 0) return undefined;
    const firstSeenLine = Math.max(1, projection.firstLine);
    const lastSeenLine = Math.min(lines.length, projection.lastLine);
    if (lastSeenLine < firstSeenLine) return undefined;
    const id = `snap_${randomBytes(16).toString("base64url")}`;
    rememberSnapshot({
      mode: "full",
      id,
      sessionId,
      canonicalPath: fullCapture.canonicalPath,
      identity: fullCapture.identity,
      bytes: fullCapture.bytes,
      sha256: sha256(fullCapture.bytes),
      firstSeenLine,
      lastSeenLine,
      residentBytes: fullCapture.bytes.byteLength,
    });
    result.content[0] = {
      type: "text",
      text: formatSnapshotReadText(displayed, firstSeenLine, lastSeenLine - firstSeenLine + 1),
    };
    return `${SNAPSHOT_EDIT_ANNOTATION_PREFIX} snapshot=${id}; editable lines=${firstSeenLine}-${lastSeenLine}. Copy LINE#ID anchors exactly. insert={kind,start,newLines} (omit end); replace={kind,start,end?,newLines}; delete={kind,start,end?}.`;
  }
  let compact: Awaited<ReturnType<typeof captureCompactSnapshot>>;
  try {
    compact = await captureCompactSnapshot(target, input, displayed);
  } catch {
    return undefined;
  }
  if (!compact) return undefined;
  const id = `snap_${randomBytes(16).toString("base64url")}`;
  rememberSnapshot({
    mode: "compact",
    id,
    sessionId,
    canonicalPath: compact.canonicalPath,
    identity: compact.identity,
    sha256: compact.sha256,
    firstSeenLine: compact.firstSeenLine,
    lastSeenLine: compact.lastSeenLine,
    residentBytes: compact.residentBytes,
    fileBytes: compact.fileBytes,
    totalLines: compact.totalLines,
    bomBytes: compact.bomBytes,
    visibleLines: compact.visibleLines,
    beforeBoundary: compact.beforeBoundary,
    afterBoundary: compact.afterBoundary,
  });
  result.content[0] = {
    type: "text",
    text: formatSnapshotReadText(displayed, compact.firstSeenLine, compact.visibleLines.length),
  };
  return `${SNAPSHOT_EDIT_ANNOTATION_PREFIX} snapshot=${id}; editable lines=${compact.firstSeenLine}-${compact.lastSeenLine}. Copy LINE#ID anchors exactly. insert={kind,start,newLines} (omit end); replace={kind,start,end?,newLines}; delete={kind,start,end?}.`;
}
function parsePhysicalLines(bytes: Buffer): PhysicalLine[] | undefined {
  let offset = 0;
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) offset = 3;
  try {
    strictUtf8Decoder.decode(bytes.subarray(offset));
  } catch {
    return undefined;
  }
  const lines: PhysicalLine[] = [];
  let lineStart = offset;
  for (let index = offset; index < bytes.length; index++) {
    if (bytes[index] === 0x0d && bytes[index + 1] !== 0x0a) return undefined;
    if (bytes[index] !== 0x0a) continue;
    const crlf = index > lineStart && bytes[index - 1] === 0x0d;
    lines.push({
      start: lineStart,
      contentEnd: crlf ? index - 1 : index,
      end: index + 1,
      eol: crlf ? "\r\n" : "\n",
    });
    lineStart = index + 1;
  }
  if (lineStart < bytes.length) {
    lines.push({ start: lineStart, contentEnd: bytes.length, end: bytes.length, eol: "" });
  }
  return lines;
}

function preferredEol(lines: readonly PhysicalLine[], lineIndex: number): "\n" | "\r\n" {
  const direct = lines[lineIndex]?.eol;
  if (direct) return direct;
  for (let index = lineIndex - 1; index >= 0; index--) if (lines[index].eol) return lines[index].eol as "\n" | "\r\n";
  for (let index = lineIndex + 1; index < lines.length; index++) if (lines[index].eol) return lines[index].eol as "\n" | "\r\n";
  return "\n";
}

function physicalLineText(bytes: Buffer, line: PhysicalLine): string {
  return strictUtf8Decoder.decode(bytes.subarray(line.start, line.contentEnd));
}

function normalizedNewLines(edit: SnapshotLineEdit, index: number): string[] {
  if (edit.kind === "delete") {
    if (edit.newLines !== undefined) throw new Error(`[SNAPSHOT_EDIT_INVALID] edits[${index}].newLines is not allowed for delete.`);
    return [];
  }
  if (!Array.isArray(edit.newLines) || edit.newLines.length === 0) {
    throw new Error(`[SNAPSHOT_EDIT_INVALID] edits[${index}].newLines must be a non-empty string array.`);
  }
  const stripped = stripCopiedSnapshotPrefixes(edit.newLines);
  for (let lineIndex = 0; lineIndex < stripped.length; lineIndex++) {
    const line = stripped[lineIndex];
    if (typeof line !== "string") throw new Error(`[SNAPSHOT_EDIT_INVALID] edits[${index}].newLines[${lineIndex}] must be a string.`);
    if (line.includes("\n") || line.includes("\r")) {
      throw new Error(`[SNAPSHOT_EDIT_INVALID] edits[${index}].newLines[${lineIndex}] must contain exactly one physical line.`);
    }
    if (line.includes("\0")) throw new Error(`[SNAPSHOT_EDIT_INVALID] edits[${index}].newLines[${lineIndex}] contains NUL.`);
  }
  return stripped;
}

function payloadBuffer(lines: readonly string[], eol: "\n" | "\r\n", index: number, maxBytes: number): Buffer {
  const text = lines.join(eol);
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes > maxBytes) {
    throw new Error(`[SNAPSHOT_EDIT_BUDGET] edits[${index}].newLines exceeds the remaining bounded edit scope.`);
  }
  return Buffer.from(text, "utf8");
}

function editKey(edit: SnapshotLineEdit): string {
  return JSON.stringify([edit.kind, edit.start.trim(), edit.end?.trim() ?? "", edit.newLines ?? null]);
}

function deduplicateEdits(edits: readonly SnapshotLineEdit[]): { edits: SnapshotLineEdit[]; deduplicatedEdits: number } {
  const seen = new Set<string>();
  const unique: SnapshotLineEdit[] = [];
  for (const edit of edits) {
    const key = editKey(edit);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(edit);
  }
  return { edits: unique, deduplicatedEdits: edits.length - unique.length };
}

function assertNoBoundaryEcho(
  index: number,
  startLine: number,
  endLine: number,
  newLines: readonly string[],
  snapshotLines: readonly string[],
): void {
  if (newLines.length === 0) return;
  const before = snapshotLines[startLine - 2];
  const after = snapshotLines[endLine];
  if (before !== undefined && newLines[0] === before) {
    throw new Error(`[SNAPSHOT_EDIT_BOUNDARY] edits[${index}].newLines repeats surviving line ${startLine - 1}; remove the first newLines entry.`);
  }
  if (after !== undefined && newLines[newLines.length - 1] === after) {
    throw new Error(`[SNAPSHOT_EDIT_BOUNDARY] edits[${index}].newLines repeats surviving line ${endLine + 1}; remove the last newLines entry.`);
  }
}

interface PreparedEdits {
  output: Buffer;
  changedBytes: number;
  replacements: number;
  deduplicatedEdits: number;
}

function prepareEdits(receipt: FullSnapshotReceipt, requestedEdits: readonly SnapshotLineEdit[]): PreparedEdits {
  if (requestedEdits.length === 0 || requestedEdits.length > MAX_SNAPSHOT_LINE_EDITS) {
    throw new Error(`[SNAPSHOT_EDIT_INVALID] Provide 1-${MAX_SNAPSHOT_LINE_EDITS} line operations.`);
  }
  const deduplicated = deduplicateEdits(requestedEdits);
  const edits = deduplicated.edits;
  const lines = parsePhysicalLines(receipt.bytes);
  if (!lines || lines.length === 0) throw new Error("[SNAPSHOT_EDIT_UNSUPPORTED] The snapshot is not supported line-oriented UTF-8 text.");
  const snapshotLines = lines.map((line) => physicalLineText(receipt.bytes, line));
  const prepared: PreparedByteEdit[] = [];
  let changedBytes = 0;
  for (let index = 0; index < edits.length; index++) {
    const edit = edits[index];
    const startLine = validateSnapshotLineReference(edit.start, `edits[${index}].start`, snapshotLines, receipt.firstSeenLine, receipt.lastSeenLine);
    const insertion = edit.kind === "insert_before" || edit.kind === "insert_after";
    const endLine = edit.end === undefined
      ? startLine
      : validateSnapshotLineReference(edit.end, `edits[${index}].end`, snapshotLines, receipt.firstSeenLine, receipt.lastSeenLine);
    if (insertion && endLine !== startLine) {
      throw new Error(`[SNAPSHOT_EDIT_INVALID] edits[${index}] insertion uses one start anchor; omit the differing end anchor.`);
    }
    if (endLine < startLine) throw new Error(`[SNAPSHOT_EDIT_INVALID] edits[${index}].end precedes start.`);
    const startIndex = startLine - 1;
    const eol = preferredEol(lines, startIndex);
    const newLines = normalizedNewLines(edit, index);
    let start: number;
    let end: number;
    let replacement: Buffer;
    if (edit.kind === "replace" || edit.kind === "delete") {
      const finalLine = lines[endLine - 1];
      start = lines[startIndex].start;
      end = finalLine.end;
      assertNoBoundaryEcho(index, startLine, endLine, newLines, snapshotLines);
      if (edit.kind === "delete") {
        replacement = Buffer.alloc(0);
      } else {
        const removedBytes = end - start;
        const terminatorBytes = finalLine.eol ? Buffer.byteLength(finalLine.eol) : 0;
        const payload = payloadBuffer(newLines, eol, index, Math.max(0, MAX_SNAPSHOT_EDIT_BYTES - changedBytes - removedBytes - terminatorBytes));
        replacement = finalLine.eol ? Buffer.concat([payload, Buffer.from(finalLine.eol)]) : payload;
      }
    } else if (edit.kind === "insert_before" || edit.kind === "insert_after") {
      const line = lines[startIndex];
      const payload = payloadBuffer(newLines, eol, index, Math.max(0, MAX_SNAPSHOT_EDIT_BYTES - changedBytes - Buffer.byteLength(eol)));
      if (edit.kind === "insert_before") {
        if (newLines[newLines.length - 1] === snapshotLines[startIndex]) {
          throw new Error(`[SNAPSHOT_EDIT_BOUNDARY] edits[${index}].newLines repeats its surviving anchor; remove the last newLines entry.`);
        }
        start = line.start;
        end = line.start;
        replacement = Buffer.concat([payload, Buffer.from(eol)]);
      } else if (line.eol) {
        if (newLines[0] === snapshotLines[startIndex]) {
          throw new Error(`[SNAPSHOT_EDIT_BOUNDARY] edits[${index}].newLines repeats its surviving anchor; remove the first newLines entry.`);
        }
        start = line.end;
        end = line.end;
        replacement = Buffer.concat([payload, Buffer.from(eol)]);
      } else {
        start = line.end;
        end = line.end;
        replacement = Buffer.concat([Buffer.from(eol), payload]);
      }
    } else {
      throw new Error(`[SNAPSHOT_EDIT_INVALID] edits[${index}].kind is unsupported.`);
    }
    changedBytes += end - start + replacement.byteLength;
    prepared.push({ index, start, end, replacement });
  }
  if (changedBytes > MAX_SNAPSHOT_EDIT_BYTES) {
    throw new Error(`[SNAPSHOT_EDIT_BUDGET] Requested ${changedBytes} scoped bytes; allowed ${MAX_SNAPSHOT_EDIT_BYTES}.`);
  }
  prepared.sort((left, right) => left.start - right.start || left.end - right.end || left.index - right.index);
  for (let index = 1; index < prepared.length; index++) {
    const previous = prepared[index - 1];
    const current = prepared[index];
    if (current.start < previous.end || (current.start === previous.start && current.end === previous.end)) {
      throw new Error(`[SNAPSHOT_EDIT_OVERLAP] edits[${previous.index}] and edits[${current.index}] overlap or share one insertion point.`);
    }
    if (previous.start === previous.end && current.start <= previous.start && previous.start <= current.end) {
      throw new Error(`[SNAPSHOT_EDIT_OVERLAP] insertion edits[${previous.index}] touches edits[${current.index}].`);
    }
    if (current.start === current.end && previous.start <= current.start && current.start <= previous.end) {
      throw new Error(`[SNAPSHOT_EDIT_OVERLAP] insertion edits[${current.index}] touches edits[${previous.index}].`);
    }
  }
  const chunks: Buffer[] = [];
  let cursor = 0;
  for (const edit of prepared) {
    chunks.push(receipt.bytes.subarray(cursor, edit.start), edit.replacement);
    cursor = edit.end;
  }
  chunks.push(receipt.bytes.subarray(cursor));
  const output = Buffer.concat(chunks);
  if (output.byteLength > MAX_SNAPSHOT_FILE_BYTES) {
    throw new Error(`[SNAPSHOT_EDIT_BUDGET] Result exceeds ${formatSize(MAX_SNAPSHOT_FILE_BYTES)}.`);
  }
  if (output.equals(receipt.bytes)) throw new Error("[SNAPSHOT_EDIT_NO_OP] The requested operations do not change the file.");
  return { output, changedBytes, replacements: edits.length, deduplicatedEdits: deduplicated.deduplicatedEdits };
}

function compactLine(receipt: CompactSnapshotReceipt, line: number): CompactCapturedLine | undefined {
  const candidate = receipt.visibleLines[line - receipt.firstSeenLine];
  return candidate?.line === line ? candidate : undefined;
}

function compactMismatchContext(receipt: CompactSnapshotReceipt, line: number): string {
  const low = Math.max(receipt.firstSeenLine, line - 2);
  const high = Math.min(receipt.lastSeenLine, line + 2);
  const output: string[] = [];
  for (let current = low; current <= high; current++) {
    const stored = compactLine(receipt, current);
    if (!stored) continue;
    output.push(`${current === line ? ">>> " : "    "}${formatSnapshotLine(current, stored.text)}`);
  }
  return output.join("\n");
}

function validateCompactLineReference(
  value: string,
  field: string,
  receipt: CompactSnapshotReceipt,
): CompactCapturedLine {
  const reference = parseSnapshotLineReference(value, field);
  if (reference.line < 1 || reference.line > receipt.totalLines) {
    throw new Error(`[SNAPSHOT_EDIT_INVALID] ${field} line ${reference.line} is outside the file.`);
  }
  if (reference.line < receipt.firstSeenLine || reference.line > receipt.lastSeenLine) {
    throw new Error(`[SNAPSHOT_EDIT_UNSEEN] ${field} line ${reference.line} is outside observed lines ${receipt.firstSeenLine}-${receipt.lastSeenLine}.`);
  }
  const line = compactLine(receipt, reference.line);
  if (!line) throw new Error(`[SNAPSHOT_EDIT_UNSEEN] ${field} line ${reference.line} is not retained by this compact snapshot.`);
  if (computeSnapshotLineId(reference.line, line.text) !== reference.id) {
    const context = compactMismatchContext(receipt, reference.line);
    const suggestion = findUniqueSnapshotLineSuggestion(
      reference.id,
      receipt.firstSeenLine,
      receipt.lastSeenLine,
      (candidate) => compactLine(receipt, candidate)?.text,
    );
    throw new Error(
      `[SNAPSHOT_EDIT_MISMATCH] ${field} ${value} does not match the immutable snapshot.${suggestion ? ` Did you mean ${suggestion}?` : ""} Copy the updated LINE#ID below.${context ? `\n${context}` : ""}`,
    );
  }
  return line;
}

function compactPreferredEol(receipt: CompactSnapshotReceipt, line: number): "\n" | "\r\n" {
  const direct = compactLine(receipt, line)?.eol;
  if (direct) return direct;
  for (let current = line - 1; current >= receipt.firstSeenLine; current--) {
    const eol = compactLine(receipt, current)?.eol;
    if (eol) return eol;
  }
  if (receipt.beforeBoundary?.eol) return receipt.beforeBoundary.eol;
  for (let current = line + 1; current <= receipt.lastSeenLine; current++) {
    const eol = compactLine(receipt, current)?.eol;
    if (eol) return eol;
  }
  if (receipt.afterBoundary?.eol) return receipt.afterBoundary.eol;
  return "\n";
}

function compactBoundaryText(receipt: CompactSnapshotReceipt, line: number): string | undefined {
  if (line < 1 || line > receipt.totalLines) return undefined;
  return compactLine(receipt, line)?.text
    ?? (receipt.beforeBoundary?.line === line ? receipt.beforeBoundary.text : undefined)
    ?? (receipt.afterBoundary?.line === line ? receipt.afterBoundary.text : undefined);
}

function assertNoCompactBoundaryEcho(
  receipt: CompactSnapshotReceipt,
  index: number,
  startLine: number,
  endLine: number,
  newLines: readonly string[],
): void {
  if (newLines.length === 0) return;
  const before = compactBoundaryText(receipt, startLine - 1);
  const after = compactBoundaryText(receipt, endLine + 1);
  if (before !== undefined && newLines[0] === before) {
    throw new Error(`[SNAPSHOT_EDIT_BOUNDARY] edits[${index}].newLines repeats surviving line ${startLine - 1}; remove the first newLines entry.`);
  }
  if (after !== undefined && newLines[newLines.length - 1] === after) {
    throw new Error(`[SNAPSHOT_EDIT_BOUNDARY] edits[${index}].newLines repeats surviving line ${endLine + 1}; remove the last newLines entry.`);
  }
}

function prepareCompactEdits(
  receipt: CompactSnapshotReceipt,
  current: Buffer,
  requestedEdits: readonly SnapshotLineEdit[],
): PreparedEdits {
  if (requestedEdits.length === 0 || requestedEdits.length > MAX_SNAPSHOT_LINE_EDITS) {
    throw new Error(`[SNAPSHOT_EDIT_INVALID] Provide 1-${MAX_SNAPSHOT_LINE_EDITS} line operations.`);
  }
  const deduplicated = deduplicateEdits(requestedEdits);
  const edits = deduplicated.edits;
  const prepared: PreparedByteEdit[] = [];
  let changedBytes = 0;
  for (let index = 0; index < edits.length; index++) {
    const edit = edits[index];
    const startLine = validateCompactLineReference(edit.start, `edits[${index}].start`, receipt);
    const insertion = edit.kind === "insert_before" || edit.kind === "insert_after";
    const endLine = edit.end === undefined
      ? startLine
      : validateCompactLineReference(edit.end, `edits[${index}].end`, receipt);
    if (insertion && endLine.line !== startLine.line) {
      throw new Error(`[SNAPSHOT_EDIT_INVALID] edits[${index}] insertion uses one start anchor; omit the differing end anchor.`);
    }
    if (endLine.line < startLine.line) throw new Error(`[SNAPSHOT_EDIT_INVALID] edits[${index}].end precedes start.`);
    const eol = compactPreferredEol(receipt, startLine.line);
    const newLines = normalizedNewLines(edit, index);
    let start: number;
    let end: number;
    let replacement: Buffer;
    if (edit.kind === "replace" || edit.kind === "delete") {
      start = startLine.start;
      end = endLine.end;
      assertNoCompactBoundaryEcho(receipt, index, startLine.line, endLine.line, newLines);
      if (edit.kind === "delete") {
        replacement = Buffer.alloc(0);
      } else {
        const removedBytes = end - start;
        const terminatorBytes = endLine.eol ? Buffer.byteLength(endLine.eol) : 0;
        const payload = payloadBuffer(newLines, eol, index, Math.max(0, MAX_SNAPSHOT_EDIT_BYTES - changedBytes - removedBytes - terminatorBytes));
        replacement = endLine.eol ? Buffer.concat([payload, Buffer.from(endLine.eol)]) : payload;
      }
    } else if (edit.kind === "insert_before" || edit.kind === "insert_after") {
      const payload = payloadBuffer(newLines, eol, index, Math.max(0, MAX_SNAPSHOT_EDIT_BYTES - changedBytes - Buffer.byteLength(eol)));
      if (edit.kind === "insert_before") {
        if (newLines[newLines.length - 1] === startLine.text) {
          throw new Error(`[SNAPSHOT_EDIT_BOUNDARY] edits[${index}].newLines repeats its surviving anchor; remove the last newLines entry.`);
        }
        start = startLine.start;
        end = startLine.start;
        replacement = Buffer.concat([payload, Buffer.from(eol)]);
      } else if (startLine.eol) {
        if (newLines[0] === startLine.text) {
          throw new Error(`[SNAPSHOT_EDIT_BOUNDARY] edits[${index}].newLines repeats its surviving anchor; remove the first newLines entry.`);
        }
        start = startLine.end;
        end = startLine.end;
        replacement = Buffer.concat([payload, Buffer.from(eol)]);
      } else {
        start = startLine.end;
        end = startLine.end;
        replacement = Buffer.concat([Buffer.from(eol), payload]);
      }
    } else {
      throw new Error(`[SNAPSHOT_EDIT_INVALID] edits[${index}].kind is unsupported.`);
    }
    changedBytes += end - start + replacement.byteLength;
    prepared.push({ index, start, end, replacement });
  }
  if (changedBytes > MAX_SNAPSHOT_EDIT_BYTES) {
    throw new Error(`[SNAPSHOT_EDIT_BUDGET] Requested ${changedBytes} scoped bytes; allowed ${MAX_SNAPSHOT_EDIT_BYTES}.`);
  }
  prepared.sort((left, right) => left.start - right.start || left.end - right.end || left.index - right.index);
  for (let index = 1; index < prepared.length; index++) {
    const previous = prepared[index - 1];
    const next = prepared[index];
    if (next.start < previous.end || (next.start === previous.start && next.end === previous.end)) {
      throw new Error(`[SNAPSHOT_EDIT_OVERLAP] edits[${previous.index}] and edits[${next.index}] overlap or share one insertion point.`);
    }
    if (previous.start === previous.end && next.start <= previous.start && previous.start <= next.end) {
      throw new Error(`[SNAPSHOT_EDIT_OVERLAP] insertion edits[${previous.index}] touches edits[${next.index}].`);
    }
    if (next.start === next.end && previous.start <= next.start && next.start <= previous.end) {
      throw new Error(`[SNAPSHOT_EDIT_OVERLAP] insertion edits[${next.index}] touches edits[${previous.index}].`);
    }
  }
  const chunks: Buffer[] = [];
  let cursor = 0;
  for (const edit of prepared) {
    chunks.push(current.subarray(cursor, edit.start), edit.replacement);
    cursor = edit.end;
  }
  chunks.push(current.subarray(cursor));
  const output = Buffer.concat(chunks);
  const maximum = compactFileLimit(receipt.canonicalPath);
  if (output.byteLength > maximum) throw new Error(`[SNAPSHOT_EDIT_BUDGET] Result exceeds ${formatSize(maximum)}.`);
  if (output.equals(current)) throw new Error("[SNAPSHOT_EDIT_NO_OP] The requested operations do not change the file.");
  return { output, changedBytes, replacements: edits.length, deduplicatedEdits: deduplicated.deduplicatedEdits };
}
async function currentIdentity(path: string): Promise<FileIdentity> {
  const info = await lstat(path, { bigint: true });
  if (!info.isFile() || info.isSymbolicLink()) throw new Error("[SNAPSHOT_EDIT_IDENTITY] Target is no longer a regular file.");
  return identityFromStat(info);
}

export async function resolveSnapshotCanonicalTarget(
  sessionId: string,
  cwd: string,
  path: string,
  snapshotId: string,
): Promise<string> {
  if (!SNAPSHOT_ID_PATTERN.test(snapshotId)) throw new Error("[SNAPSHOT_EDIT_UNKNOWN] Invalid snapshot identifier.");
  const receipt = snapshotStore().snapshots.get(snapshotId);
  if (!receipt || receipt.sessionId !== sessionId) {
    throw new Error("[SNAPSHOT_EDIT_UNKNOWN] Snapshot is absent, expired, consumed, or belongs to another Session. Read the target again.");
  }
  const requestedCanonical = await realpath(resolveToolPath(cwd, path));
  if (requestedCanonical !== receipt.canonicalPath) {
    throw new Error("[SNAPSHOT_EDIT_PATH] Snapshot does not belong to this exact canonical target.");
  }
  return receipt.canonicalPath;
}
export async function executeSnapshotLineEdit(
  sessionId: string,
  cwd: string,
  path: string,
  snapshotId: string,
  edits: readonly SnapshotLineEdit[],
  signal: AbortSignal | undefined,
  hooks: SnapshotLineEditHooks,
): Promise<SnapshotLineEditResult> {
  if (!SNAPSHOT_ID_PATTERN.test(snapshotId)) throw new Error("[SNAPSHOT_EDIT_UNKNOWN] Invalid snapshot identifier.");
  const receipt = snapshotStore().snapshots.get(snapshotId);
  if (!receipt || receipt.sessionId !== sessionId) throw new Error("[SNAPSHOT_EDIT_UNKNOWN] Snapshot is absent, expired, consumed, or belongs to another Session. Read the target again.");
  if (signal?.aborted) throw new Error("Operation aborted");
  const approvedCanonical = await hooks.assertPathAllowed();
  const requestedCanonical = await resolveSnapshotCanonicalTarget(sessionId, cwd, path, snapshotId);
  if (requestedCanonical !== receipt.canonicalPath || approvedCanonical !== receipt.canonicalPath) {
    throw new Error("[SNAPSHOT_EDIT_PATH] Snapshot does not belong to this exact canonical target.");
  }
  const identity = await currentIdentity(receipt.canonicalPath);
  if (!sameIdentity(identity, receipt.identity)) {
    forgetSnapshot(snapshotId);
    throw new Error("[SNAPSHOT_EDIT_STALE] Target identity changed. Read the target again.");
  }
  const current = await readFile(receipt.canonicalPath);
  if (sha256(current) !== receipt.sha256) {
    forgetSnapshot(snapshotId);
    throw new Error("[SNAPSHOT_EDIT_STALE] Target content changed. Read the target again.");
  }
  const prepared = receipt.mode === "full"
    ? prepareEdits(receipt, edits)
    : prepareCompactEdits(receipt, current, edits);
  const beforeText = strictUtf8Decoder.decode(current);
  const afterText = strictUtf8Decoder.decode(prepared.output);
  const diffResult = generateDiffString(beforeText, afterText);
  await assertNoNewSyntaxDiagnostics(receipt.canonicalPath, beforeText, afterText);
  const patch = generateUnifiedPatch(receipt.canonicalPath, beforeText, afterText);
  const reservationId = hooks.reserveMutation?.(prepared.changedBytes);
  if (signal?.aborted) throw new Error("Operation aborted");
  const directory = dirname(receipt.canonicalPath);
  const temporary = join(directory, `.pi-snapshot-edit-${process.pid}-${randomBytes(12).toString("hex")}.tmp`);
  let committed = false;
  try {
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(prepared.output);
      await handle.sync();
    } finally {
      await handle.close();
    }
    const originalMode = (await lstat(receipt.canonicalPath)).mode & 0o777;
    await chmod(temporary, originalMode);
    if (signal?.aborted) throw new Error("Operation aborted");
    await hooks.beforeCommit?.();
    if (signal?.aborted) throw new Error("Operation aborted");
    const finalIdentity = await currentIdentity(receipt.canonicalPath);
    const finalBytes = await readFile(receipt.canonicalPath);
    const canonicalDirectory = await realpath(directory);
    if (canonicalDirectory !== directory || !sameIdentity(finalIdentity, receipt.identity) || sha256(finalBytes) !== receipt.sha256) {
      forgetSnapshot(snapshotId);
      throw new Error("[SNAPSHOT_EDIT_STALE] Target changed before commit. Read the target again.");
    }
    await rename(temporary, receipt.canonicalPath);
    committed = true;
    forgetSnapshot(snapshotId);
    let writtenSha256: string;
    try {
      await hooks.afterCommit?.();
      const written = await readFile(receipt.canonicalPath);
      writtenSha256 = sha256(written);
      if (writtenSha256 !== sha256(prepared.output)) {
        throw new Error("readback hash did not match the staged content");
      }
    } catch (error) {
      const cause = error instanceof Error ? error.message : String(error);
      throw new Error(`[SNAPSHOT_EDIT_PARTIAL] Atomic replacement committed but verification failed: ${cause}. Verify the target manually.`);
    }
    return {
      previousSha256: receipt.sha256,
      sha256: writtenSha256,
      replacements: prepared.replacements,
      deduplicatedEdits: prepared.deduplicatedEdits,
      changedBytes: prepared.changedBytes,
      diff: diffResult.diff,
      patch,
      firstChangedLine: diffResult.firstChangedLine,
      reservationId,
    };
  } finally {
    if (!committed) await rm(temporary, { force: true });
  }
}
