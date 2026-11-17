import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { delimiter, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { rgPath } from "@vscode/ripgrep";
import { createOwnedTaskFixture } from "./helpers/owned-task-fixture.ts";

test("real native grep ignores project and added-workspace executables and launches one pinned binary offline", t => {
	const owned = createOwnedTaskFixture("native-search-trust-"); t.after(() => owned.cleanup());
	const workspace = join(owned.root, "project"), additional = join(owned.root, "additional"), agentDir = join(owned.root, "agent");
	mkdirSync(workspace); mkdirSync(additional); mkdirSync(agentDir);
	writeFileSync(join(workspace, "data.txt"), "needle\n");
	const executable = process.platform === "win32" ? "rg.exe" : "rg";
	for (const directory of [workspace, additional]) copyFileSync(process.execPath, join(directory, executable));
	const probe = join(owned.root, "probe.mjs");
	writeFileSync(probe, `import childProcess from "node:child_process";
import {syncBuiltinESMExports} from "node:module";
const commands=[], original=childProcess.spawn;
childProcess.spawn=function(command,args,options){commands.push({command,args});return original(command,args,options)};
syncBuiltinESMExports();
const {createGrepToolDefinition}=await import(${JSON.stringify(pathToFileURL(resolve("packages/coding-agent/src/core/tools/grep.ts")).href)});
const {attachToolPath}=await import(${JSON.stringify(pathToFileURL(resolve("packages/coding-agent/src/core/files/tool-path-authorization.ts")).href)});
let current=true,checks=0;const revoke=process.argv[2]==="revoke";
const input={pattern:"needle",path:"data.txt",literal:true};
attachToolPath(input,"grep","search",${JSON.stringify(join(workspace, "data.txt"))},()=>{checks++;if(!current)throw Error("authority changed")},${JSON.stringify({ workspace, directories: [additional] })});
const options=revoke?{operations:{isDirectory(){current=false;return false},readFile(){return "needle\\n"}}}:undefined;
try {
const result=await createGrepToolDefinition(${JSON.stringify(workspace)},options).execute("search",input);
process.stdout.write(JSON.stringify({commands,checks,text:result.content.filter(x=>x.type==="text").map(x=>x.text).join("\\n")}));
}catch(error){process.stdout.write(JSON.stringify({commands,checks,error:error.message}));}
`);
	const env: NodeJS.ProcessEnv = { ...process.env, SP_CODING_AGENT_DIR: agentDir, SP_OFFLINE: "1" };
	for (const key of Object.keys(env)) if (key.toLowerCase() === "path" || key.toLowerCase() === "nodefaultcurrentdirectoryinexepath") delete env[key];
	env.PATH = [workspace, additional, dirname(rgPath)].join(delimiter);
	const observed = JSON.parse(execFileSync(process.execPath, ["--experimental-strip-types", probe], { cwd: workspace, env, encoding: "utf8", windowsHide: true }));
	assert.match(observed.text, /needle/);
	assert.equal(observed.commands.length, 1, "resolution never launches --version or another executable probe");
	assert.equal(observed.commands[0].command, realpathSync.native(rgPath));
	assert.equal(observed.commands[0].args.includes("--version"), false);
	assert.equal(observed.checks, 2);
	const revoked = JSON.parse(execFileSync(process.execPath, ["--experimental-strip-types", probe, "revoke"], { cwd: workspace, env, encoding: "utf8", windowsHide: true }));
	assert.match(revoked.error, /authority changed/); assert.equal(revoked.commands.length, 0); assert.equal(revoked.checks, 2);
});
