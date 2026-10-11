import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

test("tool renderer traversal creates no per-lookup closure, list, wrapper or cache", () => {
	const path = "packages/coding-agent/src/core/extensions/runner.ts";
	const source = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true);
	const runner = source.statements.find(node => ts.isClassDeclaration(node) && node.name?.text === "ExtensionRunner") as ts.ClassDeclaration;
	const members = runner.members.filter(node => node.name && ["resolveToolRenderers", "nextToolRenderer"].includes(node.name.getText(source)));
	assert.equal(members.length, 2);
	const violations: string[] = [];
	function visit(node: ts.Node): void {
		if (ts.isArrowFunction(node) || ts.isFunctionExpression(node) || ts.isArrayLiteralExpression(node) || ts.isSpreadElement(node) || ts.isSpreadAssignment(node)) violations.push(ts.SyntaxKind[node.kind]);
		if (ts.isObjectLiteralExpression(node)) {
			let parent: ts.Node | undefined = node.parent;
			while (parent && !ts.isCatchClause(parent)) parent = parent.parent;
			if (!parent) violations.push("normal-path object literal"); // Error diagnostics are the explicit cold exception.
		}
		if (ts.isNewExpression(node) && !["RangeError", "TypeError"].includes(node.expression.getText(source))) violations.push(node.getText(source));
		if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && ["map", "flatMap", "filter", "slice", "from", "bind"].includes(node.expression.name.text)) violations.push(node.expression.getText(source));
		ts.forEachChild(node, visit);
	}
	for (const member of members) {
		if (ts.isMethodDeclaration(member)) visit(member.body!);
		else if (ts.isPropertyDeclaration(member) && member.initializer && ts.isArrowFunction(member.initializer)) visit(member.initializer.body);
	}
	assert.deepEqual(violations, []);
});
