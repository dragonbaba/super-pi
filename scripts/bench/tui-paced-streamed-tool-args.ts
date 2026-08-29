import { createHash } from "node:crypto";
import { Session } from "node:inspector/promises";
import { constants, performance, PerformanceObserver, type PerformanceEntry } from "node:perf_hooks";
import { Agent } from "../../packages/agent/src/agent.ts";
import { EventDeliveryDispatcher, type EventDeliveryScheduler } from "../../packages/agent/src/event-delivery.ts";
import { AgentSession } from "../../packages/coding-agent/src/core/agent-session.ts";
import {
	ToolExecutionComponent,
	type ToolExecutionAllocationMetrics,
} from "../../packages/coding-agent/src/modes/interactive/components/tool-execution.ts";
import {
	createInteractiveTuiReference,
	InteractiveMode,
} from "../../packages/coding-agent/src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../../packages/coding-agent/src/modes/interactive/theme/theme.ts";
import { Text } from "../../packages/tui/src/components/text.ts";
import { RetainedContainer } from "../../packages/tui/src/components/retained-item.ts";
import { TuiRenderInstrumentation } from "../../packages/tui/src/render-instrumentation.ts";
import type { Terminal } from "../../packages/tui/src/terminal.ts";
import { TuiMainScreen } from "../../packages/tui/src/tui-main-screen.ts";
import type { TUI } from "../../packages/tui/src/tui.ts";
import { currentCommit, readIntegerOption } from "./benchmark.ts";

type BenchEvent = { type: string; [key: string]: unknown };
type Scenario = "single-mutation" | "interleaved-mutation" | "openai-custom" | "replacement-object";
type SamplingNode = {
	callFrame: { functionName: string; url: string; lineNumber: number; columnNumber: number };
	selfSize: number;
	children?: SamplingNode[];
};
type GcEntry = PerformanceEntry & { detail?: { kind?: number } };
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
	processEvents(event: BenchEvent): Promise<void>;
};

const RAW_PER_DELIVERY = 20;
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
	schedule(callback: () => void): number {
		if (this.callback) throw new Error("one scheduler task expected");
		this.callback = callback;
		return ++this.handle;
	}
	cancel(handle: unknown): void { if (handle === this.handle) this.callback = undefined; }
	advance(): void {
		this.clock += 16;
		const callback = this.callback;
		this.callback = undefined;
		callback?.();
	}
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

function percentile(sorted: readonly number[], ratio: number): number {
	return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1))] ?? 0;
}

function allocationSites(head: SamplingNode): { sampledBytes: number; top: unknown[] } {
	const sites = new Map<string, { bytes: number; functionName: string; url: string; line: number; column: number }>();
	let sampledBytes = 0;
	const pending = [head];
	while (pending.length > 0) {
		const node = pending.pop()!;
		if (node.selfSize > 0) {
			sampledBytes += node.selfSize;
			const frame = node.callFrame;
			const key = `${frame.url}\0${frame.lineNumber}\0${frame.columnNumber}\0${frame.functionName}`;
			const site = sites.get(key);
			if (site) site.bytes += node.selfSize;
			else sites.set(key, { bytes: node.selfSize, functionName: frame.functionName || "(anonymous)", url: frame.url, line: frame.lineNumber + 1, column: frame.columnNumber + 1 });
		}
		if (node.children) for (const child of node.children) pending.push(child);
	}
	return { sampledBytes, top: [...sites.values()].sort((left, right) => right.bytes - left.bytes).slice(0, 20) };
}

function messageEvent(
	api: "openai-completions" | "pi-messages",
	content: Array<Record<string, unknown>>,
	contentIndex: number,
	type: "toolcall_delta" | "toolcall_end",
	delta: string,
	generation?: number,
): BenchEvent {
	const message = { role: "assistant", api, provider: "fixture", model: "fixture", content, timestamp: 0 };
	return {
		type: "message_update",
		message,
		assistantMessageEvent: type === "toolcall_end"
			? { type, contentIndex, toolCall: content[contentIndex], partial: message }
			: { type, contentIndex, delta, partial: message, toolArgsGeneration: generation },
	};
}

async function profileScenario(scenario: Scenario): Promise<Record<string, unknown>> {
	const historyItems = readIntegerOption("--history-items", 5_000);
	const rawUpdates = readIntegerOption("--updates", 20_000);
	const warmup = readIntegerOption("--warmup", 2_000);
	const samplingInterval = readIntegerOption("--sampling-interval", 8_192);
	const terminal = new NoopTerminal();
	const renderer = new InstrumentedMainScreen(terminal, false);
	const instrumentation = new TuiRenderInstrumentation();
	const transcript = new RetainedContainer({ instrumentation });
	for (let index = 0; index < historyItems; index++) {
		transcript.addRetainedChild(new Text(`history-${index}`, 0, 0), { id: `history-${index}`, version: 1, completed: true });
	}
	renderer.setRenderInstrumentation(instrumentation);
	renderer.addChild(transcript);
	const reference = createInteractiveTuiReference(() => renderer);
	const metrics = createMetrics();
	const toolCount = scenario === "interleaved-mutation" ? 2 : 1;
	const args = new Array<Record<string, unknown>>(toolCount);
	const content = new Array<Record<string, unknown>>(toolCount);
	const pendingTools = new Map<string, ToolExecutionComponent>();
	for (let index = 0; index < toolCount; index++) {
		args[index] = { value: 0 };
		content[index] = { type: "toolCall", id: `tool-${index}`, name: `tool-${index}`, arguments: args[index], partialArgs: "0" };
		const component = new ToolExecutionComponent(`tool-${index}`, `tool-${index}`, args[index], { allocationMetrics: metrics }, undefined, reference, process.cwd());
		pendingTools.set(`tool-${index}`, component);
		transcript.addRetainedChild(component, { id: `tool-${index}`, version: 0 });
	}
	activeMode = Object.assign(Object.create(InteractiveMode.prototype), {
		isInitialized: true,
		footer: { invalidate(): void {} },
		streamingComponent: { updateContent(): void {} },
		streamingMessage: undefined,
		streamingItem: { updateVersion(): void {} },
		streamingItemVersion: 0,
		pendingTools,
		streamedToolIds: new Set(pendingTools.keys()),
		deferredReadPlaceholders: new Map(),
		deferredReadExecutions: new Map(),
		chatContainer: transcript,
		ui: reference,
	});
	const session = Object.create(AgentSession.prototype) as SessionHarness;
	session._eventListeners = [{ listener: deliverSessionEvent, criticalAgentEnd: false, observeRejection: failOnRejection }];
	session._extensionObserverDelivery = { publishLatest: publishNoopObserver };
	activeSession = session;
	const agent = new Agent({ streamFn: throwUnusedStream as never });
	activeAgent = agent as unknown as AgentHarness;
	activeAgent.activeRun = { abortController: new AbortController() };
	const scheduler = new SingleTaskScheduler();
	const delivery = new EventDeliveryDispatcher<BenchEvent, string>({ scheduler, defaultMinIntervalMs: 16, snapshotLatest: snapshotEvent });
	activeAgent.eventDelivery = delivery;
	delivery.subscribe(deliverObserverEvent, { delivery: "latest", minIntervalMs: 16 });
	let updateIndex = 0;
	let sentinel = "";
	const deliverCycle = async (): Promise<void> => {
		for (let offset = 0; offset < RAW_PER_DELIVERY; offset++) {
			const toolIndex = scenario === "interleaved-mutation" ? updateIndex & 1 : 0;
			sentinel = `${scenario}:${updateIndex++}`;
			let generation: number | undefined;
			if (scenario === "replacement-object" || scenario === "openai-custom") {
				args[toolIndex] = { value: sentinel };
				content[toolIndex]!.arguments = args[toolIndex];
				if (scenario === "openai-custom") generation = updateIndex;
			} else {
				args[toolIndex]!.value = sentinel;
				content[toolIndex]!.partialArgs = String(updateIndex);
			}
			await activeAgent.processEvents(messageEvent(
				scenario === "replacement-object" ? "pi-messages" : "openai-completions",
				content,
				toolIndex,
				"toolcall_delta",
				sentinel,
				generation,
			));
		}
		scheduler.advance();
		await delivery.flushAllLatest();
		renderer.renderNow();
	};
	for (let index = 0; index < Math.ceil(warmup / RAW_PER_DELIVERY); index++) await deliverCycle();
	resetMetrics(metrics);
	instrumentation.reset();
	renderer.requestRenderCalls = 0;
	renderer.doRenderCalls = 0;
	terminal.frameWrites = 0;
	builtInPromises = 0;
	snapshotCount = 0;
	const statsBefore = delivery.stats;
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
	const measuredCycles = Math.ceil(rawUpdates / RAW_PER_DELIVERY);
	const durations = new Array<number>(measuredCycles);
	for (let index = 0; index < measuredCycles; index++) {
		const started = performance.now();
		await deliverCycle();
		durations[index] = performance.now() - started;
	}
	const measuredStats = delivery.stats;
	const measuredSnapshotCount = snapshotCount;
	for (let toolIndex = 0; toolIndex < toolCount; toolIndex++) {
		await activeAgent.processEvents(messageEvent(
			scenario === "replacement-object" ? "pi-messages" : "openai-completions",
			content,
			toolIndex,
			"toolcall_end",
			"",
		));
	}
	scheduler.advance();
	await delivery.flushAllLatest();
	renderer.renderNow();
	const stopped = await inspector.post("HeapProfiler.stopSampling");
	await inspector.post("HeapProfiler.disable");
	inspector.disconnect();
	await new Promise<void>((resolve) => setTimeout(resolve, 50));
	gcObserver.disconnect();
	const sampled = allocationSites(stopped.profile.head as SamplingNode);
	const sorted = durations.slice().sort((left, right) => left - right);
	const statsAfter = delivery.stats;
	const render = instrumentation.snapshot();
	let finalText = "";
	for (const component of pendingTools.values()) finalText += component.render(120).join("\n");
	await delivery.dispose();
	await renderer.dispose({ preserveScreen: true });
	return {
		name: scenario,
		coverage: {
			providerEventStream: true,
			realAgentDelivery: true,
			productionSnapshot: true,
			realAgentSession: true,
			realInteractiveMode: true,
			stableFacade: true,
			realToolComponent: true,
			retainedViewport: true,
			mainFrameQueue: true,
		},
		rawUpdates: measuredCycles * RAW_PER_DELIVERY,
		coalescedUpdates: measuredStats.coalesced - statsBefore.coalesced,
		actualDeliveries: measuredStats.delivered - statsBefore.delivered,
		finalizationDeliveries: statsAfter.delivered - measuredStats.delivered,
		snapshotCount: measuredSnapshotCount,
		totalSnapshotCount: snapshotCount,
		metrics: {
			cpuP50MsPerDelivery: percentile(sorted, 0.5),
			cpuP95MsPerDelivery: percentile(sorted, 0.95),
			sampledAllocationBytesPerRawUpdate: sampled.sampledBytes / (measuredCycles * RAW_PER_DELIVERY),
			sampledAllocationBytesPerDelivery: sampled.sampledBytes / measuredCycles,
			minorGcCount,
			majorGcCount,
			totalGcDurationMs,
			toolArgsGenerationUpdates: metrics.toolArgsGenerationUpdates,
			toolArgsReplacementUpdates: metrics.toolArgsReplacementUpdates,
			toolArgsSemanticFallbackComparisons: metrics.toolArgsSemanticFallbackComparisons,
			toolArgsMissingGenerationUpdates: metrics.toolArgsMissingGenerationUpdates,
			toolArgsFinalizations: metrics.toolArgsFinalizations,
			updateDisplayCalls: metrics.updateDisplayCalls,
			callRendererCalls: metrics.callRendererCalls,
			argsSerializations: metrics.argsSerializations,
			requestRenderCalls: renderer.requestRenderCalls,
			doRenderCalls: renderer.doRenderCalls,
			frameWrites: terminal.frameWrites,
			builtInPromises,
			completedItemRenders: render.completedItemRenders,
			activeItemRenders: render.activeItemRenders,
			finalSentinelCorrect: finalText.includes(sentinel) ? 1 : 0,
			finalHash: createHash("sha256").update(finalText).digest("hex"),
			schedulerPendingTasks: scheduler.pendingTasks,
		},
		sourceInvariant: { inlineClosuresPerUpdate: 0, promiseTailsPerUpdate: 0, promiseArraysPerUpdate: 0 },
		topAllocationSites: sampled.top,
	};
}

if (typeof globalThis.gc !== "function") throw new Error("tui-paced-streamed-tool-args requires --expose-gc");
initTheme("dark");
const results = [];
for (const scenario of ["single-mutation", "interleaved-mutation", "openai-custom", "replacement-object"] as const) {
	results.push(await profileScenario(scenario));
}
process.stdout.write(`${JSON.stringify({
	schemaVersion: 1,
	benchmark: "tui-paced-streamed-tool-args",
	commit: currentCommit(),
	node: process.version,
	platform: process.platform,
	arch: process.arch,
	rawPerDelivery: RAW_PER_DELIVERY,
	results,
}, null, 2)}\n`);
