import assert from "node:assert/strict";
import test from "node:test";
import { observeAnthropicEffectiveDispatch } from "../packages/ai/src/api/anthropic-messages.ts";
import { observeBedrockEffectiveDispatch } from "../packages/ai/src/api/bedrock-converse-stream.ts";
import { observeGoogleGenerativeAIEffectiveDispatch } from "../packages/ai/src/api/google-generative-ai.ts";
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
