import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

function methods(file: string, names: string[]) {
	const source = ts.createSourceFile(file, readFileSync(new URL(`../${file}`, import.meta.url), "utf8"), ts.ScriptTarget.Latest, true);
	const result: ts.MethodDeclaration[] = [];
	function visit(node: ts.Node) {
		if (ts.isMethodDeclaration(node) && names.includes(node.name.getText(source))) result.push(node);
		ts.forEachChild(node, visit);
	}
	visit(source);
	assert.equal(result.length, names.length);
	return { source, result };
}

test("ledger lookup and integrity adapter create no inline callbacks, Promise constructors, controllers or timers", () => {
	for (const [path, names] of [
		["packages/coding-agent/src/core/evidence-ledger.ts", ["lookup", "hashArguments", "hashScope", "miss", "hit"]],
		["packages/coding-agent/src/core/agent-session.ts", ["_executeEvidenceTool", "_checkEvidenceBranch", "_evidenceMutableHooks"]],
		["packages/coding-agent/src/core/tool-result-presentation.ts", ["residentEvidenceRecord", "issueEvidenceArtifact", "validateEvidenceArtifact"]],
	] as const) {
		const { source, result } = methods(path, [...names]);
		for (const method of result) {
			function visit(node: ts.Node) {
				assert.equal(ts.isArrowFunction(node) || ts.isFunctionExpression(node), false, `${method.name.getText(source)} inline callback`);
				if (ts.isNewExpression(node)) assert.ok(!["Promise", "AbortController", "Map", "Set"].includes(node.expression.getText(source)));
				if (ts.isCallExpression(node)) assert.ok(!["setTimeout", "setInterval", "setImmediate", "JSON.parse"].includes(node.expression.getText(source)));
				ts.forEachChild(node, visit);
			}
			visit(method);
		}
	}
});

test("resident evidence APIs cannot reconstruct or serialize content", () => {
	const { source, result } = methods("packages/coding-agent/src/core/tool-result-presentation.ts", ["residentEvidenceRecord", "issueEvidenceArtifact", "validateEvidenceArtifact"]);
	for (const method of result) {
		const text = method.getText(source);
		assert.doesNotMatch(text, /getOrCreateProjectionRecord|createArtifactResolutionRecord|scanSource\(|JSON\.stringify|\.readArtifact\(/);
	}
	const ledger = readFileSync(new URL("../packages/coding-agent/src/core/evidence-ledger.ts", import.meta.url), "utf8");
	assert.doesNotMatch(ledger, /WeakRef|Promise|AbortController|setTimeout|\.content\b|\.text\b/);
	assert.deepEqual(ledger.match(/JSON\.stringify\([^)]*\)/g), ["JSON.stringify(record.relativePath)", "JSON.stringify(record.location)"]);
	const read = readFileSync(new URL("../packages/coding-agent/src/core/tools/read.ts", import.meta.url), "utf8");
	assert.doesNotMatch(read, /Object\.(freeze|seal|preventExtensions)/);
});
