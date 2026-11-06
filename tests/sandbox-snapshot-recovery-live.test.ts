import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { WorkspaceSandboxTools } from "../packages/coding-agent/src/core/sandbox/workspace-tools.ts";
import { SessionExecutionPolicy } from "../packages/coding-agent/src/core/execution-policy.ts";
import { SessionManager } from "../packages/coding-agent/src/core/session-manager.ts";
import { createExtensionRuntime } from "../packages/coding-agent/src/core/extensions/loader.ts";
import { CodemodeController } from "../packages/coding-agent/src/core/codemode.ts";
import { wrapToolDefinition } from "../packages/coding-agent/src/core/tools/tool-definition-wrapper.ts";
import { NestedToolDispatch } from "../packages/agent/src/nested-tool-dispatch.ts";

const enabled = process.platform === "win32" && process.env.SUPERPI_SANDBOX_WORKSPACE_ACCEPTANCE === "1";
const distRoot = "../packages/coding-agent/dist/core/";
const SandboxTools: typeof WorkspaceSandboxTools = process.env.SUPERPI_SANDBOX_USE_DIST === "1"
	? (await import(distRoot + "sandbox/workspace-tools.js")).WorkspaceSandboxTools : WorkspaceSandboxTools;

test("live CodeMode retains VM-private files on harmless failure and discards them after failed execution", {skip:!enabled, timeout:300000}, async t => {
	const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),"snapshot-recovery-")));
	const project=path.join(root,"project"), artifacts=path.join(root,"owners");
	await fs.mkdir(project); await fs.mkdir(artifacts); await fs.writeFile(path.join(project,"notes.txt"),"original");
	for (const name of ["target", ".venv", "__pycache__"]) {
		await fs.mkdir(path.join(project,name)); await fs.writeFile(path.join(project,name,"host.txt"),"host sentinel");
	}
	const runtime=createExtensionRuntime(); runtime.appendEntry=()=>{};
	const policy=runtime.nativePermissions=new SessionExecutionPolicy(runtime,"sandbox",{},"sandbox-write");
	const owner=new SandboxTools(project,artifacts,"sandbox-write",()=>runtime);
	const ctx:any={cwd:project,hasUI:false,signal:runtime.executionBoundary.signal,sessionManager:SessionManager.inMemory(project)};
	const definitions:Record<string,any>={}; owner.install(definitions);
	for(const definition of Object.values(definitions)) policy.registerDefinition(definition);
	const tools=[wrapToolDefinition(definitions.read,()=>ctx),wrapToolDefinition(definitions.write,()=>ctx),wrapToolDefinition(definitions.powershell,()=>ctx)];
	const codemode=new CodemodeController(()=>{}); codemode.setTools(tools);
	function createDispatch(id:string) { return new NestedToolDispatch(id,()=>tools,async(call,tool,signal)=>{
		const args=structuredClone(call.arguments);
		const authorization=await policy.authorize({type:"tool_call",toolName:call.name,toolCallId:call.id,input:args} as any,ctx,definitions[call.name]);
		try {
			authorization.consume(args,call.id,call.name,signal);
			const result=await tool!.execute(call.id,args,signal);
			return {...result,role:"toolResult",toolCallId:call.id,toolName:call.name,isError:result.isError===true,timestamp:1};
		} finally {authorization.release();}
	},ctx.signal); }
	const dispatch=createDispatch("snapshot-parent"); let recoveryDispatch:NestedToolDispatch|undefined;
	try {
		const result=await codemode.definition.execute("snapshot-parent",{code:`
			for (const name of ["target", ".venv", "__pycache__"]) {
				const missing=await callTool("read",{path:name+"/host.txt"},{allowFailure:true});
				if(!missing.isError) throw new Error("Host private data imported");
				await tools.write({path:name+"/vm.txt",content:"VM only"});
			}
			const r=await tools.read({path:"notes.txt"});
			await tools.write({path:"notes.txt",content:"updated",snapshot:r.details.snapshot});
			const stale=await callTool("write",{path:"notes.txt",content:"must not publish",snapshot:r.details.snapshot},{allowFailure:true});
			if(!stale.isError) throw new Error("Stale write admitted");
			const fresh=await tools.read({path:"notes.txt"});
			if(!fresh.content[0].text.startsWith("updated")) throw new Error("Recovery lost committed content");
			const privateRead=await tools.read({path:"target/vm.txt"});
			if(!privateRead.content[0].text.startsWith("VM only")) throw new Error("Harmless failure lost VM-private file");
			text("snapshot round-trip and recovery passed");
		`},ctx.signal,undefined,ctx,dispatch);
		assert.notEqual(result.isError,true,JSON.stringify(result));
		assert.equal(await fs.readFile(path.join(project,"notes.txt"),"utf8"),"updated");
		assert.equal(owner.diagnostics.starts,1);
		recoveryDispatch=createDispatch("snapshot-recovery");
		const failed=await codemode.definition.execute("snapshot-recovery",{code:`
			const result=await callTool("powershell",{command:"Set-Content -LiteralPath 'target/dirty.txt' -Value 'discard'; exit 9"},{allowFailure:true});
			if(!result.isError) throw new Error("Failed command admitted");
			const fresh=await tools.read({path:"notes.txt"});
			if(!fresh.content[0].text.startsWith("updated")) throw new Error("New snapshot lost host content");
			const missing=await callTool("read",{path:"target/vm.txt"},{allowFailure:true});
			if(!missing.isError) throw new Error("Failed execution reused the old VM");
		`},ctx.signal,undefined,ctx,recoveryDispatch);
		assert.notEqual(failed.isError,true,JSON.stringify(failed));assert.equal(owner.diagnostics.starts,2);
		for (const name of ["target", ".venv", "__pycache__"]) {
			assert.deepEqual(await fs.readdir(path.join(project,name)),["host.txt"]);
			assert.equal(await fs.readFile(path.join(project,name,"host.txt"),"utf8"),"host sentinel");
		}
		t.diagnostic(JSON.stringify({harmlessFailuresVmStarts:1,failedCommandVmStarts:owner.diagnostics.starts,hostPrivateSentinels:3,privateWritebacks:0}));
	} finally {
		await codemode.close(); await dispatch.close(); await recoveryDispatch?.close(); await owner.close(); await owner.close();
		policy.dispose(); await runtime.executionBoundary.dispose();
		assert.equal(owner.diagnostics.ownedArtifacts,0); assert.equal(owner.diagnostics.vm,false);
		assert.equal(owner.diagnostics.sourceFiles,0); assert.equal((await fs.readdir(artifacts)).length,0);
		assert.equal(await fs.realpath(root),root); await fs.rm(root,{recursive:true});
	}
});
