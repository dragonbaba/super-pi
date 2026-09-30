import type {
	Api,
	AssistantMessage,
	ImageContent,
	Message,
	Model,
	TextContent,
	ToolCall,
	ToolResultMessage,
} from "../types.ts";
import { getModelCapabilities } from "../model-capabilities.ts";

const NON_VISION_USER_IMAGE_PLACEHOLDER = "(image omitted: model does not support images)";
const NON_VISION_TOOL_IMAGE_PLACEHOLDER = "(tool image omitted: model does not support images)";

function replaceImagesWithPlaceholder(content: (TextContent | ImageContent)[], placeholder: string): TextContent[] {
	const result: TextContent[] = [];
	let previousWasPlaceholder = false;

	for (const block of content) {
		if (block.type === "image") {
			if (!previousWasPlaceholder) {
				result.push({ type: "text", text: placeholder });
			}
			previousWasPlaceholder = true;
			continue;
		}

		result.push(block);
		previousWasPlaceholder = block.text === placeholder;
	}

	return result;
}

type NormalizeToolCallId<TApi extends Api> = (id: string, model: Model<TApi>, source: AssistantMessage) => string;

function transformContentBlock<TApi extends Api>(block: AssistantMessage["content"][number], isSameModel: boolean, replaySignatures: boolean, model: Model<TApi>, normalizeToolCallId: NormalizeToolCallId<TApi> | undefined, assistantMsg: AssistantMessage, toolCallIdMap: Map<string, string>): AssistantMessage["content"][number] | undefined {
	if (block.type === "thinking") {
		// Redacted thinking is opaque encrypted content, only valid for the same model.
		// Drop it for cross-model to avoid API errors.
		if (block.redacted) {
			return replaySignatures ? block : undefined;
		}
		// For same model: keep thinking blocks with signatures (needed for replay)
		// even if the thinking text is empty (OpenAI encrypted reasoning)
		if (replaySignatures && block.thinkingSignature) return block;
		// Skip empty thinking blocks, convert others to plain text
		if (!block.thinking || block.thinking.trim() === "") return undefined;
		if (isSameModel) return { ...block, thinkingSignature: undefined };
		return {
			type: "text" as const,
			text: block.thinking,
		};
	}

	if (block.type === "text") {
		// Responses text signatures carry item identity/phase, independently of
		// opaque thought signatures. Preserve them for same-model replay so a
		// one-message response commitment and its full-history replay have the same id.
		if (isSameModel) return replaySignatures || model.api === "openai-responses" ||
			model.api === "openai-codex-responses" || model.api === "azure-openai-responses"
			? block : { ...block, textSignature: undefined };
		return {
			type: "text" as const,
			text: block.text,
		};
	}

	if (block.type === "toolCall") {
		const toolCall = block as ToolCall;
		let normalizedToolCall: ToolCall = toolCall;

		if (!replaySignatures && toolCall.thoughtSignature) {
			normalizedToolCall = { ...toolCall, thoughtSignature: undefined };
		}

		if (!isSameModel && normalizeToolCallId) {
			const normalizedId = normalizeToolCallId(toolCall.id, model, assistantMsg);
			if (normalizedId !== toolCall.id) {
				toolCallIdMap.set(toolCall.id, normalizedId);
				normalizedToolCall = { ...normalizedToolCall, id: normalizedId };
			}
		}

		return normalizedToolCall;
	}

	return block;
}

function transformMessage<TApi extends Api>(msg: Message, model: Model<TApi>, signatureRoundTrip: boolean, normalizeToolCallId: NormalizeToolCallId<TApi> | undefined, toolCallIdMap: Map<string, string>): Message {
	// User messages pass through unchanged
	if (msg.role === "user") {
		return msg;
	}

	// Handle toolResult messages - normalize toolCallId if we have a mapping
	if (msg.role === "toolResult") {
		const normalizedId = toolCallIdMap.get(msg.toolCallId);
		if (normalizedId && normalizedId !== msg.toolCallId) {
			return { ...msg, toolCallId: normalizedId };
		}
		return msg;
	}

	// Assistant messages need transformation check
	if (msg.role === "assistant") {
		const assistantMsg = msg as AssistantMessage;
		const isSameModel =
			assistantMsg.provider === model.provider &&
			assistantMsg.api === model.api &&
			assistantMsg.model === model.id;
		const replaySignatures = isSameModel && signatureRoundTrip;

		const transformedContent: AssistantMessage["content"] = [];
		for (const block of assistantMsg.content) {
			const transformedBlock = transformContentBlock(block, isSameModel, replaySignatures, model, normalizeToolCallId, assistantMsg, toolCallIdMap);
			if (transformedBlock !== undefined) transformedContent.push(transformedBlock);
		}

		return {
			...assistantMsg,
			content: transformedContent,
		};
	}
	return msg;
}

function insertSyntheticToolResults(pendingToolCalls: ToolCall[], existingToolResultIds: Set<string>, result: Message[]): void {
	if (pendingToolCalls.length > 0) {
		for (const tc of pendingToolCalls) {
			if (!existingToolResultIds.has(tc.id)) {
				result.push({
					role: "toolResult",
					toolCallId: tc.id,
					toolName: tc.name,
					content: [{ type: "text", text: "No result provided" }],
					isError: true,
					timestamp: Date.now(),
				} as ToolResultMessage);
			}
		}
		pendingToolCalls.length = 0;
		existingToolResultIds.clear();
	}
}

/**
 * Normalize tool call ID for cross-provider compatibility.
 * OpenAI Responses API generates IDs that are 450+ chars with special characters like `|`.
 * Anthropic APIs require IDs matching ^[a-zA-Z0-9_-]+$ (max 64 chars).
 */
export function transformMessages<TApi extends Api>(
	messages: Message[],
	model: Model<TApi>,
	normalizeToolCallId?: (id: string, model: Model<TApi>, source: AssistantMessage) => string,
): Message[] {
	const signatureRoundTrip = getModelCapabilities(model).thoughtSignatureRoundTrip;
	// Build a map of original tool call IDs to normalized IDs
	const toolCallIdMap = new Map<string, string>();
	// Normalize null/undefined content from untyped callers (custom tools, hand-built
	// histories, old session files) so downstream code can rely on the type contract.
	const transformed: Message[] = [];
	const supportsImages = model.input.includes("image");
	for (const original of messages) {
		let msg = original.content == null ? { ...original, content: [] } as Message : original;
		if (!supportsImages) {
			if (msg.role === "user" && Array.isArray(msg.content)) msg = { ...msg, content: replaceImagesWithPlaceholder(msg.content, NON_VISION_USER_IMAGE_PLACEHOLDER) };
			else if (msg.role === "toolResult") msg = { ...msg, content: replaceImagesWithPlaceholder(msg.content, NON_VISION_TOOL_IMAGE_PLACEHOLDER) };
		}
		transformed.push(transformMessage(msg, model, signatureRoundTrip, normalizeToolCallId, toolCallIdMap));
	}

	// Second pass: insert synthetic empty tool results for orphaned tool calls
	// This preserves thinking signatures and satisfies API requirements
	const result: Message[] = [];
	const pendingToolCalls: ToolCall[] = [];
	const existingToolResultIds = new Set<string>();

	for (let i = 0; i < transformed.length; i++) {
		const msg = transformed[i];

		if (msg.role === "assistant") {
			// If we have pending orphaned tool calls from a previous assistant, insert synthetic results now
			insertSyntheticToolResults(pendingToolCalls, existingToolResultIds, result);

			// Skip errored/aborted assistant messages entirely.
			// These are incomplete turns that shouldn't be replayed:
			// - May have partial content (reasoning without message, incomplete tool calls)
			// - Replaying them can cause API errors (e.g., OpenAI "reasoning without following item")
			// - The model should retry from the last valid state
			const assistantMsg = msg as AssistantMessage;
			if (assistantMsg.stopReason === "error" || assistantMsg.stopReason === "aborted") {
				continue;
			}

			// Track tool calls from this assistant message
			for (const block of assistantMsg.content) if (block.type === "toolCall") pendingToolCalls.push(block);
			if (pendingToolCalls.length > 0) existingToolResultIds.clear();

			result.push(msg);
		} else if (msg.role === "toolResult") {
			existingToolResultIds.add(msg.toolCallId);
			result.push(msg);
		} else if (msg.role === "user") {
			// User message interrupts tool flow - insert synthetic results for orphaned calls
			insertSyntheticToolResults(pendingToolCalls, existingToolResultIds, result);
			result.push(msg);
		} else {
			result.push(msg);
		}
	}

	// If the conversation ends with unresolved tool calls, synthesize results now.
	insertSyntheticToolResults(pendingToolCalls, existingToolResultIds, result);

	return result;
}
