import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	type Container,
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
	createTrackedToolComponent(
		toolName: string,
		toolCallId: string,
		args: unknown,
		placeholder?: Container,
		allowReadGrouping?: boolean,
		applyBoundary?: boolean,
	): ToolExecutionComponent | ReadToolGroupComponent;
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
		pendingEntries?: number;
		attachedEntries?: number;
		totalEntries?: number;
		pendingHighWaterMark?: number;
		attachedHighWaterMark?: number;
		totalHighWaterMark?: number;
		attachedCapacityEvictions?: number;
		ambiguityRemovals?: number;
		pendingCompletionReleases?: number;
		pendingTeardownReleases?: number;
		attachedTeardownReleases?: number;
		pendingMapsCreated?: number;
		attachedMapsCreated?: number;
		canonicalV1RetainedInvalidations?: number;
		canonicalHistoryResetReleases?: number;
		canonicalHistoryResetRegistrationReleases?: number;
		canonicalHistoryResetUniqueComponentRefreshes?: number;
		canonicalPayloadRefreshes?: number;
		canonicalPayloadRefreshSkips?: number;
		canonicalPayloadConservativeHandlerRefreshes?: number;
		canonicalPayloadReplacementRefreshes?: number;
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
			[...(attachedToolResultDiscoveries(fixture.internals)?.keys() ?? [])],
			messages.map((message) => message.toolCallId),
			"successful attachment must reorder the existing registration into canonical transcript order",
		);
		const oldestComponent = attachedToolResultDiscoveries(fixture.internals)?.get(messages[0]!.toolCallId)?.component;
		const newestComponent = attachedToolResultDiscoveries(fixture.internals)?.get(messages[127]!.toolCallId)?.component;
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
			[...(attachedToolResultDiscoveries(fixture.internals)?.keys() ?? [])],
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
	const runPermutation = async (label: string, completionOrder: readonly number[]): Promise<string[]> => {
		const fixture = await createModeFixture([], [], { enabled: true, budgetTokens: 128 });
		t.after(fixture.dispose);
		fixture.internals.isInitialized = true;
		const calls: AssistantMessage["content"] = [];
		const messages = new Array<ToolResultMessage>(129);
		for (let index = 0; index < messages.length; index++) {
			const toolCallId = `pending-parallel-${label}-${index}`;
			calls.push({ type: "toolCall", id: toolCallId, name: "fixture-tool", arguments: {} });
			messages[index] = result(toolCallId, "fixture-tool", `pending-parallel-${label}-${index}-`.repeat(1_000)) as ToolResultMessage;
			await fixture.internals.handleEvent({ type: "tool_execution_start", toolCallId, toolName: "fixture-tool", args: {} });
		}
		const assistantMessage = assistant(calls);
		fixture.session.agent.state.messages.push(assistantMessage);
		fixture.sessionManager.appendMessage(assistantMessage);
		const before = fixture.internals.getToolResultDiscoveryLifecycleCounts();
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
		const pending = fixture.internals.getToolResultDiscoveryLifecycleCounts();
		assert.equal(pending.pending, 129);
		assert.equal(pending.attached, 0);
		assert.equal(pending.pendingMapsCreated, 1);
		assert.equal(pending.attachedMapsCreated, 0);
		assert.equal(pending.registrationsEvicted, before.registrationsEvicted);

		for (const message of messages) {
			fixture.session.agent.state.messages.push(message);
			await emitToolResultMessageEnd(fixture, message);
		}
		const attached = fixture.internals.getToolResultDiscoveryLifecycleCounts();
		assert.equal(attached.pending, 0);
		assert.equal(attached.attached, 128);
		assert.equal(attached.pendingMapsCreated, 1);
		assert.equal(attached.attachedMapsCreated, 1);
		assert.equal(attached.registrationsEvicted, (before.registrationsEvicted ?? 0) + 1);
		const entries = attachedToolResultDiscoveries(fixture.internals);
		const expectedOrder = messages.slice(1).map((message) => message.toolCallId);
		assert.deepEqual([...(entries?.keys() ?? [])], expectedOrder);
		assert.equal(entries?.has(messages[0]!.toolCallId), false);
		const oldestRetained = entries?.get(messages[1]!.toolCallId)?.component;
		const newestRetained = entries?.get(messages[128]!.toolCallId)?.component;
		assert.ok(oldestRetained);
		assert.ok(newestRetained);
		for (const [component, message] of [[oldestRetained, messages[1]], [newestRetained, messages[128]]] as const) {
			const discovery = component.getToolResultPresentationDiscovery(message!.toolCallId);
			assert.ok(discovery);
			assert.ok(discovery.artifactId);
			assert.equal(fixture.session.readToolResultArtifact(discovery.artifactId).content, message!.content);
			assert.ok(fixture.session.readToolResultContinuation(discovery.cursor, 128).content.length > 0);
		}

		fixture.internals.rebuildChatFromMessages();
		assert.deepEqual(
			[...(attachedToolResultDiscoveries(fixture.internals)?.keys() ?? [])],
			expectedOrder,
			"live and rebuild latest-128 sets must match canonical transcript order",
		);
		return expectedOrder.map((toolCallId) => toolCallId.slice(toolCallId.lastIndexOf("-") + 1));
	};

	const forward = Array.from({ length: 129 }, (_, index) => index);
	const reverse = Array.from({ length: 129 }, (_, index) => 128 - index);
	const seeded = Array.from({ length: 129 }, (_, index) => (index * 37) % 129);
	const forwardResult = await runPermutation("forward", forward);
	assert.deepEqual(await runPermutation("reverse", reverse), forwardResult);
	assert.deepEqual(await runPermutation("seeded", seeded), forwardResult);
});

test("pending V1 results do not consume an attached V2 discovery slot", async (t) => {
	const postExtensionV1Id = "pending-v1-255";
	const fixture = await createModeFixture(
		[],
		[],
		{ enabled: true, budgetTokens: 128 },
		[(pi) => {
			pi.on("message_end", (event: { message: ToolResultMessage }) => {
				if (event.message.role !== "toolResult" || event.message.toolCallId !== postExtensionV1Id) return undefined;
				return { message: { ...event.message, content: [{ type: "text", text: "post-extension-small" }] } };
			});
		}],
	);
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
		const message = result(
			toolCallId,
			"fixture-tool",
			index === 255 ? "pre-extension-large-".repeat(1_000) : index % 2 === 0 ? "small" : "small error",
		) as ToolResultMessage;
		if (index === 254) {
			message.content = [
				{ type: "text", text: "small image result" },
				{ type: "image", data: "QUJDREVGRw==", mimeType: "image/png" },
			];
		}
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
	assert.equal(pending.pendingMapsCreated, 1);
	assert.equal(pending.attachedMapsCreated, 1);
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
		assert.ok(discovery.artifactId);
		assert.equal(fixture.session.readToolResultArtifact(discovery.artifactId).content, message.content);
		assert.ok(fixture.session.readToolResultContinuation(discovery.cursor, 128).content.length > 0);
	}
});

test("mixed parallel V1 and V2 results evict only on successful canonical V2 promotion", async (t) => {
	const fixture = await createModeFixture([], [], { enabled: true, budgetTokens: 128 });
	t.after(fixture.dispose);
	fixture.internals.isInitialized = true;
	const originalMessages = new Array<ToolResultMessage>(128);
	for (let index = 0; index < originalMessages.length; index++) {
		const toolCallId = `mixed-original-v2-${index}`;
		const message = result(toolCallId, "fixture-tool", `mixed-original-${index}-`.repeat(1_000)) as ToolResultMessage;
		originalMessages[index] = message;
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
	const before = fixture.internals.getToolResultDiscoveryLifecycleCounts();
	const batch = new Array<ToolResultMessage>(256);
	const expectedV2Order: string[] = [];
	for (let index = 0; index < batch.length; index++) {
		const toolCallId = `mixed-batch-${index}`;
		const isV2 = index % 2 === 0;
		const message = result(toolCallId, "fixture-tool", isV2 ? `mixed-large-${index}-`.repeat(1_000) : "small") as ToolResultMessage;
		batch[index] = message;
		if (isV2) expectedV2Order.push(toolCallId);
		await fixture.internals.handleEvent({ type: "tool_execution_start", toolCallId, toolName: message.toolName, args: {} });
	}
	for (let index = batch.length - 1; index >= 0; index--) {
		const message = batch[index]!;
		await fixture.internals.handleEvent({
			type: "tool_execution_end",
			toolCallId: message.toolCallId,
			toolName: message.toolName,
			result: { content: message.content, isError: false },
			isError: false,
		});
	}
	const pending = fixture.internals.getToolResultDiscoveryLifecycleCounts();
	assert.equal(pending.pending, 256);
	assert.equal(pending.attached, 128);
	assert.equal(pending.registrationsEvicted, before.registrationsEvicted);
	assert.equal(pending.totalEntries, 384);
	for (const message of batch) {
		fixture.session.agent.state.messages.push(message);
		await emitToolResultMessageEnd(fixture, message);
	}
	const after = fixture.internals.getToolResultDiscoveryLifecycleCounts();
	assert.equal(after.pending, 0);
	assert.equal(after.attached, 128);
	assert.equal(after.pendingHighWaterMark, 256);
	assert.equal(after.attachedHighWaterMark, 128);
	assert.equal(after.totalHighWaterMark, 384);
	assert.equal(after.attachedCapacityEvictions, (before.attachedCapacityEvictions ?? 0) + 128);
	assert.equal(after.registrationsEvicted, (before.registrationsEvicted ?? 0) + 128);
	assert.equal(after.pendingCompletionReleases, (before.pendingCompletionReleases ?? 0) + 256);
	assert.deepEqual([...(attachedToolResultDiscoveries(fixture.internals)?.keys() ?? [])], expectedV2Order);
	for (const message of batch) {
		const attached = attachedToolResultDiscoveries(fixture.internals)?.has(message.toolCallId) === true;
		assert.equal(attached, Number(message.toolCallId.slice("mixed-batch-".length)) % 2 === 0);
	}
});

test("pending discovery ownership is released at turn, agent, and stop boundaries", async (t) => {
	const createPending = async (fixture: ModeFixture, toolCallId: string): Promise<void> => {
		const message = result(toolCallId, "fixture-tool", `${toolCallId}-`.repeat(1_000)) as ToolResultMessage;
		await fixture.internals.handleEvent({ type: "tool_execution_start", toolCallId, toolName: message.toolName, args: {} });
		await fixture.internals.handleEvent({
			type: "tool_execution_end",
			toolCallId,
			toolName: message.toolName,
			result: { content: message.content, isError: false },
			isError: false,
		});
	};

	const turnFixture = await createModeFixture([], [], { enabled: true, budgetTokens: 128 });
	t.after(turnFixture.dispose);
	turnFixture.internals.isInitialized = true;
	await createPending(turnFixture, "pending-turn-end");
	await turnFixture.internals.handleEvent({ type: "turn_end", message: assistant([]), toolResults: [] });
	let counts = turnFixture.internals.getToolResultDiscoveryLifecycleCounts();
	assert.equal(counts.pending, 0);
	assert.equal(counts.pendingTeardownReleases, 1);

	const agentFixture = await createModeFixture([], [], { enabled: true, budgetTokens: 128 });
	t.after(agentFixture.dispose);
	agentFixture.internals.isInitialized = true;
	await createPending(agentFixture, "pending-agent-end");
	await agentFixture.internals.handleEvent({ type: "agent_end", messages: [], willRetry: false });
	counts = agentFixture.internals.getToolResultDiscoveryLifecycleCounts();
	assert.equal(counts.pending, 0);
	assert.equal(counts.pendingTeardownReleases, 1);

	const stopFixture = await createModeFixture([], [], { enabled: true, budgetTokens: 128 });
	t.after(stopFixture.dispose);
	stopFixture.internals.isInitialized = true;
	await createPending(stopFixture, "pending-stop");
	await stopFixture.mode.stop("transcript");
	counts = stopFixture.internals.getToolResultDiscoveryLifecycleCounts();
	assert.equal(counts.pending, 0);
	assert.equal(counts.attached, 0);
	assert.equal(counts.pendingTeardownReleases, 1);
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

test("tool-result message_end disposition preserves legacy mutation and skips only zero-handler refresh", async (t) => {
	const cases = [
		{
			name: "zero-handler",
			extensions: [] as Array<(pi: any) => void>,
			expectedDisposition: "none",
			expectedText: "ZERO_HANDLER_ORIGINAL",
			expectedRefreshes: 0,
			expectedSkips: 1,
			expectedConservativeRefreshes: 0,
			expectedReplacementRefreshes: 0,
		},
		{
			name: "no-op-handler",
			extensions: [(pi: any) => pi.on("message_end", (event: object) => {
				assert.equal("toolResultMessageEndDisposition" in event, false, "extensions must not observe the internal sidecar");
				return undefined;
			})],
			expectedDisposition: "handler-may-have-mutated",
			expectedText: "NO_OP_HANDLER_ORIGINAL",
			expectedRefreshes: 1,
			expectedSkips: 0,
			expectedConservativeRefreshes: 1,
			expectedReplacementRefreshes: 0,
		},
		{
			name: "in-place-handler",
			extensions: [(pi: any) => pi.on("message_end", (event: { message: ToolResultMessage }) => {
				if (event.message.role === "toolResult" && event.message.content[0]?.type === "text") {
					event.message.content[0].text = "IN_PLACE_HANDLER_CANONICAL";
				}
				return undefined;
			})],
			expectedDisposition: "handler-may-have-mutated",
			expectedText: "IN_PLACE_HANDLER_CANONICAL",
			expectedRefreshes: 1,
			expectedSkips: 0,
			expectedConservativeRefreshes: 1,
			expectedReplacementRefreshes: 0,
		},
		{
			name: "in-place-array-handler",
			extensions: [(pi: any) => pi.on("message_end", (event: { message: ToolResultMessage }) => {
				if (event.message.role === "toolResult") {
					event.message.content.push({ type: "text", text: "ARRAY_PUSHED" });
					event.message.content.splice(0, 1, { type: "text", text: "ARRAY_SPLICED" });
					event.message.content[1] = { type: "text", text: "IN_PLACE_ARRAY_CANONICAL" };
				}
				return undefined;
			})],
			expectedDisposition: "handler-may-have-mutated",
			expectedText: "IN_PLACE_ARRAY_CANONICAL",
			expectedRefreshes: 1,
			expectedSkips: 0,
			expectedConservativeRefreshes: 1,
			expectedReplacementRefreshes: 0,
		},
		{
			name: "in-place-details-handler",
			extensions: [(pi: any) => pi.on("message_end", (event: { message: ToolResultMessage }) => {
				if (event.message.role === "toolResult") {
					(event.message.details as { nested: { value: string } }).nested.value = "DETAILS_CANONICAL";
				}
				return undefined;
			})],
			expectedDisposition: "handler-may-have-mutated",
			expectedText: "PRE_EXTENSION_ORIGINAL",
			expectedDetails: "DETAILS_CANONICAL",
			expectedRefreshes: 1,
			expectedSkips: 0,
			expectedConservativeRefreshes: 1,
			expectedReplacementRefreshes: 0,
		},
		{
			name: "in-place-is-error-handler",
			extensions: [(pi: any) => pi.on("message_end", (event: { message: ToolResultMessage }) => {
				if (event.message.role === "toolResult") event.message.isError = true;
				return undefined;
			})],
			expectedDisposition: "handler-may-have-mutated",
			expectedText: "PRE_EXTENSION_ORIGINAL",
			expectedIsError: true,
			expectedRefreshes: 1,
			expectedSkips: 0,
			expectedConservativeRefreshes: 1,
			expectedReplacementRefreshes: 0,
		},
		{
			name: "mutation-then-throw",
			extensions: [(pi: any) => pi.on("message_end", (event: { message: ToolResultMessage }) => {
				if (event.message.role === "toolResult" && event.message.content[0]?.type === "text") {
					event.message.content[0].text = "MUTATED_BEFORE_THROW_CANONICAL";
				}
				throw new Error("fixture handler failure after mutation");
			})],
			expectedDisposition: "handler-may-have-mutated",
			expectedText: "MUTATED_BEFORE_THROW_CANONICAL",
			expectedRefreshes: 1,
			expectedSkips: 0,
			expectedConservativeRefreshes: 1,
			expectedReplacementRefreshes: 0,
		},
		{
			name: "invalid-role-after-mutation",
			extensions: [(pi: any) => pi.on("message_end", (event: { message: ToolResultMessage }) => {
				if (event.message.role === "toolResult" && event.message.content[0]?.type === "text") {
					event.message.content[0].text = "INVALID_ROLE_MUTATION_CANONICAL";
				}
				return { message: { role: "user", content: "invalid role", timestamp: 3 } };
			})],
			expectedDisposition: "handler-may-have-mutated",
			expectedText: "INVALID_ROLE_MUTATION_CANONICAL",
			expectedRefreshes: 1,
			expectedSkips: 0,
			expectedConservativeRefreshes: 1,
			expectedReplacementRefreshes: 0,
		},
		{
			name: "replacement-handler",
			extensions: [(pi: any) => pi.on("message_end", (event: { message: ToolResultMessage }) => ({
				message: { ...event.message, content: [{ type: "text", text: "RETURNED_REPLACEMENT_CANONICAL" }] },
			}))],
			expectedDisposition: "replacement-returned",
			expectedText: "RETURNED_REPLACEMENT_CANONICAL",
			expectedRefreshes: 1,
			expectedSkips: 0,
			expectedConservativeRefreshes: 0,
			expectedReplacementRefreshes: 1,
		},
		{
			name: "multiple-replacement-then-mutation",
			extensions: [(pi: any) => {
				pi.on("message_end", (event: { message: ToolResultMessage }) => ({
					message: { ...event.message, content: [{ type: "text", text: "MULTI_REPLACEMENT" }] },
				}));
				pi.on("message_end", (event: { message: ToolResultMessage }) => {
					if (event.message.role === "toolResult" && event.message.content[0]?.type === "text") {
						event.message.content[0].text = "MULTI_REPLACEMENT_THEN_MUTATION";
					}
				});
			}],
			expectedDisposition: "replacement-returned",
			expectedText: "MULTI_REPLACEMENT_THEN_MUTATION",
			expectedRefreshes: 1,
			expectedSkips: 0,
			expectedConservativeRefreshes: 0,
			expectedReplacementRefreshes: 1,
		},
	] as const;

	for (const fixtureCase of cases) {
		const fixture = await createModeFixture([], [], { enabled: true, budgetTokens: 128 }, [...fixtureCase.extensions]);
		t.after(fixture.dispose);
		fixture.internals.isInitialized = true;
		const toolCallId = `message-end-disposition-${fixtureCase.name}`;
		await fixture.internals.handleEvent({ type: "tool_execution_start", toolCallId, toolName: "fixture-tool", args: {} });
		const component = fixture.internals.pendingTools.get(toolCallId);
		assert.ok(component instanceof ToolExecutionComponent);
		const originalText = fixtureCase.name === "zero-handler"
			? "ZERO_HANDLER_ORIGINAL"
			: fixtureCase.name === "no-op-handler"
				? "NO_OP_HANDLER_ORIGINAL"
				: "PRE_EXTENSION_ORIGINAL";
		const message = result(toolCallId, "fixture-tool", originalText) as ToolResultMessage;
		message.details = { nested: { value: "DETAILS_ORIGINAL" } };
		await fixture.internals.handleEvent({
			type: "tool_execution_end",
			toolCallId,
			toolName: message.toolName,
			result: { content: message.content, details: message.details, isError: false },
			isError: false,
		});
		fixture.session.agent.state.messages.push(message);
		let disposition: string | undefined;
		await emitToolResultMessageEnd(fixture, message, (event) => {
			disposition = (event as unknown as { toolResultMessageEndDisposition?: string }).toolResultMessageEndDisposition;
		});
		const counts = fixture.internals.getToolResultDiscoveryLifecycleCounts();
		assert.equal(disposition, fixtureCase.expectedDisposition);
		assert.equal(counts.canonicalPayloadRefreshes, fixtureCase.expectedRefreshes);
		assert.equal(counts.canonicalPayloadRefreshSkips, fixtureCase.expectedSkips);
		assert.equal(
			counts.canonicalPayloadConservativeHandlerRefreshes,
			fixtureCase.expectedConservativeRefreshes,
		);
		assert.equal(counts.canonicalPayloadReplacementRefreshes, fixtureCase.expectedReplacementRefreshes);
		assert.match(component.render(100).join("\n"), new RegExp(fixtureCase.expectedText));
		const componentPayload = component as unknown as {
			result?: { details?: { nested?: { value?: string } } };
			resultIsError: boolean;
		};
		if ("expectedDetails" in fixtureCase) {
			assert.equal(componentPayload.result?.details?.nested?.value, fixtureCase.expectedDetails);
		}
		if ("expectedIsError" in fixtureCase) {
			assert.equal(componentPayload.resultIsError, fixtureCase.expectedIsError);
		}
		const persisted = fixture.sessionManager.getBranch().at(-1);
		assert.equal(persisted?.type, "message");
		assert.equal(
			persisted?.type === "message" && persisted.message.role === "toolResult"
				? persisted.message.content.some(
					(block) => block.type === "text" && block.text.includes(fixtureCase.expectedText),
				)
				: false,
			true,
		);
		if ("expectedDetails" in fixtureCase) {
			assert.equal(
				persisted?.type === "message" && persisted.message.role === "toolResult"
					? (persisted.message.details as { nested?: { value?: string } } | undefined)?.nested?.value
					: undefined,
				fixtureCase.expectedDetails,
			);
		}
		if ("expectedIsError" in fixtureCase) {
			assert.equal(
				persisted?.type === "message" && persisted.message.role === "toolResult"
					? persisted.message.isError
					: undefined,
				fixtureCase.expectedIsError,
			);
		}
		const canonicalStateMessage = fixture.session.agent.state.messages.at(-1);
		assert.equal(
			canonicalStateMessage?.role === "toolResult"
				? canonicalStateMessage.content.some(
					(block) => block.type === "text" && block.text.includes(fixtureCase.expectedText),
				)
				: false,
			true,
		);
		assert.equal(
			persisted?.type === "message" && "toolResultMessageEndDisposition" in persisted.message,
			false,
			"the internal disposition must not enter session persistence",
		);
	}
});

test("zero-handler V2 attaches once while missing disposition fails safe", async (t) => {
	const zeroHandler = await createModeFixture([], [], { enabled: true, budgetTokens: 128 });
	t.after(zeroHandler.dispose);
	zeroHandler.internals.isInitialized = true;
	const zeroId = "zero-handler-v2";
	await zeroHandler.internals.handleEvent({ type: "tool_execution_start", toolCallId: zeroId, toolName: "fixture-tool", args: {} });
	const zeroComponent = zeroHandler.internals.pendingTools.get(zeroId);
	assert.ok(zeroComponent instanceof ToolExecutionComponent);
	const zeroMessage = result(zeroId, "fixture-tool", "zero-handler-v2-".repeat(1_000)) as ToolResultMessage;
	await zeroHandler.internals.handleEvent({
		type: "tool_execution_end",
		toolCallId: zeroId,
		toolName: zeroMessage.toolName,
		result: { content: zeroMessage.content, isError: false },
		isError: false,
	});
	zeroHandler.session.agent.state.messages.push(zeroMessage);
	await emitToolResultMessageEnd(zeroHandler, zeroMessage);
	let counts = zeroHandler.internals.getToolResultDiscoveryLifecycleCounts();
	assert.equal(counts.canonicalPayloadRefreshes, 0);
	assert.equal(counts.canonicalPayloadRefreshSkips, 1);
	assert.ok(zeroComponent.getToolResultPresentationDiscovery(zeroId));
	assert.equal(counts.registrationsAttached, 1);

	const compatibility = await createModeFixture([], [], { enabled: true, budgetTokens: 128 });
	t.after(compatibility.dispose);
	compatibility.internals.isInitialized = true;
	const compatibilityId = "missing-disposition-v1";
	await compatibility.internals.handleEvent({
		type: "tool_execution_start",
		toolCallId: compatibilityId,
		toolName: "fixture-tool",
		args: {},
	});
	const compatibilityComponent = compatibility.internals.pendingTools.get(compatibilityId);
	assert.ok(compatibilityComponent instanceof ToolExecutionComponent);
	const compatibilityMessage = result(compatibilityId, "fixture-tool", "compatibility-original") as ToolResultMessage;
	await compatibility.internals.handleEvent({
		type: "tool_execution_end",
		toolCallId: compatibilityId,
		toolName: compatibilityMessage.toolName,
		result: { content: compatibilityMessage.content, isError: false },
		isError: false,
	});
	compatibility.session.agent.state.messages.push(compatibilityMessage);
	let captured = false;
	const unsubscribe = compatibility.session.subscribe((event) => {
		if (event.type !== "message_end" || !event.toolResultPresentation) return;
		captured = true;
		(compatibility.internals as unknown as {
			attachLiveToolResultPresentation(
				message: ToolResultMessage,
				presentation: ToolResultPresentation,
				disposition: undefined,
			): void;
		}).attachLiveToolResultPresentation(
			event.message as ToolResultMessage,
			event.toolResultPresentation,
			undefined,
		);
	});
	await (compatibility.session as unknown as {
		_handleAgentEvent(event: { type: "message_end"; message: ToolResultMessage }): Promise<void>;
	})._handleAgentEvent({ type: "message_end", message: compatibilityMessage });
	unsubscribe();
	assert.equal(captured, true);
	counts = compatibility.internals.getToolResultDiscoveryLifecycleCounts();
	assert.equal(counts.canonicalPayloadRefreshes, 1);
	assert.equal(counts.canonicalPayloadConservativeHandlerRefreshes, 1);
	assert.equal(counts.canonicalPayloadRefreshSkips, 0);
});

test("legacy in-place details and isError mutation reaches a custom renderer once", async (t) => {
	let resultRendererCalls = 0;
	const customTool = {
		name: "disposition-renderer",
		label: "Disposition renderer",
		description: "message_end disposition fixture",
		parameters: {},
		execute: async () => ({ content: [{ type: "text", text: "unused" }], details: undefined }),
		renderResult: (
			resultPayload: { details?: { nested?: { value?: string } } },
			_options: unknown,
			_theme: unknown,
			context: ToolRenderContext,
		) => {
			resultRendererCalls++;
			return new Text(`details=${resultPayload.details?.nested?.value ?? "missing"};error=${context.isError}`);
		},
	} as unknown as ToolDefinition;
	const fixture = await createModeFixture(
		[],
		[customTool],
		{ enabled: true, budgetTokens: 128 },
		[(pi: any) => pi.on("message_end", (event: { message: ToolResultMessage }) => {
			if (event.message.role === "toolResult") {
				(event.message.details as { nested: { value: string } }).nested.value = "MUTATED_DETAILS";
				event.message.isError = true;
			}
		})],
	);
	t.after(fixture.dispose);
	fixture.internals.isInitialized = true;
	const toolCallId = "disposition-custom-renderer";
	await fixture.internals.handleEvent({
		type: "tool_execution_start",
		toolCallId,
		toolName: customTool.name,
		args: {},
	});
	const component = fixture.internals.pendingTools.get(toolCallId);
	assert.ok(component instanceof ToolExecutionComponent);
	const message = result(toolCallId, customTool.name, "custom-renderer-content") as ToolResultMessage;
	message.details = { nested: { value: "ORIGINAL_DETAILS" } };
	await fixture.internals.handleEvent({
		type: "tool_execution_end",
		toolCallId,
		toolName: customTool.name,
		result: { content: message.content, details: message.details, isError: false },
		isError: false,
	});
	const callsAfterToolEnd = resultRendererCalls;
	fixture.session.agent.state.messages.push(message);
	await emitToolResultMessageEnd(fixture, message);
	assert.equal(resultRendererCalls, callsAfterToolEnd + 1);
	assert.match(component.render(100).join("\n"), /details=MUTATED_DETAILS;error=true/);
	const counts = fixture.internals.getToolResultDiscoveryLifecycleCounts();
	assert.equal(counts.canonicalPayloadRefreshes, 1);
	assert.equal(counts.canonicalPayloadConservativeHandlerRefreshes, 1);
	assert.equal(counts.canonicalPayloadReplacementRefreshes, 0);
	const persisted = fixture.sessionManager.getBranch().at(-1);
	assert.equal(
		persisted?.type === "message" && persisted.message.role === "toolResult"
			? (persisted.message.details as { nested?: { value?: string } }).nested?.value
			: undefined,
		"MUTATED_DETAILS",
	);
	assert.equal(
		persisted?.type === "message" && persisted.message.role === "toolResult"
			? persisted.message.isError
			: undefined,
		true,
	);
});

test("grouped extension dispositions compose with bounded previews, Kitty conversion, and compaction reset", async (t) => {
	const previousCapabilities = getCapabilities();
	setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
	t.after(() => setCapabilities(previousCapabilities));

	const noOpV1 = await createModeFixture(
		[],
		[],
		{ enabled: true, budgetTokens: 10_000 },
		[(pi: any) => pi.on("message_end", () => undefined)],
	);
	t.after(noOpV1.dispose);
	noOpV1.internals.isInitialized = true;
	const v1Id = "grouped-no-op-v1";
	const v1Group = noOpV1.internals.createTrackedToolComponent("read", v1Id, { path: "v1.txt" }, undefined, true);
	assert.ok(v1Group instanceof ReadToolGroupComponent);
	v1Group.setExpanded(true);
	const v1Message = {
		...(result(v1Id, "read", `${"v1-prefix-".repeat(500)}V1_TAIL`) as ToolResultMessage),
		content: [
			{ type: "text" as const, text: `${"v1-prefix-".repeat(500)}V1_TAIL` },
			{ type: "image" as const, data: "VjFfSlBFRw==", mimeType: "image/jpeg" },
		],
	};
	await noOpV1.internals.handleEvent({
		type: "tool_execution_end",
		toolCallId: v1Id,
		toolName: "read",
		result: { content: v1Message.content, isError: false },
		isError: false,
	});
	noOpV1.session.agent.state.messages.push(v1Message);
	await emitToolResultMessageEnd(noOpV1, v1Message);
	assert.doesNotMatch(v1Group.render(100).join("\n"), /V1_TAIL/);
	assert.equal(v1Group.getGroupedImageConversionLifecycleCounts().scheduled, 0);
	assert.equal(noOpV1.internals.getToolResultDiscoveryLifecycleCounts().canonicalPayloadConservativeHandlerRefreshes, 1);

	const runV2 = async (
		label: string,
		extensions: Array<(pi: any) => void>,
		expectedRefreshes: number,
	): Promise<{ fixture: ModeFixture; group: ReadToolGroupComponent }> => {
		const fixture = await createModeFixture([], [], { enabled: true, budgetTokens: 128 }, extensions);
		t.after(fixture.dispose);
		fixture.internals.isInitialized = true;
		const toolCallId = `grouped-${label}-v2`;
		const group = fixture.internals.createTrackedToolComponent("read", toolCallId, { path: `${label}.txt` }, undefined, true);
		assert.ok(group instanceof ReadToolGroupComponent);
		(group as unknown as {
			convertImageForTerminal(data: string, mimeType: string): Promise<{ data: string; mimeType: string } | null>;
		}).convertImageForTerminal = async () => ({ data: `${label}-png`, mimeType: "image/png" });
		group.setExpanded(true);
		const message = {
			...(result(toolCallId, "read", `${label}-`.repeat(1_000)) as ToolResultMessage),
			content: [
				{ type: "text" as const, text: `${label}-`.repeat(1_000) },
				{ type: "image" as const, data: `${label}-jpeg`, mimeType: "image/jpeg" },
			],
		};
		await fixture.internals.handleEvent({
			type: "tool_execution_end",
			toolCallId,
			toolName: "read",
			result: { content: message.content, isError: false },
			isError: false,
		});
		fixture.session.agent.state.messages.push(message);
		await emitToolResultMessageEnd(fixture, message);
		const lifecycle = fixture.internals.getToolResultDiscoveryLifecycleCounts();
		assert.equal(lifecycle.canonicalPayloadRefreshes, expectedRefreshes);
		assert.equal(group.getGroupedImageConversionLifecycleCounts().scheduled, 1);
		assert.ok(group.getToolResultPresentationDiscovery(toolCallId));
		return { fixture, group };
	};

	await runV2("zero-handler", [], 0);
	await runV2("in-place", [
		(pi: any) => pi.on("message_end", (event: { message: ToolResultMessage }) => {
			if (event.message.role === "toolResult" && event.message.content[0]?.type === "text") {
				event.message.content[0].text = "IN_PLACE_GROUPED_V2-".repeat(1_000);
			}
		}),
	], 1);

	let settleReplacement: ((value: { data: string; mimeType: string } | null) => void) | undefined;
	const replacement = await createModeFixture(
		[],
		[],
		{ enabled: true, budgetTokens: 128 },
		[(pi: any) => pi.on("message_end", (event: { message: ToolResultMessage }) => ({
			message: {
				...event.message,
				content: [
					{ type: "text", text: "REPLACEMENT_GROUPED_V2-".repeat(1_000) },
					{ type: "image", data: "replacement-jpeg", mimeType: "image/jpeg" },
				],
			},
		}))],
	);
	t.after(replacement.dispose);
	replacement.internals.isInitialized = true;
	const replacementId = "grouped-replacement-compaction";
	const replacementGroup = replacement.internals.createTrackedToolComponent(
		"read",
		replacementId,
		{ path: "replacement.txt" },
		undefined,
		true,
	);
	assert.ok(replacementGroup instanceof ReadToolGroupComponent);
	(replacementGroup as unknown as {
		convertImageForTerminal(data: string, mimeType: string): Promise<{ data: string; mimeType: string } | null>;
	}).convertImageForTerminal = () => new Promise((resolve) => { settleReplacement = resolve; });
	replacementGroup.setExpanded(true);
	const replacementMessage = {
		...(result(replacementId, "read", "PRE_REPLACEMENT_GROUPED_V2-".repeat(1_000)) as ToolResultMessage),
		content: [
			{ type: "text" as const, text: "PRE_REPLACEMENT_GROUPED_V2-".repeat(1_000) },
			{ type: "image" as const, data: "pre-replacement-jpeg", mimeType: "image/jpeg" },
		],
	};
	await replacement.internals.handleEvent({
		type: "tool_execution_end",
		toolCallId: replacementId,
		toolName: "read",
		result: { content: replacementMessage.content, isError: false },
		isError: false,
	});
	replacement.session.agent.state.messages.push(replacementMessage);
	await emitToolResultMessageEnd(replacement, replacementMessage);
	assert.equal(replacementGroup.getGroupedImageConversionLifecycleCounts().scheduled, 1);
	assert.equal(replacement.internals.getToolResultDiscoveryLifecycleCounts().canonicalPayloadReplacementRefreshes, 1);
	await replacement.internals.handleEvent({
		type: "compaction_end",
		reason: "manual",
		result: { summary: "replacement compaction", firstKeptEntryId: "kept", tokensBefore: 8_192 },
		aborted: false,
		willRetry: false,
	});
	assert.ok(settleReplacement);
	settleReplacement({ data: "stale-converted-png", mimeType: "image/png" });
	await Promise.resolve();
	await Promise.resolve();
	const conversionAfterCompaction = replacementGroup.getGroupedImageConversionLifecycleCounts();
	assert.equal(conversionAfterCompaction.accepted, 0);
	assert.equal(conversionAfterCompaction.dropped, 1);
	assert.equal(conversionAfterCompaction.sourceReferences, 0);
	assert.equal(replacementGroup.getToolResultPresentationDiscovery(replacementId), undefined);
	assert.equal(replacement.internals.getToolResultDiscoveryLifecycleCounts().canonicalHistoryResetUniqueComponentRefreshes, 1);
});

test("successful compaction refreshes a shared grouped component once", async (t) => {
	const fixture = await createModeFixture([], [], { enabled: true, budgetTokens: 128 });
	t.after(fixture.dispose);
	fixture.internals.isInitialized = true;
	const groupSize = 128;
	let group: ReadToolGroupComponent | undefined;
	for (let index = 0; index < groupSize; index++) {
		const toolCallId = `compaction-unique-group-${index}`;
		const component = fixture.internals.createTrackedToolComponent("read", toolCallId, { path: `${index}.txt` }, undefined, true);
		assert.ok(component instanceof ReadToolGroupComponent);
		group ??= component;
		assert.equal(component, group);
		const message = result(toolCallId, "read", `compaction-unique-${index}-`.repeat(1_000)) as ToolResultMessage;
		await fixture.internals.handleEvent({
			type: "tool_execution_end",
			toolCallId,
			toolName: "read",
			result: { content: message.content, isError: false },
			isError: false,
		});
		fixture.session.agent.state.messages.push(message);
		await emitToolResultMessageEnd(fixture, message);
	}
	assert.ok(group);
	const attachedEntries = attachedToolResultDiscoveries(fixture.internals);
	const identityMismatch = attachedEntries?.get("compaction-unique-group-0");
	assert.ok(identityMismatch);
	identityMismatch.identity = "stale-registry-identity";
	const alreadyDetached = attachedEntries?.get("compaction-unique-group-1");
	assert.ok(alreadyDetached?.identity);
	assert.equal(group.detachToolResultPresentation("compaction-unique-group-1", alreadyDetached.identity), true);
	const groupInternals = group as unknown as { rebuild(): void };
	const originalRebuild = groupInternals.rebuild;
	let rebuilds = 0;
	groupInternals.rebuild = function (): void {
		rebuilds++;
		return originalRebuild.call(this);
	};
	t.after(() => { groupInternals.rebuild = originalRebuild; });
	const before = fixture.internals.getToolResultDiscoveryLifecycleCounts();
	await fixture.internals.handleEvent({
		type: "compaction_end",
		reason: "manual",
		result: { summary: "UNIQUE_COMPONENT_RESET", firstKeptEntryId: "kept", tokensBefore: 8_192 },
		aborted: false,
		willRetry: false,
	});
	const after = fixture.internals.getToolResultDiscoveryLifecycleCounts();
	assert.equal(rebuilds, 1);
	assert.equal(after.canonicalHistoryResetRegistrationReleases, (before.canonicalHistoryResetRegistrationReleases ?? 0) + groupSize);
	assert.equal(after.canonicalHistoryResetUniqueComponentRefreshes, (before.canonicalHistoryResetUniqueComponentRefreshes ?? 0) + 1);
	assert.equal(after.attached, 0);
	for (let index = 0; index < groupSize; index++) {
		assert.equal(group.getToolResultPresentationDiscovery(`compaction-unique-group-${index}`), undefined);
	}
	await fixture.internals.handleEvent({
		type: "compaction_end",
		reason: "manual",
		result: { summary: "REPEATED_UNIQUE_COMPONENT_RESET", firstKeptEntryId: "kept", tokensBefore: 4_096 },
		aborted: false,
		willRetry: false,
	});
	const repeated = fixture.internals.getToolResultDiscoveryLifecycleCounts();
	assert.equal(repeated.canonicalHistoryResetRegistrationReleases, after.canonicalHistoryResetRegistrationReleases);
	assert.equal(repeated.canonicalHistoryResetUniqueComponentRefreshes, after.canonicalHistoryResetUniqueComponentRefreshes);
});

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

test("post-extension canonical V1 invalidates a completed retained result", async (t) => {
	const canonicalText = "POST_EXTENSION_CONTENT";
	const fixture = await createModeFixture(
		[],
		[],
		{ enabled: true, budgetTokens: 128 },
		[(pi) => {
			pi.on("message_end", (event: { message: ToolResultMessage }) => {
				if (event.message.role !== "toolResult" || event.message.toolCallId !== "canonical-v1-cache") return undefined;
				return { message: { ...event.message, content: [{ type: "text", text: canonicalText }] } };
			});
		}],
	);
	t.after(fixture.dispose);
	fixture.internals.isInitialized = true;
	const toolCallId = "canonical-v1-cache";
	await fixture.internals.handleEvent({ type: "tool_execution_start", toolCallId, toolName: "fixture-tool", args: {} });
	const component = fixture.internals.pendingTools.get(toolCallId);
	assert.ok(component instanceof ToolExecutionComponent);
	const message = result(toolCallId, "fixture-tool", "PRE_EXTENSION_CONTENT") as ToolResultMessage;
	await fixture.internals.handleEvent({
		type: "tool_execution_end",
		toolCallId,
		toolName: message.toolName,
		result: { content: message.content, isError: false },
		isError: false,
	});
	const cached = fixture.internals.chatContainer.render(80).join("\n");
	assert.match(cached, /PRE_EXTENSION_CONTENT/);
	const originalInvalidate = fixture.internals.chatContainer.invalidateRetainedChild;
	let retainedInvalidations = 0;
	fixture.internals.chatContainer.invalidateRetainedChild = function (candidate): boolean {
		if (candidate === component) retainedInvalidations++;
		return originalInvalidate.call(this, candidate);
	};
	t.after(() => {
		fixture.internals.chatContainer.invalidateRetainedChild = originalInvalidate;
	});
	fixture.session.agent.state.messages.push(message);
	let version: number | undefined;
	await emitToolResultMessageEnd(fixture, message, (event) => {
		version = event.toolResultPresentation?.version;
	});
	assert.equal(version, 1);
	assert.equal(retainedInvalidations, 1);
	const rendered = fixture.internals.chatContainer.render(80).join("\n");
	assert.match(rendered, /POST_EXTENSION_CONTENT/);
	assert.doesNotMatch(rendered, /PRE_EXTENSION_CONTENT/);
	assert.match(component.render(80).join("\n"), /POST_EXTENSION_CONTENT/);
	const lifecycle = fixture.internals.getToolResultDiscoveryLifecycleCounts();
	assert.equal(lifecycle.canonicalV1RetainedInvalidations, 1);
	assert.equal(lifecycle.pending, 0);
	assert.equal(lifecycle.attached, 0);
	assert.equal(component.getToolResultPresentationDiscovery(toolCallId), undefined);
});

test("post-extension canonical V1 refreshes only its completed grouped read row", async (t) => {
	const firstId = "canonical-v1-group-first";
	const secondId = "canonical-v1-group-second";
	const fixture = await createModeFixture(
		[],
		[],
		{ enabled: true, budgetTokens: 128 },
		[(pi) => {
			pi.on("message_end", (event: { message: ToolResultMessage }) => {
				if (event.message.role !== "toolResult" || event.message.toolCallId !== firstId) return undefined;
				return { message: { ...event.message, content: [{ type: "text", text: "GROUP_POST_EXTENSION" }] } };
			});
		}],
	);
	t.after(fixture.dispose);
	fixture.internals.isInitialized = true;
	fixture.internals.createTrackedToolComponent("read", firstId, { path: "first.txt" }, undefined, true);
	fixture.internals.createTrackedToolComponent("read", secondId, { path: "second.txt" }, undefined, true);
	const group = fixture.internals.pendingTools.get(firstId);
	assert.ok(group instanceof ReadToolGroupComponent);
	assert.equal(fixture.internals.pendingTools.get(secondId), group);
	const first = result(firstId, "read", "GROUP_PRE_EXTENSION") as ToolResultMessage;
	const second = result(secondId, "read", "GROUP_UNCHANGED") as ToolResultMessage;
	for (const message of [first, second]) {
		await fixture.internals.handleEvent({
			type: "tool_execution_end",
			toolCallId: message.toolCallId,
			toolName: message.toolName,
			result: { content: message.content, isError: false },
			isError: false,
		});
	}
	group.setExpanded(true);
	assert.match(fixture.internals.chatContainer.render(100).join("\n"), /GROUP_PRE_EXTENSION/);
	fixture.session.agent.state.messages.push(first, second);
	await emitToolResultMessageEnd(fixture, first);
	const rendered = fixture.internals.chatContainer.render(100).join("\n");
	assert.match(rendered, /GROUP_POST_EXTENSION/);
	assert.match(rendered, /GROUP_UNCHANGED/);
	assert.doesNotMatch(rendered, /GROUP_PRE_EXTENSION/);
});

test("post-extension canonical V1 retained invalidation covers result shape changes", async () => {
	const cases = [
		{ name: "v1-to-v1", before: "PRE_V1", beforeError: false, after: "POST_V1", afterError: false },
		{ name: "large-to-v1", before: "PRE_LARGE_".repeat(1_000), beforeError: false, after: "POST_SMALL", afterError: false },
		{ name: "text-to-error", before: "PRE_TEXT", beforeError: false, after: "POST_ERROR", afterError: true },
		{ name: "error-to-text", before: "PRE_ERROR", beforeError: true, after: "POST_TEXT", afterError: false },
		{ name: "text-image-to-v1", before: "PRE_IMAGE_TEXT", beforeError: false, after: "POST_IMAGE_REMOVED", afterError: false },
	] as const;
	for (const fixtureCase of cases) {
		const toolCallId = `canonical-v1-shape-${fixtureCase.name}`;
		const fixture = await createModeFixture(
			[],
			[],
			{ enabled: true, budgetTokens: 128 },
			[(pi) => {
				pi.on("message_end", (event: { message: ToolResultMessage }) => {
					if (event.message.role !== "toolResult" || event.message.toolCallId !== toolCallId) return undefined;
					return {
						message: {
							...event.message,
							content: [{ type: "text", text: fixtureCase.after }],
							isError: fixtureCase.afterError,
						},
					};
				});
			}],
		);
		try {
			fixture.internals.isInitialized = true;
			await fixture.internals.handleEvent({ type: "tool_execution_start", toolCallId, toolName: "fixture-tool", args: {} });
			const component = fixture.internals.pendingTools.get(toolCallId);
			assert.ok(component instanceof ToolExecutionComponent);
			const message = result(toolCallId, "fixture-tool", fixtureCase.before) as ToolResultMessage;
			message.isError = fixtureCase.beforeError;
			if (fixtureCase.name === "text-image-to-v1") {
				message.content.push({ type: "image", data: "QUJDREVGRw==", mimeType: "image/png" });
			}
			await fixture.internals.handleEvent({
				type: "tool_execution_end",
				toolCallId,
				toolName: message.toolName,
				result: { content: message.content, isError: message.isError },
				isError: message.isError,
			});
			assert.match(fixture.internals.chatContainer.render(80).join("\n"), new RegExp(fixtureCase.before.slice(0, 24)));
			fixture.session.agent.state.messages.push(message);
			const beforeInvalidations = fixture.internals.getToolResultDiscoveryLifecycleCounts().canonicalV1RetainedInvalidations ?? 0;
			await emitToolResultMessageEnd(fixture, message);
			const rendered = fixture.internals.chatContainer.render(80).join("\n");
			assert.match(rendered, new RegExp(fixtureCase.after));
			assert.doesNotMatch(rendered, new RegExp(fixtureCase.before.slice(0, 24)));
			const lifecycle = fixture.internals.getToolResultDiscoveryLifecycleCounts();
			assert.equal(lifecycle.canonicalV1RetainedInvalidations, beforeInvalidations + 1);
			assert.equal(lifecycle.pending, 0);
			assert.equal(lifecycle.attached, 0);
			assert.equal(component.getToolResultPresentationDiscovery(toolCallId), undefined);
		} finally {
			fixture.dispose();
		}
	}
});

test("successful compaction revokes stale live discoveries without rebuilding transcript content", async (t) => {
	const fixture = await createModeFixture([], [], { enabled: true, budgetTokens: 128 });
	t.after(fixture.dispose);
	fixture.internals.isInitialized = true;
	const toolCallId = "compaction-stale-discovery";
	const message = result(toolCallId, "fixture-tool", "COMPACTION_VISIBLE_CONTENT-".repeat(1_000)) as ToolResultMessage;
	await fixture.internals.handleEvent({ type: "tool_execution_start", toolCallId, toolName: message.toolName, args: {} });
	const component = fixture.internals.pendingTools.get(toolCallId);
	assert.ok(component instanceof ToolExecutionComponent);
	await fixture.internals.handleEvent({
		type: "tool_execution_end",
		toolCallId,
		toolName: message.toolName,
		result: { content: message.content, isError: false },
		isError: false,
	});
	fixture.session.agent.state.messages.push(message);
	await emitToolResultMessageEnd(fixture, message);
	component.setExpanded(true);
	const discovery = component.getToolResultPresentationDiscovery(toolCallId);
	assert.ok(discovery?.artifactId);
	assert.match(fixture.internals.chatContainer.render(100).join("\n"), /Model received a bounded view/);
	const childrenBefore = fixture.internals.chatContainer.children.slice();
	const before = fixture.internals.getToolResultDiscoveryLifecycleCounts();
	const sessionInternals = fixture.session as unknown as {
		_toolResultPresentation?: { clearProjectionRecords(): void };
		_rebuildToolResultUiCanonicalIndex(): void;
	};
	sessionInternals._toolResultPresentation?.clearProjectionRecords();
	fixture.session.agent.state.messages = [];
	sessionInternals._rebuildToolResultUiCanonicalIndex();
	await fixture.internals.handleEvent({
		type: "compaction_end",
		reason: "manual",
		result: { summary: "COMPACTION_SUMMARY", firstKeptEntryId: "kept", tokensBefore: 8_192, retainedTail: [] },
		aborted: false,
		willRetry: false,
	});
	const after = fixture.internals.getToolResultDiscoveryLifecycleCounts();
	assert.equal(after.pending, 0);
	assert.equal(after.attached, 0);
	assert.equal(after.canonicalHistoryResetReleases, 1);
	assert.equal(after.attachedCapacityEvictions, before.attachedCapacityEvictions);
	assert.equal(component.getToolResultPresentationDiscovery(toolCallId), undefined);
	const rendered = fixture.internals.chatContainer.render(100).join("\n");
	assert.match(rendered, /COMPACTION_VISIBLE_CONTENT/);
	assert.match(rendered, /\[compaction\]/);
	assert.doesNotMatch(rendered, /Model received a bounded view/);
	assert.deepEqual(fixture.internals.chatContainer.children.slice(0, childrenBefore.length), childrenBefore);
	assert.throws(() => fixture.session.readToolResultArtifact(discovery.artifactId!));
	assert.throws(() => fixture.session.readToolResultContinuation(discovery.cursor, 128));
});

test("aborted and failed compaction preserve attached discoveries", async (t) => {
	const fixture = await createModeFixture([], [], { enabled: true, budgetTokens: 128 });
	t.after(fixture.dispose);
	fixture.internals.isInitialized = true;
	const toolCallId = "compaction-preserved-discovery";
	const message = result(toolCallId, "fixture-tool", "compaction-preserved-".repeat(1_000)) as ToolResultMessage;
	await fixture.internals.handleEvent({ type: "tool_execution_start", toolCallId, toolName: message.toolName, args: {} });
	const component = fixture.internals.pendingTools.get(toolCallId);
	assert.ok(component instanceof ToolExecutionComponent);
	await fixture.internals.handleEvent({
		type: "tool_execution_end",
		toolCallId,
		toolName: message.toolName,
		result: { content: message.content, isError: false },
		isError: false,
	});
	fixture.session.agent.state.messages.push(message);
	await emitToolResultMessageEnd(fixture, message);
	const originalDiscovery = component.getToolResultPresentationDiscovery(toolCallId);
	assert.ok(originalDiscovery);
	await fixture.internals.handleEvent({
		type: "compaction_end",
		reason: "manual",
		result: undefined,
		aborted: true,
		willRetry: false,
	});
	assert.equal(component.getToolResultPresentationDiscovery(toolCallId), originalDiscovery);
	await fixture.internals.handleEvent({
		type: "compaction_end",
		reason: "threshold",
		result: undefined,
		aborted: false,
		willRetry: false,
		errorMessage: "compaction failed",
	});
	assert.equal(component.getToolResultPresentationDiscovery(toolCallId), originalDiscovery);
	assert.equal(fixture.internals.getToolResultDiscoveryLifecycleCounts().canonicalHistoryResetReleases ?? 0, 0);
});

test("successful auto compaction releases 128 attached discoveries and pending ownership", async (t) => {
	const fixture = await createModeFixture([], [], { enabled: true, budgetTokens: 128 });
	t.after(fixture.dispose);
	fixture.internals.isInitialized = true;
	const messages = new Array<ToolResultMessage>(128);
	const components = new Array<ToolExecutionComponent>(128);
	for (let index = 0; index < messages.length; index++) {
		const toolCallId = `compaction-reset-${index}`;
		const message = result(toolCallId, "fixture-tool", `compaction-reset-${index}-`.repeat(1_000)) as ToolResultMessage;
		messages[index] = message;
		await fixture.internals.handleEvent({ type: "tool_execution_start", toolCallId, toolName: message.toolName, args: {} });
		const component = fixture.internals.pendingTools.get(toolCallId);
		assert.ok(component instanceof ToolExecutionComponent);
		components[index] = component;
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
	const pendingId = "compaction-reset-pending";
	const pendingMessage = result(pendingId, "fixture-tool", "compaction-pending-".repeat(1_000)) as ToolResultMessage;
	await fixture.internals.handleEvent({ type: "tool_execution_start", toolCallId: pendingId, toolName: pendingMessage.toolName, args: {} });
	await fixture.internals.handleEvent({
		type: "tool_execution_end",
		toolCallId: pendingId,
		toolName: pendingMessage.toolName,
		result: { content: pendingMessage.content, isError: false },
		isError: false,
	});
	const before = fixture.internals.getToolResultDiscoveryLifecycleCounts();
	assert.equal(before.attached, 128);
	assert.equal(before.pending, 1);
	const sessionInternals = fixture.session as unknown as {
		_toolResultPresentation?: { clearProjectionRecords(): void };
		_rebuildToolResultUiCanonicalIndex(): void;
	};
	sessionInternals._toolResultPresentation?.clearProjectionRecords();
	fixture.session.agent.state.messages = [messages.at(-1)!];
	sessionInternals._rebuildToolResultUiCanonicalIndex();
	await fixture.internals.handleEvent({
		type: "compaction_end",
		reason: "threshold",
		result: {
			summary: "AUTO_COMPACTION_SUMMARY",
			firstKeptEntryId: "kept",
			tokensBefore: 32_768,
			retainedTail: [messages.at(-1)!],
		},
		aborted: false,
		willRetry: true,
	});
	const after = fixture.internals.getToolResultDiscoveryLifecycleCounts();
	assert.equal(after.pending, 0);
	assert.equal(after.attached, 0);
	assert.equal(after.canonicalHistoryResetReleases, 128);
	assert.equal(after.pendingTeardownReleases, (before.pendingTeardownReleases ?? 0) + 1);
	assert.equal(after.attachedCapacityEvictions, before.attachedCapacityEvictions);
	for (let index = 0; index < components.length; index++) {
		assert.equal(components[index]!.getToolResultPresentationDiscovery(messages[index]!.toolCallId), undefined);
	}
});

test("successful compaction clears every discovery from a shared grouped read component", async (t) => {
	const fixture = await createModeFixture([], [], { enabled: true, budgetTokens: 128 });
	t.after(fixture.dispose);
	fixture.internals.isInitialized = true;
	const firstId = "compaction-group-first";
	const secondId = "compaction-group-second";
	const group = fixture.internals.createTrackedToolComponent("read", firstId, { path: "first.txt" }, undefined, true);
	fixture.internals.createTrackedToolComponent("read", secondId, { path: "second.txt" }, undefined, true);
	assert.ok(group instanceof ReadToolGroupComponent);
	const messages = [
		result(firstId, "read", "compaction-group-first-".repeat(1_000)) as ToolResultMessage,
		result(secondId, "read", "compaction-group-second-".repeat(1_000)) as ToolResultMessage,
	];
	for (const message of messages) {
		await fixture.internals.handleEvent({
			type: "tool_execution_end",
			toolCallId: message.toolCallId,
			toolName: message.toolName,
			result: { content: message.content, isError: false },
			isError: false,
		});
		fixture.session.agent.state.messages.push(message);
		await emitToolResultMessageEnd(fixture, message);
		assert.ok(group.getToolResultPresentationDiscovery(message.toolCallId));
	}
	group.setExpanded(true);
	assert.match(fixture.internals.chatContainer.render(100).join("\n"), /Model received a bounded view/);
	const sessionInternals = fixture.session as unknown as {
		_toolResultPresentation?: { clearProjectionRecords(): void };
		_rebuildToolResultUiCanonicalIndex(): void;
	};
	sessionInternals._toolResultPresentation?.clearProjectionRecords();
	fixture.session.agent.state.messages = [];
	sessionInternals._rebuildToolResultUiCanonicalIndex();
	await fixture.internals.handleEvent({
		type: "compaction_end",
		reason: "overflow",
		result: { summary: "GROUP_COMPACTION", firstKeptEntryId: "kept", tokensBefore: 16_384 },
		aborted: false,
		willRetry: false,
	});
	assert.equal(group.getToolResultPresentationDiscovery(firstId), undefined);
	assert.equal(group.getToolResultPresentationDiscovery(secondId), undefined);
	assert.doesNotMatch(fixture.internals.chatContainer.render(100).join("\n"), /Model received a bounded view/);
	const lifecycle = fixture.internals.getToolResultDiscoveryLifecycleCounts();
	assert.equal(lifecycle.canonicalHistoryResetReleases, 2);
	assert.equal(lifecycle.attached, 0);
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
	const lifecycle = fixture.internals.getToolResultDiscoveryLifecycleCounts();
	assert.equal(lifecycle.attachedCapacityEvictions, 0);
	assert.equal(lifecycle.ambiguityRemovals, 2);
	assert.equal(lifecycle.pending, 0);
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
	const lifecycle = fixture.internals.getToolResultDiscoveryLifecycleCounts();
	assert.equal(lifecycle.pendingMapsCreated, 0);
	assert.equal(lifecycle.attachedMapsCreated, 0);
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
			pendingEntries: 0,
			attachedEntries: 1,
			totalEntries: 1,
			pendingHighWaterMark: 0,
			attachedHighWaterMark: 1,
			totalHighWaterMark: 1,
			attachedCapacityEvictions: 0,
			ambiguityRemovals: 0,
			pendingCompletionReleases: 0,
			pendingTeardownReleases: 0,
			attachedTeardownReleases: 0,
			pendingMapsCreated: 0,
			attachedMapsCreated: 1,
			canonicalV1RetainedInvalidations: 0,
			canonicalHistoryResetReleases: 0,
			canonicalHistoryResetRegistrationReleases: 0,
			canonicalHistoryResetUniqueComponentRefreshes: 0,
			canonicalPayloadRefreshes: 0,
			canonicalPayloadRefreshSkips: 0,
			canonicalPayloadConservativeHandlerRefreshes: 0,
			canonicalPayloadReplacementRefreshes: 0,
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
