import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

function source(path: string): ts.SourceFile {
	return ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true);
}
function noCallbacks(node: ts.Node): void {
	assert.ok(!ts.isArrowFunction(node) && !ts.isFunctionExpression(node) && !ts.isRegularExpressionLiteral(node), node.getText());
	if (ts.isNewExpression(node)) assert.ok(!["Promise", "AbortController", "RegExp"].includes(node.expression.getText()));
	ts.forEachChild(node, noCallbacks);
}

test("request attribution owns prototype callbacks and no Promise, controller or regex", () => {
	noCallbacks(source("packages/coding-agent/src/core/prefix-request.ts"));
});

test("result notification stays inside the terminal branch; synchronous observers have no Promise tail", () => {
	const file = source("packages/ai/src/utils/event-stream.ts");
	const owner = file.statements.find(n => ts.isClassDeclaration(n) && n.name?.text === "EventStream") as ts.ClassDeclaration;
	const push = owner.members.find(n => n.name?.getText(file) === "push") as ts.MethodDeclaration;
	let notifications = 0;
	function visit(node: ts.Node): void {
		if (ts.isCallExpression(node) && node.expression.getText(file) === "this.notifyResult") {
			notifications++;
			let parent = node.parent;
			while (!ts.isIfStatement(parent)) { assert.ok(parent.parent); parent = parent.parent; }
			assert.equal(parent.expression.getText(file), "this.isComplete(event)");
		}
		ts.forEachChild(node, visit);
	}
	visit(push); assert.equal(notifications, 1);
	for (const name of ["notifyResult", "observeResult"]) noCallbacks(owner.members.find(n => n.name?.getText(file) === name)!);
	const notify = file.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === "notifyResultObserver")!;
	noCallbacks(notify);
	let tails = 0;
	function checkPromise(node: ts.Node): void {
		if (ts.isCallExpression(node) && node.expression.getText(file) === "Promise.resolve") {
			tails++;
			let parent = node.parent;
			while (!ts.isIfStatement(parent)) { assert.ok(parent.parent); parent = parent.parent; }
			assert.equal(parent.expression.getText(file), 'returned && typeof returned.then === "function"');
		}
		ts.forEachChild(node, checkPromise);
	}
	checkPromise(notify); assert.equal(tails, 1, "only an actual third-party async terminal observer may create a tail");
});

test("response attribution stores one weak identity without a message collection", () => {
	const file = source("packages/coding-agent/src/core/prefix-manifest.ts");
	const owner = file.statements.find(n => ts.isClassDeclaration(n) && n.name?.text === "PrefixManifestRecorder")!;
	noCallbacks(owner);
	let weakRefs = 0;
	function visit(node: ts.Node): void {
		if (ts.isNewExpression(node)) {
			assert.equal(node.expression.getText(file), "WeakRef"); weakRefs++;
		}
		assert.equal(ts.isArrayLiteralExpression(node), false);
		ts.forEachChild(node, visit);
	}
	visit(owner); assert.equal(weakRefs, 1);
});
