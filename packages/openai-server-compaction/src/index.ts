/**
 * Main extension entrypoint.
 *
 * Wires together request patching, remote compaction, runtime state
 * reconstruction, session lifecycle cleanup, and provider override registration.
 */
import { createHash, randomUUID } from "node:crypto";
import {
  VERSION,
  convertToLlm,
  sessionEntryToContextMessages,
  type ExtensionAPI,
  type ExtensionContext,
  type SessionBeforeCompactEvent,
  type SessionEntry,
} from "@super-pi/coding-agent";
import type { AgentMessage, ThinkingLevel } from "@super-pi/agent-core";
import type { Model, ProviderHeaders } from "@super-pi/ai";
import { isRecord, loadConfig, type ExtensionConfig } from "./config.ts";
import {
  COMPACTION_CONTINUATION_MESSAGE_TYPE,
  COMPACTION_CONTINUATION_PROMPT,
  shouldQueueCompactionContinuation,
} from "./continuity.ts";
import { streamOpenAIResponsesWithPhase2B } from "./custom-stream.ts";
import {
  applyPayloadPatch,
  applyRemoteHistoryPayloadPatch,
  extractAssistantResponseId,
  extractResponsesReasoningConfig,
  extractResponsesServiceTier,
  extractResponsesTextConfig,
  isOpenAICodexResponsesModel,
  looksLikeResponsesPayload,
  messageMatchesModel,
  modelKey,
  supportsPreviousResponseId,
  supportsRemoteCompactionModel,
} from "./openai.ts";
import { releaseAllWsSessions, releaseWsSession } from "./openai-ws-stream.ts";
import { SUPPORTED_SP_VERSION_PATTERN } from "./regex.ts";
import { unknownText } from "./text.ts";
import {
  buildCustomInstructionFallbackSummary,
  buildEmergencyContinuitySummary,
  buildRemoteCompactionDetails,
  buildRemoteCompactionV2History,
  callRemoteCompactionEndpoint,
  extractRemoteCompactionUsage,
  generateBestEffortLocalSummary,
  messageToResponseItems,
  messagesToResponseItems,
  normalizeResponseItemsForPrompt,
  PORTABLE_SUMMARY_MAX_TOKENS,
  reconstructRemoteCompactionStateFromBranch,
  resolveRemoteCompactionServiceTier,
  type RemoteCompactionServiceTier,
  type RemoteCompactionResult,
  type RemoteCompactionUsageSnapshot,
  type ResponseItem,
} from "./remote-compaction.ts";
import {
  clearAllContinuationState,
  clearContinuationState,
  clearRemoteCompactionState,
  clearResponsesRequestShapeState,
  clearSessionDedupState,
  clearSessionConfig,
  clearTransportContextState,
  claimCompactionContinuation,
  getContinuationState,
  getTransportContextState,
  getRemoteCompactionState,
  markMessageProcessed,
  setContinuationState,
  setRemoteCompactionState,
  setResponsesRequestShapeState,
  setSessionConfig,
} from "./state.ts";

type TargetModel = Parameters<typeof modelKey>[0];
type CompactionAuthSnapshot = {
  model: Model<any>;
  apiKey?: string;
  headers?: ProviderHeaders;
  env?: Record<string, string>;
};
type ProviderRequestPayloadAPI = ExtensionAPI & {
  buildProviderRequestPayload?: (input: {
    systemPrompt: string;
    messages: AgentMessage[];
  }) => Promise<Record<string, unknown> | undefined>;
  compactProviderRequestPayload?: (input: {
    regularPayload: Record<string, unknown>;
    signal: AbortSignal;
    shapeDiagnostics?: boolean;
    auth?: CompactionAuthSnapshot;
  }) => Promise<{
    compactionItem: Record<string, unknown>;
    usage?: unknown;
    diagnostics?: Record<string, unknown>;
  } | undefined>;
};
const COMPACTION_TELEMETRY_TYPE = "compaction-telemetry-v1";
const COMPACTION_USAGE_LEDGER_TYPE = "compaction-usage-ledger-v2";
const COMPACTION_STRATEGY = "openai-remote-compaction-v2";
const REMOTE_COMPACTION_CAPABILITY_KEY = Symbol.for("@super-pi/ai/codex-remote-compaction-sessions");
const PRODUCER_VERSION = "@super-pi/openai-server-compaction@0.1.22-pi.84.1";
const CANCEL_COMPACTION_RESULT = Object.freeze({ cancel: true as const });

function setTransportRemoteCompactionCapability(sessionId: string, enabled: boolean): void {
  const state = globalThis as Record<symbol, unknown>;
  let sessions = state[REMOTE_COMPACTION_CAPABILITY_KEY];
  if (!(sessions instanceof Set)) {
    if (!enabled) return;
    sessions = new Set<string>();
    state[REMOTE_COMPACTION_CAPABILITY_KEY] = sessions;
  }
  const sessionSet = sessions as Set<string>;
  if (enabled) sessionSet.add(sessionId);
  else sessionSet.delete(sessionId);
}

export type GptCompactionFailureClass =
  | "authentication_missing_credentials"
  | "authentication_lookup_failed"
  | "request_preview_failed"
  | "request_preview_invalid_payload"
  | "missing_regular_commitment"
  | "request_shape_drift"
  | "websocket_unavailable"
  | "websocket_busy"
  | "continuation_unavailable"
  | "connection_expired"
  | "provider_protocol_invalid"
  | "provider_native_failed"
  | "portable_summary_failed";

function isGptSeriesModel(model: Model<any>): boolean {
  return model.id.toLowerCase().startsWith("gpt-");
}

export function classifyGptCompactionFailure(stage: string, error: unknown): GptCompactionFailureClass {
  const message = unknownText(error).toLowerCase();
  if (stage === "authentication") {
    return message.includes("api key unavailable")
      ? "authentication_missing_credentials"
      : "authentication_lookup_failed";
  }
  if (stage === "request_preview") {
    return message.includes("canonical provider payload was unavailable or invalid")
      ? "request_preview_invalid_payload"
      : "request_preview_failed";
  }
  if (stage === "portable_summary") return "portable_summary_failed";
  if (message.includes("no successful regular request commitment")) return "missing_regular_commitment";
  if (
    message.includes("differ from the last successful request") ||
    message.includes("differs from the last successful request") ||
    message.includes("continuation identity drifted") ||
    message.includes("continuation prefix drifted") ||
    message.includes("connection headers drifted")
  ) return "request_shape_drift";
  if (
    message.includes("websocket transport is not available") ||
    message.includes("last successful websocket connection is unavailable")
  ) return "websocket_unavailable";
  if (message.includes("session websocket is busy")) return "websocket_busy";
  if (message.includes("websocket continuation is unavailable")) return "continuation_unavailable";
  if (message.includes("websocket connection expired")) return "connection_expired";
  if (
    message.includes("incomplete response") ||
    message.includes("response stream ended before completion") ||
    message.includes("expected one compaction item") ||
    message.includes("returned no valid compaction item")
  ) return "provider_protocol_invalid";
  return "provider_native_failed";
}

function failGptCompaction(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  model: Model<any>,
  stage: string,
  error: unknown,
): { readonly cancel: true } {
  const reason = unknownText(error).slice(0, 512);
  const failureClass = classifyGptCompactionFailure(stage, error);
  try {
    pi.appendEntry(COMPACTION_TELEMETRY_TYPE, {
      schemaVersion: 1,
      model: `${model.provider}/${model.id}`.replace(/[^A-Za-z0-9._/@:+-]+/gu, "_").slice(0, 120),
      strategy: COMPACTION_STRATEGY,
      outcome: "failed_closed",
      reason: stage,
      failureClass,
      producerVersion: PRODUCER_VERSION,
    });
  } catch { }
  const message = `GPT native compaction stopped at ${stage}: ${reason}`;
  if (ctx.hasUI) ctx.ui.notify(message, "error");
  return CANCEL_COMPACTION_RESULT;
}

async function callConfiguredRemoteCompaction(
  pi: ExtensionAPI,
  params: {
    model: Model<any>;
    apiKey: string;
    headers?: ProviderHeaders;
    sessionId: string;
    regularPayload: Record<string, unknown>;
    input: ResponseItem[];
    serviceTier?: RemoteCompactionServiceTier;
    shapeDiagnostics: boolean;
    signal: AbortSignal;
    auth: CompactionAuthSnapshot;
  },
): Promise<RemoteCompactionResult> {
  if (!isOpenAICodexResponsesModel(params.model)) return callRemoteCompactionEndpoint(params);
  const compactProviderRequestPayload = (pi as ProviderRequestPayloadAPI).compactProviderRequestPayload;
  if (typeof compactProviderRequestPayload !== "function") {
    throw new Error("The active Pi runtime does not expose provider-native Codex compaction.");
  }
  const result = await compactProviderRequestPayload.call(pi, {
    regularPayload: params.regularPayload,
    signal: params.signal,
    shapeDiagnostics: params.shapeDiagnostics,
    auth: params.auth,
  });
  if (!result || !isRecord(result.compactionItem) || result.compactionItem.type !== "compaction") {
    throw new Error("Provider-native Codex compaction returned no valid compaction item.");
  }
  return {
    protocol: "responses_compaction_v2",
    output: buildRemoteCompactionV2History(params.input, result.compactionItem as ResponseItem),
    usage: extractRemoteCompactionUsage(params.model, result.usage),
    ...(params.shapeDiagnostics && isRecord(result.diagnostics)
      ? { shapeDiagnostics: result.diagnostics }
      : {}),
  };
}

export function resolveEffectiveRemoteCompactionServiceTier(
  model: Model<any>,
  observedServiceTier: RemoteCompactionServiceTier | undefined,
  sessionId: string,
): RemoteCompactionServiceTier | undefined {
  return resolveRemoteCompactionServiceTier(model, sessionId) ?? observedServiceTier;
}

export function recordCompactionFallback(
  pi: ExtensionAPI,
  model: TargetModel,
  outcome: "cancelled" | "local_fallback_succeeded" | "default_fallback_requested" | "remote_success_with_emergency_summary",
  reason: "aborted" | "remote_failed" | "remote_and_local_failed" | "local_summary_failed",
): void {
  try {
    const modelName = `${model.provider}/${model.id}`.replace(/[^A-Za-z0-9._/@:+-]+/gu, "_").slice(0, 120) || "not-recorded";
    pi.appendEntry(COMPACTION_TELEMETRY_TYPE, {
      schemaVersion: 1,
      model: modelName,
      strategy: COMPACTION_STRATEGY,
      outcome,
      reason,
      producerVersion: PRODUCER_VERSION,
    });
  } catch {
    // Best-effort telemetry must not alter compaction or fallback behavior.
  }
}

type BranchEntry = {
  type: string;
  id: string;
  details?: unknown;
  message?: unknown;
  thinkingLevel?: unknown;
};

type SessionContextLike = {
  cwd: string;
  isProjectTrusted(): boolean;
  sessionManager: {
    getSessionId(): string;
    getBranch(): BranchEntry[];
    buildContextEntries(): SessionEntry[];
  };
};

function getSessionId(ctx: SessionContextLike): string {
  return ctx.sessionManager.getSessionId();
}

function loadContextConfig(ctx: Pick<SessionContextLike, "cwd" | "isProjectTrusted">) {
  return loadConfig(ctx.cwd, ctx.isProjectTrusted());
}

export function getContextMessages(contextEntries: readonly SessionEntry[]): AgentMessage[] {
  const messages: AgentMessage[] = [];
  for (const entry of contextEntries) {
    if (entry.type === "compaction") {
      // Pi 0.84.1 omits retainedTail here, while the local runtime backport
      // materializes it. Construct the summary directly so both runtimes add
      // the retained tail exactly once without cloning the entry.
      messages.push({
        role: "compactionSummary",
        summary: entry.summary,
        tokensBefore: entry.tokensBefore,
        timestamp: Date.parse(entry.timestamp),
      });
      const retainedTail = (entry as SessionEntry & { retainedTail?: AgentMessage[] }).retainedTail;
      if (retainedTail) {
        for (const message of retainedTail) messages.push(message);
      }
      continue;
    }
    const entryMessages = sessionEntryToContextMessages(entry);
    for (const message of entryMessages) messages.push(message);
  }
  return messages;
}

function appendCompactionUsageLedger(
  pi: ExtensionAPI,
  model: TargetModel,
  component: "portable_summary" | "remote_compaction",
  usage: RemoteCompactionUsageSnapshot | undefined,
  remoteResult?: Pick<RemoteCompactionResult, "protocol" | "output">,
): string | undefined {
  if (!usage && !remoteResult) return undefined;
  const operationId = randomUUID();
  const modelName = `${model.provider}/${model.id}`.replace(/[^A-Za-z0-9._/@:+-]+/gu, "_").slice(0, 120) || "not-recorded";
  const protocol = remoteResult?.protocol;
  const artifact = remoteResult?.output.at(-1);
  const artifactSha256 = artifact
    ? createHash("sha256").update(JSON.stringify({ protocol, artifact })).digest("hex")
    : undefined;
  pi.appendEntry(COMPACTION_USAGE_LEDGER_TYPE, {
    schemaVersion: 2,
    operationId,
    model: modelName,
    strategy: COMPACTION_STRATEGY,
    component,
    status: "provider_completed",
    ...(usage ? { usage } : {}),
    ...(protocol ? { protocol } : {}),
    ...(artifactSha256 ? { artifactSha256 } : {}),
    completedAt: new Date().toISOString(),
    producerVersion: PRODUCER_VERSION,
  });
  return operationId;
}

export function buildNativeCompactionInput(
  remoteState: ReturnType<typeof getRemoteCompactionState>,
  contextMessages: AgentMessage[],
  model: TargetModel,
): ReturnType<typeof normalizeResponseItemsForPrompt> {
  const source = remoteState?.explicitHistory
    ?? messagesToResponseItems(convertToLlm(contextMessages));
  return normalizeResponseItemsForPrompt(source, model);
}

export type CanonicalCompactionRequest = {
  payload: Record<string, unknown>;
  input: ResponseItem[];
  serviceTier?: RemoteCompactionServiceTier;
};

export function extractCanonicalCompactionRequest(
  payload: Record<string, unknown>,
  model: TargetModel,
  sessionId: string,
): CanonicalCompactionRequest | undefined {
  if (payload.model !== model.id || payload.prompt_cache_key !== sessionId) return undefined;
  if (!Array.isArray(payload.input) || typeof payload.instructions !== "string") return undefined;

  const sourceInput = payload.input;
  let normalizedInput: ResponseItem[] | undefined;
  for (let index = 0; index < sourceInput.length; index += 1) {
    const item = sourceInput[index];
    if (!isRecord(item)) return undefined;
    if (typeof item.type === "string") {
      if (normalizedInput) normalizedInput.push(item as ResponseItem);
      continue;
    }
    // The authoritative Codex builder emits Responses easy-input messages as
    // { role, content } without type. Preserve the request payload byte shape;
    // normalize only the internal history view used after compaction succeeds.
    if (typeof item.role !== "string" || !Array.isArray(item.content)) return undefined;
    if (!normalizedInput) normalizedInput = sourceInput.slice(0, index) as ResponseItem[];
    normalizedInput.push({ ...item, type: "message" } as ResponseItem);
  }

  return {
    payload,
    input: normalizedInput ?? sourceInput as ResponseItem[],
    serviceTier: extractResponsesServiceTier(payload),
  };
}

export function selectPortableSummaryModel(
  currentModel: Model<any>,
  configuredModelId: string,
  inputTokens: number,
  modelRegistry: { find(provider: string, modelId: string): Model<any> | undefined },
): Model<any> {
  const modelId = configuredModelId.trim();
  if (!modelId || modelId === "current" || modelId === currentModel.id) return currentModel;

  const candidate = modelRegistry.find(currentModel.provider, modelId);
  if (!candidate || candidate.provider !== currentModel.provider) return currentModel;
  if (candidate.input && !candidate.input.includes("text")) return currentModel;
  const outputBudget = Math.min(
    PORTABLE_SUMMARY_MAX_TOKENS,
    candidate.maxTokens > 0 ? candidate.maxTokens : PORTABLE_SUMMARY_MAX_TOKENS,
  );
  return candidate.contextWindow >= inputTokens + outputBudget ? candidate : currentModel;
}

export function shouldGeneratePortableModelSummary(
  mode: Required<ExtensionConfig>["portableSummaryMode"],
  customInstructions: string | undefined,
  remoteSucceeded: boolean,
): boolean {
  return !remoteSucceeded || mode === "always" || Boolean(customInstructions?.trim());
}

export type SettledResult<T> =
  | { status: "fulfilled"; value: T }
  | { status: "rejected"; reason: unknown };

export async function settlePromise<T>(promise: Promise<T>): Promise<SettledResult<T>> {
  try {
    return { status: "fulfilled", value: await promise };
  } catch (reason) {
    return { status: "rejected", reason };
  }
}

async function generateConfiguredLocalSummary(params: {
  model: Model<any>;
  config: Required<ExtensionConfig>;
  inputTokens: number;
  ctx: Pick<ExtensionContext, "modelRegistry" | "hasUI" | "ui">;
  activeAuth: { apiKey: string; headers?: ProviderHeaders };
  preparation: SessionBeforeCompactEvent["preparation"];
  messages: AgentMessage[];
  sessionId: string;
  customInstructions?: string;
  signal: AbortSignal;
  thinkingLevel?: ThinkingLevel;
}) {
  let summaryModel = selectPortableSummaryModel(
    params.model,
    params.config.portableSummaryModel,
    params.inputTokens,
    params.ctx.modelRegistry,
  );
  let summaryApiKey = params.activeAuth.apiKey;
  let summaryHeaders = params.activeAuth.headers;
  if (summaryModel !== params.model) {
    try {
      const resolvedSummaryAuth = await params.ctx.modelRegistry.getApiKeyAndHeaders(summaryModel);
      if (resolvedSummaryAuth.ok && resolvedSummaryAuth.apiKey) {
        summaryApiKey = resolvedSummaryAuth.apiKey;
        summaryHeaders = resolvedSummaryAuth.headers;
      } else {
        summaryModel = params.model;
      }
    } catch {
      summaryModel = params.model;
    }
    if (summaryModel === params.model && params.ctx.hasUI) {
      params.ctx.ui.notify("Configured portable summary model is unavailable; using the active model.", "warning");
    }
  }

  return generateBestEffortLocalSummary({
    preparation: params.preparation,
    messages: params.messages,
    model: summaryModel,
    apiKey: summaryApiKey,
    headers: summaryHeaders,
    sessionId: params.sessionId,
    customInstructions: params.customInstructions,
    signal: params.signal,
    thinkingLevel: params.thinkingLevel,
  });
}

export function bindLocalCheckpointToPreparation<T extends { summary: string }>(
  result: T,
  preparation: { firstKeptEntryId: string; tokensBefore: number; retainedTail?: AgentMessage[] },
): T & { firstKeptEntryId: string; tokensBefore: number; retainedTail?: AgentMessage[] } {
  return {
    ...result,
    firstKeptEntryId: preparation.firstKeptEntryId,
    tokensBefore: preparation.tokensBefore,
    ...(preparation.retainedTail ? { retainedTail: preparation.retainedTail } : {}),
  };
}

export function bindRemoteUsageToCompaction<T extends object>(
  compaction: T,
  usage: RemoteCompactionUsageSnapshot | undefined,
): T & { usage?: RemoteCompactionUsageSnapshot } {
  return usage ? { ...compaction, usage } : compaction;
}

export function combineCompactionUsage(
  first: RemoteCompactionUsageSnapshot | undefined,
  second: RemoteCompactionUsageSnapshot | undefined,
): RemoteCompactionUsageSnapshot | undefined {
  if (!first) return second;
  if (!second) return first;
  return {
    input: first.input + second.input,
    output: first.output + second.output,
    cacheRead: first.cacheRead + second.cacheRead,
    cacheWrite: first.cacheWrite + second.cacheWrite,
    totalTokens: first.totalTokens + second.totalTokens,
    cost: {
      input: first.cost.input + second.cost.input,
      output: first.cost.output + second.cost.output,
      cacheRead: first.cost.cacheRead + second.cost.cacheRead,
      cacheWrite: first.cost.cacheWrite + second.cost.cacheWrite,
      total: first.cost.total + second.cost.total,
    },
  };
}

function clearLiveContinuation(sessionId: string | undefined): void {
  clearContinuationState(sessionId);
  releaseWsSession(sessionId);
}

function clearSessionRuntimeState(sessionId: string | undefined): void {
  clearLiveContinuation(sessionId);
  clearRemoteCompactionState(sessionId);
  clearResponsesRequestShapeState(sessionId);
  clearSessionDedupState(sessionId);
  clearSessionConfig(sessionId);
}

export function buildCompactionUsageComponents(params: {
  remoteCompaction?: RemoteCompactionUsageSnapshot;
  portableSummary?: RemoteCompactionUsageSnapshot;
  fallbackSummary?: RemoteCompactionUsageSnapshot;
}): Record<string, RemoteCompactionUsageSnapshot> {
  const components: Record<string, RemoteCompactionUsageSnapshot> = {};
  if (params.remoteCompaction) components.remoteCompaction = params.remoteCompaction;
  if (params.portableSummary) components.portableSummary = params.portableSummary;
  if (params.fallbackSummary) components.fallbackSummary = params.fallbackSummary;
  return components;
}

function syncRemoteState(ctx: SessionContextLike): void {
  const sessionId = getSessionId(ctx);
  const branchEntries = ctx.sessionManager.getBranch() as Array<{
    type: string;
    id: string;
    details?: unknown;
    message?: AgentMessage;
  }>;
  const state = reconstructRemoteCompactionStateFromBranch({ branchEntries });
  if (state) {
    setRemoteCompactionState(sessionId, state);
  } else {
    clearRemoteCompactionState(sessionId);
  }
}

function getMatchingRemoteState(
  sessionId: string,
  model: TargetModel | undefined,
): ReturnType<typeof getRemoteCompactionState> {
  if (!model) return undefined;
  const remoteState = getRemoteCompactionState(sessionId);
  return remoteState && remoteState.modelKey === modelKey(model) ? remoteState : undefined;
}

function extendRemoteHistoryIfCompatible(params: {
  sessionId: string;
  model: TargetModel | undefined;
  message: AgentMessage;
}): void {
  const remoteState = getMatchingRemoteState(params.sessionId, params.model);
  if (!remoteState || !params.model) return;
  if (params.message.role === "assistant" && !messageMatchesModel(params.message, params.model)) {
    return;
  }

  const items = messageToResponseItems(params.message);
  if (items.length === 0 || !markMessageProcessed(params.sessionId, params.message as object)) return;

  setRemoteCompactionState(params.sessionId, {
    ...remoteState,
    explicitHistory: [...remoteState.explicitHistory, ...items],
  });
}

function maybeNotifyRequestFeatures(params: {
  notifiedModels: Set<string>;
  hasUI: boolean;
  notify: boolean;
  ui: { notify(message: string, level: "info" | "warning"): void };
  model: TargetModel;
  features: string[];
}): void {
  if (!params.notify || !params.hasUI || params.features.length === 0) return;

  const key = `${unknownText(params.model.provider)}/${unknownText(params.model.id)}`;
  const noticeKey = `${key}:${params.features.join(",")}`;
  if (params.notifiedModels.has(noticeKey)) return;

  params.notifiedModels.add(noticeKey);
  params.ui.notify(`OpenAI compaction active for ${key} (${params.features.join(", ")})`, "info");
}

export default function openaiServerCompactionExtension(pi: ExtensionAPI) {
  if (!SUPPORTED_SP_VERSION_PATTERN.test(VERSION)) {
    console.warn(`@super-pi/openai-server-compaction disabled: Pi ${VERSION} is unsupported (requires 0.84.x).`);
    return;
  }
  const notifiedModels = new Set<string>();
  const capabilitySessionIds = new Set<string>();

  pi.registerProvider("openai", {
    api: "openai-responses",
    streamSimple: streamOpenAIResponsesWithPhase2B,
  });

  pi.registerCommand("provider-refresh", {
    description: "Reset the current session's live provider flow without changing local history",
    handler: async (_args, ctx) => {
      await ctx.waitForIdle();
      clearLiveContinuation(getSessionId(ctx));
      ctx.ui.notify("Provider flow refreshed for the current session; local history was preserved.", "info");
    },
  });

  pi.on("session_start", (_event, ctx) => {
    const sessionId = getSessionId(ctx);
    clearLiveContinuation(sessionId);
    clearResponsesRequestShapeState(sessionId);
    clearSessionDedupState(sessionId);
    const cfg = loadContextConfig(ctx);
    setSessionConfig(sessionId, cfg);
    setTransportRemoteCompactionCapability(sessionId, cfg.enabled);
    if (cfg.enabled) capabilitySessionIds.add(sessionId);
    syncRemoteState(ctx);
  });

  const clearBeforeSessionChange = (_event: unknown, ctx: SessionContextLike): void => {
    const sessionId = getSessionId(ctx);
    setTransportRemoteCompactionCapability(sessionId, false);
    capabilitySessionIds.delete(sessionId);
    clearSessionRuntimeState(sessionId);
  };
  pi.on("session_before_switch", clearBeforeSessionChange);
  pi.on("session_before_fork", clearBeforeSessionChange);
  pi.on("session_before_tree", clearBeforeSessionChange);

  const syncAfterSessionChange = (_event: unknown, ctx: SessionContextLike): void => {
    clearLiveContinuation(getSessionId(ctx));
    syncRemoteState(ctx);
  };
  pi.on("session_tree", (event, ctx) => {
    syncAfterSessionChange(event, ctx);
    // session_before_tree clears the old session snapshot. Re-read project
    // config through the new tree context so trusted cwd configuration is
    // restored without ever falling back to process.cwd().
    const sessionId = getSessionId(ctx);
    const cfg = loadContextConfig(ctx);
    setSessionConfig(sessionId, cfg);
    setTransportRemoteCompactionCapability(sessionId, cfg.enabled);
    if (cfg.enabled) capabilitySessionIds.add(sessionId);
  });
  pi.on("session_compact", (event, ctx) => {
    syncAfterSessionChange(event, ctx);

    const sessionId = getSessionId(ctx);
    const cfg = loadContextConfig(ctx);
    const branchEntries = ctx.sessionManager.getBranch() as BranchEntry[];
    if (!shouldQueueCompactionContinuation({
      enabled: cfg.enabled && cfg.autoContinueAfterThreshold,
      reason: event.reason,
      willRetry: event.willRetry,
      compactionEntryId: event.compactionEntry.id,
      branchEntries,
    })) return;

    if (!claimCompactionContinuation(sessionId, event.compactionEntry.id)) return;

    // Only reliably truncated responses reach this point; a clean final
    // `stop` and ordinary tool-use turns are intentionally excluded.
    // The follow-up joins Pi's queue and runs after context has been rebuilt.
    // Active pi-goal sessions are also excluded because pi-goal owns their
    // stricter continuation and circuit breakers.
    pi.sendMessage(
      {
        customType: COMPACTION_CONTINUATION_MESSAGE_TYPE,
        content: COMPACTION_CONTINUATION_PROMPT,
        display: false,
        details: { compactionEntryId: event.compactionEntry.id },
      },
      { triggerTurn: true, deliverAs: "followUp" },
    );
  });

  pi.on("model_select", (_event, ctx) => {
    const sessionId = getSessionId(ctx);
    clearLiveContinuation(sessionId);
    clearResponsesRequestShapeState(sessionId);
  });

  pi.on("session_shutdown", () => {
    for (const sessionId of capabilitySessionIds) setTransportRemoteCompactionCapability(sessionId, false);
    capabilitySessionIds.clear();
    clearAllContinuationState();
    releaseAllWsSessions();
  });

  pi.on("session_before_compact", async (event, ctx) => {
    const cfg = loadContextConfig(ctx);
    const model = ctx.model;
    if (!cfg.enabled || !model || !supportsRemoteCompactionModel(model)) return undefined;

    const eventAuth = (event as typeof event & { auth?: CompactionAuthSnapshot }).auth;
    let auth: CompactionAuthSnapshot | undefined = eventAuth?.model.provider === model.provider && eventAuth.model.id === model.id
      ? eventAuth
      : undefined;
    if (!auth) {
      try {
        const resolved = await ctx.modelRegistry.getApiKeyAndHeaders(model);
        if (event.signal.aborted) {
          recordCompactionFallback(pi, model, "cancelled", "aborted");
          return undefined;
        }
        if (resolved.ok) auth = { model, apiKey: resolved.apiKey, headers: resolved.headers, env: resolved.env };
        else if (isGptSeriesModel(model)) {
          return failGptCompaction(pi, ctx, model, "authentication", resolved.error || "API key unavailable");
        }
        else return undefined;
      } catch (error) {
        if (event.signal.aborted) {
          recordCompactionFallback(pi, model, "cancelled", "aborted");
          return undefined;
        }
        if (isGptSeriesModel(model)) return failGptCompaction(pi, ctx, model, "authentication", error);
        if (ctx.hasUI) {
          ctx.ui.notify(`OpenAI compaction authentication failed; using default compaction. ${unknownText(error)}`, "warning");
        }
        return undefined;
      }
    }
    if (event.signal.aborted) {
      recordCompactionFallback(pi, model, "cancelled", "aborted");
      return undefined;
    }
    if (!auth.apiKey) {
      if (isGptSeriesModel(model)) {
        return failGptCompaction(pi, ctx, model, "authentication", "API key unavailable");
      }
      return undefined;
    }

    const sessionId = getSessionId(ctx);
    const contextMessages = getContextMessages(ctx.sessionManager.buildContextEntries());
    const systemPrompt = ctx.getSystemPrompt();
    const thinkingLevel = pi.getThinkingLevel();
    let canonicalRequest: CanonicalCompactionRequest | undefined;
    try {
      const buildProviderRequestPayload = (pi as ProviderRequestPayloadAPI).buildProviderRequestPayload;
      const payload = typeof buildProviderRequestPayload === "function"
        ? await buildProviderRequestPayload.call(pi, { systemPrompt, messages: contextMessages })
        : undefined;
      canonicalRequest = payload ? extractCanonicalCompactionRequest(payload, model, sessionId) : undefined;
    } catch (error) {
      if (event.signal.aborted) {
        recordCompactionFallback(pi, model, "cancelled", "aborted");
        return undefined;
      }
      if (isGptSeriesModel(model)) return failGptCompaction(pi, ctx, model, "request_preview", error);
      if (ctx.hasUI) {
        ctx.ui.notify(`OpenAI remote compaction request preview failed; using default compaction. ${unknownText(error)}`, "warning");
      }
      return undefined;
    }
    if (event.signal.aborted) {
      recordCompactionFallback(pi, model, "cancelled", "aborted");
      return undefined;
    }
    if (!canonicalRequest) {
      if (isGptSeriesModel(model)) {
        return failGptCompaction(
          pi,
          ctx,
          model,
          "request_preview",
          "canonical provider payload was unavailable or invalid",
        );
      }
      if (ctx.hasUI) {
        ctx.ui.notify("OpenAI remote compaction request preview was unavailable or invalid; using default compaction.", "warning");
      }
      return undefined;
    }

    const shouldGeneratePortable = shouldGeneratePortableModelSummary(
      cfg.portableSummaryMode,
      event.customInstructions,
      true,
    );
    const localSummaryInput = {
      model,
      config: cfg,
      inputTokens: event.preparation.tokensBefore,
      ctx,
      activeAuth: { apiKey: auth.apiKey, headers: auth.headers },
      preparation: event.preparation,
      messages: contextMessages,
      sessionId,
      customInstructions: event.customInstructions,
      signal: event.signal,
      thinkingLevel,
    };
    let localResult: Awaited<ReturnType<typeof generateConfiguredLocalSummary>> | undefined;
    let localError: unknown;
    let localUsageLedgerId: string | undefined;
    let localResultPromise: Promise<SettledResult<Awaited<ReturnType<typeof generateConfiguredLocalSummary>>>> | undefined;
    if (shouldGeneratePortable && isGptSeriesModel(model)) {
      const settled = await settlePromise(generateConfiguredLocalSummary(localSummaryInput));
      if (settled.status === "fulfilled") {
        localResult = settled.value;
        localUsageLedgerId = appendCompactionUsageLedger(pi, model, "portable_summary", localResult.usage);
      } else {
        localError = settled.reason;
      }
      if (event.signal.aborted) {
        recordCompactionFallback(pi, model, "cancelled", "aborted");
        return undefined;
      }
      if (!localResult) return failGptCompaction(pi, ctx, model, "portable_summary", localError);
    } else if (shouldGeneratePortable) {
      localResultPromise = settlePromise(generateConfiguredLocalSummary(localSummaryInput));
    }

    const remoteResultPromise = callConfiguredRemoteCompaction(pi, {
      model,
      apiKey: auth.apiKey,
      headers: auth.headers,
      sessionId,
      regularPayload: canonicalRequest.payload,
      input: canonicalRequest.input,
      serviceTier: canonicalRequest.serviceTier,
      shapeDiagnostics: cfg.shapeDiagnostics,
      signal: event.signal,
      auth,
    });
    let remoteResult: Awaited<ReturnType<typeof callConfiguredRemoteCompaction>> | undefined;
    let remoteError: unknown;
    let remoteUsageLedgerId: string | undefined;
    try {
      remoteResult = await remoteResultPromise;
      remoteUsageLedgerId = appendCompactionUsageLedger(
        pi,
        model,
        "remote_compaction",
        remoteResult.usage,
        remoteResult,
      );
    } catch (error) {
      remoteError = error;
    }

    if (event.signal.aborted) {
      recordCompactionFallback(pi, model, "cancelled", "aborted");
      return undefined;
    }

    if (!remoteResult && isGptSeriesModel(model)) {
      return failGptCompaction(pi, ctx, model, "provider_native_request", remoteError);
    }

    if (remoteResult && shouldGeneratePortable && !localResultPromise && !localResult) {
      localResultPromise = settlePromise(generateConfiguredLocalSummary(localSummaryInput));
    }

    if (!remoteResult && !localResultPromise && !localResult) {
      localResultPromise = settlePromise(generateConfiguredLocalSummary(localSummaryInput));
    }

    if (localResultPromise) {
      const settled = await localResultPromise;
      if (settled.status === "fulfilled") {
        localResult = settled.value;
        localUsageLedgerId = appendCompactionUsageLedger(pi, model, "portable_summary", localResult.usage);
      } else {
        localError = settled.reason;
      }
    }

    if (event.signal.aborted) {
      recordCompactionFallback(pi, model, "cancelled", "aborted");
      return undefined;
    }

    if (isGptSeriesModel(model) && shouldGeneratePortable && !localResult) {
      return failGptCompaction(pi, ctx, model, "portable_summary", localError);
    }

    if (!remoteResult) {
      if (localResult) {
        recordCompactionFallback(pi, model, "local_fallback_succeeded", "remote_failed");
        const fallback = bindLocalCheckpointToPreparation(localResult, event.preparation);
        return {
          compaction: {
            ...fallback,
            details: {
              ...(isRecord(fallback.details) ? fallback.details : {}),
              ...(localUsageLedgerId ? { usageLedger: { portableSummary: localUsageLedgerId } } : {}),
              usageComponents: buildCompactionUsageComponents({ fallbackSummary: fallback.usage }),
            },
          },
        };
      }
      recordCompactionFallback(pi, model, "default_fallback_requested", "remote_and_local_failed");
      if (!event.signal.aborted && ctx.hasUI) {
        const message = remoteError instanceof Error ? remoteError.message : unknownText(remoteError);
        ctx.ui.notify(`OpenAI remote compaction failed; falling back to default compaction. ${message}`, "warning");
      }
      return undefined;
    }

    if (localResultPromise && !localResult) {
      recordCompactionFallback(pi, model, "remote_success_with_emergency_summary", "local_summary_failed");
    }

    const remoteDetails = buildRemoteCompactionDetails(
      model,
      remoteResult.output,
      remoteResult.usage,
      remoteResult.protocol,
    );
    const localSummary = bindLocalCheckpointToPreparation(
      localResult
        ? localResult
        : {
            summary: event.customInstructions?.trim()
              ? buildCustomInstructionFallbackSummary(event.preparation.previousSummary)
              : buildEmergencyContinuitySummary({
                  messages: contextMessages,
                  previousSummary: event.preparation.previousSummary,
                }),
            details: undefined,
            usage: undefined,
          },
      event.preparation,
    );

    return {
      compaction: bindRemoteUsageToCompaction(
        {
          summary: localSummary.summary,
          firstKeptEntryId: localSummary.firstKeptEntryId,
          tokensBefore: localSummary.tokensBefore,
          retainedTail: localSummary.retainedTail,
          details: {
			producerVersion: PRODUCER_VERSION,
            ...(localSummary.details !== undefined ? { localSummaryDetails: localSummary.details } : {}),
            remoteCompaction: remoteDetails,
            usageLedger: {
              ...(remoteUsageLedgerId ? { remoteCompaction: remoteUsageLedgerId } : {}),
              ...(localUsageLedgerId ? { portableSummary: localUsageLedgerId } : {}),
            },
            ...(remoteResult.shapeDiagnostics ? { shapeDiagnostics: remoteResult.shapeDiagnostics } : {}),
            usageComponents: buildCompactionUsageComponents({
              remoteCompaction: remoteResult.usage,
              portableSummary: localResult?.usage,
            }),
          },
        },
        combineCompactionUsage(localSummary.usage, remoteResult.usage),
      ),
    };
  });

  pi.on("message_end", (event, ctx) => {
    const sessionId = getSessionId(ctx);
    const model = ctx.model;

    extendRemoteHistoryIfCompatible({
      sessionId,
      model,
      message: event.message,
    });

    const cfg = loadContextConfig(ctx);
    if (!cfg.enabled || !supportsPreviousResponseId(model, cfg)) return;
    if (!messageMatchesModel(event.message, model)) return;

    const responseId = extractAssistantResponseId(event.message);
    if (!responseId) return;

    const currentModelKey = modelKey(model);
    const currentContinuation = getContinuationState(sessionId);
    const transportContext = getTransportContextState(sessionId);
    const contextLength =
      currentContinuation?.responseId === responseId &&
      currentContinuation.modelKey === currentModelKey &&
      typeof currentContinuation.contextLength === "number"
        ? currentContinuation.contextLength
        : transportContext?.modelKey === currentModelKey
          ? transportContext.contextLength
          : undefined;

    setContinuationState(sessionId, {
      responseId,
      modelKey: currentModelKey,
      updatedAt: Date.now(),
      ...(contextLength !== undefined ? { contextLength } : {}),
    });
    clearTransportContextState(sessionId);
  });

  pi.on("before_provider_request", (event, ctx) => {
    const cfg = loadContextConfig(ctx);
    if (!cfg.enabled) return undefined;

    const model = ctx.model;
    if (!model || !isRecord(event.payload) || !looksLikeResponsesPayload(event.payload)) return undefined;

    const sessionId = getSessionId(ctx);
    const dryRun = (event as typeof event & { dryRun?: boolean }).dryRun === true;
    if (!dryRun) {
      setResponsesRequestShapeState(sessionId, {
        updatedAt: Date.now(),
        reasoning: extractResponsesReasoningConfig(event.payload),
        text: extractResponsesTextConfig(event.payload),
        serviceTier: extractResponsesServiceTier(event.payload),
      });
    }
    const remoteState = getMatchingRemoteState(sessionId, model);

    if (isOpenAICodexResponsesModel(model)) {
      if (!remoteState) return undefined;
      const payload = applyRemoteHistoryPayloadPatch({
        payload: event.payload,
        explicitHistory: normalizeResponseItemsForPrompt(remoteState.explicitHistory, model) as unknown[],
      });
      if (!dryRun) {
        maybeNotifyRequestFeatures({
          notifiedModels,
          hasUI: ctx.hasUI,
          notify: cfg.notify,
          ui: ctx.ui,
          model,
          features: ["remote_compaction_history"],
        });
      }
      return payload;
    }

    if (!supportsPreviousResponseId(model, cfg)) return undefined;

    const continuation = getContinuationState(sessionId);
    const previousResponseId =
      remoteState === undefined &&
      continuation &&
      continuation.modelKey === modelKey(model) &&
      typeof continuation.contextLength === "number"
        ? continuation.responseId
        : undefined;

    const payload = applyPayloadPatch({
      payload: event.payload,
      model,
      cfg,
      previousResponseId,
    });

    const features = ["store=true", "context_management"];
    if (remoteState !== undefined) {
      features.push("remote_compaction_history");
    } else if (previousResponseId) {
      features.push("previous_response_id");
    }

    if (!dryRun) {
      maybeNotifyRequestFeatures({
        notifiedModels,
        hasUI: ctx.hasUI,
        notify: cfg.notify,
        ui: ctx.ui,
        model,
        features,
      });
    }

    return payload;
  });
}
