import assert from "node:assert/strict";
import test from "node:test";
import { streamProxy } from "../packages/agent/src/proxy.ts";
import type { AnthropicContextCheckpoint, AssistantMessage, Model } from "../packages/ai/src/types.ts";

test("review: proxy final metadata preserves checkpoints without contaminating buffered partials", async t => {
	const originalFetch = globalThis.fetch;
	t.after(() => { globalThis.fetch = originalFetch; });
	const checkpoint: AnthropicContextCheckpoint = { version: 1, toolPolicy: "true:false", systemPrompt: "Use read", tools: [{ name: "read", description: "read", parameters: { type: "object", properties: {} } }] };
	const usage: AssistantMessage["usage"] = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
	const model = { id: "claude-opus-5", api: "anthropic-messages", provider: "anthropic" } as Model<"anthropic-messages">;
	for (const value of [checkpoint, null, undefined]) {
		globalThis.fetch = async () => new Response([
			{ type: "start" }, { type: "text_start", contentIndex: 0 }, { type: "text_delta", contentIndex: 0, delta: "OK" },
			{ type: "done", reason: "stop", usage, anthropicContext: value, rawStopReason: "pause_turn" },
		].map(event => `data: ${JSON.stringify(event)}\n`).join(""));
		const events = streamProxy(model, { messages: [] }, { proxyUrl: "https://fixture.invalid", authToken: "fixture" });
		const result = await events.result();
		assert.deepEqual(result.anthropicContext, value);
		assert.equal(result.rawStopReason, "pause_turn");
		for await (const event of events) if ("partial" in event) assert.equal(event.partial.anthropicContext, undefined);
	}
});
