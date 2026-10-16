import assert from "node:assert/strict";
import test from "node:test";
import { buildBaseOptions, clampMaxTokensToContext, usesAdaptiveRequestBudget } from "../packages/ai/src/api/simple-options.ts";
import { contextForModelCapabilities, deriveModelCapabilities } from "../packages/ai/src/model-capabilities.ts";
import { estimateContextTokens, estimateContextTokensFromParts, estimateMessageTokens } from "../packages/ai/src/utils/estimate.ts";
import { REQUEST_ESTIMATE_MODEL } from "./fixtures/request-input-estimate.ts";
import { createToolResultPresentationOwner } from "../packages/coding-agent/src/core/tool-result-presentation.ts";
import { assistant, toolResult, sessionFixture } from "./codemode-recovery/fixture.ts";

const noToolsModel={...REQUEST_ESTIMATE_MODEL,contextWindow:8192,maxTokens:128000,
  capabilities:{...deriveModelCapabilities(REQUEST_ESTIMATE_MODEL),toolCalling:false}};
const tools=[{name:"unused",description:"schema text ".repeat(10000),parameters:{type:"object",properties:{}}}];

test("R1.1 unknown extension APIs keep their fixed output-reservation contract",()=>{
  assert.equal(usesAdaptiveRequestBudget("extension-native-api"),false);
  assert.equal(usesAdaptiveRequestBudget(undefined),false);
});

test("R1.1 sender budgets omit unsupported tool schemas and image tool history",()=>{
  const messages=[assistant(["prior"]),toolResult("prior",Array.from({length:20},()=>({type:"image" as const,mimeType:"image/png",data:"AA=="})))];
  const context={messages,tools};
  const wire=contextForModelCapabilities(noToolsModel,context);
  const expected=noToolsModel.contextWindow-estimateContextTokens(wire).tokens-4096;
  assert.ok(expected>1024);
  assert.equal(buildBaseOptions(noToolsModel,context).maxTokens,expected);
});

test("R1.1 capability-aware estimates equal actual normalized context without materializing result copies",()=>{
  for(const contents of [[],[{type:"text" as const,text:""}],[{type:"text" as const,text:"a"},{type:"text" as const,text:"b"}],
    [{type:"image" as const,mimeType:"image/png",data:"AA=="}]]){
    const messages=[assistant(["prior"]),toolResult("prior",contents)];
    const context={systemPrompt:"system",messages,tools};
    const wire=contextForModelCapabilities(noToolsModel,context);
    assert.deepEqual((estimateContextTokensFromParts as any)(context.systemPrompt,messages,tools,false),estimateContextTokens(wire));
    assert.equal((estimateMessageTokens as any)(messages[1],false),estimateMessageTokens(wire.messages[1]!));
  }
  const empty=assistant([],9000);empty.timestamp=0;
  const context={messages:[empty,{role:"user" as const,content:"later",timestamp:2}],tools};
  assert.deepEqual((estimateContextTokens as any)(context,false),estimateContextTokens(contextForModelCapabilities(noToolsModel,context)));
});

test("R1.1 SDK projection uses capability-normalized costs while retaining canonical tool results",async t=>{
  const f=await sessionFixture(t);
  const source=[assistant(["prior"]),toolResult("prior",Array.from({length:20},()=>({type:"image" as const,mimeType:"image/png",data:"AA=="})))];
  const original=structuredClone(source);
  const projected=await f.session.agent.convertToLlm(source,undefined,tools as never,noToolsModel,1024);
  const wire=contextForModelCapabilities(noToolsModel,{messages:projected,tools});
  assert.ok(estimateContextTokens(wire).tokens+1024+4096<=noToolsModel.contextWindow);
  assert.equal(clampMaxTokensToContext(noToolsModel,{messages:projected,tools},1024),1024);
  assert.deepEqual(source,original);
});

for(const api of ["openai-responses","azure-openai-responses"] as const)test(`R1.1 ${api} plans its 16-token wire floor before retaining result bodies`,async t=>{
  const f=await sessionFixture(t);
  const source=[assistant(["prior"]),toolResult("prior",[{type:"image",mimeType:"image/png",data:"AA=="}])];
  const legacy=createToolResultPresentationOwner({enabled:true,budgetTokens:1024},"legacy-floor")!;
  let legacyMisses=0;
  t.after(()=>legacy.dispose());
  const used=estimateContextTokens({messages:source}).tokens;
  for(let headroom=1;headroom<16;headroom++){
    const contextWindow=used+4096+headroom;
    const model={...REQUEST_ESTIMATE_MODEL,api,contextWindow,maxTokens:128000};
    const messages=await f.session.agent.convertToLlm(source,undefined,undefined,model,1);
    assert.equal(clampMaxTokensToContext(model,{messages},1,16),16,`window=${contextWindow}`);
    const underReserved=legacy.projectMessagesForModel(source.slice(),undefined,undefined,undefined,contextWindow,1,true);
    try {clampMaxTokensToContext(model,{messages:underReserved},1,16);} catch {legacyMisses++;}
  }
  assert.equal(legacyMisses,15,"the same fixture with the old one-token reserve must miss the wire floor");
});

test("R1.1 SDK does not opt an extension sender into an unimplemented adaptive contract",async t=>{
  const f=await sessionFixture(t);
  const model={...REQUEST_ESTIMATE_MODEL,api:"extension-native-api",contextWindow:8192,maxTokens:128000};
  assert.throws(()=>f.session.agent.convertToLlm([assistant(["prior"]),toolResult("prior",[{type:"text",text:"ok"}])],undefined,undefined,model),/output-reservation/);
});
