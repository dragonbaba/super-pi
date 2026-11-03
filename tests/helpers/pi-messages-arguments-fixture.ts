import { stream as streamPiMessages } from "../../packages/ai/src/api/pi-messages.ts";
import type { Model } from "../../packages/ai/src/types.ts";

export const piMessagesArgumentsModel: Model<"pi-messages"> = {
	id: "fixture", name: "fixture", api: "pi-messages", provider: "pi", baseUrl: "https://fixture.invalid",
	reasoning: false, input: ["text"], contextWindow: 1000000, maxTokens: 1000000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
export const piMessagesUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

/** Preencode native wire events; the production SSE reader and converter still run. */
export function piMessagesEventsFixture(events: readonly unknown[], failAfterChunks?: number) {
	const encoder = new TextEncoder(), chunks = events.map(event => encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
	return {
		start(factory: typeof streamPiMessages = streamPiMessages, signal?: AbortSignal) {
			let cursor = 0;
			const fetch: typeof globalThis.fetch = async () => new Response(new ReadableStream<Uint8Array>({ pull(controller) {
				if (signal?.aborted) { controller.error(signal.reason); return; }
				if (cursor === failAfterChunks) { controller.error(new Error("injected transport failure")); return; }
				if (cursor < chunks.length) controller.enqueue(chunks[cursor++]); else controller.close();
			} }), { headers: { "content-type": "text/event-stream" } });
			return factory(piMessagesArgumentsModel, { messages: [] }, { apiKey: "fixture", fetch, signal });
		},
		release(): void { chunks.length = 0; },
	};
}

export function piMessagesArgumentsFixture(inputs: readonly string[], chunkCharacters: number, omitToolEnd = false, failAfterChunks?: number) {
	const events: unknown[] = [{ type: "start" }];
	for (let contentIndex = 0; contentIndex < inputs.length; contentIndex++) events.push({ type: "toolcall_start", contentIndex, id: `tool-${contentIndex}`, toolName: "fixture" });
	for (let offset = 0; inputs.some(input => offset < input.length); offset += chunkCharacters) {
		for (let contentIndex = 0; contentIndex < inputs.length; contentIndex++) if (offset < inputs[contentIndex].length) events.push({ type: "toolcall_delta", contentIndex, delta: inputs[contentIndex].slice(offset, offset + chunkCharacters) });
	}
	if (!omitToolEnd) for (let contentIndex = 0; contentIndex < inputs.length; contentIndex++) events.push({ type: "toolcall_end", contentIndex,
		toolCall: { type: "toolCall", id: `tool-${contentIndex}`, name: "fixture", arguments: JSON.parse(inputs[contentIndex]) } });
	events.push({ type: "done", reason: "toolUse", usage: piMessagesUsage });
	return piMessagesEventsFixture(events, failAfterChunks);
}
