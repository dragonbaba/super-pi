import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

test("native output creation is confined to first-spill setup, never delivery or writing", () => {
  const file = "packages/coding-agent/src/core/tools/output-accumulator.ts";
  const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
  let creates = 0, guards = 0;
  function visit(node: ts.Node, owner = "") {
    if (ts.isMethodDeclaration(node)) owner = node.name.getText(source);
    if (ts.isCallExpression(node) && node.expression.getText(source) === "privateOutputFileSystem.openSync") {
      assert.equal(owner, "ensureTempFile"); creates++;
    }
    if (ts.isMethodDeclaration(node) && owner === "ensureTempFile") {
      const first = node.body!.statements[0];
      assert.ok(ts.isIfStatement(first));
      assert.equal(first.expression.getText(source), "this.tempFilePath");
      assert.ok(ts.isBlock(first.thenStatement) && ts.isReturnStatement(first.thenStatement.statements[0]));
      guards++;
    }
    ts.forEachChild(node, child => visit(child, owner));
  }
  visit(source); assert.equal(creates, 2); assert.equal(guards, 1);
});

test("private stream adapter and native opener introduce no async work, IPC or dynamic write callbacks", () => {
  for (const file of ["packages/coding-agent/src/utils/private-output-file.ts", "packages/coding-agent/src/utils/windows-private-output.ts"]) {
    const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
    function visit(node: ts.Node) {
      assert.ok(!ts.isAwaitExpression(node));
      if (ts.isNewExpression(node)) assert.ok(!["Promise", "AbortController", "Worker"].includes(node.expression.getText(source)));
      if (ts.isCallExpression(node)) assert.ok(!/(?:\.then|\.catch|postMessage|spawn|execFile|setTimeout)$/.test(node.expression.getText(source)));
      ts.forEachChild(node, visit);
    }
    visit(source);
  }
  const adapter = readFileSync("packages/coding-agent/src/utils/private-output-file.ts", "utf8");
  assert.ok(adapter.includes("fs: { open: openPrivateStream, write, writev, close }"), "writes must remain direct Node functions");
});
