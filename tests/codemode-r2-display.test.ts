import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import { codemodeFailureReason, codemodeFailureWindow } from "../packages/coding-agent/src/core/codemode-display.ts";

test("R2.1 diagnostic scan preserves the tail of a 10 MiB line within a fixed window", () => {
  const text = "ffmpeg fixture\n" + "x".repeat(10 * 1024 * 1024) + "\nNo such filter: 'volumedetect'\nCommand exited with code 1";
  assert.ok(codemodeFailureWindow(text).length <= 2048);
  assert.match(codemodeFailureReason(text, "model"), /No such filter/);
  assert.match(codemodeFailureReason(text), /No such filter/);
  assert.doesNotMatch(codemodeFailureWindow("🙂".repeat(3000)), /\ud800(?![\udc00-\udfff])/);
});

test("R2.3 ordinary show has no Promise, callback or asynchronous factory", () => {
  const source = ts.createSourceFile("codemode.ts", readFileSync("packages/coding-agent/src/core/codemode.ts", "utf8"), ts.ScriptTarget.Latest, true);
  const expected = new Set(["show", "appendShown"]), found = new Set<string>();
  function audit(node: ts.Node): void {
    assert.equal(ts.isAwaitExpression(node) || ts.isArrowFunction(node) || ts.isFunctionExpression(node), false, node.getText(source));
    // Exact cold-error exemption: an invalid/expired ref throws before output processing.
    if (ts.isNewExpression(node)) {
      assert.equal(node.expression.getText(source), "Error");
      assert.ok(ts.isThrowStatement(node.parent));
      assert.equal(node.arguments?.[0]?.getText(source), '"Unknown or expired result reference; references belong to the current script"');
    }
    ts.forEachChild(node, audit);
  }
  for (const statement of source.statements) if (ts.isClassDeclaration(statement)) for (const member of statement.members) {
    if (!ts.isMethodDeclaration(member) || !expected.has(member.name.getText(source))) continue;
    assert.equal(member.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.AsyncKeyword) ?? false, false);
    found.add(member.name.getText(source)); audit(member.body!);
  }
  assert.deepEqual(found, expected);
});

test("R2.1 bounded diagnostic helper has no hot factories or temporary containers", () => {
  const source = ts.createSourceFile("display.ts", readFileSync("packages/coding-agent/src/core/codemode-display.ts", "utf8"), ts.ScriptTarget.Latest, true);
  let found = 0;
  function audit(node: ts.Node): void {
    assert.equal(ts.isArrowFunction(node) || ts.isFunctionExpression(node) || ts.isNewExpression(node)
      || ts.isObjectLiteralExpression(node) || ts.isArrayLiteralExpression(node), false, node.getText(source));
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      assert.equal(["map", "filter", "flatMap", "split", "then", "catch", "finally"].includes(node.expression.name.text), false);
    }
    ts.forEachChild(node, audit);
  }
  for (const statement of source.statements) if (ts.isFunctionDeclaration(statement) && statement.name?.text === "codemodeFailureWindow") {
    found++; audit(statement.body!);
  }
  assert.equal(found, 1);
});
