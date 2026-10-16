import assert from "node:assert/strict";
import test from "node:test";
import { createToolResultPresentationOwner } from "../packages/coding-agent/src/core/tool-result-presentation.ts";
import { estimateToolOutputTokens } from "../packages/coding-agent/src/core/tool-output-budget.ts";
import { estimateContextTokensFromParts, estimateMessageTokens } from "../packages/ai/src/utils/estimate.ts";
import { assistant, toolResult, longText } from "./codemode-recovery/fixture.ts";
import { assertTextRecovery } from "./codemode-recovery/assertions.ts";

for (const largeIndex of [0, 9, 19]) test(`R1.3 twenty results reserve minima with the long result at ${largeIndex}`, () => {
  const owner = createToolResultPresentationOwner({enabled:true,budgetTokens:1024}, `batch-${largeIndex}`)!;
  const ids = Array.from({length:20}, (_,i)=>`result-${i}`);
  const source = [assistant(ids), ...ids.map((id,i)=>toolResult(id,[{type:"text",text:i===largeIndex?longText:"ok"}]))];
  const canonical = structuredClone(source);
  try {
    const projected = owner.projectMessagesForModel(source.slice(), undefined, undefined, undefined, 128000, 4096);
    assert.ok(projected.slice(1).reduce((n,m)=>n+estimateToolOutputTokens(m.content as never).estimatedTokens,0)<=1024);
	assert.equal(owner.counters.fullSourceEstimatorScans,20, "two-pass planning must not scan the complete inputs twice");
    assertTextRecovery(projected[largeIndex+1]!.content as never, longText, cursor=>owner.readContinuation(cursor,source,1024));
    assert.deepEqual(source,canonical);
    assert.equal(owner.counters.contextualPreparedRecords,0);
    assert.equal(owner.counters.activeContextualCoordinators,0);
  } finally {owner.dispose();}
  assert.equal(owner.counters.projectionRecordEntries,0);
  assert.equal(owner.counters.retainedProjectionCodeUnits,0);
});

test("R1.3 affordable image results do not need more expensive text recovery notices", () => {
  for (const withLongText of [false,true]) {
    const budget=withLongText?80:20;
    const owner=createToolResultPresentationOwner({enabled:true,budgetTokens:budget},`images-${withLongText}`)!;
    const source=[assistant(["a","b"]),toolResult("a",[{type:"image",mimeType:"image/png",data:"AA=="}]),
      toolResult("b",withLongText?[{type:"text",text:longText}]:[{type:"image",mimeType:"image/png",data:"AA=="}])];
    try {
      const result=owner.projectMessagesForModel(source.slice(),undefined,undefined,undefined,10000,1024);
      assert.equal(result[1],source[1]);
      assert.ok(result.slice(1).reduce((n,m)=>n+estimateToolOutputTokens(m.content as never).estimatedTokens,0)<=budget);
      assert.ok(estimateContextTokensFromParts(undefined,result,undefined).tokens+1024<=10000);
    } finally {owner.dispose();}
  }
});

test("R1.3 a full CJK batch uses independent tool and request-context costs",()=>{
  const source=[assistant(["a","b"]),toolResult("a",[{type:"text",text:"中".repeat(1000)}]),toolResult("b",[{type:"text",text:"文".repeat(1000)}])];
  const toolCost=source.slice(1).reduce((n,m)=>n+estimateToolOutputTokens(m.content as never).estimatedTokens,0);
  const contextCost=source.slice(1).reduce((n,m)=>n+estimateMessageTokens(m),0);
  assert.ok(toolCost>contextCost);
  const owner=createToolResultPresentationOwner({enabled:true,budgetTokens:toolCost},"full-cjk")!;
  try {
    const result=owner.projectMessagesForModel(source.slice(),undefined,undefined,undefined,
      estimateContextTokensFromParts(undefined,source,undefined).tokens+1024,1024);
    assert.equal(result[1],source[1]);assert.equal(result[2],source[2]);
    assert.equal(owner.counters.contextualChoiceCalls,0);
    assert.equal(owner.counters.contextualToolTokensConsumed,toolCost);
    assert.equal(owner.counters.contextualContextTokensConsumed,contextCost);
  }finally{owner.dispose();}
});

test("R1.3 preparation links are released after observer failure and cancellation", () => {
  for (const error of [new Error("observer failed"), new DOMException("cancelled","AbortError")]) {
    const owner=createToolResultPresentationOwner({enabled:true,budgetTokens:1024},error.name)!;
    const source=[assistant(["a","b"]),toolResult("a",[{type:"text",text:longText}]),toolResult("b",[{type:"text",text:"ok"}])];
    try {
      assert.throws(()=>owner.projectMessagesForModel(source.slice(),undefined,undefined,undefined,128000,4096,false,undefined,
        {recordToolResultProjection(){throw error;}}), candidate=>candidate===error);
      assert.equal(owner.counters.contextualPreparedRecords,0);
      assert.equal(owner.counters.activeContextualCoordinators,0);
      assert.doesNotThrow(()=>owner.projectMessagesForModel(source.slice(),undefined,undefined,undefined,128000,4096));
    } finally {owner.dispose();}
    assert.equal(owner.counters.retainedProjectionCodeUnits,0);
  }
});

test("R1.3 oversized batches bound temporary records and scan overflow only linearly", () => {
  const owner=createToolResultPresentationOwner({enabled:true,budgetTokens:4096},"capacity")!;
  const ids=Array.from({length:256},(_,i)=>`id-${i}`);
  const source=[assistant(ids),...ids.map(id=>toolResult(id,[{type:"text",text:"ok"}]))];
  try {
    const result=owner.projectMessagesForModel(source.slice(),undefined,undefined,undefined,128000,4096);
    assert.deepEqual(result,source);
    assert.equal(owner.counters.contextualPreparedRecordsHighWaterMark,128);
    assert.equal(owner.counters.contextualPreparedRecords,0);
    assert.equal(owner.counters.fullSourceEstimatorScans,384);
  } finally {owner.dispose();}
});
