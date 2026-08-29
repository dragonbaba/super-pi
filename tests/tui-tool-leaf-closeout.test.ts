import assert from "node:assert/strict";
import test from "node:test";
import { getStreamedToolArgumentOwnership, type KnownApi } from "@super-pi/ai/compat";
import { Agent } from "../packages/agent/src/agent.ts";
import { EventDeliveryDispatcher } from "../packages/agent/src/event-delivery.ts";
import { setCapabilities, Text, type Component, type TUI } from "@super-pi/tui";
import { stream as streamAnthropic } from "../packages/ai/src/api/anthropic-messages.ts";
import type { ToolDefinition } from "../packages/coding-agent/src/core/extensions/types.ts";
import { AgentSession } from "../packages/coding-agent/src/core/agent-session.ts";
import {
	ToolExecutionComponent,
	type ToolExecutionAllocationMetrics,
} from "../packages/coding-agent/src/modes/interactive/components/tool-execution.ts";
import { InteractiveMode } from "../packages/coding-agent/src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../packages/coding-agent/src/modes/interactive/theme/theme.ts";
import { RetainedContainer } from "../packages/tui/src/components/retained-item.ts";
import { FakeScheduler } from "./helpers/runtime-instrumentation.ts";

function createMetrics(): ToolExecutionAllocationMetrics {
	return {
		updateDisplayCalls: 0,
		callRendererCalls: 0,
		resultRendererCalls: 0,
		componentCreations: 0,
		renderContextObjects: 0,
		internalWrapperObjects: 0,
		imageScans: 0,
		argsSerializations: 0,
		toolArgsGenerationUpdates: 0,
		toolArgsReplacementUpdates: 0,
		toolArgsSemanticFallbackComparisons: 0,
		toolArgsMissingGenerationUpdates: 0,
		toolArgsFinalizations: 0,
	};
}

function createTui(): TUI {
	return { requestRender(): void {} } as TUI;
}

class AgentTestDeliveryDispatcher extends EventDeliveryDispatcher<unknown, string> {
	private readonly owner: {
		snapshotObserverEvent(value: unknown): unknown;
		releaseObserverEvent(key: string, value: unknown): void;
	};

	constructor(
		owner: {
			snapshotObserverEvent(value: unknown): unknown;
			releaseObserverEvent(key: string, value: unknown): void;
		},
		scheduler: FakeScheduler,
	) {
		super({ scheduler, defaultMinIntervalMs: 16 });
		this.owner = owner;
	}

	protected override createLatestSnapshot(event: unknown): unknown {
		return this.owner.snapshotObserverEvent(event);
	}

	protected override onLatestReleased(key: string, event: unknown): void {
		this.owner.releaseObserverEvent(key, event);
	}
}

function createDefinition(
	renderCall: ToolDefinition<any, any>["renderCall"],
	renderResult?: ToolDefinition<any, any>["renderResult"],
): ToolDefinition<any, any> {
	return {
		name: "leaf-closeout",
		label: "Leaf closeout",
		description: "test",
		parameters: { type: "object", properties: {} },
		async execute() { return { content: [], details: undefined }; },
		renderCall,
		renderResult,
	} as ToolDefinition<any, any>;
}

test("legacy same-reference mutations repaint generic and custom call views", () => {
	initTheme("dark");
	const genericArgs = { top: 1, nested: { value: 1 }, streamed: "a" };
	const generic = new ToolExecutionComponent("legacy-generic", "generic", genericArgs, {}, undefined, createTui(), process.cwd());
	genericArgs.top = 2;
	generic.updateArgs(genericArgs);
	assert.match(generic.render(80).join("\n"), /"top": 2/);
	genericArgs.nested.value = 3;
	generic.updateArgs(genericArgs);
	assert.match(generic.render(80).join("\n"), /"value": 3/);
	genericArgs.streamed += "b";
	generic.updateArgs(genericArgs);
	assert.match(generic.render(80).join("\n"), /"streamed": "ab"/);

	let customCalls = 0;
	const customArgs = { top: 1, nested: { value: 1 }, streamed: "a" };
	const custom = new ToolExecutionComponent(
		"legacy-custom",
		"custom",
		customArgs,
		{},
		createDefinition((args) => {
			customCalls++;
			const value = args as typeof customArgs;
			return new Text(`${value.top}:${value.nested.value}:${value.streamed}`, 0, 0);
		}),
		createTui(),
		process.cwd(),
	);
	customCalls = 0;
	customArgs.top = 2;
	custom.updateArgs(customArgs);
	assert.match(custom.render(80).join("\n"), /2:1:a/);
	customArgs.nested.value = 3;
	custom.updateArgs(customArgs);
	assert.match(custom.render(80).join("\n"), /2:3:a/);
	customArgs.streamed += "b";
	custom.updateArgs(customArgs);
	assert.equal(customCalls, 3);
	assert.match(custom.render(80).join("\n"), /2:3:ab/);
});

test("custom renderCall remains dynamic across result and context transitions", () => {
	initTheme("dark");
	let calls = 0;
	const contexts: Array<{ executionStarted: boolean; argsComplete: boolean; isPartial: boolean; expanded: boolean; showImages: boolean; isError: boolean; state: { resultSeen?: boolean } }> = [];
	const stateSeenAtCall: boolean[] = [];
	const definition = createDefinition(
		(_args, _theme, context) => {
			calls++;
			contexts.push(context);
			stateSeenAtCall.push(context.state.resultSeen === true);
			return new Text(
				`${context.executionStarted}:${context.argsComplete}:${context.isPartial}:${context.expanded}:${context.showImages}:${context.isError}:${context.state.resultSeen === true}`,
				0,
				0,
			);
		},
		(_result, _options, _theme, context) => {
			context.state.resultSeen = true;
			return new Text("result", 0, 0);
		},
	);
	const component = new ToolExecutionComponent("dynamic-custom", "dynamic", {}, {}, definition, createTui(), process.cwd());
	calls = 0;
	contexts.length = 0;
	stateSeenAtCall.length = 0;
	component.updateResult({ content: [{ type: "text", text: "partial" }] }, true, false);
	component.updateResult({ content: [{ type: "text", text: "final" }] }, false, false);
	component.updateResult({ content: [{ type: "text", text: "error" }] }, false, true);
	component.markExecutionStarted();
	component.setArgsComplete();
	component.setExpanded(true);
	component.setShowImages(false);
	component.invalidate();
	assert.equal(calls, 8);
	assert.equal(stateSeenAtCall[1], true, "result renderer state is visible to the next call render");
	assert.match(component.render(80).join("\n"), /true:true:false:true:false:true:true/);
});

test("custom renderCall args-only caching requires explicit opt-in", () => {
	initTheme("dark");
	let calls = 0;
	const definition = createDefinition(() => {
		calls++;
		return new Text("stable", 0, 0);
	});
	definition.renderCallStability = "args-only";
	const component = new ToolExecutionComponent("stable-custom", "stable", {}, {}, definition, createTui(), process.cwd());
	calls = 0;
	component.updateResult({ content: [{ type: "text", text: "partial" }] }, true, false);
	component.updateResult({ content: [{ type: "text", text: "final" }] }, false, false);
	assert.equal(calls, 0);
	component.invalidate();
	assert.equal(calls, 1, "explicit invalidation still dirties an args-only renderer");
});

test("replacement ownership skips same-content call rebuilds but repaints changed content", () => {
	initTheme("dark");
	let calls = 0;
	const definition = createDefinition((args) => {
		calls++;
		return new Text(JSON.stringify(args), 0, 0);
	});
	const component = new ToolExecutionComponent("replacement", "replacement", { value: 1 }, {}, definition, createTui(), process.cwd());
	calls = 0;
	component.updateArgs({ value: 1 }, undefined, "replacement-object");
	assert.equal(calls, 0);
	component.updateArgs({ value: 2 }, undefined, "replacement-object");
	assert.equal(calls, 1);
	assert.match(component.render(80).join("\n"), /"value":2/);
});

test("built-in result-only updates preserve the call side", () => {
	initTheme("dark");
	const metrics = createMetrics();
	const component = new ToolExecutionComponent(
		"read",
		"read-1",
		{ path: "README.md" },
		{ allocationMetrics: metrics },
		undefined,
		createTui(),
		process.cwd(),
	);
	metrics.callRendererCalls = 0;
	component.updateResult({ content: [{ type: "text", text: "one" }] }, true, false);
	component.updateResult({ content: [{ type: "text", text: "two" }] }, false, false);
	assert.equal(metrics.callRendererCalls, 0);
});

test("mutation finalization repaints without a missing-generation diagnostic", () => {
	initTheme("dark");
	const metrics = createMetrics();
	const args = { nested: { value: 1 } };
	const component = new ToolExecutionComponent("mutation", "mutation", args, { allocationMetrics: metrics }, undefined, createTui(), process.cwd());
	args.nested.value = 2;
	component.updateArgs(args, "delta-1", "mutation-with-generation");
	args.nested.value = 3;
	(component.updateArgs as unknown as (args: unknown, generation: undefined, ownership: "mutation-with-generation", finalized: boolean) => void)(
		args,
		undefined,
		"mutation-with-generation",
		true,
	);
	assert.equal(metrics.toolArgsMissingGenerationUpdates, 0);
	assert.match(component.render(80).join("\n"), /"value": 3/);
});

test("image shrink releases converted tail entries and rejects stale ordinal data", async () => {
	initTheme("dark");
	const previous = { images: null, trueColor: false, hyperlinks: false } as const;
	setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
	try {
		const component = new ToolExecutionComponent("images", "images", {}, { showImages: true }, undefined, createTui(), process.cwd());
		component.updateResult({ content: [
			{ type: "image", data: "first", mimeType: "image/png" },
			{ type: "image", data: "second", mimeType: "image/png" },
		] }, true, false);
		const state = component as unknown as {
			convertedImages: Map<number, { data: string; mimeType: string }>;
			pendingImageSourceData: Array<string | undefined>;
		};
		state.convertedImages.set(0, { data: "converted-first", mimeType: "image/png" });
		state.convertedImages.set(1, { data: "converted-second", mimeType: "image/png" });
		component.updateResult({ content: [{ type: "image", data: "first", mimeType: "image/png" }] }, true, false);
		assert.equal(state.convertedImages.has(0), true);
		assert.equal(state.convertedImages.has(1), false);
		assert.equal(state.pendingImageSourceData.length, 1);
		component.updateResult({ content: [
			{ type: "image", data: "first", mimeType: "image/png" },
			{ type: "image", data: "R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==", mimeType: "image/gif" },
		] }, true, false);
		component.updateResult({ content: [{ type: "image", data: "first", mimeType: "image/png" }] }, true, false);
		await new Promise<void>((resolve) => setTimeout(resolve, 200));
		assert.equal(state.convertedImages.has(1), false, "late conversion cannot repopulate a removed ordinal");
		component.updateResult({ content: [] }, true, false);
		assert.equal(state.convertedImages.size, 0);
		assert.equal(state.pendingImageSourceData.length, 0);
	} finally {
		setCapabilities(previous);
	}
});

test("known adapter ownership matrix has dynamic host behavior without missing metadata", () => {
	initTheme("dark");
	const mutationApis: readonly KnownApi[] = [
		"anthropic-messages",
		"bedrock-converse-stream",
		"openai-responses",
		"azure-openai-responses",
		"openai-codex-responses",
		"openai-completions",
		"mistral-conversations",
	];
	const replacementApis: readonly KnownApi[] = ["pi-messages", "google-generative-ai", "google-vertex"];
	for (const api of mutationApis) {
		const metrics = createMetrics();
		const args = { nested: { value: 1 } };
		const component = new ToolExecutionComponent(api, api, args, { allocationMetrics: metrics }, undefined, createTui(), process.cwd());
		args.nested.value = 2;
		component.updateArgs(args, `generation:${api}:1`, getStreamedToolArgumentOwnership(api));
		assert.equal(metrics.toolArgsGenerationUpdates, 1, api);
		assert.equal(metrics.toolArgsMissingGenerationUpdates, 0, api);
		assert.equal(metrics.toolArgsSemanticFallbackComparisons, 0, api);
		assert.match(component.render(80).join("\n"), /"value": 2/, api);
	}
	for (const api of replacementApis) {
		const metrics = createMetrics();
		const component = new ToolExecutionComponent(api, api, { nested: { value: 1 } }, { allocationMetrics: metrics }, undefined, createTui(), process.cwd());
		component.updateArgs({ nested: { value: 2 } }, undefined, getStreamedToolArgumentOwnership(api));
		assert.equal(metrics.toolArgsReplacementUpdates, 1, api);
		assert.equal(metrics.toolArgsMissingGenerationUpdates, 0, api);
		assert.equal(metrics.toolArgsSemanticFallbackComparisons, 0, api);
		assert.match(component.render(80).join("\n"), /"value": 2/, api);
	}
});

test("mutation adapter start delta delta end sequence repaints finalization without a missing generation", () => {
	initTheme("dark");
	const metrics = createMetrics();
	const tui = createTui();
	const args = { nested: { value: 0 } };
	const tool = new ToolExecutionComponent(
		"streamed",
		"tool-1",
		args,
		{ allocationMetrics: metrics },
		undefined,
		tui,
		process.cwd(),
	);
	const mode = Object.create(InteractiveMode.prototype) as InteractiveMode & Record<string, unknown>;
	Object.assign(mode, {
		isInitialized: true,
		footer: { invalidate(): void {} },
		streamingComponent: { updateContent(): void {} },
		streamingMessage: undefined,
		streamingItem: { updateVersion(): void {} },
		streamingItemVersion: 0,
		pendingTools: new Map([["tool-1", tool]]),
		streamedToolIds: new Set(["tool-1"]),
		deferredReadPlaceholders: new Map(),
		deferredReadExecutions: new Map(),
		chatContainer: new RetainedContainer(),
		ui: tui,
	});
	const deliver = (type: "toolcall_start" | "toolcall_delta" | "toolcall_end", generation?: string): void => {
		const toolCall = { type: "toolCall", id: "tool-1", name: "streamed", arguments: args } as Record<string, unknown>;
		if (generation !== undefined) toolCall.partialArgs = generation;
		const message = {
			role: "assistant",
			api: "openai-completions",
			provider: "openai",
			model: "test",
			content: [toolCall],
			timestamp: 0,
		};
		(mode as unknown as { handleEvent(event: unknown): void }).handleEvent({
			type: "message_update",
			message,
			assistantMessageEvent: type === "toolcall_delta"
				? { type, contentIndex: 0, delta: generation, partial: message }
				: type === "toolcall_end"
					? { type, contentIndex: 0, toolCall, partial: message }
					: { type, contentIndex: 0, partial: message },
		});
	};
	deliver("toolcall_start", "");
	args.nested.value = 1;
	deliver("toolcall_delta", "{\"nested\":");
	args.nested.value = 2;
	deliver("toolcall_delta", "{\"nested\":{\"value\":2}}");
	args.nested.value = 3;
	deliver("toolcall_end");
	assert.equal(metrics.toolArgsGenerationUpdates, 3);
	assert.equal(metrics.toolArgsMissingGenerationUpdates, 0);
	assert.match(tool.render(80).join("\n"), /"value": 3/);
});

test("tool finalization is scoped to its content index and does not repaint sibling tools", () => {
	initTheme("dark");
	const metricsA = createMetrics();
	const metricsB = createMetrics();
	const tui = createTui();
	const argsA = { value: "a" };
	const argsB = { value: "b" };
	const toolA = new ToolExecutionComponent("a", "tool-a", argsA, { allocationMetrics: metricsA }, undefined, tui, process.cwd());
	const toolB = new ToolExecutionComponent("b", "tool-b", argsB, { allocationMetrics: metricsB }, undefined, tui, process.cwd());
	const versionAdvances = new Map<Component, number>();
	const mode = Object.create(InteractiveMode.prototype) as InteractiveMode & Record<string, unknown>;
	Object.assign(mode, {
		isInitialized: true,
		footer: { invalidate(): void {} },
		streamingComponent: { updateContent(): void {} },
		streamingMessage: undefined,
		streamingItem: { updateVersion(): void {} },
		streamingItemVersion: 0,
		pendingTools: new Map([["tool-a", toolA], ["tool-b", toolB]]),
		streamedToolIds: new Set(["tool-a", "tool-b"]),
		deferredReadPlaceholders: new Map(),
		deferredReadExecutions: new Map(),
		chatContainer: new RetainedContainer(),
		ui: tui,
		advanceActiveToolVersion(component: Component): void {
			versionAdvances.set(component, (versionAdvances.get(component) ?? 0) + 1);
		},
	});
	const content = [
		{ type: "toolCall", id: "tool-a", name: "a", arguments: argsA },
		{ type: "toolCall", id: "tool-b", name: "b", arguments: argsB, partialArgs: "b:1" },
	];
	const message = {
		role: "assistant",
		api: "openai-completions",
		provider: "openai",
		model: "test",
		content,
		timestamp: 0,
	};
	(mode as unknown as { handleEvent(event: unknown): void }).handleEvent({
		type: "message_update",
		message,
		assistantMessageEvent: { type: "toolcall_end", contentIndex: 0, toolCall: content[0], partial: message },
	});
	assert.equal(metricsA.updateDisplayCalls, 2);
	assert.equal(metricsB.updateDisplayCalls, 1, "B must not receive A's event generation");
	assert.equal(metricsA.toolArgsFinalizations, 1);
	assert.equal(metricsB.toolArgsFinalizations, 0);
	assert.equal(versionAdvances.get(toolA), 1);
	assert.equal(versionAdvances.get(toolB), undefined);

	for (let update = 2; update <= 20; update++) {
		argsB.value = `b:${update}`;
		content[1]!.partialArgs = `b:${update}`;
		(mode as unknown as { handleEvent(event: unknown): void }).handleEvent({
			type: "message_update",
			message,
			assistantMessageEvent: { type: "toolcall_delta", contentIndex: 1, delta: String(update), partial: message },
		});
	}
	assert.equal(metricsA.updateDisplayCalls, 2, "finished A must not rebuild for B deltas");
	assert.equal(versionAdvances.get(toolA), 1, "finished A retained version must not advance for B deltas");
	assert.equal(metricsA.toolArgsMissingGenerationUpdates, 0);
	assert.equal(metricsB.updateDisplayCalls, 20);
	delete content[1]!.partialArgs;
	(mode as unknown as { handleEvent(event: unknown): void }).handleEvent({
		type: "message_update",
		message,
		assistantMessageEvent: { type: "toolcall_end", contentIndex: 1, toolCall: content[1], partial: message },
	});
	assert.equal(metricsA.toolArgsFinalizations, 1);
	assert.equal(metricsB.toolArgsFinalizations, 1);
	assert.equal(metricsB.toolArgsMissingGenerationUpdates, 0);
	assert.match(toolB.render(80).join("\n"), /b:20/);
});

test("custom tool generations are scoped independently by content index", () => {
	initTheme("dark");
	const metricsA = createMetrics();
	const metricsB = createMetrics();
	const tui = createTui();
	const argsA = { nested: { value: "a:0" } };
	const argsB = { nested: { value: "b:0" } };
	const toolA = new ToolExecutionComponent("a", "tool-a", argsA, { allocationMetrics: metricsA }, undefined, tui, process.cwd());
	const toolB = new ToolExecutionComponent("b", "tool-b", argsB, { allocationMetrics: metricsB }, undefined, tui, process.cwd());
	const versionAdvances = new Map<Component, number>();
	const mode = Object.create(InteractiveMode.prototype) as InteractiveMode & Record<string, unknown>;
	Object.assign(mode, {
		isInitialized: true,
		footer: { invalidate(): void {} },
		streamingComponent: { updateContent(): void {} },
		streamingMessage: undefined,
		streamingItem: { updateVersion(): void {} },
		streamingItemVersion: 0,
		pendingTools: new Map([["tool-a", toolA], ["tool-b", toolB]]),
		streamedToolIds: new Set(["tool-a", "tool-b"]),
		deferredReadPlaceholders: new Map(),
		deferredReadExecutions: new Map(),
		chatContainer: new RetainedContainer(),
		ui: tui,
		advanceActiveToolVersion(component: Component): void {
			versionAdvances.set(component, (versionAdvances.get(component) ?? 0) + 1);
		},
	});
	const content = [
		{ type: "toolCall", id: "tool-a", name: "a", arguments: argsA },
		{ type: "toolCall", id: "tool-b", name: "b", arguments: argsB },
	];
	const message = {
		role: "assistant",
		api: "openai-completions",
		provider: "openai",
		model: "test",
		content,
		timestamp: 0,
	};
	const deliver = (contentIndex: number, generation: number, value: string): void => {
		const args = contentIndex === 0 ? argsA : argsB;
		args.nested.value = value;
		(mode as unknown as { handleEvent(event: unknown): void }).handleEvent({
			type: "message_update",
			message,
			assistantMessageEvent: {
				type: "toolcall_delta",
				contentIndex,
				delta: value,
				partial: message,
				toolArgsGeneration: generation,
			},
		});
	};

	deliver(0, 1, "a:1");
	assert.equal(metricsA.toolArgsGenerationUpdates, 1);
	assert.equal(metricsB.toolArgsGenerationUpdates, 0);
	deliver(1, 1, "b:1");
	assert.equal(metricsA.toolArgsGenerationUpdates, 1);
	assert.equal(metricsB.toolArgsGenerationUpdates, 1, "B generation 1 is independent from A generation 1");
	deliver(0, 2, "a:2");
	deliver(1, 1, "b:1");
	deliver(0, 3, "a:3");
	deliver(1, 2, "b:2");

	assert.equal(metricsA.toolArgsGenerationUpdates, 3);
	assert.equal(metricsB.toolArgsGenerationUpdates, 2);
	assert.equal(metricsA.toolArgsMissingGenerationUpdates + metricsB.toolArgsMissingGenerationUpdates, 0);
	assert.equal(metricsA.toolArgsSemanticFallbackComparisons + metricsB.toolArgsSemanticFallbackComparisons, 0);
	assert.equal(versionAdvances.get(toolA), 3);
	assert.equal(versionAdvances.get(toolB), 2, "same generation does not advance retained version");
	assert.match(toolA.render(80).join("\n"), /a:3/);
	assert.match(toolB.render(80).join("\n"), /b:2/);
});

test("latest delivery can create and finalize a tool when its first observed event is toolcall_end", async () => {
	initTheme("dark");
	const tui = createTui();
	const metricsA = createMetrics();
	const versionAdvances = new Map<Component, number>();
	const mode = Object.create(InteractiveMode.prototype) as InteractiveMode & Record<string, unknown>;
	const originalAdvance = (InteractiveMode.prototype as unknown as {
		advanceActiveToolVersion(component: Component): void;
	}).advanceActiveToolVersion;
	Object.assign(mode, {
		isInitialized: true,
		footer: { invalidate(): void {} },
		streamingComponent: { updateContent(): void {} },
		streamingMessage: undefined,
		streamingItem: { updateVersion(): void {} },
		streamingItemVersion: 0,
		nextTranscriptItemNumber: 0,
		pendingTools: new Map(),
		streamedToolIds: new Set(),
		deferredReadPlaceholders: new Map(),
		deferredReadExecutions: new Map(),
		chatContainer: new RetainedContainer(),
		runtimeHost: {
			session: {
				getToolDefinition: () => undefined,
				settingsManager: { getShowImages: () => true, getImageWidthCells: () => undefined },
				sessionManager: { getCwd: () => process.cwd() },
			},
		},
		createToolExecutionComponent(toolName: string, toolCallId: string, args: unknown): ToolExecutionComponent {
			return new ToolExecutionComponent(toolName, toolCallId, args, { allocationMetrics: metricsA }, undefined, tui, process.cwd());
		},
		ui: tui,
		advanceActiveToolVersion(component: Component): void {
			versionAdvances.set(component, (versionAdvances.get(component) ?? 0) + 1);
			originalAdvance.call(mode, component);
		},
	});
	const agent = new Agent({ streamFn: (() => { throw new Error("unused"); }) as never });
	(agent as unknown as { activeRun: unknown }).activeRun = {
		promise: Promise.resolve(),
		resolve(): void {},
		abortController: new AbortController(),
	};
	const observed: string[] = [];
	agent.subscribeObserver((event) => {
		if (event.type !== "message_update") return;
		observed.push(event.assistantMessageEvent.type);
		(mode as unknown as { handleEvent(event: unknown): void }).handleEvent(event);
	}, { minIntervalMs: 60_000 });
	const processEvent = (event: unknown): Promise<void> =>
		(agent as unknown as { processEvents(event: unknown): Promise<void> }).processEvents(event);
	const argsA = { value: "a:0" };
	const message = {
		role: "assistant",
		api: "openai-completions",
		provider: "openai",
		model: "test",
		content: [{ type: "toolCall", id: "tool-a", name: "a", arguments: argsA }],
		timestamp: 0,
	};
	await processEvent({
		type: "message_update",
		message,
		assistantMessageEvent: { type: "toolcall_start", contentIndex: 0, partial: message },
	});
	argsA.value = "a:1";
	await processEvent({
		type: "message_update",
		message,
		assistantMessageEvent: { type: "toolcall_delta", contentIndex: 0, delta: "a:1", partial: message, toolArgsGeneration: 1 },
	});
	argsA.value = "a:final";
	await processEvent({
		type: "message_update",
		message,
		assistantMessageEvent: { type: "toolcall_end", contentIndex: 0, toolCall: message.content[0], partial: message },
	});
	await (agent as unknown as { eventDelivery: { flushAllLatest(): Promise<void> } }).eventDelivery.flushAllLatest();
	assert.deepEqual(observed, ["toolcall_end"]);
	const pendingTools = (mode as unknown as { pendingTools: Map<string, ToolExecutionComponent> }).pendingTools;
	const toolA = pendingTools.get("tool-a");
	assert.ok(toolA);
	assert.equal(metricsA.toolArgsFinalizations, 1);
	assert.equal(metricsA.toolArgsMissingGenerationUpdates, 0);
	assert.match(toolA.render(80).join("\n"), /a:final/);
	assert.equal(versionAdvances.get(toolA), 1, "first end finalizes and advances exactly once");

	const textMessage = { ...message, content: [{ type: "text", text: "after" }] };
	await processEvent({
		type: "message_update",
		message: textMessage,
		assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "after", partial: textMessage },
	});
	const argsB = { value: "b:1" };
	const siblingMessage = { ...message, content: [message.content[0], { type: "toolCall", id: "tool-b", name: "b", arguments: argsB }] };
	await processEvent({
		type: "message_update",
		message: siblingMessage,
		assistantMessageEvent: { type: "toolcall_delta", contentIndex: 1, delta: "b:1", partial: siblingMessage, toolArgsGeneration: 1 },
	});
	await (agent as unknown as { eventDelivery: { flushAllLatest(): Promise<void> } }).eventDelivery.flushAllLatest();
	assert.equal(versionAdvances.get(toolA), 1, "text and sibling deliveries do not advance a finalized tool");
	assert.equal(metricsA.toolArgsFinalizations, 1);
	assert.equal(agent.eventDeliveryStats.pendingKeys, 0);
	await (agent as unknown as { eventDelivery: { dispose(): Promise<void> } }).eventDelivery.dispose();
});

test("Agent keeps interleaved tool metadata on one bounded message latest lane", async () => {
	initTheme("dark");
	const events: string[] = [];
	const metricsA = createMetrics();
	const metricsB = createMetrics();
	const tui = createTui();
	const toolA = new ToolExecutionComponent("a", "tool-a", {}, { allocationMetrics: metricsA }, undefined, tui, process.cwd());
	const toolB = new ToolExecutionComponent("b", "tool-b", {}, { allocationMetrics: metricsB }, undefined, tui, process.cwd());
	const mode = Object.create(InteractiveMode.prototype) as InteractiveMode & Record<string, unknown>;
	Object.assign(mode, {
		isInitialized: true,
		footer: { invalidate(): void {} },
		streamingComponent: { updateContent(): void {} },
		streamingMessage: undefined,
		streamingItem: { updateVersion(): void {} },
		streamingItemVersion: 0,
		pendingTools: new Map([["tool-a", toolA], ["tool-b", toolB]]),
		streamedToolIds: new Set(["tool-a", "tool-b"]),
		deferredReadPlaceholders: new Map(),
		deferredReadExecutions: new Map(),
		chatContainer: new RetainedContainer(),
		ui: tui,
	});
	const agent = new Agent({ streamFn: (() => { throw new Error("unused"); }) as never });
	(agent as unknown as { activeRun: unknown }).activeRun = {
		promise: Promise.resolve(),
		resolve(): void {},
		abortController: new AbortController(),
	};
	agent.subscribeObserver((event) => {
		if (event.type === "message_update") {
			events.push(event.assistantMessageEvent.type);
			(mode as unknown as { handleEvent(event: unknown): void }).handleEvent(event);
		}
	}, { minIntervalMs: 60_000 });
	const processEvent = (event: unknown): Promise<void> =>
		(agent as unknown as { processEvents(event: unknown): Promise<void> }).processEvents(event);
	const message = {
		role: "assistant",
		api: "openai-completions",
		provider: "openai",
		model: "test",
		content: [
			{ type: "toolCall", id: "tool-a", name: "a", arguments: {} },
			{ type: "toolCall", id: "tool-b", name: "b", arguments: { value: "b:1" }, partialArgs: "b:1" },
		],
		timestamp: 0,
	};
	await processEvent({
		type: "message_update",
		message,
		assistantMessageEvent: { type: "toolcall_end", contentIndex: 0, toolCall: message.content[0], partial: message },
	});
	message.content[1]!.partialArgs = "b:2";
	message.content[1]!.arguments.value = "b:2";
	await processEvent({
		type: "message_update",
		message,
		assistantMessageEvent: { type: "toolcall_delta", contentIndex: 1, delta: "2", partial: message },
	});
	message.content[1]!.partialArgs = "b:3";
	message.content[1]!.arguments.value = "b:3";
	await processEvent({
		type: "message_update",
		message,
		assistantMessageEvent: { type: "toolcall_delta", contentIndex: 1, delta: "3", partial: message },
	});
	await (agent as unknown as { eventDelivery: { flushAllLatest(): Promise<void> } }).eventDelivery.flushAllLatest();
	assert.deepEqual(events, ["toolcall_delta"]);
	assert.equal(agent.eventDeliveryStats.pendingKeys, 0);
	assert.equal(agent.eventDeliveryStats.maxPendingKeys, 1);
	assert.equal(agent.eventDeliveryStats.coalesced, 2);
	assert.equal(metricsA.toolArgsFinalizations, 1);
	assert.equal(metricsA.toolArgsMissingGenerationUpdates, 0);
	assert.equal(metricsB.toolArgsFinalizations, 0);
	assert.equal(metricsB.toolArgsMissingGenerationUpdates, 0);
	assert.match(toolB.render(80).join("\n"), /b:3/);
	delete message.content[1]!.partialArgs;
	await processEvent({
		type: "message_update",
		message,
		assistantMessageEvent: { type: "toolcall_end", contentIndex: 1, toolCall: message.content[1], partial: message },
	});
	await (agent as unknown as { eventDelivery: { flushAllLatest(): Promise<void> } }).eventDelivery.flushAllLatest();
	assert.equal(metricsA.toolArgsFinalizations, 1);
	assert.equal(metricsB.toolArgsFinalizations, 1);
	assert.equal(agent.eventDeliveryStats.pendingKeys, 0);
	assert.equal((agent as unknown as { pendingChangedToolUpdates: Map<string, unknown> }).pendingChangedToolUpdates.size, 0);
});

test("slow observers retain every changed tool after faster message snapshots", async () => {
	initTheme("dark");
	const scheduler = new FakeScheduler();
	const metricsA = createMetrics();
	const metricsB = createMetrics();
	let snapshots = 0;
	let pendingMetadataHwm = 0;
	const tui = createTui();
	const toolA = new ToolExecutionComponent("a", "tool-a", {}, { allocationMetrics: metricsA }, undefined, tui, process.cwd());
	const toolB = new ToolExecutionComponent("b", "tool-b", {}, { allocationMetrics: metricsB }, undefined, tui, process.cwd());
	const mode = Object.create(InteractiveMode.prototype) as InteractiveMode & Record<string, unknown>;
	Object.assign(mode, {
		isInitialized: true,
		footer: { invalidate(): void {} },
		streamingComponent: { updateContent(): void {} },
		streamingMessage: undefined,
		streamingItem: { updateVersion(): void {} },
		streamingItemVersion: 0,
		pendingTools: new Map([["tool-a", toolA], ["tool-b", toolB]]),
		streamedToolIds: new Set(["tool-a", "tool-b"]),
		deferredReadPlaceholders: new Map(),
		deferredReadExecutions: new Map(),
		chatContainer: new RetainedContainer(),
		ui: tui,
	});
	const agent = new Agent({
		streamFn: (() => { throw new Error("unused"); }) as never,
		eventInstrumentation: {
			onAssistantSnapshot(): void { snapshots++; },
			onPendingToolMetadata(pending): void {
				if (pending > pendingMetadataHwm) pendingMetadataHwm = pending;
			},
		},
	});
	(agent as unknown as { activeRun: unknown }).activeRun = {
		promise: Promise.resolve(),
		resolve(): void {},
		abortController: new AbortController(),
	};
	const dispatcher = new AgentTestDeliveryDispatcher(agent as unknown as {
		snapshotObserverEvent(value: unknown): unknown;
		releaseObserverEvent(key: string, value: unknown): void;
	}, scheduler);
	(agent as unknown as { eventDelivery: EventDeliveryDispatcher<unknown, string> }).eventDelivery = dispatcher;
	const advance = async (durationMs: number): Promise<void> => {
		scheduler.advanceBy(durationMs);
		const flush = (dispatcher as unknown as { flushPromise?: Promise<void> }).flushPromise;
		if (flush) await flush;
	};
	let fastDeliveries = 0;
	let slowDeliveries = 0;
	dispatcher.subscribe(() => { fastDeliveries++; }, { delivery: "latest", minIntervalMs: 0 });
	dispatcher.subscribe((event) => {
		slowDeliveries++;
		(mode as unknown as { handleEvent(value: unknown): void }).handleEvent(event);
	}, { delivery: "latest", minIntervalMs: 16 });
	const message = {
		role: "assistant",
		api: "openai-completions",
		provider: "fixture",
		model: "fixture",
		content: [
			{ type: "toolCall", id: "tool-a", name: "a", arguments: { value: "a:1" }, partialArgs: "a:1" },
			{ type: "toolCall", id: "tool-b", name: "b", arguments: { value: "b:1" }, partialArgs: "b:1" },
		],
		timestamp: 0,
	};
	const processEvent = (
		contentIndex: number,
		type: "toolcall_delta" | "toolcall_end",
		generation?: number,
	): Promise<void> => (
		agent as unknown as { processEvents(event: unknown): Promise<void> }
	).processEvents({
		type: "message_update",
		message,
		assistantMessageEvent: {
			type,
			contentIndex,
			delta: contentIndex === 0 ? "a:1" : "b:1",
			toolCall: type === "toolcall_end" ? message.content[contentIndex] : undefined,
			partial: message,
			toolArgsGeneration: generation,
		},
	});

	await processEvent(0, "toolcall_delta", 1);
	await advance(0);
	await processEvent(1, "toolcall_delta", 1);
	await advance(0);
	await advance(16);
	await dispatcher.flushAllLatest();

	assert.equal(fastDeliveries, 2);
	assert.equal(slowDeliveries, 1);
	assert.equal(metricsA.toolArgsGenerationUpdates, 1);
	assert.equal(metricsB.toolArgsGenerationUpdates, 1);
	assert.equal(snapshots, 2, "fast and slow observers share one snapshot for each pending version");
	assert.equal(pendingMetadataHwm, 2);
	assert.match(toolA.render(80).join("\n"), /a:1/);
	assert.match(toolB.render(80).join("\n"), /b:1/);
	assert.equal((agent as unknown as { pendingChangedToolUpdates: Map<string, unknown> }).pendingChangedToolUpdates.size, 0);
	assert.equal(dispatcher.stats.pendingKeys, 0);
	assert.equal(scheduler.pendingTasks, 0);

	await processEvent(0, "toolcall_end");
	await advance(0);
	message.content[1]!.arguments.value = "b:2";
	message.content[1]!.partialArgs = "b:2";
	await processEvent(1, "toolcall_delta", 2);
	await advance(0);
	await advance(16);
	await dispatcher.flushAllLatest();

	assert.equal(fastDeliveries, 4);
	assert.equal(slowDeliveries, 2);
	assert.equal(metricsA.toolArgsFinalizations, 1);
	assert.equal(metricsB.toolArgsGenerationUpdates, 2);
	assert.equal(snapshots, 4, "sticky finalization and the sibling delta each create one shared version snapshot");
	assert.equal(metricsA.toolArgsMissingGenerationUpdates, 0);
	assert.equal(metricsB.toolArgsMissingGenerationUpdates, 0);
	assert.match(toolB.render(80).join("\n"), /b:2/);
	assert.equal((agent as unknown as { pendingChangedToolUpdates: Map<string, unknown> }).pendingChangedToolUpdates.size, 0);
	assert.equal(scheduler.pendingTasks, 0);
});

test("one AgentSession delivery updates every changed tool from one large message snapshot", async () => {
	initTheme("dark");
	for (const toolCount of [1, 2, 4, 8, 16]) {
		let snapshots = 0;
		let pendingMetadataHwm = 0;
		let pendingMetadataAfterFlush = -1;
		let agentSessionDeliveries = 0;
		let interactiveDeliveries = 0;
		let streamingUpdates = 0;
		let streamingVersions = 0;
		let requestRenders = 0;
		let extensionPublishes = 0;
		const metrics = Array.from({ length: toolCount }, () => createMetrics());
		const pendingTools = new Map<string, ToolExecutionComponent>();
		const content: Array<Record<string, unknown>> = [{ type: "text", text: "m".repeat(64 * 1024) }];
		const tui = { requestRender(): void { requestRenders++; } } as TUI;
		for (let index = 0; index < toolCount; index++) {
			const args = { value: `${index}:`.padEnd(4 * 1024, "a") };
			content.push({
				type: "toolCall",
				id: `tool-${index}`,
				name: `tool-${index}`,
				arguments: args,
				partialArgs: `generation-${index}`,
			});
			pendingTools.set(
				`tool-${index}`,
				new ToolExecutionComponent(
					`tool-${index}`,
					`tool-${index}`,
					args,
					{ allocationMetrics: metrics[index] },
					undefined,
					tui,
					process.cwd(),
				),
			);
			metrics[index]!.updateDisplayCalls = 0;
		}
		const message = {
			role: "assistant",
			api: "openai-completions",
			provider: "fixture",
			model: "fixture",
			content,
			timestamp: 0,
		};
		const mode = Object.create(InteractiveMode.prototype) as InteractiveMode & Record<string, unknown>;
		Object.assign(mode, {
			isInitialized: true,
			footer: { invalidate(): void {} },
			streamingComponent: { updateContent(): void { streamingUpdates++; } },
			streamingMessage: message,
			streamingItem: { updateVersion(): void { streamingVersions++; } },
			streamingItemVersion: 0,
			pendingTools,
			streamedToolIds: new Set(pendingTools.keys()),
			deferredReadPlaceholders: new Map(),
			deferredReadExecutions: new Map(),
			chatContainer: new RetainedContainer(),
			ui: tui,
			advanceActiveToolVersion(): void {},
		});
		const session = Object.create(AgentSession.prototype) as AgentSession & Record<string, unknown>;
		Object.assign(session, {
			_eventListeners: [{
				listener(event: unknown): void {
					agentSessionDeliveries++;
					interactiveDeliveries++;
					(mode as unknown as { handleEvent(event: unknown): void }).handleEvent(event);
				},
				criticalAgentEnd: false,
				observeRejection(error: unknown): void { throw error; },
			}],
			_extensionObserverDelivery: {
				publishLatest(): void { extensionPublishes++; },
			},
		});
		const agent = new Agent({
			streamFn: (() => { throw new Error("unused"); }) as never,
			eventInstrumentation: {
				onAssistantSnapshot(): void { snapshots++; },
				onPendingToolMetadata(pending): void {
					if (pending > pendingMetadataHwm) pendingMetadataHwm = pending;
					pendingMetadataAfterFlush = pending;
				},
			},
		});
		(agent as unknown as { activeRun: unknown }).activeRun = {
			promise: Promise.resolve(),
			resolve(): void {},
			abortController: new AbortController(),
		};
		agent.subscribeObserver((event) => {
			(session as unknown as { _handleAgentObserverEvent(event: unknown): void })._handleAgentObserverEvent(event);
		}, { minIntervalMs: 60_000 });
		const processEvent = (event: unknown): Promise<void> =>
			(agent as unknown as { processEvents(event: unknown): Promise<void> }).processEvents(event);
		for (let index = 0; index < toolCount; index++) {
			await processEvent({
				type: "message_update",
				message,
				assistantMessageEvent: {
					type: "toolcall_delta",
					contentIndex: index + 1,
					delta: `generation-${index}`,
					partial: message,
				},
			});
		}
		await (agent as unknown as { eventDelivery: { flushAllLatest(): Promise<void> } }).eventDelivery.flushAllLatest();

		assert.equal(snapshots, 1, `${toolCount}: full message snapshots`);
		assert.equal(agentSessionDeliveries, 1, `${toolCount}: AgentSession deliveries`);
		assert.equal(interactiveDeliveries, 1, `${toolCount}: InteractiveMode deliveries`);
		assert.equal(streamingUpdates, 1, `${toolCount}: streaming component updates`);
		assert.equal(streamingVersions, 1, `${toolCount}: streaming retained versions`);
		assert.equal(requestRenders, 1, `${toolCount}: requestRender calls`);
		assert.equal(extensionPublishes, 1, `${toolCount}: extension latest publishes`);
		assert.equal(metrics.reduce((total, item) => total + item.updateDisplayCalls, 0), toolCount);
		assert.equal(pendingMetadataHwm <= toolCount, true);
		assert.equal(pendingMetadataAfterFlush, 0);
		assert.equal(agent.eventDeliveryStats.pendingKeys, 0);
		await (agent as unknown as { eventDelivery: { dispose(): Promise<void> } }).eventDelivery.dispose();
	}
});

test("Anthropic wire start delta delta end sequence satisfies the mutation ownership contract", async () => {
	initTheme("dark");
	const rawEvents: Array<[string, Record<string, unknown>]> = [
		["message_start", { type: "message_start", message: { id: "m1", usage: { input_tokens: 1, output_tokens: 0 } } }],
		["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "call-1", name: "lookup", input: {} } }],
		["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "{\"nested\":" } }],
		["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "{\"value\":3}}" } }],
		["content_block_stop", { type: "content_block_stop", index: 0 }],
		["message_delta", { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 2 } }],
		["message_stop", { type: "message_stop" }],
	];
	let body = "";
	for (const [event, data] of rawEvents) body += `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
	const response = new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
	const client = { messages: { create: () => ({ asResponse: async () => response }) } };
	const model = {
		id: "test", name: "test", api: "anthropic-messages", provider: "anthropic",
		baseUrl: "https://example.invalid", reasoning: false, input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1000, maxTokens: 100,
	};
	const metrics = createMetrics();
	const tui = createTui();
	const pendingTools = new Map<string, ToolExecutionComponent>();
	const mode = Object.create(InteractiveMode.prototype) as InteractiveMode & Record<string, unknown>;
	Object.assign(mode, {
		isInitialized: true,
		footer: { invalidate(): void {} },
		streamingComponent: { updateContent(): void {} },
		streamingMessage: undefined,
		streamingItem: { updateVersion(): void {} },
		streamingItemVersion: 0,
		pendingTools,
		streamedToolIds: new Set(["call-1"]),
		deferredReadPlaceholders: new Map(),
		deferredReadExecutions: new Map(),
		chatContainer: new RetainedContainer(),
		ui: tui,
	});
	let tool: ToolExecutionComponent | undefined;
	for await (const event of streamAnthropic(
		model as never,
		{ systemPrompt: "", messages: [], tools: [] },
		{ client } as never,
	)) {
		if (event.type !== "toolcall_start" && event.type !== "toolcall_delta" && event.type !== "toolcall_end") continue;
		const block = event.partial.content[event.contentIndex];
		assert.equal(block?.type, "toolCall");
		if (!tool) {
			tool = new ToolExecutionComponent("lookup", "call-1", block.arguments, { allocationMetrics: metrics }, undefined, tui, process.cwd());
			pendingTools.set("call-1", tool);
		}
		(mode as unknown as { handleEvent(event: unknown): void }).handleEvent({
			type: "message_update",
			message: event.partial,
			assistantMessageEvent: event,
		});
	}
	assert.ok(tool);
	assert.equal(metrics.toolArgsGenerationUpdates, 3);
	assert.equal(metrics.toolArgsMissingGenerationUpdates, 0);
	assert.match(tool.render(80).join("\n"), /"value": 3/);
});
