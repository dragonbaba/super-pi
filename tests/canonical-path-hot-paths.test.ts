import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

test("canonical helper uses one native resolution without new per-call wrappers or state", () => {
	const source = ts.createSourceFile("paths.ts", readFileSync(new URL("../packages/coding-agent/src/utils/paths.ts", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true);
	const fn = source.statements.find((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === "canonicalizePath")!;
	let nativeCalls = 0;
	function walk(node: ts.Node) {
		assert.ok(!ts.isArrowFunction(node) && !ts.isFunctionExpression(node) && !ts.isNewExpression(node) && !ts.isObjectLiteralExpression(node) && !ts.isArrayLiteralExpression(node) && !ts.isAwaitExpression(node));
		if (ts.isCallExpression(node)) { assert.equal(node.expression.getText(source), "realpathSync.native"); nativeCalls++; }
		ts.forEachChild(node, walk);
	}
	walk(fn.body!); assert.equal(nativeCalls, 1);
});
test("real selector render performs no path resolution and releases frames/components", () => {
	const child = spawnSync(process.execPath, ["--expose-gc", "--experimental-strip-types", "scripts/bench/canonical-path-selectors.ts", "--smoke"], { cwd: new URL("../", import.meta.url), encoding: "utf8", timeout: 60000 });
	assert.equal(child.status, 0, child.stderr || child.stdout);
	const evidence = JSON.parse(child.stdout); assert.equal(evidence.nativeImplementation, true);
	assert.equal(evidence.displayIdentityCached, true);
	assert.deepEqual(evidence.rows.map((row: any) => [row.kind, row.counters.nativeCalls, row.counters.legacyCalls]), [["session", 0, 0], ["config", 0, 0]]);
	for (const row of evidence.rows) { assert.equal(row.retainedFrames, 0); assert.equal(row.retainedPreviousIdentitySet, false); assert.equal(row.retainedComponent, false); }
});
