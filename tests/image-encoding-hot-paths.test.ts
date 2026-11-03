import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

test("image candidate loop has no per-candidate closures, arrays, wrappers or base64 copies", () => {
	const source = ts.createSourceFile("image.ts", readFileSync(new URL("../packages/coding-agent/src/utils/image-resize-core.ts", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true);
	const functions = source.statements.filter(ts.isFunctionDeclaration);
	for (const name of ["selectEncoding", "hasTransparency"]) {
		const fn = functions.find(fn => fn.name?.text === name)!; assert.ok(fn);
		function walk(node: ts.Node) {
			assert.ok(!ts.isArrowFunction(node) && !ts.isFunctionExpression(node) && !ts.isArrayLiteralExpression(node) && !ts.isNewExpression(node));
			if (ts.isObjectLiteralExpression(node)) assert.ok(ts.isReturnStatement(node.parent), "only the accepted result owns a wrapper");
			if (ts.isCallExpression(node)) assert.ok(!/Buffer|base64|\.map|\.filter|\.push|Array\.from/.test(node.expression.getText(source)));
			ts.forEachChild(node, walk);
		}
		walk(fn.body!);
	}
	const resize = functions.find(fn => fn.name?.text === "resizeImageInProcess")!;
	let nested = 0, views = 0;
	function walkResize(node: ts.Node) {
		if (ts.isFunctionDeclaration(node) && node !== resize) nested++;
		if (ts.isCallExpression(node) && node.expression.getText(source) === "Buffer.from" && node.arguments.length === 3) views++;
		ts.forEachChild(node, walkResize);
	}
	walkResize(resize); assert.equal(nested, 0); assert.equal(views, 1);
});

test("production image encoders have bounded work and release buffers/images on success and failure", () => {
	const child = spawnSync(process.execPath, ["--expose-gc", "--experimental-strip-types", "scripts/bench/image-encoding-selection.ts", "--smoke"], { cwd: new URL("../", import.meta.url), encoding: "utf8", timeout: 60000 });
	assert.equal(child.status, 0, child.stderr || child.stdout);
	const result = JSON.parse(child.stdout);
	assert.equal(result.counters.length, 5); assert.equal(result.lifecycle.length, 5);
	for (const row of [...result.counters, ...result.lifecycle]) { assert.equal(row.retainedTemporaryObjects, 0); assert.equal(row.imagesCreated, row.imagesFreed); }
});
