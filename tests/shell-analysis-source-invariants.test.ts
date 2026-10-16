import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

test("authorization scanners and cache methods add no callbacks, promises or temporary byte buffers", () => {
  const targets = new Map([
    ["shell-analysis.ts", new Set(["analyzeShellSource", "get", "assertCurrent", "release"])],
    ["shell-substitution.ts", new Set(["prepareShellAnalysis", "extractCommandSubstitutions", "commandSubstitutionEnd"])],
    ["core.ts", new Set(["inspectBashResourceLifecycle", "inspectLifecycleScript", "inspectHighRiskBashMutation", "inspectShellScript", "heredocConsumer", "heredocHasUntrackedCwd", "addMutationPrimitive"])],
    ["permission-bash.ts", new Set(["inspectScript", "inspectBashPermissionScope", "inspectKnownMutation", "markMutation"])],
  ]);
  for (const [file, names] of targets) {
    const source = ts.createSourceFile(file, readFileSync(`packages/extensions/resource-lifecycle-guard/${file}`, "utf8"), ts.ScriptTarget.Latest, true);
    const seen = new Set<string>();
    function audit(node: ts.Node): void {
      assert.equal(ts.isArrowFunction(node) || ts.isFunctionExpression(node) || ts.isFunctionDeclaration(node) || ts.isAwaitExpression(node), false, node.getText(source));
      if (ts.isNewExpression(node)) assert.ok(!["Promise", "AbortController", "Buffer"].includes(node.expression.getText(source)));
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
        assert.ok(!["then", "catch", "finally", "bind", "map", "filter", "flatMap"].includes(node.expression.name.text));
        assert.notEqual(node.expression.getText(source), "Buffer.from");
      }
      ts.forEachChild(node, audit);
    }
    function visit(node: ts.Node): void {
      if ((ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) && node.name && names.has(node.name.getText(source)) && node.body) {
        seen.add(node.name.getText(source)); ts.forEachChild(node.body, audit);
      } else ts.forEachChild(node, visit);
    }
    visit(source);
    assert.deepEqual(seen, names, file);
  }
});
