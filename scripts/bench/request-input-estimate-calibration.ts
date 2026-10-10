import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { getEncoding } from "js-tiktoken";
import ts from "typescript";
import { estimateContextTokens } from "../../packages/ai/src/utils/estimate.ts";
import { buildBaseOptions } from "../../packages/ai/src/api/simple-options.ts";
import type { Context } from "../../packages/ai/src/types.ts";
import { REQUEST_ESTIMATE_LOG_REFERENCE, REQUEST_ESTIMATE_MODEL, REQUEST_ESTIMATE_TOOL, requestEstimateAssistant, requestEstimateTextCorpus } from "../../tests/fixtures/request-input-estimate.ts";

// Development-only comparison. Neither tokenizer nor the VM enters the runtime.
const root = fileURLToPath(new URL("../../", import.meta.url));
const source = readFileSync(new URL("../../packages/ai/src/utils/estimate.ts", import.meta.url), "utf8");
const variants = [
	{ id: "legacy-4", divisor: "4", imageChars: "4800" },
	{ id: "upstream-3.5", divisor: "3.5", imageChars: "4800" },
	{ id: "text-3.5-image-1200", divisor: "3.5", imageChars: "1200 * CHARS_PER_TOKEN" },
].map(variant => {
	assert.equal((source.match(/^const CHARS_PER_TOKEN = .+;$/gm) ?? []).length, 1);
	assert.equal((source.match(/^const ESTIMATED_IMAGE_CHARS = .+;$/gm) ?? []).length, 1);
	const candidate = source.replace(/^const CHARS_PER_TOKEN = .+;$/m, `const CHARS_PER_TOKEN = ${variant.divisor};`)
		.replace(/^const ESTIMATED_IMAGE_CHARS = .+;$/m, `const ESTIMATED_IMAGE_CHARS = ${variant.imageChars};`);
	const sandbox = { exports: {} as { estimateContextTokens: typeof estimateContextTokens } };
	vm.runInNewContext(ts.transpileModule(candidate, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, sandbox);
	return { id: variant.id, estimate: sandbox.exports.estimateContextTokens };
});
const references = [{ id: "cl100k_base", encoding: getEncoding("cl100k_base") }, { id: "o200k_base", encoding: getEncoding("o200k_base") }];
const rows = [];
for (const fixture of requestEstimateTextCorpus()) {
	const counts = references.map(reference => ({ tokenizer: reference.id, textTokens: reference.encoding.encode(fixture.text).length }));
	if (fixture.id === "logs") for (const count of counts) assert.equal(count.textTokens, REQUEST_ESTIMATE_LOG_REFERENCE);
	for (const anchored of [false, true]) {
		const context: Context = { messages: anchored
			? [requestEstimateAssistant(1, 2000), { role: "user", content: fixture.text, timestamp: 2 }]
			: [{ role: "user", content: fixture.text, timestamp: 1 }] };
		const estimates = variants.map(variant => {
			const estimate = variant.estimate(context);
			return { variant: variant.id, ...estimate, comparisons: counts.map(reference => ({ tokenizer: reference.tokenizer,
				underTokens: Math.max(0, reference.textTokens - estimate.trailingTokens),
				overTokens: Math.max(0, estimate.trailingTokens - reference.textTokens),
				underRatio: Math.max(0, reference.textTokens - estimate.trailingTokens) / reference.textTokens,
			})) };
		});
		assert.deepEqual(estimateContextTokens(context), { tokens: estimates[2].tokens, usageTokens: estimates[2].usageTokens,
			trailingTokens: estimates[2].trailingTokens, lastUsageIndex: estimates[2].lastUsageIndex });
		rows.push({ fixture: fixture.id, anchored, utf16Length: fixture.text.length, references: counts, estimates });
	}
}
const newTool = { role: "toolResult" as const, toolCallId: "added", toolName: "add", timestamp: 2, isError: false,
	content: [{ type: "text" as const, text: "done" }], addedToolNames: [REQUEST_ESTIMATE_TOOL.name, REQUEST_ESTIMATE_TOOL.name] };
const contexts: Array<{ id: string; context: Context }> = [
	{ id: "schema-prefix", context: { systemPrompt: "Read the files", messages: [], tools: [REQUEST_ESTIMATE_TOOL] } },
	{ id: "new-schema-after-usage", context: { messages: [requestEstimateAssistant(1, 2000), newTool], tools: [REQUEST_ESTIMATE_TOOL] } },
	{ id: "image-only", context: { messages: [{ role: "user", timestamp: 1, content: [{ type: "image", mimeType: "image/png", get data(): string { throw new Error("Image base64 must not be read"); } }] }] } },
	{ id: "image-tail", context: { messages: [requestEstimateAssistant(1, 2000), { role: "user", timestamp: 2,
		content: [{ type: "text", text: "tail" }, { type: "image", mimeType: "image/png", data: "synthetic" }] }] } },
];
const boundaries = contexts.map(fixture => ({ fixture: fixture.id, estimates: variants.map(variant => ({ variant: variant.id, ...variant.estimate(fixture.context) })) }));
const log = requestEstimateTextCorpus().find(fixture => fixture.id === "logs")!;
const logContext: Context = { messages: [{ role: "user", content: log.text, timestamp: 1 }] };
const cap = buildBaseOptions(REQUEST_ESTIMATE_MODEL, logContext).maxTokens!;
assert.equal(cap, 15_323);
assert.ok(REQUEST_ESTIMATE_LOG_REFERENCE + cap <= REQUEST_ESTIMATE_MODEL.contextWindow);
process.stdout.write(`${JSON.stringify({
	benchmark: "request-input-estimate-calibration", node: process.version, platform: process.platform,
	commit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
	estimatorSha256: createHash("sha256").update(source).digest("hex"), referenceLibrary: "js-tiktoken@1.0.21",
	referenceScope: "Offline text token counts only. Excludes provider framing, image billing and live model validation; fixed usage is synthetic.",
	rows, boundaries, requestBoundary: { referenceInput: REQUEST_ESTIMATE_LOG_REFERENCE, contextWindow: REQUEST_ESTIMATE_MODEL.contextWindow, candidateOutput: cap,
		remainingBeforeWireOverhead: REQUEST_ESTIMATE_MODEL.contextWindow - REQUEST_ESTIMATE_LOG_REFERENCE - cap },
}, null, 2)}\n`);
