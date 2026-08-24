import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  VERSION,
  compact,
  convertToLlm,
  sessionEntryToContextMessages,
  type CompactionResult,
  type ExtensionAPI,
  type SessionBeforeCompactEvent,
  type ToolInfo,
} from "@super-pi/coding-agent";
import type { AgentMessage } from "@super-pi/agent-core";
import { contentText, type Api, type Model, type ProviderHeaders } from "@super-pi/ai";
import { completeSimple, type Context, type Tool } from "@super-pi/ai/compat";

const SUPPORTED_SP_VERSION = /^0\.84\./;
const DEFAULT_FALLBACK_MODEL = "deepseek/deepseek-v4-flash";
const KIMI_RESERVE_TOKENS = 32_768;
const PROJECT_CONFIG_PATH = join(".sp", "config", "provider-aware-compaction.json");
const COMPACTION_TELEMETRY_TYPE = "compaction-telemetry-v1";
const PRODUCER_VERSION = "@super-pi/provider-aware-compaction@0.3.1-pi.84.1";
const PRESERVATION_FOCUS =
  "Preserve all binding constraints, exact identifiers, exact values, directed relationships, tool outputs, final corrections, decisions, and task checkpoints needed to continue. " +
  "If the history contains authoritative ledger-like state, preserve every still-current record and use the available output budget rather than dropping records merely to be concise.";
const ORIGINAL_PREFIX_INSTRUCTION = `The messages above are a conversation to summarize. Create a structured context checkpoint summary that another LLM will use to continue the work.

Use this EXACT format:

## Goal
[What is the user trying to accomplish? Can be multiple items if the session covers different tasks.]

## Constraints & Preferences
- [Any constraints, preferences, or requirements mentioned by user]
- [Or "(none)" if none were mentioned]

## Progress
### Done
- [x] [Completed tasks/changes]

### In Progress
- [ ] [Current work]

### Blocked
- [Issues preventing progress, if any]

## Key Decisions
- **[Decision]**: [Brief rationale]

## Next Steps
1. [Ordered list of what should happen next]

## Critical Context
- [Any data, examples, or references needed to continue]
- [Or "(none)" if not applicable]

Keep each section concise. Preserve exact file paths, function names, and error messages.
Do not call tools or continue the task. Output only the checkpoint summary.`;

type CompactFunction = typeof compact;
type BeforeCompactContext = Parameters<Parameters<ExtensionAPI["on"]>[1]>[1];
type ActiveModel = Pick<Model<Api>, "provider" | "id">;

export type OriginalPrefixInput = {
  preparation: SessionBeforeCompactEvent["preparation"];
  model: Model<Api>;
  apiKey?: string;
  headers?: ProviderHeaders;
  env?: Record<string, string>;
  systemPrompt: string;
  tools: Tool[];
  messages: Context["messages"];
  customInstructions?: string;
  signal: AbortSignal;
  thinkingLevel: ReturnType<ExtensionAPI["getThinkingLevel"]>;
  sessionId: string;
};
export type OriginalPrefixCompactFunction = (input: OriginalPrefixInput) => Promise<CompactionResult>;

export type CompactionPolicy = {
  id: "claude-deepseek-fallback-v1" | "deepseek-self-preserve-v1" | "kimi-self-preserve-32k-v1" | "custom-fallback-v1";
  summaryModel: "self" | string;
  reserveTokens?: number;
};

export type CrossProviderBoundary = { allowed: boolean; reason?: string };

export type ProviderAwareCompactionOptions = {
  compactFn?: CompactFunction;
  originalPrefixCompactFn?: OriginalPrefixCompactFunction;
  /** Legacy/custom single-provider override. When set, replaces built-in policy selection. */
  targetProvider?: string;
  fallbackModel?: string;
  /** Test/integration override for project data-boundary resolution. */
  crossProviderBoundaryFn?: (cwd: string, trusted: boolean) => CrossProviderBoundary;
};

export function parseModelSpecifier(specifier: string): { provider: string; modelId: string } | undefined {
  const separator = specifier.indexOf("/");
  if (separator < 1 || separator === specifier.length - 1) return undefined;
  return { provider: specifier.slice(0, separator), modelId: specifier.slice(separator + 1) };
}

export function buildCompactionFocus(customInstructions?: string): string {
  return customInstructions?.trim()
    ? `${PRESERVATION_FOCUS}\n\nUser compaction focus: ${customInstructions.trim()}`
    : PRESERVATION_FOCUS;
}

export function buildOriginalPrefixInstruction(customInstructions?: string): string {
  const focus = buildCompactionFocus(customInstructions);
  return `${ORIGINAL_PREFIX_INSTRUCTION}\n\nAdditional focus: ${focus}`;
}

export function buildActiveToolSchemas(activeNames: string[], allTools: ToolInfo[]): Tool[] {
  const byName = new Map(allTools.map((tool) => [tool.name, tool]));
  return activeNames.map((name) => {
    const tool = byName.get(name);
    if (!tool) throw new Error(`active tool schema is unavailable: ${name}`);
    return { name: tool.name, description: tool.description, parameters: tool.parameters };
  });
}

export function buildOriginalPrefixMessages(
  event: SessionBeforeCompactEvent,
  contextEntries: ReturnType<BeforeCompactContext["sessionManager"]["buildContextEntries"]>,
): Context["messages"] {
  const firstKeptIndex = contextEntries.findIndex((entry) => entry.id === event.preparation.firstKeptEntryId);
  if (firstKeptIndex < 1) {
    throw new Error("original compaction prefix boundary is unavailable");
  }
  const messages: AgentMessage[] = [];
  for (let index = 0; index < firstKeptIndex; index += 1) {
    messages.push(...sessionEntryToContextMessages(contextEntries[index]));
  }
  const converted = convertToLlm(messages);
  if (converted.length === 0) throw new Error("original compaction prefix has no model-visible messages");
  return converted;
}

function computeFileLists(fileOps: SessionBeforeCompactEvent["preparation"]["fileOps"]): { readFiles: string[]; modifiedFiles: string[] } {
  const modified = new Set([...fileOps.edited, ...fileOps.written]);
  return {
    readFiles: [...fileOps.read].filter((file) => !modified.has(file)).sort(),
    modifiedFiles: [...modified].sort(),
  };
}

function formatFileOperations(readFiles: string[], modifiedFiles: string[]): string {
  const sections: string[] = [];
  if (readFiles.length > 0) sections.push(`<read-files>\n${readFiles.join("\n")}\n</read-files>`);
  if (modifiedFiles.length > 0) sections.push(`<modified-files>\n${modifiedFiles.join("\n")}\n</modified-files>`);
  return sections.length === 0 ? "" : `\n\n${sections.join("\n\n")}`;
}

export async function compactWithOriginalPrefix(input: OriginalPrefixInput): Promise<CompactionResult> {
  const maxTokens = Math.min(
    Math.floor(0.8 * input.preparation.settings.reserveTokens),
    input.model.maxTokens > 0 ? input.model.maxTokens : Number.POSITIVE_INFINITY,
  );
  const messages: Context["messages"] = [
    ...input.messages,
    {
      role: "user",
      content: [{ type: "text", text: buildOriginalPrefixInstruction(input.customInstructions) }],
      timestamp: Date.now(),
    },
  ];
  const response = await completeSimple(
    input.model,
    { systemPrompt: input.systemPrompt, tools: input.tools, messages },
    {
      maxTokens,
      apiKey: input.apiKey,
      headers: input.headers,
      env: input.env,
      signal: input.signal,
      sessionId: input.sessionId,
      ...(input.model.reasoning && input.thinkingLevel !== "off" ? { reasoning: input.thinkingLevel } : {}),
    },
  );
  if (response.stopReason === "error") {
    throw new Error(`Summarization failed: ${response.errorMessage || "Unknown error"}`);
  }
  const summaryText = contentText(response.content);
  const { readFiles, modifiedFiles } = computeFileLists(input.preparation.fileOps);
  const runtimePreparation = input.preparation as SessionBeforeCompactEvent["preparation"] & {
    retainedTail?: AgentMessage[];
  };
  return {
    summary: summaryText + formatFileOperations(readFiles, modifiedFiles),
    firstKeptEntryId: input.preparation.firstKeptEntryId,
    tokensBefore: input.preparation.tokensBefore,
    usage: response.usage,
    retainedTail: runtimePreparation.retainedTail,
    details: { readFiles, modifiedFiles },
  } as CompactionResult;
}

export function stringHeaders(headers: Record<string, string | null> | undefined): Record<string, string> | undefined {
  if (!headers) return undefined;
  if (Object.values(headers).some((value) => value === null)) {
    throw new Error("legacy compaction cannot preserve provider header deletion markers");
  }
  return headers as Record<string, string>;
}

function hasHeaderDeletionMarker(headers: ProviderHeaders | undefined): boolean {
  return Object.values(headers ?? {}).some((value) => value === null);
}

export function projectCrossProviderBoundary(cwd: string, trusted: boolean): CrossProviderBoundary {
  const processOverride = process.env.SP_PORTABLE_COMPACTION_ALLOW_CROSS_PROVIDER;
  if (processOverride === "0") {
    return { allowed: false, reason: "disabled by SP_PORTABLE_COMPACTION_ALLOW_CROSS_PROVIDER" };
  }
  if (processOverride === "1") return { allowed: true };
  if (!trusted) {
    return { allowed: false, reason: "project is not trusted; explicit process approval is required" };
  }
  try {
    const parsed = JSON.parse(readFileSync(join(cwd, PROJECT_CONFIG_PATH), "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { allowed: false, reason: `${PROJECT_CONFIG_PATH} must contain a JSON object` };
    }
    const value = (parsed as { allowCrossProviderSummary?: unknown }).allowCrossProviderSummary;
    if (value === undefined) {
      return { allowed: false, reason: `${PROJECT_CONFIG_PATH}.allowCrossProviderSummary must be explicitly set to true` };
    }
    if (typeof value !== "boolean") {
      return { allowed: false, reason: `${PROJECT_CONFIG_PATH}.allowCrossProviderSummary must be boolean` };
    }
    return value ? { allowed: true } : { allowed: false, reason: `disabled by ${PROJECT_CONFIG_PATH}` };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { allowed: false, reason: `${PROJECT_CONFIG_PATH} must explicitly allow cross-provider summarization` };
    }
    const message = error instanceof Error ? error.message : String(error);
    return { allowed: false, reason: `cannot read ${PROJECT_CONFIG_PATH}: ${message}` };
  }
}

export function defaultCompactionPolicy(model: ActiveModel): CompactionPolicy | undefined {
  if (model.provider === "superapi-claude") {
    return { id: "claude-deepseek-fallback-v1", summaryModel: DEFAULT_FALLBACK_MODEL };
  }
  if (model.provider === "deepseek" && model.id === "deepseek-v4-flash") {
    return { id: "deepseek-self-preserve-v1", summaryModel: "self" };
  }
  if (model.provider === "kimi-coding" && model.id === "k3-256k") {
    return { id: "kimi-self-preserve-32k-v1", summaryModel: "self", reserveTokens: KIMI_RESERVE_TOKENS };
  }
  return undefined;
}

function notifyFailure(ctx: BeforeCompactContext, message: string): void {
  if (ctx.hasUI) ctx.ui.notify(message, "warning");
}

type CompactionFallbackReason =
  | "cross_provider_denied"
  | "invalid_summary_model"
  | "summary_model_missing"
  | "auth_lookup_failed"
  | "auth_unavailable"
  | "empty_summary"
  | "summarization_aborted"
  | "summarization_failed";

function recordFallback(
  pi: ExtensionAPI,
  model: ActiveModel,
  strategy: CompactionPolicy["id"],
  reason: CompactionFallbackReason,
  outcome = "cancelled",
): void {
  try {
    const modelName = `${model.provider}/${model.id}`.replace(/[^A-Za-z0-9._/@:+-]+/gu, "_").slice(0, 120) || "not-recorded";
    pi.appendEntry(COMPACTION_TELEMETRY_TYPE, {
      schemaVersion: 1,
      model: modelName,
      strategy,
      outcome,
      reason,
      producerVersion: PRODUCER_VERSION,
    });
  } catch {
    // Telemetry must never alter fail-closed compaction behavior.
  }
}

export function createProviderAwareCompactionExtension(options: ProviderAwareCompactionOptions = {}) {
  const compactFn = options.compactFn ?? compact;
  const originalPrefixCompactFn = options.originalPrefixCompactFn ?? compactWithOriginalPrefix;
  const configuredTargetProvider = options.targetProvider ?? process.env.SP_PORTABLE_COMPACTION_TARGET_PROVIDER;
  const configuredFallbackModel = options.fallbackModel ?? process.env.SP_PORTABLE_COMPACTION_FALLBACK_MODEL ?? DEFAULT_FALLBACK_MODEL;
  const boundaryFn = options.crossProviderBoundaryFn ?? projectCrossProviderBoundary;

  return function providerAwareCompactionExtension(pi: ExtensionAPI): void {
    if (!SUPPORTED_SP_VERSION.test(VERSION)) {
      console.warn(`@super-pi/provider-aware-compaction disabled: Pi ${VERSION} is unsupported (requires 0.84.x).`);
      return;
    }
    if (process.env.SP_PORTABLE_COMPACTION_FALLBACK === "0") return;

    pi.on("session_before_compact", async (event: SessionBeforeCompactEvent, ctx) => {
      const activeModel = ctx.model;
      if (!activeModel) return undefined;

      const policy = configuredTargetProvider
        ? activeModel.provider === configuredTargetProvider
          ? { id: "custom-fallback-v1" as const, summaryModel: configuredFallbackModel }
          : undefined
        : defaultCompactionPolicy(activeModel);
      if (!policy) return undefined;

      if (policy.id === "claude-deepseek-fallback-v1" || policy.id === "custom-fallback-v1") {
        const boundary = boundaryFn(ctx.cwd, ctx.isProjectTrusted());
        if (!boundary.allowed) {
          recordFallback(pi, activeModel, policy.id, "cross_provider_denied");
          notifyFailure(ctx, `Cross-provider compaction cancelled: ${boundary.reason ?? "project policy denied it"}.`);
          return { cancel: true };
        }
      }

      let summaryModel: Model<Api> | undefined;
      let summaryModelSpecifier: string;
      if (policy.summaryModel === "self") {
        summaryModel = activeModel;
        summaryModelSpecifier = `${activeModel.provider}/${activeModel.id}`;
      } else {
        const fallback = parseModelSpecifier(policy.summaryModel);
        if (!fallback) {
          recordFallback(pi, activeModel, policy.id, "invalid_summary_model");
          notifyFailure(ctx, `Compaction cancelled: invalid summary model ${policy.summaryModel}.`);
          return { cancel: true };
        }
        summaryModel = ctx.modelRegistry.find(fallback.provider, fallback.modelId);
        summaryModelSpecifier = policy.summaryModel;
      }
      if (!summaryModel) {
        recordFallback(pi, activeModel, policy.id, "summary_model_missing");
        notifyFailure(ctx, `Compaction cancelled: summary model ${summaryModelSpecifier} is not configured.`);
        return { cancel: true };
      }

      let stage: "authentication" | "summarization" = "authentication";
      try {
        const auth = await ctx.modelRegistry.getApiKeyAndHeaders(summaryModel);
        if (event.signal.aborted) {
          recordFallback(pi, activeModel, policy.id, "summarization_aborted");
          return { cancel: true };
        }
        if (!auth.ok) {
          recordFallback(pi, activeModel, policy.id, "auth_unavailable");
          notifyFailure(ctx, `Compaction cancelled: ${auth.error}`);
          return { cancel: true };
        }

        const preparation = policy.reserveTokens
          ? {
              ...event.preparation,
              settings: { ...event.preparation.settings, reserveTokens: policy.reserveTokens },
            }
          : event.preparation;
        stage = "summarization";
        const useOriginalPrefix = policy.id === "deepseek-self-preserve-v1" || hasHeaderDeletionMarker(auth.headers);
        const result = useOriginalPrefix
          ? await originalPrefixCompactFn({
              preparation,
              model: summaryModel,
              apiKey: auth.apiKey,
              headers: auth.headers,
              env: auth.env,
              systemPrompt: ctx.getSystemPrompt(),
              tools: buildActiveToolSchemas(pi.getActiveTools(), pi.getAllTools()),
              messages: buildOriginalPrefixMessages(event, ctx.sessionManager.buildContextEntries()),
              customInstructions: event.customInstructions,
              signal: event.signal,
              thinkingLevel: pi.getThinkingLevel(),
              sessionId: ctx.sessionManager.getSessionId(),
            })
          : await compactFn(
              preparation,
              summaryModel,
              auth.apiKey,
              stringHeaders(auth.headers),
              buildCompactionFocus(event.customInstructions),
              event.signal,
              pi.getThinkingLevel(),
              undefined,
              auth.env,
            );
        if (!result.summary.trim()) {
          recordFallback(pi, activeModel, policy.id, "empty_summary");
          notifyFailure(ctx, "Compaction cancelled: summary model returned an empty summary.");
          return { cancel: true };
        }
        return {
          compaction: {
            ...result,
            details: {
              ...(result.details && typeof result.details === "object" ? result.details : {}),
              providerAwareCompaction: {
                version: 3,
                targetModel: `${activeModel.provider}/${activeModel.id}`,
                summaryModel: summaryModelSpecifier,
                policy: policy.id,
                reserveTokens: preparation.settings.reserveTokens,
                requestShape: useOriginalPrefix ? "original-prefix-v1" : "standalone-summary-v2",
              },
            },
          },
        };
      } catch (error) {
        const reason = event.signal.aborted
          ? "summarization_aborted"
          : stage === "authentication"
            ? "auth_lookup_failed"
            : "summarization_failed";
        recordFallback(
          pi,
          activeModel,
          policy.id,
          reason,
        );
        if (!event.signal.aborted) {
          const message = error instanceof Error ? error.message : String(error);
          notifyFailure(ctx, `Compaction cancelled: ${stage} failed. ${message}`);
        }
        return { cancel: true };
      }
    });
  };
}

export default createProviderAwareCompactionExtension();
