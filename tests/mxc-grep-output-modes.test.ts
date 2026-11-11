import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { mxcFileFixture } from "./helpers/mxc-file-fixture.ts";
import { WorkspaceSandboxTools } from "../packages/coding-agent/src/core/sandbox/workspace-tools.ts";
import { SessionExecutionBoundary } from "../packages/coding-agent/src/core/execution-boundary.ts";

const modes = ["content", "files", "count"] as const;

test("MXC projections agree on a complete corpus; counts measure lines, not occurrences", t => {
  const f = mxcFileFixture(t), expected = new Map([["中文 file.txt", 2], ["other.txt", 1]]);
  fs.writeFileSync(path.join(f.input, "中文 file.txt"), "hit hit hit\nplain\nhit\n");
  fs.writeFileSync(path.join(f.input, "other.txt"), "plain\nhit"); fs.writeFileSync(path.join(f.input, "absent"), "plain");
  for (const mode of modes) {
    const r = f.invoke("grep", { pattern: "hit", outputMode: mode });
    assert.equal(r.ok, true); assert.equal(r.search.scanComplete, true); assert.equal(r.search.coverageComplete, true);
    assert.equal(r.search.outputMode, mode); assert.equal(r.search.excerptTruncated, false);
    const rows: string[] = r.text.split("\n"), files = rows.map(row => mode === "files" ? row : row.slice(0, row.indexOf(":")));
    assert.deepEqual(new Set(files), new Set(expected.keys()));
    if (mode !== "content") assert.equal(rows.length, expected.size);
    if (mode === "count") for (const row of rows) { const [name, count] = row.split(":"); assert.equal(Number(count), expected.get(name!)); }
    assert.equal(r.search.returnedRecords, mode === "content" ? 3 : 2);
  }
  assert.equal(f.invoke("grep", { pattern: "hit" }).text, f.invoke("grep", { pattern: "hit", outputMode: "content" }).text);
});

test("MXC projections preserve literal metacharacters and legacy line starts", t => {
  const f = mxcFileFixture(t);
  fs.writeFileSync(path.join(f.input, "text"), "[a].* [a].*\r\nnext\n[a].*\r\nnext");
  fs.writeFileSync(path.join(f.input, "absent"), "a\n");
  for (const outputMode of modes) {
    for (const pattern of ["[a].*", "[a].*\r\nnext"]) {
      const result = f.invoke("grep", { pattern, outputMode });
      assert.equal(result.search.coverageComplete, true);
      if (outputMode === "files") assert.equal(result.text, "text");
      if (outputMode === "count") assert.equal(result.text, "text:2");
      if (outputMode === "content") assert.deepEqual(result.text.split("\n"), ["text:1:[a].* [a].*\r", "text:3:[a].*\r"]);
    }
    const newline = f.invoke("grep", { pattern: "\nnext", outputMode });
    assert.equal(newline.search.coverageComplete, true);
    assert.equal(newline.text, "(no matches)");
  }
});

test("MXC files/count fully validate suffix bytes before considering a prefix match", t => {
  const f = mxcFileFixture(t);
  fs.writeFileSync(path.join(f.input, "invalid"), Buffer.concat([Buffer.from("hit\n"), Buffer.from([255])]));
  fs.writeFileSync(path.join(f.input, "nul"), "hit\nrest\0");
  for (const outputMode of modes) {
    const r = f.invoke("grep", { pattern: "hit", outputMode });
    assert.equal(r.search.skippedNonUtf8, 1); assert.equal(r.search.skippedNul, 1); assert.equal(r.search.returnedRecords, 0);
    assert.equal(r.search.scanComplete, true); assert.equal(r.search.coverageComplete, false);
  }
});

test("MXC files/count use file-record budgets rather than the content preview budget", t => {
  const f = mxcFileFixture(t); fs.writeFileSync(path.join(f.input, "many"), "hit hit\n".repeat(501));
  fs.writeFileSync(path.join(f.input, "second"), "hit");
  const content = f.invoke("grep", { path: "many", pattern: "hit" }); assert.equal(content.search.returnedRecords, 200); assert.equal(content.search.scanComplete, false);
  for (const mode of ["files", "count"] as const) {
    const r = f.invoke("grep", { pattern: "hit", outputMode: mode }); assert.equal(r.search.scanComplete, true);
    assert.equal(r.search.returnedRecords, 2); assert.equal(r.search.observedRecords, 2);
    assert.deepEqual(new Set(r.text.split("\n")), new Set(mode === "files" ? ["many", "second"] : ["many:501", "second:1"]));
  }
});

for (const outputMode of ["files", "count"] as const) test(`MXC ${outputMode} distinguishes 200 complete files from a rejected 201st record`, t => {
  const f = mxcFileFixture(t);
  for (let i = 0; i < 200; i++) fs.writeFileSync(path.join(f.input, i + ".txt"), "hit hit\nhit");
  const exact = f.invoke("grep", { pattern: "hit", outputMode }); assert.equal(exact.search.scanComplete, true); assert.equal(exact.search.returnedRecords, 200);
  fs.writeFileSync(path.join(f.input, "extra"), "hit\nhit\nhit");
  const limited = f.invoke("grep", { pattern: "hit", outputMode }); assert.equal(limited.search.scanComplete, false);
  assert.equal(limited.search.outputTruncated, true); assert.equal(limited.search.stopReason, "row-limit"); assert.equal(limited.search.observedRecords, 201);
  if (outputMode === "count") for (const row of limited.text.split("\n").slice(1)) {
    const [name, count] = row.split(":"); assert.equal(Number(count), name === "extra" ? 3 : 2);
  }
});

for (const outputMode of modes) test(`MXC ${outputMode} keeps long-path JSON bounded and reports text stops`, t => {
  const f = mxcFileFixture(t), scope = path.join("中".repeat(70), "文".repeat(70), "😀".repeat(35));
  fs.mkdirSync(path.join(f.input, scope), { recursive: true });
  for (let i = 0; i < 200; i++) fs.writeFileSync(path.join(f.input, scope, i + ".txt"), "hit\n");
  const r = f.invoke("grep", { path: scope, pattern: "hit", outputMode }); assert.equal(r.ok, true);
  assert.equal(r.search.stopReason, "text-limit"); assert.equal(r.search.outputTruncated, true);
  assert.ok(Buffer.byteLength(JSON.stringify(r)) + 1 <= 256 * 1024); assert.equal(r.text.isWellFormed(), true);
});

test("MXC rejects unknown raw output modes and exposes the option only on grep", async t => {
  const f = mxcFileFixture(t);
  for (const outputMode of ["unknown", "files_with_matches", "", null, 0]) {
    const r = f.invoke("grep", { pattern: "hit", outputMode }); assert.equal(r.ok, false); assert.equal(r.phase, "read"); assert.match(r.error, /Unknown grep outputMode/);
  }
  const boundary = new SessionExecutionBoundary(), runtime: any = { executionBoundary: boundary };
  const owner = new WorkspaceSandboxTools(f.input, f.root, "read-only", () => runtime);
  t.after(async () => { await owner.close(); await boundary.dispose(); });
  assert.ok((owner.definition("grep")!.parameters as any).properties.outputMode);
  for (const name of ["read", "find", "ls"]) assert.equal((owner.definition(name)!.parameters as any).properties.outputMode, undefined);
});
