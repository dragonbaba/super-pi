import assert from "node:assert/strict";
import {Session} from "node:inspector/promises";
import {setImmediate as yieldLoop} from "node:timers/promises";
import {execFileSync} from "node:child_process";
import {createToolResultPresentationOwner,ToolResultContinuationError} from "../../packages/coding-agent/src/core/tool-result-presentation.ts";
import {estimateToolOutputTokens} from "../../packages/coding-agent/src/core/tool-output-budget.ts";
import {toolResult} from "../../tests/codemode-recovery/fixture.ts";

if(!globalThis.gc)throw Error("run with --expose-gc");
async function measure(codeUnits:number){
  const long="2#5678|"+"中".repeat(codeUnits)+"\n";
  const source=[{type:"text" as const,readBoundary:"lines" as const,text:"1#1234|short\n"+long+"3#7890|tail\n"},
    {type:"text" as const,readBoundary:"metadata" as const,text:"[Snapshot edit] snapshot=snap_0000000000000000000000; editable lines=1-3. Use the paired anchors."}];
  const owner=createToolResultPresentationOwner({enabled:true,budgetTokens:512},"diagnostic")!;
  const view=owner.create(source,"read")!;owner.release();assert.equal(view.version,2);
  if(view.version!==2)throw Error("expected recovery view");
  const messages=[toolResult("read",source)],expected=estimateToolOutputTokens([{type:"text",text:long}]).estimatedTokens;
  const refs=[new WeakRef(owner),new WeakRef(source),new WeakRef(messages),new WeakRef(messages[0]!),new WeakRef(source[0]!)];
  function attempt(){try{owner.readContinuation(view.continuation.cursor,messages,1);assert.fail("must reject atomic line");}catch(e){assert.ok(e instanceof ToolResultContinuationError);assert.equal(e.minimumTokens,expected);}}
  for(let i=0;i<5;i++)attempt();
  const copies=owner.counters.boundedTextStringsCreated,scans=owner.counters.fullSourceEstimatorScans;
  const inspector=new Session();inspector.connect();
  await inspector.post("HeapProfiler.startSampling",{samplingInterval:1024,includeObjectsCollectedByMajorGC:true,includeObjectsCollectedByMinorGC:true});
  const start=performance.now();for(let i=0;i<20;i++)attempt();const durationMs=performance.now()-start;
  const {profile}=await inspector.post("HeapProfiler.stopSampling");inspector.disconnect();
  const sites:any[]=[];let sampledBytes=0;
  function collect(node:any):void{sampledBytes+=node.selfSize??0;if(node.selfSize)sites.push({bytes:node.selfSize,functionName:node.callFrame.functionName,url:node.callFrame.url,line:node.callFrame.lineNumber+1});for(const child of node.children??[])collect(child);}
  collect(profile.head);sites.sort((a,b)=>b.bytes-a.bytes);
  assert.equal(owner.counters.boundedTextStringsCreated,copies);assert.equal(owner.counters.fullSourceEstimatorScans,scans);
  owner.dispose();assert.equal(owner.counters.projectionRecordEntries,0);assert.equal(owner.counters.retainedProjectionCodeUnits,0);
  return {codeUnits,expectedMinimumTokens:expected,warmupRuns:5,measuredRuns:20,durationMs,sampledBytes,leadingAllocations:sites.slice(0,15),
    diagnosticTextMaterializations:owner.counters.boundedTextStringsCreated-copies,sourceRescans:owner.counters.fullSourceEstimatorScans-scans,
    rangeScannedCodeUnitsPerFailure:long.length,refs};
}
const reports=[];
for(const size of [1024*1024,10*1024*1024])reports.push(await measure(size));
for(let i=0;i<8;i++){await yieldLoop();globalThis.gc();}
const measurements=reports.map(({refs,...data})=>({...data,trackedReferences:refs.length,retainedAfterGc:refs.filter(r=>r.deref()).length}));
for(const row of measurements)assert.equal(row.retainedAfterGc,0);
console.log(JSON.stringify({benchmark:"codemode-budget-diagnostic",commit:execFileSync("git",["rev-parse","HEAD"],{encoding:"utf8"}).trim(),
 worktreeStatus:execFileSync("git",["status","--short"],{encoding:"utf8"}),node:process.version,v8:process.versions.v8,
 samplingIntervalBytes:1024,note:"Single-run reference. Range scanning is linear and reported explicitly; no diagnostic substring is created. Other lifecycle modes use the batch/selection production benchmarks.",measurements},null,2));
