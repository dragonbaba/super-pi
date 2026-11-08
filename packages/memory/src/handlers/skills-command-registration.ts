import type { ExtensionAPI } from "@super-pi/coding-agent";
import type { SkillStore } from "../store/skill-store.js";

export function createLazySkillsHandler(pi: ExtensionAPI, store: SkillStore): Parameters<ExtensionAPI["registerCommand"]>[1]["handler"] {
  return async (args, ctx) => {
    const { runSkillsCommand } = await import("./skills-command.js");
    await runSkillsCommand(pi, store, args, ctx);
  };
}
