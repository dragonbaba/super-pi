import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { WorkspaceSandboxBackend, WorkspaceOperationError } from "../packages/coding-agent/src/core/sandbox/workspace-backend.ts";
import { mxcFileFixture } from "./helpers/mxc-file-fixture.ts";

// Mock only native launch/policy. invoke(), run(), JSON parsing and validation
// execute unchanged, unlike the higher-level fixture's attach() seam.
function fixture(t: TestContext, change: (reply: any) => void = () => {}) {
  const f = mxcFileFixture(t), backend = new WorkspaceSandboxBackend(f.input, f.root, "read-only"), internal = backend as any;
  fs.writeFileSync(path.join(f.input, "text"), "needle\nlast");
  const stat = fs.lstatSync(f.runtime, { bigint: true }), workspace = fs.lstatSync(f.input, { bigint: true });
  internal.root = f.runtime; internal.identity = stat.dev + ":" + stat.ino; internal.tools = f.runtime;
  internal.exchange = f.exchange; internal.starts = 1; internal.environment = {};
  internal.roots.push(f.input); internal.identities.push(workspace.dev + ":" + workspace.ino);
  t.mock.method(internal, "policy", async () => "fixture policy");
  t.mock.method(internal.runner, "run", async () => {
    const request = JSON.parse(fs.readFileSync(path.join(f.runtime, "request.json"), "utf8"));
    const reply = f.invoke(request.operation, request.input); reply.id = request.id; change(reply);
    return { code: reply.ok ? 0 : 1, stdout: JSON.stringify(reply) + "\n", stderr: "", timedOut: false, truncated: false };
  });
  f.cleanupWith(() => backend.close());
  return backend;
}

test("MXC backend parses and retains valid read/search facts on the real run path", async t => {
  const backend = fixture(t);
  const read = await backend.invoke("read", { path: "text", limit: 1 });
  assert.equal(read.read!.windowComplete, true); assert.equal(read.read!.hasMore, true); assert.equal(read.read!.nextOffset, 2);
  const grep = await backend.invoke("grep", { pattern: "needle" }); assert.equal(grep.search!.coverageComplete, true);
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
  ["mode", r => { r.search.outputMode = "files"; }], ["enum", r => { r.search.stopReason = "timeout"; }],
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
