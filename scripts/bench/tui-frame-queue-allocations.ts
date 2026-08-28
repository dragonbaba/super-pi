import { Session } from "node:inspector/promises";
import { constants, performance, PerformanceObserver, type PerformanceEntry } from "node:perf_hooks";
import { TerminalFrameQueue, type TerminalFrameSink } from "../../packages/tui/src/terminal-frame-queue.ts";
import { currentCommit, readIntegerOption } from "./benchmark.ts";

interface SamplingNode {
	callFrame: { functionName: string; url: string; lineNumber: number; columnNumber: number };
	selfSize: number;
	children?: SamplingNode[];
}

interface AllocationSite {
	bytes: number;
	functionName: string;
	url: string;
	line: number;
	column: number;
}

interface GcPerformanceEntry extends PerformanceEntry {
	detail?: { kind?: number };
}

class ImmediateFrameSink implements TerminalFrameSink {
	writes = 0;
	private completion: ((generation: number, error?: Error) => void) | undefined;
	setFrameWriteCompletionListener(listener: ((generation: number, error?: Error) => void) | undefined): void {
		this.completion = listener;
	}
	writeFrame(_data: string, generation: number): void {
		this.writes++;
		this.completion?.(generation);
	}
	cancelFrameWrite(): void {}
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
			const site = sites.get(key);
			if (site) site.bytes += node.selfSize;
			else {
				sites.set(key, {
					bytes: node.selfSize,
					functionName: frame.functionName || "(anonymous)",
					url: frame.url,
					line: frame.lineNumber + 1,
					column: frame.columnNumber + 1,
				});
			}
		}
		if (node.children) for (const child of node.children) pending.push(child);
	}
	return { sampledBytes, top: [...sites.values()].sort((left, right) => right.bytes - left.bytes).slice(0, 20) };
}

const measuredFrames = readIntegerOption("--frames", 20_000);
const warmupFrames = readIntegerOption("--warmup", 1_000);
const frameKiB = readIntegerOption("--frame-kib", 64);
if (typeof globalThis.gc !== "function") throw new Error("tui-frame-queue-allocations requires --expose-gc");

// The input string is built once so the measured loop isolates queue overhead.
const prebuiltFrame = "q".repeat(frameKiB * 1024);
const sink = new ImmediateFrameSink();
const queue = new TerminalFrameQueue(sink);
for (let index = 0; index < warmupFrames; index++) queue.submit(prebuiltFrame);
await queue.flush();
globalThis.gc();
globalThis.gc();
const controlledGcBeforeHeapBytes = process.memoryUsage().heapUsed;

let minorGcCount = 0;
let majorGcCount = 0;
let incrementalGcCount = 0;
let weakCallbackGcCount = 0;
let totalGcDurationMs = 0;
const observer = new PerformanceObserver((list) => {
	for (const rawEntry of list.getEntries()) {
		const entry = rawEntry as GcPerformanceEntry;
		totalGcDurationMs += entry.duration;
		const kind = entry.detail?.kind;
		if (kind === constants.NODE_PERFORMANCE_GC_MINOR) minorGcCount++;
		else if (kind === constants.NODE_PERFORMANCE_GC_MAJOR) majorGcCount++;
		else if (kind === constants.NODE_PERFORMANCE_GC_INCREMENTAL) incrementalGcCount++;
		else if (kind === constants.NODE_PERFORMANCE_GC_WEAKCB) weakCallbackGcCount++;
	}
});
observer.observe({ entryTypes: ["gc"] });

const session = new Session();
session.connect();
await session.post("HeapProfiler.enable");
await session.post("HeapProfiler.startSampling", {
	samplingInterval: 1024,
	includeObjectsCollectedByMajorGC: true,
	includeObjectsCollectedByMinorGC: true,
});
const durations = new Array<number>(measuredFrames);
for (let index = 0; index < measuredFrames; index++) {
	const started = performance.now();
	queue.submit(prebuiltFrame);
	durations[index] = performance.now() - started;
}
await queue.flush();
const stopped = await session.post("HeapProfiler.stopSampling");
await session.post("HeapProfiler.disable");
session.disconnect();
await new Promise<void>((resolve) => setTimeout(resolve, 100));
observer.disconnect();

const heapAfterFramesBytes = process.memoryUsage().heapUsed;
globalThis.gc();
globalThis.gc();
const controlledGcAfterHeapBytes = process.memoryUsage().heapUsed;
const sampled = allocationSites(stopped.profile.head as SamplingNode);
const sortedDurations = durations.slice().sort((left, right) => left - right);
const snapshot = queue.snapshot();

process.stdout.write(`${JSON.stringify({
	schemaVersion: 1,
	benchmark: "tui-frame-queue-allocations",
	commit: currentCommit(),
	fixture: "queue-only-prebuilt-frame",
	frameKiB,
	warmupFrames,
	measuredFrames,
	node: process.version,
	platform: process.platform,
	arch: process.arch,
	metrics: {
		cpuP50Ms: percentile(sortedDurations, 0.5),
		cpuP95Ms: percentile(sortedDurations, 0.95),
		sampledAllocationBytes: sampled.sampledBytes,
		sampledAllocationBytesPerFrame: sampled.sampledBytes / measuredFrames,
		minorGcCount,
		majorGcCount,
		incrementalGcCount,
		weakCallbackGcCount,
		totalGcDurationMs,
		controlledGcBeforeHeapBytes,
		heapAfterFramesBytes,
		controlledGcAfterHeapBytes,
		controlledGcHeapDeltaBytes: controlledGcAfterHeapBytes - controlledGcBeforeHeapBytes,
		writtenFrames: sink.writes - warmupFrames,
		activeAfterFlush: snapshot.activeWrites,
		pendingAfterFlush: snapshot.pendingFrames,
		activeFrameUtf8BytesAfterFlush: snapshot.activeFrameUtf8Bytes,
		pendingFrameUtf8BytesAfterFlush: snapshot.pendingFrameUtf8Bytes,
		closuresCreated: 0,
		framePromisesCreated: 0,
		frameAbortControllersCreated: 0,
		frameWrapperObjectsCreated: 0,
		frameStringsMaterializedByQueue: 0,
		fullSizeFrameCopies: 0,
	},
	topAllocationSites: sampled.top,
}, null, 2)}\n`);
