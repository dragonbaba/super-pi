import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { stability, response } from "./helpers/selected-integration-fixture.ts";
import { fixture as evidence } from "./helpers/evidence-ledger-fixture.ts";
import { fixture as operation, operationFixtureSupported } from "./helpers/operation-write-fixture.ts";
import { convertToLlm } from "../packages/coding-agent/src/core/messages.ts";

test("selected Agent progress/slow-frame abort settles before next successful run", async () => {
 await stability(1);
});

test("selected real read dispatch reuses then invalidates before the next provider context", async () => {
 const f=await evidence();
 try {
  writeFileSync(join(f.cwd,"file.txt"),"selected integration evidence line\n".repeat(20000));
  const call={name:"read",arguments:{path:"file.txt",limit:100}};
  const first=await f.runCalls([call]); const prefix=first[0].systemPrompt;
  const second=await f.runCalls([call]);
  const ledger=f.internals._evidenceLedger!;
  if(process.platform==="linux") assert.equal(ledger.counters.hits,1);
  else assert.equal(ledger.counters.hits,0);
  assert.ok(prefix,"provider context must contain the production system prompt");
  assert.equal(second[0].systemPrompt,prefix);
  assert.deepEqual(second[0].tools,first[0].tools);
  assert.ok(second.length===2);
  assert.ok(ledger.counters.entries<=128); assert.ok(ledger.counters.metadataBytes<=256*1024);
  const hits=ledger.counters.hits;
  writeFileSync(join(f.cwd,"file.txt"),"changed integration evidence line\n".repeat(20000));
  await f.runCalls([call]);
  assert.equal(ledger.counters.hits,hits);
  const result=f.session.agent.state.messages.filter(m=>m.role==="toolResult").at(-1)!;
  assert.match(JSON.stringify(result),/changed integration evidence/);
  assert.equal(f.counters.activeDispatchPresentationScopes,0);
  assert.ok(f.counters.projectionRecordEntries<=3);
  f.session.dispose();
  assert.equal(f.counters.projectionRecordEntries,0);
  assert.equal(ledger.counters.entries,0); assert.equal(ledger.counters.metadataBytes,0);
 } finally { f.close(); }
});

test("selected protected recovery feeds the next ordinary provider without another effect", async () => {
 const f=await operation(true);
 const intent={intentId:randomUUID(),originBranch:null,path:"target",content:"private write payload"};
 try {
  if(!operationFixtureSupported) {
   await assert.rejects(f.session.newOperation(intent),/Unsupported/);
   assert.equal(existsSync(join(f.cwd,"target")),false); assert.equal(f.providers(),0); return;
  }
  const first=await f.session.newOperation(intent);
  writeFileSync(join(f.cwd,"target"),"external edit");
  assert.equal((await f.session.resumeOperation(first.operationId,intent)).historical,true);
  assert.equal(f.providers(),0);
  let requests=0;
  f.session.agent.streamFunction=(model,context)=>{
   requests++;
   const text=JSON.stringify(context.messages);
   assert.ok(text.includes("Host operation historical completion"));
   assert.ok(!text.includes(intent.content));
   assert.ok(context.messages.every(m=>m.role!=="toolResult"));
   return response(model,[{type:"text",text:"ordinary continuation"}]);
  };
  await f.session.prompt("continue normally");
  assert.equal(requests,1);
  assert.equal(readFileSync(join(f.cwd,"target"),"utf8"),"external edit");
  assert.equal(convertToLlm(f.session.agent.state.messages).at(-1)?.role,"assistant");
  const state=f.session as unknown as {_operationJournal:{counters:{effects:number;recoveries:number;active:number}};_hostOperation?:unknown};
  assert.equal(state._operationJournal.counters.effects,1);
  assert.equal(state._operationJournal.counters.recoveries,1);
  assert.equal(state._operationJournal.counters.active,0); assert.equal(state._hostOperation,undefined);
 } finally { f.session.dispose(); }
});

test("selected fixed-work allocation and release evidence", {skip:!process.env.CI}, () => {
 const result=spawnSync(process.execPath,["--expose-gc","--experimental-strip-types",
  fileURLToPath(new URL("./helpers/selected-integration-measure.ts",import.meta.url))],{encoding:"utf8",timeout:60000});
 assert.equal(result.status,0,result.stderr+result.stdout);
 const line=result.stdout.split("\n").find(l=>l.startsWith("SELECTED_INTEGRATION "));
 assert.ok(line); console.log(line);
});
