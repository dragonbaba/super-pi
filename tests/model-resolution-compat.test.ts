import assert from "node:assert/strict";
import test from "node:test";
import type { Api, Model } from "../packages/ai/src/types.ts";
import { resolveCliModel } from "../packages/coding-agent/src/core/model-resolver.ts";
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
