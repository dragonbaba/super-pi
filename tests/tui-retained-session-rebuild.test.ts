import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Text, TuiMainScreen, type TuiRenderInstrumentation } from "@super-pi/tui";
import type { AssistantMessage, Model, ToolResultMessage } from "../packages/ai/src/types.ts";
import type { AgentMessage } from "../packages/agent/src/types.ts";
import type { AgentSession, AgentSessionEvent } from "../packages/coding-agent/src/core/agent-session.ts";
import { AgentSessionRuntime, type AgentSessionServices } from "../packages/coding-agent/src/core/agent-session-runtime.ts";
import type { ToolDefinition, ToolRenderContext } from "../packages/coding-agent/src/core/extensions/types.ts";
import type { ModelRuntime } from "../packages/coding-agent/src/core/model-runtime.ts";
import { DefaultResourceLoader } from "../packages/coding-agent/src/core/resource-loader.ts";
import { createAgentSession } from "../packages/coding-agent/src/core/sdk.ts";
import { SessionManager } from "../packages/coding-agent/src/core/session-manager.ts";
import { SettingsManager } from "../packages/coding-agent/src/core/settings-manager.ts";
import type { ToolResultPresentationOptions } from "../packages/coding-agent/src/core/tool-result-presentation.ts";
import {
	createToolResultPresentationOwner,
	type ToolResultPresentation,
} from "../packages/coding-agent/src/core/tool-result-presentation.ts";
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
		isUsingSubscription: () => false,
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
	isInitialized: boolean;
	renderer: TuiMainScreen;
	chatContainer: RetainedContainer;
	renderInstrumentation: TuiRenderInstrumentation;
	pendingTools: Map<string, ToolExecutionComponent | ReadToolGroupComponent>;
	clearToolResultDiscoveries(): void;
	getToolResultDiscoveryLifecycleCounts(): {
		entries: number;
		attached: number;
		pending: number;
		registrationObjectsCreated?: number;
		registrationsAttached?: number;
		registrationsHighWaterMark?: number;
		registrationsEvicted?: number;
		registrationsTeardownReleased?: number;
	};
	handleEvent(event: AgentSessionEvent): void | Promise<void>;
	rebuildChatFromMessages(): void;
	renderCurrentSessionState(): void;
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
	session: AgentSession;
	sessionManager: SessionManager;
	dispose(): void;
}

async function createModeFixture(
	messages: readonly AgentMessage[],
	customTools: readonly ToolDefinition[] = [],
	toolResultPresentation?: ToolResultPresentationOptions,
	extensionFactories: Array<(pi: any) => void> = [],
): Promise<ModeFixture> {
	initTheme("dark");
	const root = mkdtempSync(join(tmpdir(), "super-pi-retained-rebuild-"));
	const cwd = join(root, "workspace");
	const agentDir = join(root, "agent");
	mkdirSync(cwd, { recursive: true });
	mkdirSync(agentDir, { recursive: true });
	const settingsManager = toolResultPresentation
		? SettingsManager.inMemory({
			toolResultPresentation: {
				enabled: toolResultPresentation.enabled,
				budgetTokens: toolResultPresentation.budgetTokens,
			},
		})
		: SettingsManager.create(cwd, agentDir);
	const sessionManager = SessionManager.inMemory(cwd);
	for (const message of messages) sessionManager.appendMessage(message as any);
	const resourceLoader = new DefaultResourceLoader({
		cwd,
		agentDir,
		settingsManager,
		noContextFiles: true,
		noExtensions: extensionFactories.length === 0,
		extensionFactories,
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
		toolResultPresentation,
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
	await internals.renderer.dispose({ preserveScreen: true });
	await new Promise<void>((resolve) => setImmediate(resolve));
	const renderer = new TuiMainScreen(new FakeTerminal(120, 40), false);
	renderer.setRenderInstrumentation(internals.renderInstrumentation);
	internals.renderer = renderer;
	return {
		mode,
		internals,
		session,
		sessionManager,
		dispose: () => {
			renderer.stop({ preserveScreen: true });
			session.dispose();
			rmSync(root, { recursive: true, force: true });
		},
	};
}

test("live tool completion binds the internal presentation sidecar by canonical content identity", async (t) => {
	const fixture = await createModeFixture([], [], { enabled: true, budgetTokens: 128 });
	t.after(fixture.dispose);
	fixture.internals.isInitialized = true;
	const toolCallId = "live-bounded";
	await fixture.internals.handleEvent({
		type: "tool_execution_start",
		toolCallId,
		toolName: "fixture-tool",
		args: {},
	});
	const component = fixture.internals.pendingTools.get(toolCallId);
	assert.ok(component instanceof ToolExecutionComponent);
	const message = result(toolCallId, "fixture-tool", "live-canonical-".repeat(1_000));
	assert.equal(message.role, "toolResult");
	await fixture.internals.handleEvent({
		type: "tool_execution_end",
		toolCallId,
		toolName: "fixture-tool",
		result: message,
		isError: false,
	});
	assert.doesNotMatch(fixture.internals.chatContainer.render(80).join("\n"), /Model received a bounded view/);
	fixture.session.agent.state.messages.push(message);
	const presentation = fixture.session.getToolResultPresentationForUi(message);
	assert.equal(presentation?.version, 2);
	await fixture.internals.handleEvent({ type: "message_end", message, toolResultPresentation: presentation });
	assert.ok(component.getToolResultPresentationDiscovery(toolCallId));
	assert.match(
		fixture.internals.chatContainer.render(80).join("\n"),
		/Model received a bounded view/,
		"late sidecar attachment invalidates the completed retained render",
	);
	assert.deepEqual(
		(({ entries, attached, pending }) => ({ entries, attached, pending }))(
			fixture.internals.getToolResultDiscoveryLifecycleCounts(),
		),
		{ entries: 1, attached: 1, pending: 0 },
	);
	fixture.internals.clearToolResultDiscoveries();
	assert.equal(component.getToolResultPresentationDiscovery(toolCallId), undefined);
	assert.equal(fixture.internals.getToolResultDiscoveryLifecycleCounts().entries, 0);
});

test("post-extension canonical ToolResult replaces the live result and receives discovery", async (t) => {
	let extensionSawPresentation = false;
	const canonicalText = "post-extension-canonical-".repeat(1_000);
	const fixture = await createModeFixture(
		[],
		[],
		{ enabled: true, budgetTokens: 128 },
		[(pi) => {
			pi.on("message_end", (event: { message: ToolResultMessage; toolResultPresentation?: unknown }) => {
				if (event.message.role !== "toolResult") return undefined;
				extensionSawPresentation ||= "toolResultPresentation" in event;
				return { message: { ...event.message, content: [{ type: "text", text: canonicalText }] } };
			});
		}],
	);
	t.after(fixture.dispose);
	fixture.internals.isInitialized = true;
	const toolCallId = "post-extension-live";
	await fixture.internals.handleEvent({
		type: "tool_execution_start",
		toolCallId,
		toolName: "fixture-tool",
		args: {},
	});
	const component = fixture.internals.pendingTools.get(toolCallId);
	assert.ok(component instanceof ToolExecutionComponent);
	const originalText = "pre-extension-result-".repeat(1_000);
	const message = result(toolCallId, "fixture-tool", originalText) as ToolResultMessage;
	fixture.session.agent.state.messages.push(message);
	await fixture.internals.handleEvent({
		type: "tool_execution_end",
		toolCallId,
		toolName: "fixture-tool",
		result: message,
		isError: false,
	});
	let emittedPresentation: Extract<AgentSessionEvent, { type: "message_end" }>["toolResultPresentation"];
	const unsubscribe = fixture.session.subscribe((event) => {
		if (event.type !== "message_end" || event.message.role !== "toolResult") return;
		emittedPresentation = event.toolResultPresentation;
		return fixture.internals.handleEvent(event);
	});
	await (fixture.session as unknown as {
		_handleAgentEvent(event: { type: "message_end"; message: ToolResultMessage }): Promise<void>;
	})._handleAgentEvent({ type: "message_end", message });
	unsubscribe();
	assert.equal(extensionSawPresentation, false);
	assert.equal(message.content[0]?.type === "text" ? message.content[0].text : undefined, canonicalText);
	assert.ok(emittedPresentation?.version === 2);
	assert.ok(component.getToolResultPresentationDiscovery(toolCallId));
	component.setExpanded(true);
	const rendered = component.render(120).join("\n");
	assert.match(rendered, /post-extension-canonical/);
	assert.doesNotMatch(rendered, /pre-extension-result/);
	assert.match(rendered, /Model received a bounded view/);
	const artifact = fixture.session.readToolResultArtifact(emittedPresentation.artifact!.id);
	assert.equal(artifact.content, message.content);
	const continuation = fixture.session.readToolResultContinuation(emittedPresentation.continuation.cursor, 128);
	assert.ok(continuation.content.length > 0);
	const provider = await fixture.session.agent.convertToLlm(fixture.session.agent.state.messages.slice());
	const providerResult = provider.find((candidate) => candidate.role === "toolResult");
	assert.ok(providerResult?.role === "toolResult");
	assert.equal("toolResultPresentation" in providerResult, false);
	assert.equal("uiContent" in providerResult, false);
	const persisted = fixture.sessionManager.getBranch().at(-1);
	assert.equal(persisted?.type, "message");
	assert.equal(
		persisted?.type === "message" && persisted.message.role === "toolResult" && persisted.message.content[0]?.type === "text"
			? persisted.message.content[0].text
			: undefined,
		canonicalText,
	);
	const lifecycle = fixture.internals.getToolResultDiscoveryLifecycleCounts();
	assert.equal(lifecycle.registrationObjectsCreated, 1);
	assert.equal(lifecycle.registrationsAttached, 1);
	assert.equal(lifecycle.registrationsHighWaterMark, 1);
});

test("stale and duplicate live ToolResult registrations fail closed", async (t) => {
	const fixture = await createModeFixture([], [], { enabled: true, budgetTokens: 128 });
	t.after(fixture.dispose);
	fixture.internals.isInitialized = true;
	const owner = createToolResultPresentationOwner({ enabled: true, budgetTokens: 128 }, "live-stale")!;
	t.after(() => owner.dispose());
	const toolCallId = "reused-live-id";
	const driveResult = async (message: ToolResultMessage): Promise<ToolExecutionComponent> => {
		await fixture.internals.handleEvent({ type: "tool_execution_start", toolCallId, toolName: "fixture-tool", args: {} });
		const component = fixture.internals.pendingTools.get(toolCallId);
		assert.ok(component instanceof ToolExecutionComponent);
		await fixture.internals.handleEvent({
			type: "tool_execution_end",
			toolCallId,
			toolName: "fixture-tool",
			result: message,
			isError: false,
		});
		return component;
	};
	const oldMessage = result(toolCallId, "fixture-tool", "old-".repeat(1_000)) as ToolResultMessage;
	const oldComponent = await driveResult(oldMessage);
	fixture.internals.clearToolResultDiscoveries();
	const currentMessage = result(toolCallId, "fixture-tool", "current-".repeat(1_000)) as ToolResultMessage;
	const currentComponent = await driveResult(currentMessage);
	const oldPresentation = owner.create(oldMessage.content, toolCallId)!;
	owner.release();
	await fixture.internals.handleEvent({ type: "message_end", message: oldMessage, toolResultPresentation: oldPresentation });
	assert.equal(currentComponent.getToolResultPresentationDiscovery(toolCallId), undefined);
	const currentPresentation = owner.create(currentMessage.content, toolCallId)!;
	owner.release();
	await fixture.internals.handleEvent({ type: "message_end", message: currentMessage, toolResultPresentation: currentPresentation });
	assert.ok(currentComponent.getToolResultPresentationDiscovery(toolCallId));
	assert.equal(oldComponent.getToolResultPresentationDiscovery(toolCallId), undefined);

	const duplicateMessage = result(toolCallId, "fixture-tool", "duplicate-".repeat(1_000)) as ToolResultMessage;
	const duplicateComponent = await driveResult(duplicateMessage);
	const duplicatePresentation = owner.create(duplicateMessage.content, toolCallId)!;
	owner.release();
	await fixture.internals.handleEvent({ type: "message_end", message: duplicateMessage, toolResultPresentation: duplicatePresentation });
	assert.equal(currentComponent.getToolResultPresentationDiscovery(toolCallId), undefined);
	assert.equal(duplicateComponent.getToolResultPresentationDiscovery(toolCallId), undefined);
});

test("a live V1 result releases its pending discovery registration", async (t) => {
	const fixture = await createModeFixture([], [], { enabled: true, budgetTokens: 128 });
	t.after(fixture.dispose);
	fixture.internals.isInitialized = true;
	const toolCallId = "live-v1";
	const message = result(toolCallId, "fixture-tool", "small") as ToolResultMessage;
	await fixture.internals.handleEvent({ type: "tool_execution_start", toolCallId, toolName: "fixture-tool", args: {} });
	await fixture.internals.handleEvent({
		type: "tool_execution_end",
		toolCallId,
		toolName: "fixture-tool",
		result: message,
		isError: false,
	});
	const owner = createToolResultPresentationOwner({ enabled: true, budgetTokens: 128 }, "live-v1")!;
	t.after(() => owner.dispose());
	const presentation = owner.create(message.content, toolCallId)!;
	owner.release();
	assert.equal(presentation.version, 1);
	await fixture.internals.handleEvent({ type: "message_end", message, toolResultPresentation: presentation });
	const counts = fixture.internals.getToolResultDiscoveryLifecycleCounts();
	assert.equal(counts.entries, 0);
	assert.equal(counts.pending, 0);
	assert.equal(counts.attached, 0);
});

test("wholesale rebuild detaches 128 discoveries without updating discarded components", async (t) => {
	const calls: AssistantMessage["content"] = [];
	const messages: AgentMessage[] = [];
	for (let index = 0; index < 128; index++) {
		calls.push({ type: "toolCall", id: `teardown-${index}`, name: "fixture-tool", arguments: {} });
	}
	messages.push(assistant(calls));
	for (let index = 0; index < 128; index++) {
		messages.push(result(`teardown-${index}`, "fixture-tool", `large-${index}-`.repeat(1_000)));
	}
	const fixture = await createModeFixture(messages, [], { enabled: true, budgetTokens: 128 });
	t.after(fixture.dispose);
	fixture.mode.renderInitialMessages();
	const components = fixture.internals.chatContainer.children.filter(
		(child): child is ToolExecutionComponent => child instanceof ToolExecutionComponent,
	);
	assert.equal(components.length, 128);
	let discardedUpdateDisplayCalls = 0;
	for (const component of components) {
		const target = component as unknown as { updateDisplay(): void };
		const original = target.updateDisplay.bind(component);
		target.updateDisplay = () => {
			discardedUpdateDisplayCalls++;
			original();
		};
	}
	fixture.internals.renderCurrentSessionState();
	assert.equal(discardedUpdateDisplayCalls, 0);
	assert.equal(fixture.internals.getToolResultDiscoveryLifecycleCounts().registrationsTeardownReleased, 128);
	const switchedComponents = fixture.internals.chatContainer.children.filter(
		(child): child is ToolExecutionComponent => child instanceof ToolExecutionComponent,
	);
	let stopUpdateDisplayCalls = 0;
	for (const component of switchedComponents) {
		const target = component as unknown as { updateDisplay(): void };
		const original = target.updateDisplay.bind(component);
		target.updateDisplay = () => {
			stopUpdateDisplayCalls++;
			original();
		};
	}
	await fixture.mode.stop("transcript");
	assert.equal(stopUpdateDisplayCalls, 0);
	const stopped = fixture.internals.getToolResultDiscoveryLifecycleCounts();
	assert.equal(stopped.entries, 0);
	assert.equal(stopped.registrationsTeardownReleased, 256);
});

test("default-off session rebuild creates no discovery registry or component state", async (t) => {
	const toolCallId = "default-off-large";
	const fixture = await createModeFixture([
		assistant([{ type: "toolCall", id: toolCallId, name: "fixture-tool", arguments: {} }]),
		result(toolCallId, "fixture-tool", "default-off-canonical-".repeat(1_000)),
	]);
	t.after(fixture.dispose);
	fixture.mode.renderInitialMessages();
	assert.deepEqual(
		(({ entries, attached, pending }) => ({ entries, attached, pending }))(
			fixture.internals.getToolResultDiscoveryLifecycleCounts(),
		),
		{ entries: 0, attached: 0, pending: 0 },
	);
	const component = fixture.internals.chatContainer.children.find(
		(child): child is ToolExecutionComponent => child instanceof ToolExecutionComponent,
	);
	assert.ok(component);
	assert.equal(component.getToolResultPresentationDiscovery(toolCallId), undefined);
});

function assertEveryRebuiltToolIsRetained(internals: InteractiveModeInternals): void {
	for (const child of internals.chatContainer.children) {
		if (child instanceof ToolExecutionComponent || child instanceof ReadToolGroupComponent) {
			assert.ok(internals.chatContainer.getRetainedItem(child), "rebuilt tool must not remain a plain child");
		}
	}
}

test("resumed bounded results rebuild discoverability from canonical messages with a hard UI cap", async (t) => {
	const calls: AssistantMessage["content"] = [];
	const messages: AgentMessage[] = [];
	for (let index = 0; index < 130; index++) {
		calls.push({ type: "toolCall", id: `bounded-${index}`, name: "fixture-tool", arguments: { index } });
	}
	messages.push(assistant(calls));
	for (let index = 0; index < 130; index++) {
		messages.push(result(`bounded-${index}`, "fixture-tool", `canonical-${index}-`.repeat(600)));
	}

	const fixture = await createModeFixture(messages, [], { enabled: true, budgetTokens: 128 });
	t.after(fixture.dispose);
	fixture.mode.renderInitialMessages();
	let components = fixture.internals.chatContainer.children.filter(
		(child): child is ToolExecutionComponent => child instanceof ToolExecutionComponent,
	);
	assert.equal(components.length, 130);
	assert.deepEqual(
		(({ entries, attached, pending }) => ({ entries, attached, pending }))(
			fixture.internals.getToolResultDiscoveryLifecycleCounts(),
		),
		{ entries: 128, attached: 128, pending: 0 },
	);
	assert.equal(components[0]!.getToolResultPresentationDiscovery("bounded-0"), undefined);
	assert.equal(components[1]!.getToolResultPresentationDiscovery("bounded-1"), undefined);
	assert.ok(components[2]!.getToolResultPresentationDiscovery("bounded-2"));
	assert.match(components.at(-1)!.render(80).join("\n"), /Model received a bounded view/);
	const canonical = fixture.session.agent.state.messages.find(
		(message): message is Extract<AgentMessage, { role: "toolResult" }> =>
			message.role === "toolResult" && message.toolCallId === "bounded-129",
	);
	assert.ok(canonical);
	assert.equal(
		fixture.session.getToolResultPresentationForUi({ ...canonical, content: [...canonical.content] }),
		undefined,
		"a provider/context clone cannot become the UI canonical source",
	);
	assert.equal(
		fixture.session.getToolResultPresentationForUi({ ...canonical }),
		undefined,
		"a shallow wrapper sharing canonical content cannot receive the internal UI sidecar",
	);
	fixture.session.agent.state.messages.push({ ...canonical });
	assert.equal(
		fixture.session.getToolResultPresentationForUi(canonical),
		undefined,
		"duplicate active source identity stays ambiguous",
	);
	fixture.session.agent.state.messages.pop();

	fixture.internals.rebuildChatFromMessages();
	components = fixture.internals.chatContainer.children.filter(
		(child): child is ToolExecutionComponent => child instanceof ToolExecutionComponent,
	);
	assert.deepEqual(
		(({ entries, attached, pending }) => ({ entries, attached, pending }))(
			fixture.internals.getToolResultDiscoveryLifecycleCounts(),
		),
		{ entries: 128, attached: 128, pending: 0 },
	);
	assert.ok(components.at(-1)!.getToolResultPresentationDiscovery("bounded-129"));

	fixture.internals.clearToolResultDiscoveries();
	assert.deepEqual(
		(({ entries, attached, pending }) => ({ entries, attached, pending }))(
			fixture.internals.getToolResultDiscoveryLifecycleCounts(),
		),
		{ entries: 0, attached: 0, pending: 0 },
	);
	for (let index = 0; index < components.length; index++) {
		assert.equal(components[index]!.getToolResultPresentationDiscovery(`bounded-${index}`), undefined);
	}
});

test("128 trailing V1 results do not hide an earlier bounded V2 discovery", async (t) => {
	const calls: AssistantMessage["content"] = [
		{ type: "toolCall", id: "older-v2", name: "fixture-tool", arguments: {} },
	];
	const messages: AgentMessage[] = [{
		...(result("older-v2", "fixture-tool", "older-large-".repeat(1_000)) as ToolResultMessage),
		content: [
			{ type: "text", text: "older-large-".repeat(1_000) },
			{ type: "image", data: "QUJDREVGRw==", mimeType: "image/png" },
		],
	}];
	for (let index = 0; index < 128; index++) {
		calls.push({ type: "toolCall", id: `newer-v1-${index}`, name: "fixture-tool", arguments: {} });
		messages.push(result(`newer-v1-${index}`, "fixture-tool", "small"));
	}
	messages.unshift(assistant(calls));
	const fixture = await createModeFixture(messages, [], { enabled: true, budgetTokens: 128 });
	t.after(fixture.dispose);
	fixture.mode.renderInitialMessages();
	const components = fixture.internals.chatContainer.children.filter(
		(child): child is ToolExecutionComponent => child instanceof ToolExecutionComponent,
	);
	assert.equal(components.length, 129);
	assert.ok(components[0]!.getToolResultPresentationDiscovery("older-v2"));
	assert.deepEqual(
		fixture.internals.getToolResultDiscoveryLifecycleCounts(),
		{
			entries: 1,
			attached: 1,
			pending: 0,
			registrationObjectsCreated: 1,
			registrationsAttached: 1,
			registrationsHighWaterMark: 1,
			registrationsEvicted: 0,
			registrationsTeardownReleased: 0,
			historyMessagesVisited: 130,
			presentationCandidatesEvaluated: 129,
			actualV2Discoveries: 1,
			canonicalLookupProbes: 130,
			sourceScans: 129,
		},
	);
});

test("foreign-session canonical wrappers are rejected", async (t) => {
	const firstMessage = result("foreign-id", "fixture-tool", "first-".repeat(1_000)) as ToolResultMessage;
	const secondMessage = result("foreign-id", "fixture-tool", "second-".repeat(1_000)) as ToolResultMessage;
	const first = await createModeFixture([firstMessage], [], { enabled: true, budgetTokens: 128 });
	const second = await createModeFixture([secondMessage], [], { enabled: true, budgetTokens: 128 });
	t.after(first.dispose);
	t.after(second.dispose);
	const foreignCanonical = second.session.agent.state.messages[0];
	assert.ok(foreignCanonical?.role === "toolResult");
	assert.equal(first.session.getToolResultPresentationForUi(foreignCanonical), undefined);
});

test("50,000 mixed history rebuild selection remains one bounded reverse scan", async (t) => {
	const messages: AgentMessage[] = [];
	for (let index = 0; index < 50_000; index++) {
		messages.push(result(
			`mixed-${index}`,
			"fixture-tool",
			index % 390 === 0 ? `large-${index}-`.repeat(1_000) : "small",
		));
	}
	const fixture = await createModeFixture(messages, [], { enabled: true, budgetTokens: 128 });
	t.after(fixture.dispose);
	const selected = new Map<ToolResultMessage, ToolResultPresentation>();
	fixture.session.collectRecentToolResultPresentationsForUi(selected, 128);
	const counts = fixture.session.getToolResultPresentationUiRebuildCounts();
	assert.equal(selected.size, 128);
	assert.equal(counts.actualV2Discoveries, 128);
	assert.ok(counts.historyMessagesVisited <= 50_000);
	assert.ok(counts.presentationCandidatesEvaluated <= counts.historyMessagesVisited);
	assert.equal(counts.canonicalLookupProbes, 50_000);
	assert.equal(counts.sourceScans, counts.presentationCandidatesEvaluated);
	assert.ok(counts.historyMessagesVisited + counts.canonicalLookupProbes <= 100_000);
	selected.clear();
});

test("ambiguous ToolResult ids do not consume the last 128 actual V2 discoveries", async (t) => {
	const messages: AgentMessage[] = [];
	for (let index = 0; index < 129; index++) {
		messages.push(result(`unique-v2-${index}`, "fixture-tool", `large-${index}-`.repeat(1_000)));
	}
	messages.push(result("ambiguous-v2", "fixture-tool", "first-duplicate-".repeat(1_000)));
	messages.push(result("ambiguous-v2", "fixture-tool", "second-duplicate-".repeat(1_000)));
	const fixture = await createModeFixture(messages, [], { enabled: true, budgetTokens: 128 });
	t.after(fixture.dispose);
	const selected = new Map<ToolResultMessage, ToolResultPresentation>();
	fixture.session.collectRecentToolResultPresentationsForUi(selected, 128);
	assert.equal(selected.size, 128);
	assert.equal([...selected.keys()].some((message) => message.toolCallId === "ambiguous-v2"), false);
	assert.equal([...selected.keys()].some((message) => message.toolCallId === "unique-v2-0"), false);
	assert.equal([...selected.keys()].some((message) => message.toolCallId === "unique-v2-128"), true);
	const counts = fixture.session.getToolResultPresentationUiRebuildCounts();
	assert.equal(counts.actualV2Discoveries, 128);
	assert.equal(counts.historyMessagesVisited, 131);
	assert.equal(counts.canonicalLookupProbes, 131);
	selected.clear();
});

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
