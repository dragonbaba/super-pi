import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

test("N4 explicit budget helpers and request bridge create no callbacks or regexes", () => {
  for (const patternFile of ["packages/coding-agent/src/core/tool-result-budget-regex.ts", "packages/coding-agent/src/core/agent-session-regex.ts"]) {
  const patterns = ts.createSourceFile(patternFile, readFileSync(patternFile, "utf8"), ts.ScriptTarget.Latest, true);
  let patternCount = 0;
  function pattern(node: ts.Node): void {
    if (ts.isRegularExpressionLiteral(node)) {
      assert.ok(ts.isVariableDeclaration(node.parent));
      const list = node.parent.parent;
      assert.ok(ts.isVariableDeclarationList(list) && list.flags & ts.NodeFlags.Const);
      assert.ok(ts.isVariableStatement(list.parent) && ts.isSourceFile(list.parent.parent)); patternCount++;
    }
    ts.forEachChild(node, pattern);
  }
  pattern(patterns); assert.equal(patternCount, patternFile.endsWith("agent-session-regex.ts") ? 7 : 1);
  }
  const targets = [
    { file: "packages/coding-agent/src/core/tool-result-budget-status.ts", names: [] },
    { file: "packages/coding-agent/src/core/agent-session.ts", names: ["configureToolResultBudget", "getToolResultBudgetStatus", "projectToolResultMessagesForModel", "_captureBudgetProjectionSources", "recordToolResultBudgetDispatch", "discardPendingToolResultBudgetSources"] },
    { file: "packages/coding-agent/src/modes/interactive/interactive-mode.ts", names: ["handleToolResultBudgetCommand", "rediscoverToolResultsAfterBudgetChange"] },
    { file: "packages/coding-agent/src/modes/interactive/components/tool-execution.ts", names: ["hasToolResultSourceForUi", "hasToolResultSourceForUi"] },
  ];
  for (const target of targets) {
    const source = ts.createSourceFile(target.file, readFileSync(target.file, "utf8"), ts.ScriptTarget.Latest, true);
    function inspect(node: ts.Node): void {
      assert.equal(ts.isArrowFunction(node) || ts.isFunctionExpression(node) || ts.isRegularExpressionLiteral(node), false, `${target.file}: ${node.getText(source)}`);
      if (ts.isNewExpression(node)) assert.notEqual(node.expression.getText(source), "RegExp");
      ts.forEachChild(node, inspect);
    }
    if (!target.names.length) inspect(source);
    else {
      const seen: string[] = [];
      function visit(node: ts.Node): void {
        if (ts.isMethodDeclaration(node) && target.names.includes(node.name.getText(source))) {
          seen.push(node.name.getText(source)); inspect(node.body!);
          if (node.name.getText(source) === "rediscoverToolResultsAfterBudgetChange") assert.equal(node.body!.getText(source).includes("getToolResultBudgetStatus"), false);
        }
        ts.forEachChild(node, visit);
      }
      visit(source); assert.deepEqual(seen.sort(), [...target.names].sort());
    }
  }
  const file = "packages/coding-agent/src/modes/interactive/interactive-mode.ts", source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
  let callbacks = 0;
  function visit(node: ts.Node): void {
    if (ts.isPropertyDeclaration(node) && node.name.getText(source) === "onToolResultBudgetSettingChange") {
      assert.ok(node.initializer && ts.isArrowFunction(node.initializer));
      function noNested(part: ts.Node): void { assert.equal(ts.isArrowFunction(part) || ts.isFunctionExpression(part), false); ts.forEachChild(part, noNested); }
      noNested(node.initializer.body); callbacks++;
    }
    ts.forEachChild(node, visit);
  }
  visit(source); assert.equal(callbacks, 1, "one explicit settings callback per InteractiveMode owner");
});
