import { Session } from "node:inspector/promises";
import { constants, performance, PerformanceObserver, type PerformanceEntry } from "node:perf_hooks";
import { setImmediate as waitImmediate } from "node:timers/promises";
import { RetainedContainer } from "../../packages/tui/src/components/retained-item.ts";
import { ScrollView } from "../../packages/tui/src/components/scroll-view.ts";
import { VStack } from "../../packages/tui/src/components/v-stack.ts";
import { ViewportContainer } from "../../packages/tui/src/components/viewport-container.ts";
import { TuiRenderInstrumentation } from "../../packages/tui/src/render-instrumentation.ts";
import type { Terminal } from "../../packages/tui/src/terminal.ts";
import { type Component, Container, CURSOR_MARKER, type TUI } from "../../packages/tui/src/tui.ts";
import { TuiAltScreen } from "../../packages/tui/src/tui-alt-screen.ts";
import { TuiMainScreen } from "../../packages/tui/src/tui-main-screen.ts";
import { currentCommit, readIntegerOption } from "./benchmark.ts";

type Fixture = "direct-main" | "production-main" | "production-alt";
type AltControl = "stable" | "overlay" | "selection" | "cursor-ime" | "mixed";

interface SamplingNode {
	callFrame: {
		functionName: string;
		url: string;
		lineNumber: number;
		columnNumber: number;
	};
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

class NoopTerminal implements Terminal {
	readonly kittyProtocolActive = false;
	columns: number;
	rows: number;
	private frameWriteCompletion: ((generation: number, error?: Error) => void) | undefined;
	constructor(columns: number, rows: number) {
		this.columns = columns;
		this.rows = rows;
	}
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

class StaticLines implements Component {
	renderCalls = 0;
	readonly lines: readonly string[];

	constructor(text: string, lineCount = 1) {
		const lines = new Array<string>(lineCount);
		for (let index = 0; index < lineCount; index++) lines[index] = `${text}:${index}`;
		this.lines = lines;
	}

	render(): string[] {
		this.renderCalls++;
		return this.lines as string[];
	}

	invalidate(): void {}
}

class ActiveLines implements Component {
	renderCalls = 0;
	private generation = 0;
	private readonly even: string[];
	private readonly odd: string[];

	constructor(control: AltControl) {
		if (control === "cursor-ime") {
			this.even = [`输入中😀e\u0301${CURSOR_MARKER}`];
			this.odd = [`输入完成中😀e\u0301${CURSOR_MARKER}`];
		} else if (control === "mixed") {
			this.even = ["\x1b[31m中😀e\u0301-active-even\x1b[0m"];
			this.odd = ["\x1b[32m中😀e\u0301-active-odd\x1b[0m"];
		} else {
			this.even = ["active-even"];
			this.odd = ["active-odd"];
		}
	}

	advance(): void {
		this.generation++;
	}

	render(): string[] {
		this.renderCalls++;
		return this.generation % 2 === 0 ? this.even : this.odd;
	}

	invalidate(): void {}
}

interface FixtureRuntime {
	tui: TUI;
	instrumentation: TuiRenderInstrumentation;
	active: ActiveLines;
	advanceActive(): void;
	plainChildren: readonly StaticLines[];
	getAltLayoutRetainedReferenceCounts(): {
		components: number;
		lines: number;
		sources: number;
		cachedRows: number;
		sourceCodeUnits: number;
		paintedCodeUnits: number;
		maximumRowCodeUnits: number;
		indexedComponents: number;
		screenRows: number;
		screenCodeUnits: number;
	};
	dispose(): Promise<void>;
}

function addPlainContainer(plainChildren: StaticLines[], id: string, lineCount = 1): Container {
	const container = new Container();
	const child = new StaticLines(id, lineCount);
	plainChildren.push(child);
	container.addChild(child);
	return container;
}

function createTranscript(itemCount: number, instrumentation: TuiRenderInstrumentation, control: AltControl): {
	transcript: RetainedContainer;
	active: ActiveLines;
	advanceActive(): void;
} {
	const transcript = new RetainedContainer({ instrumentation });
	for (let index = 0; index < itemCount; index++) {
		transcript.addRetainedChild(new StaticLines(`history-${index}`), {
			id: `history-${index}`,
			version: 1,
			completed: true,
		});
	}
	const active = new ActiveLines(control);
	const retained = transcript.addRetainedChild(active, { id: "active", version: 0 });
	return {
		transcript,
		active,
		advanceActive: () => {
			active.advance();
			retained.advanceVersion();
		},
	};
}

function createFixture(
	fixture: Fixture,
	itemCount: number,
	width: number,
	height: number,
	altControl: AltControl,
): FixtureRuntime {
	const instrumentation = new TuiRenderInstrumentation();
	const terminal = new NoopTerminal(width, height);
	const { transcript, active, advanceActive } = createTranscript(itemCount, instrumentation, altControl);
	const plainChildren: StaticLines[] = [];
	let tui: TUI;

	if (fixture === "direct-main") {
		tui = new TuiMainScreen(terminal, false);
		tui.addChild(transcript);
	} else {
		const documentContainer = new ViewportContainer();
		documentContainer.addChild(addPlainContainer(plainChildren, "header"));
		documentContainer.addChild(addPlainContainer(plainChildren, "loaded-resources"));
		documentContainer.addChild(transcript);
		const pendingMessagesContainer = addPlainContainer(plainChildren, "pending");
		const statusContainer = addPlainContainer(plainChildren, "status");
		const widgetContainerAbove = addPlainContainer(plainChildren, "widget-above");
		const editorContainer = addPlainContainer(plainChildren, "editor", 3);
		const widgetContainerBelow = addPlainContainer(plainChildren, "widget-below");
		const footerContainer = addPlainContainer(plainChildren, "footer");
		const roots = [
			documentContainer,
			pendingMessagesContainer,
			statusContainer,
			widgetContainerAbove,
			editorContainer,
			widgetContainerBelow,
			footerContainer,
		];

		if (fixture === "production-main") {
			tui = new TuiMainScreen(terminal, false);
			for (const root of roots) tui.addChild(root);
		} else {
			const transcriptScrollView = new ScrollView(documentContainer, { follow: "end", primary: true });
			const dock = new VStack([
				{ component: pendingMessagesContainer, shrink: 1, minSize: 0 },
				{ component: statusContainer, shrink: 1, minSize: 0 },
				{ component: widgetContainerAbove, shrink: 1, minSize: 0 },
				{ component: editorContainer, shrink: 1, minSize: 3 },
				{ component: widgetContainerBelow, shrink: 1, minSize: 0 },
				{ component: footerContainer, shrink: 1, minSize: 1 },
			]);
			const layout = new VStack([
				{ component: transcriptScrollView, basis: 0, grow: 1, shrink: 1, minSize: 1 },
				{ component: dock, basis: "auto", grow: 0, shrink: 1, minSize: 1 },
			]);
			const alt = new TuiAltScreen(terminal, false, undefined, { mouse: false });
			for (const root of roots) alt.addChild(root);
			alt.setLayoutRoot(layout);
			if (altControl === "overlay") alt.showOverlay(new StaticLines("overlay-中😀e\u0301"), { width: 24 });
			alt.start();
			if (altControl === "selection") {
				const row = Math.max(0, itemCount - 2);
				const internals = alt as unknown as {
					selectionAnchor?: { row: number; col: number; scrollView: ScrollView };
					selectionFocus?: { row: number; col: number; boundary?: boolean; scrollView: ScrollView };
				};
				internals.selectionAnchor = { row, col: 0, scrollView: transcriptScrollView };
				internals.selectionFocus = { row, col: 8, boundary: true, scrollView: transcriptScrollView };
			}
			tui = alt;
		}
	}

	tui.setRenderInstrumentation(instrumentation);
	tui.renderNow();
	instrumentation.reset();
	for (const child of plainChildren) child.renderCalls = 0;
	active.renderCalls = 0;
	return {
		tui,
		instrumentation,
		active,
		advanceActive,
		plainChildren,
		getAltLayoutRetainedReferenceCounts: () =>
			tui instanceof TuiAltScreen
				? tui.getAltLayoutRetainedReferenceCounts()
				: {
					components: 0,
					lines: 0,
					sources: 0,
					cachedRows: 0,
					sourceCodeUnits: 0,
					paintedCodeUnits: 0,
					maximumRowCodeUnits: 0,
					indexedComponents: 0,
					screenRows: 0,
					screenCodeUnits: 0,
				},
		dispose: async () => {
			await tui.stop({ preserveScreen: true });
		},
	};
}

function percentile(sorted: readonly number[], ratio: number): number {
	return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1))] ?? 0;
}

function linearSlope(values: readonly number[]): number {
	if (values.length < 2) return 0;
	const xMean = (values.length - 1) / 2;
	let ySum = 0;
	for (let index = 0; index < values.length; index++) ySum += values[index]!;
	const yMean = ySum / values.length;
	let numerator = 0;
	let denominator = 0;
	for (let index = 0; index < values.length; index++) {
		const xDelta = index - xMean;
		numerator += xDelta * (values[index]! - yMean);
		denominator += xDelta * xDelta;
	}
	return denominator === 0 ? 0 : numerator / denominator;
}

async function runAltLifecycleCycle(itemCount: number, width: number, height: number): Promise<number> {
	const cycle = createFixture("production-alt", itemCount, width, height, "stable");
	cycle.advanceActive();
	cycle.tui.renderNow();
	await cycle.tui.dispose({ preserveScreen: true });
	const references = cycle.getAltLayoutRetainedReferenceCounts();
	return references.components + references.lines + references.sources + references.cachedRows;
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

const fixtureArgument = process.argv[process.argv.indexOf("--fixture") + 1] as Fixture | undefined;
if (!fixtureArgument || !new Set<Fixture>(["direct-main", "production-main", "production-alt"]).has(fixtureArgument)) {
	throw new Error("--fixture must be direct-main, production-main, or production-alt");
}
const itemCount = readIntegerOption("--items", 5_000);
const measuredFrames = readIntegerOption("--frames", 20_000);
const warmupFrames = readIntegerOption("--warmup", 1_000);
const lifecycleCycles = readIntegerOption("--lifecycle-cycles", 0);
const width = readIntegerOption("--width", 120);
const height = readIntegerOption("--height", 40);
const altControlIndex = process.argv.indexOf("--alt-control");
const altControlArgument = (altControlIndex === -1 ? "stable" : process.argv[altControlIndex + 1]) as AltControl;
if (!["stable", "overlay", "selection", "cursor-ime", "mixed"].includes(altControlArgument)) {
	throw new Error("--alt-control must be stable, overlay, selection, cursor-ime, or mixed");
}
if (typeof globalThis.gc !== "function") throw new Error("tui-frame-allocations requires --expose-gc");

const runtime = createFixture(fixtureArgument, itemCount, width, height, altControlArgument);
for (let index = 0; index < warmupFrames; index++) {
	runtime.advanceActive();
	runtime.tui.renderNow();
}
runtime.instrumentation.reset();
for (const child of runtime.plainChildren) child.renderCalls = 0;
runtime.active.renderCalls = 0;
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
	runtime.advanceActive();
	runtime.tui.renderNow();
	durations[index] = performance.now() - started;
}
const stopped = await session.post("HeapProfiler.stopSampling");
await session.post("HeapProfiler.disable");
session.disconnect();
// GC performance entries are delivered on a later observer turn than the
// inspector response; keep the observer alive long enough to drain them.
await new Promise<void>((resolve) => setTimeout(resolve, 100));
observer.disconnect();

const heapAfterFramesBytes = process.memoryUsage().heapUsed;
globalThis.gc();
globalThis.gc();
const controlledGcAfterHeapBytes = process.memoryUsage().heapUsed;
const sortedDurations = durations.slice().sort((left, right) => left - right);
const sampled = allocationSites(stopped.profile.head as SamplingNode);
const metrics = runtime.instrumentation.snapshot();
const retainedReferencesBeforeDispose = runtime.getAltLayoutRetainedReferenceCounts();
let plainRenderCalls = 0;
let maxPlainRenderCalls = 0;
for (const child of runtime.plainChildren) {
	plainRenderCalls += child.renderCalls;
	maxPlainRenderCalls = Math.max(maxPlainRenderCalls, child.renderCalls);
}
await runtime.dispose();
globalThis.gc();
globalThis.gc();
const controlledGcAfterDisposeHeapBytes = process.memoryUsage().heapUsed;
const retainedReferencesAfterDispose = runtime.getAltLayoutRetainedReferenceCounts();
const lifecycleHeapSamples: number[] = [];
let lifecycleMaximumRetainedReferencesAfterDispose = 0;
for (let cycle = 0; cycle < lifecycleCycles; cycle++) {
	const retainedReferences = await runAltLifecycleCycle(itemCount, width, height);
	await waitImmediate();
	lifecycleMaximumRetainedReferencesAfterDispose = Math.max(
		lifecycleMaximumRetainedReferencesAfterDispose,
		retainedReferences,
	);
	globalThis.gc();
	globalThis.gc();
	lifecycleHeapSamples.push(process.memoryUsage().heapUsed);
}

process.stdout.write(`${JSON.stringify({
	schemaVersion: 1,
	benchmark: "tui-frame-allocations",
	commit: currentCommit(),
	fixtureClass: "render-plus-queue",
	fixture: fixtureArgument,
	altControl: altControlArgument,
	items: itemCount,
	width,
	height,
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
		controlledGcAfterDisposeHeapBytes,
		controlledGcAfterDisposeHeapDeltaBytes: controlledGcAfterDisposeHeapBytes - controlledGcBeforeHeapBytes,
		retainedReferencesBeforeDispose,
		retainedReferencesAfterDispose,
		lifecycleCycles,
		lifecycleHeapSamples,
		lifecycleHeapSlopeBytesPerCycle: linearSlope(lifecycleHeapSamples),
		lifecycleMaximumRetainedReferencesAfterDispose,
		plainChildRenderCallsPerFrame: plainRenderCalls / measuredFrames,
		maxPlainChildRenderCallsPerFrame: maxPlainRenderCalls / measuredFrames,
		activeRenderCallsPerFrame: runtime.active.renderCalls / measuredFrames,
		completedItemRendersPerFrame: metrics.completedItemRenders / measuredFrames,
		viewportItemVisitsPerFrame: metrics.viewportItemVisits / measuredFrames,
		viewportLineArraysPerFrame: metrics.viewportLineArrays / measuredFrames,
		viewportComposedLinesPerFrame: metrics.viewportComposedLines / measuredFrames,
		viewportCopiedLinesPerFrame: metrics.viewportCopiedLines / measuredFrames,
		viewportTargetHeightLookupProbesPerFrame: metrics.viewportTargetHeightLookupProbes / measuredFrames,
		viewportBlockLookupProbesPerFrame: metrics.viewportBlockLookupProbes / measuredFrames,
		mutationEventWritesPerFrame: metrics.mutationEventWrites / measuredFrames,
		fullHistoryFallbacksPerFrame: metrics.fullHistoryFallbacks / measuredFrames,
		frameStringsGenerated: metrics.frameStringsGenerated,
		frameStringsGeneratedPerFrame: metrics.frameStringsGenerated / measuredFrames,
		frameStringUtf8BytesGenerated: metrics.frameStringUtf8BytesGenerated,
		frameStringUtf8BytesGeneratedPerFrame: metrics.frameStringUtf8BytesGenerated / measuredFrames,
		maximumFrameUtf8Bytes: metrics.maximumFrameUtf8Bytes,
		activeFrameUtf8Bytes: metrics.activeFrameUtf8Bytes,
		pendingFrameUtf8Bytes: metrics.pendingFrameUtf8Bytes,
		terminalFrameQueueHighWaterMark: metrics.terminalFrameQueueHighWaterMark,
		terminalActiveWriteHighWaterMark: metrics.terminalActiveWriteHighWaterMark,
		terminalPendingFrameHighWaterMark: metrics.terminalPendingFrameHighWaterMark,
		fullSizeFrameCopies: metrics.fullSizeFrameCopies,
		framePromisesCreated: metrics.framePromisesCreated,
		frameAbortControllersCreated: metrics.frameAbortControllersCreated,
		frameWrapperObjectsCreated: metrics.frameWrapperObjectsCreated,
		layoutNodesVisitedPerFrame: metrics.altLayoutNodesVisited / measuredFrames,
		layoutBoxObjectsPerFrame: metrics.altLayoutBoxObjects / measuredFrames,
		layoutRectObjectsPerFrame: metrics.altLayoutRectObjects / measuredFrames,
		layoutClipObjectsPerFrame: metrics.altLayoutClipObjects / measuredFrames,
		layoutRenderCacheLookupProbesPerFrame: metrics.altLayoutRenderCacheLookupProbes / measuredFrames,
		layoutRenderCacheRecordCountPerFrame: metrics.altLayoutRenderCacheRecordCount / measuredFrames,
		layoutRenderCacheIndexActivationsPerFrame: metrics.altLayoutRenderCacheIndexActivations / measuredFrames,
		layoutScreenArraysCreatedPerFrame: metrics.altLayoutScreenArraysCreated / measuredFrames,
		layoutFullViewportArrayCopiesPerFrame: metrics.altLayoutFullViewportArrayCopies / measuredFrames,
		layoutStringRepeatCallsPerFrame: metrics.altLayoutStringRepeatCalls / measuredFrames,
		layoutStringRepeatBytesPerFrame: metrics.altLayoutStringRepeatBytes / measuredFrames,
		layoutPaintBoxCallsPerFrame: metrics.altLayoutPaintBoxCalls / measuredFrames,
		layoutChildRenderCallsPerFrame: metrics.altLayoutChildRenderCalls / measuredFrames,
		layoutFullWidthRowCacheHitsPerFrame: metrics.altLayoutFullWidthRowCacheHits / measuredFrames,
		layoutCachedSourceCodeUnitsPerFrame: metrics.altLayoutCachedSourceCodeUnits / measuredFrames,
		layoutCachedPaintedCodeUnitsPerFrame: metrics.altLayoutCachedPaintedCodeUnits / measuredFrames,
		layoutMaximumCachedRowCodeUnits: metrics.altLayoutMaximumCachedRowCodeUnits,
		layoutRowCacheRejectedBySizePerFrame: metrics.altLayoutRowCacheRejectedBySize / measuredFrames,
		sourceInvariantNestedRenderCacheMapsPerFrame: 0,
		sourceInvariantRenderCacheLookupWrapperObjectsPerFrame: 0,
	},
	topAllocationSites: sampled.top,
}, null, 2)}\n`);
