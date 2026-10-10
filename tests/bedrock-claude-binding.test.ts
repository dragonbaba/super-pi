import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { BedrockRuntimeClient, type ConverseStreamCommand } from "@aws-sdk/client-bedrock-runtime";
import { Type } from "typebox";
import { stream, streamSimple, type BedrockOptions } from "../packages/ai/src/api/bedrock-converse-stream.ts";
import { getModelCapabilities, withModelProfile } from "../packages/ai/src/model-capabilities.ts";
import { profileBedrockModel } from "../packages/ai/src/providers/bedrock-profile.ts";
import type { AssistantMessage, Context, Model, SimpleStreamOptions } from "../packages/ai/src/types.ts";

const context: Context = { messages: [{ role: "user", content: "Use the fixture tool", timestamp: 1 }] };
const baseOptions = { region: "us-east-1", apiKey: "synthetic-bedrock-token", env: { AWS_PROFILE: "", AWS_REGION: "us-east-1", AWS_DEFAULT_REGION: "", HTTP_PROXY: "", HTTPS_PROXY: "", ALL_PROXY: "" } };
const binding = { prefix_mismatch_behavior: "drop_block" };
const beta = ["thinking-binding-controls-2026-08-01"];
const arn = "arn:aws:bedrock:us-east-1:123456789012:application-inference-profile/opaque";

function model(id = "anthropic.claude-opus-4-7", name = id, overrides: Partial<Model<"bedrock-converse-stream">> = {}): Model<"bedrock-converse-stream"> {
	return withModelProfile(profileBedrockModel({
		id, name, api: "bedrock-converse-stream", provider: "amazon-bedrock",
		baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com", reasoning: true, input: ["text"],
		contextWindow: 128_000, maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		...overrides,
	}), "provider-catalog");
}

function capture(t: TestContext) {
	const inputs: ConverseStreamCommand["input"][] = [];
	t.mock.method(BedrockRuntimeClient.prototype, "send", async (command: ConverseStreamCommand) => {
		inputs.push(command.input);
		return { $metadata: {}, stream: (async function* () {
			yield { messageStart: { role: "assistant" } };
			yield { messageStop: { stopReason: "end_turn" } };
		})() };
	});
	return async (target: Model<"bedrock-converse-stream">, options: BedrockOptions = {}, history = context, simple = false) => {
		const count = inputs.length;
		const result = await (simple
			? streamSimple(target, history, { ...baseOptions, ...options } as SimpleStreamOptions)
			: stream(target, history, { ...baseOptions, ...options })).result();
		assert.equal(result.stopReason, "stop", result.errorMessage);
		assert.equal(inputs.length, count + 1, "payload reaches SDK send");
		return inputs.at(-1)!;
	};
}

for (const id of [
	"anthropic.claude-opus-4-7", "us.anthropic.claude-opus-4-8",
	"global.anthropic.claude-opus-5", "anthropic.claude-opus-5-5-v1:0",
	"anthropic.claude-sonnet-5", "eu.anthropic.claude-sonnet-5-5",
	"anthropic.claude-fable-5", "anthropic.claude-fable-5-1", "anthropic.claude-haiku-5-5",
]) {
	test(`Bedrock signed thinking binding reaches SDK for ${id}`, async (t) => {
		const target = model(id);
		const send = capture(t);
		for (const simple of [false, true]) {
			const fields = (await send(target, { reasoning: "high" }, context, simple)).additionalModelRequestFields as any;
			assert.equal(fields.thinking.type, "adaptive");
			assert.deepEqual(fields.thinking.block_binding, binding);
			assert.deepEqual(fields.anthropic_beta, beta);
			assert.equal(fields.output_config.effort, "high");
		}
		assert.equal(getModelCapabilities(target).thoughtSignatureRoundTrip, true);
	});
}

test("Bedrock binding recognizes opaque profile names and normalized separators", async (t) => {
	const send = capture(t);
	for (const name of ["Claude Opus 4.7", "CLAUDE_OPUS_4_8", "Claude:Opus:5.5", "Claude.Sonnet.5", "Claude Fable 5.1"]) {
		const target = model(arn, name);
		const fields = (await send(target, { reasoning: "high" })).additionalModelRequestFields as any;
		assert.deepEqual(fields.thinking.block_binding, binding, name);
		assert.deepEqual(fields.anthropic_beta, beta, name);
		assert.equal(getModelCapabilities(target).thoughtSignatureRoundTrip, true, name);
	}
});

for (const version of ["opus-4-6", "sonnet-4-6", "opus-4-70", "opus-4-80", "opus-50", "sonnet-50", "fable-50", "opus-4-9"]) {
	test(`Bedrock does not send binding for unsupported ${version}`, async (t) => {
		const target = model(`anthropic.claude-${version}`);
		const fields = (await capture(t)(target, { reasoning: "high" })).additionalModelRequestFields as any;
		assert.equal(fields.thinking.block_binding, undefined);
		assert.ok(!fields.anthropic_beta?.includes(beta[0]));
		assert.equal(getModelCapabilities(target).thoughtSignatureRoundTrip, false);
	});
}

test("Bedrock budget Claude retains interleaved thinking and respects explicit mode overrides", async (t) => {
	const send = capture(t);
	const override = model(undefined, undefined, { capabilities: {
		...getModelCapabilities(model()), reasoning: { mode: "budget", levels: ["low", "high"] },
	} });
	for (const target of [model("anthropic.claude-haiku-4-5"), override]) {
		const fields = (await send(target, { reasoning: "high" })).additionalModelRequestFields as any;
		assert.deepEqual(fields, { thinking: { type: "enabled", budget_tokens: 16_384, display: "summarized" }, anthropic_beta: ["interleaved-thinking-2025-05-14"] });
		const withoutInterleaving = (await send(target, { reasoning: "high", interleavedThinking: false })).additionalModelRequestFields as any;
		assert.equal(withoutInterleaving.anthropic_beta, undefined);
	}
});

test("Bedrock binding follows reasoning activation and preserves display and effort options", async (t) => {
	const send = capture(t);
	for (const reasoning of [undefined, "off"] as const) {
		assert.equal((await send(model(), { reasoning })).additionalModelRequestFields, undefined);
	}
	assert.equal((await send(model(undefined, undefined, { reasoning: false }), { reasoning: "high" })).additionalModelRequestFields, undefined);
	const fields = (await send(model(undefined, undefined, { thinkingLevelMap: { high: "max" } }), {
		reasoning: "high", thinkingDisplay: "omitted", interleavedThinking: false,
	})).additionalModelRequestFields as any;
	assert.deepEqual(fields, { thinking: { type: "adaptive", display: "omitted", block_binding: binding }, output_config: { effort: "max" }, anthropic_beta: beta });
});

test("Bedrock GovCloud suppresses binding and display for supported Claude", async (t) => {
	const send = capture(t);
	for (const target of [model("us-gov.anthropic.claude-opus-5"), model(arn.replace("arn:aws:", "arn:aws-us-gov:").replace("us-east-1", "us-gov-east-1"), "Claude Sonnet 5")]) {
		const fields = (await send(target, { reasoning: "high" })).additionalModelRequestFields as any;
		assert.deepEqual(fields, { thinking: { type: "adaptive" }, output_config: { effort: "high" } });
	}
	for (const region of ["us-gov-east-1", "us-gov-west-1"]) {
		const fields = (await send(model(), { reasoning: "high", region })).additionalModelRequestFields as any;
		assert.deepEqual(fields, { thinking: { type: "adaptive" }, output_config: { effort: "high" } });
	}
	const commercial = (await send(model(arn, "Claude Opus 4.7"), {
		reasoning: "high", region: undefined, env: { ...baseOptions.env, AWS_REGION: "us-gov-east-1" },
	})).additionalModelRequestFields as any;
	assert.deepEqual(commercial.thinking.block_binding, binding, "commercial ARN region wins over ambient GovCloud");
});

function signedHistory(target: Model<"bedrock-converse-stream">, thinking: string, redacted = false): Context {
	const assistant: AssistantMessage = {
		role: "assistant", api: target.api, provider: target.provider, model: target.id, stopReason: "toolUse", timestamp: 2,
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		content: [{ type: "thinking", thinking, thinkingSignature: "bound-signature", ...(redacted ? { redacted: true } : {}) },
			{ type: "toolCall", id: "call_1", name: "fixture", arguments: {} }],
	};
	return { systemPrompt: "Changed system prompt", tools: [{ name: "fixture", description: "Changed tool description", parameters: Type.Object({}) }],
		messages: [...context.messages, assistant,
			{ role: "toolResult", toolCallId: "call_1", toolName: "fixture", content: [{ type: "text", text: "done" }], isError: false, timestamp: 3 }] };
}

for (const family of ["opus-4-7", "sonnet-5", "fable-5", "haiku-5-5"]) {
	test(`Bedrock GovCloud suppresses bound ${family} signatures without changing commercial replay`, async (t) => {
		const send = capture(t);
		const target = model(`anthropic.claude-${family}`);
		const capabilities = getModelCapabilities(target);
		for (const thinking of ["Readable thinking", "", " \t\n"]) {
			const history = signedHistory(target, thinking);
			const before = structuredClone(history);
			const assistant = history.messages[1] as AssistantMessage;
			for (const block of assistant.content) Object.freeze(block);
			Object.freeze(assistant.content);
			Object.freeze(assistant);
			for (const simple of [false, true]) {
				const wire = await send(target, { reasoning: "high", region: "us-gov-west-1", env: { ...baseOptions.env, AWS_REGION: "us-gov-west-1" } }, history, simple);
				const content = wire.messages![1]!.content!;
				assert.ok(content.every(block => !block.reasoningContent));
				assert.equal(content.length, thinking.trim() ? 2 : 1);
				if (thinking.trim()) assert.deepEqual(content[0], { text: thinking });
				assert.equal(content.at(-1)!.toolUse?.toolUseId, "call_1");
				assert.equal(wire.messages![2]!.content![0]!.toolResult?.toolUseId, "call_1");
				assert.deepEqual(wire.additionalModelRequestFields, { thinking: { type: "adaptive" }, output_config: { effort: "high" } });
				const commercial = await send(target, { reasoning: "high" }, history, simple);
				assert.deepEqual(commercial.messages![1]!.content![0], { reasoningContent: { reasoningText: { text: thinking, signature: "bound-signature" } } });
			}
			assert.deepEqual(history, before);
		}
		const redacted = await send(target, { reasoning: "high", region: "us-gov-west-1" }, signedHistory(target, "opaque ciphertext", true));
		assert.deepEqual(redacted.messages![1]!.content, [{ toolUse: { toolUseId: "call_1", name: "fixture", input: {} } }]);
		assert.equal(getModelCapabilities(target), capabilities);
		assert.equal(capabilities.thoughtSignatureRoundTrip, true);
	});
}

test("Bedrock GovCloud replay follows resolved region, ARN, inference prefix and endpoints", async (t) => {
	const send = capture(t);
	const target = model();
	for (const [selected, options] of [
		[target, { region: "fips-us-gov-east-1" }],
		[target, { region: undefined, env: { ...baseOptions.env, AWS_REGION: "us-gov-east-1" } }],
		[model(arn.replace("arn:aws:", "arn:aws-us-gov:").replace("us-east-1", "us-gov-east-1"), "Claude Opus 4.7"), {}],
		[model("us-gov.anthropic.claude-opus-4-7"), {}],
		...(["bedrock-runtime", "bedrock-runtime-fips"].map(host => [model(undefined, undefined, { baseUrl: `https://${host}.us-gov-east-1.amazonaws.com` }),
			{ region: undefined, env: { ...baseOptions.env, AWS_REGION: "", AWS_DEFAULT_REGION: "" } }])),
	] as Array<[Model<"bedrock-converse-stream">, BedrockOptions]>) {
		const wire = await send(selected, { reasoning: "high", ...options }, signedHistory(selected, "Readable thinking"));
		assert.deepEqual(wire.messages![1]!.content![0], { text: "Readable thinking" });
		assert.ok(wire.messages!.every(message => message.content!.every(block => !block.reasoningContent)));
	}
	const commercial = model(arn, "Claude Opus 4.7");
	const wire = await send(commercial, { reasoning: "high", region: "us-gov-west-1" }, signedHistory(commercial, "Readable thinking"));
	assert.equal(wire.messages![1]!.content![0]!.reasoningContent?.reasoningText?.signature, "bound-signature");
});

for (const changedPrefix of ["system", "tools"] as const) {
	test(`Bedrock streamed thinking survives tool continuation after ${changedPrefix} changes`, async (t) => {
		const target = model();
		const inputs: ConverseStreamCommand["input"][] = [];
		t.mock.method(BedrockRuntimeClient.prototype, "send", async (command: ConverseStreamCommand) => {
			inputs.push(command.input);
			return { $metadata: {}, stream: (async function* () {
				yield { messageStart: { role: "assistant" } };
				if (inputs.length === 1) {
					yield { contentBlockDelta: { contentBlockIndex: 0, delta: { reasoningContent: { signature: "signed-" } } } };
					yield { contentBlockDelta: { contentBlockIndex: 0, delta: { reasoningContent: { signature: "opaque" } } } };
					yield { contentBlockStop: { contentBlockIndex: 0 } };
					yield { contentBlockStart: { contentBlockIndex: 1, start: { toolUse: { toolUseId: "call_1", name: "fixture" } } } };
					yield { contentBlockDelta: { contentBlockIndex: 1, delta: { toolUse: { input: "{}" } } } };
					yield { contentBlockStop: { contentBlockIndex: 1 } };
					yield { messageStop: { stopReason: "tool_use" } };
				} else yield { messageStop: { stopReason: "end_turn" } };
			})() };
		});
		const first: Context = { ...context, systemPrompt: "Original instructions", tools: [{ name: "fixture", description: "Original tool", parameters: Type.Object({}) }] };
		const message = await stream(target, first, { ...baseOptions, reasoning: "high" }).result();
		assert.equal(message.stopReason, "toolUse", message.errorMessage);
		const history: Context = { ...first, messages: [...first.messages, message,
			{ role: "toolResult", toolCallId: "call_1", toolName: "fixture", content: [{ type: "text", text: "done" }], isError: false, timestamp: 2 }] };
		if (changedPrefix === "system") history.systemPrompt = "Updated instructions";
		else history.tools = [{ ...first.tools![0]!, description: "Updated tool" }];
		const originalHistory = structuredClone(history);
		const result = await streamSimple(target, history, { ...baseOptions, reasoning: "high" }).result();
		assert.equal(result.stopReason, "stop", result.errorMessage);
		assert.equal(inputs.length, 2);
		const replay = inputs[1]!;
		assert.deepEqual(replay.messages![1]!.content![0], { reasoningContent: { reasoningText: { text: "", signature: "signed-opaque" } } });
		assert.equal(replay.messages![1]!.content![1]!.toolUse?.toolUseId, "call_1");
		assert.equal(replay.messages![2]!.content![0]!.toolResult?.toolUseId, "call_1");
		const fields = replay.additionalModelRequestFields as any;
		assert.deepEqual(fields.thinking.block_binding, binding);
		assert.deepEqual(fields.anthropic_beta, beta);
		assert.notDeepEqual(changedPrefix === "system" ? inputs[0]!.system : inputs[0]!.toolConfig, changedPrefix === "system" ? replay.system : replay.toolConfig);
		assert.deepEqual(history, originalHistory);
		const govResult = await streamSimple(target, history, { ...baseOptions, reasoning: "high",
			env: { ...baseOptions.env, AWS_REGION: "us-gov-west-1" } }).result();
		assert.equal(govResult.stopReason, "stop", govResult.errorMessage);
		const govReplay = inputs.at(-1)!;
		assert.deepEqual(govReplay.messages![1]!.content, [{ toolUse: { toolUseId: "call_1", name: "fixture", input: {} } }]);
		assert.equal(govReplay.messages![2]!.content![0]!.toolResult?.toolUseId, "call_1");
		assert.deepEqual(govReplay.additionalModelRequestFields, { thinking: { type: "adaptive" }, output_config: { effort: "high" } });
		assert.deepEqual(history, originalHistory);
		const noSignatures = model(undefined, undefined, { capabilities: { ...getModelCapabilities(target), thoughtSignatureRoundTrip: false } });
		for (const other of [noSignatures, model("anthropic.claude-sonnet-5")]) {
			assert.equal((await stream(other, history, { ...baseOptions, reasoning: "high" }).result()).stopReason, "stop");
			assert.ok(inputs.at(-1)!.messages![1]!.content!.every(block => !block.reasoningContent));
		}
	});
}
