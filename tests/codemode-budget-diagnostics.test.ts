import assert from "node:assert/strict";
import test from "node:test";
import { clampMaxTokensToContext, RequestBudgetError } from "../packages/ai/src/api/simple-options.ts";
import { createToolResultPresentationOwner, ToolResultContinuationError } from "../packages/coding-agent/src/core/tool-result-presentation.ts";
import { REQUEST_ESTIMATE_MODEL } from "./fixtures/request-input-estimate.ts";
import { assistant, toolResult } from "./codemode-recovery/fixture.ts";

for (const [cause, budget, window, usage, output, planning] of [
  ["result-batch-budget", 1, 128000, 0, 4096, true],
  ["context-headroom", 1024, 128000, 124000, 4096, true],
  ["output-reservation", 1024, 128000, 0, 128000, false],
  ["model-parameters", 1024, Number.NaN, 0, 4096, true],
] as const) test(`R1.2 ${cause} reports capacity and an actionable cause`, () => {
  const owner = createToolResultPresentationOwner({enabled: true, budgetTokens: budget}, cause)!;
  const canonical = [assistant(["completed"], usage), toolResult("completed", [{type:"text",text:"result data ".repeat(300)}])];
  const before = structuredClone(canonical);
  try {
    assert.throws(() => owner.projectMessagesForModel(canonical.slice(), undefined, undefined, undefined, window, output, planning), error => {
      assert.ok(error instanceof ToolResultContinuationError);
      assert.equal(error.code, "budget-too-small");
      assert.ok(Number.isSafeInteger(error.minimumTokens) && error.minimumTokens! > 0);
      assert.match(error.message, new RegExp(`Request preparation blocked: ${cause}`));
      for (const field of ["context=", "nonCurrentInput=", "requestedOutput=", "batchBudget="]) assert.ok(error.message.includes(field));
      assert.doesNotMatch(error.message, /unavailable|undefined/);
      if (cause === "context-headroom") assert.doesNotMatch(error.message, /Adjust the result budget/);
      return true;
    });
    assert.deepEqual(canonical, before);
    assert.equal(owner.counters.activeContextualCoordinators, 0);
  } finally { owner.dispose(); }
  assert.equal(owner.counters.projectionRecordEntries, 0);
});

test("R1.2 sender distinguishes invalid model parameters, invalid output request, and actual context exhaustion", () => {
  for (const [model, cap, reason] of [
    [{...REQUEST_ESTIMATE_MODEL, contextWindow: Number.NaN}, 4096, "model-parameters"],
    [{...REQUEST_ESTIMATE_MODEL, maxTokens: 0}, 4096, "model-parameters"],
    [REQUEST_ESTIMATE_MODEL, 0, "output-reservation"],
    [{...REQUEST_ESTIMATE_MODEL, contextWindow: 4096}, 4096, "context-headroom"],
  ] as const) assert.throws(() => clampMaxTokensToContext(model, {messages:[]}, cap), error => {
    assert.ok(error instanceof RequestBudgetError);
    assert.equal(error.reason, reason);
    return true;
  });
});
