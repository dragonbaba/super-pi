import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getConfigDir } from "@super-pi/coding-agent";

export type CompactionPresetId = "claude-deepseek-fallback-v1" | "deepseek-self-preserve-v1" | "kimi-self-preserve-32k-v1";

export class CompactionPolicyConfigurationError extends Error {}

/** A primitive snapshot avoids retaining or trusting caller-owned arrays after selection. */
export function parsePolicyMask(value: unknown): number {
  if (!Array.isArray(value) || value.length > 3) throw new CompactionPolicyConfigurationError("Compaction policies must be an array of at most three known preset IDs.");
  let mask = 0;
  for (const id of value) {
    const bit = id === "claude-deepseek-fallback-v1" ? 1 : id === "deepseek-self-preserve-v1" ? 2 : id === "kimi-self-preserve-32k-v1" ? 4 : 0;
    if (!bit || (mask & bit)) throw new CompactionPolicyConfigurationError("Compaction policies contain an unknown or duplicate preset ID.");
    mask |= bit;
  }
  return mask;
}

function readPolicyMask(path: string, scope: string): number | undefined {
  let text: string;
  try { text = readFileSync(path, "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new CompactionPolicyConfigurationError(`Cannot read ${scope} provider-aware compaction configuration.`);
  }
  let config: unknown;
  try { config = JSON.parse(text); }
  catch { throw new CompactionPolicyConfigurationError(`Invalid JSON in ${scope} provider-aware compaction configuration.`); }
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    throw new CompactionPolicyConfigurationError(`${scope} provider-aware compaction configuration must be an object.`);
  }
  if (!Object.hasOwn(config, "policies")) return undefined;
  return parsePolicyMask((config as { policies: unknown }).policies);
}

/** Read once at compaction preparation. Missing fields inherit; an empty array overrides to zero. */
export function loadPolicyMask(cwd: string, trusted: boolean): number {
  const global = readPolicyMask(join(getConfigDir(), "provider-aware-compaction.json"), "Global");
  const project = trusted ? readPolicyMask(join(cwd, ".sp", "config", "provider-aware-compaction.json"), "Project") : undefined;
  return project ?? global ?? 0;
}
