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
type Scenario =
	| "single-mutation"
	| "interleaved-mutation"
	| "openai-custom"
	| "interleaved-openai-custom"
	| "replacement-object"
	| "cardinality-1"
	| "cardinality-2"
	| "cardinality-4"
	| "cardinality-8"
	| "cardinality-16";
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
	releaseObserverEvent(key: string, event: BenchEvent): void;
	processEvents(event: BenchEvent): Promise<void>;
};

const RAW_UPDATES_PER_FLUSH_CYCLE = 20;
let activeMode: { handleEvent(event: BenchEvent): void | Promise<void> };
let activeSession: SessionHarness;
let activeAgent: AgentHarness;
let builtInPromises = 0;
let snapshotCount = 0;
let agentSessionDeliveries = 0;
let interactiveModeDeliveries = 0;
let streamingComponentUpdates = 0;
let streamingItemUpdates = 0;
let extensionObserverPublishes = 0;
let pendingToolMetadata = 0;
let pendingToolMetadataHwm = 0;

function deliverSessionEvent(event: BenchEvent): void | Promise<void> {
	agentSessionDeliveries++;
	interactiveModeDeliveries++;
	const result = activeMode.handleEvent(event);
	if (result && typeof result.then === "function") builtInPromises++;
	return result;
}
function deliverObserverEvent(event: BenchEvent): void { activeSession._handleAgentObserverEvent(event); }
function publishNoopObserver(): void { extensionObserverPublishes++; }
function updateStreamingComponent(): void { streamingComponentUpdates++; }
function updateStreamingItem(): void { streamingItemUpdates++; }
function recordPendingToolMetadata(pending: number): void {
	pendingToolMetadata = pending;
	if (pending > pendingToolMetadataHwm) pendingToolMetadataHwm = pending;
}
function failOnRejection(error: unknown): never { throw error; }
function throwUnusedStream(): never { throw new Error("provider stream is not used by this benchmark"); }

const STREAMING_COMPONENT = { updateContent: updateStreamingComponent };
const STREAMING_ITEM = { updateVersion: updateStreamingItem };

function cardinalityToolCount(scenario: Scenario): number | undefined {
	if (!scenario.startsWith("cardinality-")) return undefined;
	return Number(scenario.slice("cardinality-".length));
}

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
	private callback: ((context: unknown) => void) | undefined;
	private context: unknown;
	private handle = 0;
	now(): number { return this.clock; }
	schedule(callback: (context: unknown) => void, _delayMs: number, context: unknown): number {
		if (this.callback) throw new Error("one scheduler task expected");
		this.callback = callback;
		this.context = context;
		return ++this.handle;
	}
	cancel(handle: unknown): void {
		if (handle !== this.handle) return;
		this.callback = undefined;
		this.context = undefined;
	}
	advance(): void {
		this.clock += 16;
		const callback = this.callback;
		const context = this.context;
		this.callback = undefined;
		this.context = undefined;
		callback?.(context);
	}
	get pendingTasks(): number { return this.callback ? 1 : 0; }
}

class BenchEventDeliveryDispatcher extends EventDeliveryDispatcher<BenchEvent, string> {
	private readonly owner: AgentHarness;

	constructor(owner: AgentHarness, scheduler: EventDeliveryScheduler) {
		super({ scheduler, defaultMinIntervalMs: 16 });
		this.owner = owner;
	}

	protected override createLatestSnapshot(event: BenchEvent): BenchEvent {
		snapshotCount++;
		return this.owner.snapshotObserverEvent(event);
	}

	protected override onLatestReleased(key: string, event: BenchEvent): void {
		this.owner.releaseObserverEvent(key, event);
	}
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

function sumMetric(metrics: readonly ToolExecutionAllocationMetrics[], key: keyof ToolExecutionAllocationMetrics): number {
	let total = 0;
	for (const item of metrics) total += item[key];
	return total;
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
	const cardinality = cardinalityToolCount(scenario);
	const toolCount = cardinality ?? (
		scenario === "interleaved-mutation" || scenario === "interleaved-openai-custom" ? 2 : 1
	);
	const contentOffset = cardinality === undefined ? 0 : 1;
	const rawUpdatesPerFlushCycle = cardinality ?? RAW_UPDATES_PER_FLUSH_CYCLE;
	const metrics = new Array<ToolExecutionAllocationMetrics>(toolCount);
	const args = new Array<Record<string, unknown>>(toolCount);
	const content = new Array<Record<string, unknown>>();
	if (cardinality !== undefined) content.push({ type: "text", text: "m".repeat(64 * 1024) });
	const pendingTools = new Map<string, ToolExecutionComponent>();
	for (let index = 0; index < toolCount; index++) {
		metrics[index] = createMetrics();
		args[index] = { value: cardinality === undefined ? 0 : `${index}:`.padEnd(4 * 1024, "a") };
		content.push({ type: "toolCall", id: `tool-${index}`, name: `tool-${index}`, arguments: args[index], partialArgs: "0" });
		const component = new ToolExecutionComponent(`tool-${index}`, `tool-${index}`, args[index], { allocationMetrics: metrics[index] }, undefined, reference, process.cwd());
		pendingTools.set(`tool-${index}`, component);
		transcript.addRetainedChild(component, { id: `tool-${index}`, version: 0 });
	}
	activeMode = Object.assign(Object.create(InteractiveMode.prototype), {
		isInitialized: true,
		footer: { invalidate(): void {} },
		streamingComponent: STREAMING_COMPONENT,
		streamingMessage: undefined,
		streamingItem: STREAMING_ITEM,
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
	const agent = new Agent({
		streamFn: throwUnusedStream as never,
		eventInstrumentation: { onPendingToolMetadata: recordPendingToolMetadata },
	});
	activeAgent = agent as unknown as AgentHarness;
	activeAgent.activeRun = { abortController: new AbortController() };
	const scheduler = new SingleTaskScheduler();
	const delivery = new BenchEventDeliveryDispatcher(activeAgent, scheduler);
	activeAgent.eventDelivery = delivery;
	delivery.subscribe(deliverObserverEvent, { delivery: "latest", minIntervalMs: 16 });
	let updateIndex = 0;
	const sentinels = new Array<string>(toolCount).fill("");
	const deliverCycle = async (): Promise<void> => {
		for (let offset = 0; offset < rawUpdatesPerFlushCycle; offset++) {
			const toolIndex = cardinality !== undefined ? offset : (toolCount === 2 ? updateIndex & 1 : 0);
			const sentinel = `${scenario}:${updateIndex++}`;
			const argumentValue = cardinality === undefined ? sentinel : sentinel.padEnd(4 * 1024, "s");
			sentinels[toolIndex] = sentinel;
			let generation: number | undefined;
			if (scenario === "replacement-object" || scenario === "openai-custom" || scenario === "interleaved-openai-custom") {
				args[toolIndex] = { value: argumentValue };
				content[toolIndex + contentOffset]!.arguments = args[toolIndex];
				if (scenario === "openai-custom" || scenario === "interleaved-openai-custom") {
					generation = Math.floor((updateIndex - 1) / toolCount) + 1;
				}
			} else {
				args[toolIndex]!.value = argumentValue;
				content[toolIndex + contentOffset]!.partialArgs = String(updateIndex);
			}
			await activeAgent.processEvents(messageEvent(
				scenario === "replacement-object" ? "pi-messages" : "openai-completions",
				content,
				toolIndex + contentOffset,
				"toolcall_delta",
				sentinel,
				generation,
			));
		}
		scheduler.advance();
		await delivery.flushAllLatest();
		renderer.renderNow();
	};
	for (let index = 0; index < Math.ceil(warmup / rawUpdatesPerFlushCycle); index++) await deliverCycle();
	for (const item of metrics) resetMetrics(item);
	instrumentation.reset();
	renderer.requestRenderCalls = 0;
	renderer.doRenderCalls = 0;
	terminal.frameWrites = 0;
	builtInPromises = 0;
	snapshotCount = 0;
	agentSessionDeliveries = 0;
	interactiveModeDeliveries = 0;
	streamingComponentUpdates = 0;
	streamingItemUpdates = 0;
	extensionObserverPublishes = 0;
	pendingToolMetadata = 0;
	pendingToolMetadataHwm = 0;
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
	const measuredCycles = Math.ceil(rawUpdates / rawUpdatesPerFlushCycle);
	const durations = new Array<number>(measuredCycles);
	for (let index = 0; index < measuredCycles; index++) {
		const started = performance.now();
		await deliverCycle();
		durations[index] = performance.now() - started;
	}
	const measuredStats = delivery.stats;
	const measuredSnapshotCount = snapshotCount;
	const measuredAgentSessionDeliveries = agentSessionDeliveries;
	const measuredInteractiveModeDeliveries = interactiveModeDeliveries;
	const measuredStreamingComponentUpdates = streamingComponentUpdates;
	const measuredStreamingItemUpdates = streamingItemUpdates;
	const measuredExtensionObserverPublishes = extensionObserverPublishes;
	const measuredRequestRenderCalls = renderer.requestRenderCalls;
	const measuredToolUpdateArgsCalls = sumMetric(metrics, "updateDisplayCalls");
	const stopped = await inspector.post("HeapProfiler.stopSampling");
	await inspector.post("HeapProfiler.disable");
	inspector.disconnect();
	await new Promise<void>((resolve) => setTimeout(resolve, 50));
	gcObserver.disconnect();
	const sampled = allocationSites(stopped.profile.head as SamplingNode);
	for (let toolIndex = 0; toolIndex < toolCount; toolIndex++) {
		await activeAgent.processEvents(messageEvent(
			scenario === "replacement-object" ? "pi-messages" : "openai-completions",
			content,
			toolIndex + contentOffset,
			"toolcall_end",
			"",
		));
	}
	scheduler.advance();
	await delivery.flushAllLatest();
	renderer.renderNow();
	const sorted = durations.slice().sort((left, right) => left - right);
	const statsAfter = delivery.stats;
	const render = instrumentation.snapshot();
	const perTool = new Array<Record<string, unknown>>(toolCount);
	for (let toolIndex = 0; toolIndex < toolCount; toolIndex++) {
		const component = pendingTools.get(`tool-${toolIndex}`)!;
		const finalText = component.render(120).join("\n");
		const item = metrics[toolIndex]!;
		if (item.toolArgsFinalizations !== 1) throw new Error(`${scenario}: tool-${toolIndex} finalization count is ${item.toolArgsFinalizations}`);
		if (item.toolArgsMissingGenerationUpdates !== 0) throw new Error(`${scenario}: tool-${toolIndex} missing generation count is ${item.toolArgsMissingGenerationUpdates}`);
		if (item.toolArgsSemanticFallbackComparisons !== 0) throw new Error(`${scenario}: tool-${toolIndex} used semantic fallback`);
		if (!finalText.includes(sentinels[toolIndex]!)) throw new Error(`${scenario}: tool-${toolIndex} final sentinel is stale`);
		perTool[toolIndex] = {
			toolId: `tool-${toolIndex}`,
			toolArgsGenerationUpdates: item.toolArgsGenerationUpdates,
			toolArgsReplacementUpdates: item.toolArgsReplacementUpdates,
			toolArgsSemanticFallbackComparisons: item.toolArgsSemanticFallbackComparisons,
			toolArgsMissingGenerationUpdates: item.toolArgsMissingGenerationUpdates,
			toolArgsFinalizations: item.toolArgsFinalizations,
			updateDisplayCalls: item.updateDisplayCalls,
			callRendererCalls: item.callRendererCalls,
			argsSerializations: item.argsSerializations,
			finalSentinelCorrect: finalText.includes(sentinels[toolIndex]!) ? 1 : 0,
			finalHash: createHash("sha256").update(finalText).digest("hex"),
		};
	}
	const actualDeliveries = measuredStats.delivered - statsBefore.delivered;
	const actualDeliveriesPerFlushCycle = actualDeliveries / measuredCycles;
	if (actualDeliveriesPerFlushCycle !== 1) {
		throw new Error(`${scenario}: expected one message delivery per flush cycle, received ${actualDeliveriesPerFlushCycle}`);
	}
	if (measuredSnapshotCount !== measuredCycles) {
		throw new Error(`${scenario}: expected one full message snapshot per flush cycle`);
	}
	if (
		measuredAgentSessionDeliveries !== measuredCycles ||
		measuredInteractiveModeDeliveries !== measuredCycles ||
		measuredStreamingComponentUpdates !== measuredCycles ||
		measuredRequestRenderCalls !== measuredCycles
	) {
		throw new Error(`${scenario}: message delivery cardinality exceeded one per flush cycle`);
	}
	if (measuredToolUpdateArgsCalls !== measuredCycles * toolCount) {
		throw new Error(`${scenario}: expected ${toolCount} tool updates per flush cycle`);
	}
	if (pendingToolMetadataHwm > toolCount || pendingToolMetadata !== 0) {
		throw new Error(`${scenario}: pending tool metadata exceeded its bounded tool cardinality`);
	}
	if (scheduler.pendingTasks !== 0 || statsAfter.pendingKeys !== 0) {
		throw new Error(`${scenario}: delivery state was not released`);
	}
	await delivery.dispose();
	await renderer.dispose({ preserveScreen: true });
	return {
		name: scenario,
		coverage: {
			providerStyleEventFixture: true,
			actualProviderParser: false,
			agentProcessEvents: true,
			realEventDeliveryDispatcher: true,
			productionSnapshot: true,
			agentSessionPrototypeBridge: true,
			interactiveModePrototypeHarness: true,
			stableInteractiveTuiReference: true,
			realToolExecutionComponent: true,
			retainedViewport: true,
			mainFrameQueue: true,
		},
		rawUpdates: measuredCycles * rawUpdatesPerFlushCycle,
		rawUpdatesPerFlushCycle,
		coalescedUpdates: measuredStats.coalesced - statsBefore.coalesced,
		actualDeliveries,
		actualDeliveriesPerFlushCycle,
		finalizationDeliveries: statsAfter.delivered - measuredStats.delivered,
		snapshotCount: measuredSnapshotCount,
		totalSnapshotCount: snapshotCount,
		metrics: {
			cpuP50MsPerFlushCycle: percentile(sorted, 0.5),
			cpuP95MsPerFlushCycle: percentile(sorted, 0.95),
			sampledAllocationBytesPerRawUpdate: sampled.sampledBytes / (measuredCycles * rawUpdatesPerFlushCycle),
			sampledAllocationBytesPerFlushCycle: sampled.sampledBytes / measuredCycles,
			sampledAllocationBytesPerActualDelivery: sampled.sampledBytes / Math.max(1, actualDeliveries),
			minorGcCount,
			majorGcCount,
			totalGcDurationMs,
			toolArgsGenerationUpdates: sumMetric(metrics, "toolArgsGenerationUpdates"),
			toolArgsReplacementUpdates: sumMetric(metrics, "toolArgsReplacementUpdates"),
			toolArgsSemanticFallbackComparisons: sumMetric(metrics, "toolArgsSemanticFallbackComparisons"),
			toolArgsMissingGenerationUpdates: sumMetric(metrics, "toolArgsMissingGenerationUpdates"),
			toolArgsFinalizations: sumMetric(metrics, "toolArgsFinalizations"),
			updateDisplayCalls: sumMetric(metrics, "updateDisplayCalls"),
			callRendererCalls: sumMetric(metrics, "callRendererCalls"),
			argsSerializations: sumMetric(metrics, "argsSerializations"),
			requestRenderCalls: renderer.requestRenderCalls,
			fullMessageSnapshotsPerFlush: measuredSnapshotCount / measuredCycles,
			agentSessionDeliveriesPerFlush: measuredAgentSessionDeliveries / measuredCycles,
			interactiveModeDeliveriesPerFlush: measuredInteractiveModeDeliveries / measuredCycles,
			streamingComponentUpdatesPerFlush: measuredStreamingComponentUpdates / measuredCycles,
			streamingItemUpdatesPerFlush: measuredStreamingItemUpdates / measuredCycles,
			requestRenderPerFlush: measuredRequestRenderCalls / measuredCycles,
			toolUpdateArgsCallsPerFlush: measuredToolUpdateArgsCalls / measuredCycles,
			extensionObserverPublishesPerFlush: measuredExtensionObserverPublishes / measuredCycles,
			pendingToolMetadataHwm,
			pendingToolMetadataAfterFlush: pendingToolMetadata,
			doRenderCalls: renderer.doRenderCalls,
			frameWrites: terminal.frameWrites,
			builtInPromises,
			completedItemRenders: render.completedItemRenders,
			activeItemRenders: render.activeItemRenders,
			pendingKeys: statsAfter.pendingKeys,
			schedulerPendingTasks: scheduler.pendingTasks,
			perTool,
		},
		measurementWindow: {
			cpuAndAllocation: "paced raw updates through completed flush cycles",
			finalization: "after sampling; structural evidence only",
		},
		sourceInvariant: { inlineClosuresPerUpdate: 0, promiseTailsPerUpdate: 0, promiseArraysPerUpdate: 0 },
		topAllocationSites: sampled.top,
	};
}

if (typeof globalThis.gc !== "function") throw new Error("tui-paced-streamed-tool-args requires --expose-gc");
initTheme("dark");
const results = [];
for (const scenario of [
	"single-mutation",
	"interleaved-mutation",
	"openai-custom",
	"interleaved-openai-custom",
	"replacement-object",
	"cardinality-1",
	"cardinality-2",
	"cardinality-4",
	"cardinality-8",
	"cardinality-16",
] as const) {
	results.push(await profileScenario(scenario));
}
process.stdout.write(`${JSON.stringify({
	schemaVersion: 1,
	benchmark: "tui-paced-streamed-tool-args",
	commit: currentCommit(),
	node: process.version,
	platform: process.platform,
	arch: process.arch,
	rawUpdatesPerFlushCycle: RAW_UPDATES_PER_FLUSH_CYCLE,
	results,
}, null, 2)}\n`);
