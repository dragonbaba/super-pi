// Fixed pre-T05.1 comparison. Run from the repository root with node --expose-gc. Requires built dist files.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import vm from 'node:vm';
import ts from 'typescript';
import { getModelsDevCost, getOpenRouterCost, getAiGatewayCost } from '../../packages/ai/scripts/catalog-pricing.ts';
import { calculateCost, createModels, createProvider } from '../../packages/ai/dist/models.js';
import { InMemoryModelsStore } from '../../packages/ai/dist/models-store.js';
import { withRemoteCatalog } from '../../packages/coding-agent/src/core/remote-catalog-provider.ts';
const baseline='97074eff8c78197dbf4e91ed492e3d7db400d5cc';
const unchanged=['packages/ai/src/models.ts','packages/ai/src/models-store.ts','packages/ai/src/model-capabilities.ts',
 'packages/coding-agent/src/core/model-catalog-merge.ts','packages/coding-agent/src/core/remote-catalog-provider.ts',
 'packages/coding-agent/src/core/provider-composer.ts','packages/ai/src/api/openai-completions.ts',
 'packages/ai/src/api/anthropic-messages.ts','packages/ai/src/api/bedrock-converse-stream.ts'];
for(const path of unchanged) assert.equal(readFileSync(path,'utf8'),execFileSync('git',['show',`${baseline}:${path}`],{encoding:'utf8'}));
console.log(JSON.stringify({unchangedRuntimeFiles:unchanged.length,baseline,node:process.version,platform:process.platform}));
function instrument(source,names){
 const counts={object:0,array:0,closure:0,new:0,nativeArray:0};
 const transformed=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.None},transformers:{before:[context=>root=>{
  function visit(node){
   const transformed=ts.visitEachChild(node,visit,context);
   let kind=ts.isObjectLiteralExpression(node)?'object':ts.isArrayLiteralExpression(node)?'array':
    ts.isArrowFunction(node)||ts.isFunctionExpression(node)?'closure':ts.isNewExpression(node)?'new':
    ts.isCallExpression(node)&&ts.isPropertyAccessExpression(node.expression)&&['from','flatMap','map','slice'].includes(node.expression.name.text)?'nativeArray':undefined;
   return kind?ts.factory.createCallExpression(ts.factory.createIdentifier('__count'),undefined,[ts.factory.createStringLiteral(kind),transformed]):transformed;
  }
  return ts.visitNode(root,visit);
 }]} }).outputText;
 const sandbox={__count(kind,value){counts[kind]++;return value;}};
 vm.runInNewContext(transformed.replaceAll('export ',''),sandbox);
 return {counts,functions:Object.fromEntries(names.map(name=>[name,sandbox[name]]))};
}
const oldSource=execFileSync('git',['show',`${baseline}:packages/ai/scripts/generate-models.ts`],{encoding:'utf8'});
const oldFile=ts.createSourceFile('old.ts',oldSource,ts.ScriptTarget.Latest,true);
const oldHelper=oldFile.statements.find(node=>ts.isFunctionDeclaration(node)&&node.name?.text==='getModelsDevCost').getText(oldFile);
const currentSource=readFileSync('packages/ai/scripts/catalog-pricing.ts','utf8').replace(/^import .*;$/m,'').replaceAll('export ','');
const cost={input:2,output:8,cache_read:.2,cache_write:2.5,tiers:[{tier:{type:'context',size:100},input:4,output:12,cache_read:.4,cache_write:5},{tier:{type:'context',size:200},input:6,output:18,cache_read:.6,cache_write:7.5}]};
for(const [label,source] of [['baseline-helper',oldHelper],['candidate-helper',currentSource]]){
 const probe=instrument(source,['getModelsDevCost']);
 for(const key of Object.keys(probe.counts)) probe.counts[key]=0;
 for(let i=0;i<10000;i++) probe.functions.getModelsDevCost(cost);
 console.log(JSON.stringify({label,calls:10000,...probe.counts}));
}
for(const [name,fixture] of [['getModelsDevCost',{input:2,output:8}],['getOpenRouterCost',{prompt:'.000002',overrides:[{min_prompt_tokens:100,prompt:'.000004'}]}],['getAiGatewayCost',{input:'.000002',input_tiers:[{min:101,max:201,cost:'.000004'}]}]]){
 const probe=instrument(currentSource,[name]);
 // Exclude the one module-lifetime GATEWAY_TIER_FIELDS array.
 for(const key of Object.keys(probe.counts)) probe.counts[key]=0;
 for(let i=0;i<10000;i++) probe.functions[name](fixture);
 console.log(JSON.stringify({label:name,calls:10000,...probe.counts}));
}
const runtimeSource=readFileSync('packages/ai/src/models.ts','utf8');
const runtimeFile=ts.createSourceFile('models.ts',runtimeSource,ts.ScriptTarget.Latest,true);
const runtimeFunction=runtimeFile.statements.find(node=>ts.isFunctionDeclaration(node)&&node.name?.text==='calculateCost').getText(runtimeFile).replace('export ','');
const calc=instrument(runtimeFunction,['calculateCost']);
const model={id:'pricing',provider:'fixture',api:'openai-completions',name:'pricing',baseUrl:'',reasoning:false,input:['text'],contextWindow:1000,maxTokens:100,cost:getModelsDevCost(cost)};
const usage={input:71,output:10,cacheRead:10,cacheWrite:20,totalTokens:111,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}};
for(let i=0;i<100000;i++) assert.equal(calc.functions.calculateCost(model,usage),usage.cost);
console.log(JSON.stringify({label:'calculateCost-with-tiers',calls:100000,...calc.counts}));

assert.equal(typeof globalThis.gc,'function');
const weak=[];const heldCosts=[];const heldRuntimes=[];
function watch(value){weak.push(new WeakRef(value));}
function parserLifetime(){
 const raw=structuredClone(cost);watch(raw);watch(raw.tiers);watch(raw.tiers[0]);
 heldCosts.push(getModelsDevCost(raw));
 const open={prompt:'.000002',overrides:[{min_prompt_tokens:100,prompt:'.000004'}]};watch(open);watch(open.overrides);watch(open.overrides[0]);
 heldCosts.push(getOpenRouterCost(open));
 const gateway={input:'.000002',input_tiers:[{min:101,max:201,cost:'.000004'}]};watch(gateway);watch(gateway.input_tiers);watch(gateway.input_tiers[0]);
 heldCosts.push(getAiGatewayCost(gateway));
}
async function collect(){for(let i=0;i<6;i++){await new Promise(resolve=>setImmediate(resolve));globalThis.gc();}}
parserLifetime();await collect();assert.equal(weak.filter(ref=>ref.deref()).length,0);
console.log(JSON.stringify({label:'raw-catalog-release',released:weak.length,heldGeneratedCosts:heldCosts.length}));
weak.length=0;
function dropGeneratedCosts(){
 for(const value of heldCosts){watch(value);if(value.tiers){watch(value.tiers);for(const tier of value.tiers)watch(tier);}}
 heldCosts.length=0;
}
dropGeneratedCosts();
await collect();assert.equal(weak.filter(ref=>ref.deref()).length,0);
console.log(JSON.stringify({label:'generated-cost-release',released:weak.length}));
weak.length=0;
async function runtimeLifetime(mode){
 const store=new InMemoryModelsStore();
 const raw={...model,cost:getModelsDevCost(structuredClone(cost))};
 const provider=createProvider({id:'fixture',models:[],auth:{},api:{stream(){throw Error('unused')},streamSimple(){throw Error('unused')}}});
 const models=createModels({modelsStore:store});
 const remote=withRemoteCatalog(provider);models.setProvider(remote);
 await store.write('fixture',{models:[raw],profileRevision:mode==='legacy'?undefined:1,checkedAt:0,lastModified:1});
 if(mode==='abort'){
  const controller=new AbortController();controller.abort();
  try{await models.refresh({allowNetwork:false,signal:controller.signal});}catch{}
 }else if(mode==='failure'){
  await assert.rejects(remote.refreshModels({stored:await store.read('fixture'),allowNetwork:false,signal:new AbortController().signal,publish:async()=>{throw Error('fixture publish failure')}}));
 }else{
  assert.equal((await models.refresh({allowNetwork:false})).errors.size,0);
  const restored=models.getModel('fixture','pricing');assert.ok(restored);
  calculateCost(restored,usage);watch(restored);watch(restored.cost);watch(restored.cost.tiers);
 }
 watch(raw);watch(raw.cost);watch(raw.cost.tiers);watch(remote);watch(provider);
 models.clearProviders();await store.delete('fixture');heldRuntimes.push(models);
}
for(const mode of ['normal','legacy','failure','abort'])await runtimeLifetime(mode);
await collect();assert.equal(weak.filter(ref=>ref.deref()).length,0);
console.log(JSON.stringify({label:'runtime-clear-abort-failure-release',released:weak.length,heldRuntimes:heldRuntimes.length}));
