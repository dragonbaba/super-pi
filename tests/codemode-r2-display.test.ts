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
