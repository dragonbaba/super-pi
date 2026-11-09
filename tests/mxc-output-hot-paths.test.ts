import assert from "node:assert/strict";
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import test from "node:test";
import ts from "typescript";

test("MXC output delivery allocates no callbacks, promises, wrappers or arrays", () => {
  const file = "packages/coding-agent/src/core/sandbox/mxc-process.ts";
  const source = ts.createSourceFile(file, fs.readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
  let checked = 0;
  function inspect(node: ts.Node): void {
    assert.equal(ts.isArrowFunction(node) || ts.isFunctionExpression(node) || ts.isNewExpression(node)
      || ts.isArrayLiteralExpression(node) || ts.isObjectLiteralExpression(node) || ts.isRegularExpressionLiteral(node), false, node.getText(source));
    ts.forEachChild(node, inspect);
  }
  for (const declaration of source.statements) if (ts.isClassDeclaration(declaration)) {
    for (const member of declaration.members) {
      if (ts.isMethodDeclaration(member) && member.name.getText(source) === "append") { inspect(member.body!); checked++; }
      if (ts.isPropertyDeclaration(member) && ["onStdout", "onStderr"].includes(member.name.getText(source))) {
        assert.ok(member.initializer && ts.isArrowFunction(member.initializer)); inspect(member.initializer.body); checked++;
      }
    }
  }
  assert.equal(checked, 3);
});

test("MXC large output stays bounded and releases owners and chunks", () => {
  const result = spawnSync(process.execPath, ["--expose-gc", "--experimental-strip-types", "scripts/bench/mxc-output.ts"], { encoding: "utf8", timeout: 30000 });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const evidence = JSON.parse(result.stdout);
  assert.equal(evidence.inputChunks, 16384); assert.equal(evidence.retainedOutputBytes, 32768);
  assert.equal(evidence.promisesDuringDelivery, 0); assert.equal(evidence.payloadBufferAllocationsDuringDelivery, 0);
  assert.equal(evidence.bufferViewsDuringDelivery, 0); assert.equal(evidence.stringMaterializationsDuringDelivery, 0);
  assert.equal(evidence.remainingDataListeners, 0); assert.equal(evidence.retainedOwnerAfterFourGC, 0); assert.equal(evidence.retainedInputAfterFourGC, 0);
});
