import assert from "node:assert/strict";
import { Session } from "node:inspector/promises";
import { setImmediate as tick } from "node:timers/promises";
import { stream } from "../../packages/ai/src/api/openai-responses.ts";
import { deriveModelCapabilities } from "../../packages/ai/src/model-capabilities.ts";
import type { AssistantMessage, Context, Model } from "../../packages/ai/src/types.ts";

assert.ok(global.gc,"Run with --expose-gc");
const inspector=new Session();inspector.connect();
const refs:WeakRef<object>[]=[];
const REASONING_ITEMS=32,ITERATIONS=32;
const base:Model<"openai-responses">={id:"fixture",name:"fixture",api:"openai-responses",provider:"fixture",baseUrl:"https://fixture.invalid/v1",reasoning:true,input:["text"],contextWindow:1000000,maxTokens:128,cost:{input:0,output:0,cacheRead:0,cacheWrite:0}};
let wireBytes=0,reasoningItems=0;
async function fetchFixture(_url:unknown,init?:RequestInit):Promise<Response>{
  wireBytes=Buffer.byteLength(init!.body as string);
  const body=JSON.parse(init!.body as string);reasoningItems=0;
  for(const item of body.input)if(item.type==="reasoning")reasoningItems++;
  return new Response('data: {"type":"response.completed","response":{"id":"resp","status":"completed","output":[]}}\n\n',{headers:{"content-type":"text/event-stream"}});
}
async function measure(replay:boolean){
  const model={...base,capabilities:{...deriveModelCapabilities(base),thoughtSignatureRoundTrip:replay}};
  const context:Context={messages:[{role:"user",content:"Synthetic replay",timestamp:0}]};
  for(let i=0;i<REASONING_ITEMS;i++){
    const message:AssistantMessage={role:"assistant",api:model.api,provider:model.provider,model:model.id,stopReason:"stop",timestamp:i,
      usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}},
      content:[{type:"thinking",thinking:"summary",thinkingSignature:JSON.stringify({type:"reasoning",id:"rs_"+i,summary:[{type:"summary_text",text:"summary"}],encrypted_content:"synthetic_"+i+"x".repeat(2048)})},{type:"text",text:"answer",textSignature:JSON.stringify({v:1,id:"msg_"+i,phase:"final_answer"})}]};
    context.messages.push(message);
  }
  refs.push(new WeakRef(context),new WeakRef(context.messages),new WeakRef(context.messages[1]!));
  const options={apiKey:"offline",fetch:fetchFixture,maxRetries:0};
  for(let i=0;i<4;i++)await stream(model,context,options).result();
  global.gc!();const initialHeap=process.memoryUsage().heapUsed;
  await inspector.post("HeapProfiler.startSampling",{samplingInterval:1024,includeObjectsCollectedByMajorGC:true,includeObjectsCollectedByMinorGC:true});
  const times:number[]=[];
  for(let i=0;i<ITERATIONS;i++){const start=performance.now();assert.equal((await stream(model,context,options).result()).stopReason,"stop");times.push(performance.now()-start);}
  const peakHeap=process.memoryUsage().heapUsed,{profile}=await inspector.post("HeapProfiler.stopSampling");
  const pending=[profile.head],sites:{name:string;bytes:number}[]=[];let sampledBytes=0;
  while(pending.length){const node=pending.pop()!;sampledBytes+=node.selfSize;if(node.selfSize)sites.push({name:node.callFrame.functionName,bytes:node.selfSize});for(const child of node.children)pending.push(child);}
  sites.sort((a,b)=>b.bytes-a.bytes);times.sort((a,b)=>a-b);
  assert.equal(reasoningItems,replay?REASONING_ITEMS:0);
  return {replay,iterations:ITERATIONS,wireBytes,reasoningItems,sampledBytesPerRequest:sampledBytes/ITERATIONS,cpuP50:times[16],cpuP95:times[30],initialHeap,peakHeap,topSites:sites.slice(0,5)};
}
try{
  const baseline=await measure(false),candidate=await measure(true);
  for(let i=0;i<4;i++){await tick();global.gc!();}
  assert.equal(refs.filter(ref=>ref.deref()).length,0);
  console.log(JSON.stringify({baseline,candidate,retainedOwnersAfterFourGC:0,newInlineClosures:0,newPromises:0,newArrays:0,newFullBodyCopies:0,note:"Actual serializer + offline fetch. Correctness adds previously missing reasoning bytes; SDK/harness allocations included. No pooling or new payload cache."}));
}finally{inspector.disconnect();}
