import assert from "node:assert/strict";
import { writeFileSync, renameSync } from "node:fs";
import { readFile, writeFile, rename } from "node:fs/promises";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { FileService, type FileOperation, type FileExecutionHooks } from "../packages/coding-agent/src/core/files/file-service.ts";
import { issueSnapshotForRead, prepareSnapshotLineMutation, executePreparedSnapshotMutation, MAX_SNAPSHOT_FILE_BYTES } from "../packages/coding-agent/src/core/files/snapshot-line-edit.ts";
import { FileCommitError, type FileCommitReceipt } from "../packages/coding-agent/src/core/files/file-commit.ts";
import type { CreationResult } from "../packages/coding-agent/src/core/files/file-creation.ts";
import { createReadToolDefinition } from "../packages/coding-agent/src/core/tools/read.ts";
import { disposeNativeFileWorker } from "../packages/coding-agent/src/core/files/native-file-client.ts";
import { createOwnedTaskFixture } from "./helpers/owned-task-fixture.ts";

function fixture(t:TestContext) {
  const owned=createOwnedTaskFixture("committed-revision-"), service=new FileService(owned.root,"revision-session");
  t.after(async()=>{service.dispose();await disposeNativeFileWorker();owned.cleanup();});
  let reads=0;
  const hooks:FileExecutionHooks={assertCurrent(){},record(){}};
  return {root:owned.root,service,get reads(){return reads;},hooks,
    async run(operation:FileOperation,input:Record<string,unknown>,id:string,execution:FileExecutionHooks=hooks) {return service.execute(await service.prepare(operation,input),id,execution);},
    async read(path:string) {
      reads++;
      const result=await createReadToolDefinition(owned.root).execute("read",{path,limit:1},undefined,undefined,{} as never);
      const annotation=await issueSnapshotForRead("revision-session",owned.root,{path,limit:1},result,service.revisions);
      assert.ok(annotation,JSON.stringify({first:result.content[0]?.type==="text"?result.content[0].text.slice(0,300):undefined,details:result.details}));return {id:/snapshot=(snap_[\w-]+)/u.exec(annotation)![1]!,result};
    }};
}

test("native read/edit/edit/edit continues exact text without manufacturing new observed anchors",async t=>{
  const f=fixture(t), path=join(f.root,"source.txt"); await writeFile(path,"one\ntwo\nthree\nfour\n");
  const original=await f.read(path);
  let previous=original.id;
  for(const [index,edits] of [[{oldText:"one",newText:"ONE"}],[{oldText:"two",newText:"TWO"},{oldText:"three",newText:"THREE"}],[{oldText:"four",newText:"FOUR"}]].entries()) {
    const receipt=await f.run("edit",{path,edits},"edit-"+index);
    assert.equal(receipt.ok,true);assert.equal(receipt.revisionContinuation,"available");
    assert.equal(f.service.revisions.get(previous),undefined);
    previous=receipt.revision as string;const revision=f.service.revisions.get(previous)!;
    assert.equal(revision.firstSeenLine,1);assert.equal(revision.lastSeenLine,0);
    assert.equal(f.service.revisions.size,1);
  }
  assert.equal(f.reads,1);assert.equal(await readFile(path,"utf8"),"ONE\nTWO\nTHREE\nFOUR\n");
  const anchor="1#0000";
  await assert.rejects(f.service.prepare("edit",{path,snapshot:original.id,edits:[{kind:"replace",start:anchor,newLines:["bad"]}]}),/SNAPSHOT_EDIT_UNKNOWN/);
  await assert.rejects(f.service.prepare("edit",{path,snapshot:previous,edits:[{kind:"replace",start:anchor,newLines:["bad"]}]}),/SNAPSHOT_EDIT_UNSEEN/);
  await f.read(path);assert.equal(f.service.revisions.size,1,"observed read replaces only the unobserved commit buffer");
});

test("native new write continues edits and rejects subsequent external content or identity changes",async t=>{
  for(const change of ["content","same-content-replacement"] as const) {
    const f=fixture(t), path=join(f.root,"new.txt");
    const created=await f.run("write",{path,content:"source\n"},"create");assert.equal(created.revisionContinuation,"available");
    assert.equal((await f.run("edit",{path,edits:[{oldText:"source",newText:"changed"}]},"change")).ok,true);
    assert.equal(f.reads,0);
    if(change==="content")await writeFile(path,"external\n");
    else {const replacement=join(f.root,"replacement");await writeFile(replacement,"changed\n");await rename(replacement,path);}
    await assert.rejects(f.service.prepare("edit",{path,edits:[{oldText:"changed",newText:"unsafe"}]}),/SNAPSHOT_EDIT_STALE/);
  }
});

test("continuation verifies original publication proof and transfers the exact owned buffer",async t=>{
  const f=fixture(t),path=join(f.root,"proof.txt");
  const created=await f.run("write",{path,content:"source"},"create");f.service.revisions.invalidatePath(path);
  const generation=f.service.revisions.generation;
  assert.equal(await f.service.revisions.continueCommitted(path,Buffer.from("source"),{...created.creation as CreationResult},generation,"owner","forged",()=>{}),undefined);
  const own=Buffer.from("source");
  const id=await f.service.revisions.continueCommitted(path,own,created.creation as CreationResult,generation,"owner","owned",()=>{});
  assert.ok(id);const stored=f.service.revisions.get(id)!;assert.ok(stored.mode==="full");assert.equal(stored.bytes,own);
  const changed=await f.run("edit",{path,edits:[{oldText:"source",newText:"changed"}]},"edit");f.service.revisions.invalidatePath(path);
  assert.equal(await f.service.revisions.continueCommitted(path,Buffer.from("changed"),{...changed.commit!},generation,"owner","forged",()=>{}),undefined);
  const next=await f.service.revisions.continueCommitted(path,Buffer.from("changed"),changed.commit as FileCommitReceipt,generation,"owner","real",()=>{});
  assert.ok(next); f.service.revisions.forgetContinuations("other");assert.ok(f.service.revisions.get(next));
  f.service.revisions.forgetContinuations("owner","real");assert.equal(f.service.revisions.get(next),undefined);
});

test("journal, post-publication replacement, cancellation and lifecycle failure cannot publish a continuation",async t=>{
  for(const fault of ["journal","replacement","content","cancel","clear","close"] as const) {
    const f=fixture(t),path=join(f.root,"source.txt"),controller=new AbortController();
    const receipt=await f.run("write",{path,content:"written"},fault,{assertCurrent(){},signal:controller.signal,record(entry){
      if(entry.phase!=="result")return;
      if(fault==="journal")throw new Error("synthetic journal failure");
      if(fault==="replacement"){const replacement=join(f.root,"replacement");writeFileSync(replacement,"written");renameSync(replacement,path);}
      if(fault==="content")writeFileSync(path,"external");
      if(fault==="cancel")controller.abort();if(fault==="clear")f.service.clear();if(fault==="close")f.service.dispose();
    }});
    assert.equal(receipt.revision,undefined,fault);assert.equal(f.service.revisions.size,0,fault);
    assert.equal(receipt.stateChanged,true,fault);assert.equal(await readFile(path,"utf8"),fault==="content"?"external":"written");
    if(fault==="journal"){assert.equal(receipt.status,"partial");assert.equal(receipt.requiresVerification,true);}
    else assert.equal(receipt.ok,true,"cache unavailability never makes a completed operation replayable");
  }
  const f=fixture(t),path=join(f.root,"retained.txt");await f.run("write",{path,content:"old"},"create");
  const receipt=await f.run("write",{path,content:"new"},"overwrite",{assertCurrent(){},record(entry){if(entry.phase==="result" && entry.commit){const temporary=join(f.root,"retained.tmp");writeFileSync(temporary,"retained");(entry.commit as FileCommitReceipt).retainedTemporary=temporary;}}});
  assert.equal(receipt.revision,undefined);assert.notEqual(receipt.revisionContinuation,"available");assert.equal(await readFile(path,"utf8"),"new");
});

test("failed afterCommit never hands off bytes even when the file was committed",async t=>{
  const f=fixture(t),path=join(f.root,"callback.txt");await writeFile(path,"one\n");const read=await f.read(path);
  const first=read.result.content[0];assert.ok(first.type==="text");const anchor=/^(1#[A-F0-9]{4})\|/u.exec(first.text)![1]!;
  const hooks={revisions:f.service.revisions,assertPathAllowed:async()=>path,afterCommit(){throw new Error("synthetic afterCommit failure");},committedBytes(){throw new Error("handoff must not occur");}};
  const plan=await prepareSnapshotLineMutation("revision-session",f.root,path,read.id,[{kind:"replace",start:anchor,newLines:["ONE"]}],undefined,hooks);
  await assert.rejects(executePreparedSnapshotMutation(plan,undefined,hooks),error=>error instanceof FileCommitError && error.receipt.outcome==="committed" && /afterCommit failure/.test(error.message));
  assert.equal(f.service.revisions.size,0);assert.equal(await readFile(path,"utf8"),"ONE\n");
});

test("continuation preserves 2-MiB per-file and 128-entry/8-MiB cache limits",async t=>{
  const f=fixture(t), ids:string[]=[];
  for(let index=0;index<129;index++){const receipt=await f.run("write",{path:"small-"+index,content:"small"},"create-"+index);ids.push(receipt.revision as string);}
  assert.equal(f.service.revisions.size,128);assert.equal(f.service.revisions.get(ids[0]!),undefined);
  const fullText="one\n"+("x".repeat(1023)+"\n").repeat(2047)+"x".repeat(1020);assert.equal(Buffer.byteLength(fullText),MAX_SNAPSHOT_FILE_BYTES);
  for(let index=0;index<5;index++) {
    const path=join(f.root,"large-"+index+".txt");await writeFile(path,fullText);await f.read(path);
    assert.equal((await f.run("edit",{path,edits:[{oldText:"one",newText:"ONE"}]},"large-"+index)).revisionContinuation,"available");
  }
  assert.ok(f.service.revisions.residentBytes<=8*1024*1024);assert.equal(f.service.revisions.size,4);
  const path=join(f.root,"beyond-limit.txt");await writeFile(path,"one\n"+("x".repeat(1023)+"\n").repeat(2048));const source=await f.read(path);
  const first=source.result.content[0];assert.ok(first.type==="text");const anchor=/^(1#[A-F0-9]{4})\|/u.exec(first.text)![1]!;
  const large=await f.run("edit",{path,snapshot:source.id,edits:[{kind:"replace",start:anchor,newLines:["ONE"]}]},"beyond");
  assert.equal(large.ok,true);assert.equal(large.revisionContinuation,"unavailable");
  await assert.rejects(f.service.prepare("edit",{path,edits:[{oldText:"ONE",newText:"y"}]}),/REVISION_REQUIRED/);
});
