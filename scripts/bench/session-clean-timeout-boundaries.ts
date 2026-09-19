import { performance } from "node:perf_hooks";
import { setImmediate as nextTurn } from "node:timers/promises";
import { Session } from "node:inspector/promises";
import { BoundedMemorySelector } from "../../packages/extensions/session-memory-manager/bounded-selector.ts";
import { inspectBashPermissionScope } from "../../packages/extensions/resource-lifecycle-guard/permission-bash.ts";
import { inspectBashResourceLifecycle, inspectHighRiskBashMutation } from "../../packages/extensions/resource-lifecycle-guard/core.ts";
import { getKeybindings } from "../../packages/tui/src/keybindings.ts";
import type { Terminal } from "../../packages/tui/src/terminal.ts";
import { TuiAltScreen } from "../../packages/tui/src/tui-alt-screen.ts";
import { TuiMainScreen } from "../../packages/tui/src/tui-main-screen.ts";
import { runBenchmarkMain, readIntegerOption } from "./benchmark.ts";

class NoopTerminal implements Terminal {
	readonly kittyProtocolActive = false;
	columns: number;
	rows: number;
	frameWrites = 0;
	totalFrameUtf16CodeUnits = 0;
	maximumFrameUtf16CodeUnits = 0;
	private input: ((data: string) => void) | undefined;
	private resize: (() => void) | undefined;
	private completion: ((generation: number, error?: Error) => void) | undefined;

	constructor(columns: number, rows: number) { this.columns = columns; this.rows = rows; }
	start(input: (data: string) => void, resize: () => void): void { this.input = input; this.resize = resize; }
	stop(): void { this.input = undefined; this.resize = undefined; }
	dispose(): void { this.stop(); this.completion = undefined; }
	async drainInput(): Promise<void> {}
	write(): void {}
	writeFrame(data: string, generation: number): void {
		this.frameWrites++;
		this.totalFrameUtf16CodeUnits += data.length;
		this.maximumFrameUtf16CodeUnits = Math.max(this.maximumFrameUtf16CodeUnits, data.length);
		this.completion?.(generation);
	}
	setFrameWriteCompletionListener(listener: ((generation: number, error?: Error) => void) | undefined): void { this.completion = listener; }
	cancelFrameWrite(): void {}
	moveBy(): void {}
	hideCursor(): void {}
	showCursor(): void {}
	clearLine(): void {}
	clearFromCursor(): void {}
	clearScreen(): void {}
	setTitle(): void {}
	setProgress(): void {}
	emit(data: string): void { this.input?.(data); }
	resizeTo(columns: number, rows: number): void { this.columns = columns; this.rows = rows; this.resize?.(); }
}

const theme = { bold: (value: string) => value, fg: (_tone: string, value: string) => value };
const keybindings = getKeybindings();

function selectorItems(): Array<{ value: number; label: string; selectable?: boolean; detail?: string; dangerous?: boolean }> {
	const items = [{ value: -1, label: "session-long-name.jsonl", selectable: false, detail: "/tmp/synthetic/" + "长路径😀e\u0301/".repeat(40) }];
	for (let index = 0; index < 30; index++) items.push({ value: index, label: `动作 ${index}`, dangerous: index === 0 });
	return items;
}

interface SelectorRun {
	renderCalls: number; renderedLines: number; detailWrapCalls: number;
	mainFrameWrites: number; altFrameWrites: number; totalFrameUtf16CodeUnits: number; maximumFrameUtf16CodeUnits: number;
	maximumCacheLines: number; maximumVisibleDetailRows: number; finalCacheLines: number; releasedFieldCount: number;
	ownerRefs?: WeakRef<object>[]; initialDetailRefs?: WeakRef<object>[]; resizedDetailRefs?: WeakRef<object>[];
}

interface SelectorCounters {
	renderCalls: number; renderedLines: number; maximumCacheLines: number; maximumVisibleDetailRows: number;
}

function instrumentSelector(selector: BoundedMemorySelector<number>, counters: SelectorCounters): void {
	const original = selector.render.bind(selector);
	(selector as unknown as { render: (width: number) => string[] }).render = (width: number) => {
		counters.renderCalls++;
		const lines = original(width);
		counters.renderedLines += lines.length;
		const state = selector as unknown as { detailLines: string[]; detailRows: number };
		counters.maximumCacheLines = Math.max(counters.maximumCacheLines, state.detailLines.length);
		counters.maximumVisibleDetailRows = Math.max(counters.maximumVisibleDetailRows, state.detailRows);
		return lines;
	};
}

async function runSelectorFixture(iterations: number, lifecycleDiagnostics: boolean): Promise<SelectorRun> {
	const main = new NoopTerminal(60, 24);
	const alt = new NoopTerminal(60, 24);
	const counters = { renderCalls: 0, renderedLines: 0, maximumCacheLines: 0, maximumVisibleDetailRows: 0 };
	const selectors = [
		new BoundedMemorySelector("清理", selectorItems(), theme, keybindings, () => {}, () => 22, 30),
		new BoundedMemorySelector("清理", selectorItems(), theme, keybindings, () => {}, () => 22, 30),
	];
	for (const selector of selectors) instrumentSelector(selector, counters);
	const mainScreen = new TuiMainScreen(main, true);
	const altScreen = new TuiAltScreen(alt, true);
	mainScreen.addChild(selectors[0]!); altScreen.addChild(selectors[1]!);
	mainScreen.setFocus(selectors[0]!); altScreen.setFocus(selectors[1]!);
	mainScreen.start(); altScreen.start(); mainScreen.renderNow(true); altScreen.renderNow(true);
	main.emit("\t"); alt.emit("\t"); mainScreen.renderNow(true); altScreen.renderNow(true);
	const initialCaches: string[][] = [];
	for (const selector of selectors) initialCaches.push((selector as unknown as { detailLines: string[] }).detailLines);
	for (const cache of initialCaches) {
		let containsPath = false;
		for (const line of cache) if (line.includes("/tmp/synthetic/")) { containsPath = true; break; }
		if (cache.length === 0 || !containsPath) throw new Error("selector fixture did not create the expected initial detail cache");
	}
	let initialDetailRefs: WeakRef<object>[] | undefined;
	if (lifecycleDiagnostics) {
		initialDetailRefs = [];
		for (const cache of initialCaches) initialDetailRefs.push(new WeakRef<object>(cache));
	}
	for (let index = 1; index < iterations; index++) {
		main.emit("\t"); alt.emit("\t"); mainScreen.renderNow(true); altScreen.renderNow(true);
	}
	main.emit("\t"); alt.emit("\t"); mainScreen.renderNow(true); altScreen.renderNow(true);
	if ((selectors[0] as unknown as { focus: string }).focus === "actions") main.emit("\t");
	if ((selectors[1] as unknown as { focus: string }).focus === "actions") alt.emit("\t");
	main.resizeTo(42, 16); alt.resizeTo(42, 16); mainScreen.renderNow(true); altScreen.renderNow(true);

	const detailLines: string[][] = [];
	for (const selector of selectors) detailLines.push((selector as unknown as { detailLines: string[] }).detailLines);
	for (let index = 0; index < detailLines.length; index++) {
		if (detailLines[index] === initialCaches[index] || detailLines[index]!.length === 0) throw new Error("selector fixture did not replace the detail cache after resize");
	}
	let resizedDetailRefs: WeakRef<object>[] | undefined;
	if (lifecycleDiagnostics) {
		resizedDetailRefs = [];
		for (const cache of detailLines) resizedDetailRefs.push(new WeakRef<object>(cache));
	}
	const metrics = {
		renderCalls: counters.renderCalls, renderedLines: counters.renderedLines,
		detailWrapCalls: (selectors[0] as unknown as { detailWrapCount: number }).detailWrapCount + (selectors[1] as unknown as { detailWrapCount: number }).detailWrapCount,
		maximumCacheLines: counters.maximumCacheLines,
		maximumVisibleDetailRows: counters.maximumVisibleDetailRows,
		finalCacheLines: Math.max(detailLines[0]!.length, detailLines[1]!.length),
		mainFrameWrites: main.frameWrites, altFrameWrites: alt.frameWrites,
		totalFrameUtf16CodeUnits: main.totalFrameUtf16CodeUnits + alt.totalFrameUtf16CodeUnits,
		maximumFrameUtf16CodeUnits: Math.max(main.maximumFrameUtf16CodeUnits, alt.maximumFrameUtf16CodeUnits),
	};
	let ownerRefs: WeakRef<object>[] | undefined;
	if (lifecycleDiagnostics) {
		ownerRefs = [];
		for (const selector of selectors) ownerRefs.push(new WeakRef<object>(selector));
	}
	await mainScreen.dispose({ preserveScreen: true });
	await altScreen.dispose({ preserveScreen: true });
	for (const selector of selectors) selector.dispose();
	let releasedFieldCount = 0;
	for (const selector of selectors) {
		const state = selector as unknown as { items: unknown[]; detailLines: unknown[]; done?: unknown; getAvailableRows?: unknown };
		releasedFieldCount += (state.items.length === 0 ? 1 : 0) + (state.detailLines.length === 0 ? 1 : 0) + (state.done === undefined ? 1 : 0) + (state.getAvailableRows === undefined ? 1 : 0);
	}
	if (releasedFieldCount !== 8) throw new Error("selector retained owned records after async dispose");
	initialCaches.length = 0;
	detailLines.length = 0;
	return { ...metrics, releasedFieldCount, ownerRefs, initialDetailRefs, resizedDetailRefs };
}

const shellCases = [
	"printf '%s\\n' $((8 >> 1))", "cat <<'EOF'\nliteral > victim.txt\nEOF",
	"cat <<'EOF'\nliteral > victim.txt\nEOF\necho x > after.txt", "timeout 250 find . -type f > output.txt",
	"cat <<EOF\n$(echo nested > nested.txt)\nEOF", "echo diagnostic 2>&1",
];

function runShellFixture(iterations: number): { calls: number; mutationFindings: number; permissionFindings: number; lifecycleRefusals: number; targetCount: number } {
	let calls = 0, mutationFindings = 0, permissionFindings = 0, lifecycleRefusals = 0, targetCount = 0;
	for (let iteration = 0; iteration < iterations; iteration++) for (const command of shellCases) {
		const lifecycle = inspectBashResourceLifecycle({ command });
		const mutation = inspectHighRiskBashMutation({ command }, process.cwd());
		const permission = inspectBashPermissionScope({ command }, process.cwd());
		calls += 3; if (mutation) mutationFindings++; if (permission?.kind !== "read-only") permissionFindings++; if (lifecycle) lifecycleRefusals++;
		targetCount += (mutation?.targets.length ?? 0) + (permission?.targets.length ?? 0);
	}
	return { calls, mutationFindings, permissionFindings, lifecycleRefusals, targetCount };
}

interface SamplingNode { selfSize: number; callFrame: { functionName: string; url: string; lineNumber: number }; children?: SamplingNode[] }
interface SamplingSummary {
	sampledBytes: number; sampledNodeCount: number; topSites: string; visitedNodeCount: number;
	siteTableTruncated: boolean; traversalTruncated: boolean;
}

async function startHeapSampling(): Promise<Session> {
	const inspector = new Session();
	inspector.connect();
	await inspector.post("HeapProfiler.enable");
	await inspector.post("HeapProfiler.startSampling", { samplingInterval: 8192, includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true });
	return inspector;
}

async function finishHeapSampling(inspector: Session, siteLabel: string): Promise<SamplingSummary> {
	const profile = (await inspector.post("HeapProfiler.stopSampling")).profile as unknown as { head: SamplingNode };
	await inspector.post("HeapProfiler.disable");
	inspector.disconnect();
	const pending: SamplingNode[] = [profile!.head]; const sites = new Map<string, number>();
	let sampledBytes = 0, sampledNodeCount = 0, visited = 0, siteTableTruncated = false;
	while (pending.length > 0 && visited++ < 10000) {
		const node = pending.pop()!;
		if (node.selfSize > 0) {
			sampledBytes += node.selfSize; sampledNodeCount++;
			const frame = node.callFrame; const site = `${siteLabel}:${frame.functionName}:${frame.url}:${frame.lineNumber + 1}`;
			if (sites.size < 32 || sites.has(site)) sites.set(site, (sites.get(site) ?? 0) + node.selfSize);
			else siteTableTruncated = true;
		}
		if (node.children) for (const child of node.children) pending.push(child);
	}
	const topSites = [...sites].sort((left, right) => right[1] - left[1]).slice(0, 8).map(([site, bytes]) => `${site}=${bytes}`).join(";");
	return { sampledBytes, sampledNodeCount, topSites, visitedNodeCount: visited, siteTableTruncated, traversalTruncated: pending.length > 0 };
}

async function runSampledSelectorFixture(iterations: number, lifecycleDiagnostics: boolean): Promise<{ value: SelectorRun; sample: SamplingSummary }> {
	const inspector = await startHeapSampling();
	try {
		const value = await runSelectorFixture(iterations, lifecycleDiagnostics);
		const sample = await finishHeapSampling(inspector, "selector");
		return { value, sample };
	} catch (error) {
		await finishHeapSampling(inspector, "selector");
		throw error;
	}
}

async function runSampledShellFixture(iterations: number): Promise<{ value: ReturnType<typeof runShellFixture>; sample: SamplingSummary }> {
	const inspector = await startHeapSampling();
	try {
		const value = runShellFixture(iterations);
		const sample = await finishHeapSampling(inspector, "shell");
		return { value, sample };
	} catch (error) {
		await finishHeapSampling(inspector, "shell");
		throw error;
	}
}

async function releaseDiagnostics(refs: WeakRef<object>[]): Promise<number> {
	if (typeof globalThis.gc !== "function") return -1;
	for (let index = 0; index < 3; index++) { await nextTurn(); globalThis.gc(); }
	let released = 0;
	for (const ref of refs) if (ref.deref() === undefined) released++;
	return released;
}

const iterations = readIntegerOption("--iterations", 100);
const warmupRuns = readIntegerOption("--warmup", 5);
const measuredRuns = readIntegerOption("--runs", 20);
const sampleRequested = process.argv.includes("--sample");
const lifecycleRequested = process.argv.includes("--lifecycle");
let invocation = 0;
let finalSampling: { selector: SamplingSummary; shell: SamplingSummary; samplingInterval: number } | undefined;
const emptySample: SamplingSummary = { sampledBytes: 0, sampledNodeCount: 0, topSites: "", visitedNodeCount: 0, siteTableTruncated: false, traversalTruncated: false };

await runBenchmarkMain({
	name: "session-clean-timeout-boundaries-production-paths",
	fixture: "bounded-selector-main-alt-and-shell-contexts",
	run: async () => {
		invocation++;
		const sampleThisRun = sampleRequested && invocation === warmupRuns + measuredRuns;
		const lifecycleThisRun = lifecycleRequested && invocation === warmupRuns + measuredRuns;
		const lifecycleGcAvailable = lifecycleThisRun && typeof globalThis.gc === "function";
		if (lifecycleGcAvailable) globalThis.gc();
		const beforeHeap = lifecycleGcAvailable ? process.memoryUsage().heapUsed : 0;
		const started = performance.now();
		const selectorResult = sampleThisRun
			? await runSampledSelectorFixture(iterations, lifecycleThisRun)
			: { value: await runSelectorFixture(iterations, lifecycleThisRun), sample: emptySample };
		const shellResult = sampleThisRun
			? await runSampledShellFixture(iterations)
			: { value: runShellFixture(iterations), sample: emptySample };
		const elapsedMs = performance.now() - started;
		const selectorWeakOwnerReleased = lifecycleGcAvailable && selectorResult.value.ownerRefs
			? await releaseDiagnostics(selectorResult.value.ownerRefs)
			: undefined;
		const selectorInitialCacheReleased = lifecycleGcAvailable && selectorResult.value.initialDetailRefs
			? await releaseDiagnostics(selectorResult.value.initialDetailRefs)
			: undefined;
		const selectorResizedCacheReleased = lifecycleGcAvailable && selectorResult.value.resizedDetailRefs
			? await releaseDiagnostics(selectorResult.value.resizedDetailRefs)
			: undefined;
		if (sampleThisRun) finalSampling = { selector: selectorResult.sample, shell: shellResult.sample, samplingInterval: 8192 };
		const metrics: Record<string, number> = {
			selectorRenderCalls: selectorResult.value.renderCalls, selectorRenderedLines: selectorResult.value.renderedLines,
			selectorDetailWrapCalls: selectorResult.value.detailWrapCalls, selectorMaximumCacheLines: selectorResult.value.maximumCacheLines,
			selectorMaximumVisibleDetailRows: selectorResult.value.maximumVisibleDetailRows, selectorFinalCacheLines: selectorResult.value.finalCacheLines,
			selectorFrameWrites: selectorResult.value.mainFrameWrites + selectorResult.value.altFrameWrites,
			selectorTotalFrameUtf16CodeUnits: selectorResult.value.totalFrameUtf16CodeUnits, selectorMaximumFrameUtf16CodeUnits: selectorResult.value.maximumFrameUtf16CodeUnits,
			selectorReleasedFieldCount: selectorResult.value.releasedFieldCount,
			shellCalls: shellResult.value.calls, shellMutationFindings: shellResult.value.mutationFindings, shellPermissionFindings: shellResult.value.permissionFindings,
			shellLifecycleRefusals: shellResult.value.lifecycleRefusals, shellTargetCount: shellResult.value.targetCount,
			fixtureElapsedMs: elapsedMs,
		};
		if (sampleThisRun) Object.assign(metrics, {
			selectorSampledAllocationBytes: selectorResult.sample.sampledBytes,
			selectorSampledNodeCount: selectorResult.sample.sampledNodeCount,
			shellSampledAllocationBytes: shellResult.sample.sampledBytes,
			shellSampledNodeCount: shellResult.sample.sampledNodeCount,
		});
		if (lifecycleThisRun) metrics.selectorLifecycleFieldClearCount = selectorResult.value.releasedFieldCount;
		if (lifecycleGcAvailable) Object.assign(metrics, {
			selectorWeakOwnerReleasedCount: selectorWeakOwnerReleased!,
			selectorInitialDetailCacheReleasedCount: selectorInitialCacheReleased!,
			selectorResizedDetailCacheReleasedCount: selectorResizedCacheReleased!,
			postGcHeapDeltaBytes: process.memoryUsage().heapUsed - beforeHeap,
		});
		return metrics;
	},
	observations: () => ({
		baselineCommit: "6e08fd47440796b528941ce0dba21213796db582",
		comparison: "candidate-only runtime evidence; baseline is immutable Git/structure point, with no copied source or baseline runtime",
		timing: lifecycleRequested ? "lifecycle diagnostic run; runner timings include its bounded GC/WeakRef phase" : sampleRequested ? "allocation-sampled run; runner timings include profiler phases and are not ordinary latency" : "ordinary fixture timing; includes awaited dispose only, with no explicit GC, profiler, or WeakRef diagnostic",
		sampling: sampleRequested ? "one final measured run; selector and shell phases sampled separately, including fixture setup/render/parse/dispose" : "not requested",
		samplingIntervalBytes: finalSampling?.samplingInterval ?? 8192, includeObjectsCollectedByMinorOrMajorGC: sampleRequested,
		sampledNodeMeaning: "sampledNodeCount counts profile call-tree nodes with selfSize > 0; it is not object count or profile event count",
		samplingSiteSummary: "topSites is the sorted top 8 from a bounded first-32-site table and at most 10,000 visited profile nodes; truncation flags are reported",
		selectorTopSites: finalSampling?.selector.topSites ?? "not sampled", shellTopSites: finalSampling?.shell.topSites ?? "not sampled",
		selectorSamplingVisitedNodeCount: finalSampling?.selector.visitedNodeCount ?? "not sampled", shellSamplingVisitedNodeCount: finalSampling?.shell.visitedNodeCount ?? "not sampled",
		selectorSamplingSiteTableTruncated: finalSampling?.selector.siteTableTruncated ?? false, shellSamplingSiteTableTruncated: finalSampling?.shell.siteTableTruncated ?? false,
		selectorSamplingTraversalTruncated: finalSampling?.selector.traversalTruncated ?? false, shellSamplingTraversalTruncated: finalSampling?.shell.traversalTruncated ?? false,
		lifecycle: lifecycleRequested ? (typeof globalThis.gc === "function" ? "final measured run only; three bounded GC turns after awaited dispose" : "requested but GC unavailable; WeakRef recovery undetermined") : "not requested; release counts intentionally omitted",
		selectorOwner: "one selector-owned detail array per instance; fields cleared after awaited Main/Alt dispose",
		shellOwner: "call-owned parser views and bounded token scans; no command rewrite, probe, or retained result array",
		objectPool: false, realFilesystemAccess: false,
		postGcHeapMeaning: "only present for a run that executed lifecycle GC; final-run heapUsed net change, not cumulative allocation, peak memory, sampled bytes, or leak bytes",
	}),
});
