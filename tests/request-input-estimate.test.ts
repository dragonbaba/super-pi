import assert from "node:assert/strict";
import test from "node:test";
import { streamSimple } from "../packages/ai/src/api/openai-completions.ts";
import { buildBaseOptions, clampMaxTokensToContext, CONTEXT_SAFETY_TOKENS } from "../packages/ai/src/api/simple-options.ts";
import { calculateContextTokens, estimateContextTokens, estimateContextTokensFromParts, estimateMessageTokens, estimateTextAndImageContentTokens, estimateTextTokens } from "../packages/ai/src/utils/estimate.ts";
import type { Context, ImageContent, Message, Tool, ToolResultMessage } from "../packages/ai/src/types.ts";
import { REQUEST_ESTIMATE_LOG_LINE, REQUEST_ESTIMATE_LOG_REFERENCE, REQUEST_ESTIMATE_MODEL, REQUEST_ESTIMATE_TOOL, requestEstimateAssistant } from "./fixtures/request-input-estimate.ts";

test("large new input reserves calibrated text headroom in the actual Simple Chat payload", async () => {
	const context: Context = { messages: [{ role: "user", content: REQUEST_ESTIMATE_LOG_LINE.repeat(512), timestamp: 1 }] };
	const before = structuredClone(context);
	let sends = 0;
	const result = await streamSimple(REQUEST_ESTIMATE_MODEL, context, {
		apiKey: "synthetic-fixture", maxRetries: 0, fetch: async (_input, init) => {
			sends++;
			const wire = JSON.parse(String(init?.body));
			assert.equal(wire.messages[0].content, context.messages[0].content);
			assert.ok(REQUEST_ESTIMATE_LOG_REFERENCE + wire.max_tokens <= REQUEST_ESTIMATE_MODEL.contextWindow,
				"fixed offline reference rejects input plus output beyond the context window");
			assert.equal(wire.max_tokens, 15_323);
			const chunk = { id: "offline", object: "chat.completion.chunk", created: 1, model: REQUEST_ESTIMATE_MODEL.id,
				choices: [{ index: 0, delta: { content: "Fits the fixture window." }, finish_reason: "stop" }] };
			return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, { headers: { "Content-Type": "text/event-stream" } });
		},
	}).result();
	assert.equal(result.stopReason, "stop", result.errorMessage);
	assert.equal(sends, 1);
	assert.deepEqual(context, before);
});

test("known usage stays authoritative and only the unknown tail is estimated", () => {
	const assistant = requestEstimateAssistant(2, 2000);
	const context: Context = { systemPrompt: "Already accounted for", tools: [REQUEST_ESTIMATE_TOOL], messages: [
		{ role: "user", content: "Old input", timestamp: 1 }, assistant, { role: "user", content: "x".repeat(3500), timestamp: 3 },
	] };
	assert.deepEqual(estimateContextTokens(context), { tokens: 3000, usageTokens: 2000, trailingTokens: 1000, lastUsageIndex: 1 });
	assert.equal(buildBaseOptions({ ...REQUEST_ESTIMATE_MODEL, contextWindow: 10_000 }, context).maxTokens, 2904);
	assert.equal(estimateContextTokens(context.messages).tokens, 3000);
	assert.equal(assistant.usage.totalTokens, 2000);
});

test("cached usage fallback is counted once without scaling provider totals", () => {
	const assistant = requestEstimateAssistant(2);
	Object.assign(assistant.usage, { input: 100, output: 50, cacheRead: 300, cacheWrite: 25 });
	assert.equal(calculateContextTokens(assistant.usage), 475);
	assert.equal(estimateContextTokens([assistant]).tokens, 475);
	assistant.usage.totalTokens = 999;
	assert.equal(estimateContextTokens([assistant]).tokens, 999);
});

test("newer inserted context invalidates old usage until a newer response arrives", () => {
	const messages: Message[] = [
		{ role: "user", content: "x".repeat(3500), timestamp: 4 }, requestEstimateAssistant(2, 99_000),
		{ role: "user", content: "tail", timestamp: 5 },
	];
	const estimate = estimateContextTokens(messages);
	assert.equal(estimate.lastUsageIndex, null);
	assert.equal(estimate.tokens, 1000 + estimateMessageTokens(messages[1]) + 2);
	messages.push(requestEstimateAssistant(6, 2000), { role: "user", content: "tail", timestamp: 7 });
	assert.deepEqual(estimateContextTokens(messages), { tokens: 2002, usageTokens: 2000, trailingTokens: 2, lastUsageIndex: 3 });
});

for (const stopReason of ["error", "aborted"] as const) test(`${stopReason} usage does not replace the last valid anchor`, () => {
	const failed = requestEstimateAssistant(3, 99_000);
	failed.stopReason = stopReason;
	const messages: Message[] = [requestEstimateAssistant(1, 2000), { role: "user", content: "tail", timestamp: 2 }, failed];
	assert.deepEqual(estimateContextTokens(messages), { tokens: 2002 + estimateMessageTokens(failed), usageTokens: 2000,
		trailingTokens: 2 + estimateMessageTokens(failed), lastUsageIndex: 0 });
});

test("system, schemas and tool arguments share calibrated text accounting", () => {
	const assistant = requestEstimateAssistant(2);
	assistant.content = [{ type: "thinking", thinking: "Inspect the paths" }, { type: "text", text: "Reading" },
		{ type: "toolCall", id: "read", name: "read_files", arguments: { paths: ["中文.ts", "request.ts"] } }];
	const args = JSON.stringify({ paths: ["中文.ts", "request.ts"] });
	assert.equal(estimateMessageTokens(assistant), Math.ceil(("Inspect the pathsReadingread_files".length + args.length) / 3.5));
	const messages: Message[] = [{ role: "user", content: "Read files", timestamp: 1 }, assistant];
	const context = { systemPrompt: "System instructions", tools: [REQUEST_ESTIMATE_TOOL], messages };
	const expected = Math.ceil(context.systemPrompt.length / 3.5) + Math.ceil(JSON.stringify(context.tools).length / 3.5)
		+ estimateMessageTokens(messages[0]) + estimateMessageTokens(assistant);
	assert.equal(estimateContextTokens(context).tokens, expected);
	assert.equal(estimateContextTokensFromParts(context.systemPrompt, messages, context.tools).tokens, expected);
});

test("usage tails count newly added tool schemas once, with the same text divisor", () => {
	const tools: Tool[] = [REQUEST_ESTIMATE_TOOL, { ...REQUEST_ESTIMATE_TOOL, name: "unused" }];
	const result: ToolResultMessage = { role: "toolResult", toolCallId: "add", toolName: "add", content: [{ type: "text", text: "done" }],
		isError: false, timestamp: 3, addedToolNames: ["read_files", "read_files", "missing"] };
	const estimate = estimateContextTokens({ tools, messages: [requestEstimateAssistant(2, 2000), result, { ...result, timestamp: 4 }] });
	assert.equal(estimate.trailingTokens, 4 + Math.ceil(JSON.stringify([tools[0]]).length / 3.5));
	assert.equal(estimate.tokens, 2000 + estimate.trailingTokens);
});

test("text calibration preserves the image placeholder without inspecting image data", () => {
	const image: ImageContent = { type: "image", mimeType: "image/png", get data(): string { throw new Error("must not inspect base64"); } };
	assert.equal(estimateTextAndImageContentTokens([image]), 1200);
	assert.equal(estimateTextAndImageContentTokens([image, { type: "text", text: "tail" }, image]), 2402);
	const result: ToolResultMessage = { role: "toolResult", toolCallId: "image", toolName: "image", content: [image, { type: "text", text: "tail" }], isError: false, timestamp: 1 };
	assert.equal(estimateMessageTokens(result), 1202);
	assert.equal(estimateTextTokens(""), 0);
	assert.equal(estimateContextTokens({ messages: [] }).tokens, 0);
});

test("unserializable tool arguments keep a bounded fallback", () => {
	const circular: Record<string, unknown> = {};
	circular.self = circular;
	const assistant = requestEstimateAssistant(1);
	assistant.content = [{ type: "toolCall", id: "fixture", name: "tool", arguments: circular }];
	assert.equal(estimateMessageTokens(assistant), Math.ceil("tool[unserializable]".length / 3.5));
});

test("request minimum, caller ceiling and legacy one-token clamp keep their contracts", () => {
	const context: Context = { messages: [{ role: "user", content: "x".repeat(3500), timestamp: 1 }] };
	assert.equal(clampMaxTokensToContext(REQUEST_ESTIMATE_MODEL, context, 16), 16);
	assert.equal(clampMaxTokensToContext({ ...REQUEST_ESTIMATE_MODEL, maxTokens: 2048 }, context, 9000), 2048);
	assert.equal(clampMaxTokensToContext({ ...REQUEST_ESTIMATE_MODEL, contextWindow: 1000 + CONTEXT_SAFETY_TOKENS + 1024 }, context, 9000), 1024);
	assert.throws(() => clampMaxTokensToContext({ ...REQUEST_ESTIMATE_MODEL, contextWindow: 6120 - 1 }, context, 9000), /Request preparation blocked/);
	assert.equal(clampMaxTokensToContext({ ...REQUEST_ESTIMATE_MODEL, api: "openai-responses", contextWindow: 1000 }, context, 9000), 1);
});
