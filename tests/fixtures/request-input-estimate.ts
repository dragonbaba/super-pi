import type { AssistantMessage, Model, Tool } from "../../packages/ai/src/types.ts";

export const REQUEST_ESTIMATE_MODEL: Model<"openai-completions"> = {
	id: "request-estimate-fixture", name: "Request estimate fixture", provider: "fixture", api: "openai-completions",
	baseUrl: "https://fixture.invalid/v1", reasoning: false, input: ["text", "image"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32_000, maxTokens: 32_000,
	compat: { maxTokensField: "max_tokens" },
};

export const REQUEST_ESTIMATE_TOOL: Tool = {
	name: "read_files", description: "Read a list of UTF-8 source files and return their numbered lines.",
	parameters: { type: "object", properties: {
		paths: { type: "array", items: { type: "string" } }, start: { type: "integer", minimum: 1 },
		limit: { type: "integer", minimum: 1, maximum: 2000 },
	}, required: ["paths"], additionalProperties: false },
};

export const REQUEST_ESTIMATE_LOG_LINE = "2026-10-10T12:00:00.000Z INFO request=42 file=src/request.ts status=ok duration_ms=17\n";
// Recorded with js-tiktoken@1.0.21, cl100k_base and o200k_base. Text only;
// provider framing/schema/image tokens are deliberately not called exact here.
export const REQUEST_ESTIMATE_LOG_REFERENCE = 16_384;

export function requestEstimateAssistant(timestamp: number, totalTokens = 0): AssistantMessage {
	return { role: "assistant", api: REQUEST_ESTIMATE_MODEL.api, provider: REQUEST_ESTIMATE_MODEL.provider,
		model: REQUEST_ESTIMATE_MODEL.id, content: [{ type: "text", text: "Recorded answer" }], timestamp, stopReason: "stop",
		usage: { input: totalTokens, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
}

export function requestEstimateTextCorpus(): Array<{ id: string; text: string }> {
	return [
		{ id: "english", text: "Inspect the current request and preserve the original tool result. Report the measured input size before choosing an output limit.\n".repeat(256) },
		{ id: "chinese", text: "检查当前请求并保留原始工具结果，在选择输出上限前报告测量的输入大小。\n".repeat(256) },
		{ id: "mixed", text: "读取 request context，检查工具 schema 和输入 token 数量，然后保留现有输出行为。\n".repeat(256) },
		{ id: "typescript", text: "export function sum(values: readonly number[]): number {\n  let total = 0;\n  for (const value of values) total += value;\n  return total;\n}\n".repeat(256) },
		{ id: "json", text: '{"id":42,"ok":true,"items":[1,2,3],"path":"src/request.ts","message":"fixture result"}\n'.repeat(256) },
		{ id: "schema", text: JSON.stringify(Array.from({ length: 64 }, (_, index) => ({ ...REQUEST_ESTIMATE_TOOL, name: `read_files_${index}` }))) },
		{ id: "logs", text: REQUEST_ESTIMATE_LOG_LINE.repeat(512) },
		{ id: "repetition", text: "x".repeat(512) },
	];
}
