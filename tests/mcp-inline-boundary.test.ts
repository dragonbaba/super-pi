import assert from "node:assert/strict";
import test from "node:test";
import { createToolResultPresentationOwner } from "../packages/coding-agent/src/core/tool-result-presentation.ts";
// @ts-expect-error JavaScript extension package.
import { convertMcpResult } from "../packages/mcp-bridge/src/bridge.js";
// @ts-expect-error JavaScript extension package.
import { sanitizeText } from "../packages/mcp-bridge/src/security.js";

for(const configured of [false,true])for(const controls of [false,true])test(`resource inline sanitizer and baseline information ${configured}/${controls}`,()=>{
  const text=controls?"OK\x1b]0;CANARY\x07\x1b[31mRED\x1b[0m\x1b7\0\x01\n中文😀":"SMALL-RESOURCE-OK";
  const content=convertMcpResult({content:[{type:"resource",resource:{uri:"https://example.test/small.txt",text}}]},configured);
  const expected=`[MCP resource https://example.test/small.txt]\n${sanitizeText(text,Number.MAX_SAFE_INTEGER)}`;
  assert.deepEqual(content,[{type:"text",text:expected}]);
  const owner=createToolResultPresentationOwner({enabled:true,budgetTokens:1024},"inline-session")!;
  try{const view=owner.create(content,"inline-call")!;assert.equal(view.version,1);assert.equal(view.modelContent[0].type,"text");assert.equal((view.modelContent[0] as any).text,expected);assert.equal((view.uiContent![0] as any).text,expected);assert.equal(owner.counters.artifactDescriptorsCreated,0);}finally{owner.dispose();}
});
for(const uri of ["https://example.test/docs","https://exam\nple.test/\tdocs\x1b"])test("links use sanitized canonical URL and baseline form",()=>{
  const content=convertMcpResult({content:[{type:"resource_link",name:"documentation",uri}]},true);
  assert.equal(content[0].text,`[MCP resource link: documentation — ${new URL(uri).href}]`);
  assert.doesNotMatch(content[0].text,/[\x00-\x1f]/);
});
for(const configured of [false,true])for(const count of [1,256])test(`optional metadata cannot force recovery ${configured}/${count}`,()=>{
  const content=convertMcpResult({content:Array.from({length:count},()=>({type:"text",text:"SMALL-META-OK"})),_meta:{implementationDetail:1}},configured);
  assert.equal(content.length,count);assert.equal(content.some((b:any)=>b.mcpSource),false);
  const owner=createToolResultPresentationOwner({enabled:true,budgetTokens:20_000},"metadata-session")!;
  try{const view=owner.create(content,"metadata-call")!;assert.equal(view.version,1);assert.match(JSON.stringify(view.modelContent),/SMALL-META-OK/);assert.doesNotMatch(JSON.stringify(view.modelContent),/implementationDetail/);assert.equal(owner.counters.artifactDescriptorsCreated,0);assert.equal(owner.counters.continuationCursorStringsCreated,0);}finally{owner.dispose();}
});
for(const result of [
  {content:[{type:"text",text:"x".repeat(64*1024)}]},
  {content:[{type:"audio",mimeType:"audio/flac",data:"ZkxhQw=="}]},
  {content:[{type:"resource",resource:{uri:"fixture://blob",blob:"YQ=="}}]},
  {content:[],structuredContent:{text:"x".repeat(64*1024)}},
])test("optional metadata shares existing required recovery",()=>{
  const content=convertMcpResult({...result,_meta:{opaque:"CANARY_TOKEN"}},true);
  assert.ok(content.some((b:any)=>b.mcpSource?.kind==="metadata"));
  const owner=createToolResultPresentationOwner({enabled:true,budgetTokens:256},"metadata-session")!;
  try{const view=owner.create(content,"metadata-call")!;assert.equal(view.version,2);assert.equal(owner.counters.projectionRecordEntries,1);assert.equal(owner.counters.artifactDescriptorsCreated,1);assert.doesNotMatch(JSON.stringify(view.modelContent),/CANARY_TOKEN/);}finally{owner.dispose();}
});
