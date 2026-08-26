import assert from "node:assert/strict";
import test from "node:test";
import { buildOpenAICodexRequestBody } from "../../packages/ai/src/api/openai-codex-responses.ts";
import { stream as streamOpenAIChat } from "../../packages/ai/src/api/openai-completions.ts";
import { stream as streamMistral } from "../../packages/ai/src/api/mistral-conversations.ts";
import { stream as streamPiMessages } from "../../packages/ai/src/api/pi-messages.ts";
import { conservativeModelCapabilities, withModelProfile } from "../../packages/ai/src/model-capabilities.ts";
import type { Api, Context, EffectiveDispatchObservation, Model, Tool } from "../../packages/ai/src/types.ts";

function conservativeModel<TApi extends Api>(api: TApi): Model<TApi> {
	return {
		id: `unknown-${api}`,
		name: `Unknown ${api}`,
		api,
		provider: "fixture",
		baseUrl: "https://api.openai.com/v1",
		reasoning: false,
		thinkingLevelMap: { high: "provider-high" },
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 32_768,
		maxTokens: 4_096,
		profileSource: "conservative-fallback",
		costKnown: false,
		capabilities: conservativeModelCapabilities(),
		compat: {
			supportsStrictMode: true,
			supportsLongCacheRetention: true,
			supportsToolSearch: true,
		} as Model<TApi>["compat"],
	};
}

function context(): Context {
	return {
		systemPrompt: "system",
		messages: [{ role: "user", content: "hello", timestamp: 1 }],
		tools: [
			{
				name: "read",
				description: "read",
				parameters: { type: "object", properties: {}, required: [] },
			},
		],
	};
}

function openAIChatResponse(): Response {
	const chunk = {
		id: "chatcmpl-test",
		object: "chat.completion.chunk",
		created: 1,
		model: "unknown-openai-completions",
		choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
		usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
	};
	return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
}

function mistralResponse(): Response {
	const chunk = {
		id: "mistral-test",
		choices: [{ finish_reason: "stop", delta: {} }],
		usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
	};
	return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
}

test("OpenAI Chat conservative fallback omits cache, strict schema, and reasoning fields", async () => {
	let wire: Record<string, unknown> | undefined;
	const result = await streamOpenAIChat(conservativeModel("openai-completions"), context(), {
		apiKey: "fixture-key",
		cacheRetention: "long",
		sessionId: "private-session",
		reasoningEffort: "high",
		fetch: async (_input, init) => {
			wire = JSON.parse(String(init?.body)) as Record<string, unknown>;
			return openAIChatResponse();
		},
	}).result();
	assert.equal(result.stopReason, "stop");
	assert.ok(wire);
	assert.equal(wire.prompt_cache_key, undefined);
	assert.equal(wire.prompt_cache_retention, undefined);
	assert.equal(wire.reasoning_effort, undefined);
	assert.equal(wire.reasoning, undefined);
	assert.equal(wire.tools, undefined);
	assert.equal(wire.tool_choice, undefined);
});

test("Codex conservative fallback forces SSE-safe body capabilities", () => {
	const model = conservativeModel("openai-codex-responses");
	const body = buildOpenAICodexRequestBody(model, context(), {
		cacheRetention: "long",
		reasoningEffort: "high",
	}, "private-session");
	assert.equal(body.prompt_cache_key, undefined);
	assert.equal(body.parallel_tool_calls, false);
	assert.equal(body.reasoning, undefined);
	assert.equal(body.include, undefined);
	assert.equal(body.tools, undefined);
	assert.equal(body.tool_choice, undefined);
});

test("Mistral and Pi Messages omit unsupported tool, cache, and reasoning intent", async () => {
	let mistralWire: Record<string, unknown> | undefined;
	await streamMistral(conservativeModel("mistral-conversations"), context(), {
		apiKey: "fixture-key",
		cacheRetention: "long",
		sessionId: "private-session",
		reasoningEffort: "high",
		toolChoice: "required",
		fetch: async (_input, init) => {
			mistralWire = JSON.parse(String(init?.body)) as Record<string, unknown>;
			return mistralResponse();
		},
	}).result();
	assert.ok(mistralWire);
	assert.equal(mistralWire.tools, undefined);
	assert.equal(mistralWire.toolChoice, undefined);
	assert.equal(mistralWire.promptCacheKey, undefined);
	assert.equal(mistralWire.reasoningEffort, undefined);

	let piWire: Record<string, unknown> | undefined;
	await streamPiMessages(conservativeModel("pi-messages"), context(), {
		apiKey: "fixture-key",
		cacheRetention: "long",
		sessionId: "private-session",
		reasoning: "high",
		toolChoice: "required",
		onPayload: (payload) => {
			piWire = payload as Record<string, unknown>;
		},
		fetch: async () => new Response("fixture stop", { status: 500 }),
	}).result();
	assert.ok(piWire);
	assert.equal((piWire.context as Context).tools, undefined);
	const piOptions = piWire.options as Record<string, unknown>;
	assert.equal(piOptions.cacheRetention, "none");
	assert.equal(piOptions.reasoning, undefined);
	assert.equal(piOptions.toolChoice, undefined);
});

test("Kimi deferred-tool system carriers contribute tool identity without instruction drift", async () => {
	const base = conservativeModel("openai-completions");
	const kimiModel = withModelProfile(
		{
			...base,
			profileSource: undefined,
			capabilities: undefined,
			costKnown: true,
			compat: { deferredToolsMode: "kimi", supportsStrictMode: false },
		},
		"explicit-custom",
	);
	const read: Tool = { name: "read", description: "read", parameters: { type: "object", properties: {} } };
	const write: Tool = { name: "write", description: "write", parameters: { type: "object", properties: {} } };
	const observe = async (requestContext: Context): Promise<EffectiveDispatchObservation> => {
		let observation: EffectiveDispatchObservation | undefined;
		await streamOpenAIChat(kimiModel, requestContext, {
			apiKey: "fixture-key",
			fetch: async () => openAIChatResponse(),
			onEffectiveDispatch: (value) => {
				observation = value;
			},
		}).result();
		assert.ok(observation);
		return observation;
	};

	const before = await observe({ systemPrompt: "system", messages: [], tools: [read] });
	const after = await observe({
		systemPrompt: "system",
		messages: [
			{
				role: "toolResult",
				toolCallId: "call-write",
				toolName: "load_tool",
				content: [{ type: "text", text: "loaded" }],
				addedToolNames: ["write"],
				isError: false,
				timestamp: 1,
			},
		],
		tools: [read, write],
	});
	assert.equal(before.instructionsHash, after.instructionsHash);
	assert.equal(before.toolCount, 1);
	assert.equal(after.toolCount, 2);
	assert.notEqual(before.toolIdentifierSetHash, after.toolIdentifierSetHash);
	assert.equal(JSON.stringify(after).includes("write"), false);
});
