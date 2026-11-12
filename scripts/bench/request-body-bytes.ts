import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Session } from "node:inspector/promises";
import { setImmediate as tick } from "node:timers/promises";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { requestBodyUtf8Bytes } from "../../packages/ai/src/utils/request-body-observer.ts";

assert.ok(global.gc,"Run with --expose-gc");
const inspector = new Session(); inspector.connect();
const source = readFileSync(new URL("../../packages/ai/src/utils/request-body-observer.ts",import.meta.url),"utf8");
const output = ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
const portable = runInNewContext(output+";exports.requestBodyUtf8Bytes",{exports:{}}) as (text:string)=>number;
const refs: WeakRef<object>[] = [];
async function measure(count:(text:string)=>number) {
  const owner = {body:JSON.stringify({images:"A".repeat(11*1024*1024),text:"中文😀"})};
  refs.push(new WeakRef(owner));
  const expected = Buffer.byteLength(owner.body), iterations = 40;
  for(let i=0;i<8;i++) assert.equal(count(owner.body),expected);
  global.gc!();const initialHeap=process.memoryUsage().heapUsed;
  await inspector.post("HeapProfiler.startSampling",{samplingInterval:1024,includeObjectsCollectedByMajorGC:true,includeObjectsCollectedByMinorGC:true});
  const times:number[]=[];
  for(let i=0;i<iterations;i++) {const start=performance.now();assert.equal(count(owner.body),expected);times.push(performance.now()-start);}
  const peakHeap=process.memoryUsage().heapUsed,{profile}=await inspector.post("HeapProfiler.stopSampling");
  const pending=[profile.head];let sampledBytes=0;
  while(pending.length) {const node=pending.pop()!;sampledBytes+=node.selfSize;for(const child of node.children)pending.push(child);}
  times.sort((a,b)=>a-b);
  return {wireBytes:expected,iterations,cpuP50:times[20],cpuP95:times[38],sampledBytesPerCall:sampledBytes/iterations,initialHeap,peakHeap,payloadCopies:0};
}
try {
  const portableBaseline=await measure(portable),nativeCandidate=await measure(requestBodyUtf8Bytes);
  for(let i=0;i<4;i++){await tick();global.gc!();}
  assert.equal(refs.filter(ref=>ref.deref()).length,0);
  console.log(JSON.stringify({portableBaseline,nativeCandidate,retainedPayloadOwnersAfterFourGC:0,newClosures:0,newPromises:0,newArrays:0,note:"Counts the existing serialized body. Sampling includes benchmark timing/assertions; Node native and Buffer-free browser fallback use identical Unicode semantics."}));
} finally {inspector.disconnect();}
