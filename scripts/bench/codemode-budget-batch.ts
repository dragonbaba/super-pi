import assert from "node:assert/strict";
import {Session} from "node:inspector/promises";
import {setImmediate as yieldLoop} from "node:timers/promises";
import {execFileSync} from "node:child_process";
import {createToolResultPresentationOwner} from "../../packages/coding-agent/src/core/tool-result-presentation.ts";
import type {Message,ToolResultMessage} from "../../packages/ai/src/types.ts";
import {estimateContextTokens,contextForModelCapabilities,deriveModelCapabilities} from "@super-pi/ai";
import {REQUEST_ESTIMATE_MODEL} from "../../tests/fixtures/request-input-estimate.ts";

function fixture(count:number, mode="normal") {
  const owner=createToolResultPresentationOwner({enabled:true,budgetTokens:Math.max(1024,count*4)},`batch-${count}-${mode}`)!;
  const calls=Array.from({length:count},(_,i)=>({type:"toolCall" as const,id:`id-${i}`,name:"fixture",arguments:{}}));
  const messages:Message[]=[{role:"assistant",content:calls,api:"openai-completions",provider:"fixture",model:"fixture",
    stopReason:"toolUse",timestamp:1,usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}}}];
  for(let i=0;i<count;i++) {
    const result:ToolResultMessage={role:"toolResult",toolCallId:`id-${i}`,toolName:"fixture",content:[{type:"text",text:i===0?"diagnostic result\n".repeat(16384):"ok"}],isError:false,timestamp:2};
    messages.push(result);
    if(count<=128) {owner.create(result.content,result.toolCallId);owner.release();}
  }
  return {owner,messages};
}

function lifecycle(mode:string) {
  const {owner,messages}=fixture(20,mode);
  const refs=[new WeakRef(owner),new WeakRef(messages),new WeakRef(messages[1]!),new WeakRef(messages[1]!.content as object)];
  const failure=mode==="cancel"?new DOMException("cancelled","AbortError"):new Error("observer failure");
  const observer={recordToolResultProjection(){throw failure;}};
  if(mode==="failure"||mode==="cancel") assert.throws(()=>owner.projectMessagesForModel(messages.slice(),undefined,undefined,undefined,128000,4096,false,undefined,observer),e=>e===failure);
  else owner.projectMessagesForModel(messages.slice(),undefined,undefined,undefined,128000,4096);
  const counters=owner.counters;
  assert.equal(counters.activeContextualCoordinators,0);
  assert.equal(counters.contextualPreparedRecords,0);
  if(mode==="clear") owner.clearProjectionRecords();
  owner.dispose();
  assert.equal(counters.projectionRecordEntries,0);
  assert.equal(counters.retainedProjectionCodeUnits,0);
  return {mode,refs,counters};
}

if(!globalThis.gc) throw new Error("run with --expose-gc");
const inspector=new Session();inspector.connect();
const f=fixture(20);
for(let i=0;i<5;i++)f.owner.projectMessagesForModel(f.messages.slice(),undefined,undefined,undefined,128000,4096);
const scansBefore=f.owner.counters.fullSourceEstimatorScans;
await inspector.post("HeapProfiler.startSampling",{samplingInterval:1024,includeObjectsCollectedByMajorGC:true,includeObjectsCollectedByMinorGC:true});
const start=performance.now();
for(let i=0;i<20;i++)f.owner.projectMessagesForModel(f.messages.slice(),undefined,undefined,undefined,128000,4096);
const durationMs=performance.now()-start;
const {profile}=await inspector.post("HeapProfiler.stopSampling");inspector.disconnect();
const sites:any[]=[];let sampledBytes=0;
function collect(node:any):void {sampledBytes+=node.selfSize??0;if(node.selfSize)sites.push({bytes:node.selfSize,functionName:node.callFrame.functionName,url:node.callFrame.url,line:node.callFrame.lineNumber+1});for(const child of node.children??[])collect(child);}
collect(profile.head);sites.sort((a,b)=>b.bytes-a.bytes);
const projectionSampledBytes=sampledBytes;
const steadyFullSourceScans=f.owner.counters.fullSourceEstimatorScans-scansBefore;
assert.equal(steadyFullSourceScans,0);
f.owner.dispose();
const pressure=fixture(256);
pressure.owner.projectMessagesForModel(pressure.messages.slice(),undefined,undefined,undefined,128000,4096);
assert.equal(pressure.owner.counters.contextualPreparedRecordsHighWaterMark,128);
assert.equal(pressure.owner.counters.contextualPreparedRecords,0);
assert.equal(pressure.owner.counters.fullSourceEstimatorScans,384);
pressure.owner.dispose();
const endings=["normal","failure","cancel","clear","dispose"].map(lifecycle);
for(let i=0;i<6;i++){await yieldLoop();globalThis.gc();}
const lifecycleResults=endings.map(({mode,refs,counters})=>({mode,retainedReferences:refs.filter(ref=>ref.deref()).length,counters}));
for(const result of lifecycleResults)assert.equal(result.retainedReferences,0,result.mode);
// Exercise the sender's capability-aware production estimator separately. The
// actual normalization below is a reference outside the measured region.
const capabilityContext={messages:[{role:"toolResult",toolCallId:"cap",toolName:"fixture",timestamp:2,isError:false,
  content:[{type:"text",text:"source text\n".repeat(100000)},...Array.from({length:20},()=>({type:"image",mimeType:"image/png",data:"AA=="}))]} as ToolResultMessage],
  tools:[{name:"unused",description:"schema ".repeat(100000),parameters:{type:"object",properties:{}}}]};
const capabilityModel={...REQUEST_ESTIMATE_MODEL,capabilities:{...deriveModelCapabilities(REQUEST_ESTIMATE_MODEL),toolCalling:false}};
const expectedCapabilityTokens=estimateContextTokens(contextForModelCapabilities(capabilityModel,capabilityContext)).tokens;
for(let i=0;i<5;i++)assert.equal(estimateContextTokens(capabilityContext,false).tokens,expectedCapabilityTokens);
const capabilityInspector=new Session();capabilityInspector.connect();
await capabilityInspector.post("HeapProfiler.startSampling",{samplingInterval:1024,includeObjectsCollectedByMajorGC:true,includeObjectsCollectedByMinorGC:true});
const capabilityStart=performance.now();
for(let i=0;i<20;i++)assert.equal(estimateContextTokens(capabilityContext,false).tokens,expectedCapabilityTokens);
const capabilityDurationMs=performance.now()-capabilityStart;
const capabilityProfile=await capabilityInspector.post("HeapProfiler.stopSampling");capabilityInspector.disconnect();
const previousSites=sites.slice();sites.length=0;sampledBytes=0;collect(capabilityProfile.profile.head);sites.sort((a,b)=>b.bytes-a.bytes);
const capabilityEstimate={sourceTextCodeUnits:1100000,omittedSchemaCodeUnits:700000,imageBlocks:20,measuredRuns:20,expectedTokens:expectedCapabilityTokens,durationMs:capabilityDurationMs,sampledBytes,leadingAllocations:sites.slice(0,20)};
console.log(JSON.stringify({benchmark:"codemode-budget-batch",commit:execFileSync("git",["rev-parse","HEAD"],{encoding:"utf8"}).trim(),
  node:process.version,v8:process.versions.v8,warmupRuns:5,measuredRuns:20,samplingIntervalBytes:1024,durationMs,sampledBytes:projectionSampledBytes,
  bytesPerRequest:projectionSampledBytes/20,leadingAllocations:previousSites.slice(0,20),steadyFullSourceScans,capabilityEstimate,
  copyEvidence:"AST/source invariant checks; no runtime copy/serialization counter",
  counters:f.owner.counters,pressure:pressure.owner.counters,lifecycles:lifecycleResults},null,2));
