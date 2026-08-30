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

export const TOOL_TOKEN_ESTIMATOR_CORPUS_VERSION = "phase5a-v1" as const;

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
		{ id: "malformed-high", category: "malformed-unicode", text: `before${String.fromCharCode(0xd83d)}after` },
		{ id: "malformed-low", category: "malformed-unicode", text: `left${String.fromCharCode(0xdc00)}right` },
		{ id: "malformed-boundary", category: "malformed-unicode", text: `${String.fromCharCode(0xd83d)}\n${String.fromCharCode(0xdc00)}` },
	];
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
