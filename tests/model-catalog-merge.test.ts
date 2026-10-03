import assert from "node:assert/strict";
import test from "node:test";
import type { Api, Model } from "../packages/ai/src/types.ts";
import { mergeCatalogModels } from "../packages/coding-agent/src/core/model-catalog-merge.ts";
import { withRemoteCatalog } from "../packages/coding-agent/src/core/remote-catalog-provider.ts";

function model(id: string, name = id): Model<Api> {
	return { id, name, api: "openai-responses", provider: "fixture", baseUrl: "https://fixture.invalid",
		reasoning: false, input: ["text"], contextWindow: 1000, maxTokens: 100,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
}

test("catalog merge preserves order, duplicate precedence, identity and caller arrays", () => {
	const baseline = Object.freeze([model("a"), model("a", "second a"), model("b")]);
	const dynamic = Object.freeze([model("a", "old replacement"), model("c"), model("a", "new replacement"), model("c", "last c")]);
	const result = mergeCatalogModels(baseline, dynamic);
	assert.deepEqual(result, [dynamic[2], baseline[1], baseline[2], dynamic[3]]);
	assert.equal(result[0], dynamic[2]);
	assert.equal(baseline[0]!.name, "a");
	const unchanged = mergeCatalogModels(baseline, []);
	assert.notEqual(unchanged, baseline);
	assert.deepEqual(unchanged, baseline);
	assert.deepEqual(mergeCatalogModels([], []), []);
});

test("catalog merge ID lookup work is linear, including newly appended IDs", () => {
	let idReads = 0;
	function counted(id: string): Model<Api> {
		const value = model(id);
		Object.defineProperty(value, "id", { get() { idReads++; return id; } });
		return value;
	}
	const baseline = Array.from({ length: 4000 }, (_, index) => counted(`m${index}`));
	const dynamic = Array.from({ length: 4000 }, (_, index) => counted(`m${index + 2000}`));
	const result = mergeCatalogModels(baseline, dynamic);
	assert.equal(result.length, 6000);
	assert.equal(idReads, baseline.length + dynamic.length);
});

test("remote catalog getModels reuses the cached merged array", () => {
	let baselineReads = 0;
	const provider = withRemoteCatalog({ id: "fixture", name: "Fixture", auth: {},
		getModels() { baselineReads++; return [model("a")]; },
		stream() { throw new Error("not used"); }, streamSimple() { throw new Error("not used"); } });
	const first = provider.getModels();
	for (let index = 0; index < 100; index++) assert.equal(provider.getModels(), first);
	assert.equal(baselineReads, 1);
});
