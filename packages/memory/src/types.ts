/**
 * Shared TypeScript types for the Hermes Memory extension.
 */

import type { TextContent } from "@super-pi/ai";

export type MemoryOverflowStrategy = "auto-consolidate" | "reject" | "fifo-evict";

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";


export interface MemoryConfig {
  /**
   * Prompt memory mode. Default: digest.
   * - digest: constant policy in the system prompt plus one hidden memory digest message per session context.
   * - policy-only: constant policy only.
   * - legacy-inject: full memory files in the system prompt.
   */
  memoryMode: "digest" | "policy-only" | "legacy-inject";
  /** Policy prompt style used by digest and policy-only modes. Default: full */
  memoryPolicyStyle?: "full" | "compact" | "custom" | "none";
  /** Custom policy prompt text used when memoryPolicyStyle is custom */
  memoryPolicyCustomText?: string;
  /** Max chars for MEMORY.md (agent notes). Default: 5000 */
  memoryCharLimit: number;
  /** Max chars for USER.md (user profile). Default: 5000 */
  userCharLimit: number;
  /** Max chars for project-level MEMORY.md. Default: 5000 */
  projectCharLimit: number;
  /** Recent conversation messages included by explicit /memory-review. 0 = all. Default: 0 */
  reviewRecentMessages?: number;
  /** Override extension storage directory. Default: ~/.sp/agent/@super-pi/memory */
  memoryDir?: string;
  /** Directory for project-scoped memory (relative to ~/.sp/agent). Default: "projects-memory" */
  projectsMemoryDir?: string;
  /** Override model used for child superpi -p subprocess LLM calls. Default: unset */
  llmModelOverride?: string;
  /** Override thinking level used for child superpi -p subprocess LLM calls. Default: unset */
  llmThinkingOverride?: ThinkingLevel;
  /** Strategy when memory is full. Default: reject; auto-consolidate is retained as a legacy value but no automatic consolidator is registered. */
  memoryOverflowStrategy?: MemoryOverflowStrategy;
  /** Legacy alias for memoryOverflowStrategy. Default: false */
  autoConsolidate: boolean;
  /** Inject recent failure memories into the system prompt. Default: true */
  failureInjectionEnabled: boolean;
  /** Maximum age in days for injected failure memories. Default: 7 */
  failureInjectionMaxAgeDays: number;
  /** Maximum number of failure memories to inject. Default: 5 */
  failureInjectionMaxEntries: number;
  /** Maximum time for the explicit current-model /memory-review proposal. Legacy field name retained. Default: 180000 */
  consolidationTimeoutMs: number;
}

export type MemoryCategory =
  | "failure"
  | "correction"
  | "insight"
  | "preference"
  | "convention"
  | "tool-quirk";

export interface MemoryResult {
  success: boolean;
  error?: string;
  message?: string;
  warning?: string;
  warnings?: string[];
  target?: "memory" | "user" | "failure" | "project";
  entries?: string[];
  usage?: string;
  entry_count?: number;
  evicted_entries?: string[];
  evicted_count?: number;
  matches?: string[];
}

export interface MemorySnapshot {
  memory: string;
  user: string;
}

export type SkillScope = "global" | "project";

export interface SkillIndex {
  /** Stable id for read/update/delete operations */
  skillId: string;
  /** Whether the skill is global or project-scoped */
  scope: SkillScope;
  /** File name on disk (usually SKILL.md) */
  fileName: string;
  /** Absolute path to the skill file */
  path: string;
  /** Active project name for project-scoped skills */
  projectName?: string;
  /** Pi skill slug stored in frontmatter and folder name */
  name: string;
  /** Optional human-friendly title preserved for UI output */
  displayName?: string;
  /** Short description shown in skill listings */
  description: string;
  /** ISO date created */
  created: string;
  /** ISO date last updated */
  updated: string;
}

export interface SkillDocument extends SkillIndex {
  /** Full markdown body (after frontmatter) */
  body: string;
  /** Version number */
  version: number;
}

export interface SkillResult {
  success: boolean;
  error?: string;
  message?: string;
  fileName?: string;
  skillId?: string;
  scope?: SkillScope;
  path?: string;
  conflictType?: "duplicate" | "similar" | "name-collision" | "scope-conflict";
  similarSkillIds?: string[];
  suggestedAction?: "patch" | "update" | "rename";
}

/**
 * Extract displayable text from a Pi session entry message.
 *
 * Accepts any value — returns null for non-message entries (BashExecutionMessage,
 * NotificationMessage, etc.) that lack a `content` property.
 *
 * Returns the concatenated text, truncated to `maxLength` chars.
 */
export function getMessageText(msg: unknown, maxLength = 500): string | null {
  if (typeof msg !== "object" || msg === null) return null;
  const { role, content } = msg as Record<string, unknown>;
  if (typeof role !== "string") return null;

  if (typeof content === "string") {
    return content.slice(0, maxLength);
  }
  if (Array.isArray(content)) {
    const text = (content as TextContent[])
      .filter((block): block is TextContent => block.type === "text" && typeof block.text === "string")
      .map((block) => block.text)
      .join("\n");
    return text.length > 0 ? text.slice(0, maxLength) : null;
  }
  return null;
}
