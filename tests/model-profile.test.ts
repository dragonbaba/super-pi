import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { InMemoryModelsStore } from "../packages/ai/src/models-store.ts";
import { createModels, createProvider, getSupportedThinkingLevels } from "../packages/ai/src/models.ts";
import {
	conservativeModelCapabilities,
	enrichModelCapabilities,
	withModelProfile,
} from "../packages/ai/src/model-capabilities.ts";
import type { Model, ModelCapabilitiesV1 } from "../packages/ai/src/types.ts";
import { openrouterProvider } from "../packages/ai/src/providers/openrouter.ts";
import { ModelConfig } from "../packages/coding-agent/src/core/model-config.ts";
import { ModelRuntime } from "../packages/coding-agent/src/core/model-runtime.ts";
import { resolveCliModel } from "../packages/coding-agent/src/core/model-resolver.ts";
import { composeModelProvider } from "../packages/coding-agent/src/core/provider-composer.ts";

function fixtureModel(overrides: Partial<Model<"openai-completions">> = {}): Model<"openai-completions"> {
	return {
		id: "fixture-model",
		name: "Fixture Model",
		api: "openai-completions",
		provider: "fixture",
		baseUrl: "https://fixture.invalid/v1",
		reasoning: true,
		thinkingLevelMap: { off: "none", low: "low", high: "high" },
		input: ["text"],
		cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 65_536,
		maxTokens: 8_192,
		...overrides,
	};
}

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

test("every built-in runtime model reports a profile, capability manifest, and explicit cost knowledge", async () => {
	const runtime = await ModelRuntime.create({ modelsPath: null, refreshOnCreate: false });
	const models = runtime.getModels();
	assert.ok(models.length > 0);
	for (const model of models) {
		assert.equal(model.profileSource, "built-in", `${model.provider}/${model.id}`);
		assert.equal(model.capabilities?.version, 1, `${model.provider}/${model.id}`);
		assert.equal(model.capabilities?.contextWindow, model.contextWindow);
		assert.equal(model.capabilities?.maxOutputTokens, model.maxTokens);
		assert.equal(typeof model.costKnown, "boolean", `${model.provider}/${model.id}`);
	}
});

test("OpenRouter distinguishes unknown router prices from known and genuinely free models", () => {
	const models = openrouterProvider().getModels();
	for (const id of ["auto", "openrouter/auto", "openrouter/auto-beta", "openrouter/fusion"]) {
		assert.equal(models.find((model) => model.id === id)?.costKnown, false, id);
	}
	assert.equal(models.find((model) => model.id === "openai/gpt-4o-mini")?.costKnown, true);
	assert.equal(models.find((model) => model.id === "openrouter/free")?.costKnown, true);
	assert.equal(models.find((model) => model.id === "cohere/north-mini-code:free")?.costKnown, true);
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

test("modelOverrides rederive capabilities after limits and legacy capability inputs change", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "super-pi-model-overlay-"));
	t.after(async () => rm(directory, { recursive: true, force: true }));
	const modelsPath = join(directory, "models.json");
	await writeFile(modelsPath, JSON.stringify({
		providers: {
			openai: {
				modelOverrides: {
					"gpt-4o": {
						contextWindow: 77_777,
						maxTokens: 7_777,
						reasoning: true,
						thinkingLevelMap: { off: "none", minimal: null, low: "low", medium: null, high: null },
						input: ["text"],
						compat: { supportsStrictMode: false },
					},
				},
			},
		},
	}), "utf8");

	const runtime = await ModelRuntime.create({ modelsPath, refreshOnCreate: false });
	const model = runtime.getModel("openai", "gpt-4o");
	assert.ok(model);
	assert.equal(model.contextWindow, 77_777);
	assert.equal(model.capabilities?.contextWindow, 77_777);
	assert.equal(model.capabilities?.maxOutputTokens, 7_777);
	assert.deepEqual(model.capabilities?.inputModalities, { text: true, image: false, audio: false });
	assert.deepEqual(model.capabilities?.reasoning, { mode: "levels", levels: ["off", "low"] });
	assert.equal(model.capabilities?.strictToolSchema, false);
	assert.equal(model.profileSource, "explicit-custom");
});

test("provider-level config overlays mark inherited models explicit-custom", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "super-pi-provider-overlay-"));
	t.after(async () => rm(directory, { recursive: true, force: true }));
	const modelsPath = join(directory, "models.json");
	await writeFile(modelsPath, JSON.stringify({
		providers: { openai: { baseUrl: "https://custom-openai.invalid/v1" } },
	}), "utf8");

	const runtime = await ModelRuntime.create({ modelsPath, refreshOnCreate: false });
	const model = runtime.getModel("openai", "gpt-4o");
	assert.equal(model?.baseUrl, "https://custom-openai.invalid/v1");
	assert.equal(model?.profileSource, "explicit-custom");
});

test("extension provider overlays mark inherited models explicit-custom", async () => {
	const runtime = await ModelRuntime.create({ modelsPath: null, refreshOnCreate: false });
	runtime.registerProvider("openai", { baseUrl: "https://extension-openai.invalid/v1" });
	const model = runtime.getModel("openai", "gpt-4o");
	assert.equal(model?.baseUrl, "https://extension-openai.invalid/v1");
	assert.equal(model?.profileSource, "explicit-custom");
});

test("restored provider catalog entries are profiled and invalid cached manifests are safely rebuilt", async () => {
	const store = new InMemoryModelsStore();
	const invalidCapabilities = { ...conservativeModelCapabilities(), contextWindow: 1 } as ModelCapabilitiesV1;
	await store.write("catalog-fixture", {
		checkedAt: 1,
		models: [fixtureModel({
			provider: "catalog-fixture",
			profileSource: undefined,
			capabilities: invalidCapabilities,
		})],
	});
	const provider = createProvider({
		id: "catalog-fixture",
		auth: { apiKey: { name: "fixture", resolve: async () => ({ auth: {} }) } },
		models: [],
		fetchModels: async () => [],
		api: {} as never,
	});
	const models = createModels({ modelsStore: store });
	models.setProvider(provider);
	await models.refresh({ allowNetwork: false });
	const restored = models.getModel("catalog-fixture", "fixture-model");
	assert.equal(restored?.profileSource, "provider-catalog");
	assert.equal(restored?.capabilities?.contextWindow, restored?.contextWindow);
	assert.equal(restored?.capabilities?.reasoning.mode, "levels");
	assert.ok(restored?.profileDiagnostics?.some((diagnostic) => diagnostic.code === "INVALID_CAPABILITIES_REBUILT"));
});

test("explicit capabilities are validated, cloned, deeply frozen, and drive supported reasoning levels", () => {
	const levels = ["off", "low"] as const;
	const capabilities: ModelCapabilitiesV1 = {
		...conservativeModelCapabilities(65_536, 8_192),
		toolCalling: true,
		reasoning: { mode: "levels", levels: [...levels] },
		contextWindow: 65_536,
		maxOutputTokens: 8_192,
	};
	const profiled = withModelProfile(fixtureModel(), "explicit-custom", { capabilities });
	(capabilities.reasoning as { mode: "levels"; levels: string[] }).levels.push("high");
	assert.deepEqual(profiled.capabilities?.reasoning, { mode: "levels", levels: ["off", "low"] });
	assert.equal(Object.isFrozen(profiled.capabilities), true);
	assert.equal(Object.isFrozen(profiled.capabilities?.reasoning), true);
	assert.equal(Object.isFrozen((profiled.capabilities?.reasoning as { levels?: unknown }).levels), true);
	assert.deepEqual(getSupportedThinkingLevels(profiled), ["off", "low"]);

	assert.throws(() => withModelProfile(fixtureModel(), "explicit-custom", {
		capabilities: { ...capabilities, contextWindow: 1 },
	}), /contextWindow/u);
	assert.throws(() => withModelProfile(fixtureModel(), "explicit-custom", {
		capabilities: { ...capabilities, inputModalities: { text: true, image: true, audio: false } },
	}), /inputModalities/u);
	assert.throws(() => withModelProfile(fixtureModel(), "explicit-custom", {
		capabilities: { ...capabilities, reasoning: { mode: "none" } },
	}), /reasoning/u);
	assert.throws(() => withModelProfile(fixtureModel(), "explicit-custom", {
		capabilities: { ...capabilities, version: 2 } as unknown as ModelCapabilitiesV1,
	}), /version/u);
});

test("OAuth modifyModels in-place capability input mutation rederives without mutating the base catalog", async () => {
	const baseModel = fixtureModel({
		compat: { supportsStrictMode: true },
		headers: { "x-base": "preserved" },
		samplingParams: { top_p: 0.5 },
	});
	const baseProvider = createProvider({
		id: "fixture",
		auth: { apiKey: { name: "fixture", resolve: async () => ({ auth: { apiKey: "fixture" } }) } },
		models: [baseModel],
		api: {} as never,
	});
	const provider = composeModelProvider("fixture", baseProvider, await ModelConfig.load(undefined), {
		oauth: {
			name: "fixture oauth",
			login: async () => ({ refresh: "refresh", access: "access", expires: 1 }),
			refreshToken: async (credential) => credential,
			getApiKey: (credential) => credential.access,
			modifyModels: (models) => {
				const model = models[0]!;
				model.reasoning = false;
				model.input.push("image");
				(model.compat as { supportsStrictMode?: boolean }).supportsStrictMode = false;
				model.cost.input = 99;
				model.headers!["x-base"] = "mutated";
				model.samplingParams!.top_p = 0.99;
				return models;
			},
		},
	});
	await provider.refreshModels?.({
		credential: { type: "oauth", refresh: "refresh", access: "access", expires: 1 },
		allowNetwork: false,
		signal: new AbortController().signal,
		publish: async (publication) => {
			publication.update?.();
			return true;
		},
	});
	const updated = provider.getModels()[0]!;
	assert.equal(updated.reasoning, false);
	assert.deepEqual(updated.input, ["text", "image"]);
	assert.equal(updated.capabilities?.reasoning.mode, "none");
	assert.deepEqual(updated.capabilities?.inputModalities, { text: true, image: true, audio: false });
	assert.equal(updated.capabilities?.strictToolSchema, false);
	assert.equal(baseProvider.getModels()[0]?.reasoning, true);
	assert.deepEqual(baseProvider.getModels()[0]?.input, ["text"]);
	assert.equal((baseProvider.getModels()[0]?.compat as { supportsStrictMode?: boolean }).supportsStrictMode, true);
	assert.equal(baseProvider.getModels()[0]?.cost.input, 1);
	assert.deepEqual(baseProvider.getModels()[0]?.headers, { "x-base": "preserved" });
	assert.deepEqual(baseProvider.getModels()[0]?.samplingParams, { top_p: 0.5 });
});

test("OAuth identity mutation clears stale provider enrichment and reruns the profiler", async () => {
	const baseModel = fixtureModel({ id: "provider-owned", name: "Provider-owned" });
	const baseProvider = createProvider({
		id: "fixture",
		auth: { apiKey: { name: "fixture", resolve: async () => ({ auth: { apiKey: "fixture" } }) } },
		models: [baseModel],
		profileModel: (model) => model.id === "provider-owned" && model.name === "Provider-owned"
			? enrichModelCapabilities(model, { reasoningMode: "adaptive" })
			: model,
		api: {} as never,
	});
	assert.equal(baseProvider.getModels()[0]?.capabilities?.reasoning.mode, "adaptive");
	const provider = composeModelProvider("fixture", baseProvider, await ModelConfig.load(undefined), {
		oauth: {
			name: "fixture oauth",
			login: async () => ({ refresh: "refresh", access: "access", expires: 1 }),
			refreshToken: async (credential) => credential,
			getApiKey: (credential) => credential.access,
			modifyModels: (models) => models.map((model) => ({
				...model,
				id: "extension-owned",
				name: "Extension-owned",
				api: "mistral-conversations",
				provider: "extension-provider",
			})),
		},
	});
	await provider.refreshModels?.({
		credential: { type: "oauth", refresh: "refresh", access: "access", expires: 1 },
		allowNetwork: false,
		signal: new AbortController().signal,
		publish: async (publication) => {
			publication.update?.();
			return true;
		},
	});
	const updated = provider.getModels()[0]!;
	assert.equal(updated.id, "extension-owned");
	assert.equal(updated.name, "Extension-owned");
	assert.equal(updated.api, "mistral-conversations");
	assert.equal(updated.provider, "extension-provider");
	assert.equal(updated.capabilities?.reasoning.mode, "levels");
	assert.equal(baseProvider.getModels()[0]?.id, "provider-owned");
	assert.equal(baseProvider.getModels()[0]?.capabilities?.reasoning.mode, "adaptive");
});
