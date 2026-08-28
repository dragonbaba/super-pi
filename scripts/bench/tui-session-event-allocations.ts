import { readFileSync } from "node:fs";
import { Session } from "node:inspector/promises";
import { constants, performance, PerformanceObserver, type PerformanceEntry } from "node:perf_hooks";
import { Agent } from "../../packages/agent/src/agent.ts";
import { AgentSession } from "../../packages/coding-agent/src/core/agent-session.ts";
import {
	createInteractiveTuiReference,
	InteractiveMode,
} from "../../packages/coding-agent/src/modes/interactive/interactive-mode.ts";
import type { TUI } from "../../packages/tui/src/tui.ts";
import { currentCommit, readIntegerOption } from "./benchmark.ts";

interface SamplingNode {
	callFrame: { functionName: string; url: string; lineNumber: number; columnNumber: number };
	selfSize: number;
	children?: SamplingNode[];
}

interface GcPerformanceEntry extends PerformanceEntry { detail?: { kind?: number } }
interface AllocationSite { bytes: number; functionName: string; url: string; line: number; column: number }
type BenchEvent = { type: string; [key: string]: unknown };

interface InteractiveEventHarness {
	handleEvent(event: BenchEvent): void | Promise<void>;
}

interface SessionEventHarness {
	_eventListeners: Array<{
		listener: (event: BenchEvent) => void | Promise<void>;
		criticalAgentEnd: boolean;
		observeRejection: (error: unknown) => void;
	}>;
	_emit(event: BenchEvent): void;
	_handleAgentObserverEvent(event: BenchEvent): void | Promise<void>;
	_extensionObserverDelivery: { publishLatest(key: string, event: BenchEvent): void };
}

interface AgentDeliveryHarness {
	activeRun: { abortController: AbortController };
	eventDelivery: {
		publishLatest(key: string, event: BenchEvent): unknown;
		flushLatest(key: string): Promise<void>;
		stats: { received: number; coalesced: number; delivered: number };
	};
}

let activeMode: InteractiveEventHarness;
let builtInListenerPromises = 0;
let rejectionObservers = 0;
let activeObserverSession: SessionEventHarness;
let observerBridgePromises = 0;
let observerDeliveries = 0;
let extensionObserverPublishes = 0;

function deliverBuiltInEvent(event: BenchEvent): void | Promise<void> {
	const result = activeMode.handleEvent(event);
	if (result && typeof result.then === "function") builtInListenerPromises++;
	return result;
}

function observeListenerRejection(): void { rejectionObservers++; }

function deliverAgentObserverEvent(event: BenchEvent): void | Promise<void> {
	observerDeliveries++;
	const result = activeObserverSession._handleAgentObserverEvent(event);
	if (result && typeof result.then === "function") observerBridgePromises++;
	return result;
}

function publishExtensionObserver(_key: string, _event: BenchEvent): void {
	extensionObserverPublishes++;
}

function throwUnusedStream(): never {
	throw new Error("stream function is not used by the event allocation benchmark");
}

function percentile(sorted: readonly number[], ratio: number): number {
	return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1))] ?? 0;
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
	return { sampledBytes, top: [...sites.values()].sort((a, b) => b.bytes - a.bytes).slice(0, 20) };
}

function createMode(): InteractiveEventHarness {
	const mode = Object.create(InteractiveMode.prototype) as InteractiveEventHarness & Record<string, unknown>;
	const renderer = { requestRender(): void {} } as TUI;
	Object.assign(mode, {
		isInitialized: true,
		footer: { invalidate(): void {} },
		streamingComponent: { updateContent(): void {} },
		streamingMessage: undefined,
		streamingItem: { updateVersion(): void {} },
		streamingItemVersion: 0,
		pendingTools: new Map(),
		deferredReadExecutions: new Map([
			["tool-1", { args: {}, started: true, resultIsError: false }],
		]),
		ui: createInteractiveTuiReference(() => renderer),
	});
	return mode;
}

function createSession(): SessionEventHarness {
	const session = Object.create(AgentSession.prototype) as SessionEventHarness;
	session._eventListeners = [{
		listener: deliverBuiltInEvent,
		criticalAgentEnd: false,
		observeRejection: observeListenerRejection,
	}];
	session._extensionObserverDelivery = { publishLatest: publishExtensionObserver };
	return session;
}

async function measure(name: string, event: BenchEvent, updates: number, warmup: number): Promise<unknown> {
	activeMode = createMode();
	const session = createSession();
	for (let index = 0; index < warmup; index++) session._emit(event);
	builtInListenerPromises = 0;
	rejectionObservers = 0;
	globalThis.gc!();
	globalThis.gc!();
	const heapBefore = process.memoryUsage().heapUsed;

	let minorGcCount = 0;
	let majorGcCount = 0;
	let totalGcDurationMs = 0;
	const gcObserver = new PerformanceObserver((list) => {
		for (const rawEntry of list.getEntries()) {
			const entry = rawEntry as GcPerformanceEntry;
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
		samplingInterval: 1024,
		includeObjectsCollectedByMajorGC: true,
		includeObjectsCollectedByMinorGC: true,
	});

	const batchSize = 500;
	const batches = Math.ceil(updates / batchSize);
	const durations = new Array<number>(batches);
	let delivered = 0;
	for (let batch = 0; batch < batches; batch++) {
		const count = Math.min(batchSize, updates - delivered);
		const started = performance.now();
		for (let index = 0; index < count; index++) session._emit(event);
		durations[batch] = (performance.now() - started) / count;
		delivered += count;
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
	const sorted = durations.slice().sort((a, b) => a - b);
	const modeState = activeMode as InteractiveEventHarness & Record<string, any>;
	const finalUpdateCorrect = name === "message_update"
		? modeState.streamingMessage === event.message && modeState.streamingItemVersion === warmup + updates
		: modeState.deferredReadExecutions.get("tool-1")?.result === event.partialResult &&
			modeState.deferredReadExecutions.get("tool-1")?.isPartial === true &&
			modeState.deferredReadExecutions.get("tool-1")?.resultIsError === false;
	return {
		name,
		updates,
		warmup,
		metrics: {
			cpuP50MsPerUpdate: percentile(sorted, 0.5),
			cpuP95MsPerUpdate: percentile(sorted, 0.95),
			sampledAllocationBytes: sampled.sampledBytes,
			sampledAllocationBytesPerUpdate: sampled.sampledBytes / updates,
			minorGcCount,
			majorGcCount,
			totalGcDurationMs,
			heapBefore,
			heapAfter,
			controlledGcAfter,
			controlledGcHeapDeltaBytes: controlledGcAfter - heapBefore,
			builtInListenerPromisesPerUpdate: builtInListenerPromises / updates,
			rejectionObserversPerUpdate: rejectionObservers / updates,
			finalUpdateCorrect: finalUpdateCorrect ? 1 : 0,
		},
		sourceInvariant: {
			toolWrapperObjectsPerUpdate: 0,
			inlineClosuresPerUpdate: 0,
			promiseTailsPerUpdate: 0,
			promiseArraysPerUpdate: 0,
			arraysPerUpdate: 0,
		},
		topAllocationSites: sampled.top,
	};
}

async function measureFullObserverChain(event: BenchEvent, updates: number, warmup: number): Promise<unknown> {
	activeMode = createMode();
	activeObserverSession = createSession();
	observerBridgePromises = 0;
	observerDeliveries = 0;
	extensionObserverPublishes = 0;
	builtInListenerPromises = 0;
	rejectionObservers = 0;
	let snapshotCount = 0;
	const agent = new Agent({
		streamFn: throwUnusedStream as never,
		eventInstrumentation: { onAssistantSnapshot: () => { snapshotCount++; } },
	});
	const agentHarness = agent as unknown as AgentDeliveryHarness;
	agentHarness.activeRun = { abortController: new AbortController() };
	const unsubscribe = agent.subscribeObserver(deliverAgentObserverEvent as never, {
		filter: () => true,
		minIntervalMs: 60_000,
	});
	const delivery = agentHarness.eventDelivery;
	for (let index = 0; index < warmup; index++) delivery.publishLatest("message", event);
	await delivery.flushLatest("message");
	const statsBefore = delivery.stats;
	const deliveredVersionBefore = (activeMode as InteractiveEventHarness & Record<string, any>).streamingItemVersion as number;
	observerBridgePromises = 0;
	observerDeliveries = 0;
	extensionObserverPublishes = 0;
	builtInListenerPromises = 0;
	rejectionObservers = 0;
	snapshotCount = 0;
	globalThis.gc!();
	globalThis.gc!();
	const heapBefore = process.memoryUsage().heapUsed;

	let minorGcCount = 0;
	let majorGcCount = 0;
	let totalGcDurationMs = 0;
	const gcObserver = new PerformanceObserver((list) => {
		for (const rawEntry of list.getEntries()) {
			const entry = rawEntry as GcPerformanceEntry;
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
		samplingInterval: 1024,
		includeObjectsCollectedByMajorGC: true,
		includeObjectsCollectedByMinorGC: true,
	});

	let rawUpdatePromises = 0;
	const batchSize = 500;
	const batches = Math.ceil(updates / batchSize);
	const durations = new Array<number>(batches);
	let published = 0;
	for (let batch = 0; batch < batches; batch++) {
		const count = Math.min(batchSize, updates - published);
		const started = performance.now();
		for (let index = 0; index < count; index++) {
			const result = delivery.publishLatest("message", event);
			if (result && typeof (result as PromiseLike<void>).then === "function") rawUpdatePromises++;
		}
		durations[batch] = (performance.now() - started) / count;
		published += count;
	}
	await delivery.flushLatest("message");

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
	const sorted = durations.slice().sort((a, b) => a - b);
	const stats = delivery.stats;
	const modeState = activeMode as InteractiveEventHarness & Record<string, any>;
	unsubscribe();
	return {
		name: "observer-coalesced-message_update",
		updates,
		warmup,
		metrics: {
			rawUpdates: updates,
			coalescedUpdates: stats.coalesced - statsBefore.coalesced,
			coalescedDeliveries: observerDeliveries,
			snapshotCount,
			extensionObserverPublishes,
			promisesPerRawUpdate: rawUpdatePromises / updates,
			promisesPerDelivery:
				(observerBridgePromises + builtInListenerPromises) / Math.max(1, observerDeliveries),
			observerBridgePromisesPerDelivery: observerBridgePromises / Math.max(1, observerDeliveries),
			builtInInteractivePromisesPerDelivery: builtInListenerPromises / Math.max(1, observerDeliveries),
			rejectionObserversPerDelivery: rejectionObservers / Math.max(1, observerDeliveries),
			sampledAllocationBytes: sampled.sampledBytes,
			sampledAllocationBytesPerRawUpdate: sampled.sampledBytes / updates,
			sampledAllocationBytesPerDelivery: sampled.sampledBytes / Math.max(1, observerDeliveries),
			cpuP50MsPerRawUpdate: percentile(sorted, 0.5),
			cpuP95MsPerRawUpdate: percentile(sorted, 0.95),
			minorGcCount,
			majorGcCount,
			totalGcDurationMs,
			heapBefore,
			heapAfter,
			controlledGcAfter,
			controlledGcHeapDeltaBytes: controlledGcAfter - heapBefore,
			finalUpdateCorrect:
				modeState.streamingMessage !== undefined && modeState.streamingItemVersion === deliveredVersionBefore + 1 ? 1 : 0,
		},
		sourceInvariant: {
			toolWrapperObjectsPerUpdate: 0,
			inlineClosuresPerUpdate: 0,
			promiseTailsPerUpdate: 0,
			promiseArraysPerUpdate: 0,
		},
		topAllocationSites: sampled.top,
	};
}

if (typeof globalThis.gc !== "function") throw new Error("tui-session-event-allocations requires --expose-gc");
const source = readFileSync("packages/coding-agent/src/modes/interactive/interactive-mode.ts", "utf8");
if (/session\.subscribe\(async\s*\(|tool_execution_update[\s\S]{0,700}\{\s*\.\.\.event\.partialResult/.test(source)) {
	throw new Error("InteractiveMode hot event source contract regressed");
}
const updates = readIntegerOption("--updates", 100_000);
const warmup = readIntegerOption("--warmup", 10_000);
const timestamp = 0;
const messageEvent: BenchEvent = {
	type: "message_update",
	message: { role: "assistant", content: [], timestamp },
};
const toolEvent: BenchEvent = {
	type: "tool_execution_update",
	toolCallId: "tool-1",
	toolName: "read",
	partialResult: { content: [{ type: "text", text: "progress" }] },
};
const directResults = [
	await measure("message_update", messageEvent, updates, warmup),
	await measure("tool_execution_update", toolEvent, updates, warmup),
];
const fullChainResults = [await measureFullObserverChain(messageEvent, updates, warmup)];
process.stdout.write(`${JSON.stringify({
	schemaVersion: 1,
	benchmark: "tui-session-event-allocations",
	commit: currentCommit(),
	node: process.version,
	platform: process.platform,
	arch: process.arch,
	fixtures: [{
		name: "agent-session-to-interactive-stub",
		coverage: {
			realAgentObserverDelivery: true,
			realStableReference: true,
			realAssistantComponent: false,
			realToolComponent: false,
			markdown: false,
			frameQueue: false,
		},
		results: [...directResults, ...fullChainResults],
	}],
}, null, 2)}\n`);
