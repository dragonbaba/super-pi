import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

const RETAINED_PATH = "packages/tui/src/components/retained-item.ts";
const INSTRUMENTATION_PATH = "packages/tui/src/render-instrumentation.ts";

function findMethod(source: ts.SourceFile, className: string, methodName: string): ts.MethodDeclaration {
	for (const statement of source.statements) {
		if (!ts.isClassDeclaration(statement) || statement.name?.text !== className) continue;
		for (const member of statement.members) {
			if (ts.isMethodDeclaration(member) && ts.isIdentifier(member.name) && member.name.text === methodName) return member;
		}
	}
	throw new Error(`Missing ${className}.${methodName}`);
}

test("RetainedContainer render traverses original children without per-frame history wrapper arrays", () => {
	const text = readFileSync(RETAINED_PATH, "utf8");
	const source = ts.createSourceFile(RETAINED_PATH, text, ts.ScriptTarget.Latest, true);
	const render = findMethod(source, "RetainedContainer", "render");
	const forbiddenCalls: string[] = [];
	let spreadCount = 0;
	let callbackCount = 0;
	let regexCount = 0;
	const visit = (node: ts.Node): void => {
		if (ts.isCallExpression(node)) {
			if (ts.isPropertyAccessExpression(node.expression) && ["map", "slice"].includes(node.expression.name.text)) {
				forbiddenCalls.push(node.expression.name.text);
			}
			if (ts.isPropertyAccessExpression(node.expression) && node.expression.expression.getText(source) === "Array" && node.expression.name.text === "from") {
				forbiddenCalls.push("Array.from");
			}
		}
		if (ts.isSpreadElement(node) || ts.isSpreadAssignment(node)) spreadCount++;
		if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) callbackCount++;
		if (node.kind === ts.SyntaxKind.RegularExpressionLiteral || (ts.isNewExpression(node) && node.expression.getText(source) === "RegExp")) regexCount++;
		ts.forEachChild(node, visit);
	};
	visit(render);
	assert.deepEqual(forbiddenCalls, []);
	assert.equal(spreadCount, 0);
	assert.equal(callbackCount, 0);
	assert.equal(regexCount, 0);
	assert.doesNotMatch(text, /ObjectPool/);
});
test("retained cache and instrumentation stay instance-local and retain no component or frame references", () => {
	const retainedText = readFileSync(RETAINED_PATH, "utf8");
	const instrumentationText = readFileSync(INSTRUMENTATION_PATH, "utf8");
	assert.match(retainedText, /class RetainedContainer extends Container \{\s*private readonly retainedById/);
	assert.doesNotMatch(retainedText, /^const .*new Map</m);
	assert.doesNotMatch(instrumentationText, /Component|string\[\]|frame(?:s)?\s*:/i);
	assert.doesNotMatch(instrumentationText, /ObjectPool/);
});
