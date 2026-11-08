import * as fs from "node:fs";
import * as path from "node:path";
import type { MemoryConfig, MemoryOverflowStrategy, ThinkingLevel } from "./types.js";
import {
  DEFAULT_MEMORY_CHAR_LIMIT,
  DEFAULT_USER_CHAR_LIMIT,
  DEFAULT_PROJECT_CHAR_LIMIT,
  DEFAULT_PROJECTS_MEMORY_DIR,
  DEFAULT_REVIEW_RECENT_MESSAGES,
  DEFAULT_CONSOLIDATION_TIMEOUT_MS,
  DEFAULT_FAILURE_INJECTION_MAX_AGE_DAYS,
  DEFAULT_FAILURE_INJECTION_MAX_ENTRIES,
} from "./constants.js";
import { AGENT_ROOT, normalizeConfiguredMemoryDir, normalizeProjectsMemoryDir } from "./paths.js";

const MEMORY_OVERFLOW_STRATEGIES: readonly MemoryOverflowStrategy[] = ["auto-consolidate", "reject", "fifo-evict"];
const THINKING_LEVELS: readonly ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh"];

function isMemoryOverflowStrategy(value: unknown): value is MemoryOverflowStrategy {
  return typeof value === "string" && MEMORY_OVERFLOW_STRATEGIES.includes(value as MemoryOverflowStrategy);
}

function isThinkingLevel(value: unknown): value is ThinkingLevel {
  return typeof value === "string" && THINKING_LEVELS.includes(value as ThinkingLevel);
}

const DEFAULT_CONFIG: MemoryConfig = {
  memoryMode: "digest",
  memoryPolicyStyle: "full",
  memoryCharLimit: DEFAULT_MEMORY_CHAR_LIMIT,
  userCharLimit: DEFAULT_USER_CHAR_LIMIT,
  projectCharLimit: DEFAULT_PROJECT_CHAR_LIMIT,
  reviewRecentMessages: DEFAULT_REVIEW_RECENT_MESSAGES,
  memoryOverflowStrategy: "reject",
  autoConsolidate: false,
  failureInjectionEnabled: true,
  failureInjectionMaxAgeDays: DEFAULT_FAILURE_INJECTION_MAX_AGE_DAYS,
  failureInjectionMaxEntries: DEFAULT_FAILURE_INJECTION_MAX_ENTRIES,
  consolidationTimeoutMs: DEFAULT_CONSOLIDATION_TIMEOUT_MS,
  projectsMemoryDir: DEFAULT_PROJECTS_MEMORY_DIR,
};

export const DEFAULT_CONFIG_PATH = path.join(
  AGENT_ROOT,
  "config",
  "hermes-memory-config.json",
);

export function loadConfig(configPath = DEFAULT_CONFIG_PATH): MemoryConfig {
  try {
    if (fs.existsSync(configPath)) {
      const raw = fs.readFileSync(configPath, "utf-8");
      const parsed = JSON.parse(raw);
      // Merge: override defaults with user config
      const config: MemoryConfig = { ...DEFAULT_CONFIG };
      const isNonNegativeNumber = (value: unknown): value is number => (
        typeof value === "number" && Number.isFinite(value) && value >= 0
      );
      let hasLegacyAutoConsolidate = false;
      let hasMemoryOverflowStrategy = false;
      if (parsed.memoryMode === "digest" || parsed.memoryMode === "policy-only" || parsed.memoryMode === "legacy-inject") {
        config.memoryMode = parsed.memoryMode;
      }
      if (
        parsed.memoryPolicyStyle === "full" ||
        parsed.memoryPolicyStyle === "compact" ||
        parsed.memoryPolicyStyle === "custom" ||
        parsed.memoryPolicyStyle === "none"
      ) config.memoryPolicyStyle = parsed.memoryPolicyStyle;
      if (typeof parsed.memoryPolicyCustomText === "string") config.memoryPolicyCustomText = parsed.memoryPolicyCustomText;
      if (typeof parsed.memoryCharLimit === "number") config.memoryCharLimit = parsed.memoryCharLimit;
      if (typeof parsed.userCharLimit === "number") config.userCharLimit = parsed.userCharLimit;
      if (isNonNegativeNumber(parsed.reviewRecentMessages)) config.reviewRecentMessages = parsed.reviewRecentMessages;
      if (typeof parsed.autoConsolidate === "boolean") {
        config.autoConsolidate = parsed.autoConsolidate;
        hasLegacyAutoConsolidate = true;
      }
      if (isMemoryOverflowStrategy(parsed.memoryOverflowStrategy)) {
        config.memoryOverflowStrategy = parsed.memoryOverflowStrategy;
        hasMemoryOverflowStrategy = true;
      }
      if (typeof parsed.consolidationTimeoutMs === "number") {
        config.consolidationTimeoutMs = parsed.consolidationTimeoutMs;
        if (parsed.consolidationTimeoutMs < DEFAULT_CONSOLIDATION_TIMEOUT_MS) {
          console.warn(
            `⚠️ consolidationTimeoutMs is set to ${parsed.consolidationTimeoutMs}ms, below the ${DEFAULT_CONSOLIDATION_TIMEOUT_MS}ms default.`
            + " The explicit memory review command needs enough time for one current-model proposal.",
          );
        }
      }
      if (typeof parsed.failureInjectionEnabled === "boolean") config.failureInjectionEnabled = parsed.failureInjectionEnabled;
      if (typeof parsed.failureInjectionMaxAgeDays === "number") config.failureInjectionMaxAgeDays = parsed.failureInjectionMaxAgeDays;
      if (typeof parsed.failureInjectionMaxEntries === "number") config.failureInjectionMaxEntries = parsed.failureInjectionMaxEntries;
      if (typeof parsed.projectCharLimit === "number") config.projectCharLimit = parsed.projectCharLimit;
      if (typeof parsed.memoryDir === "string") {
        const normalizedMemoryDir = normalizeConfiguredMemoryDir(parsed.memoryDir);
        if (normalizedMemoryDir) config.memoryDir = normalizedMemoryDir;
      }
      if (typeof parsed.projectsMemoryDir === "string") {
        const normalizedProjectsMemoryDir = normalizeProjectsMemoryDir(parsed.projectsMemoryDir);
        if (normalizedProjectsMemoryDir) config.projectsMemoryDir = normalizedProjectsMemoryDir;
      }
      if (typeof parsed.llmModelOverride === "string") {
        const trimmed = parsed.llmModelOverride.trim();
        if (trimmed.length > 0) config.llmModelOverride = trimmed;
      }
      if (isThinkingLevel(parsed.llmThinkingOverride)) config.llmThinkingOverride = parsed.llmThinkingOverride;
      if (hasMemoryOverflowStrategy) {
        config.autoConsolidate = config.memoryOverflowStrategy === "auto-consolidate";
      } else if (hasLegacyAutoConsolidate) {
        config.memoryOverflowStrategy = config.autoConsolidate ? "auto-consolidate" : "reject";
      }
      return config;
    }
  } catch {
    // Fall back to defaults on parse error or access issues
  }
  return { ...DEFAULT_CONFIG };
}
