import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import type { AssistantMessage, AssistantMessageEvent, Context, Model } from "@super-pi/ai";
import { stream as streamOpenAIChat } from "../../packages/ai/src/api/openai-completions.ts";
import { processResponsesStream } from "../../packages/ai/src/api/openai-responses-shared.ts";

const EMPTY_USAGE = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function model<TApi extends "openai-completions" | "openai-responses">(api: TApi): Model<TApi> {
	return {
		id: "fixture",
		name: "fixture",
		api,
		provider: "openai",
		baseUrl: "https://example.invalid/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1_000,
		maxTokens: 100,
	};
}

function customGenerations(events: readonly AssistantMessageEvent[]): number[] {
	const generations: number[] = [];
	for (const event of events) {
		if (event.type !== "toolcall_start" && event.type !== "toolcall_delta") continue;
		const block = event.partial.content[event.contentIndex] as { toolArgsGeneration?: unknown };
		const generation = event.type === "toolcall_delta" ? event.toolArgsGeneration : block.toolArgsGeneration;
		assert.equal(typeof generation, "number", event.type);
		generations.push(generation as number);
	}
	return generations;
}

test("OpenAI Chat custom tool exposes host-only generation for every partial delivery", async () => {
	const chunks = [
		{ id: "chat-1", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call-1", type: "custom", custom: { name: "grammar", input: "hel" } }] }, finish_reason: null }] },
		{ id: "chat-1", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call-1", type: "custom", custom: { name: "grammar", input: "lo" } }] }, finish_reason: null }] },
		{ id: "chat-1", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
	];
	const encoder = new TextEncoder();
	let chunkIndex = 0;
	const fetch = async (): Promise<Response> => new Response(new ReadableStream<Uint8Array>({
		async pull(controller): Promise<void> {
			await new Promise((resolve) => setTimeout(resolve, 2));
			if (chunkIndex < chunks.length) {
				controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunks[chunkIndex++])}\n\n`));
				return;
			}
			controller.enqueue(encoder.encode("data: [DONE]\n\n"));
			controller.close();
		},
	}), { status: 200, headers: { "content-type": "text/event-stream" } });
	const context = { systemPrompt: "", messages: [], tools: [] } satisfies Context;
	const events: AssistantMessageEvent[] = [];
	for await (const event of streamOpenAIChat(model("openai-completions"), context, {
		apiKey: "fixture",
		fetch: fetch as never,
	})) {
		events.push(structuredClone(event));
	}
	assert.deepEqual(customGenerations(events), [1, 1, 2, 3]);
	const end = events.find((event) => event.type === "toolcall_end");
	assert.ok(end?.type === "toolcall_end");
	assert.deepEqual(end.toolCall.arguments, { input: "hello" });
	assert.equal((end.toolCall as { toolArgsGeneration?: unknown }).toolArgsGeneration, undefined);
	assert.equal((end.toolCall as { customInput?: unknown }).customInput, undefined);
});

test("OpenAI Responses custom tool exposes host-only generation and strips parser scratch", async () => {
	const events: AssistantMessageEvent[] = [];
	const output: AssistantMessage = {
		role: "assistant",
		content: [],
		api: "openai-responses",
		provider: "openai",
		model: "fixture",
		usage: structuredClone(EMPTY_USAGE),
		stopReason: "pending",
		timestamp: 0,
	};
	const item = { type: "custom_tool_call", id: "item-1", call_id: "call-1", name: "grammar", input: "hello" };
	async function* providerEvents(): AsyncGenerator<unknown> {
		yield { type: "response.output_item.added", output_index: 0, item: { ...item, input: "" } };
		yield { type: "response.custom_tool_call_input.delta", output_index: 0, delta: "hel" };
		yield { type: "response.custom_tool_call_input.delta", output_index: 0, delta: "lo" };
		yield { type: "response.custom_tool_call_input.done", output_index: 0, input: "hello" };
		yield { type: "response.output_item.done", output_index: 0, item };
		yield { type: "response.completed", response: { id: "response-1", status: "completed", output: [item] } };
	}
	const sink = {
		push(event: AssistantMessageEvent): void {
			events.push(structuredClone(event));
		},
	};
	await processResponsesStream(providerEvents() as never, output, sink as never, model("openai-responses"));
	assert.deepEqual(customGenerations(events), [0, 1, 2, 3]);
	const end = events.find((event) => event.type === "toolcall_end");
	assert.ok(end?.type === "toolcall_end");
	assert.deepEqual(end.toolCall.arguments, { input: "hello" });
	assert.equal((end.toolCall as { toolArgsGeneration?: unknown }).toolArgsGeneration, undefined);
	assert.equal((end.toolCall as { customInput?: unknown }).customInput, undefined);
	assert.equal(JSON.stringify(output).includes("toolArgsGeneration"), false);
	assert.equal(JSON.stringify(output).includes("customInput"), false);
});

test("OpenAI Responses, Azure, and Codex share the custom generation parser", () => {
	for (const filePath of [
		"packages/ai/src/api/openai-responses.ts",
		"packages/ai/src/api/azure-openai-responses.ts",
		"packages/ai/src/api/openai-codex-responses.ts",
	]) {
		const source = readFileSync(filePath, "utf8");
		assert.match(source, /processResponsesStream\(/, filePath);
	}
	const shared = readFileSync("packages/ai/src/api/openai-responses-shared.ts", "utf8");
	assert.match(shared, /toolArgsGeneration = \(block\.toolArgsGeneration \?\? 0\) \+ 1/);
});
