export interface ToolTokenCorpusFixture {
	id: string;
	category: string;
	text: string;
	/** Recorded cl100k_base count for fixtures too large for routine JS tokenizer runs. */
	referenceTokens?: number;
}

const MEBIBYTE = 1024 * 1024;
const ENGLISH_PROSE =
	"A conservative estimator should remain inexpensive while giving downstream budget simulations enough headroom to avoid accidental context overflow.";
const ENGLISH_LOG = "2026-08-30T09:14:22.481Z INFO worker=fixture request=42 completed duration_ms=17 status=ok\n";
const JSON_PRETTY = `{
  "kind": "fixture",
  "enabled": true,
  "items": [1, 2, 3],
  "nested": { "message": "deterministic sample" }
}`;
const JSON_MINIFIED = '{"kind":"fixture","enabled":true,"items":[1,2,3],"nested":{"message":"deterministic sample"}}';
const TYPESCRIPT = `export function sum(values: readonly number[]): number {
  let total = 0;
  for (const value of values) total += value;
  return total;
}`;
const PYTHON = `def summarize(values: list[int]) -> int:
    total = 0
    for value in values:
        total += value
    return total
`;
const STACK = `Error: fixture failure
    at executeFixture (src/example.ts:42:17)
    at async runTask (src/runner.ts:18:5)
    at async main (src/main.ts:7:3)`;
const REPEATED_ERROR = "ERROR fixture worker failed code=E_RETRY attempt=3\n";

const LOWERCASE = "abcdefghijklmnopqrstuvwxyz";
const UPPERCASE = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const MIXED_CASE = `${LOWERCASE}${UPPERCASE}`;
const PUNCTUATION = "!@#$%^&*()-_=+[]{};:'\",.<>/?\\|`~";
const SYMBOL_COLLISION_ALPHABET = ";[{<\\|=]}>^~?_@`";
const MATRIX_SEEDS = [0x5a17_0001, 0x5a17_0002, 0x5a17_0003, 0x5a17_0004] as const;

function seededCharacters(length: number, alphabet: string, seed: number): string {
	let state = seed >>> 0;
	let value = "";
	for (let index = 0; index < length; index++) {
		state ^= state << 13;
		state ^= state >>> 17;
		state ^= state << 5;
		value += alphabet[(state >>> 0) % alphabet.length];
	}
	return value;
}

function seededCharactersWithRequiredAlphabet(length: number, alphabet: string, seed: number): string {
	let value = "";
	const offset = seed % alphabet.length;
	let step = (seed % (alphabet.length - 1)) + 1;
	while (greatestCommonDivisor(step, alphabet.length) !== 1) step++;
	for (let index = 0; index < alphabet.length; index++) {
		value += alphabet[(offset + index * step) % alphabet.length];
	}
	if (value.length < length) value += seededCharacters(length - value.length, alphabet, seed);
	return value;
}

function greatestCommonDivisor(left: number, right: number): number {
	while (right !== 0) {
		const remainder = left % right;
		left = right;
		right = remainder;
	}
	return left;
}

export const TOOL_TOKEN_ESTIMATOR_CORPUS_VERSION = "phase5a-v3" as const;

export function createToolTokenEstimatorCorpus(includeLarge = true): ToolTokenCorpusFixture[] {
	const fixtures: ToolTokenCorpusFixture[] = [
		{ id: "empty", category: "empty-tiny", text: "" },
		{ id: "tiny", category: "empty-tiny", text: "ok" },
		{ id: "english-prose-short", category: "english-prose", text: ENGLISH_PROSE },
		{ id: "english-prose-repeated", category: "english-prose", text: `${ENGLISH_PROSE}\n`.repeat(8) },
		{ id: "english-log", category: "english-logs", text: ENGLISH_LOG.repeat(8) },
		{ id: "chinese", category: "chinese", text: "这是固定且可复现的中文工具输出，用于验证保守估算不会系统性低估。".repeat(8) },
		{ id: "mixed", category: "mixed-chinese-english", text: "Phase 5A 估算器处理 mixed output，并保留 conservative headroom.\n".repeat(8) },
		{ id: "json-pretty", category: "json", text: `${JSON_PRETTY}\n`.repeat(8) },
		{ id: "json-minified", category: "minified-json", text: JSON_MINIFIED.repeat(8) },
		{ id: "typescript", category: "typescript-javascript", text: `${TYPESCRIPT}\n`.repeat(8) },
		{ id: "javascript", category: "typescript-javascript", text: "const result = rows.filter(Boolean).map((row) => ({ ...row, ready: true }));\n".repeat(8) },
		{ id: "python", category: "python", text: PYTHON.repeat(8) },
		{ id: "shell", category: "shell-output", text: "$ npm test\nPASS fixture.test.ts\nTests: 24 passed, 24 total\nTime: 1.42s\n".repeat(8) },
		{ id: "stack-trace", category: "stack-traces", text: `${STACK}\n`.repeat(8) },
		{ id: "repeated-errors", category: "repeated-errors", text: REPEATED_ERROR.repeat(16) },
		{ id: "ansi", category: "ansi-logs", text: "\u001b[31mERROR\u001b[0m fixture failed; \u001b[33mretrying\u001b[0m\n".repeat(12) },
		{ id: "emoji", category: "emoji", text: "😀 🚀 🧪 ✅ ❌ 🎉 🔥 💡 📦\n".repeat(8) },
		{ id: "family-emoji", category: "family-emoji", text: "👨‍👩‍👧‍👦 👩🏽‍💻 👨‍🚀 👩‍🔬\n".repeat(8) },
		{ id: "combining", category: "combining-marks", text: "Cafe\u0301 nai\u0308ve co\u0308operate A\u030a ngstro\u0308m\n".repeat(12) },
		{ id: "urls", category: "urls", text: "https://example.test/api/v1/items?cursor=fixture-123&include=metadata#section\n".repeat(8) },
		{ id: "uuid-hash", category: "uuid-hash", text: "550e8400-e29b-41d4-a716-446655440000 0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef\n".repeat(8) },
		{ id: "base64-like", category: "base64-like", text: "VGhpcy1pcy1ub3QtYS1zZWNyZXQtZml4dHVyZS0wMTIzNDU2Nzg5QUJDREVGRw==".repeat(16) },
		{ id: "long-word-lower", category: "long-unbroken-word", text: "deterministicfixtureword".repeat(128) },
		{ id: "long-word-mixed", category: "long-unbroken-word", text: "Ab9xQ2Lm7Pz4".repeat(256) },
		{ id: "random-lowercase-12", category: "adversarial-alpha", text: seededCharacters(12, LOWERCASE, 0x5a17_0012) },
		{ id: "random-lowercase-64", category: "adversarial-alpha", text: seededCharacters(64, LOWERCASE, 0x5a17_0064) },
		{ id: "random-lowercase-256", category: "adversarial-alpha", text: seededCharacters(256, LOWERCASE, 0x5a17_0256) },
		{ id: "random-uppercase-64", category: "adversarial-alpha", text: seededCharacters(64, UPPERCASE, 0x5a17_1064) },
		{ id: "random-mixed-case-128", category: "adversarial-alpha", text: seededCharacters(128, MIXED_CASE, 0x5a17_2128) },
		{ id: "camel-case-identifiers", category: "adversarial-alpha", text: "parseHTTPResponseIntoModelVisibleTokenBudgetCandidateWithoutCopyingTextBlocks".repeat(4) },
		{ id: "alphabetic-api-key-like", category: "adversarial-alpha", text: `FixtureApiToken${seededCharacters(192, MIXED_CASE, 0x5a17_3192)}` },
		{ id: "random-punctuation-256", category: "adversarial-punctuation", text: seededCharacters(256, PUNCTUATION, 0x5a17_4256) },
		{ id: "rare-han", category: "adversarial-cjk", text: "龘麤靐齉纛鱻灥爨籲讟钃鸜".repeat(16) },
		{ id: "cjk-extension", category: "adversarial-cjk", text: "𠀀𠮷𡃁𡈼𡚴𢀖𢎭𣏟".repeat(16) },
		{ id: "hiragana-katakana", category: "adversarial-cjk", text: "ひらがなカタカナヷヸヹヺゔヵヶ".repeat(16) },
		{ id: "hangul", category: "adversarial-cjk", text: "한글도구출력토큰예산관찰값".repeat(16) },
		{ id: "mixed-cjk-ascii-identifiers", category: "adversarial-cjk", text: "工具Result解析器Model预算値tokenCount한국어ID".repeat(16) },
		{ id: "malformed-high", category: "malformed-unicode", text: `before${String.fromCharCode(0xd83d)}after` },
		{ id: "malformed-low", category: "malformed-unicode", text: `left${String.fromCharCode(0xdc00)}right` },
		{ id: "malformed-boundary", category: "malformed-unicode", text: `${String.fromCharCode(0xd83d)}\n${String.fromCharCode(0xdc00)}` },
	];
	for (const [length, cardinalities] of [
		[12, [8, 10, 12]],
		[16, [12, 14, 16]],
		[64, [16, 19, 20, 26]],
		[256, [16, 19, 20, 26]],
	] as const) {
		for (const cardinality of cardinalities) {
			const alphabet = LOWERCASE.slice(0, cardinality);
			for (let seedIndex = 0; seedIndex < MATRIX_SEEDS.length; seedIndex++) {
				fixtures.push({
					id: `threshold-lower-l${length}-c${cardinality}-s${seedIndex + 1}`,
					category: "threshold-alpha",
					text: seededCharactersWithRequiredAlphabet(length, alphabet, MATRIX_SEEDS[seedIndex]!),
				});
			}
		}
	}
	for (const cardinality of [16, 19, 20] as const) {
		const upperAlphabet = UPPERCASE.slice(0, cardinality);
		const mixedAlphabet = `${LOWERCASE.slice(0, cardinality)}${UPPERCASE.slice(0, cardinality)}`;
		for (let seedIndex = 0; seedIndex < MATRIX_SEEDS.length; seedIndex++) {
			fixtures.push(
				{
					id: `threshold-upper-l64-c${cardinality}-s${seedIndex + 1}`,
					category: "threshold-alpha",
					text: seededCharactersWithRequiredAlphabet(64, upperAlphabet, MATRIX_SEEDS[seedIndex]!),
				},
				{
					id: `threshold-mixed-l64-c${cardinality}-s${seedIndex + 1}`,
					category: "threshold-alpha",
					text: seededCharactersWithRequiredAlphabet(64, mixedAlphabet, MATRIX_SEEDS[seedIndex]!),
				},
			);
		}
	}
	for (const length of [64, 256] as const) {
		for (let seedIndex = 0; seedIndex < MATRIX_SEEDS.length; seedIndex++) {
			fixtures.push({
				id: `threshold-symbol-collision-l${length}-s${seedIndex + 1}`,
				category: "threshold-symbol-collision",
				text: seededCharactersWithRequiredAlphabet(length, SYMBOL_COLLISION_ALPHABET, MATRIX_SEEDS[seedIndex]!),
			});
		}
	}
	if (includeLarge) {
		fixtures.push(
			{
				id: "one-mib-output",
				category: "large-output",
				text: ENGLISH_LOG.repeat(Math.ceil(MEBIBYTE / ENGLISH_LOG.length)).slice(0, MEBIBYTE),
				referenceTokens: 353_327,
			},
			{
				id: "ten-mib-single-line",
				category: "large-single-line",
				text: "x".repeat(10 * MEBIBYTE),
				referenceTokens: 1_310_720,
			},
		);
	}
	return fixtures;
}
