import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Type } from "typebox";
import { stream as streamMistral } from "../packages/ai/src/api/mistral-conversations.ts";
import type { Model } from "../packages/ai/src/types.ts";
import { isRetryableAssistantError } from "../packages/ai/src/utils/retry.ts";
import { createAgentSession } from "../packages/coding-agent/src/core/sdk.ts";
import type { ModelRuntime } from "../packages/coding-agent/src/core/model-runtime.ts";
import { DefaultResourceLoader } from "../packages/coding-agent/src/core/resource-loader.ts";
import { SessionManager } from "../packages/coding-agent/src/core/session-manager.ts";
import { SettingsManager } from "../packages/coding-agent/src/core/settings-manager.ts";

const model: Model<"mistral-conversations"> = {
	id: "mistral-small-latest", name: "Offline Mistral", provider: "mistral", api: "mistral-conversations",
	baseUrl: "https://fixture.invalid", reasoning: false, input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 1024,
};
const context = { messages: [{ role: "user" as const, content: "Complete the scoped task.", timestamp: 1 }] };

function reply(finish: string, text = "partial response", toolId?: string): Response {
	const event = { id: "offline-mistral", choices: [{ finish_reason: finish, delta: {
		content: text,
		tool_calls: toolId ? [{ index: 0, id: toolId, function: { name: "record_effect", arguments: "{}" } }] : undefined,
	} }] };
	return new Response(`data: ${JSON.stringify(event)}\n\ndata: [DONE]\n\n`, { headers: { "Content-Type": "text/event-stream" } });
}

for (const [finish, stopReason, retryable] of [
	["error", "error", true], ["unmapped_error", "error", false], ["stop", "stop", false],
	["length", "length", false], ["tool_calls", "toolUse", false],
] as const) {
	test(`Mistral SSE ${finish} preserves raw reason, retry semantics and reader cleanup`, async () => {
		const response = reply(finish);
		let requestSignal: AbortSignal | undefined;
		const events = streamMistral(model, context, { apiKey: "offline-fixture", fetch: async (_input, init) => {
			requestSignal = init?.signal ?? undefined;
			return response;
		} });
		const eventTypes: string[] = [];
		for await (const event of events) eventTypes.push(event.type);
		const result = await events.result();
		assert.equal(result.stopReason, stopReason);
		assert.equal(result.rawStopReason, finish);
		assert.equal(isRetryableAssistantError(result), retryable);
		assert.equal(eventTypes.at(-1), stopReason === "error" ? "error" : "done");
		assert.equal(eventTypes.filter(type => type === "error" || type === "done").length, 1);
		assert.equal(response.body!.locked, false);
		assert.ok(requestSignal);
		assert.equal(getEventListeners(requestSignal, "abort").length, 0);
		if (finish === "error") assert.equal(result.errorMessage, "Provider stopped with: error (server error)");
	});
}

test("Mistral caller cancellation stays terminal even when the response reports a server error", async () => {
	const controller = new AbortController();
	const response = reply("error");
	const events = streamMistral(model, context, { apiKey: "offline-fixture", signal: controller.signal, fetch: async () => {
		controller.abort();
		return response;
	} });
	for await (const _event of events) { /* Drain the production event queue. */ }
	const result = await events.result();
	assert.equal(result.stopReason, "aborted");
	assert.equal(isRetryableAssistantError(result), false);
	assert.equal(response.body!.locked, false);
	assert.equal(getEventListeners(controller.signal, "abort").length, 0);
});

for (const failure of ["server_busy", "servers are currently busy", "The pending stream has been canceled", "finish-error"]) {
	test(`AgentSession recovers from ${failure} without replaying completed tools`, async t => {
		const root = mkdtempSync(join(tmpdir(), "sp-mistral-retry-"));
		let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
		t.after(async () => { await session?.abort(); session?.dispose(); rmSync(root, { recursive: true, force: true }); });
		const settings = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: true, maxRetries: 1, baseDelayMs: 1 } });
		const resources = new DefaultResourceLoader({ cwd: root, agentDir: root, settingsManager: settings,
			noExtensions: true, noContextFiles: true, noPromptTemplates: true, noSkills: true, noThemes: true,
			systemPrompt: "Execute the scoped task once; preserve completed tool evidence." });
		await resources.reload();
		const manager = SessionManager.inMemory(root);
		const wires: any[] = [];
		const retryEvents: string[] = [];
		let effects = 0;
		const runtime = {
			hasConfiguredAuth: () => true, checkAuth: async () => ({ type: "api_key" }),
			getAuth: async () => undefined, isUsingOAuth: () => false, getModel: () => model,
			registerProvider() {}, registerNativeProvider() {}, unregisterProvider() {},
			streamSimple: (_model: unknown, ctx: any, options: any) => streamMistral(model, ctx, {
				...options, apiKey: "offline-fixture", fetch: async (_input, init) => {
					wires.push(JSON.parse(String(init?.body)));
					assert.ok(wires.length <= 3, "the configured retry budget bounds requests");
					if (wires.length === 1) return reply("tool_calls", "", "effect001");
					if (wires.length === 2) {
						if (failure === "finish-error") return reply("error", "ABANDONED_ATTEMPT", "abandon01");
						throw new Error(failure);
					}
					return reply("stop", "Recovery complete.");
				},
			}),
		} as unknown as ModelRuntime;
		session = (await createAgentSession({ cwd: root, agentDir: root, model, modelRuntime: runtime,
			settingsManager: settings, sessionManager: manager, resourceLoader: resources, tools: ["record_effect"],
			customTools: [{ name: "record_effect", label: "Effect", description: "Record a synthetic effect", modelOnly: true,
				parameters: Type.Object({}), execute: async () => {
					effects++;
					return { content: [{ type: "text" as const, text: "EFFECT_ALREADY_COMPLETED" }], details: {} };
				},
			}],
		})).session;
		session.subscribe(event => {
			if (event.type === "auto_retry_start") retryEvents.push(`start:${event.attempt}:${event.maxAttempts}:${event.delayMs}`);
			if (event.type === "auto_retry_end") retryEvents.push(`end:${event.success}:${event.attempt}`);
		});
		await session.prompt("Complete the authorized synthetic effect and summarize.");
		assert.equal(wires.length, 3);
		assert.equal(effects, 1, "neither the completed call nor a failed-attempt call may execute again");
		assert.deepEqual(retryEvents, ["start:1:1:1", "end:true:1"]);
		assert.equal(session.isRetrying, false);
		assert.ok(wires[2].messages.some((entry: any) => entry.role === "tool" && entry.tool_call_id === "effect001" &&
			entry.content.some((part: any) => part.type === "text" && part.text.includes("EFFECT_ALREADY_COMPLETED"))));
		assert.equal(JSON.stringify(wires[2]).includes("ABANDONED_ATTEMPT"), false);
		assert.equal(JSON.stringify(wires[2]).includes("abandon01"), false);
		assert.ok(manager.getEntries().some(entry => entry.type === "message" && entry.message.role === "assistant" && entry.message.stopReason === "error"), "failed attempt remains in session history");
		const finalMessage = session.agent.state.messages.at(-1);
		assert.equal(finalMessage?.role, "assistant");
		assert.equal((finalMessage as { stopReason?: string }).stopReason, "stop");
	});
}
