import { dirname, extname, join } from "node:path";
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
const TYPESCRIPT_ENTRY = pathToFileURL(join(dirname(process.execPath), "node_modules", "typescript", "lib", "typescript.js")).href;
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
  typescriptPromise ??= import(TYPESCRIPT_ENTRY) as Promise<TypeScriptModule>;
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

function lineNumberAt(text: string, offset: number): number {
  let line = 1;
  const end = Math.min(Math.max(0, offset), text.length);
  for (let index = 0; index < end; index++) if (text.charCodeAt(index) === 10) line += 1;
  return line;
}

export async function assertNoNewSyntaxDiagnostics(path: string, before: string, after: string): Promise<void> {
  if (!GUARDED_EXTENSIONS.has(extname(path).toLowerCase())) return;
  let ts: TypeScriptModule;
  try {
    ts = await typescript();
  } catch (error) {
    const cause = error instanceof Error ? error.message : String(error);
    throw new Error(`[SNAPSHOT_EDIT_SYNTAX] TypeScript parser is unavailable; refusing an unchecked JavaScript/TypeScript snapshot edit: ${cause}`);
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
  const line = lineNumberAt(after, first.start);
  throw new Error(
    `[SNAPSHOT_EDIT_SYNTAX] Edit would introduce ${introduced.length} TypeScript/JavaScript syntax diagnostic(s). First at line ${line}: TS${first.code} ${first.message}`,
  );
}
