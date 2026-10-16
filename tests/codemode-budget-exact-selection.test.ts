import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import test from "node:test";
import {createToolResultPresentationOwner, createToolResultPresentationCounters, ToolResultContinuationError} from "../packages/coding-agent/src/core/tool-result-presentation.ts";
import {ToolResultBudgetSelection, ToolResultBudgetComputationError, RESULT_SELECTION_MAX_BYTES, RESULT_SELECTION_MAX_STATES, RESULT_SELECTION_MAX_STEPS} from "../packages/coding-agent/src/core/tool-result-budget-selection.ts";
import {estimateContextTokensFromParts,estimateMessageTokens} from "../packages/ai/src/utils/estimate.ts";
import {estimateToolOutputTokens} from "../packages/coding-agent/src/core/tool-output-budget.ts";
import {assistant,toolResult,longText,sessionFixture} from "./codemode-recovery/fixture.ts";
import {REQUEST_ESTIMATE_MODEL} from "./fixtures/request-input-estimate.ts";

const image={type:"image" as const,mimeType:"image/png",data:"AA=="};
function trade(imageCount=1,reverse=true) {
  const results=[toolResult("0",[{type:"text",text:"x"},...Array.from({length:imageCount},()=>image)]),toolResult("1",[image])];
  if(reverse)results.reverse();
  const source=[assistant(results.map(m=>m.toolCallId)),...results];
  const base=estimateContextTokensFromParts(undefined,source,undefined).tokens-results.reduce((s,m)=>s+estimateMessageTokens(m),0);
  return {source,contextWindow:base+5120+1200*imageCount+32};
}
for(const imageCount of [1,2])for(const reverse of [false,true])test(`R1.3 exact fallback admits the feasible ${imageCount}-image trade in order reverse=${reverse}`,()=>{
  const {source,contextWindow}=trade(imageCount,reverse);
  const original=structuredClone(source);
  const owner=createToolResultPresentationOwner({enabled:true,budgetTokens:57},"trade")!;
  try {
    const result=owner.projectMessagesForModel(source.slice(),undefined,undefined,undefined,contextWindow,1024,true);
    assert.ok(result.slice(1).reduce((s,m)=>s+estimateToolOutputTokens(m.content as never).estimatedTokens,0)<=57);
    assert.ok(estimateContextTokensFromParts(undefined,result,undefined).tokens+5120<=contextWindow);
    assert.equal(result.find(m=>m.role==="toolResult"&&m.toolCallId==="0"),source.find(m=>m.role==="toolResult"&&m.toolCallId==="0"));
    const omitted=result.find(m=>m.role==="toolResult"&&m.toolCallId==="1")! as ReturnType<typeof toolResult>;
    const notice=omitted.content.find(b=>b.type==="text") as {text:string};
    const cursor=notice.text.match(/cursor (tr1\.[^.]+(?:\.[^\s.]+)+)\./)?.[1];
    assert.ok(cursor);
    const restored=owner.readContinuation(cursor,source,1024);
    assert.deepEqual(restored.content,[image]);assert.equal(restored.done,true);
    assert.equal(owner.counters.contextualChoiceCalls,reverse?1:0);
    assert.equal(owner.counters.contextualChoiceActivePlans,0);
    assert.equal(owner.counters.contextualChoiceActiveBytes,0);
    assert.deepEqual(source,original);
  } finally {owner.dispose();}
});

test("R1.3 exact search still refuses genuine result and context exhaustion",()=>{
  for(const budget of [9,56]) {
    const {source,contextWindow}=trade();
    const owner=createToolResultPresentationOwner({enabled:true,budgetTokens:budget},"trade")!;
    try {
      assert.throws(()=>owner.projectMessagesForModel(source.slice(),undefined,undefined,undefined,contextWindow,1024,true),e=>{
        assert.ok(e instanceof ToolResultContinuationError);assert.equal(e.code,"budget-too-small");
        assert.match(e.message,budget===9?/result-batch-budget/:/context-headroom/);return true;
      });
      assert.equal(owner.counters.contextualChoiceCalls,1);
      assert.equal(owner.counters.contextualChoiceActivePlans,0);
      assert.equal(owner.counters.contextualChoiceActiveBytes,0);
    } finally {owner.dispose();}
  }
});

test("R1.3 resource exhaustion has a separate SDK-visible cause, counts and deterministic limits",async t=>{
  const f=await sessionFixture(t,{budgetTokens:8000});
  const ids=Array.from({length:256},(_,i)=>String(i));
  const source=[assistant(ids),...ids.map(id=>toolResult(id,[image]))];
  const original=structuredClone(source);
  const model={...REQUEST_ESTIMATE_MODEL,contextWindow:65536,maxTokens:1024};
  assert.throws(()=>f.session.agent.convertToLlm(source,undefined,undefined,model,1024),e=>{
    assert.ok(e instanceof ToolResultBudgetComputationError,String(e));
    assert.equal(e.code,"result-budget-computation-exhausted");
    assert.equal(e.checkedStates,0);assert.equal(e.stateLimit,RESULT_SELECTION_MAX_STATES);
    assert.ok(e.requiredStates>e.stateLimit);assert.match(e.message,/checkedStates=0.*statesLimit=1048576/);
    assert.match(e.message,/computation-resource-limit/);assert.doesNotMatch(e.message,/result-batch-budget|minimumNotice/);
    return true;
  });
  assert.deepEqual(source,original);
});

test("R1.3 state, step and memory limits are separate and release allocated scratch on failure",()=>{
  for(const kind of ["states","steps","memory"] as const) {
    const counters=createToolResultPresentationCounters();
    let plan:ToolResultBudgetSelection|undefined;
    try {
      assert.throws(()=>{
        const count=kind==="states"?256:kind==="steps"?1024:30000;
        plan=new ToolResultBudgetSelection(count,counters);
        for(let i=0;i<count;i++)plan.set(i,kind==="steps"?1024:56,31,1,1201,false);
        plan.solve(kind==="steps"?2047:8000,100);
      },e=>{
        assert.ok(e instanceof ToolResultBudgetComputationError);assert.equal(e.limit,kind);
        assert.equal(e.checkedStates,0);assert.equal(e.stateLimit,RESULT_SELECTION_MAX_STATES);
        assert.equal(e.stepLimit,RESULT_SELECTION_MAX_STEPS);assert.equal(e.memoryLimit,RESULT_SELECTION_MAX_BYTES);
        return true;
      });
    } finally {plan?.dispose();}
    assert.equal(counters.contextualChoiceResourceFailures,1);
    assert.equal(counters.contextualChoiceActivePlans,0);
    assert.equal(counters.contextualChoiceActiveBytes,0);
  }
});

test("R1.3 common-path allocation and structural counters match the pre-fallback implementation",()=>{
  // Captured from 248d373e6 before adding the exact fallback; no R0 assertion changed.
  const baseline=JSON.parse(readFileSync("tests/fixtures/codemode-budget-fast-counters.json","utf8"));
  for(const count of [2,20,256]) {
    const ids=Array.from({length:count},(_,i)=>"id-"+i);
    const source=[assistant(ids),...ids.map((id,i)=>toolResult(id,[{type:"text",text:i===0?longText:"ok"}]))];
    const owner=createToolResultPresentationOwner({enabled:true,budgetTokens:Math.max(1024,count*4)},"fast-path")!;
    owner.projectMessagesForModel(source.slice(),undefined,undefined,undefined,128000,4096);owner.dispose();
    for(const [key,value] of Object.entries(baseline[count]))assert.equal((owner.counters as any)[key],value,`${count}/${key}`);
    for(const [key,value] of Object.entries(owner.counters))if(key.startsWith("contextualChoice"))assert.equal(value,0,key);
  }
});

test("R1.3 exhausted search reports tool and context costs from one attainable selection",()=>{
  const plan=new ToolResultBudgetSelection(2,createToolResultPresentationCounters());
  try {
    plan.set(0,2,100,5,30,false);plan.set(1,2,100,6,20,false);
    assert.equal(plan.solve(8,100),false);
    assert.equal(plan.toolTokens,8);assert.equal(plan.contextTokens,120);
  }finally{plan.dispose();}
});

test("R1.3 exact selection agrees with exhaustive enumeration for both input orders",()=>{
  let seed=42;
  function nextInt(max:number){seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed%max;}
  for(let iteration=0;iteration<1000;iteration++) {
    const n=1+nextInt(8);
    const costs=Array.from({length:n},()=>({mt:1+nextInt(30),mc:1+nextInt(50),ft:1+nextInt(30),fc:1+nextInt(50)}));
    const tb=1+nextInt(150),cb=1+nextInt(200);
    let feasible=false;
    for(let mask=0;mask<(1<<n);mask++) {
      let tool=0,context=0;
      for(let i=0;i<n;i++){const c=costs[i]!;tool+=mask&(1<<i)?c.ft:c.mt;context+=mask&(1<<i)?c.fc:c.mc;}
      if(tool<=tb&&context<=cb)feasible=true;
    }
    for(const rows of [costs,costs.slice().reverse()]) {
      const plan=new ToolResultBudgetSelection(n,createToolResultPresentationCounters());
      try {
        rows.forEach((c,i)=>plan.set(i,c.mt,c.mc,c.ft,c.fc,false));assert.equal(plan.solve(tb,cb),feasible);
        if(feasible) {
          const tool=rows.reduce((s,c,i)=>s+(plan.keepsFullSource(i)?c.ft:c.mt),0);
          const context=rows.reduce((s,c,i)=>s+(plan.keepsFullSource(i)?c.fc:c.mc),0);
          assert.equal(plan.toolTokens,tool);assert.equal(plan.contextTokens,context);
          assert.ok(tool<=tb&&context<=cb);
        }
      }
      finally {plan.dispose();}
    }
  }
});

for(const count of [129,257])test(`R1.3 exact choices survive beyond the ${count}-result cache boundary`,()=>{
  const {source:pair}=trade();
  const prefix=Array.from({length:count-2},(_,i)=>toolResult("prefix-"+i,[{type:"text",text:"ok"}]));
  const results=[...prefix,...pair.slice(1)] as ReturnType<typeof toolResult>[];
  const source=[assistant(results.map(m=>m.toolCallId)),...results];
  const prefixTool=prefix.reduce((s,m)=>s+estimateToolOutputTokens(m.content).estimatedTokens,0);
  const prefixContext=prefix.reduce((s,m)=>s+estimateMessageTokens(m),0);
  const base=estimateContextTokensFromParts(undefined,source,undefined).tokens-results.reduce((s,m)=>s+estimateMessageTokens(m),0);
  const owner=createToolResultPresentationOwner({enabled:true,budgetTokens:prefixTool+57},"trade")!;
  try {
    const result=owner.projectMessagesForModel(source.slice(),undefined,undefined,undefined,base+5120+prefixContext+1232,1024,true);
    assert.equal(owner.counters.contextualChoiceCalls,1);
    assert.equal(owner.counters.contextualPreparedRecords,0);
    assert.equal(owner.counters.contextualChoiceActiveBytes,0);
    assert.ok(owner.counters.contextualChoicePeakBytes!<=RESULT_SELECTION_MAX_BYTES);
    assert.equal(owner.counters.fullSourceEstimatorScans,count+3*(count-128));
    assert.ok(result.slice(1).reduce((s,m)=>s+estimateToolOutputTokens(m.content as never).estimatedTokens,0)<=prefixTool+57);
    const omitted=result.find(m=>m.role==="toolResult"&&m.toolCallId==="1")!;
    const cursor=(omitted.content[0] as {text:string}).text.match(/cursor (tr1\.[^.]+(?:\.[^\s.]+)+)\./)?.[1];
    assert.ok(cursor);assert.deepEqual(owner.readContinuation(cursor,source,1024).content,[image]);
  } finally {owner.dispose();}
});
