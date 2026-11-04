/**
 * Proxy stream function for apps that route LLM calls through a server.
 * The server manages auth and proxies requests to LLM providers.
 */

import {
	type AssistantMessage,
	type AssistantMessageEvent,
	type Context,
	EventStream,
	IncrementalToolArguments,
	type Model,
	type SimpleStreamOptions,
	type StopReason,
	type ToolCall,
} from "@super-pi/ai";

type StreamingProxyToolCall = ToolCall & { toolArgsGeneration?: number };
const PROXY_DECODE_OPTIONS = { stream: true } as const;
function ignoreReaderCancellation(): void { /* The stream's original error/abort remains authoritative. */ }

function releaseProxyTool(partial: AssistantMessage, parsers: (IncrementalToolArguments | undefined)[], index: number, finalize = false): void {
	const parser = parsers[index];
	if (!parser) return;
	const block = partial.content[index] as StreamingProxyToolCall;
	if (finalize) block.arguments = parser.finalize();
	else parser.dispose();
	block.toolArgsGeneration = undefined;
	parsers[index] = undefined;
}

function releaseProxyTools(partial: AssistantMessage, parsers: (IncrementalToolArguments | undefined)[], finalize = false): void {
	for (let index = 0; index < parsers.length; index++) releaseProxyTool(partial, parsers, index, finalize);
	parsers.length = 0;
}

// Create stream class matching ProxyMessageEventStream
class ProxyMessageEventStream extends EventStream<AssistantMessageEvent, AssistantMessage> {
	constructor() {
		super(
			(event) => event.type === "done" || event.type === "error",
			(event) => {
				if (event.type === "done") return event.message;
				if (event.type === "error") return event.error;
				throw new Error("Unexpected event type");
			},
		);
	}
}

/**
 * Proxy event types - server sends these with partial field stripped to reduce bandwidth.
 */
export type ProxyAssistantMessageEvent =
	| { type: "start" }
	| { type: "text_start"; contentIndex: number }
	| { type: "text_delta"; contentIndex: number; delta: string }
	| { type: "text_end"; contentIndex: number; contentSignature?: string }
	| { type: "thinking_start"; contentIndex: number }
	| { type: "thinking_delta"; contentIndex: number; delta: string }
	| { type: "thinking_end"; contentIndex: number; contentSignature?: string }
	| { type: "toolcall_start"; contentIndex: number; id: string; toolName: string }
	| { type: "toolcall_delta"; contentIndex: number; delta: string }
	| { type: "toolcall_end"; contentIndex: number; toolCall: ToolCall }
	| {
			type: "done";
			reason: Extract<StopReason, "stop" | "length" | "toolUse">;
			usage: AssistantMessage["usage"];
			/** Forward from the provider's final message; omit on legacy servers. */
			anthropicContext?: AssistantMessage["anthropicContext"];
			rawStopReason?: AssistantMessage["rawStopReason"];
	  }
	| {
			type: "error";
			reason: Extract<StopReason, "aborted" | "error">;
			errorMessage?: string;
			usage: AssistantMessage["usage"];
	  };

type ProxySerializableStreamOptions = Pick<
	SimpleStreamOptions,
	| "temperature"
	| "samplingParams"
	| "maxTokens"
	| "reasoning"
	| "cacheRetention"
	| "sessionId"
	| "headers"
	| "metadata"
	| "transport"
	| "thinkingBudgets"
	| "maxRetryDelayMs"
>;

export interface ProxyStreamOptions extends ProxySerializableStreamOptions {
	/** Local abort signal for the proxy request */
	signal?: AbortSignal;
	/** Auth token for the proxy server */
	authToken: string;
	/** Proxy server URL (e.g., "https://genai.example.com") */
	proxyUrl: string;
}

/**
 * Stream function that proxies through a server instead of calling LLM providers directly.
 * The server strips the partial field from delta events to reduce bandwidth.
 * We reconstruct the partial message client-side.
 *
 * Use this as the `streamFn` option when creating an Agent that needs to go through a proxy.
 *
 * @example
 * ```typescript
 * const agent = new Agent({
 *   streamFn: (model, context, options) =>
 *     streamProxy(model, context, {
 *       ...options,
 *       authToken: await getAuthToken(),
 *       proxyUrl: "https://genai.example.com",
 *     }),
 * });
 * ```
 */
function buildProxyRequestOptions(options: ProxyStreamOptions): ProxySerializableStreamOptions {
	return {
		temperature: options.temperature,
		samplingParams: options.samplingParams,
		maxTokens: options.maxTokens,
		reasoning: options.reasoning,
		cacheRetention: options.cacheRetention,
		sessionId: options.sessionId,
		headers: options.headers,
		metadata: options.metadata,
		transport: options.transport,
		thinkingBudgets: options.thinkingBudgets,
		maxRetryDelayMs: options.maxRetryDelayMs,
	};
}

export function streamProxy(model: Model<any>, context: Context, options: ProxyStreamOptions): ProxyMessageEventStream {
	const stream = new ProxyMessageEventStream();

	(async () => {
		// Initialize the partial message that we'll build up from events
		const partial: AssistantMessage = {
			role: "assistant",
			stopReason: "pending",
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
			timestamp: Date.now(),
		};

		let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
		let buffer = "";
		const toolParsers: (IncrementalToolArguments | undefined)[] = [];

		const abortHandler = () => {
			if (reader) {
				reader.cancel("Request aborted by user").catch(ignoreReaderCancellation);
			}
		};

		if (options.signal) {
			options.signal.addEventListener("abort", abortHandler);
		}

		try {
			const response = await fetch(`${options.proxyUrl}/api/stream`, {
				method: "POST",
				headers: {
					Authorization: `Bearer ${options.authToken}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({
					model,
					context,
					options: buildProxyRequestOptions(options),
				}),
				signal: options.signal,
			});

			if (!response.ok) {
				let errorMessage = `Proxy error: ${response.status} ${response.statusText}`;
				try {
					const errorData = (await response.json()) as { error?: string };
					if (errorData.error) {
						errorMessage = `Proxy error: ${errorData.error}`;
					}
				} catch {
					// Couldn't parse error response
				}
				throw new Error(errorMessage);
			}

			reader = response.body!.getReader();
			const decoder = new TextDecoder();
			let terminalReceived = false;

			while (!terminalReceived) {
				const { done, value } = await reader.read();
				if (done) break;

				if (options.signal?.aborted) {
					throw new Error("Request aborted by user");
				}

				const decoded = decoder.decode(value, PROXY_DECODE_OPTIONS);
				let segmentStart = 0;
				let newline = decoded.indexOf("\n", segmentStart);
				while (newline !== -1) {
					const line = buffer + decoded.slice(segmentStart, newline);
					buffer = "";
					segmentStart = newline + 1;
					if (line.startsWith("data: ")) {
						const data = line.slice(6).trim();
						if (data) {
							const proxyEvent = JSON.parse(data) as ProxyAssistantMessageEvent;
							const event = processProxyEvent(proxyEvent, partial, toolParsers);
							if (event) {
								stream.push(event);
								if (event.type === "done" || event.type === "error") { terminalReceived = true; break; }
							}
						}
					}
					newline = decoded.indexOf("\n", segmentStart);
				}
				if (!terminalReceived && segmentStart < decoded.length) buffer += decoded.slice(segmentStart);
			}

			if (options.signal?.aborted) {
				throw new Error("Request aborted by user");
			}
			if (!terminalReceived) throw new Error("Proxy stream ended without a terminal event");

			stream.end();
		} catch (error) {
			releaseProxyTools(partial, toolParsers);
			const errorMessage = error instanceof Error ? error.message : String(error);
			const reason = options.signal?.aborted ? "aborted" : "error";
			partial.stopReason = reason;
			partial.errorMessage = errorMessage;
			stream.push({
				type: "error",
				reason,
				error: partial,
			});
			stream.end();
		} finally {
			releaseProxyTools(partial, toolParsers);
			buffer = "";
			if (options.signal) {
				options.signal.removeEventListener("abort", abortHandler);
			}
			if (reader) {
				await reader.cancel().catch(ignoreReaderCancellation);
				reader.releaseLock();
				reader = undefined;
			}
		}
	})();

	return stream;
}

/**
 * Process a proxy event and update the partial message.
 */
function processProxyEvent(
	proxyEvent: ProxyAssistantMessageEvent,
	partial: AssistantMessage,
	toolParsers: (IncrementalToolArguments | undefined)[],
): AssistantMessageEvent | undefined {
	switch (proxyEvent.type) {
		case "start":
			return { type: "start", partial };

		case "text_start":
			releaseProxyTool(partial, toolParsers, proxyEvent.contentIndex);
			partial.content[proxyEvent.contentIndex] = { type: "text", text: "" };
			return { type: "text_start", contentIndex: proxyEvent.contentIndex, partial };

		case "text_delta": {
			const content = partial.content[proxyEvent.contentIndex];
			if (content?.type === "text") {
				content.text += proxyEvent.delta;
				return {
					type: "text_delta",
					contentIndex: proxyEvent.contentIndex,
					delta: proxyEvent.delta,
					partial,
				};
			}
			throw new Error("Received text_delta for non-text content");
		}

		case "text_end": {
			const content = partial.content[proxyEvent.contentIndex];
			if (content?.type === "text") {
				content.textSignature = proxyEvent.contentSignature;
				return {
					type: "text_end",
					contentIndex: proxyEvent.contentIndex,
					content: content.text,
					partial,
				};
			}
			throw new Error("Received text_end for non-text content");
		}

		case "thinking_start":
			releaseProxyTool(partial, toolParsers, proxyEvent.contentIndex);
			partial.content[proxyEvent.contentIndex] = { type: "thinking", thinking: "" };
			return { type: "thinking_start", contentIndex: proxyEvent.contentIndex, partial };

		case "thinking_delta": {
			const content = partial.content[proxyEvent.contentIndex];
			if (content?.type === "thinking") {
				content.thinking += proxyEvent.delta;
				return {
					type: "thinking_delta",
					contentIndex: proxyEvent.contentIndex,
					delta: proxyEvent.delta,
					partial,
				};
			}
			throw new Error("Received thinking_delta for non-thinking content");
		}

		case "thinking_end": {
			const content = partial.content[proxyEvent.contentIndex];
			if (content?.type === "thinking") {
				content.thinkingSignature = proxyEvent.contentSignature;
				return {
					type: "thinking_end",
					contentIndex: proxyEvent.contentIndex,
					content: content.thinking,
					partial,
				};
			}
			throw new Error("Received thinking_end for non-thinking content");
		}

		case "toolcall_start": {
			releaseProxyTool(partial, toolParsers, proxyEvent.contentIndex);
			const block: StreamingProxyToolCall = {
				type: "toolCall",
				id: proxyEvent.id,
				name: proxyEvent.toolName,
				arguments: {},
				thoughtSignature: undefined,
				namespace: undefined,
				toolArgsGeneration: 0,
			};
			partial.content[proxyEvent.contentIndex] = block;
			toolParsers[proxyEvent.contentIndex] = new IncrementalToolArguments();
			return { type: "toolcall_start", contentIndex: proxyEvent.contentIndex, partial };
		}

		case "toolcall_delta": {
			const content = partial.content[proxyEvent.contentIndex] as StreamingProxyToolCall;
			const parser = toolParsers[proxyEvent.contentIndex];
			if (content?.type === "toolCall" && parser) {
				content.arguments = parser.append(proxyEvent.delta);
				content.toolArgsGeneration = (content.toolArgsGeneration ?? 0) + 1;
				const hostEvent = proxyEvent as Extract<AssistantMessageEvent, { type: "toolcall_delta" }>;
				hostEvent.toolArgsGeneration = content.toolArgsGeneration;
				hostEvent.partial = partial;
				return hostEvent;
			}
			throw new Error("Received toolcall_delta without an active tool call");
		}

		case "toolcall_end": {
			releaseProxyTool(partial, toolParsers, proxyEvent.contentIndex);
			const content = partial.content[proxyEvent.contentIndex];
			if (content?.type === "toolCall") {
				content.id = proxyEvent.toolCall.id;
				content.name = proxyEvent.toolCall.name;
				content.arguments = proxyEvent.toolCall.arguments;
				content.thoughtSignature = proxyEvent.toolCall.thoughtSignature;
				content.namespace = proxyEvent.toolCall.namespace;
				return {
					type: "toolcall_end",
					contentIndex: proxyEvent.contentIndex,
					toolCall: content,
					partial,
				};
			}
			return undefined;
		}

		case "done":
			releaseProxyTools(partial, toolParsers, true);
			partial.stopReason = proxyEvent.reason;
			partial.usage = proxyEvent.usage;
			return { type: "done", reason: proxyEvent.reason, message:
				proxyEvent.anthropicContext === undefined && proxyEvent.rawStopReason === undefined ? partial :
					{ ...partial, anthropicContext: proxyEvent.anthropicContext, rawStopReason: proxyEvent.rawStopReason } };

		case "error":
			releaseProxyTools(partial, toolParsers);
			partial.stopReason = proxyEvent.reason;
			partial.errorMessage = proxyEvent.errorMessage;
			partial.usage = proxyEvent.usage;
			return { type: "error", reason: proxyEvent.reason, error: partial };

		default: {
			const _exhaustiveCheck: never = proxyEvent;
			console.warn(`Unhandled proxy event type: ${(proxyEvent as any).type}`);
			return undefined;
		}
	}
}
