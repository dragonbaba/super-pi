import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import { BedrockRuntimeClient } from "@aws-sdk/client-bedrock-runtime";
import ts from "typescript";
import { streamSimple as streamAnthropic } from "../packages/ai/src/api/anthropic-messages.ts";
import { stream as streamBedrock, streamSimple as streamBedrockSimple } from "../packages/ai/src/api/bedrock-converse-stream.ts";
import { getModelCapabilities, withModelProfile } from "../packages/ai/src/model-capabilities.ts";
import { anthropicProvider } from "../packages/ai/src/providers/anthropic.ts";
import { profileBedrockModel } from "../packages/ai/src/providers/bedrock-profile.ts";
import { HAIKU_55_THINKING_LEVEL_MAP, isHaiku55Model, profileHaiku55Model } from "../packages/ai/src/providers/haiku-55-profile.ts";
import type { Api, Context, Model, SimpleStreamOptions } from "../packages/ai/src/types.ts";

function bedrock(baseUrl = ""): Model<"bedrock-converse-stream"> {
	return { id: "anthropic.claude-haiku-5-5", name: "Claude Haiku 5.5", api: "bedrock-converse-stream",
		provider: "amazon-bedrock", baseUrl, reasoning: true, input: ["text"], contextWindow: 1_000_000,
		maxTokens: 128_000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
}
function profiled(raw = bedrock()): Model<"bedrock-converse-stream"> {
	return withModelProfile(profileBedrockModel(raw), "provider-catalog");
}
const context: Context = { messages: [{ role: "user", content: "Use the fixture tool", timestamp: 0 }] };

async function capture(model: Model<Api>, options: SimpleStreamOptions, messages = context, directBedrock = false): Promise<any> {
	let payload: unknown;
	const stream = directBedrock ? streamBedrock : model.api === "anthropic-messages" ? streamAnthropic : streamBedrockSimple;
	const result = await stream(model as never, messages, {
		apiKey: "fixture", cacheRetention: "none", ...options,
		onPayload(value) { payload = structuredClone(value); throw new Error("review payload captured"); },
	}).result();
	assert.ok(payload, result.errorMessage);
	assert.match(result.errorMessage ?? "", /review payload captured/);
	return payload;
}

for (const api of ["anthropic", "bedrock", "bedrock-direct"] as const) {
	for (const reasoning of [undefined, "off"] as const) {
		test(`${api} omitted/explicit off disables Haiku thinking: ${reasoning}`, async () => {
			const model = api === "anthropic"
				? anthropicProvider().getModels().find(model => model.id === "claude-haiku-5-5")!
				: profiled();
			const capability = getModelCapabilities(model).reasoning;
			assert.ok(capability.mode !== "none" && capability.levels.includes("off"));
			// TS callers omit reasoning for off; JS callers can pass the equivalent literal.
			const wire = await capture(model,
				{ reasoning: reasoning as SimpleStreamOptions["reasoning"], env: { AWS_REGION: "us-east-1" } },
				context, api === "bedrock-direct");
			const fields = api === "anthropic" ? wire : wire.additionalModelRequestFields;
			assert.deepEqual(fields.thinking, { type: "disabled" });
			assert.equal(fields.output_config, undefined);
			assert.equal(fields.anthropic_beta, undefined);
		});
	}
}

test("explicit off prohibition remains authoritative", async () => {
	const wire = await capture(profiled({ ...bedrock(), thinkingLevelMap: { off: null } }), { env: { AWS_REGION: "us-east-1" } });
	assert.equal(wire.additionalModelRequestFields.thinking.type, "adaptive");
	assert.equal(wire.additionalModelRequestFields.output_config.effort, "low");
});

// Execute the production generator's Haiku branch without invoking catalog
// downloads or generation. Extract dependent merge helpers from the same AST.
function generatorHaikuMetadata(model: Model<Api>): void {
	const source = readFileSync(new URL("../packages/ai/scripts/generate-models.ts", import.meta.url), "utf8");
	const file = ts.createSourceFile("generate-models.ts", source, ts.ScriptTarget.Latest, true);
	const functions = file.statements.filter(ts.isFunctionDeclaration);
	const apply = functions.find(node => node.name?.text === "applyThinkingLevelMetadata");
	const branch = apply?.body?.statements[0];
	assert.ok(branch && ts.isIfStatement(branch) && branch.expression.getText(file) === "isHaiku55Model(model)");
	const helpers = functions.filter(node => ["mergeThinkingLevelMap", "mergeAnthropicMessagesCompat"].includes(node.name?.text ?? ""));
	const program = `${helpers.map(node => node.getText(file)).join("\n")}\nfunction apply(model) { ${branch.getText(file)} }\napply(model);`;
	const javascript = ts.transpileModule(program, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
	vm.runInNewContext(javascript, { model, HAIKU_55_THINKING_LEVEL_MAP, isHaiku55Model, profileHaiku55Model });
}

for (const api of ["anthropic-messages", "bedrock-converse-stream", "openai-completions"] as const) {
	test(`generator Haiku defaults preserve explicit ${api} catalog facts`, () => {
		const model: Model<Api> = { ...bedrock(), api,
			thinkingLevelMap: { off: "none", minimal: "low", xhigh: "high", max: null },
			compat: { forceAdaptiveThinking: false, supportsTemperature: true } };
		const original = structuredClone(model);
		generatorHaikuMetadata(model);
		for (const key of ["off", "minimal", "xhigh", "max"] as const) {
			assert.equal(model.thinkingLevelMap?.[key], original.thinkingLevelMap?.[key]);
		}
		assert.equal(model.thinkingLevelMap?.medium, "medium");
		assert.deepEqual(structuredClone(model.compat), original.compat);
		const once = JSON.stringify(model);
		generatorHaikuMetadata(model);
		assert.equal(JSON.stringify(model), once);
	});
}

for (const endpoint of ["bedrock-runtime.us-gov-west-1.amazonaws.com", "bedrock-runtime-fips.us-gov-east-1.amazonaws.com"]) {
	test(`Haiku GovCloud endpoint controls display/binding: ${endpoint}`, async (t) => {
		for (const variable of ["AWS_REGION", "AWS_DEFAULT_REGION", "AWS_PROFILE"]) {
			const previous = process.env[variable];
			delete process.env[variable];
			t.after(() => { if (previous === undefined) delete process.env[variable]; else process.env[variable] = previous; });
		}
		const wire = await capture(profiled(bedrock(`https://${endpoint}`)), { reasoning: "high" });
		assert.deepEqual(wire.additionalModelRequestFields.thinking, { type: "adaptive" });
		assert.equal(wire.additionalModelRequestFields.anthropic_beta, undefined);
		const overridden = await capture(profiled(bedrock(`https://${endpoint}`)), { reasoning: "high", env: { AWS_REGION: "us-east-1" } });
		assert.equal(overridden.additionalModelRequestFields.thinking.display, "summarized");
		assert.ok(overridden.additionalModelRequestFields.thinking.block_binding);
	});
}

test("Bedrock resolved ARN region takes precedence over ambient GovCloud region", async () => {
	const model = profiled({ ...bedrock(), id: "arn:aws:bedrock:us-east-1:123456789012:application-inference-profile/opaque" });
	const wire = await capture(model, { reasoning: "high", env: { AWS_REGION: "us-gov-west-1" } });
	assert.equal(wire.additionalModelRequestFields.thinking.display, "summarized");
	assert.ok(wire.additionalModelRequestFields.thinking.block_binding);
});

test("Bedrock signature-only stream survives tool continuation without fabricated thinking text", async (t) => {
	t.mock.method(BedrockRuntimeClient.prototype, "send", async () => ({
		$metadata: {},
		stream: (async function* () {
			yield { messageStart: { role: "assistant" } };
			yield { contentBlockDelta: { contentBlockIndex: 0, delta: { reasoningContent: { signature: "signed-" } } } };
			yield { contentBlockDelta: { contentBlockIndex: 0, delta: { reasoningContent: { signature: "opaque" } } } };
			yield { contentBlockStop: { contentBlockIndex: 0 } };
			yield { contentBlockStart: { contentBlockIndex: 1, start: { toolUse: { toolUseId: "call_1", name: "fixture" } } } };
			yield { contentBlockDelta: { contentBlockIndex: 1, delta: { toolUse: { input: "{}" } } } };
			yield { contentBlockStop: { contentBlockIndex: 1 } };
			yield { messageStop: { stopReason: "tool_use" } };
		})(),
	}));
	const model = profiled();
	assert.equal(getModelCapabilities(model).thoughtSignatureRoundTrip, true);
	const message = await streamBedrock(model, context, { apiKey: "fixture", reasoning: "high", env: { AWS_REGION: "us-gov-west-1" } }).result();
	assert.equal(message.stopReason, "toolUse");
	const thinking = message.content[0];
	assert.equal(thinking.type, "thinking");
	if (thinking.type !== "thinking") throw new Error("missing thinking block");
	assert.equal(thinking.thinking, "");
	assert.equal(thinking.thinkingSignature, "signed-opaque");
	const history: Context = { messages: [...context.messages, message,
		{ role: "toolResult", toolCallId: "call_1", toolName: "fixture", content: [{ type: "text", text: "done" }], isError: false, timestamp: 1 }] };
	const wire = await capture(model, { reasoning: "high", env: { AWS_REGION: "us-gov-west-1" } }, history);
	assert.deepEqual(wire.messages[1].content[0], { reasoningContent: { reasoningText: { text: "", signature: "signed-opaque" } } });
	assert.equal(wire.messages[1].content[1].toolUse.toolUseId, "call_1");
	assert.equal(wire.messages[2].content[0].toolResult.toolUseId, "call_1");
	for (const text of ["", " \t\n"]) {
		thinking.thinking = text;
		const replay = await capture(model, { reasoning: "high" }, history);
		assert.equal(replay.messages[1].content[0].reasoningContent.reasoningText.text, text);
	}
	thinking.thinkingSignature = " ";
	const unsigned = await capture(model, { reasoning: "high" }, history);
	assert.equal(unsigned.messages[1].content[0].reasoningContent, undefined);
	thinking.thinkingSignature = "signed-opaque";
	const noSignatures = withModelProfile({ ...model,
		capabilities: { ...getModelCapabilities(model), thoughtSignatureRoundTrip: false },
	}, "provider-catalog");
	const optedOut = await capture(noSignatures, { reasoning: "high" }, history);
	assert.equal(optedOut.messages[1].content[0].reasoningContent, undefined);
	const other = await capture(profiled({ ...bedrock(), id: "anthropic.claude-sonnet-5-5", name: "Claude Sonnet 5.5" }), { reasoning: "high" }, history);
	assert.equal(other.messages[1].content[0].reasoningContent, undefined);
});
