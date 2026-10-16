import assert from "node:assert/strict";
import test from "node:test";
import {deriveModelCapabilities} from "../packages/ai/src/model-capabilities.ts";
import {buildBaseOptions,requestThinkingTokens,resolveRequestOutputFloor} from "../packages/ai/src/api/simple-options.ts";
import {estimateContextTokens} from "../packages/ai/src/utils/estimate.ts";
import {REQUEST_ESTIMATE_MODEL} from "./fixtures/request-input-estimate.ts";
import {assistant,toolResult,sessionFixture} from "./codemode-recovery/fixture.ts";

for(const api of ["google-generative-ai","google-vertex"] as const)test(`R1.1 ${api} reserves configured thinking and a usable answer through the real SDK`,async t=>{
  const f=await sessionFixture(t,{budgetTokens:16000});
  const model={...REQUEST_ESTIMATE_MODEL,api,id:"gemini-2.5-pro",reasoning:true,maxTokens:32768,contextWindow:15000,
    thinkingBudgetMap:{medium:8192,high:16384},capabilities:{...deriveModelCapabilities(REQUEST_ESTIMATE_MODEL),reasoning:{mode:"budget" as const,levels:["off","medium","high"] as const}}};
  f.session.agent.state.thinkingLevel="medium";
  const source=[assistant(["prior"]),toolResult("prior",[{type:"text",text:"result payload information ".repeat(4000)}])];
  const original=structuredClone(source);
  for(const custom of [undefined,{medium:4096}]){
    f.session.agent.thinkingBudgets=custom;
    const expectedThinking=custom?.medium??8192;
    assert.equal(requestThinkingTokens(model,"medium",custom),expectedThinking);
    const messages=await f.session.agent.convertToLlm(source,undefined,undefined,model,32768);
    assert.ok(estimateContextTokens({messages}).tokens+4096+1024+expectedThinking<=model.contextWindow);
    const sender=await import(`../packages/ai/src/api/${api}.ts`);
    let payload:any;
    const result=await sender.streamSimple(model,{messages},{reasoning:"medium",thinkingBudgets:custom,apiKey:"synthetic-fixture-token",maxRetries:0,
      project:"fixture",location:"us-central1",onPayload(value:unknown){payload=value;throw Error("captured-thinking-payload");}}).result();
    assert.ok(payload,result.errorMessage);
    assert.equal(payload.config.thinkingConfig.thinkingBudget,expectedThinking);
    assert.ok(payload.config.maxOutputTokens>=expectedThinking+1024);
    assert.ok(payload.config.maxOutputTokens+estimateContextTokens({messages}).tokens+4096<=model.contextWindow);
    assert.match(result.errorMessage??"",/captured-thinking-payload/);
  }
  assert.deepEqual(source,original);
  assert.equal(requestThinkingTokens(model,"off"),0);
  assert.throws(()=>buildBaseOptions(model,{messages:[]},{reasoning:"medium",maxTokens:8192}),/output-reservation.*minimumOutput=9216/);
  const sender=await import(`../packages/ai/src/api/${api}.ts`);
  let sent=false;
  const direct=await sender.stream({...model,contextWindow:6500},{messages:[]},{apiKey:"synthetic-fixture-token",maxRetries:0,thinking:{enabled:true,budgetTokens:8192},
    project:"fixture",location:"us-central1",onPayload(){sent=true;throw Error("should not send");}}).result();
  assert.equal(sent,false);assert.match(direct.errorMessage??"",/context-headroom.*minimumOutput=9216/);
  assert.equal(resolveRequestOutputFloor(model,32768,8192),9216);
});
