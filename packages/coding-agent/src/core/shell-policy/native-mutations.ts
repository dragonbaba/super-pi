import { inspectHighRiskBashMutation } from "./core.ts";
import { inspectBashPermissionScope } from "./permission-bash.ts";
import { inspectPowerShellPermissionScope } from "./permission-powershell.ts";
import { ShellAnalysisOwner, type NativeShellTarget } from "./shell-analysis.ts";

export interface NativeShellMutations { targets: NativeShellTarget[]; uncertain: boolean; }

/**
 * The existing scanners read words with Bash rules, where an unquoted backslash is an
 * escape. PowerShell escapes with a backtick, so its backslash is a path separator:
 * `..\out\x` must not become `..outx` inside the workspace. Give the scanners the
 * equivalent Windows separator; this is path spelling only, not new command grammar.
 */
function powerShellAnalysisInput(input: Record<string, unknown>, command: string): Record<string, unknown> {
  return command.includes("\\") ? { ...input, command: command.replaceAll("\\", "/") } : input;
}

/** Adapt existing evidence. Opaque scripts, runners and parser uncertainty alone do not gate commands. */
export function inspectNativeShellMutations(tool: "bash" | "powershell", original: Record<string, unknown>, cwd: string, generation: number): NativeShellMutations | undefined {
  if (typeof original.command !== "string") return undefined;
  const input = tool === "powershell" ? powerShellAnalysisInput(original, original.command) : original;
  const owner = new ShellAnalysisOwner(input.command as string, cwd, generation, tool);
  try {
    const high = inspectHighRiskBashMutation(input, cwd, tool, owner);
    const scope = tool === "bash" ? inspectBashPermissionScope(input, cwd, owner) : inspectPowerShellPermissionScope(input, cwd, owner);
    if (!high?.mutationDetected && !scope?.mutationDetected) return undefined;
    const uncertain = owner.nativePathUncertain || high?.mutationDetected === true && high.unverifiableScope
      || scope?.mutationDetected === true && scope.unverifiableMutation === true;
    const targets = owner.takeNativeTargets()!;
    // Reconcile only move operands. A separate write to the same path stays a write.
    for (const target of targets) if (target.kind === "move")
      target.kind = scope?.destructiveTargets?.includes(target.target) ? "delete" : "write";
    return targets.length || uncertain ? { targets, uncertain } : undefined;
  } finally { owner.release(); }
}
