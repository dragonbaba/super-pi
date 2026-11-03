import { stream as streamChat } from "../../packages/ai/src/api/openai-completions.ts";
import type { Model } from "../../packages/ai/src/types.ts";

export const chatArgumentsModel: Model<"openai-completions"> = {
	id: "fixture", name: "fixture", api: "openai-completions", provider: "openai", baseUrl: "https://fixture.invalid/v1",
	reasoning: false, input: ["text"], contextWindow: 1000000, maxTokens: 1000000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

/** Preencode bytes; the actual SDK SSE decoder, adapter and EventStream still execute. */
export function chatEventsFixture(events: readonly unknown[], failAfterChunks?: number) {
	const encoder = new TextEncoder(), chunks = events.map(event => encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
	chunks.push(encoder.encode("data: [DONE]\n\n"));
	return {
		start(factory: typeof streamChat = streamChat, signal?: AbortSignal) {
			let cursor = 0;
			const fetch: typeof globalThis.fetch = async () => new Response(new ReadableStream<Uint8Array>({ pull(controller) {
				if (signal?.aborted) { controller.error(signal.reason); return; }
				if (cursor === failAfterChunks) { controller.error(new Error("injected transport failure")); return; }
				if (cursor < chunks.length) controller.enqueue(chunks[cursor++]); else controller.close();
			} }), { headers: { "content-type": "text/event-stream" } });
			return factory(chatArgumentsModel, { messages: [] }, { apiKey: "fixture", fetch, maxRetries: 0, signal });
		},
		release(): void { chunks.length = 0; },
	};
}

export function chatArgumentsFixture(inputs: readonly string[], chunkCharacters: number, omitFinishReason = false, failAfterChunks?: number) {
	const events: unknown[] = [];
	function add(tool: unknown): void { events.push({ id: "fixture", choices: [{ index: 0, delta: { tool_calls: [tool] }, finish_reason: null }] }); }
	for (let index = 0; index < inputs.length; index++) add({ index, id: `tool-${index}`, type: "function", function: { name: "fixture", arguments: "" } });
	for (let offset = 0; inputs.some(input => offset < input.length); offset += chunkCharacters) {
		for (let index = 0; index < inputs.length; index++) if (offset < inputs[index].length) add({ index, function: { arguments: inputs[index].slice(offset, offset + chunkCharacters) } });
	}
	if (!omitFinishReason) events.push({ id: "fixture", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] });
	return chatEventsFixture(events, failAfterChunks);
}
