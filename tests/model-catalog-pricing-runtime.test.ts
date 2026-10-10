import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { InMemoryCredentialStore } from "../packages/ai/src/auth/credential-store.ts";
import { envApiKeyAuth } from "../packages/ai/src/auth/helpers.ts";
import { InMemoryModelsStore, MODELS_STORE_PROFILE_REVISION } from "../packages/ai/src/models-store.ts";
import { calculateCost, createModels, createProvider } from "../packages/ai/src/models.ts";
import type { Api, Model, Usage } from "../packages/ai/src/types.ts";
import { ModelConfig } from "../packages/coding-agent/src/core/model-config.ts";
import { composeModelProvider } from "../packages/coding-agent/src/core/provider-composer.ts";
import { withRemoteCatalog } from "../packages/coding-agent/src/core/remote-catalog-provider.ts";
import { catalogFixtures, generateCatalog } from "./fixtures/catalog-generator.ts";

function usage(): Usage {
	return { input: 71, output: 10, cacheRead: 10, cacheWrite: 20, totalTokens: 111,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
}
function provider(model: Model<Api>) {
	return createProvider({ id: model.provider, models: [model], auth: { apiKey: envApiKeyAuth("Fixture", []) },
		api: { stream() { throw new Error("unexpected stream"); }, streamSimple() { throw new Error("unexpected stream"); } } });
}

for (const providerId of ["amazon-bedrock", "openai", "github-copilot"]) {
	test(`${providerId}: generated costs survive online/304/error restore and user override`, async () => {
		const generated = await generateCatalog(catalogFixtures());
		const model = generated[providerId]!["gpt-tier-fixture"]!;
		const expected = structuredClone(model.cost);
		let status = 200;
		let requests = 0;
		const server = createServer((request, response) => {
			requests++;
			if (status === 304) assert.equal(request.headers["if-none-match"], '"pricing"');
			response.writeHead(status, { "content-type": "application/json", etag: '"pricing"',
				"last-modified": new Date(Date.now() + 60_000).toUTCString() });
			response.end(status === 200 ? JSON.stringify({ models: [model] }) : undefined);
		});
		await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
		const store = new InMemoryModelsStore();
		const credentials = new InMemoryCredentialStore();
		await credentials.modify(providerId, async () => ({ type: "api_key", key: "fixture" }));
		const models = createModels({ modelsStore: store, credentials });
		const directory = await mkdtemp(join(tmpdir(), "pi-pricing-"));
		try {
			const address = server.address();
			assert.ok(address && typeof address !== "string");
			const base = { ...model, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
			const remote = withRemoteCatalog(provider(base), `http://127.0.0.1:${address.port}`);
			models.setProvider(remote);
			for (const responseStatus of [200, 304, 400]) {
				status = responseStatus;
				const result = await models.refresh({ providers: [providerId], allowNetwork: true, force: true });
				assert.equal(result.errors.size, status === 400 ? 1 : 0);
				const loaded = models.getModel(providerId, model.id)!;
				assert.deepEqual(loaded.cost, expected);
				assert.equal(calculateCost(loaded, usage()).input, (4 / 1e6) * 71);
			}
			const stored = await store.read(providerId);
			assert.deepEqual(stored?.models[0]?.cost, expected);
			const beforeOffline = requests;
			for (const profileRevision of [undefined, MODELS_STORE_PROFILE_REVISION]) {
				await store.write(providerId, { ...stored!, profileRevision });
				models.setProvider(withRemoteCatalog(provider(base)));
				assert.equal((await models.refresh({ providers: [providerId], allowNetwork: false })).errors.size, 0);
				assert.deepEqual(models.getModel(providerId, model.id)!.cost, expected);
			}
			assert.equal(requests, beforeOffline);
			// Explicit custom prices remain the final layer, including [] to clear tiers.
			for (const tiers of [undefined, [], [{ inputTokensAbove: 50, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }]]) {
				const configPath = join(directory, "models.json");
				await writeFile(configPath, JSON.stringify({ providers: { [providerId]: {
					modelOverrides: { [model.id]: { cost: { input: 9, tiers } } },
				} } }));
				const composed = composeModelProvider(providerId, models.getProvider(providerId), await ModelConfig.load(configPath), undefined);
				const overridden = composed.getModels().find(item => item.id === model.id)!;
				assert.equal(overridden.cost.input, 9);
				assert.deepEqual(overridden.cost.tiers, tiers ?? expected.tiers);
			}
			assert.deepEqual(model.cost, expected);
		} finally {
			models.clearProviders();
			await store.delete(providerId);
			server.closeAllConnections();
			await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
			assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + "\\") || resolve(directory).startsWith(resolve(tmpdir()) + "/"));
			await rm(directory, { recursive: true, force: true });
		}
	});
}
