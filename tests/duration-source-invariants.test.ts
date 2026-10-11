import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

test("assistant timing adds no per-delta allocation and drops its primitive record at termination", () => {
	const file = "packages/ai/src/utils/event-stream.ts";
	const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
	const stream = source.statements.find(node => ts.isClassDeclaration(node) && node.name?.text === "AssistantMessageEventStream") as ts.ClassDeclaration;
	const finish = source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === "finishResponseTiming") as ts.FunctionDeclaration;
	const violations: string[] = [];
	function visit(node: ts.Node): void {
		if (ts.isArrowFunction(node) || ts.isFunctionExpression(node) || ts.isObjectLiteralExpression(node) || ts.isArrayLiteralExpression(node) || ts.isNewExpression(node) || ts.isSpreadElement(node)) violations.push(ts.SyntaxKind[node.kind]);
		ts.forEachChild(node, visit);
	}
	visit(finish.body!);
	for (const member of stream.members) {
		assert.equal(ts.isPropertyDeclaration(member), false, "new instance state must not narrow SDK structural compatibility");
		if (ts.isMethodDeclaration(member)) visit(member.body!);
	}
	assert.deepEqual(violations, []);
	assert.match(finish.getText(source), /responseTiming\.delete\(stream\)/);
});
