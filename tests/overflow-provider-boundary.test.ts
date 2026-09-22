import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { AssistantMessage, Model } from "../packages/ai/src/types.ts";
import { isContextOverflow, isRecoverableLength } from "../packages/ai/src/utils/overflow.ts";
import { streamSimple } from "@super-pi/ai/api/openai-completions";
import { createAgentSession } from "../packages/coding-agent/src/core/sdk.ts";
import { DefaultResourceLoader } from "../packages/coding-agent/src/core/resource-loader.ts";
import { SettingsManager } from "../packages/coding-agent/src/core/settings-manager.ts";
import { SessionManager } from "../packages/coding-agent/src/core/session-manager.ts";
import type { ModelRuntime } from "../packages/coding-agent/src/core/model-runtime.ts";

function message(provider: string, errorMessage: string): AssistantMessage {
	return { role: "assistant", provider, model: "offline", api: "openai-completions", content: [],
		stopReason: "error", errorMessage, timestamp: 1,
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
}

test("bodyless HTTP errors have a Cerebras boundary and explicit overflow remains recognized", () => {
	for (const provider of ["fixture", "openai", "zai", "cerebras"]) {
		for (const error of ["400 (no body)", "413 status code (no body)"]) {
			assert.equal(isContextOverflow(message(provider, error)), provider === "cerebras", `${provider}: ${error}`);
		}
		for (const error of ["400 invalid parameter: strict", "413 invalid request", "429 Too many requests",
			"Rate limit: too many tokens", "Throttling error: Too many tokens", "Service unavailable: too many tokens", "503 Service unavailable"]) {
			assert.equal(isContextOverflow(message(provider, error)), false, error);
		}
	}
	for (const error of ["Prompt too long", '{"code":"1261","message":"Prompt too long"}',
		"prompt is too long: 2001 tokens > 2000 maximum", "context_length_exceeded", "request_too_large",
		"Input length (265330) exceeds model's maximum context length (262144)."])
		assert.equal(isContextOverflow(message("zai", error)), true, error);
});

test("silent and zero-output length overflow boundaries remain intact", () => {
	const value = message("zai", ""); value.stopReason = "stop"; value.usage.input = 900; value.usage.cacheRead = 101;
	assert.equal(isContextOverflow(value, 1000), true);
	value.usage.cacheRead = 100; assert.equal(isContextOverflow(value, 1000), false);
	value.stopReason = "length"; assert.equal(isContextOverflow(value, 1000), true);
	value.usage.output = 1; assert.equal(isContextOverflow(value, 1000), false);
	assert.equal(isRecoverableLength(value, 100), true);
	value.usage.output = 100; assert.equal(isRecoverableLength(value, 100), false);
});

for (const scenario of [
	{ provider: "fixture", status: 400, error: undefined, overflow: false },
	{ provider: "fixture", status: 413, error: undefined, overflow: false },
	{ provider: "fixture", status: 400, error: "Invalid parameter: strict", overflow: false },
	{ provider: "fixture", status: 503, error: "Service unavailable", overflow: false },
	{ provider: "fixture", status: 429, error: "Rate limit: too many tokens", overflow: false },
	{ provider: "cerebras", status: 400, error: undefined, overflow: true },
	{ provider: "zai", status: 400, error: "Prompt too long", overflow: true },
]) test(`offline SDK wire recovery: ${scenario.provider} ${scenario.status} ${scenario.error ?? "bodyless"}`, async () => {
	const root = mkdtempSync(join(tmpdir(), "pi087-overflow-"));
	const settings = SettingsManager.inMemory({ compaction: { enabled: true, keepRecentTokens: 128, reserveTokens: 128 }, retry: { enabled: false } });
	const resources = new DefaultResourceLoader({ cwd: root, agentDir: root, settingsManager: settings,
		noExtensions: true, noContextFiles: true, noPromptTemplates: true, noSkills: true, noThemes: true });
	await resources.reload();
	const manager = SessionManager.inMemory(root);
	for (let i = 0; i < 6; i++) {
		manager.appendMessage({ role: "user", content: `history ${i} ` + "synthetic ".repeat(200), timestamp: i * 2 });
		manager.appendMessage({ ...message(scenario.provider, ""), content: [{ type: "text", text: "recorded answer" }], stopReason: "stop", timestamp: i * 2 + 1 });
	}
	const model: Model<"openai-completions"> = { id: "offline", name: "Offline", provider: scenario.provider,
		api: "openai-completions", baseUrl: "https://fixture.invalid/v1", reasoning: false, input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 1024 };
	let normalRequests = 0, summaryRequests = 0, compactStarts = 0;
	const runtime = { hasConfiguredAuth: () => true, checkAuth: async () => ({ type: "api_key" }),
		getAuth: async () => undefined, isUsingOAuth: () => false, getModel: () => model,
		registerProvider() {}, registerNativeProvider() {}, unregisterProvider() {},
		streamSimple: (m: any, context: any, options: any) => {
			const summary = context.systemPrompt?.includes("summar") === true;
			return streamSimple(m, context, { ...options, apiKey: "offline-fixture", maxRetries: 0,
				fetch: async (_input, init) => {
					const wire = JSON.parse(String(init?.body)); assert.ok(Array.isArray(wire.messages));
					if (!summary) { normalRequests++; assert.ok(normalRequests <= 2, "recovery must be bounded");
						return new Response(scenario.error ? JSON.stringify({ error: { message: scenario.error } }) : null, { status: scenario.status }); }
					summaryRequests++;
					const event = { id: "offline", object: "chat.completion.chunk", created: 1, model: m.id,
						choices: [{ index: 0, delta: { content: "Synthetic checkpoint." }, finish_reason: "stop" }] };
					return new Response(`data: ${JSON.stringify(event)}\n\ndata: [DONE]\n\n`, { headers: { "Content-Type": "text/event-stream" } });
				} });
		},
	} as unknown as ModelRuntime;
	const { session } = await createAgentSession({ cwd: root, agentDir: root, model, modelRuntime: runtime,
		settingsManager: settings, sessionManager: manager, resourceLoader: resources, noTools: "all" });
	session.subscribe(event => { if (event.type === "compaction_start") compactStarts++; });
	try {
		await session.prompt("Synthetic request.");
		assert.equal(compactStarts, scenario.overflow ? 1 : 0);
		assert.equal(normalRequests, scenario.overflow ? 2 : 1);
		// This fixture splits the retained turn: history and turn-prefix summaries.
		assert.equal(summaryRequests, scenario.overflow ? 2 : 0);
		assert.equal(session.isCompacting, false);
		assert.equal(session.agent.state.isStreaming, false);
		assert.ok(manager.getEntries().some(e => e.type === "message" && e.message.role === "assistant" && e.message.stopReason === "error"), "raw failed history remains durable");
	} finally { session.dispose(); rmSync(root, { recursive: true, force: true }); }
});
