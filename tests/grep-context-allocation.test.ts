import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import ts from "typescript";
import { createOwnedTaskFixture } from "./helpers/owned-task-fixture.ts";

for (const [phase, rows, context] of [["counts", "4096", "1"], ["counts", "65536", "1"], ["counts", "65536", "65537"], ["lifecycle", "65536", "1"]]) {
  test(`grep context bounded storage and release: ${phase}/${rows}/${context}`, t => {
    const owned = createOwnedTaskFixture("h08-grep-gate-"); t.after(owned.cleanup);
    const startedAt = new Date().toISOString();
    const child = spawnSync(process.execPath, ["--expose-gc", "--experimental-strip-types", fileURLToPath(new URL("../scripts/bench/grep-context.ts", import.meta.url)), phase!, rows!, context!], {
      cwd: fileURLToPath(new URL("../", import.meta.url)), encoding: "utf8", timeout: 30000, killSignal: "SIGKILL", maxBuffer: 1024 * 1024,
      env: { ...process.env, TMP: owned.root, TEMP: owned.root, TMPDIR: owned.root },
    });
    writeFileSync(join(owned.root, "resources.json"), JSON.stringify({ root: owned.root, createdSharedParent: owned.createdSharedParent, childPid: child.pid, startedAt, code: child.status, purpose: phase }));
    assert.ifError(child.error); assert.equal(child.status, 0, child.stderr + child.stdout);
    const report = JSON.parse(child.stdout.trim().split("\n")[1]!);
    if (phase === "counts") {
      assert.equal(report.reads, 0); assert.equal(report.readBytes, 0); assert.equal(report.wholeFileSplits, 0); assert.equal(report.splitLines, 0);
      if (context === "1") { assert.equal(report.jsonRecords, 6); assert.equal(report.retainedRows, 3); assert.ok(report.retainedBytes <= 80); }
      else { assert.equal(report.jsonRecords, 65542); assert.ok(report.retainedRows < 400); assert.ok(report.retainedBytes > 51200 && report.retainedBytes < 51400); }
    } else {
      assert.equal(report.weakRefs, 8); assert.equal(report.retained, 0); assert.equal(report.childrenAlive, 4); assert.equal(report.signalsAlive, 4);
      assert.equal(report.faultsAfterMatch, 2);
      assert.equal(report.childPipesDestroyed, true); assert.deepEqual(report.listeners, [0, 0, 0, 0]);
    }
    t.diagnostic(JSON.stringify(report));
  });
}

test("grep context callbacks use owner state without per-record closures or async wrappers", () => {
  const file = ts.createSourceFile("grep.ts", readFileSync(new URL("../packages/coding-agent/src/core/tools/grep.ts", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true);
  const selected: ts.Node[] = [];
  function locate(node: ts.Node): void {
    if (ts.isVariableDeclaration(node) && node.name.getText(file) === "onLine") {
      assert.ok(node.initializer && ts.isArrowFunction(node.initializer)); selected.push(node.initializer.body);
    }
    if (ts.isClassDeclaration(node) && node.name?.text === "GrepContextBuffer") {
      for (const member of node.members) if (ts.isMethodDeclaration(member)) selected.push(member.body!);
    }
    if (ts.isFunctionDeclaration(node) && ["decodeRipgrepText"].includes(node.name?.text ?? "")) selected.push(node.body!);
    ts.forEachChild(node, locate);
  }
  locate(file); assert.equal(selected.length, 5);
  const violations: string[] = []; let matchRecords = 0;
  function visit(node: ts.Node): void {
    if (ts.isArrowFunction(node) || ts.isFunctionExpression(node) || ts.isAwaitExpression(node) || ts.isNewExpression(node) || ts.isArrayLiteralExpression(node) || ts.isSpreadAssignment(node) || ts.isSpreadElement(node) || node.kind === ts.SyntaxKind.RegularExpressionLiteral) violations.push(node.getText(file));
    if (ts.isObjectLiteralExpression(node)) {
      assert.deepEqual(node.properties.map(property => property.name?.getText(file)), ["filePath", "displayPath", "lineNumber", "lineText"]);
      matchRecords++;
    }
    ts.forEachChild(node, visit);
  }
  for (const body of selected) visit(body);
  assert.deepEqual(violations, []); assert.equal(matchRecords, 1, "existing accepted-match metadata only; no per-context wrapper");
});
