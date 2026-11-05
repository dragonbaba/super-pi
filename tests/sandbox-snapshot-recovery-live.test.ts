import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { WorkspaceSandboxTools } from "../packages/coding-agent/src/core/sandbox/workspace-tools.ts";
import { SessionExecutionPolicy } from "../packages/coding-agent/src/core/execution-policy.ts";
import { createExtensionRuntime } from "../packages/coding-agent/src/core/extensions/loader.ts";
import { CodemodeController } from "../packages/coding-agent/src/core/codemode.ts";
import { wrapToolDefinition } from "../packages/coding-agent/src/core/tools/tool-definition-wrapper.ts";
import { NestedToolDispatch } from "../packages/agent/src/nested-tool-dispatch.ts";

const enabled = process.platform === "win32" && process.env.SUPERPI_SANDBOX_WORKSPACE_ACCEPTANCE === "1";
const distRoot = "../packages/coding-agent/dist/core/";
const SandboxTools: typeof WorkspaceSandboxTools = process.env.SUPERPI_SANDBOX_USE_DIST === "1"
	? (await import(distRoot + "sandbox/workspace-tools.js")).WorkspaceSandboxTools : WorkspaceSandboxTools;

test("live CodeMode snapshot round-trip, stale refusal, fresh VM recovery and final shutdown", {skip:!enabled, timeout:300000}, async () => {
	const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),"snapshot-recovery-")));
	const project=path.join(root,"project"), artifacts=path.join(root,"owners");
	await fs.mkdir(project); await fs.mkdir(artifacts); await fs.writeFile(path.join(project,"notes.txt"),"original");
	const runtime=createExtensionRuntime(); runtime.appendEntry=()=>{};
	const policy=runtime.nativePermissions=new SessionExecutionPolicy(runtime,"sandbox",{},"sandbox-write");
	const owner=new SandboxTools(project,artifacts,"sandbox-write",()=>runtime);
	const ctx:any={cwd:project,hasUI:false,signal:runtime.executionBoundary.signal,sessionManager:{getSessionId:()=>"snapshot-recovery",getLeafEntry:()=>undefined}};
	const definitions:Record<string,any>={}; owner.install(definitions);
	for(const definition of Object.values(definitions)) policy.registerDefinition(definition);
	const tools=[wrapToolDefinition(definitions.read,()=>ctx),wrapToolDefinition(definitions.write,()=>ctx)];
	const codemode=new CodemodeController(()=>{}); codemode.setTools(tools);
	const dispatch=new NestedToolDispatch("snapshot-parent",()=>tools,async(call,tool,signal)=>{
		const args=structuredClone(call.arguments);
		const authorization=await policy.authorize({type:"tool_call",toolName:call.name,toolCallId:call.id,input:args} as any,ctx,definitions[call.name]);
		try {
			authorization.consume(args,call.id,call.name,signal);
			const result=await tool!.execute(call.id,args,signal);
			return {...result,role:"toolResult",toolCallId:call.id,toolName:call.name,isError:result.isError===true,timestamp:1};
		} finally {authorization.release();}
	},ctx.signal);
	try {
		const result=await codemode.definition.execute("snapshot-parent",{code:`
			const r=await tools.read({path:"notes.txt"});
			await tools.write({path:"notes.txt",content:"updated",snapshot:r.details.snapshot});
			const stale=await callTool("write",{path:"notes.txt",content:"must not publish",snapshot:r.details.snapshot},{allowFailure:true});
			if(!stale.isError) throw new Error("Stale write admitted");
			const fresh=await tools.read({path:"notes.txt"});
			if(!fresh.content[0].text.startsWith("updated")) throw new Error("Recovery lost committed content");
			text("snapshot round-trip and recovery passed");
		`},ctx.signal,undefined,ctx,dispatch);
		assert.notEqual(result.isError,true,JSON.stringify(result));
		assert.equal(await fs.readFile(path.join(project,"notes.txt"),"utf8"),"updated");
		assert.equal(owner.diagnostics.starts,2);
	} finally {
		await codemode.close(); await dispatch.close(); await owner.close(); await owner.close();
		policy.dispose(); await runtime.executionBoundary.dispose();
		assert.equal(owner.diagnostics.ownedArtifacts,0); assert.equal(owner.diagnostics.vm,false);
		assert.equal(owner.diagnostics.sourceFiles,0); assert.equal((await fs.readdir(artifacts)).length,0);
		assert.equal(await fs.realpath(root),root); await fs.rm(root,{recursive:true});
	}
});
