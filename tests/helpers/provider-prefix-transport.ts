import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { gunzipSync, zstdDecompressSync } from "node:zlib";
import { NodeHttpHandler } from "@smithy/node-http-handler";
import { EventStreamCodec } from "@smithy/core/event-streams";
import type { TestContext } from "node:test";
import type { KnownApi, Model } from "../../packages/ai/src/types.ts";
import { codexToken, responsesUsage, sseFrames, textEvents } from "./responses-sse-fixture.ts";

const PREFIX_PROVIDER_ENV = Object.freeze({ HTTP_PROXY: "", HTTPS_PROXY: "", ALL_PROXY: "", AWS_PROFILE: "", AWS_REGION: "us-east-1",
  AWS_DEFAULT_REGION: "", AWS_BEDROCK_FORCE_HTTP1: "1" });
const SSE_HEADERS = Object.freeze({ "content-type": "text/event-stream" });

export interface PrefixCase { label: string; model: Model<any> }
function model(api: KnownApi, provider: string, id: string): Model<any> {
  return { api, provider, id, name: id, baseUrl: "https://fixture.invalid", reasoning: false, input: ["text"],
    contextWindow: 128000, maxTokens: 1024, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
}
// A new built-in API must have a transport fixture before this record can typecheck.
export const prefixModels: Record<KnownApi, Model<any>> = {
  "openai-codex-responses": model("openai-codex-responses", "openai-codex", "gpt-5.1-codex"),
  "openai-responses": model("openai-responses", "openai", "gpt-4.1"),
  "azure-openai-responses": model("azure-openai-responses", "azure-openai-responses", "gpt-4.1"),
  "openai-completions": model("openai-completions", "openai", "gpt-4.1"),
  "anthropic-messages": model("anthropic-messages", "anthropic", "claude-sonnet-4-5"),
  "bedrock-converse-stream": model("bedrock-converse-stream", "amazon-bedrock", "anthropic.claude-sonnet-4-5"),
  "google-generative-ai": model("google-generative-ai", "google", "gemini-2.5-pro"),
  "google-vertex": model("google-vertex", "google-vertex", "gemini-2.5-pro"),
  "mistral-conversations": model("mistral-conversations", "mistral", "devstral-small-latest"),
  "pi-messages": model("pi-messages", "radius", "fixture"),
};
export const prefixCases: PrefixCase[] = [
  ...Object.entries(prefixModels).map(([label, model]) => ({ label, model })),
  { label: "anthropic native inline", model: model("anthropic-messages", "anthropic", "claude-opus-5") },
  { label: "OpenRouter Claude cache markers", model: model("openai-completions", "openrouter", "anthropic/claude-sonnet-4.5") },
  { label: "DeepSeek chat", model: model("openai-completions", "deepseek", "deepseek-chat") },
  { label: "Kimi chat", model: model("openai-completions", "kimi-coding", "kimi-for-coding") },
];

export interface WirePrefix {
  prefix: string;
  history: any[];
  rawBytes: number;
  wireBytes: number;
}
// Keep all fixed wire fields and cache settings. History grows; it is compared separately.
function extract(body: any, api: KnownApi): Pick<WirePrefix, "prefix" | "history"> {
  const { messages, input, contents, context, ...fixed } = body;
  let history = messages ?? input ?? contents ?? context?.messages;
  if (api === "pi-messages") fixed.context = { ...context, messages: undefined };
  if (Array.isArray(input)) {
    let leading = 0;
    while (leading < input.length && (input[leading].role === "system" || input[leading].role === "developer")) leading++;
    fixed.inputInstructions = input.slice(0, leading);
    history = input.slice(leading);
  } else if (Array.isArray(messages)) {
    let leading = 0;
    while (leading < messages.length && (messages[leading].role === "system" || messages[leading].role === "developer")) leading++;
    fixed.messageInstructions = messages.slice(0, leading);
    history = messages.slice(leading);
  }
  assert.ok(Array.isArray(history), `${api} fixture did not identify the actual wire history`);
  return { prefix: JSON.stringify(fixed), history };
}

function response(api: KnownApi): Response {
  let text: string;
  if (api.endsWith("responses")) text = sseFrames(textEvents());
  else if (api === "anthropic-messages") {
    const events = [
      { type: "message_start", message: { id: "fixture", usage: { input_tokens: 1, output_tokens: 0 } } },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "OK" } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
      { type: "message_stop" },
    ];
    text = events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("");
  } else if (api === "google-generative-ai" || api === "google-vertex") {
    text = sseFrames([{ candidates: [{ content: { role: "model", parts: [{ text: "OK" }] }, finishReason: "STOP" }],
      usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 } }]);
  } else if (api === "pi-messages") {
    text = sseFrames([{ type: "text_start", contentIndex: 0 }, { type: "text_end", contentIndex: 0, content: "OK" },
      { type: "done", reason: "stop", usage: responsesUsage }]);
  } else text = sseFrames([{ id: "fixture", object: "chat.completion.chunk", created: 1, model: "fixture",
    choices: [{ index: 0, delta: { role: "assistant", content: "OK" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }]) + "data: [DONE]\n\n";
  return new Response(text, { headers: SSE_HEADERS });
}

/** Real SDK serialization and response decoding; only network admission is replaced. */
export async function prefixTransport(t: TestContext, target: Model<any>) {
  const api = target.api as KnownApi;
  const sent: WirePrefix[] = [];
  const record = (wire: Uint8Array, encoding?: string | null) => {
    const raw = encoding === "zstd" ? zstdDecompressSync(wire) : encoding === "gzip" ? gunzipSync(wire) : wire;
    sent.push({ ...extract(JSON.parse(Buffer.from(raw).toString("utf8")), api), rawBytes: raw.byteLength, wireBytes: wire.byteLength });
  };
  t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    record(new Uint8Array(await request.arrayBuffer()), request.headers.get("content-encoding"));
    return response(api);
  });
  if (api === "bedrock-converse-stream") {
    const codec = new EventStreamCodec(bytes => Buffer.from(bytes).toString("utf8"), text => Buffer.from(text));
    const events = [
      ["messageStart", { role: "assistant" }],
      ["contentBlockStart", { contentBlockIndex: 0, start: {} }],
      ["contentBlockDelta", { contentBlockIndex: 0, delta: { text: "OK" } }],
      ["contentBlockStop", { contentBlockIndex: 0 }],
      ["messageStop", { stopReason: "end_turn" }],
      ["metadata", { usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } }],
    ] as const;
    const frames = events.map(([name, body]) => codec.encode({ headers: {
      ":message-type": { type: "string", value: "event" }, ":event-type": { type: "string", value: name },
      ":content-type": { type: "string", value: "application/json" },
    }, body: Buffer.from(JSON.stringify(body)) }));
    t.mock.method(NodeHttpHandler.prototype, "handle", async (request: { body: string }) => {
      assert.equal(typeof request.body, "string", "Bedrock must reach serialized HTTP request boundary");
      record(Buffer.from(request.body));
      return { response: { statusCode: 200, headers: { "content-type": "application/vnd.amazon.eventstream" }, body: Readable.from(frames) } };
    });
  }
  const adapter = await import(`../../packages/ai/src/api/${api}.ts`);
  return { sent, stream(requestModel: Model<any>, context: any, options: any) {
    assert.equal(requestModel.api, target.api, "production session must use the tested API");
    assert.equal(requestModel.id, target.id, "production session must use the tested model");
    assert.equal(requestModel.provider, target.provider, "production session must use the tested provider");
    return adapter.stream(requestModel, context, { ...options, fetch: globalThis.fetch,
      apiKey: api === "openai-codex-responses" ? codexToken() : "synthetic-offline-token", maxRetries: 0,
      transport: "sse", cacheRetention: "long", region: "us-east-1", apiVersion: "2025-04-01-preview",
      env: PREFIX_PROVIDER_ENV,
    });
  } };
}

/** Moving history breakpoints are policy metadata, not changed prior token content. */
export function historyContent(history: any[]): any[] {
  return JSON.parse(JSON.stringify(history, (key, value) => key === "cache_control" ? undefined
    : Array.isArray(value) ? value.filter(item => !item?.cachePoint || Object.keys(item).length !== 1) : value));
}
