/**
 * Configuration loading for the extension.
 *
 * Reads global/project JSON config files plus environment overrides and exposes
 * a normalized, fully-populated runtime config object.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { CONFIG_DIR_NAME } from "@super-pi/coding-agent";

export type JsonRecord = Record<string, unknown>;

export type ExtensionConfig = {
  enabled?: boolean;
  includeAzure?: boolean;
  compactThreshold?: number;
  thresholdRatio?: number;
  notify?: boolean;
  usePreviousResponseId?: boolean;
  autoContinueAfterThreshold?: boolean;
  portableSummaryModel?: string;
  portableSummaryMode?: "always" | "fallback";
  shapeDiagnostics?: boolean;
};

export function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readJsonFile(path: string): JsonRecord | undefined {
  if (!existsSync(path)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function toBoolean(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return undefined;
}

function toPositiveNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return undefined;
}

function toNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized || undefined;
}

function toPortableSummaryMode(value: unknown): "always" | "fallback" | undefined {
  if (value === "always" || value === "fallback") return value;
  return undefined;
}

export function loadConfig(
  cwd?: string,
  projectTrusted = false,
): Required<ExtensionConfig> {
  const globalPath = join(homedir(), ".super-pi", "agent", "openai-server-compaction.json");
  const globalCfg = readJsonFile(globalPath) ?? {};
  const projectCfg = cwd && projectTrusted
    ? readJsonFile(join(cwd, CONFIG_DIR_NAME, "openai-server-compaction.json")) ?? {}
    : {};
  const merged = { ...globalCfg, ...projectCfg };

  return {
    enabled:
      toBoolean(process.env.SP_OPENAI_SERVER_COMPACTION_ENABLED) ??
      toBoolean(merged.enabled) ??
      true,
    includeAzure:
      toBoolean(process.env.SP_OPENAI_SERVER_COMPACTION_AZURE) ??
      toBoolean(merged.includeAzure) ??
      false,
    compactThreshold:
      toPositiveNumber(process.env.SP_OPENAI_SERVER_COMPACTION_THRESHOLD) ??
      toPositiveNumber(merged.compactThreshold) ??
      0,
    thresholdRatio:
      toPositiveNumber(process.env.SP_OPENAI_SERVER_COMPACTION_RATIO) ??
      toPositiveNumber(merged.thresholdRatio) ??
      0.7,
    notify:
      toBoolean(process.env.SP_OPENAI_SERVER_COMPACTION_NOTIFY) ??
      toBoolean(merged.notify) ??
      false,
    usePreviousResponseId:
      toBoolean(process.env.SP_OPENAI_SERVER_COMPACTION_PREVIOUS_RESPONSE_ID) ??
      toBoolean(merged.usePreviousResponseId) ??
      true,
    autoContinueAfterThreshold:
      toBoolean(process.env.SP_OPENAI_SERVER_COMPACTION_AUTO_CONTINUE) ??
      toBoolean(merged.autoContinueAfterThreshold) ??
      true,
    portableSummaryModel:
      toNonEmptyString(process.env.SP_OPENAI_SERVER_COMPACTION_SUMMARY_MODEL) ??
      toNonEmptyString(merged.portableSummaryModel) ??
      "current",
    portableSummaryMode:
      toPortableSummaryMode(process.env.SP_OPENAI_SERVER_COMPACTION_SUMMARY_MODE) ??
      toPortableSummaryMode(merged.portableSummaryMode) ??
      "fallback",
    shapeDiagnostics:
      toBoolean(process.env.SP_OPENAI_SERVER_COMPACTION_SHAPE_DIAGNOSTICS) ??
      toBoolean(merged.shapeDiagnostics) ??
      false,
  };
}

export function toPositiveInteger(value: unknown): number | undefined {
  const numeric = toPositiveNumber(value);
  return numeric ? Math.floor(numeric) : undefined;
}
