import { clampThinkingLevel } from "../models.ts";
import { getModelCapabilities } from "../model-capabilities.ts";
import type {
	Api,
	Context,
	Model,
	ModelThinkingLevel,
	SamplingParams,
	SimpleStreamOptions,
	StreamOptions,
	ThinkingBudgets,
	ThinkingLevel,
} from "../types.ts";
import { estimateContextTokens } from "../utils/estimate.ts";

export const CONTEXT_SAFETY_TOKENS = 4096;

/** Request preparation reserves a viable answer; senders cap their final output. */
export function usesAdaptiveRequestBudget(api: Api | undefined): boolean {
	switch (api) {
		case "openai-completions": case "openai-responses": case "azure-openai-responses":
		case "openai-codex-responses": case "anthropic-messages": case "bedrock-converse-stream":
		case "google-generative-ai": case "google-vertex": case "mistral-conversations": case "pi-messages": return true;
		default: return false;
	}
}

export function minimumProviderOutputTokens(api: Api): number {
	return api === "openai-responses" || api === "azure-openai-responses" ? 16 : 1;
}

export function isRequestBudgetBlock(message: string | undefined): boolean {
	return message?.startsWith("Request preparation blocked:") === true;
}

/** Minimum viable answer, bounded by an explicitly smaller requested ceiling. */
export function minimumRequestOutputTokens(maxTokens: number): number {
	return Math.min(MIN_ANSWER_TOKENS, maxTokens);
}

/** Shared by Google simple senders and request preparation; -1 stays dynamic. */
export function getGoogleThinkingBudget(model: Model<Api>, effort: ThinkingLevel, customBudgets?: ThinkingBudgets): number {
	const budgetLevel = effort === "xhigh" || effort === "max" ? "high" : effort;
	return customBudgets?.[budgetLevel] ?? model.thinkingBudgetMap?.[effort] ?? model.thinkingBudgetMap?.high ?? -1;
}

export function requestThinkingTokens(model: Model<Api>, reasoning: ModelThinkingLevel = "off", customBudgets?: ThinkingBudgets): number {
	if (model.api !== "google-generative-ai" && model.api !== "google-vertex") return 0;
	if (getModelCapabilities(model).reasoning.mode !== "budget") return 0;
	const effort = clampThinkingLevel(model, reasoning);
	return effort === "off" ? 0 : Math.max(0, getGoogleThinkingBudget(model, effort, customBudgets));
}

export function resolveRequestOutputFloor(model: Model<Api>, requested: number, thinkingTokens = 0): number {
	const floor = minimumRequestOutputTokens(requested) + thinkingTokens;
	if (!Number.isSafeInteger(floor) || floor <= 0 || floor > requested) throw new RequestBudgetError(model.contextWindow, 0, requested, requested - thinkingTokens, "output-reservation", floor);
	return floor;
}

/** Host request preparation failed; this says nothing about prior tool effects. */
export class RequestBudgetError extends Error {
	readonly code = "request-budget-blocked";
	readonly contextWindow: number;
	readonly inputTokens: number;
	readonly requestedOutputTokens: number;
	readonly availableOutputTokens: number;
	readonly minimumOutputTokens: number;
	readonly reason: "context-headroom" | "model-parameters" | "output-reservation";
	constructor(contextWindow: number, inputTokens: number, requestedOutputTokens: number, availableOutputTokens: number,
		reason: "context-headroom" | "model-parameters" | "output-reservation" = "context-headroom", minimumOutputTokens = minimumRequestOutputTokens(requestedOutputTokens)) {
		super(`Request preparation blocked: ${reason}; insufficient response capacity (context=${contextWindow}, input=${inputTokens}, requestedOutput=${requestedOutputTokens}, availableOutput=${availableOutputTokens}, minimumOutput=${minimumOutputTokens}, safety=${CONTEXT_SAFETY_TOKENS}). Prior tool outcomes are unchanged; ${reason === "model-parameters" ? "correct the model context/output parameters" : reason === "output-reservation" ? "correct the requested output allowance" : "reduce request context or explicitly compact"} before retrying the request. Do not repeat completed tools.`);
		this.name = "RequestBudgetError";
		this.contextWindow = contextWindow;
		this.inputTokens = inputTokens;
		this.requestedOutputTokens = requestedOutputTokens;
		this.availableOutputTokens = availableOutputTokens;
		this.minimumOutputTokens = minimumOutputTokens;
		this.reason = reason;
	}
}

/** Shared by projection planning and senders, including wire-specific floors. */
export function resolveRequestOutputTokens(model: Model<Api>, maxTokens: number, providerMinimum = minimumProviderOutputTokens(model.api)): number {
	const adaptive = usesAdaptiveRequestBudget(model.api);
	if (adaptive && (!Number.isSafeInteger(model.contextWindow) || model.contextWindow <= 0 || !Number.isSafeInteger(model.maxTokens) || model.maxTokens <= 0)) throw new RequestBudgetError(model.contextWindow, 0, model.maxTokens, 0, "model-parameters");
	if (adaptive && (!Number.isSafeInteger(maxTokens) || maxTokens <= 0)) throw new RequestBudgetError(model.contextWindow, 0, maxTokens, 0, "output-reservation");
	const requested = adaptive ? Math.min(Math.max(maxTokens, providerMinimum), model.maxTokens) : maxTokens;
	if (requested < providerMinimum) throw new RequestBudgetError(model.contextWindow, 0, requested, 0, "model-parameters");
	if (adaptive && (!Number.isSafeInteger(requested) || requested <= 0)) throw new RequestBudgetError(model.contextWindow, 0, requested, 0);
	return requested;
}

export function clampMaxTokensToContext(model: Model<Api>, context: Context, maxTokens: number, providerMinimum = minimumProviderOutputTokens(model.api), thinkingTokens = 0): number {
	const adaptive = usesAdaptiveRequestBudget(model.api);
	const requested = resolveRequestOutputTokens(model, maxTokens, providerMinimum);
	if (model.contextWindow <= 0) return Math.max(1, requested);
	const input = estimateContextTokens(context, adaptive ? getModelCapabilities(model).toolCalling : true).tokens;
	const available = model.contextWindow - input - CONTEXT_SAFETY_TOKENS;
	const minimum = adaptive ? resolveRequestOutputFloor(model, requested, thinkingTokens) : 0;
	if (adaptive && available < minimum) throw new RequestBudgetError(model.contextWindow, input, requested, available, "context-headroom", minimum);
	return Math.min(requested, Math.max(1, available));
}

/** Resolve model defaults at request setup, never from a provider-delta callback. */
export function resolveSamplingParams(
	model: Model<Api>,
	thinkingLevel: ModelThinkingLevel,
	requestParams?: SamplingParams,
): SamplingParams | undefined {
	const levelParams = model.samplingParamsByThinkingLevel?.[clampThinkingLevel(model, thinkingLevel)];
	return model.samplingParams || levelParams || requestParams
		? { ...model.samplingParams, ...levelParams, ...requestParams }
		: undefined;
}

export function buildBaseOptions(
	model: Model<Api>,
	context: Context,
	options?: SimpleStreamOptions,
	apiKey?: string,
): StreamOptions {
	const samplingParams = resolveSamplingParams(model, options?.reasoning ?? "off", options?.samplingParams);
	return {
		temperature: options?.temperature,
		samplingParams,
		maxTokens: clampMaxTokensToContext(model, context, options?.maxTokens ?? model.maxTokens, undefined, requestThinkingTokens(model, options?.reasoning, options?.thinkingBudgets)),
		signal: options?.signal,
		telemetryContext: options?.telemetryContext,
		apiKey: apiKey || options?.apiKey,
		fetch: options?.fetch,
		transport: options?.transport,
		cacheRetention: options?.cacheRetention,
		sessionId: options?.sessionId,
		headers: options?.headers,
		onPayload: options?.onPayload,
		onEffectiveDispatch: options?.onEffectiveDispatch,
		onResponse: options?.onResponse,
		timeoutMs: options?.timeoutMs,
		websocketConnectTimeoutMs: options?.websocketConnectTimeoutMs,
		maxRetries: options?.maxRetries,
		maxRetryDelayMs: options?.maxRetryDelayMs,
		metadata: options?.metadata,
		env: options?.env,
	};
}

/** Tokens always left for the answer when a thinking budget shares the response ceiling. */
export const MIN_ANSWER_TOKENS = 1024;

export function clampReasoning(effort: ThinkingLevel | undefined): Exclude<ThinkingLevel, "xhigh" | "max"> | undefined {
	return effort === "xhigh" || effort === "max" ? "high" : effort;
}

export function adjustMaxTokensForThinking(
	// Undefined means no explicit caller cap. Use the model cap and fit thinking inside it.
	baseMaxTokens: number | undefined,
	modelMaxTokens: number,
	reasoningLevel: ThinkingLevel,
	customBudgets?: ThinkingBudgets,
): { maxTokens: number; thinkingBudget: number } {
	const defaultBudgets: ThinkingBudgets = {
		minimal: 1024,
		low: 2048,
		medium: 8192,
		high: 16384,
	};
	const budgets = { ...defaultBudgets, ...customBudgets };

	const level = clampReasoning(reasoningLevel)!;
	let thinkingBudget = budgets[level]!;
	const maxTokens =
		baseMaxTokens === undefined ? modelMaxTokens : Math.min(baseMaxTokens + thinkingBudget, modelMaxTokens);

	if (maxTokens <= thinkingBudget) {
		thinkingBudget = Math.max(0, maxTokens - MIN_ANSWER_TOKENS);
	}

	return { maxTokens, thinkingBudget };
}
