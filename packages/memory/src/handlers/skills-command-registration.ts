import type { ExtensionAPI } from "@super-pi/coding-agent";
import type { SkillStore } from "../store/skill-store.js";

export function registerLazySkillsCommand(pi: ExtensionAPI, store: SkillStore): void {
  pi.registerCommand("memory-skills", {
    description: "Manage global, active-project, and loaded external procedural skills",
    handler: async (args, ctx) => {
      const { runSkillsCommand } = await import("./skills-command.js");
      await runSkillsCommand(pi, store, args, ctx);
    },
  });
}
