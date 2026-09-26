import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

test("shell data/progress/drain callbacks create no callback or Promise on delivery", () => {
  const targets = new Set(["onError", "onClose", "onIdle", "armIdleTimer", "onData", "onStdoutEnd", "onStderrEnd", "onSpawn", "onExit", "maybeFinalizeAfterExit", "finalize", "cleanup",
    "recordOutputFailure", "emitOutputUpdate", "clearUpdateTimer", "onUpdateTimer", "scheduleOutputUpdate", "handleData"]);
  const seen = new Set<string>();
  for (const file of ["packages/coding-agent/src/core/tools/bash.ts", "packages/coding-agent/src/utils/child-process.ts"]) {
    const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
    function audit(node: ts.Node): void {
      assert.equal(ts.isArrowFunction(node) || ts.isFunctionExpression(node) || ts.isFunctionDeclaration(node), false, `per-delivery callback: ${node.getText(source)}`);
      if (ts.isNewExpression(node)) assert.notEqual(node.expression.getText(source), "Promise");
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) assert.ok(!["then", "catch", "finally", "bind", "map", "filter"].includes(node.expression.name.text));
      ts.forEachChild(node, audit);
    }
    function visit(node: ts.Node): void {
      if ((ts.isVariableDeclaration(node) || ts.isPropertyDeclaration(node)) && targets.has(node.name.getText(source)) && node.initializer && ts.isArrowFunction(node.initializer)) {
        seen.add(node.name.getText(source)); audit(node.initializer.body);
        // Exact startup owners, never a file-wide exemption for nested closures.
        let owner: ts.Node | undefined = node.parent;
        while (owner && !ts.isFunctionDeclaration(owner) && !ts.isClassDeclaration(owner)) owner = owner.parent;
        assert.ok(owner && (ts.isFunctionDeclaration(owner) || ts.isClassDeclaration(owner)));
        assert.ok(["ShellInputObserver", "createLocalShellOperations", "createShellToolDefinition", "waitForChildProcess"].includes(owner.name?.getText(source) ?? ""));
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
  }
  assert.deepEqual(seen, targets);
});
