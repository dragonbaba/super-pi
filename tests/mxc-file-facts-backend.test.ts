import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { WorkspaceSandboxBackend, WorkspaceOperationError } from "../packages/coding-agent/src/core/sandbox/workspace-backend.ts";
import { mxcFileFixture } from "./helpers/mxc-file-fixture.ts";

// Mock only native launch/policy. invoke(), run(), JSON parsing and validation
// execute unchanged, unlike the higher-level fixture's attach() seam.
function fixture(t: TestContext, change: (reply: any) => void = () => {}, mode: "read-only" | "sandbox-write" = "read-only") {
  const f = mxcFileFixture(t), backend = new WorkspaceSandboxBackend(f.input, f.root, mode), internal = backend as any;
  fs.writeFileSync(path.join(f.input, "text"), "needle\nlast");
  const stat = fs.lstatSync(f.runtime, { bigint: true }), workspace = fs.lstatSync(f.input, { bigint: true });
  internal.root = f.runtime; internal.identity = stat.dev + ":" + stat.ino; internal.tools = f.runtime;
  internal.exchange = f.exchange; internal.starts = 1; internal.environment = {};
  internal.roots.push(f.input); internal.identities.push(workspace.dev + ":" + workspace.ino);
  t.mock.method(internal, "policy", async () => "fixture policy");
  t.mock.method(internal.runner, "run", async () => {
    const request = JSON.parse(fs.readFileSync(path.join(f.runtime, "request.json"), "utf8"));
    const reply = f.invoke(request.operation, request.input, mode); reply.id = request.id; change(reply);
    return { code: reply.ok ? 0 : 1, stdout: JSON.stringify(reply) + "\n", stderr: "", timedOut: false, truncated: false };
  });
  f.cleanupWith(() => backend.close());
  return backend;
}

test("MXC backend validates mutation successors and preserves verified partial batch receipts",async t=>{
  const backend=fixture(t,undefined,"sandbox-write");
  const created=await backend.invoke("write",{path:"new",content:"one"});assert.match(created.snapshot!,/^[a-f0-9]{64}$/);
  const edited=await backend.invoke("edit",{path:"new",snapshot:created.snapshot,edits:[{oldText:"one",newText:"two"}]});assert.notEqual(edited.snapshot,created.snapshot);
  await assert.rejects(backend.invoke("file_batch",{operations:[{operation:"write",path:"kept",content:"kept"},{operation:"edit",path:"missing",snapshot:edited.snapshot,edits:[{oldText:"one",newText:"two"}]}]}),error=>{
    assert.ok(error instanceof WorkspaceOperationError);assert.equal(error.reply.items?.[0]?.status,"succeeded");assert.match(error.reply.items![0]!.snapshot!,/^[a-f0-9]{64}$/);assert.equal(error.reply.items?.[1]?.snapshot,undefined);return true;
  });
});
test("MXC backend retains failed publication verification and rejects a success carrying it",async t=>{
  const failed=fixture(t,reply=>{reply.ok=false;reply.phase="mutation";reply.noEffects=false;reply.error="publication observation failed";reply.snapshot=undefined;reply.requiresVerification=true;},"sandbox-write");
  await assert.rejects(failed.invoke("write",{path:"new",content:"written"}),error=>{
    assert.ok(error instanceof WorkspaceOperationError);assert.equal(error.reply.requiresVerification,true);return true;
  });
  const forged=fixture(t,reply=>{reply.requiresVerification=true;},"sandbox-write");
  await assert.rejects(forged.invoke("write",{path:"new",content:"written"}),/Invalid publication verification fact/);
});
for(const [name,change] of [["missing",(r:any)=>{r.snapshot=undefined;}],["malformed",(r:any)=>{r.snapshot="not-a-hash";}],["wrong-type",(r:any)=>{r.snapshot=42;}]] as const) test(`MXC backend rejects ${name} mutation snapshot`,async t=>{
  const backend=fixture(t,change,"sandbox-write");await assert.rejects(backend.invoke("write",{path:"new",content:"written"}),/Invalid mutation snapshot/);
});
for(const [name,change] of [["missing",(r:any)=>{r.items=undefined;}],["snapshot",(r:any)=>{r.items[0].snapshot="invalid";}],["index",(r:any)=>{r.items[0].index=1;}],["status",(r:any)=>{r.items[0].status="not_started";}]] as const) test(`MXC backend rejects ${name} batch continuation`,async t=>{
  const backend=fixture(t,change,"sandbox-write");await assert.rejects(backend.invoke("file_batch",{operations:[{operation:"write",path:"new",content:"written"}]}),/(?:Invalid|Inconsistent) (?:mutation|completed|incomplete)/);
});

test("MXC backend parses and retains valid read/search facts on the real run path", async t => {
  const backend = fixture(t);
  const read = await backend.invoke("read", { path: "text", limit: 1 });
  assert.equal(read.read!.windowComplete, true); assert.equal(read.read!.hasMore, true); assert.equal(read.read!.nextOffset, 2);
  const grep = await backend.invoke("grep", { pattern: "needle" }); assert.equal(grep.search!.coverageComplete, true);
  for (const outputMode of ["files", "count"]) assert.equal((await backend.invoke("grep", { pattern: "needle", outputMode })).search!.outputMode, outputMode);
  for (const offset of [Number.MAX_SAFE_INTEGER, Number.MAX_VALUE]) {
    const end = await backend.invoke("read", { path: "text", offset, limit: 1 });
    assert.equal(end.read!.offset, offset);
    assert.equal(end.read!.hasMore, false);
    assert.equal(end.read!.returnedLines, 0);
  }
  assert.equal((await backend.invoke("ls", {})).search!.operation, "ls");
});

const faults: [string, (reply: any) => void][] = [
  ["missing", r => { r.search = undefined; }], ["null", r => { r.search = null; }],
  ["version", r => { r.search.version = 2; }], ["operation", r => { r.search.operation = "read"; }],
  ["mode", r => { r.search.outputMode = "bogus"; }], ["enum", r => { r.search.stopReason = "timeout"; }],
  ["boolean", r => { r.search.scanComplete = "true"; }], ["negative", r => { r.search.scannedFiles = -1; }],
  ["fraction", r => { r.search.observedRecords = 0.5; }], ["unsafe", r => { r.search.excludedLinks = Number.MAX_SAFE_INTEGER + 1; }],
  ["entries", r => { r.search.visitedEntries = 20001; }], ["rows", r => { r.search.returnedRecords = 201; }],
  ["units", r => { r.search.outputUnits = 32769; }], ["inconsistent", r => { r.search.coverageComplete = false; }],
  ["unrelated read", r => { r.read = {}; }],
  ["unexpected field", r => { r.search.source = "not allowed"; }],
  ["impossible row stop", r => { r.search.stopReason = "row-limit"; r.search.scanComplete = false;
    r.search.coverageComplete = false; r.search.outputTruncated = true; r.search.observedRecords++; }],
];
for (const [name, change] of faults) test(`MXC backend rejects ${name} search metadata`, async t => {
  const backend = fixture(t, change);
  await assert.rejects(backend.invoke("grep", { pattern: "needle" }), /(?:Invalid|Inconsistent|Unexpected) (?:search|read) facts/);
  assert.equal(backend.diagnostics.pending, false);
});

for (const [name, change] of [
  ["missing", (r: any) => { r.read = undefined; }], ["boolean", (r: any) => { r.read.hasMore = 1; }],
  ["offset", (r: any) => { r.read.offset = -1; }], ["nextOffset", (r: any) => { r.read.nextOffset = 90; }],
  ["fraction", (r: any) => { r.read.returnedLines = 0.5; }],
  ["unrelated search", (r: any) => { r.search = {}; }],
  ["nonadvancing nextOffset", (r: any) => { r.read.returnedLines = 0; r.read.windowComplete = false; r.read.nextOffset = 1; }],
] as const) test(`MXC backend rejects ${name} read metadata`, async t => {
  const backend = fixture(t, change);
  await assert.rejects(backend.invoke("read", { path: "text", limit: 1 }), /(?:Invalid|Inconsistent|Unexpected) (?:search|read) facts/);
});

test("MXC backend keeps worker failure semantics before success-facts validation", async t => {
  const backend = fixture(t, r => { r.ok = false; r.phase = "read"; r.error = "fixture failure"; r.noEffects = true; r.search = undefined; });
  await assert.rejects(backend.invoke("grep", { pattern: "needle" }), (error: any) => {
    assert.ok(error instanceof WorkspaceOperationError); assert.equal(error.reply.noEffects, true); return true;
  });
});
