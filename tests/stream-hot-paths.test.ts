import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import test from "node:test";
import { stream as streamAnthropic } from "../packages/ai/src/api/anthropic-messages.ts";
import { stream as streamPiMessages } from "../packages/ai/src/api/pi-messages.ts";
import { retryAssistantCall } from "../packages/ai/src/utils/retry.ts";
import { streamProxy } from "../packages/agent/src/proxy.ts";

test("Anthropic stream routes sparse provider block indexes without linear lookup", async () => {
	const rawEvents: Array<[string, Record<string, unknown>]> = [
		["message_start", { type: "message_start", message: { id: "m1", usage: { input_tokens: 1, output_tokens: 0 } } }],
		["content_block_start", { type: "content_block_start", index: 3, content_block: { type: "text", text: "a" } }],
		["content_block_delta", { type: "content_block_delta", index: 3, delta: { type: "text_delta", text: "b" } }],
		["content_block_stop", { type: "content_block_stop", index: 3 }],
		["message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 2 } }],
		["message_stop", { type: "message_stop" }],
	];
	let body = "";
	for (const [event, data] of rawEvents) body += `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
	const response = new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
	const client = { messages: { create: () => ({ asResponse: async () => response }) } };
	const model = {
		id: "test",
		name: "test",
		api: "anthropic-messages",
		provider: "anthropic",
		baseUrl: "https://example.invalid",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1000,
		maxTokens: 100,
	};
	const events: Array<{ type: string; contentIndex?: number; content?: string; delta?: string }> = [];
	for await (const event of streamAnthropic(model as never, { systemPrompt: "", messages: [], tools: [] }, { client } as never)) {
		events.push(event);
	}
	assert.deepEqual(
		events.map(({ type, contentIndex, content, delta }) => ({ type, contentIndex, content, delta })),
		[
			{ type: "start", contentIndex: undefined, content: undefined, delta: undefined },
			{ type: "text_start", contentIndex: 0, content: undefined, delta: undefined },
			{ type: "text_delta", contentIndex: 0, content: undefined, delta: "b" },
			{ type: "text_end", contentIndex: 0, content: "ab", delta: undefined },
			{ type: "done", contentIndex: undefined, content: undefined, delta: undefined },
		],
	);
});

test("pi-messages tool completion ignores unexpected prototype fields", async () => {
	const body = [
		'data: {"type":"start"}',
		'data: {"type":"toolcall_start","contentIndex":0,"id":"call-1","toolName":"read"}',
		'data: {"type":"toolcall_end","contentIndex":0,"toolCall":{"type":"toolCall","id":"call-1","name":"read","arguments":{"path":"a"},"__proto__":{"polluted":true}}}',
		'data: {"type":"done","reason":"toolUse","usage":{"input":1,"output":1,"cacheRead":0,"cacheWrite":0,"totalTokens":2,"cost":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"total":0}}}',
		"",
	].join("\n\n");
	const response = new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
	const model = {
		id: "test",
		name: "test",
		api: "pi-messages",
		provider: "pi",
		baseUrl: "https://example.invalid",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1000,
		maxTokens: 100,
	};
	let toolCall: Record<string, unknown> | undefined;
	for await (const event of streamPiMessages(
		model as never,
		{ systemPrompt: "", messages: [], tools: [] },
		{ apiKey: "test", fetch: async () => response } as never,
	)) {
		if (event.type === "toolcall_end") toolCall = event.toolCall as unknown as Record<string, unknown>;
	}

	assert.ok(toolCall);
	assert.equal(Object.getPrototypeOf(toolCall), Object.prototype);
	assert.equal(toolCall.polluted, undefined);
	assert.deepEqual(toolCall.arguments, { path: "a" });
});

test("proxy tool completion ignores unexpected prototype fields", async () => {
	const originalFetch = globalThis.fetch;
	const body = [
		'data: {"type":"start"}',
		'data: {"type":"toolcall_start","contentIndex":0,"id":"call-1","toolName":"read"}',
		'data: {"type":"toolcall_end","contentIndex":0,"toolCall":{"type":"toolCall","id":"call-1","name":"read","arguments":{"path":"a"},"__proto__":{"polluted":true}}}',
		'data: {"type":"done","reason":"toolUse","usage":{"input":1,"output":1,"cacheRead":0,"cacheWrite":0,"totalTokens":2,"cost":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"total":0}}}',
		"",
	].join("\n");
	globalThis.fetch = async () => new Response(body, { status: 200 }) as never;
	try {
		const model = { id: "test", api: "test", provider: "proxy" };
		let toolCall: Record<string, unknown> | undefined;
		for await (const event of streamProxy(
			model as never,
			{ systemPrompt: "", messages: [], tools: [] },
			{ proxyUrl: "https://example.invalid", authToken: "test" },
		)) {
			if (event.type === "toolcall_end") toolCall = event.toolCall as unknown as Record<string, unknown>;
		}

		assert.ok(toolCall);
		assert.equal(Object.getPrototypeOf(toolCall), Object.prototype);
		assert.equal(toolCall.polluted, undefined);
		assert.deepEqual(toolCall.arguments, { path: "a" });
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("retry backoff removes its abort listener after the timer completes", async () => {
	const controller = new AbortController();
	let calls = 0;
	const response = await retryAssistantCall(
		async () => {
			calls++;
			return calls === 1
				? ({ stopReason: "error", errorMessage: "503 service unavailable" } as never)
				: ({ stopReason: "stop" } as never);
		},
		{ enabled: true, maxRetries: 1, baseDelayMs: 1 },
		controller.signal,
	);

	assert.equal(response.stopReason, "stop");
	assert.equal(calls, 2);
	assert.equal(getEventListeners(controller.signal, "abort").length, 0);
});
