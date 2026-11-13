import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { mxcFileFixture } from "./helpers/mxc-file-fixture.ts";
import { MXC_FILE_RUNTIME_ASSETS, MXC_FILE_WORKER_PATH } from "../packages/coding-agent/src/core/files/file-runtime-assets.mjs";

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
