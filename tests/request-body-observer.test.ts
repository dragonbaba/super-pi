import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import test from "node:test";
import ts from "typescript";
import { observeRequestBody, requestBodyUtf8Bytes } from "../packages/ai/src/utils/request-body-observer.ts";

test("native and Buffer-free browser counting agree for Unicode and malformed surrogates", () => {
  const source = readFileSync(new URL("../packages/ai/src/utils/request-body-observer.ts",import.meta.url),"utf8");
  const output = ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
  const portable = runInNewContext(output + "; exports.requestBodyUtf8Bytes",{exports:{}}) as (text:string)=>number;
  let nativeCalls = 0;
  const native = runInNewContext(output + "; exports.requestBodyUtf8Bytes",{exports:{},Buffer:{byteLength(text:string,encoding:BufferEncoding){nativeCalls++;return Buffer.byteLength(text,encoding);}}}) as (text:string)=>number;
  const samples = ["", "A".repeat(11*1024*1024), "中文😀é\ud800x\udc00", "\ud800\ud800\udc00\udc00"];
  let seed = 1, unicode = "";
  for (let i=0;i<10000;i++) {seed = (seed*1664525+1013904223)>>>0;unicode+=String.fromCharCode(seed>>>16);}
  samples.push(unicode);
  for (const text of samples) {
    assert.equal(requestBodyUtf8Bytes(text),Buffer.byteLength(text));
    assert.equal(portable(text),Buffer.byteLength(text));
    assert.equal(native(text),Buffer.byteLength(text));
  }
  assert.equal(nativeCalls,samples.length,"exactly one native byteLength call per body");
});

test("plain JSON observer reports identical wire/serialized bytes before dispatch",async()=>{
  let observed:number[]|undefined;
  const send=observeRequestBody(async()=>{assert.deepEqual(observed,[10,10]);return new Response();},(wire,json)=>{observed=[wire,json!];})!;
  await send("https://fixture.invalid",{method:"POST",body:"中文😀"});
});
