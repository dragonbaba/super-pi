import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Type } from "typebox";
import { streamSimple } from "@super-pi/ai/api/openai-completions";
import type { AssistantMessage, Model } from "../packages/ai/src/types.ts";
import type { ModelRuntime } from "../packages/coding-agent/src/core/model-runtime.ts";
import { createAgentSession } from "../packages/coding-agent/src/core/sdk.ts";
import { DefaultResourceLoader } from "../packages/coding-agent/src/core/resource-loader.ts";
import { SessionManager } from "../packages/coding-agent/src/core/session-manager.ts";
import { SettingsManager } from "../packages/coding-agent/src/core/settings-manager.ts";

const model: Model<"openai-completions"> = {
	id: "offline-history", name: "Offline", provider: "fixture", api: "openai-completions",
	baseUrl: "https://fixture.invalid/v1", reasoning: false, input: ["text"],
	cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 1024,
};

function reply(text: string, finish = "stop"): Response {
	const chunk = { id: "offline", object: "chat.completion.chunk", created: 1, model: model.id,
		choices: [{ index: 0, delta: { content: text }, finish_reason: finish }],
		usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110,
			completion_tokens_details: { reasoning_tokens: 4 } } };
	return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, {
		headers: { "Content-Type": "text/event-stream" },
	});
}

test("final Chat wire excludes failed attempts across retry, resume, branch and model switch without losing effects or usage", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi087-history-"));
	const settings = SettingsManager.inMemory({ compaction: { enabled: false },
		retry: { enabled: true, maxRetries: 1, baseDelayMs: 1 } });
	const resources = new DefaultResourceLoader({ cwd: root, agentDir: root, settingsManager: settings,
		noExtensions: true, noContextFiles: true, noPromptTemplates: true, noSkills: true, noThemes: true,
		systemPrompt: "Synthetic fixed system policy." });
	await resources.reload();
	const manager = SessionManager.inMemory(root);
	const usage = { input: 20, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 25,
		cost: { input: 0.00002, output: 0.00001, cacheRead: 0, cacheWrite: 0, total: 0.00003 } };
	const assistant = (stopReason: AssistantMessage["stopReason"], text: string): AssistantMessage => ({
		role: "assistant", api: model.api, model: model.id, provider: model.provider, stopReason,
		content: [{ type: "text", text }], usage: structuredClone(usage), timestamp: 1,
	});
	manager.appendMessage({ role: "user", content: "Previously authorized synthetic effect.", timestamp: 0 });
	manager.appendMessage({ ...assistant("toolUse", ""), content: [{ type: "toolCall", id: "effect-1", name: "lookup", arguments: {} }] });
	manager.appendMessage({ role: "toolResult", toolCallId: "effect-1", toolName: "lookup",
		content: [{ type: "text", text: "synthetic-effect-already-completed" }], isError: false, timestamp: 2 });
	manager.appendMessage(assistant("error", "failed-persisted-fragment"));
	const branchPoint = manager.appendMessage(assistant("aborted", "aborted-persisted-fragment"));
	let requests = 0;
	let executions = 0;
	const wires: any[] = [];
	const runtime = {
		hasConfiguredAuth: () => true, checkAuth: async () => ({ type: "api_key" }),
		getAuth: async () => undefined, isUsingOAuth: () => false, getModel: () => model,
		registerProvider() {}, registerNativeProvider() {}, unregisterProvider() {},
		streamSimple: (m: any, context: any, options: any) => streamSimple(m, context, {
			...options, apiKey: "offline-fixture", maxRetries: 0, fetch: async (_input, init) => {
				wires.push(JSON.parse(String(init?.body)));
				requests++;
				assert.ok(requests <= 4, "one retry plus two independent resumed prompts");
				return requests === 1 ? reply("failed-live-fragment", "network_error") : reply("Recorded effect acknowledged.");
			},
		}),
	} as unknown as ModelRuntime;
	const options = { cwd: root, agentDir: root, model, modelRuntime: runtime, settingsManager: settings,
		sessionManager: manager, resourceLoader: resources, tools: ["lookup"], customTools: [{
			name: "lookup", label: "Lookup", description: "Synthetic lookup", parameters: Type.Object({}),
			execute: async () => { executions++; return { content: [{ type: "text" as const, text: "unexpected" }], details: {} }; },
		}] };
	let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
	try {
		session = (await createAgentSession(options)).session;
		await session.prompt("Continue from recorded evidence.");
		assert.equal(requests, 2);
		session.dispose();
		session = (await createAgentSession(options)).session;
		await session.setModel({ ...model, id: "switched-model", contextWindow: 256000 });
		await session.prompt("Resume with the same completed effect.");
		assert.equal(wires[2].model, "switched-model");
		session.dispose();
		manager.branch(branchPoint);
		session = (await createAgentSession(options)).session;
		await session.prompt("Branch from the recorded effect.");
		assert.equal(requests, 4);
		for (const wire of wires) {
			const serialized = JSON.stringify(wire);
			assert.doesNotMatch(serialized, /failed-persisted-fragment|aborted-persisted-fragment|failed-live-fragment/);
			assert.match(serialized, /Synthetic fixed system policy/);
			assert.ok(wire.tools.some((tool: any) => tool.function.name === "lookup"));
			const call = wire.messages.find((message: any) => message.tool_calls?.some((tool: any) => tool.id === "effect-1"));
			const result = wire.messages.find((message: any) => message.role === "tool" && message.tool_call_id === "effect-1");
			assert.ok(call && result, "completed effect retains its tool call/result pair");
			assert.match(JSON.stringify(result), /synthetic-effect-already-completed/);
		}
		assert.equal(executions, 0, "recorded effects must not execute again");
		const history = manager.getEntries().filter((entry) => entry.type === "message");
		assert.match(JSON.stringify(history), /failed-live-fragment/);
		assert.match(JSON.stringify(history), /aborted-persisted-fragment/);
		const failed = history.find((entry) => entry.message.role === "assistant" &&
			entry.message.content.some((block: any) => block.text === "failed-live-fragment"))?.message;
		assert.ok(failed?.role === "assistant");
		assert.equal(failed.usage.output, 10);
		assert.equal(failed.usage.reasoning, 4);
		assert.equal(failed.usage.totalTokens, 110, "reasoning is included in output, never added twice");
		assert.ok(failed.usage.cost.total > 0, "fixture usage is preserved, not a real charge");
	} finally { session?.dispose(); rmSync(root, { recursive: true, force: true }); }
});
