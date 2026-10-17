import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

test("authorization scanners and cache methods add no callbacks, promises or Buffer copies", () => {
  const targets = new Map([
    ["shell-analysis.ts", new Set(["analyzeShellSource", "get", "assertCurrent", "release"])],
    ["shell-substitution.ts", new Set(["prepareShellAnalysis", "removeHeredocContinuations", "heredocDeclarationEnd", "collectHereDelimiters", "heredocDescriptorCopy", "isShellWordBoundary", "isFunctionSubstitutionStart", "extractCommandSubstitutions", "commandSubstitutionEnd"])],
    ["core.ts", new Set(["inspectBashResourceLifecycle", "inspectLifecycleScript", "inspectHighRiskBashMutation", "inspectShellScript", "heredocConsumer", "heredocConsumers", "heredocDocumentConsumers", "heredocExecutableBody", "decodeLiteralBase64", "stdinScriptConsumers", "simpleStdinConsumers", "functionStdinConsumers", "persistedHeredocConsumers", "isPersistentHeredocDeclaration", "heredocHasAliasRisk", "hasUninspectableBashState", "uninspectableBashStateStart", "hasUnboundDescriptorSource", "descriptorBoundAt", "pipelineDescriptorConnected", "parseShellSegments", "literalProcessSources", "isTransparentStdinStage", "literalStoredScripts", "literalAdjacentSource", "literalPreviousAssignment", "literalEvalScript", "literalAliasSource", "isHeredocDescriptorPath", "nodeMayReadStdin", "heredocHasUntrackedCwd", "addMutationPrimitive", "inspectEmbeddedCode", "inspectCodeCall", "inspectOutputRedirections", "inspectPowerShellRemove", "inspectWindowsRmdir", "inspectXargs", "collectPositionalTargets", "addPrimitive", "addTarget", "addResolvedTarget", "markUnverifiable", "maskCodeStringsAndComments", "literalFirstArgument", "inspectFind"])],
    ["permission-bash.ts", new Set(["inspectScript", "inspectBashPermissionScope", "inspectKnownMutation", "markMutation", "markUncertainContext", "addResolvedTarget", "addTarget"])],
    ["shell-redirection.ts", new Set(["isShellOutputFileRedirection", "isShellFileDescriptor", "shellRedirectionLength", "hasUnsafeBashTestOperand", "isBashIntegerLiteral", "hasOnlySimpleQueryVariables", "isQueryVariableStart", "isQueryVariablePart", "isQueryVariableDigit", "isReadOnlySpecialParameter", "bashPipelinePrefixEnd", "bashTimeOptionsEnd", "isQuotedBashWord"])],
    ["readonly-find.ts", new Set(["findPredicateHasOperand"])],
    ["sort-options.ts", new Set(["sortLongOption", "sortOptionRequiresValue", "sortHasTerminalOption"])],
    ["timeout-wrapper.ts", new Set(["parseTimeoutInvocation"])],
  ]);
  for (const name of ["hasUnsafeBashBuiltinOperand", "hasNonliteralBashSubscript", "skipRedirections", "afterLeadingRedirection"]) targets.get("core.ts")!.add(name);
  targets.get("core.ts")!.add("hasBareBashArithmeticCommand");
  targets.get("core.ts")!.add("descriptorCopyOrigin");
  targets.get("shell-substitution.ts")!.add("subscriptTextState");
  targets.get("shell-substitution.ts")!.add("isPromptParameterExpansion");
  targets.get("core.ts")!.add("findSearchRootIndex");
  targets.get("core.ts")!.add("nodeHasRecursiveOption");
  targets.get("core.ts")!.add("pythonPathArgumentOpen");
  targets.get("core.ts")!.add("coprocBodyIndex");
  targets.get("core.ts")!.add("coprocHeredocContext");
  for (const name of ["nodeIndirectCall", "nodeLiteralMethodKeyEnd", "isCodeWhitespace", "hasUninspectableEnvLauncher", "commandTokenIndex"]) targets.get("core.ts")!.add(name);
  for (const name of ["addPositionalTargets", "findSearchRootIndex", "inspectTokenBuffer"]) targets.get("permission-bash.ts")!.add(name);
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

test("builtin, coproc and Node argv checks use primitive state without source copies or temporary containers", () => {
  const source = ts.createSourceFile("core.ts", readFileSync("packages/extensions/resource-lifecycle-guard/core.ts", "utf8"), ts.ScriptTarget.Latest, true);
  const names = new Set(["hasUnsafeBashBuiltinOperand", "hasNonliteralBashSubscript", "skipRedirections", "afterLeadingRedirection", "coprocBodyIndex", "coprocHeredocContext", "nodeMayReadStdin", "hasUninspectableEnvLauncher"]), seen = new Set<string>();
  function audit(node: ts.Node): void {
    assert.equal(ts.isNewExpression(node) || ts.isObjectLiteralExpression(node) || ts.isArrayLiteralExpression(node) || ts.isArrowFunction(node) || ts.isFunctionExpression(node) || ts.isRegularExpressionLiteral(node), false, node.getText(source));
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) assert.ok(["charCodeAt", "startsWith", "includes", "test", "has"].includes(node.expression.name.text), node.getText(source));
    ts.forEachChild(node, audit);
  }
  for (const statement of source.statements) if (ts.isFunctionDeclaration(statement) && statement.name && names.has(statement.name.text)) {
    seen.add(statement.name.text); ts.forEachChild(statement.body!, audit);
  }
  assert.deepEqual(seen, names);
  for (const name of ["inspectLifecycleScript", "simpleStdinConsumers", "commandTokenIndex"]) {
    const caller = source.statements.find(statement => ts.isFunctionDeclaration(statement) && statement.name?.text === name);
    assert.ok(caller?.getText(source).includes("hasUninspectableEnvLauncher("), `${name} must share the env uncertainty condition`);
  }
});

test("subscript text judgment creates only primitive state in the existing scan", () => {
  const source = ts.createSourceFile("shell-substitution.ts", readFileSync("packages/extensions/resource-lifecycle-guard/shell-substitution.ts", "utf8"), ts.ScriptTarget.Latest, true);
  const helper = source.statements.find(statement => ts.isFunctionDeclaration(statement) && statement.name?.text === "subscriptTextState");
  assert.ok(helper && ts.isFunctionDeclaration(helper));
  function audit(node: ts.Node): void {
    assert.equal(ts.isNewExpression(node) || ts.isObjectLiteralExpression(node) || ts.isArrayLiteralExpression(node) || ts.isArrowFunction(node) || ts.isFunctionExpression(node) || ts.isRegularExpressionLiteral(node) || ts.isCallExpression(node), false, node.getText(source));
    ts.forEachChild(node, audit);
  }
  ts.forEachChild(helper.body!, audit);
});

test("sort terminal preflight adds no source copies or temporary containers", () => {
  const source = ts.createSourceFile("sort-options.ts", readFileSync("packages/extensions/resource-lifecycle-guard/sort-options.ts", "utf8"), ts.ScriptTarget.Latest, true);
  const helper = source.statements.find(statement => ts.isFunctionDeclaration(statement) && statement.name?.text === "sortHasTerminalOption");
  assert.ok(helper && ts.isFunctionDeclaration(helper));
  function audit(node: ts.Node): void {
    assert.equal(ts.isNewExpression(node) || ts.isObjectLiteralExpression(node) || ts.isArrayLiteralExpression(node) || ts.isArrowFunction(node) || ts.isFunctionExpression(node) || ts.isRegularExpressionLiteral(node), false, node.getText(source));
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) assert.ok(["charCodeAt", "startsWith", "indexOf"].includes(node.expression.name.text), node.getText(source));
    ts.forEachChild(node, audit);
  }
  ts.forEachChild(helper.body!, audit);
});

test("interpreter call helpers allocate no per-call regexes, strings or containers", () => {
  const source = ts.createSourceFile("core.ts", readFileSync("packages/extensions/resource-lifecycle-guard/core.ts", "utf8"), ts.ScriptTarget.Latest, true);
  const names = new Set(["nodeIndirectCall", "nodeLiteralMethodKeyEnd", "isCodeWhitespace"]), seen = new Set<string>();
  function audit(node: ts.Node): void {
    assert.equal(ts.isNewExpression(node) || ts.isObjectLiteralExpression(node) || ts.isArrayLiteralExpression(node) || ts.isArrowFunction(node) || ts.isFunctionExpression(node) || ts.isRegularExpressionLiteral(node) || ts.isTemplateExpression(node), false, node.getText(source));
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) assert.ok(["charCodeAt", "endsWith", "test"].includes(node.expression.name.text), node.getText(source));
    ts.forEachChild(node, audit);
  }
  for (const statement of source.statements) if (ts.isFunctionDeclaration(statement) && statement.name && names.has(statement.name.text)) { seen.add(statement.name.text); ts.forEachChild(statement.body!, audit); }
  assert.deepEqual(seen, names);
  for (const file of ["core.ts", "permission-bash.ts"]) assert.ok(readFileSync(`packages/extensions/resource-lifecycle-guard/${file}`, "utf8").includes("PYTHON_COMMAND_PATTERN.test("));
  assert.equal(readFileSync("packages/extensions/resource-lifecycle-guard/core.ts", "utf8").includes("PYTHON_COMMANDS"), false);
});

test("descriptor origin decoding adds no strings or temporary containers", () => {
  const source = ts.createSourceFile("core.ts", readFileSync("packages/extensions/resource-lifecycle-guard/core.ts", "utf8"), ts.ScriptTarget.Latest, true);
  const helper = source.statements.find(statement => ts.isFunctionDeclaration(statement) && statement.name?.text === "descriptorCopyOrigin");
  assert.ok(helper && ts.isFunctionDeclaration(helper));
  function audit(node: ts.Node): void {
    assert.equal(ts.isNewExpression(node) || ts.isObjectLiteralExpression(node) || ts.isArrayLiteralExpression(node) || ts.isArrowFunction(node) || ts.isFunctionExpression(node) || ts.isRegularExpressionLiteral(node), false, node.getText(source));
    if (ts.isCallExpression(node)) assert.ok(ts.isPropertyAccessExpression(node.expression) && ["endsWith", "charCodeAt", "isSafeInteger"].includes(node.expression.name.text), node.getText(source));
    ts.forEachChild(node, audit);
  }
  ts.forEachChild(helper.body!, audit);
});

test("prompt transform recognition adds no strings or temporary containers", () => {
  const source = ts.createSourceFile("shell-substitution.ts", readFileSync("packages/extensions/resource-lifecycle-guard/shell-substitution.ts", "utf8"), ts.ScriptTarget.Latest, true);
  const helper = source.statements.find(statement => ts.isFunctionDeclaration(statement) && statement.name?.text === "isPromptParameterExpansion");
  assert.ok(helper && ts.isFunctionDeclaration(helper));
  function audit(node: ts.Node): void {
    assert.equal(ts.isNewExpression(node) || ts.isObjectLiteralExpression(node) || ts.isArrayLiteralExpression(node) || ts.isArrowFunction(node) || ts.isFunctionExpression(node) || ts.isRegularExpressionLiteral(node), false, node.getText(source));
    if (ts.isCallExpression(node)) assert.ok(ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === "charCodeAt", node.getText(source));
    ts.forEachChild(node, audit);
  }
  ts.forEachChild(helper.body!, audit);
});

test("Node call-boundary checks allocate no source copies or temporary containers", () => {
  const source = ts.createSourceFile("core.ts", readFileSync("packages/extensions/resource-lifecycle-guard/core.ts", "utf8"), ts.ScriptTarget.Latest, true);
  const helper = source.statements.find(statement => ts.isFunctionDeclaration(statement) && statement.name?.text === "nodeHasRecursiveOption");
  assert.ok(helper && ts.isFunctionDeclaration(helper));
  function audit(node: ts.Node): void {
    assert.equal(ts.isNewExpression(node) || ts.isObjectLiteralExpression(node) || ts.isArrayLiteralExpression(node) || ts.isArrowFunction(node) || ts.isFunctionExpression(node) || ts.isRegularExpressionLiteral(node), false, node.getText(source));
    if (ts.isCallExpression(node)) assert.ok(ts.isPropertyAccessExpression(node.expression) && ["charCodeAt", "test"].includes(node.expression.name.text), node.getText(source));
    ts.forEachChild(node, audit);
  }
  ts.forEachChild(helper.body!, audit);
});

test("Python unlink receiver checks allocate no source copies or temporary containers", () => {
  const source = ts.createSourceFile("core.ts", readFileSync("packages/extensions/resource-lifecycle-guard/core.ts", "utf8"), ts.ScriptTarget.Latest, true);
  const helper = source.statements.find(statement => ts.isFunctionDeclaration(statement) && statement.name?.text === "pythonPathArgumentOpen");
  assert.ok(helper && ts.isFunctionDeclaration(helper));
  function audit(node: ts.Node): void {
    assert.equal(ts.isNewExpression(node) || ts.isObjectLiteralExpression(node) || ts.isArrayLiteralExpression(node) || ts.isArrowFunction(node) || ts.isFunctionExpression(node) || ts.isRegularExpressionLiteral(node), false, node.getText(source));
    if (ts.isCallExpression(node)) assert.ok(ts.isPropertyAccessExpression(node.expression) && ["charCodeAt", "endsWith"].includes(node.expression.name.text), node.getText(source));
    ts.forEachChild(node, audit);
  }
  ts.forEachChild(helper.body!, audit);
});

test("builtin heredoc gate allocates no AST, source copy, container or callback", () => {
  const file = "packages/coding-agent/src/core/tools/shell-heredoc-gate.ts";
  const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
  const names = new Set(["shellHeredocKind", "scanHeredocSyntax", "classifyBoundedBody"]), seen = new Set<string>();
  function audit(node: ts.Node): void {
    assert.equal(ts.isArrowFunction(node) || ts.isFunctionExpression(node) || ts.isFunctionDeclaration(node) || ts.isNewExpression(node) || ts.isObjectLiteralExpression(node) || ts.isArrayLiteralExpression(node) || ts.isTemplateExpression(node) || ts.isRegularExpressionLiteral(node), false, node.getText(source));
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      if (ts.isPropertyAccessExpression(callee)) assert.ok(["charCodeAt", "startsWith"].includes(callee.name.text), node.getText(source));
      else assert.ok(names.has(callee.getText(source)), node.getText(source));
    }
    ts.forEachChild(node, audit);
  }
  for (const statement of source.statements) if (ts.isFunctionDeclaration(statement) && statement.name && statement.body) {
    assert.ok(names.has(statement.name.text)); seen.add(statement.name.text); ts.forEachChild(statement.body, audit);
  }
  assert.deepEqual(seen, names);
});

test("function-boundary and CR decisions add no source copies or temporary objects", () => {
  const file = "packages/extensions/resource-lifecycle-guard/shell-substitution.ts";
  const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
  let prefix = 0, crLoop = 0, guardedLegacyCopies = 0;
  function primitive(node: ts.Node): void {
    assert.equal(ts.isNewExpression(node) || ts.isObjectLiteralExpression(node) || ts.isArrayLiteralExpression(node) || ts.isArrowFunction(node) || ts.isFunctionExpression(node), false, node.getText(source));
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) assert.equal(node.expression.name.text, "charCodeAt", node.getText(source));
    ts.forEachChild(node, primitive);
  }
  function visit(node: ts.Node): void {
    if (ts.isFunctionDeclaration(node) && node.name?.text === "isFunctionSubstitutionStart") { prefix++; ts.forEachChild(node.body!, primitive); }
    if (ts.isForStatement(node) && node.condition?.getText(source) === "cursor < contentEnd") { crLoop++; primitive(node.statement); }
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === "slice") {
      let parent: ts.Node | undefined = node.parent, guarded = false;
      while (parent && !ts.isFunctionDeclaration(parent)) {
        if (ts.isIfStatement(parent) && parent.expression.getText(source) === "!functionBody") guarded = true;
        parent = parent.parent;
      }
      if (parent && ts.isFunctionDeclaration(parent) && parent.name?.text === "commandSubstitutionEnd") { assert.equal(guarded, true); guardedLegacyCopies++; }
    }
    ts.forEachChild(node, visit);
  }
  visit(source); assert.equal(prefix, 1); assert.equal(crLoop, 1); assert.equal(guardedLegacyCopies, 1);
});
