import assert from "node:assert/strict";
import test, { after, mock } from "node:test";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { mkdirSync, writeFileSync, readFileSync, realpathSync, symlinkSync, unlinkSync, renameSync, existsSync, openSync, writeSync, closeSync, statSync } from "node:fs";
import { join } from "node:path";
import { createJiti } from "jiti";
import { mutationFixture, MutationWriteGuard } from "./helpers/mutation-fixture.ts";
import { SessionManager } from "../packages/coding-agent/src/core/session-manager.ts";
// Stable I/O interceptor across jiti module scopes; each case owns only its hook.
let opened: ((handle: Awaited<ReturnType<typeof fs.open>>, path: string) => void) | undefined;
let coarsePath: string | undefined;
function coarseIdentity(info: any, path: string) {
  if (path !== coarsePath) return info;
  const copy = Object.assign(Object.create(Object.getPrototypeOf(info)), info);
  copy.mtimeNs = 1n; copy.ctimeNs = 1n; return copy;
}
const statFile = fs.stat;
mock.method(fs, "stat", async function(...args: any[]) { return coarseIdentity(await (statFile as any)(...args), String(args[0])); });
const openFile = fs.open;
mock.method(fs, "open", async function(...args: Parameters<typeof fs.open>) {
  const handle = await openFile(...args);
  if (String(args[0]) === coarsePath) { const stat = handle.stat.bind(handle); handle.stat = (async (...opts: any[]) => coarseIdentity(await (stat as any)(...opts), String(args[0]))) as typeof handle.stat; }
  opened?.(handle, String(args[0])); return handle;
});
syncBuiltinESMExports();
after(() => { coarsePath = undefined; opened = undefined; mock.restoreAll(); syncBuiltinESMExports(); });
const { restoreMutationEvidenceFromBranch } = await createJiti(import.meta.url).import<any>("../packages/extensions/mutation-guard-write/session-evidence.ts");
for (const change of ["alias", "object"]) test(`read execution to result evidence drift: ${change}`, async t => {
  const f = await mutationFixture(t), cwd = realpathSync.native(f.cwd), alias = join(cwd, "alias"), a = join(cwd, "one/inner/file"), b = join(cwd, "two/inner/file");
  for (const dir of ["one", "two"]) { mkdirSync(join(cwd, dir, "inner"), { recursive: true }); writeFileSync(join(cwd, dir, "inner/file"), "same"); }
  symlinkSync(join(cwd, "one"), alias, process.platform === "win32" ? "junction" : "dir");
  const after = f.agent.afterToolCall!;
  f.agent.afterToolCall = async context => { if (context.toolCall.name === "read") {
    if (change === "alias") { unlinkSync(alias); symlinkSync(join(cwd, "two"), alias, process.platform === "win32" ? "junction" : "dir"); }
    else { renameSync(a, a + "-old"); writeFileSync(a, "same"); }
  } return after(context); };
  const read = await f.call("read", { path: "alias/inner/file" }, "read-drift"); assert.equal(read.isError, false); f.agent.afterToolCall = after;
  if (change === "alias") { unlinkSync(alias); symlinkSync(join(cwd, "one"), alias, process.platform === "win32" ? "junction" : "dir"); }
  const target = change === "alias" ? b : a, branch = SessionManager.open(f.session.getSessionFile()!).getBranch();
  const restored = new MutationWriteGuard(); await restoreMutationEvidenceFromBranch(restored, f.cwd, branch);
  let restoredDenied = false; try { await restored.write(f.cwd, target, "forbidden", 99); } catch { restoredDenied = true; }
  writeFileSync(target, "same");
  const live = await f.call("write", { path: target, content: "forbidden" }, "denied");
  assert.equal(live.isError, true); assert.equal(restoredDenied, true); assert.equal(readFileSync(target, "utf8"), "same");
});
for (const repair of ["number", "markdown", "offset"]) test(`validated read evidence survives reopen: ${repair}`, async t => {
  const f = await mutationFixture(t), cwd = realpathSync.native(f.cwd), path = join(cwd, "123"); writeFileSync(path, "same");
  const args = repair === "number" ? { path: 123 } : repair === "markdown" ? { path: "[123](https://123)" } : { path: "123", offset: 99 };
  const result = await f.call("read", args, "repaired"); assert.equal(result.isError, false, JSON.stringify(result));
  const restored = new MutationWriteGuard(); await restoreMutationEvidenceFromBranch(restored, f.cwd, SessionManager.open(f.session.getSessionFile()!).getBranch());
  assert.equal((await restored.write(f.cwd, path, "after", 99)).ok, true);
});
for (const spelling of ["case", "unicode"]) test(`legacy plain read follows filesystem spelling identity: ${spelling}`, async t => {
  const f = await mutationFixture(t), cwd = realpathSync.native(f.cwd), real = spelling === "case" ? "MiXeD" : "e\u0301", input = spelling === "case" ? "mixed" : "é";
  const path = join(cwd, real); writeFileSync(path, "same");
  if (!existsSync(join(cwd, input))) { t.skip("filesystem distinguishes this spelling"); return; }
  await f.call("read", { path: input }, "legacy");
  const branch = JSON.parse(JSON.stringify(SessionManager.open(f.session.getSessionFile()!).getBranch()));
  for (const entry of branch) if (entry.message?.toolName === "read") { delete entry.message.details.mutationReadEvidence; }
  const restored = new MutationWriteGuard(); await restoreMutationEvidenceFromBranch(restored, f.cwd, branch);
  assert.equal((await restored.write(f.cwd, path, "after", 99)).ok, true);
});

for (const change of ["alias", "object"]) test(`descriptor close to snapshot annotation drift: ${change}`, async t => {
  const f = await mutationFixture(t), cwd = realpathSync.native(f.cwd), alias = join(cwd, "alias");
  for (const dir of ["one", "two"]) { mkdirSync(join(cwd, dir, "inner"), { recursive: true }); writeFileSync(join(cwd, dir, "inner/file"), "same\n"); }
  symlinkSync(join(cwd, "one"), alias, process.platform === "win32" ? "junction" : "dir");
  const target = join(cwd, "one/inner/file");
  let drifted = false;
  opened = (handle, path) => {
    if (!drifted && path === target) {
      const close = handle.close.bind(handle);
      handle.close = async () => { await close(); if (drifted) return; drifted = true;
        if (change === "alias") { unlinkSync(alias); symlinkSync(join(cwd, "two"), alias, process.platform === "win32" ? "junction" : "dir"); }
        else { renameSync(target, target + "-old"); writeFileSync(target, "same\n"); }
      };
    }
  };
  try {
    const result = await f.call("read", { path: "alias/inner/file" }, "before-annotation");
    assert.equal(drifted, true); assert.equal(result.isError, false);
    assert.equal(JSON.stringify(result.content).includes("snapshot="), false);
    assert.equal((result.details as any).mutationReadEvidence.rejected, true);
    for (const dir of ["one", "two"]) assert.equal(readFileSync(join(cwd, dir, "inner/file"), "utf8"), "same\n");
  } finally { opened = undefined; }
});

for (const linked of ["root", "ancestor"]) test(`legacy Session root ${linked} redirect cannot grant new read evidence`, async t => {
  const f = await mutationFixture(t), cwd = realpathSync.native(f.cwd), alias = join(cwd, "workspace-link");
  for (const dir of ["one", "two"]) { mkdirSync(join(cwd, dir, "inner"), { recursive: true }); writeFileSync(join(cwd, dir, "inner/file"), "same"); }
  symlinkSync(join(cwd, "one"), alias, process.platform === "win32" ? "junction" : "dir");
  await f.call("read", { path: "one/inner/file" }, "legacy-root");
  const branch = JSON.parse(JSON.stringify(SessionManager.open(f.session.getSessionFile()!).getBranch()));
  for (const entry of branch) {
    for (const block of entry.message?.content ?? []) if (block.type === "toolCall" && block.name === "read") block.arguments.path = linked === "root" ? "inner/file" : "file";
    if (entry.message?.toolName === "read") { delete entry.message.details.mutationReadEvidence; }
  }
  unlinkSync(alias); symlinkSync(join(cwd, "two"), alias, process.platform === "win32" ? "junction" : "dir");
  const restored = new MutationWriteGuard(), target = join(cwd, "two/inner/file");
  await restoreMutationEvidenceFromBranch(restored, linked === "root" ? alias : join(alias, "inner"), branch);
  await assert.rejects(restored.write(cwd, target, "forbidden", 99));
  assert.equal(readFileSync(target, "utf8"), "same");
});

test("optional snapshot source disappearing retains successful read without evidence", async t => {
  const f = await mutationFixture(t), target = join(realpathSync.native(f.cwd), "file"); writeFileSync(target, "same\n");
  let removed = false;
  opened = (handle, path) => {
    if (path === target) {
      const close = handle.close.bind(handle), read = handle.readFile.bind(handle); let captured = false;
      handle.readFile = (async (...options: any[]) => { const bytes = await (read as any)(...options); captured = true; return bytes; }) as typeof handle.readFile;
      handle.close = async () => { await close(); if (captured && !removed) { removed = true; unlinkSync(target); } };
    }
  };
  try {
    const result = await f.call("read", { path: target }, "snapshot-race");
    assert.equal(removed, true, JSON.stringify(result)); assert.equal(existsSync(target), false); assert.equal(result.isError, false, JSON.stringify(result));
    assert.equal(JSON.stringify(result.content).includes("snapshot="), false); assert.equal((result.details as any).mutationReadEvidence.rejected, true);
  } finally { opened = undefined; }
});

async function builtinGuardFixture(t: test.TestContext) {
  const { createAgentSession } = await import("../packages/coding-agent/src/core/sdk.ts");
  const { DefaultResourceLoader } = await import("../packages/coding-agent/src/core/resource-loader.ts");
  const { SettingsManager } = await import("../packages/coding-agent/src/core/settings-manager.ts");
  const { ALPHA_MODEL, alphaModelRuntime } = await import("./helpers/alpha-session.ts");
  const jiti = createJiti(import.meta.url), mutation = (await jiti.import<any>("../packages/extensions/mutation-guard-write/index.ts")).default;
  const lifecycle = (await jiti.import<any>("../packages/extensions/resource-lifecycle-guard/index.ts")).default;
  const f = await mutationFixture(t), cwd = realpathSync.native(f.cwd), agentDir = join(cwd,"isolated-agent"); mkdirSync(agentDir);
  const settingsManager = SettingsManager.inMemory(), manager = SessionManager.create(cwd,join(cwd,"builtin-sessions"));
  const loader = new DefaultResourceLoader({cwd,agentDir,settingsManager,noContextFiles:true,noSkills:true,noThemes:true,noPromptTemplates:true,extensionFactories:[mutation,lifecycle]}); await loader.reload();
  const {session} = await createAgentSession({cwd,agentDir,settingsManager,resourceLoader:loader,sessionManager:manager,model:ALPHA_MODEL,modelRuntime:alphaModelRuntime(),tools:["read","edit","write"]});
  t.after(()=>session.dispose()); const runner=session.extensionRunner;
  await session.bindExtensions({uiContext:{...runner.getUIContext(),select:async()=>"仅允许本次"},mode:"tui"}); session.setActiveToolsByName(["read","edit","write"]);
  assert.equal(session.getAllTools().filter(tool=>tool.name==="read").length,1);
  let calls=0;
  async function call(name:string,args:any){ const id=`builtin-${++calls}`;await runner.emit({type:"turn_start"} as never);manager.appendMessage({role:"assistant",content:[{type:"toolCall",id,name,arguments:args}],timestamp:0} as never);return session.agent.dispatchHostTool({type:"toolCall",id,name,arguments:args}); }
  return { cwd, session, manager, call };
}
for (const operation of ["edit", "write"]) test(`built-in read with mutation and permission guards only: ${operation}`, async t => {
  const { cwd, call } = await builtinGuardFixture(t);
  writeFileSync(join(cwd,"builtin-file"),"before");
  assert.equal((await call("read",{path:"builtin-file"})).isError,false);
  const result=await call(operation,operation==="write"?{path:"builtin-file",content:"after"}:{path:"builtin-file",edits:[{oldText:"before",newText:"after"}]});
  assert.equal(result.isError,false,JSON.stringify(result));assert.equal(readFileSync(join(cwd,"builtin-file"),"utf8"),"after");
});

for (const cursor of [false, true]) for (const allowed of [false,true]) test(`built-in read window bounds repeated target, cursor=${cursor}, allowed=${allowed}`, async t => {
  const f = await builtinGuardFixture(t), path=join(f.cwd,"large.txt");
  const lines=Array.from({length:3000},()=>"x".repeat(120)); lines[cursor?150:0]="needle";lines[2999]="needle"; const original=lines.join("\n");writeFileSync(path,original);
  const first=await f.call("read",{path:"large.txt"});assert.equal(first.isError,false); assert.ok((first.details as any).window);
  if(cursor){const second=await f.call("read",{path:"large.txt",cursor:(first.details as any).window.cursor});assert.equal(second.isError,false);assert.ok(JSON.stringify(second.content).includes("needle"));}
  const expectedLine=allowed?(cursor?151:1):3000;
  const restored=new MutationWriteGuard();await restoreMutationEvidenceFromBranch(restored,f.cwd,SessionManager.open(f.manager.getSessionFile()!).getBranch());
  let denied=false;try{await restored.authorizeEdit(f.cwd,path,[{oldText:"needle",newText:"changed",expectedLine}],99,original);}catch{denied=true;}
  const result=await f.call("edit",{path:"large.txt",edits:[{oldText:"needle",newText:"changed",expectedLine}]});
  t.diagnostic(JSON.stringify({cursor,allowed,result,denied}));assert.equal(result.isError,!allowed,JSON.stringify(result));assert.equal(denied,!allowed);if(allowed)lines[expectedLine-1]="changed";assert.equal(readFileSync(path,"utf8"),lines.join("\n"));
});

test("Windows held writer control records actual generation and rejects changed content", {skip:process.platform!=="win32"}, async t => {
  const f=await mutationFixture(t),path=join(realpathSync.native(f.cwd),"file");writeFileSync(path,"seen\nold\n");let fd: number | undefined;
  const before=statSync(path,{bigint:true}),afterHook=f.agent.afterToolCall!;let identical=false;
  f.agent.afterToolCall=async context=>{if(context.toolCall.name==="read"){fd=openSync(path,"r+");writeSync(fd,"seen\nnew\n",0,"utf8");const changed=statSync(path,{bigint:true});identical=["dev","ino","size","mtimeNs","ctimeNs","birthtimeNs"].every(k=>(before as any)[k]===(changed as any)[k]);}return afterHook(context);};
  try {
    const read=await f.call("read",{path});assert.equal(read.isError,false);t.diagnostic(JSON.stringify({identical,before:[String(before.mtimeNs),String(before.ctimeNs)],after:[String(statSync(path,{bigint:true}).mtimeNs),String(statSync(path,{bigint:true}).ctimeNs)],details:read.details}));f.agent.afterToolCall=afterHook;
    const result=await f.call("edit",{path,edits:[{oldText:"new",newText:"bad"}]});
    assert.equal(result.isError,true,JSON.stringify(result));assert.equal((read.details as any).mutationReadEvidence.rejected,true);assert.equal(readFileSync(path,"utf8"),"seen\nnew\n");
  } finally {f.agent.afterToolCall=afterHook;if(fd!==undefined)closeSync(fd);}
});

for (const loop of [false, true]) for (const changed of [false,true]) test(`coarse filesystem producer proof, loop=${loop}, changed=${changed}`, async t => {
  const f=loop?await mutationFixture(t):await builtinGuardFixture(t), agent="agent" in f?f.agent:f.session.agent;
  const path=join(realpathSync.native(f.cwd),"file");writeFileSync(path,"seen\nold\n");coarsePath=path;
  const afterHook=agent.afterToolCall!;
  agent.afterToolCall=async context=>{if(changed&&context.toolCall.name==="read")writeFileSync(path,"seen\nnew\n");return afterHook(context);};
  try {
    const read=await f.call("read",{path});assert.equal(read.isError,false);agent.afterToolCall=afterHook;
    const result=await f.call("edit",{path,edits:[{oldText:changed?"new":"old",newText:"bad"}]});
    assert.equal(result.isError,changed,JSON.stringify(result));assert.equal((read.details as any).mutationReadEvidence.rejected===true,changed);assert.equal(readFileSync(path,"utf8"),changed?"seen\nnew\n":"seen\nbad\n");
  }finally{coarsePath=undefined;agent.afterToolCall=afterHook;}
});
