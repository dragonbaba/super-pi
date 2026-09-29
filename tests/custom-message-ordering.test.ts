import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { streamSimple } from "../packages/ai/src/api/openai-completions.ts";
import { DefaultResourceLoader } from "../packages/coding-agent/src/core/resource-loader.ts";
import { createAgentSession } from "../packages/coding-agent/src/core/sdk.ts";
import { SessionManager } from "../packages/coding-agent/src/core/session-manager.ts";
import { SettingsManager } from "../packages/coding-agent/src/core/settings-manager.ts";
import { ALPHA_MODEL, alphaModelRuntime } from "./helpers/alpha-session.ts";

function chatResponse(delta: unknown, finish: string): Response {
	const chunk = (d: unknown, f: string | null) => `data: ${JSON.stringify({ id: "x", object: "chat.completion.chunk", created: 1, model: "fixture", choices: [{ index: 0, delta: d, finish_reason: f }] })}\n\n`;
	return new Response(chunk(delta, null) + chunk({}, finish) + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
}

// A context-only custom message sent while a tool runs must not split a tool call from its result.
test("custom message sent during a tool call is appended after the turn's tool results", async () => {
	const root = mkdtempSync(join(tmpdir(), "custom-order-"));
	const payloads: any[] = [];
	const fetch: typeof globalThis.fetch = async (_url, init) => {
		payloads.push(JSON.parse(String(init?.body)));
		return payloads.length === 1
			? chatResponse({ tool_calls: [{ index: 0, id: "call_note", type: "function", function: { name: "note", arguments: "{}" } }] }, "tool_calls")
			: chatResponse({ content: "done" }, "stop");
	};
	const runtime = alphaModelRuntime((model: any, context: any, options: any) =>
		streamSimple({ ...model, api: "openai-completions" }, context, { ...options, apiKey: "offline", fetch, maxRetries: 0 }));
	const settings = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
	const resourceLoader = new DefaultResourceLoader({ cwd: root, agentDir: root, settingsManager: settings, noExtensions: true, noContextFiles: true, noSkills: true, noPromptTemplates: true, noThemes: true });
	await resourceLoader.reload();
	const sessionManager = SessionManager.inMemory(root);
	let session: any;
	const events: string[] = [];
	({ session } = await createAgentSession({
		cwd: root, agentDir: root, settingsManager: settings, sessionManager, resourceLoader, model: ALPHA_MODEL, modelRuntime: runtime, noTools: "builtin",
		customTools: [{ name: "note", label: "Note", description: "fixture", parameters: { type: "object", properties: {} },
			execute: async () => {
				await session.sendCustomMessage({ customType: "note", content: "noted", display: true }, { triggerTurn: false });
				events.push(`queued:${session.messages.some((m: any) => m.role === "custom")}`);
				return { content: [{ type: "text", text: "ok" }], details: {} };
			} }],
	}));
	const unsubscribe = session.subscribe((event: any) => {
		if (event.type === "message_end") events.push(`end:${event.message.role}`);
	});
	try {
		await session.prompt("Take a note.");
		await session.agent.waitForIdle();
		const roles = (entries: any[]) => entries.map(entry => entry.type === "custom_message" ? "custom" : entry.message?.role ?? entry.role).filter(Boolean);
		assert.deepEqual(roles(sessionManager.getEntries()), ["user", "assistant", "toolResult", "custom", "assistant"]);
		assert.deepEqual(session.messages.map((m: any) => m.role), ["user", "assistant", "toolResult", "custom", "assistant"]);
		// Nothing is announced before it exists in session history.
		assert.deepEqual(events, ["end:user", "end:assistant", "queued:false", "end:toolResult", "end:custom", "end:assistant"]);
		// The next request replays history; the tool result must still follow its call.
		await session.prompt("Again.");
		await session.agent.waitForIdle();
		const wire = payloads[2].messages.map((m: any) => m.role);
		assert.equal(wire[wire.indexOf("assistant") + 1], "tool", JSON.stringify(wire));
	} finally {
		unsubscribe();
		session.dispose();
		rmSync(root, { recursive: true, force: true });
	}
});

test("custom message without a turn is appended immediately when idle", async () => {
	const root = mkdtempSync(join(tmpdir(), "custom-idle-"));
	const settings = SettingsManager.inMemory({ compaction: { enabled: false } });
	const resourceLoader = new DefaultResourceLoader({ cwd: root, agentDir: root, settingsManager: settings, noExtensions: true, noContextFiles: true, noSkills: true, noPromptTemplates: true, noThemes: true });
	await resourceLoader.reload();
	const sessionManager = SessionManager.inMemory(root);
	const { session } = await createAgentSession({ cwd: root, agentDir: root, settingsManager: settings, sessionManager, resourceLoader, model: ALPHA_MODEL, modelRuntime: alphaModelRuntime(), noTools: "all" });
	try {
		await session.sendCustomMessage({ customType: "note", content: "idle", display: true }, { triggerTurn: false });
		assert.deepEqual(session.messages.map((m: any) => m.role), ["custom"]);
		assert.equal(sessionManager.getEntries().filter((entry: any) => entry.type === "custom_message").length, 1);
	} finally {
		session.dispose();
		rmSync(root, { recursive: true, force: true });
	}
});
