import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { cpus } from "node:os";
import { currentCommit, readIntegerOption } from "./benchmark.ts";

type FixtureResult = {
	name: string;
	fullObserverChain: {
		rawUpdates: number;
		coalescedUpdates: number;
		deliveries: number;
		productionSnapshot: boolean;
		productionAgentSessionBridge: boolean;
		productionInteractiveModeHandler: boolean;
	};
	metrics: {
		cpuP50MsPerUpdate: number;
		cpuP95MsPerUpdate: number;
		sampledAllocationBytesPerUpdate: number;
		minorGcCount: number;
		majorGcCount: number;
		totalGcDurationMs: number;
	};
	topAllocationSites: Array<{
		bytes: number;
		functionName: string;
		url: string;
		line: number;
		column: number;
	}>;
};

type ChildResult = {
	commit: string;
	fixtures: Array<{ name: string; results: FixtureResult[] }>;
};

const fixtureNames = ["plain-streaming-text", "append-growing-markdown", "thinking-block"] as const;
const processes = readIntegerOption("--processes", 5);
const updates = readIntegerOption("--updates", 20_000);
const warmup = readIntegerOption("--warmup", 5_000);
const samplingInterval = readIntegerOption("--sampling-interval", 8_192);

function readStringOption(name: string): string | undefined {
	const index = process.argv.indexOf(name);
	return index < 0 ? undefined : process.argv[index + 1];
}

function percentile(sorted: readonly number[], ratio: number): number {
	return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1))] ?? 0;
}

function median(values: readonly number[]): number {
	return percentile([...values].sort((left, right) => left - right), 0.5);
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

function runFixture(fixture: string): FixtureResult {
	const child = spawnSync(
		process.execPath,
		[
			"--expose-gc",
			"--import",
			"tsx",
			"scripts/bench/tui-real-leaf-allocations.ts",
			"--assistant-fixture",
			fixture,
			"--updates",
			String(updates),
			"--warmup",
			String(warmup),
			"--structural-updates",
			"100000",
			"--sampling-interval",
			String(samplingInterval),
		],
		{ cwd: process.cwd(), encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
	);
	if (child.status !== 0) {
		throw new Error(`Fixture ${fixture} failed (${child.status}):\n${child.stderr || child.stdout}`);
	}
	const parsed = JSON.parse(child.stdout) as ChildResult;
	const group = parsed.fixtures.find((candidate) => candidate.name === "production-assistant-markdown-stream");
	const result = group?.results.find((candidate) => candidate.name === fixture);
	if (!result) throw new Error(`Fixture ${fixture} did not return a production assistant result`);
	return result;
}

const fixtureReports: unknown[] = [];
for (const fixture of fixtureNames) {
	const runs: FixtureResult[] = [];
	for (let processIndex = 0; processIndex < processes; processIndex++) runs.push(runFixture(fixture));
	const p50 = runs.map((run) => run.metrics.cpuP50MsPerUpdate);
	const p95 = runs.map((run) => run.metrics.cpuP95MsPerUpdate);
	const sampled = runs.map((run) => run.metrics.sampledAllocationBytesPerUpdate);
	let minorGcCount = 0;
	let majorGcCount = 0;
	let totalGcDurationMs = 0;
	const sites = new Map<string, FixtureResult["topAllocationSites"][number]>();
	for (const run of runs) {
		minorGcCount += run.metrics.minorGcCount;
		majorGcCount += run.metrics.majorGcCount;
		totalGcDurationMs += run.metrics.totalGcDurationMs;
		for (const site of run.topAllocationSites) {
			const key = `${site.url}\0${site.line}\0${site.column}\0${site.functionName}`;
			const existing = sites.get(key);
			if (existing) existing.bytes += site.bytes;
			else sites.set(key, { ...site });
		}
	}
	fixtureReports.push({
		name: fixture,
		fullObserverChain: runs[0]?.fullObserverChain,
		runs: runs.map((run, processIndex) => ({
			processIndex,
			cpuP50MsPerUpdate: run.metrics.cpuP50MsPerUpdate,
			cpuP95MsPerUpdate: run.metrics.cpuP95MsPerUpdate,
			sampledAllocationBytesPerUpdate: run.metrics.sampledAllocationBytesPerUpdate,
			minorGcCount: run.metrics.minorGcCount,
			majorGcCount: run.metrics.majorGcCount,
			totalGcDurationMs: run.metrics.totalGcDurationMs,
		})),
		aggregate: {
			medianCpuP50MsPerUpdate: median(p50),
			medianCpuP95MsPerUpdate: median(p95),
			cpuP50Cv: coefficientOfVariation(p50),
			cpuP95Cv: coefficientOfVariation(p95),
			medianSampledAllocationBytesPerUpdate: median(sampled),
			minorGcCount,
			majorGcCount,
			totalGcDurationMs,
		},
		topAllocationSites: [...sites.values()].sort((left, right) => right.bytes - left.bytes).slice(0, 20),
	});
}

const output = `${JSON.stringify({
	schemaVersion: 1,
	benchmark: "tui-assistant-leaf-multiprocess",
	commit: currentCommit(),
	worktreeDirty: spawnSync("git", ["status", "--porcelain"], { encoding: "utf8" }).stdout.trim().length > 0,
	node: process.version,
	platform: process.platform,
	arch: process.arch,
	cpu: cpus()[0]?.model ?? "unknown",
	processes,
	updatesPerProcess: updates,
	warmupPerProcess: warmup,
	samplingInterval,
	componentInstrumentation: false,
	fixtures: fixtureReports,
}, null, 2)}\n`;
const outputPath = readStringOption("--output");
if (outputPath) writeFileSync(outputPath, output, "utf8");
else process.stdout.write(output);
