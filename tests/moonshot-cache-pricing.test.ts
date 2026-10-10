import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import test from "node:test";
import { openAICompletionsApi } from "../packages/ai/src/api/openai-completions.lazy.ts";
import { getModelsDevCost } from "../packages/ai/scripts/catalog-pricing.ts";
import { createModels, createProvider } from "../packages/ai/src/models.ts";
import { InMemoryModelsStore, MODELS_STORE_PROFILE_REVISION } from "../packages/ai/src/models-store.ts";
import { moonshotaiProvider } from "../packages/ai/src/providers/moonshotai.ts";
import { moonshotaiCnProvider } from "../packages/ai/src/providers/moonshotai-cn.ts";
import type { Model } from "../packages/ai/src/types.ts";
import { ModelConfig } from "../packages/coding-agent/src/core/model-config.ts";
import { composeModelProvider } from "../packages/coding-agent/src/core/provider-composer.ts";
import { withRemoteCatalog } from "../packages/coding-agent/src/core/remote-catalog-provider.ts";
import { catalogFixtures, generateCatalog, tieredCost } from "./fixtures/catalog-generator.ts";

const providerIds = ["moonshotai", "moonshotai-cn"] as const;
const shipped = [moonshotaiProvider(), moonshotaiCnProvider()];
const prices = { input: 3, output: 15, cache_read: 0.3, cache_write: 99 };

function fixturesFor(cost: unknown) {
	const fixtures = catalogFixtures();
	for (const provider of providerIds) {
		fixtures["https://models.dev/api.json"][provider].models["kimi-k3"] = {
			id: "kimi-k3", name: "Kimi K3", tool_call: true, reasoning: true, cost,
			limit: { context: 1_048_576, output: 131_072 }, modalities: { input: ["text", "image"] },
		};
	}
	return fixtures;
}

const generated = generateCatalog(fixturesFor(prices));
for (const [label, cost] of [
	["missing prices", undefined], ["missing write price", { input: 3, output: 15, cache_read: 0.3 }],
	["old zero write price", { ...prices, cache_write: 0 }], ["conflicting write price", prices],
	["base and context tiers", { ...tieredCost, cache_write: 99, tiers: [
		{ tier: { type: "context", size: 100 }, input: 4, cache_write: 88 },
		{ tier: { type: "context", size: 200 }, input: 0, cache_write: 77 },
		{ tier: { type: "context", size: 300 }, output: 0 },
	] }],
] as const) {
	test(`Moonshot K3 default write rate equals accepted input rate: ${label}`, async () => {
		const fixtures = fixturesFor(cost);
		const before = structuredClone(fixtures);
		const catalog = await generateCatalog(fixtures);
		for (const provider of providerIds) {
			const model = catalog[provider]!["kimi-k3"]!;
			assert.equal(model.cost.cacheWrite, model.cost.input);
			for (const tier of model.cost.tiers ?? []) assert.equal(tier.cacheWrite, tier.input);
			assert.equal(model.contextWindow, 1_048_576);
			assert.equal(model.maxTokens, 131_072);
			assert.equal(model.baseUrl, provider === "moonshotai" ? "https://api.moonshot.ai/v1" : "https://api.moonshot.cn/v1");
		}
		assert.deepEqual(fixtures, before);
	});
}

test("Moonshot K3 correction leaves non-K3, reseller and subscription rates intact", async () => {
	const fixtures = fixturesFor(prices);
	fixtures["https://openrouter.ai/api/v1/models"].data.push({ id: "moonshotai/kimi-k3", name: "Reseller",
		supported_parameters: ["tools"], pricing: { prompt: "0.000004", completion: "0.000019",
			input_cache_read: "0.0000005", input_cache_write: "0.000009" } });
	fixtures["https://models.dev/api.json"]["kimi-for-coding"].models.k3 = {
		...fixtures["https://models.dev/api.json"].moonshotai.models["kimi-k3"], id: "k3",
		cost: { input: 0, output: 0, cache_read: 0, cache_write: 0 },
	};
	const catalog = await generateCatalog(fixtures);
	for (const provider of providerIds) assert.deepEqual(catalog[provider]!["gpt-tier-fixture"]!.cost, getModelsDevCost(tieredCost));
	assert.deepEqual(catalog.openrouter!["moonshotai/kimi-k3"]!.cost, { input: 4, output: 19, cacheRead: 0.5, cacheWrite: 9 });
	assert.deepEqual(catalog["kimi-coding"]!.k3!.cost, { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 0 });
});

for (const providerId of providerIds) {
	test(`${providerId} ships the default K3 write price in the existing USD cost convention`, () => {
		const provider = shipped.find(provider => provider.id === providerId)!;
		assert.deepEqual(provider.getModels().find(model => model.id === "kimi-k3")!.cost,
			{ input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3 });
	});
	for (const source of ["generated", "shipped"] as const) {
		for (const entry of ["stream", "streamSimple"] as const) {
			test(`${providerId} ${source} ${entry} accounts default cache writes without double counting`, async () => {
				const model = (source === "generated" ? (await generated)[providerId]!["kimi-k3"]
					: shipped.find(provider => provider.id === providerId)!.getModels().find(model => model.id === "kimi-k3")) as Model<"openai-completions">;
				const provider = createProvider({ id: providerId, auth: {}, models: [model], api: openAICompletionsApi() });
				for (const [read, write] of [[400, 200], [1000, 0], [0, 1000], [0, 0]] as const) {
					let requests = 0;
					const result = await provider[entry](provider.getModels()[0]!, { messages: [{ role: "user", content: "fixture", timestamp: 0 }] }, {
						apiKey: "fixture-only", maxRetries: 0, fetch: async (url, init) => {
							requests++;
							assert.equal(String(url), `${model.baseUrl}/chat/completions`);
							const payload = JSON.parse(String(init?.body));
							assert.equal(payload.model, "kimi-k3");
							assert.equal(payload.stream_options.include_usage, true);
							assert.equal(payload.prompt_cache_options, undefined);
							const chunk = { id: "fixture", object: "chat.completion.chunk", model: "kimi-k3", created: 0,
								choices: [{ index: 0, delta: { content: "ok" }, finish_reason: "stop" }],
								usage: { prompt_tokens: 1000, completion_tokens: 100, total_tokens: 1100,
									prompt_tokens_details: { cached_tokens: read, cache_write_tokens: write } } };
							return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
						},
					}).result();
					assert.equal(result.stopReason, "stop", result.errorMessage);
					assert.equal(requests, 1);
					assert.equal(result.usage.input, 1000 - read - write);
					assert.equal(result.usage.cacheRead, read);
					assert.equal(result.usage.cacheWrite, write);
					assert.equal(result.usage.totalTokens, 1100);
					assert.equal(result.usage.cost.cacheWrite, 3 * write / 1e6);
					assert.ok(Math.abs(result.usage.cost.total - (3 * (1000 - read) + 0.3 * read + 15 * 100) / 1e6) < 1e-12);
				}
			});
		}
	}
}

test("K3 prices survive current/legacy catalog restore while newer raw prices remain authoritative", async () => {
	const store = new InMemoryModelsStore();
	const registry = createModels({ modelsStore: store });
	try {
		for (const provider of shipped) {
			for (const profileRevision of [undefined, MODELS_STORE_PROFILE_REVISION]) {
				const raw = (await generated)[provider.id]!["kimi-k3"]!;
				for (const cacheWrite of [3, 7]) {
					await store.write(provider.id, { models: [{ ...raw, cost: { ...raw.cost, cacheWrite } }],
						profileRevision, checkedAt: Date.now(), lastModified: 2 });
					registry.setProvider(withRemoteCatalog(provider, "http://127.0.0.1:1", 1));
					assert.equal((await registry.refresh({ providers: [provider.id], allowNetwork: false })).errors.size, 0);
					assert.equal(registry.getModel(provider.id, "kimi-k3")!.cost.cacheWrite, cacheWrite);
				}
			}
			await store.delete(provider.id);
		}
	} finally {
		registry.clearProviders();
		for (const id of providerIds) await store.delete(id);
	}
});

test("explicit model cost overrides retain precedence over the K3 default rate", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-moonshot-pricing-"));
	try {
		for (const cacheWrite of [0, 9]) {
			const path = join(directory, "models.json");
			await writeFile(path, JSON.stringify({ providers: { moonshotai: {
				modelOverrides: { "kimi-k3": { cost: { cacheWrite } } },
			} } }));
			const provider = composeModelProvider("moonshotai", shipped[0], await ModelConfig.load(path), undefined);
			assert.equal(provider.getModels().find(model => model.id === "kimi-k3")!.cost.cacheWrite, cacheWrite);
		}
	} finally {
		assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep));
		await rm(directory, { recursive: true, force: true });
	}
});
