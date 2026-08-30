import { spawnSync } from "node:child_process";
import { Session } from "node:inspector/promises";
import { performance } from "node:perf_hooks";
import {
	createToolOutputEstimatorCounters,
	estimateToolOutputTokens,
} from "../../packages/coding-agent/src/core/tool-output-budget.ts";

interface BenchmarkFixture {
	id: string;
	text: string;
	bytes: number;
}

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
}

const MEBIBYTE = 1024 * 1024;
const WARMUP_RUNS = 5;
const MEASURED_RUNS = 20;

function exactSize(pattern: string, bytes: number): string {
	return pattern.repeat(Math.ceil(bytes / Buffer.byteLength(pattern))).slice(0, bytes);
}

function fixture(id: string, text: string): BenchmarkFixture {
	return { id, text, bytes: Buffer.byteLength(text) };
}

const fixtures: BenchmarkFixture[] = [
	fixture("tiny", "ok"),
	fixture("64KiB-english", exactSize("A deterministic English fixture measures conservative token estimation throughput.\n", 64 * 1024)),
	fixture("1MiB-logs", exactSize("2026-08-30T09:14:22.481Z ERROR worker=fixture code=E_RETRY attempt=3\n", MEBIBYTE)),
	fixture("10MiB-single-line", "x".repeat(10 * MEBIBYTE)),
	fixture("english", exactSize("Provider-neutral token estimates should preserve enough safety headroom. ", 64 * 1024)),
	fixture("chinese", exactSize("固定中文输出用于验证估算性能与保守性。", 64 * 1024)),
	fixture("json", exactSize('{"level":"error","fixture":true,"count":42,"items":[1,2,3]}', 64 * 1024)),
	fixture("code", exactSize("const value = rows.map((row) => ({ ...row, ready: true }));\n", 64 * 1024)),
	fixture("ansi", exactSize("\u001b[31mERROR\u001b[0m fixture failed; \u001b[33mretrying\u001b[0m\n", 64 * 1024)),
	fixture("emoji", exactSize("😀 🚀 🧪 ✅ 👨‍👩‍👧‍👦\n", 64 * 1024)),
	fixture("repeated-errors", exactSize("ERROR fixture worker failed code=E_RETRY attempt=3\n", 64 * 1024)),
];

function percentile(sorted: readonly number[], ratio: number): number {
	return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1))] ?? 0;
}

function git(args: string[]): string {
	const result = spawnSync("git", args, { encoding: "utf8" });
	return result.status === 0 ? result.stdout.trim() : "unknown";
}

function allocationSites(head: SamplingNode): { sampledBytes: number; top: AllocationSite[] } {
	const sites = new Map<string, AllocationSite>();
	const pending = [head];
	let sampledBytes = 0;
	while (pending.length > 0) {
		const node = pending.pop()!;
		if (node.selfSize > 0) {
			sampledBytes += node.selfSize;
			const frame = node.callFrame;
			const key = `${frame.url}\u0000${frame.lineNumber}\u0000${frame.functionName}`;
			const current = sites.get(key);
			if (current) current.bytes += node.selfSize;
			else sites.set(key, {
				bytes: node.selfSize,
				functionName: frame.functionName || "(anonymous)",
				url: frame.url,
				line: frame.lineNumber + 1,
			});
		}
		if (node.children) for (const child of node.children) pending.push(child);
	}
	return { sampledBytes, top: [...sites.values()].sort((left, right) => right.bytes - left.bytes).slice(0, 20) };
}

function slope(values: readonly number[]): number {
	const count = values.length;
	const meanX = (count - 1) / 2;
	const meanY = values.reduce((sum, value) => sum + value, 0) / count;
	let numerator = 0;
	let denominator = 0;
	for (let index = 0; index < count; index++) {
		const dx = index - meanX;
		numerator += dx * (values[index]! - meanY);
		denominator += dx * dx;
	}
	return denominator === 0 ? 0 : numerator / denominator;
}

if (typeof globalThis.gc !== "function") throw new Error("bench:tool-token-estimator requires --expose-gc");

const counters = createToolOutputEstimatorCounters();
for (const value of fixtures) {
	for (let run = 0; run < WARMUP_RUNS; run++) {
		estimateToolOutputTokens([{ type: "text", text: value.text }], undefined, counters);
	}
}

globalThis.gc();
globalThis.gc();
const controlledGcBeforeHeapBytes = process.memoryUsage().heapUsed;
const inspector = new Session();
inspector.connect();
await inspector.post("HeapProfiler.enable");
await inspector.post("HeapProfiler.startSampling", {
	samplingInterval: 1024,
	includeObjectsCollectedByMajorGC: true,
	includeObjectsCollectedByMinorGC: true,
});

const fixtureResults = [];
let measuredInputBytes = 0;
let measuredCalls = 0;
let measuredDurationMs = 0;
for (const value of fixtures) {
	const durations = new Array<number>(MEASURED_RUNS);
	for (let run = 0; run < MEASURED_RUNS; run++) {
		const started = performance.now();
		estimateToolOutputTokens([{ type: "text", text: value.text }], undefined, counters);
		durations[run] = performance.now() - started;
	}
	durations.sort((left, right) => left - right);
	const totalMs = durations.reduce((sum, duration) => sum + duration, 0);
	measuredInputBytes += value.bytes * MEASURED_RUNS;
	measuredCalls += MEASURED_RUNS;
	measuredDurationMs += totalMs;
	fixtureResults.push({
		fixture: value.id,
		inputBytes: value.bytes,
		cpuP50Ms: percentile(durations, 0.5),
		cpuP95Ms: percentile(durations, 0.95),
		throughputMiBPerSecond: value.bytes === 0 || totalMs === 0
			? 0
			: (value.bytes * MEASURED_RUNS) / MEBIBYTE / (totalMs / 1000),
	});
}

const stopped = await inspector.post("HeapProfiler.stopSampling");
await inspector.post("HeapProfiler.disable");
inspector.disconnect();
const sampled = allocationSites(stopped.profile.head as SamplingNode);
const heapBeforeFinalGcBytes = process.memoryUsage().heapUsed;
globalThis.gc();
globalThis.gc();
const controlledGcAfterHeapBytes = process.memoryUsage().heapUsed;

const controlledGcSamples: number[] = [];
for (let cycle = 0; cycle < 5; cycle++) {
	for (const value of fixtures) estimateToolOutputTokens([{ type: "text", text: value.text }], undefined, counters);
	globalThis.gc();
	globalThis.gc();
	controlledGcSamples.push(process.memoryUsage().heapUsed);
}

process.stdout.write(`${JSON.stringify({
	schemaVersion: 1,
	benchmark: "tool-token-estimator",
	commit: git(["rev-parse", "HEAD"]),
	branch: git(["branch", "--show-current"]),
	worktree: git(["rev-parse", "--show-toplevel"]),
	worktreeStatus: git(["status", "--short"]),
	node: process.version,
	platform: process.platform,
	arch: process.arch,
	warmupRuns: WARMUP_RUNS,
	measuredRuns: MEASURED_RUNS,
	fixtureResults,
	metrics: {
		measuredCalls,
		measuredInputBytes,
		measuredDurationMs,
		throughputMiBPerSecond: measuredInputBytes / MEBIBYTE / (measuredDurationMs / 1000),
		sampledAllocationBytes: sampled.sampledBytes,
		sampledBytesPerInput: sampled.sampledBytes / measuredCalls,
		sampledBytesPerMiB: sampled.sampledBytes / (measuredInputBytes / MEBIBYTE),
		controlledGcBeforeHeapBytes,
		heapBeforeFinalGcBytes,
		controlledGcAfterHeapBytes,
		controlledGcHeapDeltaBytes: controlledGcAfterHeapBytes - controlledGcBeforeHeapBytes,
		controlledGcSamples,
		controlledGcSlopeBytesPerCycle: slope(controlledGcSamples),
		...counters,
	},
	topAllocationSites: sampled.top,
}, null, 2)}\n`);
