import { calculateCost, clampThinkingLevel } from "../models.ts";
import type {
	AssistantMessage,
	Context,
	Message,
	Model,
	SimpleStreamOptions,
	StopReason,
	StreamFunction,
	StreamOptions,
	TextContent,
	ThinkingContent,
	Tool,
	ToolCall,
} from "../types.ts";
import { AssistantMessageEventStream } from "../utils/event-stream.ts";
import { shortHash } from "../utils/hash.ts";
import { headersToRecord } from "../utils/headers.ts";
import { parseStreamingJson } from "../utils/json-parse.ts";
import { getPiUserAgent } from "../utils/pi-user-agent.ts";
import { sanitizeSurrogates } from "../utils/sanitize-unicode.ts";
import { getJsonSchemaToolParameters, resolveJsonSchemaStrictSampling } from "./constrained-sampling.ts";
import { buildBaseOptions } from "./simple-options.ts";
import { transformMessages } from "./transform-messages.ts";

const MISTRAL_TOOL_CALL_ID_LENGTH = 9;
const MAX_MISTRAL_ERROR_BODY_CHARS = 4000;
const MAX_MISTRAL_ERROR_BODY_BYTES = 16 * 1024;
const MAX_MISTRAL_STREAM_CHUNK_BYTES = 1024 * 1024;
const MAX_MISTRAL_EVENT_CHARS = 1024 * 1024;
const MISTRAL_EVENT_BOUNDARY_OVERLAP = 3;

/**
 * Provider-specific options for the Mistral API.
 */
type MistralReasoningEffort = "none" | "high";

export interface MistralOptions extends StreamOptions {
	toolChoice?: "auto" | "none" | "any" | "required" | { type: "function"; function: { name: string } };
	promptMode?: "reasoning";
	reasoningEffort?: MistralReasoningEffort;
}

type MistralContentChunk =
	| { type: "text"; text: string }
	| { type: "image_url"; imageUrl: string }
	| { type: "thinking"; thinking: Array<{ type: "text"; text: string }> };

type MistralRequestToolCall = {
	id: string;
	type: "function";
	function: { name: string; arguments: string };
	index: number;
};

type MistralChatMessage = {
	role: "system" | "user" | "assistant" | "tool";
	content?: string | MistralContentChunk[];
	toolCalls?: MistralRequestToolCall[];
	toolCallId?: string;
	name?: string;
	prefix?: boolean;
};

type MistralFunctionTool = {
	type: "function";
	function: {
		name: string;
		description: string;
		parameters: Record<string, unknown>;
		strict: boolean;
	};
};

type MistralChatPayload = {
	[key: string]: unknown;
	model: string;
	stream: boolean;
	messages: MistralChatMessage[];
	tools?: MistralFunctionTool[];
	temperature?: number;
	maxTokens?: number;
	toolChoice?: Exclude<MistralOptions["toolChoice"], undefined>;
	promptMode?: "reasoning";
	reasoningEffort?: MistralReasoningEffort;
	promptCacheKey?: string;
};

type MistralStreamContentChunk = {
	type: string;
	text?: string;
	thinking?: Array<{ text?: string }>;
};

type MistralStreamToolCall = {
	id?: string;
	index?: number;
	function: {
		name?: string;
		arguments?: string | Record<string, unknown>;
	};
};

type MistralCompletionEvent = {
	data: {
		id?: string;
		usage?: {
			[key: string]: unknown;
			prompt_tokens?: number;
			completion_tokens?: number;
			total_tokens?: number;
		};
		choices: Array<{
			finish_reason?: string | null;
			delta: {
				content?: string | MistralStreamContentChunk[] | null;
				tool_calls?: MistralStreamToolCall[] | null;
			};
		}>;
	};
};

const MISTRAL_PAYLOAD_PROPERTY_MAPPINGS = [
	["topP", "top_p"],
	["maxTokens", "max_tokens"],
	["randomSeed", "random_seed"],
	["responseFormat", "response_format"],
	["toolChoice", "tool_choice"],
	["presencePenalty", "presence_penalty"],
	["frequencyPenalty", "frequency_penalty"],
	["parallelToolCalls", "parallel_tool_calls"],
	["reasoningEffort", "reasoning_effort"],
	["promptMode", "prompt_mode"],
	["promptCacheKey", "prompt_cache_key"],
	["safePrompt", "safe_prompt"],
] as const;

const MISTRAL_CONTENT_PROPERTY_MAPPINGS = [
	["imageUrl", "image_url"],
	["documentUrl", "document_url"],
	["documentName", "document_name"],
	["fileId", "file_id"],
	["referenceIds", "reference_ids"],
	["inputAudio", "input_audio"],
] as const;

/**
 * Stream responses from the native Mistral Chat Completions endpoint.
 */
export const stream: StreamFunction<"mistral-conversations", MistralOptions> = (
	model: Model<"mistral-conversations">,
	context: Context,
	options?: MistralOptions,
): AssistantMessageEventStream => {
	const stream = new AssistantMessageEventStream();

	(async () => {
		const output = createOutput(model);

		try {
			const apiKey = options?.apiKey;
			if (!apiKey) {
				throw new Error(`No API key for provider: ${model.provider}`);
			}

			const normalizeMistralToolCallId = createMistralToolCallIdNormalizer();
			const transformedMessages = transformMessages(context.messages, model, (id) => normalizeMistralToolCallId(id));

			let payload = buildChatPayload(model, context, transformedMessages, options);
			const nextPayload = await options?.onPayload?.(payload, model);
			if (nextPayload !== undefined) {
				payload = nextPayload as MistralChatPayload;
			}
			const mistralStream = await requestMistralStream(model, payload, apiKey, options);
			stream.push({ type: "start", partial: output });
			await consumeChatStream(model, output, stream, mistralStream);

			if (options?.signal?.aborted) {
				throw new Error("Request was aborted");
			}

			if (output.stopReason === "pending") {
				throw new Error("Mistral stream ended without a finish reason");
			}
			if (output.stopReason === "aborted" || output.stopReason === "error") {
				throw new Error(output.errorMessage || "An unknown error occurred");
			}

			stream.push({ type: "done", reason: output.stopReason, message: output });
			stream.end();
		} catch (error) {
			for (const block of output.content) {
				// partialArgs is only a streaming scratch buffer; never persist it.
				if (block.type === "toolCall" && "partialArgs" in block) {
					(block as ToolCall & { partialArgs?: string }).partialArgs = undefined;
				}
			}
			output.stopReason = options?.signal?.aborted ? "aborted" : "error";
			output.errorMessage = formatMistralError(error);
			stream.push({ type: "error", reason: output.stopReason, error: output });
			stream.end();
		}
	})();

	return stream;
};

/**
 * Maps provider-agnostic `SimpleStreamOptions` to Mistral options.
 */
export const streamSimple: StreamFunction<"mistral-conversations", SimpleStreamOptions> = (
	model: Model<"mistral-conversations">,
	context: Context,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream => {
	const apiKey = options?.apiKey;
	if (!apiKey) {
		throw new Error(`No API key for provider: ${model.provider}`);
	}

	const base = {
		...buildBaseOptions(model, context, options, apiKey),
		toolChoice: options?.toolChoice,
	} satisfies MistralOptions;
	const clampedReasoning = options?.reasoning ? clampThinkingLevel(model, options.reasoning) : undefined;
	const reasoning = clampedReasoning === "off" ? undefined : clampedReasoning;
	const shouldUseReasoning = model.reasoning && reasoning !== undefined;

	return stream(model, context, {
		...base,
		promptMode: shouldUseReasoning && usesPromptModeReasoning(model) ? "reasoning" : undefined,
		reasoningEffort:
			shouldUseReasoning && usesReasoningEffort(model) ? mapReasoningEffort(model, reasoning) : undefined,
	} satisfies MistralOptions);
};

function createOutput(model: Model<"mistral-conversations">): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: model.api,
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
}

function createMistralToolCallIdNormalizer(): (id: string) => string {
	const idMap = new Map<string, string>();
	const reverseMap = new Map<string, string>();

	return (id: string): string => {
		const existing = idMap.get(id);
		if (existing) return existing;

		let attempt = 0;
		while (true) {
			const candidate = deriveMistralToolCallId(id, attempt);
			const owner = reverseMap.get(candidate);
			if (!owner || owner === id) {
				idMap.set(id, candidate);
				reverseMap.set(candidate, id);
				return candidate;
			}
			attempt++;
		}
	};
}

function deriveMistralToolCallId(id: string, attempt: number): string {
	const normalized = keepAsciiAlphanumeric(id);
	if (attempt === 0 && normalized.length === MISTRAL_TOOL_CALL_ID_LENGTH) return normalized;
	const seedBase = normalized || id;
	const seed = attempt === 0 ? seedBase : `${seedBase}:${attempt}`;
	return shortHash(seed).slice(0, MISTRAL_TOOL_CALL_ID_LENGTH);
}

function keepAsciiAlphanumeric(value: string): string {
	let firstInvalid = -1;
	for (let index = 0; index < value.length; index++) {
		const code = value.charCodeAt(index);
		if ((code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122)) continue;
		firstInvalid = index;
		break;
	}
	if (firstInvalid < 0) return value;

	let result = value.slice(0, firstInvalid);
	for (let index = firstInvalid + 1; index < value.length; index++) {
		const code = value.charCodeAt(index);
		if ((code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122)) {
			result += value[index];
		}
	}
	return result;
}

function formatMistralError(error: unknown): string {
	if (error instanceof Error) {
		const httpError = error as Error & { statusCode?: unknown; body?: unknown };
		const statusCode = typeof httpError.statusCode === "number" ? httpError.statusCode : undefined;
		const bodyText = typeof httpError.body === "string" ? httpError.body.trim() : undefined;
		if (statusCode !== undefined && bodyText) {
			return `Mistral API error (${statusCode}): ${truncateErrorText(bodyText, MAX_MISTRAL_ERROR_BODY_CHARS)}`;
		}
		if (statusCode !== undefined) return `Mistral API error (${statusCode}): ${error.message}`;
		return error.message;
	}
	return safeJsonStringify(error);
}

function truncateErrorText(text: string, maxChars: number): string {
	if (text.length <= maxChars) return text;
	return `${text.slice(0, maxChars)}... [truncated ${text.length - maxChars} chars]`;
}

function safeJsonStringify(value: unknown): string {
	try {
		const serialized = JSON.stringify(value);
		return serialized === undefined ? String(value) : serialized;
	} catch {
		return String(value);
	}
}

async function requestMistralStream(
	model: Model<"mistral-conversations">,
	payload: MistralChatPayload,
	apiKey: string,
	options?: MistralOptions,
): Promise<AsyncIterable<MistralCompletionEvent>> {
	const baseUrl = new URL(model.baseUrl);
	let pathnameEnd = baseUrl.pathname.length;
	while (pathnameEnd > 0 && baseUrl.pathname.charCodeAt(pathnameEnd - 1) === 0x2f) pathnameEnd--;
	baseUrl.pathname = `${baseUrl.pathname.slice(0, pathnameEnd)}/`;
	const url = new URL("v1/chat/completions", baseUrl);
	const headers = buildMistralHeaders(model, apiKey, options);
	const timeoutSignal = AbortSignal.timeout(options?.timeoutMs ?? 60_000);
	const signal = options?.signal ? AbortSignal.any([options.signal, timeoutSignal]) : timeoutSignal;
	const response = await (options?.fetch ?? globalThis.fetch)(url, {
		method: "POST",
		headers,
		body: JSON.stringify(toMistralWirePayload(payload)),
		signal,
	});

	await options?.onResponse?.({ status: response.status, headers: headersToRecord(response.headers) }, model);

	if (!response.ok) {
		const body = await readBoundedMistralErrorBody(response);
		throw new MistralHttpError(response.status, body, response.statusText);
	}
	if (!response.body) {
		throw new Error("Mistral response has no body");
	}

	return readMistralEvents(response.body, signal);
}

async function readBoundedMistralErrorBody(response: Response): Promise<string> {
	if (!response.body) return "";
	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	const parts: string[] = [];
	let bytesRead = 0;
	let truncated = false;
	try {
		while (bytesRead < MAX_MISTRAL_ERROR_BODY_BYTES) {
			const { done, value } = await reader.read();
			if (done) {
				const tail = decoder.decode();
				if (tail) parts.push(tail);
				break;
			}
			const remaining = MAX_MISTRAL_ERROR_BODY_BYTES - bytesRead;
			const acceptedBytes = value.byteLength > remaining ? remaining : value.byteLength;
			if (acceptedBytes > 0) {
				parts.push(decoder.decode(value.subarray(0, acceptedBytes), { stream: acceptedBytes === value.byteLength }));
				bytesRead += acceptedBytes;
			}
			if (acceptedBytes < value.byteLength) {
				truncated = true;
				break;
			}
		}
		if (bytesRead >= MAX_MISTRAL_ERROR_BODY_BYTES) truncated = true;
	} finally {
		try {
			await reader.cancel();
		} catch {}
		try {
			reader.releaseLock();
		} catch {}
	}
	const text = parts.join("");
	return truncated ? `${text}\n[response body truncated]` : text;
}

class MistralHttpError extends Error {
	statusCode: number;
	body: string;

	constructor(statusCode: number, body: string, statusText: string) {
		super(statusText || `Request failed with status ${statusCode}`);
		this.name = "MistralHttpError";
		this.statusCode = statusCode;
		this.body = body;
	}
}

function buildMistralHeaders(model: Model<"mistral-conversations">, apiKey: string, options?: MistralOptions): Headers {
	const headers = new Headers({
		"User-Agent": getPiUserAgent(),
		accept: "text/event-stream",
		authorization: `Bearer ${apiKey}`,
		"content-type": "application/json",
	});
	applyMistralHeaderOverrides(headers, model.headers);
	applyMistralHeaderOverrides(headers, options?.headers);

	const hasExplicitAffinity =
		hasMistralHeaderOverride(model.headers, "x-affinity") || hasMistralHeaderOverride(options?.headers, "x-affinity");
	if (shouldUsePromptCaching(options) && !hasExplicitAffinity) {
		headers.set("x-affinity", options.sessionId);
	}

	return headers;
}

function applyMistralHeaderOverrides(headers: Headers, overrides?: Record<string, string | null>): void {
	if (!overrides) return;
	const names = Object.keys(overrides);
	for (let index = 0; index < names.length; index++) {
		const name = names[index]!;
		const value = overrides[name];
		if (value === null) headers.delete(name);
		else if (value !== undefined) headers.set(name, value);
	}
}

function hasMistralHeaderOverride(overrides: Record<string, string | null> | undefined, target: string): boolean {
	if (!overrides) return false;
	const names = Object.keys(overrides);
	for (let index = 0; index < names.length; index++) {
		if (names[index]!.toLowerCase() === target) return true;
	}
	return false;
}

function toMistralWirePayload(payload: MistralChatPayload): Record<string, unknown> {
	const wirePayload: Record<string, unknown> = { ...payload };
	for (const [source, target] of MISTRAL_PAYLOAD_PROPERTY_MAPPINGS) {
		remapMistralProperty(wirePayload, source, target);
	}
	const wireMessages = new Array<Record<string, unknown>>(payload.messages.length);
	for (let index = 0; index < payload.messages.length; index++) {
		wireMessages[index] = toMistralWireMessage(payload.messages[index]!);
	}
	wirePayload.messages = wireMessages;

	const responseFormat = wirePayload.response_format;
	if (isMistralRecord(responseFormat)) {
		const wireResponseFormat = { ...responseFormat };
		remapMistralProperty(wireResponseFormat, "jsonSchema", "json_schema");
		const jsonSchema = wireResponseFormat.json_schema;
		if (isMistralRecord(jsonSchema)) {
			const wireJsonSchema = { ...jsonSchema };
			remapMistralProperty(wireJsonSchema, "schemaDefinition", "schema");
			wireResponseFormat.json_schema = wireJsonSchema;
		}
		wirePayload.response_format = wireResponseFormat;
	}

	return wirePayload;
}

function toMistralWireMessage(message: MistralChatMessage): Record<string, unknown> {
	const wireMessage: Record<string, unknown> = { ...message };
	remapMistralProperty(wireMessage, "toolCalls", "tool_calls");
	remapMistralProperty(wireMessage, "toolCallId", "tool_call_id");
	if (Array.isArray(message.content)) {
		const wireContent = new Array<Record<string, unknown>>(message.content.length);
		for (let index = 0; index < message.content.length; index++) {
			wireContent[index] = toMistralWireContentChunk(message.content[index]!);
		}
		wireMessage.content = wireContent;
	}
	return wireMessage;
}

function toMistralWireContentChunk(chunk: MistralContentChunk): Record<string, unknown> {
	const wireChunk: Record<string, unknown> = { ...chunk };
	for (const [source, target] of MISTRAL_CONTENT_PROPERTY_MAPPINGS) {
		remapMistralProperty(wireChunk, source, target);
	}
	return wireChunk;
}

function remapMistralProperty(record: Record<string, unknown>, source: string, target: string): void {
	if (!Object.hasOwn(record, source)) return;
	record[target] = record[source];
	record[source] = undefined;
}

function isMistralRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

const MISTRAL_STREAM_DONE = Symbol("mistral-stream-done");

interface MistralEventBoundary {
	start: number;
	end: number;
}

function ignoreMistralReaderCancellation(): void {}

async function* readMistralEvents(
	body: ReadableStream<Uint8Array>,
	signal: AbortSignal,
): AsyncGenerator<MistralCompletionEvent> {
	const reader = body.getReader();
	const decoder = new TextDecoder();
	const boundary: MistralEventBoundary = { start: 0, end: 0 };
	let buffer = "";
	let scanFrom = 0;
	const onAbort = () => {
		void reader.cancel().catch(ignoreMistralReaderCancellation);
	};
	signal.addEventListener("abort", onAbort, { once: true });

	try {
		while (true) {
			if (signal.aborted) throw signal.reason;
			const { done, value } = await reader.read();
			if (signal.aborted) throw signal.reason;
			if (value && value.byteLength > MAX_MISTRAL_STREAM_CHUNK_BYTES) {
				throw new Error(`Mistral stream chunk exceeded ${MAX_MISTRAL_STREAM_CHUNK_BYTES} bytes`);
			}
			buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });

			let consumed = 0;
			while (findMistralEventBoundary(buffer, scanFrom, boundary)) {
				if (boundary.start - consumed > MAX_MISTRAL_EVENT_CHARS) {
					throw new Error(`Mistral streaming event exceeded ${MAX_MISTRAL_EVENT_CHARS} characters`);
				}
				const event = parseMistralEvent(buffer, consumed, boundary.start);
				consumed = boundary.end;
				scanFrom = consumed;
				if (event === MISTRAL_STREAM_DONE) return;
				if (event) yield event;
			}
			if (consumed > 0) buffer = buffer.slice(consumed);
			scanFrom = Math.max(0, buffer.length - MISTRAL_EVENT_BOUNDARY_OVERLAP);
			if (buffer.length > MAX_MISTRAL_EVENT_CHARS) {
				throw new Error(`Mistral streaming event exceeded ${MAX_MISTRAL_EVENT_CHARS} characters`);
			}

			if (done) break;
		}

	if (buffer.trim()) {
			const event = parseMistralEvent(buffer);
			if (event !== MISTRAL_STREAM_DONE && event) yield event;
		}
	} finally {
		signal.removeEventListener("abort", onAbort);
		try {
			await reader.cancel();
		} catch {}
		try {
			reader.releaseLock();
		} catch {}
	}
}

function findMistralEventBoundary(buffer: string, fromIndex: number, boundary: MistralEventBoundary): boolean {
	for (let index = fromIndex; index < buffer.length; ) {
		const first = buffer.charCodeAt(index);
		if (first !== 0x0a && first !== 0x0d) {
			index++;
			continue;
		}

		let secondStart = index + 1;
		if (first === 0x0d && buffer.charCodeAt(secondStart) === 0x0a) secondStart++;
		const second = buffer.charCodeAt(secondStart);
		if (second !== 0x0a && second !== 0x0d) {
			index = secondStart;
			continue;
		}

		let end = secondStart + 1;
		if (second === 0x0d && buffer.charCodeAt(end) === 0x0a) end++;
		boundary.start = index;
		boundary.end = end;
		return true;
	}
	return false;
}

function parseMistralEvent(
	raw: string,
	start = 0,
	end = raw.length,
): MistralCompletionEvent | typeof MISTRAL_STREAM_DONE | undefined {
	let data = "";
	let additionalDataLines: string[] | undefined;
	let hasDataLine = false;
	let lineStart = start;
	while (lineStart < end) {
		let lineEnd = lineStart;
		while (lineEnd < end) {
			const code = raw.charCodeAt(lineEnd);
			if (code === 0x0a || code === 0x0d) break;
			lineEnd++;
		}

		if (raw.startsWith("data:", lineStart)) {
			const value = raw.slice(lineStart + 5, lineEnd).trimStart();
			if (hasDataLine) {
				additionalDataLines ??= [data];
				additionalDataLines.push(value);
			} else {
				data = value;
			}
			hasDataLine = true;
		}

		if (lineEnd >= end) break;
		lineStart = lineEnd + 1;
		if (raw.charCodeAt(lineEnd) === 0x0d && raw.charCodeAt(lineStart) === 0x0a) lineStart++;
	}
	if (additionalDataLines) data = additionalDataLines.join("\n");
	data = data.trim();
	if (!data) return undefined;
	if (data === "[DONE]") return MISTRAL_STREAM_DONE;

	const parsed: unknown = JSON.parse(data);
	if (!isMistralRecord(parsed) || !Array.isArray(parsed.choices)) {
		throw new Error("Invalid Mistral streaming event");
	}
	return { data: parsed as MistralCompletionEvent["data"] };
}

function buildChatPayload(
	model: Model<"mistral-conversations">,
	context: Context,
	messages: Message[],
	options?: MistralOptions,
): MistralChatPayload {
	const payload: MistralChatPayload = {
		model: model.id,
		stream: true,
		messages: toChatMessages(messages, model.input.includes("image")),
	};

	if (context.tools?.length) payload.tools = toFunctionTools(context.tools);
	if (options?.temperature !== undefined) payload.temperature = options.temperature;
	if (options?.maxTokens !== undefined) payload.maxTokens = options.maxTokens;
	if (options?.toolChoice) payload.toolChoice = mapToolChoice(options.toolChoice);
	if (options?.promptMode) payload.promptMode = options.promptMode;
	if (options?.reasoningEffort) payload.reasoningEffort = options.reasoningEffort;
	if (shouldUsePromptCaching(options)) payload.promptCacheKey = options.sessionId;

	if (context.systemPrompt) {
		payload.messages.unshift({
			role: "system",
			content: sanitizeSurrogates(context.systemPrompt),
		});
	}

	return payload;
}

function shouldUsePromptCaching(options?: MistralOptions): options is MistralOptions & { sessionId: string } {
	return options?.cacheRetention !== "none" && !!options?.sessionId;
}

function getMistralCachedPromptTokens(usage: unknown, promptTokens: number): number {
	const rawUsage = usage as {
		promptTokensDetails?: { cachedTokens?: unknown } | null;
		prompt_tokens_details?: { cached_tokens?: unknown } | null;
		promptTokenDetails?: { cachedTokens?: unknown } | null;
		prompt_token_details?: { cached_tokens?: unknown } | null;
		numCachedTokens?: unknown;
		num_cached_tokens?: unknown;
	};
	const rawCachedTokens =
		rawUsage.promptTokensDetails?.cachedTokens ??
		rawUsage.prompt_tokens_details?.cached_tokens ??
		rawUsage.promptTokenDetails?.cachedTokens ??
		rawUsage.prompt_token_details?.cached_tokens ??
		rawUsage.numCachedTokens ??
		rawUsage.num_cached_tokens ??
		0;
	const cachedTokens = typeof rawCachedTokens === "number" && Number.isFinite(rawCachedTokens) ? rawCachedTokens : 0;
	return Math.min(promptTokens, Math.max(0, cachedTokens));
}

function finishMistralContentBlock(
	block: TextContent | ThinkingContent | null | undefined,
	output: AssistantMessage,
	stream: AssistantMessageEventStream,
): void {
	if (!block) return;
	const contentIndex = output.content.length - 1;
	if (block.type === "text") {
		stream.push({ type: "text_end", contentIndex, content: block.text, partial: output });
	} else {
		stream.push({ type: "thinking_end", contentIndex, content: block.thinking, partial: output });
	}
}

function appendMistralTextDelta(
	text: string,
	currentBlock: TextContent | ThinkingContent | null,
	output: AssistantMessage,
	stream: AssistantMessageEventStream,
): TextContent {
	const textDelta = sanitizeSurrogates(text);
	let textBlock: TextContent;
	if (currentBlock?.type === "text") {
		textBlock = currentBlock;
	} else {
		finishMistralContentBlock(currentBlock, output, stream);
		textBlock = { type: "text", text: "" };
		output.content.push(textBlock);
		stream.push({ type: "text_start", contentIndex: output.content.length - 1, partial: output });
	}
	textBlock.text += textDelta;
	stream.push({
		type: "text_delta",
		contentIndex: output.content.length - 1,
		delta: textDelta,
		partial: output,
	});
	return textBlock;
}

async function consumeChatStream(
	model: Model<"mistral-conversations">,
	output: AssistantMessage,
	stream: AssistantMessageEventStream,
	mistralStream: AsyncIterable<MistralCompletionEvent>,
): Promise<void> {
	let currentBlock: TextContent | ThinkingContent | null = null;
	const toolBlocksByKey = new Map<number, number>();

	for await (const event of mistralStream) {
		const chunk = event.data;
		// Mistral's streamed CompletionChunk carries an id field. Keep the first non-empty one,
		// mirroring how OpenAI-style streaming exposes a stable response identifier per stream.
		output.responseId ||= chunk.id;

		if (chunk.usage) {
			const promptTokens = chunk.usage.prompt_tokens || 0;
			const cachedPromptTokens = getMistralCachedPromptTokens(chunk.usage, promptTokens);

			output.usage.input = Math.max(0, promptTokens - cachedPromptTokens);
			output.usage.output = chunk.usage.completion_tokens || 0;
			output.usage.cacheRead = cachedPromptTokens;
			output.usage.cacheWrite = 0;
			output.usage.totalTokens =
				chunk.usage.total_tokens ||
				output.usage.input + output.usage.output + output.usage.cacheRead + output.usage.cacheWrite;
			calculateCost(model, output.usage);
		}

		const choice = chunk.choices[0];
		if (!choice) continue;

		if (choice.finish_reason) {
			output.rawStopReason = choice.finish_reason;
			const stopReasonResult = mapChatStopReason(choice.finish_reason);
			output.stopReason = stopReasonResult.stopReason;
			if (stopReasonResult.errorMessage) {
				output.errorMessage = stopReasonResult.errorMessage;
			}
		}

		const delta = choice.delta;
		if (delta.content !== null && delta.content !== undefined) {
			if (typeof delta.content === "string") {
				currentBlock = appendMistralTextDelta(delta.content, currentBlock, output, stream);
			} else {
				for (const item of delta.content) {
					if (typeof item === "string") {
						currentBlock = appendMistralTextDelta(item, currentBlock, output, stream);
						continue;
					}

					if (item.type === "thinking") {
						let deltaText = "";
						if (item.thinking) {
							for (const part of item.thinking) {
								if (part.text) deltaText += part.text;
							}
						}
						const thinkingDelta = sanitizeSurrogates(deltaText);
						if (!thinkingDelta) continue;
						if (!currentBlock || currentBlock.type !== "thinking") {
							finishMistralContentBlock(currentBlock, output, stream);
							currentBlock = { type: "thinking", thinking: "" };
							output.content.push(currentBlock);
							stream.push({ type: "thinking_start", contentIndex: output.content.length - 1, partial: output });
						}
						currentBlock.thinking += thinkingDelta;
						stream.push({
							type: "thinking_delta",
							contentIndex: output.content.length - 1,
							delta: thinkingDelta,
							partial: output,
						});
						continue;
					}

					if (item.type === "text") {
						currentBlock = appendMistralTextDelta(item.text ?? "", currentBlock, output, stream);
					}
				}
			}
		}

		if (delta.tool_calls) {
			for (let chunkToolIndex = 0; chunkToolIndex < delta.tool_calls.length; chunkToolIndex++) {
				const toolCall = delta.tool_calls[chunkToolIndex]!;
				if (currentBlock) {
					finishMistralContentBlock(currentBlock, output, stream);
					currentBlock = null;
				}
				const toolIndex = toolCall.index ?? chunkToolIndex;
				const existingIndex = toolBlocksByKey.get(toolIndex);
				let contentIndex = existingIndex;
				let block: (ToolCall & { partialArgs?: string }) | undefined;

				if (existingIndex !== undefined) {
					const existing = output.content[existingIndex];
					if (existing?.type === "toolCall") {
						block = existing as ToolCall & { partialArgs?: string };
						if (toolCall.id && toolCall.id !== "null") block.id = toolCall.id;
						if (toolCall.function.name) block.name = toolCall.function.name;
					}
				}

				if (!block) {
					const callId =
						toolCall.id && toolCall.id !== "null"
							? toolCall.id
							: deriveMistralToolCallId(`toolcall:${toolIndex}`, 0);
					block = {
						type: "toolCall",
						id: callId,
						name: toolCall.function.name ?? "",
						arguments: {},
						partialArgs: "",
					};
					output.content.push(block);
					contentIndex = output.content.length - 1;
					toolBlocksByKey.set(toolIndex, contentIndex);
					stream.push({ type: "toolcall_start", contentIndex, partial: output });
				}

				const argsDelta =
					typeof toolCall.function.arguments === "string"
						? toolCall.function.arguments
						: toolCall.function.arguments
							? JSON.stringify(toolCall.function.arguments)
							: "";
				if (argsDelta) {
					block.partialArgs = (block.partialArgs || "") + argsDelta;
					block.arguments = parseStreamingJson<Record<string, unknown>>(block.partialArgs);
					stream.push({
						type: "toolcall_delta",
						contentIndex: contentIndex!,
						delta: argsDelta,
						partial: output,
					});
				}
			}
		}
	}

	finishMistralContentBlock(currentBlock, output, stream);
	for (const index of toolBlocksByKey.values()) {
		const block = output.content[index];
		if (block.type !== "toolCall") continue;
		const toolBlock = block as ToolCall & { partialArgs?: string };
		toolBlock.arguments = parseStreamingJson<Record<string, unknown>>(toolBlock.partialArgs);
		// Finalize in-place and strip the scratch buffer so replay only
		// carries parsed arguments.
		toolBlock.partialArgs = undefined;
		stream.push({
			type: "toolcall_end",
			contentIndex: index,
			toolCall: toolBlock,
			partial: output,
		});
	}
}

function toFunctionTools(tools: Tool[]): MistralFunctionTool[] {
	const result = new Array<MistralFunctionTool>(tools.length);
	for (let index = 0; index < tools.length; index++) {
		const tool = tools[index]!;
		const strict = resolveJsonSchemaStrictSampling(tool, true);
		result[index] = {
			type: "function",
			function: {
				name: tool.name,
				description: tool.description,
				parameters: getJsonSchemaToolParameters(tool, strict) as Record<string, unknown>,
				strict: strict ?? false,
			},
		};
	}
	return result;
}

function toChatMessages(messages: Message[], supportsImages: boolean): MistralChatMessage[] {
	const result: MistralChatMessage[] = [];

	for (const msg of messages) {
		if (msg.role === "user") {
			if (typeof msg.content === "string") {
				result.push({ role: "user", content: sanitizeSurrogates(msg.content) });
				continue;
			}
			let hadImages = false;
			const content: MistralContentChunk[] = [];
			for (const item of msg.content) {
				if (item.type === "text") {
					content.push({ type: "text", text: sanitizeSurrogates(item.text) });
				} else {
					hadImages = true;
					if (supportsImages) {
						content.push({ type: "image_url", imageUrl: `data:${item.mimeType};base64,${item.data}` });
					}
				}
			}
			if (content.length > 0) {
				result.push({ role: "user", content });
				continue;
			}
			if (hadImages && !supportsImages) {
				result.push({ role: "user", content: "(image omitted: model does not support images)" });
			}
			continue;
		}

		if (msg.role === "assistant") {
			const contentParts: MistralContentChunk[] = [];
			const toolCalls: MistralRequestToolCall[] = [];

			for (const block of msg.content) {
				if (block.type === "text") {
					if (block.text.trim().length > 0) {
						contentParts.push({ type: "text", text: sanitizeSurrogates(block.text) });
					}
					continue;
				}
				if (block.type === "thinking") {
					if (block.thinking.trim().length > 0) {
						contentParts.push({
							type: "thinking",
							thinking: [{ type: "text", text: sanitizeSurrogates(block.thinking) }],
						});
					}
					continue;
				}
				toolCalls.push({
					id: block.id,
					type: "function",
					function: { name: block.name, arguments: JSON.stringify(block.arguments || {}) },
					index: toolCalls.length,
				});
			}

			const assistantMessage: MistralChatMessage = { role: "assistant", prefix: false };
			if (contentParts.length > 0) assistantMessage.content = contentParts;
			if (toolCalls.length > 0) assistantMessage.toolCalls = toolCalls;
			if (contentParts.length > 0 || toolCalls.length > 0) result.push(assistantMessage);
			continue;
		}

		const toolContent: MistralContentChunk[] = [{ type: "text", text: "" }];
		let textResult = "";
		let hasText = false;
		let hasImages = false;
		for (const part of msg.content) {
			if (part.type === "text") {
				const text = sanitizeSurrogates(part.text);
				textResult += hasText ? `\n${text}` : text;
				hasText = true;
			} else {
				hasImages = true;
				if (supportsImages) {
					toolContent.push({
						type: "image_url",
						imageUrl: `data:${part.mimeType};base64,${part.data}`,
					});
				}
			}
		}
		const toolText = buildToolResultText(textResult, hasImages, supportsImages, msg.isError);
		toolContent[0] = { type: "text", text: toolText };
		result.push({
			role: "tool",
			toolCallId: msg.toolCallId,
			name: msg.toolName,
			content: toolContent,
		});
	}

	return result;
}

function buildToolResultText(text: string, hasImages: boolean, supportsImages: boolean, isError: boolean): string {
	const trimmed = text.trim();
	const errorPrefix = isError ? "[tool error] " : "";

	if (trimmed.length > 0) {
		const imageSuffix = hasImages && !supportsImages ? "\n[tool image omitted: model does not support images]" : "";
		return `${errorPrefix}${trimmed}${imageSuffix}`;
	}

	if (hasImages) {
		if (supportsImages) {
			return isError ? "[tool error] (see attached image)" : "(see attached image)";
		}
		return isError
			? "[tool error] (image omitted: model does not support images)"
			: "(image omitted: model does not support images)";
	}

	return isError ? "[tool error] (no tool output)" : "(no tool output)";
}

function usesReasoningEffort(model: Model<"mistral-conversations">): boolean {
	return model.id === "mistral-small-2603" || model.id === "mistral-small-latest" || model.id === "mistral-medium-3.5";
}

function usesPromptModeReasoning(model: Model<"mistral-conversations">): boolean {
	return model.reasoning && !usesReasoningEffort(model);
}

function mapReasoningEffort(
	model: Model<"mistral-conversations">,
	level: Exclude<SimpleStreamOptions["reasoning"], undefined>,
): MistralReasoningEffort {
	return (model.thinkingLevelMap?.[level] ?? "high") as MistralReasoningEffort;
}

function mapToolChoice(
	choice: MistralOptions["toolChoice"],
): "auto" | "none" | "any" | "required" | { type: "function"; function: { name: string } } | undefined {
	if (!choice) return undefined;
	if (choice === "auto" || choice === "none" || choice === "any" || choice === "required") {
		return choice;
	}
	return {
		type: "function",
		function: { name: choice.function.name },
	};
}

function mapChatStopReason(reason: string | null): { stopReason: StopReason; errorMessage?: string } {
	if (reason === null) return { stopReason: "stop" };
	switch (reason) {
		case "stop":
			return { stopReason: "stop" };
		case "length":
		case "model_length":
			return { stopReason: "length" };
		case "tool_calls":
			return { stopReason: "toolUse" };
		case "error":
			return { stopReason: "error", errorMessage: "Provider stopped with: error" };
		default:
			return { stopReason: "error", errorMessage: `Provider stopped with: ${reason}` };
	}
}
