import { stream as streamCodex } from "../../packages/ai/src/api/openai-codex-responses.ts";
import type { AssistantMessage, Context } from "../../packages/ai/src/types.ts";

// Shared by Responses/Codex stream boundary regressions (terminal events, SSE framing).

export const responsesUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

export const codexModel: any = {
	id: "gpt-5.1-codex", name: "fixture", api: "openai-codex-responses", provider: "openai-codex",
	baseUrl: "https://chatgpt.invalid/backend-api", reasoning: false, input: ["text"],
	cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }, contextWindow: 64_000, maxTokens: 512,
};

export const responsesContext: Context = { systemPrompt: "", messages: [{ role: "user", content: "hi", timestamp: 1 }] };

export function responsesOutput(api = "openai-responses"): AssistantMessage {
	return { role: "assistant", content: [], api, provider: "fixture", model: "fixture", timestamp: 0, stopReason: "stop", usage: structuredClone(responsesUsage) } as AssistantMessage;
}

export function codexToken(): string {
	return `header.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "fixture" } })).toString("base64url")}.signature`;
}

export const textItem = { type: "message", id: "msg_1", role: "assistant", content: [{ type: "output_text", text: "héllo✓", annotations: [] }] };

export function textEvents(): unknown[] {
	return [
		{ type: "response.output_item.added", output_index: 0, item: { ...textItem, content: [] } },
		{ type: "response.output_text.delta", output_index: 0, delta: "héllo✓" },
		{ type: "response.output_item.done", output_index: 0, item: textItem },
		{ type: "response.completed", response: { id: "resp_1", status: "completed", output: [textItem] } },
	];
}

/** Serializes events as SSE frames; `trailing: false` omits the blank line after the final frame. */
export function sseFrames(events: readonly unknown[], newline = "\n", trailing = true): string {
	let text = "";
	for (let index = 0; index < events.length; index++) {
		text += `data: ${JSON.stringify(events[index])}${newline}`;
		if (trailing || index < events.length - 1) text += newline;
	}
	return text;
}

/** Splits encoded bytes at fixed offsets so frames, CRLF pairs and UTF-8 sequences straddle reads. */
export function byteChunks(text: string, size: number): Uint8Array[] {
	const bytes = new TextEncoder().encode(text);
	const chunks: Uint8Array[] = [];
	for (let offset = 0; offset < bytes.length; offset += size) chunks.push(bytes.subarray(offset, offset + size));
	return chunks;
}

export function sseResponse(chunks: readonly Uint8Array[]): Response {
	let index = 0;
	const body = new ReadableStream<Uint8Array>({
		pull(controller) {
			if (index < chunks.length) controller.enqueue(chunks[index++]);
			else controller.close();
		},
	});
	return new Response(body, { headers: { "content-type": "text/event-stream" } });
}

export async function runCodexSse(chunks: readonly Uint8Array[]): Promise<AssistantMessage> {
	const fetch: typeof globalThis.fetch = async () => sseResponse(chunks);
	return streamCodex(codexModel, responsesContext, { apiKey: codexToken(), transport: "sse", fetch, maxRetries: 0 }).result();
}
