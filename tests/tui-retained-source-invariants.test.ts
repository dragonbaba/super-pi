import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import { getCellDimensions, setCellDimensions } from "../packages/tui/src/terminal-image.ts";

const RETAINED_PATH = "packages/tui/src/components/retained-item.ts";
const INSTRUMENTATION_PATH = "packages/tui/src/render-instrumentation.ts";
const INTERACTIVE_MODE_PATH = "packages/coding-agent/src/modes/interactive/interactive-mode.ts";
const MAIN_SCREEN_PATH = "packages/tui/src/tui-main-screen.ts";
const ALT_SCREEN_PATH = "packages/tui/src/tui-alt-screen.ts";

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
	assert.doesNotMatch(instrumentationText, /Component|string\[\]|(?:^|\s)frames?\s*:/im);
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
	const text = readFileSync(MAIN_SCREEN_PATH, "utf8");
	const source = ts.createSourceFile(MAIN_SCREEN_PATH, text, ts.ScriptTarget.Latest, true);
	const visibleRender = findMethod(source, "TuiMainScreen", "renderVisibleDocument").getText(source);
	assert.match(visibleRender, /this\.children\.length === 1[\s\S]*renderViewportTail\(width, height\)/);
	assert.match(visibleRender, /observeViewportMutations\(width\)/);
	assert.match(visibleRender, /mutation\.kind === "unsafe"/);
	assert.match(visibleRender, /mutation\.earliestChangedLine < previousStart/);
	assert.doesNotMatch(visibleRender, /previousKittyImageIds\s*=\s*new Set/);
	assert.match(visibleRender, /sourceOffset === 0[\s\S]*?\? rendered\.lines[\s\S]*?: rendered\.lines\.slice/);
	assert.doesNotMatch(visibleRender, /expectedLines|previousWindow\.slice\(shiftedRows/);
});

test("allocation hot paths keep cache hits and mutation writes allocation-free", () => {
	const retainedText = readFileSync(RETAINED_PATH, "utf8");
	const retainedSource = ts.createSourceFile(RETAINED_PATH, retainedText, ts.ScriptTarget.Latest, true);
	const itemRender = findMethod(retainedSource, "RetainedItem", "render").getText(retainedSource);
	const hitReturn = itemRender.indexOf("return this.cachedLines");
	const missKeyCreation = itemRender.indexOf("key = {");
	assert.ok(hitReturn >= 0 && missKeyCreation > hitReturn, "cache key creation must remain after the cache-hit return");
	assert.doesNotMatch(itemRender.slice(0, hitReturn), /nextKey|RetainedCacheKey\s*=\s*\{/);

	const mutation = findMethod(retainedSource, "RetainedContainer", "recordViewportMutation");
	for (const parameter of mutation.parameters) {
		assert.equal(parameter.type?.kind, ts.SyntaxKind.NumberKeyword, `${parameter.name.getText()}: primitive number`);
	}
	const mutationText = mutation.getText(retainedSource);
	assert.doesNotMatch(mutationText, /\.shift\(|\.\.\.|\{\s*\.\.\./);
	assert.match(retainedText, /viewportMutationEventRecordIndices = new Float64Array/);
	assert.doesNotMatch(retainedText, /viewportMutationEventRecords = new Array/);
});

test("Main reuses mutation tokens and Alt avoids duplicate no-op frame copies", () => {
	const mainText = readFileSync(MAIN_SCREEN_PATH, "utf8");
	assert.match(mainText, /private readonly viewportMutationTokens: unknown\[\] = \[\]/);
	assert.doesNotMatch(mainText, /childTokens\s*:/);

	const altText = readFileSync(ALT_SCREEN_PATH, "utf8");
	assert.match(altText, /let screen = nextLayout\.lines;/);
	assert.doesNotMatch(altText, /nextLayout\.lines\.slice\(\)/);
	assert.match(altText, /if \(!this\.flashes\.hasEntries\) return screen/);
	assert.doesNotMatch(altText, /:\s*\{ lines: screen, evictedImageDeletion: "" \}/);
});

test("overlay composition consumes the frame array without callback or wrapper-array allocations", () => {
	const path = "packages/tui/src/tui.ts";
	const text = readFileSync(path, "utf8");
	const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
	const composite = findMethod(source, "TuiBase", "compositeOverlays");
	let closures = 0;
	let objectLiterals = 0;
	let spreads = 0;
	const forbiddenCalls: string[] = [];
	const visit = (node: ts.Node): void => {
		if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) closures++;
		if (ts.isObjectLiteralExpression(node)) objectLiterals++;
		if (ts.isSpreadElement(node) || ts.isSpreadAssignment(node)) spreads++;
		if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
			if (["filter", "sort", "slice", "map", "flatMap"].includes(node.expression.name.text)) {
				forbiddenCalls.push(node.expression.name.text);
			}
		}
		ts.forEachChild(node, visit);
	};
	visit(composite);
	assert.equal(closures, 0);
	assert.equal(objectLiterals, 0);
	assert.equal(spreads, 0);
	assert.deepEqual(forbiddenCalls, []);
	const body = composite.getText(source);
	assert.match(body, /return lines/);
	assert.match(body, /finally[\s\S]*overlayLinesScratch\.length = 0/);
	assert.doesNotMatch(body, /const result = \[\.\.\.lines\]/);
});

test("cell dimensions keep stable isolated primitive-backed identity", () => {
	const original = { ...getCellDimensions() };
	const external = { widthPx: 11, heightPx: 22 };
	const identity = getCellDimensions();
	try {
		setCellDimensions(external);
		external.widthPx = 99;
		assert.equal(getCellDimensions(), identity);
		assert.deepEqual(getCellDimensions(), { widthPx: 11, heightPx: 22 });
		assert.equal(Object.isFrozen(getCellDimensions()), true);
	} finally {
		setCellDimensions(original);
	}
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
