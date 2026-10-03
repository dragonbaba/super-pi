import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import type { Api, Model } from "../../packages/ai/src/types.ts";
import { mergeCatalogModels } from "../../packages/coding-agent/src/core/model-catalog-merge.ts";

function model(id: string): Model<Api> {
	return { id, name: id, api: "openai-responses", provider: "fixture", baseUrl: "https://fixture.invalid",
		reasoning: false, input: ["text"], contextWindow: 1000, maxTokens: 100,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
}
// Exact previous algorithm, retained here only as a same-process comparison.
function legacy(baseline: readonly Model<Api>[], dynamic: readonly Model<Api>[]): Model<Api>[] {
	const merged = [...baseline];
	for (const model of dynamic) {
		const index = merged.findIndex(entry => entry.id === model.id);
		if (index >= 0) merged[index] = model;
		else merged.push(model);
	}
	return merged;
}
function ascending(left: number, right: number): number { return left - right; }
const baseline = Array.from({ length: 4000 }, (_, index) => model(`m${index}`));
const dynamic = Array.from({ length: 4000 }, (_, index) => model(`m${index + 2000}`));
assert.deepEqual(mergeCatalogModels(baseline, dynamic), legacy(baseline, dynamic));
for (const [name, merge] of [["previous", legacy], ["indexed", mergeCatalogModels]] as const) {
	for (let iteration = 0; iteration < 5; iteration++) merge(baseline, dynamic);
	const samples: number[] = [];
	for (let iteration = 0; iteration < 20; iteration++) {
		const start = performance.now();
		assert.equal(merge(baseline, dynamic).length, 6000);
		samples.push(performance.now() - start);
	}
	samples.sort(ascending);
	process.stdout.write(JSON.stringify({ name, baseline: baseline.length, dynamic: dynamic.length, samples: samples.length,
		medianMs: samples[10], p95Ms: samples[18], node: process.version, platform: process.platform }) + "\n");
}
