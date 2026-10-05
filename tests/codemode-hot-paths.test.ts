import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

test("post-authorization validation dispatch has no per-call factory or async boundary", () => {
  const source = ts.createSourceFile("agent-loop.ts", readFileSync("packages/agent/src/agent-loop.ts", "utf8"), ts.ScriptTarget.Latest, true);
  let found = 0;
  function audit(node: ts.Node): void {
    assert.equal(ts.isArrowFunction(node) || ts.isFunctionExpression(node) || ts.isNewExpression(node)
      || ts.isObjectLiteralExpression(node) || ts.isArrayLiteralExpression(node) || ts.isAwaitExpression(node)
      || node.kind === ts.SyntaxKind.RegularExpressionLiteral, false, node.getText(source));
    if (ts.isCallExpression(node)) assert.equal(["String", "RegExp", "Promise", "AbortController"].includes(node.expression.getText(source)), false);
    ts.forEachChild(node, audit);
  }
  function find(node: ts.Node): void {
    if (ts.isIfStatement(node) && node.expression.getText(source) === "prepared.tool.validateInput") {
      found++; audit(node.thenStatement);
    } else ts.forEachChild(node, find);
  }
  find(source); assert.equal(found, 1);
});

test("Codemode tree progress, timer and leaf refresh reuse owners without hot factories", () => {
	const targets = new Map([
		["packages/coding-agent/src/modes/interactive/components/codemode-tree.ts", new Set(["boundedPreview", "compactText", "shellStatus", "updateChild", "refresh", "refreshHeader", "tick"])],
		["packages/coding-agent/src/modes/interactive/components/tool-execution.ts", new Set(["startNestedTool", "updateNestedTool"])],
		["packages/coding-agent/src/core/codemode.ts", new Set(["requiredReadBlocks", "readSurvived", "recordToolResultProjection", "recordProjection"])],
	]);
	for (const [path, names] of targets) {
		const source = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true);
		const found = new Set<string>();
		function audit(node: ts.Node): void {
			assert.equal(ts.isArrowFunction(node) || ts.isFunctionExpression(node) || ts.isObjectLiteralExpression(node) || ts.isArrayLiteralExpression(node), false, node.getText(source));
			if (ts.isNewExpression(node)) assert.fail(node.getText(source));
			if (ts.isCallExpression(node)) {
				assert.equal(["String", "RegExp", "Promise", "AbortController"].includes(node.expression.getText(source)), false);
				if (ts.isPropertyAccessExpression(node.expression)) assert.equal(["bind", "then", "catch", "finally", "map", "filter", "flatMap"].includes(node.expression.name.text), false);
			}
			ts.forEachChild(node, audit);
		}
		function visit(node: ts.Node): void {
			if ((ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) && node.name && names.has(node.name.getText(source)) && node.body) {
				found.add(node.name.getText(source)); audit(node.body);
			} else if (ts.isPropertyDeclaration(node) && names.has(node.name.getText(source)) && node.initializer && ts.isArrowFunction(node.initializer)) {
				// Exactly one stable callback per tree lifetime; audit the entire recurring body.
				found.add(node.name.getText(source)); audit(node.initializer.body);
			} else ts.forEachChild(node, visit);
		}
		visit(source); assert.deepEqual(found, names);
	}
});

test("nested dispatch lookup, scheduling and progress adapter have no per-update factories", () => {
	const methods = new Set(["getTools", "findTool", "isCurrentTool", "pump"]);
	const found = new Set<string>();
	function audit(node: ts.Node, source: ts.SourceFile): void {
		assert.equal(ts.isArrowFunction(node) || ts.isFunctionExpression(node), false, node.getText(source));
		assert.equal(ts.isObjectLiteralExpression(node) || ts.isArrayLiteralExpression(node), false, node.getText(source));
		if (ts.isNewExpression(node) || ts.isCallExpression(node)) {
			assert.equal(["String", "RegExp", "Promise", "AbortController", "Map", "Set"].includes(node.expression.getText(source)), false, node.getText(source));
			if (ts.isPropertyAccessExpression(node.expression)) assert.equal(["bind", "then", "catch", "finally", "map", "filter", "slice"].includes(node.expression.name.text), false);
		}
		ts.forEachChild(node, child => audit(child, source));
	}
	const path = "packages/agent/src/nested-tool-dispatch.ts";
	const source = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true);
	let classifiers = 0;
	for (const statement of source.statements) if (ts.isFunctionDeclaration(statement) && statement.name?.text === "isConcurrentNestedRead" && statement.body) {
		classifiers++; audit(statement.body, source);
	}
	assert.equal(classifiers, 1);
	for (const statement of source.statements) if (ts.isClassDeclaration(statement)) {
		for (const member of statement.members) {
			if (!ts.isMethodDeclaration(member) || !member.body || !methods.has(member.name.getText(source))) continue;
			found.add(member.name.getText(source)); audit(member.body, source);
		}
	}
	assert.deepEqual(found, methods);
	const loop = ts.createSourceFile("loop.ts", readFileSync("packages/agent/src/agent-loop.ts", "utf8"), ts.ScriptTarget.Latest, true);
	let adapters = 0;
	function findAdapter(node: ts.Node): void {
		if (ts.isVariableDeclaration(node) && node.name.getText(loop) === "emitNested" && node.initializer && ts.isArrowFunction(node.initializer)) {
			adapters++; audit(node.initializer.body, loop);
		} else ts.forEachChild(node, findAdapter);
	}
	findAdapter(loop);
	assert.equal(adapters, 1);
});

test("Codemode bridge counters and bounded serialization reuse lifecycle callbacks", () => {
	for (const path of ["packages/codemode/src/runtime/protocol.ts", "packages/codemode/src/bounded-json.ts"]) {
		const source = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true);
		function audit(node: ts.Node): void {
			if (ts.isNewExpression(node) || ts.isCallExpression(node)) {
				assert.equal(["String", "RegExp", "Promise", "AbortController"].includes(node.expression.getText(source)), false);
			}
			if (ts.isMethodDeclaration(node) && node.body) {
				function noFactories(child: ts.Node): void {
					assert.equal(ts.isArrowFunction(child) || ts.isFunctionExpression(child), false, child.getText(source));
					ts.forEachChild(child, noFactories);
				}
				noFactories(node.body);
			}
			ts.forEachChild(node, audit);
		}
		audit(source);
	}
});

test("BoundedJson constructor installs exactly one stable callback for its owner lifetime", () => {
	const path = "packages/codemode/src/bounded-json.ts";
	const source = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true);
	let callbacks = 0;
	function visit(node: ts.Node): void {
		if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) {
			callbacks++;
			assert.ok(ts.isBinaryExpression(node.parent));
			assert.equal(node.parent.left.getText(source), "this.count");
			assert.ok(ts.isExpressionStatement(node.parent.parent));
			assert.ok(ts.isBlock(node.parent.parent.parent));
			assert.ok(ts.isConstructorDeclaration(node.parent.parent.parent.parent));
		}
		ts.forEachChild(node, visit);
	}
	visit(source); assert.equal(callbacks, 1);
});

test("Codemode child completion tracks a count without per-call settlement closures", () => {
	const path = "packages/coding-agent/src/core/codemode.ts";
	const source = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true);
	let found = 0;
	function visit(node: ts.Node): void {
		assert.equal(ts.isArrowFunction(node) || ts.isFunctionExpression(node), false, node.getText(source));
		if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) assert.equal(["then", "catch", "finally", "bind"].includes(node.expression.name.text), false);
		ts.forEachChild(node, visit);
	}
	for (const statement of source.statements) if (ts.isClassDeclaration(statement)) for (const member of statement.members) {
		if (ts.isMethodDeclaration(member) && member.name.getText(source) === "invoke" && member.body) { found++; visit(member.body); }
	}
	assert.equal(found, 1);
});

test("Codemode output cap uses no nested callbacks, dynamic patterns or per-group containers", () => {
	const path = "packages/coding-agent/src/core/codemode-result.ts";
	const source = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true);
	let found = 0;
	function audit(node: ts.Node): void {
		assert.equal(ts.isArrowFunction(node) || ts.isFunctionExpression(node), false);
		if (ts.isNewExpression(node) || ts.isCallExpression(node)) assert.equal(["String", "RegExp", "Map", "Set", "Array", "Promise", "AbortController"].includes(node.expression.getText(source)), false);
		if (ts.isForStatement(node) || ts.isForOfStatement(node)) {
			function containers(child: ts.Node): void {
				assert.equal(ts.isArrayLiteralExpression(child) || ts.isSpreadAssignment(child) || ts.isNewExpression(child), false);
				ts.forEachChild(child, containers);
			}
			containers(node);
		}
		ts.forEachChild(node, audit);
	}
	for (const statement of source.statements) if (ts.isFunctionDeclaration(statement) && statement.name?.text === "capCodemodeOutput") { found++; audit(statement.body!); }
	assert.equal(found, 1);
});

test("user-message render has no per-frame callbacks or pattern/string constructors", () => {
	const path = "packages/coding-agent/src/modes/interactive/components/user-message.ts";
	const source = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true);
	let found = 0;
	function audit(node: ts.Node): void {
		assert.equal(ts.isArrowFunction(node) || ts.isFunctionExpression(node), false);
		if (ts.isNewExpression(node) || ts.isCallExpression(node)) assert.equal(["String", "RegExp", "Promise"].includes(node.expression.getText(source)), false);
		ts.forEachChild(node, audit);
	}
	for (const statement of source.statements) if (ts.isClassDeclaration(statement)) for (const member of statement.members) {
		if (ts.isMethodDeclaration(member) && member.name.getText(source) === "render" && member.body) { found++; audit(member.body); }
	}
	assert.equal(found, 1);
});
