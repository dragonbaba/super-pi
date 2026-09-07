import assert from "node:assert/strict";
import test from "node:test";
import { alphaHeadless, alphaModelRuntime } from "./helpers/alpha-session.ts";
import { createToolResultPresentationOwner, getToolResultModelContent, getToolResultUiContent } from "../packages/coding-agent/src/core/tool-result-presentation.ts";
// @ts-expect-error JavaScript extension package.
import { McpBridgeRuntime, convertMcpResult } from "../packages/mcp-bridge/src/bridge.js";

const large = "initial ".repeat(12_000), replacement = "replacement ".repeat(12_000);
const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aP9sAAAAASUVORK5CYII=";
const jpeg = Buffer.concat([Buffer.from([255,216,255]),Buffer.alloc(60_000)]).toString("base64");

for (const hook of ["tool_result", "message_end"]) for (const kind of ["text", "image"]) {
  test(`public MCP ${kind} remains mutable through real ${hook} runner`, async () => {
    const fixture = await alphaHeadless(alphaModelRuntime());
    const owner = createToolResultPresentationOwner({enabled:true,budgetTokens:256},fixture.session.sessionManager.getSessionId())!;
    let tool: any, observed = false, final: any, view: any;
    const runtime = new McpBridgeRuntime({registerTool(value: any){tool=value;}},"fixture");
    const initial = kind === "text" ? {type:"text",text:large} : {type:"image",data:jpeg,mimeType:"image/jpeg"};
    runtime.registerRemoteTool({status:"connected",config:{id:"fixture",toolTimeoutMs:1000},client:{async callTool(){return {content:[initial,{type:"text",text:large}]};}}},{name:"fixture",inputSchema:{type:"object",properties:{}}});
    try {
      (fixture.session as any)._toolResultPresentation=owner;
      const runner=(fixture.session as any)._extensionRunner;
      runner.handlerEventTypes.add(hook);
      runner.extensions.push({path:"fixture-extension",handlers:new Map([[hook,[ (event: any) => {
        const content=hook==="message_end"?event.message.content:event.content;
        assert.equal(Object.isFrozen(content[0]),false);
        assert.equal(owner.counters.projectionRecordEntries,0);
        assert.equal(owner.counters.sourceDigestConstructions,0);
        assert.equal(owner.counters.artifactDescriptorsCreated,0);
        if(kind==="text")content[0].text=replacement;
        else {content[0].data=png;content[0].mimeType="image/png";}
        observed=true;
      }]]])});
      fixture.session.subscribe((event: any)=>{if(event.type==="message_end"){final=event.message;view=event.toolResultPresentation;}});
      const result=await tool.execute("mutable-call",{},undefined,undefined,runner.createContext());
      const after=await fixture.session.agent.afterToolCall!({toolCall:{type:"toolCall",id:"mutable-call",name:tool.name,arguments:{}},args:{},result,isError:false} as never);
      const message={role:"toolResult",toolCallId:"mutable-call",toolName:tool.name,content:after?.content??result.content,details:after?.details??result.details,isError:false,timestamp:0};
      await (fixture.session as any)._handleAgentEvent({type:"message_end",message});
      assert.equal(observed,true,"hook failed before mutation");
      assert.equal(final.content[0][kind==="text"?"text":"data"],kind==="text"?replacement:png);
      const saved: any=fixture.session.sessionManager.getBranch().filter((e:any)=>e.type==="message").at(-1);
      assert.equal(saved.message.content[0][kind==="text"?"text":"data"],kind==="text"?replacement:png);
      assert.equal(getToolResultModelContent(view,final.content),view.modelContent);
      assert.equal(getToolResultUiContent(view,final.content)[0],final.content[0]);
      assert.ok(view.truncation.modelEstimatedTokens<=256);
      assert.equal(owner.readArtifact(view.artifact.id,[final]).content[0],final.content[0]);
      assert.equal(owner.counters.sourceDigestConstructions,1);
    } finally {owner.dispose();assert.equal(owner.counters.projectionRecordEntries,0);await runtime.close();await fixture.release();}
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
