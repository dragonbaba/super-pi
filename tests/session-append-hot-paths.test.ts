import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import ts from "typescript";

const source = ts.createSourceFile("session-manager.ts", readFileSync(new URL("../packages/coding-agent/src/core/session-manager.ts", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true);
const owner = source.statements.find(node => ts.isClassDeclaration(node) && node.name?.text === "SessionManager") as ts.ClassDeclaration;

test("steady session persistence has no closures, async work, transient containers or hidden history scans", () => {
	const allowed = new Set([
		"this._assertWriteReady", "this._hasConversation", "this._flushEntries", "this._persist",
		"this.fileEntries.push", "this.fileEntries.pop", "this.byId.set", "this.byId.delete",
		"JSON.stringify", "openSync", "writeFileSync", "closeSync",
	]);
	for (const name of ["_appendEntry", "_persist", "_assertWriteReady"]) {
		const method = owner.members.find(node => ts.isMethodDeclaration(node) && node.name.getText(source) === name) as ts.MethodDeclaration;
		assert.ok(method?.body, name);
		assert.equal(ts.getCombinedModifierFlags(method) & ts.ModifierFlags.Async, 0, `${name} must stay synchronous`);
		function visit(node: ts.Node): void {
			assert.equal(ts.isArrowFunction(node) || ts.isFunctionExpression(node) || ts.isFunctionDeclaration(node) || ts.isAwaitExpression(node) ||
				ts.isObjectLiteralExpression(node) || ts.isArrayLiteralExpression(node) || ts.isSpreadElement(node) ||
				ts.isForStatement(node) || ts.isForOfStatement(node) || ts.isWhileStatement(node), false, `${name}: ${node.getText(source)}`);
			if (ts.isNewExpression(node)) assert.equal(node.expression.getText(source), "Error", "only exceptional diagnostics may allocate");
			if (ts.isCallExpression(node)) {
				const target = node.expression.getText(source);
				assert.ok(allowed.has(target), `audit newly reachable helper: ${target}`);
				if (target === "this._hasConversation" || target === "this._flushEntries") {
					let parent: ts.Node | undefined = node.parent;
					while (parent && !(ts.isIfStatement(parent) && parent.expression.getText(source) === "!this.flushed")) parent = parent.parent;
					assert.ok(parent && ts.isIfStatement(parent) && node.pos >= parent.thenStatement.pos && node.end <= parent.thenStatement.end,
						`${target} must remain confined to initial flush`);
				}
			}
			ts.forEachChild(node, visit);
		}
		visit(method.body!);
	}
});

test("real JSONL append counters and controlled-GC ownership hold at 0/1000/10000 history entries", { timeout: 30000 }, () => {
	const output = execFileSync(process.execPath, ["--expose-gc", "--experimental-strip-types", "scripts/bench/session-append.ts", "--smoke"], {
		cwd: fileURLToPath(new URL("../", import.meta.url)), encoding: "utf8", windowsHide: true, timeout: 25000,
	});
	const evidence = JSON.parse(output);
	assert.deepEqual(evidence.deterministic.map((row: { history: number }) => row.history), [0, 1000, 10000]);
	assert.deepEqual(evidence.references, { failedWhileOwnerAlive: 0, failedAfterClear: 0, successWhileOwnerAlive: 1, successAfterClear: 0, finalEntryCount: 0 });
});
