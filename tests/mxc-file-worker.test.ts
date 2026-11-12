import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { mxcFileFixture, legacyMxcFileFixture } from "./helpers/mxc-file-fixture.ts";
import { MXC_FILE_RUNTIME_ASSETS, MXC_FILE_WORKER_PATH } from "../packages/coding-agent/src/core/files/file-runtime-assets.mjs";

test("Historical v2: MXC write/edit/edit/edit returns verified successor hashes without an intervening read",t=>{
  const f=legacyMxcFileFixture(t), name="successor.txt";
  const created=f.invoke("write",{path:name,content:"one\ntwo\nthree\n"});assert.equal(created.ok,true);
  let snapshot=created.snapshot;
  for(const edits of [[{oldText:"one",newText:"ONE"}],[{oldText:"two",newText:"TWO"},{oldText:"three",newText:"THREE"}],[{oldText:"ONE",newText:"first"}]]) {
    const previous=snapshot, result=f.invoke("edit",{path:name,snapshot,edits});
    assert.equal(result.ok,true,JSON.stringify(result));snapshot=result.snapshot;
    assert.equal(snapshot,createHash("sha256").update(fs.readFileSync(path.join(f.input,name))).digest("hex"));
    assert.equal(f.invoke("write",{path:name,snapshot:previous,content:"stale"}).ok,false);
  }
  assert.equal(fs.readFileSync(path.join(f.input,name),"utf8"),"first\nTWO\nTHREE\n");
  assert.equal(f.invoke("write",{path:name,content:"missing hash"}).ok,false);
  const replaced=path.join(f.input,"replacement");fs.writeFileSync(replaced,"first\nTWO\nTHREE\n");fs.renameSync(replaced,path.join(f.input,name));
  const sameContent=f.invoke("edit",{path:name,snapshot,edits:[{oldText:"first",newText:"final"}]});assert.equal(sameContent.ok,true,"cross-call MXC versions retain content-hash semantics");
});

test("Historical v2: MXC read/edit successors and partial batches preserve individual verified effects",t=>{
  const f=legacyMxcFileFixture(t),file=path.join(f.input,"existing");fs.writeFileSync(file,"old");
  const read=f.invoke("read",{path:"existing"}), edit=f.invoke("edit",{path:"existing",snapshot:read.snapshot,edits:[{oldText:"old",newText:"new"}]});
  assert.equal(edit.ok,true);assert.equal(f.invoke("write",{path:"existing",snapshot:edit.snapshot,content:"complete"}).ok,true);
  const batch=f.invoke("file_batch",{operations:[{operation:"write",path:"kept",content:"kept"},{operation:"edit",path:"missing",snapshot:read.snapshot,edits:[{oldText:"a",newText:"b"}]},{operation:"write",path:"not-started",content:"unused"}]});
  assert.equal(batch.ok,false);assert.deepEqual(batch.items.map((item:any)=>item.status),["succeeded","unknown","not_started"]);
  assert.equal(batch.items[0].snapshot,createHash("sha256").update("kept").digest("hex"));assert.equal(batch.items[1].snapshot,undefined);
  assert.equal(fs.existsSync(path.join(f.input,"not-started")),false);
  assert.equal(f.invoke("edit",{path:"kept",snapshot:batch.items[0].snapshot,edits:[{oldText:"kept",newText:"continued"}]}).ok,true);
});

for(const replacement of [false,true]) test(`Historical v2: MXC publication verification refuses changed postimages, replacement=${replacement}`,t=>{
  const f=legacyMxcFileFixture(t), file=path.join(f.input,"source");fs.writeFileSync(file,"old");const snapshot=f.invoke("read",{path:"source"}).snapshot;
  const io=Object.create(fs);
  io.renameSync=(temporary:string,target:string)=>{
    fs.renameSync(temporary,target);
    if(replacement){const other=path.join(f.input,"external");fs.writeFileSync(other,"new");fs.renameSync(other,target);}
    else fs.writeFileSync(target,"external");
  };
  const result=f.invoke("write",{path:"source",snapshot,content:"new"},"sandbox-write",io);
  assert.equal(result.ok,false);assert.equal(result.snapshot,undefined);assert.equal(result.noEffects,false);assert.match(result.error,/Published file/);
  assert.equal(result.requiresVerification,true,"a failed post-publication observation cannot become an ordinary handled error");
  assert.equal(fs.readFileSync(file,"utf8"),replacement?"new":"external");assert.deepEqual(fs.readdirSync(f.input),["source"]);
});

for(const stage of ["write","stat","close"] as const)test(`Historical v2: MXC new-file ${stage} failure retains uncertainty after creation`,t=>{
  const f=legacyMxcFileFixture(t),io=Object.create(fs);let written=false,closed=false;
  io.writeFileSync=(fd:any,content:any)=>{if(stage==="write"){fs.writeSync(fd,"partial");throw Object.assign(new Error("disk full"),{code:"ENOSPC"});}fs.writeFileSync(fd,content);written=true;};
  io.fstatSync=(fd:number,options:any)=>{if(stage==="stat"&&written)throw new Error("publication stat failed");return fs.fstatSync(fd,options);};
  io.closeSync=(fd:number)=>{fs.closeSync(fd);if(stage==="close"&&written&&!closed){closed=true;throw new Error("publication close failed");}};
  const reply=f.invoke("write",{path:"new",content:"complete"},"sandbox-write",io);
  assert.equal(reply.ok,false);assert.equal(reply.requiresVerification,true);assert.equal(reply.snapshot,undefined);assert.equal(reply.noEffects,false);
  assert.equal(fs.readFileSync(path.join(f.input,"new"),"utf8"),stage==="write"?"partial":"complete");
});

test("Historical v2: MXC pre-creation and stale-hash refusals stay recoverable",t=>{
  const f=legacyMxcFileFixture(t),io=Object.create(fs);
  io.openSync=()=>{throw Object.assign(new Error("creation denied"),{code:"EACCES"});};
  const denied=f.invoke("write",{path:"denied",content:"none"},"sandbox-write",io);
  assert.equal(denied.ok,false);assert.equal(denied.requiresVerification,undefined);assert.equal(fs.existsSync(path.join(f.input,"denied")),false);
  fs.writeFileSync(path.join(f.input,"existing"),"old");
  const stale=f.invoke("write",{path:"existing",snapshot:"0".repeat(64),content:"bad"});
  assert.equal(stale.ok,false);assert.equal(stale.requiresVerification,undefined);assert.equal(fs.readFileSync(path.join(f.input,"existing"),"utf8"),"old");
  fs.writeFileSync(path.join(f.input,"occupied"),"destination");
  const conflict=f.invoke("move",{path:"existing",destination:"occupied"});
  assert.equal(conflict.ok,false);assert.equal(conflict.requiresVerification,undefined);assert.equal(fs.readFileSync(path.join(f.input,"occupied"),"utf8"),"destination");
});

test("Historical v2: MXC partial batch creation retains successful hashes and marks uncertain publication",t=>{
  const f=legacyMxcFileFixture(t),io=Object.create(fs);let writes=0;
  io.writeFileSync=(fd:any,content:any)=>{if(++writes===2){fs.writeSync(fd,"partial");throw new Error("disk full");}fs.writeFileSync(fd,content);};
  const reply=f.invoke("file_batch",{operations:[{operation:"write",path:"first",content:"one"},{operation:"write",path:"second",content:"two"},{operation:"write",path:"third",content:"three"}]},"sandbox-write",io);
  assert.equal(reply.ok,false);assert.equal(reply.requiresVerification,true);
  assert.deepEqual(reply.items.map((item:any)=>item.status),["succeeded","unknown","not_started"]);
  assert.match(reply.items[0].snapshot,/^[a-f0-9]{64}$/);assert.equal(reply.items[1].snapshot,undefined);
  assert.equal(fs.readFileSync(path.join(f.input,"first"),"utf8"),"one");assert.equal(fs.readFileSync(path.join(f.input,"second"),"utf8"),"partial");assert.equal(fs.existsSync(path.join(f.input,"third")),false);
});

test("Historical v2: MXC partial link-move and retained staged candidates require verification",t=>{
  const f=legacyMxcFileFixture(t);fs.writeFileSync(path.join(f.input,"source"),"old");
  const moveIO=Object.create(fs);moveIO.unlinkSync=()=>{throw new Error("source removal failed");};
  const moved=f.invoke("move",{path:"source",destination:"destination"},"sandbox-write",moveIO);
  assert.equal(moved.ok,false);assert.equal(moved.requiresVerification,true);assert.equal(fs.readFileSync(path.join(f.input,"destination"),"utf8"),"old");
  const snapshot=f.invoke("read",{path:"source"}).snapshot,stageIO=Object.create(fs);
  stageIO.writeFileSync=()=>{throw new Error("staged write failed");};stageIO.unlinkSync=()=>{throw new Error("candidate cleanup failed");};
  const staged=f.invoke("write",{path:"source",snapshot,content:"new"},"sandbox-write",stageIO);
  assert.equal(staged.ok,false);assert.equal(staged.requiresVerification,true);assert.equal(fs.readFileSync(path.join(f.input,"source"),"utf8"),"old");
});

test("Historical v2: MXC files update the workspace, retain dependencies and reject stale snapshots", t => {
  const f = legacyMxcFileFixture(t);
  for (const name of ["ordinary.txt", ".venv/installed.txt", "target/output.txt", "__pycache__/cache.txt", "node_modules/local.txt"]) {
    assert.equal(f.invoke("write", { path: name, content: "first" }).ok, true);
    const read = f.invoke("read", { path: name }); assert.equal(read.ok, true);
    const edited = f.invoke("edit", { path: name, snapshot: read.snapshot, edits: [{ oldText: "first", newText: "changed" }] });
    assert.equal(edited.ok, true, JSON.stringify(edited));
    assert.equal(fs.readFileSync(path.join(f.input, name), "utf8"), "changed");
    assert.equal(f.invoke("write", { path: name, snapshot: read.snapshot, content: "stale" }).ok, false);
    assert.equal(fs.readFileSync(path.join(f.input, name), "utf8"), "changed");
  }
  const batch = f.invoke("file_batch", { operations: [{ operation: "write", path: "completed", content: "kept" }, { operation: "edit", path: "missing" }] });
  assert.equal(batch.ok, false); assert.equal(batch.noEffects, false); assert.equal(fs.readFileSync(path.join(f.input, "completed"), "utf8"), "kept");
});

test("Historical v2: MXC native tools refuse protected mutations, readonly writes and invalid UTF-8 edits", t => {
  const f = legacyMxcFileFixture(t);
  for (const name of [".git", ".sp"]) {
    fs.mkdirSync(path.join(f.input, name)); fs.writeFileSync(path.join(f.input, name, "config"), "kept");
    assert.equal(f.invoke("read", { path: name + "/config" }).ok, true);
    for (const operation of ["write", "delete", "move"]) assert.equal(f.invoke(operation, { path: name + "/config", destination: "moved", content: "x" }).ok, false);
    assert.equal(fs.readFileSync(path.join(f.input, name, "config"), "utf8"), "kept");
  }
  assert.equal(f.invoke("write", { path: "blocked", content: "x" }, "read-only").ok, false);
  assert.equal(fs.existsSync(path.join(f.input, "blocked")), false);
  const bytes = Buffer.from([97, 255, 98]); fs.writeFileSync(path.join(f.input, "invalid"), bytes);
  const edit = f.invoke("edit", { path: "invalid", snapshot: createHash("sha256").update(bytes).digest("hex"), edits: [{ oldText: "a", newText: "c" }] });
  assert.equal(edit.ok, false); assert.match(edit.error, /UTF-8/); assert.deepEqual(fs.readFileSync(path.join(f.input, "invalid")), bytes);
  assert.equal(f.invoke("write", { path: "too-large", content: "x".repeat(1024 * 1024 + 1) }).ok, false);
  assert.equal(fs.existsSync(path.join(f.input, "too-large")), false);
});

test("Historical v2: MXC atomic replacement leaves the original intact on temporary write failure", t => {
  const f = legacyMxcFileFixture(t), file = path.join(f.input, "source.txt"); fs.writeFileSync(file, "original");
  const snapshot = f.invoke("read", { path: "source.txt" }).snapshot, io = Object.create(fs);
  io.writeFileSync = (target: any, ...args: any[]) => {
    if (typeof target === "number") throw new Error("fixture disk full");
    return (fs.writeFileSync as any)(target, ...args);
  };
  const reply = f.invoke("write", { path: "source.txt", snapshot, content: "replacement" }, "sandbox-write", io);
  assert.equal(reply.ok, false); assert.match(reply.error, /disk full/);
  assert.equal(fs.readFileSync(file, "utf8"), "original"); assert.deepEqual(fs.readdirSync(f.input), ["source.txt"]);
});

test("MXC reads detect growth without expanding the admitted buffer", t => {
  const f = mxcFileFixture(t), file = path.join(f.input, "growing.txt"); fs.writeFileSync(file, "original");
  const io = Object.create(fs); let reads = 0;
  io.readSync = (...args: any[]) => {
    const result = (fs.readSync as any)(...args);
    if (++reads === 2) fs.appendFileSync(file, "changed");
    return result;
  };
  const reply = f.invoke("read", { path: "growing.txt" }, "read-only", io);
  assert.equal(reply.ok, false); assert.match(reply.error, /changed during read/); assert.equal(reply.noEffects, true);
});

test("MXC search scopes files and directories, bounds rows and preserves no-match results", t => {
  const f = mxcFileFixture(t); fs.mkdirSync(path.join(f.input, "search")); fs.mkdirSync(path.join(f.input, "unrelated"));
  for (let i = 0; i < 201; i++) fs.writeFileSync(path.join(f.input, "search", i + ".txt"), "needle\n");
  const io = Object.create(fs); io.opendirSync = (name: string, ...args: any[]) => {
    assert.notEqual(name, path.join(f.input, "unrelated")); return (fs.opendirSync as any)(name, ...args);
  };
  const grep = f.invoke("grep", { path: "search", pattern: "needle" }, "read-only", io);
  assert.equal(grep.ok, true); assert.match(grep.text, /Results truncated/); assert.equal(grep.text.split("\n").length, 201);
  assert.equal(f.invoke("grep", { path: "search/0.txt", pattern: "absent" }).text, "(no matches)");
  const exact = f.invoke("grep", { path: "search/0.txt", pattern: "needle" }); assert.equal(exact.text, "search/0.txt:1:needle");
});

test("MXC search keeps the complete JSON response within the transport budget", t => {
  const f = mxcFileFixture(t), scope = path.join("中".repeat(70), "文".repeat(70), "字".repeat(70));
  fs.mkdirSync(path.join(f.input, scope), { recursive: true });
  for (let index = 0; index < 200; index++) fs.writeFileSync(path.join(f.input, scope, index + ".txt"), "中".repeat(256));
  const reply = f.invoke("grep", { path: scope, pattern: "中" });
  assert.equal(reply.ok, true); assert.match(reply.text, /Results truncated/);
  assert.ok(Buffer.byteLength(JSON.stringify(reply)) + 1 <= 256 * 1024);
  assert.ok(reply.text.startsWith("[Search status:")); assert.ok(reply.text.includes(scope));
});

test("packaged controlled worker loads its real module assets and emits facts (host process, not isolation)", t => {
  const f = mxcFileFixture(t);
  const dist = new URL("../packages/coding-agent/dist/core/sandbox/", import.meta.url);
  for (const [source, name] of MXC_FILE_RUNTIME_ASSETS) {
    const target = path.join(f.runtime, name); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.copyFileSync(new URL(source, dist), target);
  }
  fs.writeFileSync(path.join(f.input, "hits"), "needle needle\nneedle");
  const request = path.join(f.runtime, "request.json");
  fs.writeFileSync(request, JSON.stringify({ id: "dist", workspaces: [f.input], exchange: f.exchange, mode: "read-only", operation: "grep",
    input: { pattern: "needle" } }));
  const result = spawnSync(process.execPath, [path.join(f.runtime, MXC_FILE_WORKER_PATH), request], { encoding: "utf8", timeout: 5000,
    env: { ...process.env, TMP: f.root, TEMP: f.root, TMPDIR: f.root } });
  assert.equal(result.status, 0, result.stderr); const reply = JSON.parse(result.stdout);
  assert.equal(reply.ok, true); assert.equal(reply.search.outputMode, "content"); assert.equal(reply.search.coverageComplete, true); assert.equal(reply.text, "hits:1:needle needle\nhits:2:needle");
});
