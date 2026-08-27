import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { observeAnthropicEffectiveDispatch } from "../packages/ai/src/api/anthropic-messages.ts";
import { observeBedrockEffectiveDispatch } from "../packages/ai/src/api/bedrock-converse-stream.ts";
import { observeGoogleGenerativeAIEffectiveDispatch } from "../packages/ai/src/api/google-generative-ai.ts";
import { observeGoogleVertexEffectiveDispatch } from "../packages/ai/src/api/google-vertex.ts";
import {
	observeMistralEffectiveDispatch,
	stream as streamMistral,
} from "../packages/ai/src/api/mistral-conversations.ts";
import {
	observeOpenAIChatEffectiveDispatch,
	stream as streamOpenAIChat,
} from "../packages/ai/src/api/openai-completions.ts";
import { observeOpenAIResponsesEffectiveDispatch } from "../packages/ai/src/api/openai-responses.ts";
import { observePiMessagesEffectiveDispatch } from "../packages/ai/src/api/pi-messages.ts";
import type { Api, EffectiveDispatchObservation, Model, ProviderRequestOptions } from "../packages/ai/src/types.ts";
import { createEffectiveDispatchBenchmarkScenario } from "../scripts/bench/effective-dispatch.ts";
import {
	buildPrefixManifest,
	comparePrefixManifests,
	type PrefixManifestBuildInput,
} from "../packages/coding-agent/src/core/prefix-manifest.ts";

function model<TApi extends Api>(api: TApi): Model<TApi> {
	return {
		id: `test-${api}`,
		name: `Test ${api}`,
		api,
		provider: "fixture",
		baseUrl: "https://example.test",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 4_096,
	};
}

function capture<TApi extends Api>(): {
	observations: EffectiveDispatchObservation[];
	options: ProviderRequestOptions<Model<TApi>>;
} {
	const observations: EffectiveDispatchObservation[] = [];
	return {
		observations,
		options: { onEffectiveDispatch: (observation) => { observations.push(observation); } },
	};
}

function assertMetadataOnly(observations: readonly EffectiveDispatchObservation[], secrets: readonly string[]): void {
	const serialized = JSON.stringify(observations);
	for (const secret of secrets) assert.equal(serialized.includes(secret), false, `leaked ${secret}`);
}

function jsonHash(value: unknown): string {
	return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function manifestForObservation(
	observation: EffectiveDispatchObservation,
	tools: readonly string[] = [],
) {
	return buildPrefixManifest({
		provider: "fixture",
		model: "fixture-model",
		api: "fixture-api",
		transport: "sse",
		systemPrompt: "fixed system prompt",
		tools: tools.map((name) => ({ name, schema: {} })),
		previousResponseMode: "none",
		effectiveDispatch: observation,
	});
}

function observeOne<TApi extends Api>(
	observe: (options: ProviderRequestOptions<Model<TApi>>, model: Model<TApi>) => void,
	api: TApi,
): EffectiveDispatchObservation {
	const captured = capture<TApi>();
	observe(captured.options, model(api));
	return captured.observations[0]!;
}

function openAIChatResponse(): Response {
	const chunk = {
		id: "chatcmpl-test",
		object: "chat.completion.chunk",
		created: 1,
		model: "test-openai-completions",
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

async function runOpenAIChatAdapter(systemPrompt: string, tools: string[]): Promise<EffectiveDispatchObservation> {
	const captured = capture<"openai-completions">();
	await streamOpenAIChat(model("openai-completions"), {
		systemPrompt,
		messages: [{ role: "user", content: "hello", timestamp: 1 }],
		tools: tools.map((name) => ({ name, description: name, parameters: { type: "object", properties: {} } })),
	}, {
		apiKey: "test-key",
		fetch: async () => openAIChatResponse(),
		onEffectiveDispatch: (observation) => { captured.observations.push(observation); },
	}).result();
	return captured.observations[0]!;
}

async function runMistralAdapter(systemPrompt: string): Promise<EffectiveDispatchObservation> {
	const captured = capture<"mistral-conversations">();
	await streamMistral(model("mistral-conversations"), {
		systemPrompt,
		messages: [{ role: "user", content: "hello", timestamp: 1 }],
		tools: [{ name: "lookup", description: "lookup", parameters: { type: "object", properties: {} } }],
	}, {
		apiKey: "test-key",
		fetch: async () => mistralResponse(),
		onEffectiveDispatch: (observation) => { captured.observations.push(observation); },
	}).result();
	return captured.observations[0]!;
}

test("real OpenAI Chat adapter changes effective hashes for system and tool wire changes", async () => {
	const systemA = await runOpenAIChatAdapter("adapter-system-A", ["read"]);
	const systemB = await runOpenAIChatAdapter("adapter-system-B", ["read"]);
	const write = await runOpenAIChatAdapter("adapter-system-A", ["write"]);
	assert.notEqual(systemA.instructionsHash, systemB.instructionsHash);
	assert.notEqual(systemA.prefixHash, systemB.prefixHash);
	assert.notEqual(systemA.toolOrderHash, write.toolOrderHash);
	assertMetadataOnly([systemA, systemB, write], ["adapter-system-A", "adapter-system-B", "read", "write"]);
});

test("real Mistral adapter changes effective hashes for system wire changes", async () => {
	const systemA = await runMistralAdapter("adapter-mistral-A");
	const systemB = await runMistralAdapter("adapter-mistral-B");
	assert.notEqual(systemA.instructionsHash, systemB.instructionsHash);
	assert.notEqual(systemA.prefixHash, systemB.prefixHash);
	assertMetadataOnly([systemA, systemB], ["adapter-mistral-A", "adapter-mistral-B", "lookup"]);
});

test("OpenAI Chat observes system/developer messages and function tool identity from wire shape", () => {
	const first = capture<"openai-completions">();
	const second = capture<"openai-completions">();
	const third = capture<"openai-completions">();
	const chatModel = model("openai-completions");
	const payload = (system: string, toolName: string) => ({
		model: chatModel.id,
		stream: true,
		messages: [
			{ role: "system", content: system },
			{ role: "developer", content: "developer-secret" },
			{ role: "user", content: "user content is not an instruction" },
		],
		tools: [{ type: "function", function: { name: toolName, description: `${toolName}-secret`, parameters: {} } }],
	});
	observeOpenAIChatEffectiveDispatch(first.options as never, chatModel, payload("system-A-secret", "read") as never);
	observeOpenAIChatEffectiveDispatch(second.options as never, chatModel, payload("system-B-secret", "read") as never);
	observeOpenAIChatEffectiveDispatch(third.options as never, chatModel, payload("system-A-secret", "write") as never);

	assert.notEqual(first.observations[0]?.instructionsHash, second.observations[0]?.instructionsHash);
	assert.notEqual(first.observations[0]?.prefixHash, second.observations[0]?.prefixHash);
	assert.notEqual(first.observations[0]?.toolOrderHash, third.observations[0]?.toolOrderHash);
	assertMetadataOnly([...first.observations, ...second.observations, ...third.observations], [
		"system-A-secret", "system-B-secret", "developer-secret", "read-secret", "write-secret",
	]);
});

test("OpenAI Chat effective dispatch observation works when the browser has no process global", () => {
	const processDescriptor = Object.getOwnPropertyDescriptor(globalThis, "process");
	const captured = capture<"openai-completions">();
	const chatModel = model("openai-completions");
	try {
		Object.defineProperty(globalThis, "process", {
			configurable: true,
			value: undefined,
			writable: true,
		});
		observeOpenAIChatEffectiveDispatch(captured.options as never, chatModel, {
			model: chatModel.id,
			stream: true,
			messages: [{ role: "system", content: "browser-system-secret" }],
			tools: [{
				type: "function",
				function: { name: "browser-tool", description: "browser-tool-secret", parameters: {} },
			}],
		} as never);
	} finally {
		if (processDescriptor) Object.defineProperty(globalThis, "process", processDescriptor);
		else Reflect.deleteProperty(globalThis, "process");
	}

	assert.equal(captured.observations.length, 1);
	assert.equal(captured.observations[0]?.toolCount, 1);
	assert.equal(
		captured.observations[0]?.instructionsHash,
		jsonHash([{ role: "system", content: "browser-system-secret" }]),
	);
	assert.match(captured.observations[0]?.prefixHash ?? "", /^[a-f0-9]{64}$/);
	assertMetadataOnly(captured.observations, ["browser-system-secret", "browser-tool-secret", "browser-tool"]);
});

test("Mistral observes system messages and tools[].function.name from wire shape", () => {
	const first = capture<"mistral-conversations">();
	const second = capture<"mistral-conversations">();
	const mistralModel = model("mistral-conversations");
	const payload = (system: string) => ({
		model: mistralModel.id,
		stream: true,
		messages: [{ role: "system", content: system }, { role: "user", content: "hello" }],
		tools: [{ type: "function", function: { name: "lookup", description: "lookup-secret", parameters: {} } }],
	});
	observeMistralEffectiveDispatch(first.options as never, mistralModel, payload("mistral-A-secret"));
	observeMistralEffectiveDispatch(second.options as never, mistralModel, payload("mistral-B-secret"));

	assert.notEqual(first.observations[0]?.instructionsHash, second.observations[0]?.instructionsHash);
	assert.notEqual(first.observations[0]?.prefixHash, second.observations[0]?.prefixHash);
	assertMetadataOnly([...first.observations, ...second.observations], ["mistral-A-secret", "mistral-B-secret", "lookup-secret"]);
});

test("Bedrock observes system and every toolConfig.tools[].toolSpec in order", () => {
	const captured = capture<"bedrock-converse-stream">();
	const bedrockModel = model("bedrock-converse-stream");
	observeBedrockEffectiveDispatch(captured.options as never, bedrockModel, {
		modelId: bedrockModel.id,
		system: [{ text: "bedrock-system-secret" }],
		toolConfig: { tools: [
			{ toolSpec: { name: "read", description: "read-secret", inputSchema: { json: {} } } },
			{ toolSpec: { name: "write", description: "write-secret", inputSchema: { json: {} } } },
		] },
	});

	assert.equal(captured.observations[0]?.toolCount, 2);
	assertMetadataOnly(captured.observations, ["bedrock-system-secret", "read-secret", "write-secret"]);
});

test("Google preserves flattened function declaration order across tool groups", () => {
	const forward = capture<"google-generative-ai">();
	const reverse = capture<"google-generative-ai">();
	const googleModel = model("google-generative-ai");
	const params = (names: string[]) => ({
		model: googleModel.id,
		contents: [],
		config: {
			systemInstruction: "google-system-secret",
			tools: [
				{ functionDeclarations: [{ name: names[0], description: `${names[0]}-secret` }] },
				{ functionDeclarations: [{ name: names[1], description: `${names[1]}-secret` }] },
			],
		},
	});
	observeGoogleGenerativeAIEffectiveDispatch(forward.options as never, googleModel, params(["read", "write"]) as never);
	observeGoogleGenerativeAIEffectiveDispatch(reverse.options as never, googleModel, params(["write", "read"]) as never);

	assert.equal(forward.observations[0]?.toolCount, 2);
	assert.notEqual(forward.observations[0]?.toolOrderHash, reverse.observations[0]?.toolOrderHash);
	assert.equal(forward.observations[0]?.toolIdentifierSetHash, reverse.observations[0]?.toolIdentifierSetHash);
	assertMetadataOnly([...forward.observations, ...reverse.observations], ["google-system-secret", "read-secret", "write-secret"]);
});

test("Google provider-native tool groups participate in effective identity", () => {
	const withoutNative = capture<"google-generative-ai">();
	const withNative = capture<"google-generative-ai">();
	const googleModel = model("google-generative-ai");
	const params = (tools: unknown[]) => ({
		model: googleModel.id,
		contents: [],
		config: { systemInstruction: "system", tools },
	});
	observeGoogleGenerativeAIEffectiveDispatch(withoutNative.options as never, googleModel, params([]) as never);
	observeGoogleGenerativeAIEffectiveDispatch(withNative.options as never, googleModel, params([
		{ googleSearch: { timeRangeFilter: { startTime: "2026-01-01T00:00:00Z" } } },
	]) as never);

	assert.equal(withoutNative.observations[0]?.toolCount, 0);
	assert.equal(withNative.observations[0]?.toolCount, 1);
	assert.notEqual(withoutNative.observations[0]?.toolOrderHash, withNative.observations[0]?.toolOrderHash);
	assert.notEqual(withoutNative.observations[0]?.toolIdentifierSetHash, withNative.observations[0]?.toolIdentifierSetHash);
	assert.notEqual(withoutNative.observations[0]?.prefixHash, withNative.observations[0]?.prefixHash);
});

test("Anthropic, OpenAI Responses, and Pi Messages use their actual top-level wire families", () => {
	const anthropic = capture<"anthropic-messages">();
	const responses = capture<"openai-responses">();
	const pi = capture<"pi-messages">();
	observeAnthropicEffectiveDispatch(anthropic.options as never, model("anthropic-messages"), {
		model: "claude-test",
		stream: true,
		max_tokens: 64,
		messages: [],
		system: [{ type: "text", text: "anthropic-secret" }],
		tools: [{ name: "anthropic-tool", description: "anthropic-tool-secret", input_schema: { type: "object" } }],
	} as never);
	observeOpenAIResponsesEffectiveDispatch(responses.options as never, model("openai-responses"), {
		model: "gpt-test",
		stream: true,
		input: [],
		instructions: "responses-secret",
		tools: [{ type: "function", name: "responses-tool", description: "responses-tool-secret", parameters: {} }],
	} as never);
	observePiMessagesEffectiveDispatch(pi.options as never, model("pi-messages"), {
		model: "pi-test",
		context: {
			systemPrompt: "pi-secret",
			messages: [],
			tools: [{ name: "pi-tool", description: "pi-tool-secret", parameters: {} }],
		},
		options: { sessionId: "pi-session-secret" },
	});

	assert.equal(anthropic.observations[0]?.toolCount, 1);
	assert.equal(responses.observations[0]?.toolCount, 1);
	assert.equal(pi.observations[0]?.toolCount, 1);
	assertMetadataOnly([...anthropic.observations, ...responses.observations, ...pi.observations], [
		"anthropic-secret", "anthropic-tool-secret", "responses-secret", "responses-tool-secret",
		"pi-secret", "pi-tool-secret", "pi-session-secret",
	]);
});

test("provider-resolved retention hashes change without contaminating policy hashes", () => {
	const observePair = <TApi extends Api>(
		observe: (captured: ReturnType<typeof capture<TApi>>, long: boolean) => void,
	): [EffectiveDispatchObservation, EffectiveDispatchObservation] => {
		const short = capture<TApi>();
		const long = capture<TApi>();
		observe(short, false);
		observe(long, true);
		return [short.observations[0]!, long.observations[0]!];
	};
	const pairs = [
		observePair<"openai-responses">((captured, long) => {
			observeOpenAIResponsesEffectiveDispatch(captured.options as never, model("openai-responses"), {
				model: "gpt-test", stream: true, input: [],
				prompt_cache_retention: long ? "24h" : undefined,
				prompt_cache_options: { mode: "explicit" },
			} as never);
		}),
		observePair<"anthropic-messages">((captured, long) => {
			observeAnthropicEffectiveDispatch(captured.options as never, model("anthropic-messages"), {
				model: "claude-test", stream: true, max_tokens: 64, messages: [],
				system: [{ type: "text", text: "system", cache_control: {
					type: "ephemeral", ...(long ? { ttl: "1h" } : {}),
				} }],
			} as never);
		}),
		observePair<"pi-messages">((captured, long) => {
			observePiMessagesEffectiveDispatch(captured.options as never, model("pi-messages"), {
				model: "pi-test", context: { systemPrompt: "system", messages: [], tools: [] },
				options: { cacheRetention: long ? "long" : "short" },
			});
		}),
		observePair<"bedrock-converse-stream">((captured, long) => {
			observeBedrockEffectiveDispatch(captured.options as never, model("bedrock-converse-stream"), {
				modelId: "bedrock-test", messages: [],
				system: [{ cachePoint: { type: "default", ...(long ? { ttl: "1h" } : {}) } }],
			});
		}),
		observePair<"openai-completions">((captured, long) => {
			observeOpenAIChatEffectiveDispatch(captured.options as never, model("openai-completions"), {
				model: "chat-test", stream: true,
				messages: [{ role: "system", content: [{
					type: "text", text: "system", cache_control: {
						type: "ephemeral", ...(long ? { ttl: "1h" } : {}),
					},
				}] }],
			} as never);
		}),
	];

	for (const [short, long] of pairs) {
		assert.equal(typeof short.cacheRetentionHash, "string");
		assert.notEqual(short.cacheRetentionHash, long.cacheRetentionHash);
		assert.equal(typeof short.cachePolicyHash, "string");
		assert.equal(short.cachePolicyHash, long.cachePolicyHash);
		assert.notEqual(short.prefixHash, long.prefixHash);
	}
});

test("Anthropic history growth keeps cache policy and semantic boundary stable", () => {
	const marker = { type: "ephemeral", ttl: "1h" };
	const observe = (messages: unknown[]) => observeOne((options, anthropicModel) => {
		observeAnthropicEffectiveDispatch(options as never, anthropicModel, {
			model: anthropicModel.id,
			stream: true,
			max_tokens: 64,
			system: [{ type: "text", text: "system", cache_control: marker }],
			messages,
		} as never);
	}, "anthropic-messages");
	const first = observe([{ role: "user", content: [{ type: "text", text: "first", cache_control: marker }] }]);
	const grown = observe([
		{ role: "user", content: [{ type: "text", text: "first" }] },
		{ role: "assistant", content: [{ type: "text", text: "answer" }] },
		{ role: "user", content: [{ type: "text", text: "second", cache_control: marker }] },
	]);
	assert.equal(first.cacheRetentionHash, grown.cacheRetentionHash);
	assert.equal(first.cachePolicyHash, grown.cachePolicyHash);
	assert.equal(first.cacheBoundaryHash, grown.cacheBoundaryHash);
	assert.equal(comparePrefixManifests(manifestForObservation(first), manifestForObservation(grown)), undefined);
});

test("OpenAI Chat history growth keeps cache policy and semantic boundary stable", () => {
	const marker = { type: "ephemeral", ttl: "1h" };
	const observe = (messages: unknown[]) => observeOne((options, chatModel) => {
		observeOpenAIChatEffectiveDispatch(options as never, chatModel, {
			model: chatModel.id,
			stream: true,
			messages,
		} as never);
	}, "openai-completions");
	const first = observe([{ role: "user", content: [{ type: "text", text: "first", cache_control: marker }] }]);
	const grown = observe([
		{ role: "user", content: [{ type: "text", text: "first" }] },
		{ role: "assistant", content: [{ type: "text", text: "answer" }] },
		{ role: "user", content: [{ type: "text", text: "second", cache_control: marker }] },
	]);
	assert.equal(first.cacheRetentionHash, grown.cacheRetentionHash);
	assert.equal(first.cachePolicyHash, grown.cachePolicyHash);
	assert.equal(first.cacheBoundaryHash, grown.cacheBoundaryHash);
	assert.equal(comparePrefixManifests(manifestForObservation(first), manifestForObservation(grown)), undefined);
});

test("Bedrock history growth keeps cache policy and semantic boundary stable", () => {
	const marker = { type: "default", ttl: "1h" };
	const observe = (messages: unknown[]) => observeOne((options, bedrockModel) => {
		observeBedrockEffectiveDispatch(options as never, bedrockModel, {
			modelId: bedrockModel.id,
			system: [{ text: "system" }, { cachePoint: marker }],
			messages,
		} as never);
	}, "bedrock-converse-stream");
	const first = observe([{ role: "user", content: [{ text: "first" }, { cachePoint: marker }] }]);
	const grown = observe([
		{ role: "user", content: [{ text: "first" }] },
		{ role: "assistant", content: [{ text: "answer" }] },
		{ role: "user", content: [{ text: "second" }, { cachePoint: marker }] },
	]);
	assert.equal(first.cacheRetentionHash, grown.cacheRetentionHash);
	assert.equal(first.cachePolicyHash, grown.cachePolicyHash);
	assert.equal(first.cacheBoundaryHash, grown.cacheBoundaryHash);
	assert.equal(comparePrefixManifests(manifestForObservation(first), manifestForObservation(grown)), undefined);
});

test("tool activation outranks movement of the built-in last-tool cache marker", () => {
	const marker = { type: "ephemeral", ttl: "1h" };
	const observe = (toolNames: string[]) => observeOne((options, anthropicModel) => {
		observeAnthropicEffectiveDispatch(options as never, anthropicModel, {
			model: anthropicModel.id,
			stream: true,
			max_tokens: 64,
			messages: [],
			tools: toolNames.map((name, index) => ({
				name,
				description: name,
				input_schema: { type: "object" },
				...(index === toolNames.length - 1 ? { cache_control: marker } : {}),
			})),
		} as never);
	}, "anthropic-messages");
	const diagnostic = comparePrefixManifests(
		manifestForObservation(observe(["read"]), ["read"]),
		manifestForObservation(observe(["read", "write"]), ["read", "write"]),
	);
	assert.equal(diagnostic?.reasonCode, "TOOL_ACTIVATED");
});

test("cache TTL and genuine custom boundary changes have distinct diagnostics", () => {
	const observe = (ttl: string, markedMessage: number) => observeOne((options, anthropicModel) => {
		observeAnthropicEffectiveDispatch(options as never, anthropicModel, {
			model: anthropicModel.id,
			stream: true,
			max_tokens: 64,
			messages: [0, 1].map((index) => ({
				role: "user",
				content: [{
					type: "text",
					text: `message-${index}`,
					...(index === markedMessage ? { cache_control: { type: "ephemeral", ttl } } : {}),
				}],
			})),
		} as never);
	}, "anthropic-messages");
	const short = observe("5m", 1);
	const long = observe("1h", 1);
	assert.equal(
		comparePrefixManifests(manifestForObservation(short), manifestForObservation(long))?.reasonCode,
		"CACHE_RETENTION_CHANGED",
	);
	const moved = observe("5m", 0);
	assert.equal(
		comparePrefixManifests(manifestForObservation(short), manifestForObservation(moved))?.reasonCode,
		"CACHE_BOUNDARY_CHANGED",
	);
});

test("Anthropic cache metadata is neutral to system and tool component fingerprints", () => {
	const observe = (ttl?: "1h") => observeOne((options, anthropicModel) => {
		const cacheControl = { type: "ephemeral", ...(ttl ? { ttl } : {}) };
		observeAnthropicEffectiveDispatch(options as never, anthropicModel, {
			model: anthropicModel.id,
			stream: true,
			max_tokens: 64,
			messages: [],
			system: [{ type: "text", text: "system", cache_control: cacheControl }],
			tools: [{
				name: "read",
				description: "read",
				input_schema: { type: "object" },
				cache_control: cacheControl,
			}],
		} as never);
	}, "anthropic-messages");
	const short = observe();
	const long = observe("1h");
	const diagnostic = comparePrefixManifests(
		manifestForObservation(short, ["read"]),
		manifestForObservation(long, ["read"]),
	);
	assert.equal(short.instructionsHash, long.instructionsHash);
	assert.equal(short.toolsHash, long.toolsHash);
	assert.equal(diagnostic?.reasonCode, "CACHE_RETENTION_CHANGED");
});

test("OpenAI Chat compatible cache metadata is neutral to system and tool component fingerprints", () => {
	const observe = (ttl?: "1h") => observeOne((options, chatModel) => {
		const cacheControl = { type: "ephemeral", ...(ttl ? { ttl } : {}) };
		observeOpenAIChatEffectiveDispatch(options as never, chatModel, {
			model: chatModel.id,
			stream: true,
			messages: [{
				role: "system",
				content: [{ type: "text", text: "system", cache_control: cacheControl }],
			}],
			tools: [{
				type: "function",
				function: { name: "read", description: "read", parameters: {} },
				cache_control: cacheControl,
			}],
		} as never);
	}, "openai-completions");
	const short = observe();
	const long = observe("1h");
	const diagnostic = comparePrefixManifests(
		manifestForObservation(short, ["read"]),
		manifestForObservation(long, ["read"]),
	);
	assert.equal(short.instructionsHash, long.instructionsHash);
	assert.equal(short.toolsHash, long.toolsHash);
	assert.equal(diagnostic?.reasonCode, "CACHE_RETENTION_CHANGED");
});

test("Bedrock cache points are neutral to system component fingerprints", () => {
	const observe = (ttl?: "1h") => observeOne((options, bedrockModel) => {
		observeBedrockEffectiveDispatch(options as never, bedrockModel, {
			modelId: bedrockModel.id,
			messages: [],
			system: [
				{ text: "system" },
				{ cachePoint: { type: "default", ...(ttl ? { ttl } : {}) } },
			],
		} as never);
	}, "bedrock-converse-stream");
	const short = observe();
	const long = observe("1h");
	const diagnostic = comparePrefixManifests(manifestForObservation(short), manifestForObservation(long));
	assert.equal(short.instructionsHash, long.instructionsHash);
	assert.equal(diagnostic?.reasonCode, "CACHE_RETENTION_CHANGED");
});

test("fixed custom cache boundary remains stable when messages are appended", () => {
	const marker = { type: "ephemeral" };
	const observe = (suffix: unknown[]) => observeOne((options, anthropicModel) => {
		observeAnthropicEffectiveDispatch(options as never, anthropicModel, {
			model: anthropicModel.id,
			stream: true,
			max_tokens: 64,
			messages: [
				{ role: "user", content: [{ type: "text", text: "fixed", cache_control: marker }] },
				{ role: "assistant", content: [{ type: "text", text: "existing suffix" }] },
				...suffix,
			],
		} as never);
	}, "anthropic-messages");
	const first = observe([]);
	const appended = observe([
		{ role: "user", content: [{ type: "text", text: "appended" }] },
		{ role: "assistant", content: [{ type: "text", text: "appended answer" }] },
	]);
	assert.equal(first.cacheBoundaryHash, appended.cacheBoundaryHash);
	assert.equal(comparePrefixManifests(manifestForObservation(first), manifestForObservation(appended)), undefined);
});

test("cache boundary fingerprints preserve breakpoint multiplicity", () => {
	const observe = (markers: number) => observeOne((options, anthropicModel) => {
		observeAnthropicEffectiveDispatch(options as never, anthropicModel, {
			model: anthropicModel.id,
			stream: true,
			max_tokens: 64,
			messages: [],
			system: Array.from({ length: markers }, () => ({
				type: "text",
				text: "same system block",
				cache_control: { type: "ephemeral" },
			})),
		} as never);
	}, "anthropic-messages");
	assert.notEqual(observe(1).cacheBoundaryHash, observe(2).cacheBoundaryHash);
});

test("Google Generative AI and Vertex observe cachedContent without exposing resource names", () => {
	const adapters = [
		{
			api: "google-generative-ai" as const,
			observe: observeGoogleGenerativeAIEffectiveDispatch,
		},
		{
			api: "google-vertex" as const,
			observe: observeGoogleVertexEffectiveDispatch,
		},
	];
	for (const adapter of adapters) {
		const observe = (cachedContent?: string) => observeOne((options, googleModel) => {
			adapter.observe(options as never, googleModel as never, {
				model: googleModel.id,
				contents: [],
				config: { systemInstruction: "system", ...(cachedContent ? { cachedContent } : {}) },
			} as never);
		}, adapter.api);
		const implicit = observe();
		const explicitA = observe("projects/private/locations/us/cachedContents/cache-A-secret");
		const explicitB = observe("projects/private/locations/us/cachedContents/cache-B-secret");
		const implicitManifest = manifestForObservation(implicit);
		const explicitAManifest = manifestForObservation(explicitA);
		const explicitBManifest = manifestForObservation(explicitB);
		assert.notEqual(implicit.cachePolicyHash, explicitA.cachePolicyHash);
		assert.equal(
			comparePrefixManifests(implicitManifest, explicitAManifest)?.reasonCode,
			"CACHE_POLICY_CHANGED",
		);
		const keyDiagnostic = comparePrefixManifests(explicitAManifest, explicitBManifest);
		assert.equal(
			keyDiagnostic?.reasonCode,
			"CACHE_KEY_CHANGED",
		);
		assertMetadataOnly([implicit, explicitA, explicitB], ["cache-A-secret", "cache-B-secret", "cachedContents"]);
		const publicMetadata = JSON.stringify({
			observations: [implicit, explicitA, explicitB],
			manifests: [implicitManifest, explicitAManifest, explicitBManifest],
			diagnostic: keyDiagnostic,
		});
		for (const secret of ["cache-A-secret", "cache-B-secret", "cachedContents"]) {
			assert.equal(publicMetadata.includes(secret), false, `leaked ${secret}`);
		}
	}
});

test("effective dispatch observers isolate sync throws, async rejection, and unhandledRejection", async () => {
	const chatModel = model("openai-completions");
	const payload = {
		model: chatModel.id,
		stream: true,
		messages: [{ role: "system", content: "safe" }],
	};
	assert.doesNotThrow(() => observeOpenAIChatEffectiveDispatch({
		onEffectiveDispatch: () => { throw new Error("sync observer failure"); },
	} as never, chatModel, payload as never));

	const unhandled: unknown[] = [];
	const listener = (reason: unknown) => { unhandled.push(reason); };
	process.on("unhandledRejection", listener);
	try {
		assert.doesNotThrow(() => observeOpenAIChatEffectiveDispatch({
			onEffectiveDispatch: async () => { throw new Error("async observer failure"); },
		} as never, chatModel, payload as never));
		await new Promise<void>((resolve) => setImmediate(resolve));
		await new Promise<void>((resolve) => setImmediate(resolve));
		assert.deepEqual(unhandled, []);
	} finally {
		process.off("unhandledRejection", listener);
	}
});

test("onPayload-fixed instructions suppress intent-only context drift while added tools remain effective drift", () => {
	const chatModel = model("openai-completions");
	const observe = (tools: string[]): EffectiveDispatchObservation => {
		const captured = capture<"openai-completions">();
		observeOpenAIChatEffectiveDispatch(captured.options as never, chatModel, {
			model: chatModel.id,
			stream: true,
			messages: [{ role: "system", content: "fixed-by-onPayload" }],
			tools: tools.map((name) => ({ type: "function", function: { name, description: name, parameters: {} } })),
		} as never);
		return captured.observations[0]!;
	};
	const input = (contextContent: string, effectiveDispatch: EffectiveDispatchObservation): PrefixManifestBuildInput => ({
		provider: chatModel.provider,
		model: chatModel.id,
		api: chatModel.api,
		transport: "sse",
		systemPrompt: `configured prompt ${contextContent}`,
		tools: [{ name: "read", schema: {} }],
		persistentContext: [{ identifier: "workspace:AGENTS.md", content: contextContent, precedence: 0 }],
		previousResponseMode: "none",
		effectiveDispatch,
	});
	const fixedRead = observe(["read"]);
	const first = buildPrefixManifest(input("context A", fixedRead));
	const second = buildPrefixManifest(input("context B", fixedRead));
	assert.equal(comparePrefixManifests(first, second), undefined);

	const addedTool = buildPrefixManifest(input("context B", observe(["read", "write"])));
	const diagnostic = comparePrefixManifests(second, addedTool);
	assert.equal(diagnostic?.reasonCode, "TOOL_ACTIVATED");
	assert.equal(diagnostic?.firstDivergentSegment, "tool-order");
});

test("generic effective observation never serializes 1 MiB or 10 MiB full provider payloads", () => {
	for (const mebibytes of [1, 10]) {
		for (const observerEnabled of [false, true]) {
			const metrics = createEffectiveDispatchBenchmarkScenario(mebibytes, observerEnabled).run();
			assert.equal(metrics.payloadBytes, mebibytes * 1024 * 1024);
			assert.equal(metrics.fullPayloadSerializations, 0);
			assert.equal(metrics.observerCallbacks, observerEnabled ? 1 : 0);
		}
	}
});
