import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

test("LSP traversal owns one reusable adapter scratch per directory, never per entry", () => {
  const source = ts.createSourceFile("files.ts", readFileSync(new URL("../packages/lsp/src/files.ts", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true);
  const collect = source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === "collectPath");
  assert.ok(collect?.body);
  let scratch, loopArrays = 0, clearCount = 0, finallyClear = false;
  function visit(node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(source) === "childCollections") scratch = node;
    if (ts.isArrayLiteralExpression(node)) {
      for (let parent = node.parent; parent && parent !== collect; parent = parent.parent) {
        if (ts.isForOfStatement(parent) || ts.isForStatement(parent) || ts.isWhileStatement(parent)) { loopArrays++; break; }
      }
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      node.left.getText(source) === "childCollections.length" && node.right.getText(source) === "0") {
      clearCount++;
      for (let parent = node.parent; parent && parent !== collect; parent = parent.parent) {
        if (ts.isBlock(parent) && ts.isTryStatement(parent.parent) && parent.parent.finallyBlock === parent) finallyClear = true;
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(collect);
  assert.ok(scratch && ts.isArrayLiteralExpression(scratch.initializer));
  assert.ok(scratch.parent.parent.parent === collect.body, "scratch must be directory-call owned");
  assert.equal(loopArrays, 0, "no per-entry adapter arrays");
  assert.ok(clearCount >= 2 && finallyClear, "reuse and exceptional exits must release scratch references");
});
