import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { parseBenchmarkResult, type BenchmarkEnvironment, type BenchmarkResult } from "./benchmark.ts";

const COMPARABLE_ENVIRONMENT_KEYS = [
	"cpu",
	"cpuCores",
	"totalMemoryBytes",
	"terminalColumns",
	"terminalRows",
	"term",
	"kittyImages",
	"exposeGc",
] as const satisfies readonly (keyof BenchmarkEnvironment)[];

export interface BenchmarkComparison {
	name: string;
	fixture: string;
	metrics: Record<string, { baseline: number; candidate: number; changePercent: number | null }>;
}

function requireEqual(label: string, baseline: unknown, candidate: unknown): void {
	if (baseline !== candidate) throw new Error(`${label} differs: ${String(baseline)} vs ${String(candidate)}`);
}

export function compareBenchmarkResults(baseline: BenchmarkResult, candidate: BenchmarkResult): BenchmarkComparison {
	requireEqual("Benchmark name", baseline.name, candidate.name);
	requireEqual("Benchmark fixture", baseline.fixture, candidate.fixture);
	requireEqual("Node version", baseline.node, candidate.node);
	requireEqual("Platform", baseline.platform, candidate.platform);
	requireEqual("Architecture", baseline.arch, candidate.arch);
	requireEqual("Warm-up run count", baseline.warmupRuns, candidate.warmupRuns);
	requireEqual("Measured run count", baseline.measuredRuns, candidate.measuredRuns);
	for (const key of COMPARABLE_ENVIRONMENT_KEYS) {
		requireEqual(`Environment ${key}`, baseline.environment[key], candidate.environment[key]);
	}

	const metrics: BenchmarkComparison["metrics"] = {};
	for (const [name, baselineValue] of Object.entries(baseline.metrics)) {
		const candidateValue = candidate.metrics[name];
		if (candidateValue === undefined) continue;
		metrics[name] = {
			baseline: baselineValue,
			candidate: candidateValue,
			changePercent: baselineValue === 0 ? null : ((candidateValue - baselineValue) / baselineValue) * 100,
		};
	}
	return { name: baseline.name, fixture: baseline.fixture, metrics };
}

function main(): void {
	const [baselinePath, candidatePath] = process.argv.slice(2);
	if (!baselinePath || !candidatePath) {
		console.error("Usage: compare.ts <baseline.json> <candidate.json>");
		process.exitCode = 1;
		return;
	}
	try {
		const baseline = parseBenchmarkResult(readFileSync(baselinePath, "utf8"));
		const candidate = parseBenchmarkResult(readFileSync(candidatePath, "utf8"));
		process.stdout.write(`${JSON.stringify(compareBenchmarkResults(baseline, candidate), null, 2)}\n`);
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	}
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
