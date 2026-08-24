import { MEMORY_POLICY_PROMPT, MEMORY_POLICY_PROMPT_COMPACT } from "./constants.js";
import type { MemoryConfig } from "./types.js";
import type { MemoryStore } from "./store/memory-store.js";

type MemoryPolicyConfig = Pick<MemoryConfig, "memoryPolicyStyle" | "memoryPolicyCustomText">;

export function resolveMemoryPolicyPrompt(config: MemoryPolicyConfig): string {
  const style = config.memoryPolicyStyle ?? "full";

  switch (style) {
    case "compact":
      return MEMORY_POLICY_PROMPT_COMPACT;
    case "custom":
      return config.memoryPolicyCustomText && config.memoryPolicyCustomText.trim().length > 0
        ? config.memoryPolicyCustomText
        : MEMORY_POLICY_PROMPT_COMPACT;
    case "none":
      return "";
    case "full":
    default:
      return MEMORY_POLICY_PROMPT;
  }
}

export function buildPromptContext(
  config: Pick<MemoryConfig, "memoryMode" | "memoryPolicyStyle" | "memoryPolicyCustomText">,
  store: MemoryStore,
  projectStore: MemoryStore | null,
  projectName: string,
): string {
  if (config.memoryMode === "policy-only") {
    return resolveMemoryPolicyPrompt(config);
  }

  const memoryBlock = store.formatForSystemPrompt();
  const projectBlock = projectStore ? projectStore.formatProjectBlock(projectName) : "";

  const parts: string[] = [];
  if (memoryBlock) parts.push(memoryBlock);
  if (projectBlock) parts.push(projectBlock);

  return parts.join("\n\n");
}

/**
 * Session-scoped stable prompt appender.
 *
 * Pi calls before_agent_start for every user turn. Memory policy and legacy
 * snapshots are intentionally frozen for the session, so rebuilding and
 * concatenating the same system prompt on every turn is pure allocation. This
 * class caches the combined string and only rebuilds when Pi's upstream base
 * prompt actually changes (for example after an active-tool change).
 */
export class StablePromptAppender {
  private context = "";
  private base: string | undefined;
  private combined: string | undefined;

  setContext(context: string): void {
    if (context === this.context) return;
    this.context = context;
    this.base = undefined;
    this.combined = undefined;
  }

  append(base: string): string | undefined {
    if (!this.context) return undefined;
    if (base !== this.base || this.combined === undefined) {
      this.base = base;
      this.combined = `${base}\n\n${this.context}`;
    }
    return this.combined;
  }
}
