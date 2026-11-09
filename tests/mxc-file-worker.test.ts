import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import test from "node:test";
import { mxcFileFixture } from "./helpers/mxc-file-fixture.ts";

test("MXC files update the workspace, retain dependencies and reject stale snapshots", t => {
  const f = mxcFileFixture(t);
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

test("MXC native tools refuse protected mutations, readonly writes and invalid UTF-8 edits", t => {
  const f = mxcFileFixture(t);
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

test("MXC atomic replacement leaves the original intact on temporary write failure", t => {
  const f = mxcFileFixture(t), file = path.join(f.input, "source.txt"); fs.writeFileSync(file, "original");
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
  const io = Object.create(fs); io.readdirSync = (name: string, ...args: any[]) => {
    assert.notEqual(name, path.join(f.input, "unrelated")); return (fs.readdirSync as any)(name, ...args);
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
  assert.ok(reply.text.startsWith(scope));
});
