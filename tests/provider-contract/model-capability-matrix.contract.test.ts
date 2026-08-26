import assert from "node:assert/strict";
import test from "node:test";
import { streamSimple as streamAnthropic } from "../../packages/ai/src/api/anthropic-messages.ts";
import { streamSimple as streamAzure } from "../../packages/ai/src/api/azure-openai-responses.ts";
import { streamSimple as streamBedrock } from "../../packages/ai/src/api/bedrock-converse-stream.ts";
import { streamSimple as streamGoogle } from "../../packages/ai/src/api/google-generative-ai.ts";
import { streamSimple as streamVertex } from "../../packages/ai/src/api/google-vertex.ts";
import { streamSimple as streamMistral } from "../../packages/ai/src/api/mistral-conversations.ts";
import { streamSimple as streamCodex } from "../../packages/ai/src/api/openai-codex-responses.ts";
import { streamSimple as streamOpenAIChat } from "../../packages/ai/src/api/openai-completions.ts";
import { streamSimple as streamOpenAIResponses } from "../../packages/ai/src/api/openai-responses.ts";
import { streamSimple as streamPiMessages } from "../../packages/ai/src/api/pi-messages.ts";
import { conservativeModelCapabilities } from "../../packages/ai/src/model-capabilities.ts";
import type {
	Api,
	Context,
	Model,
	ModelCapabilitiesV1,
	SimpleStreamOptions,
	StreamFunction,
	Tool,
} from "../../packages/ai/src/types.ts";

const CAPTURE_ERROR = "capability matrix payload captured";

interface AdapterCase<TApi extends Api = Api> {
	name: string;
	api: TApi;
	stream: StreamFunction<TApi, SimpleStreamOptions>;
	id: string;
	baseUrl: string;
	provider?: string;
	options?: Record<string, unknown>;
}

const ADAPTERS: readonly AdapterCase[] = [
	{ name: "Anthropic", api: "anthropic-messages", stream: streamAnthropic as never, id: "claude-sonnet-4-5", baseUrl: "https://api.anthropic.com" },
	{ name: "OpenAI Chat", api: "openai-completions", stream: streamOpenAIChat as never, id: "gpt-5", baseUrl: "https://api.openai.com/v1" },
	{ name: "OpenAI Responses", api: "openai-responses", stream: streamOpenAIResponses as never, id: "gpt-5", baseUrl: "https://api.openai.com/v1" },
	{ name: "Azure Responses", api: "azure-openai-responses", stream: streamAzure as never, id: "deployment", baseUrl: "https://fixture.openai.azure.com/openai/deployments/deployment" },
	{ name: "Codex", api: "openai-codex-responses", stream: streamCodex as never, id: "gpt-5-codex", baseUrl: "https://chatgpt.com/backend-api", provider: "openai-codex", options: { transport: "sse" } },
	{ name: "Google", api: "google-generative-ai", stream: streamGoogle as never, id: "gemini-3-flash-preview", baseUrl: "https://generativelanguage.googleapis.com" },
	{ name: "Vertex", api: "google-vertex", stream: streamVertex as never, id: "gemini-3-flash-preview", baseUrl: "https://aiplatform.googleapis.com", options: { project: "fixture", location: "us-central1" } },
	{ name: "Mistral", api: "mistral-conversations", stream: streamMistral as never, id: "mistral-large", baseUrl: "https://api.mistral.ai/v1" },
	{ name: "Bedrock", api: "bedrock-converse-stream", stream: streamBedrock as never, id: "anthropic.claude-3-7-sonnet", baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com", options: { env: { AWS_REGION: "us-east-1" } } },
	{ name: "Pi Messages", api: "pi-messages", stream: streamPiMessages as never, id: "pi-model", baseUrl: "https://fixture.invalid/v1" },
];

const STRICT_TOOL: Tool = {
	name: "lookup",
	description: "lookup",
	parameters: { type: "object", properties: { query: { type: "string" } } },
	constrainedSampling: { type: "json_schema", strict: "prefer" },
};

function capabilities(enabled: boolean): ModelCapabilitiesV1 {
	if (!enabled) return conservativeModelCapabilities();
	return {
		...conservativeModelCapabilities(),
		toolCalling: true,
		parallelTools: true,
		strictToolSchema: false,
		streamedToolArguments: true,
		reasoning: { mode: "levels", levels: ["off", "low"] },
		promptCache: { mode: "implicit", retention: false },
	};
}

function adapterModel(adapter: AdapterCase, enabled: boolean): Model<Api> {
	return {
		id: adapter.id,
		name: adapter.id,
		api: adapter.api,
		provider: adapter.provider ?? "fixture",
		baseUrl: adapter.baseUrl,
		reasoning: enabled,
		thinkingLevelMap: { off: "none", minimal: "minimal", low: "low", high: "high" },
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 32_768,
		maxTokens: 4_096,
		profileSource: enabled ? "explicit-custom" : "conservative-fallback",
		costKnown: enabled,
		capabilities: capabilities(enabled),
		compat: {
			supportsStrictMode: true,
			supportsStrictTools: true,
			supportsLongCacheRetention: true,
			supportsCacheControlOnTools: true,
			supportsReasoningEffort: true,
			thinkingFormat: "openai",
		},
	};
}

function toolHistoryContext(): Context {
	return {
		systemPrompt: "matrix system",
		tools: [STRICT_TOOL],
		messages: [
			{ role: "user", content: "start", timestamp: 1 },
			{
				role: "assistant",
				content: [{ type: "toolCall", id: "matrix-call", name: "lookup", arguments: { query: "value" }, thoughtSignature: "c2ln" }],
				api: "openai-completions",
				provider: "fixture",
				model: "prior",
				usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
				stopReason: "toolUse",
				timestamp: 2,
			},
			{ role: "toolResult", toolCallId: "matrix-call", toolName: "lookup", content: [{ type: "text", text: "done" }], isError: false, timestamp: 3 },
		],
	};
}

function codexToken(): string {
	const body = btoa(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "fixture" } }));
	return `header.${body}.signature`;
}

async function capturePayload(adapter: AdapterCase, enabled: boolean): Promise<Record<string, unknown>> {
	let payload: Record<string, unknown> | undefined;
	const apiKey = adapter.api === "openai-codex-responses" ? codexToken() : "fixture-key";
	const options = {
		apiKey,
		reasoning: "high",
		cacheRetention: "long",
		sessionId: "matrix-session",
		toolChoice: "auto",
		samplingParams: {
			tools: [{ type: "function", function: { name: "injected", strict: true, parameters: {} } }],
			tool_choice: "required",
			parallel_tool_calls: true,
			reasoning_effort: "high",
			prompt_cache_key: "injected-cache",
			prompt_cache_retention: "24h",
		},
		...adapter.options,
		onPayload: (value: unknown) => {
			payload = structuredClone(value as Record<string, unknown>);
			throw new Error(CAPTURE_ERROR);
		},
	} as SimpleStreamOptions;
	await adapter.stream(adapterModel(adapter, enabled) as never, toolHistoryContext(), options).result();
	assert.ok(payload, `${adapter.name} did not reach onPayload`);
	return payload;
}

function walk(value: unknown, visit: (key: string | undefined, value: unknown) => void, key?: string): void {
	visit(key, value);
	if (Array.isArray(value)) {
		for (const entry of value) walk(entry, visit);
	} else if (value && typeof value === "object") {
		for (const [childKey, child] of Object.entries(value)) walk(child, visit, childKey);
	}
}

function assertNoNativeToolProtocol(adapter: AdapterCase, payload: Record<string, unknown>): void {
	const forbiddenKeys = new Set([
		"tools", "tool_choice", "toolChoice", "parallel_tool_calls", "parallelToolCalls", "toolConfig",
		"tool_calls", "tool_call_id", "toolCallId", "toolUse", "toolResult", "functionCall", "functionResponse",
		"thoughtSignature", "thinkingSignature",
	]);
	walk(payload, (key, value) => {
		if (key && value !== undefined) assert.equal(forbiddenKeys.has(key), false, `${adapter.name} leaked ${key}`);
		if (key === "role") assert.notEqual(value, "tool", `${adapter.name} leaked tool role`);
	});
}

function assertNoCapabilityFields(adapter: AdapterCase, payload: Record<string, unknown>): void {
	const forbidden = new Set([
		"reasoning", "reasoning_effort", "reasoningEffort", "thinking", "thinkingConfig", "thinking_token_budget",
		"prompt_cache_key", "promptCacheKey", "prompt_cache_retention", "promptCacheRetention", "cachedContent",
		"cache_control", "cachePoint",
	]);
	walk(payload, (key, value) => {
		if (key && value !== undefined) assert.equal(forbidden.has(key), false, `${adapter.name} leaked ${key}`);
	});
}

function assertStrictDisabled(adapter: AdapterCase, payload: Record<string, unknown>): void {
	walk(payload, (key, value) => {
		if (key === "strict") assert.notEqual(value, true, `${adapter.name} enabled strict tools`);
		if (key === "additionalProperties") assert.notEqual(value, false, `${adapter.name} strict-normalized schema`);
	});
}

for (const adapter of ADAPTERS) {
	test(`${adapter.name} capability-off wire omits tools, cache, reasoning, injected fields, and prior tool protocol`, async () => {
		const payload = await capturePayload(adapter, false);
		assertNoNativeToolProtocol(adapter, payload);
		assertNoCapabilityFields(adapter, payload);
	});

	test(`${adapter.name} capability-on wire clamps reasoning levels, strict schema, and long retention`, async () => {
		const payload = await capturePayload(adapter, true);
		const serialized = JSON.stringify(payload);
		assert.equal(serialized.toLowerCase().includes("high"), false, `${adapter.name} did not clamp high reasoning`);
		assert.equal(serialized.includes("24h"), false, `${adapter.name} emitted 24h retention`);
		assert.equal(serialized.includes("1h"), false, `${adapter.name} emitted 1h retention`);
		assertStrictDisabled(adapter, payload);
	});
}
