import assert from "node:assert/strict";
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import test from "node:test";
import ts from "typescript";

test("image sniffing and guest artifact transport add no per-byte callbacks, regexes or arrays", () => {
  for (const [file, names] of [
    ["packages/coding-agent/src/utils/image-signature.mjs", undefined],
    ["packages/coding-agent/src/core/sandbox/mxc-file-worker.mjs", ["read", "readHandle"]],
  ] as const) {
    const source = ts.createSourceFile(file, fs.readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
    for (const node of source.statements) if (ts.isFunctionDeclaration(node) && (!names || (names as readonly string[]).includes(node.name!.text))) {
      function inspect(child: ts.Node): void {
        assert.equal(ts.isArrowFunction(child) || ts.isFunctionExpression(child) || ts.isRegularExpressionLiteral(child) || ts.isArrayLiteralExpression(child), false, child.getText(source));
        ts.forEachChild(child, inspect);
      }
      inspect(node.body!);
    }
  }
});

test("image attachment allocation has one exact payload buffer and releases bytes and disk artifacts", () => {
  const child = spawnSync(process.execPath, ["--expose-gc", "--experimental-strip-types", "scripts/bench/sandbox-image-read.ts"], { encoding: "utf8", timeout: 60000 });
  assert.equal(child.status, 0, child.stderr || child.stdout);
  const evidence = JSON.parse(child.stdout); assert.equal(evidence.payloadAllocations, 24);
  assert.equal(evidence.retainedPayloadsAfterFourGC, 0); assert.equal(evidence.attachmentsRemaining, 0);
});
