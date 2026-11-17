import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import ts from "typescript";
import { SettingsManager } from "../packages/coding-agent/src/core/settings-manager.ts";

const MATERIALIZING_CALL = /\.map$|\.filter$|\.reduce$|\.sort$|JSON\.stringify$/;

test("occupancy lookup adds no callbacks, promises, controllers, scans or wrapper objects", () => {
	for (const [file, names] of [
		["packages/agent/src/compaction-policy.ts", ["isAutoCompactionPercentage", "getAutoCompactionThreshold"]],
		["packages/coding-agent/src/core/settings-manager.ts", ["getAutoCompactionKey", "getAutoCompactionPercentage"]],
	] as const) {
		const source = ts.createSourceFile(file, readFileSync(new URL(`../${file}`, import.meta.url), "utf8"), ts.ScriptTarget.Latest, true);
		const found = new Set<string>();
		function invariant(node: ts.Node): void {
			assert.ok(!ts.isArrowFunction(node) && !ts.isFunctionExpression(node) && !ts.isNewExpression(node));
			assert.ok(!ts.isArrayLiteralExpression(node) && !ts.isObjectLiteralExpression(node));
			if (ts.isCallExpression(node)) assert.ok(!MATERIALIZING_CALL.test(node.expression.getText(source)));
			ts.forEachChild(node, invariant);
		}
		function visit(node: ts.Node): void {
			if ((ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) && node.name && (names as readonly string[]).includes(node.name.getText(source))) {
				found.add(node.name.getText(source)); ts.forEachChild(node, invariant); return;
			}
			ts.forEachChild(node, visit);
		}
		visit(source); assert.equal(found.size, names.length);
	}
});

test("steady settings lookup reuses one identity key but reads fresh values across reload", async t => {
	const settings = SettingsManager.inMemory({ modelAutoCompactionPercentages: {} });
	let encodings = 0;
	const encode = globalThis.encodeURIComponent;
	t.mock.method(globalThis, "encodeURIComponent", (value: string) => { encodings++; return encode(value); });
	assert.equal(settings.getAutoCompactionPercentage("provider", "model"), 85);
	assert.equal(encodings, 2);
	for (let index = 0; index < 256; index++) assert.equal(settings.getAutoCompactionPercentage("provider", "model"), 85);
	assert.equal(encodings, 2);
	await settings.setAutoCompactionPercentage("provider", "model", 70);
	await settings.reload();
	assert.equal(settings.getAutoCompactionPercentage("provider", "model"), 70);
	assert.equal(encodings, 2);
	assert.equal(settings.getAutoCompactionPercentage("other-provider", "model"), 85);
	assert.equal(encodings, 4, "identity replacement happens only when the selected pair changes");
});
