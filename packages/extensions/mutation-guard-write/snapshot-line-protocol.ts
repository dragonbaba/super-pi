import { createHash } from "node:crypto";

const LINE_ID_PATTERN = /^([1-9]\d*)#([A-F0-9]{4})$/u;
const DISPLAYED_LINE_PATTERN = /^([1-9]\d*)#[A-F0-9]{4}\|(.*?)(\r?)$/u;
const MISMATCH_CONTEXT_LINES = 2;

export interface SnapshotLineReference {
  line: number;
  id: string;
}

export function computeSnapshotLineId(line: number, content: string): string {
  const hash = createHash("sha256");
  hash.update(`${line}\0`);
  hash.update(content);
  return hash.digest("hex").slice(0, 4).toUpperCase();
}

export function formatSnapshotLine(line: number, content: string): string {
  return `${line}#${computeSnapshotLineId(line, content)}|${content}`;
}

export function formatSnapshotReadText(text: string, firstLine: number, visibleLines: number): string {
  if (visibleLines <= 0) return text;
  const rows = text.split("\n");
  const count = Math.min(visibleLines, rows.length);
  for (let index = 0; index < count; index++) {
    const displayed = rows[index];
    const withoutCr = displayed.endsWith("\r") ? displayed.slice(0, -1) : displayed;
    const content = firstLine + index === 1 && withoutCr.startsWith("\uFEFF") ? withoutCr.slice(1) : withoutCr;
    const rendered = firstLine + index === 1 && withoutCr.startsWith("\uFEFF") ? `\uFEFF${content}` : content;
    rows[index] = `${firstLine + index}#${computeSnapshotLineId(firstLine + index, content)}|${rendered}${displayed.endsWith("\r") ? "\r" : ""}`;
  }
  return rows.join("\n");
}

export function restoreSnapshotReadText(text: string): string {
  const rows = text.split("\n");
  let expectedLine: number | undefined;
  for (let index = 0; index < rows.length; index++) {
    const match = DISPLAYED_LINE_PATTERN.exec(rows[index]);
    if (!match) break;
    const line = Number(match[1]);
    if (!Number.isSafeInteger(line) || (expectedLine !== undefined && line !== expectedLine)) break;
    rows[index] = `${match[2]}${match[3]}`;
    expectedLine = line + 1;
  }
  return rows.join("\n");
}

export function parseSnapshotLineReference(value: string, field: string): SnapshotLineReference {
  if (value.includes("\n")) {
    throw new Error(`[SNAPSHOT_EDIT_INVALID] ${field} must be an exact LINE#ID copied from read, for example "33#6D08"; source text, line numbers alone, and multi-line values are invalid.`);
  }
  let candidate = value.trim();
  const mismatchPrefix = candidate.startsWith(">>> ");
  if (mismatchPrefix) candidate = candidate.slice(4);
  const separator = candidate.indexOf("|");
  if (mismatchPrefix && separator < 0) {
    throw new Error(`[SNAPSHOT_EDIT_INVALID] ${field} must be an exact LINE#ID copied from read, for example "33#6D08"; source text and line numbers alone are invalid.`);
  }
  if (separator >= 0) candidate = candidate.slice(0, separator);
  const match = LINE_ID_PATTERN.exec(candidate);
  if (!match) {
    throw new Error(`[SNAPSHOT_EDIT_INVALID] ${field} must be an exact LINE#ID copied from read, for example "33#6D08"; source text and line numbers alone are invalid.`);
  }
  const line = Number(match[1]);
  if (!Number.isSafeInteger(line)) {
    throw new Error(`[SNAPSHOT_EDIT_INVALID] ${field} line number is not a safe integer.`);
  }
  return { line, id: match[2] };
}

export function findUniqueSnapshotLineSuggestion(
  id: string,
  firstSeenLine: number,
  lastSeenLine: number,
  contentAt: (line: number) => string | undefined,
): string | undefined {
  let suggestion: string | undefined;
  for (let line = firstSeenLine; line <= lastSeenLine; line++) {
    const content = contentAt(line);
    if (content === undefined || computeSnapshotLineId(line, content) !== id) continue;
    if (suggestion !== undefined) return undefined;
    suggestion = `${line}#${id}`;
  }
  return suggestion;
}

function lineContent(lines: readonly string[], line: number): string {
  return lines[line - 1] ?? "";
}

function mismatchContext(lines: readonly string[], line: number, firstSeenLine: number, lastSeenLine: number): string {
  const low = Math.max(firstSeenLine, line - MISMATCH_CONTEXT_LINES);
  const high = Math.min(lastSeenLine, line + MISMATCH_CONTEXT_LINES);
  if (low > high) return "";
  const output: string[] = [];
  for (let current = low; current <= high; current++) {
    const marker = current === line ? ">>> " : "    ";
    output.push(`${marker}${formatSnapshotLine(current, lineContent(lines, current))}`);
  }
  return output.join("\n");
}

export function validateSnapshotLineReference(
  value: string,
  field: string,
  lines: readonly string[],
  firstSeenLine: number,
  lastSeenLine: number,
): number {
  const reference = parseSnapshotLineReference(value, field);
  if (reference.line < 1 || reference.line > lines.length) {
    throw new Error(`[SNAPSHOT_EDIT_INVALID] ${field} line ${reference.line} is outside the file.`);
  }
  if (reference.line < firstSeenLine || reference.line > lastSeenLine) {
    throw new Error(`[SNAPSHOT_EDIT_UNSEEN] ${field} line ${reference.line} is outside observed lines ${firstSeenLine}-${lastSeenLine}.`);
  }
  const actual = computeSnapshotLineId(reference.line, lineContent(lines, reference.line));
  if (actual !== reference.id) {
    const context = mismatchContext(lines, reference.line, firstSeenLine, lastSeenLine);
    const suggestion = findUniqueSnapshotLineSuggestion(reference.id, firstSeenLine, lastSeenLine, (line) => lineContent(lines, line));
    throw new Error(
      `[SNAPSHOT_EDIT_MISMATCH] ${field} ${value} does not match the immutable snapshot.${suggestion ? ` Did you mean ${suggestion}?` : ""} Copy the updated LINE#ID below.${context ? `\n${context}` : ""}`,
    );
  }
  return reference.line;
}

export function stripCopiedSnapshotPrefixes(lines: readonly string[]): string[] {
  const nonEmpty = lines.filter((line) => line.length > 0);
  if (nonEmpty.length === 0 || !nonEmpty.every((line) => DISPLAYED_LINE_PATTERN.test(line))) return [...lines];
  return lines.map((line) => {
    if (line.length === 0) return line;
    const match = DISPLAYED_LINE_PATTERN.exec(line);
    if (!match) return line;
    const content = match[2];
    return match[1] === "1" && content.startsWith("\uFEFF") ? content.slice(1) : content;
  });
}
