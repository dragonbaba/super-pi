import assert from "node:assert/strict";
import test from "node:test";
import { resolve } from "node:path";
import { createJiti } from "jiti";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Session } from "node:inspector/promises";
import { estimateContextTokensFromParts } from "../packages/ai/src/utils/estimate.ts";
import { clampMaxTokensToContext } from "../packages/ai/src/api/simple-options.ts";

// Source-only loading permits a deterministic red before building this checkout.
const jiti = createJiti(import.meta.url, { alias: {
 "@super-pi/ai": resolve("packages/ai/src/utils/estimate.ts"),
 "@super-pi/ai/api/simple-options": resolve("packages/ai/src/api/simple-options.ts"),
} });
const { createToolResultPresentationOwner } = await jiti.import<any>("../packages/coding-agent/src/core/tool-result-presentation.ts");
const model: any = { api: "openai-completions", contextWindow: 1_000_000, maxTokens: 384_000 };
const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: {input:0,output:0,cacheRead:0,cacheWrite:0,total:0} };
// One bounded corpus is shared, not regenerated for every boundary case.
const corpus = "abcd".repeat(620_000);
function messages(tokens: number): any[] {
 return [{role:"user",content:corpus.substring(0,tokens*4),timestamp:0},
 {role:"assistant",content:[{type:"toolCall",id:"edit-1",name:"edit",arguments:{}}],api:"openai-completions",provider:"fixture",model:"fixture",usage,stopReason:"toolUse",timestamp:1},
 {role:"toolResult",toolCallId:"edit-1",toolName:"edit",content:[{type:"text",text:"Edit completed."}],isError:false,timestamp:2}];
}
test("request planning has no 61.6-percent ceiling wall with a real small result", () => {
 const owner = createToolResultPresentationOwner({enabled:true,budgetTokens:1024},"budget-recovery");
 try { for(const tokens of [615_900,616_140,620_000]) {
  const source=messages(tokens), result=source[2];
  const projected=owner.projectMessagesForModel(source,undefined,undefined,undefined,model.contextWindow,model.maxTokens,true);
  const input=estimateContextTokensFromParts(undefined,projected,undefined).tokens;
  const cap=clampMaxTokensToContext(model,{messages:projected},model.maxTokens);
  assert.ok(cap>=1024); assert.ok(input+cap+4096<=model.contextWindow);
  assert.equal(projected[2].isError,false); assert.equal(result.content[0].text,"Edit completed.");
 } } finally { owner.dispose(); }
 assert.equal(owner.counters.activeContextualCoordinators,0);
});
test("true insufficient request capacity is not a one-token success", () => {
 const source=messages(620_000);
 assert.throws(()=>clampMaxTokensToContext({...model,contextWindow:620_100},{messages:source},384_000), /Request preparation blocked/);
});

test("explicit output overrides and model ceilings bound the finished request", () => {
 const context={messages:messages(620_000)};
 assert.equal(clampMaxTokensToContext(model,context,2048),2048);
 assert.ok(clampMaxTokensToContext(model,context,900_000)<=model.maxTokens);
 assert.throws(()=>clampMaxTokensToContext(model,context,0));
});

test("unrelated APIs retain their existing clamp contract", () => {
 assert.equal(clampMaxTokensToContext({...model,api:"openai-codex-responses",contextWindow:620_100},{messages:messages(620_000)},384_000),1);
});

test("request blocks distinguish genuine batch exhaustion from context headroom", () => {
 for(const [budget,window,cause] of [[16,1_000_000,"result-batch-budget"],[1024,620_100,"context-headroom"]] as const) {
  const owner=createToolResultPresentationOwner({enabled:true,budgetTokens:budget},`failure-${cause}`);
  const source=messages(620_000); source[2].content[0].text="large result ".repeat(300);
  try {
   assert.throws(()=>owner.projectMessagesForModel(source,undefined,undefined,undefined,window,384_000,true),new RegExp(`Request preparation blocked: ${cause}`));
   assert.equal(source[2].isError,false); assert.equal(owner.counters.activeContextualCoordinators,0);
  } finally { owner.dispose(); }
 }
});

test("multiple required results retain exact order and bounded batch envelopes", () => {
 const owner=createToolResultPresentationOwner({enabled:true,budgetTokens:1024},"ordered-recovery");
 const source=messages(620_000); source.pop(); source[1].content=[];
 for(let i=0;i<4;i++) {
  source[1].content.push({type:"toolCall",id:`ordered-${i}`,name:"read",arguments:{}});
  source.push({role:"toolResult",toolCallId:`ordered-${i}`,toolName:"read",content:[{type:"text",text:"result data ".repeat(500)}],isError:false,timestamp:2});
 }
 try {
  const projected=owner.projectMessagesForModel(source,undefined,undefined,undefined,model.contextWindow,model.maxTokens,true);
  assert.deepEqual(projected.slice(2).map((m:any)=>m.toolCallId),["ordered-0","ordered-1","ordered-2","ordered-3"]);
  assert.ok(estimateContextTokensFromParts(undefined,projected,undefined).tokens+clampMaxTokensToContext(model,{messages:projected},384_000)+4096<=1_000_000);
  assert.equal(owner.counters.contextualContextScans,1); assert.equal(owner.counters.activeContextualCoordinators,0);
 } finally {owner.dispose();}
});

for (const presentationBudget of [1024,1]) test(`real SDK write persists across projection block and recovery: budget ${presentationBudget}`, async t => {
 const {createAgentSession}=await import("../packages/coding-agent/src/core/sdk.ts");
 const {DefaultResourceLoader}=await import("../packages/coding-agent/src/core/resource-loader.ts");
 const {SettingsManager}=await import("../packages/coding-agent/src/core/settings-manager.ts");
 const {SessionManager}=await import("../packages/coding-agent/src/core/session-manager.ts");
 // Use the same published module instance as the production dispatcher: the
 // incomplete-argument provenance is intentionally module-owned, not serialized.
 const {streamSimple}=await import("@super-pi/ai/api/openai-completions");
 const {RequestBudgetError}=await import("../packages/ai/src/api/simple-options.ts");
 const root=mkdtempSync(join(tmpdir(),"pi-budget-recovery-"));
 t.after(()=>rmSync(root,{recursive:true,force:true}));
 const cwd=join(root,"work"),agentDir=join(root,"agent");mkdirSync(cwd);mkdirSync(agentDir);
 const settingsManager=SettingsManager.inMemory({compaction:{enabled:false},retry:{enabled:false}});
 const loader=new DefaultResourceLoader({cwd,agentDir,settingsManager,noExtensions:true,noContextFiles:true,noPromptTemplates:true,noSkills:true,noThemes:true});await loader.reload();
 const manager=SessionManager.create(cwd,join(root,"sessions"));
 const fullModel:any={...model,id:"offline-budget",name:"Offline",api:"openai-completions",provider:"fixture",baseUrl:"https://fixture.invalid/v1",reasoning:false,input:["text"],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},compat:{maxTokensField:"max_tokens"}};
 let sends=0,effects=0,receivedCap=0,expectedCap=0;
 let pendingArguments: string|string[]|undefined=JSON.stringify({path:"created.txt",content:"completed exactly once"});
 const fakeFetch: typeof fetch=async(_input,init)=>{
  const payload=JSON.parse(String(init?.body)); sends++;receivedCap=payload.max_tokens;
  assert.equal(receivedCap,expectedCap,"effective sender payload must use the planned request-cap policy");
  const hasCall=pendingArguments!==undefined;
  const delta=hasCall?{tool_calls:(Array.isArray(pendingArguments)?pendingArguments:[pendingArguments]).map((argumentsText,index)=>({index,id:`write-${sends}-${index}`,type:"function",function:{name:"write",arguments:argumentsText}}))}:{content:"Recorded write acknowledged; no second effect."};
  pendingArguments=undefined;
  if(sends>1) assert.ok(payload.messages.filter((m:any)=>m.role==='tool').length>=1);
  const event={id:"offline",object:"chat.completion.chunk",created:1,model:fullModel.id,choices:[{index:0,delta,finish_reason:null}]};
  const end={...event,choices:[{index:0,delta:{},finish_reason:hasCall?"tool_calls":"stop"}]};
  return new Response(`data: ${JSON.stringify(event)}\n\ndata: ${JSON.stringify(end)}\n\ndata: [DONE]\n\n`,{headers:{"Content-Type":"text/event-stream"}});
 };
 const runtime:any={hasConfiguredAuth:()=>true,checkAuth:async()=>({type:"api_key"}),isUsingOAuth:()=>false,getAuth:async()=>undefined,getModel:()=>undefined,registerProvider(){},registerNativeProvider(){},unregisterProvider(){},streamSimple:(m:any,c:any,o:any)=>{expectedCap=clampMaxTokensToContext(m,c,o?.maxTokens??m.maxTokens);return streamSimple(m,c,{...o,apiKey:"offline-fixture",fetch:fakeFetch,maxRetries:0});}};
 const {session}=await createAgentSession({cwd,agentDir,model:fullModel,modelRuntime:runtime,settingsManager,sessionManager:manager,resourceLoader:loader,tools:["write"],toolResultPresentation:{enabled:true,budgetTokens:presentationBudget}});
 try {
  const write=session.agent.state.tools.find(tool=>tool.name==='write')!;
  const execute=write.execute;
  let delay: Promise<void>|undefined, entered: (()=>void)|undefined;
  write.execute=async(...args)=>{
   const input=args[1] as {path:string};
   if(input.path==='delayed.txt'||input.path==='aborted.txt'){entered?.();await delay;}
   const result=await execute(...args);effects++;return result;
  };
  const convert=session.agent.convertToLlm;
  if(presentationBudget===1024)assert.throws(()=>convert(messages(620_000),undefined,[],{...fullModel,api:"openai-codex-responses"}),/Request preparation blocked/);
  let inject=presentationBudget===1024,blockAfterResults=1;
  session.agent.convertToLlm=(m,s,tools,model,cap)=>{
   if(inject&&m.filter(x=>x.role==='toolResult'&&!x.isError).length>=blockAfterResults)throw new RequestBudgetError(1_000_000,999_000,384_000,-3096);
   return convert(m,s,tools,model,cap);
  };
  await session.prompt(corpus);
  assert.equal(readFileSync(join(cwd,"created.txt"),"utf8"),"completed exactly once");
  assert.equal(effects,1); assert.equal(sends,1,"preparation failed before constructing/sending another request");
  const durable=SessionManager.open(manager.getSessionFile()!).buildSessionContext().messages;
  assert.equal(durable.filter((m:any)=>m.role==='toolResult'&&!m.isError).length,1);
  assert.match((session.messages.at(-1) as any).errorMessage,/Request preparation blocked/);
  if(presentationBudget===1){
   await session.prompt("Do not repeat the completed write; budget remains too small.");
   assert.equal(sends,1);assert.equal(effects,1);
   assert.match((session.messages.at(-1) as any).errorMessage,/Request preparation blocked: configured result budget/);
   return;
  }
  inject=false;
  await session.prompt("Use the recorded result; continue without repeating the write.");
  assert.equal(sends,2);assert.equal(effects,1);assert.ok(receivedCap>1024&&receivedCap<384_000);
  pendingArguments='{"path":"created.txt","content":"partial';
  await session.prompt("Incomplete argument fixture.");
  assert.equal(effects,1,"incomplete provider JSON must not execute");
  assert.ok(session.messages.some((m:any)=>m.role==='toolResult'&&m.isError&&m.content.some((b:any)=>b.text?.includes('incomplete'))));
  pendingArguments=JSON.stringify({path:"created.txt"});
  await session.prompt("Active schema rejection fixture.");
  assert.equal(effects,1,"active-schema required-field rejection must not execute");
  assert.equal(readFileSync(join(cwd,"created.txt"),"utf8"),"completed exactly once");
  let release!:()=>void; delay=new Promise<void>(resolve=>{release=resolve;});
  const started=new Promise<void>(resolve=>{entered=resolve;});
  pendingArguments=[JSON.stringify({path:"delayed.txt",content:"first"}),JSON.stringify({path:"parallel.txt",content:"second"})];
  inject=true;blockAfterResults=3;
  const parallel=session.prompt("Parallel write fixture.");await started;release();await parallel;
  assert.equal(effects,3);assert.equal(readFileSync(join(cwd,"delayed.txt"),"utf8"),"first");
  assert.equal(readFileSync(join(cwd,"parallel.txt"),"utf8"),"second");
  const results=session.messages.filter((m:any)=>m.role==='toolResult'&&!m.isError) as any[];
  assert.equal(results.length,3);assert.match((session.messages.at(-1) as any).errorMessage,/Request preparation blocked/);
  inject=false;delay=undefined;entered=undefined;
  await session.prompt("Recover the recorded parallel results only.");assert.equal(effects,3);
  delay=new Promise<void>(resolve=>{release=resolve;});const abortStarted=new Promise<void>(resolve=>{entered=resolve;});
  pendingArguments=JSON.stringify({path:"aborted.txt",content:"never written"});
  const aborting=session.prompt("Abort fixture.");await abortStarted;session.agent.abort();release();await aborting;
  assert.equal(effects,3);assert.equal(existsSync(join(cwd,"aborted.txt")),false);
  delay=undefined;entered=undefined;
  assert.equal(session.agent.state.pendingToolCalls.size,0);assert.equal(session.agent.state.isStreaming,false);
 } finally { session.dispose(); }
});

test("bounded request planning allocation and release", t => {
 const child=spawnSync(process.execPath,["--expose-gc","--experimental-strip-types","--test","--test-name-pattern=^request planning measurement child$",fileURLToPath(import.meta.url)],{cwd:process.cwd(),env:{...process.env,PI_BUDGET_MEASUREMENT_CHILD:"1"},encoding:"utf8",timeout:30_000,maxBuffer:64*1024});
 assert.equal(child.error,undefined); assert.equal(child.status,0,child.stdout+child.stderr);
 t.diagnostic(child.stdout.trim());
});

test("request planning measurement child", {skip:process.env.PI_BUDGET_MEASUREMENT_CHILD!=="1"}, async t => {
 const owner=createToolResultPresentationOwner({enabled:true,budgetTokens:1024},"measurement");
 const refs: WeakRef<object>[]=[];
 function lookup(retainWeak:boolean) {
  const source=messages(620_000);
  if(retainWeak)refs.push(new WeakRef(source),new WeakRef(source[2].content));
  const projected=owner.projectMessagesForModel(source,undefined,undefined,undefined,1_000_000,384_000,true);
  assert.ok(clampMaxTokensToContext(model,{messages:projected},384_000)>=1024);
 }
 const warmup=8,samples=32;for(let i=0;i<warmup;i++)lookup(false);
 const inspector=new Session();inspector.connect();let bytes=0;
 try {
  await inspector.post("HeapProfiler.enable");await inspector.post("HeapProfiler.startSampling",{samplingInterval:1024,includeObjectsCollectedByMajorGC:true,includeObjectsCollectedByMinorGC:true});
  for(let i=0;i<samples;i++)lookup(true);
  let profile:any=(await inspector.post("HeapProfiler.stopSampling")).profile;
  const pending=[profile.head];while(pending.length){const node=pending.pop();bytes+=node.selfSize;for(const c of node.children)pending.push(c);}profile=undefined;
  await inspector.post("HeapProfiler.disable");
 } finally {inspector.disconnect();owner.dispose();}
 for(let i=0;i<3;i++){await new Promise<void>(resolve=>setImmediate(resolve));global.gc!();}
 assert.equal(owner.counters.contextualContextScans,warmup+samples);
 assert.equal(owner.counters.activeContextualCoordinators,0);assert.equal(owner.counters.projectionRecordEntries,0);
 assert.equal(refs.filter(ref=>ref.deref()!==undefined).length,0);
 assert.ok(bytes>0&&bytes<8*1024*1024,"bounded paired preparation sample exceeded gross allocation ceiling");
 t.diagnostic(JSON.stringify({platform:process.platform,node:process.version,warmup,samples,sampledBytes:bytes,projectionScans:owner.counters.contextualContextScans,projectionPasses:owner.counters.contextualProjectionPasses,activeCoordinators:0,retainedResultReferences:0,fullResultCopies:0,scope:"projection plus actual cap estimator; sampled allocation is not total heap"}));
});
