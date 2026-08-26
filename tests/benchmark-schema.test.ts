import assert from "node:assert/strict";
import test from "node:test";
import {
	BENCHMARK_SCHEMA_VERSION,
	parseBenchmarkResult,
	type BenchmarkResult,
} from "../scripts/bench/benchmark.ts";
import { compareBenchmarkResults } from "../scripts/bench/compare.ts";

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
		observations: { fixtureSha256: "abc", bounded: true },
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
	assert.throws(
		() => parseBenchmarkResult(JSON.stringify({ ...sampleResult(), observations: { hash: null } })),
		/observations\.hash/,
	);
	assert.throws(
		() => parseBenchmarkResult(JSON.stringify({ ...sampleResult(), environment: { cpu: "incomplete" } })),
		/environment\.term/,
	);
});

test("benchmark comparison rejects machine, runtime, terminal, and run-option mismatches", () => {
	const baseline = sampleResult();
	const mutations: Array<[string, BenchmarkResult]> = [
		["Node version", { ...sampleResult(), node: "v99.0.0" }],
		["Platform", { ...sampleResult(), platform: process.platform === "linux" ? "win32" : "linux" }],
		["Architecture", { ...sampleResult(), arch: process.arch === "arm64" ? "x64" : "arm64" }],
		["Measured run count", { ...sampleResult(), measuredRuns: 21 }],
		["Environment cpu", { ...sampleResult(), environment: { ...sampleResult().environment, cpu: "other" } }],
		["Environment terminalColumns", {
			...sampleResult(),
			environment: { ...sampleResult().environment, terminalColumns: 80 },
		}],
		["Environment term", { ...sampleResult(), environment: { ...sampleResult().environment, term: "other" } }],
		["Environment exposeGc", {
			...sampleResult(),
			environment: { ...sampleResult().environment, exposeGc: true },
		}],
	];
	for (const [label, candidate] of mutations) {
		assert.throws(() => compareBenchmarkResults(baseline, candidate), new RegExp(label));
	}
	const candidate = sampleResult();
	candidate.commit = "fedcba9876543210";
	candidate.environment.measuredAt = "2026-08-26T00:01:00.000Z";
	assert.equal(compareBenchmarkResults(baseline, candidate).metrics.p50Ms?.changePercent, 0);
});
