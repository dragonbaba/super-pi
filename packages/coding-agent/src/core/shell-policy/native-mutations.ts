import { inspectHighRiskBashMutation } from "./core.ts";
import { inspectBashPermissionScope } from "./permission-bash.ts";
import { inspectPowerShellPermissionScope } from "./permission-powershell.ts";
import { ShellAnalysisOwner, type NativeShellTarget } from "./shell-analysis.ts";

export interface NativeShellMutations { targets: NativeShellTarget[]; uncertain: boolean; }

/** Adapt existing evidence. Opaque scripts, runners and parser uncertainty alone do not gate commands. */
/** Both scanners share one analysis owner, so a PowerShell or cmd source is tokenized once. */
export function inspectNativeShellMutations(tool: "bash" | "powershell", input: Record<string, unknown>, cwd: string, generation: number): NativeShellMutations | undefined {
  if (typeof input.command !== "string") return undefined;
  const owner = new ShellAnalysisOwner(input.command, cwd, generation, tool);
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
