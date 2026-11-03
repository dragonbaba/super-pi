import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

test("tool search does not normalize per term or join full catalog text", () => {
	const source = ts.createSourceFile("search.ts", readFileSync(new URL("../packages/tool-classification/src/index.ts", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true);
	let termLoops = 0;
	function walk(node: ts.Node) {
		if (ts.isForOfStatement(node) && node.expression.getText(source) === "terms") {
			termLoops++;
			function audit(child: ts.Node) {
				assert.ok(!ts.isArrowFunction(child) && !ts.isFunctionExpression(child) && !ts.isObjectLiteralExpression(child) && !ts.isArrayLiteralExpression(child) && !ts.isNewExpression(child) && !ts.isTemplateExpression(child));
				if (ts.isCallExpression(child)) assert.ok(!/normalize|toLowerCase|\.join/.test(child.expression.getText(source)));
				ts.forEachChild(child, audit);
			}
			audit(node.statement);
		}
		ts.forEachChild(node, walk);
	}
	walk(source); assert.equal(termLoops, 1);
	assert.ok(!source.text.includes("const haystack ="));
});
test("explicit search counts scale with catalog and release old catalog references", () => {
	const child = spawnSync(process.execPath, ["--expose-gc", "--experimental-strip-types", "scripts/bench/tool-search-ranking.ts", "--smoke"], { cwd: new URL("../", import.meta.url), encoding: "utf8", timeout: 60000 });
	assert.equal(child.status, 0, child.stderr || child.stdout);
	const evidence = JSON.parse(child.stdout);
	assert.equal(evidence.counters.length, 4); assert.equal(evidence.releases.length, 6);
	assert.deepEqual(evidence.counters[0].terms, ["export", "report", "archive"]);
	assert.deepEqual(evidence.counters[1].terms, ["検索", "ファイル"]);
	for (const row of evidence.releases) assert.equal(row.retainedCatalogObjects, 0);
});
