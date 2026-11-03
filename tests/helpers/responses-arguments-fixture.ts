import { stream as streamCodex } from "../../packages/ai/src/api/openai-codex-responses.ts";
import { codexModel, codexToken, responsesContext } from "./responses-sse-fixture.ts";

/** Actual Codex SSE/Responses producer; encode inputs before allocation sampling. */
export function responsesArgumentsFixture(inputs: readonly string[], chunkCharacters: number, omitToolStop = false, failAfterChunks?: number) {
	const encoder = new TextEncoder(), chunks: Uint8Array[] = [];
	function add(event: Record<string, unknown>): void { chunks.push(encoder.encode(`data: ${JSON.stringify(event)}\n\n`)); }
	const item = (index: number, args: string) => ({ type: "function_call", id: `fc_${index}`, call_id: `tool-${index}`, name: "fixture", arguments: args });
	for (let index = 0; index < inputs.length; index++) add({ type: "response.output_item.added", output_index: index, item: item(index, "") });
	for (let offset = 0; inputs.some(input => offset < input.length); offset += chunkCharacters) {
		for (let index = 0; index < inputs.length; index++) if (offset < inputs[index].length) {
			add({ type: "response.function_call_arguments.delta", output_index: index, delta: inputs[index].slice(offset, offset + chunkCharacters) });
		}
	}
	for (let index = 0; index < inputs.length; index++) {
		add({ type: "response.function_call_arguments.done", output_index: index, arguments: inputs[index] });
		if (!omitToolStop) add({ type: "response.output_item.done", output_index: index, item: item(index, inputs[index]) });
	}
	add({ type: "response.completed", response: { id: "fixture", status: "completed" } });
	return {
		start(factory: typeof streamCodex = streamCodex, signal?: AbortSignal) {
			let cursor = 0;
			const fetch: typeof globalThis.fetch = async () => new Response(new ReadableStream<Uint8Array>({ pull(controller) {
				if (cursor === failAfterChunks) { controller.error(new Error("injected transport failure")); return; }
				if (cursor < chunks.length) controller.enqueue(chunks[cursor++]); else controller.close();
			} }), { headers: { "content-type": "text/event-stream" } });
			return factory(codexModel, responsesContext, { apiKey: codexToken(), transport: "sse", fetch, maxRetries: 0, signal });
		},
		release(): void { chunks.length = 0; },
	};
}
