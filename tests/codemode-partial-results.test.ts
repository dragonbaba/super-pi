import assert from "node:assert/strict";
import test from "node:test";
import { executionFixture } from "./codemode-recovery/execution-fixture.ts";
import { body } from "./codemode-recovery/fixture.ts";

test("ignored helper rejection cannot commit store, while an awaited catch still can",async t=>{
  const f=await executionFixture(t);
  const first=await f.run('describeTools("invalid");store("bad",true);');
  assert.equal(first.result.isError,true,body(first.result.content));
  assert.equal(first.result.details.codemode.calls.length,0);assert.equal(first.result.details.codemode.unobservedHelpers,1);
  assert.match(body(first.result.content),/CODEMODE_UNOBSERVED_CALL.*describeTools.*expects up to 16 names/);
  const second=await f.run('try{await describeTools("invalid")}catch{}store("good",true);text(load("bad")??null);');
  assert.equal(second.result.isError,false,body(second.result.content));assert.match(body(second.result.content),/null/);
  assert.match(body((await f.run('text(load("good"))')).result.content),/true/);
});

test("all handled failures complete the script without claiming a successful child",async t=>{
  const f=await executionFixture(t);
  const first=await f.run('await Promise.allSettled([tools.probe({kind:"failure"}),callTool("probe",{kind:"failure"})]);store("handled",2);');
  const result=first.result;assert.equal(result.isError,false,body(result.content));
  const facts=result.details.codemode;
  assert.deepEqual([facts.succeeded,facts.failed,facts.handledFailures,facts.unhandled],[0,2,2,0]);
  assert.equal(facts.calls.length,2);assert.equal(facts.runtimeCalls.length,1,"globals are not double-counted as tools");
  assert.match(body(result.content),/CODEMODE_PARTIAL.*[\s\S]*no child succeeded/);
  assert.deepEqual(f.calls,["failure","failure"]);
  assert.match(body((await f.run('text(load("handled"))')).result.content),/\n2/);
});

test("caught preflight errors retain one host identity and never enter a tool",async t=>{
  const f=await executionFixture(t);
  const {result}=await f.run('await Promise.allSettled([tools.probe(null)]);store("preflight",true);');
  assert.equal(result.isError,false,body(result.content));
  const facts=result.details.codemode;
  assert.equal(facts.calls.length,1);assert.equal(facts.runtimeCalls.length,1);
  assert.equal(facts.calls[0].runtimeCallId,facts.runtimeCalls[0].id);
  assert.equal(facts.calls[0].executionStatus,"not_executed");
  assert.deepEqual([facts.failed,facts.handledFailures,facts.unhandled],[1,1,0]);
  assert.equal(f.calls.length,0);
  assert.match(body((await f.run('text(load("preflight"))')).result.content),/true/);
});

for(const [label,code]of [
  ["rethrow",'try {await tools.probe({kind:"failure"})}catch(e){throw e}'],
  ["discarded failure",'void tools.probe({kind:"failure"}).then(()=>{});await new Promise(r=>setTimeout(r,30));'],
  ["unfinished child",'tools.probe({kind:"ok",delay:10000});'],
]as const)test(`${label} cannot commit a normally returned store`,async t=>{
  const f=await executionFixture(t);
  const {result}=await f.run('store("bad",true);'+code);
  assert.equal(result.isError,true,body(result.content));
  assert.equal(f.calls.length,1);
  assert.match(body((await f.run('text(load("bad")??null)')).result.content),/null/);
});

test("caught child observation failure remains fatal and retains the actual execution fact",async t=>{
  const f=await executionFixture(t);let pending=true;
  const unsubscribe=f.session.agent.subscribe(event=>{
    if(pending&&event.type==="tool_execution_end"&&event.parentToolCallId&&event.toolName==="probe"){
      pending=false;throw new Error("child observer failed");
    }
  });
  let first;
  try{first=await f.run('try{await tools.probe({kind:"ok"})}catch{}store("bad",true);');}finally{unsubscribe();}
  assert.equal(first.result.isError,true);
  const fact=first.result.details.codemode.calls[0];
  assert.equal(fact.executed,true);assert.equal(fact.systemFailure,true);assert.equal(fact.failureHandled,false);
  assert.match(body((await f.run('text(load("bad")??null)')).result.content),/null/);
});

for(const code of [
  'await Promise.allSettled([tools.probe({kind:"verification"})]);',
  'try{await callTool("probe",{kind:"verification"},{allowFailure:true})}catch{}',
])test("publication requiring verification remains fatal even when caught",async t=>{
  const f=await executionFixture(t);
  const first=await f.run(code+'store("bad",true);');
  assert.equal(first.result.isError,true);assert.equal(first.result.details.codemode.calls[0].failureHandled,false);
  assert.match(body((await f.run('text(load("bad")??null)')).result.content),/null/);
});
