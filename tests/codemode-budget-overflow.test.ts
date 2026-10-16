import assert from "node:assert/strict";
import test from "node:test";
import { createToolResultPresentationOwner, ToolResultContinuationError } from "../packages/coding-agent/src/core/tool-result-presentation.ts";
import { estimateToolOutputTokens } from "../packages/coding-agent/src/core/tool-output-budget.ts";
import { assistant, toolResult } from "./codemode-recovery/fixture.ts";
import { assertTextRecovery } from "./codemode-recovery/assertions.ts";

for(const longCount of [128,256])test(`R1.3 a cheaper full source after ${longCount} records participates in feasibility and delivery`,()=>{
  const text="diagnostic line\n".repeat(8000);
  const ids=Array.from({length:longCount},(_,i)=>`long-${i}`);
  const longs=ids.map(id=>toolResult(id,[{type:"text",text}]));
  const probe=createToolResultPresentationOwner({enabled:true,budgetTokens:1024},"overflow-boundary")!;
  let required=0;
  try {
    assert.throws(()=>probe.projectMessagesForModel([assistant(ids),...longs],undefined,undefined,undefined,1_000_000,1),error=>{
      assert.ok(error instanceof ToolResultContinuationError);
      assert.match(error.message,/result-batch-budget/);
      required=error.minimumTokens!;assert.ok(required>1024);return true;
    });
  } finally {probe.dispose();}
  const image=toolResult("last-image",[{type:"image",mimeType:"image/png",data:"AA=="}]);
  const budget=required+estimateToolOutputTokens(image.content).estimatedTokens;
  const source=[assistant([...ids,"last-image"]),...longs,image];
  const owner=createToolResultPresentationOwner({enabled:true,budgetTokens:budget},"overflow-boundary")!;
  try {
    const projected=owner.projectMessagesForModel(source.slice(),undefined,undefined,undefined,1_000_000,1);
    assert.equal(projected.at(-1),image,"the feasible full image must survive the second pass too");
    assert.ok(projected.slice(1).reduce((sum,m)=>sum+estimateToolOutputTokens(m.content as never).estimatedTokens,0)<=budget);
    assertTextRecovery(projected[1]!.content as never,text,cursor=>owner.readContinuation(cursor,source,1024));
    assertTextRecovery(projected[longCount]!.content as never,text,cursor=>owner.readContinuation(cursor,source,1024));
    assert.ok((owner.counters.contextualPreparedRecordsHighWaterMark??0)<=128);
    assert.equal(owner.counters.contextualPreparedRecords,0);
    assert.equal(owner.counters.activeContextualCoordinators,0);
    assert.equal(longs[0]!.content[0]!.type,"text");
    assert.equal((longs[0]!.content[0] as {text:string}).text,text);
  } finally {owner.dispose();}
  assert.equal(owner.counters.retainedProjectionCodeUnits,0);
});
