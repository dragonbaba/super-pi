import { createHash } from "node:crypto";
import { Session } from "node:inspector/promises";
import { constants, performance, PerformanceObserver, type PerformanceEntry } from "node:perf_hooks";
import { Agent } from "../../packages/agent/src/agent.ts";
import { EventDeliveryDispatcher, type EventDeliveryScheduler } from "../../packages/agent/src/event-delivery.ts";
import { AgentSession } from "../../packages/coding-agent/src/core/agent-session.ts";
import type { ToolDefinition } from "../../packages/coding-agent/src/core/extensions/types.ts";
import {
	ToolExecutionComponent,
	type ToolExecutionAllocationMetrics,
} from "../../packages/coding-agent/src/modes/interactive/components/tool-execution.ts";
import {
	createInteractiveTuiReference,
	InteractiveMode,
} from "../../packages/coding-agent/src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../../packages/coding-agent/src/modes/interactive/theme/theme.ts";
import { RetainedContainer } from "../../packages/tui/src/components/retained-item.ts";
import { TuiRenderInstrumentation } from "../../packages/tui/src/render-instrumentation.ts";
import { getCapabilities, setCapabilities } from "../../packages/tui/src/terminal-image.ts";
import type { Terminal } from "../../packages/tui/src/terminal.ts";
import { Text } from "../../packages/tui/src/components/text.ts";
import type { Component, TUI } from "../../packages/tui/src/tui.ts";
import { TuiMainScreen } from "../../packages/tui/src/tui-main-screen.ts";
import { currentCommit, readIntegerOption } from "./benchmark.ts";

type BenchEvent = { type: string; [key: string]: unknown };
type SamplingNode = {
	callFrame: { functionName: string; url: string; lineNumber: number; columnNumber: number };
	selfSize: number;
	children?: SamplingNode[];
};
type GcEntry = PerformanceEntry & { detail?: { kind?: number } };
type AllocationSite = { bytes: number; functionName: string; url: string; line: number; column: number };
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
	eventDelivery: EventDeliveryDispatcher<BenchEvent, string>;
	snapshotObserverEvent(event: BenchEvent): BenchEvent;
};

const RAW_UPDATES_PER_FLUSH_CYCLE = 20;
let activeMode: { handleEvent(event: BenchEvent): void | Promise<void> };
let activeSession: SessionHarness;
let activeAgent: AgentHarness;
let builtInPromises = 0;
let snapshotCount = 0;

function deliverSessionEvent(event: BenchEvent): void | Promise<void> {
	const result = activeMode.handleEvent(event);
	if (result && typeof result.then === "function") builtInPromises++;
	return result;
}
function deliverObserverEvent(event: BenchEvent): void { activeSession._handleAgentObserverEvent(event); }
function snapshotEvent(event: BenchEvent): BenchEvent { snapshotCount++; return activeAgent.snapshotObserverEvent(event); }
function publishNoopObserver(): void {}
function failOnRejection(error: unknown): never { throw error; }
function throwUnusedStream(): never { throw new Error("provider stream is not used by this benchmark"); }

class NoopTerminal implements Terminal {
	readonly kittyProtocolActive = false;
	columns = 120;
	rows = 40;
	frameWrites = 0;
	private completion: ((generation: number, error?: Error) => void) | undefined;
	start(): void {}
	stop(): void {}
	drainInput(): Promise<void> { return Promise.resolve(); }
	write(): void {}
	setFrameWriteCompletionListener(listener: ((generation: number, error?: Error) => void) | undefined): void { this.completion = listener; }
	writeFrame(_data: string, generation: number): void { this.frameWrites++; this.completion?.(generation); }
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
	override requestRender(force = false): void { this.requestRenderCalls++; super.requestRender(force); }
	protected override doRender(): void { this.doRenderCalls++; super.doRender(); }
}

class SingleTaskScheduler implements EventDeliveryScheduler {
	private clock = 0;
	private callback: (() => void) | undefined;
	private handle = 0;
	now(): number { return this.clock; }
	schedule(callback: () => void): number { if (this.callback) throw new Error("one scheduler task expected"); this.callback = callback; return ++this.handle; }
	cancel(handle: unknown): void { if (handle === this.handle) this.callback = undefined; }
	advance(): void { this.clock += 16; const callback = this.callback; this.callback = undefined; callback?.(); }
	get pendingTasks(): number { return this.callback ? 1 : 0; }
}

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

function resetMetrics(metrics: ToolExecutionAllocationMetrics): void {
	for (const key of Object.keys(metrics) as Array<keyof ToolExecutionAllocationMetrics>) metrics[key] = 0;
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
			else sites.set(key, { bytes: node.selfSize, functionName: frame.functionName || "(anonymous)", url: frame.url, line: frame.lineNumber + 1, column: frame.columnNumber + 1 });
		}
		if (node.children) for (const child of node.children) pending.push(child);
	}
	return { sampledBytes, top: [...sites.values()].sort((left, right) => right.bytes - left.bytes).slice(0, 20) };
}

function percentile(sorted: readonly number[], ratio: number): number {
	return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1))] ?? 0;
}

function customDefinition(): ToolDefinition<any, any> {
	return {
		name: "bench-custom",
		label: "Bench custom",
		description: "benchmark",
		parameters: { type: "object", properties: {} },
		async execute() { return { content: [], details: undefined }; },
		renderCall(args): Component { return new Text(`call:${args.value ?? ""}`, 0, 0); },
		renderResult(result): Component { return new Text(result.content[0]?.text ?? "", 0, 0); },
	} as ToolDefinition<any, any>;
}

type ToolFixtureKind = "generic" | "built-in" | "custom" | "image";

function createFixture(kind: ToolFixtureKind, historyItems: number): {
	renderer: InstrumentedMainScreen;
	terminal: NoopTerminal;
	transcript: RetainedContainer;
	component: ToolExecutionComponent;
	metrics: ToolExecutionAllocationMetrics;
	session: SessionHarness;
	instrumentation: TuiRenderInstrumentation;
} {
	const terminal = new NoopTerminal();
	const renderer = new InstrumentedMainScreen(terminal, false);
	const instrumentation = new TuiRenderInstrumentation();
	const transcript = new RetainedContainer({ instrumentation });
	for (let index = 0; index < historyItems; index++) transcript.addRetainedChild(new Text(`history-${index}`, 0, 0), { id: `history-${index}`, version: 1, completed: true });
	renderer.setRenderInstrumentation(instrumentation);
	renderer.addChild(transcript);
	const reference = createInteractiveTuiReference(() => renderer);
	const metrics = createMetrics();
	const toolName = kind === "built-in" ? "read" : kind === "custom" ? "bench-custom" : "bench-generic";
	const component = new ToolExecutionComponent(toolName, "tool-1", { value: 1 }, { allocationMetrics: metrics, showImages: kind === "image" }, kind === "custom" ? customDefinition() : undefined, reference, process.cwd());
	transcript.addRetainedChild(component, { id: "tool-1", version: 0 });
	activeMode = Object.assign(Object.create(InteractiveMode.prototype), {
		isInitialized: true,
		footer: { invalidate(): void {} },
		pendingTools: new Map([["tool-1", component]]),
		deferredReadExecutions: new Map(),
		chatContainer: transcript,
		ui: reference,
	});
	const session = Object.create(AgentSession.prototype) as SessionHarness;
	session._eventListeners = [{ listener: deliverSessionEvent, criticalAgentEnd: false, observeRejection: failOnRejection }];
	session._extensionObserverDelivery = { publishLatest: publishNoopObserver };
	return { renderer, terminal, transcript, component, metrics, session, instrumentation };
}

async function profileFixture(kind: ToolFixtureKind, paced: boolean): Promise<Record<string, unknown>> {
	const historyItems = readIntegerOption("--history-items", 5_000);
	const updates = readIntegerOption("--updates", paced ? 20_000 : 20_000);
	const warmup = readIntegerOption("--warmup", paced ? 2_000 : 5_000);
	const samplingInterval = readIntegerOption("--sampling-interval", 8_192);
	const previousCapabilities = getCapabilities();
	if (kind === "image") setCapabilities({ ...previousCapabilities, images: "iterm2" });
	const fixture = createFixture(kind, historyItems);
	const scheduler = paced ? new SingleTaskScheduler() : undefined;
	let delivery: EventDeliveryDispatcher<BenchEvent, string> | undefined;
	if (scheduler) {
		activeSession = fixture.session;
		const agent = new Agent({ streamFn: throwUnusedStream as never });
		activeAgent = agent as unknown as AgentHarness;
		activeAgent.activeRun = { abortController: new AbortController() };
		delivery = new EventDeliveryDispatcher<BenchEvent, string>({ scheduler, defaultMinIntervalMs: 16, snapshotLatest: snapshotEvent });
		activeAgent.eventDelivery = delivery;
		delivery.subscribe(deliverObserverEvent, { delivery: "latest", minIntervalMs: 16 });
	}
	let sentinel = "";
	let rawIndex = 0;
	const deliverDirect = (): void => {
		sentinel = `${kind}-${rawIndex++}`;
		const content = kind === "image"
			? [{ type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" }, { type: "text", text: sentinel }]
			: [{ type: "text", text: sentinel }];
		fixture.session._emit({ type: "tool_execution_update", toolCallId: "tool-1", toolName: kind, partialResult: { content } });
	};
	const deliverPaced = async (): Promise<void> => {
		for (let offset = 0; offset < RAW_UPDATES_PER_FLUSH_CYCLE; offset++) {
			sentinel = `${kind}-${rawIndex++}`;
			const content = kind === "image"
				? [{ type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" }, { type: "text", text: sentinel }]
				: [{ type: "text", text: sentinel }];
			delivery!.publishLatest("tool:tool-1", { type: "tool_execution_update", toolCallId: "tool-1", toolName: kind, partialResult: { content } });
		}
		scheduler!.advance();
		await delivery!.flushLatest("tool:tool-1");
		fixture.renderer.renderNow();
	};
	const warmupCycles = paced ? Math.ceil(warmup / RAW_UPDATES_PER_FLUSH_CYCLE) : warmup;
	if (paced) for (let index = 0; index < warmupCycles; index++) await deliverPaced();
	else for (let index = 0; index < warmupCycles; index++) deliverDirect();
	resetMetrics(fixture.metrics);
	fixture.instrumentation.reset();
	fixture.renderer.requestRenderCalls = 0;
	fixture.renderer.doRenderCalls = 0;
	fixture.terminal.frameWrites = 0;
	builtInPromises = 0;
	snapshotCount = 0;
	const deliveryStatsBefore = delivery?.stats;
	globalThis.gc!();
	globalThis.gc!();
	let minorGcCount = 0;
	let majorGcCount = 0;
	let totalGcDurationMs = 0;
	const gcObserver = new PerformanceObserver((list) => {
		for (const raw of list.getEntries()) {
			const entry = raw as GcEntry;
			totalGcDurationMs += entry.duration;
			if (entry.detail?.kind === constants.NODE_PERFORMANCE_GC_MINOR) minorGcCount++;
			else if (entry.detail?.kind === constants.NODE_PERFORMANCE_GC_MAJOR) majorGcCount++;
		}
	});
	gcObserver.observe({ entryTypes: ["gc"] });
	const inspector = new Session();
	inspector.connect();
	await inspector.post("HeapProfiler.enable");
	await inspector.post("HeapProfiler.startSampling", { samplingInterval, includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true });
	const measuredCycles = paced ? Math.ceil(updates / RAW_UPDATES_PER_FLUSH_CYCLE) : updates;
	const durations = new Array<number>(measuredCycles);
	for (let index = 0; index < measuredCycles; index++) {
		const started = performance.now();
		if (paced) await deliverPaced();
		else deliverDirect();
		durations[index] = performance.now() - started;
	}
	const stopped = await inspector.post("HeapProfiler.stopSampling");
	await inspector.post("HeapProfiler.disable");
	inspector.disconnect();
	await new Promise<void>((resolve) => setTimeout(resolve, 50));
	gcObserver.disconnect();
	const sampled = allocationSites(stopped.profile.head as SamplingNode);
	const sorted = durations.slice().sort((left, right) => left - right);
	const render = fixture.instrumentation.snapshot();
	const deliveryStatsAfter = delivery?.stats;
	let finalText = "";
	const finalContent = (fixture.component as unknown as { result?: { content?: Array<{ text?: string }> } }).result?.content;
	if (finalContent) for (const block of finalContent) if (block.text) finalText = block.text;
	if (delivery) await delivery.dispose();
	await fixture.renderer.dispose({ preserveScreen: true });
	if (kind === "image") setCapabilities(previousCapabilities);
	return {
		name: `${paced ? "paced" : "direct"}-${kind}-tool-leaf`,
		coverage: { realAgentDelivery: paced, productionSnapshot: paced, realAgentSession: true, realInteractiveMode: true, stableFacade: true, realToolComponent: true, realToolRenderer: true, retainedViewport: true, frameQueue: paced },
		rawUpdates: paced ? measuredCycles * RAW_UPDATES_PER_FLUSH_CYCLE : measuredCycles,
		coalescedUpdates: deliveryStatsAfter && deliveryStatsBefore ? deliveryStatsAfter.coalesced - deliveryStatsBefore.coalesced : 0,
		actualDeliveries: measuredCycles,
		dispatcherDeliveries: deliveryStatsAfter && deliveryStatsBefore ? deliveryStatsAfter.delivered - deliveryStatsBefore.delivered : measuredCycles,
		metrics: {
			cpuP50MsPerDelivery: percentile(sorted, 0.5),
			cpuP95MsPerDelivery: percentile(sorted, 0.95),
			sampledAllocationBytesPerRawUpdate: sampled.sampledBytes / (paced ? measuredCycles * RAW_UPDATES_PER_FLUSH_CYCLE : measuredCycles),
			sampledAllocationBytesPerDelivery: sampled.sampledBytes / measuredCycles,
			minorGcCount, majorGcCount, totalGcDurationMs,
			updateDisplayCalls: fixture.metrics.updateDisplayCalls,
			callRendererCalls: fixture.metrics.callRendererCalls,
			resultRendererCalls: fixture.metrics.resultRendererCalls,
			componentCreations: fixture.metrics.componentCreations,
			renderContextObjects: fixture.metrics.renderContextObjects,
			internalWrapperObjects: fixture.metrics.internalWrapperObjects,
			imageScans: fixture.metrics.imageScans,
			argsSerializations: fixture.metrics.argsSerializations,
			toolArgsGenerationUpdates: fixture.metrics.toolArgsGenerationUpdates,
			toolArgsReplacementUpdates: fixture.metrics.toolArgsReplacementUpdates,
			toolArgsSemanticFallbackComparisons: fixture.metrics.toolArgsSemanticFallbackComparisons,
			toolArgsMissingGenerationUpdates: fixture.metrics.toolArgsMissingGenerationUpdates,
			toolArgsFinalizations: fixture.metrics.toolArgsFinalizations,
			requestRenderCalls: fixture.renderer.requestRenderCalls,
			doRenderCalls: fixture.renderer.doRenderCalls,
			frameWrites: fixture.terminal.frameWrites,
			snapshotCount,
			builtInPromises,
			completedItemRenders: render.completedItemRenders,
			activeItemRenders: render.activeItemRenders,
			viewportItemVisits: render.viewportItemVisits,
			finalSentinelCorrect: finalText === sentinel ? 1 : 0,
			finalHash: createHash("sha256").update(finalText).digest("hex"),
			schedulerPendingTasks: scheduler?.pendingTasks ?? 0,
		},
		sourceInvariant: { inlineClosuresPerUpdate: 0, promiseTailsPerUpdate: 0, promiseArraysPerUpdate: 0, eventWrapperObjectsPerUpdate: 0 },
		topAllocationSites: sampled.top,
	};
}

if (typeof globalThis.gc !== "function") throw new Error("tui-tool-leaf-allocations requires --expose-gc");
initTheme("dark");
const paced = process.argv.includes("--paced");
const results = [];
for (const kind of ["generic", "built-in", "custom", "image"] as const) results.push(await profileFixture(kind, paced));
process.stdout.write(`${JSON.stringify({
	schemaVersion: 1,
	benchmark: paced ? "tui-paced-tool-leaf" : "tui-tool-leaf-allocations",
	commit: currentCommit(),
	node: process.version,
	platform: process.platform,
	arch: process.arch,
	rawUpdatesPerFlushCycle: paced ? RAW_UPDATES_PER_FLUSH_CYCLE : 1,
	results,
}, null, 2)}\n`);
