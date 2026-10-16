import assert from "node:assert/strict";
import {Session} from "node:inspector/promises";
import {execFileSync} from "node:child_process";
import {setImmediate as yieldLoop} from "node:timers/promises";
import {createToolResultPresentationOwner,createToolResultPresentationCounters,ToolResultContinuationError} from "../../packages/coding-agent/src/core/tool-result-presentation.ts";
import {ToolResultBudgetSelection,ToolResultBudgetComputationError,RESULT_SELECTION_MAX_BYTES,RESULT_SELECTION_MAX_STATES,RESULT_SELECTION_MAX_STEPS} from "../../packages/coding-agent/src/core/tool-result-budget-selection.ts";
import {estimateContextTokensFromParts,estimateMessageTokens} from "@super-pi/ai";
import {assistant,toolResult} from "../../tests/codemode-recovery/fixture.ts";
const image={type:"image" as const,mimeType:"image/png",data:"AA=="};

function fixture(pairs:number) {
  const results=[...Array.from({length:pairs},(_,i)=>toolResult("b"+i,[image])),
    ...Array.from({length:pairs},(_,i)=>toolResult("a"+i,[{type:"text",text:"x"},image]))];
  const source=[assistant(results.map(m=>m.toolCallId)),...results];
  const probe=createToolResultPresentationOwner({enabled:true,budgetTokens:1000000},"selection-bench")!;
  let budget=0,context=0;
  for(const result of results) {
    const record=(probe as any).getOrCreateProjectionRecord(result.content,result.toolCallId,"provider");
    (probe as any).measureContextualMinimum(result,record);
    const full=result.toolCallId.startsWith("a");
    budget+=full?record.contextualFullToolTokens:record.contextualMinimumToolTokens;
    context+=full?record.contextualFullContextTokens:record.contextualMinimumContextTokens;
  }
  probe.dispose();
  const base=estimateContextTokensFromParts(undefined,source,undefined).tokens-results.reduce((s,m)=>s+estimateMessageTokens(m),0);
  const owner=createToolResultPresentationOwner({enabled:true,budgetTokens:budget},"selection-bench")!;
  for(const result of results){owner.create(result.content,result.toolCallId);owner.release();}
  return {owner,source,window:base+5120+context};
}
if(!globalThis.gc)throw new Error("run with --expose-gc");
async function measure(pairs:number) {
  const f=fixture(pairs);
  for(let i=0;i<5;i++)f.owner.projectMessagesForModel(f.source.slice(),undefined,undefined,undefined,f.window,1024,true);
  const before={...f.owner.counters};
  const inspector=new Session();inspector.connect();
  await inspector.post("HeapProfiler.startSampling",{samplingInterval:1024,includeObjectsCollectedByMajorGC:true,includeObjectsCollectedByMinorGC:true});
  const start=performance.now();
  for(let i=0;i<20;i++)f.owner.projectMessagesForModel(f.source.slice(),undefined,undefined,undefined,f.window,1024,true);
  const durationMs=performance.now()-start;
  const {profile}=await inspector.post("HeapProfiler.stopSampling");inspector.disconnect();
  let sampledBytes=0;const sites:any[]=[];
  function collect(node:any):void {sampledBytes+=node.selfSize??0;if(node.selfSize)sites.push({bytes:node.selfSize,functionName:node.callFrame.functionName,url:node.callFrame.url,line:node.callFrame.lineNumber+1});for(const child of node.children??[])collect(child);}
  collect(profile.head);sites.sort((a,b)=>b.bytes-a.bytes);
  const counts=f.owner.counters;
  const calls=counts.contextualChoiceCalls!-before.contextualChoiceCalls!;
  assert.equal(calls,20);assert.equal(counts.contextualChoiceActiveBytes,0);
  assert.equal(counts.fullSourceEstimatorScans-before.fullSourceEstimatorScans,0);
  assert.ok(counts.contextualChoicePeakBytes!<=RESULT_SELECTION_MAX_BYTES);
  f.owner.dispose();
  return {pairs,warmupRuns:5,measuredRuns:20,durationMs,sampledBytes,leadingAllocations:sites.slice(0,20),
    exactCalls:calls,statesPerCall:(counts.contextualChoiceStates!-before.contextualChoiceStates!)/20,
    stepsPerCall:(counts.contextualChoiceSteps!-before.contextualChoiceSteps!)/20,
    allocatedBackingBytesPerCall:(counts.contextualChoiceAllocatedBackingBytes!-before.contextualChoiceAllocatedBackingBytes!)/20,
    peakAccountedBytes:counts.contextualChoicePeakBytes,steadyFullSourceScans:0,counters:counts};
}
const measurements=[await measure(1),await measure(64)];
const originalDispose=ToolResultBudgetSelection.prototype.dispose;
let currentRefs:WeakRef<object>[]|undefined;
function observedDispose(this:ToolResultBudgetSelection):void {
  if(currentRefs) {
    currentRefs.push(new WeakRef(this));
    const costs=(this as any).costs as Float64Array|undefined;
    const workspace=(this as any).workspace as ArrayBuffer|undefined;
    if(costs)currentRefs.push(new WeakRef(costs),new WeakRef(costs.buffer));
    if(workspace)currentRefs.push(new WeakRef(workspace));
  }
  originalDispose.call(this);
}
function lifecycle(mode:string) {
  const f=fixture(1),refs:WeakRef<object>[]=[new WeakRef(f.owner)];
  currentRefs=refs;
  const error=mode==="cancel"?new DOMException("cancelled","AbortError"):new Error("observer failed");
  try {
    if(mode==="resource-limit") {
      f.owner.dispose();
      const ids=Array.from({length:256},(_,i)=>String(i));
      const source=[assistant(ids),...ids.map(id=>toolResult(id,[image]))];
      const owner=createToolResultPresentationOwner({enabled:true,budgetTokens:8000},"resource")!;
      refs.push(new WeakRef(owner));
      try {assert.throws(()=>owner.projectMessagesForModel(source.slice(),undefined,undefined,undefined,65536,1024,true),ToolResultBudgetComputationError);}
      finally {owner.dispose();assert.equal(owner.counters.contextualChoiceActiveBytes,0);}
    } else if(mode==="budget-failure") {
      assert.throws(()=>f.owner.projectMessagesForModel(f.source.slice(),undefined,undefined,undefined,f.window-1200,1024,true),ToolResultContinuationError);
    } else if(mode==="failure"||mode==="cancel") {
      assert.throws(()=>f.owner.projectMessagesForModel(f.source.slice(),undefined,undefined,undefined,f.window,1024,true,undefined,
        {recordToolResultProjection(){throw error;}}),e=>e===error);
    } else f.owner.projectMessagesForModel(f.source.slice(),undefined,undefined,undefined,f.window,1024,true);
    if(mode==="clear")f.owner.clearProjectionRecords();
  } finally {currentRefs=undefined;f.owner.dispose();}
  assert.equal(f.owner.counters.contextualChoiceActivePlans,0);assert.equal(f.owner.counters.contextualChoiceActiveBytes,0);
  return {mode,refs,counters:f.owner.counters};
}
let endings:ReturnType<typeof lifecycle>[];
function linearLifecycle(mode:string) {
  const counters=createToolResultPresentationCounters(),refs:WeakRef<object>[]=[];
  const plan=new ToolResultBudgetSelection(3,counters);
  currentRefs=refs;
  try {
    for(let index=0;index<3;index++)plan.set(index,100,5000,30000,4000,false);
    assert.equal(plan.solve(100000,mode==="linear-reject"?10000:13000),mode==="linear-select-all");
  } finally {plan.dispose();currentRefs=undefined;}
  assert.equal(counters.contextualChoiceStates,0);
  assert.equal(counters.contextualChoiceAllocatedBackingBytes,144);
  assert.equal(counters.contextualChoiceActiveBytes,0);
  assert.equal(counters.contextualChoiceActivePlans,0);
  return {mode,refs,counters};
}
ToolResultBudgetSelection.prototype.dispose=observedDispose;
try {
  endings=["normal","budget-failure","failure","cancel","clear","dispose","resource-limit"].map(lifecycle);
  endings.push(linearLifecycle("linear-reject"),linearLifecycle("linear-select-all"));
}
finally {ToolResultBudgetSelection.prototype.dispose=originalDispose;}
for(let i=0;i<6;i++){await yieldLoop();globalThis.gc();}
const lifecycles=endings.map(x=>({mode:x.mode,trackedReferences:x.refs.length,retainedAfterGc:x.refs.filter(ref=>ref.deref()).length,counters:x.counters}));
for(const result of lifecycles)assert.equal(result.retainedAfterGc,0,result.mode);
console.log(JSON.stringify({benchmark:"codemode-budget-selection",commit:execFileSync("git",["rev-parse","HEAD"],{encoding:"utf8"}).trim(),
  worktreeStatus:execFileSync("git",["status","--short"],{encoding:"utf8"}).trim(),node:process.version,v8:process.versions.v8,
  limits:{states:RESULT_SELECTION_MAX_STATES,steps:RESULT_SELECTION_MAX_STEPS,accountedBytes:RESULT_SELECTION_MAX_BYTES,fixedHeaderAllowance:4096},
  memoryAccounting:"Both typed backing stores plus a fixed 4096-byte plan/view header allowance; HeapProfiler sampled bytes are separate and do not measure all external ArrayBuffer backing storage.",
  cancellationScope:"Synchronous projection observer AbortError; no OS/Worker cancellation claim",samplingIntervalBytes:1024,measurements,lifecycles},null,2));
