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

test("Bedrock delta lookup creates no closures and argument parsing stays incremental", () => {
	const file = "packages/ai/src/api/bedrock-converse-stream.ts", text = readFileSync(file, "utf8");
	const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
	let seen = 0;
	function visit(node: ts.Node): void {
		if (ts.isFunctionDeclaration(node) && node.name?.text === "handleContentBlockDelta") {
			seen++;
			function audit(child: ts.Node): void {
				assert.equal(ts.isArrowFunction(child) || ts.isFunctionExpression(child) || ts.isAwaitExpression(child) || ts.isNewExpression(child)
					|| ts.isArrayLiteralExpression(child) || ts.isSpreadElement(child), false, child.getText(source));
				if (ts.isObjectLiteralExpression(child)) {
					const type = child.properties.find(property => ts.isPropertyAssignment(property) && property.name.getText(source) === "type");
					assert.ok(type && ts.isPropertyAssignment(type) && ts.isStringLiteral(type.initializer));
					assert.ok(["text", "thinking", "text_start", "text_delta", "toolcall_delta", "thinking_start", "thinking_delta"].includes(type.initializer.text));
				}
				if (ts.isCallExpression(child)) assert.doesNotMatch(child.expression.getText(source), /(?:parse|parseStreamingJson|findIndex|map|filter|join|stringify|then|bind)$/);
				ts.forEachChild(child, audit);
			}
			audit(node.body!); // Existing protocol events and first text/thinking block creation are explicit object exemptions.
		}
		ts.forEachChild(node, visit);
	}
	visit(source); assert.equal(seen, 1);
	assert.doesNotMatch(text, /partialJson|parseStreamingJson/);
	assert.match(text, /toolParsers\[index\]!\.append\(delta\.toolUse\.input \|\| ""\)/);
	assert.match(text, /blockPositions\.delete\(event\.contentBlockIndex!\)/);
	assert.match(text, /finally \{\s*for \(const parser of toolParsers\) parser\?\.dispose\(\);\s*toolParsers\.length = 0;\s*blockPositions\.clear\(\)/);
});

test("Chat function arguments only append new input and release owners on finalization, custom transition and error", () => {
	const file = "packages/ai/src/api/openai-completions.ts", text = readFileSync(file, "utf8");
	const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
	let seen = 0;
	function visit(node: ts.Node): void {
		if (ts.isForOfStatement(node) && node.awaitModifier && node.expression.getText(source) === "openaiStream") {
			function auditLoop(child: ts.Node): void {
				assert.equal(ts.isArrayLiteralExpression(child) || ts.isArrowFunction(child) || ts.isFunctionExpression(child) || ts.isNewExpression(child), false, child.getText(source));
				ts.forEachChild(child, auditLoop);
			}
			auditLoop(node.statement);
		}
		if (ts.isIfStatement(node) && node.expression.getText(source) === "toolCall.function?.arguments") {
			seen++;
			function audit(child: ts.Node): void {
				assert.equal(ts.isArrowFunction(child) || ts.isFunctionExpression(child) || ts.isAwaitExpression(child) || ts.isNewExpression(child)
					|| ts.isObjectLiteralExpression(child) || ts.isArrayLiteralExpression(child) || ts.isSpreadElement(child), false, child.getText(source));
				if (ts.isCallExpression(child)) assert.ok(["toolParsers.get", "toolParsers.get(block)!.append"].includes(child.expression.getText(source)), child.getText(source));
				ts.forEachChild(child, audit);
			}
			audit(node.thenStatement);
		}
		ts.forEachChild(node, visit);
	}
	visit(source); assert.equal(seen, 1);
	assert.doesNotMatch(text, /partialArgs|parseStreamingJson/);
	assert.match(text, /toolParsers\.get\(block\)!\.finalize\(\);\s*toolParsers\.delete\(block\)/);
	assert.match(text, /toolParsers\.get\(block\)!\.dispose\(\);\s*toolParsers\.delete\(block\)/);
	assert.match(text, /finally \{\s*for \(const parser of toolParsers\.values\(\)\) parser\.dispose\(\);\s*toolParsers\.clear\(\)/);
});

test("Mistral native delivery avoids scratch wrappers and releases incremental argument owners", () => {
	const file = "packages/ai/src/api/mistral-conversations.ts", text = readFileSync(file, "utf8");
	const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
	let seen = 0;
	function visit(node: ts.Node): void {
		if (ts.isIfStatement(node) && node.expression.getText(source) === "argsDelta") {
			seen++;
			function audit(child: ts.Node): void {
				assert.equal(ts.isArrowFunction(child) || ts.isFunctionExpression(child) || ts.isAwaitExpression(child) || ts.isNewExpression(child)
					|| ts.isArrayLiteralExpression(child) || ts.isSpreadElement(child), false, child.getText(source));
				if (ts.isObjectLiteralExpression(child)) assert.match(child.getText(source), /^\{\s*type: "toolcall_delta",/);
				if (ts.isCallExpression(child)) assert.ok(["toolParsers[contentIndex!]!.append", "stream.push"].includes(child.expression.getText(source)), child.getText(source));
				ts.forEachChild(child, audit);
			}
			audit(node.thenStatement);
		}
		ts.forEachChild(node, visit);
	}
	visit(source); assert.equal(seen, 1);
	assert.doesNotMatch(text, /partialArgs|parseStreamingJson|return \{ data: parsed|decoder\.decode\(value, \{/);
	assert.match(text, /return parsed as MistralCompletionEvent/);
	assert.match(text, /decoder\.decode\(value, MISTRAL_STREAM_DECODE_OPTIONS\)/);
	assert.match(text, /finally \{\s*buffer = "";\s*signal\.removeEventListener/);
	assert.match(text, /finally \{\s*for \(const parser of toolParsers\) parser\?\.dispose\(\);\s*toolParsers\.length = 0;\s*toolBlocksByKey\.clear\(\)/);
});

test("Pi Messages scans only each decoded chunk and mutates host events without wrappers", () => {
	const file = "packages/ai/src/api/pi-messages.ts", text = readFileSync(file, "utf8");
	const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
	let deltaSeen = 0, scannerSeen = 0, parseSeen = 0;
	function noControlAllocation(child: ts.Node): void {
		assert.equal(ts.isArrowFunction(child) || ts.isFunctionExpression(child) || ts.isNewExpression(child) || ts.isAwaitExpression(child)
			|| ts.isObjectLiteralExpression(child) || ts.isArrayLiteralExpression(child) || ts.isSpreadElement(child) || ts.isSpreadAssignment(child), false, child.getText(source));
		ts.forEachChild(child, noControlAllocation);
	}
	function visit(node: ts.Node): void {
		if (ts.isCaseClause(node) && node.expression.getText(source) === '"toolcall_delta"') {
			deltaSeen++; noControlAllocation(node);
			assert.doesNotMatch(node.getText(source), /JSON|parseStreamingJson|\.slice\(|\.join\(/);
		}
		if (ts.isForStatement(node) && node.condition?.getText(source) === "index < decoded.length") {
			scannerSeen++; noControlAllocation(node);
			assert.doesNotMatch(node.getText(source), /buffer\.(?:charCodeAt|indexOf|replace|slice|split)/);
		}
		if (ts.isFunctionDeclaration(node) && node.name?.text === "parsePiMessagesEvent") {
			parseSeen++; noControlAllocation(node.body!);
			assert.doesNotMatch(node.getText(source), /\.split\(|\.find\(|\.map\(/);
		}
		ts.forEachChild(node, visit);
	}
	visit(source); assert.deepEqual([deltaSeen, scannerSeen, parseSeen], [1, 1, 1]);
	assert.doesNotMatch(text, /toolJson|parseStreamingJson|\.\.\.event|buffer\.replace|decoder\.decode\(value, \{/);
	assert.match(text, /content\.arguments = event\.toolCall\.arguments/);
	assert.match(text, /finally \{\s*converter\.dispose\(\)/);
	assert.match(text, /finally \{\s*buffer = "";\s*decoded = "";[\s\S]*?reader\.cancel\(\)[\s\S]*?reader\.releaseLock\(\)/);
});

for (const provider of ["anthropic", "responses", "bedrock", "chat", "mistral", "pi-messages"]) test(`real provider counters and controlled-GC release satisfy the argument lifecycle, provider=${provider}`, { timeout: 30000 }, () => {
	const output = execFileSync(process.execPath, ["--expose-gc", "--experimental-strip-types", "scripts/bench/provider-tool-args.ts", "--smoke", ...(provider === "anthropic" ? [] : [`--${provider}`])], { encoding: "utf8", windowsHide: true, timeout: 25000 });
	const evidence = JSON.parse(output);
	assert.equal(evidence.counters.length, 3); assert.equal(evidence.lifecycle.length, 3);
	for (const row of evidence.counters) { assert.equal(row.parserPromises, 0); assert.equal(row.argumentParseCalls, provider === "pi-messages" ? 0 : 1); }
	for (const row of evidence.lifecycle) assert.equal(row.retainedParsers, 0);
});
