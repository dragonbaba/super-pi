import type {
	Api,
	Context,
	Model,
	SimpleStreamOptions,
	StreamOptions,
	ThinkingBudgets,
	ThinkingLevel,
} from "../types.ts";
import { estimateContextTokens } from "../utils/estimate.ts";

export const CONTEXT_SAFETY_TOKENS = 4096;

/** Other senders retain their existing reserve/output accounting in this slice. */
export function usesAdaptiveRequestBudget(api: Api | undefined): boolean {
	return api === "openai-completions";
}

export function isRequestBudgetBlock(message: string | undefined): boolean {
	return message?.startsWith("Request preparation blocked:") === true;
}

/** Minimum viable answer, bounded by an explicitly smaller requested ceiling. */
export function minimumRequestOutputTokens(maxTokens: number): number {
	return Math.min(MIN_ANSWER_TOKENS, maxTokens);
}

/** Host request preparation failed; this says nothing about prior tool effects. */
export class RequestBudgetError extends Error {
	readonly code = "request-budget-blocked";
	readonly contextWindow: number;
	readonly inputTokens: number;
	readonly requestedOutputTokens: number;
	readonly availableOutputTokens: number;
	constructor(contextWindow: number, inputTokens: number, requestedOutputTokens: number, availableOutputTokens: number) {
		super(`Request preparation blocked: insufficient response capacity (context=${contextWindow}, input=${inputTokens}, requestedOutput=${requestedOutputTokens}, availableOutput=${availableOutputTokens}, safety=${CONTEXT_SAFETY_TOKENS}). Prior tool outcomes are unchanged; reduce request context or explicitly compact before retrying the request. Do not repeat completed tools.`);
		this.name = "RequestBudgetError";
		this.contextWindow = contextWindow;
		this.inputTokens = inputTokens;
		this.requestedOutputTokens = requestedOutputTokens;
		this.availableOutputTokens = availableOutputTokens;
	}
}

export function clampMaxTokensToContext(model: Model<Api>, context: Context, maxTokens: number): number {
	const adaptive = usesAdaptiveRequestBudget(model.api);
	const requested = adaptive ? Math.min(maxTokens, model.maxTokens) : maxTokens;
	if (adaptive && (!Number.isSafeInteger(requested) || requested <= 0)) throw new RequestBudgetError(model.contextWindow, 0, requested, 0);
	if (model.contextWindow <= 0) return Math.max(1, requested);
	const input = estimateContextTokens(context).tokens;
	const available = model.contextWindow - input - CONTEXT_SAFETY_TOKENS;
	if (adaptive && available < minimumRequestOutputTokens(requested)) throw new RequestBudgetError(model.contextWindow, input, requested, available);
	return Math.min(requested, Math.max(1, available));
}

export function buildBaseOptions(
	model: Model<Api>,
	context: Context,
	options?: SimpleStreamOptions,
	apiKey?: string,
): StreamOptions {
	const samplingParams =
		model.samplingParams || options?.samplingParams
			? { ...model.samplingParams, ...options?.samplingParams }
			: undefined;
	return {
		temperature: options?.temperature,
		samplingParams,
		maxTokens: clampMaxTokensToContext(model, context, options?.maxTokens ?? model.maxTokens),
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
