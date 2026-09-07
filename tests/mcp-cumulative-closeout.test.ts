import assert from "node:assert/strict";
import test from "node:test";
import crypto from "node:crypto";
import { syncBuiltinESMExports } from "node:module";
import { alphaHeadless, alphaModelRuntime } from "./helpers/alpha-session.ts";
import { createToolResultPresentationOwner, getToolResultModelContent, getToolResultUiContent } from "../packages/coding-agent/src/core/tool-result-presentation.ts";
// @ts-expect-error JavaScript extension package.
import { McpBridgeRuntime, convertMcpResult } from "../packages/mcp-bridge/src/bridge.js";

const large = "initial ".repeat(12_000), replacement = "replacement ".repeat(12_000);
const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aP9sAAAAASUVORK5CYII=";
function pngWithMetadata(label: string): string {
  const original=Buffer.from(png,"base64"), data=Buffer.from("fixture\0"+label.repeat(12_000));
  const chunk=Buffer.alloc(data.length+12);chunk.writeUInt32BE(data.length);chunk.write("tEXt",4);data.copy(chunk,8);
  let crc=0xffffffff;
  for(let i=4;i<chunk.length-4;i++){crc^=chunk[i]!;for(let bit=0;bit<8;bit++)crc=(crc>>>1)^((crc&1)?0xedb88320:0);}
  chunk.writeUInt32BE((crc^0xffffffff)>>>0,chunk.length-4);
  return Buffer.concat([original.subarray(0,33),chunk,original.subarray(33)]).toString("base64");
}
const largePng=pngWithMetadata("initial"), replacementPng=pngWithMetadata("replacement");

for (const hook of ["tool_result", "message_end"]) for (const kind of ["text", "image"]) for(const mode of ["in-place","returned","splice","no-op","no-handler"]) {
  test(`public MCP ${kind} remains mutable through real ${hook} runner: ${mode}`, async () => {
    const fixture = await alphaHeadless(alphaModelRuntime());
    const owner = createToolResultPresentationOwner({enabled:true,budgetTokens:256},fixture.session.sessionManager.getSessionId())!;
    let tool: any, observed = false, final: any, view: any;
    const runtime = new McpBridgeRuntime({registerTool(value: any){tool=value;}},"fixture");
    const initial = kind === "text" ? {type:"text",text:large} : {type:"image",data:largePng,mimeType:"image/png"};
    const changed=mode!=="no-op"&&mode!=="no-handler";
    const expected=kind==="text"?(changed?replacement:large):(changed?replacementPng:largePng);
    const originalHash=crypto.createHash;
    let fullHashes=0;
    crypto.createHash=((...args: any[])=>{const hash=(originalHash as any)(...args), update=hash.update;hash.update=function(value:any,...rest:any[]){if(value===expected)fullHashes++;return update.call(this,value,...rest);};return hash;}) as any;
    syncBuiltinESMExports();
    runtime.registerRemoteTool({status:"connected",config:{id:"fixture",toolTimeoutMs:1000},client:{async callTool(){return {content:[initial,{type:"text",text:large}]};}}},{name:"fixture",inputSchema:{type:"object",properties:{}}});
    try {
      (fixture.session as any)._toolResultPresentation=owner;
      const runner=(fixture.session as any)._extensionRunner;
      const errors: any[]=[];runner.onError((error:any)=>errors.push(error));
      if(mode!=="no-handler")runner.handlerEventTypes.add(hook);
      if(mode!=="no-handler")runner.extensions.push({path:"fixture-extension",handlers:new Map([[hook,[ (event: any) => {
        const content=hook==="message_end"?event.message.content:event.content;
        assert.equal(Object.isFrozen(content[0]),false);
        assert.equal(owner.counters.projectionRecordEntries,0);
        assert.equal(owner.counters.sourceDigestConstructions,0);
        assert.equal(owner.counters.artifactDescriptorsCreated,0);
        observed=true;
        if(mode==="no-op")return;
        const block=kind==="text"?{type:"text",text:replacement}:{type:"image",data:replacementPng,mimeType:"image/png"};
        if(mode==="returned")return hook==="message_end"?{message:{...event.message,content:[block,content[1]]}}:{content:[block,content[1]]};
        if(mode==="splice"){content.splice(0,1,block);content.push({type:"text",text:"added"});return;}
        if(kind==="text")content[0].text=replacement;
        else {content[0].data=replacementPng;content[0].mimeType="image/png";}
      }]]])});
      fixture.session.subscribe((event: any)=>{if(event.type==="message_end"){final=event.message;view=event.toolResultPresentation;}});
      const result=await tool.execute("mutable-call",{},undefined,undefined,runner.createContext());
      const after=await fixture.session.agent.afterToolCall!({toolCall:{type:"toolCall",id:"mutable-call",name:tool.name,arguments:{}},args:{},result,isError:false} as never);
      const message={role:"toolResult",toolCallId:"mutable-call",toolName:tool.name,content:after?.content??result.content,details:after?.details??result.details,isError:false,timestamp:0};
      await (fixture.session as any)._handleAgentEvent({type:"message_end",message});
      assert.deepEqual(errors,[]);
      assert.equal(observed,mode!=="no-handler","hook failed before mutation");
      assert.equal(final.content[0][kind==="text"?"text":"data"],expected);
      const saved: any=fixture.session.sessionManager.getBranch().filter((e:any)=>e.type==="message").at(-1);
      assert.equal(saved.message.content[0][kind==="text"?"text":"data"],expected);
      assert.equal(getToolResultModelContent(view,final.content),view.modelContent);
      assert.equal(getToolResultUiContent(view,final.content)[0],final.content[0]);
      assert.ok(view.truncation.modelEstimatedTokens<=256);
      assert.equal(owner.readArtifact(view.artifact.id,[final]).content[0],final.content[0]);
      assert.equal(owner.counters.sourceDigestConstructions,1);
      const digestCount=fullHashes;
      for(let i=0;i<3;i++)owner.readArtifact(view.artifact.id,[final]);
      owner.readContinuation(view.continuation.cursor,[final]);
      assert.equal(fullHashes,digestCount);
      assert.equal(digestCount,kind==="text"&&!changed?2:1); // Two distinct same-valued canonical text blocks in the unchanged fixture.
    } finally {crypto.createHash=originalHash;syncBuiltinESMExports();owner.dispose();assert.equal(owner.counters.projectionRecordEntries,0);await runtime.close();await fixture.release();}
  });
}

for(const configured of [false,true]) for(const kind of ["resource","resource_link","meta"]) test(`small ${kind} compatible with G2 ${configured}`,()=>{
  const input=kind==="resource"?{content:[{type:"resource",resource:{uri:"https://example.test/small.txt",text:"SMALL-RESOURCE-OK"}}]}:
    kind==="resource_link"?{content:[{type:"resource_link",name:"documentation",uri:"https://example.test/docs"}]}:
    {content:[{type:"text",text:"SMALL-META-OK"}],_meta:{implementationDetail:1}};
  const content=convertMcpResult(input,configured);
  const visible=content.map((b:any)=>b.text??"").join("\n");
  assert.match(visible,kind==="resource"?/SMALL-RESOURCE-OK/:kind==="resource_link"?/example.test\/docs/:/SMALL-META-OK/);
  if(kind!=="meta")assert.equal(content.some((b:any)=>b.mcpSource),false);
  if(!configured)assert.equal(visible.includes("implementationDetail"),false);
});

for(const mimeType of ["image/bmp","image/tiff"]) test(`legacy image subtype ${mimeType} stays typed`,()=>{
  const bytes=mimeType==="image/bmp"?Buffer.alloc(58):Buffer.from("49492a0008000000000000000000","hex");
  if(mimeType==="image/bmp"){bytes.write("BM");bytes.writeUInt32LE(58,2);bytes.writeUInt32LE(54,10);bytes.writeUInt32LE(40,14);bytes.writeInt32LE(1,18);bytes.writeInt32LE(1,22);bytes.writeUInt16LE(1,26);bytes.writeUInt16LE(24,28);}
  for(const configured of [false,true])assert.deepEqual(convertMcpResult({content:[{type:"image",mimeType,data:bytes.toString("base64")}]},configured),[{type:"image",mimeType,data:bytes.toString("base64")}]);
});

test("resource link secrets are not exposed inline",()=>{
  try {const content=convertMcpResult({content:[{type:"resource_link",name:"documentation",uri:"https://user:password@example.test/path?token=secret#secret"}]},false);assert.doesNotMatch(JSON.stringify(content),/password|token=secret|#secret/);}
  catch(error){assert.doesNotMatch(String(error),/password|token=secret|#secret/);}
});

for(const budget of [undefined,1,256]) test(`final message_end failure is delivered once: ${budget}`,async()=>{
  const fixture=await alphaHeadless(alphaModelRuntime());
  const owner=budget===undefined?undefined:createToolResultPresentationOwner({enabled:true,budgetTokens:budget},fixture.session.sessionManager.getSessionId());
  let delivered=0;
  try {
    (fixture.session as any)._toolResultPresentation=owner;
    const runner=(fixture.session as any)._extensionRunner;
    runner.handlerEventTypes.add("message_end");
    runner.extensions.push({path:"fixture",handlers:new Map([["message_end",[(event:any)=>{assert.equal(owner?.counters.projectionRecordEntries??0,0);event.message.content[0].text=budget===256?"x".repeat(11*1024*1024):large;}]]])});
    fixture.session.subscribe((event:any)=>{if(event.type==="message_end")delivered++;});
    const message:any={role:"toolResult",toolCallId:"final-fail",toolName:"mcp__fixture__fixture",content:[{type:"text",text:"tiny"}],isError:false,timestamp:0};
    await (fixture.session as any)._handleAgentEvent({type:"message_end",message});
    assert.equal(delivered,1);assert.equal(message.isError,true);assert.deepEqual(message.content,[]);
    assert.match(message.details.configurationReason,/configured/);
    assert.equal(fixture.session.sessionManager.getBranch().filter((e:any)=>e.type==="message").length,1);
  }finally{owner?.dispose();await fixture.release();}
});

for(const input of [
  {content:[{type:"resource",resource:{uri:"fixture://text",text:large}}]},
  {content:[{type:"resource",resource:{uri:"fixture://blob",blob:"YQ=="}}]},
  {content:[{type:"audio",mimeType:"audio/flac",data:"ZkxhQw=="}]},
  {content:[],structuredContent:{text:large}},
])test("recovery-required source remains fail closed without G2",()=>{
  assert.throws(()=>convertMcpResult(input,false),{code:"budget-not-configured"});
  assert.ok(convertMcpResult(input,true).some((b:any)=>b.mcpSource));
});

for(const block of [
  {type:"image",data:"ab=",mimeType:"image/bmp"},
  {type:"image",data:png,mimeType:"image/jpeg"},
  {type:"image",data:"/9j/",mimeType:"image/png"},
  {type:"image",data:Buffer.alloc(5*1024*1024+1).toString("base64"),mimeType:"image/bmp"},
])test("legacy subtype support preserves encoding/signature/size rejection",()=>{
  assert.throws(()=>convertMcpResult({content:[block]},true));
});
