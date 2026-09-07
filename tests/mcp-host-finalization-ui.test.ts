import assert from "node:assert/strict";
import test from "node:test";
import { alphaSession, alphaModelRuntime } from "./helpers/alpha-session.ts";
// @ts-expect-error JavaScript extension package.
import { McpBridgeRuntime } from "../packages/mcp-bridge/src/bridge.js";

for(const scenario of ["budget","prepare","success","success-wrapped","mutation","replacement"])test(`MCP final UI disposition: ${scenario}`,async()=>{
  let providerCalls=0, toolCalls=0, tool:any;
  const extensions=scenario==="mutation"||scenario==="replacement"?[(pi:any)=>pi.on("message_end",(event:any)=>{
    if(event.message.role!=="toolResult")return;
    if(scenario==="replacement")return {message:{...event.message,content:[{type:"text",text:"EXTENSION_FINAL"}]}};
    event.message.content[0].text="EXTENSION_FINAL";
  })]:[];
  const fixture=await alphaSession({budgetTokens:scenario==="budget"?1:256,extensions,runtime:alphaModelRuntime((()=>{providerCalls++;throw new Error("unexpected provider request");}) as never)});
  const runtime=new McpBridgeRuntime({registerTool(value:any){tool=value;}},"fixture");
  const original=scenario==="budget"||scenario==="prepare"||scenario==="success-wrapped"?"ORIGINAL_SUCCESS ".repeat(6000):"ORIGINAL_SUCCESS";
  runtime.registerRemoteTool({status:"connected",config:{id:"fixture",toolTimeoutMs:1000},client:{async callTool(){toolCalls++;return {content:[{type:"text",text:original}]};}}},{name:"fixture",inputSchema:{type:"object",properties:{}}});
  let ends=0, disposition:any, presentation:any;
  const session:any=fixture.session, mode=fixture.internal;
  const unsubscribe=fixture.session.subscribe((event:any)=>{if(event.type==="message_end"){ends++;disposition=event.toolResultMessageEndDisposition;presentation=event.toolResultPresentation;}return mode.handleEvent(event);});
  try{
    mode.isInitialized=true;
    const runner=session._extensionRunner;
    assert.equal(runner.hasHandlers("tool_result"),false);
    assert.equal(runner.hasHandlers("message_end"),extensions.length>0);
    const id="host-final-call";
    await session._handleAgentEvent({type:"tool_execution_start",toolCallId:id,toolName:tool.name,args:{}});
    const component=mode.pendingTools.get(id);assert.ok(component);
    const raw=await tool.execute(id,{},undefined,undefined,runner.createContext());
    const after=await fixture.session.agent.afterToolCall!({toolCall:{type:"toolCall",id,name:tool.name,arguments:{}},args:{},result:raw,isError:false} as never);
    const result={content:after?.content??raw.content,details:after?.details??raw.details};
    await session._handleAgentEvent({type:"tool_execution_end",toolCallId:id,toolName:tool.name,result,isError:false});
    assert.equal(component.result.content[0].text,original);assert.equal(component.resultIsError,false);
    assert.match(component.render(100).join("\n"),/ORIGINAL_SUCCESS/);
    const message:any={role:"toolResult",toolCallId:id,toolName:tool.name,content:result.content,details:result.details,isError:false,timestamp:0};
    // Exercise final validation independently of the bridge's earlier validation.
    if(scenario==="prepare")message.content[0]={type:"text",text:42};
    fixture.session.agent.state.messages.push(message);
    await session._handleAgentEvent({type:"message_start",message});
    await session._handleAgentEvent({type:"message_end",message});
    const rejected=scenario==="budget"||scenario==="prepare";
    const noChange=scenario==="success"||scenario==="success-wrapped";
    const counts=mode.getToolResultDiscoveryLifecycleCounts();
    assert.equal(component.resultIsError,message.isError,"UI retained the pre-rejection success state");
    assert.deepEqual(component.result.content,message.content);
    assert.deepEqual(component.result.details,message.details);
    assert.equal(ends,1);assert.equal(toolCalls,1);assert.equal(providerCalls,0);
    assert.equal(disposition,rejected?"host-finalized":noChange?"none":scenario==="replacement"?"replacement-returned":"handler-may-have-mutated");
    assert.equal(counts.canonicalPayloadRefreshes,noChange?0:1);
    assert.equal(counts.canonicalPayloadHostFinalizationRefreshes,rejected?1:0);
    assert.equal(counts.canonicalPayloadReplacementRefreshes,scenario==="replacement"?1:0);
    assert.equal(counts.canonicalPayloadConservativeHandlerRefreshes,scenario==="mutation"?1:0);
    assert.equal(counts.pendingEntries,0);assert.equal(counts.attachedEntries,scenario==="success-wrapped"?1:0);
    const saved:any=fixture.sessionManager.getBranch().filter((entry:any)=>entry.type==="message").at(-1);
    assert.deepEqual(saved.message,message);assert.equal("toolResultMessageEndDisposition" in saved.message,false);
    if(rejected){assert.deepEqual(message.content,[]);assert.equal(message.details.mcpError,"input-admission-failed");assert.doesNotMatch(component.render(100).join("\n"),/ORIGINAL_SUCCESS/);assert.equal(counts.canonicalV1RetainedInvalidations,1);}
    const owner=session._toolResultPresentation;
    if(scenario!=="success-wrapped"){assert.equal(presentation.artifact,undefined);assert.equal(presentation.continuation,undefined);assert.equal(component.getToolResultPresentationDiscovery(id),undefined);}
    owner.clearProjectionRecords();owner.dispose();assert.equal(owner.counters.projectionRecordEntries,0);
  }finally{unsubscribe();await runtime.close();await fixture.release();}
});
