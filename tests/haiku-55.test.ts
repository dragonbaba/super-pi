import assert from "node:assert/strict";
import test from "node:test";
import { ensureHaiku55CatalogModel } from "../packages/ai/scripts/haiku-55-catalog.ts";
import { streamSimple as streamAnthropic } from "../packages/ai/src/api/anthropic-messages.ts";
import { streamSimple as streamBedrock } from "../packages/ai/src/api/bedrock-converse-stream.ts";
import { getModelCapabilities, withModelProfile } from "../packages/ai/src/model-capabilities.ts";
import { calculateCost } from "../packages/ai/src/models.ts";
import { anthropicProvider } from "../packages/ai/src/providers/anthropic.ts";
import { profileBedrockModel } from "../packages/ai/src/providers/bedrock-profile.ts";
import { isHaiku55Model, profileHaiku55Model } from "../packages/ai/src/providers/haiku-55-profile.ts";
import type { Api, Model, SimpleStreamOptions, Usage } from "../packages/ai/src/types.ts";

function bedrock(id = "anthropic.claude-haiku-5-5", name = id): Model<"bedrock-converse-stream"> {
	return { id, name, api: "bedrock-converse-stream", provider: "amazon-bedrock", baseUrl: "",
		reasoning: true, input: ["text", "image"], contextWindow: 1_000_000, maxTokens: 128_000,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
}

function profiled(model: Model<"bedrock-converse-stream">): Model<"bedrock-converse-stream"> {
	return withModelProfile(profileBedrockModel(model), "provider-catalog");
}

async function payload(model: Model<Api>, options: SimpleStreamOptions = {}): Promise<any> {
	let captured: unknown;
	const stream = model.api === "anthropic-messages" ? streamAnthropic : streamBedrock;
	const result = await stream(model as never, {
		systemPrompt: "Fixture instructions",
		messages: [{ role: "user", content: "Hello", timestamp: 0 }],
	}, {
		apiKey: "fixture", reasoning: "xhigh", temperature: 0.2, cacheRetention: "short",
		env: { AWS_REGION: "us-east-1" }, ...options,
		onPayload(value) { captured = structuredClone(value); throw new Error("haiku payload captured"); },
	}).result();
	assert.ok(captured, result.errorMessage);
	assert.match(result.errorMessage ?? "", /haiku payload captured/);
	return captured;
}

test("Haiku 5.5 is available offline with adaptive metadata and official tiered pricing", async () => {
	const model = anthropicProvider().getModels().find((entry) => entry.id === "claude-haiku-5-5");
	assert.ok(model);
	assert.equal(model.contextWindow, 1_000_000);
	assert.equal(model.maxTokens, 128_000);
	assert.equal(getModelCapabilities(model).reasoning.mode, "adaptive");
	const reasoningCapability = getModelCapabilities(model).reasoning;
	assert.ok(reasoningCapability.mode !== "none");
	assert.deepEqual(reasoningCapability.levels, ["low", "medium", "high", "xhigh", "max"]);
	assert.equal(model.compat?.supportsTemperature, false);
	for (const reasoning of ["xhigh", "max"] as const) {
		const wire = await payload(model, { reasoning });
		assert.equal(wire.thinking.type, "adaptive");
		assert.equal(wire.output_config.effort, reasoning);
		assert.equal(wire.thinking.budget_tokens, undefined);
		assert.equal(wire.temperature, undefined);
	}
	for (const [input, rate] of [[80_000, 0.1], [80_001, 0.5]]) {
		const usage: Usage = { input, output: 1_000, cacheRead: 10_000, cacheWrite: 10_000,
			totalTokens: input + 21_000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
		const cost = calculateCost(model, usage);
		assert.ok(Math.abs(cost.input - input / 1_000_000 * rate) < 1e-12);
		assert.ok(Math.abs(cost.output - 1_000 / 1_000_000 * rate * 5) < 1e-12);
		assert.ok(Math.abs(cost.cacheRead - 10_000 / 1_000_000 * rate / 10) < 1e-12);
		assert.ok(Math.abs(cost.cacheWrite - 10_000 / 1_000_000 * rate * 1.25) < 1e-12);
	}
});

for (const [id, name] of [
	["anthropic.claude-haiku-5-5", "Claude Haiku 5.5"],
	["us.anthropic.claude-haiku-5.5", "fixture"],
	["arn:aws:bedrock:us-east-1:123456789012:application-inference-profile/opaque", "Claude Haiku 5.5"],
	["arn:aws:bedrock:us-east-1:123456789012:application-inference-profile/haiku-name-only", "Haiku 5.5"],
]) {
	test(`Bedrock Haiku 5.5 profiles and builds adaptive/cache requests: ${id}`, async () => {
		const model = profiled(bedrock(id, name));
		assert.equal(getModelCapabilities(model).reasoning.mode, "adaptive");
		assert.equal(getModelCapabilities(model).strictToolSchema, false);
		for (const reasoning of ["xhigh", "max"] as const) {
			const wire = await payload(model, { reasoning });
			const fields = wire.additionalModelRequestFields;
			assert.equal(fields.thinking.type, "adaptive");
			assert.equal(fields.thinking.budget_tokens, undefined);
			assert.equal(fields.output_config.effort, reasoning);
			assert.equal(fields.thinking.display, "summarized");
			assert.deepEqual(fields.thinking.block_binding, { prefix_mismatch_behavior: "drop_block" });
			assert.deepEqual(fields.anthropic_beta, ["thinking-binding-controls-2026-08-01"]);
			assert.equal(wire.inferenceConfig.temperature, undefined);
			assert.ok(wire.system.some((block: any) => block.cachePoint));
		}
	});
}

test("Bedrock Haiku GovCloud omits unsupported display and binding fields", async () => {
	for (const [id, region] of [
		["anthropic.claude-haiku-5-5", "us-gov-west-1"],
		["arn:aws-us-gov:bedrock:us-gov-east-1:123456789012:application-inference-profile/opaque", "us-east-1"],
	]) {
		const wire = await payload(profiled(bedrock(id, "Claude Haiku 5.5")), { env: { AWS_REGION: region } });
		assert.equal(wire.additionalModelRequestFields.thinking.type, "adaptive");
		assert.equal(wire.additionalModelRequestFields.thinking.display, undefined);
		assert.equal(wire.additionalModelRequestFields.thinking.block_binding, undefined);
		assert.equal(wire.additionalModelRequestFields.anthropic_beta, undefined);
	}
});

test("Bedrock Haiku honors explicit thinking maps and cache disablement", async () => {
	const raw = bedrock();
	raw.thinkingLevelMap = { xhigh: "medium", max: null };
	const model = profiled(raw);
	assert.equal(model.thinkingLevelMap?.max, null);
	const wire = await payload(model, { cacheRetention: "none" });
	assert.equal(wire.additionalModelRequestFields.output_config.effort, "medium");
	assert.ok(wire.system.every((block: any) => !block.cachePoint));
	const capabilities = { ...getModelCapabilities(model), reasoning: { mode: "none" as const },
		promptCache: { mode: "none" as const } };
	const overridden = profiled({ ...raw, reasoning: false, capabilities });
	assert.equal(overridden.profileDiagnostics?.length, 0);
	const disabled = await payload(overridden);
	assert.equal(disabled.additionalModelRequestFields, undefined);
	assert.ok(disabled.system.every((block: any) => !block.cachePoint));
});

test("Haiku matching is bounded to 5.5 and profiles preserve caller-owned inputs", () => {
	for (const id of ["claude-haiku-4-5", "claude-haiku-5-50", "claude-haiku-5-6", "claude-sonnet-5-5"]) {
		const raw = bedrock(id);
		assert.equal(isHaiku55Model(raw), false);
		assert.equal(profileHaiku55Model(raw), raw);
	}
	const raw = Object.freeze({ ...bedrock("opaque", "CLAUDE HAIKU 5.5"),
		thinkingLevelMap: Object.freeze({ xhigh: "medium", max: null }),
		compat: Object.freeze({ supportsTemperature: true, supportsStrictMode: false }),
	});
	const model = profileHaiku55Model(raw);
	assert.notEqual(model, raw);
	assert.notEqual(model.thinkingLevelMap, raw.thinkingLevelMap);
	assert.equal(model.thinkingLevelMap?.xhigh, "medium");
	assert.equal(model.compat?.supportsTemperature, true);
	assert.equal(raw.thinkingLevelMap.max, null);
});

test("Haiku catalog fallback is idempotent and preserves an existing authoritative record", () => {
	const models: Model<Api>[] = [];
	ensureHaiku55CatalogModel(models);
	assert.equal(models.length, 1);
	const existing = models[0]!;
	assert.deepEqual(existing, (() => {
		const { capabilities, profileSource, profileDiagnostics, costKnown, ...raw } =
			anthropicProvider().getModels().find((entry) => entry.id === "claude-haiku-5-5")!;
		return raw;
	})());
	existing.cost = { input: 9, output: 9, cacheRead: 9, cacheWrite: 9 };
	ensureHaiku55CatalogModel(models);
	assert.equal(models.length, 1);
	assert.equal(models[0], existing);
	assert.equal(models[0]!.cost.input, 9);
});

test("Haiku explicit compatibility and reasoning overrides remain authoritative", async () => {
	const anthropic = { ...bedrock(), api: "anthropic-messages" as const, provider: "anthropic",
		baseUrl: "https://api.anthropic.com", compat: { forceAdaptiveThinking: false, supportsTemperature: true } };
	const budget = withModelProfile(profileHaiku55Model(anthropic), "provider-catalog");
	assert.equal(getModelCapabilities(budget).reasoning.mode, "budget");
	const wire = await payload(budget, { reasoning: "high" });
	assert.equal(wire.thinking.type, "enabled");
	const off = withModelProfile(profileHaiku55Model({ ...anthropic, reasoning: false }), "provider-catalog");
	assert.equal((await payload(off, { reasoning: undefined })).temperature, 0.2);
	const raw = bedrock();
	const overridden = profiled({ ...raw, compat: { supportsTemperature: true },
		capabilities: { ...getModelCapabilities(profiled(raw)), reasoning: { mode: "budget", levels: ["low", "high"] } } });
	assert.equal(overridden.profileDiagnostics?.length, 0);
	const request = await payload(overridden, { reasoning: "high" });
	assert.equal(request.inferenceConfig.temperature, 0.2);
	assert.equal(request.additionalModelRequestFields.thinking.type, "enabled");
	assert.equal(request.additionalModelRequestFields.thinking.block_binding, undefined);
});

test("Older Haiku and unrelated Claude models keep their existing request format", async () => {
	const old = profiled(bedrock("anthropic.claude-haiku-4-5", "Claude Haiku 4.5"));
	assert.equal(getModelCapabilities(old).reasoning.mode, "budget");
	const wire = await payload(old, { reasoning: "high" });
	assert.equal(wire.additionalModelRequestFields.thinking.type, "enabled");
	assert.equal(wire.additionalModelRequestFields.thinking.budget_tokens, 16_384);
	assert.equal(wire.additionalModelRequestFields.thinking.block_binding, undefined);
	assert.equal(wire.inferenceConfig.temperature, 0.2);
	const sonnet = await payload(profiled(bedrock("anthropic.claude-sonnet-5-5")), { reasoning: "high" });
	assert.equal(sonnet.additionalModelRequestFields.thinking.type, "adaptive");
	assert.equal(sonnet.additionalModelRequestFields.thinking.block_binding, undefined);
});
