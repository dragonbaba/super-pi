import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { stream, streamSimple } from "../packages/ai/src/compat.ts";
import { createProvider } from "../packages/ai/src/models.ts";
import { deriveModelCapabilities } from "../packages/ai/src/model-capabilities.ts";
import type { Api, Model, SimpleStreamOptions, StreamOptions, ThinkingLevel } from "../packages/ai/src/types.ts";
import { ModelConfig } from "../packages/coding-agent/src/core/model-config.ts";
import { composeModelProvider } from "../packages/coding-agent/src/core/provider-composer.ts";

type SamplingModel = Model<Api>;
type DirectOptions = StreamOptions & { reasoningEffort?: ThinkingLevel; reasoningSummary?: "auto" };
const APIS = ["openai-completions", "openai-responses", "azure-openai-responses"] as const;

function model(api: Api, overrides: Partial<SamplingModel> = {}): SamplingModel {
	return {
		id: "sampling-fixture", name: "Sampling fixture", api, provider: "sampling-fixture",
		baseUrl: "https://sampling.invalid/v1", reasoning: true,
		thinkingLevelMap: { off: "none", minimal: null, low: null, medium: null, high: "high", xhigh: null, max: null },
		input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 32768, maxTokens: 4096,
		samplingParams: { temperature: 1, top_p: 0.95, min_p: 0.1 },
		samplingParamsByThinkingLevel: { off: { temperature: 0.7 }, high: { temperature: 0.6, top_k: 20 } },
		...overrides,
	};
}

async function capture(input: SamplingModel, options: SimpleStreamOptions | DirectOptions, simple = true) {
	let captured: Record<string, unknown> | undefined;
	const run = simple ? streamSimple : stream;
	const result = await run(input, { messages: [{ role: "user", content: "hello", timestamp: 1 }] }, {
		...options, apiKey: "fixture-key",
		fetch: async () => { throw new Error("unexpected network dispatch"); },
		onPayload: (payload) => { captured = payload as Record<string, unknown>; throw new Error("sampling captured"); },
	}).result();
	assert.match(result.errorMessage ?? "", /sampling captured/u);
	assert.ok(captured);
	return captured;
}

for (const api of APIS) {
	test(`${api}: simple and direct sampling precedence uses the clamped Pi level`, async () => {
		const input = model(api);
		const before = structuredClone(input);
		for (const simple of [true, false]) {
			const payload = await capture(input, {
				...(simple ? { reasoning: "low" as const } : { reasoningEffort: "low" as const }),
				temperature: 0.2, samplingParams: { top_p: 0, min_p: null },
			}, simple);
			assert.equal(payload.temperature, 0.6);
			assert.equal(payload.top_p, 0);
			assert.equal(payload.top_k, 20);
			assert.equal(payload.min_p, null);
		}
		assert.deepEqual(input, before);
	});

	test(`${api}: off, missing levels, provider aliases and structural filtering`, async () => {
		const input = model(api, { reasoning: false, thinkingLevelMap: undefined });
		assert.equal((await capture(input, { reasoning: "max" })).temperature, 0.7);
		input.reasoning = true;
		input.thinkingLevelMap = { off: "none", low: "provider-low" };
		assert.equal((await capture(input, { reasoning: "low" })).temperature, 1);
		input.samplingParamsByThinkingLevel = {
			low: { top_k: 33, model: "injected", messages: [], input: [], tools: [],
				reasoning: { effort: "max" }, previous_response_id: "injected", prompt_cache_key: "injected" },
		};
		const payload = await capture(input, { reasoning: "low" });
		assert.equal(payload.top_k, 33);
		assert.equal(payload.model, input.id);
		assert.equal(payload.tools, undefined);
		assert.equal(payload.previous_response_id, undefined);
		assert.equal(payload.prompt_cache_key, undefined);
		const messages = api === "openai-completions" ? payload.messages : payload.input;
		assert.ok(Array.isArray(messages) && messages.length > 0);
		assert.equal(JSON.stringify(payload).includes("injected"), false);
	});
}

test("Responses summary-only calls select medium sampling; other APIs ignore sampling fields", async () => {
	for (const api of APIS.slice(1)) {
		const input = model(api, { thinkingLevelMap: undefined,
			samplingParamsByThinkingLevel: { medium: { temperature: 0.8 } } });
		const payload = await capture(input, { reasoningSummary: "auto" }, false);
		assert.equal((payload.reasoning as { effort: string }).effort, "medium");
		assert.equal(payload.temperature, 0.8);
	}
	const payload = await capture(model("anthropic-messages"), { reasoning: "high", temperature: 0.3 });
	assert.equal(payload.top_p, undefined);
	assert.equal(payload.top_k, undefined);
});

for (const api of APIS) {
	test(`${api}: direct requests align wire effort and sampling when the capability manifest excludes off`, async () => {
		const input = model(api, { thinkingLevelMap: { low: "provider-low", high: "provider-high" } });
		input.capabilities = { ...deriveModelCapabilities(input), reasoning: { mode: "levels", levels: ["high"] } };
		const cases: DirectOptions[] = [{}, { reasoningEffort: "low" }];
		if (api !== "openai-completions") cases.push({ reasoningSummary: "auto" });
		for (const options of cases) {
			const payload = await capture(input, options, false);
			const effort = api === "openai-completions"
				? payload.reasoning_effort : (payload.reasoning as { effort: string }).effort;
			assert.equal(effort, "provider-high", `${api}: ${JSON.stringify(options)}`);
			assert.equal(payload.temperature, 0.6);
		}
	});
}

test("model configuration carries levels and merges user overrides after extension models", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "super-pi-sampling-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const path = join(directory, "models.json");
	const input = model("openai-completions");
	await writeFile(path, JSON.stringify({ providers: { "sampling-fixture": {
		api: input.api, baseUrl: input.baseUrl, models: [input],
		modelOverrides: { [input.id]: { samplingParamsByThinkingLevel: {
			high: { top_k: 40 }, max: { temperature: 0 },
		} } },
	} } }));
	const config = await ModelConfig.load(path);
	assert.equal(config.getError(), undefined);
	const provider = composeModelProvider(input.provider, undefined, config, undefined);
	assert.deepEqual((provider.getModels()[0] as SamplingModel).samplingParamsByThinkingLevel, {
		off: { temperature: 0.7 }, high: { temperature: 0.6, top_k: 40 }, max: { temperature: 0 },
	});
	const base = createProvider({ id: input.provider, auth: {}, models: [input], api: {} as never });
	const extension = { ...input, samplingParamsByThinkingLevel: { high: { temperature: 0.9, top_p: 0.8 } } };
	const extended = composeModelProvider(input.provider, base, config, { models: [extension] });
	assert.deepEqual((extended.getModels()[0] as SamplingModel).samplingParamsByThinkingLevel, {
		high: { temperature: 0.9, top_p: 0.8, top_k: 40 }, max: { temperature: 0 },
	});
	assert.deepEqual(input.samplingParamsByThinkingLevel?.high, { temperature: 0.6, top_k: 20 });
	await writeFile(path, JSON.stringify({ providers: { "sampling-fixture": { models: [
		{ ...input, samplingParamsByThinkingLevel: { high: 123 } },
	] } } }));
	assert.match((await ModelConfig.load(path)).getError() ?? "", /Invalid models.json schema/u);
});
