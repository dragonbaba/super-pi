import assert from "node:assert/strict";
import { Session } from "node:inspector/promises";
import { setImmediate as tick } from "node:timers/promises";
import { stream } from "../../packages/ai/src/api/openai-completions.ts";
import { RequestImageBudget } from "../../packages/coding-agent/src/core/request-image-budget.ts";
import { paddedPngFixture } from "../../tests/helpers/image-acceptance-fixtures.ts";
import type { Context, Message, Model } from "../../packages/ai/src/types.ts";

assert.ok(global.gc,"Run with --expose-gc");
const ITERATIONS=8, refs:WeakRef<object>[]=[];
const inspector=new Session(); inspector.connect();
const model:Model<"openai-completions">={id:"fixture",name:"fixture",api:"openai-completions",provider:"fixture",baseUrl:"https://fixture.invalid",reasoning:false,input:["text","image"],contextWindow:1000000,maxTokens:1024,cost:{input:0,output:0,cacheRead:0,cacheWrite:0}};
const response='data: {"id":"f","choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":null}]}\n\ndata: {"id":"f","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n';
let wireBytes=0;
async function transport(_url:unknown,init?:RequestInit):Promise<Response>{wireBytes=Buffer.byteLength(String(init?.body));return new Response(response,{headers:{"content-type":"text/event-stream"}});}
function corpus():Message[]{
  const data=paddedPngFixture().toString("base64"), messages:Message[]=[{role:"user",content:"Synthetic image inspection",timestamp:0}];
  for(let i=0;i<44;i++){
    const id="image-"+i;
    messages.push({role:"assistant",api:model.api,provider:model.provider,model:model.id,content:[{type:"toolCall",id,name:"read",arguments:{path:"fixture.png"}}],stopReason:"toolUse",timestamp:i,usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}}});
    messages.push({role:"toolResult",toolCallId:id,toolName:"read",content:[{type:"image",data,mimeType:"image/png"}],isError:false,timestamp:i});
  }return messages;
}
async function measure(project:boolean){
  const messages=corpus(), owner=new RequestImageBudget();
  refs.push(new WeakRef(messages),new WeakRef(owner),new WeakRef(messages[2]!));
  const context:Context={messages};
  const coldStart=performance.now();
  if(project){await owner.prepare(messages,{},true);context.messages=owner.applyMessages(messages);}
  const coldPrepareMs=performance.now()-coldStart, coldEncodes=owner.metrics.encodes;
  assert.equal((await stream(model,context,{apiKey:"offline-fixture",fetch:transport,maxRetries:0,onRequestBodyBytes:project?owner.observeWireBytes:undefined}).result()).stopReason,"stop");
  global.gc!(); const initialHeap=process.memoryUsage().heapUsed;
  await inspector.post("HeapProfiler.startSampling",{samplingInterval:4096,includeObjectsCollectedByMajorGC:true,includeObjectsCollectedByMinorGC:true});
  const timings:number[]=[];
  for(let i=0;i<ITERATIONS;i++){
    const before=performance.now();
    if(project){await owner.prepare(messages,{},true);context.messages=owner.applyMessages(messages);}
    await stream(model,context,{apiKey:"offline-fixture",fetch:transport,maxRetries:0,onRequestBodyBytes:project?owner.observeWireBytes:undefined}).result();
    timings.push(performance.now()-before);
  }
  const peakHeap=process.memoryUsage().heapUsed,{profile}=await inspector.post("HeapProfiler.stopSampling");
  const pending=[profile.head], sites:{name:string;bytes:number}[]=[];let sampledBytes=0;
  while(pending.length){const n=pending.pop()!;sampledBytes+=n.selfSize;if(n.selfSize)sites.push({name:n.callFrame.functionName,bytes:n.selfSize});for(const c of n.children)pending.push(c);}
  sites.sort((a,b)=>b.bytes-a.bytes);timings.sort((a,b)=>a-b);
  assert.equal(owner.metrics.encodes,coldEncodes,"no image encoding in warmed requests");
  if(project)assert.equal(owner.metrics.imagesInspected,44,"unchanged images reuse numeric metadata");
  if(project){assert.equal(owner.metrics.wireBytes,wireBytes);assert.equal(owner.metrics.uploads,ITERATIONS+1);}
  const result={project,iterations:ITERATIONS,wireBytes,sampledBytesPerRequest:sampledBytes/ITERATIONS,cpuP50:timings[4],cpuP95:timings[7],coldPrepareMs,coldEncodes,initialHeap,peakHeap,topSites:sites.slice(0,5),metadataImages:owner.metrics.imagesInspected,warmEncodes:0,fullPayloadCopiesForCounting:0};
  owner.clear();assert.equal(owner.metrics.cacheSourceBytes,0);assert.equal(owner.metrics.cacheViewBytes,0);return result;
}
try{
  const baseline=await measure(false),candidate=await measure(true);
  const heapAfterGc:number[]=[];
  for(let i=0;i<4;i++){await tick();global.gc!();heapAfterGc.push(process.memoryUsage().heapUsed);}
  assert.equal(refs.filter(r=>r.deref()).length,0);
  console.log(JSON.stringify({baseline,candidate,heapAfterGc,retainedAfterFourGC:0,note:"Actual OpenAI chat serializer + SDK with offline fetch; corpus includes valid 1920x1080 PNG ancillary padding. Sampling includes request harness."}));
}finally{inspector.disconnect();}
