import { boundedShellInput } from "../tools/bounded-shell-input.ts";
import { extractCommandSubstitutions, prepareShellAnalysis, type CommandSubstitutionScan, type ShellAnalysisView } from "./shell-substitution.ts";

export const MAX_ANALYSIS_ENTRIES = 128;
export const MAX_ANALYSIS_BYTES = 512 * 1024;
const MAX_NATIVE_TARGETS = 34;
const MAX_NATIVE_TARGET_CHARS = 4096;
// Existing parseShellSegments flags; this adapter does not add token classification.
const LEGACY_GLOB_EXPANSION = 16, LEGACY_HOME_EXPANSION = 32;
export interface NativeShellTarget { target: string; kind: "delete" | "write"; }
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

  get size(): number { return this.entries.size; }

  /** Observe only operands the existing scanners already recognized; never scan source here. */
  observeMutationTarget(raw: string, cwd: string, expansion: number, target: string | undefined, kind: "delete" | "write" | "contents"): void {
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
    if (this.entries.size < MAX_ANALYSIS_ENTRIES && this.retainedBytes + bytes <= MAX_ANALYSIS_BYTES) {
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
    shellAnalysisOwnership.liveEntries -= this.entries.size;
    shellAnalysisOwnership.liveBytes -= this.retainedBytes;
    this.entries.clear();
    if (this.nativeTargets) this.nativeTargets.length = 0;
    this.nativeTargets = undefined;
    this.nativeShell = undefined;
    this.command = undefined;
    this.cwd = undefined;
    this.retainedBytes = 0;
    this.released = true;
  }
}
