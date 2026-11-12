import assert from "node:assert/strict";
import test from "node:test";
import type { ImageContent, Message, ToolResultMessage } from "../packages/ai/src/types.ts";
import { RequestImageBudget, IMAGE_KEEP_BYTES, IMAGE_STEP_BYTES } from "../packages/coding-agent/src/core/request-image-budget.ts";
import { isRequestBodyTooLarge } from "../packages/ai/src/utils/request-body-size.ts";
import { observeRequestBody, requestBodyUtf8Bytes } from "../packages/ai/src/utils/request-body-observer.ts";
import { processedImage, reuseUnchangedToolImages } from "../packages/coding-agent/src/utils/processed-image.ts";
import { normalizeToolResultImages } from "../packages/coding-agent/src/utils/tool-result-images.ts";
import { pngFixture } from "./helpers/image-acceptance-fixtures.ts";
import { resizeImage } from "../packages/coding-agent/src/utils/image-resize.ts";
import { retryProviderRequest } from "../packages/ai/src/utils/provider-retry.ts";
import { createToolResultPresentationOwner } from "../packages/coding-agent/src/core/tool-result-presentation.ts";
import { setImmediate as tick } from "node:timers/promises";

const MiB = 1024 * 1024;
function tool(bytes: number, id = "tool"): ToolResultMessage {
  return { role: "toolResult", toolCallId: id, toolName: "read", content: [{ type: "image", data: "A".repeat(bytes), mimeType: "image/png" }], isError: false, timestamp: 0 };
}
function imageBytes(messages: Message[]): number {
  let n = 0; for (const m of messages) if (m.role === "toolResult") for (const b of m.content) if (b.type === "image") n += b.data.length; return n;
}
test("all selected views survive cross-request cache eviction", async () => {
  const owner = new RequestImageBudget(async () => ({ data:"AAAA",mimeType:"image/png",width:1,height:1,originalWidth:10,originalHeight:10,wasResized:true }));
  const source = tool(0); source.content = Array.from({length:300}, () => tool(100000).content[0]!);
  await owner.prepare([source], {}, true);
  assert.equal(imageBytes(owner.applyMessages([source])), owner.metrics.retainedImageBytes);
  assert.equal(owner.metrics.retainedImageBytes,1200);
  const before=owner.metrics.encodes; source.content.push(source.content[0]!);
  await owner.prepare([source],{},true); assert.equal(owner.metrics.encodes-before,300);
  assert.equal(imageBytes(owner.applyMessages([source])),1204); owner.clear();
});
for(const contextual of [false,true]) test(`text presentation wrappers preserve prepared image occurrence omissions, contextual=${contextual}`, async () => {
  const owner=new RequestImageBudget(), messages=[tool(7*MiB,"old"),tool(7*MiB,"current")];
  for(const message of messages) message.content.unshift({type:"text",text:"long result line\n".repeat(10000)});
  const presentation=createToolResultPresentationOwner({enabled:true,budgetTokens:1024},"budget-wrapper-test")!;
  try {
    await owner.prepare(messages,{},false);
    const projected=presentation.projectMessagesForModel(messages,owner.apply,undefined,undefined,contextual?1000000:undefined,1024);
    assert.equal(imageBytes(owner.applyMessages(projected)),owner.metrics.retainedImageBytes);
  } finally {owner.clear();presentation.dispose();}
});
test("presentation preserves distinct occurrences of a shared image inside one source", async () => {
  const owner=new RequestImageBudget(), image=tool(4*MiB).content[0]!, old=tool(0,"old"), current=tool(4*MiB,"current");
  old.content=[{type:"text",text:"long result line\n".repeat(10000)},image,image,image];
  const messages=[old,current], presentation=createToolResultPresentationOwner({enabled:true,budgetTokens:4096},"shared-wrapper-test")!;
  try { await owner.prepare(messages,{},false); const projected=presentation.projectMessagesForModel(messages,owner.apply); assert.equal(imageBytes(owner.applyMessages(projected)),8*MiB); }
  finally {owner.clear();presentation.dispose();}
});
for(const mcp of [false,true]) for(const shared of [false,true]) test(`projected suffix keeps the exact identical image occurrence, mcp=${mcp}, shared=${shared}`, async()=>{
  const owner=new RequestImageBudget(), first=tool(4*MiB).content[0]!, second=shared?first:{...first};
  if(mcp) {Object.assign(first,{mcpInput:true});Object.assign(second,{mcpInput:true});}
  const old=tool(0,"old"), current=tool(4*MiB,"current"), tail={type:"text" as const,text:"retained tail"};
  old.content=[{type:"text",text:"long beginning\n".repeat(10000)},first,{type:"text",text:"long middle\n".repeat(10000)},second,tail];
  const messages=[old,current], presentation=createToolResultPresentationOwner({enabled:true,budgetTokens:1024},"exact-suffix-test")!;
  try {
    await owner.prepare(messages,{},false);
    const suffix={...old,content:[{...second},tail]};
    assert.equal(imageBytes([owner.apply(suffix,old,undefined,{start:{blockIndex:0},end:{blockIndex:3}})]),4*MiB);
    if(!shared) assert.equal(imageBytes([owner.apply({...old,content:[second,tail]},old)]),4*MiB);
    assert.equal(imageBytes(presentation.projectMessagesForModel(messages,owner.apply)),8*MiB);
  } finally {owner.clear();presentation.dispose();}
});
test("expanded views release discarded payloads and transient request ownership, including shared survivors", async()=>{
  const owner=new RequestImageBudget(async()=>({data:Buffer.alloc(3*MiB/4,65).toString("base64"),mimeType:"image/png",width:1,height:1,originalWidth:10,originalHeight:10,wasResized:true}));
  const refs:WeakRef<object>[]=[], internal=owner as any, originalView=internal.view;
  internal.view=async(...args:any[])=>{const view=await originalView.apply(owner,args);refs.push(new WeakRef(view.image));return view;};
  const messages=Array.from({length:100},(_,i)=>tool(1000,String(i)));
  messages[99]!.content[0]=messages[0]!.content[0]!;
  await owner.prepare(messages,{},true);
  assert.equal(internal.requestViews.has(messages[1]!.content[0]),false);
  assert.equal(internal.requestViews.has(messages[0]!.content[0]),true,"the shared current occurrence still owns its view");
  assert.equal(owner.metrics.requestViewBytes,12*MiB);
  assert.ok(owner.metrics.requestViewBytesHighWaterMark<=13*MiB,"expansion never accumulates the whole 99 MiB batch");
  assert.equal(imageBytes(owner.applyMessages(messages)),12*MiB);
  assert.ok(owner.metrics.projectionCacheBytes<=2*MiB);
  owner.completeResponse(); assert.equal(owner.metrics.requestViewBytes,0);
  if(global.gc) {
    for(let i=0;i<4;i++){await tick();global.gc();}
    assert.equal(refs.filter(ref=>ref.deref()).length,11,"only bounded cross-request cache views remain");
  }
  owner.clear();
  if(global.gc) {for(let i=0;i<4;i++){await tick();global.gc();} assert.equal(refs.filter(ref=>ref.deref()).length,0);}
});
test("over-capacity current batches stop encoding as soon as their size is known", async()=>{
  for(const shared of [false,true]) {
    const owner=new RequestImageBudget(async()=>({data:"B".repeat(MiB),mimeType:"image/png",width:1,height:1,originalWidth:10,originalHeight:10,wasResized:true}));
    const message=tool(0), first=tool(1000).content[0]!;
    message.content=Array.from({length:100},()=>shared?first:tool(1000).content[0]!);
    await assert.rejects(owner.prepare([message],{},true),/current tool images exceed/);
    assert.equal(owner.metrics.encodes,shared?1:13);
    assert.equal(owner.metrics.requestViewBytes,0); assert.equal(owner.metrics.cacheViewBytes,0); owner.clear();
  }
});
test("the complete originating assistant batch is protected", async () => {
  const assistant: Message = {role:"assistant",api:"openai-completions",provider:"openai",model:"fixture",content:[],stopReason:"toolUse",timestamp:0,
    usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}}};
  const owner = new RequestImageBudget(), messages = [assistant,tool(4*MiB,"one"),tool(4*MiB,"two"),tool(4*MiB,"three")];
  await owner.prepare(messages,{},false); assert.equal(imageBytes(owner.applyMessages(messages)),12*MiB);
  await assert.rejects(owner.prepare([assistant,tool(7*MiB,"one"),tool(7*MiB,"two")],{},false),/current tool images exceed/); owner.clear();
});

for (const boundary of ["user", "assistant", "text-tool-batch"] as const) test(`oversized batch becomes historical after ${boundary}`, async () => {
  const owner = new RequestImageBudget();
  const assistant: Message = {role:"assistant",api:"openai-completions",provider:"openai",model:"fixture",content:[],stopReason:"toolUse",timestamp:0,
    usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}}};
  const batch = tool(0);
  batch.content = Array.from({length:6}, () => tool(Math.ceil(2.2*MiB)).content[0]!);
  const messages: Message[] = [assistant,batch];
  await assert.rejects(owner.prepare(messages,{},false),/current tool images exceed/);
  if (boundary === "user") messages.push({role:"user",content:"Continue with text",timestamp:1});
  else messages.push({...assistant,stopReason:boundary === "assistant" ? "stop" : "toolUse"});
  if (boundary === "text-tool-batch") messages.push({...tool(0,"text"),content:[{type:"text",text:"text only"}]});
  await owner.prepare(messages,{},false);
  assert.equal(imageBytes(owner.applyMessages(messages)),4* Math.ceil(2.2*MiB));
  assert.equal(imageBytes(messages),6* Math.ceil(2.2*MiB));
  assert.equal(owner.metrics.encodes,0);
  messages.push({...assistant}, {...batch,toolCallId:"new-current"});
  await assert.rejects(owner.prepare(messages,{},false),/current tool images exceed/);
  owner.clear();
});
test("successful recovery releases the byte ceiling without permitting another recovery", async () => {
  const owner = new RequestImageBudget(), messages = [tool(1024)];
  await owner.prepare(messages,{},false); owner.observeWireBytes(2048); assert.equal(owner.tighten(),true);
  owner.observeWireBytes(1800); owner.completeResponse(); owner.observeWireBytes(4096);
  assert.equal(owner.tighten(),false); owner.clear();
});
test("unchanged context clones reuse admitted images and cached views; modified images do not", async () => {
  let encodes=0;
  const owner=new RequestImageBudget(async()=>{encodes++;return {data:"AAAA",mimeType:"image/png",width:1,height:1,originalWidth:10,originalHeight:10,wasResized:true};});
  const admitted=tool(0,"admitted"); admitted.content=[processedImage("AAAA","image/png")];
  const sources=[admitted,tool(1024,"unprocessed")];
  for(let i=0;i<3;i++) { const cloned=structuredClone(sources); reuseUnchangedToolImages(cloned,sources); await owner.prepare(cloned,{},true); owner.applyMessages(cloned); }
  assert.equal(encodes,1);
  const modified=structuredClone(sources); (modified[0]!.content[0] as ImageContent).data="BBBB";
  reuseUnchangedToolImages(modified,sources); await owner.prepare(modified,{},true); assert.equal(encodes,2);
  assert.equal((sources[0]!.content[0] as ImageContent).data,"AAAA"); owner.clear();
});
test("legacy images use bounded whole-image strides and retain a crossing current batch", async () => {
  for (const sizes of [[7*MiB,7*MiB],[7.9*MiB,8.3*MiB],[4*MiB,4*MiB,4*MiB],[0],[12*MiB]]) {
    const owner = new RequestImageBudget(), messages = sizes.map((s,i) => tool(Math.floor(s), String(i)));
    await owner.prepare(messages, {}, false);
    const projected = owner.applyMessages(messages);
    assert.ok(imageBytes(projected) <= IMAGE_KEEP_BYTES + IMAGE_STEP_BYTES);
    const last = projected.at(-1)!; assert.ok(last.role === "toolResult" && last.content.some(b => b.type === "image"));
    assert.equal(imageBytes(messages), sizes.reduce((sum,s) => sum + Math.floor(s), 0));
    owner.clear(); assert.equal(owner.metrics.cacheSourceBytes, 0);
  }
});
test("unchanged requests reuse views and projection; source mutations and policy changes invalidate", async () => {
  let encodes = 0;
  const owner = new RequestImageBudget(async () => { encodes++; return { data: "AAAA", mimeType: "image/png", width: 1,height:1,originalWidth:10,originalHeight:10,wasResized:true }; });
  const source = tool(2048), messages = [source];
  await owner.prepare(messages, {}, true); const first = owner.applyMessages(messages)[0];
  await owner.prepare(messages, {}, true); assert.equal(owner.applyMessages(messages)[0], first); assert.equal(encodes, 1);
  (source.content[0] as ImageContent).data = "B".repeat(2048);
  await owner.prepare(messages, {}, true); assert.equal(encodes, 2); assert.notEqual(owner.applyMessages(messages)[0], first);
  await owner.prepare(messages, { maxWidth: 32 }, true); assert.equal(encodes, 3);
  owner.clear(); assert.equal(owner.metrics.cacheViewBytes, 0);
});
test("recreated evicted views invalidate projections after in-place source changes", async () => {
  const owner=new RequestImageBudget(async bytes=>({data:bytes[0]===0?"AAAA":"BBBBBBBB",mimeType:"image/png",width:1,height:1,originalWidth:10,originalHeight:10,wasResized:true}));
  const messages=Array.from({length:129},(_,i)=>tool(1000,String(i)));
  await owner.prepare(messages,{},true); const previous=owner.applyMessages(messages);
  (messages[0]!.content[0] as ImageContent).data="B".repeat(1000);
  await owner.prepare(messages,{},true); const next=owner.applyMessages(messages);
  assert.notEqual(next[0],previous[0]); assert.equal(imageBytes(next),owner.metrics.retainedImageBytes);
  assert.equal((next[0] as ToolResultMessage).content.find(b=>b.type==="image")?.data,"BBBBBBBB"); owner.clear();
});
test("newly generated cache-miss views replace old projections even for unchanged source bytes", async()=>{
  let phase=0;
  const owner=new RequestImageBudget(async()=>({data:phase?"BBBBBBBB":"AAAA",mimeType:"image/png",width:1,height:1,originalWidth:10,originalHeight:10,wasResized:true}));
  const messages=Array.from({length:129},(_,i)=>tool(1000,String(i)));
  await owner.prepare(messages,{},true); owner.applyMessages(messages); phase=1;
  await owner.prepare(messages,{},true); assert.equal(imageBytes(owner.applyMessages(messages)),owner.metrics.retainedImageBytes); owner.clear();
});
test("images changed after preparation cannot reuse a cached projected body", async()=>{
  const owner=new RequestImageBudget(), messages=[tool(7*MiB,"old"),tool(7*MiB,"current")];
  await owner.prepare(messages,{},false); owner.applyMessages(messages);
  (messages[0]!.content[0] as ImageContent).data="changed";
  assert.throws(()=>owner.applyMessages(messages),/image changed after preparation/); owner.clear();
});
for(const resize of [false,true]) test(`MCP sanitizer clones resolve source omissions and views, resize=${resize}`, async()=>{
  const owner=new RequestImageBudget(async()=>({data:"AAAA",mimeType:"image/png",width:1,height:1,originalWidth:10,originalHeight:10,wasResized:true}));
  const messages=[tool(7*MiB,"old-mcp"),tool(7*MiB,"current-mcp")];
  for(const message of messages) Object.assign(message.content[0]!,{mcpInput:true});
  const presentation=createToolResultPresentationOwner({enabled:true,budgetTokens:4096},"mcp-clone-test")!;
  try {
    await owner.prepare(messages,{},resize); const projected=presentation.projectMessagesForModel(messages,owner.apply);
    assert.equal(imageBytes(owner.applyMessages(projected)),owner.metrics.retainedImageBytes);
    for(const message of projected) if(message.role==="toolResult") for(const block of message.content) assert.equal("mcpInput" in block,false);
  } finally {owner.clear();presentation.dispose();}
});
test("unresized current images over budget are explicit; user images are counted without eviction", async () => {
  const owner = new RequestImageBudget(), messages: Message[] = [{ role: "user", content: [{ type: "image", data: "AAAA", mimeType: "image/png" }], timestamp:0 }, tool(13*MiB)];
  await assert.rejects(owner.prepare(messages, {}, false), /current tool images exceed/);
  assert.equal(owner.metrics.userImageBytes, 4); assert.equal(owner.metrics.cacheViewBytes, 0);
});
test("recovery tightens once and refuses an unchanged serialized body before upload", async () => {
  const owner = new RequestImageBudget(), messages = Array.from({length:44}, (_,i) => tool(1140000, String(i)));
  await owner.prepare(messages, {}, false); const first = imageBytes(owner.applyMessages(messages)); owner.observeWireBytes(first+100);
  assert.equal(owner.tighten(), true); await owner.prepare(messages, {}, false);
  const second = imageBytes(owner.applyMessages(messages)); assert.ok(second < first);
  assert.throws(() => owner.observeWireBytes(first+100), /did not reduce/); owner.observeWireBytes(second+100);
  assert.equal(owner.tighten(), false); owner.clear();
});
test("cancellation releases views after the owned encoding settles", async () => {
  let release!: (value: null) => void;
  const owner = new RequestImageBudget(() => new Promise(resolve => { release = resolve; })), controller = new AbortController();
  const pending = owner.prepare([tool(1024)], {}, true, controller.signal); controller.abort(); release(null);
  await assert.rejects(pending, /abort/i); assert.equal(owner.metrics.cacheSourceBytes, 0); owner.clear();
});
test("admission provenance skips repeat read processing but rejects changed image blocks", async () => {
  const content = [processedImage("AAAA", "image/png")];
  assert.equal(await normalizeToolResultImages(content), content);
  const owner = new RequestImageBudget(async()=>{throw new Error("admitted image must not be decoded again");});
  await owner.prepare([{...tool(0),content}],{},true); assert.equal(owner.metrics.encodes,0); owner.clear();
  content[0]!.data = "changed";
  const result = await normalizeToolResultImages(content); assert.equal(result[0], content[0]);
});
test("PNG request views preserve format and alpha without altering the source", async () => {
  const original = pngFixture(96,64,true), before = Buffer.from(original);
  const result = await resizeImage(original, "image/png", { maxWidth:48,maxHeight:48,maxBytes:100000,preservePng:true });
  assert.ok(result); assert.equal(result.mimeType,"image/png"); assert.equal(result.width,48); assert.equal(result.height,32); assert.deepEqual(original,before);
});
test("body classifier separates payload size from token, connection, format and rate failures", () => {
  for (const message of ["413 Failed to buffer the request body: length limit exceeded","HTTP 413: rejected","request_too_large","Payload too large"]) assert.equal(isRequestBodyTooLarge({ stopReason:"error",errorMessage:message }),true,message);
  for (const message of ["Connection error.","request body missing field","line 413 failed","too many tokens","429 rate limit: request body too large"]) assert.equal(isRequestBodyTooLarge({stopReason:"error",errorMessage:message}),false,message);
  assert.equal(isRequestBodyTooLarge({status:413,message:"rate limit"}),true);
  assert.equal(isRequestBodyTooLarge({provider:"cerebras",stopReason:"error",errorMessage:"413 status code (no body)"}),false);
});
test("serialized byte observation uses the existing body and counts UTF-8 without copying it", async () => {
  for (const text of ["plain","中😀", "\ud800","\udc00","a\ud800b"]) assert.equal(requestBodyUtf8Bytes(text),Buffer.byteLength(text));
  let bytes=0, sent=0; const body = JSON.stringify({text:"中😀"});
  const send = observeRequestBody(async (_url, init) => { sent++; assert.equal(init?.body,body); return new Response("ok"); }, n=>{bytes=n;})!;
  await send("https://fixture.invalid",{body}); assert.equal(sent,1); assert.equal(bytes,Buffer.byteLength(body));
});
test("an old encoding completion cannot clear a new generation's cache", async () => {
  let release!:(value:null)=>void, calls=0;
  const owner=new RequestImageBudget(()=>++calls===1?new Promise(resolve=>{release=resolve;}):Promise.resolve({data:"AAAA",mimeType:"image/png",width:1,height:1,originalWidth:2,originalHeight:2,wasResized:true}));
  const old=owner.prepare([tool(100)],{},true); owner.clear();
  const next=[tool(200)]; await owner.prepare(next,{},true); release(null);
  await assert.rejects(old,/policy changed/); assert.equal(owner.metrics.cacheViewBytes,4);
  assert.equal(imageBytes(owner.applyMessages(next)),4); owner.clear();
});
test("413 never repeats at the provider layer even with x-should-retry", async()=>{
  let calls=0; const error=Object.assign(new Error("too big"),{status:413,headers:new Headers({"x-should-retry":"true"})});
  await assert.rejects(retryProviderRequest(async()=>{calls++;throw error;},{maxRetries:3}),e=>e===error); assert.equal(calls,1);
});
test("a shared image object has independent historical occurrences", async()=>{
  const owner=new RequestImageBudget(), shared=tool(7*MiB).content[0]!;
  const messages=[{...tool(0,"old"),content:[shared]},{...tool(0,"current"),content:[shared]}];
  await owner.prepare(messages,{},false); const projected=owner.applyMessages(messages);
  assert.equal(imageBytes(projected),7*MiB); const first=projected[0]!; assert.ok(first.role==="toolResult"&&first.content.some(b=>b.type==="text")); owner.clear();
});
test("mutable hook content cannot reuse a projection for different blocks", async()=>{
  const owner=new RequestImageBudget(), old=tool(7*MiB,"old"), current=tool(7*MiB,"current"), messages=[old,current];
  await owner.prepare(messages,{},false); const first=owner.applyMessages(messages)[0]!;
  old.content.push({type:"text",text:"new hook text"});
  await owner.prepare(messages,{},false); const second=owner.applyMessages(messages)[0]!;
  assert.notEqual(first,second); assert.ok(second.role==="toolResult"&&second.content.some(b=>b.type==="text"&&b.text==="new hook text")); owner.clear();
});
test("projection metadata stays bounded even when many messages share one image", async()=>{
  const owner=new RequestImageBudget(), image=tool(MiB).content[0]!;
  const messages=Array.from({length:5000},(_,i)=>({...tool(0,String(i)),content:[image]}));
  await owner.prepare(messages,{},false); owner.applyMessages(messages);
  assert.ok(owner.metrics.projectionCacheBytes<=2*MiB); assert.equal(owner.metrics.imagesInspected,1);
  owner.clear(); assert.equal(owner.metrics.projectionCacheBytes,0);
});
test("UTF-8 weights and changed outcome metadata are not stale cache entries", async()=>{
  const owner=new RequestImageBudget(), old=tool(7*MiB,"old"), current=tool(7*MiB,"current"), messages=[old,current];
  await owner.prepare(messages,{},false); owner.applyMessages(messages); old.isError=true;
  await owner.prepare(messages,{},false); const next=owner.applyMessages(messages)[0]!;
  assert.ok(next.role==="toolResult"&&next.isError);
  owner.clear(); const small=tool(3); (small.content[0] as ImageContent).data="中中中";
  await owner.prepare([small],{},false); assert.equal(owner.metrics.retainedImageBytes,9); owner.clear();
});
