import type { SessionEntry } from "@super-pi/coding-agent";
import { collectSessionErrors, type ErrorObservation } from "../session-tool-errors/core.ts";
import { DIMENSION_EDGE_UNDERSCORES_RE, DIMENSION_RE, DIMENSION_UNSAFE_RE } from "./regex.ts";

export const ANALYTICS_VERSION = "0.2.1-pi.84.2";
export const SP_VERSION_ANCHOR = "pi@0.84.1";
export const CHECKPOINT_TYPE = "tool-repair-aggregate-checkpoint-v1";
export const COMPACTION_TELEMETRY_TYPE = "compaction-telemetry-v1";
export const AGGREGATE_SCHEMA_VERSION = 1;
export const MAX_RETENTION_DAYS = 90;
export const MAX_BUCKETS = 4_096;
export const MAX_SEEN_EVENTS = 16_384;

export const MUTATION_GUARD_VERSION = "mutation-guard-write@0.16.3-pi.84.2";
export const FALSE_SUCCESS_GUARD_VERSION = "false-success-guard@0.3.4-pi.84.2";
const COMPACTION_FREQUENCY_VERSION = "compaction-frequency@0.1.0-pi.84.1";
const COMPLETION_OPPORTUNITY_CATEGORY = "completion_opportunity";
const UNKNOWN_MODEL = "not-recorded";
const DIMENSION_MAX_CHARS = 120;
const COMPACTION_STRATEGIES = new Set([
  "claude-deepseek-fallback-v1",
  "custom-fallback-v1",
  "deepseek-self-preserve-v1",
  "kimi-self-preserve-32k-v1",
  "openai-remote-compaction-v2",
]);
const COMPACTION_OUTCOMES = new Set([
  "cancelled",
  "local_fallback_succeeded",
  "default_fallback_requested",
  "remote_success_with_emergency_summary",
]);
const COMPACTION_REASONS = new Set([
  "cross_provider_denied",
  "invalid_summary_model",
  "summary_model_missing",
  "auth_unavailable",
  "empty_summary",
  "summarization_aborted",
  "summarization_failed",
  "remote_failed",
  "remote_and_local_failed",
  "local_summary_failed",
  "aborted",
]);
const COMPACTION_PRODUCER_VERSIONS = new Set([
  "@super-pi/provider-aware-compaction@0.2.2-pi.84.1",
  "@super-pi/openai-server-compaction@0.1.8-pi.84.1",
]);
const DAY_FORMATTER = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Shanghai",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

export interface RepairMetric {
  entryId: string;
  timestamp: string;
  day: string;
  model: string;
  tool: string;
  category: string;
  outcome: string;
  version: string;
  count: number;
}

export interface RepairBucket {
  day: string;
  model: string;
  tool: string;
  category: string;
  outcome: string;
  version: string;
  count: number;
}

export interface AggregateStore {
  schemaVersion: 1;
  analyticsVersion: string;
  updatedAt: string;
  retentionDays: number;
  maxBuckets: number;
  buckets: RepairBucket[];
  seenEventHashes: string[];
}

interface ToolOwner {
  model: string;
}

export function collectRepairMetrics(entries: readonly SessionEntry[], initialModel?: string): RepairMetric[] {
  const errorsByEntry = new Map<string, ErrorObservation>();
  let collapsedAbortEntryIds: Set<string> | undefined;
  for (const observation of collectSessionErrors(entries)) {
    if (observation.entryId) errorsByEntry.set(observation.entryId, observation);
    if (observation.cascadeEntryIds) {
      for (let index = 1; index < observation.cascadeEntryIds.length; index++) {
        (collapsedAbortEntryIds ??= new Set()).add(observation.cascadeEntryIds[index]);
      }
    }
  }

  const owners = new Map<string, ToolOwner>();
  const metrics: RepairMetric[] = [];
  let currentModel = initialModel;
  for (const entry of entries) {
    if (entry.type === "model_change") {
      currentModel = modelName(entry.provider, entry.modelId);
      continue;
    }
    if (entry.type === "compaction") {
      const observation = compactionObservation(entry.details, entry.fromHook);
      metrics.push(metric(
        entry.id,
        entry.timestamp,
        observation.model ?? currentModel,
        "compaction",
        observation.strategy,
        "succeeded",
        COMPACTION_FREQUENCY_VERSION,
      ));
      continue;
    }
    if (entry.type === "custom") {
      const custom = entry as typeof entry & { customType?: unknown; data?: unknown };
      if (custom.customType === COMPACTION_TELEMETRY_TYPE) {
        const audit = parseCompactionAudit(custom.data);
        if (audit) {
          metrics.push(metric(
            entry.id,
            entry.timestamp,
            audit.model,
            "compaction_fallback",
            `${audit.strategy}/${audit.reason}`,
            audit.outcome,
            audit.producerVersion,
          ));
        }
      } else if (custom.customType === "false-success-intervention-v1") {
        const audit = parseInterventionAudit(custom.data);
        if (audit) {
          metrics.push(metric(
            entry.id,
            entry.timestamp,
            audit.model,
            audit.tool,
            audit.category,
            audit.outcome,
            `false-success-guard@${audit.guardVersion}`,
          ));
        }
      }
      continue;
    }
    if (entry.type !== "message") continue;
    const message = entry.message;
    if (message.role === "assistant") {
      const model = modelName(message.provider, message.model);
      currentModel = model;
      let hasToolCall = false;
      for (const block of message.content) {
        if (block.type !== "toolCall") continue;
        hasToolCall = true;
        owners.set(block.id, { model });
        if (block.name === "goal_complete") {
          metrics.push(metric(
            `goal-completion-opportunity:${block.id}`,
            entry.timestamp,
            model,
            "goal_complete",
            COMPLETION_OPPORTUNITY_CATEGORY,
            "observed",
            FALSE_SUCCESS_GUARD_VERSION,
          ));
        }
      }
      if (!hasToolCall && message.stopReason !== "error" && message.stopReason !== "toolUse") {
        metrics.push(metric(
          `assistant-completion-opportunity:${entry.id}`,
          entry.timestamp,
          model,
          "assistant_message",
          COMPLETION_OPPORTUNITY_CATEGORY,
          "observed",
          FALSE_SUCCESS_GUARD_VERSION,
        ));
      }
      const error = errorsByEntry.get(entry.id);
      if (error) metrics.push(metricFromError(entry.id, error));
      continue;
    }

    if (message.role === "toolResult") {
      const owner = owners.get(message.toolCallId);
      if (message.isError) {
        const error = errorsByEntry.get(entry.id);
        if (error) {
          metrics.push(metricFromError(entry.id, error));
        } else if (!collapsedAbortEntryIds?.has(entry.id)) {
          // session-tool-errors otherwise omits only a proven standalone rg no-match.
          metrics.push(metric(entry.id, entry.timestamp, owner?.model, message.toolName, "no_match", "succeeded", SP_VERSION_ANCHOR));
        }
      } else {
        const details = message.details && typeof message.details === "object"
          ? message.details as Record<string, unknown>
          : undefined;
        const category = typeof details?.category === "string" ? details.category : "success";
        const version = (message.toolName === "edit" || message.toolName === "write") && details?.ok === true
          ? MUTATION_GUARD_VERSION
          : SP_VERSION_ANCHOR;
        metrics.push(metric(entry.id, entry.timestamp, owner?.model, message.toolName, category, "succeeded", version));
      }
      continue;
    }

    if (message.role === "bashExecution") {
      const error = errorsByEntry.get(entry.id);
      if (error) metrics.push(metricFromError(entry.id, error));
      else if (!message.cancelled && message.exitCode === 0) {
        metrics.push(metric(entry.id, entry.timestamp, undefined, "user_bash", "success", "succeeded", SP_VERSION_ANCHOR));
      }
    }
  }
  return metrics;
}

export function emptyAggregate(now = new Date()): AggregateStore {
  return {
    schemaVersion: AGGREGATE_SCHEMA_VERSION,
    analyticsVersion: ANALYTICS_VERSION,
    updatedAt: now.toISOString(),
    retentionDays: MAX_RETENTION_DAYS,
    maxBuckets: MAX_BUCKETS,
    buckets: [],
    seenEventHashes: [],
  };
}

export function mergeRepairMetrics(
  store: AggregateStore,
  metrics: readonly RepairMetric[],
  eventHashes: readonly string[],
  now = new Date(),
): AggregateStore {
  const seen = new Set(store.seenEventHashes);
  const buckets = new Map<string, RepairBucket>();
  for (const bucket of store.buckets) buckets.set(bucketKey(bucket), { ...bucket });

  for (let index = 0; index < metrics.length; index++) {
    const eventHash = eventHashes[index];
    if (!eventHash || seen.has(eventHash)) continue;
    seen.add(eventHash);
    const current = normalizedBucket(metrics[index]);
    const key = bucketKey(current);
    const existing = buckets.get(key);
    if (existing) existing.count = Math.min(Number.MAX_SAFE_INTEGER, existing.count + current.count);
    else buckets.set(key, current);
  }

  const orderedDays = [...new Set([...buckets.values()].map((bucket) => bucket.day))]
    .sort((left, right) => right.localeCompare(left));
  const keptDays = new Set(orderedDays.slice(0, MAX_RETENTION_DAYS));
  const boundedBuckets = [...buckets.values()]
    .filter((bucket) => keptDays.has(bucket.day))
    .sort(compareBuckets)
    .slice(0, MAX_BUCKETS);
  const boundedSeen = [...seen].slice(-MAX_SEEN_EVENTS);

  return {
    schemaVersion: AGGREGATE_SCHEMA_VERSION,
    analyticsVersion: ANALYTICS_VERSION,
    updatedAt: now.toISOString(),
    retentionDays: MAX_RETENTION_DAYS,
    maxBuckets: MAX_BUCKETS,
    buckets: boundedBuckets,
    seenEventHashes: boundedSeen,
  };
}

export interface FalseSuccessInterventionFrequency {
  guardVersion: string;
  assistantCompletionOpportunities: number;
  completionReplacements: number;
  goalCompletionOpportunities: number;
  goalCompletionBlocks: number;
}

export interface CompactionAggregate {
  compactionFrequency: number;
  fallbackCount: number;
  fallbackReasons: Array<{
    model: string;
    strategy: string;
    outcome: string;
    reason: string;
    count: number;
  }>;
}

export function falseSuccessInterventionFrequency(store: AggregateStore): FalseSuccessInterventionFrequency {
  let assistantCompletionOpportunities = 0;
  let completionReplacements = 0;
  let goalCompletionOpportunities = 0;
  let goalCompletionBlocks = 0;
  for (const bucket of store.buckets) {
    if (bucket.version !== FALSE_SUCCESS_GUARD_VERSION) continue;
    if (bucket.category === COMPLETION_OPPORTUNITY_CATEGORY && bucket.outcome === "observed") {
      if (bucket.tool === "assistant_message") assistantCompletionOpportunities += bucket.count;
      else if (bucket.tool === "goal_complete") goalCompletionOpportunities += bucket.count;
      continue;
    }
    if (bucket.category !== "unverified_completion" || bucket.outcome !== "blocked") continue;
    if (bucket.tool === "assistant_message") completionReplacements += bucket.count;
    else if (bucket.tool === "goal_complete") goalCompletionBlocks += bucket.count;
  }
  return {
    guardVersion: FALSE_SUCCESS_GUARD_VERSION,
    assistantCompletionOpportunities,
    completionReplacements,
    goalCompletionOpportunities,
    goalCompletionBlocks,
  };
}

export function compactionAggregate(store: AggregateStore): CompactionAggregate {
  let compactionFrequency = 0;
  let fallbackCount = 0;
  const fallbackReasons: CompactionAggregate["fallbackReasons"] = [];
  for (const bucket of store.buckets) {
    if (bucket.tool === "compaction" && bucket.version === COMPACTION_FREQUENCY_VERSION) {
      compactionFrequency += bucket.count;
      continue;
    }
    if (bucket.tool !== "compaction_fallback") continue;
    const separator = bucket.category.lastIndexOf("/");
    if (separator <= 0 || separator === bucket.category.length - 1) continue;
    fallbackCount += bucket.count;
    fallbackReasons.push({
      model: bucket.model,
      strategy: bucket.category.slice(0, separator),
      outcome: bucket.outcome,
      reason: bucket.category.slice(separator + 1),
      count: bucket.count,
    });
  }
  return { compactionFrequency, fallbackCount, fallbackReasons };
}

export function publicAggregate(store: AggregateStore): Omit<AggregateStore, "seenEventHashes"> & {
  totalEvents: number;
  bucketCount: number;
  falseSuccessInterventionFrequency: FalseSuccessInterventionFrequency;
  compaction: CompactionAggregate;
} {
  const { seenEventHashes: _seen, ...safe } = store;
  return {
    ...safe,
    totalEvents: store.buckets.reduce((sum, bucket) => sum + bucket.count, 0),
    bucketCount: store.buckets.length,
    falseSuccessInterventionFrequency: falseSuccessInterventionFrequency(store),
    compaction: compactionAggregate(store),
  };
}

export function formatRepairMarkdown(store: AggregateStore): string {
  const view = publicAggregate(store);
  const lines = [
    "# Tool repair aggregate",
    "",
    `- Generated from store updated: ${view.updatedAt}`,
    `- Retention: ${view.retentionDays} Asia/Shanghai day(s), at most ${view.maxBuckets} buckets`,
    `- Events: ${view.totalEvents}`,
    `- Buckets: ${view.bucketCount}`,
    `- Analytics version: ${view.analyticsVersion}`,
    "- Scope: bounded cross-session aggregate; no raw prompts, arguments, paths, tool output, or discarded drafts",
    "",
    "## False-success intervention frequency",
    "",
    `- Persisted assistant completion replacements: ${view.falseSuccessInterventionFrequency.completionReplacements}/${view.falseSuccessInterventionFrequency.assistantCompletionOpportunities} observed terminal assistant completion(s)`,
    `- Persisted blocked goal completion calls: ${view.falseSuccessInterventionFrequency.goalCompletionBlocks}/${view.falseSuccessInterventionFrequency.goalCompletionOpportunities} observed goal_complete attempt(s)`,
    `- Guard version: ${view.falseSuccessInterventionFrequency.guardVersion}`,
    "- These are intervention frequencies, not false-positive rates; determining a false positive requires external adjudication.",
    "",
    "## Compaction frequency and fallback reasons",
    "",
    `- Compaction frequency (persisted successes): ${view.compaction.compactionFrequency}`,
    `- Bounded fallback events: ${view.compaction.fallbackCount}`,
    "- Fallback reasons retain only reviewed enum values; no summary, prompt, provider response, URL, header, credential, or cache key is recorded.",
    ...view.compaction.fallbackReasons.map((item) => `- ${item.model} · ${item.strategy} · ${item.outcome} · ${item.reason}: ${item.count}`),
    "",
    "| Day (Asia/Shanghai) | Model | Tool | Category | Outcome | Version | Count |",
    "|---|---|---|---|---|---|---:|",
  ];
  for (const bucket of view.buckets) {
    lines.push(`| ${bucket.day} | ${bucket.model} | ${bucket.tool} | ${bucket.category} | ${bucket.outcome} | ${bucket.version} | ${bucket.count} |`);
  }
  if (view.buckets.length === 0) lines.push("| — | — | — | — | — | — | 0 |");
  return lines.join("\n");
}

function metricFromError(entryId: string, error: ErrorObservation): RepairMetric {
  const outcome = error.category === "policy_blocked"
    || error.category === "workspace_escape"
    || error.category === "duplicate_call"
    || error.category === "repeated_call_blocked"
    ? "blocked"
    : error.followUpOutcome;
  return metric(entryId, error.timestamp, error.model, error.tool, error.category, outcome, SP_VERSION_ANCHOR);
}

export function createRepairMetric(
  entryId: string,
  timestamp: string,
  model: string | undefined,
  tool: string,
  category: string,
  outcome: string,
  version: string,
): RepairMetric {
  return metric(entryId, timestamp, model, tool, category, outcome, version);
}

function metric(
  entryId: string,
  timestamp: string,
  model: string | undefined,
  tool: string,
  category: string,
  outcome: string,
  version: string,
): RepairMetric {
  return {
    entryId,
    timestamp,
    day: dayKey(timestamp),
    model: dimension(model ?? UNKNOWN_MODEL),
    tool: dimension(tool),
    category: dimension(category),
    outcome: dimension(outcome),
    version: dimension(version),
    count: 1,
  };
}

function compactionObservation(details: unknown, fromHook: boolean | undefined): { model?: string; strategy: string } {
  if (details && typeof details === "object") {
    const value = details as Record<string, unknown>;
    const providerAware = value.providerAwareCompaction;
    if (providerAware && typeof providerAware === "object") {
      const audit = providerAware as Record<string, unknown>;
      const policy = typeof audit.policy === "string" && COMPACTION_STRATEGIES.has(audit.policy)
        ? audit.policy
        : "provider-aware-unknown";
      const model = isBoundedDimension(audit.targetModel) ? audit.targetModel : undefined;
      return { model, strategy: policy };
    }
    const remote = value.remoteCompaction;
    if (remote && typeof remote === "object") {
      const implementation = (remote as Record<string, unknown>).implementation;
      const strategy = implementation === "responses_compact_v1"
        ? "openai-remote-compaction-v1"
        : "openai-remote-compaction-v2";
      return { strategy };
    }
    if (value.maintenance === "tool-result-prune-v1") return { strategy: "tool-result-prune-v1" };
  }
  return { strategy: fromHook ? "extension-hook" : "pi-default" };
}

function parseCompactionAudit(data: unknown): {
  model: string;
  strategy: string;
  outcome: string;
  reason: string;
  producerVersion: string;
} | undefined {
  if (!data || typeof data !== "object") return undefined;
  const value = data as Record<string, unknown>;
  if (value.schemaVersion !== 1
    || !isBoundedDimension(value.model)
    || typeof value.strategy !== "string"
    || !COMPACTION_STRATEGIES.has(value.strategy)
    || typeof value.outcome !== "string"
    || !COMPACTION_OUTCOMES.has(value.outcome)
    || typeof value.reason !== "string"
    || !COMPACTION_REASONS.has(value.reason)
    || typeof value.producerVersion !== "string"
    || !COMPACTION_PRODUCER_VERSIONS.has(value.producerVersion)) return undefined;
  return {
    model: value.model,
    strategy: value.strategy,
    outcome: value.outcome,
    reason: value.reason,
    producerVersion: value.producerVersion,
  };
}

function parseInterventionAudit(data: unknown): {
  model: string;
  tool: string;
  category: string;
  outcome: string;
  guardVersion: string;
} | undefined {
  if (!data || typeof data !== "object") return undefined;
  const value = data as Record<string, unknown>;
  if (value.schemaVersion !== 1
    || typeof value.model !== "string"
    || typeof value.tool !== "string"
    || typeof value.category !== "string"
    || typeof value.outcome !== "string"
    || typeof value.guardVersion !== "string") return undefined;
  return {
    model: value.model,
    tool: value.tool,
    category: value.category,
    outcome: value.outcome,
    guardVersion: value.guardVersion,
  };
}

function normalizedBucket(metricValue: RepairMetric): RepairBucket {
  return {
    day: dimension(metricValue.day),
    model: dimension(metricValue.model),
    tool: dimension(metricValue.tool),
    category: dimension(metricValue.category),
    outcome: dimension(metricValue.outcome),
    version: dimension(metricValue.version),
    count: Math.max(1, Math.min(Number.MAX_SAFE_INTEGER, Math.floor(metricValue.count))),
  };
}

function bucketKey(bucket: Omit<RepairBucket, "count"> | RepairBucket): string {
  return `${bucket.day}\u0000${bucket.model}\u0000${bucket.tool}\u0000${bucket.category}\u0000${bucket.outcome}\u0000${bucket.version}`;
}

function compareBuckets(left: RepairBucket, right: RepairBucket): number {
  return right.day.localeCompare(left.day)
    || left.model.localeCompare(right.model)
    || left.tool.localeCompare(right.tool)
    || left.category.localeCompare(right.category)
    || left.outcome.localeCompare(right.outcome)
    || left.version.localeCompare(right.version);
}

function dayKey(timestamp: string): string {
  const parsed = Date.parse(timestamp);
  return DAY_FORMATTER.format(Number.isFinite(parsed) ? parsed : Date.now());
}

function modelName(provider: unknown, model: unknown): string {
  return typeof provider === "string" && typeof model === "string"
    ? `${provider}/${model}`
    : UNKNOWN_MODEL;
}

function isBoundedDimension(value: unknown): value is string {
  return typeof value === "string" && DIMENSION_RE.test(value);
}

function dimension(value: string): string {
  const normalized = value.replace(DIMENSION_UNSAFE_RE, "_").replace(DIMENSION_EDGE_UNDERSCORES_RE, "") || "unknown";
  return normalized.length <= DIMENSION_MAX_CHARS ? normalized : normalized.slice(0, DIMENSION_MAX_CHARS);
}
