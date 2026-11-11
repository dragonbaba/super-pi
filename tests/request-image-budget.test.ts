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
  assert.equal(owner.metrics.retainedImageBytes,1200); owner.clear();
});
test("the complete originating assistant batch is protected", async () => {
  const assistant: Message = {role:"assistant",api:"openai-completions",provider:"openai",model:"fixture",content:[],stopReason:"toolUse",timestamp:0,
    usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}}};
  const owner = new RequestImageBudget(), messages = [assistant,tool(4*MiB,"one"),tool(4*MiB,"two"),tool(4*MiB,"three")];
  await owner.prepare(messages,{},false); assert.equal(imageBytes(owner.applyMessages(messages)),12*MiB);
  await assert.rejects(owner.prepare([assistant,tool(7*MiB,"one"),tool(7*MiB,"two")],{},false),/current tool images exceed/); owner.clear();
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
