import type { ExtensionAPI } from "@super-pi/coding-agent";
import type { MemoryStore } from "../store/memory-store.js";
import { runMemoryRecoveryCleanup } from "./memory-recovery-cleanup.js";

export function registerMemoryCleanupCommand(
  pi: ExtensionAPI,
  options: { store: MemoryStore; globalDir: string; projectsRoot: string },
  deps: { runCleanup?: typeof runMemoryRecoveryCleanup } = {},
): void {
  const runCleanup = deps.runCleanup ?? runMemoryRecoveryCleanup;
  pi.registerCommand("memory-cleanup", {
    description: "Explicitly remove expired, superseded, or over-budget generated memory recovery artifacts",
    handler: async (rawArgs, ctx) => {
      if (rawArgs.trim()) {
        ctx.ui.notify("Usage: /memory-cleanup", "warning");
        return;
      }
      if (!ctx.hasUI) {
        ctx.ui.notify("Memory cleanup requires interactive confirmation; nothing was removed.", "warning");
        return;
      }
      const confirmed = await ctx.ui.confirm(
        "Run bounded memory artifact cleanup?",
        "Scan global and immediate project-memory directories, then remove only generated recovery/retired/conflict files that are expired, superseded, or over policy budgets. Canonical memory files, symlinks, and lookalikes are never removed.",
      );
      if (!confirmed) {
        ctx.ui.notify("Memory cleanup cancelled; nothing was removed.", "info");
        return;
      }

      ctx.ui.notify("Scanning bounded memory recovery artifacts…", "info");
      try {
        const result = await runCleanup(options);
        ctx.ui.notify([
          "Memory cleanup complete.",
          `Project directories scanned: ${result.projectDirsScanned}`,
          `Canonical targets checked: ${result.targetsPruned}`,
          `Artifacts removed: ${result.aggregateRemoved}`,
          `Bytes removed: ${result.aggregateRemovedBytes}`,
          `Failures: ${result.targetsFailed + result.aggregateFailed}`,
          result.projectLimitReached || result.targetLimitReached
            ? "A safety scan limit was reached; rerun the command to continue bounded cleanup."
            : "All bounded scan scopes completed.",
        ].join("\n"), result.targetsFailed + result.aggregateFailed > 0 ? "warning" : "info");
      } catch (error) {
        ctx.ui.notify(`Memory cleanup failed: ${error instanceof Error ? error.message : String(error)}`, "error");
      }
    },
  });
}
