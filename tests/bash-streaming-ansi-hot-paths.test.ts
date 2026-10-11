import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

test("streaming ANSI delivery and sanitizer allocate no callbacks, containers, promises or regexes", () => {
  const seen = new Set<string>();
  for (const [file, names] of [
    ["packages/coding-agent/src/utils/ansi.ts", ["write", "reset"]],
    ["packages/coding-agent/src/utils/shell.ts", ["sanitizeBinaryOutput"]],
    ["packages/coding-agent/src/core/bash-executor.ts", ["onData", "appendText"]],
    ["packages/coding-agent/src/core/tools/bash.ts", ["onStdoutData", "onStderrData"]],
  ] as const) {
    const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
    function audit(node: ts.Node): void {
      assert.ok(!ts.isArrowFunction(node) && !ts.isFunctionExpression(node) && !ts.isFunctionDeclaration(node)
        && !ts.isObjectLiteralExpression(node) && !ts.isArrayLiteralExpression(node) && !ts.isNewExpression(node)
        && !ts.isRegularExpressionLiteral(node) && !ts.isAwaitExpression(node), node.getText(source));
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
        assert.ok(!["map", "filter", "split", "then", "catch", "finally", "bind", "from"].includes(node.expression.name.text));
      }
      ts.forEachChild(node, audit);
    }
    function visit(node: ts.Node): void {
      if ((ts.isMethodDeclaration(node) || ts.isFunctionDeclaration(node)) && node.name && (names as readonly string[]).includes(node.name.getText(source))) {
        seen.add(node.name.getText(source)); audit(node.body!);
      }
      if (ts.isVariableDeclaration(node) && (names as readonly string[]).includes(node.name.getText(source)) && node.initializer && ts.isArrowFunction(node.initializer)) {
        seen.add(node.name.getText(source)); audit(node.initializer.body);
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
    if (file.endsWith("ansi.ts")) {
      const parser = source.statements.find(node => ts.isClassDeclaration(node) && node.name?.text === "AnsiStreamFilter") as ts.ClassDeclaration;
      const slots = parser.members.filter(ts.isPropertyDeclaration);
      assert.equal(slots.length, 1); assert.equal(slots[0].name.getText(source), "state");
    }
  }
  assert.deepEqual([...seen].sort(), ["appendText", "onData", "onStderrData", "onStdoutData", "reset", "sanitizeBinaryOutput", "write"]);
});

test("local stdout/stderr callbacks have matching listener ownership", () => {
  const source = readFileSync("packages/coding-agent/src/core/tools/bash.ts", "utf8");
  for (const [stream, callback] of [["stdout", "onStdoutData"], ["stderr", "onStderrData"]]) {
    assert.ok(source.includes(`child.${stream}?.on("data", ${callback})`));
    assert.ok(source.includes(`child.${stream}?.removeListener("data", ${callback})`));
    assert.ok(source.includes(`const ${callback} = (data: Buffer) => { onData(data, "${stream}"); };`));
  }
});
