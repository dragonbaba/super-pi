import assert from "node:assert/strict";
import test from "node:test";
import {
	BENCHMARK_SCHEMA_VERSION,
	parseBenchmarkResult,
	type BenchmarkResult,
} from "../scripts/bench/benchmark.ts";

function sampleResult(): BenchmarkResult {
	return {
		schemaVersion: BENCHMARK_SCHEMA_VERSION,
		name: "sample",
		commit: "0123456789abcdef",
		node: process.version,
		platform: process.platform,
		arch: process.arch,
		fixture: "fixture-v1",
		warmupRuns: 5,
		measuredRuns: 20,
		metrics: { p50Ms: 1, p95Ms: 2, p99Ms: 3, minMs: 0.5, maxMs: 4 },
		environment: {
			cpu: "test cpu",
			cpuCores: 1,
			totalMemoryBytes: 1024,
			terminalColumns: 120,
			terminalRows: 40,
			term: "test",
			kittyImages: false,
			exposeGc: false,
			measuredAt: "2026-08-26T00:00:00.000Z",
		},
	};
}

test("benchmark schema accepts a complete version 1 result", () => {
	const result = sampleResult();
	assert.deepEqual(parseBenchmarkResult(JSON.stringify(result)), result);
});

test("benchmark schema rejects malformed metrics and schema versions", () => {
	assert.throws(
		() => parseBenchmarkResult(JSON.stringify({ ...sampleResult(), schemaVersion: 2 })),
		/Unsupported benchmark schemaVersion/,
	);
	assert.throws(
		() => parseBenchmarkResult(JSON.stringify({ ...sampleResult(), metrics: { p50Ms: "fast" } })),
		/metrics\.p50Ms/,
	);
});
