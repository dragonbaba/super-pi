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
 * Only unquoted words change: Bash already keeps a backslash literal inside single
 * quotes and before ordinary characters in double quotes, and a quoted argument may be
 * a nested script (`bash -c '...'`) whose backslashes keep their own meaning.
 */
function powerShellAnalysisInput(input: Record<string, unknown>, command: string): Record<string, unknown> {
  if (!command.includes("\\")) return input;
  let quote = 0, spelled = "", start = 0;
  for (let index = 0; index < command.length; index++) {
    const code = command.charCodeAt(index);
    if (quote === 0) {
      if (code === 96) index++; // A backtick escapes the next character.
      else if (code === 39 || code === 34) quote = code;
      else if (code === 92) { spelled += command.slice(start, index) + "/"; start = index + 1; }
    } else if (quote === 34 && code === 96) index++;
    else if (code === quote) quote = 0; // '' and "" reopen at once, with the same effect.
  }
  return start === 0 ? input : { ...input, command: spelled + command.slice(start) };
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
