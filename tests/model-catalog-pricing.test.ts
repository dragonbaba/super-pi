import assert from "node:assert/strict";
import test from "node:test";
import { calculateCost } from "../packages/ai/src/models.ts";
import { getAiGatewayCost, getModelsDevCost, getOpenRouterCost } from "../packages/ai/scripts/catalog-pricing.ts";
import type { Api, Model, Usage } from "../packages/ai/src/types.ts";
import { catalogFixtures, generateCatalog, tieredCost } from "./fixtures/catalog-generator.ts";

const providers = [
	"amazon-bedrock", "anthropic", "google", "google-vertex", "openai", "azure-openai-responses", "groq", "cerebras",
	"cloudflare-workers-ai", "cloudflare-ai-gateway", "xai", "zai", "zai-coding-cn", "mistral", "huggingface",
	"nvidia", "together", "opencode", "opencode-go", "github-copilot", "minimax", "minimax-cn", "kimi-coding",
	"moonshotai", "moonshotai-cn", "xiaomi", "xiaomi-token-plan-cn", "xiaomi-token-plan-ams", "xiaomi-token-plan-sgp",
	"qwen-token-plan", "qwen-token-plan-individual", "qwen-token-plan-cn", "baseten", "fireworks",
];
const generated = generateCatalog(catalogFixtures());
function fixtureModel(catalog: Awaited<typeof generated>, provider: string): Model<Api> {
	const id = provider.startsWith("minimax") ? "MiniMax-M3" : provider === "google-vertex" ? "gemini-tier-fixture"
		: provider.startsWith("qwen-token-plan") && provider !== "qwen-token-plan-cn" ? "qwen3.8-max" : "gpt-tier-fixture";
	const result = catalog[provider]?.[id];
	assert.ok(result, `missing fixture ${provider}/${id}`);
	return result;
}
export function fixtureUsage(tokens: number): Usage {
	return { input: tokens - 30, output: 10, cacheRead: 10, cacheWrite: 20, totalTokens: tokens + 10,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
}
for (const provider of providers) {
	test(`generated ${provider} preserves tiers through JSON and prices total prompt boundaries`, async () => {
		const model = fixtureModel(await generated, provider);
		assert.equal(model.cost.tiers?.length, 2);
		for (const tokens of [99, 100, 101, 199, 200, 201]) {
			const inputRate = tokens > 200 ? 6 : tokens > 100 ? 4 : 2;
			const outputRate = tokens > 200 ? 18 : tokens > 100 ? 12 : 8;
			const usage = fixtureUsage(tokens);
			assert.equal(calculateCost(model, usage), usage.cost);
			assert.equal(usage.cost.input, (inputRate / 1e6) * usage.input);
			assert.equal(usage.cost.output, (outputRate / 1e6) * 10);
			const cacheReadRate = tokens > 200 ? 0.6 : tokens > 100 ? 0.4 : 0.2;
			const cacheWriteRate = provider === "google-vertex" ? 0 : tokens > 200 ? 7.5 : tokens > 100 ? 5 : 2.5;
			assert.equal(usage.cost.cacheRead, (cacheReadRate / 1e6) * 10);
			assert.equal(usage.cost.cacheWrite, (cacheWriteRate * 20) / 1e6);
		}
	});
}

test("models.dev partial tiers inherit base rates independently and preserve explicit zero", async () => {
	const catalog = await generateCatalog(catalogFixtures({ ...tieredCost, tiers: [
		{ tier: { type: "context", size: 100 }, input: 4, cache_read: 0 },
		{ tier: { type: "context", size: 200 }, output: 0 },
		{ tier: { type: "other", size: 50 }, input: 99 },
	] }));
	assert.deepEqual(fixtureModel(catalog, "github-copilot").cost.tiers, [
		{ inputTokensAbove: 100, input: 4, output: 8, cacheRead: 0, cacheWrite: 2.5 },
		{ inputTokensAbove: 200, input: 2, output: 0, cacheRead: 0.2, cacheWrite: 2.5 },
	]);
});

test("pricing conversion retains source ownership, explicit zero and invalid-threshold boundaries", () => {
	const source = structuredClone(tieredCost);
	const original = structuredClone(source);
	const cost = getModelsDevCost(source);
	cost.tiers![0]!.input = 99;
	assert.deepEqual(source, original);
	assert.deepEqual(getModelsDevCost({ input: 0, output: 0, cache_read: 0, cache_write: 0 }),
		{ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
	for (const size of [-1, 0.5, NaN, Infinity]) {
		assert.equal(getModelsDevCost({ tiers: [{ tier: { type: "context", size }, input: 9 }] }).tiers, undefined);
		assert.equal(getOpenRouterCost({ overrides: [{ min_prompt_tokens: size, prompt: "9" }] }).tiers, undefined);
	}
	assert.deepEqual(getOpenRouterCost(undefined), { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
	assert.deepEqual(getAiGatewayCost({ input: "0.000002", output: 0.000008 }),
		{ input: 2, output: 8, cacheRead: 0, cacheWrite: 0 });
	assert.equal(getAiGatewayCost({ input: 0.000002, input_tiers: [{ min: 100, max: 100, cost: 9 }] }).tiers, undefined);
});

test("provider base exceptions survive tier conversion and partial-rate inheritance", async () => {
	const fixtures = catalogFixtures({ input: 2, output: 8, tiers: [{ tier: { type: "context", size: 100 }, input: 4 }] });
	const vertex = fixtures["https://models.dev/api.json"]["google-vertex"].models;
	vertex["gemini-2.5-flash"] = { ...vertex["gemini-tier-fixture"], id: "gemini-2.5-flash", cost: {
		...tieredCost, cache_read: 9, cache_write: 99,
	} };
	const catalog = await generateCatalog(fixtures);
	const corrected = catalog["google-vertex"]!["gemini-2.5-flash"]!.cost;
	assert.equal(corrected.cacheRead, 0.03);
	assert.equal(corrected.cacheWrite, 0);
	for (const tier of corrected.tiers!) {
		assert.equal(tier.cacheRead, 0.03);
		assert.equal(tier.cacheWrite, 0);
	}
	const mistral = fixtureModel(catalog, "mistral").cost;
	assert.equal(mistral.cacheRead, 0.2);
	assert.equal(mistral.tiers![0]!.cacheRead, 0.2);
});

test("long-cache accounting uses the selected request tier without counting output in threshold", async () => {
	const model = fixtureModel(await generated, "anthropic");
	for (const tokens of [100, 101, 200, 201]) {
		const usage = fixtureUsage(tokens);
		usage.output = 1_000_000;
		usage.cacheWrite1h = 5;
		const input = tokens > 200 ? 6 : tokens > 100 ? 4 : 2;
		const write = tokens > 200 ? 7.5 : tokens > 100 ? 5 : 2.5;
		assert.equal(calculateCost(model, usage).cacheWrite, (write * 15 + input * 2 * 5) / 1e6);
	}
});

test("OpenRouter propagates prompt overrides, inherits rates, and excludes timed prices", async () => {
	const fixtures = catalogFixtures();
	fixtures["https://openrouter.ai/api/v1/models"].data.push({ id: "fixture/chat", name: "Fixture", supported_parameters: ["tools"],
		pricing: { prompt: "0.000002", completion: "0.000008", input_cache_read: "0.0000002", input_cache_write: "0.0000025",
			overrides: [
				{ min_prompt_tokens: 100, prompt: "0.000004", input_cache_read: "0" },
				{ min_prompt_tokens: 200, completion: "0" },
				{ min_prompt_tokens: 50, utc_start: 0, prompt: "0.000099" },
				{ min_prompt_tokens: 50, utc_end: 1200, prompt: "0.000099" },
				{ min_prompt_tokens: 50, utc_days: [], prompt: "0.000099" },
			],
		} });
	const model = (await generateCatalog(fixtures)).openrouter!["fixture/chat"]!;
	assert.deepEqual(model.cost.tiers, [
		{ inputTokensAbove: 100, input: 4, output: 8, cacheRead: 0, cacheWrite: 2.5 },
		{ inputTokensAbove: 200, input: 2, output: 0, cacheRead: 0.2, cacheWrite: 2.5 },
	]);
	for (const [tokens, rate] of [[100, 2], [101, 4], [200, 4], [201, 2]]) {
		const usage = fixtureUsage(tokens!);
		assert.equal(calculateCost(model, usage).input, (rate! / 1e6) * usage.input);
	}
});

test("Gateway combines independent inclusive brackets and returns to base at exclusive ends", async () => {
	const fixtures = catalogFixtures();
	fixtures["https://ai-gateway.vercel.sh/v1/models"].data.push({ id: "fixture/chat", tags: ["tool-use"], pricing: {
		input: "0.000002", output: "0.000008", input_cache_read: "0.0000002", input_cache_write: "0.0000025",
		input_tiers: [{ min: 101, max: 201, cost: "0.000004" }],
		output_tiers: [{ min: 151, cost: "0.000012" }],
		input_cache_read_tiers: [{ min: 0, max: 51, cost: "0" }],
	} });
	const model = (await generateCatalog(fixtures))["vercel-ai-gateway"]!["fixture/chat"]!;
	for (const tokens of [40, 50, 51, 100, 101, 150, 151, 200, 201, 250]) {
		const usage = fixtureUsage(tokens);
		const cost = calculateCost(model, usage);
		assert.equal(cost.input, ((tokens >= 101 && tokens < 201 ? 4 : 2) / 1e6) * usage.input);
		assert.equal(cost.output, ((tokens >= 151 ? 12 : 8) / 1e6) * usage.output);
		assert.equal(cost.cacheRead, ((tokens < 51 ? 0 : 0.2) / 1e6) * usage.cacheRead);
		assert.equal(cost.cacheWrite, 2.5 * usage.cacheWrite / 1e6);
	}
});
