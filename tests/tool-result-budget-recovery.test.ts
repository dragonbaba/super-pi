import assert from "node:assert/strict";
import test from "node:test";
import { resolve } from "node:path";
import { createJiti } from "jiti";
import { estimateContextTokensFromParts } from "../packages/ai/src/utils/estimate.ts";
import { clampMaxTokensToContext } from "../packages/ai/src/api/simple-options.ts";

// Source-only loading permits a deterministic red before building this checkout.
const jiti = createJiti(import.meta.url, { alias: {
 "@super-pi/ai": resolve("packages/ai/src/utils/estimate.ts"),
 "@super-pi/ai/api/simple-options": resolve("packages/ai/src/api/simple-options.ts"),
} });
const { createToolResultPresentationOwner } = await jiti.import<any>("../packages/coding-agent/src/core/tool-result-presentation.ts");
const model: any = { contextWindow: 1_000_000, maxTokens: 384_000 };
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
