import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Text, TuiMainScreen, type TuiRenderInstrumentation } from "@super-pi/tui";
import type { AssistantMessage, Model } from "../packages/ai/src/types.ts";
import type { AgentMessage } from "../packages/agent/src/types.ts";
import { AgentSessionRuntime, type AgentSessionServices } from "../packages/coding-agent/src/core/agent-session-runtime.ts";
import type { ToolDefinition, ToolRenderContext } from "../packages/coding-agent/src/core/extensions/types.ts";
import type { ModelRuntime } from "../packages/coding-agent/src/core/model-runtime.ts";
import { DefaultResourceLoader } from "../packages/coding-agent/src/core/resource-loader.ts";
import { createAgentSession } from "../packages/coding-agent/src/core/sdk.ts";
import { SessionManager } from "../packages/coding-agent/src/core/session-manager.ts";
import { SettingsManager } from "../packages/coding-agent/src/core/settings-manager.ts";
import {
	ReadToolGroupComponent,
	ToolExecutionComponent,
} from "../packages/coding-agent/src/modes/interactive/components/tool-execution.ts";
import { InteractiveMode } from "../packages/coding-agent/src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../packages/coding-agent/src/modes/interactive/theme/theme.ts";
import type { RetainedContainer } from "../packages/tui/src/components/retained-item.ts";
import { FakeTerminal } from "./helpers/runtime-instrumentation.ts";

const EMPTY_USAGE = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function fixtureModel(): Model<"openai-responses"> {
	return {
		id: "retained-rebuild",
		name: "Retained Rebuild",
		api: "openai-responses",
		provider: "fixture",
		baseUrl: "https://fixture.invalid/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 32_768,
		maxTokens: 4_096,
	};
}

function createModelRuntime(): ModelRuntime {
	return {
		hasConfiguredAuth: () => true,
		checkAuth: async () => ({ type: "api_key" as const }),
		isUsingOAuth: () => false,
		streamSimple: () => {
			throw new Error("streaming is not expected in retained rebuild tests");
		},
		registerProvider: () => {},
		registerNativeProvider: () => {},
		unregisterProvider: () => {},
		getModel: () => undefined,
		getAuth: async () => undefined,
	} as unknown as ModelRuntime;
}

function assistant(toolCalls: AssistantMessage["content"]): AssistantMessage {
	return {
		role: "assistant",
		content: toolCalls,
		api: "openai-responses",
		provider: "fixture",
		model: "retained-rebuild",
		usage: EMPTY_USAGE,
		stopReason: "toolUse",
		timestamp: 1,
	};
}

function result(toolCallId: string, toolName: string, text = "done"): AgentMessage {
	return {
		role: "toolResult",
		toolCallId,
		toolName,
		content: [{ type: "text", text }],
		isError: false,
		timestamp: 2,
	};
}

interface InteractiveModeInternals {
	renderer: TuiMainScreen;
	chatContainer: RetainedContainer;
	renderInstrumentation: TuiRenderInstrumentation;
	pendingTools: Map<string, ToolExecutionComponent | ReadToolGroupComponent>;
	rebuildChatFromMessages(): void;
	showStatus(message: string): void;
	updateTrackedToolArgs(
		component: ToolExecutionComponent | ReadToolGroupComponent,
		toolCallId: string,
		args: unknown,
	): void;
}

function assertIndexedTailMatchesFull(internals: InteractiveModeInternals, width = 80, height = 20): void {
	const viewport = internals.chatContainer.renderViewportTail(width, height);
	const full: string[] = [];
	for (const child of internals.chatContainer.children) {
		for (const line of child.render(width)) full.push(line);
	}
	assert.equal(viewport.totalHeight, full.length);
	assert.equal(internals.chatContainer.getViewportIndexStats().totalHeight, full.length);
	assert.deepEqual(viewport.lines, full.slice(-height));
}

interface ModeFixture {
	mode: InteractiveMode;
	internals: InteractiveModeInternals;
	sessionManager: SessionManager;
	dispose(): void;
}

async function createModeFixture(
	messages: readonly AgentMessage[],
	customTools: readonly ToolDefinition[] = [],
): Promise<ModeFixture> {
	initTheme("dark");
	const root = mkdtempSync(join(tmpdir(), "super-pi-retained-rebuild-"));
	const cwd = join(root, "workspace");
	const agentDir = join(root, "agent");
	mkdirSync(cwd, { recursive: true });
	mkdirSync(agentDir, { recursive: true });
	const settingsManager = SettingsManager.create(cwd, agentDir);
	const sessionManager = SessionManager.inMemory(cwd);
	for (const message of messages) sessionManager.appendMessage(message as any);
	const resourceLoader = new DefaultResourceLoader({
		cwd,
		agentDir,
		settingsManager,
		noContextFiles: true,
		noExtensions: true,
		noPromptTemplates: true,
		noSkills: true,
		noThemes: true,
	});
	await resourceLoader.reload();
	const { session } = await createAgentSession({
		cwd,
		agentDir,
		model: fixtureModel(),
		modelRuntime: createModelRuntime(),
		settingsManager,
		sessionManager,
		resourceLoader,
		customTools: [...customTools],
	});
	const runtime = new AgentSessionRuntime(
		session,
		{ cwd, agentDir } as AgentSessionServices,
		async () => {
			throw new Error("session replacement is not expected in retained rebuild tests");
		},
	);
	const mode = new InteractiveMode(runtime, { tuiMode: "regular" });
	const internals = mode as unknown as InteractiveModeInternals;
	const renderer = new TuiMainScreen(new FakeTerminal(120, 40), false);
	renderer.setRenderInstrumentation(internals.renderInstrumentation);
	internals.renderer = renderer;
	return {
		mode,
		internals,
		sessionManager,
		dispose: () => {
			renderer.stop({ preserveScreen: true });
			session.dispose();
			rmSync(root, { recursive: true, force: true });
		},
	};
}

function assertEveryRebuiltToolIsRetained(internals: InteractiveModeInternals): void {
	for (const child of internals.chatContainer.children) {
		if (child instanceof ToolExecutionComponent || child instanceof ReadToolGroupComponent) {
			assert.ok(internals.chatContainer.getRetainedItem(child), "rebuilt tool must not remain a plain child");
		}
	}
}

test("initial render and compaction rebuild retain ordinary tools and one grouped read", async (t) => {
	let customVisual = "first";
	let capturedInvalidate: (() => void) | undefined;
	let resultRendererCalls = 0;
	const customTool = {
		name: "custom-retained",
		label: "Custom retained",
		description: "retained rebuild fixture",
		parameters: {},
		execute: async () => ({ content: [{ type: "text", text: "done" }], details: undefined }),
		renderCall: () => new Text("custom call"),
		renderResult: (
			_result: unknown,
			_options: unknown,
			_theme: unknown,
			context: ToolRenderContext,
		) => {
			resultRendererCalls++;
			capturedInvalidate = context.invalidate;
			return new Text(`custom result ${customVisual}`);
		},
	} as unknown as ToolDefinition;
	const messages: AgentMessage[] = [
		assistant([
			{ type: "toolCall", id: "custom-complete", name: "custom-retained", arguments: {} },
			{ type: "toolCall", id: "read-a", name: "read", arguments: { path: "src/a.ts" } },
			{ type: "toolCall", id: "read-b", name: "read", arguments: { path: "src/b.ts" } },
			{ type: "toolCall", id: "custom-pending", name: "custom-retained", arguments: { pending: true } },
		]),
		result("custom-complete", "custom-retained"),
		result("read-a", "read", "a"),
		result("read-b", "read", "b"),
	];
	const fixture = await createModeFixture(messages, [customTool]);
	t.after(fixture.dispose);
	const { mode, internals } = fixture;

	mode.renderInitialMessages();
	assertEveryRebuiltToolIsRetained(internals);
	let ordinary = internals.chatContainer.children.filter(
		(child): child is ToolExecutionComponent => child instanceof ToolExecutionComponent,
	);
	let groups = internals.chatContainer.children.filter(
		(child): child is ReadToolGroupComponent => child instanceof ReadToolGroupComponent,
	);
	assert.equal(ordinary.length, 2);
	assert.equal(groups.length, 1);
	assert.equal(internals.chatContainer.getRetainedItem(ordinary[0])?.completed, true);
	assert.equal(internals.chatContainer.getRetainedItem(groups[0])?.completed, true);
	assert.equal(internals.chatContainer.getRetainedItem(ordinary[1])?.completed, false);

	// Exercise the same production rebuild used after compaction/settings changes.
	internals.rebuildChatFromMessages();
	assertEveryRebuiltToolIsRetained(internals);
	ordinary = internals.chatContainer.children.filter(
		(child): child is ToolExecutionComponent => child instanceof ToolExecutionComponent,
	);
	groups = internals.chatContainer.children.filter(
		(child): child is ReadToolGroupComponent => child instanceof ReadToolGroupComponent,
	);
	assert.equal(ordinary.length, 2);
	assert.equal(groups.length, 1);
	assert.equal(internals.chatContainer.getRetainedItem(groups[0])?.completed, true);

	internals.chatContainer.render(100);
	const completedItemsBeforeActiveUpdate = internals.chatContainer.getRetainedStats().completedItems;
	internals.renderInstrumentation.reset();
	const pending = internals.pendingTools.get("custom-pending");
	assert.ok(pending);
	internals.updateTrackedToolArgs(pending, "custom-pending", { pending: "updated" });
	internals.chatContainer.render(100);
	let metrics = internals.renderInstrumentation.snapshot();
	assert.equal(metrics.completedItemRenders, 0);
	assert.equal(metrics.retainedCacheHits, completedItemsBeforeActiveUpdate);

	assert.ok(capturedInvalidate);
	const callsBeforeLateInvalidate = resultRendererCalls;
	internals.renderInstrumentation.reset();
	customVisual = "second";
	capturedInvalidate();
	const updated = internals.chatContainer.render(100);
	metrics = internals.renderInstrumentation.snapshot();
	assert.equal(resultRendererCalls, callsBeforeLateInvalidate + 1);
	assert.ok(updated.some((line) => line.includes("custom result second")));
	assert.equal(metrics.completedItemRenders, 1);

	internals.chatContainer.render(100);
	assert.equal(resultRendererCalls, callsBeforeLateInvalidate + 1);
	assert.equal(internals.renderInstrumentation.snapshot().completedItemRenders, 1);
});

test("5,000 rebuilt historical tools all own completed retained sidecars", async (t) => {
	const toolCalls: AssistantMessage["content"] = [];
	const messages: AgentMessage[] = [];
	for (let index = 0; index < 5_000; index++) {
		toolCalls.push({ type: "toolCall", id: `history-${index}`, name: "history-tool", arguments: { index } });
	}
	messages.push(assistant(toolCalls));
	for (let index = 0; index < 5_000; index++) messages.push(result(`history-${index}`, "history-tool"));
	const historyTool = {
		name: "history-tool",
		label: "History tool",
		description: "large retained rebuild fixture",
		parameters: {},
		execute: async () => ({ content: [{ type: "text", text: "done" }], details: undefined }),
		renderCall: () => new Text("history call"),
		renderResult: () => new Text("history result"),
	} as unknown as ToolDefinition;
	const fixture = await createModeFixture(messages, [historyTool]);
	t.after(fixture.dispose);
	fixture.mode.renderInitialMessages();
	const tools = fixture.internals.chatContainer.children.filter(
		(child): child is ToolExecutionComponent => child instanceof ToolExecutionComponent,
	);
	assert.equal(tools.length, 5_000);
	for (const tool of tools) {
		const item = fixture.internals.chatContainer.getRetainedItem(tool);
		assert.ok(item);
		assert.equal(item.completed, true);
	}
});

test("production showStatus tracks short, multiline, and short dynamic heights", async (t) => {
	const fixture = await createModeFixture([]);
	t.after(fixture.dispose);
	const { internals } = fixture;
	internals.showStatus("short");
	assertIndexedTailMatchesFull(internals);

	internals.renderInstrumentation.reset();
	internals.showStatus("long one\nlong two 中文 😀\nlong three e\u0301");
	assertIndexedTailMatchesFull(internals);
	assert.equal(internals.renderInstrumentation.snapshot().viewportItemVisits < 20, true);

	internals.renderInstrumentation.reset();
	internals.showStatus("short again");
	assertIndexedTailMatchesFull(internals);
	assert.equal(internals.renderInstrumentation.snapshot().viewportItemVisits < 20, true);
});
