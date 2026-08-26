import type {
	Api,
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
const PROFILE_CACHE = new WeakMap<object, Map<string, Model<Api>>>();

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
	const manifest: ModelCapabilitiesV1 = {
		version: 1,
		inputModalities: Object.freeze({
			text: model.input.includes("text"),
			image: model.input.includes("image"),
			audio: false,
		}),
		toolCalling: TOOL_APIS.has(api),
		parallelTools: PARALLEL_TOOL_APIS.has(api),
		strictToolSchema: supportsStrictToolSchema(model),
		streamedToolArguments: STREAMED_TOOL_ARGUMENT_APIS.has(api),
		reasoning: Object.freeze(reasoningCapability(model)),
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
	return Object.freeze(manifest);
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
	if (
		model.profileSource === source &&
		model.capabilities !== undefined &&
		model.costKnown === requestedCostKnown &&
		(options.capabilities === undefined || options.capabilities === model.capabilities) &&
		(options.diagnostics === undefined || options.diagnostics === model.profileDiagnostics)
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
	const capabilities = options.capabilities ?? model.capabilities ?? deriveModelCapabilities(model as Model<Api>);
	const profiled: Model<TApi> = {
		...model,
		reasoning: capabilities.reasoning.mode !== "none",
		profileSource: source,
		capabilities,
		costKnown: requestedCostKnown,
		profileDiagnostics: Object.freeze([...(options.diagnostics ?? model.profileDiagnostics ?? [])]),
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
