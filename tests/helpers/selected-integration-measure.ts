import assert from "node:assert/strict";
import { Session } from "node:inspector/promises";
import { setImmediate as turn } from "node:timers/promises";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { stability } from "./selected-integration-fixture.ts";

assert.equal(typeof globalThis.gc,"function");
async function collect() { await turn(); globalThis.gc!(); await turn(); globalThis.gc!(); await turn(); }
let warm = await stability(2);
const warmWeak=warm.weak;
warm=undefined as never;
await collect();
assert.ok(warmWeak.every(w=>w.deref()===undefined),"warmup owner retained");
const before=process.memoryUsage().heapUsed;
const profiler=new Session(); profiler.connect();
await profiler.post("HeapProfiler.startSampling",{samplingInterval:4096});
let measured=await stability(8);
const {profile}=await profiler.post("HeapProfiler.stopSampling");
profiler.disconnect();
let sampledBytes=0; const pending=[profile.head];
while(pending.length) { const n=pending.pop()!; sampledBytes+=n.selfSize; pending.push(...n.children); }
const metrics=measured.metrics, weak=measured.weak;
measured=undefined as never;
const quiescent=process.memoryUsage().heapUsed;
await collect();
assert.ok(weak.every(w=>w.deref()===undefined),"released owner retained");
const after=process.memoryUsage().heapUsed;
console.log("SELECTED_INTEGRATION "+JSON.stringify({
 head:execFileSync("git",["rev-parse","HEAD"],{encoding:"utf8"}).trim(),
 fixtureHash:createHash("sha256").update(readFileSync(new URL("./selected-integration-fixture.ts",import.meta.url))).digest("hex"),
 node:process.version,platform:process.platform,warmup:2,metrics,samplingInterval:4096,sampledBytes,
 heap:{releasedAfterWarmup:before,quiescentBeforeGC:quiescent,releasedAfterWorkload:after,delta:after-before},
 ownersReleased:true,interpretation:"Bounded offline workload; retained checkpoint delta is not a heap slope, sampled bytes are not total allocation; no timing or provider savings claim."
}));
