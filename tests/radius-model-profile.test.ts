import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { InMemoryCredentialStore } from "../packages/ai/src/auth/credential-store.ts";
import { InMemoryModelsStore, MODELS_STORE_PROFILE_REVISION } from "../packages/ai/src/models-store.ts";
import { createModels } from "../packages/ai/src/models.ts";
import { radiusProvider } from "../packages/ai/src/providers/radius.ts";
import type { Api, Model } from "../packages/ai/src/types.ts";

async function configuredCredentials(providerId: string): Promise<InMemoryCredentialStore> {
	const credentials = new InMemoryCredentialStore();
	await credentials.modify(providerId, async () => ({ type: "api_key", key: "radius-fixture-key" }));
	return credentials;
}

async function withRadiusServer<T>(run: (baseUrl: string) => Promise<T>): Promise<T> {
	const server = createServer((_request, response) => {
		response.writeHead(200, { "content-type": "application/json" });
		response.end(JSON.stringify({
			baseUrl: "https://models.radius.test/v1",
			models: [{
				id: "radius-reasoning",
				name: "Radius Reasoning",
				reasoning: true,
				thinkingLevelMap: { low: "low", high: "high" },
				input: ["text", "image"],
				cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1.25 },
				contextWindow: 131_072,
				maxTokens: 16_384,
			}],
		}));
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	try {
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("Radius fixture server did not bind a TCP port");
		return await run(`http://127.0.0.1:${address.port}`);
	} finally {
		await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
	}
}

function assertCatalogProfile(model: Model<Api> | undefined): asserts model is Model<Api> {
	assert.ok(model);
	assert.equal(model.profileSource, "provider-catalog");
	assert.equal(model.capabilities?.version, 1);
	assert.equal(typeof model.costKnown, "boolean");
}

test("Radius network refresh and store restore profile runtime models while persisting raw catalog facts", async () => {
	await withRadiusServer(async (gateway) => {
		const providerId = "radius-network";
		const store = new InMemoryModelsStore();
		const first = createModels({
			modelsStore: store,
			credentials: await configuredCredentials(providerId),
		});
		first.setProvider(radiusProvider({ id: providerId, gateway }));
		assert.equal((await first.refresh({ providers: [providerId], allowNetwork: true })).errors.size, 0);
		const fetched = first.getModel(providerId, "radius-reasoning");
		assertCatalogProfile(fetched);
		assert.equal(fetched.costKnown, true);

		const persisted = await store.read(providerId);
		assert.equal(persisted?.profileRevision, MODELS_STORE_PROFILE_REVISION);
		assert.equal(persisted?.models[0]?.profileSource, undefined);
		assert.equal(persisted?.models[0]?.capabilities, undefined);
		assert.equal(persisted?.models[0]?.costKnown, undefined);

		const restoredModels = createModels({ modelsStore: store });
		restoredModels.setProvider(radiusProvider({ id: providerId, gateway }));
		assert.equal((await restoredModels.refresh({ providers: [providerId], allowNetwork: false })).errors.size, 0);
		const restored = restoredModels.getModel(providerId, "radius-reasoning");
		assertCatalogProfile(restored);
		assert.equal(restored.costKnown, true);
		assert.deepEqual(restored.capabilities, fetched.capabilities);
	});
});

test("Radius legacy OAuth credential import profiles runtime models and migrates raw storage", async () => {
	const providerId = "radius-legacy";
	const credentials = new InMemoryCredentialStore();
	await credentials.modify(providerId, async () => ({
		type: "oauth",
		refresh: "refresh",
		access: "access",
		expires: Date.now() + 60_000,
		gatewayConfig: {
			baseUrl: "https://legacy.radius.test/v1",
			models: [{
				id: "legacy-radius-model",
				name: "Legacy Radius Model",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 32_768,
				maxTokens: 4_096,
			}],
		},
	}));
	const store = new InMemoryModelsStore();
	const models = createModels({ modelsStore: store, credentials });
	models.setProvider(radiusProvider({ id: providerId }));
	assert.equal((await models.refresh({ providers: [providerId], allowNetwork: false })).errors.size, 0);
	const imported = models.getModel(providerId, "legacy-radius-model");
	assertCatalogProfile(imported);
	assert.equal(imported.costKnown, true);
	const persisted = await store.read(providerId);
	assert.equal(persisted?.profileRevision, MODELS_STORE_PROFILE_REVISION);
	assert.equal(persisted?.models[0]?.profileSource, undefined);
	assert.equal(persisted?.models[0]?.capabilities, undefined);
});
