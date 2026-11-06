import { boundedShellInput } from "../tools/bounded-shell-input.ts";
import { extractCommandSubstitutions, prepareShellAnalysis, type CommandSubstitutionScan, type ShellAnalysisView } from "./shell-substitution.ts";
import { lexBash } from "./syntax/bash.ts";
import { DIALECT_BASH } from "./syntax/token-table.ts";
import { DIALECT_POWERSHELL, lexWindowsScript, type ShellTokenTable } from "./syntax/windows.ts";

export const MAX_ANALYSIS_ENTRIES = 128;
export const MAX_ANALYSIS_BYTES = 512 * 1024;
const MAX_NATIVE_TARGETS = 34;
const MAX_NATIVE_TARGET_CHARS = 4096;
// Existing parseShellSegments flags; this adapter does not add token classification.
const LEGACY_GLOB_EXPANSION = 16, LEGACY_HOME_EXPANSION = 32;
export interface NativeShellTarget { target: string; kind: "delete" | "write" | "move"; }
export const shellAnalysisOwnership = {
  created: 0, released: 0, liveOwners: 0, liveEntries: 0, liveBytes: 0,
  hits: 0, misses: 0, overflows: 0,
};

export interface PreparedShellAnalysis {
  view: ShellAnalysisView;
  substitutions: CommandSubstitutionScan;
  stdin: ReturnType<typeof boundedShellInput>;
  /** Language presence derived from an existing masked-command token walk. */
  heredocLanguages?: number;
}

export function analyzeShellSource(source: string): PreparedShellAnalysis {
  const stdin = source.includes("<<") ? boundedShellInput(source) : undefined;
  const view = prepareShellAnalysis(stdin?.analysisCommand ?? source);
  return { view, substitutions: extractCommandSubstitutions(view.command), stdin };
}

/** Owned by one authorization, never by a session or a final invocation token.
 * Keys include nested source, while the owner is bound to the exact root request.
 * Capacity overflow analyzes without retaining; finally releases on every exit.
 * Bytes are a conservative UTF-16 reference budget, not V8 heap measurements.
 */
export class ShellAnalysisOwner {
  private readonly entries = new Map<string, PreparedShellAnalysis>();
  /** Token tables, one per source and dialect. */
  private readonly bashTables = new Map<string, ShellTokenTable>();
  private readonly powerShellTables = new Map<string, ShellTokenTable>();
  private readonly cmdTables = new Map<string, ShellTokenTable>();
  private command: string | undefined;
  private cwd: string | undefined;
  private released = false;
  private readonly generation: number;
  retainedBytes = 0;
  hits = 0;
  misses = 0;
  overflows = 0;
  private nativeTargets?: NativeShellTarget[];
  private nativeShell?: "bash" | "powershell";
  nativePathUncertain = false;

  constructor(command: string, cwd: string, generation: number, nativeShell?: "bash" | "powershell") {
    this.command = command;
    this.cwd = cwd;
    this.generation = generation;
    this.nativeShell = nativeShell;
    if (nativeShell) this.nativeTargets = [];
    shellAnalysisOwnership.created++;
    shellAnalysisOwnership.liveOwners++;
  }

  get size(): number { return this.entries.size + this.bashTables.size + this.powerShellTables.size + this.cmdTables.size; }

  /** Tokenize a Bash source once per authorization; the lifecycle, mutation and scope scanners read the same table. */
  bashTable(source: string): ShellTokenTable {
    return this.table(source, DIALECT_BASH);
  }

  /** Tokenize a PowerShell or cmd source once per authorization; every scanner reads the same table. */
  windowsTable(source: string, dialect: number): ShellTokenTable {
    return this.table(source, dialect);
  }

  private table(source: string, dialect: number): ShellTokenTable {
    if (this.released) throw new Error("Shell analysis owner is released");
    const tables = dialect === DIALECT_BASH ? this.bashTables : dialect === DIALECT_POWERSHELL ? this.powerShellTables : this.cmdTables;
    const cached = tables.get(source);
    if (cached) { this.hits++; shellAnalysisOwnership.hits++; return cached; }
    this.misses++;
    shellAnalysisOwnership.misses++;
    const table = dialect === DIALECT_BASH ? lexBash(source) : lexWindowsScript(source, dialect);
    const bytes = table.byteLength;
    if (this.size < MAX_ANALYSIS_ENTRIES && this.retainedBytes + bytes <= MAX_ANALYSIS_BYTES) {
      tables.set(source, table);
      this.retainedBytes += bytes;
      shellAnalysisOwnership.liveEntries++;
      shellAnalysisOwnership.liveBytes += bytes;
    } else { this.overflows++; shellAnalysisOwnership.overflows++; }
    return table;
  }

  /** Observe only operands the existing scanners already recognized; never scan source here. */
  observeMutationTarget(raw: string, cwd: string, expansion: number, target: string | undefined, kind: "delete" | "write" | "move" | "contents"): void {
    const targets = this.nativeTargets;
    if (!targets) return;
    // A search/glob scope is not an exact deletion operand. Shell-internal cwd and
    // Windows Bash roots/HOME cannot borrow the legacy Node path interpretation.
    if (target === undefined || target.length >= MAX_NATIVE_TARGET_CHARS || kind === "contents" || (expansion & LEGACY_GLOB_EXPANSION) !== 0 || cwd !== this.cwd
      || this.nativeShell === "bash" && process.platform === "win32" && (raw.startsWith("/") || (expansion & LEGACY_HOME_EXPANSION) !== 0)) {
      this.nativePathUncertain = true; return;
    }
    for (let index = 0; index < targets.length; index++) if (targets[index]!.target === target && targets[index]!.kind === kind) return;
    if (targets.length === MAX_NATIVE_TARGETS) { this.nativePathUncertain = true; return; }
    targets.push({ target, kind });
  }

  /** The native tool whose operands this owner collects; undefined for legacy analysis. */
  get nativeTool(): "bash" | "powershell" | undefined { return this.nativeTargets ? this.nativeShell : undefined; }

  takeNativeTargets(): NativeShellTarget[] | undefined {
    const targets = this.nativeTargets; this.nativeTargets = undefined; return targets;
  }

  assertCurrent(command: unknown, cwd: string, generation: number): void {
    if (this.released || command !== this.command || cwd !== this.cwd || generation !== this.generation) {
      this.release();
      throw new Error("[SHELL_ANALYSIS_CHANGED] Shell request or permission authority changed; resubmit for fresh analysis.");
    }
  }

  get(source: string): PreparedShellAnalysis {
    if (this.released) throw new Error("Shell analysis owner is released");
    const cached = this.entries.get(source);
    if (cached) { this.hits++; shellAnalysisOwnership.hits++; return cached; }
    this.misses++;
    shellAnalysisOwnership.misses++;
    const analysis = analyzeShellSource(source);
    let bytes = 2 * (source.length + analysis.view.command.length + (analysis.stdin?.analysisCommand.length ?? 0));
    for (const nested of analysis.view.substitutions) bytes += nested.length * 2;
    for (const nested of analysis.substitutions.scripts) bytes += nested.length * 2;
    if (analysis.view.hereDocuments) for (const document of analysis.view.hereDocuments) bytes += 2 * document.body.length;
    if (this.size < MAX_ANALYSIS_ENTRIES && this.retainedBytes + bytes <= MAX_ANALYSIS_BYTES) {
      this.entries.set(source, analysis);
      this.retainedBytes += bytes;
      shellAnalysisOwnership.liveEntries++;
      shellAnalysisOwnership.liveBytes += bytes;
    } else { this.overflows++; shellAnalysisOwnership.overflows++; }
    return analysis;
  }

  release(): void {
    if (this.released) return;
    shellAnalysisOwnership.released++;
    shellAnalysisOwnership.liveOwners--;
    shellAnalysisOwnership.liveEntries -= this.size;
    shellAnalysisOwnership.liveBytes -= this.retainedBytes;
    this.entries.clear();
    this.bashTables.clear();
    this.powerShellTables.clear();
    this.cmdTables.clear();
    if (this.nativeTargets) this.nativeTargets.length = 0;
    this.nativeTargets = undefined;
    this.nativeShell = undefined;
    this.command = undefined;
    this.cwd = undefined;
    this.retainedBytes = 0;
    this.released = true;
  }
}
