import assert from "node:assert/strict";
import test from "node:test";
import { stream } from "../packages/ai/src/api/openai-completions.ts";
import { stream as responses } from "../packages/ai/src/api/openai-responses.ts";
import { stream as azure } from "../packages/ai/src/api/azure-openai-responses.ts";
import { createOpenAICodexTransportOwner } from "../packages/ai/src/api/openai-codex-responses.ts";
import { zstdDecompressSync } from "node:zlib";
import { codexToken } from "./helpers/responses-sse-fixture.ts";
import { sseFrames, textEvents } from "./helpers/responses-sse-fixture.ts";
import { createAgentSession } from "../packages/coding-agent/src/core/sdk.ts";
import { SettingsManager } from "../packages/coding-agent/src/core/settings-manager.ts";
import { SessionManager } from "../packages/coding-agent/src/core/session-manager.ts";
import { DefaultResourceLoader } from "../packages/coding-agent/src/core/resource-loader.ts";
import { ALPHA_MODEL, alphaModelRuntime } from "./helpers/alpha-session.ts";
import { createOwnedTaskFixture } from "./helpers/owned-task-fixture.ts";
import { paddedPngFixture } from "./helpers/image-acceptance-fixtures.ts";

const ADAPTERS=[{api:"openai-completions",run:stream},{api:"openai-responses",run:responses},{api:"azure-openai-responses",run:azure}] as const;
function countWireImages(wire:any,api:string):number {
  let count=0;
  for(const message of api==="openai-completions"?wire.messages:wire.input) {
    const blocks=message.content??message.output;
    if(Array.isArray(blocks))for(const block of blocks)if(block.type==="image_url"||block.type==="input_image")count++;
  }
  return count;
}
function successResponse(api:string):Response {
  const text=api==="openai-completions"?'data: {"id":"fixture","choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":null}]}\n\ndata: {"id":"fixture","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n':sseFrames(textEvents());
  return new Response(text,{headers:{"content-type":"text/event-stream"}});
}

for(const adapter of ADAPTERS) for (const presentation of [false,true]) test(`oversized batch recovers after a new user message and text-only tool batch, api=${adapter.api}, presentation=${presentation}`, async t => {
  const owned = createOwnedTaskFixture("image-budget-recovery-"), root = owned.root;
  const model: any = {...ALPHA_MODEL,api:adapter.api,baseUrl:adapter.api==="azure-openai-responses"?"https://fixture.openai.azure.com/openai/deployments/fixture":ALPHA_MODEL.baseUrl,input:["text","image"],contextWindow:1000000};
  const settings = SettingsManager.inMemory({executionEnvironment:"trusted-host",compaction:{enabled:false},retry:{enabled:true,maxRetries:3,baseDelayMs:0},images:{autoResize:false}});
  const resources = new DefaultResourceLoader({cwd:root,agentDir:root,settingsManager:settings,noExtensions:true,noContextFiles:true,noSkills:true,noPromptTemplates:true,noThemes:true});
  await resources.reload();
  const uploads: {bytes:number;images:number}[] = [];
  const run=adapter.run as typeof stream;
  const runtime = alphaModelRuntime((target,context,options) => run(target as any,context,{...options,apiKey:"offline-fixture",maxRetries:0,
    fetch:async (_url,init) => {
      const wire = JSON.parse(init!.body as string), images=countWireImages(wire,adapter.api);
      uploads.push({bytes:Buffer.byteLength(init!.body as string),images});
      return successResponse(adapter.api);
    }}));
  runtime.getModel = () => model;
  const manager = SessionManager.inMemory(root);
  const {session} = await createAgentSession({cwd:root,agentDir:root,model,modelRuntime:runtime,settingsManager:settings,sessionManager:manager,resourceLoader:resources,noTools:"all",
    toolResultPresentation:presentation?{enabled:true,budgetTokens:100000}:undefined});
  t.after(async()=>{await session.abort();await (session as any)._codemode.close();session.dispose();await (session as any)._sessionLeaseRelease;owned.cleanup();});
  await session.bindExtensions({});
  const assistant: any = {role:"assistant",api:model.api,provider:model.provider,model:model.id,content:[{type:"toolCall",id:"oversized",name:"read",arguments:{path:"fixture.png"}}],stopReason:"toolUse",timestamp:0,
    usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}}};
  const data = paddedPngFixture(1920,1080,Math.ceil(2.2*1024*1024)).toString("base64");
  manager.appendMessage({role:"user",content:"Inspect six images",timestamp:0});
  manager.appendMessage(assistant);
  manager.appendMessage({role:"toolResult",toolCallId:"oversized",toolName:"read",content:Array.from({length:6},()=>({type:"image",data,mimeType:"image/png"})),isError:false,timestamp:0});
  session.agent.state.messages = manager.buildSessionContext().messages;
  await session.agent.continue();
  assert.equal(uploads.length,0,"current over-budget batch must not be silently dropped or uploaded");
  assert.match((session.messages.at(-1) as any).errorMessage,/current tool images exceed.*Send a new text message.*images.requestBudget/);
  await session.prompt("Continue with text; do not repeat the image tool");
  assert.equal(uploads.length,1); assert.equal(uploads[0]!.images,4);
  session.agent.state.messages.push({...assistant,content:[{type:"toolCall",id:"text-only",name:"read",arguments:{path:"notes.txt"}}]});
  session.agent.state.messages.push({role:"toolResult",toolCallId:"text-only",toolName:"read",content:[{type:"text",text:"text-only output"}],isError:false,timestamp:1});
  await session.agent.continue();
  assert.equal(uploads.length,2); assert.equal(uploads[1]!.images,4);
  assert.equal(session.messages.filter(message=>message.role==="toolResult" && message.toolCallId==="oversized").length,1);
  const original = session.messages.find(message=>message.role==="toolResult" && message.toolCallId==="oversized")!;
  assert.ok(original.role==="toolResult"); assert.equal(original.content.filter(block=>block.type==="image" && block.data===data).length,6);
  assert.equal(manager.getEntries().filter(entry=>entry.type==="compaction").length,0);
  assert.equal(session.requestImages.metrics.requestViewBytes,0);
  t.diagnostic(JSON.stringify({presentation,originalImageBytes:6*data.length,uploads,toolReplays:0,compactions:0}));
});

test("Codex session records actual compressed upload without automatic compaction or identical 413 replay",async t=>{
  const owned=createOwnedTaskFixture("codex-body-session-"),root=owned.root;
  const model:any={...ALPHA_MODEL,api:"openai-codex-responses",provider:"openai-codex",contextWindow:100000000};
  const settings=SettingsManager.inMemory({executionEnvironment:"trusted-host",compaction:{enabled:true},retry:{enabled:true,maxRetries:2,baseDelayMs:0}});
  const resourceLoader=new DefaultResourceLoader({cwd:root,agentDir:root,settingsManager:settings,noExtensions:true,noContextFiles:true,noSkills:true,noPromptTemplates:true,noThemes:true});await resourceLoader.reload();
  const owner=createOpenAICodexTransportOwner();let uploads=0,wireBytes=0,jsonBytes=0;
  const runtime=alphaModelRuntime((target,context,options)=>owner.stream(target as any,context,{...options,apiKey:codexToken(),transport:"sse",maxRetries:1,
    fetch:async(_url,init)=>{uploads++;wireBytes=(init!.body as Uint8Array).byteLength;jsonBytes=Buffer.byteLength(zstdDecompressSync(init!.body as Uint8Array).toString());return new Response(null,{status:413});}}));
  runtime.getModel=()=>model;
  const sessionManager=SessionManager.inMemory(root);
  const {session}=await createAgentSession({cwd:root,agentDir:root,model,modelRuntime:runtime,settingsManager:settings,sessionManager,resourceLoader,noTools:"all"});
  t.after(async()=>{await session.abort();await (session as any)._codemode.close();session.dispose();await (session as any)._sessionLeaseRelease;await owner.dispose();owned.cleanup();});
  await session.bindExtensions({});await session.prompt("TEXT".repeat(2*1024*1024));
  assert.equal(uploads,1);assert.equal(session.requestImages.metrics.uploads,1);
  assert.equal(session.requestImages.metrics.wireBytes,wireBytes);assert.equal(session.requestImages.metrics.serializedJsonBytes,jsonBytes);
  assert.ok(wireBytes<jsonBytes);assert.equal(sessionManager.getEntries().filter(entry=>entry.type==="compaction").length,0);
  assert.match((session.messages.at(-1) as any).errorMessage,/REQUEST_BODY_TOO_LARGE/);
});

for(const adapter of ADAPTERS) for (const presentation of [false,true]) for (const failure of ["once","twice","blocked","same","connection","text-only","bare413","no-images","api-switch"] as const) test(`actual serializer: api=${adapter.api}, presentation=${presentation}, payload=${failure}`, async t => {
  const owned = createOwnedTaskFixture("image-budget-session-"), root = owned.root;
  const model: any = { ...ALPHA_MODEL, api:adapter.api,reasoning:adapter.api!=="openai-completions",baseUrl:adapter.api==="azure-openai-responses"?"https://fixture.openai.azure.com/openai/deployments/fixture":ALPHA_MODEL.baseUrl, input:failure==="text-only"?["text"]:["text","image"], contextWindow:failure==="no-images"?100000000:1000000 };
  const reasoning={type:"reasoning",id:"rs_history",summary:[],encrypted_content:"synthetic_opaque_history"};
  const settings = SettingsManager.inMemory({ executionEnvironment:"trusted-host", compaction:{enabled:failure==="no-images"}, retry:{enabled:failure==="connection",maxRetries:1,baseDelayMs:0},
    images:{autoResize:failure==="once"&&adapter.api!=="openai-completions",blockImages:failure==="blocked"} });
  const resources = new DefaultResourceLoader({cwd:root,agentDir:root,settingsManager:settings,noExtensions:true,noContextFiles:true,noSkills:true,noPromptTemplates:true,noThemes:true});
  await resources.reload();
  const uploads: {bytes:number;images:number}[] = [];
  const run=adapter.run as typeof stream;
  const runtime = alphaModelRuntime((target,context,options) => run(target as any,context,{...options,apiKey:"offline-fixture",maxRetries:0,
    fetch: async (_url,init) => {
      const body = String(init?.body), wire = JSON.parse(body), images=countWireImages(wire,adapter.api);
      if(Array.isArray(wire.input)) {
        const calls=wire.input.filter((item:any)=>item.type==="function_call"),outputs=wire.input.filter((item:any)=>item.type==="function_call_output");
        assert.equal(calls.length,outputs.length);assert.ok(outputs.every((item:any)=>calls.some((call:any)=>call.call_id===item.call_id)));
        if(failure!=="no-images")assert.deepEqual(wire.input.find((item:any)=>item.type==="reasoning"),reasoning);
      }
      uploads.push({bytes:Buffer.byteLength(body),images});
      if (failure === "connection" && uploads.length === 1) throw new Error("synthetic connection failure");
      if(failure==="api-switch"&&uploads.length===1)session.agent.state.model={...model,api:adapter.api==="openai-responses"?"azure-openai-responses":"openai-responses"};
      assert.doesNotMatch(body,/cacheSourceBytes|requestViews/);
      if(failure==="bare413"&&uploads.length===1)return new Response(null,{status:413});
      if(failure==="no-images")return new Response(JSON.stringify({error:{message:"request_too_large"}}),{status:413,headers:{"content-type":"application/json"}});
      if (failure!=="blocked" && failure!=="text-only" && (uploads.length===1 || failure==="twice" || failure==="connection" && uploads.length===2)) return new Response(JSON.stringify({error:{message:"Failed to buffer the request body: length limit exceeded",type:"request_too_large"}}),{status:413,headers:{"content-type":"application/json"}});
      return successResponse(adapter.api);
    }}));
  runtime.getModel = () => model;
  const manager = SessionManager.inMemory(root);
  const {session} = await createAgentSession({cwd:root,agentDir:root,model,modelRuntime:runtime,settingsManager:settings,sessionManager:manager,resourceLoader:resources,noTools:"all",
    toolResultPresentation:presentation?{enabled:true,budgetTokens:100000}:undefined});
  t.after(async()=>{await session.abort(); await (session as any)._codemode.close(); session.dispose(); await (session as any)._sessionLeaseRelease; owned.cleanup();});
  await session.bindExtensions({});
  const data=failure==="text-only"?"A".repeat(13*1024*1024):paddedPngFixture().toString("base64"), images:any[]=[];
  manager.appendMessage({role:"user",content:failure==="no-images"?"TEXT".repeat(2*1024*1024):"synthetic historical image inspection",timestamp:0});
  const imageCount = failure==="no-images"?0:failure === "same" || failure === "text-only" ? 1 : 44;
  for (let i=0;i<imageCount;i++) {
    const id="history-"+i;
    manager.appendMessage({role:"assistant",api:model.api,provider:model.provider,model:model.id,content:[...(i===0&&model.reasoning?[{type:"thinking" as const,thinking:"",thinkingSignature:JSON.stringify(reasoning)}]:[]),{type:"toolCall",id,name:"read",arguments:{path:"synthetic.png"}}],stopReason:"toolUse",timestamp:i,
      usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}}});
    const image={type:"image" as const,data,mimeType:"image/png"}; images.push(image);
    manager.appendMessage({role:"toolResult",toolCallId:id,toolName:"read",content:[image],isError:false,timestamp:i});
  }
  session.agent.state.messages=manager.buildSessionContext().messages;
  const originalImageChars=imageCount*data.length;
  await session.prompt("continue inspecting the existing results");
  assert.equal(uploads.length,failure==="blocked" || failure==="same" || failure==="text-only"||failure==="no-images"||failure==="api-switch"?1:failure==="connection"?3:2);
  if (failure==="blocked" || failure==="text-only"||failure==="no-images") assert.equal(uploads[0]!.images,0);
  else if (failure === "same") assert.match((session.messages.at(-1) as any).errorMessage, /Request preparation blocked: image recovery/);
  else { assert.ok(uploads[0]!.images<44); if(failure!=="api-switch")assert.ok(uploads.at(-1)!.bytes<uploads[0]!.bytes); }
  if (failure === "twice") assert.match((session.messages.at(-1) as any).errorMessage,/REQUEST_BODY_TOO_LARGE.*reduce images/);
  if(failure==="no-images")assert.match((session.messages.at(-1) as any).errorMessage,/REQUEST_BODY_TOO_LARGE/);
  let retained=0;
  for (const m of session.messages) if (m.role==="toolResult") for (const b of m.content) if (b.type==="image") retained+=b.data.length;
  assert.equal(retained,originalImageChars); assert.ok(images.every(image=>image.data===data));
  assert.equal(manager.getEntries().filter(entry=>entry.type==="compaction").length,0);
  assert.equal(session.requestImages.metrics.uploads,uploads.length);
  assert.equal(session.requestImages.metrics.requestViewBytes,0,"assistant settlement releases request-owned views");
  if(failure==="once"&&adapter.api!=="openai-completions")assert.ok(session.requestImages.metrics.encodes>0,"native Responses exercises the actual image encoder");
  t.diagnostic(JSON.stringify({presentation,failure,uploads,canonicalImageChars:retained}));
});
