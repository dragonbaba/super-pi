import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { parseBenchmarkResult } from "../scripts/bench/benchmark.ts";

test("retained lifecycle benchmark clears every sidecar and cached-line counter", () => {
	const result = spawnSync(
		process.execPath,
		[
			"--expose-gc",
			"--experimental-strip-types",
			"./scripts/bench/tui-retained-lifecycle.ts",
			"--items",
			"20",
			"--cycles",
			"2",
			"--warmup",
			"1",
			"--runs",
			"1",
		],
		{ cwd: process.cwd(), encoding: "utf8" },
	);
	assert.equal(result.status, 0, result.stderr);
	const benchmark = parseBenchmarkResult(result.stdout);
	assert.equal(benchmark.environment.exposeGc, true);
	assert.equal(benchmark.metrics.retainedItems, 20);
	assert.equal(benchmark.metrics.cachedItems, 20);
	assert.ok(benchmark.metrics.cachedLines >= 20);
	assert.ok(benchmark.metrics.estimatedCachedBytes > 0);
	assert.equal(benchmark.metrics.indexedItems, 20);
	assert.equal(benchmark.metrics.heightBlocks, 1);
	assert.equal(benchmark.metrics.releasedChildren, 20);
	assert.equal(benchmark.metrics.releasedRetainedItems, 20);
	assert.equal(benchmark.metrics.releasedRetainedComponents, 20);
	assert.equal(benchmark.metrics.releasedCachedItems, 0);
	assert.equal(benchmark.metrics.releasedCachedLines, 0);
	assert.equal(benchmark.metrics.releasedEstimatedCachedBytes, 0);
	assert.equal(benchmark.metrics.releasedViewportRecords, 0);
	assert.equal(benchmark.metrics.releasedViewportRecordComponentReferences, 0);
	assert.equal(benchmark.metrics.releasedViewportRecordRetainedItemReferences, 0);
	assert.equal(benchmark.metrics.releasedDirtyViewportRecords, 0);
	assert.equal(benchmark.metrics.releasedPreparedViewportRecords, 0);
	assert.equal(benchmark.metrics.releasedViewportBlockHeights, 0);
	assert.equal(benchmark.metrics.releasedPreparedLineReferences, 0);
	assert.equal(benchmark.metrics.releasedKittyLineReferences, 0);
	assert.equal(benchmark.metrics.rebuiltViewportRecords, 20);
	assert.equal(benchmark.metrics.rebuiltViewportRecordComponentReferences, 20);
	assert.equal(benchmark.metrics.rereleasedViewportRecords, 0);
	assert.equal(benchmark.metrics.clearedRetainedItems, 0);
	assert.equal(benchmark.metrics.clearedCachedItems, 0);
	assert.equal(benchmark.metrics.clearedCachedLines, 0);
	assert.equal(benchmark.metrics.clearedEstimatedCachedBytes, 0);
	assert.equal(benchmark.metrics.clearedIndexedItems, 0);
	assert.equal(benchmark.metrics.clearedHeightBlocks, 0);
});
