import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

const root = "packages/extensions/tool-loop-guardrails/";
const targets: Record<string, string[]> = {
  "call-identity.ts": ["InputHash.text", "InputHash.visit", "callKey"],
  "call-ledger.ts": ["CallLedger.canAdmit", "CallLedger.remember", "CallLedger.rememberRepair", "CallLedger.finish", "CallLedger.end", "CallLedger.clear"],
  "transient-retry.ts": ["isTransientFailure", "RetryBudget.record", "RetryBudget.delay", "RetryBudget.refusal", "RetryBudget.clear", "RetryWait.start", "RetryWait.cancel", "RetryWait.finish"],
  "core.ts": ["boundedToolName", "setBounded", "inspectBatchCall", "resetBatchState", "classifyFailureText", "observeRepeatedCall", "warningText", "signatureKey", "inspectBeforeCall", "recordResult", "resetGuardState",
    "prepareDeterministicCall", "bashWorkdirFailure", "bashStaticCdFailure", "staticLeadingCdDirectory", "npmManifestDirectory", "commandPrefixTokens", "toolPath", "structuredRgBraceFailure", "structuredRgPathOperands",
    "failureRecoveryHint", "isMsysRegexArgvFailure", "nearestFailurePath", "nearestExistingPath", "boundedEditDistance"],
  "index.ts": ["boundedFailureText", "sendHiddenAdvisory", "tool_call", "tool_result", "tool_execution_end"],
};

test("R3 repeat lane and its exact helpers contain no per-delivery callbacks, Promise tails or full-input serialization", () => {
  for (const [file, names] of Object.entries(targets)) {
    const source = ts.createSourceFile(file, readFileSync(root + file, "utf8"), ts.ScriptTarget.Latest, true);
    const found = new Set<string>();
    function inspect(body: ts.Node, owner: string): void {
      function audit(node: ts.Node): void {
        assert.equal(ts.isArrowFunction(node) || ts.isFunctionExpression(node) || ts.isFunctionDeclaration(node), false, `${file}/${owner}: nested callback ${node.getText(source)}`);
        if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
          assert.ok(!["then", "catch", "finally", "map", "filter", "flatMap", "bind"].includes(node.expression.name.text), `${file}/${owner}: ${node.expression.getText(source)}`);
        }
        if (ts.isNewExpression(node)) {
          const constructor = node.expression.getText(source);
          if (constructor === "Promise") {
            assert.equal(`${file}/${owner}`, "transient-retry.ts/RetryWait.start");
            assert.equal(node.arguments?.[0].getText(source), "this.executor");
          }
          assert.notEqual(constructor, "AbortController");
        }
        ts.forEachChild(node, audit);
      }
      audit(body);
    }
    function visit(node: ts.Node): void {
      let name: string | undefined, body: ts.Node | undefined;
      if (ts.isFunctionDeclaration(node) && node.name) { name = node.name.text; body = node.body; }
      if (ts.isMethodDeclaration(node) && ts.isClassDeclaration(node.parent)) { name = `${node.parent.name?.text}.${node.name.getText(source)}`; body = node.body; }
      if (ts.isCallExpression(node) && node.expression.getText(source) === "pi.on" && ts.isStringLiteral(node.arguments[0]) && ts.isArrowFunction(node.arguments[1])) {
        name = node.arguments[0].text; body = node.arguments[1].body;
      }
      if (name && names.includes(name)) { assert.ok(body); found.add(name); inspect(body, name); }
      ts.forEachChild(node, visit);
    }
    visit(source);
    assert.deepEqual(found, new Set(names), `exact coverage: ${file}`);
    if (file === "call-identity.ts") {
      const text = source.text;
      assert.doesNotMatch(text, /JSON\.stringify|Buffer\.from|\.join\(|\.map\(|\.filter\(/);
      assert.match(text, /offset \+= HASH_CHUNK_CHARACTERS/);
      assert.match(text, /hash\.update\(value\.slice\(offset, offset \+ HASH_CHUNK_CHARACTERS\), "utf16le"\)/);
    }
  }
});

test("result handoff cannot rehash input and only the startup-owned retry instance creates timer callbacks", () => {
  const source = ts.createSourceFile("index.ts", readFileSync(root + "index.ts", "utf8"), ts.ScriptTarget.Latest, true);
  let checked = false;
  function visit(node: ts.Node): void {
    if (ts.isCallExpression(node) && node.expression.getText(source) === "pi.on" && node.arguments[0]?.getText(source) === '"tool_result"') {
      const body = node.arguments[1].getText(source);
      assert.doesNotMatch(body, /callKey\(|JSON\.stringify\(event\.input/);
      assert.match(body, /const key = pending.key/);
      checked = true;
    }
    ts.forEachChild(node, visit);
  }
  visit(source); assert.ok(checked);
  const retry = ts.createSourceFile("retry.ts", readFileSync(root + "transient-retry.ts", "utf8"), ts.ScriptTarget.Latest, true);
  const callbacks = new Set<string>();
  function inspect(node: ts.Node): void {
    if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) {
      assert.ok(ts.isPropertyDeclaration(node.parent));
      const owner = node.parent.parent;
      assert.ok(ts.isClassDeclaration(owner)); assert.equal(owner.name?.text, "RetryWait");
      callbacks.add(node.parent.name.getText(retry));
    }
    ts.forEachChild(node, inspect);
  }
  inspect(retry);
  assert.deepEqual(callbacks, new Set(["onTimer", "onAbort", "executor"]));
});
