import {
	type GenerateContentConfig,
	type GenerateContentParameters,
	GoogleGenAI,
	type HttpOptions,
	ResourceScope,
	type ThinkingConfig,
	ThinkingLevel,
} from "@google/genai";
import { calculateCost, clampThinkingLevel } from "../models.ts";
import { contextForModelCapabilities, getModelCapabilities } from "../model-capabilities.ts";
import type {
	Api,
	AssistantMessage,
	Context,
	Model,
	ThinkingLevel as PiThinkingLevel,
	ProviderEnv,
	ProviderHeaders,
	SimpleStreamOptions,
	StreamFunction,
	StreamOptions,
	TextContent,
	ThinkingBudgets,
	ThinkingContent,
	ToolCall,
} from "../types.ts";

export const streamedToolArgumentOwnership = "replacement-object" as const;
import { formatProviderError, normalizeProviderError } from "../utils/error-body.ts";
import { AssistantMessageEventStream } from "../utils/event-stream.ts";
import { observeEffectiveDispatch } from "../utils/effective-dispatch.ts";
import { providerHeadersToRecord } from "../utils/headers.ts";
import { getPiUserAgent } from "../utils/pi-user-agent.ts";
import { getProviderEnvValue } from "../utils/provider-env.ts";
import { sanitizeSurrogates } from "../utils/sanitize-unicode.ts";
import type { GoogleThinkingLevel } from "./google-shared.ts";
import {
	convertMessages,
	convertTools,
	isThinkingPart,
	mapStopReason,
	resolveGoogleFunctionCallingMode,
	retainThoughtSignature,
	retryGoogleRequest,
} from "./google-shared.ts";
import { buildBaseOptions } from "./simple-options.ts";

export interface GoogleVertexOptions extends StreamOptions {
	toolChoice?: "auto" | "none" | "any";
	thinking?: {
		enabled: boolean;
		budgetTokens?: number; // -1 for dynamic, 0 to disable
		level?: GoogleThinkingLevel;
	};
	project?: string;
	location?: string;
}

const API_VERSION = "v1";
const GCP_VERTEX_CREDENTIALS_MARKER = "gcp-vertex-credentials";

const THINKING_LEVEL_MAP: Record<GoogleThinkingLevel, ThinkingLevel> = {
	THINKING_LEVEL_UNSPECIFIED: ThinkingLevel.THINKING_LEVEL_UNSPECIFIED,
	MINIMAL: ThinkingLevel.MINIMAL,
	LOW: ThinkingLevel.LOW,
	MEDIUM: ThinkingLevel.MEDIUM,
	HIGH: ThinkingLevel.HIGH,
};

// Counter for generating unique tool call IDs
let toolCallCounter = 0;

export const stream: StreamFunction<"google-vertex", GoogleVertexOptions> = (
	model: Model<"google-vertex">,
	context: Context,
	options?: GoogleVertexOptions,
): AssistantMessageEventStream => {
	const stream = new AssistantMessageEventStream();

	(async () => {
		const output: AssistantMessage = {
			role: "assistant",
			content: [],
			api: "google-vertex" as Api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "pending",
			timestamp: Date.now(),
		};

		try {
			if (options?.fetch && options.fetch !== globalThis.fetch) {
				throw new Error("Custom fetch is not supported by the Google Vertex adapter");
			}
			const apiKey = resolveApiKey(options);
			// Create the client using either a Vertex API key, if provided, or ADC with project and location
			const client = apiKey
				? createClientWithApiKey(model, apiKey, options?.headers)
				: createClient(model, resolveProject(options), resolveLocation(options), options?.headers, options?.env);
			let params = buildParams(model, context, options);
			const nextParams = await options?.onPayload?.(params, model);
			if (nextParams !== undefined) {
				params = nextParams as GenerateContentParameters;
			}
			observeGoogleVertexEffectiveDispatch(options, model, params);
			const googleStream = await retryGoogleRequest(() => client.models.generateContentStream(params), options);

			stream.push({ type: "start", partial: output });
			let currentBlock: TextContent | ThinkingContent | null = null;
			const blocks = output.content;
			const blockIndex = () => blocks.length - 1;
			for await (const chunk of googleStream) {
				// Vertex uses the same @google/genai GenerateContentResponse type as Gemini.
				// responseId is documented there as an output-only identifier for each response.
				output.responseId ||= chunk.responseId;
				const candidate = chunk.candidates?.[0];
				if (candidate?.content?.parts) {
					for (const part of candidate.content.parts) {
						if (part.text !== undefined) {
							const isThinking = isThinkingPart(part);
							if (
								!currentBlock ||
								(isThinking && currentBlock.type !== "thinking") ||
								(!isThinking && currentBlock.type !== "text")
							) {
								if (currentBlock) {
									if (currentBlock.type === "text") {
										stream.push({
											type: "text_end",
											contentIndex: blocks.length - 1,
											content: currentBlock.text,
											partial: output,
										});
									} else {
										stream.push({
											type: "thinking_end",
											contentIndex: blockIndex(),
											content: currentBlock.thinking,
											partial: output,
										});
									}
								}
								if (isThinking) {
									currentBlock = { type: "thinking", thinking: "", thinkingSignature: undefined };
									output.content.push(currentBlock);
									stream.push({ type: "thinking_start", contentIndex: blockIndex(), partial: output });
								} else {
									currentBlock = { type: "text", text: "" };
									output.content.push(currentBlock);
									stream.push({ type: "text_start", contentIndex: blockIndex(), partial: output });
								}
							}
							if (currentBlock.type === "thinking") {
								currentBlock.thinking += part.text;
								currentBlock.thinkingSignature = retainThoughtSignature(
									currentBlock.thinkingSignature,
									part.thoughtSignature,
								);
								stream.push({
									type: "thinking_delta",
									contentIndex: blockIndex(),
									delta: part.text,
									partial: output,
								});
							} else {
								currentBlock.text += part.text;
								currentBlock.textSignature = retainThoughtSignature(
									currentBlock.textSignature,
									part.thoughtSignature,
								);
								stream.push({
									type: "text_delta",
									contentIndex: blockIndex(),
									delta: part.text,
									partial: output,
								});
							}
						}

						if (part.functionCall) {
							if (currentBlock) {
								if (currentBlock.type === "text") {
									stream.push({
										type: "text_end",
										contentIndex: blockIndex(),
										content: currentBlock.text,
										partial: output,
									});
								} else {
									stream.push({
										type: "thinking_end",
										contentIndex: blockIndex(),
										content: currentBlock.thinking,
										partial: output,
									});
								}
								currentBlock = null;
							}

							const providedId = part.functionCall.id;
							const needsNewId =
								!providedId || output.content.some((b) => b.type === "toolCall" && b.id === providedId);
							const toolCallId = needsNewId
								? `${part.functionCall.name}_${Date.now()}_${++toolCallCounter}`
								: providedId;

							const toolCall: ToolCall = {
								type: "toolCall",
								id: toolCallId,
								name: part.functionCall.name || "",
								arguments: (part.functionCall.args as Record<string, any>) ?? {},
								...(part.thoughtSignature && { thoughtSignature: part.thoughtSignature }),
							};

							output.content.push(toolCall);
							stream.push({ type: "toolcall_start", contentIndex: blockIndex(), partial: output });
							stream.push({
								type: "toolcall_delta",
								contentIndex: blockIndex(),
								delta: JSON.stringify(toolCall.arguments),
								partial: output,
							});
							stream.push({ type: "toolcall_end", contentIndex: blockIndex(), toolCall, partial: output });
						}
					}
				}

				if (candidate?.finishReason) {
					output.rawStopReason = candidate.finishReason;
					output.stopReason = mapStopReason(candidate.finishReason);
					if (output.content.some((b) => b.type === "toolCall") && output.stopReason === "stop") {
						output.stopReason = "toolUse";
					}
				}

				if (chunk.usageMetadata) {
					output.usage = {
						input:
							(chunk.usageMetadata.promptTokenCount || 0) - (chunk.usageMetadata.cachedContentTokenCount || 0),
						output:
							(chunk.usageMetadata.candidatesTokenCount || 0) + (chunk.usageMetadata.thoughtsTokenCount || 0),
						cacheRead: chunk.usageMetadata.cachedContentTokenCount || 0,
						cacheWrite: 0,
						reasoning: chunk.usageMetadata.thoughtsTokenCount || 0,
						totalTokens: chunk.usageMetadata.totalTokenCount || 0,
						cost: {
							input: 0,
							output: 0,
							cacheRead: 0,
							cacheWrite: 0,
							total: 0,
						},
					};
					calculateCost(model, output.usage);
				}
			}

			if (currentBlock) {
				if (currentBlock.type === "text") {
					stream.push({
						type: "text_end",
						contentIndex: blockIndex(),
						content: currentBlock.text,
						partial: output,
					});
				} else {
					stream.push({
						type: "thinking_end",
						contentIndex: blockIndex(),
						content: currentBlock.thinking,
						partial: output,
					});
				}
			}

			if (options?.signal?.aborted) {
				throw new Error("Request was aborted");
			}

			if (output.stopReason === "pending") {
				throw new Error("Google Vertex stream ended without a finish reason");
			}
			if (output.stopReason === "aborted" || output.stopReason === "error") {
				const errorMessage = output.rawStopReason
					? `Provider stopped with: ${output.rawStopReason}`
					: "An unknown error occurred";
				throw new Error(errorMessage);
			}

			stream.push({ type: "done", reason: output.stopReason, message: output });
			stream.end();
		} catch (error) {
			// Remove internal index property used during streaming
			for (const block of output.content) {
				if ("index" in block) {
					(block as { index?: number }).index = undefined;
				}
			}
			output.stopReason = options?.signal?.aborted ? "aborted" : "error";
			output.errorMessage = formatProviderError(normalizeProviderError(error));
			stream.push({ type: "error", reason: output.stopReason, error: output });
			stream.end();
		}
	})();

	return stream;
};

export const streamSimple: StreamFunction<"google-vertex", SimpleStreamOptions> = (
	model: Model<"google-vertex">,
	context: Context,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream => {
	const base: GoogleVertexOptions = {
		...buildBaseOptions(model, context, options, undefined),
		toolChoice: options?.toolChoice,
	};
	const capabilities = getModelCapabilities(model);
	const clampedReasoning = clampThinkingLevel(model, options?.reasoning ?? "off");
	if (clampedReasoning === "off") {
		return stream(model, context, {
			...base,
			thinking: { enabled: false },
		} satisfies GoogleVertexOptions);
	}

	const effort = clampedReasoning as ClampedThinkingLevel;
	if (capabilities.reasoning.mode === "levels") {
		return stream(model, context, {
			...base,
			thinking: {
				enabled: true,
				level: getThinkingLevel(effort, model),
			},
		} satisfies GoogleVertexOptions);
	}
	if (capabilities.reasoning.mode === "adaptive") {
		return stream(model, context, {
			...base,
			thinking: { enabled: true, budgetTokens: -1 },
		} satisfies GoogleVertexOptions);
	}

	return stream(model, context, {
		...base,
		thinking: {
			enabled: true,
			budgetTokens: getGoogleBudget(model, effort, options?.thinkingBudgets),
		},
	} satisfies GoogleVertexOptions);
};

function createClient(
	model: Model<"google-vertex">,
	project: string,
	location: string,
	optionsHeaders?: ProviderHeaders,
	env?: ProviderEnv,
): GoogleGenAI {
	const googleAuthOptions = buildGoogleAuthOptions(env);
	return new GoogleGenAI({
		vertexai: true,
		project,
		location,
		apiVersion: API_VERSION,
		...(googleAuthOptions ? { googleAuthOptions } : {}),
		httpOptions: buildHttpOptions(model, optionsHeaders),
	});
}

export function observeGoogleVertexEffectiveDispatch(
	options: GoogleVertexOptions | undefined,
	model: Model<"google-vertex">,
	params: GenerateContentParameters,
): void {
	const effectiveTools = extractGoogleEffectiveTools(params.config?.tools ?? []);
	const cachedContent = params.config?.cachedContent;
	observeEffectiveDispatch(options, model, {
		transport: "sse",
		previousResponseMode: "none",
		instructionPrefix: params.config?.systemInstruction ?? null,
		orderedToolDefinitions: effectiveTools.definitions,
		orderedToolIdentifiers: effectiveTools.identifiers,
		cacheKey: cachedContent,
		cacheRetention: null,
		cachePolicy: { enabled: Boolean(cachedContent), mode: cachedContent ? "explicit" : "implicit" },
		cacheBoundary: null,
	});
}

function extractGoogleEffectiveTools(tools: readonly unknown[]): { definitions: unknown[]; identifiers: string[] } {
	const definitions: unknown[] = [];
	const identifiers: string[] = [];
	for (const value of tools) {
		if (!value || typeof value !== "object") {
			definitions.push(value);
			identifiers.push(`native:${typeof value}`);
			continue;
		}
		const tool = value as Record<string, unknown>;
		const declarations = Array.isArray(tool.functionDeclarations) ? tool.functionDeclarations : [];
		for (const declaration of declarations) {
			definitions.push(declaration);
			const name = declaration && typeof declaration === "object"
				? (declaration as Record<string, unknown>).name
				: undefined;
			identifiers.push(`function:${typeof name === "string" ? name : "unknown"}`);
		}
		for (const kind of Object.keys(tool).filter((key) => key !== "functionDeclarations" && tool[key] !== undefined).sort()) {
			definitions.push({ kind, configuration: tool[kind] });
			identifiers.push(`native:${kind}`);
		}
	}
	return { definitions, identifiers };
}

function createClientWithApiKey(
	model: Model<"google-vertex">,
	apiKey: string,
	optionsHeaders?: ProviderHeaders,
): GoogleGenAI {
	return new GoogleGenAI({
		vertexai: true,
		apiKey,
		apiVersion: API_VERSION,
		httpOptions: buildHttpOptions(model, optionsHeaders),
	});
}

function buildHttpOptions(model: Model<"google-vertex">, optionsHeaders?: ProviderHeaders): HttpOptions | undefined {
	const httpOptions: HttpOptions = {};
	const baseUrl = resolveCustomBaseUrl(model.baseUrl);
	if (baseUrl) {
		httpOptions.baseUrl = baseUrl;
		httpOptions.baseUrlResourceScope = ResourceScope.COLLECTION;
		if (baseUrlIncludesApiVersion(baseUrl)) {
			httpOptions.apiVersion = "";
		}
	}

	const headers = providerHeadersToRecord({ "User-Agent": getPiUserAgent(), ...model.headers, ...optionsHeaders });
	if (headers) {
		httpOptions.headers = headers;
	}

	return Object.keys(httpOptions).length > 0 ? httpOptions : undefined;
}

function resolveCustomBaseUrl(baseUrl: string): string | undefined {
	const trimmed = baseUrl.trim();
	if (!trimmed || trimmed.includes("{location}")) {
		return undefined;
	}
	return trimmed;
}

function baseUrlIncludesApiVersion(baseUrl: string): boolean {
	try {
		const url = new URL(baseUrl);
		return url.pathname.split("/").some((part) => /^v\d+(?:beta\d*)?$/.test(part));
	} catch {
		return /(?:^|\/)v\d+(?:beta\d*)?(?:\/|$)/.test(baseUrl);
	}
}

function buildGoogleAuthOptions(env?: ProviderEnv): { keyFilename: string } | undefined {
	const keyFilename = getProviderEnvValue("GOOGLE_APPLICATION_CREDENTIALS", env);
	return keyFilename ? { keyFilename } : undefined;
}

function resolveApiKey(options?: GoogleVertexOptions): string | undefined {
	const apiKey = options?.apiKey?.trim();
	if (!apiKey || apiKey === GCP_VERTEX_CREDENTIALS_MARKER || isPlaceholderApiKey(apiKey)) {
		return undefined;
	}
	return apiKey;
}

function isPlaceholderApiKey(apiKey: string): boolean {
	return /^<[^>]+>$/.test(apiKey);
}

function resolveProject(options?: GoogleVertexOptions): string {
	const project =
		options?.project ||
		getProviderEnvValue("GOOGLE_CLOUD_PROJECT", options?.env) ||
		getProviderEnvValue("GCLOUD_PROJECT", options?.env);
	if (!project) {
		throw new Error(
			"Vertex AI requires a project ID. Set GOOGLE_CLOUD_PROJECT/GCLOUD_PROJECT or pass project in options.",
		);
	}
	return project;
}

function resolveLocation(options?: GoogleVertexOptions): string {
	const location = options?.location || getProviderEnvValue("GOOGLE_CLOUD_LOCATION", options?.env);
	if (!location) {
		throw new Error("Vertex AI requires a location. Set GOOGLE_CLOUD_LOCATION or pass location in options.");
	}
	return location;
}

function buildParams(
	model: Model<"google-vertex">,
	context: Context,
	options: GoogleVertexOptions = {},
): GenerateContentParameters {
	const capabilities = getModelCapabilities(model);
	const wireContext = contextForModelCapabilities(model, context);
	const contents = convertMessages(model, wireContext);
	const supportsStrictMode = capabilities.strictToolSchema;

	const generationConfig: GenerateContentConfig = {};
	if (options.temperature !== undefined) {
		generationConfig.temperature = options.temperature;
	}
	if (options.maxTokens !== undefined) {
		generationConfig.maxOutputTokens = options.maxTokens;
	}

	const functionCallingMode = wireContext.tools?.length
		? resolveGoogleFunctionCallingMode(wireContext.tools, options.toolChoice, supportsStrictMode)
		: undefined;
	const config: GenerateContentConfig = {
		...(Object.keys(generationConfig).length > 0 && generationConfig),
		...(wireContext.systemPrompt && { systemInstruction: sanitizeSurrogates(wireContext.systemPrompt) }),
		...(wireContext.tools &&
			wireContext.tools.length > 0 && {
				tools: convertTools(wireContext.tools, false, supportsStrictMode),
			}),
		...(functionCallingMode !== undefined && {
			toolConfig: { functionCallingConfig: { mode: functionCallingMode } },
		}),
	};

	if (options.thinking?.enabled && capabilities.reasoning.mode !== "none") {
		const thinkingConfig: ThinkingConfig = { includeThoughts: true };
		if (options.thinking.level !== undefined) {
			thinkingConfig.thinkingLevel = THINKING_LEVEL_MAP[options.thinking.level];
		} else if (options.thinking.budgetTokens !== undefined) {
			thinkingConfig.thinkingBudget = options.thinking.budgetTokens;
		}
		config.thinkingConfig = thinkingConfig;
	} else if (capabilities.reasoning.mode !== "none" && options.thinking && !options.thinking.enabled) {
		config.thinkingConfig = getDisabledThinkingConfig(model);
	}

	if (options.signal) {
		if (options.signal.aborted) {
			throw new Error("Request aborted");
		}
		config.abortSignal = options.signal;
	}

	const params: GenerateContentParameters = {
		model: model.id,
		contents,
		config,
	};

	return params;
}

type ClampedThinkingLevel = Exclude<PiThinkingLevel, "off">;

function getDisabledThinkingConfig(model: Model<"google-vertex">): ThinkingConfig {
	return getModelCapabilities(model).reasoning.mode === "budget" ? { thinkingBudget: 0 } : {};
}

function getThinkingLevel(effort: ClampedThinkingLevel, model: Model<"google-vertex">): GoogleThinkingLevel {
	const mapped = model.thinkingLevelMap?.[effort];
	if (mapped === "MINIMAL" || mapped === "LOW" || mapped === "MEDIUM" || mapped === "HIGH") return mapped;
	switch (effort) {
		case "minimal":
			return "MINIMAL";
		case "low":
			return "LOW";
		case "medium":
			return "MEDIUM";
		case "high":
		case "xhigh":
		case "max":
			return "HIGH";
	}
}

function getGoogleBudget(
	model: Model<"google-vertex">,
	effort: ClampedThinkingLevel,
	customBudgets?: ThinkingBudgets,
): number {
	const budgetLevel = effort === "xhigh" || effort === "max" ? "high" : effort;
	if (customBudgets?.[budgetLevel] !== undefined) {
		return customBudgets[budgetLevel]!;
	}

	return model.thinkingBudgetMap?.[effort] ?? model.thinkingBudgetMap?.high ?? -1;
}
