import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { cpus } from "node:os";
import { constants, performance, PerformanceObserver, type PerformanceEntry } from "node:perf_hooks";
import { Session } from "node:inspector/promises";
import assert from "node:assert/strict";
import {
	Markdown,
	type MarkdownIncrementalMetrics,
	type MarkdownTheme,
} from "../../packages/tui/src/components/markdown.ts";
import { currentCommit, readIntegerOption } from "./benchmark.ts";

interface SamplingNode {
	callFrame: { functionName: string; url: string; lineNumber: number; columnNumber: number };
	selfSize: number;
	children?: SamplingNode[];
}

interface PerformanceGcEntry extends PerformanceEntry {
	detail?: { kind?: number };
}

interface AllocationSite {
	bytes: number;
	functionName: string;
	url: string;
	line: number;
	column: number;
}

interface ChildResult {
	fixture: string;
	width: number;
	rows: number;
	mode: "full" | "incremental";
	cpuP50MsPerUpdate: number;
	cpuP95MsPerUpdate: number;
	sampledAllocationBytesPerUpdate: number;
	minorGcCount: number;
	majorGcCount: number;
	totalGcDurationMs: number;
	heapBefore: number;
	heapAfter: number;
	controlledGcAfter: number;
	controlledGcHeapDeltaBytes: number;
	finalHash: string;
	metrics: MarkdownIncrementalMetrics;
	cacheHwm: {
		tokens: number;
		renderedLines: number;
		sourceCharacters: number;
	};
	afterInvalidate: {
		tokens: number;
		renderedLines: number;
		sourceCharacters: number;
	};
	topAllocationSites: AllocationSite[];
}

interface LifecycleResult {
	cycles: number;
	heapSamples: number[];
	heapSlopeBytesPerCycle: number;
	maximumCachedSourceCharacters: number;
	maximumCachedRenderedLines: number;
	afterShrinkSourceCharacters: number;
	afterShrinkRenderedLines: number;
	afterInvalidateSourceCharacters: number;
	afterInvalidateRenderedLines: number;
}

const identityStyle = (text: string): string => text;
const THEME: MarkdownTheme = {
	heading: identityStyle,
	link: identityStyle,
	linkUrl: identityStyle,
	code: identityStyle,
	codeBlock: identityStyle,
	codeBlockBorder: identityStyle,
	quote: identityStyle,
	quoteBorder: identityStyle,
	hr: identityStyle,
	listBullet: identityStyle,
	bold: identityStyle,
	italic: identityStyle,
	strikethrough: identityStyle,
	underline: identityStyle,
};

const FIXTURES = ["plain", "append", "cjk", "ansi", "code", "list", "table", "latex"] as const;
type Fixture = (typeof FIXTURES)[number];
const WIDTHS = [120, 200] as const;
const ROWS = [40, 60] as const;

function readStringOption(name: string): string | undefined {
	const index = process.argv.indexOf(name);
	return index < 0 ? undefined : process.argv[index + 1];
}

function createMetrics(): MarkdownIncrementalMetrics {
	return {
		incrementalEligibleUpdates: 0,
		incrementalUpdates: 0,
		fullFallbacks: 0,
		sourceCharactersReparsed: 0,
		sourceCharactersRewrapped: 0,
		parserTokensReused: 0,
		parserTokensRebuilt: 0,
		renderedPrefixLinesReused: 0,
		tailLinesRebuilt: 0,
		cachedTokenCount: 0,
		cachedRenderedLines: 0,
		cachedSourceCharacters: 0,
		lastFallbackReason: "none",
	};
}

function resetMetrics(metrics: MarkdownIncrementalMetrics): void {
	metrics.incrementalEligibleUpdates = 0;
	metrics.incrementalUpdates = 0;
	metrics.fullFallbacks = 0;
	metrics.sourceCharactersReparsed = 0;
	metrics.sourceCharactersRewrapped = 0;
	metrics.parserTokensReused = 0;
	metrics.parserTokensRebuilt = 0;
	metrics.renderedPrefixLinesReused = 0;
	metrics.tailLinesRebuilt = 0;
	metrics.cachedTokenCount = 0;
	metrics.cachedRenderedLines = 0;
	metrics.cachedSourceCharacters = 0;
	metrics.lastFallbackReason = "none";
}

function percentile(sorted: readonly number[], ratio: number): number {
	return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1))] ?? 0;
}

function median(values: readonly number[]): number {
	const sorted = values.slice().sort((left, right) => left - right);
	return percentile(sorted, 0.5);
}

function coefficientOfVariation(values: readonly number[]): number {
	if (values.length === 0) return 0;
	let sum = 0;
	for (let index = 0; index < values.length; index++) sum += values[index]!;
	const mean = sum / values.length;
	if (mean === 0) return 0;
	let squaredDeviation = 0;
	for (let index = 0; index < values.length; index++) {
		const deviation = values[index]! - mean;
		squaredDeviation += deviation * deviation;
	}
	return Math.sqrt(squaredDeviation / values.length) / mean;
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
			const previous = sites.get(key);
			if (previous) previous.bytes += node.selfSize;
			else sites.set(key, {
				bytes: node.selfSize,
				functionName: frame.functionName || "(anonymous)",
				url: frame.url,
				line: frame.lineNumber + 1,
				column: frame.columnNumber + 1,
			});
		}
		if (node.children) {
			for (let index = 0; index < node.children.length; index++) pending.push(node.children[index]!);
		}
	}
	return {
		sampledBytes,
		top: [...sites.values()].sort((left, right) => right.bytes - left.bytes).slice(0, 20),
	};
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

function runLifecycle(cycles: number): LifecycleResult {
	if (typeof globalThis.gc !== "function") throw new Error("lifecycle fixture requires --expose-gc");
	const heapSamples = new Array<number>(cycles);
	let maximumCachedSourceCharacters = 0;
	let maximumCachedRenderedLines = 0;
	let afterShrinkSourceCharacters = 0;
	let afterShrinkRenderedLines = 0;
	let afterInvalidateSourceCharacters = 0;
	let afterInvalidateRenderedLines = 0;
	for (let cycle = -2; cycle < cycles; cycle++) {
		const metrics = createMetrics();
		let markdown: Markdown | undefined = new Markdown(
			"x".repeat(256 * 1024 - 1),
			1,
			0,
			THEME,
			undefined,
			{ incrementalRenderCache: true },
			metrics,
		);
		markdown.render(120);
		if (metrics.cachedSourceCharacters > maximumCachedSourceCharacters) {
			maximumCachedSourceCharacters = metrics.cachedSourceCharacters;
		}
		if (metrics.cachedRenderedLines > maximumCachedRenderedLines) {
			maximumCachedRenderedLines = metrics.cachedRenderedLines;
		}
		markdown.setText("small");
		markdown.render(120);
		afterShrinkSourceCharacters = metrics.cachedSourceCharacters;
		afterShrinkRenderedLines = metrics.cachedRenderedLines;
		markdown.invalidate();
		afterInvalidateSourceCharacters = metrics.cachedSourceCharacters;
		afterInvalidateRenderedLines = metrics.cachedRenderedLines;
		markdown = undefined;
		globalThis.gc();
		globalThis.gc();
		if (cycle >= 0) heapSamples[cycle] = process.memoryUsage().heapUsed;
	}
	return {
		cycles,
		heapSamples,
		heapSlopeBytesPerCycle: linearSlope(heapSamples),
		maximumCachedSourceCharacters,
		maximumCachedRenderedLines,
		afterShrinkSourceCharacters,
		afterShrinkRenderedLines,
		afterInvalidateSourceCharacters,
		afterInvalidateRenderedLines,
	};
}

function nextFixtureSource(fixture: Fixture, index: number, growing: string): string {
	switch (fixture) {
		case "plain": return `plain replacement control ${index & 7}`;
		case "append": return growing.length >= 4_096 ? "# x" : growing.charCodeAt(0) === 0x23 ? `${growing}x` : "# x";
		case "cjk": return growing.length >= 4_096 ? "中" : `${growing}中`;
		case "ansi": return `\x1b[31mANSI control ${index & 7}\x1b[0m`;
		case "code": return `\`\`\`ts\nconst value = ${index & 15};\n\`\`\``;
		case "list": return `- item ${index & 7}\n  - nested ${index & 3}`;
		case "table": return `| key | value |\n| --- | --- |\n| row | ${index & 15} |`;
		case "latex": return `$x_${index & 7}^2 + y_${index & 3}^2$`;
	}
}

async function runChild(): Promise<void> {
	if (typeof globalThis.gc !== "function") throw new Error("benchmark child requires --expose-gc");
	const fixtureName = readStringOption("--fixture");
	if (!FIXTURES.includes(fixtureName as Fixture)) throw new Error(`Unknown fixture: ${fixtureName}`);
	const fixture = fixtureName as Fixture;
	const width = readIntegerOption("--width", 120);
	const rows = readIntegerOption("--rows", 40);
	const mode = readStringOption("--mode") === "full" ? "full" : "incremental";
	const updates = readIntegerOption("--updates", 20_000);
	const warmup = readIntegerOption("--warmup", 5_000);
	const samplingInterval = readIntegerOption("--sampling-interval", 8_192);
	const metrics = createMetrics();
	let source = "x";
	const markdown = new Markdown(source, 1, 0, THEME, undefined, {
		incrementalRenderCache: mode === "incremental",
	}, metrics);
	let lines = markdown.render(width);
	let updateIndex = 0;
	const update = (): void => {
		source = nextFixtureSource(fixture, updateIndex++, source);
		markdown.setText(source);
		lines = markdown.render(width);
	};
	for (let index = 0; index < warmup; index++) update();
	resetMetrics(metrics);
	let cacheTokenHwm = 0;
	let cacheRenderedLineHwm = 0;
	let cacheSourceCharacterHwm = 0;
	globalThis.gc();
	globalThis.gc();
	const heapBefore = process.memoryUsage().heapUsed;
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
	const inspector = new Session();
	inspector.connect();
	await inspector.post("HeapProfiler.enable");
	await inspector.post("HeapProfiler.startSampling", {
		samplingInterval,
		includeObjectsCollectedByMajorGC: true,
		includeObjectsCollectedByMinorGC: true,
	});
	const batchSize = 100;
	const durations = new Array<number>(Math.ceil(updates / batchSize));
	let completed = 0;
	for (let batch = 0; completed < updates; batch++) {
		const count = Math.min(batchSize, updates - completed);
		const started = performance.now();
		for (let offset = 0; offset < count; offset++) update();
		durations[batch] = (performance.now() - started) / count;
		completed += count;
		if (metrics.cachedTokenCount > cacheTokenHwm) cacheTokenHwm = metrics.cachedTokenCount;
		if (metrics.cachedRenderedLines > cacheRenderedLineHwm) cacheRenderedLineHwm = metrics.cachedRenderedLines;
		if (metrics.cachedSourceCharacters > cacheSourceCharacterHwm) {
			cacheSourceCharacterHwm = metrics.cachedSourceCharacters;
		}
	}
	const stopped = await inspector.post("HeapProfiler.stopSampling");
	await inspector.post("HeapProfiler.disable");
	inspector.disconnect();
	await new Promise<void>((resolve) => setTimeout(resolve, 50));
	gcObserver.disconnect();
	const heapAfter = process.memoryUsage().heapUsed;
	let reference: Markdown | undefined = new Markdown(source, 1, 0, THEME);
	assert.deepEqual(lines, reference.render(width));
	const finalHash = createHash("sha256").update(lines.join("\n")).digest("hex");
	markdown.invalidate();
	reference.invalidate();
	const afterInvalidate = {
		tokens: metrics.cachedTokenCount,
		renderedLines: metrics.cachedRenderedLines,
		sourceCharacters: metrics.cachedSourceCharacters,
	};
	reference = undefined;
	lines = [];
	source = "";
	globalThis.gc();
	globalThis.gc();
	const controlledGcAfter = process.memoryUsage().heapUsed;
	const sampled = allocationSites(stopped.profile.head as SamplingNode);
	const sortedDurations = durations.slice().sort((left, right) => left - right);
	const result: ChildResult = {
		fixture,
		width,
		rows,
		mode,
		cpuP50MsPerUpdate: percentile(sortedDurations, 0.5),
		cpuP95MsPerUpdate: percentile(sortedDurations, 0.95),
		sampledAllocationBytesPerUpdate: sampled.sampledBytes / updates,
		minorGcCount,
		majorGcCount,
		totalGcDurationMs,
		heapBefore,
		heapAfter,
		controlledGcAfter,
		controlledGcHeapDeltaBytes: controlledGcAfter - heapBefore,
		finalHash,
		metrics,
		cacheHwm: {
			tokens: cacheTokenHwm,
			renderedLines: cacheRenderedLineHwm,
			sourceCharacters: cacheSourceCharacterHwm,
		},
		afterInvalidate,
		topAllocationSites: sampled.top,
	};
	process.stdout.write(`${JSON.stringify(result)}\n`);
}

function worktreeFingerprint(): string {
	const hash = createHash("sha256");
	const tracked = spawnSync("git", ["diff", "--binary", "HEAD"], { encoding: "buffer", maxBuffer: 64 * 1024 * 1024 });
	if (tracked.status === 0 && tracked.stdout) hash.update(tracked.stdout);
	const untracked = spawnSync("git", ["ls-files", "--others", "--exclude-standard", "-z"], { encoding: "buffer" });
	if (untracked.status === 0 && untracked.stdout) {
		const paths = untracked.stdout.toString("utf8").split("\0").filter(Boolean).sort();
		for (let index = 0; index < paths.length; index++) {
			const path = paths[index]!;
			hash.update(path);
			hash.update(readFileSync(path));
		}
	}
	return hash.digest("hex");
}

function runOneChild(
	fixture: Fixture,
	width: number,
	rows: number,
	mode: "full" | "incremental",
	updates: number,
	warmup: number,
	samplingInterval: number,
): ChildResult {
	const child = spawnSync(process.execPath, [
		"--expose-gc",
		"--experimental-strip-types",
		import.meta.filename,
		"--child",
		"--fixture", fixture,
		"--width", String(width),
		"--rows", String(rows),
		"--mode", mode,
		"--updates", String(updates),
		"--warmup", String(warmup),
		"--sampling-interval", String(samplingInterval),
	], { cwd: process.cwd(), encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
	if (child.status !== 0) throw new Error(`${fixture}/${width}/${mode} failed (${child.status}):\n${child.stderr || child.stdout}`);
	return JSON.parse(child.stdout) as ChildResult;
}

async function runParent(): Promise<void> {
	const processes = readIntegerOption("--processes", 5);
	const updates = readIntegerOption("--updates", 20_000);
	const warmup = readIntegerOption("--warmup", 5_000);
	const samplingInterval = readIntegerOption("--sampling-interval", 8_192);
	const lifecycleCycles = readIntegerOption("--lifecycle-cycles", 10);
	const lifecycle = runLifecycle(lifecycleCycles);
	const reports: unknown[] = [];
	for (let fixtureIndex = 0; fixtureIndex < FIXTURES.length; fixtureIndex++) {
		const fixture = FIXTURES[fixtureIndex]!;
		for (let widthIndex = 0; widthIndex < WIDTHS.length; widthIndex++) {
			const width = WIDTHS[widthIndex]!;
			const rows = ROWS[widthIndex]!;
			const fullRuns: ChildResult[] = [];
			const incrementalRuns: ChildResult[] = [];
			for (let processIndex = 0; processIndex < processes; processIndex++) {
				fullRuns.push(runOneChild(fixture, width, rows, "full", updates, warmup, samplingInterval));
				incrementalRuns.push(runOneChild(fixture, width, rows, "incremental", updates, warmup, samplingInterval));
			}
			const summarize = (runs: readonly ChildResult[]): unknown => {
				const p50 = runs.map((run) => run.cpuP50MsPerUpdate);
				const p95 = runs.map((run) => run.cpuP95MsPerUpdate);
				const allocation = runs.map((run) => run.sampledAllocationBytesPerUpdate);
				let minorGcCount = 0;
				let majorGcCount = 0;
				let totalGcDurationMs = 0;
				for (let index = 0; index < runs.length; index++) {
					minorGcCount += runs[index]!.minorGcCount;
					majorGcCount += runs[index]!.majorGcCount;
					totalGcDurationMs += runs[index]!.totalGcDurationMs;
				}
				return {
					runs: runs.map((run, processIndex) => ({
						processIndex,
						cpuP50MsPerUpdate: run.cpuP50MsPerUpdate,
						cpuP95MsPerUpdate: run.cpuP95MsPerUpdate,
						sampledAllocationBytesPerUpdate: run.sampledAllocationBytesPerUpdate,
						minorGcCount: run.minorGcCount,
						majorGcCount: run.majorGcCount,
						totalGcDurationMs: run.totalGcDurationMs,
					})),
					aggregate: {
						medianCpuP50MsPerUpdate: median(p50),
						medianCpuP95MsPerUpdate: median(p95),
						cpuP50Cv: coefficientOfVariation(p50),
						cpuP95Cv: coefficientOfVariation(p95),
						medianSampledAllocationBytesPerUpdate: median(allocation),
						minorGcCount,
						majorGcCount,
						totalGcDurationMs,
					},
					structure: runs[0]?.metrics,
					cacheHwm: runs[0]?.cacheHwm,
					afterInvalidate: runs[0]?.afterInvalidate,
					finalHash: runs[0]?.finalHash,
					topAllocationSites: runs[0]?.topAllocationSites,
				};
			};
			reports.push({ fixture, width, rows, full: summarize(fullRuns), incremental: summarize(incrementalRuns) });
		}
	}
	const status = spawnSync("git", ["status", "--porcelain"], { encoding: "utf8" });
	const output = `${JSON.stringify({
		schemaVersion: 1,
		benchmark: "tui-markdown-incremental-wrap",
		commit: currentCommit(),
		worktreeDirty: status.stdout.trim().length > 0,
		candidateWorktreeFingerprint: worktreeFingerprint(),
		node: process.version,
		platform: process.platform,
		arch: process.arch,
		cpu: cpus()[0]?.model ?? "unknown",
		processes,
		updatesPerProcess: updates,
		warmupPerProcess: warmup,
		samplingInterval,
		lifecycle,
		measurementWindow: "Heap sampling, GC observation, and batched CPU timing all cover measured updates only",
		reports,
	}, null, 2)}\n`;
	const outputPath = readStringOption("--output");
	if (outputPath) writeFileSync(outputPath, output, "utf8");
	else process.stdout.write(output);
}

if (process.argv.includes("--child")) await runChild();
else await runParent();
