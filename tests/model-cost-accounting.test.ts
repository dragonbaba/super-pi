import assert from "node:assert/strict";
import test from "node:test";
import { stream as streamOpenAIChat } from "../packages/ai/src/api/openai-completions.ts";
import { calculateCost } from "../packages/ai/src/models.ts";
import { openrouterProvider } from "../packages/ai/src/providers/openrouter.ts";
import type { Model, Usage } from "../packages/ai/src/types.ts";

function usage(input = 1_000, output = 1_000, cacheRead = 0, cacheWrite = 0): Usage {
	return {
		input,
		output,
		cacheRead,
		cacheWrite,
		totalTokens: input + output + cacheRead + cacheWrite,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function model(id: string): Model<"openai-completions"> {
	const result = openrouterProvider().getModels().find((entry) => entry.id === id);
	assert.ok(result);
	return result;
}

function chatResponse(): Response {
	const chunk = {
		id: "chatcmpl-cost-accounting",
		object: "chat.completion.chunk",
		created: 1,
		model: "openrouter/auto",
		choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
		usage: { prompt_tokens: 1_000, completion_tokens: 1_000, total_tokens: 2_000 },
	};
	return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
}

test("calculateCost ignores placeholder base and tier rates when cost is unknown", () => {
	const unknown: Model<"openai-completions"> = {
		...model("auto"),
		costKnown: false,
		cost: {
			input: -1_000_000,
			output: -2_000_000,
			cacheRead: -3_000_000,
			cacheWrite: -4_000_000,
			tiers: [{
				inputTokensAbove: 1,
				input: -5_000_000,
				output: -6_000_000,
				cacheRead: -7_000_000,
				cacheWrite: -8_000_000,
			}],
		},
	};
	const unknownUsage = usage(1_000, 1_000, 1_000, 1_000);
	unknownUsage.cacheWrite1h = 500;
	assert.deepEqual(calculateCost(unknown, unknownUsage), {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		total: 0,
	});
});

test("unknown OpenRouter router rates never produce negative or non-zero calculated cost", () => {
	for (const id of ["auto", "openrouter/auto", "openrouter/auto-beta", "openrouter/fusion"]) {
		const router = model(id);
		assert.equal(router.costKnown, false, id);
		assert.deepEqual(router.cost, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, id);
		const calculated = calculateCost(router, usage(1_000, 1_000, 1_000, 1_000));
		assert.deepEqual(calculated, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, id);
	}
});

test("known paid and genuinely free OpenRouter models retain distinct accounting semantics", () => {
	const paid = model("openai/gpt-4o-mini");
	assert.equal(paid.costKnown, true);
	const paidCost = calculateCost(paid, usage());
	const expectedInput = (paid.cost.input / 1_000_000) * 1_000;
	const expectedOutput = (paid.cost.output / 1_000_000) * 1_000;
	assert.equal(paidCost.input, expectedInput);
	assert.equal(paidCost.output, expectedOutput);
	assert.equal(paidCost.total, expectedInput + expectedOutput);

	for (const id of ["openrouter/free", "cohere/north-mini-code:free"]) {
		const free = model(id);
		assert.equal(free.costKnown, true, id);
		assert.deepEqual(calculateCost(free, usage()), {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			total: 0,
		}, id);
	}
});

test("actual OpenAI Chat response usage honors unknown cost accounting", async () => {
	const result = await streamOpenAIChat(model("openrouter/auto"), {
		systemPrompt: "cost accounting fixture",
		messages: [{ role: "user", content: "hello", timestamp: 1 }],
		tools: [],
	}, {
		apiKey: "fixture-key",
		fetch: async () => chatResponse(),
	}).result();
	assert.deepEqual(result.usage.cost, {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		total: 0,
	});
});
