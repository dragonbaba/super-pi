import { createHash } from "node:crypto";
import { Session } from "node:inspector/promises";
import { constants, performance, PerformanceObserver, type PerformanceEntry } from "node:perf_hooks";
import type { AssistantMessage } from "@super-pi/ai/compat";
import { Agent } from "../../packages/agent/src/agent.ts";
import {
	EventDeliveryDispatcher,
	type EventDeliveryScheduler,
} from "../../packages/agent/src/event-delivery.ts";
import { AgentSession } from "../../packages/coding-agent/src/core/agent-session.ts";
import type { ToolDefinition } from "../../packages/coding-agent/src/core/extensions/types.ts";
import {
	AssistantMessageComponent,
	type AssistantMessageAllocationMetrics,
} from "../../packages/coding-agent/src/modes/interactive/components/assistant-message.ts";
import {
	ToolExecutionComponent,
	type ToolExecutionAllocationMetrics,
} from "../../packages/coding-agent/src/modes/interactive/components/tool-execution.ts";
import {
	createInteractiveTuiReference,
	InteractiveMode,
} from "../../packages/coding-agent/src/modes/interactive/interactive-mode.ts";
import { getMarkdownTheme, initTheme } from "../../packages/coding-agent/src/modes/interactive/theme/theme.ts";
import { RetainedContainer } from "../../packages/tui/src/components/retained-item.ts";
import { TuiRenderInstrumentation } from "../../packages/tui/src/render-instrumentation.ts";
import type { Terminal } from "../../packages/tui/src/terminal.ts";
import { Text } from "../../packages/tui/src/components/text.ts";
import type { Component, TUI } from "../../packages/tui/src/tui.ts";
import { TuiMainScreen } from "../../packages/tui/src/tui-main-screen.ts";
import { currentCommit, readIntegerOption } from "./benchmark.ts";

type BenchEvent = { type: string; [key: string]: unknown };
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
type SnapshotAgentHarness = {
	activeRun: { abortController: AbortController };
	eventDelivery: EventDeliveryDispatcher<BenchEvent, string>;
	snapshotObserverEvent(event: BenchEvent): BenchEvent;
};
type SamplingNode = {
	callFrame: { functionName: string; url: string; lineNumber: number; columnNumber: number };
	selfSize: number;
	children?: SamplingNode[];
};
type GcEntry = PerformanceEntry & { detail?: { kind?: number } };
type AllocationSite = { bytes: number; functionName: string; url: string; line: number; column: number };

const RAW_PER_DELIVERY = 20;
let activeSession: SessionHarness;
let activeSnapshotAgent: SnapshotAgentHarness;
let snapshotCount = 0;
let builtInListenerPromises = 0;

function throwUnusedStream(): never { throw new Error("stream is not used by the paced real-leaf benchmark"); }
function publishNoopExtensionObserver(): void {}
function failOnListenerRejection(error: unknown): never { throw error; }
function deliverPacedObserverEvent(event: BenchEvent): void {
	activeSession._handleAgentObserverEvent(event);
}
function deliverPacedSessionEvent(event: BenchEvent): void {
	const result = activeMode.handleEvent(event);
	if (result && typeof (result as Promise<void>).then === "function") builtInListenerPromises++;
}
function snapshotPacedEvent(event: BenchEvent): BenchEvent {
	snapshotCount++;
	return activeSnapshotAgent.snapshotObserverEvent(event);
}

let activeMode: { handleEvent(event: BenchEvent): void | Promise<void> };

class SingleTaskScheduler implements EventDeliveryScheduler {
	private currentTime = 0;
	private callback: (() => void) | undefined;
	private handle = 0;

	now(): number { return this.currentTime; }
	schedule(callback: () => void): number {
		if (this.callback) throw new Error("paced scheduler only permits one pending task");
		this.callback = callback;
		return ++this.handle;
	}
	cancel(handle: unknown): void {
		if (handle === this.handle) this.callback = undefined;
	}
	advanceBy(durationMs: number): void {
		this.currentTime += durationMs;
		const callback = this.callback;
		this.callback = undefined;
		callback?.();
	}
	get pendingTasks(): number { return this.callback ? 1 : 0; }
}

class NoopTerminal implements Terminal {
	readonly kittyProtocolActive = false;
	columns = 120;
	rows = 40;
	frameWrites = 0;
	private completion: ((generation: number, error?: Error) => void) | undefined;
	start(): void {}
	stop(): void {}
	async drainInput(): Promise<void> {}
	write(): void {}
	setFrameWriteCompletionListener(listener: ((generation: number, error?: Error) => void) | undefined): void {
		this.completion = listener;
	}
	writeFrame(_data: string, generation: number): void {
		this.frameWrites++;
		this.completion?.(generation);
	}
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
	doRenderCalls = 0;
	override requestRender(force = false): void {
		this.requestRenderCalls++;
		super.requestRender(force);
	}
	protected override doRender(): void {
		this.doRenderCalls++;
		super.doRender();
	}
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

function resetMetrics(metrics: ToolExecutionAllocationMetrics | AssistantMessageAllocationMetrics): void {
	for (const key of Object.keys(metrics) as Array<keyof typeof metrics>) metrics[key] = 0;
}

function createRenderer(historyItems: number): {
	renderer: InstrumentedMainScreen;
	reference: TUI;
	transcript: RetainedContainer;
	instrumentation: TuiRenderInstrumentation;
	terminal: NoopTerminal;
} {
	const terminal = new NoopTerminal();
	const renderer = new InstrumentedMainScreen(terminal, false);
	const instrumentation = new TuiRenderInstrumentation();
	const transcript = new RetainedContainer({ instrumentation });
	for (let index = 0; index < historyItems; index++) {
		transcript.addRetainedChild(new Text(`history-${index}`, 0, 0), {
			id: `history-${index}`,
			version: 1,
			completed: true,
		});
	}
	renderer.setRenderInstrumentation(instrumentation);
	renderer.addChild(transcript);
	return {
		renderer,
		reference: createInteractiveTuiReference(() => renderer),
		transcript,
		instrumentation,
		terminal,
	};
}

function createSession(mode: { handleEvent(event: BenchEvent): void | Promise<void> }): SessionHarness {
	activeMode = mode;
	const session = Object.create(AgentSession.prototype) as SessionHarness;
	session._eventListeners = [{
		listener: deliverPacedSessionEvent,
		criticalAgentEnd: false,
		observeRejection: failOnListenerRejection,
	}];
	session._extensionObserverDelivery = { publishLatest: publishNoopExtensionObserver };
	return session;
}

function createDelivery(session: SessionHarness, scheduler: SingleTaskScheduler): EventDeliveryDispatcher<BenchEvent, string> {
	activeSession = session;
	const agent = new Agent({ streamFn: throwUnusedStream as never });
	const harness = agent as unknown as SnapshotAgentHarness;
	const delivery = new EventDeliveryDispatcher<BenchEvent, string>({
		scheduler,
		defaultMinIntervalMs: 16,
		snapshotLatest: snapshotPacedEvent,
	});
	harness.activeRun = { abortController: new AbortController() };
	harness.eventDelivery = delivery;
	activeSnapshotAgent = harness;
	delivery.subscribe(deliverPacedObserverEvent, { delivery: "latest", minIntervalMs: 16 });
	return delivery;
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

async function profilePaced(
	name: string,
	deliveries: number,
	warmupDeliveries: number,
	runDelivery: (firstRawIndex: number) => Promise<void>,
	beginMeasured: () => void,
	metrics: () => Record<string, unknown>,
): Promise<Record<string, unknown>> {
	for (let index = 0; index < warmupDeliveries; index++) await runDelivery(-((warmupDeliveries - index) * RAW_PER_DELIVERY));
	beginMeasured();
	globalThis.gc!();
	globalThis.gc!();
	let minorGcCount = 0;
	let majorGcCount = 0;
	let totalGcDurationMs = 0;
	const gcObserver = new PerformanceObserver((list) => {
		for (const rawEntry of list.getEntries()) {
			const entry = rawEntry as GcEntry;
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
	const durations = new Array<number>(deliveries);
	for (let delivery = 0; delivery < deliveries; delivery++) {
		const started = performance.now();
		await runDelivery(delivery * RAW_PER_DELIVERY);
		durations[delivery] = performance.now() - started;
	}
	const stopped = await inspector.post("HeapProfiler.stopSampling");
	await inspector.post("HeapProfiler.disable");
	inspector.disconnect();
	await new Promise<void>((resolve) => setTimeout(resolve, 50));
	gcObserver.disconnect();
	const sampled = allocationSites(stopped.profile.head as SamplingNode);
	const sorted = durations.slice().sort((left, right) => left - right);
	return {
		name,
		rawUpdates: deliveries * RAW_PER_DELIVERY,
		actualDeliveries: deliveries,
		metrics: {
			cpuP50MsPerDelivery: percentile(sorted, 0.5),
			cpuP95MsPerDelivery: percentile(sorted, 0.95),
			cpuP50MsPerRawUpdate: percentile(sorted, 0.5) / RAW_PER_DELIVERY,
			cpuP95MsPerRawUpdate: percentile(sorted, 0.95) / RAW_PER_DELIVERY,
			sampledAllocationBytes: sampled.sampledBytes,
			sampledAllocationBytesPerRawUpdate: sampled.sampledBytes / (deliveries * RAW_PER_DELIVERY),
			sampledAllocationBytesPerDelivery: sampled.sampledBytes / deliveries,
			minorGcCount,
			majorGcCount,
			totalGcDurationMs,
			...metrics(),
		},
		topAllocationSites: sampled.top,
	};
}

async function measureTool(
	name: string,
	toolName: string,
	definition: ToolDefinition<any, any> | undefined,
	historyItems: number,
	deliveries: number,
	warmupDeliveries: number,
): Promise<Record<string, unknown>> {
	const { renderer, reference, transcript, instrumentation, terminal } = createRenderer(historyItems);
	const metrics = createToolMetrics();
	const component = new ToolExecutionComponent(
		toolName,
		"paced-tool",
		{ value: 1 },
		{ allocationMetrics: metrics },
		definition,
		reference,
		process.cwd(),
	);
	transcript.addRetainedChild(component, { id: "paced-tool", version: 0 });
	const mode = Object.create(InteractiveMode.prototype) as { handleEvent(event: BenchEvent): void } & Record<string, unknown>;
	Object.assign(mode, {
		isInitialized: true,
		footer: { invalidate(): void {} },
		pendingTools: new Map([["paced-tool", component]]),
		deferredReadExecutions: new Map(),
		chatContainer: transcript,
		ui: reference,
	});
	const session = createSession(mode);
	const scheduler = new SingleTaskScheduler();
	const delivery = createDelivery(session, scheduler);
	renderer.renderNow();
	resetMetrics(metrics);
	instrumentation.reset();
	renderer.requestRenderCalls = 0;
	renderer.doRenderCalls = 0;
	terminal.frameWrites = 0;
	let statsBefore = delivery.stats;
	let snapshotsBefore = snapshotCount;
	let promisesBefore = builtInListenerPromises;
	let finalSentinel = "";
	const runDelivery = async (firstRawIndex: number): Promise<void> => {
		for (let offset = 0; offset < RAW_PER_DELIVERY; offset++) {
			const index = firstRawIndex + offset;
			finalSentinel = `tool-${index}`;
			delivery.publishLatest("tool:paced-tool", {
				type: "tool_execution_update",
				toolCallId: "paced-tool",
				toolName,
				partialResult: { content: [{ type: "text", text: finalSentinel }] },
			});
		}
		scheduler.advanceBy(16);
		await delivery.flushLatest("tool:paced-tool");
		renderer.renderNow();
	};
	const result = await profilePaced(name, deliveries, warmupDeliveries, runDelivery, () => {
		resetMetrics(metrics);
		instrumentation.reset();
		renderer.requestRenderCalls = 0;
		renderer.doRenderCalls = 0;
		terminal.frameWrites = 0;
		statsBefore = delivery.stats;
		snapshotsBefore = snapshotCount;
		promisesBefore = builtInListenerPromises;
	}, () => {
		const stats = delivery.stats;
		const render = instrumentation.snapshot();
		const finalText = (component as unknown as { result?: { content?: Array<{ text?: string }> } })
			.result?.content?.[0]?.text ?? "";
		return {
			historyItems,
			coalescedUpdates: stats.coalesced - statsBefore.coalesced,
			deliveries: stats.delivered - statsBefore.delivered,
			snapshotCount: snapshotCount - snapshotsBefore,
			updateDisplayCalls: metrics.updateDisplayCalls,
			requestRenderCalls: renderer.requestRenderCalls,
			doRenderCalls: renderer.doRenderCalls,
			frameWrites: terminal.frameWrites,
			activeItemRenders: render.activeItemRenders,
			completedItemRenders: render.completedItemRenders,
			viewportItemVisits: render.viewportItemVisits,
			builtInListenerPromises: builtInListenerPromises - promisesBefore,
			extensionVisibleRenderObjects: metrics.internalWrapperObjects,
			finalSentinelCorrect: finalText === finalSentinel ? 1 : 0,
			finalHash: createHash("sha256").update(finalText).digest("hex"),
			schedulerPendingTasks: scheduler.pendingTasks,
		};
	});
	await renderer.flushTerminalFrames();
	await delivery.dispose();
	await renderer.dispose({ preserveScreen: true });
	return result;
}

async function measureAssistant(
	name: string,
	thinking: boolean,
	historyItems: number,
	deliveries: number,
	warmupDeliveries: number,
): Promise<Record<string, unknown>> {
	const { renderer, reference, transcript, instrumentation, terminal } = createRenderer(historyItems);
	const metrics = createAssistantMetrics();
	const component = new AssistantMessageComponent(undefined, false, getMarkdownTheme(), "Thinking...", 1, [], metrics);
	const retained = transcript.addRetainedChild(component, { id: "paced-assistant", version: 0 });
	const mode = Object.create(InteractiveMode.prototype) as { handleEvent(event: BenchEvent): void } & Record<string, unknown>;
	Object.assign(mode, {
		isInitialized: true,
		footer: { invalidate(): void {} },
		streamingComponent: component,
		streamingItem: retained,
		streamingItemVersion: 0,
		pendingTools: new Map(),
		streamedToolIds: new Set(),
		deferredReadExecutions: new Map(),
		deferredReadPlaceholders: new Map(),
		chatContainer: transcript,
		ui: reference,
	});
	const session = createSession(mode);
	const scheduler = new SingleTaskScheduler();
	const delivery = createDelivery(session, scheduler);
	renderer.renderNow();
	resetMetrics(metrics);
	instrumentation.reset();
	renderer.requestRenderCalls = 0;
	renderer.doRenderCalls = 0;
	terminal.frameWrites = 0;
	let statsBefore = delivery.stats;
	let snapshotsBefore = snapshotCount;
	let promisesBefore = builtInListenerPromises;
	let finalSentinel = "";
	const runDelivery = async (firstRawIndex: number): Promise<void> => {
		for (let offset = 0; offset < RAW_PER_DELIVERY; offset++) {
			const index = firstRawIndex + offset;
			finalSentinel = `${thinking ? "thinking" : "assistant"}-${index}`;
			const message = {
				role: "assistant",
				content: thinking
					? [{ type: "thinking", thinking: finalSentinel }]
					: [{ type: "text", text: finalSentinel }],
				timestamp: index,
			} as AssistantMessage;
			delivery.publishLatest("message", { type: "message_update", message });
		}
		scheduler.advanceBy(16);
		await delivery.flushLatest("message");
		renderer.renderNow();
	};
	const result = await profilePaced(name, deliveries, warmupDeliveries, runDelivery, () => {
		resetMetrics(metrics);
		instrumentation.reset();
		renderer.requestRenderCalls = 0;
		renderer.doRenderCalls = 0;
		terminal.frameWrites = 0;
		statsBefore = delivery.stats;
		snapshotsBefore = snapshotCount;
		promisesBefore = builtInListenerPromises;
	}, () => {
		const stats = delivery.stats;
		const render = instrumentation.snapshot();
		const rendered = component.render(120).join("\n");
		return {
			historyItems,
			coalescedUpdates: stats.coalesced - statsBefore.coalesced,
			deliveries: stats.delivered - statsBefore.delivered,
			snapshotCount: snapshotCount - snapshotsBefore,
			updateContentCalls: metrics.updateContentCalls,
			requestRenderCalls: renderer.requestRenderCalls,
			doRenderCalls: renderer.doRenderCalls,
			frameWrites: terminal.frameWrites,
			activeItemRenders: render.activeItemRenders,
			completedItemRenders: render.completedItemRenders,
			viewportItemVisits: render.viewportItemVisits,
			builtInListenerPromises: builtInListenerPromises - promisesBefore,
			finalSentinelCorrect: rendered.includes(finalSentinel) ? 1 : 0,
			finalHash: createHash("sha256").update(rendered).digest("hex"),
			schedulerPendingTasks: scheduler.pendingTasks,
		};
	});
	await renderer.flushTerminalFrames();
	await delivery.dispose();
	await renderer.dispose({ preserveScreen: true });
	return result;
}

if (typeof globalThis.gc !== "function") throw new Error("tui-paced-real-leaf requires --expose-gc");
initTheme("dark");
const samplingInterval = readIntegerOption("--sampling-interval", 8_192);
const deliveries = readIntegerOption("--deliveries", 1_000);
const warmupDeliveries = readIntegerOption("--warmup-deliveries", 100);
const historyItems = readIntegerOption("--history-items", 5_000);
const customCounters = { calls: 0 };
const customDefinition = {
	name: "paced-custom",
	label: "Paced custom",
	description: "Paced benchmark renderer",
	parameters: { type: "object", properties: {} },
	renderResult(result): Component {
		customCounters.calls++;
		return new Text(result.content[0]?.text ?? "", 0, 0);
	},
} as ToolDefinition<any, any>;

const fixtures = [
	await measureTool("generic-tool-progress-history-500", "paced-generic", undefined, 500, deliveries, warmupDeliveries),
	await measureTool("generic-tool-progress", "paced-generic", undefined, historyItems, deliveries, warmupDeliveries),
	await measureTool("built-in-tool-progress", "read", undefined, historyItems, deliveries, warmupDeliveries),
	await measureTool("custom-tool-progress", "paced-custom", customDefinition, historyItems, deliveries, warmupDeliveries),
	await measureAssistant("assistant-plain-text", false, historyItems, deliveries, warmupDeliveries),
	await measureAssistant("assistant-thinking", true, historyItems, deliveries, warmupDeliveries),
];

process.stdout.write(`${JSON.stringify({
	schemaVersion: 1,
	benchmark: "tui-paced-real-leaf",
	commit: currentCommit(),
	node: process.version,
	platform: process.platform,
	arch: process.arch,
	rawPerDelivery: RAW_PER_DELIVERY,
	deliveries,
	historyItems,
	fixtures,
	sourceInvariant: {
		builtInOrdinaryDeliveryPromises: 0,
		toolWrapperObjects: 0,
		inlineClosures: 0,
		promiseTails: 0,
		promiseArrays: 0,
	},
}, null, 2)}\n`);
