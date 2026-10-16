import { boundedShellInput } from "@super-pi/coding-agent";
import { extractCommandSubstitutions, prepareShellAnalysis, type CommandSubstitutionScan, type ShellAnalysisView } from "./shell-substitution.ts";

export const MAX_ANALYSIS_ENTRIES = 128;
export const MAX_ANALYSIS_BYTES = 512 * 1024;
export const shellAnalysisOwnership = {
  created: 0, released: 0, liveOwners: 0, liveEntries: 0, liveBytes: 0,
  hits: 0, misses: 0, overflows: 0,
};

export interface PreparedShellAnalysis {
  view: ShellAnalysisView;
  substitutions: CommandSubstitutionScan;
  stdin: ReturnType<typeof boundedShellInput>;
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

  constructor(command: string, cwd: string, generation: number) {
    this.command = command;
    this.cwd = cwd;
    this.generation = generation;
    shellAnalysisOwnership.created++;
    shellAnalysisOwnership.liveOwners++;
  }

  get size(): number { return this.entries.size; }

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
    if (analysis.view.hereDocuments) for (const document of analysis.view.hereDocuments) bytes += 2 * (document.header.length + document.body.length);
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
    this.command = undefined;
    this.cwd = undefined;
    this.retainedBytes = 0;
    this.released = true;
  }
}
