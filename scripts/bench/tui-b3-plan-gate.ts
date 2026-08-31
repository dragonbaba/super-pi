import { Session } from "node:inspector/promises";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { constants, performance, PerformanceObserver, type PerformanceEntry } from "node:perf_hooks";
import { Editor, type EditorTheme } from "../../packages/tui/src/components/editor.ts";
import { HStack } from "../../packages/tui/src/components/h-stack.ts";
import { RetainedContainer } from "../../packages/tui/src/components/retained-item.ts";
import { ScrollView } from "../../packages/tui/src/components/scroll-view.ts";
import { VStack } from "../../packages/tui/src/components/v-stack.ts";
import { ViewportContainer } from "../../packages/tui/src/components/viewport-container.ts";
import { getScrollViewsAt, type LayoutFrame } from "../../packages/tui/src/layout.ts";
import { TuiRenderInstrumentation } from "../../packages/tui/src/render-instrumentation.ts";
import type { Terminal, TerminalFrameWriteCompletion } from "../../packages/tui/src/terminal.ts";
import {
	getCapabilities,
	registerKittyImageMetadata,
	setCapabilities,
} from "../../packages/tui/src/terminal-image.ts";
import { type Component, Container } from "../../packages/tui/src/tui.ts";
import { TuiAltScreen } from "../../packages/tui/src/tui-alt-screen.ts";
import { currentCommit, readIntegerOption } from "./benchmark.ts";

type Candidate = "editor-frame" | "mouse-hit" | "selection-auto-scroll" | "kitty-fallback" | "stack-direct";
type EditorUpdate = "stable" | "cursor" | "oversize-small";

interface SamplingNode {
	callFrame: { functionName: string; url: string; lineNumber: number; columnNumber: number };
	selfSize: number;
	children?: SamplingNode[];
}

interface GcPerformanceEntry extends PerformanceEntry {
	detail?: { kind?: number };
}

interface CandidateRuntime {
	readonly unit: "frame" | "event";
	readonly productionPath: string;
	step(index: number): void;
	reset(): void;
	snapshot(): Record<string, number | string | boolean>;
	dispose(): Promise<void>;
}

interface EditorLayoutCacheMetrics {
	layoutCacheHits: number;
	layoutCacheMisses: number;
	layoutCacheValidationLineComparisons: number;
	layoutCacheSourceRecords: number;
	layoutCacheLayoutRecords: number;
	layoutCacheRejectedByCapacity: number;
	layoutCacheRetainedSourceCodeUnits: number;
	layoutCacheRetainedLayoutLines: number;
}

function resetEditorLayoutCacheMetrics(editor: Editor): void {
	const diagnostics = editor as unknown as { resetLayoutCacheMetrics?: () => void };
	diagnostics.resetLayoutCacheMetrics?.();
}

function getEditorLayoutCacheMetrics(editor: Editor): EditorLayoutCacheMetrics {
	const diagnostics = editor as unknown as { getLayoutCacheMetrics?: () => EditorLayoutCacheMetrics };
	return diagnostics.getLayoutCacheMetrics?.() ?? {
		layoutCacheHits: 0,
		layoutCacheMisses: 0,
		layoutCacheValidationLineComparisons: 0,
		layoutCacheSourceRecords: 0,
		layoutCacheLayoutRecords: 0,
		layoutCacheRejectedByCapacity: 0,
		layoutCacheRetainedSourceCodeUnits: 0,
		layoutCacheRetainedLayoutLines: 0,
	};
}

class BenchTerminal implements Terminal {
	readonly kittyProtocolActive = false;
	columns: number;
	rows: number;
	frameWrites = 0;
	frameBytes = 0;
	private lastFrame = "";
	private frameCompletion: TerminalFrameWriteCompletion | undefined;

	constructor(columns: number, rows: number) {
		this.columns = columns;
		this.rows = rows;
	}

	start(): void {}
	stop(): void {}
	async drainInput(): Promise<void> {}
	write(): void {}
	setFrameWriteCompletionListener(listener: TerminalFrameWriteCompletion | undefined): void {
		this.frameCompletion = listener;
	}
	writeFrame(data: string, generation: number): void {
		this.frameWrites++;
		this.frameBytes += data.length;
		this.lastFrame = data;
		this.frameCompletion?.(generation);
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

	finalFrameHash(): string {
		return createHash("sha256").update(this.lastFrame).digest("hex");
	}
}

class StaticLines implements Component {
	readonly lines: string[];
	renderCalls = 0;

	constructor(line: string, count = 1) {
		this.lines = new Array<string>(count);
		for (let index = 0; index < count; index++) this.lines[index] = `${line}:${index}`;
	}

	render(): string[] {
		this.renderCalls++;
		return this.lines;
	}

	invalidate(): void {}
}

class ActiveLines implements Component {
	renderCalls = 0;
	private generation = 0;
	private readonly even = ["active-even"];
	private readonly odd = ["active-odd"];

	advance(): void {
		this.generation++;
	}

	render(): string[] {
		this.renderCalls++;
		return (this.generation & 1) === 0 ? this.even : this.odd;
	}

	invalidate(): void {}
}

class CountingEditor extends Editor {
	renderCalls = 0;

	override render(width: number): string[] {
		this.renderCalls++;
		return super.render(width);
	}
}

class CountingVStack extends VStack {
	directRenderCalls = 0;

	override render(width: number): string[] {
		this.directRenderCalls++;
		return super.render(width);
	}
}

const EDITOR_THEME: EditorTheme = {
	borderColor: identity,
	selectList: {
		selectedPrefix: identity,
		selectedText: identity,
		description: identity,
		scrollInfo: identity,
		noMatch: identity,
	},
};

function identity(value: string): string {
	return value;
}

function createTranscript(itemCount: number, instrumentation: TuiRenderInstrumentation): {
	container: RetainedContainer;
	active: ActiveLines;
	advance(): void;
} {
	const container = new RetainedContainer({ instrumentation });
	for (let index = 0; index < itemCount; index++) {
		container.addRetainedChild(new StaticLines(`history-${index}`), {
			id: `history-${index}`,
			version: 1,
			completed: true,
		});
	}
	const active = new ActiveLines();
	const retained = container.addRetainedChild(active, { id: "active", version: 0 });
	return {
		container,
		active,
		advance(): void {
			active.advance();
			retained.advanceVersion();
		},
	};
}

function createAltShell(
	itemCount: number,
	width: number,
	height: number,
	editorKind: "static" | "editor",
	editorLineCount: number,
): {
	tui: TuiAltScreen;
	terminal: BenchTerminal;
	instrumentation: TuiRenderInstrumentation;
	transcriptScrollView: ScrollView;
	editor: CountingEditor | undefined;
	advanceTranscript(): void;
} {
	const instrumentation = new TuiRenderInstrumentation();
	const terminal = new BenchTerminal(width, height);
	const tui = new TuiAltScreen(terminal, false, undefined, { mouse: false });
	let editor: CountingEditor | undefined;
	let editorComponent: Component;
	if (editorKind === "editor") {
		editor = new CountingEditor(tui, EDITOR_THEME);
		editor.focused = true;
		if (editorLineCount === 1) {
			editor.setText(
				"A production editor line with English words, CJK 中文, emoji 👨‍👩‍👧‍👦, and combining e\u0301. ".repeat(8),
			);
		} else {
			const lines = new Array<string>(editorLineCount);
			for (let index = 0; index < editorLineCount; index++) lines[index] = `editor-validation-line-${index}`;
			editor.setText(lines.join("\n"));
		}
		editorComponent = editor;
	} else {
		editorComponent = new StaticLines("editor", 3);
	}
	const transcript = createTranscript(itemCount, instrumentation);
	const documentContainer = new ViewportContainer();
	documentContainer.addChild(new StaticLines("header"));
	documentContainer.addChild(new StaticLines("loaded-resources"));
	documentContainer.addChild(transcript.container);
	const transcriptScrollView = new ScrollView(documentContainer, { follow: "end", primary: true });
	const editorContainer = new Container();
	editorContainer.addChild(editorComponent);
	const dock = new VStack([
		{ component: new StaticLines("pending"), shrink: 1, minSize: 0 },
		{ component: new StaticLines("status"), shrink: 1, minSize: 0 },
		{ component: editorContainer, shrink: 1, minSize: 3 },
		{ component: new StaticLines("footer"), shrink: 1, minSize: 1 },
	]);
	const layout = new VStack([
		{ component: transcriptScrollView, basis: 0, grow: 1, shrink: 1, minSize: 1 },
		{ component: dock, basis: "auto", grow: 0, shrink: 1, minSize: 1 },
	]);
	tui.setLayoutRoot(layout);
	tui.setRenderInstrumentation(instrumentation);
	tui.start();
	tui.renderNow();
	instrumentation.reset();
	return { tui, terminal, instrumentation, transcriptScrollView, editor, advanceTranscript: transcript.advance };
}

function createEditorRuntime(
	itemCount: number,
	width: number,
	height: number,
	editorUpdate: EditorUpdate,
	editorLineCount: number,
): CandidateRuntime {
	const shell = createAltShell(itemCount, width, height, "editor", editorLineCount);
	const editor = shell.editor!;
	editor.renderCalls = 0;
	let oversizeCapacityRejections = 0;
	return {
		unit: "frame",
		productionPath: "Retained viewport -> ScrollView/VStack -> real Editor.render -> TuiAltScreen.doRender -> frame queue",
		step(index: number): void {
			if (editorUpdate === "cursor") editor.handleInput((index & 1) === 0 ? "\x1b[D" : "\x1b[C");
			shell.advanceTranscript();
			shell.tui.renderNow();
		},
		reset(): void {
			if (editorUpdate === "oversize-small") {
				oversizeCapacityRejections = getEditorLayoutCacheMetrics(editor).layoutCacheRejectedByCapacity;
				editor.setText("small");
				editor.render(width);
			}
			editor.renderCalls = 0;
			resetEditorLayoutCacheMetrics(editor);
			shell.terminal.frameWrites = 0;
			shell.terminal.frameBytes = 0;
			shell.instrumentation.reset();
		},
		snapshot(): Record<string, number | string | boolean> {
			const metrics = shell.instrumentation.snapshot();
			const layoutCache = getEditorLayoutCacheMetrics(editor);
			return {
				editorRenderCalls: editor.renderCalls,
				layoutCacheHits: layoutCache.layoutCacheHits,
				layoutCacheMisses: layoutCache.layoutCacheMisses,
				layoutCacheValidationLineComparisons: layoutCache.layoutCacheValidationLineComparisons,
				layoutCacheSourceRecords: layoutCache.layoutCacheSourceRecords,
				layoutCacheLayoutRecords: layoutCache.layoutCacheLayoutRecords,
				layoutCacheRejectedByCapacity: layoutCache.layoutCacheRejectedByCapacity,
				layoutCacheRetainedSourceCodeUnits: layoutCache.layoutCacheRetainedSourceCodeUnits,
				layoutCacheRetainedLayoutLines: layoutCache.layoutCacheRetainedLayoutLines,
				oversizeCapacityRejections,
				completedItemRenders: metrics.completedItemRenders,
				viewportItemVisits: metrics.viewportItemVisits,
				frameWrites: shell.terminal.frameWrites,
				frameBytes: shell.terminal.frameBytes,
				finalFrameHash: shell.terminal.finalFrameHash(),
			};
		},
		async dispose(): Promise<void> {
			await shell.tui.dispose({ preserveScreen: true });
		},
	};
}

function createMouseRuntime(itemCount: number, width: number, height: number): CandidateRuntime {
	const shell = createAltShell(itemCount, width, height, "static", 1);
	const internals = shell.tui as unknown as { currentLayout: LayoutFrame | undefined };
	let matchedScrollViews = 0;
	return {
		unit: "event",
		productionPath: "production Alt LayoutFrame -> getScrollViewsAt mouse hit-test",
		step(index: number): void {
			const frame = internals.currentLayout;
			if (frame) matchedScrollViews += getScrollViewsAt(frame, index % width, (index * 7) % height).length;
		},
		reset(): void {
			matchedScrollViews = 0;
		},
		snapshot(): Record<string, number | string | boolean> {
			return { matchedScrollViews, actualLayoutFrame: internals.currentLayout !== undefined };
		},
		async dispose(): Promise<void> {
			await shell.tui.dispose({ preserveScreen: true });
		},
	};
}

function createSelectionAutoScrollRuntime(itemCount: number, width: number, height: number): CandidateRuntime {
	const shell = createAltShell(Math.max(itemCount, 50_000), width, height, "static", 1);
	const scrollView = shell.transcriptScrollView;
	scrollView.follow = "none";
	scrollView.scrollTo(10_000);
	const internals = shell.tui as unknown as {
		selectionAnchor?: { row: number; col: number; scrollView: ScrollView };
		selectionFocus?: { row: number; col: number; scrollView: ScrollView };
		selectionDragPointer?: { x: number; y: number };
		selectionAutoScrollDirection: -1 | 0 | 1;
		autoScrollSelection(): void;
	};
	internals.selectionAnchor = { row: 10_000, col: 0, scrollView };
	internals.selectionFocus = { row: 10_000, col: 1, scrollView };
	internals.selectionDragPointer = { x: 1, y: height - 2 };
	let ticks = 0;
	return {
		unit: "event",
		productionPath: "production Alt selection state -> TuiAltScreen.autoScrollSelection -> ScrollView/requestRender",
		step(index: number): void {
			internals.selectionAutoScrollDirection = (index & 1) === 0 ? 1 : -1;
			internals.autoScrollSelection();
			ticks++;
		},
		reset(): void {
			ticks = 0;
		},
		snapshot(): Record<string, number | string | boolean> {
			return { ticks, prototypeHarness: true, productionMethod: true, scrollTop: scrollView.scrollTop };
		},
		async dispose(): Promise<void> {
			await shell.tui.dispose({ preserveScreen: true });
		},
	};
}

class AlternatingKittyLines implements Component {
	private generation = 0;
	private readonly first = ["\x1b_Ga=T,i=9101,r=1;first-payload\x1b\\"];
	private readonly second = ["\x1b_Ga=T,i=9102,r=1;second-payload\x1b\\"];

	advance(): void {
		this.generation++;
	}

	render(): string[] {
		return (this.generation & 1) === 0 ? this.first : this.second;
	}

	invalidate(): void {}
}

function createKittyRuntime(width: number, height: number): CandidateRuntime {
	const previousCapabilities = getCapabilities();
	setCapabilities({ images: "kitty", trueColor: previousCapabilities.trueColor, hyperlinks: previousCapabilities.hyperlinks });
	registerKittyImageMetadata({ imageId: 9101, columns: 4, rows: 1, widthPx: 40, heightPx: 10 });
	registerKittyImageMetadata({ imageId: 9102, columns: 4, rows: 1, widthPx: 40, heightPx: 10 });
	const terminal = new BenchTerminal(width, height);
	const image = new AlternatingKittyLines();
	const root = new VStack([{ component: image, basis: 1 }, { component: new StaticLines("footer"), grow: 1 }]);
	const tui = new TuiAltScreen(terminal, false, undefined, { mouse: false });
	tui.setLayoutRoot(root);
	tui.start();
	tui.renderNow();
	terminal.frameWrites = 0;
	terminal.frameBytes = 0;
	let frames = 0;
	return {
		unit: "frame",
		productionPath: "real Kitty line -> Alt layout/paint -> prepareKittyScreen -> TuiAltScreen frame queue",
		step(): void {
			image.advance();
			tui.renderNow();
			frames++;
		},
		reset(): void {
			frames = 0;
			terminal.frameWrites = 0;
			terminal.frameBytes = 0;
		},
		snapshot(): Record<string, number | string | boolean> {
			return {
				frames,
				frameWrites: terminal.frameWrites,
				frameBytes: terminal.frameBytes,
				finalFrameHash: terminal.finalFrameHash(),
				kittyProtocol: true,
			};
		},
		async dispose(): Promise<void> {
			await tui.dispose({ preserveScreen: true });
			setCapabilities(previousCapabilities);
		},
	};
}

function createStackDirectRuntime(width: number): CandidateRuntime {
	const leaves: Component[] = [];
	for (let index = 0; index < 9; index++) leaves.push(new StaticLines(`leaf-${index}`, 3));
	const root = new CountingVStack([
		new HStack(leaves.slice(0, 3)),
		new HStack(leaves.slice(3, 6)),
		new HStack(leaves.slice(6, 9)),
	]);
	let outputLines = 0;
	return {
		unit: "frame",
		productionPath: "direct compatibility HStack/VStack.render (Alt specialized layout path bypasses this method)",
		step(): void {
			outputLines += root.render(width).length;
		},
		reset(): void {
			root.directRenderCalls = 0;
			outputLines = 0;
		},
		snapshot(): Record<string, number | string | boolean> {
			return { directRenderCalls: root.directRenderCalls, outputLines, altProductionPath: false };
		},
		async dispose(): Promise<void> {},
	};
}

function createRuntime(
	candidate: Candidate,
	itemCount: number,
	width: number,
	height: number,
	editorUpdate: EditorUpdate,
	editorLineCount: number,
): CandidateRuntime {
	if (candidate === "editor-frame") return createEditorRuntime(itemCount, width, height, editorUpdate, editorLineCount);
	if (candidate === "mouse-hit") return createMouseRuntime(itemCount, width, height);
	if (candidate === "selection-auto-scroll") return createSelectionAutoScrollRuntime(itemCount, width, height);
	if (candidate === "kitty-fallback") return createKittyRuntime(width, height);
	return createStackDirectRuntime(width);
}

function percentile(sorted: readonly number[], ratio: number): number {
	return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1))] ?? 0;
}

function numericAscending(left: number, right: number): number {
	return left - right;
}

function readCandidate(): Candidate {
	const index = process.argv.indexOf("--candidate");
	const value = index === -1 ? "editor-frame" : process.argv[index + 1];
	if (
		value !== "editor-frame" &&
		value !== "mouse-hit" &&
		value !== "selection-auto-scroll" &&
		value !== "kitty-fallback" &&
		value !== "stack-direct"
	) {
		throw new Error("--candidate must be editor-frame, mouse-hit, selection-auto-scroll, kitty-fallback, or stack-direct");
	}
	return value;
}

function collectAllocationSites(head: SamplingNode): {
	sampledBytes: number;
	top: Array<{ bytes: number; functionName: string; url: string; line: number }>;
} {
	const sites = new Map<string, { bytes: number; functionName: string; url: string; line: number }>();
	const pending = [head];
	let sampledBytes = 0;
	while (pending.length > 0) {
		const node = pending.pop()!;
		if (node.selfSize > 0) {
			sampledBytes += node.selfSize;
			const frame = node.callFrame;
			const key = `${frame.url}\0${frame.lineNumber}\0${frame.functionName}`;
			const existing = sites.get(key);
			if (existing) existing.bytes += node.selfSize;
			else sites.set(key, { bytes: node.selfSize, functionName: frame.functionName || "(anonymous)", url: frame.url, line: frame.lineNumber + 1 });
		}
		if (node.children) for (let index = 0; index < node.children.length; index++) pending.push(node.children[index]!);
	}
	const top = [...sites.values()];
	top.sort(descendingAllocationBytes);
	if (top.length > 20) top.length = 20;
	return { sampledBytes, top };
}

function descendingAllocationBytes(left: { bytes: number }, right: { bytes: number }): number {
	return right.bytes - left.bytes;
}

const candidate = readCandidate();
const itemCount = readIntegerOption("--items", 5_000);
const width = readIntegerOption("--width", 120);
const height = readIntegerOption("--height", 40);
const editorLineCount = readIntegerOption("--editor-lines", 1);
const warmup = readIntegerOption("--warmup", 1_000);
const measured = readIntegerOption("--measured", 20_000);
const profile = process.argv.includes("--profile");
const editorUpdateIndex = process.argv.indexOf("--editor-update");
const editorUpdate = (editorUpdateIndex === -1 ? "stable" : process.argv[editorUpdateIndex + 1]) as EditorUpdate;
if (editorUpdate !== "stable" && editorUpdate !== "cursor" && editorUpdate !== "oversize-small") {
	throw new Error("--editor-update must be stable, cursor, or oversize-small");
}
if (profile && typeof globalThis.gc !== "function") throw new Error("--profile requires --expose-gc");

let runtime: CandidateRuntime | undefined = createRuntime(candidate, itemCount, width, height, editorUpdate, editorLineCount);
for (let index = 0; index < warmup; index++) runtime.step(index);
runtime.reset();
const runtimeUnit = runtime.unit;
const productionPath = runtime.productionPath;

let minorGcCount = 0;
let majorGcCount = 0;
let totalGcDurationMs = 0;
const observer = new PerformanceObserver(onGcEntries);
function onGcEntries(list: PerformanceObserverEntryList): void {
	for (const rawEntry of list.getEntries()) {
		const entry = rawEntry as GcPerformanceEntry;
		totalGcDurationMs += entry.duration;
		if (entry.detail?.kind === constants.NODE_PERFORMANCE_GC_MINOR) minorGcCount++;
		else if (entry.detail?.kind === constants.NODE_PERFORMANCE_GC_MAJOR) majorGcCount++;
	}
}

let session: Session | undefined;
let controlledGcBeforeHeapBytes = 0;
if (profile) {
	globalThis.gc!();
	globalThis.gc!();
	controlledGcBeforeHeapBytes = process.memoryUsage().heapUsed;
	observer.observe({ entryTypes: ["gc"] });
	session = new Session();
	session.connect();
	await session.post("HeapProfiler.enable");
	await session.post("HeapProfiler.startSampling", {
		samplingInterval: 1024,
		includeObjectsCollectedByMajorGC: true,
		includeObjectsCollectedByMinorGC: true,
	});
}

const durations = new Array<number>(measured);
for (let index = 0; index < measured; index++) {
	const started = performance.now();
	runtime.step(index);
	durations[index] = performance.now() - started;
}

let sampledBytes = 0;
let topAllocationSites: Array<{ bytes: number; functionName: string; url: string; line: number }> = [];
let controlledGcAfterHeapBytes = 0;
let controlledGcAfterDisposeHeapBytes = 0;
if (session) {
	const stopped = await session.post("HeapProfiler.stopSampling");
	await session.post("HeapProfiler.disable");
	session.disconnect();
	const allocation = collectAllocationSites(stopped.profile.head as SamplingNode);
	sampledBytes = allocation.sampledBytes;
	topAllocationSites = allocation.top;
	await new Promise<void>(resolveAfterProfile);
	observer.disconnect();
	globalThis.gc!();
	globalThis.gc!();
	controlledGcAfterHeapBytes = process.memoryUsage().heapUsed;
}

function resolveAfterProfile(resolve: () => void): void {
	setTimeout(resolve, 100);
}

durations.sort(numericAscending);
const runtimeSnapshot = runtime.snapshot();
await runtime.dispose();
runtime = undefined;
if (profile) {
	globalThis.gc!();
	globalThis.gc!();
	controlledGcAfterDisposeHeapBytes = process.memoryUsage().heapUsed;
}

process.stdout.write(
	`${JSON.stringify(
		{
			schemaVersion: 1,
			benchmark: "tui-b3-plan-gate",
			commit: currentCommit(),
			candidate,
			unit: runtimeUnit,
			productionPath,
			itemCount,
			width,
			height,
			warmup,
			measured,
			editorUpdate,
			editorLineCount,
			worktreeStatus: spawnSync("git", ["status", "--short"], { encoding: "utf8" }).stdout.trim() || "clean",
			profile,
			node: process.version,
			platform: process.platform,
			metrics: {
				cpuP50Ms: percentile(durations, 0.5),
				cpuP95Ms: percentile(durations, 0.95),
				sampledAllocationBytes: sampledBytes,
				sampledAllocationBytesPerUnit: profile ? sampledBytes / measured : null,
				minorGcCount,
				majorGcCount,
				totalGcDurationMs,
				controlledGcBeforeHeapBytes,
				controlledGcAfterHeapBytes,
				controlledGcDeltaBytes: profile ? controlledGcAfterHeapBytes - controlledGcBeforeHeapBytes : null,
				controlledGcAfterDisposeHeapBytes,
				controlledGcAfterDisposeDeltaBytes: profile
					? controlledGcAfterDisposeHeapBytes - controlledGcBeforeHeapBytes
					: null,
				...runtimeSnapshot,
			},
			topAllocationSites,
		},
		null,
		2,
	)}\n`,
);
