import assert from "node:assert/strict";
import test from "node:test";
import type { Api, Model } from "../packages/ai/src/types.ts";
import { nvidiaProvider } from "../packages/ai/src/providers/nvidia.ts";
import { findInitialModel, resolveCliModel, resolveModelScopeFromModels, restoreModelFromSession } from "../packages/coding-agent/src/core/model-resolver.ts";
import { parseArgs } from "../packages/coding-agent/src/cli/args.ts";
import type { ModelRuntime } from "../packages/coding-agent/src/core/model-runtime.ts";

function model(provider: string, id: string): Model<Api> {
	return {
		id,
		name: id,
		api: "openai-completions",
		provider,
		baseUrl: "https://fixture.invalid/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 8_192,
		maxTokens: 1_024,
	};
}

function runtime(models: Model<Api>[], authenticated: string[] = []): ModelRuntime {
	return {
		getModels: () => models,
		getModel: (provider: string, id: string) => models.find(value => value.provider === provider && value.id === id),
		getAvailableSnapshot: () => models.filter(value => authenticated.includes(value.provider)),
		hasConfiguredAuth: (provider: string) => authenticated.includes(provider),
		createConservativeFallbackModel: (provider: string, id: string) => ({
			id,
			name: id,
			api: "openai-completions",
			provider,
			baseUrl: "https://fixture.invalid/v1",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			costKnown: false,
			contextWindow: 32_768,
			maxTokens: 4_096,
			profileSource: "conservative-fallback",
		}),
	} as unknown as ModelRuntime;
}

test("--models trailing comma cannot add an unrelated model to the resolved cycle", () => {
	const models = [model("fixture", "unrelated"), model("fixture", "chosen")];
	const parsed = parseArgs(["--models", "fixture/chosen,"]);
	const result = resolveModelScopeFromModels(parsed.models!, models);
	assert.deepEqual(result.scopedModels.map(value => value.model.id), ["chosen"]);
	assert.deepEqual(result.diagnostics, []);
});

test("bare duplicate ids remain ambiguous and independent of catalog order", () => {
	const forward = [model("alpha", "shared"), model("beta", "shared")];
	const reverse = [...forward].reverse();
	for (const models of [forward, reverse]) {
		const result = resolveCliModel({ cliModel: "shared", modelRuntime: runtime(models) });
		assert.equal(result.model, undefined);
		assert.match(result.error ?? "", /ambiguous across providers/u);
		assert.match(result.error ?? "", /alpha\/shared, beta\/shared/u);
	}
});

test("an authenticated raw slash id still wins over an unauthenticated provider prefix", () => {
	const models = [model("alpha", "something"), model("gateway", "alpha/future")];
	const result = resolveCliModel({
		cliModel: "alpha/future",
		modelRuntime: runtime(models, ["gateway"]),
	});
	assert.equal(result.error, undefined);
	assert.equal(result.model?.provider, "gateway");
	assert.equal(result.model?.id, "alpha/future");
});

test("explicit provider preserves model ids containing slashes", () => {
	const models = [model("gateway", "known/model")];
	const result = resolveCliModel({
		cliProvider: "gateway",
		cliModel: "unknown/vendor-model",
		modelRuntime: runtime(models),
	});
	assert.equal(result.error, undefined);
	assert.equal(result.model?.provider, "gateway");
	assert.equal(result.model?.id, "unknown/vendor-model");
});

test("known models warn when a requested thinking level is unsupported", () => {
	const result = resolveCliModel({
		cliProvider: "gateway",
		cliModel: "known-model",
		cliThinking: "high",
		modelRuntime: runtime([model("gateway", "known-model")]),
	});
	assert.equal(result.error, undefined);
	assert.equal(result.model?.id, "known-model");
	assert.match(result.warning ?? "", /unsupported/u);
});

const nvidiaUltraId = "nvidia/nemotron-3-ultra-550b-a55b";
const nvidiaSuperId = "nvidia/nemotron-3-super-120b-a12b";

test("NVIDIA startup selects shipped Nemotron 3 Ultra independently of catalog order or Super availability", async () => {
	const models = [...nvidiaProvider().getModels()];
	const ultra = models.find(value => value.id === nvidiaUltraId);
	assert.ok(ultra, "the default must exist in the shipped provider catalog");
	for (const catalog of [models, [...models].reverse(), models.filter(value => value.id !== nvidiaSuperId)]) {
		const result = await findInitialModel({
			scopedModels: [], isContinuing: false, modelRuntime: runtime(catalog, ["nvidia"]),
		});
		assert.equal(result.model, ultra);
		assert.equal(result.fallbackMessage, undefined);
	}
});

test("NVIDIA default keeps explicit CLI, scoped and saved model choices", async () => {
	const superModel = model("nvidia", nvidiaSuperId);
	const modelRuntime = runtime([model("nvidia", nvidiaUltraId), superModel], ["nvidia"]);
	for (const selection of [
		{ cliProvider: "nvidia", cliModel: nvidiaSuperId },
		{ scopedModels: [{ model: superModel }] },
		{ defaultProvider: "nvidia", defaultModelId: nvidiaSuperId },
	]) {
		const result = await findInitialModel({ scopedModels: [], isContinuing: false, modelRuntime, ...selection });
		assert.equal(result.model, superModel);
	}
});

test("NVIDIA session restoration preserves saved/current models and uses Ultra only as a fallback", async () => {
	const superModel = model("nvidia", nvidiaSuperId);
	const ultra = model("nvidia", nvidiaUltraId);
	const modelRuntime = runtime([superModel, ultra], ["nvidia"]);
	const restored = await restoreModelFromSession("nvidia", nvidiaSuperId, undefined, false, modelRuntime);
	assert.equal(restored.model, superModel);
	assert.equal(restored.fallbackMessage, undefined);
	const current = await restoreModelFromSession("nvidia", "missing", superModel, false, modelRuntime);
	assert.equal(current.model, superModel);
	const fallback = await restoreModelFromSession("nvidia", "missing", undefined, false, modelRuntime);
	assert.equal(fallback.model, ultra);
	assert.ok(fallback.fallbackMessage?.includes(nvidiaUltraId));
});

test("NVIDIA startup still handles a restricted catalog or missing authentication", async () => {
	const custom = model("nvidia", "custom-nim-model");
	for (const authenticated of [["nvidia"], []]) {
		const result = await findInitialModel({
			scopedModels: [], isContinuing: false, modelRuntime: runtime([custom], authenticated),
		});
		assert.equal(result.model, authenticated.length ? custom : undefined);
	}
});
