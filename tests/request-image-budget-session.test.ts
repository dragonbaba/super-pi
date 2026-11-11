import assert from "node:assert/strict";
import test from "node:test";
import { stream } from "../packages/ai/src/api/openai-completions.ts";
import { createAgentSession } from "../packages/coding-agent/src/core/sdk.ts";
import { SettingsManager } from "../packages/coding-agent/src/core/settings-manager.ts";
import { SessionManager } from "../packages/coding-agent/src/core/session-manager.ts";
import { DefaultResourceLoader } from "../packages/coding-agent/src/core/resource-loader.ts";
import { ALPHA_MODEL, alphaModelRuntime } from "./helpers/alpha-session.ts";
import { createOwnedTaskFixture } from "./helpers/owned-task-fixture.ts";
import { paddedPngFixture } from "./helpers/image-acceptance-fixtures.ts";

for (const presentation of [false,true]) for (const failure of ["once","twice","blocked","same","connection","text-only"] as const) test(`actual serializer: presentation=${presentation}, payload=${failure}`, async t => {
  const owned = createOwnedTaskFixture("image-budget-session-"), root = owned.root;
  const model: any = { ...ALPHA_MODEL, api:"openai-completions", input:failure==="text-only"?["text"]:["text","image"], contextWindow:1000000 };
  const settings = SettingsManager.inMemory({ executionEnvironment:"trusted-host", compaction:{enabled:false}, retry:{enabled:failure==="connection",maxRetries:1,baseDelayMs:0},
    images:{autoResize:false,blockImages:failure==="blocked"} });
  const resources = new DefaultResourceLoader({cwd:root,agentDir:root,settingsManager:settings,noExtensions:true,noContextFiles:true,noSkills:true,noPromptTemplates:true,noThemes:true});
  await resources.reload();
  const uploads: {bytes:number;images:number}[] = [];
  const runtime = alphaModelRuntime((target,context,options) => stream(target as any,context,{...options,apiKey:"offline-fixture",maxRetries:0,
    fetch: async (_url,init) => {
      const body = String(init?.body), wire = JSON.parse(body); let images=0;
      for (const m of wire.messages) if (Array.isArray(m.content)) for (const b of m.content) if (b.type==="image_url") images++;
      uploads.push({bytes:Buffer.byteLength(body),images});
      if (failure === "connection" && uploads.length === 1) throw new Error("synthetic connection failure");
      assert.doesNotMatch(body,/cacheSourceBytes|requestViews/);
      if (failure!=="blocked" && failure!=="text-only" && (uploads.length===1 || failure==="twice" || failure==="connection" && uploads.length===2)) return new Response(JSON.stringify({error:{message:"Failed to buffer the request body: length limit exceeded",type:"request_too_large"}}),{status:413,headers:{"content-type":"application/json"}});
      return new Response('data: {"id":"fixture","choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":null}]}\n\ndata: {"id":"fixture","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',{headers:{"content-type":"text/event-stream"}});
    }}));
  runtime.getModel = () => model;
  const manager = SessionManager.inMemory(root);
  const {session} = await createAgentSession({cwd:root,agentDir:root,model,modelRuntime:runtime,settingsManager:settings,sessionManager:manager,resourceLoader:resources,noTools:"all",
    toolResultPresentation:presentation?{enabled:true,budgetTokens:100000}:undefined});
  t.after(async()=>{await session.abort(); await (session as any)._codemode.close(); session.dispose(); await (session as any)._sessionLeaseRelease; owned.cleanup();});
  await session.bindExtensions({});
  const data=failure==="text-only"?"A".repeat(13*1024*1024):paddedPngFixture().toString("base64"), images:any[]=[];
  manager.appendMessage({role:"user",content:"synthetic historical image inspection",timestamp:0});
  const imageCount = failure === "same" || failure === "text-only" ? 1 : 44;
  for (let i=0;i<imageCount;i++) {
    const id="history-"+i;
    manager.appendMessage({role:"assistant",api:model.api,provider:model.provider,model:model.id,content:[{type:"toolCall",id,name:"read",arguments:{path:"synthetic.png"}}],stopReason:"toolUse",timestamp:i,
      usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}}});
    const image={type:"image" as const,data,mimeType:"image/png"}; images.push(image);
    manager.appendMessage({role:"toolResult",toolCallId:id,toolName:"read",content:[image],isError:false,timestamp:i});
  }
  session.agent.state.messages=manager.buildSessionContext().messages;
  const originalImageChars=imageCount*data.length;
  await session.prompt("continue inspecting the existing results");
  assert.equal(uploads.length,failure==="blocked" || failure==="same" || failure==="text-only"?1:failure==="connection"?3:2);
  if (failure==="blocked" || failure==="text-only") assert.equal(uploads[0]!.images,0);
  else if (failure === "same") assert.match((session.messages.at(-1) as any).errorMessage, /Request preparation blocked: image recovery/);
  else { assert.ok(uploads[0]!.images<44); assert.ok(uploads.at(-1)!.bytes<uploads[0]!.bytes); }
  if (failure === "twice") assert.match((session.messages.at(-1) as any).errorMessage,/REQUEST_BODY_TOO_LARGE.*reduce images/);
  let retained=0;
  for (const m of session.messages) if (m.role==="toolResult") for (const b of m.content) if (b.type==="image") retained+=b.data.length;
  assert.equal(retained,originalImageChars); assert.ok(images.every(image=>image.data===data));
  assert.equal(manager.getEntries().filter(entry=>entry.type==="compaction").length,0);
  assert.equal(session.requestImages.metrics.uploads,uploads.length);
  t.diagnostic(JSON.stringify({presentation,failure,uploads,canonicalImageChars:retained}));
});
