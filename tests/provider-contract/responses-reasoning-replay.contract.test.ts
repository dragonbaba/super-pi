import assert from "node:assert/strict";
import test from "node:test";
import { zstdDecompressSync } from "node:zlib";
import { stream as responses } from "../../packages/ai/src/api/openai-responses.ts";
import { stream as azure } from "../../packages/ai/src/api/azure-openai-responses.ts";
import { stream as codex } from "../../packages/ai/src/api/openai-codex-responses.ts";
import { deriveModelCapabilities } from "../../packages/ai/src/model-capabilities.ts";
import { InMemoryModelsStore, MODELS_STORE_PROFILE_REVISION } from "../../packages/ai/src/models-store.ts";
import { createModels, createProvider } from "../../packages/ai/src/models.ts";
import { InMemoryCredentialStore } from "../../packages/ai/src/auth/credential-store.ts";
import type { Context, Model, StreamFunction } from "../../packages/ai/src/types.ts";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.ts";
import { createOwnedTaskFixture } from "../helpers/owned-task-fixture.ts";
import { codexToken, sseFrames } from "../helpers/responses-sse-fixture.ts";

const ADAPTERS = [
  {api:"openai-responses",run:responses},
  {api:"azure-openai-responses",run:azure},
  {api:"openai-codex-responses",run:codex},
] as const;
for (const adapter of ADAPTERS) for (const kind of ["encrypted-empty","plaintext"] as const)
for (const scene of ["default","reload","disabled","other-model","other-provider","other-api"] as const)
test(`${adapter.api} reasoning parser to next wire: ${kind}, ${scene}`,async t=>{
  const model: Model<any> = {id:"fixture",name:"fixture",api:adapter.api,provider:adapter.api==="openai-codex-responses"?"openai-codex":kind==="plaintext"?"deepseek":"openai",
    baseUrl:adapter.api==="azure-openai-responses"?"https://fixture.openai.azure.com/openai/deployments/fixture":"https://fixture.invalid/v1",
    reasoning:true,input:["text"],contextWindow:128000,maxTokens:128,cost:{input:0,output:0,cacheRead:0,cacheWrite:0}};
  if(scene==="disabled")model.capabilities={...deriveModelCapabilities(model),thoughtSignatureRoundTrip:false};
  const reasoning = kind==="encrypted-empty"
    ? {type:"reasoning",id:"rs_fixture",summary:[],encrypted_content:"synthetic_opaque"}
    : {type:"reasoning",id:"rs_fixture",content:[{type:"reasoning_text",text:"synthetic reasoning"}]};
  const message={type:"message",id:"msg_fixture",role:"assistant",phase:"commentary",content:[{type:"output_text",text:"Inspecting fixture",annotations:[]}]};
  const call={type:"function_call",id:"fc_fixture",call_id:"call_fixture",name:"inspect_fixture",arguments:"{}"};
  const events=[
    {type:"response.output_item.added",output_index:0,item:{type:"reasoning",id:reasoning.id}},
    {type:"response.output_item.done",output_index:0,item:reasoning},
    {type:"response.output_item.done",output_index:1,item:message},
    {type:"response.output_item.done",output_index:2,item:call},
    {type:"response.completed",response:{id:"resp_fixture",status:"completed",output:[reasoning,message,call]}},
  ];
  let requests=0,nextBody:any;
  const options={apiKey:adapter.api==="openai-codex-responses"?codexToken():"offline",transport:"sse" as const,maxRetries:0,
    fetch:async(_url:unknown,init?:RequestInit)=>{
      requests++;
      if(requests===2)nextBody=JSON.parse(typeof init!.body==="string"?init!.body:zstdDecompressSync(init!.body as Uint8Array).toString());
      return new Response(sseFrames(requests===1?events:[{type:"response.completed",response:{id:"resp_final",status:"completed",output:[]}}]),{headers:{"content-type":"text/event-stream"}});
    }};
  const run=adapter.run as StreamFunction<any,any>;
  const context:Context={messages:[{role:"user",content:"Inspect synthetic fixture",timestamp:0}],tools:[{name:call.name,description:"Read fixture",parameters:{type:"object",properties:{}}}]};
  const first=await run(model,context,options).result();
  assert.equal(first.stopReason,"toolUse",first.errorMessage);
  const thinking=first.content.find(block=>block.type==="thinking")!;
  assert.equal(thinking.type,"thinking");assert.deepEqual(JSON.parse(thinking.thinkingSignature!),reasoning);
  assert.equal(thinking.thinking,kind==="plaintext"?"synthetic reasoning":"");
  const tool=first.content.find(block=>block.type==="toolCall")!;assert.equal(tool.type,"toolCall");
  if(scene==="other-model")first.model="other";
  if(scene==="other-provider")first.provider="other";
  if(scene==="other-api")first.api="openai-completions";
  context.messages.push(first,{role:"toolResult",toolCallId:tool.id,toolName:tool.name,content:[{type:"text",text:"fixture result"}],isError:false,timestamp:1});
  if(scene==="reload"){
    const owned=createOwnedTaskFixture("responses-replay-");t.after(()=>owned.cleanup());
    const manager=SessionManager.create(owned.root,owned.root);
    for(const item of context.messages)manager.appendMessage(item);
    context.messages=SessionManager.open(manager.getSessionFile()!).buildSessionContext().messages as Context["messages"];
  }
  const before=JSON.stringify(context.messages);
  const second=await run(model,context,options).result();assert.equal(second.stopReason,"stop",second.errorMessage);
  assert.equal(requests,2);assert.equal(JSON.stringify(context.messages),before,"canonical messages are immutable");
  const replay=nextBody.input.find((item:any)=>item.type==="reasoning");
  if(scene==="default"||scene==="reload")assert.deepEqual(replay,reasoning);
  else assert.equal(replay,undefined);
  const output=nextBody.input.find((item:any)=>item.type==="function_call_output");
  assert.equal(output.call_id,nextBody.input.find((item:any)=>item.type==="function_call").call_id);
  if(scene==="default"||scene==="reload"||scene==="disabled")assert.equal(nextBody.input.find((item:any)=>item.type==="message"&&item.role==="assistant").phase,"commentary");
});

for(const source of ["current-raw","legacy-derived","explicit-disabled"] as const)test(`Responses catalog restore: ${source}`,async()=>{
  const raw:Model<"openai-responses">={id:"restored",name:"restored",api:"openai-responses",provider:"fixture",baseUrl:"https://fixture.invalid/v1",reasoning:true,input:["text"],contextWindow:128000,maxTokens:128,cost:{input:0,output:0,cacheRead:0,cacheWrite:0}};
  const stored=source==="current-raw"?raw:{...raw,capabilities:{...deriveModelCapabilities(raw),thoughtSignatureRoundTrip:false}};
  const store=new InMemoryModelsStore();
  await store.write("fixture",{models:[stored],checkedAt:1,...source!=="legacy-derived"?{profileRevision:MODELS_STORE_PROFILE_REVISION}:{}});
  const credentials=new InMemoryCredentialStore();await credentials.modify("fixture",async()=>({type:"api_key",key:"offline"}));
  const models=createModels({modelsStore:store,credentials});
  models.setProvider(createProvider<"openai-responses">({id:"fixture",auth:{apiKey:{name:"fixture",resolve:async()=>({auth:{apiKey:"offline"}})}},models:[],api:{stream:responses,streamSimple:responses},fetchModels:async()=>[]}));
  const result=await models.refresh({providers:["fixture"],allowNetwork:false});assert.equal(result.errors.size,0);
  assert.equal(models.getModel("fixture","restored")?.capabilities?.thoughtSignatureRoundTrip,source!=="explicit-disabled");
});
