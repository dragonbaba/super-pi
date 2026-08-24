import { createHash } from "node:crypto";
import { open, realpath } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { TextDecoder } from "node:util";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  type ReadToolInput,
} from "@super-pi/coding-agent";

export const MAX_COMPACT_FILE_BYTES = 32 * 1024 * 1024;
export const MAX_COMPACT_SCRIPT_BYTES = 4 * 1024 * 1024;
export const MAX_COMPACT_RESIDENT_BYTES = 128 * 1024;
const COMPACT_SCAN_CHUNK_BYTES = 64 * 1024;
// Resident accounting includes bounded text plus a conservative per-line metadata estimate.
const COMPACT_LINE_METADATA_BYTES = 56;
const COMPACT_FIXED_METADATA_BYTES = 512;
const SCRIPT_EXTENSIONS = new Set([".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".mts", ".cts"]);
const strictUtf8Decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

export interface CompactFileIdentity {
  dev: bigint;
  ino: bigint;
  size: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
}

export interface CompactCapturedLine {
  line: number;
  start: number;
  contentEnd: number;
  end: number;
  eol: "\n" | "\r\n" | "";
  text: string;
}

export interface CompactCapture {
  canonicalPath: string;
  identity: CompactFileIdentity;
  sha256: string;
  fileBytes: number;
  totalLines: number;
  bomBytes: 0 | 3;
  firstSeenLine: number;
  lastSeenLine: number;
  visibleLines: CompactCapturedLine[];
  beforeBoundary?: CompactCapturedLine;
  afterBoundary?: CompactCapturedLine;
  residentBytes: number;
  projectedText: string;
}

export interface CompactCaptureHooks {
  afterScan?: () => void | Promise<void>;
}

function identityFromStat(info: Awaited<ReturnType<Awaited<ReturnType<typeof open>>["stat"]>>): CompactFileIdentity {
  const bigint = info as unknown as CompactFileIdentity;
  return { dev: bigint.dev, ino: bigint.ino, size: bigint.size, mtimeNs: bigint.mtimeNs, ctimeNs: bigint.ctimeNs };
}

function sameCaptureState(left: CompactFileIdentity, right: CompactFileIdentity): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}

export function compactFileLimit(path: string): number {
  return SCRIPT_EXTENSIONS.has(extname(path).toLowerCase()) ? MAX_COMPACT_SCRIPT_BYTES : MAX_COMPACT_FILE_BYTES;
}

function nativeLineText(line: CompactCapturedLine): string {
  return line.eol === "\r\n" ? `${line.text}\r` : line.text;
}

function storedResidentBytes(lines: readonly CompactCapturedLine[]): number {
  let bytes = COMPACT_FIXED_METADATA_BYTES;
  for (const line of lines) bytes += Buffer.byteLength(line.text, "utf8") + COMPACT_LINE_METADATA_BYTES;
  return bytes;
}

export async function captureCompactSnapshot(
  path: string,
  input: ReadToolInput,
  displayed: string,
  hooks: CompactCaptureHooks = {},
): Promise<CompactCapture | undefined> {
  const canonicalPath = await realpath(resolve(path));
  const handle = await open(canonicalPath, "r");
  try {
    const beforeInfo = await handle.stat({ bigint: true });
    if (!beforeInfo.isFile()) return undefined;
    const before = identityFromStat(beforeInfo);
    const fileBytes = Number(before.size);
    if (!Number.isSafeInteger(fileBytes)
      || fileBytes <= 2 * 1024 * 1024
      || fileBytes > compactFileLimit(canonicalPath)) return undefined;

    const startLine = input.offset ? Math.max(1, Math.floor(input.offset)) : 1;
    const requestedLimit = input.limit === undefined ? undefined : Math.max(0, Math.floor(input.limit));
    if (requestedLimit === 0) return undefined;

    const hash = createHash("sha256");
    const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
    const buffer = Buffer.allocUnsafe(COMPACT_SCAN_CHUNK_BYTES);
    const visibleLines: CompactCapturedLine[] = [];
    let beforeBoundary: CompactCapturedLine | undefined;
    let afterBoundary: CompactCapturedLine | undefined;
    let lineParts: Buffer[] = [];
    let lineBytes = 0;
    let lineStart = 0;
    let lineNumber = 1;
    let newlineCount = 0;
    let position = 0;
    let previousByteWasCr = false;
    let invalid = false;
    let truncatedBy: "lines" | "bytes" | undefined;
    let outputBytes = 0;
    let selectionStopped = false;
    let captureCurrentLine = startLine <= 2;
    let firstBytes = Buffer.alloc(0);

    const appendLineBytes = (part: Buffer): void => {
      if (!captureCurrentLine || part.length === 0) return;
      lineBytes += part.length;
      if (lineBytes > MAX_COMPACT_RESIDENT_BYTES) {
        invalid = true;
        return;
      }
      lineParts.push(Buffer.from(part));
    };

    const finishLine = (end: number, eol: CompactCapturedLine["eol"]): void => {
      let raw = lineParts.length === 1 ? lineParts[0] : Buffer.concat(lineParts, lineBytes);
      const terminatorBytes = eol === "\r\n" ? 2 : eol === "\n" ? 1 : 0;
      let start = lineStart;
      let contentEnd = end - terminatorBytes;
      if (lineNumber === 1 && raw.length >= 3 && raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf) {
        raw = raw.subarray(3);
        start += 3;
      }
      const contentLength = raw.length - terminatorBytes;
      let line: CompactCapturedLine | undefined;
      if (captureCurrentLine) {
        try {
          line = { line: lineNumber, start, contentEnd, end, eol, text: strictUtf8Decoder.decode(raw.subarray(0, contentLength)) };
        } catch {
          invalid = true;
        }
      }
      if (line && lineNumber === startLine - 1) {
        beforeBoundary = line;
      } else if (line && lineNumber >= startLine && !selectionStopped) {
        const selectedIndex = lineNumber - startLine;
        if (requestedLimit !== undefined && selectedIndex >= requestedLimit) {
          selectionStopped = true;
          afterBoundary = line;
        } else {
          const nativeContentBytes = contentLength + (eol === "\r\n" ? 1 : 0);
          const nextBytes = outputBytes + nativeContentBytes + (visibleLines.length > 0 ? 1 : 0);
          if (visibleLines.length >= DEFAULT_MAX_LINES || nextBytes > DEFAULT_MAX_BYTES) {
            if (visibleLines.length === 0) invalid = true;
            truncatedBy = visibleLines.length >= DEFAULT_MAX_LINES ? "lines" : "bytes";
            selectionStopped = true;
            afterBoundary = line;
          } else {
            visibleLines.push(line);
            outputBytes = nextBytes;
          }
        }
      } else if (line && selectionStopped && afterBoundary === undefined) {
        afterBoundary = line;
      }
      lineNumber += 1;
      lineStart = end;
      lineParts = [];
      lineBytes = 0;
      captureCurrentLine = lineNumber >= startLine - 1 && afterBoundary === undefined;
    };

    while (position < fileBytes && !invalid) {
      const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, fileBytes - position), position);
      if (bytesRead === 0) break;
      const chunk = buffer.subarray(0, bytesRead);
      if (firstBytes.length < 3) firstBytes = Buffer.concat([firstBytes, chunk.subarray(0, 3 - firstBytes.length)]);
      hash.update(chunk);
      try {
        utf8.decode(chunk, { stream: true });
      } catch {
        invalid = true;
        break;
      }
      if (chunk.includes(0)) {
        invalid = true;
        break;
      }
      let segmentStart = 0;
      for (let index = 0; index < bytesRead; index++) {
        const byte = chunk[index];
        const absolute = position + index;
        if (previousByteWasCr && byte !== 0x0a) {
          invalid = true;
          break;
        }
        if (byte === 0x0a) {
          appendLineBytes(chunk.subarray(segmentStart, index + 1));
          if (invalid) break;
          const eol: CompactCapturedLine["eol"] = previousByteWasCr ? "\r\n" : "\n";
          previousByteWasCr = false;
          newlineCount += 1;
          finishLine(absolute + 1, eol);
          segmentStart = index + 1;
        } else {
          previousByteWasCr = byte === 0x0d;
        }
      }
      if (!invalid) appendLineBytes(chunk.subarray(segmentStart));
      position += bytesRead;
    }
    try {
      utf8.decode();
    } catch {
      invalid = true;
    }
    if (previousByteWasCr) invalid = true;
    const fileEndsWithLf = fileBytes > 0 && lineStart === fileBytes;
    if (!invalid && lineStart < fileBytes) finishLine(fileBytes, "");
    if (invalid || visibleLines.length === 0 || position !== fileBytes) return undefined;

    const nativeTotalLines = newlineCount + 1;
    if (startLine > nativeTotalLines) return undefined;
    const firstSeenLine = visibleLines[0].line;
    const lastSeenLine = visibleLines[visibleLines.length - 1].line;
    const bomBytes: 0 | 3 = firstBytes.length >= 3
      && firstBytes[0] === 0xef && firstBytes[1] === 0xbb && firstBytes[2] === 0xbf ? 3 : 0;
    let content = visibleLines.map(nativeLineText).join("\n");
    if (bomBytes === 3 && firstSeenLine === 1) content = `\uFEFF${content}`;
    const selectedSpan = requestedLimit === undefined
      ? nativeTotalLines - startLine + 1
      : Math.min(requestedLimit, nativeTotalLines - startLine + 1);
    const reachesTrailingGhost = fileEndsWithLf && startLine + selectedSpan - 1 >= nativeTotalLines;
    if (!truncatedBy && reachesTrailingGhost) {
      if (outputBytes + 1 > DEFAULT_MAX_BYTES) truncatedBy = "bytes";
      else content += "\n";
    }

    let projectedText: string;
    if (truncatedBy) {
      const nextOffset = lastSeenLine + 1;
      projectedText = truncatedBy === "lines"
        ? `${content}\n\n[Showing lines ${firstSeenLine}-${lastSeenLine} of ${nativeTotalLines}. Use offset=${nextOffset} to continue.]`
        : `${content}\n\n[Showing lines ${firstSeenLine}-${lastSeenLine} of ${nativeTotalLines} (${formatSize(DEFAULT_MAX_BYTES)} limit). Use offset=${nextOffset} to continue.]`;
    } else if (requestedLimit !== undefined && startLine - 1 + selectedSpan < nativeTotalLines) {
      const remaining = nativeTotalLines - (startLine - 1 + selectedSpan);
      projectedText = `${content}\n\n[${remaining} more lines in file. Use offset=${startLine + selectedSpan} to continue.]`;
    } else {
      projectedText = content;
    }
    if (projectedText !== displayed) return undefined;

    await hooks.afterScan?.();
    const after = identityFromStat(await handle.stat({ bigint: true }));
    if (!sameCaptureState(before, after)) return undefined;

    const storedLines = [beforeBoundary, ...visibleLines, afterBoundary].filter((line): line is CompactCapturedLine => line !== undefined);
    const residentBytes = storedResidentBytes(storedLines);
    if (residentBytes > MAX_COMPACT_RESIDENT_BYTES) return undefined;
    return {
      canonicalPath,
      identity: after,
      sha256: hash.digest("hex"),
      fileBytes,
      totalLines: nativeTotalLines,
      bomBytes,
      firstSeenLine,
      lastSeenLine,
      visibleLines,
      beforeBoundary,
      afterBoundary,
      residentBytes,
      projectedText,
    };
  } finally {
    await handle.close();
  }
}
