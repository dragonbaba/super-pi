import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

test("task persistence is reachable only from named lifecycle boundaries, never streaming publication", () => {
	const file = "packages/extensions/subagent/tasks.ts";
	const tree = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
	const sites: string[] = [];
	function walk(node: ts.Node, owner: string): void {
		if (ts.isMethodDeclaration(node)) owner = node.name.getText(tree);
		if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
			const called = node.expression.getText(tree);
			if (called === "this.persist") sites.push(owner);
			if (called === "this.history?.save") assert.equal(owner, "persist");
			if (called === "history.load") assert.equal(owner, "configureHistory");
			if (called === "this.history?.close") assert.equal(owner, "closeHistory");
		}
		ts.forEachChild(node, child => walk(child, owner));
	}
	walk(tree, ""); assert.deepEqual(sites.sort(), ["create", "finish", "start"]);
	const storage = readFileSync("packages/extensions/task-history.ts", "utf8");
	assert.doesNotMatch(storage, /setTimeout|setInterval|new Promise|AbortController|\.on\(["']data/);
	assert.doesNotMatch(storage, /JSON\.stringify\(record\)|JSON\.stringify\(.*records/);
	assert.match(storage, /JSON\.stringify\(record\.shellExecution\)/, "only bounded terminal facts are encoded");
});
