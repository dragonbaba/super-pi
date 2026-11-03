import type { Model } from "../../packages/ai/src/types.ts";
import type { AssistantMessageEventStream } from "../../packages/ai/src/utils/event-stream.ts";
import { stream as streamAnthropic } from "../../packages/ai/src/api/anthropic-messages.ts";

export const argumentsModel: Model<"anthropic-messages"> = {
	id: "fixture", name: "fixture", api: "anthropic-messages", provider: "anthropic", baseUrl: "https://fixture.invalid",
	reasoning: false, input: ["text"], contextWindow: 1000000, maxTokens: 1000000,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

/** Real SSE decoding and adapter; only request admission is offline. Build bytes before profiling. */
export function anthropicArgumentsFixture(inputs: readonly string[], chunkCharacters: number, omitToolStop = false, failAfterChunks?: number) {
	const encoder = new TextEncoder(), chunks: Uint8Array[] = [];
	function add(event: Record<string, unknown>): void {
		chunks.push(encoder.encode(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`));
	}
	add({ type: "message_start", message: { id: "fixture", usage: { input_tokens: 1, output_tokens: 0 } } });
	for (let index = 0; index < inputs.length; index++) add({ type: "content_block_start", index, content_block: { type: "tool_use", id: `tool-${index}`, name: "fixture", input: {} } });
	for (let offset = 0; inputs.some(input => offset < input.length); offset += chunkCharacters) {
		for (let index = 0; index < inputs.length; index++) if (offset < inputs[index].length) {
			add({ type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: inputs[index].slice(offset, offset + chunkCharacters) } });
		}
	}
	if (!omitToolStop) for (let index = 0; index < inputs.length; index++) add({ type: "content_block_stop", index });
	add({ type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 1 } });
	add({ type: "message_stop" });
	return {
		start(factory: typeof streamAnthropic = streamAnthropic, signal?: AbortSignal): AssistantMessageEventStream {
			let cursor = 0;
			const body = new ReadableStream<Uint8Array>({ pull(controller) {
				if (cursor === failAfterChunks) { controller.error(new Error("injected transport failure")); return; }
				if (cursor < chunks.length) controller.enqueue(chunks[cursor++]); else controller.close();
			} });
			const response = new Response(body, { headers: { "content-type": "text/event-stream" } });
			const client = { messages: { create: () => ({ asResponse: async () => response }) } };
			return factory(argumentsModel, { messages: [], tools: [] }, { client, signal } as never);
		},
		release(): void { chunks.length = 0; },
	};
}
