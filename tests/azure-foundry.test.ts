import assert from "node:assert/strict";
import test from "node:test";
import { stream, type OpenAICompletionsOptions } from "../packages/ai/src/api/openai-completions.ts";
import { InMemoryCredentialStore } from "../packages/ai/src/auth/credential-store.ts";
import { createModels, getSupportedThinkingLevels } from "../packages/ai/src/models.ts";
import { azureOpenAIResponsesProvider } from "../packages/ai/src/providers/azure-openai-responses.ts";
import type { Context, Model } from "../packages/ai/src/types.ts";
import { SessionManager } from "../packages/coding-agent/src/core/session-manager.ts";
import { SettingsManager } from "../packages/coding-agent/src/core/settings-manager.ts";
import { catalogFixtures, generateCatalog } from "./fixtures/catalog-generator.ts";

const providerId = "azure-openai-responses";
const context: Context = { systemPrompt: "Be concise", messages: [{ role: "user", content: "hello", timestamp: 1 }] };
const chatModel: Model<"openai-completions"> = {
	id: "deepseek-v4-pro", name: "DeepSeek V4 Pro", api: "openai-completions", provider: providerId,
	baseUrl: "", reasoning: true, input: ["text"], contextWindow: 1_000_000, maxTokens: 384_000,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	compat: { supportsStore: false, supportsDeveloperRole: false, thinkingFormat: "openai" },
};

function captureFetch(responses = false) {
	const requests: { url: URL; headers: Headers; body: Record<string, any> }[] = [];
	const fetch: typeof globalThis.fetch = async (input, init) => {
		requests.push({ url: new URL(String(input)), headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) });
		return new Response(responses
			? 'data: {"type":"response.completed","response":{"id":"fixture","status":"completed","output":[]}}\n\n'
			: 'data: {"id":"fixture","choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
			{ headers: { "content-type": "text/event-stream" } });
	};
	return { requests, fetch };
}

test("Azure keeps its persisted identity and legacy GPT profiles while adding Foundry Chat", () => {
	const provider = azureOpenAIResponsesProvider();
	assert.equal(provider.id, providerId);
	const models = provider.getModels();
	assert.equal(models.find(model => model.id === "gpt-5.4")?.api, "azure-openai-responses");
	const deepseek = models.find(model => model.id === chatModel.id);
	assert.ok(deepseek, "missing Azure DeepSeek catalog entry");
	assert.equal(deepseek.api, "openai-completions");
	assert.equal(deepseek.provider, providerId);
	assert.deepEqual(getSupportedThinkingLevels(deepseek), ["off", "low", "medium", "high"]);
});

test("Azure endpoint priority, deployment priority and custom proxy paths reach the SDK", async () => {
	const cases: [OpenAICompletionsOptions, string, string][] = [
		[{ azureBaseUrl: " https://direct.openai.azure.com/ ", azureResourceName: "resource", azureDeploymentName: "direct",
			env: { AZURE_OPENAI_BASE_URL: "https://environment.openai.azure.com", AZURE_OPENAI_DEPLOYMENT_NAME_MAP: "deepseek-v4-pro=env" } },
			"https://direct.openai.azure.com/openai/v1/chat/completions", "direct"],
		[{ azureResourceName: "resource", env: { AZURE_OPENAI_BASE_URL: "https://environment.cognitiveservices.azure.com/openai/v1/responses",
			AZURE_OPENAI_DEPLOYMENT_NAME_MAP: "bad,=,deepseek-v4-pro=old, deepseek-v4-pro = mapped " } },
			"https://environment.cognitiveservices.azure.com/openai/v1/chat/completions", "mapped"],
		[{ azureResourceName: "explicit", env: { AZURE_OPENAI_RESOURCE_NAME: "environment" } },
			"https://explicit.openai.azure.com/openai/v1/chat/completions", chatModel.id],
		[{ env: { AZURE_OPENAI_RESOURCE_NAME: "environment" } }, "https://environment.openai.azure.com/openai/v1/chat/completions", chatModel.id],
		[{}, "https://proxy.invalid/custom/v1/chat/completions", chatModel.id],
		[{ azureBaseUrl: "https://fixture.services.ai.azure.com/openai/v1/chat/completions?api-version=old" },
			"https://fixture.services.ai.azure.com/openai/v1/chat/completions", chatModel.id],
	];
	for (const [options, url, deployment] of cases) {
		const captured = captureFetch();
		const result = await stream({ ...chatModel, baseUrl: "https://proxy.invalid/custom/v1" }, context,
			{ ...options, apiKey: "fixture", fetch: captured.fetch, maxRetries: 0 }).result();
		assert.equal(result.stopReason, "stop", result.errorMessage);
		assert.equal(captured.requests[0]!.url.href, url);
		assert.equal(captured.requests[0]!.body.model, deployment);
	}
});

test("Azure provider direct and simple dispatch use Foundry effort semantics and system roles", async () => {
	const provider = azureOpenAIResponsesProvider();
	const model = provider.getModels().find(value => value.id === chatModel.id)!;
	const before = structuredClone(model);
	for (const simple of [true, false]) {
		for (const [level, effort] of [["off", undefined], ["minimal", "low"], ["medium", "medium"], ["max", "high"]] as const) {
			const captured = captureFetch();
			const options = { apiKey: "fixture", fetch: captured.fetch, maxRetries: 0, cacheRetention: "long" as const,
				sessionId: "session", env: { AZURE_OPENAI_RESOURCE_NAME: "fixture" } };
			const result = await (simple
				? provider.streamSimple(model, context, { ...options, reasoning: level === "off" ? undefined : level })
				: provider.stream(model, context, { ...options, reasoningEffort: level === "off" ? undefined : level })).result();
			assert.equal(result.stopReason, "stop", result.errorMessage);
			const request = captured.requests[0]!;
			assert.equal(request.url.pathname, "/openai/v1/chat/completions");
			assert.equal(request.body.reasoning_effort, effort);
			assert.equal(request.body.messages[0].role, "system");
			for (const key of ["thinking", "store", "prompt_cache_key", "prompt_cache_retention"]) assert.equal(request.body[key], undefined, key);
		}
	}
	assert.deepEqual(structuredClone(model), before);
});

test("Azure Chat preserves reasoning replay, header overrides and final payload hooks", async () => {
	const provider = azureOpenAIResponsesProvider();
	const model = provider.getModels().find(value => value.id === chatModel.id)!;
	const captured = captureFetch();
	const previous = await provider.streamSimple(model, context, { apiKey: "fixture", fetch: captured.fetch,
		env: { AZURE_OPENAI_RESOURCE_NAME: "fixture" } }).result();
	previous.content.unshift({ type: "thinking", thinking: "prior reasoning", thinkingSignature: "reasoning_content" });
	previous.content.push({ type: "toolCall", id: "call_fixture", name: "lookup", arguments: {} });
	let observed = false;
	const result = await provider.stream(model, { ...context, messages: [...context.messages, previous,
		{ role: "toolResult", toolCallId: "call_fixture", toolName: "lookup", content: [{ type: "text", text: "found" }], isError: false, timestamp: 2 }] }, {
		apiKey: "fixture", fetch: captured.fetch, azureResourceName: "fixture", azureDeploymentName: "configured-deployment",
		headers: { "X-Fixture": "request" },
		onPayload(payload, hookModel) {
			assert.equal(hookModel.id, chatModel.id);
			assert.equal((payload as { model: string }).model, "configured-deployment");
			return { ...payload as object, model: "hook-deployment" };
		},
		onEffectiveDispatch: () => { observed = true; },
	}).result();
	assert.equal(result.stopReason, "stop", result.errorMessage);
	assert.equal(result.model, chatModel.id);
	assert.equal(observed, true);
	assert.equal(captured.requests[1]!.body.model, "hook-deployment");
	assert.equal(captured.requests[1]!.headers.get("x-fixture"), "request");
	assert.equal(captured.requests[1]!.body.messages.find((message: { role: string }) => message.role === "assistant").reasoning_content, "prior reasoning");
});

test("legacy Azure credentials, settings and session selection still resolve GPT Responses and new Chat", async () => {
	const credentials = new InMemoryCredentialStore();
	await credentials.modify(providerId, async () => ({ type: "api_key", key: "stored-fixture",
		env: { AZURE_OPENAI_RESOURCE_NAME: "legacy", AZURE_OPENAI_API_VERSION: "2025-04-01-preview", AZURE_OPENAI_DEPLOYMENT_NAME_MAP: "gpt-5.4=legacy-gpt" } }));
	const registry = createModels({ credentials });
	registry.setProvider(azureOpenAIResponsesProvider());
	try {
		const settings = SettingsManager.inMemory({ defaultProvider: providerId, defaultModel: "gpt-5.4" });
		const session = SessionManager.inMemory(process.cwd());
		session.appendModelChange(settings.getDefaultProvider()!, settings.getDefaultModel()!);
		const selected = session.buildSessionContext().model!;
		const legacy = registry.getModel(selected.provider, selected.modelId)!;
		assert.ok(legacy);
		const captured = captureFetch(true);
		const result = await registry.streamSimple(legacy, context, { fetch: captured.fetch, maxRetries: 0 }).result();
		assert.equal(result.stopReason, "stop", result.errorMessage);
		assert.equal(result.api, "azure-openai-responses");
		assert.equal(result.model, "gpt-5.4");
		assert.equal(captured.requests[0]!.url.pathname, "/openai/v1/responses");
		assert.equal(captured.requests[0]!.url.searchParams.get("api-version"), "2025-04-01-preview");
		assert.equal(captured.requests[0]!.headers.get("api-key"), "stored-fixture");
		assert.equal(captured.requests[0]!.body.model, "legacy-gpt");
		const chat = captureFetch();
		assert.equal((await registry.streamSimple(registry.getModel(providerId, chatModel.id)!, context,
			{ fetch: chat.fetch, maxRetries: 0 }).result()).stopReason, "stop");
		assert.equal(chat.requests[0]!.headers.get("authorization"), "Bearer stored-fixture");
		assert.equal(chat.requests[0]!.url.search, "");
		assert.deepEqual(await credentials.list(), [{ providerId, type: "api_key" }]);
	} finally {
		registry.clearProviders();
		await credentials.delete(providerId);
	}
});

test("Azure Chat missing or invalid endpoints and cancellation terminate without dispatch", async () => {
	for (const baseUrl of ["", "invalid URL"]) {
		const captured = captureFetch();
		const result = await stream({ ...chatModel, baseUrl }, context, { apiKey: "fixture", fetch: captured.fetch, maxRetries: 0 }).result();
		assert.equal(result.stopReason, "error");
		assert.match(result.errorMessage ?? "", /Azure OpenAI base URL/u);
		assert.equal(captured.requests.length, 0);
	}
	const captured = captureFetch();
	const result = await stream(chatModel, context, { apiKey: "fixture", fetch: captured.fetch, azureResourceName: "fixture",
		signal: AbortSignal.abort(), maxRetries: 0 }).result();
	assert.equal(result.stopReason, "aborted");
	assert.equal(captured.requests.length, 0);
});

test("Azure catalog generation applies Foundry metadata after native DeepSeek defaults", async () => {
	const fixtures = catalogFixtures();
	fixtures["https://models.dev/api.json"].deepseek = { models: { "deepseek-v4-pro": {
		id: "deepseek-v4-pro", name: "DeepSeek V4 Pro", tool_call: true, reasoning: true,
		cost: { input: 1, output: 2, cache_read: 0.1 }, limit: { context: 1_000_000, output: 384_000 },
		modalities: { input: ["text"], output: ["text"] },
	} } };
	const generated = await generateCatalog(fixtures);
	const model = generated[providerId]![chatModel.id]!;
	const shipped = azureOpenAIResponsesProvider().getModels().find(value => value.id === chatModel.id)!;
	assert.equal(model.api, "openai-completions");
	assert.equal(model.baseUrl, "");
	assert.deepEqual(model.thinkingLevelMap, shipped.thinkingLevelMap);
	assert.deepEqual(model.compat, shipped.compat);
	assert.deepEqual(model.cost, shipped.cost);
	assert.equal(generated.deepseek![chatModel.id]!.thinkingLevelMap?.max, "max");
	assert.equal((generated.deepseek![chatModel.id]! as Model<"openai-completions">).compat?.thinkingFormat, "deepseek");
});

test("Azure Chat resolves Foundry root and deployment without changing assistant identity", async () => {
	const captured = captureFetch();
	const result = await stream(chatModel, context, {
		apiKey: "fixture-key", fetch: captured.fetch, maxRetries: 0,
		env: { AZURE_OPENAI_BASE_URL: "https://fixture.services.ai.azure.com", AZURE_OPENAI_DEPLOYMENT_NAME_MAP: "deepseek-v4-pro=deployed-pro" },
	}).result();
	assert.equal(result.stopReason, "stop", result.errorMessage);
	assert.equal(captured.requests.length, 1);
	assert.equal(captured.requests[0]!.url.href, "https://fixture.services.ai.azure.com/openai/v1/chat/completions");
	assert.equal(captured.requests[0]!.body.model, "deployed-pro");
	assert.equal(captured.requests[0]!.headers.get("authorization"), "Bearer fixture-key");
	assert.equal(result.model, chatModel.id);
	assert.equal(result.provider, providerId);
});
