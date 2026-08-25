import * as fs from "node:fs";
import * as path from "node:path";
import {
  SESSION_ANCHOR_DATE_ONLY_PATTERN,
  SESSION_ANCHOR_FIELD_PATTERN,
  SESSION_ANCHOR_LIST_ITEM_PATTERN,
  SESSION_ANCHOR_POSITIVE_INTEGER_PATTERN,
  SESSION_ANCHOR_REQUEST_LINE_PATTERN,
} from "./session-anchor-regex.js";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;
const DEFAULT_MAX_FILES = 5000;
const DEFAULT_MAX_LINES = 500000;
const MAX_CONFIGURED_FILES = 100000;
const MAX_CONFIGURED_LINES = 5000000;
const MAX_DISCOVERY_ENTRIES = 100000;
const MAX_REQUEST_CHARS = 64 * 1024;
const MAX_QUERY_TERMS = 256;
const MAX_QUERY_TERM_CHARS = 1024;
const MAX_CWD_CHARS = 4096;
const MAX_JSONL_LINE_CHARS = 1024 * 1024;
const MAX_EVENT_NODES = 100000;
const LIST_FIELDS = new Set(["all", "any", "exclude"]);
const VALUE_FIELDS = new Set(["from", "to", "cwd", "limit"]);
const REQUEST_FIELD_SCRATCH = new Map<string, string>();
const REQUEST_SEEN_FIELD_SCRATCH = new Set<string>();

export interface SessionAnchorRange {
  path: string;
  startLine: number;
  endLine: number;
  sessionId?: string;
  cwd?: string;
  startTime?: string;
  endTime?: string;
  score?: number;
  reason: string;
}

export interface SessionAnchorSearchResult {
  success: boolean;
  ranges: SessionAnchorRange[];
  message?: string;
}

export interface SessionAnchorSearchOptions {
  sessionsDir?: string;
  maxFiles?: number;
  maxLines?: number;
}

interface ParsedAnchorRequest {
  fromMs?: number;
  toMs?: number;
  cwd?: string;
  limit: number;
  all: string[];
  any: string[];
  exclude: string[];
  allLower: string[];
  anyLower: string[];
  excludeLower: string[];
  hasTimeConstraint: boolean;
  hasTextConstraint: boolean;
}

interface PendingRange {
  path: string;
  startLine: number;
  endLine: number;
  sessionId?: string;
  cwd?: string;
  startTime?: string;
  endTime?: string;
  score: number;
  reason: string;
  sortTimeMs: number;
  excluded: boolean;
}

interface TextCollectionScratch {
  parts: string[];
  values: unknown[];
  keys: Array<string | undefined>;
}

export async function searchSessionAnchors(
  markdown: string,
  options: SessionAnchorSearchOptions = {},
): Promise<SessionAnchorSearchResult> {
  const parsed = parseMarkdownRequest(markdown);
  if (!parsed.success) {
    return { success: false, ranges: [], message: parsed.message };
  }

  if (!options.sessionsDir) {
    return { success: false, ranges: [], message: "sessionsDir is required" };
  }

  if (!fs.existsSync(options.sessionsDir)) {
    return { success: false, ranges: [], message: `sessionsDir does not exist: ${options.sessionsDir}` };
  }

  const maxFiles = normalizeScanLimit(options.maxFiles, DEFAULT_MAX_FILES, MAX_CONFIGURED_FILES);
  const maxLines = normalizeScanLimit(options.maxLines, DEFAULT_MAX_LINES, MAX_CONFIGURED_LINES);
  if (maxFiles === undefined || maxLines === undefined) {
    return { success: false, ranges: [], message: "maxFiles and maxLines must be positive safe integers." };
  }

  const discovered = await findJsonlFiles(options.sessionsDir, maxFiles);
  if (!discovered.success) {
    return {
      success: false,
      ranges: [],
      message: discovered.message,
    };
  }
  const files = discovered.files;
  files.sort();

  const ranges = new BoundedRangeCollector(parsed.request.limit, parsed.request.hasTextConstraint);
  const textScratch: TextCollectionScratch = { parts: [], values: [], keys: [] };
  let scannedLines = 0;

  for (let fileIndex = 0; fileIndex < files.length; fileIndex++) {
    const file = files[fileIndex]!;
    const remainingLines = maxLines - scannedLines;
    const fileResult = await searchJsonlFile(
      file,
      parsed.request,
      remainingLines,
      scannedLines,
      maxLines,
      ranges,
      textScratch,
    );
    if (!fileResult.success) {
      return { success: false, ranges: [], message: fileResult.message };
    }
    scannedLines += fileResult.scannedLines;
  }

  const limited = ranges.toResults();

  return {
    success: true,
    ranges: limited,
    message: limited.length === 0 ? "No matching session anchors found." : undefined,
  };
}

function normalizeScanLimit(value: number | undefined, fallback: number, hardMaximum: number): number | undefined {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value <= 0) return undefined;
  return Math.min(value, hardMaximum);
}

function parseMarkdownRequest(markdown: string): { success: true; request: ParsedAnchorRequest } | { success: false; message: string } {
  REQUEST_FIELD_SCRATCH.clear();
  REQUEST_SEEN_FIELD_SCRATCH.clear();
  try {
    return parseMarkdownRequestWithScratch(markdown, REQUEST_FIELD_SCRATCH, REQUEST_SEEN_FIELD_SCRATCH);
  } finally {
    REQUEST_FIELD_SCRATCH.clear();
    REQUEST_SEEN_FIELD_SCRATCH.clear();
  }
}

function parseMarkdownRequestWithScratch(
  markdown: string,
  fields: Map<string, string>,
  seen: Set<string>,
): { success: true; request: ParsedAnchorRequest } | { success: false; message: string } {
  if (!markdown || markdown.trim().length === 0) {
    return { success: false, message: "markdown is required" };
  }
  if (markdown.length > MAX_REQUEST_CHARS) {
    return { success: false, message: `markdown exceeds ${MAX_REQUEST_CHARS} characters` };
  }

  const lists: Record<"all" | "any" | "exclude", string[]> = { all: [], any: [], exclude: [] };
  let currentList: "all" | "any" | "exclude" | null = null;
  let termCount = 0;

  const lines = markdown.split(SESSION_ANCHOR_REQUEST_LINE_PATTERN);
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;

    const fieldMatch = SESSION_ANCHOR_FIELD_PATTERN.exec(trimmed);
    if (fieldMatch) {
      const field = fieldMatch[1];
      const value = fieldMatch[2];

      if (!VALUE_FIELDS.has(field) && !LIST_FIELDS.has(field)) {
        return {
          success: false,
          message: `Invalid field '${field}'. Supported fields: from, to, cwd, limit, all, any, exclude.`,
        };
      }
      if (seen.has(field)) {
        return { success: false, message: `Duplicate field '${field}'. Keep one value.` };
      }
      seen.add(field);

      if (LIST_FIELDS.has(field)) {
        if (value.trim().length > 0) {
          return { success: false, message: `Invalid list section '${field}'. Use '${field}:' followed by '- item' lines.` };
        }
        currentList = field as "all" | "any" | "exclude";
      } else {
        fields.set(field, value.trim());
        currentList = null;
      }
      continue;
    }

    const listMatch = SESSION_ANCHOR_LIST_ITEM_PATTERN.exec(trimmed);
    if (listMatch && currentList) {
      const term = listMatch[1].trim();
      if (term.length === 0) {
        return { success: false, message: `Empty term in '${currentList}'. Remove it or provide text.` };
      }
      if (term.length > MAX_QUERY_TERM_CHARS) {
        return { success: false, message: `Term in '${currentList}' exceeds ${MAX_QUERY_TERM_CHARS} characters.` };
      }
      termCount++;
      if (termCount > MAX_QUERY_TERMS) {
        return { success: false, message: `Request exceeds the limit of ${MAX_QUERY_TERMS} search terms.` };
      }
      lists[currentList].push(term);
      continue;
    }

    if (listMatch && !currentList) {
      return { success: false, message: "List item found outside all, any, or exclude section." };
    }

    return { success: false, message: `Invalid markdown line: ${trimmed}` };
  }

  const limitValue = fields.get("limit");
  let limit = DEFAULT_LIMIT;
  if (limitValue !== undefined) {
    if (!SESSION_ANCHOR_POSITIVE_INTEGER_PATTERN.test(limitValue)) {
      return { success: false, message: "Invalid limit. Use a positive integer." };
    }
    const parsedLimit = Number(limitValue);
    if (!Number.isSafeInteger(parsedLimit) || parsedLimit <= 0) {
      return { success: false, message: "Invalid limit. Use a positive integer." };
    }
    limit = Math.min(parsedLimit, MAX_LIMIT);
  }

  const fromValue = fields.get("from");
  const toValue = fields.get("to");
  const fromMs = fromValue === undefined ? undefined : parseDateTime(fromValue, "from");
  if (fromMs === null) return { success: false, message: "Invalid from. Use YYYY-MM-DD or an ISO timestamp." };
  const toMs = toValue === undefined ? undefined : parseDateTime(toValue, "to");
  if (toMs === null) return { success: false, message: "Invalid to. Use YYYY-MM-DD or an ISO timestamp." };
  if (fromMs !== undefined && toMs !== undefined && fromMs > toMs) {
    return { success: false, message: "Invalid time window. 'from' must be before or equal to 'to'." };
  }

  const cwd = fields.get("cwd");
  if (fields.has("cwd") && (!cwd || cwd.trim().length === 0 || cwd.length > MAX_CWD_CHARS)) {
    return { success: false, message: `Invalid cwd. Provide a non-empty path up to ${MAX_CWD_CHARS} characters.` };
  }
  const all = lists.all;
  const any = lists.any;
  const exclude = lists.exclude;
  const hasTimeConstraint = fromMs !== undefined || toMs !== undefined;
  const hasCwdConstraint = Boolean(cwd);
  const hasTextConstraint = all.length > 0 || any.length > 0;

  if (!hasTimeConstraint && !hasCwdConstraint && !hasTextConstraint) {
    return {
      success: false,
      message: "Request needs at least one constraint: provide from/to, cwd, all, or any.",
    };
  }
  return {
    success: true,
    request: {
      fromMs,
      toMs,
      cwd,
      limit,
      all,
      any,
      exclude,
      allLower: lowercaseTerms(all),
      anyLower: lowercaseTerms(any),
      excludeLower: lowercaseTerms(exclude),
      hasTimeConstraint,
      hasTextConstraint,
    },
  };
}

function lowercaseTerms(terms: string[]): string[] {
  const result = new Array<string>(terms.length);
  for (let index = 0; index < terms.length; index++) result[index] = terms[index]!.toLowerCase();
  return result;
}

function parseDateTime(value: string, boundary: "from" | "to"): number | null {
  const dateOnly = SESSION_ANCHOR_DATE_ONLY_PATTERN.exec(value);
  if (dateOnly) {
    const year = Number(dateOnly[1]);
    const month = Number(dateOnly[2]);
    const day = Number(dateOnly[3]);
    const date = boundary === "from"
      ? new Date(year, month - 1, day, 0, 0, 0, 0)
      : new Date(year, month - 1, day, 23, 59, 59, 999);
    if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) {
      return null;
    }
    return date.getTime();
  }

  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) ? null : timestamp;
}

async function findJsonlFiles(
  root: string,
  maxFiles: number,
): Promise<{ success: true; files: string[] } | { success: false; message: string }> {
  const files: string[] = [];
  const directories = [root];
  let discoveredEntries = 0;
  while (directories.length > 0) {
    const directoryPath = directories.pop()!;
    let directory: fs.Dir;
    try {
      directory = await fs.promises.opendir(directoryPath);
    } catch (error) {
      return { success: false, message: `Failed to read session directory ${directoryPath}: ${formatError(error)}` };
    }
    try {
      while (true) {
        const entry = await directory.read();
        if (!entry) break;
        discoveredEntries++;
        if (discoveredEntries > MAX_DISCOVERY_ENTRIES) {
          return {
            success: false,
            message: `Request too broad: session discovery exceeded ${MAX_DISCOVERY_ENTRIES} filesystem entries. Narrow the session directory.`,
          };
        }
        const fullPath = path.join(directoryPath, entry.name);
        if (entry.isDirectory()) {
          directories.push(fullPath);
          continue;
        }
        if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
        files.push(fullPath);
        if (files.length > maxFiles) {
          return {
            success: false,
            message: `Request too broad: session files exceed the configured scan cap of ${maxFiles}. Add from/to, cwd, all, or any constraints.`,
          };
        }
      }
    } catch (error) {
      return { success: false, message: `Failed to read session directory ${directoryPath}: ${formatError(error)}` };
    } finally {
      try {
        await directory.close();
      } catch {
        // The handle may already be closed after a terminal read error.
      }
    }
  }
  return { success: true, files };
}

async function* readJsonlLines(filePath: string): AsyncGenerator<string> {
  const stream = fs.createReadStream(filePath, { encoding: "utf8", highWaterMark: 64 * 1024 });
  let carry = "";
  for await (const rawChunk of stream) {
    const chunk = typeof rawChunk === "string" ? rawChunk : rawChunk.toString("utf8");
    const buffer = carry ? carry + chunk : chunk;
    let lineStart = 0;
    while (true) {
      const lineFeed = buffer.indexOf("\n", lineStart);
      if (lineFeed < 0) break;
      let lineEnd = lineFeed;
      if (lineEnd > lineStart && buffer.charCodeAt(lineEnd - 1) === 0x0d) lineEnd--;
      if (lineEnd - lineStart > MAX_JSONL_LINE_CHARS) {
        throw new Error(`session line exceeds ${MAX_JSONL_LINE_CHARS} characters`);
      }
      yield buffer.slice(lineStart, lineEnd);
      lineStart = lineFeed + 1;
    }
    carry = lineStart === 0 ? buffer : buffer.slice(lineStart);
    if (carry.length > MAX_JSONL_LINE_CHARS) {
      throw new Error(`session line exceeds ${MAX_JSONL_LINE_CHARS} characters`);
    }
  }
  if (carry) yield carry;
}

async function searchJsonlFile(
  filePath: string,
  request: ParsedAnchorRequest,
  maxLines: number,
  scannedBefore: number,
  scanCap: number,
  collector: BoundedRangeCollector,
  scratch: TextCollectionScratch,
): Promise<{ success: true; scannedLines: number } | { success: false; message: string }> {
  let currentSessionId: string | undefined;
  let currentCwd: string | undefined;
  let scannedLines = 0;
  let physicalLine = 0;
  let pendingRange: PendingRange | undefined;
  try {
    for await (const line of readJsonlLines(filePath)) {
      physicalLine++;
      if (line.length === 0 || (line.charCodeAt(0) <= 0x20 && line.trim().length === 0)) continue;

      scannedLines++;
      if (scannedLines > maxLines) {
        return {
          success: false,
          message: `Request too broad: scanned ${scannedBefore + scannedLines} session lines, exceeding the configured scan cap of ${scanCap}. Add from/to, cwd, all, or any constraints.`,
        };
      }

      let event: unknown;
      try {
        event = JSON.parse(line);
      } catch {
        return { success: false, message: `Invalid JSON in ${filePath}:${physicalLine}` };
      }

      const sessionId = getSessionId(event) ?? currentSessionId;
      if (sessionId) currentSessionId = sessionId;

      const cwd = getCwd(event) ?? currentCwd;
      if (cwd) currentCwd = cwd;

      if (request.cwd && cwd !== request.cwd) continue;

      const timestamp = getTimestamp(event);
      const timestampMs = timestamp ? Date.parse(timestamp) : undefined;
      const hasValidTimestamp = timestampMs !== undefined && !Number.isNaN(timestampMs);
      if (request.hasTimeConstraint) {
        if (!hasValidTimestamp) continue;
        if (request.fromMs !== undefined && timestampMs < request.fromMs) continue;
        if (request.toMs !== undefined && timestampMs > request.toMs) continue;
      }

      const text = textualizeEvent(event, scratch);
      const lowerText = request.hasTextConstraint || request.excludeLower.length > 0 ? text.toLowerCase() : "";
      const termScore = scoreTerms(lowerText, request);
      if (request.hasTextConstraint && termScore === 0) continue;

      if (!request.hasTextConstraint && !hasValidTimestamp) continue;

      const reason = buildReason(request, lowerText);
      const excluded = containsAny(lowerText, request.excludeLower);
      if (
        pendingRange &&
        pendingRange.endLine + 1 === physicalLine &&
        pendingRange.reason === reason
      ) {
        pendingRange.endLine = physicalLine;
        pendingRange.score += request.hasTextConstraint ? termScore : 1;
        pendingRange.excluded ||= excluded;
        pendingRange.sessionId ??= sessionId;
        pendingRange.cwd ??= cwd;
        if (!pendingRange.startTime && hasValidTimestamp) {
          pendingRange.startTime = timestamp;
          pendingRange.sortTimeMs = timestampMs;
        }
        if (hasValidTimestamp) pendingRange.endTime = timestamp;
        continue;
      }

      const reusableRange = pendingRange ? collector.offer(pendingRange) : undefined;
      pendingRange = resetPendingRange(
        reusableRange,
        filePath,
        physicalLine,
        sessionId,
        cwd,
        hasValidTimestamp ? timestamp : undefined,
        hasValidTimestamp ? timestampMs : undefined,
        request.hasTextConstraint ? termScore : 1,
        reason,
        excluded,
      );
    }
  } catch (error) {
    return { success: false, message: `Failed to scan ${filePath}: ${formatError(error)}` };
  }

  if (pendingRange) collector.offer(pendingRange);
  return { success: true, scannedLines };
}

function resetPendingRange(
  range: PendingRange | undefined,
  filePath: string,
  lineNumber: number,
  sessionId: string | undefined,
  cwd: string | undefined,
  timestamp: string | undefined,
  timestampMs: number | undefined,
  score: number,
  reason: string,
  excluded: boolean,
): PendingRange {
  const target = range ?? ({} as PendingRange);
  target.path = filePath;
  target.startLine = lineNumber;
  target.endLine = lineNumber;
  target.sessionId = sessionId;
  target.cwd = cwd;
  target.startTime = timestamp;
  target.endTime = timestamp;
  target.score = score;
  target.reason = reason;
  target.sortTimeMs = timestampMs ?? Number.NaN;
  target.excluded = excluded;
  return target;
}

function compareRanges(left: PendingRange, right: PendingRange, textConstrained: boolean): number {
  if (textConstrained && right.score !== left.score) return right.score - left.score;
  const timeCompare = left.sortTimeMs - right.sortTimeMs;
  if (!Number.isNaN(timeCompare) && timeCompare !== 0) return timeCompare;
  const pathCompare = left.path < right.path ? -1 : left.path > right.path ? 1 : 0;
  return pathCompare !== 0 ? pathCompare : left.startLine - right.startLine;
}

class BoundedRangeCollector {
  private readonly ranges: PendingRange[] = [];

  constructor(
    private readonly limit: number,
    private readonly textConstrained: boolean,
  ) {}

  offer(range: PendingRange): PendingRange | undefined {
    if (range.excluded) return range;
    let low = 0;
    let high = this.ranges.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (compareRanges(range, this.ranges[middle]!, this.textConstrained) < 0) high = middle;
      else low = middle + 1;
    }
    if (low >= this.limit) return range;

    if (this.ranges.length < this.limit) {
      this.ranges.push(range);
      for (let index = this.ranges.length - 1; index > low; index--) {
        this.ranges[index] = this.ranges[index - 1]!;
      }
      this.ranges[low] = range;
      return undefined;
    }

    const reusable = this.ranges[this.ranges.length - 1]!;
    for (let index = this.ranges.length - 1; index > low; index--) {
      this.ranges[index] = this.ranges[index - 1]!;
    }
    this.ranges[low] = range;
    return reusable;
  }

  toResults(): SessionAnchorRange[] {
    const results = new Array<SessionAnchorRange>(this.ranges.length);
    for (let index = 0; index < this.ranges.length; index++) {
      const range = this.ranges[index]!;
      results[index] = {
        path: range.path,
        startLine: range.startLine,
        endLine: range.endLine,
        sessionId: range.sessionId,
        cwd: range.cwd,
        startTime: range.startTime,
        endTime: range.endTime,
        score: range.score,
        reason: range.reason,
      };
    }
    return results;
  }
}

function scoreTerms(lowerText: string, request: ParsedAnchorRequest): number {
  for (let index = 0; index < request.allLower.length; index++) {
    if (!lowerText.includes(request.allLower[index]!)) return 0;
  }
  let matchedAny = 0;
  for (let index = 0; index < request.anyLower.length; index++) {
    if (lowerText.includes(request.anyLower[index]!)) matchedAny++;
  }
  if (request.anyLower.length > 0 && matchedAny === 0) return 0;
  if (request.allLower.length === 0 && request.anyLower.length === 0) return 1;
  return request.allLower.length * 2 + matchedAny;
}

function buildReason(request: ParsedAnchorRequest, lowerText: string): string {
  if (!request.hasTextConstraint) {
    if (request.hasTimeConstraint && request.cwd) return "cwd+time window";
    if (request.hasTimeConstraint) return "time window";
    return "cwd";
  }

  let reason = request.all.length > 0 ? `matched all: ${request.all.join(", ")}` : "";
  let matchedAnyText = "";
  for (let index = 0; index < request.anyLower.length; index++) {
    if (!lowerText.includes(request.anyLower[index]!)) continue;
    matchedAnyText += matchedAnyText ? `, ${request.any[index]!}` : request.any[index]!;
  }
  if (matchedAnyText) reason += reason ? `; matched any: ${matchedAnyText}` : `matched any: ${matchedAnyText}`;
  return reason;
}

function containsAny(lowerText: string, lowerTerms: string[]): boolean {
  for (let index = 0; index < lowerTerms.length; index++) {
    if (lowerText.includes(lowerTerms[index]!)) return true;
  }
  return false;
}

function getTimestamp(event: unknown): string | undefined {
  if (!isRecord(event)) return undefined;
  if (typeof event.timestamp === "string") return event.timestamp;
  if (isRecord(event.message) && typeof event.message.timestamp === "string") return event.message.timestamp;
  return undefined;
}

function getSessionId(event: unknown): string | undefined {
  if (!isRecord(event)) return undefined;
  if (typeof event.sessionId === "string") return event.sessionId;
  if (typeof event.session_id === "string") return event.session_id;
  if (event.type === "session" && typeof event.id === "string") return event.id;
  if (isRecord(event.session) && typeof event.session.id === "string") return event.session.id;
  return undefined;
}

function getCwd(event: unknown): string | undefined {
  if (!isRecord(event)) return undefined;
  if (typeof event.cwd === "string") return event.cwd;
  if (isRecord(event.session) && typeof event.session.cwd === "string") return event.session.cwd;
  return undefined;
}

const METADATA_TEXT_KEYS = new Set([
  "type",
  "id",
  "parentId",
  "sessionId",
  "session_id",
  "timestamp",
  "cwd",
  "role",
  "customType",
]);

function textualizeEvent(event: unknown, scratch: TextCollectionScratch): string {
  const parts = scratch.parts;
  const values = scratch.values;
  const keys = scratch.keys;
  parts.length = 0;
  values.length = 1;
  values[0] = event;
  keys.length = 1;
  keys[0] = undefined;
  let visitedNodes = 0;

  while (values.length > 0) {
    const stackIndex = values.length - 1;
    const value = values[stackIndex];
    const key = keys[stackIndex];
    values.length = stackIndex;
    keys.length = stackIndex;
    visitedNodes++;
    if (visitedNodes > MAX_EVENT_NODES) throw new Error(`session event exceeds ${MAX_EVENT_NODES} values`);

    if (typeof value === "string") {
      if (!key || !METADATA_TEXT_KEYS.has(key)) parts.push(value);
      continue;
    }

    if (Array.isArray(value)) {
      for (let index = value.length - 1; index >= 0; index--) {
        values.push(value[index]);
        keys.push(key);
      }
      continue;
    }

    if (!isRecord(value)) continue;
    const childKeys = Object.keys(value);
    for (let index = childKeys.length - 1; index >= 0; index--) {
      const childKey = childKeys[index]!;
      values.push(value[childKey]);
      keys.push(childKey);
    }
  }

  return parts.join("\n");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
