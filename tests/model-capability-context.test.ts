import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { stream as streamOpenAIChat } from "../packages/ai/src/api/openai-completions.ts";
import { conservativeModelCapabilities } from "../packages/ai/src/model-capabilities.ts";
import type { Context, Model } from "../packages/ai/src/types.ts";
import type { ModelRuntime } from "../packages/coding-agent/src/core/model-runtime.ts";
import { DefaultResourceLoader } from "../packages/coding-agent/src/core/resource-loader.ts";
import { createAgentSession } from "../packages/coding-agent/src/core/sdk.ts";
import { SessionManager } from "../packages/coding-agent/src/core/session-manager.ts";
import { SettingsManager } from "../packages/coding-agent/src/core/settings-manager.ts";
import { buildSystemPrompt } from "../packages/coding-agent/src/core/system-prompt.ts";

function model(): Model<"openai-completions"> {
	return {
		id: "no-tools",
		name: "No Tools",
		api: "openai-completions",
		provider: "fixture",
		baseUrl: "https://fixture.invalid/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 32_768,
		maxTokens: 4_096,
		profileSource: "conservative-fallback",
		costKnown: false,
		capabilities: conservativeModelCapabilities(),
		compat: { supportsStrictMode: true, supportsLongCacheRetention: true },
	};
}

function contextWithToolHistory(): Context {
	return {
		systemPrompt: "system",
		tools: [{ name: "read", description: "read", parameters: { type: "object", properties: {} } }],
		messages: [
			{ role: "user", content: "inspect", timestamp: 1 },
			{
				role: "assistant",
				content: [{ type: "toolCall", id: "call-secret", name: "read", arguments: { path: "secret.txt" } }],
				api: "openai-completions",
				provider: "fixture",
				model: "previous",
				usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
				stopReason: "toolUse",
				timestamp: 2,
			},
			{
				role: "toolResult",
				toolCallId: "call-secret",
				toolName: "read",
				content: [{ type: "text", text: "file contents" }],
				isError: false,
				timestamp: 3,
			},
		],
	};
}

function response(): Response {
	return new Response('data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
}

test("toolCalling=false default prompt does not advertise tools", () => {
	const prompt = buildSystemPrompt({ cwd: "C:/workspace", selectedTools: [], toolSnippets: {} });
	assert.equal(prompt.includes("Available tools:"), false);
	assert.equal(prompt.includes("other custom tools"), false);
	assert.equal(prompt.includes("executing commands"), false);
});

test("AgentSession preserves active tools while a no-tool model is selected and restores them on switch", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "super-pi-no-tool-switch-"));
	t.after(async () => rm(root, { recursive: true, force: true }));
	const agentDir = join(root, "agent");
	const settingsManager = SettingsManager.create(root, agentDir);
	const resourceLoader = new DefaultResourceLoader({
		cwd: root,
		agentDir,
		settingsManager,
		noContextFiles: true,
		noExtensions: true,
		noPromptTemplates: true,
		noSkills: true,
		noThemes: true,
	});
	await resourceLoader.reload();
	const runtime = {
		checkAuth: async () => ({ type: "api_key" as const }),
		streamSimple: () => {
			throw new Error("streaming is not expected in this test");
		},
	} as unknown as ModelRuntime;
	const noToolModel = model();
	const toolModel: Model<"openai-completions"> = {
		...noToolModel,
		id: "with-tools",
		name: "With Tools",
		capabilities: undefined,
		profileSource: undefined,
	};
	const { session } = await createAgentSession({
		cwd: root,
		agentDir,
		model: noToolModel,
		modelRuntime: runtime,
		settingsManager,
		sessionManager: SessionManager.inMemory(root),
		resourceLoader,
		tools: ["read"],
	});
	t.after(() => session.dispose());

	assert.deepEqual(session.getActiveToolNames(), ["read"]);
	assert.equal(session.systemPrompt.includes("Available tools:"), false);
	await session.setModel(toolModel);
	assert.deepEqual(session.getActiveToolNames(), ["read"]);
	assert.equal(session.systemPrompt.includes("Available tools:"), true);
	await session.setModel(noToolModel);
	assert.deepEqual(session.getActiveToolNames(), ["read"]);
	assert.equal(session.systemPrompt.includes("Available tools:"), false);
});

test("toolCalling=false converts prior tool protocol to ordinary messages", async () => {
	let wire: Record<string, unknown> | undefined;
	await streamOpenAIChat(model(), contextWithToolHistory(), {
		apiKey: "fixture-key",
		fetch: async (_input, init) => {
			wire = JSON.parse(String(init?.body)) as Record<string, unknown>;
			return response();
		},
	}).result();
	assert.ok(wire);
	assert.equal(wire.tools, undefined);
	assert.equal(wire.tool_choice, undefined);
	const messages = wire.messages as Array<Record<string, unknown>>;
	assert.equal(messages.some((message) => message.role === "tool"), false);
	assert.equal(messages.some((message) => "tool_calls" in message || "tool_call_id" in message), false);
});

test("capability sanitizer runs after samplingParams and before onPayload", async () => {
	let sanitized: Record<string, unknown> | undefined;
	let finalWire: Record<string, unknown> | undefined;
	const injectedTool = { type: "function", function: { name: "injected", parameters: {}, strict: true } };
	const injectedReasoning = { effort: "high", summary: "auto" };
	await streamOpenAIChat(model(), contextWithToolHistory(), {
		apiKey: "fixture-key",
		cacheRetention: "long",
		reasoningEffort: "high",
		samplingParams: {
			tools: [injectedTool],
			tool_choice: "required",
			parallel_tool_calls: true,
			reasoning_effort: "high",
			reasoning: injectedReasoning,
			prompt_cache_key: "secret-cache-key",
			prompt_cache_retention: "24h",
			prompt_cache_options: { mode: "explicit" },
			cache_control: { type: "ephemeral", ttl: "1h" },
			strict: true,
		},
		onPayload: (payload) => {
			sanitized = structuredClone(payload as Record<string, unknown>);
			return { ...(payload as Record<string, unknown>), temperature: 0.25 };
		},
		fetch: async (_input, init) => {
			finalWire = JSON.parse(String(init?.body)) as Record<string, unknown>;
			return response();
		},
	}).result();
	for (const payload of [sanitized, finalWire]) {
		assert.ok(payload);
		assert.equal(payload.tools, undefined);
		assert.equal(payload.tool_choice, undefined);
		assert.equal(payload.parallel_tool_calls, undefined);
		assert.equal(payload.reasoning_effort, undefined);
		assert.equal(payload.reasoning, undefined);
		assert.equal(payload.prompt_cache_key, undefined);
		assert.equal(payload.prompt_cache_retention, undefined);
		assert.equal(payload.prompt_cache_options, undefined);
		assert.equal(payload.cache_control, undefined);
		assert.equal(payload.strict, undefined);
	}
	assert.equal(injectedTool.function.strict, true);
	assert.equal(injectedReasoning.effort, "high");
	assert.equal(finalWire?.temperature, 0.25);
});
