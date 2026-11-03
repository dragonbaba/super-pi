import { createRequire } from "node:module";
import { extname } from "node:path";
import { pathToFileURL } from "node:url";

interface SyntaxDiagnostic {
  code: number;
  start: number;
  message: string;
}

interface TypeScriptModule {
  ScriptTarget: { Latest: unknown };
  ScriptKind: Record<string, unknown>;
  createSourceFile(path: string, text: string, target: unknown, setParentNodes: boolean, scriptKind?: unknown): {
    parseDiagnostics: readonly {
      code: number;
      start?: number;
      messageText: string | { messageText: string };
    }[];
  };
  flattenDiagnosticMessageText(message: unknown, newline: string): string;
}
const GUARDED_EXTENSIONS = new Set([".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".mts", ".cts"]);
let typescriptPromise: Promise<TypeScriptModule> | undefined;

function scriptKindFor(ts: TypeScriptModule, path: string): unknown {
  switch (extname(path).toLowerCase()) {
    case ".js": return ts.ScriptKind.JS;
    case ".jsx": return ts.ScriptKind.JSX;
    case ".mjs": return ts.ScriptKind.JS;
    case ".cjs": return ts.ScriptKind.JS;
    case ".tsx": return ts.ScriptKind.TSX;
    case ".mts": return ts.ScriptKind.TS;
    case ".cts": return ts.ScriptKind.TS;
    default: return ts.ScriptKind.TS;
  }
}

async function typescript(): Promise<TypeScriptModule> {
  // Resolve the pinned host dependency, never a parser from the target project or Node installation.
  typescriptPromise ??= import(pathToFileURL(createRequire(import.meta.url).resolve("typescript")).href) as Promise<TypeScriptModule>;
  return typescriptPromise;
}

function diagnosticKey(diagnostic: SyntaxDiagnostic): string {
  return `${diagnostic.code}:${diagnostic.message}`;
}

function collectDiagnostics(ts: TypeScriptModule, path: string, text: string): SyntaxDiagnostic[] {
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, false, scriptKindFor(ts, path));
  return source.parseDiagnostics.map((diagnostic) => ({
    code: diagnostic.code,
    start: diagnostic.start ?? 0,
    message: ts.flattenDiagnosticMessageText(diagnostic.messageText, " "),
  }));
}

function locationAt(text: string, offset: number): { line: number; column: number } {
  let line = 1;
  let lineStart = 0;
  const end = Math.min(Math.max(0, offset), text.length);
  for (let index = 0; index < end; index++) {
    if (text.charCodeAt(index) === 10) { line += 1; lineStart = index + 1; }
  }
  return { line, column: end - lineStart + 1 };
}

export async function assertNoNewSyntaxDiagnostics(
  path: string, before: string, after: string,
  edits?: readonly { start: string; end?: string; newLines?: string[] }[],
  byteEdits?: readonly { index: number; start: number; end: number; replacement: Buffer }[],
): Promise<void> {
  if (!GUARDED_EXTENSIONS.has(extname(path).toLowerCase())) return;
  let ts: TypeScriptModule;
  try {
    ts = await typescript();
  } catch {
    throw new Error("[SNAPSHOT_EDIT_SYNTAX] TypeScript parser is unavailable. No change; the candidate was not checked.\nRetry: restore the host TypeScript dependency, then resubmit with a still-current snapshot.");
  }
  const beforeCounts = new Map<string, number>();
  for (const diagnostic of collectDiagnostics(ts, path, before)) {
    const key = diagnosticKey(diagnostic);
    beforeCounts.set(key, (beforeCounts.get(key) ?? 0) + 1);
  }
  const introduced = collectDiagnostics(ts, path, after).filter((diagnostic) => {
    const key = diagnosticKey(diagnostic);
    const remaining = beforeCounts.get(key) ?? 0;
    if (remaining === 0) return true;
    beforeCounts.set(key, remaining - 1);
    return false;
  });
  if (introduced.length === 0) return;
  const first = introduced[0];
  const location = locationAt(after, first.start);
  const payload = payloadLocation(before, after, first.start, edits, byteEdits);
  let scope = "";
  for (let slot = 0; slot < Math.min(edits?.length ?? 0, 3); slot++) {
    const index = slot === 2 && payload && payload.editIndex > 2 ? payload.editIndex : slot;
    const edit = edits![index];
    // Only caller-supplied, validated original coordinates; never mint candidate anchors.
    const start = parseInt(edit.start.trim().replace(/^>>> /u, ""), 10);
    const end = edit.end === undefined ? start : parseInt(edit.end.trim().replace(/^>>> /u, ""), 10);
    if (Number.isSafeInteger(start) && Number.isSafeInteger(end)) scope += ` edits[${index}] original lines ${start}-${end};`;
  }
  throw new Error(
    `[SNAPSHOT_EDIT_SYNTAX] No change. ${introduced.length} new syntax diagnostic(s); first at candidate line ${location.line}, column ${location.column}: TS${first.code} ${first.message.slice(0, 400)}\n${payload ? `Diagnostic falls in edits[${payload.editIndex}].newLines[${payload.lineIndex}] (zero-based indices). ` : ""}Candidate coordinates are not original read anchors; later diagnostics may cascade.${scope}\nRetry: correct the request using the existing snapshot if still current; stale or consumed snapshots require read.`,
  );
}

// Failure-only mapping: TypeScript offsets are UTF-16, prepared offsets are UTF-8 bytes.
// Reuse the validated, sorted byte edits; do not retain a second before/after source.
function payloadLocation(
  before: string, after: string, offset: number,
  edits: readonly { newLines?: string[] }[] | undefined,
  byteEdits: readonly { index: number; start: number; end: number; replacement: Buffer }[] | undefined,
): { editIndex: number; lineIndex: number } | undefined {
  if (!edits || !byteEdits) return undefined;
  let byteOffset = 0;
  for (let i = 0; i < offset; i++) {
    const code = after.charCodeAt(i);
    if (code < 0x80) byteOffset++;
    else if (code < 0x800) byteOffset += 2;
    else if (code >= 0xd800 && code <= 0xdbff && i + 1 < after.length && after.charCodeAt(i + 1) >= 0xdc00 && after.charCodeAt(i + 1) <= 0xdfff) {
      if (i + 1 === offset) return undefined; // Never attribute an offset inside a surrogate pair.
      byteOffset += 4; i++;
    } else byteOffset += 3;
  }
  let shift = 0;
  for (const edit of byteEdits) {
    const start = edit.start + shift;
    if (byteOffset >= start && byteOffset < start + edit.replacement.length) {
      const lines = edits[edit.index]?.newLines;
      if (!lines) return undefined;
      let line = 0;
      for (let i = 0; i < byteOffset - start; i++) if (edit.replacement[i] === 10) line++;
      // insert_after at unterminated EOF adds a separator before the payload.
      if (edit.start === edit.end && !before.endsWith("\n") && edit.start === Buffer.byteLength(before, "utf8") && (edit.replacement[0] === 10 || (edit.replacement[0] === 13 && edit.replacement[1] === 10))) line--;
      return line >= 0 && line < lines.length ? { editIndex: edit.index, lineIndex: line } : undefined;
    }
    shift += edit.replacement.length - (edit.end - edit.start);
  }
  return undefined;
}
