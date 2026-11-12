import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import ts from "typescript";

test("native v3 executor callbacks are created once outside the target loop", () => {
  const source = ts.createSourceFile("file-service.ts", readFileSync("packages/coding-agent/src/core/files/file-service.ts", "utf8"), ts.ScriptTarget.Latest, true);
  const owner = source.statements.find(node => ts.isClassDeclaration(node) && node.name?.text === "FileService") as ts.ClassDeclaration;
  const method = owner.members.find(node => node.name?.getText(source) === "withPreparedItems") as ts.MethodDeclaration;
  let constructors = 0;
  function visit(node: ts.Node): void {
    if (ts.isNewExpression(node) && node.expression.getText(source) === "FileExecution") {
      constructors++; let parent: ts.Node | undefined = node.parent;
      while (parent && parent !== method) { assert(!ts.isArrowFunction(parent) && !ts.isForOfStatement(parent) && !ts.isForStatement(parent)); parent = parent.parent; }
    }
    ts.forEachChild(node, visit);
  }
  visit(method); assert.equal(constructors, 1);
  const mutation = ts.createSourceFile("file-mutation.ts", readFileSync("packages/coding-agent/src/core/files/file-mutation.ts", "utf8"), ts.ScriptTarget.Latest, true);
  const execution = mutation.statements.find(node => ts.isClassDeclaration(node) && node.name?.text === "FileMutationExecution") as ts.ClassDeclaration;
  function noCallbacks(node: ts.Node): void {
    assert(!ts.isArrowFunction(node) && !ts.isFunctionExpression(node), "Per-target processing must reuse invocation callbacks");
    if (ts.isNewExpression(node)) assert(!["Promise", "AbortController"].includes(node.expression.getText(mutation)));
    ts.forEachChild(node, noCallbacks);
  }
  for (const name of ["run", "preparation", "remember"]) {
    const member = execution.members.find(node => node.name?.getText(mutation) === name)!;
    const body = ts.isMethodDeclaration(member) ? member.body! : (member as ts.PropertyDeclaration).initializer as ts.ArrowFunction;
    noCallbacks(ts.isArrowFunction(body) ? body.body : body);
  }
});
