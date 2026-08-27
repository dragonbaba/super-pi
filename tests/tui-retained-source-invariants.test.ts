import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

const RETAINED_PATH = "packages/tui/src/components/retained-item.ts";
const INSTRUMENTATION_PATH = "packages/tui/src/render-instrumentation.ts";
const INTERACTIVE_MODE_PATH = "packages/coding-agent/src/modes/interactive/interactive-mode.ts";

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
	assert.match(
		retainedText,
		/class RetainedContainer extends Container implements LineViewportComponent \{[\s\S]*?private readonly retainedById/,
	);
	assert.doesNotMatch(retainedText, /^const .*new Map</m);
	assert.doesNotMatch(instrumentationText, /Component|string\[\]|frame(?:s)?\s*:/i);
	assert.doesNotMatch(instrumentationText, /ObjectPool/);
});

test("viewport hot paths avoid full-history wrapper copies and global ownership", () => {
	const retainedText = readFileSync(RETAINED_PATH, "utf8");
	const viewportText = readFileSync("packages/tui/src/components/viewport-container.ts", "utf8");
	const source = ts.createSourceFile(RETAINED_PATH, retainedText, ts.ScriptTarget.Latest, true);
	for (const methodName of ["renderViewport", "renderViewportTail", "composeViewport"]) {
		const method = findMethod(source, "RetainedContainer", methodName).getText(source);
		assert.doesNotMatch(method, /\.map\(|Array\.from\(|\.\.\.|\.slice\(|\.indexOf\(|\.findIndex\(/);
	}
	const prepare = findMethod(source, "RetainedContainer", "prepareViewportIndex").getText(source);
	assert.doesNotMatch(prepare, /new Map|viewportRecords\s*=|viewportRecordByComponent\.(?:clear|set)/);
	const totalHeight = findMethod(source, "RetainedContainer", "totalViewportHeight").getText(source);
	assert.doesNotMatch(totalHeight, /for\s*\(|while\s*\(|\.reduce\(/);
	assert.match(totalHeight, /return this\.viewportTotalHeight/);
	assert.doesNotMatch(viewportText, /^const .*new (?:Map|Set)/m);
	assert.doesNotMatch(`${retainedText}\n${viewportText}`, /ObjectPool|Proxy\s*\(/);
});

test("Main bounded frames use explicit mutation attribution and the singleton tail query", () => {
	const mainPath = "packages/tui/src/tui-main-screen.ts";
	const text = readFileSync(mainPath, "utf8");
	const source = ts.createSourceFile(mainPath, text, ts.ScriptTarget.Latest, true);
	const visibleRender = findMethod(source, "TuiMainScreen", "renderVisibleDocument").getText(source);
	assert.match(visibleRender, /this\.children\.length === 1[\s\S]*renderViewportTail\(width, height\)/);
	assert.match(visibleRender, /observeViewportMutations\(width\)/);
	assert.match(visibleRender, /mutation\.kind === "unsafe"/);
	assert.match(visibleRender, /mutation\.earliestChangedLine < previousStart/);
	assert.doesNotMatch(visibleRender, /previousKittyImageIds\s*=\s*new Set/);
});

test("every production transcript splice notifies the structure index", () => {
	const text = readFileSync(INTERACTIVE_MODE_PATH, "utf8");
	const spliceMatches = [...text.matchAll(/chatContainer\.children\.splice/g)];
	assert.equal(spliceMatches.length, 1);
	for (const match of spliceMatches) {
		const following = text.slice(match.index, match.index + 240);
		assert.match(following, /chatContainer\.notifyChildrenChanged\(\)/);
	}
	assert.match(text, /replaceToolPlaceholder[\s\S]{0,180}chatContainer\.notifyChildrenChanged\(\)/);
});

test("production dynamic status and image setting mutations notify viewport heights", () => {
	const text = readFileSync(INTERACTIVE_MODE_PATH, "utf8");
	assert.match(text, /lastStatusText\.setText[\s\S]{0,160}invalidateViewportChild\(this\.lastStatusText\)/);
	for (const callback of ["onShowImagesChange", "onImageWidthCellsChange"]) {
		const start = text.indexOf(`${callback}:`);
		assert.notEqual(start, -1);
		const following = text.slice(start, start + 700);
		assert.match(following, /chatContainer\.invalidateViewportHeights\(\)/);
	}
});

test("session rebuild retains tools and reuses one visual invalidation callback", () => {
	const text = readFileSync(INTERACTIVE_MODE_PATH, "utf8");
	const source = ts.createSourceFile(INTERACTIVE_MODE_PATH, text, ts.ScriptTarget.Latest, true);
	const rebuild = findMethod(source, "InteractiveMode", "renderSessionItems").getText(source);
	assert.match(rebuild, /retainActiveToolComponent\(rebuildReadGroup, content\.id\)/);
	assert.match(rebuild, /retainActiveToolComponent\(component, content\.id\)/);
	assert.doesNotMatch(rebuild, /chatContainer\.addChild\((?:rebuildReadGroup|component)\)/);
	assert.match(text, /private readonly invalidateRetainedToolVisual = \(component: ToolExecutionComponent\)/);
	assert.equal(text.match(/onVisualInvalidate: this\.invalidateRetainedToolVisual/g)?.length, 1);
	assert.equal(text.match(/chatContainer\.children\.splice/g)?.length, 1);
	assert.match(text, /chatContainer\.children\.splice[\s\S]{0,160}chatContainer\.notifyChildrenChanged\(\)/);
	assert.match(text, /replaceToolPlaceholder[\s\S]{0,160}chatContainer\.notifyChildrenChanged\(\)/);
});
