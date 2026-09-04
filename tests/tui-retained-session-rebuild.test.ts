import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	getCapabilities,
	Image,
	setCapabilities,
	Text,
	TuiMainScreen,
	type TuiRenderInstrumentation,
} from "@super-pi/tui";
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
	createToolResultPresentationCounters,
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
	toolResultDiscoveries?: Map<string, {
		component: ToolExecutionComponent | ReadToolGroupComponent;
		identity: string | undefined;
	}>;
	pendingToolResultDiscoveries?: Map<string, {
		component: ToolExecutionComponent | ReadToolGroupComponent;
		identity: string | undefined;
	}>;
	attachedToolResultDiscoveries?: Map<string, {
		component: ToolExecutionComponent | ReadToolGroupComponent;
		identity: string | undefined;
	}>;
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
		actualV2Discoveries?: number;
		liveCanonicalIndexBuildProbes?: number;
		liveCanonicalIndexAppendProbes?: number;
		liveCanonicalLookupProbes?: number;
		liveCanonicalIndexRebuilds?: number;
		liveCanonicalIndexEntries?: number;
		liveCanonicalIndexOverflowed?: boolean;
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

function attachedToolResultDiscoveries(
	internals: InteractiveModeInternals,
): InteractiveModeInternals["attachedToolResultDiscoveries"] {
	return internals.attachedToolResultDiscoveries ?? internals.toolResultDiscoveries;
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
	settingsManager: SettingsManager;
	dispose(): void;
}

async function createModeFixture(
	messages: readonly AgentMessage[],
	customTools: readonly ToolDefinition[] = [],
	toolResultPresentation?: ToolResultPresentationOptions,
	extensionFactories: Array<(pi: any) => void> = [],
	settingsToolResultPresentation = toolResultPresentation,
): Promise<ModeFixture> {
	initTheme("dark");
	const root = mkdtempSync(join(tmpdir(), "super-pi-retained-rebuild-"));
	const cwd = join(root, "workspace");
	const agentDir = join(root, "agent");
	mkdirSync(cwd, { recursive: true });
	mkdirSync(agentDir, { recursive: true });
	const settingsManager = settingsToolResultPresentation
		? SettingsManager.inMemory({
			toolResultPresentation: {
				enabled: settingsToolResultPresentation.enabled,
				budgetTokens: settingsToolResultPresentation.budgetTokens,
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
		settingsManager,
		dispose: () => {
			renderer.stop({ preserveScreen: true });
			session.dispose();
			rmSync(root, { recursive: true, force: true });
		},
	};
}

test("rebuilt grouped bounded reads use current image settings", async (t) => {
	const previousCapabilities = getCapabilities();
	setCapabilities({ images: "iterm2", trueColor: true, hyperlinks: true });
	const toolCallId = "grouped-image-rebuild";
	const imageResult = {
		...(result(toolCallId, "read", "grouped-rebuild-text-".repeat(1_000)) as ToolResultMessage),
		content: [
			{ type: "text" as const, text: "grouped-rebuild-text-".repeat(1_000) },
			{ type: "image" as const, data: "QUJDREVGRw==", mimeType: "image/png" },
		],
	};
	const fixture = await createModeFixture(
		[
			assistant([{ type: "toolCall", id: toolCallId, name: "read", arguments: { path: "image.txt" } }]),
			imageResult,
		],
		[],
		{ enabled: true, budgetTokens: 128 },
	);
	t.after(() => {
		setCapabilities(previousCapabilities);
		fixture.dispose();
	});
	fixture.settingsManager.setShowImages(false);
	fixture.settingsManager.setImageWidthCells(19);
	fixture.mode.renderInitialMessages();
	const group = fixture.internals.chatContainer.children.find(
		(child): child is ReadToolGroupComponent => child instanceof ReadToolGroupComponent,
	);
	assert.ok(group);
	group.setExpanded(true);
	assert.equal(group.children.some((child) => child instanceof Image), false);
	assert.match(group.render(100).join("\n"), /grouped-rebuild-text/);
	assert.match(group.render(100).join("\n"), /Model received a bounded view/);
});

test("parallel live discovery attachment follows canonical message order", async (t) => {
	const runPermutation = async (completionOrder: readonly number[]): Promise<void> => {
		const fixture = await createModeFixture([], [], { enabled: true, budgetTokens: 128 });
		t.after(fixture.dispose);
		fixture.internals.isInitialized = true;
		const messages = new Array<ToolResultMessage>(128);
		for (let index = 0; index < 128; index++) {
			const toolCallId = `parallel-canonical-${index}`;
			messages[index] = result(toolCallId, "fixture-tool", `parallel-${index}-`.repeat(1_000)) as ToolResultMessage;
			await fixture.internals.handleEvent({ type: "tool_execution_start", toolCallId, toolName: "fixture-tool", args: {} });
		}
		for (const index of completionOrder) {
			const message = messages[index]!;
			await fixture.internals.handleEvent({
				type: "tool_execution_end",
				toolCallId: message.toolCallId,
				toolName: message.toolName,
				result: { content: message.content, isError: false },
				isError: false,
			});
		}
		for (const message of messages) {
			fixture.session.agent.state.messages.push(message);
			await emitToolResultMessageEnd(fixture, message);
		}
		assert.deepEqual(
			[...(fixture.internals.toolResultDiscoveries?.keys() ?? [])],
			messages.map((message) => message.toolCallId),
			"successful attachment must reorder the existing registration into canonical transcript order",
		);
		const oldestComponent = fixture.internals.toolResultDiscoveries?.get(messages[0]!.toolCallId)?.component;
		const newestComponent = fixture.internals.toolResultDiscoveries?.get(messages[127]!.toolCallId)?.component;
		assert.ok(oldestComponent);
		assert.ok(newestComponent);
		const newestDiscovery = newestComponent.getToolResultPresentationDiscovery(messages[127]!.toolCallId);
		assert.ok(newestDiscovery);
		const registrationObjectsBefore = fixture.internals.getToolResultDiscoveryLifecycleCounts().registrationObjectsCreated;
		const later = result("parallel-canonical-later", "fixture-tool", "parallel-later-".repeat(1_000)) as ToolResultMessage;
		await fixture.internals.handleEvent({ type: "tool_execution_start", toolCallId: later.toolCallId, toolName: later.toolName, args: {} });
		await fixture.internals.handleEvent({
			type: "tool_execution_end",
			toolCallId: later.toolCallId,
			toolName: later.toolName,
			result: { content: later.content, isError: false },
			isError: false,
		});
		fixture.session.agent.state.messages.push(later);
		await emitToolResultMessageEnd(fixture, later);
		assert.equal(oldestComponent.getToolResultPresentationDiscovery(messages[0]!.toolCallId), undefined);
		assert.ok(newestComponent.getToolResultPresentationDiscovery(messages[127]!.toolCallId));
		assert.deepEqual(
			[...(fixture.internals.toolResultDiscoveries?.keys() ?? [])],
			[...messages.slice(1).map((message) => message.toolCallId), later.toolCallId],
		);
		const lifecycle = fixture.internals.getToolResultDiscoveryLifecycleCounts();
		assert.equal(lifecycle.registrationObjectsCreated, registrationObjectsBefore! + 1);
		assert.equal(lifecycle.registrationsEvicted, 1);
		const chunk = fixture.session.readToolResultContinuation(newestDiscovery.cursor, 128);
		assert.ok(chunk.content.length > 0);
	};

	await runPermutation(Array.from({ length: 128 }, (_, index) => 127 - index));
	const alternating: number[] = [];
	for (let index = 0; index < 64; index++) {
		alternating.push(64 + index, index);
	}
	await runPermutation(alternating);
});

test("129 pending parallel V2 results do not evict before canonical attachment", async (t) => {
	const fixture = await createModeFixture([], [], { enabled: true, budgetTokens: 128 });
	t.after(fixture.dispose);
	fixture.internals.isInitialized = true;
	const calls: AssistantMessage["content"] = [];
	const messages = new Array<ToolResultMessage>(129);
	for (let index = 0; index < messages.length; index++) {
		const toolCallId = `pending-parallel-v2-${index}`;
		calls.push({ type: "toolCall", id: toolCallId, name: "fixture-tool", arguments: {} });
		messages[index] = result(toolCallId, "fixture-tool", `pending-parallel-${index}-`.repeat(1_000)) as ToolResultMessage;
		await fixture.internals.handleEvent({ type: "tool_execution_start", toolCallId, toolName: "fixture-tool", args: {} });
	}
	const assistantMessage = assistant(calls);
	fixture.session.agent.state.messages.push(assistantMessage);
	fixture.sessionManager.appendMessage(assistantMessage);
	const before = fixture.internals.getToolResultDiscoveryLifecycleCounts();
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index]!;
		await fixture.internals.handleEvent({
			type: "tool_execution_end",
			toolCallId: message.toolCallId,
			toolName: message.toolName,
			result: { content: message.content, isError: false },
			isError: false,
		});
	}
	const pending = fixture.internals.getToolResultDiscoveryLifecycleCounts();
	assert.equal(pending.pending, 129);
	assert.equal(pending.attached, 0);
	assert.equal(pending.registrationsEvicted, before.registrationsEvicted);

	for (const message of messages) {
		fixture.session.agent.state.messages.push(message);
		await emitToolResultMessageEnd(fixture, message);
	}
	const attached = fixture.internals.getToolResultDiscoveryLifecycleCounts();
	assert.equal(attached.pending, 0);
	assert.equal(attached.attached, 128);
	assert.equal(attached.registrationsEvicted, (before.registrationsEvicted ?? 0) + 1);
	const entries = attachedToolResultDiscoveries(fixture.internals);
	assert.deepEqual(
		[...(entries?.keys() ?? [])],
		messages.slice(1).map((message) => message.toolCallId),
	);
	assert.equal(entries?.has(messages[0]!.toolCallId), false);
	const oldestRetained = entries?.get(messages[1]!.toolCallId)?.component;
	const newestRetained = entries?.get(messages[128]!.toolCallId)?.component;
	assert.ok(oldestRetained);
	assert.ok(newestRetained);
	for (const [component, message] of [[oldestRetained, messages[1]], [newestRetained, messages[128]]] as const) {
		const discovery = component.getToolResultPresentationDiscovery(message!.toolCallId);
		assert.ok(discovery);
		assert.equal(fixture.session.readToolResultArtifact(discovery.artifactId).content, message!.content);
		assert.ok(fixture.session.readToolResultContinuation(discovery.cursor, 128).content.length > 0);
	}

	fixture.internals.rebuildChatFromMessages();
	assert.deepEqual(
		[...(attachedToolResultDiscoveries(fixture.internals)?.keys() ?? [])],
		messages.slice(1).map((message) => message.toolCallId),
		"live and rebuild latest-128 sets must match canonical transcript order",
	);
});

test("pending V1 results do not consume an attached V2 discovery slot", async (t) => {
	const fixture = await createModeFixture([], [], { enabled: true, budgetTokens: 128 });
	t.after(fixture.dispose);
	fixture.internals.isInitialized = true;
	const attachedMessages = new Array<ToolResultMessage>(128);
	for (let index = 0; index < attachedMessages.length; index++) {
		const toolCallId = `attached-before-v1-${index}`;
		const message = result(toolCallId, "fixture-tool", `attached-before-v1-${index}-`.repeat(1_000)) as ToolResultMessage;
		attachedMessages[index] = message;
		await fixture.internals.handleEvent({ type: "tool_execution_start", toolCallId, toolName: message.toolName, args: {} });
		await fixture.internals.handleEvent({
			type: "tool_execution_end",
			toolCallId,
			toolName: message.toolName,
			result: { content: message.content, isError: false },
			isError: false,
		});
		fixture.session.agent.state.messages.push(message);
		await emitToolResultMessageEnd(fixture, message);
	}
	const expectedOrder = attachedMessages.map((message) => message.toolCallId);
	const before = fixture.internals.getToolResultDiscoveryLifecycleCounts();
	assert.equal(before.attached, 128);
	assert.deepEqual([...(attachedToolResultDiscoveries(fixture.internals)?.keys() ?? [])], expectedOrder);

	const smallMessages = new Array<ToolResultMessage>(256);
	for (let index = 0; index < smallMessages.length; index++) {
		const toolCallId = `pending-v1-${index}`;
		const message = result(toolCallId, "fixture-tool", index % 2 === 0 ? "small" : "small error") as ToolResultMessage;
		message.isError = index % 2 !== 0;
		smallMessages[index] = message;
		await fixture.internals.handleEvent({ type: "tool_execution_start", toolCallId, toolName: message.toolName, args: {} });
		await fixture.internals.handleEvent({
			type: "tool_execution_end",
			toolCallId,
			toolName: message.toolName,
			result: { content: message.content, isError: message.isError },
			isError: message.isError,
		});
	}
	const pending = fixture.internals.getToolResultDiscoveryLifecycleCounts();
	assert.equal(pending.pending, 256);
	assert.equal(pending.attached, 128);
	assert.equal(pending.registrationsEvicted, before.registrationsEvicted);
	assert.deepEqual([...(attachedToolResultDiscoveries(fixture.internals)?.keys() ?? [])], expectedOrder);

	for (const message of smallMessages) {
		fixture.session.agent.state.messages.push(message);
		await emitToolResultMessageEnd(fixture, message);
	}
	const after = fixture.internals.getToolResultDiscoveryLifecycleCounts();
	assert.equal(after.pending, 0);
	assert.equal(after.attached, 128);
	assert.equal(after.registrationsEvicted, before.registrationsEvicted);
	assert.deepEqual([...(attachedToolResultDiscoveries(fixture.internals)?.keys() ?? [])], expectedOrder);
	for (const message of [attachedMessages[0]!, attachedMessages[127]!]) {
		const component = attachedToolResultDiscoveries(fixture.internals)?.get(message.toolCallId)?.component;
		const discovery = component?.getToolResultPresentationDiscovery(message.toolCallId);
		assert.ok(discovery);
		assert.equal(fixture.session.readToolResultArtifact(discovery.artifactId).content, message.content);
		assert.ok(fixture.session.readToolResultContinuation(discovery.cursor, 128).content.length > 0);
	}
});

test("initial UI rebuild skips malformed historical presentation candidates", async (t) => {
	const malformedContents: unknown[] = [
		"not-an-array",
		[null],
		[1, "block"],
		[{ type: "text" }],
		[{ type: "text", text: 1 }],
		[{ type: "image", mimeType: "image/png" }],
		[{ type: "image", data: "AA==" }],
		[{ type: "image", data: 1, mimeType: false }],
		[{ type: "unknown", text: "nope" }],
		[{ type: "text", text: "valid-prefix" }, { type: "image", data: "AA==" }],
	];
	const calls: AssistantMessage["content"] = [];
	const messages: AgentMessage[] = [];
	for (let index = 0; index < malformedContents.length; index++) {
		const toolCallId = `malformed-history-${index}`;
		messages.push({
			role: "toolResult",
			toolCallId,
			toolName: "fixture-tool",
			content: malformedContents[index],
			isError: false,
			timestamp: index + 2,
		} as unknown as AgentMessage);
	}
	for (let index = 0; index < 129; index++) {
		const toolCallId = `malformed-boundary-v1-${index}`;
		calls.push({ type: "toolCall", id: toolCallId, name: "fixture-tool", arguments: {} });
		messages.push(result(toolCallId, "fixture-tool", "small"));
	}
	const validToolCallId = "malformed-control-v2";
	calls.push({ type: "toolCall", id: validToolCallId, name: "fixture-tool", arguments: {} });
	messages.push(result(validToolCallId, "fixture-tool", "valid-control-".repeat(1_000)));
	messages.unshift(assistant(calls));
	const fixture = await createModeFixture(messages, [], { enabled: true, budgetTokens: 128 });
	t.after(fixture.dispose);
	assert.doesNotThrow(() => fixture.mode.renderInitialMessages());
	const lifecycle = fixture.internals.getToolResultDiscoveryLifecycleCounts();
	assert.equal(lifecycle.entries, 1);
	assert.equal(lifecycle.attached, 1);
	assert.equal(lifecycle.actualV2Discoveries, 1);
	const groups = fixture.internals.chatContainer.children.filter(
		(child): child is ToolExecutionComponent => child instanceof ToolExecutionComponent,
	);
	const control = groups.find((component) => component.getToolResultPresentationDiscovery(validToolCallId) !== undefined);
	assert.ok(control);
	for (let index = 0; index < malformedContents.length; index++) {
		assert.equal(
			groups.some((component) => component.getToolResultPresentationDiscovery(`malformed-history-${index}`) !== undefined),
			false,
		);
	}
});

async function emitToolResultMessageEnd(
	fixture: ModeFixture,
	message: ToolResultMessage,
	observe?: (event: Extract<AgentSessionEvent, { type: "message_end" }>) => void,
): Promise<void> {
	const unsubscribe = fixture.session.subscribe((event) => {
		if (event.type === "message_end") observe?.(event);
		return fixture.internals.handleEvent(event);
	});
	try {
		await (fixture.session as unknown as {
			_handleAgentEvent(event: { type: "message_end"; message: ToolResultMessage }): Promise<void>;
		})._handleAgentEvent({ type: "message_end", message });
	} finally {
		unsubscribe();
	}
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
		result: { content: message.content, isError: message.isError },
		isError: false,
	});
	assert.doesNotMatch(fixture.internals.chatContainer.render(80).join("\n"), /Model received a bounded view/);
	fixture.session.agent.state.messages.push(message);
	await emitToolResultMessageEnd(fixture, message);
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
		result: { content: message.content, isError: message.isError },
		isError: false,
	});
	let emittedPresentation: Extract<AgentSessionEvent, { type: "message_end" }>["toolResultPresentation"];
	await emitToolResultMessageEnd(fixture, message, (event) => {
		if (event.message.role === "toolResult") emittedPresentation = event.toolResultPresentation;
	});
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
	const toolCallId = "reused-live-id";
	const driveResult = async (message: ToolResultMessage): Promise<ToolExecutionComponent> => {
		await fixture.internals.handleEvent({ type: "tool_execution_start", toolCallId, toolName: "fixture-tool", args: {} });
		const component = fixture.internals.pendingTools.get(toolCallId);
		assert.ok(component instanceof ToolExecutionComponent);
		await fixture.internals.handleEvent({
			type: "tool_execution_end",
			toolCallId,
			toolName: "fixture-tool",
			result: { content: message.content, isError: message.isError },
			isError: false,
		});
		return component;
	};
	const oldMessage = result(toolCallId, "fixture-tool", "old-".repeat(1_000)) as ToolResultMessage;
	const oldComponent = await driveResult(oldMessage);
	fixture.internals.clearToolResultDiscoveries();
	const currentMessage = result(toolCallId, "fixture-tool", "current-".repeat(1_000)) as ToolResultMessage;
	const currentComponent = await driveResult(currentMessage);
	fixture.session.agent.state.messages.push(currentMessage);
	await emitToolResultMessageEnd(fixture, oldMessage);
	assert.equal(currentComponent.getToolResultPresentationDiscovery(toolCallId), undefined);
	await emitToolResultMessageEnd(fixture, currentMessage);
	assert.ok(currentComponent.getToolResultPresentationDiscovery(toolCallId));
	assert.equal(oldComponent.getToolResultPresentationDiscovery(toolCallId), undefined);

	const duplicateMessage = result(toolCallId, "fixture-tool", "duplicate-".repeat(1_000)) as ToolResultMessage;
	const duplicateComponent = await driveResult(duplicateMessage);
	fixture.session.agent.state.messages.push(duplicateMessage);
	await emitToolResultMessageEnd(fixture, duplicateMessage);
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
		result: { content: message.content, isError: message.isError },
		isError: false,
	});
	fixture.session.agent.state.messages.push(message);
	await emitToolResultMessageEnd(fixture, message);
	const counts = fixture.internals.getToolResultDiscoveryLifecycleCounts();
	assert.equal(counts.entries, 0);
	assert.equal(counts.pending, 0);
	assert.equal(counts.attached, 0);
});

test("a live V1 occurrence makes a later reused V2 identity fail closed", async (t) => {
	const fixture = await createModeFixture([], [], { enabled: true, budgetTokens: 128 });
	t.after(fixture.dispose);
	fixture.internals.isInitialized = true;
	const toolCallId = "live-v1-then-v2-reuse";
	const driveResult = async (message: ToolResultMessage): Promise<ToolExecutionComponent> => {
		await fixture.internals.handleEvent({ type: "tool_execution_start", toolCallId, toolName: "fixture-tool", args: {} });
		const component = fixture.internals.pendingTools.get(toolCallId);
		assert.ok(component instanceof ToolExecutionComponent);
		await fixture.internals.handleEvent({
			type: "tool_execution_end",
			toolCallId,
			toolName: "fixture-tool",
			result: { content: message.content, isError: message.isError },
			isError: false,
		});
		fixture.session.agent.state.messages.push(message);
		await emitToolResultMessageEnd(fixture, message);
		return component;
	};
	const first = result(toolCallId, "fixture-tool", "small-v1") as ToolResultMessage;
	const firstComponent = await driveResult(first);
	assert.equal(firstComponent.getToolResultPresentationDiscovery(toolCallId), undefined);
	const second = result(toolCallId, "fixture-tool", "later-v2-".repeat(1_000)) as ToolResultMessage;
	const secondComponent = await driveResult(second);
	assert.equal(
		secondComponent.getToolResultPresentationDiscovery(toolCallId),
		undefined,
		"a duplicate active identity must not advertise unusable artifact/continuation controls",
	);
	const lifecycle = fixture.internals.getToolResultDiscoveryLifecycleCounts();
	assert.equal(lifecycle.entries, 0, "a rejected duplicate must release its pending registration immediately");
	assert.equal(lifecycle.pending, 0);
});

test("live canonical validation indexes resumed history once and performs one lookup per result", async (t) => {
	const messages: AgentMessage[] = [];
	for (let index = 0; index < 10_000; index++) {
		messages.push(result(`indexed-history-${index}`, "fixture-tool", "small"));
	}
	const fixture = await createModeFixture(messages, [], { enabled: true, budgetTokens: 128 });
	t.after(fixture.dispose);
	fixture.internals.isInitialized = true;
	for (let index = 0; index < 8; index++) {
		const toolCallId = `indexed-live-${index}`;
		await fixture.internals.handleEvent({
			type: "tool_execution_start",
			toolCallId,
			toolName: "fixture-tool",
			args: {},
		});
		const component = fixture.internals.pendingTools.get(toolCallId);
		assert.ok(component instanceof ToolExecutionComponent);
		const message = result(toolCallId, "fixture-tool", `indexed-live-${index}-`.repeat(1_000)) as ToolResultMessage;
		await fixture.internals.handleEvent({
			type: "tool_execution_end",
			toolCallId,
			toolName: "fixture-tool",
			result: { content: message.content, isError: message.isError },
			isError: false,
		});
		fixture.session.agent.state.messages.push(message);
		await emitToolResultMessageEnd(fixture, message);
		assert.ok(component.getToolResultPresentationDiscovery(toolCallId));
	}
	const lifecycle = fixture.internals.getToolResultDiscoveryLifecycleCounts();
	assert.equal(lifecycle.liveCanonicalIndexRebuilds, 1);
	assert.equal(lifecycle.liveCanonicalIndexBuildProbes, 10_000);
	assert.equal(lifecycle.liveCanonicalIndexAppendProbes, 8);
	assert.equal(lifecycle.liveCanonicalLookupProbes, 8);
	assert.equal(lifecycle.liveCanonicalIndexEntries, 10_008);
	assert.equal(lifecycle.liveCanonicalIndexOverflowed, false);
});

test("live canonical identity index fails closed at its hard metadata cap", async (t) => {
	const messages: AgentMessage[] = [];
	for (let index = 0; index < 65_536; index++) {
		messages.push(result(`capped-history-${index}`, "fixture-tool", "small"));
	}
	const fixture = await createModeFixture(messages, [], { enabled: true, budgetTokens: 128 });
	t.after(fixture.dispose);
	fixture.internals.isInitialized = true;
	const toolCallId = "capped-live-result";
	await fixture.internals.handleEvent({
		type: "tool_execution_start",
		toolCallId,
		toolName: "fixture-tool",
		args: {},
	});
	const component = fixture.internals.pendingTools.get(toolCallId);
	assert.ok(component instanceof ToolExecutionComponent);
	const message = result(toolCallId, "fixture-tool", "capped-live-".repeat(1_000)) as ToolResultMessage;
	await fixture.internals.handleEvent({
		type: "tool_execution_end",
		toolCallId,
		toolName: "fixture-tool",
		result: { content: message.content, isError: message.isError },
		isError: false,
	});
	fixture.session.agent.state.messages.push(message);
	await emitToolResultMessageEnd(fixture, message);
	const lifecycle = fixture.internals.getToolResultDiscoveryLifecycleCounts();
	assert.equal(component.getToolResultPresentationDiscovery(toolCallId), undefined);
	assert.equal(lifecycle.entries, 0);
	assert.equal(lifecycle.liveCanonicalIndexEntries, 65_536);
	assert.equal(lifecycle.liveCanonicalIndexOverflowed, true);
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
			sourceScans: 130,
			liveCanonicalIndexBuildProbes: 130,
			liveCanonicalIndexAppendProbes: 0,
			liveCanonicalLookupProbes: 0,
			liveCanonicalIndexRebuilds: 1,
			liveCanonicalIndexEntries: 129,
			liveCanonicalIndexOverflowed: false,
		},
	);
});

test("rebuild uses the shared owner override rather than an unrelated settings budget", async (t) => {
	const toolCallId = "override-budget-v2";
	const fixture = await createModeFixture(
		[
			assistant([{ type: "toolCall", id: toolCallId, name: "fixture-tool", arguments: {} }]),
			result(toolCallId, "fixture-tool", "override-budget-large-".repeat(300)),
		],
		[],
		{ enabled: true, budgetTokens: 128 },
		[],
		{ enabled: true, budgetTokens: 4_096 },
	);
	t.after(fixture.dispose);
	fixture.mode.renderInitialMessages();
	const component = fixture.internals.chatContainer.children.find(
		(child): child is ToolExecutionComponent => child instanceof ToolExecutionComponent,
	);
	assert.ok(component?.getToolResultPresentationDiscovery(toolCallId));
});

test("a newer V1 reuse makes an older V2 tool-call identity ambiguous", async (t) => {
	const duplicateId = "v1-v2-reuse";
	const fixture = await createModeFixture([
		result(duplicateId, "fixture-tool", "older-v2-".repeat(1_000)),
		result(duplicateId, "fixture-tool", "newer-v1"),
	], [], { enabled: true, budgetTokens: 128 });
	t.after(fixture.dispose);
	const selected = new Map<ToolResultMessage, ToolResultPresentation>();
	fixture.session.collectRecentToolResultPresentationsForUi(selected, 128);
	assert.equal(selected.size, 0);
});

test("128 ambiguous V2 ids do not consume the 128 actual-discovery quota", async (t) => {
	const messages: AgentMessage[] = [];
	for (let index = 0; index < 128; index++) {
		messages.push(result(`valid-before-ambiguity-${index}`, "fixture-tool", `valid-${index}-`.repeat(1_000)));
	}
	for (let index = 0; index < 128; index++) {
		const toolCallId = `ambiguous-quota-${index}`;
		messages.push(result(toolCallId, "fixture-tool", `duplicate-a-${index}-`.repeat(1_000)));
		messages.push(result(toolCallId, "fixture-tool", `duplicate-b-${index}-`.repeat(1_000)));
	}
	const fixture = await createModeFixture(messages, [], { enabled: true, budgetTokens: 128 });
	t.after(fixture.dispose);
	const selected = new Map<ToolResultMessage, ToolResultPresentation>();
	fixture.session.collectRecentToolResultPresentationsForUi(selected, 128);
	assert.equal(selected.size, 128);
	assert.equal([...selected.keys()].every((message) => message.toolCallId.startsWith("valid-before-ambiguity-")), true);
});

test("the final 128 rebuild discoveries remain resident after evaluating 256 candidates", async (t) => {
	const counters = createToolResultPresentationCounters();
	const messages: AgentMessage[] = [];
	for (let index = 0; index < 256; index++) {
		messages.push(result(`resident-rebuild-${index}`, "fixture-tool", `resident-${index}-`.repeat(1_000)));
	}
	const fixture = await createModeFixture(messages, [], { enabled: true, budgetTokens: 128, counters });
	t.after(fixture.dispose);
	const selected = new Map<ToolResultMessage, ToolResultPresentation>();
	fixture.session.collectRecentToolResultPresentationsForUi(selected, 128);
	assert.equal(selected.size, 128);
	const [canonical, presentation] = selected.entries().next().value!;
	assert.equal(presentation.version, 2);
	const scansBeforeRead = counters.fullSourceEstimatorScans;
	const recordHitsBeforeRead = counters.activeContinuationRecordHits;
	const chunk = fixture.session.readToolResultContinuation(presentation.continuation.cursor, 128);
	assert.ok(chunk.content.length > 0);
	assert.equal(
		counters.fullSourceEstimatorScans,
		scansBeforeRead,
		"advertised rebuild discovery must not require a new full-source scan",
	);
	assert.equal(counters.activeContinuationRecordHits, recordHitsBeforeRead + 1);
	assert.equal(canonical.toolCallId.startsWith("resident-rebuild-"), true);
});

test("UI-only rebuild preserves unrelated shared projection records", async (t) => {
	const counters = createToolResultPresentationCounters();
	const small = result("shared-provider-v1", "fixture-tool", "small") as ToolResultMessage;
	const large = result(
		"shared-ui-v2",
		"fixture-tool",
		"shared-ui-discovery-".repeat(1_000),
	) as ToolResultMessage;
	const fixture = await createModeFixture(
		[small, large],
		[],
		{ enabled: true, budgetTokens: 128, counters },
	);
	t.after(fixture.dispose);

	const canonicalSmall = fixture.session.agent.state.messages[0];
	assert.ok(canonicalSmall?.role === "toolResult");
	assert.equal(fixture.session.getToolResultPresentationForUi(canonicalSmall)?.version, 1);
	await fixture.session.agent.convertToLlm(fixture.session.agent.state.messages.slice());
	const scansAfterSharedAdmission = counters.fullSourceEstimatorScans;

	const selected = new Map<ToolResultMessage, ToolResultPresentation>();
	fixture.session.collectRecentToolResultPresentationsForUi(selected, 128);
	assert.equal(selected.size, 1);
	assert.equal([...selected.keys()][0]?.toolCallId, large.toolCallId);
	assert.equal(fixture.session.getToolResultPresentationForUi(canonicalSmall)?.version, 1);
	await fixture.session.agent.convertToLlm(fixture.session.agent.state.messages.slice());
	assert.equal(
		counters.fullSourceEstimatorScans,
		scansAfterSharedAdmission + 1,
		"the rebuild may scan the new V2 candidate once but must preserve the unrelated shared V1 record",
	);
	const entriesAfterFirstRebuild = counters.projectionRecordEntries;
	const retainedAfterFirstRebuild = counters.retainedProjectionCodeUnits;
	const evictionsAfterFirstRebuild = counters.projectionRecordEvictions;
	const scansAfterFirstRebuild = counters.fullSourceEstimatorScans;
	fixture.session.collectRecentToolResultPresentationsForUi(selected, 128);
	assert.equal(selected.size, 1);
	assert.equal(counters.fullSourceEstimatorScans, scansAfterFirstRebuild);
	assert.equal(counters.projectionRecordEntries, entriesAfterFirstRebuild);
	assert.equal(counters.retainedProjectionCodeUnits, retainedAfterFirstRebuild);
	assert.equal(counters.projectionRecordEvictions, evictionsAfterFirstRebuild);
});

test("UI candidate inspection does not evict a hot resident across an all-V1 history", async (t) => {
	const counters = createToolResultPresentationCounters();
	const messages: AgentMessage[] = [];
	for (let index = 0; index < 128; index++) {
		messages.push(result(`inspection-v1-${index}`, "fixture-tool", `small-${index}`));
	}
	const hot = result("inspection-hot-v1", "fixture-tool", "hot-small") as ToolResultMessage;
	messages.push(hot);
	const fixture = await createModeFixture(messages, [], { enabled: true, budgetTokens: 128, counters });
	t.after(fixture.dispose);

	const canonicalHot = fixture.session.agent.state.messages.at(-1);
	assert.ok(canonicalHot?.role === "toolResult");
	assert.equal(fixture.session.getToolResultPresentationForUi(canonicalHot)?.version, 1);
	const entriesBefore = counters.projectionRecordEntries;
	const evictionsBefore = counters.projectionRecordEvictions;
	const retainedBefore = counters.retainedProjectionCodeUnits;

	const selected = new Map<ToolResultMessage, ToolResultPresentation>();
	fixture.session.collectRecentToolResultPresentationsForUi(selected, 128);
	assert.equal(selected.size, 0);
	assert.equal(counters.projectionRecordEntries, entriesBefore, "non-selected V1 inspection must not become resident");
	assert.equal(counters.projectionRecordEvictions, evictionsBefore, "all-V1 inspection must not evict the hot record");
	assert.equal(counters.retainedProjectionCodeUnits, retainedBefore);

	const scansBeforeProvider = counters.fullSourceEstimatorScans;
	const hitsBeforeProvider = counters.residentReadHits;
	await fixture.session.agent.convertToLlm([canonicalHot]);
	assert.equal(counters.fullSourceEstimatorScans, scansBeforeProvider);
	assert.equal(counters.residentReadHits, hitsBeforeProvider + 1);
});

test("UI candidate inspection admits only one selected V2 beside an unrelated hot V1", async (t) => {
	const counters = createToolResultPresentationCounters();
	const selectedV2 = result(
		"inspection-selected-v2",
		"fixture-tool",
		"selected-discovery-".repeat(1_000),
	) as ToolResultMessage;
	const messages: AgentMessage[] = [selectedV2];
	for (let index = 0; index < 128; index++) {
		messages.push(result(`inspection-rejected-v1-${index}`, "fixture-tool", `small-${index}`));
	}
	const hot = result("inspection-mixed-hot-v1", "fixture-tool", "hot-small") as ToolResultMessage;
	messages.push(hot);
	const fixture = await createModeFixture(messages, [], { enabled: true, budgetTokens: 128, counters });
	t.after(fixture.dispose);

	const canonicalHot = fixture.session.agent.state.messages.at(-1);
	assert.ok(canonicalHot?.role === "toolResult");
	assert.equal(fixture.session.getToolResultPresentationForUi(canonicalHot)?.version, 1);
	const entriesBefore = counters.projectionRecordEntries;
	const evictionsBefore = counters.projectionRecordEvictions;

	const selected = new Map<ToolResultMessage, ToolResultPresentation>();
	fixture.session.collectRecentToolResultPresentationsForUi(selected, 128);
	assert.equal(selected.size, 1);
	assert.equal([...selected.keys()][0]?.toolCallId, selectedV2.toolCallId);
	assert.equal(counters.projectionRecordEntries, entriesBefore + 1, "only the selected V2 may be admitted");
	assert.equal(counters.projectionRecordEvictions, evictionsBefore);

	const scansBeforeProvider = counters.fullSourceEstimatorScans;
	const hitsBeforeProvider = counters.residentReadHits;
	await fixture.session.agent.convertToLlm([canonicalHot]);
	assert.equal(counters.fullSourceEstimatorScans, scansBeforeProvider);
	assert.equal(counters.residentReadHits, hitsBeforeProvider + 1);
});

test("discarded duplicate, ambiguous, and backup UI candidates never enter the shared resident cache", async (t) => {
	const duplicateV1Counters = createToolResultPresentationCounters();
	const duplicateV1Hot = result("inspection-duplicate-v1-hot", "fixture-tool", "hot") as ToolResultMessage;
	const duplicateV1Fixture = await createModeFixture(
		[
			duplicateV1Hot,
			result("inspection-duplicate-v1", "fixture-tool", "first-small"),
			result("inspection-duplicate-v1", "fixture-tool", "second-small"),
		],
		[],
		{ enabled: true, budgetTokens: 128, counters: duplicateV1Counters },
	);
	t.after(duplicateV1Fixture.dispose);
	assert.equal(duplicateV1Fixture.session.getToolResultPresentationForUi(duplicateV1Hot)?.version, 1);
	const duplicateV1Entries = duplicateV1Counters.projectionRecordEntries;
	const duplicateV1Evictions = duplicateV1Counters.projectionRecordEvictions;
	const duplicateV1Retained = duplicateV1Counters.retainedProjectionCodeUnits;
	const selected = new Map<ToolResultMessage, ToolResultPresentation>();
	duplicateV1Fixture.session.collectRecentToolResultPresentationsForUi(selected, 128);
	assert.equal(selected.size, 0);
	assert.equal(duplicateV1Counters.projectionRecordEntries, duplicateV1Entries);
	assert.equal(duplicateV1Counters.projectionRecordEvictions, duplicateV1Evictions);
	assert.equal(duplicateV1Counters.retainedProjectionCodeUnits, duplicateV1Retained);

	const ambiguousCounters = createToolResultPresentationCounters();
	const ambiguousHot = result("inspection-ambiguous-hot", "fixture-tool", "hot") as ToolResultMessage;
	const ambiguousFixture = await createModeFixture(
		[
			ambiguousHot,
			result("inspection-ambiguous-v2", "fixture-tool", "ambiguous-first-".repeat(1_000)),
			result("inspection-ambiguous-v2", "fixture-tool", "ambiguous-second-".repeat(1_000)),
		],
		[],
		{ enabled: true, budgetTokens: 128, counters: ambiguousCounters },
	);
	t.after(ambiguousFixture.dispose);
	assert.equal(ambiguousFixture.session.getToolResultPresentationForUi(ambiguousHot)?.version, 1);
	const ambiguousEntries = ambiguousCounters.projectionRecordEntries;
	const ambiguousEvictions = ambiguousCounters.projectionRecordEvictions;
	const ambiguousRetained = ambiguousCounters.retainedProjectionCodeUnits;
	ambiguousFixture.session.collectRecentToolResultPresentationsForUi(selected, 128);
	assert.equal(selected.size, 0);
	assert.equal(ambiguousCounters.projectionRecordEntries, ambiguousEntries);
	assert.equal(ambiguousCounters.projectionRecordEvictions, ambiguousEvictions);
	assert.equal(ambiguousCounters.retainedProjectionCodeUnits, ambiguousRetained);

	const backupCounters = createToolResultPresentationCounters();
	const backupHot = result("inspection-backup-hot", "fixture-tool", "hot") as ToolResultMessage;
	const backupFixture = await createModeFixture(
		[
			backupHot,
			result("inspection-backup-v2", "fixture-tool", "backup-discarded-".repeat(1_000)),
			result("inspection-final-v2", "fixture-tool", "selected-newest-".repeat(1_000)),
		],
		[],
		{ enabled: true, budgetTokens: 128, counters: backupCounters },
	);
	t.after(backupFixture.dispose);
	assert.equal(backupFixture.session.getToolResultPresentationForUi(backupHot)?.version, 1);
	const backupEntries = backupCounters.projectionRecordEntries;
	const backupEvictions = backupCounters.projectionRecordEvictions;
	backupFixture.session.collectRecentToolResultPresentationsForUi(selected, 1);
	assert.equal(selected.size, 1);
	assert.equal([...selected.keys()][0]?.toolCallId, "inspection-final-v2");
	assert.equal(backupCounters.projectionRecordEntries, backupEntries + 1, "the discarded backup must stay transient");
	assert.equal(backupCounters.projectionRecordEvictions, backupEvictions);
});

test("UI rebind synchronizes setup-replaced history before the first live result", async (t) => {
	const fixture = await createModeFixture([], [], { enabled: true, budgetTokens: 128 });
	t.after(fixture.dispose);
	const setupMessages: AgentMessage[] = [];
	for (let index = 0; index < 64; index++) {
		setupMessages.push(result(`setup-replaced-${index}`, "fixture-tool", "small"));
	}
	fixture.session.agent.state.messages = setupMessages;

	const beforeRebind = fixture.session.getToolResultPresentationUiRebuildCounts();
	fixture.mode.renderInitialMessages();
	const afterRebind = fixture.session.getToolResultPresentationUiRebuildCounts();
	assert.equal(
		afterRebind.liveCanonicalIndexBuildProbes - beforeRebind.liveCanonicalIndexBuildProbes,
		setupMessages.length,
		"the setup replacement must be indexed by the UI rebind rather than the first live message_end",
	);
	assert.equal(afterRebind.liveCanonicalIndexEntries, setupMessages.length);
	fixture.mode.renderInitialMessages();
	const afterRepeatedRebind = fixture.session.getToolResultPresentationUiRebuildCounts();
	assert.equal(afterRepeatedRebind.liveCanonicalIndexBuildProbes, afterRebind.liveCanonicalIndexBuildProbes);
	assert.equal(afterRepeatedRebind.liveCanonicalIndexRebuilds, afterRebind.liveCanonicalIndexRebuilds);

	fixture.internals.isInitialized = true;
	const liveToolCallId = "after-setup-live";
	await fixture.internals.handleEvent({
		type: "tool_execution_start",
		toolCallId: liveToolCallId,
		toolName: "fixture-tool",
		args: {},
	});
	const liveMessage = result(
		liveToolCallId,
		"fixture-tool",
		"after-setup-live-".repeat(1_000),
	) as ToolResultMessage;
	await fixture.internals.handleEvent({
		type: "tool_execution_end",
		toolCallId: liveToolCallId,
		toolName: "fixture-tool",
		result: { content: liveMessage.content, isError: liveMessage.isError },
		isError: false,
	});
	fixture.session.agent.state.messages.push(liveMessage);
	await emitToolResultMessageEnd(fixture, liveMessage);
	const afterLive = fixture.session.getToolResultPresentationUiRebuildCounts();
	assert.equal(afterLive.liveCanonicalIndexBuildProbes, afterRepeatedRebind.liveCanonicalIndexBuildProbes);
	assert.equal(afterLive.liveCanonicalIndexAppendProbes - afterRepeatedRebind.liveCanonicalIndexAppendProbes, 1);
	assert.equal(afterLive.liveCanonicalLookupProbes - afterRepeatedRebind.liveCanonicalLookupProbes, 1);
});

test("rebuild re-admission order stays aligned with chronological UI eviction", async (t) => {
	const counters = createToolResultPresentationCounters();
	const calls: AssistantMessage["content"] = [];
	const messages: AgentMessage[] = [];
	for (let index = 0; index < 128; index++) {
		const toolCallId = `chronological-rebuild-${index}`;
		calls.push({ type: "toolCall", id: toolCallId, name: "fixture-tool", arguments: {} });
		messages.push(result(toolCallId, "fixture-tool", `chronological-${index}-`.repeat(1_000)));
	}
	messages.unshift(assistant(calls));
	const fixture = await createModeFixture(messages, [], { enabled: true, budgetTokens: 128, counters });
	t.after(fixture.dispose);
	fixture.internals.isInitialized = true;
	fixture.mode.renderInitialMessages();
	const newestComponent = fixture.internals.chatContainer.children.find(
		(child): child is ToolExecutionComponent =>
			child instanceof ToolExecutionComponent &&
			child.getToolResultPresentationDiscovery("chronological-rebuild-127") !== undefined,
	);
	assert.ok(newestComponent);
	const newestDiscovery = newestComponent.getToolResultPresentationDiscovery("chronological-rebuild-127");
	assert.ok(newestDiscovery);

	const liveToolCallId = "chronological-live";
	await fixture.internals.handleEvent({
		type: "tool_execution_start",
		toolCallId: liveToolCallId,
		toolName: "fixture-tool",
		args: {},
	});
	const liveMessage = result(liveToolCallId, "fixture-tool", "chronological-live-".repeat(1_000)) as ToolResultMessage;
	await fixture.internals.handleEvent({
		type: "tool_execution_end",
		toolCallId: liveToolCallId,
		toolName: "fixture-tool",
		result: { content: liveMessage.content, isError: liveMessage.isError },
		isError: false,
	});
	fixture.session.agent.state.messages.push(liveMessage);
	await emitToolResultMessageEnd(fixture, liveMessage);
	assert.ok(
		newestComponent.getToolResultPresentationDiscovery("chronological-rebuild-127"),
		"UI eviction must retain the newest rebuilt discovery",
	);
	const scansBeforeRead = counters.fullSourceEstimatorScans;
	const hitsBeforeRead = counters.activeContinuationRecordHits;
	const chunk = fixture.session.readToolResultContinuation(newestDiscovery.cursor, 128);
	assert.ok(chunk.content.length > 0);
	assert.equal(
		counters.fullSourceEstimatorScans,
		scansBeforeRead,
		"the newest advertised discovery must remain resident after the next live admission",
	);
	assert.equal(counters.activeContinuationRecordHits, hitsBeforeRead + 1);
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
	assert.equal(counts.sourceScans, counts.presentationCandidatesEvaluated + selected.size);
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
