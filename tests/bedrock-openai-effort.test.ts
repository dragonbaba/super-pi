import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { BedrockRuntimeClient, type ConverseStreamCommand } from "@aws-sdk/client-bedrock-runtime";
import { stream, streamSimple, type BedrockOptions } from "../packages/ai/src/api/bedrock-converse-stream.ts";
import { deriveModelCapabilities, withModelProfile } from "../packages/ai/src/model-capabilities.ts";
import { amazonBedrockProvider } from "../packages/ai/src/providers/amazon-bedrock.ts";
import { profileBedrockModel } from "../packages/ai/src/providers/bedrock-profile.ts";
import type { Context, Model, SimpleStreamOptions, ThinkingLevel } from "../packages/ai/src/types.ts";

const context: Context = { messages: [{ role: "user", content: "hello", timestamp: 1 }] };
const baseOptions = { region: "us-east-1", apiKey: "synthetic-bedrock-token", env: { AWS_PROFILE: "", HTTP_PROXY: "", HTTPS_PROXY: "", ALL_PROXY: "" } };

function model(id = "global.openai.gpt-5.6-sol", name = id, overrides: Partial<Model<"bedrock-converse-stream">> = {}): Model<"bedrock-converse-stream"> {
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
	return async (target: Model<"bedrock-converse-stream">, options: BedrockOptions = {}, simple = false) => {
		const before = inputs.length;
		const result = await (simple
			? streamSimple(target, context, { ...baseOptions, ...options } as SimpleStreamOptions)
			: stream(target, context, { ...baseOptions, ...options })).result();
		assert.equal(result.stopReason, "stop", result.errorMessage);
		assert.equal(inputs.length, before + 1, "assert the payload actually reaches SDK send");
		return inputs.at(-1)!;
	};
}

const levels: Array<[ThinkingLevel, string, string]> = [
	["minimal", "low", "low"], ["low", "low", "low"], ["medium", "medium", "medium"],
	["high", "high", "high"], ["xhigh", "xhigh", "high"], ["max", "max", "high"],
];

for (const [reasoning, gptEffort, ossEffort] of levels) {
	test(`Bedrock GPT sends ${reasoning} as nested ${gptEffort}`, async (t) => {
		const send = capture(t);
		for (const id of ["global.openai.gpt-5.6-sol", "global.openai.gpt-6-sol", "us.openai.gpt-6-luna"]) {
			assert.deepEqual((await send(model(id), { reasoning })).additionalModelRequestFields, { reasoning: { effort: gptEffort } }, id);
		}
	});
	test(`Bedrock gpt-oss sends ${reasoning} as flat ${ossEffort}`, async (t) => {
		const send = capture(t);
		for (const id of ["openai.gpt-oss-120b-1:0", "openai.gpt-oss-20b-1:0"]) {
			assert.deepEqual((await send(model(id), { reasoning })).additionalModelRequestFields, { reasoning_effort: ossEffort }, id);
		}
	});
}

test("Bedrock OpenAI matching handles profile names, casing and normalized separators", async (t) => {
	const send = capture(t);
	const arn = "arn:aws:bedrock:us-east-1:123456789012:application-inference-profile/opaque";
	for (const name of ["GPT-6 Sol", "GPT 6 Sol", "GPT_6_Sol", "GPT.6.Sol", "GPT:6:Sol"]) {
		assert.deepEqual((await send(model(arn, name), { reasoning: "high" })).additionalModelRequestFields, { reasoning: { effort: "high" } }, name);
	}
	for (const name of ["GPT-OSS 120B", "GPT OSS 120B", "GPT_OSS_120B", "GPT.OSS.120B", "GPT:OSS:120B"]) {
		assert.deepEqual((await send(model(arn, name), { reasoning: "xhigh" })).additionalModelRequestFields, { reasoning_effort: "high" }, name);
	}
	assert.deepEqual((await send(model("GLOBAL.OPENAI.GPT_6_SOL", "opaque"), { reasoning: "medium" })).additionalModelRequestFields, { reasoning: { effort: "medium" } });
});

test("Bedrock GPT honors explicit effort mappings through direct and simple APIs", async (t) => {
	const send = capture(t);
	const target = model(undefined, undefined, { thinkingLevelMap: { minimal: "low", high: "medium", xhigh: "high", max: "xhigh" } });
	for (const simple of [false, true]) {
		for (const [reasoning, effort] of [["minimal", "low"], ["high", "medium"], ["xhigh", "high"], ["max", "xhigh"]] as const) {
			assert.deepEqual((await send(target, { reasoning }, simple)).additionalModelRequestFields, { reasoning: { effort } });
		}
	}
});

test("Bedrock simple reasoning retains supported extended levels and clamps null exclusions", async (t) => {
	const send = capture(t);
	const target = model(undefined, undefined, { thinkingLevelMap: { xhigh: "xhigh", max: "max" } });
	for (const [reasoning, effort] of levels) {
		assert.deepEqual((await send(target, { reasoning }, true)).additionalModelRequestFields, { reasoning: { effort } });
	}
	const restricted = model(undefined, undefined, { thinkingLevelMap: { minimal: null, xhigh: null, max: null } });
	assert.deepEqual((await send(restricted, { reasoning: "minimal" }, true)).additionalModelRequestFields, { reasoning: { effort: "low" } });
	assert.deepEqual((await send(restricted, { reasoning: "max" }, true)).additionalModelRequestFields, { reasoning: { effort: "high" } });
});

test("Bedrock gpt-oss stays within low/medium/high even when extended levels are enabled", async (t) => {
	const send = capture(t);
	const target = model("openai.gpt-oss-120b-1:0", undefined, { thinkingLevelMap: { xhigh: "xhigh", max: "max" } });
	for (const [reasoning, , effort] of levels) {
		assert.deepEqual((await send(target, { reasoning }, true)).additionalModelRequestFields, { reasoning_effort: effort });
	}
});

test("Bedrock built-in OpenAI catalog models send the selected effort", async (t) => {
	const send = capture(t);
	const catalog = amazonBedrockProvider().getModels();
	const gpt = catalog.find(entry => entry.id === "global.openai.gpt-5.6-sol");
	const oss = catalog.find(entry => entry.id === "openai.gpt-oss-120b-1:0");
	assert.ok(gpt);
	assert.ok(oss);
	assert.deepEqual((await send(gpt, { reasoning: "xhigh" }, true)).additionalModelRequestFields, { reasoning: { effort: "xhigh" } });
	assert.deepEqual((await send(oss, { reasoning: "minimal" }, true)).additionalModelRequestFields, { reasoning_effort: "low" });
});

test("Bedrock OpenAI omits reasoning fields when off, omitted or capability-disabled", async (t) => {
	const send = capture(t);
	for (const id of ["global.openai.gpt-5.6-sol", "openai.gpt-oss-20b-1:0"]) {
		for (const reasoning of [undefined, "off"] as const) {
			assert.equal((await send(model(id), { reasoning })).additionalModelRequestFields, undefined);
		}
		const disabled = model(id, id, { reasoning: false });
		const capabilityDisabled = model(id, id, { reasoning: false, capabilities: { ...deriveModelCapabilities(disabled), reasoning: { mode: "none" } } });
		for (const simple of [false, true]) {
			assert.equal((await send(model(id), {}, simple)).additionalModelRequestFields, undefined);
			assert.equal((await send(disabled, { reasoning: "high" }, simple)).additionalModelRequestFields, undefined);
			assert.equal((await send(capabilityDisabled, { reasoning: "high" }, simple)).additionalModelRequestFields, undefined);
		}
	}
});

test("Bedrock does not add OpenAI fields to other model families", async (t) => {
	const send = capture(t);
	for (const id of ["us.deepseek.r1-v1:0", "amazon.nova-2-lite-v1:0", "qwen.qwen3-32b-v1:0"]) {
		assert.equal((await send(model(id), { reasoning: "high" })).additionalModelRequestFields, undefined);
	}
	const claude = model("us.anthropic.claude-sonnet-4-6", "Claude Sonnet 4.6");
	assert.deepEqual((await send(claude, { reasoning: "high" })).additionalModelRequestFields, {
		thinking: { type: "adaptive", display: "summarized" }, output_config: { effort: "high" },
	});
	assert.deepEqual((await send(claude, { reasoning: "high", region: "us-gov-west-1" })).additionalModelRequestFields, {
		thinking: { type: "adaptive" }, output_config: { effort: "high" },
	});
});

test("Bedrock payload hook can still override the generated OpenAI fields", async (t) => {
	const send = capture(t);
	const input = await send(model(), { reasoning: "high", onPayload(payload) {
		const command = payload as ConverseStreamCommand["input"];
		assert.deepEqual(command.additionalModelRequestFields, { reasoning: { effort: "high" } });
		return { ...command, additionalModelRequestFields: { reasoning: { effort: "low" } } };
	} });
	assert.deepEqual(input.additionalModelRequestFields, { reasoning: { effort: "low" } });
});
