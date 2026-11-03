import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import ts from "typescript";

test("exec output and its wait helper have stable callbacks and no per-chunk async/container/history work", () => {
	// forceKill invokes the cached platform stop Promise once at cancellation/root exit.
	// Exact asynchronous exemptions: execCommand admission/finally, WindowsShellJob.spawn/close,
	// stopOwnedProcessGroup and ExtensionExecOwner.exec/drain. No normal output callback is exempt.
	const targets = new Set(["onStdoutData", "onStderrData", "takeWithinCap", "forceKill", "killProcess", "onRootExit", "cancelled", "onData", "armIdleTimer", "cleanup", "finalize", "onIdle", "onExit", "onClose", "onError", "onSpawn", "onStdoutEnd", "onStderrEnd", "maybeFinalizeAfterExit"]);
	const seen = new Set<string>();
	for (const path of ["packages/coding-agent/src/core/exec.ts", "packages/coding-agent/src/utils/child-process.ts"]) {
		const source = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true);
		function visit(node: ts.Node): void {
			if (ts.isVariableDeclaration(node) && targets.has(node.name.getText(source)) && node.initializer && ts.isArrowFunction(node.initializer)) {
				seen.add(node.name.getText(source));
				assert.equal(ts.getCombinedModifierFlags(node.initializer) & ts.ModifierFlags.Async, 0);
				function audit(child: ts.Node): void {
					assert.equal(ts.isArrowFunction(child) || ts.isFunctionExpression(child) || ts.isFunctionDeclaration(child) || ts.isAwaitExpression(child)
						|| ts.isObjectLiteralExpression(child) || ts.isArrayLiteralExpression(child) || ts.isNewExpression(child) || ts.isSpreadElement(child), false, child.getText(source));
					if (ts.isCallExpression(child) && ts.isPropertyAccessExpression(child.expression)) {
						assert.ok(!["then", "catch", "finally", "bind", "map", "filter", "join", "toString", "stringify", "concat"].includes(child.expression.name.text), child.getText(source));
					}
					ts.forEachChild(child, audit);
				}
				audit(node.initializer.body);
			}
			ts.forEachChild(node, visit);
		}
		visit(source);
	}
	assert.deepEqual(seen, targets);
	const exec = readFileSync("packages/coding-agent/src/core/exec.ts", "utf8");
	assert.doesNotMatch(exec, /proc\.killed|new Promise|\.then\(|\.catch\(/);
	assert.match(exec, /stdout = ""; stderr = "";\s*return result/);
});

test("exec delivery counters and GC release hold through completion, cap, cancellation and error", { timeout: 30000 }, () => {
	const output = execFileSync(process.execPath, ["--expose-gc", "--experimental-strip-types", "scripts/bench/extension-exec-output.ts", "--smoke"], {
		cwd: fileURLToPath(new URL("../", import.meta.url)), encoding: "utf8", windowsHide: true, timeout: 25000,
	});
	const evidence = JSON.parse(output);
	assert.equal(evidence.deterministic.length, 3); assert.equal(evidence.references.length, 4);
	assert.equal(evidence.runtimeReferences.length, 2);
	for (const row of evidence.references) assert.equal(row.dataListeners, 0);
});
