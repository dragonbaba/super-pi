import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { parseBenchmarkResult } from "../scripts/bench/benchmark.ts";

function run(mode: "cold" | "warm") {
	const result = spawnSync(process.execPath, [
		"--experimental-strip-types",
		"scripts/bench/model-runtime-startup.ts",
		"--mode",
		mode,
		"--warmup",
		"1",
		"--runs",
		"1",
	], { cwd: process.cwd(), encoding: "utf8", windowsHide: true });
	assert.equal(result.status, 0, result.stderr);
	return parseBenchmarkResult(result.stdout);
}

test("model runtime benchmark separates child-process cold startup from warm construction", () => {
	const cold = run("cold");
	const warm = run("warm");
	assert.match(cold.fixture, /:cold:/u);
	assert.match(warm.fixture, /:warm:/u);
	assert.equal(cold.observations?.processIsolation, "child-per-sample");
	assert.equal(warm.observations?.processIsolation, "same-process");
	assert.equal(cold.metrics.modelCount, cold.metrics.profiledModelCount);
	assert.equal(warm.metrics.modelCount, warm.metrics.profiledModelCount);
});

test("stored catalog restore benchmark validates current provider profiling", () => {
	const result = spawnSync(process.execPath, [
		"--experimental-strip-types",
		"scripts/bench/model-catalog-restore.ts",
		"--warmup",
		"1",
		"--runs",
		"1",
	], { cwd: process.cwd(), encoding: "utf8", windowsHide: true });
	assert.equal(result.status, 0, result.stderr);
	const benchmark = parseBenchmarkResult(result.stdout);
	assert.equal(benchmark.name, "model-catalog-restore");
	assert.equal(benchmark.observations?.network, false);
	assert.equal(benchmark.observations?.reasoningMode, "levels");
	assert.equal(benchmark.observations?.strictToolSchema, true);
	assert.equal(benchmark.metrics.restoredModelCount, 1);
	assert.equal(benchmark.metrics.modelCount, benchmark.metrics.profiledModelCount);
});
