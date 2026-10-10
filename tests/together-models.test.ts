import assert from "node:assert/strict";
import test from "node:test";
import { streamSimple } from "../packages/ai/src/api/openai-completions.ts";
import { openAICompletionsApi } from "../packages/ai/src/api/openai-completions.lazy.ts";
import { createModels, createProvider, getSupportedThinkingLevels } from "../packages/ai/src/models.ts";
import { InMemoryModelsStore, MODELS_STORE_PROFILE_REVISION } from "../packages/ai/src/models-store.ts";
import { togetherProvider } from "../packages/ai/src/providers/together.ts";
import type { Model } from "../packages/ai/src/types.ts";
import { catalogFixtures, generateCatalog } from "./fixtures/catalog-generator.ts";
import { withRemoteCatalog } from "../packages/coding-agent/src/core/remote-catalog-provider.ts";

const renamedId = "deepseek-ai/DeepSeek-V4-Pro-0813";
const legacyId = "deepseek-ai/DeepSeek-V4-Pro";
const flashId = "deepseek-ai/DeepSeek-V4-Flash-0731";
const expectedMap = { minimal: null, low: null, medium: null, high: "high", xhigh: null, max: "max" };
const fixtures = catalogFixtures();
const sourceModels = Object.fromEntries([renamedId, legacyId, flashId, "openai/gpt-oss-120b", "fixture-chat"].map(id => [id, {
	id, name: id, tool_call: true, reasoning: id !== "fixture-chat",
	cost: { input: 1, output: 2, cache_read: 0, cache_write: 0 },
	limit: { context: 1_048_576, output: 384_000 }, modalities: { input: ["text"], output: ["text"] },
}]));
fixtures["https://models.dev/api.json"].togetherai = { models: sourceModels };
const generated = generateCatalog(fixtures);

async function generatedModel(id: string): Promise<Model<"openai-completions">> {
	const raw = (await generated).together![id]! as Model<"openai-completions">;
	assert.ok(raw);
	return createProvider({ id: "together", models: [raw], auth: {}, api: openAICompletionsApi() }).getModels()[0]!;
}

test("Together generator recognizes renamed DeepSeek V4 Pro and enables its documented levels", async () => {
	const value = await generatedModel(renamedId);
	assert.equal(value.compat?.supportsReasoningEffort, true);
	assert.equal(value.compat?.thinkingFormat, "together");
	assert.deepEqual(value.thinkingLevelMap, expectedMap);
	assert.deepEqual(getSupportedThinkingLevels(value), ["off", "high", "max"]);
});

test("Together generator preserves legacy, Flash, GPT-OSS and nonreasoning model controls", async () => {
	const legacy = await generatedModel(legacyId);
	assert.equal(legacy.compat?.supportsReasoningEffort, true);
	assert.deepEqual(legacy.thinkingLevelMap, { minimal: null, low: null, medium: null, high: "high", xhigh: null });
	const flash = await generatedModel(flashId);
	assert.equal(flash.compat?.supportsReasoningEffort, false);
	assert.deepEqual(flash.thinkingLevelMap, { minimal: null, low: null, medium: null });
	const oss = await generatedModel("openai/gpt-oss-120b");
	assert.equal(oss.compat?.thinkingFormat, "openai");
	assert.equal(oss.compat?.supportsReasoningEffort, true);
	const chat = await generatedModel("fixture-chat");
	assert.equal(chat.compat?.supportsReasoningEffort, false);
	assert.deepEqual(getSupportedThinkingLevels(chat), ["off"]);
});

test("Together shipped profile matches generated renamed-model reasoning metadata", async () => {
	const shipped = togetherProvider().getModels().find(value => value.id === renamedId)!;
	assert.ok(shipped);
	assert.equal(shipped.compat?.supportsReasoningEffort, true);
	assert.deepEqual(shipped.thinkingLevelMap, expectedMap);
	assert.deepEqual(shipped.capabilities?.reasoning, (await generatedModel(renamedId)).capabilities?.reasoning);
});

test("Together offline restore keeps corrected reasoning metadata and rejects an older broken overlay", async () => {
	const store = new InMemoryModelsStore();
	const registry = createModels({ modelsStore: store });
	const raw = (await generated).together![renamedId]!;
	try {
		for (const profileRevision of [undefined, MODELS_STORE_PROFILE_REVISION]) {
			await store.write("together", { models: [raw], profileRevision, checkedAt: 0, lastModified: 2 });
			registry.setProvider(withRemoteCatalog(togetherProvider(), "https://fixture.invalid", 1));
			assert.equal((await registry.refresh({ allowNetwork: false })).errors.size, 0);
			assert.deepEqual(getSupportedThinkingLevels(registry.getModel("together", renamedId)!), ["off", "high", "max"]);
		}
		const broken = { ...raw, compat: { ...raw.compat, supportsReasoningEffort: false },
			thinkingLevelMap: { minimal: null, low: null, medium: null } };
		await store.write("together", { models: [broken], checkedAt: 0, lastModified: 1 });
		registry.setProvider(withRemoteCatalog(togetherProvider(), "https://fixture.invalid", 2));
		assert.equal((await registry.refresh({ allowNetwork: false })).errors.size, 0);
		const restored = registry.getModel("together", renamedId)! as Model<"openai-completions">;
		assert.equal(restored.compat?.supportsReasoningEffort, true);
		assert.deepEqual(getSupportedThinkingLevels(restored), ["off", "high", "max"]);
	} finally {
		registry.clearProviders();
		await store.delete("together");
	}
});

for (const source of ["generated", "shipped"] as const) {
	for (const [level, effort] of [["off", undefined], ["high", "high"], ["max", "max"], ["low", "high"], ["xhigh", "max"]] as const) {
		test(`Together ${source} ${level} reaches the wire with the intended reasoning controls`, async () => {
			const model = source === "generated" ? await generatedModel(renamedId)
				: togetherProvider().getModels().find(value => value.id === renamedId)!;
			let requests = 0;
			let payload: Record<string, any> | undefined;
			const fetch: typeof globalThis.fetch = async (_input, init) => {
				requests++;
				payload = JSON.parse(String(init?.body));
				return new Response('data: {"id":"fixture","choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
					{ headers: { "content-type": "text/event-stream" } });
			};
			const result = await streamSimple(model, { messages: [{ role: "user", content: "hello", timestamp: 1 }] },
				{ apiKey: "fixture-not-a-real-key", reasoning: level === "off" ? undefined : level, fetch, maxRetries: 0 }).result();
			assert.equal(result.stopReason, "stop", result.errorMessage);
			assert.equal(requests, 1);
			assert.equal(payload?.model, renamedId);
			assert.deepEqual(payload?.reasoning, { enabled: level !== "off" });
			assert.equal(payload?.reasoning_effort, effort);
			if (effort === undefined) assert.equal(Object.hasOwn(payload!, "reasoning_effort"), false);
		});
	}
}
