import assert from "node:assert/strict";
import test from "node:test";
import { getBuiltinModel } from "../../packages/ai/src/providers/all.ts";
import { stream as streamCodex } from "../../packages/ai/src/api/openai-codex-responses.ts";
import { stream as streamResponses } from "../../packages/ai/src/api/openai-responses.ts";
import { byteChunks, codexModel, codexToken, responsesContext, sseFrames, sseResponse } from "../helpers/responses-sse-fixture.ts";

// OpenAI renamed Priority processing to Fast mode on 2026-07-30 and prices both identically
// (https://developers.openai.com/api/docs/pricing); GPT-6 responses report service_tier "fast".
// 1M input + 1M output tokens at $1/M make cost.total / 2 the applied multiplier.
function completed(serviceTier: string | undefined) {
	return [{ type: "response.completed", response: { id: "resp", status: "completed", output: [], service_tier: serviceTier, usage: { input_tokens: 1_000_000, output_tokens: 1_000_000, total_tokens: 2_000_000, input_tokens_details: { cached_tokens: 0 } } } }];
}

async function multiplier(api: "responses" | "codex", modelId: string, requested: string | undefined, reported: string | undefined): Promise<number> {
	const fetch: typeof globalThis.fetch = async () => sseResponse(byteChunks(sseFrames(completed(reported)), 64));
	const options = { transport: "sse", fetch, maxRetries: 0, serviceTier: requested } as any;
	const result = api === "codex"
		? await streamCodex({ ...codexModel, id: modelId }, responsesContext, { ...options, apiKey: codexToken() }).result()
		: await streamResponses({ ...codexModel, id: modelId, api: "openai-responses", provider: "openai", baseUrl: "https://api.openai.invalid/v1" }, responsesContext, { ...options, apiKey: "sk-fixture" }).result();
	assert.equal(result.stopReason, "stop", result.errorMessage);
	return result.usage.cost.total / 2;
}

for (const api of ["responses", "codex"] as const) {
	for (const [modelId, requested, reported, expected] of [
		["gpt-6-luna", "priority", "fast", 2],
		["gpt-6-luna", "fast", "fast", 2],
		["gpt-5.5", "priority", "fast", 2.5],
		["gpt-5.6-sol", "priority", "fast", 2],
		["gpt-5.6-sol", "fast", "default", 1],
		["gpt-5.4", "priority", "priority", 2],
		["gpt-5.4", "flex", "flex", 0.5],
		// The reported tier is what was served; the requested tier applies only when none is reported.
		["gpt-5.4", "priority", "default", 1],
		["gpt-5.4", "priority", undefined, 2],
		["gpt-5.4", undefined, undefined, 1],
	] as const) test(`${api} prices requested ${requested} / reported ${reported} on ${modelId} at ${expected}x`, async () => {
		assert.equal(await multiplier(api, modelId, requested, reported), expected);
	});
}

test("GPT-5.6 Sol catalog uses Standard API rates before tier pricing, including long context", () => {
	for (const provider of ["openai", "openai-codex"] as const) {
		const model = getBuiltinModel(provider, "gpt-5.6-sol")!;
		assert.deepEqual(model.cost, { input: 4, output: 20, cacheRead: 0.4, cacheWrite: 5,
			tiers: [{ inputTokensAbove: 272000, input: 8, output: 30, cacheRead: 0.8, cacheWrite: 10 }] });
	}
});
