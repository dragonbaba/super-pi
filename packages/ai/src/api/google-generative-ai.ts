import {
	type GenerateContentConfig,
	type GenerateContentParameters,
	GoogleGenAI,
	type ThinkingConfig,
} from "@google/genai";
import { calculateCost, clampThinkingLevel } from "../models.ts";
import { contextForModelCapabilities, getModelCapabilities } from "../model-capabilities.ts";
import type {
	Api,
	AssistantMessage,
	Context,
	Model,
	ProviderHeaders,
	SimpleStreamOptions,
	StreamFunction,
	StreamOptions,
	TextContent,
	ThinkingBudgets,
	ThinkingContent,
	ThinkingLevel,
	ToolCall,
} from "../types.ts";
import { formatProviderError, normalizeProviderError } from "../utils/error-body.ts";
import { AssistantMessageEventStream } from "../utils/event-stream.ts";
import { observeEffectiveDispatch } from "../utils/effective-dispatch.ts";
import { providerHeadersToRecord } from "../utils/headers.ts";
import { getPiUserAgent } from "../utils/pi-user-agent.ts";
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

export interface GoogleOptions extends StreamOptions {
	toolChoice?: "auto" | "none" | "any";
	thinking?: {
		enabled: boolean;
		budgetTokens?: number; // -1 for dynamic, 0 to disable
		level?: GoogleThinkingLevel;
	};
}

// Counter for generating unique tool call IDs
let toolCallCounter = 0;

export const stream: StreamFunction<"google-generative-ai", GoogleOptions> = (
	model: Model<"google-generative-ai">,
	context: Context,
	options?: GoogleOptions,
): AssistantMessageEventStream => {
	const stream = new AssistantMessageEventStream();

	(async () => {
		const output: AssistantMessage = {
			role: "assistant",
			content: [],
			api: "google-generative-ai" as Api,
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
				throw new Error("Custom fetch is not supported by the Google Generative AI adapter");
			}
			const apiKey = options?.apiKey;
			if (!apiKey) {
				throw new Error(`No API key for provider: ${model.provider}`);
			}
			const client = createClient(model, apiKey, options?.headers);
			let params = buildParams(model, context, options);
			const nextParams = await options?.onPayload?.(params, model);
			if (nextParams !== undefined) {
				params = nextParams as GenerateContentParameters;
			}
			observeGoogleGenerativeAIEffectiveDispatch(options, model, params);
			const googleStream = await retryGoogleRequest(() => client.models.generateContentStream(params), options);

			stream.push({ type: "start", partial: output });
			let currentBlock: TextContent | ThinkingContent | null = null;
			const blocks = output.content;
			const blockIndex = () => blocks.length - 1;
			for await (const chunk of googleStream) {
				// @google/genai documents GenerateContentResponse.responseId as an output-only field
				// used to identify each response. Keep the first non-empty one from the stream.
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

							// Generate unique ID if not provided or if it's a duplicate
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
				throw new Error("Google stream ended without a finish reason");
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

export const streamSimple: StreamFunction<"google-generative-ai", SimpleStreamOptions> = (
	model: Model<"google-generative-ai">,
	context: Context,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream => {
	const apiKey = options?.apiKey;
	if (!apiKey) {
		throw new Error(`No API key for provider: ${model.provider}`);
	}

	const base: GoogleOptions = {
		...buildBaseOptions(model, context, options, apiKey),
		toolChoice: options?.toolChoice,
	};
	const capabilities = getModelCapabilities(model);
	const clampedReasoning = clampThinkingLevel(model, options?.reasoning ?? "off");
	if (clampedReasoning === "off") {
		return stream(model, context, { ...base, thinking: { enabled: false } } satisfies GoogleOptions);
	}

	const effort = clampedReasoning as ClampedThinkingLevel;
	if (capabilities.reasoning.mode === "levels") {
		return stream(model, context, {
			...base,
			thinking: {
				enabled: true,
				level: getThinkingLevel(effort, model),
			},
		} satisfies GoogleOptions);
	}
	if (capabilities.reasoning.mode === "adaptive") {
		return stream(model, context, {
			...base,
			thinking: { enabled: true, budgetTokens: -1 },
		} satisfies GoogleOptions);
	}

	return stream(model, context, {
		...base,
		thinking: {
			enabled: true,
			budgetTokens: getGoogleBudget(model, effort, options?.thinkingBudgets),
		},
	} satisfies GoogleOptions);
};

function createClient(
	model: Model<"google-generative-ai">,
	apiKey?: string,
	optionsHeaders?: ProviderHeaders,
): GoogleGenAI {
	const httpOptions: { baseUrl?: string; apiVersion?: string; headers?: Record<string, string> } = {};
	if (model.baseUrl) {
		httpOptions.baseUrl = model.baseUrl;
		httpOptions.apiVersion = ""; // baseUrl already includes version path, don't append
	}
	const headers = providerHeadersToRecord({ "User-Agent": getPiUserAgent(), ...model.headers, ...optionsHeaders });
	if (headers) {
		httpOptions.headers = headers;
	}

	return new GoogleGenAI({
		apiKey,
		httpOptions: Object.keys(httpOptions).length > 0 ? httpOptions : undefined,
	});
}

export function observeGoogleGenerativeAIEffectiveDispatch(
	options: GoogleOptions | undefined,
	model: Model<"google-generative-ai">,
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

function buildParams(
	model: Model<"google-generative-ai">,
	context: Context,
	options: GoogleOptions = {},
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
			// Cast to any since our GoogleThinkingLevel mirrors Google's ThinkingLevel enum values
			thinkingConfig.thinkingLevel = options.thinking.level as any;
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

type ClampedThinkingLevel = Exclude<ThinkingLevel, "off">;

function getDisabledThinkingConfig(model: Model<"google-generative-ai">): ThinkingConfig {
	return getModelCapabilities(model).reasoning.mode === "budget" ? { thinkingBudget: 0 } : {};
}

function getThinkingLevel(effort: ClampedThinkingLevel, model: Model<"google-generative-ai">): GoogleThinkingLevel {
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
	model: Model<"google-generative-ai">,
	effort: ClampedThinkingLevel,
	customBudgets?: ThinkingBudgets,
): number {
	const budgetLevel = effort === "xhigh" || effort === "max" ? "high" : effort;
	if (customBudgets?.[budgetLevel] !== undefined) {
		return customBudgets[budgetLevel]!;
	}

	return model.thinkingBudgetMap?.[effort] ?? model.thinkingBudgetMap?.high ?? -1;
}
