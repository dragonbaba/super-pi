import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

test("LSP protocol delivery reuses diagnostic settle callbacks without notification arrays or promise tails", () => {
  const source = ts.createSourceFile("lsp-client.ts", readFileSync(new URL("../packages/lsp/src/lsp-client.ts", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true);
  const names = new Set(["#onStdout", "#onStderr", "#onData", "#handleMessage", "#recordPublishedDiagnostics", "#send", "documentUriKey", "onPublish"]);
  let audited = 0;
  function audit(node) {
    if (node.name && names.has(node.name.getText(source))) {
      const body = node.body ?? node.initializer?.body;
      if (body) {
        audited++;
        function visit(child) {
          assert.equal(ts.isArrowFunction(child) || ts.isFunctionExpression(child), false, child.getText(source));
          assert.equal(ts.isArrayLiteralExpression(child), false, child.getText(source));
          if (ts.isNewExpression(child)) assert.equal(child.expression.getText(source), "Error");
          if (ts.isCallExpression(child)) assert.doesNotMatch(child.expression.getText(source), /\.(then|catch|finally|map|filter|flatMap|bind)$/);
          ts.forEachChild(child, visit);
        }
        visit(body);
      }
    }
    ts.forEachChild(node, audit);
  }
  audit(source); assert.equal(audited, names.size);
  // start, request, shutdown, #waitForClose and initial diagnostic waiter setup are lifecycle/call boundaries.
  assert.match(source.text, /setTimeout\(\s*settleLatest,/);
  assert.match(source.text, /this\.#publishedDiagnostics\.size >= MAX_PUBLISHED_DIAGNOSTIC_DOCUMENTS/);
});

test("LSP source reads own one capped buffer and no per-read allocation or asynchronous tail", () => {
  const source = ts.createSourceFile("runner.ts", readFileSync(new URL("../packages/lsp/src/runner.ts", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true);
  const fn = source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === "readBoundedDocument");
  assert.ok(fn?.body);
  let buffers = 0, loops = 0;
  function inspect(node) {
    if (ts.isCallExpression(node) && node.expression.getText(source) === "Buffer.allocUnsafe") {
      buffers++; assert.equal(node.arguments[0].getText(source), "size + 1");
    }
    if (ts.isWhileStatement(node)) {
      loops++;
      function check(child) {
        assert.equal(ts.isArrowFunction(child) || ts.isFunctionExpression(child) || ts.isObjectLiteralExpression(child) || ts.isArrayLiteralExpression(child) || ts.isNewExpression(child) || ts.isAwaitExpression(child), false, child.getText(source));
        ts.forEachChild(child, check);
      }
      check(node);
    }
    ts.forEachChild(node, inspect);
  }
  inspect(fn.body); assert.equal(buffers, 1); assert.equal(loops, 1);
  assert.match(fn.getText(source), /size > MAX_LSP_DOCUMENT_BYTES/);
  assert.match(fn.getText(source), /finally\s*\{ closeSync\(fd\); \}/);
});

test("LSP traversal owns one reusable adapter scratch per directory, never per entry", () => {
  const source = ts.createSourceFile("files.ts", readFileSync(new URL("../packages/lsp/src/files.ts", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true);
  const collect = source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === "collectPath");
  assert.ok(collect?.body);
  let scratch, loopArrays = 0, clearCount = 0, finallyClear = false;
  function visit(node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(source) === "childCollections") scratch = node;
    if (ts.isArrayLiteralExpression(node)) {
      for (let parent = node.parent; parent && parent !== collect; parent = parent.parent) {
        if (ts.isForOfStatement(parent) || ts.isForStatement(parent) || ts.isWhileStatement(parent)) { loopArrays++; break; }
      }
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      node.left.getText(source) === "childCollections.length" && node.right.getText(source) === "0") {
      clearCount++;
      for (let parent = node.parent; parent && parent !== collect; parent = parent.parent) {
        if (ts.isBlock(parent) && ts.isTryStatement(parent.parent) && parent.parent.finallyBlock === parent) finallyClear = true;
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(collect);
  assert.ok(scratch && ts.isArrayLiteralExpression(scratch.initializer));
  assert.ok(scratch.parent.parent.parent === collect.body, "scratch must be directory-call owned");
  assert.equal(loopArrays, 0, "no per-entry adapter arrays");
  assert.ok(clearCount >= 2 && finallyClear, "reuse and exceptional exits must release scratch references");
});
