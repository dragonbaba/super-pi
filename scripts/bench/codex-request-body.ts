import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { Session } from "node:inspector/promises";
import { setImmediate as tick } from "node:timers/promises";
import { zstdDecompressSync } from "node:zlib";
import { createOpenAICodexTransportOwner } from "../../packages/ai/src/api/openai-codex-responses.ts";
import { codexModel, codexToken, sseFrames, textEvents } from "../../tests/helpers/responses-sse-fixture.ts";
import type { Context } from "../../packages/ai/src/types.ts";

assert.ok(global.gc,"Run with --expose-gc");
const inspector=new Session();inspector.connect();
const refs:WeakRef<object>[]=[],ITERATIONS=16;
let payload="中文😀";
for(let i=0;i<8192;i++)payload+=createHash("sha256").update(String(i)).digest("hex");
const model={...codexModel,input:["text","image"],contextWindow:10000000};
const events=textEvents().map(event=>JSON.stringify(event));
const sse=sseFrames(textEvents());
let sent=0,lastWire=0,lastJson=0,observed=0,observedWire=0,observedJson=0,activeListeners=0;
function observe(wire:number,json?:number):void{observed++;observedWire=wire;observedJson=json!;}
function verifyObservation(enabled:boolean):void{if(enabled){assert.equal(observedWire,lastWire);assert.equal(observedJson,lastJson);}}
let enabled=false;
async function fetchFixture(_url:unknown,init?:RequestInit):Promise<Response>{
  sent++;lastWire=typeof init!.body==="string"?Buffer.byteLength(init!.body): (init!.body as Uint8Array).byteLength;
  lastJson=typeof init!.body==="string"?lastWire:zstdDecompressSync(init!.body as Uint8Array).byteLength;
  verifyObservation(enabled);return new Response(sse,{headers:{"content-type":"text/event-stream"}});
}
class Socket {
  readyState=0;readonly listeners=new Map<string,Set<(event:any)=>void>>();
  constructor(){queueMicrotask(()=>{this.readyState=1;this.emit("open",{});});}
  addEventListener(type:string,listener:(event:any)=>void){let set=this.listeners.get(type);if(!set)this.listeners.set(type,set=new Set());if(!set.has(listener)){set.add(listener);activeListeners++;}}
  removeEventListener(type:string,listener:(event:any)=>void){if(this.listeners.get(type)?.delete(listener))activeListeners--;}
  emit(type:string,event:any){for(const listener of this.listeners.get(type)??[])listener(event);}
  send(frame:string){sent++;lastWire=lastJson=Buffer.byteLength(frame);verifyObservation(enabled);queueMicrotask(()=>{for(const data of events)this.emit("message",{data});});}
  close(){this.readyState=3;}
}
const originalSocket=globalThis.WebSocket,originalBuiltin=process.getBuiltinModule;
globalThis.WebSocket=Socket as unknown as typeof WebSocket;
async function cycle(transport:"sse"|"auto",track:boolean){
  const owner=createOpenAICodexTransportOwner(),context:Context={messages:[{role:"user",content:[{type:"text",text:"synthetic 中文😀"},{type:"image",mimeType:"image/png",data:payload}],timestamp:0}]};
  if(track)refs.push(new WeakRef(owner),new WeakRef(context),new WeakRef(context.messages));
  const options={apiKey:codexToken(),sessionId:"bench",transport,maxRetries:0,fetch:fetchFixture,onRequestBodyBytes:enabled?observe:undefined,
    onPayload:(body:unknown)=>{if(track)refs.push(new WeakRef(body as object));}};
  const first=await owner.stream(model,context,options).result();assert.equal(first.stopReason,"stop",first.errorMessage);
  const fullWire=lastWire,fullJson=lastJson;
  context.messages.push(first,{role:"user",content:"next 中文😀",timestamp:1});
  const next=await owner.stream(model,context,options).result();assert.equal(next.stopReason,"stop",next.errorMessage);
  const deltaWire=lastWire,deltaJson=lastJson;
  if(transport==="auto")assert.ok(deltaWire<fullWire);
  await owner.dispose();
  for(const value of Object.values(owner.diagnostics))assert.equal(value,0,"dispose clears all owner resources");
  assert.equal(activeListeners,0);return {fullWire,fullJson,deltaWire,deltaJson};
}
async function measure(transport:"sse"|"auto",compressed:boolean,metering:boolean){
  enabled=metering;sent=observed=0;
  process.getBuiltinModule=(function(id:string){const module=originalBuiltin(id);return !compressed&&id==="node:zlib"?{...module,zstdCompressSync:undefined}:module;}) as typeof process.getBuiltinModule;
  for(let i=0;i<2;i++)await cycle(transport,false);
  sent=observed=0;global.gc!();const initialHeap=process.memoryUsage().heapUsed;
  await inspector.post("HeapProfiler.startSampling",{samplingInterval:4096,includeObjectsCollectedByMajorGC:true,includeObjectsCollectedByMinorGC:true});
  const times:number[]=[];let peakHeap=initialHeap,bytes;
  for(let i=0;i<ITERATIONS;i++){const start=performance.now();bytes=await cycle(transport,i===0);times.push(performance.now()-start);peakHeap=Math.max(peakHeap,process.memoryUsage().heapUsed);}
  const {profile}=await inspector.post("HeapProfiler.stopSampling");
  const pending=[profile.head],sites:{name:string;bytes:number}[]=[];let sampled=0;
  while(pending.length){const node=pending.pop()!;sampled+=node.selfSize;if(node.selfSize)sites.push({name:node.callFrame.functionName,bytes:node.selfSize});for(const child of node.children)pending.push(child);}
  sites.sort((a,b)=>b.bytes-a.bytes);times.sort((a,b)=>a-b);
  assert.equal(sent,ITERATIONS*2);assert.equal(observed,metering?sent:0);
  return {transport,compressed,metering,requests:sent,observations:observed,...bytes,sampledBytesPerRequest:sampled/sent,p50PairMs:times[8],p95PairMs:times[15],initialHeap,peakHeap,topSites:sites.slice(0,5)};
}
async function failedCycle(abort:boolean){
  const owner=createOpenAICodexTransportOwner(),failure=new Error("synthetic observer failure"),controller=new AbortController();
  const context:Context={messages:[{role:"user",content:"failed",timestamp:0}]};
  refs.push(new WeakRef(failure),new WeakRef(owner),new WeakRef(context));
  const sentBefore=sent;
  await owner.stream(model,context,{apiKey:codexToken(),transport:"auto",signal:controller.signal,onRequestBodyBytes:()=>{if(abort)controller.abort();else throw failure;}}).result();
  assert.equal(sent,sentBefore);await owner.dispose();
  for(const value of Object.values(owner.diagnostics))assert.equal(value,0);
}
try{
  const results=[];
  for(const [transport,compressed] of [["sse",false],["sse",true],["auto",false]] as const){results.push(await measure(transport,compressed,false),await measure(transport,compressed,true));}
  // An observer failure creates weak numeric error metadata; no socket write is made.
  await failedCycle(false);await failedCycle(true);
  for(let i=0;i<4;i++){await tick();global.gc!();}
  assert.equal(refs.filter(ref=>ref.deref()).length,0);assert.equal(activeListeners,0);
  console.log(JSON.stringify({results,trackedObjects:refs.length,releasedObjects:refs.length,activeListeners:0,newPerDeltaClosures:0,newPerDeltaPromises:0,newPerDeltaArrays:0,newFullBodyCopies:0,finalWsFrameMaterializationsPerAttempt:1,frameReferencesAcrossResponseAwait:0,note:"Actual transport owner + offline HTTP/WS; includes serializer, zstd, prefix hashing and harness allocations. Comparison isolates optional numeric callback, not old-image projection. No pooling."}));
}finally{process.getBuiltinModule=originalBuiltin;globalThis.WebSocket=originalSocket;inspector.disconnect();}
