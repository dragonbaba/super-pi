import { Session } from "node:inspector/promises";
import { writeFileSync } from "node:fs";
import { constants, performance, PerformanceObserver, type PerformanceEntry } from "node:perf_hooks";
import type { AssistantMessage } from "@super-pi/ai/compat";
import { Agent } from "../../packages/agent/src/agent.ts";
import { AgentSession } from "../../packages/coding-agent/src/core/agent-session.ts";
import {
	createInteractiveTuiReference,
	InteractiveMode,
} from "../../packages/coding-agent/src/modes/interactive/interactive-mode.ts";
import {
	AssistantMessageComponent,
	type AssistantMessageAllocationMetrics,
} from "../../packages/coding-agent/src/modes/interactive/components/assistant-message.ts";
import {
	ToolExecutionComponent,
	type ToolExecutionAllocationMetrics,
} from "../../packages/coding-agent/src/modes/interactive/components/tool-execution.ts";
import { getMarkdownTheme, initTheme } from "../../packages/coding-agent/src/modes/interactive/theme/theme.ts";
import type { ToolDefinition } from "../../packages/coding-agent/src/core/extensions/types.ts";
import { RetainedContainer } from "../../packages/tui/src/components/retained-item.ts";
import { getCapabilities, setCapabilities } from "../../packages/tui/src/terminal-image.ts";
import type { Terminal } from "../../packages/tui/src/terminal.ts";
import { Text } from "../../packages/tui/src/components/text.ts";
import type { Component, TUI } from "../../packages/tui/src/tui.ts";
import { TuiMainScreen } from "../../packages/tui/src/tui-main-screen.ts";
import { currentCommit, readIntegerOption } from "./benchmark.ts";

interface SamplingNode {
	callFrame: { functionName: string; url: string; lineNumber: number; columnNumber: number };
	selfSize: number;
	children?: SamplingNode[];
}
interface PerformanceGcEntry extends PerformanceEntry { detail?: { kind?: number } }
interface AllocationSite { bytes: number; functionName: string; url: string; line: number; column: number }
const samplingInterval = readIntegerOption("--sampling-interval", 8_192);
const instrumentComponents = process.argv.includes("--instrument-components");
function readStringOption(name: string): string | undefined {
	const index = process.argv.indexOf(name);
	return index < 0 ? undefined : process.argv[index + 1];
}
type BenchEvent = { type: string; [key: string]: unknown };
type ModeHarness = { handleEvent(event: BenchEvent): void | Promise<void> };
type SessionHarness = {
	_eventListeners: Array<{
		listener: (event: BenchEvent) => void | Promise<void>;
		criticalAgentEnd: boolean;
		observeRejection: (error: unknown) => void;
	}>;
	_emit(event: BenchEvent): void;
	_handleAgentObserverEvent(event: BenchEvent): void;
	_extensionObserverDelivery: { publishLatest(key: string, event: BenchEvent): void };
};
type AgentHarness = {
	activeRun: { abortController: AbortController };
	eventDelivery: {
		publishLatest(key: string, event: BenchEvent): void;
		flushLatest(key: string): Promise<void>;
		stats: { received: number; coalesced: number; delivered: number };
	};
};

let activeMode: ModeHarness;
let activeObserverSession: SessionHarness;
function deliverSessionEvent(event: BenchEvent): void | Promise<void> { return activeMode.handleEvent(event); }
function deliverObserverEvent(event: BenchEvent): void { activeObserverSession._handleAgentObserverEvent(event); }
function publishNoopExtensionObserver(): void {}
function failOnListenerRejection(error: unknown): never { throw error; }
function throwUnusedStream(): never { throw new Error("stream function is not used by the real-leaf benchmark"); }

class NoopTerminal implements Terminal {
	readonly kittyProtocolActive = false;
	columns = 120;
	rows = 40;
	private frameWriteCompletion: ((generation: number, error?: Error) => void) | undefined;
	start(): void {}
	stop(): void {}
	async drainInput(): Promise<void> {}
	write(): void {}
	setFrameWriteCompletionListener(listener: ((generation: number, error?: Error) => void) | undefined): void {
		this.frameWriteCompletion = listener;
	}
	writeFrame(_data: string, generation: number): void { this.frameWriteCompletion?.(generation); }
	cancelFrameWrite(): void {}
	moveBy(): void {}
	hideCursor(): void {}
	showCursor(): void {}
	clearLine(): void {}
	clearFromCursor(): void {}
	clearScreen(): void {}
	setTitle(): void {}
	setProgress(): void {}
}

class InstrumentedMainScreen extends TuiMainScreen {
	requestRenderCalls = 0;
	override requestRender(force = false): void {
		this.requestRenderCalls++;
		super.requestRender(force);
	}
}

function createSession(mode: ModeHarness): SessionHarness {
	activeMode = mode;
	const session = Object.create(AgentSession.prototype) as SessionHarness;
	session._eventListeners = [{
		listener: deliverSessionEvent,
		criticalAgentEnd: false,
		observeRejection: failOnListenerRejection,
	}];
	session._extensionObserverDelivery = { publishLatest: publishNoopExtensionObserver };
	return session;
}

function createObserverAgent(session: SessionHarness): {
	delivery: AgentHarness["eventDelivery"];
	unsubscribe: () => void;
} {
	activeObserverSession = session;
	const agent = new Agent({ streamFn: throwUnusedStream as never });
	const harness = agent as unknown as AgentHarness;
	harness.activeRun = { abortController: new AbortController() };
	const unsubscribe = agent.subscribeObserver(deliverObserverEvent as never, { minIntervalMs: 0 });
	return { delivery: harness.eventDelivery, unsubscribe };
}

function allocationSites(head: SamplingNode): { sampledBytes: number; top: AllocationSite[] } {
	const sites = new Map<string, AllocationSite>();
	let sampledBytes = 0;
	const pending = [head];
	while (pending.length > 0) {
		const node = pending.pop()!;
		if (node.selfSize > 0) {
			sampledBytes += node.selfSize;
			const frame = node.callFrame;
			const key = `${frame.url}\0${frame.lineNumber}\0${frame.columnNumber}\0${frame.functionName}`;
			const existing = sites.get(key);
			if (existing) existing.bytes += node.selfSize;
			else sites.set(key, {
				bytes: node.selfSize,
				functionName: frame.functionName || "(anonymous)",
				url: frame.url,
				line: frame.lineNumber + 1,
				column: frame.columnNumber + 1,
			});
		}
		if (node.children) for (const child of node.children) pending.push(child);
	}
	return { sampledBytes, top: [...sites.values()].sort((left, right) => right.bytes - left.bytes).slice(0, 20) };
}

function percentile(sorted: readonly number[], ratio: number): number {
	return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1))] ?? 0;
}

async function profileUpdates(
	name: string,
	updates: number,
	warmup: number,
	update: (index: number) => void,
	metrics: () => Record<string, unknown>,
): Promise<unknown> {
	for (let index = 0; index < warmup; index++) update(index);
	globalThis.gc!();
	globalThis.gc!();
	const heapBefore = process.memoryUsage().heapUsed;
	let minorGcCount = 0;
	let majorGcCount = 0;
	let totalGcDurationMs = 0;
	const gcObserver = new PerformanceObserver((list) => {
		for (const rawEntry of list.getEntries()) {
			const entry = rawEntry as PerformanceGcEntry;
			totalGcDurationMs += entry.duration;
			if (entry.detail?.kind === constants.NODE_PERFORMANCE_GC_MINOR) minorGcCount++;
			else if (entry.detail?.kind === constants.NODE_PERFORMANCE_GC_MAJOR) majorGcCount++;
		}
	});
	gcObserver.observe({ entryTypes: ["gc"] });
	const inspector = new Session();
	inspector.connect();
	await inspector.post("HeapProfiler.enable");
	await inspector.post("HeapProfiler.startSampling", {
		samplingInterval,
		includeObjectsCollectedByMajorGC: true,
		includeObjectsCollectedByMinorGC: true,
	});
	const batchSize = 100;
	const durations = new Array<number>(Math.ceil(updates / batchSize));
	let completed = 0;
	for (let batch = 0; completed < updates; batch++) {
		const count = Math.min(batchSize, updates - completed);
		const started = performance.now();
		for (let offset = 0; offset < count; offset++) update(completed + offset + warmup);
		durations[batch] = (performance.now() - started) / count;
		completed += count;
	}
	const stopped = await inspector.post("HeapProfiler.stopSampling");
	await inspector.post("HeapProfiler.disable");
	inspector.disconnect();
	await new Promise<void>((resolve) => setTimeout(resolve, 50));
	gcObserver.disconnect();
	const heapAfter = process.memoryUsage().heapUsed;
	globalThis.gc!();
	globalThis.gc!();
	const controlledGcAfter = process.memoryUsage().heapUsed;
	const sampled = allocationSites(stopped.profile.head as SamplingNode);
	const sortedDurations = durations.slice().sort((left, right) => left - right);
	return {
		name,
		updates,
		warmup,
		metrics: {
			cpuP50MsPerUpdate: percentile(sortedDurations, 0.5),
			cpuP95MsPerUpdate: percentile(sortedDurations, 0.95),
			sampledAllocationBytes: sampled.sampledBytes,
			sampledAllocationBytesPerUpdate: sampled.sampledBytes / updates,
			minorGcCount,
			majorGcCount,
			totalGcDurationMs,
			heapBefore,
			heapAfter,
			controlledGcAfter,
			controlledGcHeapDeltaBytes: controlledGcAfter - heapBefore,
			...metrics(),
		},
		topAllocationSites: sampled.top,
	};
}

function createToolMetrics(): ToolExecutionAllocationMetrics {
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

function resetToolMetrics(metrics: ToolExecutionAllocationMetrics): void {
	metrics.updateDisplayCalls = 0;
	metrics.callRendererCalls = 0;
	metrics.resultRendererCalls = 0;
	metrics.componentCreations = 0;
	metrics.renderContextObjects = 0;
	metrics.internalWrapperObjects = 0;
	metrics.imageScans = 0;
	metrics.argsSerializations = 0;
	metrics.toolArgsGenerationUpdates = 0;
	metrics.toolArgsReplacementUpdates = 0;
	metrics.toolArgsSemanticFallbackComparisons = 0;
	metrics.toolArgsMissingGenerationDiagnostics = 0;
}

function createAssistantMetrics(): AssistantMessageAllocationMetrics {
	return {
		updateContentCalls: 0,
		contentScans: 0,
		streamingMapAllocations: 0,
		slotRecordObjects: 0,
		markdownInstances: 0,
		spacerInstances: 0,
		textInstances: 0,
	};
}

function resetAssistantMetrics(metrics: AssistantMessageAllocationMetrics): void {
	metrics.updateContentCalls = 0;
	metrics.contentScans = 0;
	metrics.streamingMapAllocations = 0;
	metrics.slotRecordObjects = 0;
	metrics.markdownInstances = 0;
	metrics.spacerInstances = 0;
	metrics.textInstances = 0;
}

function createRenderer(): { renderer: InstrumentedMainScreen; reference: TUI; transcript: RetainedContainer } {
	const renderer = new InstrumentedMainScreen(new NoopTerminal(), false);
	const transcript = new RetainedContainer();
	renderer.addChild(transcript);
	const reference = createInteractiveTuiReference(() => renderer);
	return { renderer, reference, transcript };
}

function createToolDefinition(counters: { call: number; result: number; components: number }): ToolDefinition<any, any> {
	return {
		name: "allocation-custom",
		label: "Allocation custom",
		description: "Allocation benchmark renderer",
		parameters: { type: "object", properties: {} },
		renderCall(args): Component {
			counters.call++;
			counters.components++;
			return new Text(`call:${args.value ?? ""}`, 0, 0);
		},
		renderResult(result): Component {
			counters.result++;
			counters.components++;
			return new Text(result.content[0]?.text ?? "", 0, 0);
		},
	} as ToolDefinition<any, any>;
}

async function measureToolFixture(
	name: string,
	toolName: string,
	definition: ToolDefinition<any, any> | undefined,
	updates: number,
	warmup: number,
	mode: "constant" | "growing" | "image",
): Promise<unknown> {
	const { renderer, reference, transcript } = createRenderer();
	const metrics = createToolMetrics();
	const rendererCounters = { call: 0, result: 0, components: 0 };
	const selectedDefinition = definition ?? (name === "custom-extension-renderer" ? createToolDefinition(rendererCounters) : undefined);
	const component = new ToolExecutionComponent(
		toolName,
		"tool-1",
		{ value: 1 },
		{ allocationMetrics: instrumentComponents ? metrics : undefined, showImages: mode === "image" },
		selectedDefinition,
		reference,
		process.cwd(),
	);
	transcript.addRetainedChild(component, { id: "tool", version: 0 });
	const pendingTools = new Map<string, ToolExecutionComponent>([["tool-1", component]]);
	const interactive = Object.create(InteractiveMode.prototype) as ModeHarness & Record<string, unknown>;
	Object.assign(interactive, {
		isInitialized: true,
		footer: { invalidate(): void {} },
		pendingTools,
		deferredReadExecutions: new Map(),
		chatContainer: transcript,
		ui: reference,
	});
	const session = createSession(interactive);
	const observerAgent = createObserverAgent(session);
	let growingText = "";
	const update = (index: number): void => {
		let content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
		if (mode === "image") {
			content = [{ type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" }];
		} else if (mode === "growing") {
			growingText = growingText.length >= 4096 ? "x" : `${growingText}x`;
			content = [{ type: "text", text: growingText }];
		} else {
			content = [{ type: "text", text: `progress-${index & 3}` }];
		}
		session._emit({
			type: "tool_execution_update",
			toolCallId: "tool-1",
			toolName,
			partialResult: { content },
		});
	};
	for (let index = 0; index < warmup; index++) update(index);
	const allocationMetricsAvailable = metrics.updateDisplayCalls > 0;
	resetToolMetrics(metrics);
	rendererCounters.call = 0;
	rendererCounters.result = 0;
	rendererCounters.components = 0;
	renderer.requestRenderCalls = 0;
	const result = await profileUpdates(name, updates, 0, update, () => ({
		updateDisplayCalls: metrics.updateDisplayCalls,
		callRendererCalls: metrics.callRendererCalls,
		resultRendererCalls: metrics.resultRendererCalls,
		internalComponentCreations: metrics.componentCreations,
		externalRendererComponentCreations: rendererCounters.components,
		renderContextObjects: metrics.renderContextObjects,
		internalWrapperObjects: metrics.internalWrapperObjects,
		imageScans: metrics.imageScans,
		argsSerializations: metrics.argsSerializations,
		toolArgsGenerationUpdates: metrics.toolArgsGenerationUpdates,
		toolArgsReplacementUpdates: metrics.toolArgsReplacementUpdates,
		toolArgsSemanticFallbackComparisons: metrics.toolArgsSemanticFallbackComparisons,
		toolArgsMissingGenerationDiagnostics: metrics.toolArgsMissingGenerationDiagnostics,
		requestRenderCalls: renderer.requestRenderCalls,
		allocationMetricsAvailable,
	}));
	const observerStatsBefore = observerAgent.delivery.stats;
	for (let index = 0; index < updates; index++) {
		const content = mode === "image"
			? [{ type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" }]
			: [{ type: "text", text: `observer-progress-${index & 3}` }];
		observerAgent.delivery.publishLatest("tool:tool-1", {
			type: "tool_execution_update",
			toolCallId: "tool-1",
			toolName,
			partialResult: { content },
		});
	}
	await observerAgent.delivery.flushLatest("tool:tool-1");
	const observerStatsAfter = observerAgent.delivery.stats;
	observerAgent.unsubscribe();
	component.setExpanded(true);
	const expanded = (component as unknown as { expanded: boolean }).expanded;
	component.setExpanded(false);
	const collapsed = !(component as unknown as { expanded: boolean }).expanded;
	session._emit({
		type: "tool_execution_end",
		toolCallId: "tool-1",
		toolName,
		result: { content: [{ type: "text", text: "final" }] },
		isError: false,
	});
	const finalResult =
		(component as unknown as { isPartial: boolean; resultIsError: boolean }).isPartial === false &&
		(component as unknown as { resultIsError: boolean }).resultIsError === false &&
		!pendingTools.has("tool-1");
	const errorComponent = new ToolExecutionComponent(
		toolName,
		"tool-error",
		{ value: 1 },
		{ showImages: mode === "image" },
		selectedDefinition,
		reference,
		process.cwd(),
	);
	pendingTools.set("tool-error", errorComponent);
	session._emit({
		type: "tool_execution_end",
		toolCallId: "tool-error",
		toolName,
		result: { content: [{ type: "text", text: "error" }] },
		isError: true,
	});
	const errorResult =
		(errorComponent as unknown as { isPartial: boolean; resultIsError: boolean }).isPartial === false &&
		(errorComponent as unknown as { resultIsError: boolean }).resultIsError === true &&
		!pendingTools.has("tool-error");
	await renderer.dispose({ preserveScreen: true });
	return {
		...(result as Record<string, unknown>),
		warmup,
		stateCoverage: { expanded, collapsed, finalResult, errorResult },
		fullObserverChain: {
			rawUpdates: observerStatsAfter.received - observerStatsBefore.received,
			coalescedUpdates: observerStatsAfter.coalesced - observerStatsBefore.coalesced,
			deliveries: observerStatsAfter.delivered - observerStatsBefore.delivered,
			productionSnapshot: true,
			productionAgentSessionBridge: true,
			productionInteractiveModeHandler: true,
		},
		sourceInvariant: { inlineClosuresPerUpdate: 0, callbackArraysPerUpdate: 0 },
	};
}

function getMarkdownStats(component: AssistantMessageComponent): { parserTokenCount: number; incrementalReuseCount: number } {
	const slots = (component as unknown as { streamingMarkdownSlots: Map<number, { markdown: {
		getLastParserTokenCount?: () => number;
		getLastIncrementalReuseCount?: () => number;
	} }> }).streamingMarkdownSlots;
	let parserTokenCount = 0;
	let incrementalReuseCount = 0;
	for (const slot of slots.values()) {
		parserTokenCount += slot.markdown.getLastParserTokenCount?.() ?? 0;
		incrementalReuseCount += slot.markdown.getLastIncrementalReuseCount?.() ?? 0;
	}
	return { parserTokenCount, incrementalReuseCount };
}

async function measureAssistantFixture(
	name: string,
	updates: number,
	warmup: number,
	contentForUpdate: (index: number) => AssistantMessage["content"],
): Promise<unknown> {
	const { renderer, reference, transcript } = createRenderer();
	const metrics = createAssistantMetrics();
	const component = new AssistantMessageComponent(
		undefined,
		false,
		getMarkdownTheme(),
		"Thinking...",
		1,
		[],
		instrumentComponents ? metrics : undefined,
	);
	const retained = transcript.addRetainedChild(component, { id: "assistant", version: 0 });
	const toolComponent = new ToolExecutionComponent("allocation-tool", "mixed-tool", {}, {}, undefined, reference, process.cwd());
	const interactive = Object.create(InteractiveMode.prototype) as ModeHarness & Record<string, unknown>;
	Object.assign(interactive, {
		isInitialized: true,
		footer: { invalidate(): void {} },
		streamingComponent: component,
		streamingMessage: undefined,
		streamingItem: retained,
		streamingItemVersion: 0,
		pendingTools: new Map([["mixed-tool", toolComponent]]),
		streamedToolIds: new Set(["mixed-tool"]),
		deferredReadExecutions: new Map(),
		deferredReadPlaceholders: new Map(),
		chatContainer: transcript,
		ui: reference,
	});
	const session = createSession(interactive);
	const observerAgent = createObserverAgent(session);
	const update = (index: number): void => {
		const message = {
			role: "assistant",
			content: contentForUpdate(index),
			timestamp: index,
		} as AssistantMessage;
		session._emit({ type: "message_update", message });
		renderer.renderNow();
	};
	for (let index = 0; index < warmup; index++) update(index);
	const allocationMetricsAvailable = metrics.updateContentCalls > 0;
	resetAssistantMetrics(metrics);
	renderer.requestRenderCalls = 0;
	const result = await profileUpdates(name, updates, 0, update, () => ({
		updateContentCalls: metrics.updateContentCalls,
		contentScans: metrics.contentScans,
		newMaps: metrics.streamingMapAllocations,
		slotRecordObjects: metrics.slotRecordObjects,
		markdownInstancesCreated: metrics.markdownInstances,
		spacerInstancesCreated: metrics.spacerInstances,
		textInstancesCreated: metrics.textInstances,
		requestRenderCalls: renderer.requestRenderCalls,
		allocationMetricsAvailable,
		...getMarkdownStats(component),
	}));
	const observerStatsBefore = observerAgent.delivery.stats;
	for (let index = 0; index < updates; index++) {
		observerAgent.delivery.publishLatest("message", {
			type: "message_update",
			message: {
				role: "assistant",
				content: contentForUpdate(index + updates + warmup),
				timestamp: index,
			},
		});
	}
	await observerAgent.delivery.flushLatest("message");
	const observerStatsAfter = observerAgent.delivery.stats;
	observerAgent.unsubscribe();
	await renderer.dispose({ preserveScreen: true });
	return {
		...(result as Record<string, unknown>),
		warmup,
		fullObserverChain: {
			rawUpdates: observerStatsAfter.received - observerStatsBefore.received,
			coalescedUpdates: observerStatsAfter.coalesced - observerStatsBefore.coalesced,
			deliveries: observerStatsAfter.delivered - observerStatsBefore.delivered,
			productionSnapshot: true,
			productionAgentSessionBridge: true,
			productionInteractiveModeHandler: true,
		},
		sourceInvariant: { inlineClosuresPerUpdate: 0, perUpdateMapAllocations: 0 },
	};
}

if (typeof globalThis.gc !== "function") throw new Error("tui-real-leaf-allocations requires --expose-gc");
initTheme("dark");
const updates = readIntegerOption("--updates", 20_000);
const warmup = readIntegerOption("--warmup", 5_000);
const structuralUpdates = readIntegerOption("--structural-updates", 100_000);
const selectedAssistantFixture = readStringOption("--assistant-fixture");
const toolOnly = process.argv.includes("--tool-only");
if (toolOnly && selectedAssistantFixture) throw new Error("--tool-only and --assistant-fixture are mutually exclusive");
const validAssistantFixtures = new Set([
	"plain-streaming-text",
	"append-growing-markdown",
	"code-block-json",
	"cjk-emoji",
	"thinking-block",
	"text-toolcall-mixed",
]);
if (selectedAssistantFixture && !validAssistantFixtures.has(selectedAssistantFixture)) {
	throw new Error(`Unknown --assistant-fixture: ${selectedAssistantFixture}`);
}
const previousCapabilities = getCapabilities();
const toolResults: unknown[] = [];
if (!selectedAssistantFixture) {
	toolResults.push(await measureToolFixture("generic-fallback-constant", "allocation-generic", undefined, updates, warmup, "constant"));
	toolResults.push(await measureToolFixture("generic-fallback-growing", "allocation-generic", undefined, updates, warmup, "growing"));
	toolResults.push(await measureToolFixture("built-in-renderer", "read", undefined, updates, warmup, "constant"));
	toolResults.push(await measureToolFixture("custom-extension-renderer", "allocation-custom", undefined, updates, warmup, "constant"));
	setCapabilities({ ...previousCapabilities, images: "iterm2" });
	toolResults.push(await measureToolFixture("image-result-low-frequency", "allocation-image", undefined, Math.min(updates, 2_000), warmup, "image"));
	setCapabilities(previousCapabilities);
}

let growingMarkdown = "";
const assistantResults: unknown[] = [];
if (!toolOnly && (!selectedAssistantFixture || selectedAssistantFixture === "plain-streaming-text")) {
	assistantResults.push(await measureAssistantFixture("plain-streaming-text", updates, warmup, (index) => [
		{ type: "text", text: `plain-${index & 7}` },
	]));
}
if (!toolOnly && (!selectedAssistantFixture || selectedAssistantFixture === "append-growing-markdown")) {
	assistantResults.push(await measureAssistantFixture("append-growing-markdown", updates, warmup, () => {
		growingMarkdown = growingMarkdown.length >= 4096 ? "# x" : `${growingMarkdown}x`;
		return [{ type: "text", text: growingMarkdown }];
	}));
}
if (!toolOnly && (!selectedAssistantFixture || selectedAssistantFixture === "code-block-json")) {
	assistantResults.push(await measureAssistantFixture("code-block-json", updates, warmup, (index) => [
		{ type: "text", text: `\`\`\`json\n{\"value\":${index & 15}}\n\`\`\`` },
	]));
}
if (!toolOnly && (!selectedAssistantFixture || selectedAssistantFixture === "cjk-emoji")) {
	assistantResults.push(await measureAssistantFixture("cjk-emoji", updates, warmup, (index) => [
		{ type: "text", text: `中文🙂e\u0301-${index & 7}` },
	]));
}
if (!toolOnly && (!selectedAssistantFixture || selectedAssistantFixture === "thinking-block")) {
	assistantResults.push(await measureAssistantFixture("thinking-block", updates, warmup, (index) => [
		{ type: "thinking", thinking: `thinking-${index & 7}` },
	]));
}
if (!toolOnly && (!selectedAssistantFixture || selectedAssistantFixture === "text-toolcall-mixed")) {
	assistantResults.push(await measureAssistantFixture("text-toolcall-mixed", updates, warmup, (index) => [
		{ type: "text", text: `text-${index & 7}` },
		{ type: "toolCall", id: "mixed-tool", name: "allocation-tool", arguments: { value: index & 7 } },
	]));
}

const structuralToolRenderer = createRenderer();
const structuralToolMetrics = createToolMetrics();
const structuralToolComponent = new ToolExecutionComponent(
	"allocation-generic",
	"structural-tool",
	{ value: 1 },
	{ allocationMetrics: structuralToolMetrics },
	undefined,
	structuralToolRenderer.reference,
	process.cwd(),
);
structuralToolRenderer.transcript.addRetainedChild(structuralToolComponent, { id: "structural-tool", version: 0 });
const structuralToolMode = Object.create(InteractiveMode.prototype) as ModeHarness & Record<string, unknown>;
Object.assign(structuralToolMode, {
	isInitialized: true,
	footer: { invalidate(): void {} },
	pendingTools: new Map([["structural-tool", structuralToolComponent]]),
	deferredReadExecutions: new Map(),
	chatContainer: structuralToolRenderer.transcript,
	ui: structuralToolRenderer.reference,
});
const structuralToolSession = createSession(structuralToolMode);
const structuralToolEvent = {
	type: "tool_execution_update",
	toolCallId: "structural-tool",
	toolName: "allocation-generic",
	partialResult: { content: [{ type: "text", text: "constant" }] },
};
structuralToolSession._emit(structuralToolEvent);
resetToolMetrics(structuralToolMetrics);
structuralToolRenderer.renderer.requestRenderCalls = 0;
const structuralToolStarted = performance.now();
for (let index = 0; index < structuralUpdates; index++) structuralToolSession._emit(structuralToolEvent);
const structuralToolElapsedMs = performance.now() - structuralToolStarted;

const structuralAssistantMetrics = createAssistantMetrics();
const structuralAssistant = new AssistantMessageComponent(
	undefined,
	false,
	getMarkdownTheme(),
	"Thinking...",
	1,
	[],
	structuralAssistantMetrics,
);
const structuralMessage = {
	role: "assistant",
	content: [{ type: "text", text: "constant" }],
	timestamp: 0,
} as AssistantMessage;
structuralAssistant.updateContent(structuralMessage, true);
resetAssistantMetrics(structuralAssistantMetrics);
const structuralStarted = performance.now();
for (let index = 0; index < structuralUpdates; index++) structuralAssistant.updateContent(structuralMessage, true);
const structuralElapsedMs = performance.now() - structuralStarted;
await structuralToolRenderer.renderer.dispose({ preserveScreen: true });

const output = `${JSON.stringify({
	schemaVersion: 1,
	benchmark: "tui-real-leaf-allocations",
	commit: currentCommit(),
	node: process.version,
	platform: process.platform,
	arch: process.arch,
	samplingInterval,
	structuralGate: {
		updates: structuralUpdates,
		toolAllocationMetricsAvailable: structuralToolMetrics.updateDisplayCalls > 0,
		assistantAllocationMetricsAvailable: structuralAssistantMetrics.updateContentCalls > 0,
		assistantCpuMsPerUpdate: structuralElapsedMs / structuralUpdates,
		toolCpuMsPerUpdate: structuralToolElapsedMs / structuralUpdates,
		assistantNewMaps: structuralAssistantMetrics.streamingMapAllocations,
		assistantSlotRecordObjects: structuralAssistantMetrics.slotRecordObjects,
		assistantMarkdownInstances: structuralAssistantMetrics.markdownInstances,
		toolWrapperObjectsPerUpdate: structuralToolMetrics.internalWrapperObjects / structuralUpdates,
		toolCallRendererCalls: structuralToolMetrics.callRendererCalls,
		toolArgsSerializations: structuralToolMetrics.argsSerializations,
		toolArgsGenerationUpdates: structuralToolMetrics.toolArgsGenerationUpdates,
		toolArgsReplacementUpdates: structuralToolMetrics.toolArgsReplacementUpdates,
		toolArgsSemanticFallbackComparisons: structuralToolMetrics.toolArgsSemanticFallbackComparisons,
		toolArgsMissingGenerationDiagnostics: structuralToolMetrics.toolArgsMissingGenerationDiagnostics,
		toolRequestRenderCalls: structuralToolRenderer.renderer.requestRenderCalls,
	},
	fixtures: [
		{
			name: "production-tool-progress",
			coverage: {
				productionAgentSessionEmit: true,
				productionInteractiveModeHandler: true,
				fullRuntimeConstruction: false,
				realStableReference: true,
				realToolComponent: true,
				realToolRenderer: true,
				markdown: false,
				frameQueue: false,
			},
			results: toolResults,
		},
		{
			name: "production-assistant-markdown-stream",
			coverage: {
				productionAgentSessionEmit: true,
				productionInteractiveModeHandler: true,
				fullRuntimeConstruction: false,
				realStableReference: true,
				realAssistantComponent: true,
				realMarkdown: true,
				realViewport: true,
				realFrameQueue: true,
			},
			results: assistantResults,
		},
	],
}, null, 2)}\n`;
const outputPath = readStringOption("--output");
if (outputPath) writeFileSync(outputPath, output, "utf8");
else process.stdout.write(output);
