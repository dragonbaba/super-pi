import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

test("incremental argument delivery creates no asynchronous control, delta containers or history reparse", () => {
	const file = "packages/ai/src/utils/incremental-tool-arguments.ts", source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
	const targets = new Set(["append", "delimiter", "hex", "scalar", "selectSlot", "place", "valueEnded", "structural", "appendString", "readString", "continueEscape", "readScalar"]), seen = new Set<string>();
	// Exact exemptions: instance construction, openContainer (JSON node + active frame),
	// defineMember (__proto__ descriptor), closedParser (fatal misuse), terminal getAppendDelta/finalize/dispose/diagnostics.
	function visit(node: ts.Node): void {
		if ((ts.isMethodDeclaration(node) || ts.isFunctionDeclaration(node)) && node.name && node.body && targets.has(node.name.getText(source))) {
			seen.add(node.name.getText(source));
			function audit(child: ts.Node): void {
				assert.equal(ts.isArrowFunction(child) || ts.isFunctionExpression(child) || ts.isFunctionDeclaration(child) || ts.isAwaitExpression(child)
					|| ts.isObjectLiteralExpression(child) || ts.isArrayLiteralExpression(child) || ts.isNewExpression(child) || ts.isSpreadElement(child), false, child.getText(source));
				if (ts.isCallExpression(child)) assert.doesNotMatch(child.expression.getText(source), /(?:JSON\.(?:parse|stringify)|parseStreamingJson|repairJson|\.map|\.filter|\.join|\.then|\.catch|\.finally|\.bind)$/);
				ts.forEachChild(child, audit);
			}
			audit(node.body);
		}
		ts.forEachChild(node, visit);
	}
	visit(source); assert.deepEqual(seen, targets);
	const adapter = readFileSync("packages/ai/src/api/anthropic-messages.ts", "utf8");
	assert.doesNotMatch(adapter, /partialJson|parseStreamingJson/);
	assert.match(adapter, /toolParsers\[index\]!\.append\(event\.delta\.partial_json\)/);
	assert.match(adapter, /finally \{\s*for \(const parser of toolParsers\) parser\?\.dispose\(\);\s*toolParsers\.length = 0/);
});

test("Responses ordinary function delta only appends new input and publishes its numeric generation", () => {
	const file = "packages/ai/src/api/openai-responses-shared.ts", text = readFileSync(file, "utf8");
	const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
	let seen = 0;
	function visit(node: ts.Node): void {
		if (ts.isIfStatement(node) && node.expression.getText(source) === 'event.type === "response.function_call_arguments.delta"') {
			seen++;
			function audit(child: ts.Node): void {
				assert.equal(ts.isArrowFunction(child) || ts.isFunctionExpression(child) || ts.isAwaitExpression(child) || ts.isNewExpression(child)
					|| ts.isObjectLiteralExpression(child) || ts.isArrayLiteralExpression(child) || ts.isSpreadElement(child), false, child.getText(source));
				if (ts.isCallExpression(child)) assert.ok(["getSlot", "slot.parser.append", "pushToolCallDelta"].includes(child.expression.getText(source)), child.getText(source));
				ts.forEachChild(child, audit);
			}
			audit(node.thenStatement);
		}
		ts.forEachChild(node, visit);
	}
	visit(source); assert.equal(seen, 1);
	assert.doesNotMatch(text, /partialJson|parseStreamingJson/);
	assert.match(text, /slot\.parser\.finalize\(item\.arguments \|\| undefined\)/);
	assert.match(text, /finally \{\s*for \(const slot of outputSlots\.values\(\)\)[\s\S]*?slot\.parser\?\.dispose\(\)/);
	assert.match(text, /outputSlots\.clear\(\)/);
});

for (const responses of [false, true]) test(`real provider counters and controlled-GC release satisfy the argument lifecycle, responses=${responses}`, { timeout: 30000 }, () => {
	const output = execFileSync(process.execPath, ["--expose-gc", "--experimental-strip-types", "scripts/bench/provider-tool-args.ts", "--smoke", ...(responses ? ["--responses"] : [])], { encoding: "utf8", windowsHide: true, timeout: 25000 });
	const evidence = JSON.parse(output);
	assert.equal(evidence.counters.length, 3); assert.equal(evidence.lifecycle.length, 3);
	for (const row of evidence.counters) { assert.equal(row.parserPromises, 0); assert.equal(row.argumentParseCalls, 1); }
	for (const row of evidence.lifecycle) assert.equal(row.retainedParsers, 0);
});
