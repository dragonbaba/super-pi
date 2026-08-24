import { open, stat } from "node:fs/promises";
import { resolve } from "node:path";

const MAX_DIAGNOSTIC_FILE_BYTES = 4 * 1024 * 1024;
const MIN_ALREADY_APPLIED_TEXT = 8;
const MIN_REPLACEMENT_CONTEXT_ANCHOR = 8;
const MAX_LOCATIONS = 8;
const MAX_VISUALIZED_CHARS = 180;

export interface DiagnosticEditPair {
  oldText: string;
  newText: string;
  expectedLine?: number;
}

function normalizeLf(value: string): string {
  if (!value.includes("\r")) return value;
  return value.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
}

function lineAt(content: string, offset: number): number {
  let line = 1;
  for (let index = content.indexOf("\n"); index !== -1 && index < offset; index = content.indexOf("\n", index + 1)) line++;
  return line;
}

function exactLocations(content: string, needle: string): number[] {
  if (!needle) return [];
  const lines: number[] = [];
  let offset = content.indexOf(needle);
  while (offset !== -1 && lines.length < MAX_LOCATIONS) {
    lines.push(lineAt(content, offset));
    offset = content.indexOf(needle, offset + Math.max(1, needle.length));
  }
  return lines;
}

function visualizeWhitespace(value: string): string {
  const clipped = value.length > MAX_VISUALIZED_CHARS ? `${value.slice(0, MAX_VISUALIZED_CHARS)}…` : value;
  let output = "";
  for (const character of clipped) {
    if (character === " ") output += "·";
    else if (character === "\t") output += "⇥";
    else if (character === "\n") output += "↵\n";
    else output += character;
  }
  return output;
}

async function readBoundedFile(path: string): Promise<string | undefined> {
  let info;
  try {
    info = await stat(path);
  } catch {
    return undefined;
  }
  if (!info.isFile() || info.size > MAX_DIAGNOSTIC_FILE_BYTES) return undefined;
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.allocUnsafe(info.size);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead !== info.size) return undefined;
    return normalizeLf(buffer.toString("utf8"));
  } finally {
    await handle.close();
  }
}

export function isConservativelyAlreadyApplied(content: string, edits: readonly DiagnosticEditPair[]): boolean {
  if (edits.length === 0) return false;
  const normalizedContent = normalizeLf(content);
  let previousReplacementEnd = -1;
  for (const edit of edits) {
    const oldText = normalizeLf(edit.oldText);
    const newText = normalizeLf(edit.newText);
    if (newText.trim().length < MIN_ALREADY_APPLIED_TEXT || oldText === newText) return false;
    if (normalizedContent.indexOf(oldText) !== -1) return false;
    const replacementOffset = uniqueOccurrenceOffset(normalizedContent, newText);
    if (replacementOffset < 0 || replacementOffset < previousReplacementEnd) return false;

    if (edit.expectedLine !== undefined) {
      if (!Number.isInteger(edit.expectedLine) || edit.expectedLine < 1) return false;
      if (lineAt(normalizedContent, replacementOffset) !== edit.expectedLine) return false;
    } else {
      const prefix = commonPrefixLength(oldText, newText);
      const suffix = commonSuffixLength(oldText, newText, prefix);
      if (prefix < MIN_REPLACEMENT_CONTEXT_ANCHOR && suffix < MIN_REPLACEMENT_CONTEXT_ANCHOR) return false;
      if (prefix + suffix >= Math.min(oldText.length, newText.length)) return false;
    }
    previousReplacementEnd = replacementOffset + newText.length;
  }
  return true;
}

function uniqueOccurrenceOffset(content: string, value: string): number {
  const first = content.indexOf(value);
  if (first < 0) return -1;
  return content.indexOf(value, first + Math.max(1, value.length)) < 0 ? first : -1;
}

function commonPrefixLength(left: string, right: string): number {
  const limit = Math.min(left.length, right.length);
  let index = 0;
  while (index < limit && left.charCodeAt(index) === right.charCodeAt(index)) index++;
  return index;
}

function commonSuffixLength(left: string, right: string, prefixLength: number): number {
  const limit = Math.min(left.length, right.length) - prefixLength;
  let length = 0;
  while (length < limit
    && left.charCodeAt(left.length - length - 1) === right.charCodeAt(right.length - length - 1)) length++;
  return length;
}

export function buildEditDiagnostic(
  content: string,
  edits: readonly DiagnosticEditPair[],
  onlyIndex?: number,
): string | undefined {
  const rows: string[] = [];
  for (let index = 0; index < edits.length; index++) {
    if (onlyIndex !== undefined && index !== onlyIndex) continue;
    const oldText = normalizeLf(edits[index].oldText);
    const newText = normalizeLf(edits[index].newText);
    const oldLines = exactLocations(content, oldText);
    const newLines = exactLocations(content, newText);
    if (oldLines.length > 0) rows.push(`edits[${index}].oldText exact location(s): line ${oldLines.join(", ")}`);
    if (newLines.length > 0) rows.push(`edits[${index}].newText already appears at line ${newLines.join(", ")}`);
    if (oldLines.length === 0) rows.push(`edits[${index}].oldText whitespace: ${visualizeWhitespace(oldText)}`);
  }
  return rows.length > 0 ? rows.join("\n") : undefined;
}

export async function diagnoseFailedEdit(
  cwd: string,
  path: string,
  edits: readonly DiagnosticEditPair[],
  onlyIndex?: number,
): Promise<{
  alreadyApplied: boolean;
  diagnostic?: string;
} | undefined> {
  const content = await readBoundedFile(resolve(cwd, path));
  if (content === undefined) return undefined;
  return {
    alreadyApplied: isConservativelyAlreadyApplied(content, edits),
    diagnostic: buildEditDiagnostic(content, edits, onlyIndex),
  };
}
