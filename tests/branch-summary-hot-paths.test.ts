import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import test from "node:test";
import ts from "typescript";

test("summary admission preserves one history preparation and serialization", () => {
  const source = ts.createSourceFile("summary.ts", readFileSync(new URL("../packages/coding-agent/src/core/compaction/branch-summarization.ts", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true);
  const fn = source.statements.find((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === "generateBranchSummary")!;
  const calls = new Map<string, number>(); let loops = 0;
  function walk(node: ts.Node) {
    if (ts.isCallExpression(node)) { const name = node.expression.getText(source); calls.set(name, (calls.get(name) ?? 0) + 1); }
    if (ts.isForStatement(node) || ts.isForOfStatement(node) || ts.isForInStatement(node) || ts.isWhileStatement(node)) loops++;
    ts.forEachChild(node, walk);
  }
  walk(fn);
  for (const name of ["prepareBranchEntries", "convertToLlm", "serializeConversation", "completeSummarization"]) assert.equal(calls.get(name), 1, name);
  assert.equal(loops, 0, "request admission must not add a second history traversal");
  assert.ok(fn.getText(source).indexOf("Number.isSafeInteger(maxTokens)") < fn.getText(source).indexOf("prepareBranchEntries("));
});

test("summary large-history counters and completion/abort/error ownership remain bounded", () => {
  const child = spawnSync(process.execPath, ["--expose-gc", "--experimental-strip-types", "scripts/bench/branch-summary.ts", "--smoke"], { cwd: new URL("../", import.meta.url), encoding: "utf8", timeout: 60000 });
  assert.equal(child.status, 0, child.stderr || child.stdout);
  const evidence = JSON.parse(child.stdout);
  assert.deepEqual(evidence.counters.map((row: any) => [row.size, row.requests, row.serializations, row.serializedMessages]), [[256, 1, 1, 256], [512, 1, 1, 512], [1024, 1, 1, 1024]]);
  assert.equal(evidence.lifecycle.length, 3);
  for (const row of evidence.lifecycle) { assert.equal(row.retainedRequestContexts, 0); assert.equal(row.retainedRequestOptions, 0); }
});
