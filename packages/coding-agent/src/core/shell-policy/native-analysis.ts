import { inspectBashPermissionScope } from "./permission-bash.ts";
import { inspectHighRiskBashMutation } from "./core.ts";
import { inspectWindowsMutations } from "./windows-mutations.ts";
import { MAX_SHELL_SOURCE_CHARS, type ShellMutationScan } from "./mutation-effects.ts";
import { ShellAnalysisOwner } from "./shell-analysis.ts";

/** Analysis owns all parsed source only until this synchronous call returns. */
export function analyzeNativeShell(command: string, cwd: string, shell: "bash" | "powershell", generation: number): ShellMutationScan {
  const scan: ShellMutationScan = { effects: [], recognized: false, uncertain: false };
  if (command.length > MAX_SHELL_SOURCE_CHARS) { scan.recognized = true; scan.uncertain = true; return scan; }
  const owner = new ShellAnalysisOwner(command, cwd, generation);
  try {
    if (shell === "powershell") inspectWindowsMutations(command, cwd, shell, scan, 0, owner);
    else {
      const input = { command };
      const scope = inspectBashPermissionScope(input, cwd, owner, scan);
      const high = inspectHighRiskBashMutation(input, cwd, "bash", owner, 0, scan);
      if (scope?.unverifiableMutation || high?.unverifiableScope) scan.uncertain = true;
    }
    owner.assertCurrent(command, cwd, generation);
    return scan;
  } finally { owner.release(); }
}
