import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { InMemoryCredentialStore } from "../packages/ai/src/auth/credential-store.ts";
import { InMemoryModelsStore, MODELS_STORE_PROFILE_REVISION } from "../packages/ai/src/models-store.ts";
import { createModels, type Provider } from "../packages/ai/src/models.ts";
import type { Api, Model } from "../packages/ai/src/types.ts";
import { mergeCatalogModels } from "../packages/coding-agent/src/core/model-catalog-merge.ts";
import { withRemoteCatalog } from "../packages/coding-agent/src/core/remote-catalog-provider.ts";

function model(id: string, name = id): Model<Api> {
	return { id, name, api: "openai-responses", provider: "fixture", baseUrl: "https://fixture.invalid",
		reasoning: false, input: ["text"], contextWindow: 1000, maxTokens: 100,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
}

test("catalog merge preserves order, duplicate precedence, identity and caller arrays", () => {
	const baseline = Object.freeze([model("a"), model("a", "second a"), model("b")]);
	const dynamic = Object.freeze([model("a", "old replacement"), model("c"), model("a", "new replacement"), model("c", "last c")]);
	const result = mergeCatalogModels(baseline, dynamic);
	assert.deepEqual(result, [dynamic[2], baseline[1], baseline[2], dynamic[3]]);
	assert.equal(result[0], dynamic[2]);
	assert.equal(baseline[0]!.name, "a");
	const unchanged = mergeCatalogModels(baseline, []);
	assert.notEqual(unchanged, baseline);
	assert.deepEqual(unchanged, baseline);
	assert.deepEqual(mergeCatalogModels([], []), []);
});

test("catalog merge ID lookup work is linear, including newly appended IDs", () => {
	let idReads = 0;
	function counted(id: string): Model<Api> {
		const value = model(id);
		Object.defineProperty(value, "id", { get() { idReads++; return id; } });
		return value;
	}
	const baseline = Array.from({ length: 4000 }, (_, index) => counted(`m${index}`));
	const dynamic = Array.from({ length: 4000 }, (_, index) => counted(`m${index + 2000}`));
	const result = mergeCatalogModels(baseline, dynamic);
	assert.equal(result.length, 6000);
	assert.equal(idReads, baseline.length + dynamic.length);
});

test("remote catalog getModels reuses the cached merged array", () => {
	let baselineReads = 0;
	const provider = withRemoteCatalog({ id: "fixture", name: "Fixture", auth: {},
		getModels() { baselineReads++; return [model("a")]; },
		stream() { throw new Error("not used"); }, streamSimple() { throw new Error("not used"); } });
	const first = provider.getModels();
	for (let index = 0; index < 100; index++) assert.equal(provider.getModels(), first);
	assert.equal(baselineReads, 1);
});

function fixtureProvider(baseline: readonly Model<Api>[]): Provider {
	return { id: "fixture", name: "Fixture",
		auth: { apiKey: { name: "fixture", resolve: async ({ credential }) =>
			credential ? { auth: { apiKey: credential.key } } : undefined } }, getModels: () => baseline,
		stream() { throw new Error("not used"); }, streamSimple() { throw new Error("not used"); } };
}

test("older catalogs retain missing model IDs without replacing newer built-in definitions", async () => {
	for (const lastModified of [undefined, 0, 999, 1000, 1001]) {
		const baseline = model("shared", "built-in");
		const rows = [model("shared", "remote"), model("remote-only"),
			{ ...model("foreign"), provider: "another-provider" }];
		const store = new InMemoryModelsStore();
		const registry = createModels({ modelsStore: store });
		await store.write("fixture", { models: rows, lastModified, checkedAt: Date.now(),
			profileRevision: MODELS_STORE_PROFILE_REVISION, etag: '"stored"' });
		try {
			const provider = withRemoteCatalog(fixtureProvider([baseline]), "http://127.0.0.1:1", 1000);
			registry.setProvider(provider);
			assert.equal((await registry.refresh({ allowNetwork: false })).errors.size, 0);
			assert.ok(registry.getModel("fixture", "remote-only"), `missing model with timestamp ${lastModified}`);
			assert.equal(registry.getModel("fixture", "shared")?.name,
				lastModified !== undefined && lastModified > 1000 ? "remote" : "built-in");
			assert.equal(registry.getModel("fixture", "foreign"), undefined);
			const snapshot = provider.getModels();
			for (let index = 0; index < 100; index++) assert.equal(provider.getModels(), snapshot);
			assert.deepEqual((await store.read("fixture"))?.models, rows);
		} finally {
			registry.clearProviders();
			await store.delete("fixture");
		}
	}
});

test("older HTTP catalogs preserve missing models through 200, 304 and offline reopen", async () => {
	const rows = [model("shared", "remote"), model("remote-only")];
	const requests: Array<string | undefined> = [];
	const server = createServer((request, response) => {
		requests.push(request.headers["if-none-match"]);
		if (request.headers["if-none-match"]) {
			response.writeHead(304);
			response.end();
		} else {
			response.writeHead(200, { "content-type": "application/json", etag: '"old-catalog"',
				"last-modified": new Date(1000).toUTCString() });
			response.end(JSON.stringify({ models: rows }));
		}
	});
	const store = new InMemoryModelsStore();
	const credentials = new InMemoryCredentialStore();
	await credentials.modify("fixture", async () => ({ type: "api_key", key: "fixture-only" }));
	const registry = createModels({ modelsStore: store, credentials });
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	try {
		const address = server.address();
		assert.ok(address && typeof address !== "string");
		for (const allowNetwork of [true, true, false]) {
			registry.setProvider(withRemoteCatalog(fixtureProvider([model("shared", "built-in")]),
				`http://127.0.0.1:${address.port}`, 2000));
			assert.equal((await registry.refresh({ allowNetwork, force: true })).errors.size, 0);
			assert.ok(registry.getModel("fixture", "remote-only"));
			assert.equal(registry.getModel("fixture", "shared")?.name, "built-in");
		}
		assert.deepEqual(requests, [undefined, '"old-catalog"']);
		assert.equal((await store.read("fixture"))?.lastModified, 1000);
	} finally {
		registry.clearProviders();
		await store.delete("fixture");
		server.closeAllConnections();
		await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
	}
});

test("removed catalog endpoints clear remote-only models immediately and on offline reopen", async () => {
	for (const status of [404, 501]) {
		const server = createServer((_request, response) => { response.writeHead(status).end(); });
		const store = new InMemoryModelsStore(), credentials = new InMemoryCredentialStore();
		await credentials.modify("fixture", async () => ({ type: "api_key", key: "fixture-only" }));
		await store.write("fixture", { models: [model("remote-only")], lastModified: 1, etag: '"obsolete"', profileRevision: MODELS_STORE_PROFILE_REVISION });
		const registry = createModels({ modelsStore: store, credentials });
		await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
		try {
			const address = server.address(); assert.ok(address && typeof address !== "string");
			const endpoint = `http://127.0.0.1:${address.port}`;
			const provider = withRemoteCatalog(fixtureProvider([model("built-in")]), endpoint, 2);
			registry.setProvider(provider);
			await registry.refresh({ allowNetwork: false });
			assert.ok(registry.getModel("fixture", "remote-only"));
			assert.equal((await registry.refresh({ allowNetwork: true, force: true })).errors.size, 0);
			assert.equal(registry.getModel("fixture", "remote-only"), undefined);
			assert.ok(registry.getModel("fixture", "built-in"));
			assert.deepEqual((await store.read("fixture"))?.models, []);
			assert.equal((await store.read("fixture"))?.etag, undefined);
			registry.setProvider(withRemoteCatalog(fixtureProvider([model("built-in")]), endpoint, 2));
			await registry.refresh({ allowNetwork: false });
			assert.equal(registry.getModel("fixture", "remote-only"), undefined);
		} finally {
			registry.clearProviders(); server.closeAllConnections();
			await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
		}
	}
});

test("stale canonical aliases cannot replace a corrected built-in model", async () => {
	const providerId = "cloudflare-ai-gateway";
	const baseline = { ...model("claude-sonnet-4-5", "corrected"), provider: providerId, api: "anthropic-messages" as const };
	const raw = { ...baseline, id: "claude-sonnet-4.5", name: "stale" };
	const store = new InMemoryModelsStore();
	const registry = createModels({ modelsStore: store });
	await store.write(providerId, { models: [raw], lastModified: 1, profileRevision: MODELS_STORE_PROFILE_REVISION });
	try {
		registry.setProvider(withRemoteCatalog({ ...fixtureProvider([baseline]), id: providerId }, undefined, 2));
		assert.equal((await registry.refresh({ allowNetwork: false })).errors.size, 0);
		assert.equal(registry.getModel(providerId, baseline.id)?.name, "corrected");
		assert.equal(registry.getModel(providerId, raw.id), undefined);
		assert.deepEqual((await store.read(providerId))?.models, [raw]);
	} finally {
		registry.clearProviders();
		await store.delete(providerId);
	}
});
