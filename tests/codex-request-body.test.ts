import assert from "node:assert/strict";
import test from "node:test";
import { zstdDecompressSync } from "node:zlib";
import { createHash } from "node:crypto";
import { createOpenAICodexTransportOwner, buildOpenAICodexRequestBody } from "../packages/ai/src/api/openai-codex-responses.ts";
import { isRequestBodyTooLarge } from "../packages/ai/src/utils/request-body-size.ts";
import { codexModel, codexToken, sseFrames, textEvents } from "./helpers/responses-sse-fixture.ts";
import type { TestContext } from "node:test";

const artifact={type:"compaction",encrypted_content:"wire-artifact"};
const compactEvents=[{type:"response.output_item.done",output_index:0,item:artifact},{type:"response.completed",response:{id:"compacted",status:"completed",output:[artifact]}}];
function sockets(t:TestContext){
  const original=globalThis.WebSocket,frames:string[]=[],bodies:any[]=[],instances:Socket[]=[];
  let mode:"success"|"size"|"network"|"missing-id"|"after-output-size"="success";
  class Socket {
    readyState=0;readonly listeners=new Map<string,Set<(event:any)=>void>>();
    constructor(){instances.push(this);queueMicrotask(()=>{this.readyState=1;this.emit("open",{});});}
    addEventListener(type:string,listener:(event:any)=>void){let set=this.listeners.get(type);if(!set)this.listeners.set(type,set=new Set());set.add(listener);}
    removeEventListener(type:string,listener:(event:any)=>void){this.listeners.get(type)?.delete(listener);}
    emit(type:string,event:any){for(const listener of this.listeners.get(type)??[])listener(event);}
    send(frame:string){
      frames.push(frame);const body=JSON.parse(frame);bodies.push(body);
      queueMicrotask(()=>{
        if(mode==="size"||mode==="after-output-size"){
          if(mode==="after-output-size")this.emit("message",{data:JSON.stringify(textEvents()[0])});
          this.readyState=3;this.emit("close",{code:1009,reason:"message too big",wasClean:true});return;
        }
        if(mode==="network"){this.emit("error",new Error("synthetic network error"));return;}
        if(mode==="missing-id"){mode="success";this.emit("message",{data:JSON.stringify({type:"error",code:"previous_response_not_found",message:"previous response not found"})});return;}
        const events=body.input?.some((item:any)=>item.type==="compaction_trigger")?compactEvents:textEvents();
        for(const event of events)this.emit("message",{data:JSON.stringify(event)});
      });
    }
    close(){this.readyState=3;}
  }
  globalThis.WebSocket=Socket as unknown as typeof WebSocket;
  t.after(()=>{globalThis.WebSocket=original;});
  return {frames,bodies,instances,mode(next:typeof mode){mode=next;}};
}

const model={...codexModel,contextWindow:1000000};
const context={messages:[{role:"user" as const,content:"synthetic 中文😀 "+"x".repeat(32768),timestamp:0}]};
function success():Response{return new Response(sseFrames(textEvents()),{headers:{"content-type":"text/event-stream"}});}

for(const compressed of [false,true])test(`Codex SSE observes final body and JSON bytes, compressed=${compressed}`,async t=>{
  if(!compressed){const original=process.getBuiltinModule;t.mock.method(process,"getBuiltinModule",function(id:string){const module=original(id);return id==="node:zlib"?{...module,zstdCompressSync:undefined}:module;});}
  const owner=createOpenAICodexTransportOwner();t.after(()=>owner.dispose());
  const observed:number[][]=[];let uploads=0;
  const result=await owner.stream(model,context,{apiKey:codexToken(),transport:"sse",maxRetries:0,
    onRequestBodyBytes:(wire,json)=>{observed.push([wire,json!]);},
    fetch:async(_url,init)=>{
      uploads++;assert.equal(observed.length,uploads,"observation precedes the attempted send");
      const zipped=new Headers(init?.headers).get("content-encoding")==="zstd";
      assert.equal(zipped,compressed);
      const json=zipped?zstdDecompressSync(init!.body as Uint8Array).toString():init!.body as string;
      assert.deepEqual(observed.at(-1),[zipped?(init!.body as Uint8Array).byteLength:Buffer.byteLength(json),Buffer.byteLength(json)]);
      return success();
    }}).result();
  assert.equal(result.stopReason,"stop",result.errorMessage);assert.equal(uploads,1);assert.equal(observed.length,1);
});

for(const body of [null,JSON.stringify({error:{code:"request_too_large",message:"request_too_large"}})])test(`Codex HTTP 413 is not replayed, bodyless=${body===null}`,async t=>{
  const owner=createOpenAICodexTransportOwner();t.after(()=>owner.dispose());let uploads=0,observed=0;
  const result=await owner.stream(model,context,{apiKey:codexToken(),transport:"sse",maxRetries:1,
    onRequestBodyBytes:()=>{observed++;},fetch:async()=>{uploads++;return new Response(body,{status:413});}}).result();
  assert.equal(result.stopReason,"error");assert.equal(uploads,1);assert.equal(observed,1);
  assert.equal(isRequestBodyTooLarge(result),true);assert.match(result.errorMessage!,/413/);
});

test("Codex observer failure blocks SSE without transport retry",async t=>{
  const owner=createOpenAICodexTransportOwner();t.after(()=>owner.dispose());let uploads=0,observed=0;
  const result=await owner.stream(model,context,{apiKey:codexToken(),transport:"sse",maxRetries:1,
    onRequestBodyBytes:()=>{observed++;throw new Error("synthetic measurement failure");},fetch:async()=>{uploads++;return success();}}).result();
  assert.equal(result.stopReason,"error");assert.equal(uploads,0);assert.equal(observed,1);
  assert.match(result.errorMessage!,/^Request preparation blocked:.*synthetic measurement failure/);
});

test("Codex WS counts actual full/delta frames and preserves continuation on observer failure",async t=>{
  const f=sockets(t),owner=createOpenAICodexTransportOwner();t.after(()=>owner.dispose());
  const observed:number[][]=[];let rejectObserver=false,http=0;
  const options={apiKey:codexToken(),sessionId:"wire-delta",transport:"auto" as const,maxRetries:0,
    onRequestBodyBytes:(wire:number,json?:number)=>{if(rejectObserver)throw new Error("local observer failed");observed.push([wire,json!]);},
    fetch:async()=>{http++;return success();}};
  const first=await owner.stream(model,context,options).result();assert.equal(first.stopReason,"stop",first.errorMessage);
  assert.deepEqual(observed[0],[Buffer.byteLength(f.frames[0]!),Buffer.byteLength(f.frames[0]!)]);
  const next={messages:[...context.messages,first,{role:"user" as const,content:"next 中文😀",timestamp:1}]};
  rejectObserver=true;
  const rejected=await owner.stream(model,next,options).result();assert.match(rejected.errorMessage!,/^Request preparation blocked:/);
  assert.equal(f.frames.length,1);assert.equal(http,0);assert.equal(owner.diagnostics.cached,1);
  rejectObserver=false;
  const last=await owner.stream(model,next,options).result();assert.equal(last.stopReason,"stop",last.errorMessage);
  assert.equal(f.bodies[1].previous_response_id,first.responseId);assert.equal(f.bodies[1].input.length,1);
  assert.deepEqual(observed[1],[Buffer.byteLength(f.frames[1]!),Buffer.byteLength(f.frames[1]!)]);
  assert.ok(observed[1]![0]!<observed[0]![0]!);assert.equal(http,0);
});

for(const mode of ["network","size","after-output-size"] as const)test(`Codex before-output fallback measures each attempted transport: ${mode}`,async t=>{
  const f=sockets(t),owner=createOpenAICodexTransportOwner();t.after(()=>owner.dispose());f.mode(mode);
  const observed:number[][]=[];let http=0;
  const result=await owner.stream(model,context,{apiKey:codexToken(),transport:"auto",maxRetries:0,
    onRequestBodyBytes:(wire,json)=>{observed.push([wire,json!]);},fetch:async(_url,init)=>{http++;assert.equal(observed.at(-1)![0],(init!.body as Uint8Array).byteLength);return success();}}).result();
  assert.equal(f.frames.length,1);assert.equal(observed[0]![0],Buffer.byteLength(f.frames[0]!));
  if(mode==="after-output-size"){
    assert.equal(result.stopReason,"error");assert.equal(http,0);assert.equal(observed.length,1);assert.equal(isRequestBodyTooLarge(result),true);
  }else{
    assert.equal(result.stopReason,"stop",result.errorMessage);assert.equal(http,1);assert.equal(observed.length,2);
    if(mode==="size")assert.ok(observed[1]![0]!<observed[0]![0]!);
  }
});

test("Codex 1009 does not replace a small delta with a larger full-history fallback",async t=>{
  const f=sockets(t),owner=createOpenAICodexTransportOwner();t.after(()=>owner.dispose());let http=0;
  const largeContext={messages:[{...context.messages[0]!,content:Array.from({length:512},(_,i)=>createHash("sha256").update(String(i)).digest("hex")).join("")}]};
  const options={apiKey:codexToken(),sessionId:"wire-size-delta",transport:"auto" as const,maxRetries:0,fetch:async()=>{http++;return success();}};
  const first=await owner.stream(model,largeContext,options).result();assert.equal(first.stopReason,"stop");
  f.mode("size");
  const second=await owner.stream(model,{messages:[...largeContext.messages,first,{role:"user",content:"x",timestamp:1}]},options).result();
  assert.equal(second.stopReason,"error");assert.equal(isRequestBodyTooLarge(second),true);assert.equal(http,0);
  assert.equal(owner.getDebugStats(options.sessionId)?.sseFallbacks,0);
});

test("Codex missing response ID retains existing full-request recovery and measures both frames",async t=>{
  const f=sockets(t),owner=createOpenAICodexTransportOwner();t.after(()=>owner.dispose());const observed:number[]=[];
  const options={apiKey:codexToken(),sessionId:"wire-missing-id",transport:"auto" as const,maxRetries:0,onRequestBodyBytes:(bytes:number)=>{observed.push(bytes);}};
  const first=await owner.stream(model,context,options).result();assert.equal(first.stopReason,"stop");f.mode("missing-id");
  const second=await owner.stream(model,{messages:[...context.messages,first,{role:"user",content:"next",timestamp:1}]},options).result();
  assert.equal(second.stopReason,"stop",second.errorMessage);assert.equal(f.frames.length,3);
  assert.deepEqual(observed,f.frames.map(frame=>Buffer.byteLength(frame)));
  assert.ok(f.bodies[1].previous_response_id);assert.equal(f.bodies[2].previous_response_id,undefined);
});

for(const transport of ["sse","auto"] as const)test(`Codex compaction meters final upload and local observer failure preserves commitment: ${transport}`,async t=>{
  const f=sockets(t),owner=createOpenAICodexTransportOwner();t.after(()=>owner.dispose());let rejectObserver=false,http=0;
  const observed:number[][]=[];
  const options={apiKey:codexToken(),sessionId:"wire-compaction-"+transport,transport,maxRetries:0,codexRemoteCompaction:true,
    onRequestBodyBytes:(wire:number,json?:number)=>{if(rejectObserver)throw new Error("compaction observer failed");observed.push([wire,json!]);},
    fetch:async(_url:unknown,init?:RequestInit)=>{http++;const body=typeof init!.body==="string"?init!.body:zstdDecompressSync(init!.body as Uint8Array).toString();assert.equal(observed.at(-1)![1],Buffer.byteLength(body));return new Response(sseFrames(JSON.parse(body).input.some((item:any)=>item.type==="compaction_trigger")?compactEvents:textEvents()),{headers:{"content-type":"text/event-stream"}});}};
  const first=await owner.stream(model,context,options).result();assert.equal(first.stopReason,"stop",first.errorMessage);
  const payload=buildOpenAICodexRequestBody(model,{messages:[...context.messages,first]},options,options.sessionId) as Record<string,unknown>;
  rejectObserver=true;await assert.rejects(owner.compact(model,payload,options),/compaction observer failed/);
  assert.equal(owner.diagnostics.commitments,1);assert.equal(owner.diagnostics.consumed,0);
  assert.equal(transport==="sse"?http:f.frames.length,1);
  rejectObserver=false;assert.deepEqual((await owner.compact(model,payload,options)).compactionItem,artifact);
  assert.equal(observed.length,2);assert.equal(owner.diagnostics.consumed,1);
  if(transport==="auto"){
    const continued=await owner.stream(model,context,{...options,onPayload:body=>({...body as Record<string,unknown>,input:[artifact,{role:"user",content:[{type:"input_text",text:"after compaction"}]}]})}).result();
    assert.equal(continued.stopReason,"stop",continued.errorMessage);assert.equal(f.bodies.at(-1).previous_response_id,"compacted");
    assert.equal(f.bodies.at(-1).input.length,1);assert.equal(http,0);
  }
});

for(const failure of ["network",503,401] as const)test(`Codex SSE retry policy remains bounded for ${failure}`,async t=>{
  const owner=createOpenAICodexTransportOwner();t.after(()=>owner.dispose());let attempts=0,observations=0;
  const result=await owner.stream(model,context,{apiKey:codexToken(),transport:"sse",maxRetries:1,
    onRequestBodyBytes:()=>{observations++;},fetch:async()=>{
      attempts++;
      if(attempts===1){if(failure==="network")throw new TypeError("synthetic connection failure");return new Response("synthetic error",{status:failure,headers:{"retry-after-ms":"0"}});}
      return success();
    }}).result();
  assert.equal(attempts,failure===401?1:2);assert.equal(observations,attempts);
  assert.equal(result.stopReason,failure===401?"error":"stop",result.errorMessage);
});

for(const transport of ["sse","auto"] as const)for(const invalidation of ["abort","reset"] as const)test(`Codex observer ${invalidation} prevents a late ${transport} write`,async t=>{
  const f=sockets(t),owner=createOpenAICodexTransportOwner(),controller=new AbortController();t.after(()=>owner.dispose());let http=0;
  const result=await owner.stream(model,context,{apiKey:codexToken(),transport,signal:controller.signal,maxRetries:0,
    onRequestBodyBytes:()=>{if(invalidation==="abort")controller.abort();else owner.reset();},fetch:async()=>{http++;return success();}}).result();
  assert.equal(result.stopReason,"aborted");assert.equal(http,0);assert.equal(f.frames.length,0);
  await owner.dispose();assert.equal(owner.diagnostics.cached,0);assert.equal(owner.diagnostics.commitments,0);
});

test("Codex post-compaction preflight and 1009 retain the provider boundary",async t=>{
  const f=sockets(t),owner=createOpenAICodexTransportOwner();t.after(()=>owner.dispose());let http=0,observations=0;
  const options={apiKey:codexToken(),sessionId:"wire-compacted-boundary",transport:"auto" as const,maxRetries:0,codexRemoteCompaction:true,
    onRequestBodyBytes:()=>{observations++;},fetch:async()=>{http++;return success();}};
  const first=await owner.stream(model,context,options).result();assert.equal(first.stopReason,"stop");
  const payload=buildOpenAICodexRequestBody(model,{messages:[...context.messages,first]},options,options.sessionId) as Record<string,unknown>;
  await owner.compact(model,payload,options);assert.equal(observations,2);
  const invalid=await owner.stream(model,context,options).result();assert.match(invalid.errorMessage!,/post-compaction continuation boundary/);
  assert.equal(observations,2,"preflight rejected before creating/sending a frame");assert.equal(owner.diagnostics.cached,1);
  f.mode("size");
  const rejected=await owner.stream(model,context,{...options,onPayload:body=>({...body as Record<string,unknown>,input:[artifact,{role:"user",content:[{type:"input_text",text:"after compaction"}]}]})}).result();
  assert.equal(rejected.stopReason,"error");assert.equal(isRequestBodyTooLarge(rejected),true);assert.equal(http,0);
  assert.equal(observations,3);assert.equal(f.bodies.at(-1).previous_response_id,"compacted");
  assert.equal(owner.getDebugStats(options.sessionId)?.sseFallbacks,0);
});
