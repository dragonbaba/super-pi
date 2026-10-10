import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import test from "node:test";
import { anthropicMessagesApi } from "../packages/ai/src/api/anthropic-messages.lazy.ts";
import { InMemoryCredentialStore } from "../packages/ai/src/auth/credential-store.ts";
import { CLOUDFLARE_AI_GATEWAY_ANTHROPIC_BASE_URL, CLOUDFLARE_AI_GATEWAY_COMPAT_BASE_URL,
	CLOUDFLARE_AI_GATEWAY_OPENAI_BASE_URL } from "../packages/ai/src/api/cloudflare.ts";
import { createModels, createProvider } from "../packages/ai/src/models.ts";
import { InMemoryModelsStore, MODELS_STORE_PROFILE_REVISION } from "../packages/ai/src/models-store.ts";
import { cloudflareAIGatewayProvider } from "../packages/ai/src/providers/cloudflare-ai-gateway.ts";
import { cloudflareStreams } from "../packages/ai/src/providers/cloudflare-stream.ts";
import type { Model } from "../packages/ai/src/types.ts";
import { ModelConfig } from "../packages/coding-agent/src/core/model-config.ts";
import { ModelRuntime } from "../packages/coding-agent/src/core/model-runtime.ts";
import { restoreModelFromSession } from "../packages/coding-agent/src/core/model-resolver.ts";
import { FileModelsStore } from "../packages/coding-agent/src/core/models-store.ts";
import { composeModelProvider } from "../packages/coding-agent/src/core/provider-composer.ts";
import { withRemoteCatalog } from "../packages/coding-agent/src/core/remote-catalog-provider.ts";
import { catalogFixtures, generateCatalog, tieredCost } from "./fixtures/catalog-generator.ts";
import manifest from "../packages/ai/src/providers/data/.manifest.json" with { type: "json" };

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
			models: ["custom.claude-4.5", "claude-custom-4.5"].map(id => ({ id, name: "Explicit custom deployment", api: "anthropic-messages",
				baseUrl: CLOUDFLARE_AI_GATEWAY_ANTHROPIC_BASE_URL, reasoning: false, input: ["text"],
				cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1000, maxTokens: 100 })),
		} } }));
		const config = await ModelConfig.load(path);
		const provider = composeModelProvider(providerId, shipped, config, undefined);
		assert.equal(provider.getModels().find(model => model.id === "claude-sonnet-4-5")?.cost.input, 9);
		assert.ok(provider.getModels().find(model => model.id === "custom.claude-4.5"));
		assert.equal(provider.getModels().find(model => model.id === "custom-claude-4-5"), undefined);
		assert.ok(provider.getModels().find(model => model.id === "claude-custom-4.5"));
		assert.equal(provider.getModels().find(model => model.id === "claude-custom-4-5"), undefined);
		assert.equal(shipped.getModels().find(model => model.id === "claude-sonnet-4-5")?.cost.input, 3);
	} finally {
		assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep));
		await rm(directory, { recursive: true, force: true });
	}
});

const generatedAt = Date.parse(manifest.generatedAt);
const cacheLastModified = generatedAt + 60_000;
const gatewayEnv = { CLOUDFLARE_ACCOUNT_ID: "fixture-account", CLOUDFLARE_GATEWAY_ID: "fixture-gateway" };

async function configuredCredentials() {
	const credentials = new InMemoryCredentialStore();
	await credentials.modify(providerId, async () => ({ type: "api_key", key: "fixture-only", env: gatewayEnv }));
	return credentials;
}

async function oldCloudflareRows() {
	const catalog = (await generated)[providerId]!;
	return renamed.map(([dotted, dashed]) => ({ ...catalog[dashed]!, id: dotted,
		name: `Cached ${dotted}`, cost: { ...catalog[dashed]!.cost, input: 11 } }));
}

for (const profileRevision of [undefined, MODELS_STORE_PROFILE_REVISION]) {
	test(`Cloudflare old dotted cache is canonical offline and within freshness window (revision ${profileRevision})`, async () => {
		const store = new InMemoryModelsStore();
		const registry = createModels({ modelsStore: store, credentials: await configuredCredentials() });
		const rows = await oldCloudflareRows();
		const before = structuredClone(rows);
		await store.write(providerId, { models: rows, profileRevision, checkedAt: Date.now(), lastModified: cacheLastModified, etag: '"old"' });
		try {
			for (const allowNetwork of [false, true, false]) {
				// A failed freshness gate would contact this closed loopback port and fail the refresh.
				registry.setProvider(withRemoteCatalog(shipped, "http://127.0.0.1:1", generatedAt));
				assert.equal((await registry.refresh({ providers: [providerId], allowNetwork })).errors.size, 0);
				for (const [dotted, dashed] of renamed) {
					assert.equal(registry.getModel(providerId, dotted), undefined);
					const model = registry.getModel(providerId, dashed)!;
					assert.equal(registry.getModels().filter(row => row.id === dashed).length, 1);
					assert.equal(model.name, `Cached ${dotted}`);
					assert.deepEqual(model.cost, rows.find(row => row.id === dotted)!.cost);
				}
			}
			assert.deepEqual(rows, before);
			const stored = await store.read(providerId);
			assert.deepEqual(stored?.models.map(model => model.id), rows.map(model => model.id));
			assert.equal(stored?.etag, '"old"');
			assert.equal(stored?.lastModified, cacheLastModified);
		} finally {
			registry.clearProviders();
			await store.delete(providerId);
		}
	});
}

test("Cloudflare dotted remote rows merge canonically across 304, HTTP 200, failure and offline reopen", async () => {
	const rows = await oldCloudflareRows();
	const future = { ...rows[0]!, id: "claude-future-5.5-20261010" };
	const canonical = { ...rows[0]!, id: "claude-haiku-4-5", cost: { ...rows[0]!.cost, input: 19 } };
	const openai = (await generated)[providerId]!["gpt-fixture-5.4"]!;
	const workers = (await generated)[providerId]!["workers-ai/@cf/meta/llama-3.1"]!;
	const otherApi = { ...openai, id: "claude-route-4.5" };
	const nonClaude = { ...rows[0]!, id: "deployment.4.5" };
	const cached = [canonical, ...rows, future, openai, workers, otherApi, nonClaude];
	const downloaded = [...rows, canonical, future, openai, workers, otherApi, nonClaude];
	let status = 304;
	let requests = 0;
	const server = createServer((request, response) => {
		requests++;
		assert.equal(request.headers["if-none-match"], '"old"');
		response.writeHead(status, { "content-type": "application/json", etag: '"old"',
			"last-modified": new Date(cacheLastModified).toUTCString() });
		response.end(status === 200 ? JSON.stringify({ models: downloaded }) : undefined);
	});
	const store = new InMemoryModelsStore();
	const registry = createModels({ modelsStore: store, credentials: await configuredCredentials() });
	await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
	try {
		const address = server.address();
		assert.ok(address && typeof address !== "string");
		const baseUrl = `http://127.0.0.1:${address.port}`;
		await store.write(providerId, { models: cached, profileRevision: MODELS_STORE_PROFILE_REVISION,
			checkedAt: 0, lastModified: cacheLastModified, etag: '"old"' });
		registry.setProvider(withRemoteCatalog(shipped, baseUrl, generatedAt));
		for (const nextStatus of [304, 200, 304, 400]) {
			status = nextStatus;
			const result = await registry.refresh({ providers: [providerId], allowNetwork: true, force: true });
			assert.equal(result.errors.size, status === 400 ? 1 : 0);
			for (const [dotted, dashed] of renamed) {
				assert.equal(registry.getModel(providerId, dotted), undefined);
				assert.equal(registry.getModels().filter(row => row.id === dashed).length, 1);
			}
			assert.equal(registry.getModel(providerId, canonical.id)!.cost.input, requests === 1 ? 11 : 19);
			assert.ok(registry.getModel(providerId, "claude-future-5-5-20261010"));
			for (const unchanged of [openai, workers, otherApi, nonClaude]) assert.ok(registry.getModel(providerId, unchanged.id));
		}
		assert.equal(requests, 4);
		registry.setProvider(withRemoteCatalog(shipped, baseUrl, generatedAt));
		assert.equal((await registry.refresh({ allowNetwork: false })).errors.size, 0);
		assert.equal(registry.getModel(providerId, "claude-sonnet-4.5"), undefined);
		assert.equal(registry.getModel(providerId, canonical.id)!.cost.input, 19);
		assert.equal(requests, 4);
	} finally {
		registry.clearProviders();
		await store.delete(providerId);
		server.closeAllConnections();
		await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
	}
});

test("remote ID correction does not rewrite another provider's Claude catalog", async () => {
	const model = { ...(await oldCloudflareRows())[0]!, provider: "other-provider" };
	const provider = createProvider({ id: model.provider, auth: {}, models: [], api: anthropicMessagesApi() });
	const store = new InMemoryModelsStore();
	const registry = createModels({ modelsStore: store });
	try {
		await store.write(provider.id, { models: [model], lastModified: cacheLastModified });
		registry.setProvider(withRemoteCatalog(provider, "http://127.0.0.1:1", generatedAt));
		assert.equal((await registry.refresh({ allowNetwork: false })).errors.size, 0);
		assert.ok(registry.getModel(provider.id, model.id));
	} finally {
		registry.clearProviders();
		await store.delete(provider.id);
	}
});

test("ModelRuntime reopens a persisted dotted catalog and session fallback dispatches a canonical ID", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-cloudflare-upgrade-"));
	const path = join(directory, "models-store.json");
	const rows = await oldCloudflareRows();
	try {
		for (const profileRevision of [undefined, MODELS_STORE_PROFILE_REVISION]) {
			const store = new FileModelsStore(path);
			await store.write(providerId, { models: rows, profileRevision, checkedAt: Date.now(), lastModified: cacheLastModified });
			const runtime = await ModelRuntime.create({ credentials: await configuredCredentials(),
				modelsPath: null, modelsStore: new FileModelsStore(path), allowModelNetwork: false });
			assert.equal(runtime.getModel(providerId, "claude-sonnet-4.5"), undefined);
			const canonical = runtime.getModel(providerId, "claude-sonnet-4-5")!;
			assert.equal(canonical.cost.input, 11);
			const restored = await restoreModelFromSession(providerId, "claude-sonnet-4.5", canonical, false, runtime);
			assert.equal(restored.model, canonical);
			assert.match(restored.fallbackMessage!, /model no longer exists/);
			for (const entry of ["stream", "streamSimple"] as const) {
				let requests = 0;
				const result = await runtime[entry](restored.model!, { messages: [{ role: "user", content: "hello", timestamp: 0 }] }, {
					apiKey: "fixture-only", env: gatewayEnv, maxRetries: 0, fetch: async (url, init) => {
						requests++;
						assert.equal(String(url), "https://gateway.ai.cloudflare.com/v1/fixture-account/fixture-gateway/anthropic/v1/messages");
						assert.equal(JSON.parse(String(init?.body)).model, canonical.id);
						return new Response("fixture failure", { status: 400 });
					},
				}).result();
				assert.equal(requests, 1);
				assert.equal(result.stopReason, "error");
			}
			await store.delete(providerId);
		}
	} finally {
		assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep));
		await rm(directory, { recursive: true, force: true });
	}
});
