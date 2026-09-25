import assert from "node:assert/strict";
import test, { after, mock } from "node:test";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { mkdirSync, writeFileSync, readFileSync, realpathSync, symlinkSync, unlinkSync, renameSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createJiti } from "jiti";
import { mutationFixture, MutationWriteGuard } from "./helpers/mutation-fixture.ts";
import { SessionManager } from "../packages/coding-agent/src/core/session-manager.ts";
// Stable I/O interceptor across jiti module scopes; each case owns only its hook.
let opened: ((handle: Awaited<ReturnType<typeof fs.open>>, path: string) => void) | undefined;
const openFile = fs.open;
mock.method(fs, "open", async function(...args: Parameters<typeof fs.open>) {
  const handle = await openFile(...args); opened?.(handle, String(args[0])); return handle;
});
syncBuiltinESMExports();
after(() => { opened = undefined; mock.restoreAll(); syncBuiltinESMExports(); });
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
  const f = await mutationFixture(t), cwd = realpathSync.native(f.cwd), real = spelling === "case" ? "MiXeD" : "e\u0301", input = spelling === "case" ? "mixed" : "茅";
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

for (const operation of ["edit", "write"]) test(`built-in read with mutation and permission guards only: ${operation}`, async t => {
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
  writeFileSync(join(cwd,"builtin-file"),"before");
  async function call(name:string,args:any){ await runner.emit({type:"turn_start"} as never);manager.appendMessage({role:"assistant",content:[{type:"toolCall",id:name,name,arguments:args}],timestamp:0} as never);return session.agent.dispatchHostTool({type:"toolCall",id:name,name,arguments:args}); }
  assert.equal((await call("read",{path:"builtin-file"})).isError,false);
  const result=await call(operation,operation==="write"?{path:"builtin-file",content:"after"}:{path:"builtin-file",edits:[{oldText:"before",newText:"after"}]});
  assert.equal(result.isError,false,JSON.stringify(result));assert.equal(readFileSync(join(cwd,"builtin-file"),"utf8"),"after");
});
