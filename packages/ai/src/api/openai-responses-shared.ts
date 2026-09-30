import type OpenAI from "openai";
import type {
	Tool as OpenAITool,
	ResponseCreateParamsStreaming,
	ResponseInput,
	ResponseInputContent,
	ResponseInputImage,
	ResponseInputItem,
	ResponseInputText,
	ResponseOutputItem,
	ResponseOutputMessage,
	ResponseReasoningItem,
	ResponseStreamEvent,
	ResponseToolSearchOutputItemParam,
} from "openai/resources/responses/responses.js";
import { calculateCost } from "../models.ts";
import type {
	Api,
	AssistantMessage,
	Context,
	ImageContent,
	Model,
	StopReason,
	TextContent,
	TextSignatureV1,
	ThinkingContent,
	Tool,
	ToolCall,
	Usage,
} from "../types.ts";
import { getModelCapabilities } from "../model-capabilities.ts";
import type { AssistantMessageEventStream } from "../utils/event-stream.ts";
import { shortHash } from "../utils/hash.ts";
import { parseStreamingJson, stringifyToolArguments } from "../utils/json-parse.ts";
import { sanitizeSurrogates } from "../utils/sanitize-unicode.ts";
import {
	appendGrammarToolInputJsonDelta,
	type GrammarToolInputJsonBuffer,
	getGrammarToolInput,
	getJsonSchemaToolParameters,
	resolveGrammarConstrainedSampling,
	resolveJsonSchemaStrictSampling,
} from "./constrained-sampling.ts";
import { transformMessages } from "./transform-messages.ts";

// =============================================================================
// Utilities
// =============================================================================

function encodeTextSignatureV1(id: string, phase?: TextSignatureV1["phase"]): string {
	const payload: TextSignatureV1 = { v: 1, id };
	if (phase) payload.phase = phase;
	return JSON.stringify(payload);
}

function parseTextSignature(
	signature: string | undefined,
): { id: string; phase?: TextSignatureV1["phase"] } | undefined {
	if (!signature) return undefined;
	if (signature.startsWith("{")) {
		try {
			const parsed = JSON.parse(signature) as Partial<TextSignatureV1>;
			if (parsed.v === 1 && typeof parsed.id === "string") {
				if (parsed.phase === "commentary" || parsed.phase === "final_answer") {
					return { id: parsed.id, phase: parsed.phase };
				}
				return { id: parsed.id };
			}
		} catch {
			// Fall through to legacy plain-string handling.
		}
	}
	return { id: signature };
}

type ToolResultOutputContent = Array<ResponseInputText | ResponseInputImage>;

function convertToolResultOutput<TApi extends Api>(
	model: Model<TApi>,
	content: readonly (TextContent | ImageContent)[],
): string | ToolResultOutputContent {
	let textResult = "";
	let textBlocks = 0;
	let imageCount = 0;
	const supportsImages = model.input.includes("image");
	let output: ToolResultOutputContent | undefined;
	for (const item of content) {
		if (item.type === "text") {
			textResult += (textBlocks++ > 0 ? "\n" : "") + item.text;
		} else if (item.type === "image") {
			imageCount++;
			if (supportsImages) {
				output ??= [];
				output.push({ type: "input_image", detail: "auto", image_url: `data:${item.mimeType};base64,${item.data}` });
			}
		}
	}
	const hasText = textResult.length > 0;

	if (imageCount === 0 || !supportsImages) {
		return sanitizeSurrogates(hasText ? textResult : imageCount > 0 ? "(see attached image)" : "(no tool output)");
	}

	if (hasText) {
		output!.unshift({ type: "input_text", text: sanitizeSurrogates(textResult) });
	}
	return output!;
}

export interface OpenAIResponsesStreamOptions {
	serviceTier?: ResponseCreateParamsStreaming["service_tier"];
	grammarToolInputProperties?: ReadonlyMap<string, string>;
	resolveServiceTier?: (
		responseServiceTier: ResponseCreateParamsStreaming["service_tier"] | undefined,
		requestServiceTier: ResponseCreateParamsStreaming["service_tier"] | undefined,
	) => ResponseCreateParamsStreaming["service_tier"] | undefined;
	applyServiceTierPricing?: (
		usage: Usage,
		serviceTier: ResponseCreateParamsStreaming["service_tier"] | undefined,
	) => void;
}

export interface ConvertResponsesMessagesOptions {
	includeSystemPrompt?: boolean;
	grammarToolInputProperties?: ReadonlyMap<string, string>;
	deferredTools?: ReadonlyMap<string, Tool>;
	toolOptions?: ConvertResponsesToolsOptions;
}

export interface ConvertResponsesToolsOptions {
	strict?: boolean | null;
	supportsStrictMode?: boolean;
	supportsOpenAIGrammarTools?: boolean;
	deferLoading?: boolean;
}

// =============================================================================
// Message conversion
// =============================================================================

const ID_INVALID_CHARACTER_PATTERN = /[^a-zA-Z0-9_-]/g;
const ID_TRAILING_UNDERSCORE_PATTERN = /_+$/;

function normalizeIdPart(part: string): string {
	const sanitized = part.replace(ID_INVALID_CHARACTER_PATTERN, "_");
	const normalized = sanitized.length > 64 ? sanitized.slice(0, 64) : sanitized;
	return normalized.replace(ID_TRAILING_UNDERSCORE_PATTERN, "");
}

function buildForeignResponsesItemId(itemId: string): string {
	const normalized = `fc_${shortHash(itemId)}`;
	return normalized.length > 64 ? normalized.slice(0, 64) : normalized;
}

export function convertResponsesMessages<TApi extends Api>(
	model: Model<TApi>,
	context: Context,
	allowedToolCallProviders: ReadonlySet<string>,
	options?: ConvertResponsesMessagesOptions,
): ResponseInput {
	const messages: ResponseInput = [];
	const loadedToolNames = new Set<string>();





	const normalizeToolCallId = (id: string, _targetModel: Model<TApi>, source: AssistantMessage): string => {
		if (!allowedToolCallProviders.has(model.provider)) return normalizeIdPart(id);
		if (!id.includes("|")) return normalizeIdPart(id);
		const [callId, itemId] = id.split("|");
		const normalizedCallId = normalizeIdPart(callId);
		const isForeignToolCall = source.provider !== model.provider || source.api !== model.api;
		let normalizedItemId = isForeignToolCall ? buildForeignResponsesItemId(itemId) : normalizeIdPart(itemId);
		// OpenAI Responses API requires item id to start with "fc"
		if (!normalizedItemId.startsWith("fc_")) {
			normalizedItemId = normalizeIdPart(`fc_${normalizedItemId}`);
		}
		return `${normalizedCallId}|${normalizedItemId}`;
	};

	const transformedMessages = transformMessages(context.messages, model, normalizeToolCallId);

	const includeSystemPrompt = options?.includeSystemPrompt ?? true;
	if (includeSystemPrompt && context.systemPrompt) {
		const compat = model.compat as { supportsDeveloperRole?: boolean } | undefined;
		const role = getModelCapabilities(model).reasoning.mode !== "none" && compat?.supportsDeveloperRole !== false
			? "developer"
			: "system";
		messages.push({
			role,
			content: sanitizeSurrogates(context.systemPrompt),
		});
	}

	let msgIndex = 0;
	for (const msg of transformedMessages) {
		if (msg.role === "user") {
			if (typeof msg.content === "string") {
				messages.push({
					role: "user",
					content: [{ type: "input_text", text: sanitizeSurrogates(msg.content) }],
				});
			} else {
				const content: ResponseInputContent[] = [];
				for (const item of msg.content) {
					if (item.type === "text") {
						content.push({
							type: "input_text",
							text: sanitizeSurrogates(item.text),
						} satisfies ResponseInputText);
						continue;
					}
					content.push({
						type: "input_image",
						detail: "auto",
						image_url: `data:${item.mimeType};base64,${item.data}`,
					} satisfies ResponseInputImage);
				}
				if (content.length === 0) continue;
				messages.push({
					role: "user",
					content,
				});
			}
		} else if (msg.role === "assistant") {
			const output: ResponseInput = [];
			const assistantMsg = msg as AssistantMessage;
			const isSameProviderAndApi = assistantMsg.provider === model.provider && assistantMsg.api === model.api;
			const isSameModel = isSameProviderAndApi && assistantMsg.model === model.id;
			const isDifferentModel = isSameProviderAndApi && assistantMsg.model !== model.id;
			let textBlockIndex = 0;

			for (const block of msg.content) {
				if (block.type === "thinking") {
					if (block.thinkingSignature) {
						const reasoningItem = JSON.parse(block.thinkingSignature) as ResponseReasoningItem;
						output.push(reasoningItem);
					}
				} else if (block.type === "text") {
					const textBlock = block as TextContent;
					const parsedSignature = parseTextSignature(textBlock.textSignature);
					const fallbackMessageId =
						textBlockIndex === 0 ? `msg_pi_${msgIndex}` : `msg_pi_${msgIndex}_${textBlockIndex}`;
					textBlockIndex++;
					// OpenAI requires id to be max 64 characters
					let msgId = parsedSignature?.id;
					if (!msgId) {
						msgId = fallbackMessageId;
					} else if (msgId.length > 64) {
						msgId = `msg_${shortHash(msgId)}`;
					}
					output.push({
						type: "message",
						role: "assistant",
						content: [{ type: "output_text", text: sanitizeSurrogates(textBlock.text), annotations: [] }],
						status: "completed",
						id: msgId,
						phase: parsedSignature?.phase,
					} satisfies ResponseOutputMessage);
				} else if (block.type === "toolCall") {
					const toolCall = block as ToolCall;
					const [callId, itemIdRaw] = toolCall.id.split("|");
					const customInputProperty = options?.grammarToolInputProperties?.get(toolCall.name);
					let itemId: string | undefined = itemIdRaw;

					// For different-model messages, set id to undefined to avoid pairing validation.
					// OpenAI tracks which fc_xxx IDs were paired with rs_xxx reasoning items.
					// By omitting the id, we avoid triggering that validation (like cross-provider does).
					// When replaying custom-tool calls as a function_call, also drop non-fc_* ids such as
					// ctc_* custom-tool ids because function_call item ids must be fc_*.
					if (
						(isDifferentModel && itemId?.startsWith("fc_")) ||
						(customInputProperty === undefined && !itemId?.startsWith("fc_"))
					) {
						itemId = undefined;
					}
					const canReplayNamespace = isSameModel || options?.deferredTools?.has(toolCall.name) === true;

					if (customInputProperty !== undefined) {
						output.push({
							type: "custom_tool_call",
							id: itemId,
							call_id: callId,
							name: toolCall.name,
							input: sanitizeSurrogates(
								getGrammarToolInput(toolCall.name, toolCall.arguments, customInputProperty),
							),
							...(canReplayNamespace && toolCall.namespace !== undefined
								? { namespace: toolCall.namespace }
								: {}),
						} satisfies ResponseOutputItem);
					} else {
						output.push({
							type: "function_call",
							id: itemId,
							call_id: callId,
							name: toolCall.name,
							arguments: stringifyToolArguments(toolCall.arguments)!,
							...(canReplayNamespace && toolCall.namespace !== undefined
								? { namespace: toolCall.namespace }
								: {}),
						});
					}
				}
			}
			if (output.length === 0) continue;
			messages.push(...output);
		} else if (msg.role === "toolResult") {
			const [callId] = msg.toolCallId.split("|");
			const output = convertToolResultOutput(model, msg.content);

			if (options?.grammarToolInputProperties?.has(msg.toolName)) {
				messages.push({
					type: "custom_tool_call_output",
					call_id: callId,
					output,
				});
			} else {
				messages.push({
					type: "function_call_output",
					call_id: callId,
					output,
				});
			}

			const deferredTools: Tool[] = [];
			for (const name of msg.addedToolNames ?? []) {
				const tool = options?.deferredTools?.get(name);
				if (!tool || loadedToolNames.has(name)) continue;
				loadedToolNames.add(name);
				deferredTools.push(tool);
			}
			if (deferredTools.length > 0) {
				const names: string[] = [];
				for (const tool of deferredTools) names.push(tool.name);
				const searchCallId = `pi_tool_load_${shortHash(`${msg.toolCallId}:${names.join(",")}`)}`;
				messages.push({
					type: "tool_search_call",
					call_id: searchCallId,
					execution: "client",
					status: "completed",
					arguments: { query: names.join(" "), limit: names.length },
				} satisfies ResponseInputItem);
				messages.push({
					type: "tool_search_output",
					call_id: searchCallId,
					execution: "client",
					status: "completed",
					tools: convertResponsesTools(deferredTools, {
						...options?.toolOptions,
						deferLoading: true,
					}),
				} satisfies ResponseToolSearchOutputItemParam);
			}
		}
		msgIndex++;
	}

	return messages;
}

// =============================================================================
// Tool conversion
// =============================================================================

export function convertResponsesTools(tools: readonly Tool[], options?: ConvertResponsesToolsOptions): OpenAITool[] {
	const defaultStrict = options?.strict === undefined ? false : options.strict;
	const supportsStrictMode = options?.supportsStrictMode ?? true;
	const supportsOpenAIGrammarTools = options?.supportsOpenAIGrammarTools ?? false;

	const converted: OpenAITool[] = [];
	for (const tool of tools) {
		const grammar = resolveGrammarConstrainedSampling(tool, supportsOpenAIGrammarTools);
		if (grammar) {
			converted.push({
				type: "custom",
				name: tool.name,
				description: tool.description,
				format: {
					type: "grammar",
					syntax: grammar.format,
					definition: grammar.definition,
				},
				...(options?.deferLoading ? { defer_loading: true } : {}),
			} satisfies OpenAITool);
			continue;
		}

		const constrainedStrict = resolveJsonSchemaStrictSampling(tool, supportsStrictMode);
		const strict = constrainedStrict ?? defaultStrict;
		const functionTool: Omit<Extract<OpenAITool, { type: "function" }>, "strict"> & {
			strict?: Extract<OpenAITool, { type: "function" }>["strict"];
		} = {
			type: "function",
			name: tool.name,
			description: tool.description,
			parameters: getJsonSchemaToolParameters(tool, strict === true) as Record<string, unknown>,
			...(options?.deferLoading ? { defer_loading: true } : {}),
		};
		if (supportsStrictMode) {
			functionTool.strict = strict;
		}
		converted.push(functionTool as OpenAITool);
	}
	return converted;
}

// =============================================================================
// Stream processing
// =============================================================================

type StreamingToolCall = ToolCall & {
	partialJson?: string;
	/** Host-only generation for custom/grammar argument replacement. */
	toolArgsGeneration?: number;
	customInput?: {
		property: string;
		jsonBuffer: GrammarToolInputJsonBuffer;
	};
};

function getCustomToolCallInput(block: StreamingToolCall): string {
	const property = block.customInput?.property;
	if (property === undefined) return "";
	const value = block.arguments[property];
	return typeof value === "string" ? value : "";
}

function appendCustomToolCallInput(block: StreamingToolCall, nextInput: string, close: boolean): string | undefined {
	const customInput = block.customInput;
	if (!customInput) return undefined;
	const delta = appendGrammarToolInputJsonDelta(customInput.jsonBuffer, customInput.property, nextInput, close);
	block.arguments = { [customInput.property]: nextInput };
	if (delta !== undefined) block.toolArgsGeneration = (block.toolArgsGeneration ?? 0) + 1;
	return delta;
}

type ResponsesOutputSlot =
	| { type: "thinking"; block: ThinkingContent; contentIndex: number }
	| { type: "text"; block: TextContent; contentIndex: number }
	| { type: "toolCall"; block: StreamingToolCall; contentIndex: number };

type ToolCallOutputSlot = Extract<ResponsesOutputSlot, { type: "toolCall" }>;

function joinReasoningText(parts: readonly { text?: string }[] | undefined): string {
	if (!parts) return "";
	let text = "";
	for (let index = 0; index < parts.length; index++) {
		text += (index > 0 ? "\n\n" : "") + (parts[index]!.text ?? "");
	}
	return text;
}

function applyMessagePhaseStopReason(
	item: ResponseOutputItem,
	output: AssistantMessage,
): void {
	if (item.type === "message" && item.phase === "final_answer") {
		output.stopReason = "stop";
	}
}

function getSlot<TType extends ResponsesOutputSlot["type"]>(
	outputIndex: number,
	type: TType,
	outputSlots: Map<number, ResponsesOutputSlot>,
): Extract<ResponsesOutputSlot, { type: TType }> | undefined {
	const slot = outputSlots.get(outputIndex);
	return slot?.type === type ? (slot as Extract<ResponsesOutputSlot, { type: TType }>) : undefined;
}

function pushToolCallDelta(
	slot: ToolCallOutputSlot,
	delta: string | undefined,
	output: AssistantMessage,
	stream: AssistantMessageEventStream,
): void {
	if (delta === undefined) return;
	stream.push({
		type: "toolcall_delta",
		contentIndex: slot.contentIndex,
		delta,
		partial: output,
		toolArgsGeneration: slot.block.toolArgsGeneration,
	});
}

function createSlot(
	outputIndex: number,
	item: ResponseOutputItem,
	output: AssistantMessage,
	stream: AssistantMessageEventStream,
	outputSlots: Map<number, ResponsesOutputSlot>,
	options?: OpenAIResponsesStreamOptions,
): ResponsesOutputSlot | undefined {
	if (item.type === "reasoning") {
		const block: ThinkingContent = { type: "thinking", thinking: "" };
		output.content.push(block);
		const slot = {
			type: "thinking",
			block,
			contentIndex: output.content.length - 1,
		} satisfies ResponsesOutputSlot;
		outputSlots.set(outputIndex, slot);
		stream.push({ type: "thinking_start", contentIndex: slot.contentIndex, partial: output });
		return slot;
	}
	if (item.type === "message") {
		applyMessagePhaseStopReason(item, output);
		const block: TextContent = { type: "text", text: "" };
		output.content.push(block);
		const slot = { type: "text", block, contentIndex: output.content.length - 1 } satisfies ResponsesOutputSlot;
		outputSlots.set(outputIndex, slot);
		stream.push({ type: "text_start", contentIndex: slot.contentIndex, partial: output });
		return slot;
	}
	if (item.type === "function_call") {
		const namespace = "namespace" in item && typeof item.namespace === "string" ? item.namespace : undefined;
		const block: StreamingToolCall = {
			type: "toolCall",
			id: `${item.call_id}|${item.id}`,
			name: item.name,
			arguments: {},
			...(namespace !== undefined ? { namespace } : {}),
			partialJson: item.arguments || "",
		};
		output.content.push(block);
		const slot = {
			type: "toolCall",
			block,
			contentIndex: output.content.length - 1,
		} satisfies ResponsesOutputSlot;
		outputSlots.set(outputIndex, slot);
		stream.push({ type: "toolcall_start", contentIndex: slot.contentIndex, partial: output });
		return slot;
	}
	if (item.type === "custom_tool_call") {
		const namespace = "namespace" in item && typeof item.namespace === "string" ? item.namespace : undefined;
		const inputProperty = options?.grammarToolInputProperties?.get(item.name) ?? "input";
		const input = item.input || "";
		const block: StreamingToolCall = {
			type: "toolCall",
			id: `${item.call_id}|${item.id}`,
			name: item.name,
			arguments: { [inputProperty]: input },
			toolArgsGeneration: 0,
			...(namespace !== undefined ? { namespace } : {}),
			customInput: {
				property: inputProperty,
				jsonBuffer: { input: "", started: false, closed: false },
			},
		};
		output.content.push(block);
		const slot = {
			type: "toolCall",
			block,
			contentIndex: output.content.length - 1,
		} satisfies ResponsesOutputSlot;
		outputSlots.set(outputIndex, slot);
		stream.push({ type: "toolcall_start", contentIndex: slot.contentIndex, partial: output });
		return slot;
	}
	return undefined;
}

function getOrCreateSlot(
	outputIndex: number,
	item: ResponseOutputItem,
	output: AssistantMessage,
	stream: AssistantMessageEventStream,
	outputSlots: Map<number, ResponsesOutputSlot>,
	options?: OpenAIResponsesStreamOptions,
): ResponsesOutputSlot | undefined {
	return outputSlots.get(outputIndex) ?? createSlot(outputIndex, item, output, stream, outputSlots, options);
}

// Azure OpenAI can omit reasoning.encrypted_content from response.output_item.done
// and provide it only in response.completed.response.output. Backfill the
// persisted reasoning signature from the terminal response to keep store:false
// multi-turn replay stateless. See https://github.com/earendil-works/pi/issues/6409.
function backfillReasoningSignatures(
	responseOutput: ResponseOutputItem[],
	reasoningBlocksById: Map<string, ThinkingContent>,
): void {
	for (const item of responseOutput) {
		if (item.type !== "reasoning" || !item.encrypted_content) continue;
		const block = reasoningBlocksById.get(item.id);
		if (!block?.thinkingSignature) continue;

		const storedItem = JSON.parse(block.thinkingSignature) as ResponseReasoningItem;
		if (storedItem.encrypted_content) continue;
		storedItem.encrypted_content = item.encrypted_content;
		block.thinkingSignature = JSON.stringify(storedItem);
	}
}

function finalizeResponse<TApi extends Api>(
	response: Extract<ResponseStreamEvent, { type: "response.completed" | "response.incomplete" }>["response"],
	output: AssistantMessage,
	model: Model<TApi>,
	reasoningBlocksById: Map<string, ThinkingContent>,
	options?: OpenAIResponsesStreamOptions,
): void {
	backfillReasoningSignatures(response.output ?? [], reasoningBlocksById);
	if (response?.id) {
		output.responseId = response.id;
	}
	if (response?.usage) {
		const inputDetails = response.usage.input_tokens_details as
			| { cached_tokens?: number; cache_write_tokens?: number }
			| undefined;
		const cachedTokens = inputDetails?.cached_tokens || 0;
		const cacheWriteTokens = inputDetails?.cache_write_tokens || 0;
		output.usage = {
			// OpenAI includes cached and cache-write tokens in input_tokens, so subtract both.
			input: Math.max(0, (response.usage.input_tokens || 0) - cachedTokens - cacheWriteTokens),
			output: response.usage.output_tokens || 0,
			cacheRead: cachedTokens,
			cacheWrite: cacheWriteTokens,
			reasoning: response.usage.output_tokens_details?.reasoning_tokens || 0,
			totalTokens: response.usage.total_tokens || 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		};
	}
	calculateCost(model, output.usage);
	if (options?.applyServiceTierPricing) {
		const serviceTier = options.resolveServiceTier
			? options.resolveServiceTier(response?.service_tier, options.serviceTier)
			: (response?.service_tier ?? options.serviceTier);
		options.applyServiceTierPricing(output.usage, serviceTier);
	}
	// Map status to stop reason. For incomplete responses, retain the provider's
	// specific reason so max-output truncation and content filtering stay distinct.
	const status = response?.status;
	const incompleteDetails = response?.incomplete_details as { reason?: unknown } | null | undefined;
	const incompleteReason = typeof incompleteDetails?.reason === "string" ? incompleteDetails.reason : undefined;
	output.rawStopReason = incompleteReason ? `${status}.${incompleteReason}` : status;
	const mappedStop = mapStopReason(status, incompleteReason);
	output.stopReason = mappedStop.stopReason;
	output.errorMessage = mappedStop.errorMessage;
	if (output.stopReason === "stop") {
		for (const block of output.content) {
			if (block.type !== "toolCall") continue;
			output.stopReason = "toolUse";
			break;
		}
	}
}

export async function processResponsesStream<TApi extends Api>(
	openaiStream: AsyncIterable<ResponseStreamEvent>,
	output: AssistantMessage,
	stream: AssistantMessageEventStream,
	model: Model<TApi>,
	options?: OpenAIResponsesStreamOptions,
): Promise<void> {
	let sawTerminalResponseEvent = false;
	const outputSlots = new Map<number, ResponsesOutputSlot>();
	const reasoningBlocksById = new Map<string, ThinkingContent>();

	for await (const event of openaiStream) {
		if (event.type === "response.created") {
			output.responseId = event.response.id;
		} else if (event.type === "response.output_item.added") {
			createSlot(event.output_index, event.item, output, stream, outputSlots, options);
		} else if (event.type === "response.reasoning_summary_text.delta") {
			const slot = getSlot(event.output_index, "thinking", outputSlots);
			if (!slot) continue;
			slot.block.thinking += event.delta;
			stream.push({
				type: "thinking_delta",
				contentIndex: slot.contentIndex,
				delta: event.delta,
				partial: output,
			});
		} else if (event.type === "response.reasoning_summary_part.done") {
			const slot = getSlot(event.output_index, "thinking", outputSlots);
			if (!slot) continue;
			slot.block.thinking += "\n\n";
			stream.push({
				type: "thinking_delta",
				contentIndex: slot.contentIndex,
				delta: "\n\n",
				partial: output,
			});
		} else if (event.type === "response.reasoning_text.delta") {
			const slot = getSlot(event.output_index, "thinking", outputSlots);
			if (!slot) continue;
			slot.block.thinking += event.delta;
			stream.push({
				type: "thinking_delta",
				contentIndex: slot.contentIndex,
				delta: event.delta,
				partial: output,
			});
		} else if (event.type === "response.output_text.delta") {
			const slot = getSlot(event.output_index, "text", outputSlots);
			if (!slot) continue;
			slot.block.text += event.delta;
			stream.push({
				type: "text_delta",
				contentIndex: slot.contentIndex,
				delta: event.delta,
				partial: output,
			});
		} else if (event.type === "response.refusal.delta") {
			const slot = getSlot(event.output_index, "text", outputSlots);
			if (!slot) continue;
			slot.block.text += event.delta;
			stream.push({
				type: "text_delta",
				contentIndex: slot.contentIndex,
				delta: event.delta,
				partial: output,
			});
		} else if (event.type === "response.function_call_arguments.delta") {
			const slot = getSlot(event.output_index, "toolCall", outputSlots);
			if (!slot || slot.block.partialJson === undefined) continue;
			slot.block.partialJson += event.delta;
			slot.block.arguments = parseStreamingJson(slot.block.partialJson);
			pushToolCallDelta(slot, event.delta, output, stream);
		} else if (event.type === "response.function_call_arguments.done") {
			const slot = getSlot(event.output_index, "toolCall", outputSlots);
			if (!slot || slot.block.partialJson === undefined) continue;
			const previousPartialJson = slot.block.partialJson;
			slot.block.partialJson = event.arguments;
			slot.block.arguments = parseStreamingJson(slot.block.partialJson);

			if (event.arguments.startsWith(previousPartialJson)) {
				const delta = event.arguments.slice(previousPartialJson.length);
				if (delta.length > 0) pushToolCallDelta(slot, delta, output, stream);
			}
		} else if (event.type === "response.custom_tool_call_input.delta") {
			const slot = getSlot(event.output_index, "toolCall", outputSlots);
			if (!slot || !slot.block.customInput) continue;
			pushToolCallDelta(slot, appendCustomToolCallInput(slot.block, getCustomToolCallInput(slot.block) + event.delta, false), output, stream);
		} else if (event.type === "response.custom_tool_call_input.done") {
			const slot = getSlot(event.output_index, "toolCall", outputSlots);
			if (!slot || !slot.block.customInput) continue;
			pushToolCallDelta(slot, appendCustomToolCallInput(slot.block, event.input, true), output, stream);
		} else if (event.type === "response.output_item.done") {
			const item = event.item;
			applyMessagePhaseStopReason(item, output);
			const slot = getOrCreateSlot(event.output_index, item, output, stream, outputSlots, options);

			if (item.type === "reasoning" && slot?.type === "thinking") {
				const summaryText = joinReasoningText(item.summary);
				const contentText = summaryText ? "" : joinReasoningText(item.content);
				slot.block.thinking = summaryText || contentText || slot.block.thinking;
				slot.block.thinkingSignature = JSON.stringify(item);
				reasoningBlocksById.set(item.id, slot.block);
				stream.push({
					type: "thinking_end",
					contentIndex: slot.contentIndex,
					content: slot.block.thinking,
					partial: output,
				});
				outputSlots.delete(event.output_index);
			} else if (item.type === "message" && slot?.type === "text") {
				let text = "";
				for (const part of item.content ?? []) text += (part.type === "output_text" ? part.text : part.refusal) ?? "";
				slot.block.text = text;
				slot.block.textSignature = encodeTextSignatureV1(item.id, item.phase ?? undefined);
				stream.push({
					type: "text_end",
					contentIndex: slot.contentIndex,
					content: slot.block.text,
					partial: output,
				});
				outputSlots.delete(event.output_index);
			} else if (
				item.type === "function_call" &&
				slot?.type === "toolCall" &&
				slot.block.partialJson !== undefined
			) {
				slot.block.arguments = parseStreamingJson(item.arguments || slot.block.partialJson);
				if ("namespace" in item && typeof item.namespace === "string") slot.block.namespace = item.namespace;
				// Finalize in-place and strip the scratch buffer so replay only
				// carries parsed arguments.
				slot.block.partialJson = undefined;
				stream.push({
					type: "toolcall_end",
					contentIndex: slot.contentIndex,
					toolCall: slot.block,
					partial: output,
				});
				outputSlots.delete(event.output_index);
			} else if (item.type === "custom_tool_call" && slot?.type === "toolCall" && slot.block.customInput) {
				pushToolCallDelta(slot, appendCustomToolCallInput(slot.block, item.input ?? getCustomToolCallInput(slot.block), true), output, stream);
				if ("namespace" in item && typeof item.namespace === "string") slot.block.namespace = item.namespace;
				slot.block.customInput = undefined;
				slot.block.toolArgsGeneration = undefined;
				stream.push({
					type: "toolcall_end",
					contentIndex: slot.contentIndex,
					toolCall: slot.block,
					partial: output,
				});
				outputSlots.delete(event.output_index);
			}
		} else if (event.type === "response.completed" || event.type === "response.incomplete") {
			sawTerminalResponseEvent = true;
			finalizeResponse(event.response, output, model, reasoningBlocksById, options);
		} else if (event.type === "error") {
			throw new Error(`Error Code ${event.code}: ${event.message}` || "Unknown error");
		} else if (event.type === "response.failed") {
			sawTerminalResponseEvent = true;
			output.rawStopReason = event.response?.status;
			const error = event.response?.error;
			const details = event.response?.incomplete_details;
			const msg = error
				? `${error.code || "unknown"}: ${error.message || "no message"}`
				: details?.reason
					? `incomplete: ${details.reason}`
					: "Unknown error (no error details in response)";
			throw new Error(msg);
		}
	}
	if (!sawTerminalResponseEvent) {
		throw new Error("OpenAI Responses stream ended before a terminal response event");
	}
	// The agent executes every tool call in the final message. A call whose output_item.done
	// never arrived still owns its scratch buffer and may carry cut-off or mixed-up arguments
	// (for example when a server omits output_index), so it must not be handed over.
	if (output.stopReason === "toolUse") {
		for (const block of output.content) {
			if (block.type !== "toolCall") continue;
			const toolCall = block as StreamingToolCall;
			if (toolCall.partialJson !== undefined || toolCall.customInput !== undefined) {
				throw new Error(
					`OpenAI Responses stream completed with an unfinished tool call: ${toolCall.name} (${toolCall.id})`,
				);
			}
		}
	}
}

function mapStopReason(
	status: OpenAI.Responses.ResponseStatus | undefined,
	incompleteReason?: string,
): { stopReason: StopReason; errorMessage?: string } {
	if (!status) return { stopReason: "stop" };
	switch (status) {
		case "completed":
			return { stopReason: "stop" };
		case "incomplete":
			if (incompleteReason === "max_output_tokens") {
				return { stopReason: "length" };
			}
			return {
				stopReason: "error",
				errorMessage: incompleteReason
					? `Response incomplete: ${incompleteReason}`
					: "Response incomplete without a provider reason",
			};
		case "failed":
		case "cancelled":
			return { stopReason: "error" };
		// These two are wonky ...
		case "in_progress":
		case "queued":
			return { stopReason: "stop" };
		default: {
			const _exhaustive: never = status;
			throw new Error(`Unhandled stop reason: ${_exhaustive}`);
		}
	}
}
