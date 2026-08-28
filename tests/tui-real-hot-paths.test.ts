import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
	getStreamedToolArgumentOwnership,
	type AssistantMessage,
	type KnownApi,
} from "@super-pi/ai/compat";
import {
	AssistantMessageComponent,
	type AssistantMessageAllocationMetrics,
} from "../packages/coding-agent/src/modes/interactive/components/assistant-message.ts";
import {
	createInteractiveTuiReference,
	InteractiveMode,
} from "../packages/coding-agent/src/modes/interactive/interactive-mode.ts";
import {
	ToolExecutionComponent,
	type ToolExecutionAllocationMetrics,
} from "../packages/coding-agent/src/modes/interactive/components/tool-execution.ts";
import { getMarkdownTheme, initTheme } from "../packages/coding-agent/src/modes/interactive/theme/theme.ts";
import type { MarkdownTransformer, ToolDefinition } from "../packages/coding-agent/src/core/extensions/types.ts";
import { Input } from "../packages/tui/src/components/input.ts";
import { RetainedContainer, RetainedItem } from "../packages/tui/src/components/retained-item.ts";
import { getCapabilities, setCapabilities } from "../packages/tui/src/terminal-image.ts";
import { Text } from "../packages/tui/src/components/text.ts";
import { Container, type Component, type OverlayHandle, type TUI, type TuiInputListener } from "../packages/tui/src/tui.ts";

initTheme("dark");

test("nested base containers append into one caller-owned result without bypassing render overrides", () => {
	const root = new Container();
	const firstNested = new Container();
	const secondNested = new Container();
	firstNested.addChild(new Text("first", 0, 0));
	secondNested.addChild(new Text("second", 0, 0));
	firstNested.addChild(secondNested);
	root.addChild(firstNested);

	const first = root.render(80);
	const expected = ["first".padEnd(80), "second".padEnd(80)];
	assert.deepEqual(first, expected);
	const second = root.render(80);
	assert.notEqual(second, first);
	assert.deepEqual(first, expected, "the next render must not mutate the caller-owned prior result");

	class DecoratedContainer extends Container {
		render(width: number): string[] {
			const decorated = super.render(width);
			decorated.unshift("before");
			decorated.push("after");
			return decorated;
		}
	}
	const decorated = new DecoratedContainer();
	decorated.addChild(new Text("body", 0, 0));
	root.clear();
	root.addChild(decorated);
	assert.deepEqual(root.render(80), ["before", "body".padEnd(80), "after"]);
});

function createTuiHarness(name: string): TUI & {
	requestRenderCalls: number;
	renderNowCalls: number;
	invalidateCalls: number;
	removedListeners: TuiInputListener[];
	stopResult: Promise<void>;
	disposeResult: Promise<void>;
	flushResult: Promise<void>;
	overlayHandle: OverlayHandle;
} {
	const listeners = new Set<TuiInputListener>();
	const stopResult = Promise.resolve();
	const disposeResult = Promise.resolve();
	const flushResult = Promise.resolve();
	const overlayHandle: OverlayHandle = {
		hide(): void {},
		setHidden(): void {},
		isHidden(): boolean { return false; },
		focus(): void {},
		unfocus(): void {},
		isFocused(): boolean { return false; },
	};
	return {
		mode: name === "main" ? "regular" : "fullscreen",
		children: [],
		terminal: { name } as never,
		onDebug: undefined,
		fullRedraws: 0,
		requestRenderCalls: 0,
		renderNowCalls: 0,
		invalidateCalls: 0,
		removedListeners: [],
		stopResult,
		disposeResult,
		flushResult,
		overlayHandle,
		addChild(component: Component): void { this.children.push(component); },
		removeChild(component: Component): void {
			const index = this.children.indexOf(component);
			if (index >= 0) this.children.splice(index, 1);
		},
		clear(): void { this.children.length = 0; },
		invalidate(): void { this.invalidateCalls++; },
		render(): string[] { return []; },
		getShowHardwareCursor(): boolean { return false; },
		setShowHardwareCursor(): void {},
		getClearOnShrink(): boolean { return true; },
		setClearOnShrink(): void {},
		setRenderInstrumentation(): void {},
		setFocus(): void {},
		showOverlay(): OverlayHandle { return this.overlayHandle; },
		hideOverlay(): void {},
		hasOverlay(): boolean { return false; },
		start(): void {},
		stop(): Promise<void> { return this.stopResult; },
		dispose(): Promise<void> { return this.disposeResult; },
		renderNow(): void { this.renderNowCalls++; },
		requestRender(): void { this.requestRenderCalls++; },
		flushTerminalFrames(): Promise<void> { return this.flushResult; },
		addInputListener(listener: TuiInputListener): () => void {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		removeInputListener(listener: TuiInputListener): void {
			listeners.delete(listener);
			this.removedListeners.push(listener);
		},
		onTerminalColorSchemeChange(): () => void { return () => {}; },
		setTerminalColorSchemeNotifications(): void {},
		async queryTerminalBackgroundColor(): Promise<undefined> { return undefined; },
		async queryTerminalColorScheme(): Promise<undefined> { return undefined; },
	};
}

test("Interactive TUI reference exposes one stable method and follows renderer switches", () => {
	const main = createTuiHarness("main");
	const alt = createTuiHarness("alt");
	let current: TUI = main;
	const reference = createInteractiveTuiReference(() => current);
	const capturedRequestRender = reference.requestRender;
	const capturedRenderNow = reference.renderNow;
	const capturedInvalidate = reference.invalidate;

	assert.equal(reference.requestRender, capturedRequestRender);
	assert.equal(reference.requestRender, reference.requestRender);
	assert.equal(reference.renderNow, capturedRenderNow);
	assert.equal(reference.invalidate, capturedInvalidate);
	capturedRequestRender();
	current = alt;
	capturedRequestRender();
	capturedRenderNow();
	capturedInvalidate();
	assert.equal(main.requestRenderCalls, 1);
	assert.equal(alt.requestRenderCalls, 1);
	assert.equal(main.renderNowCalls, 0);
	assert.equal(alt.renderNowCalls, 1);
	assert.equal(main.invalidateCalls, 0);
	assert.equal(alt.invalidateCalls, 1);
	assert.equal(reference.mode, "fullscreen");
	assert.equal(reference.terminal, alt.terminal);
	assert.equal(reference.children, alt.children);
	assert.equal(reference.showOverlay(main), alt.overlayHandle);
	assert.equal(reference.stop(), alt.stopResult);
	assert.equal(reference.dispose(), alt.disposeResult);
	assert.equal(reference.flushTerminalFrames(), alt.flushResult);
	const onDebug = (): void => {};
	const replacementTerminal = { name: "replacement" } as never;
	reference.onDebug = onDebug;
	reference.terminal = replacementTerminal;
	reference.children = [main as unknown as Component];
	assert.equal(alt.onDebug, onDebug);
	assert.equal(alt.terminal, replacementTerminal);
	assert.equal(alt.children[0], main);
});

test("Interactive TUI reference creates no method wrappers after initialization", () => {
	const current = createTuiHarness("main");
	const reference = createInteractiveTuiReference(() => current);
	const methods = new Set<unknown>();
	for (let index = 0; index < 100_000; index++) methods.add(reference.requestRender);
	assert.equal(methods.size, 1);
	for (const property of Object.keys(reference)) {
		const first = (reference as unknown as Record<string, unknown>)[property];
		if (typeof first !== "function") continue;
		for (let index = 0; index < 100; index++) {
			assert.equal((reference as unknown as Record<string, unknown>)[property], first, property);
		}
	}
	assert.doesNotMatch(
		readFileSync("packages/coding-agent/src/modes/interactive/interactive-mode.ts", "utf8"),
		/new Proxy\(|getPrototypeOf:\s*\(|return \(\.\.\.args: unknown\[\]\)/,
	);
});

test("stable TUI listener forwarding preserves listener identity", () => {
	const current = createTuiHarness("main");
	const reference = createInteractiveTuiReference(() => current);
	const listener: TuiInputListener = () => undefined;
	const remove = reference.removeInputListener;
	reference.addInputListener(listener);
	remove(listener);
	assert.deepEqual(current.removedListeners, [listener]);
});

test("stable TUI facade has no production prototype impersonation dependency", () => {
	const source = readFileSync("packages/coding-agent/src/modes/interactive/interactive-mode.ts", "utf8");
	assert.doesNotMatch(source, /this\.ui\s+instanceof\s+Tui(?:Main|Alt)Screen/);
	assert.doesNotMatch(source, /InteractiveTuiReference[\s\S]{0,120}getPrototypeOf/);
	assert.doesNotMatch(source, /createInteractiveTuiReference[\s\S]{0,120}Proxy/);
});

test("default retained items share one module-level context callback", () => {
	const component: Component = { render: () => ["line"], invalidate(): void {} };
	const callbacks = new Set<unknown>();
	let context: unknown;
	for (let index = 0; index < 100_000; index++) {
		const item = new RetainedItem(component, { id: `item-${index}`, version: 0 });
		const callback = (item as unknown as { getContext: () => unknown }).getContext;
		callbacks.add(callback);
		const nextContext = callback();
		context ??= nextContext;
		assert.equal(nextContext, context);
	}
	assert.equal(callbacks.size, 1);
});

test("Input grapheme hot paths avoid callback arrays and preserve Unicode clusters", () => {
	const source = readFileSync("packages/tui/src/components/input.ts", "utf8");
	assert.doesNotMatch(source, /\[\.\.\.data\]\.some\(/);
	assert.doesNotMatch(source, /\[\.\.\.segmenter\.segment\((?:beforeCursor|afterCursor)\)\]/);

	const input = new Input();
	input.handleInput("A");
	input.handleInput("中");
	input.handleInput("👨‍👩‍👧‍👦");
	input.handleInput("e\u0301");
	assert.equal(input.getValue(), "A中👨‍👩‍👧‍👦e\u0301");
	input.handleInput("\u001b[D");
	input.handleInput("\u007f");
	assert.equal(input.getValue(), "A中e\u0301");
	input.handleInput("\u001b[H");
	input.handleInput("\u001b[C");
	input.handleInput("\u001b[3~");
	assert.equal(input.getValue(), "Ae\u0301");
});

function toolMetrics(): ToolExecutionAllocationMetrics {
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
		toolArgsMissingGenerationDiagnostics: 0,
	};
}

test("ToolExecutionComponent preserves its call side and image tree across result-only updates", () => {
	const tui = createTuiHarness("main");
	const metrics = toolMetrics();
	let callRendererCalls = 0;
	let resultRendererCalls = 0;
	const renderContexts: unknown[] = [];
	const definition = {
		name: "stable-tool",
		label: "Stable tool",
		description: "test",
		parameters: { type: "object", properties: {} },
		async execute(): Promise<{ content: Array<{ type: "text"; text: string }>; details: undefined }> {
			return { content: [{ type: "text", text: "unused" }], details: undefined };
		},
		renderCall(args: { value: number }): Component {
			callRendererCalls++;
			return new Text(`call:${args.value}`, 0, 0);
		},
		renderResult(result: { content: Array<{ text?: string }> }, _options, _theme, context): Component {
			resultRendererCalls++;
			renderContexts.push(context);
			return new Text(result.content[0]?.text ?? "", 0, 0);
		},
	} as ToolDefinition<any, any>;
	const args = { value: 1 };
	const component = new ToolExecutionComponent(
		"stable-tool",
		"tool-1",
		args,
		{ allocationMetrics: metrics },
		definition,
		tui,
		process.cwd(),
	);
	callRendererCalls = 0;
	resultRendererCalls = 0;
	metrics.callRendererCalls = 0;
	metrics.resultRendererCalls = 0;
	metrics.renderContextObjects = 0;
	metrics.internalWrapperObjects = 0;
	metrics.argsSerializations = 0;
	metrics.toolArgsGenerationUpdates = 0;
	metrics.toolArgsReplacementUpdates = 0;
	metrics.toolArgsSemanticFallbackComparisons = 0;
	metrics.toolArgsMissingGenerationDiagnostics = 0;

	component.updateResult({ content: [{ type: "text", text: "one" }] }, true, false);
	component.updateResult({ content: [{ type: "text", text: "two" }] }, true, false);
	component.updateArgs(args, undefined, "replacement-object");
	assert.equal(callRendererCalls, 0);
	assert.equal(metrics.callRendererCalls, 0);
	assert.equal(resultRendererCalls, 2);
	assert.equal(metrics.resultRendererCalls, 2);
	assert.equal(metrics.renderContextObjects, 2);
	assert.equal(metrics.internalWrapperObjects, 4);
	assert.equal(metrics.argsSerializations, 0);
	assert.equal(new Set(renderContexts).size, 2, "extension-visible render contexts remain per-delivery values");

	const previousCapabilities = getCapabilities();
	try {
		setCapabilities({ ...previousCapabilities, images: "iterm2" });
		const imageResult = { content: [{ type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" }] };
		component.updateResult(imageResult, true, false);
		const state = component as unknown as { imageComponents: Component[]; imageSpacers: Component[] };
		const imageComponents = state.imageComponents;
		const imageSpacers = state.imageSpacers;
		const image = imageComponents[0];
		const spacer = imageSpacers[0];
		component.updateResult(imageResult, true, false);
		assert.equal(state.imageComponents, imageComponents);
		assert.equal(state.imageSpacers, imageSpacers);
		assert.equal(state.imageComponents[0], image);
		assert.equal(state.imageSpacers[0], spacer);
	} finally {
		setCapabilities(previousCapabilities);
	}

	component.setExpanded(true);
	component.updateResult({ content: [{ type: "text", text: "final" }] }, false, false);
	component.setExpanded(false);
	component.updateResult({ content: [{ type: "text", text: "error" }] }, false, true);
});

test("ToolExecutionComponent detects semantic tool arg changes without rebuilding unchanged args", () => {
	const tui = createTuiHarness("main");
	const metrics = toolMetrics();
	let callRendererCalls = 0;
	const definition = {
		name: "mutable-args-tool",
		label: "Mutable args tool",
		description: "test",
		parameters: { type: "object", properties: {} },
		async execute(): Promise<{ content: []; details: undefined }> {
			return { content: [], details: undefined };
		},
		renderCall(args: { top: number; nested: { value: number } }): Component {
			callRendererCalls++;
			return new Text(`call:${args.top}:${args.nested.value}`, 0, 0);
		},
	} as ToolDefinition<any, any>;
	const args: { top: number; nested: { value: number }; streamed?: { chunk: string } } = {
		top: 1,
		nested: { value: 1 },
	};
	const component = new ToolExecutionComponent(
		"mutable-args-tool",
		"tool-mutable",
		args,
		{ allocationMetrics: metrics },
		definition,
		tui,
		process.cwd(),
	);
	callRendererCalls = 0;
	metrics.callRendererCalls = 0;

	component.updateArgs(args, undefined, "replacement-object");
	assert.equal(callRendererCalls, 0);
	args.top = 2;
	component.updateArgs(args, 1, "mutation-with-generation");
	assert.match(component.render(80).join("\n"), /call:2:1/);
	assert.equal(callRendererCalls, 1);

	args.nested.value = 3;
	component.updateArgs(args, 2, "mutation-with-generation");
	assert.match(component.render(80).join("\n"), /call:2:3/);
	assert.equal(callRendererCalls, 2);

	component.updateArgs({ top: 2, nested: { value: 3 } }, 2, "mutation-with-generation");
	assert.equal(callRendererCalls, 2, "new object with identical content reuses the call side");
	component.updateArgs({ top: 2, nested: { value: 3 } }, undefined, "replacement-object");
	assert.equal(callRendererCalls, 2, "replacement ownership uses the semantic compatibility check");
	component.updateArgs({ top: 4, nested: { value: 5 } }, undefined, "replacement-object");
	assert.match(component.render(80).join("\n"), /call:4:5/);
	assert.equal(callRendererCalls, 3);
});

test("generic tool args serialize only after semantic changes", () => {
	const tui = createTuiHarness("main");
	const metrics = toolMetrics();
	const args = { value: 1, nested: { value: 1 } };
	const component = new ToolExecutionComponent(
		"allocation-generic",
		"tool-json",
		args,
		{ allocationMetrics: metrics },
		undefined,
		tui,
		process.cwd(),
	);
	metrics.argsSerializations = 0;
	metrics.toolArgsGenerationUpdates = 0;
	metrics.toolArgsReplacementUpdates = 0;
	metrics.toolArgsSemanticFallbackComparisons = 0;
	metrics.toolArgsMissingGenerationDiagnostics = 0;
	component.updateArgs(args, undefined, "replacement-object");
	assert.equal(metrics.argsSerializations, 0);
	args.nested.value = 2;
	component.updateArgs(args, 1, "mutation-with-generation");
	assert.equal(metrics.argsSerializations, 1);
	component.updateArgs(args, 1, "mutation-with-generation");
	component.updateArgs({ value: 1, nested: { value: 2 } }, 1, "mutation-with-generation");
	assert.equal(metrics.argsSerializations, 1);
	assert.equal(metrics.toolArgsGenerationUpdates, 1);
	assert.equal(metrics.toolArgsMissingGenerationDiagnostics, 0);
});

test("known adapter ownership matrix avoids missing-generation diagnostics", () => {
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
		const metrics = toolMetrics();
		const args = { nested: { value: 1 } };
		const component = new ToolExecutionComponent(
			"contract-tool",
			api,
			args,
			{ allocationMetrics: metrics },
			undefined,
			createTuiHarness("main"),
			process.cwd(),
		);
		args.nested.value = 2;
		component.updateArgs(args, "{\"nested\":{\"value\":2}}", getStreamedToolArgumentOwnership(api));
		assert.equal(metrics.toolArgsGenerationUpdates, 1, api);
		assert.equal(metrics.toolArgsMissingGenerationDiagnostics, 0, api);
		assert.equal(metrics.toolArgsSemanticFallbackComparisons, 0, api);
		assert.match(component.render(80).join("\n"), /"value": 2/, api);
	}
	for (const api of replacementApis) {
		const metrics = toolMetrics();
		const component = new ToolExecutionComponent(
			"contract-tool",
			api,
			{ nested: { value: 1 } },
			{ allocationMetrics: metrics },
			undefined,
			createTuiHarness("main"),
			process.cwd(),
		);
		component.updateArgs({ nested: { value: 1 } }, undefined, getStreamedToolArgumentOwnership(api));
		assert.equal(metrics.toolArgsReplacementUpdates, 1, api);
		assert.equal(metrics.toolArgsMissingGenerationDiagnostics, 0, api);
		assert.equal(metrics.toolArgsSemanticFallbackComparisons, 0, api);
		const before = metrics.updateDisplayCalls;
		component.updateArgs({ nested: { value: 2 } }, undefined, getStreamedToolArgumentOwnership(api));
		assert.equal(metrics.updateDisplayCalls, before + 1, api);
	}
});

test("legacy custom tool args use the bounded semantic compatibility fallback", () => {
	const metrics = toolMetrics();
	const component = new ToolExecutionComponent(
		"legacy-custom-tool",
		"legacy-custom",
		{ nested: { value: 1 } },
		{ allocationMetrics: metrics },
		undefined,
		createTuiHarness("main"),
		process.cwd(),
	);
	metrics.argsSerializations = 0;
	const unchangedDisplayCalls = metrics.updateDisplayCalls;
	component.updateArgs({ nested: { value: 1 } });
	assert.equal(metrics.toolArgsSemanticFallbackComparisons, 1);
	assert.equal(metrics.toolArgsMissingGenerationDiagnostics, 1);
	assert.equal(metrics.argsSerializations, 1);
	assert.equal(metrics.updateDisplayCalls, unchangedDisplayCalls);
	component.updateArgs({ nested: { value: 2 } });
	assert.equal(metrics.toolArgsSemanticFallbackComparisons, 2);
	assert.equal(metrics.toolArgsMissingGenerationDiagnostics, 2);
	assert.equal(metrics.argsSerializations, 2);
	assert.equal(metrics.updateDisplayCalls, unchangedDisplayCalls + 1);
	assert.match(component.render(80).join("\n"), /"value": 2/);
});

test("InteractiveMode streamed tool-call path observes same-reference arg completion", () => {
	const tui = createTuiHarness("main");
	const transcript = new RetainedContainer();
	const args: { top: number; nested: { value: number }; streamed?: { chunk: string } } = {
		top: 1,
		nested: { value: 1 },
	};
	let calls = 0;
	const definition = {
		name: "streamed-args-tool",
		label: "Streamed args tool",
		description: "test",
		parameters: { type: "object", properties: {} },
		async execute(): Promise<{ content: []; details: undefined }> { return { content: [], details: undefined }; },
		renderCall(value: typeof args): Component {
			calls++;
			return new Text(`args:${value.top}:${value.nested.value}:${value.streamed?.chunk ?? ""}`, 0, 0);
		},
	} as ToolDefinition<any, any>;
	const tool = new ToolExecutionComponent("streamed-args-tool", "tool-stream", args, {}, definition, tui, process.cwd());
	transcript.addRetainedChild(tool, { id: "tool-stream", version: 0 });
	const streaming = new AssistantMessageComponent();
	const mode = Object.create(InteractiveMode.prototype) as InteractiveMode & Record<string, unknown>;
	Object.assign(mode, {
		isInitialized: true,
		footer: { invalidate(): void {} },
		streamingComponent: streaming,
		streamingItemVersion: 0,
		pendingTools: new Map([["tool-stream", tool]]),
		streamedToolIds: new Set(["tool-stream"]),
		deferredReadPlaceholders: new Map(),
		deferredReadExecutions: new Map(),
		chatContainer: transcript,
		ui: tui,
	});
	const deliver = (value: typeof args, generation?: string): void => {
		(mode as unknown as { handleEvent(event: unknown): void }).handleEvent({
			type: "message_update",
			message: {
				role: "assistant",
				api: "openai-completions",
				provider: "openai",
				model: "test",
				content: [{
					type: "toolCall",
					id: "tool-stream",
					name: "streamed-args-tool",
					arguments: value,
					partialArgs: generation,
				}],
				timestamp: 0,
			},
		});
	};
	deliver(args, "initial");
	calls = 0;
	deliver(args, "initial");
	assert.equal(calls, 0);
	args.top = 2;
	deliver(args, "top:2");
	assert.match(tool.render(80).join("\n"), /args:2:1/);
	args.nested.value = 3;
	deliver(args, "nested:3");
	assert.match(tool.render(80).join("\n"), /args:2:3:/);
	args.streamed = { chunk: "a" };
	deliver(args, "stream:a");
	assert.match(tool.render(80).join("\n"), /args:2:3:a/);
	args.streamed.chunk = "ab";
	deliver(args, "stream:ab");
	assert.match(tool.render(80).join("\n"), /args:2:3:ab/);
	deliver({ top: 2, nested: { value: 3 }, streamed: { chunk: "ab" } }, "stream:ab");
	assert.equal(calls, 4);
	deliver({ top: 4, nested: { value: 5 }, streamed: { chunk: "abc" } }, "stream:abc");
	assert.equal(calls, 5);
});

test("AssistantMessageComponent reuses bounded streaming slots and private child storage", () => {
	const metrics: AssistantMessageAllocationMetrics = {
		updateContentCalls: 0,
		contentScans: 0,
		streamingMapAllocations: 0,
		slotRecordObjects: 0,
		markdownInstances: 0,
		spacerInstances: 0,
		textInstances: 0,
	};
	const component = new AssistantMessageComponent(undefined, false, getMarkdownTheme(), "Thinking...", 1, [], metrics);
	const message = {
		role: "assistant",
		content: [{ type: "text", text: "stream" }],
		timestamp: 0,
	} as AssistantMessage;
	component.updateContent(message, true);
	const state = component as unknown as {
		contentContainer: { children: Component[] };
		streamingMarkdownSlots: Map<number, unknown>;
		nextStreamingMarkdownSlots: Map<number, unknown>;
		streamingSpacers: Component[];
	};
	const children = state.contentContainer.children;
	const slotMaps = new Set([state.streamingMarkdownSlots, state.nextStreamingMarkdownSlots]);
	metrics.streamingMapAllocations = 0;
	metrics.slotRecordObjects = 0;
	metrics.markdownInstances = 0;
	metrics.spacerInstances = 0;
	for (let index = 0; index < 100_000; index++) {
		component.updateContent(message, true);
		slotMaps.add(state.streamingMarkdownSlots);
		slotMaps.add(state.nextStreamingMarkdownSlots);
	}
	assert.equal(state.contentContainer.children, children);
	assert.equal(slotMaps.size, 2);
	assert.equal(metrics.streamingMapAllocations, 0);
	assert.equal(metrics.slotRecordObjects, 0);
	assert.equal(metrics.markdownInstances, 0);
	assert.equal(metrics.spacerInstances, 0);
	assert.equal(state.streamingSpacers.length, 1);
});

test("AssistantMessageComponent bounded slot reuse stays golden across presentation and final-state transitions", () => {
	const baseTheme = getMarkdownTheme();
	const alternateTheme = {
		...baseTheme,
		heading: (text: string): string => baseTheme.heading(`alt:${text}`),
	};
	const noTransformers: readonly MarkdownTransformer[] = [];
	const alternateTransformers: readonly MarkdownTransformer[] = [
		(markdown): string => markdown.replaceAll("TRANSFORM", "transformed"),
	];
	let activeTheme = baseTheme;
	let activeTransformers = noTransformers;
	let hideThinking = false;
	let outputPad = 1;
	const candidate = new AssistantMessageComponent(
		undefined,
		hideThinking,
		activeTheme,
		"Thinking...",
		outputPad,
		activeTransformers,
	);
	const state = candidate as unknown as {
		contentContainer: { children: Component[] };
		streamingMarkdownSlots: Map<number, unknown>;
		nextStreamingMarkdownSlots: Map<number, unknown>;
	};
	const childrenIdentity = state.contentContainer.children;
	const mapIdentities = new Set([state.streamingMarkdownSlots, state.nextStreamingMarkdownSlots]);
	let evictedRecord: unknown;

	const message = (
		content: AssistantMessage["content"],
		stopReason: AssistantMessage["stopReason"] = "pending",
		errorMessage?: string,
	): AssistantMessage => ({ role: "assistant", content, stopReason, errorMessage, timestamp: 0 } as AssistantMessage);
	const assertStep = (next: AssistantMessage, streaming: boolean): void => {
		candidate.updateContent(next, streaming);
		const reference = new AssistantMessageComponent(
			undefined,
			hideThinking,
			activeTheme,
			"Thinking...",
			outputPad,
			activeTransformers,
		);
		reference.updateContent(next, streaming);
		assert.deepEqual(candidate.render(52), reference.render(52));
		assert.equal(state.contentContainer.children, childrenIdentity);
		mapIdentities.add(state.streamingMarkdownSlots);
		mapIdentities.add(state.nextStreamingMarkdownSlots);
		assert.equal(mapIdentities.size, 2);
		assert.ok(state.streamingMarkdownSlots.size <= 4);
		assert.ok(state.nextStreamingMarkdownSlots.size <= 4);
	};

	assertStep(message([{ type: "text", text: "one" }]), true);
	assertStep(message([{ type: "thinking", thinking: "reasoning" }]), true);
	assertStep(message([{ type: "text", text: "two" }]), true);
	assertStep(message([
		{ type: "text", text: "before" },
		{ type: "toolCall", id: "tool-1", name: "read", arguments: { path: "README.md" } },
		{ type: "text", text: "after" },
	]), true);
	assertStep(message([{ type: "text", text: "after tool" }]), true);
	assertStep(message([
		{ type: "text", text: "slot 1" },
		{ type: "text", text: "slot 2" },
		{ type: "text", text: "slot 3" },
		{ type: "text", text: "slot 4" },
	]), true);
	evictedRecord = state.streamingMarkdownSlots.get(2);
	assert.ok(evictedRecord);
	assertStep(message([{ type: "text", text: "single" }]), true);
	assert.equal([...state.streamingMarkdownSlots.values(), ...state.nextStreamingMarkdownSlots.values()].includes(evictedRecord), false);

	outputPad = 2;
	candidate.setOutputPad(outputPad);
	assertStep(message([{ type: "text", text: "pad changed" }]), true);
	activeTheme = alternateTheme;
	candidate.setMarkdownTheme(activeTheme);
	assertStep(message([{ type: "text", text: "# heading" }]), true);
	assert.match(candidate.render(52).join("\n"), /alt:heading/);
	activeTransformers = alternateTransformers;
	candidate.setMarkdownTransformers(activeTransformers);
	assertStep(message([{ type: "text", text: "TRANSFORM" }]), true);
	assert.match(candidate.render(52).join("\n"), /transformed/);
	hideThinking = true;
	candidate.setHideThinkingBlock(true);
	assertStep(message([{ type: "thinking", thinking: "hidden detail" }]), true);
	hideThinking = false;
	candidate.setHideThinkingBlock(false);
	assertStep(message([{ type: "thinking", thinking: "shown detail" }]), true);
	assertStep(message([{ type: "text", text: "partial" }], "aborted", "aborted by test"), false);
	assertStep(message([{ type: "text", text: "partial" }], "error", "failed by test"), false);
	assertStep(message([{ type: "text", text: "final" }], "stop"), false);
	assert.equal(state.streamingMarkdownSlots.size, 0);
	assert.equal(state.nextStreamingMarkdownSlots.size, 0);
});

test("real leaf source invariants exclude known callback arrays and per-update maps", () => {
	const toolSource = readFileSync(
		"packages/coding-agent/src/modes/interactive/components/tool-execution.ts",
		"utf8",
	);
	const assistantSource = readFileSync(
		"packages/coding-agent/src/modes/interactive/components/assistant-message.ts",
		"utf8",
	);
	const markdownSource = readFileSync("packages/tui/src/components/markdown.ts", "utf8");
	const interactiveSource = readFileSync(
		"packages/coding-agent/src/modes/interactive/interactive-mode.ts",
		"utf8",
	);
	assert.doesNotMatch(toolSource, /result\.content\.filter\(/);
	assert.match(toolSource, /updateArgs\([\s\S]*generation\?: ToolArgsGeneration,[\s\S]*ownership\?: StreamedToolArgumentOwnership/);
	assert.match(toolSource, /generation !== undefined && Object\.is\(this\.argsGeneration, generation\)/);
	assert.doesNotMatch(toolSource, /cloneToolArgsSnapshot|toolArgsMatchSnapshot|for\s*\([^)]*\bin\b/);
	assert.match(interactiveSource, /typeof transient\.partialJson === "string"/);
	assert.match(interactiveSource, /typeof transient\.partialArgs === "string"/);
	assert.match(toolSource, /const toolPendingBackground = /);
	assert.match(toolSource, /this\.imageComponents\.length = 0/);
	assert.match(toolSource, /this\.imageSpacers\.length = 0/);
	assert.doesNotMatch(assistantSource, /message\.content\.some\(/);
	assert.doesNotMatch(assistantSource, /slice\(i \+ 1\)\.some\(/);
	assert.match(assistantSource, /this\.contentContainer\.children\.length = 0/);
	assert.match(assistantSource, /private streamingMarkdownSlots = new Map/);
	assert.match(assistantSource, /private nextStreamingMarkdownSlots = new Map/);
	assert.doesNotMatch(markdownSource, /split\("\\n"\)\.map\(/);
	assert.match(markdownSource, /private readonly defaultInlineStyleContext/);
});
