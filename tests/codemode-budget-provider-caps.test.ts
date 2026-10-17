import assert from "node:assert/strict";
import test from "node:test";
import type { Context, KnownApi, Model } from "../packages/ai/src/types.ts";
import { buildBaseOptions, clampMaxTokensToContext, usesAdaptiveRequestBudget } from "../packages/ai/src/api/simple-options.ts";
import { buildOpenAICodexRequestBody } from "../packages/ai/src/api/openai-codex-responses.ts";
import { REQUEST_ESTIMATE_MODEL } from "./fixtures/request-input-estimate.ts";

const context: Context = { messages: [{ role: "user", content: "x".repeat(3500), timestamp: 1 }] };
const apis: KnownApi[] = ["openai-completions", "openai-responses", "azure-openai-responses", "openai-codex-responses",
  "anthropic-messages", "bedrock-converse-stream", "google-generative-ai", "google-vertex", "mistral-conversations", "pi-messages"];

for (const api of apis) test(`R1.1 ${api}: reserve a viable answer and cap the finished request`, async t => {
  const model: Model<KnownApi> = { ...REQUEST_ESTIMATE_MODEL, api, contextWindow: 8000, maxTokens: 128000 };
  assert.equal(usesAdaptiveRequestBudget(api), true);
  assert.equal(buildBaseOptions(model, context).maxTokens, 2904);
  assert.equal(clampMaxTokensToContext(model, context, 2048), 2048);
  assert.throws(() => clampMaxTokensToContext({ ...model, contextWindow: 6000 }, context, 128000), /Request preparation blocked/);
  if (api === "openai-codex-responses") {
    const body = buildOpenAICodexRequestBody(model as Model<"openai-codex-responses">, context, { maxTokens: 2904 }, undefined);
    assert.equal("max_output_tokens" in body, false, "Codex has no wire output cap to reserve wholesale");
    return;
  }
  // Capture actual sender payloads before any transport. A fake global fetch is
  // a second guard: these checks must never consume credentials or network.
  t.mock.method(globalThis, "fetch", () => { throw new Error("unexpected network"); });
  const sender = await import(`../packages/ai/src/api/${api}.ts`);
  let payload: any;
  const result = await sender.stream(model, context, {
    apiKey: "synthetic-fixture-token", maxTokens: 128000, maxRetries: 0,
    region: "us-east-1", endpoint: "https://fixture.openai.azure.com", deployment: "fixture", apiVersion: "2025-04-01-preview",
    env: { AWS_PROFILE: "", HTTP_PROXY: "", HTTPS_PROXY: "", ALL_PROXY: "" },
    onPayload(value: unknown) { payload = value; throw new Error("captured-offline-payload"); },
  }).result();
  assert.ok(payload, result.errorMessage);
  const cap = payload.max_tokens ?? payload.max_completion_tokens ?? payload.max_output_tokens ?? payload.maxTokens
    ?? payload.inferenceConfig?.maxTokens ?? payload.config?.maxOutputTokens ?? payload.options?.maxTokens;
  assert.equal(cap, 2904, `${api} actual payload output ceiling`);
  assert.match(result.errorMessage ?? "", /captured-offline-payload/);
});

test("R1.1 Responses' 16-token wire minimum cannot exceed the remaining context", () => {
  const model = { ...REQUEST_ESTIMATE_MODEL, contextWindow: 5110 };
  assert.throws(() => clampMaxTokensToContext(model, context, 1, 16), /Request preparation blocked/);
  assert.equal(clampMaxTokensToContext({ ...model, contextWindow: 5112 }, context, 1, 16), 16);
});
