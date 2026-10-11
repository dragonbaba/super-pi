import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

test("stream timing confines envelope allocation to guarded completion boundaries", () => {
	const file = "packages/ai/src/utils/event-stream.ts";
	const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
	const stream = source.statements.find(node => ts.isClassDeclaration(node) && node.name?.text === "AssistantMessageEventStream") as ts.ClassDeclaration;
	for (const member of stream.members) {
		assert.equal(ts.isPropertyDeclaration(member), false, "new instance state must not narrow SDK structural compatibility");
	}
	const generic = source.statements.find(node => ts.isClassDeclaration(node) && node.name?.text === "EventStream") as ts.ClassDeclaration;
	for (const name of ["push", "end"]) {
		const method = generic.members.find(node => ts.isMethodDeclaration(node) && node.name.getText(source) === name) as ts.MethodDeclaration;
		let objects = 0;
		const violations: string[] = [];
		function visit(node: ts.Node): void {
			if (ts.isObjectLiteralExpression(node)) objects++;
			if (ts.isArrowFunction(node) || ts.isFunctionExpression(node) || ts.isArrayLiteralExpression(node) || ts.isNewExpression(node) || ts.isSpreadAssignment(node)) violations.push(ts.SyntaxKind[node.kind]);
			if (ts.isCallExpression(node) && ["finalizeAssistantTiming", "replaceAssistantTerminal"].includes(node.expression.getText(source))) {
				let parent: ts.Node | undefined = node.parent;
				while (parent && !ts.isIfStatement(parent)) parent = parent.parent;
				assert.ok(parent && ts.isIfStatement(parent));
				assert.equal(parent.expression.getText(source), name === "push" ? "this.isComplete(event)" : "!this.done && result !== undefined");
			}
			ts.forEachChild(node, visit);
		}
		visit(method.body!);
		assert.deepEqual(violations, []);
		assert.equal(objects, 1, "only the existing waiting-iterator result envelope is allowed");
	}
	for (const [name, envelopes] of [["finalizeAssistantTiming", 1], ["replaceAssistantTerminal", 2]] as const) {
		const helper = source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name) as ts.FunctionDeclaration;
		let objects = 0;
		function visit(node: ts.Node): void {
			if (ts.isObjectLiteralExpression(node)) objects++;
			assert.ok(!ts.isArrowFunction(node) && !ts.isFunctionExpression(node) && !ts.isNewExpression(node) && !ts.isArrayLiteralExpression(node));
			ts.forEachChild(node, visit);
		}
		visit(helper.body!); assert.equal(objects, envelopes);
	}
});
