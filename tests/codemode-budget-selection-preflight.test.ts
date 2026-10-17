import assert from "node:assert/strict";
import test from "node:test";
import { createToolResultPresentationCounters } from "../packages/coding-agent/src/core/tool-result-presentation.ts";
import { ToolResultBudgetComputationError, ToolResultBudgetSelection } from "../packages/coding-agent/src/core/tool-result-budget-selection.ts";

for (const budget of [16_000, 100_000]) test(`R1.3 linear proof rejects impossible context at tool budget ${budget} without DP`, () => {
  const counters = createToolResultPresentationCounters();
  const plan = new ToolResultBudgetSelection(3, counters);
  try {
    for (let i = 0; i < 3; i++) plan.set(i, 100, 5000, 30_000, 4000, false);
    assert.equal(plan.solve(budget, 10_000), false);
    assert.ok(plan.toolTokens <= budget);
    assert.ok(plan.contextTokens > 10_000);
    assert.equal(counters.contextualChoiceAllocatedBackingBytes, 3 * 6 * 8);
    assert.equal(counters.contextualChoiceResourceFailures, 0);
  } finally { plan.dispose(); }
  assert.equal(counters.contextualChoiceStates, 0);
  assert.equal(counters.contextualChoiceSteps, 6);
  assert.equal(counters.contextualChoiceActiveBytes, 0);
  assert.equal(counters.contextualChoiceActivePlans, 0);
});

test("R1.3 all affordable beneficial alternatives are selected without a DP workspace", () => {
  const counters = createToolResultPresentationCounters();
  const plan = new ToolResultBudgetSelection(3, counters);
  try {
    plan.set(0, 100, 5000, 30_000, 4000, false);
    // A context-saving alternative can be the notice rather than the source.
    plan.set(1, 30_000, 4000, 100, 5000, false);
    plan.set(2, 100, 5000, 30_000, 4000, false);
    assert.equal(plan.solve(100_000, 13_000), true);
    assert.deepEqual([0, 1, 2].map(i => plan.keepsFullSource(i)), [true, false, true]);
    assert.equal(plan.toolTokens, 90_000);
    assert.equal(plan.contextTokens, 12_000);
    assert.equal(plan.bodyResults, 1);
    assert.equal(counters.contextualChoiceAllocatedBackingBytes, 3 * 6 * 8);
  } finally { plan.dispose(); }
  assert.equal(counters.contextualChoiceStates, 0);
  assert.equal(counters.contextualChoiceSteps, 12);
  assert.equal(counters.contextualChoiceActiveBytes, 0);
});

test("R1.3 an individually unaffordable alternative contributes neither gain nor width", () => {
  for (const contextBudget of [8000, 6000]) {
    const counters = createToolResultPresentationCounters();
    const plan = new ToolResultBudgetSelection(3, counters);
    try {
      plan.set(0, 100, 5000, 1_000_000_000, 0, false);
      plan.set(1, 100, 5000, 30_000, 1000, false);
      plan.set(2, 100, 5000, 30_000, 1000, false);
      assert.equal(plan.solve(100_000, contextBudget), contextBudget === 8000);
      if (contextBudget === 8000) {
        assert.deepEqual([0, 1, 2].map(i => plan.keepsFullSource(i)), [false, true, true]);
        assert.equal(plan.toolTokens, 60_100);
        assert.equal(plan.contextTokens, 7000);
      }
      assert.equal(counters.contextualChoiceAllocatedBackingBytes, 3 * 6 * 8);
      assert.equal(counters.contextualChoiceResourceFailures, 0);
    } finally { plan.dispose(); }
    assert.equal(counters.contextualChoiceStates, 0);
    assert.equal(counters.contextualChoiceActiveBytes, 0);
  }
});

test("R1.3 genuine unresolved combinations still report the memory limit", () => {
  const counters = createToolResultPresentationCounters();
  const plan = new ToolResultBudgetSelection(3, counters);
  try {
    for (let i = 0; i < 3; i++) plan.set(i, 100, 5000, 30_000, 4000, false);
    assert.throws(() => plan.solve(70_000, 13_000), error => {
      assert.ok(error instanceof ToolResultBudgetComputationError);
      assert.equal(error.limit, "memory");
      assert.equal(error.checkedStates, 0);
      assert.equal(error.checkedSteps, 6);
      assert.ok(error.requiredBytes > error.memoryLimit);
      return true;
    });
  } finally { plan.dispose(); }
  assert.equal(counters.contextualChoiceActiveBytes, 0);
  assert.equal(counters.contextualChoiceActivePlans, 0);
});
