import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { AssistantMessage, ToolResultMessage } from "@super-pi/ai";
import type { AgentEvent } from "../packages/agent/src/types.ts";
import { Text, type TUI } from "@super-pi/tui";
import { createAgentSession } from "../packages/coding-agent/src/core/sdk.ts";
import { DefaultResourceLoader } from "../packages/coding-agent/src/core/resource-loader.ts";
import { SettingsManager } from "../packages/coding-agent/src/core/settings-manager.ts";
import { SessionManager } from "../packages/coding-agent/src/core/session-manager.ts";
import { InteractiveMode } from "../packages/coding-agent/src/modes/interactive/interactive-mode.ts";
import { ToolExecutionComponent } from "../packages/coding-agent/src/modes/interactive/components/tool-execution.ts";
import { RetainedContainer } from "../packages/tui/src/components/retained-item.ts";
import { initTheme } from "../packages/coding-agent/src/modes/interactive/theme/theme.ts";

test("duration survives session delivery/reopen, live/deferred/history contexts and HTML; legacy remains unknown", async t => {
	initTheme("dark");
	const root = mkdtempSync(join(tmpdir(), "sp-duration-")); t.diagnostic(`ownedFixture=${root}`);
	const contexts = new Map<string, number | undefined>(), endDurations: Array<number | undefined> = [];
	const settings = SettingsManager.inMemory({});
	const resources = new DefaultResourceLoader({ cwd: root, agentDir: root, settingsManager: settings,
		noExtensions: true, noContextFiles: true, noSkills: true, noPromptTemplates: true, noThemes: true,
		extensionFactories: [pi => {
			pi.registerToolRenderer(() => ({ renderShell: "self", renderCall: () => new Text("call", 0, 0),
				renderResult(_result, _options, _theme, context) {
					contexts.set(context.toolCallId, context.durationMs);
					return new Text(`duration:${context.durationMs ?? "unknown"}`, 0, 0);
				} }));
			pi.on("tool_execution_end", event => { endDurations.push(event.durationMs); });
		}] });
	let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
	t.after(() => { try { session?.dispose(); } finally { rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } });
	await resources.reload();
	({ session } = await createAgentSession({ cwd: root, agentDir: root, resourceLoader: resources, settingsManager: settings,
		sessionManager: SessionManager.create(root, root), tools: ["read"], noMcp: true,
		model: { id: "fixture", name: "fixture", api: "openai-responses", provider: "fixture", baseUrl: "http://unused", reasoning: false,
			input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32000, maxTokens: 4096 },
		modelRuntime: { hasConfiguredAuth: () => true, checkAuth: async () => ({ type: "api_key" }), isUsingOAuth: () => false,
			getModel: () => undefined, getAuth: async () => undefined } as never }));
	await session.bindExtensions({});
	const mode = Object.assign(Object.create(InteractiveMode.prototype), { runtimeHost: { session }, isInitialized: true,
		pendingTools: new Map(), streamedToolIds: new Set(), deferredReadPlaceholders: new Map(), deferredReadExecutions: new Map(),
		chatContainer: new RetainedContainer(), nextTranscriptItemNumber: 0, toolOutputExpanded: false,
		ui: { requestRender() {} } as TUI, footer: { invalidate() {} }, addMessageToChat() {} }) as {
		createTrackedToolComponent(name: string, id: string, args: unknown): ToolExecutionComponent;
		handleEvent(event: AgentEvent): void; materializeStreamingReadTools(message: AssistantMessage): void;
		renderSessionItems(items: unknown[]): void; chatContainer: RetainedContainer;
	};
	t.after(() => mode.chatContainer.clear());
	const producer = Object.freeze({ content: [{ type: "text" as const, text: "done" }], details: {} });
	const row = mode.createTrackedToolComponent("timed", "live", {});
	mode.handleEvent({ type: "tool_execution_update", toolCallId: "live", toolName: "timed", args: {}, partialResult: producer });
	assert.equal(contexts.get("live"), undefined);
	const ended: AgentEvent = { type: "tool_execution_end", toolCallId: "live", toolName: "timed", result: producer, isError: false, durationMs: 42 };
	mode.handleEvent(ended); assert.equal(contexts.get("live"), 42); assert.match(row.render(100).join("\n"), /duration:42/);
	assert.equal("durationMs" in producer, false);
	const delivery = session as unknown as { _handleAgentEvent(event: AgentEvent): Promise<void> };
	await delivery._handleAgentEvent(ended); assert.deepEqual(endDurations, [42]);
	const assistant: AssistantMessage = { role: "assistant", api: "openai-responses", provider: "fixture", model: "fixture",
		content: [{ type: "toolCall", id: "saved", name: "timed", arguments: {} }, { type: "toolCall", id: "old", name: "legacy", arguments: {} }],
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason: "toolUse", timestamp: 1000, durationMs: 123 };
	const saved: ToolResultMessage = { role: "toolResult", toolCallId: "saved", toolName: "timed", content: producer.content,
		details: {}, isError: false, timestamp: 2000, durationMs: 42 };
	const legacy: ToolResultMessage = { role: "toolResult", toolCallId: "old", toolName: "legacy", content: producer.content, isError: false, timestamp: 1 };
	for (const message of [assistant, saved, legacy]) await delivery._handleAgentEvent({ type: "message_end", message });
	const reopened = SessionManager.open(session.sessionManager.getSessionFile()!, root);
	const history = reopened.getEntries().flatMap(entry => entry.type === "message" ? [entry.message] : []);
	assert.equal(history.find(value => value.role === "assistant")?.durationMs, 123);
	const restoredResults = history.filter((value): value is ToolResultMessage => value.role === "toolResult");
	assert.equal(restoredResults.find(value => value.toolCallId === "saved")?.durationMs, 42);
	assert.equal(restoredResults.find(value => value.toolCallId === "old")?.durationMs, undefined);
	mode.renderSessionItems(history); assert.equal(contexts.get("saved"), 42); assert.equal(contexts.get("old"), undefined);
	mode.handleEvent({ type: "tool_execution_start", toolCallId: "deferred", toolName: "read", args: { path: "a" } });
	mode.handleEvent({ type: "tool_execution_end", toolCallId: "deferred", toolName: "read", result: producer, isError: false, durationMs: 17 });
	mode.materializeStreamingReadTools({ ...assistant, content: [{ type: "toolCall", id: "deferred", name: "read", arguments: { path: "a" } }] });
	assert.equal(contexts.get("deferred"), 17);
	const output = await session.exportToHtml(join(root, "timing.html"));
	const encoded = readFileSync(output, "utf8").match(/<script id="session-data" type="application\/json">([A-Za-z0-9+/=]+)<\/script>/)?.[1];
	assert.ok(encoded); const data = JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
	assert.match(data.renderedTools.saved.resultHtmlExpanded, /duration:42/);
	assert.match(data.renderedTools.old.resultHtmlExpanded, /duration:unknown/);
	row.updateResult({ ...producer, durationMs: 999 }, true); assert.equal(contexts.get("live"), undefined);
});
