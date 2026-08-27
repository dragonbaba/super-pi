import assert from "node:assert/strict";
import test from "node:test";
import { streamSimple as streamAnthropic } from "../../packages/ai/src/api/anthropic-messages.ts";
import { streamSimple as streamBedrock } from "../../packages/ai/src/api/bedrock-converse-stream.ts";
import { streamSimple as streamGoogle } from "../../packages/ai/src/api/google-generative-ai.ts";
import { streamSimple as streamVertex } from "../../packages/ai/src/api/google-vertex.ts";
import { streamSimple as streamMistral } from "../../packages/ai/src/api/mistral-conversations.ts";
import { streamSimple as streamOpenAIChat } from "../../packages/ai/src/api/openai-completions.ts";
import { transformMessages } from "../../packages/ai/src/api/transform-messages.ts";
import { deriveModelCapabilities, sanitizeCapabilityRequest } from "../../packages/ai/src/model-capabilities.ts";
import { googleProvider } from "../../packages/ai/src/providers/google.ts";
import { googleVertexProvider } from "../../packages/ai/src/providers/google-vertex.ts";
import { mistralProvider } from "../../packages/ai/src/providers/mistral.ts";
import type {
	Api,
	Context,
	Model,
	ModelCapabilitiesV1,
	SimpleStreamOptions,
	StreamFunction,
	Tool,
} from "../../packages/ai/src/types.ts";

const CAPTURE_ERROR = "authority payload captured";

const STRICT_TOOL: Tool = {
	name: "lookup",
	description: "lookup",
	parameters: { type: "object", properties: { query: { type: "string" } } },
	constrainedSampling: { type: "json_schema", strict: "prefer" },
};

function context(): Context {
	return {
		systemPrompt: "authority system",
		messages: [{ role: "user", content: "hello", timestamp: 1 }],
		tools: [STRICT_TOOL],
	};
}

function fixtureModel<TApi extends Api>(api: TApi, overrides: Partial<Model<TApi>> = {}): Model<TApi> {
	const model: Model<TApi> = {
		id: "authority-fixture",
		name: "Authority Fixture",
		api,
		provider: "fixture",
		baseUrl: "https://fixture.invalid/v1",
		reasoning: true,
		thinkingLevelMap: { off: "none", minimal: "minimal", low: "low", medium: "medium", high: "high" },
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 32_768,
		maxTokens: 4_096,
		...overrides,
	};
	return model;
}

function withCapabilities<TApi extends Api>(
	model: Model<TApi>,
	overrides: Partial<ModelCapabilitiesV1>,
): Model<TApi> {
	return { ...model, capabilities: { ...deriveModelCapabilities(model as Model<Api>), ...overrides } };
}

async function capture<TApi extends Api>(
	stream: StreamFunction<TApi, SimpleStreamOptions>,
	model: Model<TApi>,
	options: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
	let payload: Record<string, unknown> | undefined;
	await stream(model, context(), {
		apiKey: "fixture-key",
		...options,
		onPayload: (value) => {
			payload = structuredClone(value as Record<string, unknown>);
			throw new Error(CAPTURE_ERROR);
		},
	} as SimpleStreamOptions).result();
	assert.ok(payload);
	return payload;
}

test("built-in Gemini 3 and Mistral preserve positive strict schema authority", async () => {
	const googleModel = googleProvider().getModels().find((model) => model.id === "gemini-3.1-pro-preview");
	const mistralModel = mistralProvider().getModels().find((model) => model.id === "mistral-large-latest");
	assert.ok(googleModel);
	assert.ok(mistralModel);

	const googlePayload = await capture(streamGoogle, googleModel);
	const googleConfig = googlePayload.config as Record<string, unknown>;
	const googleToolConfig = googleConfig.toolConfig as { functionCallingConfig?: { mode?: string } };
	assert.equal(googleToolConfig.functionCallingConfig?.mode, "VALIDATED");
	const googleTools = googleConfig.tools as Array<{ functionDeclarations: Array<Record<string, unknown>> }>;
	const googleSchema = googleTools[0]!.functionDeclarations[0]!.parametersJsonSchema as Record<string, unknown>;
	assert.deepEqual(googleSchema.required, ["query"]);
	assert.equal(googleSchema.additionalProperties, false);

	const mistralPayload = await capture(streamMistral, mistralModel);
	const mistralTools = mistralPayload.tools as Array<{ function: Record<string, unknown> }>;
	assert.equal(mistralTools[0]!.function.strict, true);
});

test("explicit strictToolSchema=false disables Google and Mistral strict schema", async () => {
	const googleBase = googleProvider().getModels().find((model) => model.id === "gemini-3.1-pro-preview");
	const mistralBase = mistralProvider().getModels().find((model) => model.id === "mistral-large-latest");
	assert.ok(googleBase);
	assert.ok(mistralBase);
	const googlePayload = await capture(streamGoogle, withCapabilities(googleBase, { strictToolSchema: false }));
	const googleConfig = googlePayload.config as Record<string, unknown>;
	const googleTools = googleConfig.tools as Array<{ functionDeclarations: Array<Record<string, unknown>> }>;
	const googleSchema = googleTools[0]!.functionDeclarations[0]!.parametersJsonSchema as Record<string, unknown>;
	assert.equal(googleSchema.required, undefined);
	assert.equal(googleSchema.additionalProperties, undefined);

	const mistralPayload = await capture(streamMistral, withCapabilities(mistralBase, { strictToolSchema: false }));
	const mistralTools = mistralPayload.tools as Array<{ function: Record<string, unknown> }>;
	assert.equal(mistralTools[0]!.function.strict, false);
});

test("samplingParams cannot replace structural request authority", async () => {
	const model = withCapabilities(fixtureModel("openai-completions"), {
		toolCalling: true,
		parallelTools: true,
		strictToolSchema: true,
		reasoning: { mode: "levels", levels: ["off", "low"] },
		promptCache: { mode: "implicit", retention: true },
		previousResponseId: true,
	});
	const payload = await capture(streamOpenAIChat, model, {
		reasoning: "low",
		samplingParams: {
			messages: [{ role: "assistant", tool_calls: [{ id: "injected-call" }], cache_control: { ttl: "1h" } }],
			input: [{ type: "reasoning", encrypted_content: "injected-reasoning" }],
			instructions: "injected instructions",
			tools: [{ type: "function", function: { name: "injected-tool", strict: true, cache_control: { ttl: "1h" } } }],
			tool_choice: "required",
			parallel_tool_calls: true,
			previous_response_id: "injected-response",
			reasoning: { effort: "high", encrypted_content: "injected" },
			thinking: { type: "enabled", budget_tokens: 999_999 },
			prompt_cache_key: "injected-cache",
			prompt_cache_retention: "24h",
			cache_control: { type: "ephemeral", ttl: "1h" },
			cachePoint: { type: "default" },
			cachedContent: "projects/private/cachedContents/secret",
			top_p: 0.25,
		},
	});
	assert.equal(payload.top_p, 0.25);
	assert.equal(payload.instructions, undefined);
	assert.equal(payload.input, undefined);
	assert.equal(payload.previous_response_id, undefined);
	assert.equal(payload.thinking, undefined);
	assert.equal(payload.cachePoint, undefined);
	assert.equal(payload.cachedContent, undefined);
	const messages = payload.messages as Array<Record<string, unknown>>;
	assert.equal(JSON.stringify(messages).includes("injected-call"), false);
	const tools = payload.tools as Array<{ function: { name: string } }>;
	assert.deepEqual(tools.map((tool) => tool.function.name), ["lookup"]);
});

test("parallelTools and previousResponseId gates are independent of toolCalling", async () => {
	const model = withCapabilities(fixtureModel("openai-completions"), {
		toolCalling: true,
		parallelTools: false,
		strictToolSchema: true,
		previousResponseId: false,
	});
	const payload = await capture(streamOpenAIChat, model, {
		samplingParams: { parallel_tool_calls: true, previous_response_id: "injected-response" },
	});
	assert.ok(payload.tools);
	assert.equal(payload.parallel_tool_calls, undefined);
	assert.equal(payload.previous_response_id, undefined);
});

test("parallelTools and previousResponseId preserve positive authority independently", () => {
	const enabled = withCapabilities(fixtureModel("openai-completions"), {
		toolCalling: true,
		parallelTools: true,
		previousResponseId: true,
	});
	const payload = sanitizeCapabilityRequest(enabled, {
		tools: [{ type: "function", function: { name: "lookup" } }],
		parallel_tool_calls: true,
		previous_response_id: "response-1",
	});
	assert.equal(payload.parallel_tool_calls, true);
	assert.equal(payload.previous_response_id, "response-1");
});

test("reasoning modes control Google, Vertex, Anthropic, and Bedrock wire branches", async () => {
	const mandatoryLevels: ModelCapabilitiesV1["reasoning"] = { mode: "levels", levels: ["low", "high"] };
	const google = withCapabilities(fixtureModel("google-generative-ai", { id: "custom-google-levels" }), {
		reasoning: mandatoryLevels,
	});
	const googlePayload = await capture(streamGoogle, google);
	const googleThinking = (googlePayload.config as { thinkingConfig: Record<string, unknown> }).thinkingConfig;
	assert.equal(googleThinking.thinkingLevel, "LOW");
	assert.equal(googleThinking.thinkingBudget, undefined);

	const vertex = withCapabilities(fixtureModel("google-vertex", { id: "custom-vertex-budget" }), {
		reasoning: { mode: "budget", levels: ["off", "low", "high"] },
	});
	const vertexPayload = await capture(streamVertex, vertex, { project: "fixture", location: "us-central1", reasoning: "low" });
	const vertexThinking = (vertexPayload.config as { thinkingConfig: Record<string, unknown> }).thinkingConfig;
	assert.equal(typeof vertexThinking.thinkingBudget, "number");
	assert.equal(vertexThinking.thinkingLevel, undefined);

	const anthropic = withCapabilities(fixtureModel("anthropic-messages"), {
		reasoning: { mode: "adaptive", levels: ["low", "high"] },
	});
	const anthropicPayload = await capture(streamAnthropic, anthropic, { reasoning: "low" });
	assert.deepEqual(anthropicPayload.thinking, { type: "adaptive", display: "summarized" });

	const bedrock = withCapabilities(fixtureModel("bedrock-converse-stream", {
		id: "custom-bedrock-adaptive",
		provider: "amazon-bedrock",
		name: "Custom Claude",
	}), { reasoning: { mode: "adaptive", levels: ["low", "high"] } });
	const bedrockPayload = await capture(streamBedrock, bedrock, {
		reasoning: "low",
		env: { AWS_REGION: "us-east-1" },
	});
	const additional = bedrockPayload.additionalModelRequestFields as Record<string, unknown>;
	assert.deepEqual(additional.thinking, { type: "adaptive", display: "summarized" });
});

test("built-in Vertex Gemini 3 profile owns levels reasoning mode", () => {
	const model = googleVertexProvider().getModels().find((entry) => entry.id === "gemini-3.1-pro-preview");
	assert.ok(model);
	assert.equal(model.capabilities?.reasoning.mode, "levels");
});

test("thoughtSignatureRoundTrip independently controls same-model signature replay", () => {
	const base = fixtureModel("openai-completions");
	const message = {
		role: "assistant" as const,
		content: [
			{ type: "thinking" as const, thinking: "private summary", thinkingSignature: "thinking-signature" },
			{ type: "text" as const, text: "answer", textSignature: "text-signature" },
			{ type: "toolCall" as const, id: "call", name: "lookup", arguments: {}, thoughtSignature: "tool-signature" },
		],
		api: base.api,
		provider: base.provider,
		model: base.id,
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "toolUse" as const,
		timestamp: 1,
	};
	const disabled = transformMessages([message], withCapabilities(base, { thoughtSignatureRoundTrip: false }));
	const disabledContent = disabled[0]!.role === "assistant" ? disabled[0]!.content : [];
	assert.equal(disabledContent.some((block) => "thinkingSignature" in block && block.thinkingSignature), false);
	assert.equal(disabledContent.some((block) => "textSignature" in block && block.textSignature), false);
	assert.equal(disabledContent.some((block) => "thoughtSignature" in block && block.thoughtSignature), false);

	const enabled = transformMessages([message], withCapabilities(base, { thoughtSignatureRoundTrip: true }));
	assert.deepEqual(enabled[0], message);
});
