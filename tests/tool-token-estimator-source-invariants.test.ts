import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

const SOURCE_PATH = "packages/coding-agent/src/core/tool-output-budget.ts";

test("tool estimator source invariants forbid hot-path allocation regressions", () => {
	const source = readFileSync(SOURCE_PATH, "utf8");
	const ast = ts.createSourceFile(SOURCE_PATH, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
	let arrows = 0;
	let functionExpressions = 0;
	let promiseConstructions = 0;
	let abortControllerConstructions = 0;
	let dynamicRegexConstructions = 0;
	let forbiddenCalls = 0;
	const forbiddenMethods = new Set(["split", "map", "filter", "flatMap", "join"]);

	function visit(node: ts.Node): void {
		if (ts.isArrowFunction(node)) arrows++;
		if (ts.isFunctionExpression(node)) functionExpressions++;
		if (ts.isNewExpression(node)) {
			const name = node.expression.getText(ast);
			if (name === "Promise") promiseConstructions++;
			if (name === "AbortController") abortControllerConstructions++;
			if (name === "RegExp") dynamicRegexConstructions++;
		}
		if (ts.isCallExpression(node)) {
			const expression = node.expression;
			if (ts.isPropertyAccessExpression(expression) && forbiddenMethods.has(expression.name.text)) forbiddenCalls++;
			const name = expression.getText(ast);
			if (
				name === "Array.from" ||
				name === "Buffer.from" ||
				name === "JSON.stringify" ||
				name === "String"
			) forbiddenCalls++;
		}
		ts.forEachChild(node, visit);
	}
	visit(ast);
	assert.equal(arrows, 0, "sourceInvariantArrowFunctions");
	assert.equal(functionExpressions, 0, "sourceInvariantFunctionExpressions");
	assert.equal(promiseConstructions, 0);
	assert.equal(abortControllerConstructions, 0);
	assert.equal(dynamicRegexConstructions, 0);
	assert.equal(forbiddenCalls, 0);
	assert.equal(source.includes("new String"), false);
	assert.equal(source.includes("ObjectPool"), false);
	assert.equal(source.includes("Promise.all"), false);
	assert.equal(source.includes(".catch("), false);
	assert.equal(source.includes("recordRejectedTelemetry.bind(undefined, this.counters)"), true);
	for (const removedPseudoRuntimeCounter of [
		"closuresCreated",
		"promisesCreated",
		"fullStringCopies",
		"fullStringSerializations",
		"temporaryLineArrays",
		"finalRetainedReferences",
	]) {
		assert.equal(source.includes(removedPseudoRuntimeCounter), false, removedPseudoRuntimeCounter);
	}
});
