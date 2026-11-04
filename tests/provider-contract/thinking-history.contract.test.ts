import assert from "node:assert/strict";
import test from "node:test";
import { stream as streamAnthropic } from "../../packages/ai/src/api/anthropic-messages.ts";
import { transformMessages } from "../../packages/ai/src/api/transform-messages.ts";
import { conservativeModelCapabilities } from "../../packages/ai/src/model-capabilities.ts";
import type { AssistantMessage, Message, Model } from "../../packages/ai/src/types.ts";

function model(toolCalling = true, replay = true): Model<"anthropic-messages"> {
  return { id: "history-fixture", name: "History fixture", api: "anthropic-messages", provider: "fixture",
    baseUrl: "https://fixture.invalid", reasoning: true, input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 1024,
    capabilities: { ...conservativeModelCapabilities(128000, 1024), toolCalling, thoughtSignatureRoundTrip: replay } };
}

function history(target: Model<"anthropic-messages">, origin: string): Message[] {
  const assistant: AssistantMessage = { role: "assistant", api: origin === "api" ? "openai-completions" : target.api,
    provider: origin === "provider" ? "other" : target.provider, model: origin === "model" ? "other" : target.id,
    content: [
      { type: "thinking", thinking: "PRIVATE_UNSIGNED" },
      { type: "thinking", thinking: "PRIVATE_SIGNED", thinkingSignature: "signed-fixture" },
      { type: "thinking", thinking: "", thinkingSignature: "opaque-fixture", redacted: true },
      { type: "thinking", thinking: " " },
      { type: "thinking", thinking: "", thinkingSignature: "empty-fixture" },
      { type: "text", text: "visible answer" },
      { type: "toolCall", id: "call", name: "lookup", arguments: { q: "visible" }, thoughtSignature: "tool-fixture" },
    ], stopReason: "toolUse", timestamp: 1,
    usage: { input: 5, output: 7, cacheRead: 0, cacheWrite: 0, totalTokens: 12,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
  return [{ role: "user", content: "earlier request", timestamp: 0 }, assistant,
    { role: "toolResult", toolCallId: "call", toolName: "lookup", content: [{ type: "text", text: "visible result" }], isError: false, timestamp: 2 },
    { role: "user", content: "next request", timestamp: 3 }];
}

function freeze(value: unknown): void {
  if (value === null || typeof value !== "object") return;
  for (const child of Object.values(value)) freeze(child);
  Object.freeze(value);
}
function normalize(id: string): string { return "normalized_" + id; }

for (const origin of ["same", "model", "provider", "api"]) for (const replay of [true, false]) {
  test(`thinking history ${origin}, signature replay=${replay}`, () => {
    const target = model(true, replay), input = history(target, origin), before = structuredClone(input);
    freeze(input);
    const result = transformMessages(input, target, normalize);
    const assistant = result[1];
    assert.ok(assistant?.role === "assistant");
    const thinking = assistant.content.filter(block => block.type === "thinking");
    assert.equal(thinking.length, origin === "same" ? replay ? 4 : 2 : 0);
    const texts = assistant.content.filter(block => block.type === "text");
    assert.deepEqual(texts.map(block => block.text), ["visible answer"]);
    const tool = assistant.content.at(-1);
    assert.ok(tool?.type === "toolCall");
    assert.equal(tool.id, origin === "same" ? "call" : "normalized_call");
    assert.equal(tool.thoughtSignature, origin === "same" && replay ? "tool-fixture" : undefined);
    assert.equal(result[2]?.role === "toolResult" && result[2].toolCallId, tool.id);
    assert.equal(result.length, input.length);
    assert.deepEqual(input, before);
    assert.equal(assistant.usage, (input[1] as AssistantMessage).usage);
    if (origin === "same" && replay) {
      assert.equal(thinking[1], (input[1] as AssistantMessage).content[1]);
      assert.equal(thinking[2], (input[1] as AssistantMessage).content[2]);
      assert.equal(thinking[3], (input[1] as AssistantMessage).content[4]);
    } else for (const block of thinking) assert.equal(block.thinkingSignature, undefined);
  });
}

const response = [
  ["message_start", { type: "message_start", message: { id: "fixture", usage: { input_tokens: 1, output_tokens: 0 } } }],
  ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "ok" } }],
  ["content_block_stop", { type: "content_block_stop", index: 0 }],
  ["message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } }],
  ["message_stop", { type: "message_stop" }],
].map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join("");

for (const toolCalling of [true, false]) for (const origin of ["same", "model"]) {
  test(`Anthropic outgoing thinking ${origin}, toolCalling=${toolCalling}`, async () => {
    const target = model(toolCalling), input = history(target, origin), before = structuredClone(input);
    freeze(input);
    let requests = 0;
    let body = "";
    const stream = streamAnthropic(target, { messages: input }, {
      apiKey: "offline-fixture", cacheRetention: "none", maxRetries: 0,
      fetch: async (_url, init) => {
        requests++;
        assert.equal(typeof init?.body, "string");
        body = init!.body as string;
        return new Response(response, { status: 200, headers: { "content-type": "text/event-stream" } });
      },
    });
    for await (const _event of stream) { /* Drain the actual provider stream. */ }
    assert.equal((await stream.result()).stopReason, "stop");
    assert.equal(requests, 1);
    const payload = JSON.parse(body);
    assert.equal(body.includes("PRIVATE_"), origin === "same");
    assert.ok(body.includes("visible answer") && body.includes("visible result"));
    if (origin === "same" && toolCalling) {
      const blocks = payload.messages.flatMap((entry: { content: unknown }) => Array.isArray(entry.content) ? entry.content : []);
      assert.ok(blocks.some((block: { type: string; signature?: string }) => block.type === "thinking" && block.signature === "signed-fixture"));
      assert.ok(blocks.some((block: { type: string; data?: string }) => block.type === "redacted_thinking" && block.data === "opaque-fixture"));
    } else if (origin === "same") {
      // No-tool models retain their established plain-history projection.
      assert.equal(body.includes("signed-fixture"), false);
      assert.equal(body.includes("opaque-fixture"), false);
    }
    assert.deepEqual(input, before);
  });
}
