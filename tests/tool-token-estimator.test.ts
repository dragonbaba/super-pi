import assert from "node:assert/strict";
import test from "node:test";
import { getEncoding } from "js-tiktoken";
import {
	createToolOutputEstimatorCounters,
	estimateToolOutputTokens,
	inspectToolOutputAsciiRunForTests,
	TOOL_OUTPUT_EXACT_ESTIMATOR_ID,
	TOOL_OUTPUT_FALLBACK_ESTIMATOR_ID,
} from "../packages/coding-agent/src/core/tool-output-budget.ts";
import { createToolTokenEstimatorCorpus } from "./fixtures/tool-token-estimator-corpus.ts";

const PHASE5A_V2_FIXTURE_IDS = [
	"empty", "tiny", "english-prose-short", "english-prose-repeated", "english-log", "chinese", "mixed",
	"json-pretty", "json-minified", "typescript", "javascript", "python", "shell", "stack-trace",
	"repeated-errors", "ansi", "emoji", "family-emoji", "combining", "urls", "uuid-hash", "base64-like",
	"long-word-lower", "long-word-mixed", "random-lowercase-12", "random-lowercase-64",
	"random-lowercase-256", "random-uppercase-64", "random-mixed-case-128", "camel-case-identifiers",
	"alphabetic-api-key-like", "random-punctuation-256", "rare-han", "cjk-extension", "hiragana-katakana",
	"hangul", "mixed-cjk-ascii-identifiers", "malformed-high", "malformed-low", "malformed-boundary",
	"one-mib-output", "ten-mib-single-line",
] as const;

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
	assert.equal(counters.scanStateObjectsCreated, 1);
	assert.equal(counters.estimateObjectsCreated, 1);
});

test("exact provider estimator succeeds and invalid or throwing estimators fall back", () => {
	const exact = estimateToolOutputTokens([{ type: "text", text: "fixture" }], {
		estimateToolOutputTokens: () => 7,
	});
	assert.equal(exact.estimatedTokens, 7);
	assert.equal(exact.estimatorId, TOOL_OUTPUT_EXACT_ESTIMATOR_ID);
	assert.equal(exact.confidence, "exact");

	for (const brokenEstimator of [() => { throw new Error("unavailable"); }, () => Number.NaN, () => -1]) {
		const fallback = estimateToolOutputTokens([{ type: "text", text: "fixture" }], {
			estimateToolOutputTokens: brokenEstimator,
		});
		assert.equal(fallback.estimatorId, TOOL_OUTPUT_FALLBACK_ESTIMATOR_ID);
		assert.equal(fallback.confidence, "conservative-fallback");
	}
});

test("a rejected thenable from the synchronous exact boundary is isolated", async () => {
	let unhandledRejections = 0;
	const onUnhandledRejection = (): void => { unhandledRejections++; };
	process.on("unhandledRejection", onUnhandledRejection);
	try {
		const estimate = estimateToolOutputTokens([{ type: "text", text: "fixture" }], {
			estimateToolOutputTokens: (() => Promise.reject(new Error("invalid exact estimator"))) as never,
		});
		assert.equal(estimate.confidence, "conservative-fallback");
		await new Promise<void>((resolve) => { setImmediate(resolve); });
		assert.equal(unhandledRejections, 0);
	} finally {
		process.off("unhandledRejection", onUnhandledRejection);
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
	assert.equal(counters.scanStateObjectsCreated, 1);
	assert.equal(counters.estimateObjectsCreated, 1);
});

test("letter and printable-symbol masks include the first character without collisions", () => {
	const letters = inspectToolOutputAsciiRunForTests("aBbCc");
	assert.equal(letters.distinctLetters, 3);
	assert.equal(letters.letterMask, 0b111);

	const symbols = inspectToolOutputAsciiRunForTests(";[{<\\|=]}>^~?_@`");
	assert.equal(symbols.distinctSymbols, 16);
	assert.equal(symbols.symbolMask >>> 0, 0xffff_0000);
});

test("threshold corpus retains v2 and locks every seed/cardinality boundary", () => {
	const fixtures = createToolTokenEstimatorCorpus();
	const byId = new Map(fixtures.map((fixture) => [fixture.id, fixture]));
	assert.equal(fixtures.length, 285);
	assert.equal(PHASE5A_V2_FIXTURE_IDS.length, 42);
	for (const id of PHASE5A_V2_FIXTURE_IDS) assert.ok(byId.has(id), `missing retained fixture ${id}`);

	for (const [length, cardinalities] of [
		[8, [6, 8]],
		[10, [8, 10]],
		[11, [8, 10, 11]],
		[12, [8, 10, 12]],
		[15, [8, 12, 15]],
		[16, [12, 14, 16]],
		[17, [8, 12, 16, 17]],
		[18, [8, 12, 16, 18]],
		[64, [16, 19, 20, 26]],
		[256, [16, 19, 20, 26]],
	] as const) {
		for (const cardinality of cardinalities) {
			for (let seed = 1; seed <= 4; seed++) {
				const fixture = byId.get(`threshold-lower-l${length}-c${cardinality}-s${seed}`)!;
				assert.equal(fixture.text.length, length);
				assert.equal(new Set(fixture.text).size, cardinality);
			}
		}
	}
	for (const [length, cardinalities] of [
		[11, [8, 10, 11]],
		[16, [12, 14, 16]],
		[17, [8, 12, 16, 17]],
		[64, [16, 19, 20]],
	] as const) {
		for (const cardinality of cardinalities) {
			for (let seed = 1; seed <= 4; seed++) {
				const upper = byId.get(`threshold-upper-l${length}-c${cardinality}-s${seed}`)!;
				const mixed = byId.get(`threshold-mixed-l${length}-c${cardinality}-s${seed}`)!;
				assert.equal(upper.text.length, length);
				assert.equal(mixed.text.length, length);
				assert.equal(new Set(upper.text).size, cardinality);
				assert.equal(new Set(mixed.text.toLowerCase()).size, cardinality);
				assert.match(mixed.text, /[a-z]/);
				assert.match(mixed.text, /[A-Z]/);
			}
		}
	}
	for (const [id, length, cardinality, separator] of [
		["threshold-aggregate-lower-l11-c11-space", 11, 11, " "],
		["threshold-aggregate-mixed-l11-c11-newline", 11, 11, "\n"],
		["threshold-aggregate-lower-l17-c17-space", 17, 17, " "],
	] as const) {
		const runs = byId.get(id)!.text.split(separator);
		assert.equal(runs.length, 1_024);
		for (const run of runs) {
			assert.equal(run.length, length);
			assert.equal(new Set(run.toLowerCase()).size, cardinality);
		}
	}
	for (const length of [64, 256] as const) {
		for (let seed = 1; seed <= 4; seed++) {
			const symbols = byId.get(`threshold-symbol-collision-l${length}-s${seed}`)!;
			assert.equal(symbols.text.length, length);
			assert.equal(new Set(symbols.text).size, 16);
		}
	}
});

test("fixed reference corpus meets conservative accuracy gates", { timeout: 120_000 }, () => {
	const encoding = getEncoding("cl100k_base");
	try {
		const fixtures = createToolTokenEstimatorCorpus();
		assert.equal(fixtures.length, 285);
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
