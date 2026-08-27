import { spawnSync } from "node:child_process";
import { cpus, totalmem } from "node:os";
import { performance } from "node:perf_hooks";

export const BENCHMARK_SCHEMA_VERSION = 1 as const;

export interface BenchmarkEnvironment {
	cpu: string;
	cpuCores: number;
	totalMemoryBytes: number;
	terminalColumns: number;
	terminalRows: number;
	term: string;
	kittyImages: boolean;
	exposeGc: boolean;
	measuredAt: string;
}

export interface BenchmarkResult {
	schemaVersion: typeof BENCHMARK_SCHEMA_VERSION;
	name: string;
	commit: string;
	node: string;
	platform: NodeJS.Platform;
	arch: string;
	fixture: string;
	warmupRuns: number;
	measuredRuns: number;
	metrics: Record<string, number>;
	observations?: Record<string, string | number | boolean>;
	environment: BenchmarkEnvironment;
}

export interface BenchmarkOptions {
	name: string;
	fixture: string;
	run: () => void | Record<string, number> | Promise<void | Record<string, number>>;
	observations?: () => Record<string, string | number | boolean>;
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
	return value as Record<string, unknown>;
}

export function parseBenchmarkResult(json: string): BenchmarkResult {
	const result = requireRecord(JSON.parse(json), "benchmark result");
	if (result.schemaVersion !== BENCHMARK_SCHEMA_VERSION) {
		throw new Error(`Unsupported benchmark schemaVersion: ${String(result.schemaVersion)}`);
	}
	for (const key of ["name", "commit", "node", "platform", "arch", "fixture"] as const) {
		if (typeof result[key] !== "string" || result[key].length === 0) throw new Error(`${key} must be a non-empty string`);
	}
	for (const key of ["warmupRuns", "measuredRuns"] as const) {
		if (!Number.isInteger(result[key]) || (result[key] as number) < 0) throw new Error(`${key} must be a non-negative integer`);
	}
	const metrics = requireRecord(result.metrics, "metrics");
	for (const [key, value] of Object.entries(metrics)) {
		if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`metrics.${key} must be a finite number`);
	}
	if (result.observations !== undefined) {
		const observations = requireRecord(result.observations, "observations");
		for (const [key, value] of Object.entries(observations)) {
			if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") {
				throw new Error(`observations.${key} must be a string, number, or boolean`);
			}
			if (typeof value === "number" && !Number.isFinite(value)) {
				throw new Error(`observations.${key} must be finite`);
			}
		}
	}
	const benchmarkEnvironment = requireRecord(result.environment, "environment");
	for (const key of ["cpu", "term", "measuredAt"] as const) {
		if (typeof benchmarkEnvironment[key] !== "string") throw new Error(`environment.${key} must be a string`);
	}
	for (const key of ["cpuCores", "totalMemoryBytes", "terminalColumns", "terminalRows"] as const) {
		if (typeof benchmarkEnvironment[key] !== "number" || !Number.isFinite(benchmarkEnvironment[key])) {
			throw new Error(`environment.${key} must be a finite number`);
		}
	}
	for (const key of ["kittyImages", "exposeGc"] as const) {
		if (typeof benchmarkEnvironment[key] !== "boolean") throw new Error(`environment.${key} must be a boolean`);
	}
	return result as unknown as BenchmarkResult;
}

export function readIntegerOption(name: string, fallback: number, argv = process.argv.slice(2)): number {
	const index = argv.indexOf(name);
	if (index === -1) return fallback;
	const parsed = Number.parseInt(argv[index + 1] ?? "", 10);
	if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer`);
	return parsed;
}

function percentile(sorted: readonly number[], ratio: number): number {
	const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1));
	return sorted[index] ?? 0;
}

export function currentCommit(): string {
	const result = spawnSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" });
	return result.status === 0 ? result.stdout.trim() : "unknown";
}

function environment(): BenchmarkEnvironment {
	const cpuList = cpus();
	return {
		cpu: cpuList[0]?.model ?? "unknown",
		cpuCores: cpuList.length,
		totalMemoryBytes: totalmem(),
		terminalColumns: process.stdout.columns ?? 0,
		terminalRows: process.stdout.rows ?? 0,
		term: process.env.TERM ?? "",
		kittyImages: process.env.TERM === "xterm-kitty" || process.env.KITTY_WINDOW_ID !== undefined,
		exposeGc: typeof globalThis.gc === "function",
		measuredAt: new Date().toISOString(),
	};
}

export async function runBenchmark(options: BenchmarkOptions): Promise<BenchmarkResult> {
	const warmupRuns = readIntegerOption("--warmup", 5);
	const measuredRuns = readIntegerOption("--runs", 20);
	for (let index = 0; index < warmupRuns; index++) await options.run();

	const durations: number[] = [];
	let peakHeapBytes = process.memoryUsage().heapUsed;
	let finalMetrics: Record<string, number> = {};
	for (let index = 0; index < measuredRuns; index++) {
		const started = performance.now();
		const runMetrics = await options.run();
		durations.push(performance.now() - started);
		if (runMetrics) finalMetrics = runMetrics;
		peakHeapBytes = Math.max(peakHeapBytes, process.memoryUsage().heapUsed);
	}
	const sorted = durations.slice().sort((left, right) => left - right);
	const mean = durations.reduce((sum, value) => sum + value, 0) / durations.length;
	const variance = durations.reduce((sum, value) => sum + (value - mean) ** 2, 0) / durations.length;
	const metrics: Record<string, number> = {
		minMs: sorted[0] ?? 0,
		p50Ms: percentile(sorted, 0.5),
		p95Ms: percentile(sorted, 0.95),
		p99Ms: percentile(sorted, 0.99),
		maxMs: sorted[sorted.length - 1] ?? 0,
		meanMs: mean,
		coefficientOfVariation: mean === 0 ? 0 : Math.sqrt(variance) / mean,
		peakHeapBytes,
		finalHeapBytes: process.memoryUsage().heapUsed,
		...finalMetrics,
	};

	return {
		schemaVersion: BENCHMARK_SCHEMA_VERSION,
		name: options.name,
		commit: currentCommit(),
		node: process.version,
		platform: process.platform,
		arch: process.arch,
		fixture: options.fixture,
		warmupRuns,
		measuredRuns,
		metrics,
		...(options.observations ? { observations: options.observations() } : {}),
		environment: environment(),
	};
}

export async function runBenchmarkMain(options: BenchmarkOptions): Promise<void> {
	try {
		const result = await runBenchmark(options);
		process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
	} catch (error) {
		console.error(error instanceof Error ? error.stack ?? error.message : String(error));
		process.exitCode = 1;
	}
}
