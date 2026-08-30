import assert from "node:assert/strict";
import test from "node:test";
import { getEncoding } from "js-tiktoken";
import {
	createToolOutputEstimatorCounters,
	estimateToolOutputTokens,
	TOOL_OUTPUT_FALLBACK_ESTIMATOR_ID,
} from "../packages/coding-agent/src/core/tool-output-budget.ts";
import { createToolTokenEstimatorCorpus } from "./fixtures/tool-token-estimator-corpus.ts";

function percentile(sorted: readonly number[], ratio: number): number {
	return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1))] ?? 0;
}

test("fallback handles representative, empty, and malformed model-visible text", () => {
	const cases = ["", "ok", "English words", "中文内容", '{"ok":true}', "const x = 1;", "\u001b[31mred\u001b[0m", "😀👨‍👩‍👧‍👦"];
	for (const text of cases) {
		const estimate = estimateToolOutputTokens([{ type: "text", text }]);
		assert.equal(estimate.estimatorId, TOOL_OUTPUT_FALLBACK_ESTIMATOR_ID);
		assert.equal(estimate.confidence, "conservative-fallback");
		assert.ok(estimate.estimatedTokens >= 0);
	}

	const malformed = `before${String.fromCharCode(0xd83d)}after`;
	const estimate = estimateToolOutputTokens([{ type: "text", text: malformed }]);
	assert.equal(estimate.rawUtf8Bytes, Buffer.byteLength(malformed));
	assert.equal(estimate.modelVisibleUtf8Bytes, Buffer.byteLength("beforeafter"));
});

test("content blocks are scanned without joining and image bodies are not inspected", () => {
	const counters = createToolOutputEstimatorCounters();
	const estimate = estimateToolOutputTokens(
		[
			{ type: "text", text: "first" },
			{ type: "image", data: "sensitive-base64-body", mimeType: "image/png" },
			{ type: "text", text: "second" },
		],
		undefined,
		counters,
	);
	assert.equal(estimate.rawUtf8Bytes, Buffer.byteLength("first\nsecond"));
	assert.equal(counters.charactersScanned, "first\nsecond".length);
	assert.equal(counters.fullStringCopies, 0);
	assert.equal(counters.fullStringSerializations, 0);
	assert.equal(counters.temporaryLineArrays, 0);
});

test("exact provider estimator succeeds and invalid or throwing estimators fall back", () => {
	const exact = estimateToolOutputTokens([{ type: "text", text: "fixture" }], {
		estimatorId: "provider.fixture-v1",
		estimateToolOutputTokens: () => 7,
	});
	assert.equal(exact.estimatedTokens, 7);
	assert.equal(exact.estimatorId, "provider.fixture-v1");
	assert.equal(exact.confidence, "exact");

	for (const brokenEstimator of [() => { throw new Error("unavailable"); }, () => Number.NaN, () => -1]) {
		const fallback = estimateToolOutputTokens([{ type: "text", text: "fixture" }], {
			estimatorId: "provider.broken",
			estimateToolOutputTokens: brokenEstimator,
		});
		assert.equal(fallback.estimatorId, TOOL_OUTPUT_FALLBACK_ESTIMATOR_ID);
		assert.equal(fallback.confidence, "conservative-fallback");
	}
});

test("10 MiB single line uses one bounded scan and no line array or full copy", () => {
	const text = "x".repeat(10 * 1024 * 1024);
	const counters = createToolOutputEstimatorCounters();
	const estimate = estimateToolOutputTokens([{ type: "text", text }], undefined, counters);
	assert.equal(estimate.rawUtf8Bytes, text.length);
	assert.equal(estimate.rawLines, 1);
	assert.equal(counters.charactersScanned, text.length);
	assert.equal(counters.maximumInputCharacters, text.length);
	assert.equal(counters.fullStringCopies, 0);
	assert.equal(counters.temporaryLineArrays, 0);
	assert.equal(counters.promisesCreated, 0);
});

test("fixed reference corpus meets conservative accuracy gates", { timeout: 120_000 }, () => {
	const encoding = getEncoding("cl100k_base");
	try {
		const fixtures = createToolTokenEstimatorCorpus();
		const under: number[] = [];
		const over: number[] = [];
		const categoryUnder = new Map<string, { total: number; count: number }>();
		for (const fixture of fixtures) {
			// Reference tokenizer only: it is a declared dev dependency and never enters production.
			const sanitized = fixture.text.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "");
			const actual = fixture.referenceTokens ?? encoding.encode(sanitized).length;
			const estimated = estimateToolOutputTokens([{ type: "text", text: fixture.text }]).estimatedTokens;
			const underRatio = actual === 0 ? 0 : Math.max(0, (actual - estimated) / actual);
			const overRatio = actual === 0 ? 0 : Math.max(0, (estimated - actual) / actual);
			under.push(underRatio);
			over.push(overRatio);
			const category = categoryUnder.get(fixture.category) ?? { total: 0, count: 0 };
			category.total += underRatio;
			category.count++;
			categoryUnder.set(fixture.category, category);
			assert.ok(underRatio <= 0.1, `${fixture.id}: actual=${actual} estimated=${estimated} under=${underRatio}`);
		}
		under.sort((left, right) => left - right);
		over.sort((left, right) => left - right);
		const averageOver = over.reduce((sum, value) => sum + value, 0) / over.length;
		assert.ok(percentile(under, 0.99) <= 0.1, `p99 underestimation ${percentile(under, 0.99)}`);
		assert.ok(averageOver <= 0.35, `average overestimation ${averageOver}`);
		for (const [category, aggregate] of categoryUnder) {
			assert.ok(aggregate.total / aggregate.count <= 0.1, `${category} systematically underestimates`);
		}
	} finally {
		// js-tiktoken's JavaScript implementation owns no explicit disposable handle.
	}
});
