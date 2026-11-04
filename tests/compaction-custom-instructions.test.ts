import assert from "node:assert/strict";
import test from "node:test";
import type { StreamFn } from "@super-pi/agent-core";
import { stream as streamAnthropic } from "../packages/ai/src/api/anthropic-messages.ts";
import { compact } from "../packages/coding-agent/src/core/compaction/compaction.ts";
import { SUMMARIZATION_SYSTEM_PROMPT } from "../packages/coding-agent/src/core/compaction/utils.ts";
import { compactionFocus, compactionPreparation } from "./helpers/compaction-instructions-fixture.ts";
import { freezeSchemaInput, schemaModel, schemaResponse } from "./helpers/anthropic-schema-fixture.ts";

for (const scene of ["prefix-only", "both", "non-split", "no-instructions"]) {
  test(`compaction sends custom focus to each actual request: ${scene}`, async () => {
    const preparation = compactionPreparation(scene), model = schemaModel();
    const before = structuredClone(preparation);
    freezeSchemaInput(preparation);
    const budgets: number[] = [], prompts: string[] = [], systems: string[] = [];
    const routeHeaders = { "x-fixture-route": "preserved" }, env = { FIXTURE_ENV: "preserved" };
    const streamFn: StreamFn = (_model, context, options) => {
      assert.equal(options?.apiKey, "offline-fixture");
      assert.equal(options?.headers, routeHeaders);
      assert.equal(options?.env, env);
      assert.equal(options?.sessionId, "fixture-session");
      assert.equal(options?.cacheRetention, "none");
      assert.equal(options?.toolChoice, "none");
      assert.equal(context.systemPrompt, SUMMARIZATION_SYSTEM_PROMPT);
      return streamAnthropic(model, context, { ...options, maxRetries: 0, fetch: async (_url, init) => {
        assert.equal(new Headers(init?.headers).get("x-fixture-route"), "preserved");
        const body = JSON.parse(init!.body as string) as { max_tokens: number; system: Array<{ text: string }>; messages: Array<{ role: string; content: Array<{ text: string }> }> };
        budgets.push(body.max_tokens);
        systems.push(body.system.map(block => block.text).join("\n"));
        assert.equal(body.messages.length, 1);
        assert.equal(body.messages[0]!.role, "user");
        prompts.push(body.messages[0]!.content.map(block => block.text).join("\n"));
        return new Response(schemaResponse, { headers: { "content-type": "text/event-stream" } });
      } });
    };
    const focus = scene === "no-instructions" ? undefined : compactionFocus;
    const result = await compact(preparation, model, "offline-fixture", routeHeaders, focus, undefined,
      undefined, streamFn, env, { enabled: false, maxRetries: 0, baseDelayMs: 1 }, undefined, "fixture-session");
    assert.equal(prompts.length, scene === "both" || scene === "no-instructions" ? 2 : 1);
    assert.deepEqual(budgets, scene === "prefix-only" ? [512] : scene === "non-split" ? [819] : [819, 512]);
    for (let index = 0; index < prompts.length; index++) {
      assert.equal(prompts[index]!.split(compactionFocus).length - 1, focus ? 1 : 0);
      assert.equal(systems[index]!.includes(compactionFocus), false);
      if (focus) assert.ok(prompts[index]!.indexOf("Additional focus: " + focus) > prompts[index]!.indexOf("</conversation>"));
    }
    if (scene === "both") assert.ok(prompts[0]!.includes("<previous-summary>\nEarlier decisions"));
    assert.equal(result.firstKeptEntryId, preparation.firstKeptEntryId);
    assert.equal(result.retainedTail, preparation.retainedTail);
    assert.equal(result.tokensBefore, preparation.tokensBefore);
    assert.equal(result.usage?.input, prompts.length);
    assert.ok(result.summary.includes("<read-files>\nread-only.txt"));
    assert.ok(result.summary.includes("<modified-files>\nchanged.txt"));
    assert.deepEqual(preparation, before);
  });
}
