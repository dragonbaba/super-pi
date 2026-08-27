import type {
	Api,
	AssistantMessage,
	Context,
	Model,
	ModelCapabilitiesV1,
	ModelProfileDiagnostic,
	ModelProfileSource,
	ModelThinkingLevel,
} from "./types.ts";

const TOOL_APIS = new Set<Api>([
	"anthropic-messages",
	"openai-completions",
	"openai-responses",
	"openai-codex-responses",
	"azure-openai-responses",
	"google-generative-ai",
	"google-vertex",
	"mistral-conversations",
	"bedrock-converse-stream",
	"pi-messages",
]);

const PARALLEL_TOOL_APIS = new Set<Api>([
	"anthropic-messages",
	"openai-completions",
	"openai-responses",
	"openai-codex-responses",
	"azure-openai-responses",
	"google-generative-ai",
	"google-vertex",
	"mistral-conversations",
	"bedrock-converse-stream",
	"pi-messages",
]);

const STREAMED_TOOL_ARGUMENT_APIS = new Set<Api>([
	"anthropic-messages",
	"openai-completions",
	"openai-responses",
	"openai-codex-responses",
	"azure-openai-responses",
	"google-generative-ai",
	"google-vertex",
	"mistral-conversations",
	"bedrock-converse-stream",
	"pi-messages",
]);

const THINKING_LEVELS: readonly ModelThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
const THINKING_LEVEL_SET = new Set<ModelThinkingLevel>(THINKING_LEVELS);
const PROFILE_CACHE = new WeakMap<object, Map<string, Model<Api>>>();
const NORMALIZED_CAPABILITIES = new WeakSet<object>();
// A provider factory and its host can be loaded through separate package copies
// (for example source tests plus built workspace exports). Use one realm-wide key
// so the host can consume and clear provider-owned enrichment in either copy.
const MODEL_CAPABILITY_ENRICHMENT: unique symbol = Symbol.for("super-pi.model-capability-enrichment-v1") as never;

export interface ModelCapabilityEnrichmentV1 {
	strictToolSchema?: boolean;
	reasoningMode?: Exclude<ModelCapabilitiesV1["reasoning"]["mode"], "none">;
}

type CapabilityEnrichedModel = Model<Api> & {
	[MODEL_CAPABILITY_ENRICHMENT]?: Readonly<ModelCapabilityEnrichmentV1>;
};

/** Attach provider/model-owned capability facts without serializing internal profile metadata. */
export function enrichModelCapabilities<TApi extends Api>(
	model: Model<TApi>,
	enrichment: ModelCapabilityEnrichmentV1,
): Model<TApi> {
	const enriched = { ...model } as Model<TApi> & CapabilityEnrichedModel;
	Object.defineProperty(enriched, MODEL_CAPABILITY_ENRICHMENT, {
		value: Object.freeze({ ...enrichment }),
		enumerable: true,
	});
	return enriched;
}

function modelCapabilityEnrichment(model: Model<Api>): Readonly<ModelCapabilityEnrichmentV1> | undefined {
	return (model as CapabilityEnrichedModel)[MODEL_CAPABILITY_ENRICHMENT];
}

/** Remove locally derived profile/enrichment metadata before a model re-enters a provider profiler. */
export function stripModelRuntimeProfile<TApi extends Api>(model: Model<TApi>): Model<TApi> {
	const {
		capabilities: _capabilities,
		profileSource: _profileSource,
		profileDiagnostics: _profileDiagnostics,
		thinkingBudgetMap: _thinkingBudgetMap,
		[MODEL_CAPABILITY_ENRICHMENT]: _enrichment,
		...raw
	} = model as Model<TApi> & CapabilityEnrichedModel;
	return raw as Model<TApi>;
}

const CAPABILITY_KEYS = [
	"version",
	"inputModalities",
	"toolCalling",
	"parallelTools",
	"strictToolSchema",
	"streamedToolArguments",
	"reasoning",
	"thoughtSignatureRoundTrip",
	"promptCache",
	"previousResponseId",
	"websocketContinuation",
	"deferredTools",
	"remoteCompaction",
	"contextWindow",
	"maxOutputTokens",
] as const;

function capabilityError(model: Model<Api>, message: string): Error {
	return new Error(`Invalid capabilities for ${model.provider}/${model.id}: ${message}`);
}

function requirePlainRecord(model: Model<Api>, value: unknown, label: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw capabilityError(model, `${label} must be an object`);
	const prototype = Object.getPrototypeOf(value);
	if (prototype !== Object.prototype && prototype !== null) throw capabilityError(model, `${label} must be a plain object`);
	return value as Record<string, unknown>;
}

function requireExactKeys(
	model: Model<Api>,
	record: Record<string, unknown>,
	label: string,
	expected: readonly string[],
): void {
	const actual = Object.keys(record).sort();
	const sortedExpected = [...expected].sort();
	if (actual.length !== sortedExpected.length || actual.some((key, index) => key !== sortedExpected[index])) {
		throw capabilityError(model, `${label} must contain exactly: ${sortedExpected.join(", ")}`);
	}
}

function requireBoolean(model: Model<Api>, record: Record<string, unknown>, key: string): boolean {
	const value = record[key];
	if (typeof value !== "boolean") throw capabilityError(model, `${key} must be boolean`);
	return value;
}

function requirePositiveInteger(model: Model<Api>, record: Record<string, unknown>, key: string): number {
	const value = record[key];
	if (!Number.isSafeInteger(value) || (value as number) <= 0) {
		throw capabilityError(model, `${key} must be a positive safe integer`);
	}
	return value as number;
}

function normalizeReasoningCapability(
	model: Model<Api>,
	value: unknown,
): ModelCapabilitiesV1["reasoning"] {
	const record = requirePlainRecord(model, value, "reasoning");
	const mode = record.mode;
	if (mode === "none") {
		requireExactKeys(model, record, "reasoning", ["mode"]);
		if (model.reasoning) throw capabilityError(model, "reasoning.mode=none contradicts model.reasoning=true");
		return Object.freeze({ mode: "none" });
	}
	if (mode !== "levels" && mode !== "budget" && mode !== "adaptive") {
		throw capabilityError(model, "reasoning.mode is unsupported");
	}
	requireExactKeys(model, record, "reasoning", ["mode", "levels"]);
	if (!model.reasoning) throw capabilityError(model, `${mode} reasoning contradicts model.reasoning=false`);
	if (!Array.isArray(record.levels) || record.levels.length === 0) {
		throw capabilityError(model, "reasoning.levels must be a non-empty array");
	}
	const levels: ModelThinkingLevel[] = [];
	for (const level of record.levels) {
		if (typeof level !== "string" || !THINKING_LEVEL_SET.has(level as ModelThinkingLevel)) {
			throw capabilityError(model, `unsupported reasoning level ${String(level)}`);
		}
		if (levels.includes(level as ModelThinkingLevel)) throw capabilityError(model, `duplicate reasoning level ${level}`);
		levels.push(level as ModelThinkingLevel);
	}
	return Object.freeze({ mode, levels: Object.freeze(levels) });
}

function normalizePromptCacheCapability(
	model: Model<Api>,
	value: unknown,
): ModelCapabilitiesV1["promptCache"] {
	const record = requirePlainRecord(model, value, "promptCache");
	const mode = record.mode;
	if (mode === "none") {
		requireExactKeys(model, record, "promptCache", ["mode"]);
		return Object.freeze({ mode: "none" });
	}
	if (mode !== "implicit" && mode !== "explicit") throw capabilityError(model, "promptCache.mode is unsupported");
	requireExactKeys(model, record, "promptCache", ["mode", "retention"]);
	if (typeof record.retention !== "boolean") throw capabilityError(model, "promptCache.retention must be boolean");
	return Object.freeze({ mode, retention: record.retention });
}

function normalizedCapabilitiesMatchModel(model: Model<Api>, capabilities: Readonly<ModelCapabilitiesV1>): boolean {
	return (
		capabilities.contextWindow === model.contextWindow &&
		capabilities.maxOutputTokens === model.maxTokens &&
		capabilities.inputModalities.text === model.input.includes("text") &&
		capabilities.inputModalities.image === model.input.includes("image") &&
		capabilities.inputModalities.audio === false &&
		(capabilities.reasoning.mode !== "none") === model.reasoning
	);
}

/** Validate, clone, and deeply freeze a complete provider-neutral capability manifest. */
export function normalizeModelCapabilitiesV1<TApi extends Api>(
	model: Model<TApi>,
	value: unknown,
): Readonly<ModelCapabilitiesV1> {
	const apiModel = model as Model<Api>;
	const record = requirePlainRecord(apiModel, value, "capabilities");
	requireExactKeys(apiModel, record, "capabilities", CAPABILITY_KEYS);
	if (record.version !== 1) throw capabilityError(apiModel, "version must be 1");
	const modalities = requirePlainRecord(apiModel, record.inputModalities, "inputModalities");
	requireExactKeys(apiModel, modalities, "inputModalities", ["text", "image", "audio"]);
	const inputModalities = Object.freeze({
		text: requireBoolean(apiModel, modalities, "text"),
		image: requireBoolean(apiModel, modalities, "image"),
		audio: requireBoolean(apiModel, modalities, "audio"),
	});
	if (inputModalities.text !== model.input.includes("text") || inputModalities.image !== model.input.includes("image")) {
		throw capabilityError(apiModel, "inputModalities contradict model.input");
	}
	if (inputModalities.audio) throw capabilityError(apiModel, "audio input is unsupported by the legacy model input shape");

	const reasoning = normalizeReasoningCapability(apiModel, record.reasoning);
	const promptCache = normalizePromptCacheCapability(apiModel, record.promptCache);
	const contextWindow = requirePositiveInteger(apiModel, record, "contextWindow");
	const maxOutputTokens = requirePositiveInteger(apiModel, record, "maxOutputTokens");
	if (contextWindow !== model.contextWindow) throw capabilityError(apiModel, "contextWindow must match model.contextWindow");
	if (maxOutputTokens !== model.maxTokens) throw capabilityError(apiModel, "maxOutputTokens must match model.maxTokens");

	const toolCalling = requireBoolean(apiModel, record, "toolCalling");
	const parallelTools = requireBoolean(apiModel, record, "parallelTools");
	const strictToolSchema = requireBoolean(apiModel, record, "strictToolSchema");
	const streamedToolArguments = requireBoolean(apiModel, record, "streamedToolArguments");
	const thoughtSignatureRoundTrip = requireBoolean(apiModel, record, "thoughtSignatureRoundTrip");
	const previousResponseId = requireBoolean(apiModel, record, "previousResponseId");
	const websocketContinuation = requireBoolean(apiModel, record, "websocketContinuation");
	const deferredTools = requireBoolean(apiModel, record, "deferredTools");
	const remoteCompaction = requireBoolean(apiModel, record, "remoteCompaction");
	if (!toolCalling && (parallelTools || strictToolSchema || streamedToolArguments || deferredTools)) {
		throw capabilityError(apiModel, "tool sub-capabilities require toolCalling=true");
	}
	if (websocketContinuation && !previousResponseId) {
		throw capabilityError(apiModel, "websocketContinuation requires previousResponseId=true");
	}

	const normalized = Object.freeze({
		version: 1 as const,
		inputModalities,
		toolCalling,
		parallelTools,
		strictToolSchema,
		streamedToolArguments,
		reasoning,
		thoughtSignatureRoundTrip,
		promptCache,
		previousResponseId,
		websocketContinuation,
		deferredTools,
		remoteCompaction,
		contextWindow,
		maxOutputTokens,
	});
	NORMALIZED_CAPABILITIES.add(normalized);
	return normalized;
}

function compatValue(model: Model<Api>, key: string): unknown {
	return (model.compat as Record<string, unknown> | undefined)?.[key];
}

function supportedThinkingLevels(model: Model<Api>): readonly ModelThinkingLevel[] {
	if (!model.reasoning) return ["off"];
	return THINKING_LEVELS.filter((level) => {
		const mapped = model.thinkingLevelMap?.[level];
		if (mapped === null) return false;
		if (level === "xhigh" || level === "max") return mapped !== undefined;
		return true;
	});
}

function reasoningCapability(model: Model<Api>): ModelCapabilitiesV1["reasoning"] {
	if (!model.reasoning) return { mode: "none" };
	const levels = supportedThinkingLevels(model);
	if (model.api === "anthropic-messages" && compatValue(model, "forceAdaptiveThinking") === true) {
		return { mode: "adaptive", levels };
	}
	if (
		model.api === "anthropic-messages" ||
		model.api === "bedrock-converse-stream" ||
		model.api === "google-generative-ai" ||
		model.api === "google-vertex"
	) {
		return { mode: "budget", levels };
	}
	return { mode: "levels", levels };
}

function supportsStrictToolSchema(model: Model<Api>): boolean {
	if (model.api === "anthropic-messages") return compatValue(model, "supportsStrictTools") === true;
	if (model.api === "bedrock-converse-stream") return compatValue(model, "supportsStrictMode") === true;
	if (
		model.api === "openai-completions" ||
		model.api === "openai-responses" ||
		model.api === "openai-codex-responses" ||
		model.api === "azure-openai-responses"
	) {
		return compatValue(model, "supportsStrictMode") !== false;
	}
	return false;
}

function promptCacheCapability(model: Model<Api>): ModelCapabilitiesV1["promptCache"] {
	if (model.api === "google-generative-ai" || model.api === "google-vertex") {
		return { mode: "explicit", retention: false };
	}
	if (
		model.api === "anthropic-messages" ||
		model.api === "openai-completions" ||
		model.api === "openai-responses" ||
		model.api === "openai-codex-responses" ||
		model.api === "azure-openai-responses" ||
		model.api === "bedrock-converse-stream" ||
		model.api === "mistral-conversations" ||
		model.api === "pi-messages"
	) {
		return {
			mode: "implicit",
			retention:
				model.api === "anthropic-messages" ||
				model.api === "bedrock-converse-stream" ||
				compatValue(model, "supportsLongCacheRetention") === true,
		};
	}
	return { mode: "none" };
}

/** Derive a manifest from trusted catalog/custom fields without mutating the model. */
export function deriveModelCapabilities(model: Model<Api>): Readonly<ModelCapabilitiesV1> {
	const api = model.api;
	const enrichment = modelCapabilityEnrichment(model);
	const derivedReasoning = reasoningCapability(model);
	const reasoning =
		enrichment?.reasoningMode && derivedReasoning.mode !== "none"
			? { ...derivedReasoning, mode: enrichment.reasoningMode }
			: derivedReasoning;
	const manifest: ModelCapabilitiesV1 = {
		version: 1,
		inputModalities: Object.freeze({
			text: model.input.includes("text"),
			image: model.input.includes("image"),
			audio: false,
		}),
		toolCalling: TOOL_APIS.has(api),
		parallelTools: PARALLEL_TOOL_APIS.has(api),
		strictToolSchema: enrichment?.strictToolSchema ?? supportsStrictToolSchema(model),
		streamedToolArguments: STREAMED_TOOL_ARGUMENT_APIS.has(api),
		reasoning: Object.freeze(reasoning),
		thoughtSignatureRoundTrip:
			api === "anthropic-messages" || api === "google-generative-ai" || api === "google-vertex",
		promptCache: Object.freeze(promptCacheCapability(model)),
		previousResponseId:
			api === "openai-responses" || api === "openai-codex-responses" || api === "azure-openai-responses",
		websocketContinuation: api === "openai-codex-responses",
		deferredTools:
			(api === "anthropic-messages" && compatValue(model, "supportsToolReferences") === true) ||
			((api === "openai-responses" || api === "openai-codex-responses" || api === "azure-openai-responses") &&
				compatValue(model, "supportsToolSearch") === true) ||
			(api === "openai-completions" && compatValue(model, "deferredToolsMode") !== undefined),
		remoteCompaction: api === "openai-codex-responses",
		contextWindow: model.contextWindow,
		maxOutputTokens: model.maxTokens,
	};
	return normalizeModelCapabilitiesV1(model, manifest);
}

export interface WithModelProfileOptions {
	costKnown?: boolean;
	diagnostics?: readonly ModelProfileDiagnostic[];
	capabilities?: Readonly<ModelCapabilitiesV1>;
}

/** Attach immutable provenance and capability metadata to a runtime model. */
export function withModelProfile<TApi extends Api>(
	model: Model<TApi>,
	source: ModelProfileSource,
	options: WithModelProfileOptions = {},
): Model<TApi> {
	const requestedCostKnown = options.costKnown ?? source !== "conservative-fallback";
	let diagnostics = options.diagnostics ?? model.profileDiagnostics ?? [];
	const suppliedCapabilities = options.capabilities ?? model.capabilities;
	let capabilities: Readonly<ModelCapabilitiesV1>;
	if (suppliedCapabilities !== undefined) {
		try {
			capabilities =
				NORMALIZED_CAPABILITIES.has(suppliedCapabilities as object) &&
				normalizedCapabilitiesMatchModel(model as Model<Api>, suppliedCapabilities)
					? suppliedCapabilities
					: normalizeModelCapabilitiesV1(model, suppliedCapabilities);
		} catch (error) {
			if (source !== "provider-catalog") throw error;
			capabilities = deriveModelCapabilities({ ...model, capabilities: undefined } as Model<Api>);
			diagnostics = [
				...diagnostics,
				{
					code: "INVALID_CAPABILITIES_REBUILT",
					field: "capabilities",
					message: `Model ${model.provider}/${model.id} had an invalid cached capability manifest; rebuilt it from catalog fields.`,
				} satisfies ModelProfileDiagnostic,
			];
		}
	} else {
		capabilities = deriveModelCapabilities(model as Model<Api>);
	}
	if (
		model.profileSource === source &&
		model.capabilities === capabilities &&
		model.costKnown === requestedCostKnown &&
		(options.diagnostics === undefined || diagnostics === model.profileDiagnostics)
	) {
		return model;
	}
	const cacheable =
		model.profileSource === undefined &&
		model.capabilities === undefined &&
		model.profileDiagnostics === undefined &&
		options.capabilities === undefined &&
		options.diagnostics === undefined;
	const cacheKey = `${source}:${requestedCostKnown ? "known" : "unknown"}`;
	if (cacheable) {
		const cached = PROFILE_CACHE.get(model)?.get(cacheKey);
		if (cached) return cached as Model<TApi>;
	}
	const profiled: Model<TApi> = {
		...model,
		reasoning: capabilities.reasoning.mode !== "none",
		profileSource: source,
		capabilities,
		costKnown: requestedCostKnown,
		profileDiagnostics: Object.freeze(diagnostics.map((diagnostic) => Object.freeze({ ...diagnostic }))),
	};
	if (cacheable) {
		let byProfile = PROFILE_CACHE.get(model);
		if (!byProfile) {
			byProfile = new Map();
			PROFILE_CACHE.set(model, byProfile);
		}
		byProfile.set(cacheKey, profiled as Model<Api>);
	}
	return profiled;
}

/** Manifest for an unknown model: only text, basic serial tools, and streaming are assumed. */
export function conservativeModelCapabilities(contextWindow = 32_768, maxOutputTokens = 4_096): Readonly<ModelCapabilitiesV1> {
	return Object.freeze({
		version: 1,
		inputModalities: Object.freeze({ text: true, image: false, audio: false }),
		toolCalling: false,
		parallelTools: false,
		strictToolSchema: false,
		streamedToolArguments: false,
		reasoning: Object.freeze({ mode: "none" as const }),
		thoughtSignatureRoundTrip: false,
		promptCache: Object.freeze({ mode: "none" as const }),
		previousResponseId: false,
		websocketContinuation: false,
		deferredTools: false,
		remoteCompaction: false,
		contextWindow,
		maxOutputTokens,
	});
}

export function getModelCapabilities(model: Model<Api>): Readonly<ModelCapabilitiesV1> {
	return model.capabilities ?? deriveModelCapabilities(model);
}

export function modelSupportsPromptCache(model: Model<Api>): boolean {
	return getModelCapabilities(model).promptCache.mode !== "none";
}

export function modelSupportsToolCalling(model: Model<Api>): boolean {
	return getModelCapabilities(model).toolCalling;
}

function plainToolHistoryText(label: string, value: unknown): string {
	let serialized: string;
	try {
		serialized = typeof value === "string" ? value : JSON.stringify(value);
	} catch {
		serialized = "[unserializable]";
	}
	return `[${label}] ${serialized}`;
}

/** Remove provider-native tool protocol while retaining a plain-text account of prior activity. */
export function contextForModelCapabilities<TApi extends Api>(model: Model<TApi>, context: Context): Context {
	if (getModelCapabilities(model).toolCalling) return context;
	const messages: Context["messages"] = [];
	for (const message of context.messages) {
		if (message.role === "user") {
			messages.push(message);
			continue;
		}
		if (message.role === "toolResult") {
			const output = message.content.map((block) =>
				block.type === "text" ? block.text : `[image ${block.mimeType} omitted]`,
			).join("\n");
			messages.push({
				role: "user",
				content: plainToolHistoryText(`Result from ${message.toolName}`, output || "(no output)"),
				timestamp: message.timestamp,
			});
			continue;
		}
		const content: AssistantMessage["content"] = [];
		for (const block of message.content) {
			if (block.type === "text") {
				content.push({ type: "text", text: block.text });
			} else if (block.type === "thinking") {
				if (block.thinking) content.push({ type: "text", text: block.thinking });
			} else {
				content.push({
					type: "text",
					text: plainToolHistoryText(`Requested ${block.name}`, block.arguments),
				});
			}
		}
		if (content.length === 0) continue;
		messages.push({
			...message,
			content,
			stopReason: message.stopReason === "toolUse" ? "stop" : message.stopReason,
			responseId: undefined,
			deferred: undefined,
		});
	}
	return { ...context, messages, tools: undefined };
}

export function capabilityCacheRetention<TApi extends Api>(
	model: Model<TApi>,
	retention: "none" | "short" | "long",
): "none" | "short" | "long" {
	const cache = getModelCapabilities(model).promptCache;
	if (cache.mode === "none") return "none";
	return retention === "long" && !cache.retention ? "short" : retention;
}

function clampCapabilityReasoningLevel(
	capabilities: Readonly<ModelCapabilitiesV1>,
	requested: ModelThinkingLevel,
): ModelThinkingLevel {
	if (capabilities.reasoning.mode === "none") return "off";
	if (capabilities.reasoning.levels.includes(requested)) return requested;
	const requestedIndex = THINKING_LEVELS.indexOf(requested);
	for (let index = requestedIndex; index < THINKING_LEVELS.length; index++) {
		const candidate = THINKING_LEVELS[index]!;
		if (capabilities.reasoning.levels.includes(candidate)) return candidate;
	}
	for (let index = requestedIndex - 1; index >= 0; index--) {
		const candidate = THINKING_LEVELS[index]!;
		if (capabilities.reasoning.levels.includes(candidate)) return candidate;
	}
	return capabilities.reasoning.levels[0] ?? "off";
}

const TOOL_REQUEST_KEYS = [
	"tools",
	"tool_choice",
	"toolChoice",
	"parallel_tool_calls",
	"parallelToolCalls",
	"toolConfig",
	"functions",
	"function_call",
	"functionCall",
	"web_search_options",
	"webSearchOptions",
];
const REASONING_REQUEST_KEYS = [
	"reasoning",
	"reasoning_effort",
	"reasoningEffort",
	"thinking",
	"thinkingConfig",
	"thinking_token_budget",
	"include",
];
const CACHE_REQUEST_KEYS = [
	"prompt_cache_key",
	"promptCacheKey",
	"prompt_cache_retention",
	"promptCacheRetention",
	"prompt_cache_options",
	"cache_control",
	"cacheControl",
	"cachePoint",
	"cacheRetention",
	"cachedContent",
];
const CACHE_RETENTION_REQUEST_KEYS = [
	"prompt_cache_retention",
	"promptCacheRetention",
	"cache_control",
	"cacheControl",
	"cachePoint",
	"cacheRetention",
];
/** Merge only non-structural generation/sampling parameters into a provider request. */
export function mergeSamplingParams<TPayload extends Record<string, unknown>>(
	payload: TPayload,
	samplingParams: Readonly<Record<string, unknown>> | undefined,
	reservedKeys: ReadonlySet<string>,
): TPayload {
	if (!samplingParams) return payload;
	const mutable = payload as Record<string, unknown>;
	for (const [key, value] of Object.entries(samplingParams)) {
		if (!reservedKeys.has(key)) mutable[key] = value;
	}
	return payload;
}

/** Remove capability-controlled top-level fields after custom sampling parameters are merged. */
export function sanitizeCapabilityRequest<TApi extends Api, TPayload extends Record<string, unknown>>(
	model: Model<TApi>,
	payload: TPayload,
): TPayload {
	const capabilities = getModelCapabilities(model);
	const mutable = payload as Record<string, unknown>;
	if (!capabilities.toolCalling) for (const key of TOOL_REQUEST_KEYS) mutable[key] = undefined;
	if (!capabilities.parallelTools) {
		mutable.parallel_tool_calls = undefined;
		mutable.parallelToolCalls = undefined;
	}
	if (!capabilities.previousResponseId) {
		mutable.previous_response_id = undefined;
		mutable.previousResponseId = undefined;
	}
	if (capabilities.reasoning.mode === "none") {
		for (const key of REASONING_REQUEST_KEYS) mutable[key] = undefined;
	}
	else {
		for (const key of ["reasoning_effort", "reasoningEffort"] as const) {
			const value = payload[key];
			if (typeof value !== "string" || !THINKING_LEVEL_SET.has(value as ModelThinkingLevel)) continue;
			const clamped = clampCapabilityReasoningLevel(capabilities, value as ModelThinkingLevel);
			const mapped = model.thinkingLevelMap?.[clamped];
			mutable[key] = mapped === null || clamped === "off" ? undefined : (mapped ?? clamped);
		}
		const reasoning = payload.reasoning;
		if (reasoning && typeof reasoning === "object" && !Array.isArray(reasoning)) {
			const record = { ...(reasoning as Record<string, unknown>) };
			if (typeof record.effort === "string" && THINKING_LEVEL_SET.has(record.effort as ModelThinkingLevel)) {
				const clamped = clampCapabilityReasoningLevel(capabilities, record.effort as ModelThinkingLevel);
				const mapped = model.thinkingLevelMap?.[clamped];
				record.effort = mapped === null || clamped === "off" ? undefined : (mapped ?? clamped);
			}
			mutable.reasoning = record;
		}
	}
	if (!capabilities.strictToolSchema) {
		mutable.strict = undefined;
		if (Array.isArray(payload.tools)) {
			mutable.tools = payload.tools.map((tool) => {
				if (!tool || typeof tool !== "object" || Array.isArray(tool)) return tool;
				const record = { ...(tool as Record<string, unknown>) };
				record.strict = undefined;
				const fn = record.function;
				if (fn && typeof fn === "object" && !Array.isArray(fn)) {
					record.function = { ...(fn as Record<string, unknown>), strict: undefined };
				}
				return record;
			});
		}
	}
	if (capabilities.promptCache.mode === "none") for (const key of CACHE_REQUEST_KEYS) mutable[key] = undefined;
	if (capabilities.promptCache.mode !== "none" && !capabilities.promptCache.retention) {
		for (const key of CACHE_RETENTION_REQUEST_KEYS) mutable[key] = undefined;
	}
	return payload;
}
