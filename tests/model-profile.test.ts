import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createModels, createProvider } from "../packages/ai/src/models.ts";
import { ModelRuntime } from "../packages/coding-agent/src/core/model-runtime.ts";
import { resolveCliModel } from "../packages/coding-agent/src/core/model-resolver.ts";

test("unknown model uses a conservative profile instead of cloning a provider sibling", async () => {
	const runtime = await ModelRuntime.create({ modelsPath: null, refreshOnCreate: false });
	const sibling = runtime.getModels("openai")[0];
	assert.ok(sibling);

	const result = resolveCliModel({
		cliProvider: "openai",
		cliModel: "future-model-not-in-catalog",
		modelRuntime: runtime,
	});
	assert.equal(result.error, undefined);
	assert.equal(result.model?.profileSource, "conservative-fallback");
	assert.equal(result.model?.costKnown, false);
	assert.deepEqual(result.model?.cost, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
	assert.equal(result.model?.contextWindow, 32_768);
	assert.equal(result.model?.maxTokens, 4_096);
	assert.equal(result.model?.reasoning, false);
	assert.deepEqual(result.model?.input, ["text"]);
	assert.equal(result.model?.capabilities?.promptCache.mode, "none");
	assert.equal(result.model?.capabilities?.toolCalling, false);
	assert.equal(result.model?.capabilities?.parallelTools, false);
	assert.equal(result.model?.capabilities?.strictToolSchema, false);
	assert.notDeepEqual(result.model?.cost, sibling.cost);
	assert.match(result.warning ?? "", /conservative capability profile/u);
});

test("unknown model does not enable reasoning merely because thinking was requested", async () => {
	const runtime = await ModelRuntime.create({ modelsPath: null, refreshOnCreate: false });
	const result = resolveCliModel({
		cliProvider: "openai",
		cliModel: "future-model-not-in-catalog",
		cliThinking: "high",
		modelRuntime: runtime,
	});
	assert.equal(result.error, undefined);
	assert.equal(result.model?.reasoning, false);
	assert.equal(result.model?.profileSource, "conservative-fallback");
	assert.match(result.warning ?? "", /reasoning remains off/u);
});

test("every built-in runtime model reports a model profile source and capability manifest", async () => {
	const runtime = await ModelRuntime.create({ modelsPath: null, refreshOnCreate: false });
	const models = runtime.getModels();
	assert.ok(models.length > 0);
	for (const model of models) {
		assert.equal(model.profileSource, "built-in", `${model.provider}/${model.id}`);
		assert.equal(model.capabilities?.version, 1, `${model.provider}/${model.id}`);
		assert.equal(model.capabilities?.contextWindow, model.contextWindow);
		assert.equal(model.capabilities?.maxOutputTokens, model.maxTokens);
		assert.equal(model.costKnown, true);
	}
});

test("models.json models are explicit custom profiles and preserve declared limits", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "super-pi-model-profile-"));
	t.after(async () => rm(directory, { recursive: true, force: true }));
	const modelsPath = join(directory, "models.json");
	await writeFile(
		modelsPath,
		JSON.stringify({
			providers: {
				fixture: {
					baseUrl: "https://fixture.invalid/v1",
					apiKey: "fixture-key",
					api: "openai-completions",
					models: [
						{
							id: "declared-model",
							name: "Declared Model",
							reasoning: true,
							input: ["text", "image"],
							cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1.25 },
							contextWindow: 91_337,
							maxTokens: 7_777,
							capabilities: {
								version: 1,
								inputModalities: { text: true, image: true, audio: false },
								toolCalling: true,
								parallelTools: false,
								strictToolSchema: false,
								streamedToolArguments: true,
								reasoning: { mode: "levels", levels: ["off", "low", "medium", "high"] },
								thoughtSignatureRoundTrip: false,
								promptCache: { mode: "none" },
								previousResponseId: false,
								websocketContinuation: false,
								deferredTools: false,
								remoteCompaction: false,
								contextWindow: 91_337,
								maxOutputTokens: 7_777,
							},
						},
					],
				},
			},
		}),
		"utf8",
	);

	const runtime = await ModelRuntime.create({ modelsPath, refreshOnCreate: false });
	const model = runtime.getModel("fixture", "declared-model");
	assert.ok(model);
	assert.equal(model.profileSource, "explicit-custom");
	assert.equal(model.costKnown, true);
	assert.equal(model.contextWindow, 91_337);
	assert.equal(model.maxTokens, 7_777);
	assert.equal(model.capabilities?.reasoning.mode, "levels");
	assert.deepEqual(model.profileDiagnostics, []);
});

test("models.json defaults are diagnosed instead of presented as observed profile data", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "super-pi-model-profile-defaults-"));
	t.after(async () => rm(directory, { recursive: true, force: true }));
	const modelsPath = join(directory, "models.json");
	await writeFile(
		modelsPath,
		JSON.stringify({
			providers: {
				fixture: {
					baseUrl: "https://fixture.invalid/v1",
					apiKey: "fixture-key",
					api: "openai-completions",
					models: [{ id: "defaulted-model" }],
				},
			},
		}),
		"utf8",
	);

	const runtime = await ModelRuntime.create({ modelsPath, refreshOnCreate: false });
	const model = runtime.getModel("fixture", "defaulted-model");
	assert.ok(model);
	assert.equal(model.profileSource, "explicit-custom");
	assert.equal(model.costKnown, false);
	assert.deepEqual(
		model.profileDiagnostics?.map((diagnostic) => diagnostic.field),
		["capabilities", "contextWindow", "cost", "maxTokens"],
	);
});

test("dynamic provider models are marked as provider-catalog profiles", async () => {
	let generation = 0;
	const dynamicModel = () => ({
		id: "dynamic-model",
		name: "Dynamic Model",
		api: "openai-completions" as const,
		provider: "dynamic-fixture",
		baseUrl: "https://fixture.invalid/v1",
		reasoning: false,
		input: ["text" as const],
		cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 65_536 + generation,
		maxTokens: 8_192,
	});
	const provider = createProvider({
		id: "dynamic-fixture",
		auth: { apiKey: { name: "fixture", resolve: async () => ({ auth: {} }) } },
		models: [],
		fetchModels: async () => [dynamicModel()],
		api: {} as never,
	});
	const models = createModels();
	models.setProvider(provider);
	const result = await models.refresh({ allowNetwork: true });
	assert.equal(result.errors.size, 0);
	const observed = models.getModel("dynamic-fixture", "dynamic-model");
	assert.equal(observed?.profileSource, "provider-catalog");
	assert.equal(observed?.capabilities?.contextWindow, 65_536);
	assert.equal(observed?.costKnown, true);

	generation = 1;
	const refreshed = await models.refresh({ allowNetwork: true, force: true });
	assert.equal(refreshed.errors.size, 0);
	const updated = models.getModel("dynamic-fixture", "dynamic-model");
	assert.equal(updated?.contextWindow, 65_537);
	assert.equal(updated?.capabilities?.contextWindow, 65_537);
	assert.equal(updated?.profileSource, "provider-catalog");
});
