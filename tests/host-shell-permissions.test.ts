import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, parse, relative, isAbsolute } from "node:path";
import { Agent } from "../packages/agent/src/agent.ts";
import { createExtensionRuntime, ExtensionRunner } from "../packages/coding-agent/src/core/extensions/index.ts";
import { SessionExecutionPolicy } from "../packages/coding-agent/src/core/execution-policy.ts";
import { SessionManager } from "../packages/coding-agent/src/core/session-manager.ts";
import { createBashTool } from "../packages/coding-agent/src/core/tools/bash.ts";
import { createPowerShellTool } from "../packages/coding-agent/src/core/tools/powershell.ts";
import { getShellCwdBinding } from "../packages/coding-agent/src/core/tools/shell-cwd.ts";
import { createOwnedTaskFixture } from "./helpers/owned-task-fixture.ts";
import { createEventBus } from "../packages/coding-agent/src/core/event-bus.ts";
import { SessionTasks } from "../packages/coding-agent/src/core/tasks/session-tasks.ts";
import { CodemodeController } from "../packages/coding-agent/src/core/codemode.ts";
import { wrapToolDefinition } from "../packages/coding-agent/src/core/tools/tool-definition-wrapper.ts";
import { AssistantMessageEventStream } from "../packages/ai/src/utils/event-stream.ts";

const owned=createOwnedTaskFixture("native-shell-result-"), oldTemps=[process.env.TMP,process.env.TEMP,process.env.TMPDIR];
process.env.TMP=owned.root;process.env.TEMP=owned.root;process.env.TMPDIR=owned.root;
assert.equal(await fs.realpath(tmpdir()),await fs.realpath(owned.root));
test.after(() => { for (const [index,key] of ["TMP","TEMP","TMPDIR"].entries()) {
  if(oldTemps[index]===undefined) delete process.env[key];else process.env[key]=oldTemps[index];
} owned.cleanup(); });

async function fixture(t:test.TestContext, orchestration=false) {
  const root=await fs.realpath(await fs.mkdtemp(join(owned.root,"case-"))), cwd=join(root,"project space"), outside=join(root,"outside"), added=join(root,"added");
  for(const directory of [cwd,outside,added]) await fs.mkdir(directory);
  const runtime=createExtensionRuntime(), manager=orchestration?SessionManager.create(cwd,join(root,"sessions")):SessionManager.inMemory(cwd), events=createEventBus();
  const tasks=orchestration?runtime.nativeTasks=new SessionTasks(runtime,events):undefined;
  runtime.appendEntry=(type,data) => {manager.appendCustomEntry(type,data);};
  const policy=runtime.nativePermissions=new SessionExecutionPolicy(runtime,"trusted-host",{rules:[{tool:"*",decision:"allow"}]},"host-write",[added]);
  const runner=new ExtensionRunner([],runtime,cwd,manager,{} as never);
  const agent=new Agent({streamFn:() => {throw new Error("offline fixture");},beforeToolCall:({toolCall,args,parentToolCallId}) =>
    runner.emitToolCall({type:"tool_call",toolName:toolCall.name,toolCallId:toolCall.id,parentToolCallId,input:args} as any)});
  agent.state.tools=[createBashTool(cwd),createPowerShellTool(cwd)];
  const codemode=orchestration?new CodemodeController(()=>{}):undefined;
  if(tasks) agent.state.tools.push(wrapToolDefinition(tasks.definition,()=>runner.createContext()));
  if(codemode) {codemode.setTools(agent.state.tools);agent.state.tools.push(wrapToolDefinition(codemode.definition,()=>runner.createContext()));}
  runner.bindCore({getThinkingLevel:()=>"off",getActiveTools:()=>agent.state.tools.map(tool=>tool.name),getAllTools:()=>agent.state.tools,sendMessage:()=>{},appendEntry:(type:string,data:unknown)=>manager.appendCustomEntry(type,data)} as any,
    {getSignal:()=>agent.signal,getModel:()=>undefined,isProjectTrusted:()=>false,isIdle:()=>true,hasPendingMessages:()=>false} as any);
  const dialogs:string[]=[],notices:string[]=[];let choice:"allow"|"cancel"="allow",sequence=0;
  runner.setUIContext({...runner.getUIContext(),select:async (_title,choices,options) => {dialogs.push(options!.details!);return choice==="cancel"?undefined:choices[0];},
    notify:(message)=>{notices.push(message);}},"tui");
  if(orchestration) await runner.emit({type:"session_start",reason:"startup"} as any);
  t.after(async()=>{agent.abort();await agent.waitForIdle();await codemode?.close();runner.invalidate();await tasks?.dispose();policy.dispose();await runtime.executionBoundary.dispose();events.clear();});
  function event(name:string,input:object):any {return {type:"tool_call",toolName:name,toolCallId:"native-"+(++sequence),input};}
  return {root,cwd,outside,added,policy,dialogs,notices,tasks,ctx:()=>runner.createContext(),event,
    select(value:"allow"|"cancel"){choice=value;},
    async call(name:string,command:string,directory?:string){const input={command,...(directory===undefined?{}:{cwd:directory})},request=event(name,input);
      return agent.dispatchHostTool({type:"toolCall",id:request.toolCallId,name,arguments:input});},
    async callInput(name:string,input:object){
      const request=event(name,input);
      if(name!=="codemode") return agent.dispatchHostTool({type:"toolCall",id:request.toolCallId,name,arguments:input});
      let issued=false;
      agent.streamFunction=()=>{
        const stopReason=issued?"stop":"toolUse";
        const message:any={role:"assistant",api:"openai-responses",provider:"fixture",model:"fixture",timestamp:0,stopReason,
          usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}},
          content:issued?[{type:"text",text:"done"}]:[{type:"toolCall",id:request.toolCallId,name,arguments:input}]};
        issued=true;const stream=new AssistantMessageEventStream();stream.push({type:"done",reason:stopReason,message});return stream;
      };
      await agent.prompt("run offline fixture");
      const result=agent.state.messages.find(message=>message.role==="toolResult"&&message.toolCallId===request.toolCallId);
      assert.ok(result&&result.role==="toolResult");return result;
    },
    async authorize(name:string,command:string){const input={command},request=event(name,input);
      try {const grant=await policy.authorize(request,runner.createContext());grant.release();}
      finally {getShellCwdBinding(input)?.release();}}
  };
}
function quote(tool:string,value:string):string {return tool==="bash"?"'"+value.replaceAll("\\","/").replaceAll("'","'\\''")+"'":"'"+value.replaceAll("'","''")+"'";}
function text(result:any):string {return result.content.filter((block:any)=>block.type==="text").map((block:any)=>block.text).join("\n");}

test("native shell approval precedes actual deletion, cancellation retries, and added cwd stays workspace-bound",async t=>{
  const f=await fixture(t);
  const shells=process.platform==="win32"?["bash","powershell"]:["bash"];
  for(const shell of shells) {
    const target=join(f.outside,shell+".txt"), rel=relative(f.root,target);assert.ok(!isAbsolute(rel)&&!rel.startsWith(".."));
    await fs.writeFile(target,"owned");
    const command=shell==="bash"?"rm -f -- "+quote(shell,target):"Remove-Item -LiteralPath "+quote(shell,target);
    f.select("cancel");let before=f.dialogs.length;
    const cancelled=await f.call(shell,command);assert.equal(cancelled.isError,true);assert.match(text(cancelled),/APPROVAL_CANCELLED/);
    assert.equal(await fs.readFile(target,"utf8"),"owned");assert.equal(f.dialogs.length,before+1);
    f.select("allow");const approved=await f.call(shell,command);assert.equal(approved.isError,false,text(approved));
    await assert.rejects(fs.stat(target),{code:"ENOENT"});assert.equal(f.dialogs.length,before+2);
    assert.match(f.dialogs.at(-1)!,/工作区外/);
  }
  await fs.writeFile(join(f.added,"owned.txt"),"owned");const before=f.dialogs.length;
  const added=await f.call("bash","rm -f owned.txt",f.added);assert.equal(added.isError,false,text(added));
  assert.equal(f.dialogs.length,before);await assert.rejects(fs.stat(join(f.added,"owned.txt")),{code:"ENOENT"});
  const temps=await f.call("bash",`node -e 'process.stdout.write(require("node:os").tmpdir())'`);
  assert.equal(temps.isError,false,text(temps));assert.ok(text(temps).includes(owned.root));
});

test("existing mutation evidence distinguishes external writes from reads and refuses sensitive deletion",async t=>{
  const f=await fixture(t), file=join(f.outside,"existing.txt");await fs.writeFile(file,"original");
  await assert.rejects(f.authorize("bash","printf changed > "+quote("bash",file)),/EXTERNAL_FILE_WRITE_BLOCKED/);
  assert.equal(await fs.readFile(file,"utf8"),"original");assert.equal(f.dialogs.length,0);assert.equal(f.notices.length,1);
  await fs.writeFile(join(f.cwd,"local.txt"),"owned");
  const mixed=await f.call("bash","cat "+quote("bash",file)+"; rm -f local.txt");
  assert.equal(mixed.isError,false,text(mixed));assert.equal(f.dialogs.length,0);
  for(const command of ["rm -rf .","rm -rf .git"]) await assert.rejects(f.authorize("bash",command),/敏感目标禁止删除/);
  if(process.platform==="win32") await assert.rejects(f.authorize("powershell","Remove-Item -Recurse -LiteralPath "+quote("powershell",parse(f.cwd).root)),/敏感目标禁止删除/);
  assert.equal(f.dialogs.length,0);
  await fs.mkdir(join(f.cwd,".git"));await f.authorize("bash","git add local.txt");assert.equal(f.dialogs.length,0);
});

test("only recognized uncertain mutations ask; ordinary shell paths, recovery and npm keep actual runtime semantics",async t=>{
  const f=await fixture(t);
  await f.authorize("bash",'rm -rf "$X"');assert.equal(f.dialogs.length,1);assert.match(f.dialogs[0]!,/不能确认全部目标/);
  if(process.platform==="win32") {
    await f.authorize("bash","rm -rf /tmp/example");assert.equal(f.dialogs.length,2);
    assert.match(f.dialogs.at(-1)!,/不能确认全部目标/);assert.ok(!f.dialogs.at(-1)!.includes("D:\\tmp"));
  }
  const before=f.dialogs.length;
  for(const command of ["cd /tmp && printf 'DIRECTORY_OK'","cd missing-directory || printf 'RECOVERED'"]) {
    const result=await f.call("bash",command);assert.equal(result.isError,false,text(result));
  }
  const child=join(f.cwd,"sub");await fs.mkdir(child);
  await fs.writeFile(join(f.cwd,"package.json"),JSON.stringify({private:true,scripts:{verify:"node -e \"process.stdout.write('PARENT_OK')\""}}));
  const npm=await f.call("bash","npm run verify --silent",child);assert.equal(npm.isError,false,text(npm));assert.match(text(npm),/PARENT_OK/);
  assert.equal(f.dialogs.length,before);
});

test("CodeMode children and managed background commands share the same native approval before effects",async t=>{
  const f=await fixture(t,true);
  for(const mode of ["codemode","background"]) {
    const file=join(f.outside,mode+".txt");await fs.writeFile(file,"owned");
    const input={command:"rm -f -- "+quote("bash",file),...(mode==="background"?{cwd:f.cwd,background:true}:{})};
    const args=mode==="codemode"?{code:"await tools.bash("+JSON.stringify(input)+");"}:input;
    const name=mode==="codemode"?"codemode":"bash", before=f.dialogs.length;
    f.select("cancel");const cancelled=await f.callInput(name,args);assert.equal(cancelled.isError,true,text(cancelled));
    assert.equal(await fs.readFile(file,"utf8"),"owned");assert.equal(f.dialogs.length,before+1,text(cancelled));
    assert.equal(f.tasks!.shell.scheduler.outstanding,0);
    f.select("allow");const approved=await f.callInput(name,args);assert.equal(approved.isError,false,text(approved));
    if(mode==="background") {
      const id=(approved.details as any).backgroundTask.id;
      const completed=await f.callInput("tasks",{action:"wait",id,timeoutMs:5000});
      assert.match(text(completed),/completed/);assert.equal((completed.details as any).result.shellExecution.exitCode,0);
    }
    await assert.rejects(fs.stat(file),{code:"ENOENT"});assert.equal(f.dialogs.length,before+2);
  }
});
