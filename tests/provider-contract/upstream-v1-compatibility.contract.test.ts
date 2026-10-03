import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import test from "node:test";
import { Type } from "typebox";
import { stream as streamAnthropic } from "../../packages/ai/src/api/anthropic-messages.ts";
import { resolveJsonSchemaStrictSampling } from "../../packages/ai/src/api/constrained-sampling.ts";
import { convertResponsesMessages } from "../../packages/ai/src/api/openai-responses-shared.ts";
import { conservativeModelCapabilities } from "../../packages/ai/src/model-capabilities.ts";
import type { AssistantMessage, Model, Tool } from "../../packages/ai/src/types.ts";
import { isContextOverflow } from "../../packages/ai/src/utils/overflow.ts";
import { retryProviderRequest } from "../../packages/ai/src/utils/provider-retry.ts";

const USAGE = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

function providerError(headers: Record<string, string>, status = 429): Error {
	return Object.assign(new Error("fixture provider error"), { status, headers: new Headers(headers) });
}

for (const [headers, expected] of [
	[{ "retry-after": "not-a-date" }, 500],
	[{ "retry-after": "Infinity" }, 500],
	[{ "retry-after-ms": "Infinity" }, 500],
	[{ "retry-after-ms": "NaN", "retry-after": "not-a-date" }, 500],
	[{ "retry-after-ms": "Infinity", "retry-after": "2" }, 2000],
	[{ "retry-after-ms": "250", "retry-after": "2" }, 250],
	[{ "retry-after": "2" }, 2000],
] as Array<[Record<string, string>, number]>) {
	test(`provider retry uses a finite bounded delay for ${JSON.stringify(headers)}`, async (t) => {
		const originalTimeout = globalThis.setTimeout;
		const delays: number[] = [];
		t.mock.method(Math, "random", () => 0);
		t.mock.method(globalThis, "setTimeout", (callback: () => void, delay: number) => {
			delays.push(delay);
			return originalTimeout(callback, 0);
		});
		let calls = 0;
		const controller = new AbortController();
		const result = await retryProviderRequest(async () => {
			if (++calls === 1) throw providerError(headers);
			return "ok";
		}, { maxRetries: 1, signal: controller.signal });
		assert.equal(result, "ok");
		assert.equal(calls, 2);
		assert.deepEqual(delays, [expected]);
		assert.equal(getEventListeners(controller.signal, "abort").length, 0);
	});
}

test("retry caps, provider veto and abort retain their error and release boundaries", async () => {
	let calls = 0;
	await assert.rejects(retryProviderRequest(async () => {
		calls++;
		throw providerError({ "retry-after": "100" });
	}, { maxRetries: 1, maxRetryDelayMs: 1000 }), /Server requested 100s retry delay/);
	assert.equal(calls, 1);
	const veto = providerError({ "x-should-retry": "false" });
	await assert.rejects(retryProviderRequest(async () => { throw veto; }, { maxRetries: 2 }), error => error === veto);
	const controller = new AbortController();
	calls = 0;
	const pending = retryProviderRequest(async () => {
		calls++;
		throw providerError({ "retry-after": "30" });
	}, { maxRetries: 2, signal: controller.signal });
	await Promise.resolve();
	assert.equal(getEventListeners(controller.signal, "abort").length, 1);
	controller.abort();
	await assert.rejects(pending, { name: "AbortError" });
	assert.equal(calls, 1);
	assert.equal(getEventListeners(controller.signal, "abort").length, 0);
});

test("ZAI CN overflow is recognized without swallowing rate-limit failures", () => {
	const value: AssistantMessage = { role: "assistant", api: "openai-completions", provider: "zai", model: "fixture",
		content: [], stopReason: "error", errorMessage: '{"code":"1261","message":"Prompt exceeds max length"}',
		usage: USAGE, timestamp: 1 };
	assert.equal(isContextOverflow(value), true);
	assert.equal(isContextOverflow({ ...value, errorMessage: "Rate limit: Prompt exceeds max length" }), false);
	assert.equal(isContextOverflow({ ...value, errorMessage: "Prompt has invalid parameter" }), false);
});

const ANTHROPIC: Model<"anthropic-messages"> = {
	id: "fixture", name: "Fixture", api: "anthropic-messages", provider: "fixture", baseUrl: "https://fixture.invalid",
	reasoning: false, input: ["text"], cost: USAGE.cost, contextWindow: 32000, maxTokens: 1000,
	compat: { supportsStrictTools: true }, profileSource: "explicit-custom", costKnown: true,
	capabilities: { ...conservativeModelCapabilities(32000, 1000), toolCalling: true, strictToolSchema: true },
};

async function captureAnthropic(tool: Tool) {
	let payload: { tools?: Array<{ strict?: boolean; input_schema: Record<string, unknown> }> } | undefined;
	let requests = 0;
	const result = await streamAnthropic(ANTHROPIC, { messages: [], tools: [tool] }, {
		apiKey: "offline-fixture", cacheRetention: "none", maxRetries: 0,
		fetch: async () => { requests++; throw new Error("unexpected network call"); },
		onPayload(value) { payload = value as typeof payload; throw new Error("fixture payload captured"); },
	}).result();
	assert.equal(requests, 0);
	return { payload, result };
}

for (const parameters of [
	Type.Object({ timeout: Type.Integer({ minimum: 1, maximum: 300000 }) }),
	Type.Object({ options: Type.Object({ tags: Type.Array(Type.String(), { minItems: 2 }) }) }),
	Type.Object({ entries: Type.Array(Type.Object({ count: Type.Number({ multipleOf: 2 }) }), { maxItems: 3 }) }),
	Type.Object({ value: Type.Union([Type.Number({ maximum: 10 }), Type.Null()]) }),
	Type.Object({ pattern: Type.String({ format: "regex" }) }),
]) test(`Anthropic prefer falls back and require fails for ${JSON.stringify(parameters)}`, async () => {
	const tool: Tool = { name: "lookup", description: "fixture", parameters, constrainedSampling: { type: "json_schema", strict: "prefer" } };
	const before = JSON.stringify(parameters);
	const preferred = await captureAnthropic(tool);
	assert.match(preferred.result.errorMessage ?? "", /fixture payload captured/);
	assert.ok(preferred.payload?.tools?.[0]);
	assert.equal(preferred.payload.tools[0].strict, undefined);
	assert.deepEqual(preferred.payload.tools[0].input_schema.properties, parameters.properties);
	assert.equal(JSON.stringify(parameters), before);
	// The restriction belongs to Anthropic, not every strict-capable provider.
	assert.equal(resolveJsonSchemaStrictSampling(tool, true), true);
	const required = await captureAnthropic({ ...tool, constrainedSampling: { type: "json_schema", strict: "require" } });
	assert.equal(required.payload, undefined);
	assert.match(required.result.errorMessage ?? "", /requires JSON-schema constrained sampling/);
});

test("Anthropic accepted schema stays strict, including properties named like keywords", async () => {
	const parameters = Type.Object({ minimum: Type.Number(), format: Type.String(),
		tags: Type.Array(Type.String(), { minItems: 1 }), url: Type.String({ format: "uri" }) });
	const { payload } = await captureAnthropic({ name: "lookup", description: "fixture", parameters,
		constrainedSampling: { type: "json_schema", strict: "require" } });
	assert.equal(payload?.tools?.[0]?.strict, true);
	assert.equal(payload?.tools?.[0]?.input_schema.additionalProperties, false);
});

const RESPONSES: Model<"openai-responses"> = { id: "fixture", name: "Fixture", api: "openai-responses",
	provider: "openai", baseUrl: "https://fixture.invalid", reasoning: false, input: ["text"],
	cost: USAGE.cost, contextWindow: 32000, maxTokens: 1000 };

for (const grammar of [true, false]) for (const origin of ["same", "different-model", "foreign"] as const) {
	for (const prefix of ["fc_", "ctc_"]) test(`Responses replay ${prefix} ${origin} grammar=${grammar}`, () => {
		const assistant: AssistantMessage = { role: "assistant", api: "openai-responses",
			provider: origin === "foreign" ? "foreign" : "openai", model: origin === "different-model" ? "other" : "fixture",
			content: [{ type: "toolCall", id: `call_fixture|${prefix}fixture`, name: "code", arguments: { code: "1 + 1" } }],
			stopReason: "toolUse", usage: USAGE, timestamp: 1 };
		const wire = convertResponsesMessages(RESPONSES, { messages: [assistant] }, new Set(["openai"]),
			{ grammarToolInputProperties: grammar ? new Map([["code", "code"]]) : undefined });
		const replay = wire.find(item => "type" in item && (item.type === "function_call" || item.type === "custom_tool_call"));
		assert.ok(replay && "call_id" in replay);
		assert.equal(replay.type, grammar ? "custom_tool_call" : "function_call");
		assert.equal(replay.call_id, "call_fixture");
		const expectedPrefix = grammar ? "ctc_" : "fc_";
		if (origin === "same" && prefix === expectedPrefix) assert.equal(replay.id, `${prefix}fixture`);
		else if (origin === "foreign" && !grammar) assert.ok(replay.id?.startsWith("fc_"));
		else assert.equal(replay.id, undefined);
	});
}
