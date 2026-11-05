import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

function method(path: string, owner: string, name: string): ts.MethodDeclaration {
	const file = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true);
	const declaration = file.statements.find(node => ts.isClassDeclaration(node) && node.name?.text === owner) as ts.ClassDeclaration;
	return declaration.members.find(node => node.name?.getText(file) === name) as ts.MethodDeclaration;
}
function noHotAllocations(node: ts.Node): void {
	assert.ok(!ts.isArrowFunction(node) && !ts.isFunctionExpression(node) && !ts.isArrayLiteralExpression(node) && !ts.isObjectLiteralExpression(node) && !ts.isRegularExpressionLiteral(node), node.getText());
	if (ts.isNewExpression(node)) assert.equal(node.expression.getText(), "RangeError", "only the invalid-cursor rejection allocates");
	if (ts.isCallExpression(node)) assert.ok(![".map", ".filter", ".slice", ".bind", ".getEntries", ".getBranch"].some(suffix => node.expression.getText().endsWith(suffix)));
	ts.forEachChild(node, noHotAllocations);
}

test("append and footer visitors do not allocate arrays, wrappers, callbacks, promises or controllers", () => {
	for (const [file, owner, name] of [
		["packages/coding-agent/src/core/session-manager.ts", "SessionManager", "visitAppendedEntries"],
		["packages/coding-agent/src/modes/interactive/components/footer.ts", "FooterComponent", "visitSessionEntry"],
	] as const) noHotAllocations(method(file, owner, name).body!);
});

test("footer state construction is guarded by owner or reload invalidation", () => {
	const scan = method("packages/coding-agent/src/modes/interactive/components/footer.ts", "FooterComponent", "getSessionScan");
	let objects = 0;
	function visit(node: ts.Node): void {
		assert.ok(!ts.isArrowFunction(node) && !ts.isFunctionExpression(node) && !ts.isNewExpression(node) && !ts.isArrayLiteralExpression(node));
		if (ts.isObjectLiteralExpression(node)) {
			objects++;
			let parent = node.parent;
			while (!ts.isIfStatement(parent)) { assert.ok(parent.parent); parent = parent.parent; }
			assert.match(parent.expression.getText(), /cached\.historyGeneration !== historyGeneration/);
		}
		ts.forEachChild(node, visit);
	}
	visit(scan.body!); assert.equal(objects, 1);
});

test("notice branch rebuild is guarded and the warm path has no full scan or Map", () => {
	const estimate = method("packages/coding-agent/src/core/cache-stats.ts", "CacheOverlapCursor", "estimate");
	let branchReads = 0, weakRefs = 0;
	function visit(node: ts.Node): void {
		assert.ok(!ts.isArrowFunction(node) && !ts.isFunctionExpression(node) && !ts.isObjectLiteralExpression(node) && !ts.isArrayLiteralExpression(node));
		if (ts.isNewExpression(node)) { assert.equal(node.expression.getText(), "WeakRef"); weakRefs++; }
		if (ts.isCallExpression(node)) {
			assert.ok(!["scan", "detectCacheOverlapEstimate", "manager.getEntries"].includes(node.expression.getText()));
			if (node.expression.getText() === "manager.getBranch") {
				branchReads++;
				let parent = node.parent;
				while (!ts.isIfStatement(parent)) { assert.ok(parent.parent); parent = parent.parent; }
				assert.equal(parent.expression.getText(), "rebuild");
			}
		}
		ts.forEachChild(node, visit);
	}
	visit(estimate.body!); assert.equal(branchReads, 1); assert.equal(weakRefs, 1);
});

test("disabled notices keep the original immediate return before all cursor work", () => {
	const gate = method("packages/coding-agent/src/modes/interactive/interactive-mode.ts", "InteractiveMode", "maybeShowCacheMissNotice");
	const statements = gate.body!.statements;
	assert.equal(statements.length, 2);
	assert.ok(ts.isIfStatement(statements[0]!));
	assert.equal(statements[0].expression.getText(), "!this.settingsManager.getShowCacheMissNotices()");
	assert.ok(ts.isReturnStatement(statements[0].thenStatement));
	assert.equal(statements[1]!.getText(), "this.showCacheOverlapEstimate(message);");
});
