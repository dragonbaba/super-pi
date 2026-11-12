import assert from "node:assert/strict";
import test from "node:test";
import type { Message } from "../packages/ai/src/types.ts";
import { stream } from "../packages/ai/src/api/openai-completions.ts";
import { generateSummaryWithUsage } from "../packages/coding-agent/src/core/compaction/compaction.ts";
import { ALPHA_MODEL } from "./helpers/alpha-session.ts";

for (const oversizedText of [false,true]) test(`default summary serializes text only and bounds size-error recovery, oversizedText=${oversizedText}`, async t => {
  const model: any = {...ALPHA_MODEL,api:"openai-completions",input:["text","image"],contextWindow:10000000};
  const image = {type:"image" as const,data:"PRIVATE_IMAGE_SENTINEL".repeat(10000),mimeType:"image/png"};
  const messages: Message[] = [
    {role:"user",content:[{type:"text",text:oversizedText?"TEXT".repeat(4*1024*1024):"Summarize inspection"},image],timestamp:0},
    {role:"toolResult",toolCallId:"image",toolName:"read",content:[image,{type:"text",text:"TOOL_TEXT".repeat(1024*1024)+"TOOL_TAIL_SENTINEL"}],isError:false,timestamp:1},
  ];
  let requests = 0, wireBytes = 0;
  const pending = generateSummaryWithUsage(messages,model,1024,"offline",undefined,undefined,undefined,undefined,undefined,
    (_target,context,options)=>stream(model,context,{...options,maxRetries:3,fetch:async (_url,init)=>{
      requests++;const body = init!.body as string;wireBytes=Buffer.byteLength(body);
      assert.doesNotMatch(body,/PRIVATE_IMAGE_SENTINEL|data:image|image_url|TOOL_TAIL_SENTINEL/);
      const wire = JSON.parse(body);
      for (const message of wire.messages) if (Array.isArray(message.content)) for (const block of message.content) assert.equal(block.type,"text");
      if (oversizedText) return new Response(JSON.stringify({error:{message:"request_too_large",type:"request_too_large"}}),{status:413,headers:{"content-type":"application/json","x-should-retry":"true"}});
      assert.ok(wireBytes<10000,"existing per-tool summary truncation bounds the multi-MiB tool result");
      return new Response('data: {"id":"s","choices":[{"index":0,"delta":{"content":"summary"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',{headers:{"content-type":"text/event-stream"}});
    }}),undefined,{enabled:true,maxRetries:3,baseDelayMs:0});
  if (oversizedText) await assert.rejects(pending,/Summarization failed:.*REQUEST_BODY_TOO_LARGE/s);
  else assert.equal((await pending).text,"summary");
  assert.equal(requests,1,"413 is not retried by either summary or provider recovery");
  assert.equal((messages[1] as any).content[0],image);
  t.diagnostic(JSON.stringify({oversizedText,requests,wireBytes,imageBlocks:0,base64Included:false}));
});
