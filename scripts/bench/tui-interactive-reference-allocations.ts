import { Session } from "node:inspector/promises";
import { constants, performance, PerformanceObserver, type PerformanceEntry } from "node:perf_hooks";
import type { TUI } from "../../packages/tui/src/tui.ts";
import { createInteractiveTuiReference } from "../../packages/coding-agent/src/modes/interactive/interactive-mode.ts";
import { currentCommit, readIntegerOption } from "./benchmark.ts";

interface SamplingNode {
	callFrame: { functionName: string; url: string; lineNumber: number; columnNumber: number };
	selfSize: number;
	children?: SamplingNode[];
}
interface PerformanceGcEntry extends PerformanceEntry { detail?: { kind?: number } }
interface AllocationSite { bytes: number; functionName: string; url: string; line: number; column: number }

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

function createRenderer(mode: "regular" | "fullscreen"): TUI & { requestRenderCalls: number } {
	return {
		mode,
		requestRenderCalls: 0,
		requestRender(): void { this.requestRenderCalls++; },
	} as unknown as TUI & { requestRenderCalls: number };
}

async function measure(
	name: "method-access" | "captured-method-call",
	reference: TUI,
	iterations: number,
	firstMethod: TUI["requestRender"],
): Promise<unknown> {
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
	globalThis.gc!();
	globalThis.gc!();
	const inspector = new Session();
	inspector.connect();
	await inspector.post("HeapProfiler.enable");
	await inspector.post("HeapProfiler.startSampling", {
		samplingInterval: 128,
		includeObjectsCollectedByMajorGC: true,
		includeObjectsCollectedByMinorGC: true,
	});
	let differentMethods = 0;
	const started = performance.now();
	if (name === "method-access") {
		for (let index = 0; index < iterations; index++) {
			if (reference.requestRender !== firstMethod) differentMethods++;
		}
	} else {
		for (let index = 0; index < iterations; index++) firstMethod();
	}
	const durationMs = performance.now() - started;
	const stopped = await inspector.post("HeapProfiler.stopSampling");
	await inspector.post("HeapProfiler.disable");
	inspector.disconnect();
	await new Promise<void>((resolve) => setTimeout(resolve, 50));
	gcObserver.disconnect();
	const sampled = allocationSites(stopped.profile.head as SamplingNode);
	return {
		name,
		iterations,
		metrics: {
			cpuMsPerOperation: durationMs / iterations,
			sampledAllocationBytes: sampled.sampledBytes,
			sampledAllocationBytesPerOperation: sampled.sampledBytes / iterations,
			minorGcCount,
			majorGcCount,
			totalGcDurationMs,
			uniqueRequestRenderFunctions: differentMethods === 0 ? 1 : differentMethods + 1,
			wrapperAllocationsAfterInitialization: differentMethods,
		},
		topAllocationSites: sampled.top,
	};
}

if (typeof globalThis.gc !== "function") throw new Error("tui-interactive-reference-allocations requires --expose-gc");
const iterations = readIntegerOption("--iterations", 100_000);
const main = createRenderer("regular");
const alt = createRenderer("fullscreen");
let current: TUI = main;
const reference = createInteractiveTuiReference(() => current);
const capturedRequestRender = reference.requestRender;
const access = await measure("method-access", reference, iterations, capturedRequestRender);
capturedRequestRender();
current = alt;
const calls = await measure("captured-method-call", reference, iterations, capturedRequestRender);
process.stdout.write(`${JSON.stringify({
	schemaVersion: 1,
	benchmark: "tui-interactive-reference-allocations",
	fixture: "interactive-reference-bridge",
	commit: currentCommit(),
	node: process.version,
	platform: process.platform,
	arch: process.arch,
	coverage: {
		realStableReference: true,
		rendererHarness: true,
		realRenderer: false,
		rendererSwitchSemantics: true,
		markdown: false,
		toolRenderer: false,
		frameQueue: false,
	},
	rendererSwitchCorrect: main.requestRenderCalls === 1 && alt.requestRenderCalls === iterations,
	results: [access, calls],
}, null, 2)}\n`);
