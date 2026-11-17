import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import ts from "typescript";
import { createOwnedTaskFixture } from "./helpers/owned-task-fixture.ts";

const MATERIALIZING_CALL = /\.map$|\.filter$|\.reduce$|\.sort$|JSON\.stringify$/;

test("compaction epoch lookup adds no callbacks, promises, controllers or history materialization", () => {
  const source = ts.createSourceFile("agent-session.ts", readFileSync(new URL("../packages/coding-agent/src/core/agent-session.ts", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true);
  function visit(node: ts.Node): void {
    assert.ok(!ts.isArrowFunction(node) && !ts.isFunctionExpression(node) && !ts.isNewExpression(node));
    assert.ok(!ts.isArrayLiteralExpression(node));
    if (ts.isCallExpression(node)) assert.ok(!MATERIALIZING_CALL.test(node.expression.getText(source)));
    ts.forEachChild(node, visit);
  }
  for (const name of ["estimateCompactionAwareContextTokens", "isPostCompactionMessage"]) {
    const declaration = source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name);
    assert.ok(declaration && ts.isFunctionDeclaration(declaration));
    ts.forEachChild(declaration, visit);
  }
});

test("verified epoch lookup releases its session and never serializes historical tool bodies", t => {
  const resources = createOwnedTaskFixture("compaction-usage-bench-"); t.after(resources.cleanup);
  const output = join(resources.root, "measurement.json");
  const child = spawnSync(process.execPath, ["--expose-gc", "--experimental-strip-types", "scripts/bench/compaction-usage-epoch.ts", "--smoke", "--output", output],
    { cwd: new URL("../", import.meta.url), encoding: "utf8", timeout: 60000, windowsHide: true });
  assert.equal(child.status, 0, child.stderr || child.stdout);
  const evidence = JSON.parse(readFileSync(output, "utf8"));
  assert.equal(evidence.source, "provider");
  assert.equal(evidence.serializations, 0);
  assert.equal(evidence.serializedChars, 0);
  assert.equal(evidence.retainedSessionOwners, 0);
  assert.equal(evidence.retainedSettingsOwners, 0);
  assert.equal(evidence.retainedFooterOwners, 0);
  assert.equal(evidence.identityEncodings, 0);
});

test("request epoch owner and usage index allocate no per-history wrappers or callbacks", () => {
  for (const [file, names] of [
    ["packages/coding-agent/src/core/agent-session.ts", ["getRequestUsageEpoch", "getPersistedMaterializedBaseline", "assertAutomaticCompactionReady"]],
    ["packages/ai/src/utils/estimate.ts", ["getLastAssistantUsageIndex"]],
  ] as const) {
    const source = ts.createSourceFile(file, readFileSync(new URL(`../${file}`, import.meta.url), "utf8"), ts.ScriptTarget.Latest, true);
    const found = new Set<string>();
    function invariant(node: ts.Node): void {
      assert.ok(!ts.isArrowFunction(node) && !ts.isFunctionExpression(node) && !ts.isNewExpression(node));
      assert.ok(!ts.isArrayLiteralExpression(node) && !ts.isObjectLiteralExpression(node));
      if (ts.isCallExpression(node)) assert.ok(!MATERIALIZING_CALL.test(node.expression.getText(source)));
      ts.forEachChild(node, invariant);
    }
    function visit(node: ts.Node): void {
      if ((ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) && node.name && (names as readonly string[]).includes(node.name.getText(source))) {
        found.add(node.name.getText(source)); ts.forEachChild(node, invariant); return;
      }
      ts.forEachChild(node, visit);
    }
    visit(source); assert.equal(found.size, names.length);
  }
});

test("request conversion uses one metadata view, zero body serializations and releases its owners", t => {
  const resources = createOwnedTaskFixture("compaction-request-bench-"); t.after(resources.cleanup);
  const output = join(resources.root, "measurement.json");
  const child = spawnSync(process.execPath, ["--expose-gc", "--experimental-strip-types", "scripts/bench/compaction-request-epoch.ts", "--smoke", "--output", output],
    { cwd: new URL("../", import.meta.url), encoding: "utf8", timeout: 60000, windowsHide: true });
  assert.equal(child.status, 0, child.stderr || child.stdout);
  const evidence = JSON.parse(readFileSync(output, "utf8"));
  assert.equal(evidence.serializations, 0); assert.equal(evidence.serializedChars, 0);
  assert.equal(evidence.metadataViews, evidence.iterations);
  assert.equal(evidence.retainedOwners, 0); assert.equal(evidence.retainedSettings, 0);
});
