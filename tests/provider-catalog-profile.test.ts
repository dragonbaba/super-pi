import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { InMemoryCredentialStore } from "../packages/ai/src/auth/credential-store.ts";
import { InMemoryModelsStore, MODELS_STORE_PROFILE_REVISION } from "../packages/ai/src/models-store.ts";
import { createModels, createProvider, type Provider } from "../packages/ai/src/models.ts";
import { amazonBedrockProvider } from "../packages/ai/src/providers/amazon-bedrock.ts";
import { googleVertexProvider } from "../packages/ai/src/providers/google-vertex.ts";
import { googleProvider } from "../packages/ai/src/providers/google.ts";
import { mistralProvider } from "../packages/ai/src/providers/mistral.ts";
import { profileMistralModel } from "../packages/ai/src/providers/mistral-profile.ts";
import type { Api, Model } from "../packages/ai/src/types.ts";
import { withRemoteCatalog } from "../packages/coding-agent/src/core/remote-catalog-provider.ts";

function rawCatalogModel(model: Model<Api>): Model<Api> {
	const {
		capabilities: _capabilities,
		profileSource: _profileSource,
		profileDiagnostics: _profileDiagnostics,
		thinkingBudgetMap: _thinkingBudgetMap,
		...raw
	} = model;
	return structuredClone(raw) as Model<Api>;
}

async function configuredCredentials(providerId: string): Promise<InMemoryCredentialStore> {
	const credentials = new InMemoryCredentialStore();
	await credentials.modify(providerId, async () => ({ type: "api_key", key: "catalog-fixture-key" }));
	return credentials;
}

async function withCatalogServer<T>(models: readonly Model<Api>[], run: (baseUrl: string) => Promise<T>): Promise<T> {
	const server = createServer((_request, response) => {
		response.writeHead(200, {
			"content-type": "application/json",
			"last-modified": new Date(Date.now() + 60_000).toUTCString(),
			etag: '"catalog-fixture"',
		});
		response.end(JSON.stringify({ models }));
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	try {
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("catalog fixture server did not bind a TCP port");
		return await run(`http://127.0.0.1:${address.port}`);
	} finally {
		await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
	}
}

async function fetchRemoteReplacement(
	provider: Provider,
	rawModel: Model<Api>,
): Promise<{ model: Model<Api>; stored: Awaited<ReturnType<InMemoryModelsStore["read"]>> }> {
	return withCatalogServer([rawModel], async (baseUrl) => {
		const store = new InMemoryModelsStore();
		const models = createModels({
			modelsStore: store,
			credentials: await configuredCredentials(provider.id),
		});
		models.setProvider(withRemoteCatalog(provider, baseUrl));
		const result = await models.refresh({ providers: [provider.id], allowNetwork: true, force: true });
		assert.equal(result.errors.size, 0);
		const replacement = models.getModel(provider.id, rawModel.id);
		assert.ok(replacement);
		return { model: replacement, stored: await store.read(provider.id) };
	});
}

test("Google and Mistral remote same-ID replacements retain provider-owned facts and raw storage", async () => {
	const google = googleProvider();
	const googleStatic = google.getModels().find((model) => model.id === "gemini-3.1-pro-preview");
	assert.ok(googleStatic);
	const googleResult = await fetchRemoteReplacement(google, rawCatalogModel(googleStatic));
	assert.equal(googleResult.model.profileSource, "provider-catalog");
	assert.equal(googleResult.model.capabilities?.strictToolSchema, true);
	assert.equal(googleResult.model.capabilities?.reasoning.mode, "levels");
	assert.equal(googleResult.stored?.models[0]?.capabilities, undefined);
	assert.equal(googleResult.stored?.models[0]?.profileSource, undefined);
	assert.equal(googleResult.stored?.profileRevision, MODELS_STORE_PROFILE_REVISION);

	const mistral = mistralProvider();
	const mistralStatic = mistral.getModels().find((model) => model.id === "mistral-large-latest");
	assert.ok(mistralStatic);
	const mistralResult = await fetchRemoteReplacement(mistral, rawCatalogModel(mistralStatic));
	assert.equal(mistralResult.model.capabilities?.strictToolSchema, true);
	assert.equal(mistralResult.stored?.models[0]?.capabilities, undefined);
});

test("createProvider fetchModels applies its provider profiler before publishing runtime models", async () => {
	const staticModel = mistralProvider().getModels().find((model) => model.id === "mistral-large-latest");
	assert.ok(staticModel);
	const rawModel = { ...rawCatalogModel(staticModel), provider: "direct-mistral" };
	const store = new InMemoryModelsStore();
	const provider = createProvider({
		id: "direct-mistral",
		auth: { apiKey: { name: "fixture", resolve: async () => ({ auth: { apiKey: "fixture" } }) } },
		models: [],
		profileModel: profileMistralModel,
		fetchModels: async () => [rawModel],
		api: {} as never,
	});
	const models = createModels({ modelsStore: store, credentials: await configuredCredentials(provider.id) });
	models.setProvider(provider);
	const result = await models.refresh({ providers: [provider.id], allowNetwork: true });
	assert.equal(result.errors.size, 0);
	assert.equal(models.getModel(provider.id, rawModel.id)?.capabilities?.strictToolSchema, true);
	assert.equal((await store.read(provider.id))?.models[0]?.capabilities, undefined);
});

test("Vertex legacy cache restore profiles with networking disabled", async () => {
	const provider = googleVertexProvider();
	const staticModel = provider.getModels().find((model) => model.id === "gemini-3.1-pro-preview");
	assert.ok(staticModel);
	const store = new InMemoryModelsStore();
	await store.write(provider.id, {
		models: [rawCatalogModel(staticModel)],
		lastModified: Date.now() + 60_000,
		checkedAt: Date.now(),
	});
	const models = createModels({ modelsStore: store });
	models.setProvider(withRemoteCatalog(provider));
	const result = await models.refresh({ providers: [provider.id], allowNetwork: false });
	assert.equal(result.errors.size, 0);
	const restored = models.getModel(provider.id, staticModel.id);
	assert.equal(restored?.profileSource, "provider-catalog");
	assert.equal(restored?.capabilities?.reasoning.mode, "levels");
	assert.equal(restored?.capabilities?.strictToolSchema, true);
	assert.equal((await store.read(provider.id))?.profileRevision, MODELS_STORE_PROFILE_REVISION);
});

test("Bedrock adaptive provider facts rebuild fetched and locally-profiled legacy cache models", async () => {
	const provider = amazonBedrockProvider();
	const staticModel = provider.getModels().find((model) => model.capabilities?.reasoning.mode === "adaptive");
	assert.ok(staticModel);
	const fetched = await fetchRemoteReplacement(provider, rawCatalogModel(staticModel));
	assert.equal(fetched.model.capabilities?.reasoning.mode, "adaptive");

	const staleRuntimeModel = {
		...rawCatalogModel(staticModel),
		capabilities: { ...staticModel.capabilities!, reasoning: { mode: "budget", levels: ["off", "low"] } },
		profileSource: "provider-catalog" as const,
	} as Model<Api>;
	const store = new InMemoryModelsStore();
	await store.write(provider.id, {
		models: [staleRuntimeModel],
		lastModified: Date.now() + 60_000,
	});
	const models = createModels({ modelsStore: store });
	models.setProvider(withRemoteCatalog(provider));
	await models.refresh({ providers: [provider.id], allowNetwork: false });
	assert.equal(models.getModel(provider.id, staticModel.id)?.capabilities?.reasoning.mode, "adaptive");
	const migrated = await store.read(provider.id);
	assert.equal(migrated?.models[0]?.capabilities, undefined);
	assert.equal(migrated?.profileRevision, MODELS_STORE_PROFILE_REVISION);
});
