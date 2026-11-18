import assert from "node:assert/strict";
import test from "node:test";
import { Type } from "typebox";
import { deepseekProvider } from "../packages/ai/src/providers/deepseek.ts";
import { DEEPSEEK_MODELS } from "../packages/ai/src/providers/deepseek.models.ts";
import type { Context } from "../packages/ai/src/types.ts";

for (const id of ["deepseek-v4-pro", "deepseek-v4-flash"] as const) test(id + " replays ordinary and tool-turn reasoning through the provider", async () => {
	const model = DEEPSEEK_MODELS[id], provider = deepseekProvider();
	const context: Context = { messages: [{ role: "user", content: "Inspect", timestamp: 1 }],
		tools: [{ name: "inspect", description: "Inspect fixture", parameters: Type.Object({}) }] };
	const sent: Record<string, any>[] = [];
	const fetch: typeof globalThis.fetch = async (url, init) => {
		sent.push(await new Request(url, init).json());
		const useTool = sent.length === 2;
		const delta = useTool ? { reasoning_content: "tool reasoning", tool_calls: [{ index: 0, id: "call", type: "function",
			function: { name: "inspect", arguments: "{}" } }] } : { reasoning_content: "text reasoning", content: "Done" };
		const chunk = { id: "fixture", object: "chat.completion.chunk", model: id,
			choices: [{ index: 0, delta, finish_reason: useTool ? "tool_calls" : "stop" }] };
		return new Response("data: " + JSON.stringify(chunk) + "\n\ndata: [DONE]\n\n", { headers: { "Content-Type": "text/event-stream" } });
	};
	const options = { apiKey: "fixture", fetch, reasoning: "high" as const, maxRetries: 0 };
	const first = await provider.streamSimple(model, context, options).result();
	assert.equal(first.stopReason, "stop", first.errorMessage);
	context.messages.push(first, { role: "user", content: "Use the tool", timestamp: 2 });
	const second = await provider.streamSimple(model, context, options).result();
	assert.equal(second.stopReason, "toolUse", second.errorMessage);
	context.messages.push(second, { role: "toolResult", toolName: "inspect", toolCallId: "call", content: [{ type: "text", text: "ok" }], isError: false, timestamp: 3 });
	const third = await provider.streamSimple(model, context, options).result();
	assert.equal(third.stopReason, "stop", third.errorMessage);
	assert.deepEqual(sent[2]!.messages.filter((m: { role: string }) => m.role === "assistant")
		.map((m: { reasoning_content?: string }) => m.reasoning_content), ["text reasoning", "tool reasoning"]);
	const foreign = { ...first, model: "another-model" };
	const opaque = { ...first, content: [{ type: "thinking" as const, redacted: true, thinking: "redacted marker", thinkingSignature: "opaque signature" },
		{ type: "text" as const, text: "Done" }] };
	await provider.streamSimple(model, { ...context, messages: [context.messages[0]!, foreign, opaque] }, options).result();
	assert.doesNotMatch(JSON.stringify(sent[3]!.messages), /text reasoning|redacted marker|opaque signature/);
	await provider.streamSimple(model, { messages: [context.messages[0]!, first] }, options).result();
	assert.equal(sent[4]!.tools, undefined);
	assert.equal(sent[4]!.messages[1].reasoning_content, undefined);
});
