import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import test from "node:test";
import { anthropicMessagesApi } from "../packages/ai/src/api/anthropic-messages.lazy.ts";
import { CLOUDFLARE_AI_GATEWAY_ANTHROPIC_BASE_URL, CLOUDFLARE_AI_GATEWAY_COMPAT_BASE_URL,
	CLOUDFLARE_AI_GATEWAY_OPENAI_BASE_URL } from "../packages/ai/src/api/cloudflare.ts";
import { createModels, createProvider } from "../packages/ai/src/models.ts";
import { InMemoryModelsStore, MODELS_STORE_PROFILE_REVISION } from "../packages/ai/src/models-store.ts";
import { cloudflareAIGatewayProvider } from "../packages/ai/src/providers/cloudflare-ai-gateway.ts";
import { cloudflareStreams } from "../packages/ai/src/providers/cloudflare-stream.ts";
import type { Model } from "../packages/ai/src/types.ts";
import { ModelConfig } from "../packages/coding-agent/src/core/model-config.ts";
import { composeModelProvider } from "../packages/coding-agent/src/core/provider-composer.ts";
import { withRemoteCatalog } from "../packages/coding-agent/src/core/remote-catalog-provider.ts";
import { catalogFixtures, generateCatalog, tieredCost } from "./fixtures/catalog-generator.ts";

const providerId = "cloudflare-ai-gateway";
const renamed = [
	["claude-haiku-4.5", "claude-haiku-4-5"],
	["claude-opus-4.5", "claude-opus-4-5"],
	["claude-opus-4.6", "claude-opus-4-6"],
	["claude-opus-4.7", "claude-opus-4-7"],
	["claude-opus-4.8", "claude-opus-4-8"],
	["claude-sonnet-4.5", "claude-sonnet-4-5"],
	["claude-sonnet-4.6", "claude-sonnet-4-6"],
] as const;
const fixtures = catalogFixtures();
const sourceIds = [...renamed.map(([id]) => `anthropic/${id}`), "anthropic/claude-opus-5.5",
	"anthropic/claude-sonnet-4.5-20250929", "anthropic/claude-sonnet-5", "anthropic/claude-opus-5-5",
	"openai/gpt-fixture-5.4", "workers-ai/@cf/meta/llama-3.1", "unsupported/claude-opus-5.5", "no-slash"];
fixtures["https://models.dev/api.json"][providerId] = { models: Object.fromEntries(sourceIds.map(id => [id, {
	id, name: `Fixture ${id}`, tool_call: true, reasoning: true, cost: tieredCost,
	limit: { context: 200_000, output: 16_000 }, modalities: { input: ["text", "image"], output: ["text"] },
}])) };
fixtures["https://models.dev/api.json"].anthropic.models["claude-fixture-4.5"] = {
	id: "claude-fixture-4.5", name: "Other provider control", tool_call: true,
	cost: tieredCost, limit: { context: 1000, output: 100 },
};
const generated = generateCatalog(fixtures);
const shipped = cloudflareAIGatewayProvider();

for (const [dotted, dashed] of renamed) {
	test(`Cloudflare generator converts ${dotted} to ${dashed}`, async () => {
		const catalog = (await generated)[providerId]!;
		const model = catalog[dashed]!;
		assert.ok(model, `missing ${dashed}`);
		assert.equal(catalog[dotted], undefined);
		assert.equal(model.id, dashed);
		assert.equal(model.api, "anthropic-messages");
		assert.equal(model.baseUrl, CLOUDFLARE_AI_GATEWAY_ANTHROPIC_BASE_URL);
		assert.equal(model.name, `Fixture anthropic/${dotted}`);
		assert.equal(model.contextWindow, 200_000);
		assert.equal(model.maxTokens, 16_000);
		assert.deepEqual(model.input, ["text", "image"]);
		assert.equal(model.cost.input, 2);
		assert.deepEqual(model.cost.tiers?.map(tier => tier.inputTokensAbove), [200, 100]);
	});
	test(`Cloudflare ships ${dashed} without the invalid dotted ID`, () => {
		assert.ok(shipped.getModels().find(model => model.id === dashed));
		assert.equal(shipped.getModels().find(model => model.id === dotted), undefined);
	});
}

test("Cloudflare canonicalizes newer and dated Claude IDs, preserves dashed IDs and deduplicates", async () => {
	const catalog = (await generated)[providerId]!;
	for (const id of ["claude-opus-5-5", "claude-sonnet-4-5-20250929", "claude-sonnet-5"]) assert.ok(catalog[id]);
	assert.equal(catalog["claude-opus-5.5"], undefined);
	assert.equal(Object.keys(catalog).filter(id => id === "claude-opus-5-5").length, 1);
	assert.equal(catalog["claude-opus-5-5"]!.name, "Fixture anthropic/claude-opus-5.5");
	assert.equal(catalog["no-slash"], undefined);
});

test("Cloudflare normalization leaves OpenAI and Workers AI IDs and routes unchanged", async () => {
	const catalog = (await generated)[providerId]!;
	const openai = catalog["gpt-fixture-5.4"]!;
	assert.equal(openai.id, "gpt-fixture-5.4");
	assert.equal(openai.api, "openai-responses");
	assert.equal(openai.baseUrl, CLOUDFLARE_AI_GATEWAY_OPENAI_BASE_URL);
	const workers = catalog["workers-ai/@cf/meta/llama-3.1"]!;
	assert.equal(workers.id, "workers-ai/@cf/meta/llama-3.1");
	assert.equal(workers.api, "openai-completions");
	assert.equal(workers.baseUrl, CLOUDFLARE_AI_GATEWAY_COMPAT_BASE_URL);
	assert.equal(catalog["unsupported/claude-opus-5.5"], undefined);
	assert.ok((await generated).anthropic!["claude-fixture-4.5"]);
});

for (const source of ["generated", "shipped"] as const) {
	for (const entry of ["stream", "streamSimple"] as const) {
		test(`Cloudflare ${source} ${entry} sends native Claude IDs through the Anthropic gateway`, async () => {
			for (const [dotted, dashed] of renamed) {
				const catalog = (await generated)[providerId]!;
				// Fall back to the old record so baseline failures also exercise real dispatch.
				const raw = (catalog[dashed] ?? catalog[dotted]) as Model<"anthropic-messages"> | undefined;
				assert.ok(raw);
				const provider = source === "shipped" ? shipped : createProvider({ id: providerId, auth: {}, models: [raw],
					api: cloudflareStreams(anthropicMessagesApi()) });
				const model = provider.getModels().find(model => model.id === dashed)
					?? provider.getModels().find(model => model.id === dotted)!;
				assert.ok(model, dotted);
				let requests = 0;
				const result = await provider[entry](model, { messages: [{ role: "user", content: "Hello", timestamp: 0 }] }, {
					apiKey: "fixture-only", env: { CLOUDFLARE_ACCOUNT_ID: "fixture-account", CLOUDFLARE_GATEWAY_ID: "fixture-gateway" },
					maxRetries: 0, fetch: async (url, init) => {
						requests++;
						assert.equal(String(url), "https://gateway.ai.cloudflare.com/v1/fixture-account/fixture-gateway/anthropic/v1/messages");
						assert.equal(JSON.parse(String(init?.body)).model, dashed);
						return new Response('event: message_start\ndata: {"type":"message_start","message":{"id":"fixture","type":"message","role":"assistant","content":[],"model":"fixture","usage":{"input_tokens":1,"output_tokens":0}}}\n\nevent: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":0}}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n',
							{ headers: { "content-type": "text/event-stream" } });
					},
				}).result();
				assert.equal(result.stopReason, "stop", result.errorMessage);
				assert.equal(requests, 1);
				assert.equal(model.id, dashed);
				assert.equal(model.baseUrl, CLOUDFLARE_AI_GATEWAY_ANTHROPIC_BASE_URL);
			}
		});
	}
}

test("Cloudflare canonical IDs survive current and legacy remote cache restoration", async () => {
	const store = new InMemoryModelsStore();
	const registry = createModels({ modelsStore: store });
	const models = Object.values((await generated)[providerId]!);
	try {
		for (const profileRevision of [undefined, MODELS_STORE_PROFILE_REVISION]) {
			await store.write(providerId, { models, profileRevision, checkedAt: 0, lastModified: 2 });
			registry.setProvider(withRemoteCatalog(shipped, "https://fixture.invalid", 1));
			assert.equal((await registry.refresh({ allowNetwork: false })).errors.size, 0);
			for (const [dotted, dashed] of renamed) {
				assert.ok(registry.getModel(providerId, dashed));
				assert.equal(registry.getModel(providerId, dotted), undefined);
			}
		}
	} finally {
		registry.clearProviders();
		await store.delete(providerId);
	}
});

test("Cloudflare canonical model overrides and explicit custom IDs remain caller-controlled", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-cloudflare-model-ids-"));
	try {
		const path = join(directory, "models.json");
		await writeFile(path, JSON.stringify({ providers: { [providerId]: {
			modelOverrides: { "claude-sonnet-4-5": { cost: { input: 9 } } },
			models: [{ id: "custom.claude-4.5", name: "Explicit custom deployment", api: "anthropic-messages",
				baseUrl: "https://fixture.invalid/anthropic", reasoning: false, input: ["text"],
				cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1000, maxTokens: 100 }],
		} } }));
		const config = await ModelConfig.load(path);
		const provider = composeModelProvider(providerId, shipped, config, undefined);
		assert.equal(provider.getModels().find(model => model.id === "claude-sonnet-4-5")?.cost.input, 9);
		assert.ok(provider.getModels().find(model => model.id === "custom.claude-4.5"));
		assert.equal(provider.getModels().find(model => model.id === "custom-claude-4-5"), undefined);
		assert.equal(shipped.getModels().find(model => model.id === "claude-sonnet-4-5")?.cost.input, 3);
	} finally {
		assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep));
		await rm(directory, { recursive: true, force: true });
	}
});
