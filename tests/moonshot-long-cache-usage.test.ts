import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import { openAICompletionsApi } from "../packages/ai/src/api/openai-completions.lazy.ts";
import { createProvider } from "../packages/ai/src/models.ts";
import { moonshotaiProvider } from "../packages/ai/src/providers/moonshotai.ts";
import { moonshotaiCnProvider } from "../packages/ai/src/providers/moonshotai-cn.ts";
import type { Model } from "../packages/ai/src/types.ts";

const models = [moonshotaiProvider(), moonshotaiCnProvider()].map(provider =>
	provider.getModels().find(model => model.id === "kimi-k3") as Model<"openai-completions">);
const longHeader = "Msh-Usage-Cache-Write-Tokens-1h";
const shortHeader = "Msh-Usage-Cache-Write-Tokens-5m";

interface Fixture {
	long?: string;
	write?: number;
	read?: number;
	choiceUsage?: boolean;
	repeated?: boolean;
	ttl?: "5m" | "1h";
	retry?: boolean;
	finalUsageOnly?: boolean;
	partialWrite?: number;
}

async function send(model: Model<"openai-completions">, entry: "stream" | "streamSimple", fixture: Fixture = {}) {
	const provider = createProvider({ id: model.provider, auth: {}, models: [model], api: openAICompletionsApi() });
	let requests = 0;
	let headerReads = 0;
	let responseHooks = 0;
	const result = await provider[entry](provider.getModels()[0]!, {
		messages: [{ role: "user", content: "fixture", timestamp: 0 }],
	}, {
		apiKey: "fixture-only", maxRetries: fixture.retry ? 1 : 0,
		onPayload(payload) {
			if (fixture.ttl) (payload as any).prompt_cache_options = { mode: "implicit", ttl: fixture.ttl };
		},
		onResponse(response) {
			responseHooks++;
			assert.equal(response.headers[longHeader.toLowerCase()], fixture.long);
		},
		fetch: async (_url, init) => {
			requests++;
			const payload = JSON.parse(String(init?.body));
			assert.equal(payload.stream_options.include_usage, true);
			assert.equal(payload.prompt_cache_options?.ttl, fixture.ttl);
			if (fixture.retry && requests === 1) return new Response("retry fixture", {
				status: 429, headers: { "retry-after-ms": "1", [longHeader]: "199" },
			});
			const usage = { prompt_tokens: 1000, completion_tokens: 100, total_tokens: 1100,
				prompt_tokens_details: { cached_tokens: fixture.read ?? 400, cache_write_tokens: fixture.write ?? 200 } };
			const chunk = { id: "fixture", model: model.id, object: "chat.completion.chunk", created: 0,
				choices: [{ index: 0, delta: { content: "ok" }, finish_reason: "stop",
					...(fixture.choiceUsage ? { usage } : {}) }], ...(!fixture.choiceUsage ? { usage } : {}) };
			let body = `data: ${JSON.stringify(chunk)}\n\n`;
			if (fixture.finalUsageOnly) body = `data: ${JSON.stringify({ ...chunk, usage: undefined })}\n\n`
				+ `data: ${JSON.stringify({ ...chunk, choices: [] })}\n\n`;
			if (fixture.partialWrite !== undefined) body = `data: ${JSON.stringify({ ...chunk, usage: {
				...usage, prompt_tokens_details: { ...usage.prompt_tokens_details, cache_write_tokens: fixture.partialWrite },
			} })}\n\n${body}`;
			const response = new Response(`${fixture.repeated ? body : ""}${body}data: [DONE]\n\n`, {
				headers: { "content-type": "text/event-stream", [shortHeader]: "100",
					...(fixture.long !== undefined ? { [longHeader]: fixture.long } : {}) },
			});
			const get = response.headers.get.bind(response.headers);
			response.headers.get = name => {
				if (name.toLowerCase() === longHeader.toLowerCase()) headerReads++;
				return get(name);
			};
			return response;
		},
	}).result();
	assert.equal(result.stopReason, "stop", result.errorMessage);
	assert.equal(requests, fixture.retry ? 2 : 1);
	assert.equal(responseHooks, 1);
	assert.equal(result.usage.cacheWrite, fixture.write ?? 200);
	assert.equal(result.usage.cacheRead, fixture.read ?? 400);
	assert.equal(result.usage.input, 1000 - result.usage.cacheRead - result.usage.cacheWrite);
	assert.equal(result.usage.totalTokens, 1100);
	return { usage: result.usage, headerReads };
}

for (const model of models) for (const entry of ["stream", "streamSimple"] as const) {
	for (const choiceUsage of [false, true]) test(`${model.provider} ${entry} ${choiceUsage ? "choice" : "chunk"} usage splits long writes`, async () => {
		const { usage, headerReads } = await send(model, entry, { long: "100", choiceUsage, repeated: true });
		assert.equal(usage.cacheWrite1h, 100);
		assert.equal(usage.cost.cacheWrite, 0.0009);
		assert.ok(Math.abs(usage.cost.total - 0.00372) < 1e-12);
		assert.equal(headerReads, 1, "read once per response, never per usage/delta");
	});
	for (const [label, fixture, expected] of [
		["all long", { long: "200" }, 200],
		["zero long", { long: "0" }, 0],
		["all hits", { long: "0", read: 1000, write: 0 }, 0],
		["no body writes", { long: "200", write: 0 }, 0],
		["bounded by total writes", { long: "999" }, 200],
		["request 5m, locked long TTL", { long: "200", ttl: "5m" }, 200],
		["request 1h, locked short TTL", { long: "0", ttl: "1h" }, 0],
		["request 1h without header", { ttl: "1h" }, undefined],
		["successful retry headers", { long: "100", retry: true }, 100],
		["final usage with no choices", { long: "100", finalUsageOnly: true }, 100],
		["partial then cumulative usage", { long: "200", partialWrite: 50 }, 200],
	] as const) test(`${model.provider} ${entry}: ${label}`, async () => {
		const { usage } = await send(model, entry, fixture);
		assert.equal(usage.cacheWrite1h, expected);
		assert.equal(usage.cost.cacheWrite, (3 * usage.cacheWrite + 3 * (expected ?? 0)) / 1e6);
	});
}

for (const value of [undefined, "", "-1", "1.5", "NaN", "Infinity", "100x", "1e2", "0x64", "100, 100", "9007199254740992"]) {
	test(`invalid/missing long header preserves default price: ${value}`, async () => {
		const { usage } = await send(models[0]!, "stream", { long: value });
		assert.equal(usage.cacheWrite1h, undefined);
		assert.equal(usage.cost.cacheWrite, 0.0006);
	});
}

for (const [provider, id] of [["openrouter", "moonshotai/kimi-k3"], ["kimi-coding", "k3"],
	["custom-moonshot", "kimi-k3"], ["moonshotai", "kimi-k2.7"]]) {
	test(`${provider}/${id} ignores Moonshot K3 header policy`, async () => {
		const { usage, headerReads } = await send({ ...models[0]!, provider: provider!, id: id! }, "stream", { long: "100" });
		assert.equal(usage.cacheWrite1h, undefined);
		assert.equal(usage.cost.cacheWrite, 0.0006);
		assert.equal(headerReads, 0);
	});
}

test("long writes use the selected input tier while preserving short-write overrides and unknown prices", async () => {
	for (const costKnown of [true, false]) {
		const { usage } = await send({ ...models[0]!, costKnown, cost: {
			input: 3, output: 15, cacheRead: 0.3, cacheWrite: 0,
			tiers: [{ inputTokensAbove: 999, input: 4, output: 20, cacheRead: 0.5, cacheWrite: 9 }],
		} }, "stream", { long: "100" });
		assert.equal(usage.cacheWrite1h, 100);
		assert.equal(usage.cost.cacheWrite, costKnown ? 0.0017 : 0);
		assert.ok(Math.abs(usage.cost.total - (costKnown ? 0.0055 : 0)) < 1e-12);
	}
});

test("long-cache parsing retains primitive state without new hot-path allocation sites", () => {
	const source = ts.createSourceFile("openai-completions.ts", readFileSync(
		new URL("../packages/ai/src/api/openai-completions.ts", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true);
	for (const name of ["getMoonshotCacheWrite1h", "parseChunkUsage"]) {
		const fn = source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name) as ts.FunctionDeclaration;
		assert.ok(fn?.body, name);
		let objects = 0;
		function inspect(node: ts.Node): void {
			if (ts.isObjectLiteralExpression(node)) objects++;
			assert.equal(ts.isArrowFunction(node) || ts.isFunctionExpression(node) || ts.isNewExpression(node)
				|| ts.isArrayLiteralExpression(node) || ts.isRegularExpressionLiteral(node) || ts.isAwaitExpression(node), false,
				`${name}: ${node.getText(source)}`);
			if (ts.isCallExpression(node)) assert.ok((name === "getMoonshotCacheWrite1h"
				? ["headers.get", "value.charCodeAt", "Number", "Number.isSafeInteger"]
				: ["Math.max", "Math.min", "calculateCost"]).includes(node.expression.getText(source)), node.getText(source));
			ts.forEachChild(node, inspect);
		}
		inspect(fn.body!);
		assert.equal(objects, name === "parseChunkUsage" ? 2 : 0, "only pre-existing usage/cost records");
	}
	let headerCalls = 0;
	let usageCalls = 0;
	function inspectCalls(node: ts.Node): void {
		if (ts.isCallExpression(node) && node.expression.getText(source) === "getMoonshotCacheWrite1h") {
			headerCalls++;
			for (let parent = node.parent; parent; parent = parent.parent) assert.equal(ts.isForOfStatement(parent), false);
		}
		if (ts.isCallExpression(node) && node.expression.getText(source) === "parseChunkUsage") {
			usageCalls++;
			assert.equal(node.arguments[2]?.getText(source), "cacheWrite1h");
		}
		ts.forEachChild(node, inspectCalls);
	}
	inspectCalls(source);
	assert.equal(headerCalls, 1);
	assert.equal(usageCalls, 2);
});
