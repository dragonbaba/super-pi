import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

interface WorkerResult {
	mode: "baseline" | "absent" | "disabled";
	commit: string;
	worktreeStatus: string;
	node: string;
	platform: string;
	arch: string;
	warmupRuns: number;
	measuredRuns: number;
	resultsPerRun: number;
	heapProfilerSamplingIntervalBytes: number;
	cpuP50MsPerResult: number;
	cpuP95MsPerResult: number;
	sampledBytesPerResult: number;
	listenerCallsPerResult: number;
	persistedMessagesPerResult: number;
	presentationCountersPerResult?: Record<string, number>;
}

const ROUNDS = 5;
const workerPath = fileURLToPath(new URL("./tool-result-presentation-baseline-worker.ts", import.meta.url));
const candidateRoot = process.cwd();
const baselineRoot = process.argv[2];
if (!baselineRoot) throw new Error("usage: baseline-ab <baseline-worktree>");
const orders: Array<Array<WorkerResult["mode"]>> = [
	["baseline", "absent", "disabled"],
	["disabled", "baseline", "absent"],
	["absent", "disabled", "baseline"],
];
const results: Record<WorkerResult["mode"], WorkerResult[]> = {
	baseline: [],
	absent: [],
	disabled: [],
};

function runWorker(mode: WorkerResult["mode"]): WorkerResult {
	const repoRoot = mode === "baseline" ? baselineRoot! : candidateRoot;
	const child = spawnSync(process.execPath, [
		"--expose-gc",
		"--experimental-strip-types",
		workerPath,
		repoRoot,
		mode,
	], {
		cwd: repoRoot,
		encoding: "utf8",
		maxBuffer: 16 * 1024 * 1024,
	});
	if (child.status !== 0) {
		throw new Error(`worker ${mode} failed (${child.status}): ${child.stderr || child.stdout}`);
	}
	return JSON.parse(child.stdout) as WorkerResult;
}

function median(values: readonly number[]): number {
	const sorted = [...values].sort((left, right) => left - right);
	return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

function summarize(mode: WorkerResult["mode"]): Record<string, unknown> {
	const modeResults = results[mode];
	return {
		mode,
		commit: modeResults[0]?.commit,
		worktreeStatuses: modeResults.map((result) => result.worktreeStatus),
		cpuP50MedianMsPerResult: median(modeResults.map((result) => result.cpuP50MsPerResult)),
		cpuP95MedianMsPerResult: median(modeResults.map((result) => result.cpuP95MsPerResult)),
		sampledBytesMedianPerResult: median(modeResults.map((result) => result.sampledBytesPerResult)),
		listenerCallsMedianPerResult: median(modeResults.map((result) => result.listenerCallsPerResult)),
		persistedMessagesMedianPerResult: median(modeResults.map((result) => result.persistedMessagesPerResult)),
		presentationCountersPerResult: modeResults[0]?.presentationCountersPerResult,
		runs: modeResults.map((result) => ({
			cpuP50MsPerResult: result.cpuP50MsPerResult,
			cpuP95MsPerResult: result.cpuP95MsPerResult,
			sampledBytesPerResult: result.sampledBytesPerResult,
		})),
	};
}

for (let round = 0; round < ROUNDS; round++) {
	for (const mode of orders[round % orders.length]!) results[mode].push(runWorker(mode));
}
const baselineP50 = median(results.baseline.map((result) => result.cpuP50MsPerResult));
const baselineP95 = median(results.baseline.map((result) => result.cpuP95MsPerResult));
const comparison = function comparison(mode: "absent" | "disabled"): Record<string, number> {
	const candidateP50 = median(results[mode].map((result) => result.cpuP50MsPerResult));
	const candidateP95 = median(results[mode].map((result) => result.cpuP95MsPerResult));
	return {
		p50RegressionPercent: ((candidateP50 / baselineP50) - 1) * 100,
		p95RegressionPercent: ((candidateP95 / baselineP95) - 1) * 100,
	};
};
const first = results.baseline[0]!;
process.stdout.write(`${JSON.stringify({
	schemaVersion: 1,
	benchmark: "tool-result-presentation-default-off-ab",
	rounds: ROUNDS,
	interleavedOrders: orders,
	node: first.node,
	platform: first.platform,
	arch: first.arch,
	warmupRunsPerProcess: first.warmupRuns,
	measuredRunsPerProcess: first.measuredRuns,
	resultsPerRun: first.resultsPerRun,
	heapProfilerSamplingIntervalBytes: first.heapProfilerSamplingIntervalBytes,
	baseline: summarize("baseline"),
	absent: summarize("absent"),
	disabled: summarize("disabled"),
	comparisons: {
		absentVsBaseline: comparison("absent"),
		disabledVsBaseline: comparison("disabled"),
	},
}, null, 2)}\n`);
