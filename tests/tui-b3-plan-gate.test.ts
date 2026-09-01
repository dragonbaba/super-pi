import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import { Editor, type EditorTheme } from "../packages/tui/src/components/editor.ts";
import { VStack } from "../packages/tui/src/components/v-stack.ts";
import type { TUI } from "../packages/tui/src/tui.ts";
import { TuiAltScreen } from "../packages/tui/src/tui-alt-screen.ts";
import { FakeTerminal } from "./helpers/runtime-instrumentation.ts";

interface AllocationShape {
	closures: number;
	arrayMethods: number;
	arrayLiterals: number;
	objectLiterals: number;
	mapOrSetConstructions: number;
}

interface EditorLayoutCacheMetrics {
	layoutCacheHits: number;
	layoutCacheMisses: number;
	layoutCacheValidationLineComparisons: number;
	layoutCacheSourceRecords: number;
	layoutCacheLayoutRecords: number;
	layoutCacheRejectedByCapacity: number;
	layoutCacheRetainedSourceCodeUnits: number;
	layoutCacheRetainedLayoutLines: number;
}

interface EditorDiagnostics {
	getLayoutCacheMetrics(): EditorLayoutCacheMetrics;
	resetLayoutCacheMetrics(): void;
}

interface EditorTestState {
	state: { lines: string[]; cursorLine: number; cursorCol: number };
	scrollOffset: number;
	autocompleteState: "regular" | "force" | null;
	autocompleteList: { render(width: number): string[] } | undefined;
	applyAutocompleteSuggestions(
		suggestions: { items: Array<{ value: string; label: string; description?: string }>; prefix: string },
		state: "regular" | "force",
	): void;
	clearAutocompleteUi(): void;
	undo(): void;
}

const EDITOR_THEME: EditorTheme = {
	borderColor: identity,
	selectList: {
		selectedPrefix: identity,
		selectedText: identity,
		description: identity,
		scrollInfo: identity,
		noMatch: identity,
	},
};

function identity(value: string): string {
	return value;
}

function diagnostics(editor: Editor): EditorDiagnostics {
	return editor as unknown as EditorDiagnostics;
}

function testState(editor: Editor): EditorTestState {
	return editor as unknown as EditorTestState;
}

function findMethod(source: ts.SourceFile, className: string, methodName: string): ts.MethodDeclaration {
	let found: ts.MethodDeclaration | undefined;
	function visit(node: ts.Node): void {
		if (ts.isClassDeclaration(node) && node.name?.text === className) {
			for (const member of node.members) {
				if (ts.isMethodDeclaration(member) && member.name.getText(source) === methodName) found = member;
			}
		}
		if (!found) ts.forEachChild(node, visit);
	}
	visit(source);
	assert.ok(found, `${className}.${methodName}`);
	return found;
}

function findFunction(source: ts.SourceFile, functionName: string): ts.FunctionDeclaration {
	let found: ts.FunctionDeclaration | undefined;
	function visit(node: ts.Node): void {
		if (ts.isFunctionDeclaration(node) && node.name?.text === functionName) found = node;
		if (!found) ts.forEachChild(node, visit);
	}
	visit(source);
	assert.ok(found, functionName);
	return found;
}

function allocationShape(node: ts.Node): AllocationShape {
	const shape: AllocationShape = {
		closures: 0,
		arrayMethods: 0,
		arrayLiterals: 0,
		objectLiterals: 0,
		mapOrSetConstructions: 0,
	};
	function visit(current: ts.Node): void {
		if (ts.isArrowFunction(current) || ts.isFunctionExpression(current)) shape.closures++;
		if (ts.isArrayLiteralExpression(current)) shape.arrayLiterals++;
		if (ts.isObjectLiteralExpression(current)) shape.objectLiterals++;
		if (
			ts.isNewExpression(current) &&
			ts.isIdentifier(current.expression) &&
			(current.expression.text === "Map" || current.expression.text === "Set")
		) {
			shape.mapOrSetConstructions++;
		}
		if (
			ts.isCallExpression(current) &&
			ts.isPropertyAccessExpression(current.expression) &&
			["findIndex", "map", "filter", "flatMap", "reduce"].includes(current.expression.name.text)
		) {
			shape.arrayMethods++;
		}
		ts.forEachChild(current, visit);
	}
	visit(node);
	return shape;
}

test("B3 Plan Gate records allocation shapes only for the five exact candidate leaves", () => {
	const editorPath = "packages/tui/src/components/editor.ts";
	const layoutPath = "packages/tui/src/layout.ts";
	const altPath = "packages/tui/src/tui-alt-screen.ts";
	const hStackPath = "packages/tui/src/components/h-stack.ts";
	const vStackPath = "packages/tui/src/components/v-stack.ts";
	const editor = ts.createSourceFile(editorPath, readFileSync(editorPath, "utf8"), ts.ScriptTarget.Latest, true);
	const layout = ts.createSourceFile(layoutPath, readFileSync(layoutPath, "utf8"), ts.ScriptTarget.Latest, true);
	const alt = ts.createSourceFile(altPath, readFileSync(altPath, "utf8"), ts.ScriptTarget.Latest, true);
	const hStack = ts.createSourceFile(hStackPath, readFileSync(hStackPath, "utf8"), ts.ScriptTarget.Latest, true);
	const vStack = ts.createSourceFile(vStackPath, readFileSync(vStackPath, "utf8"), ts.ScriptTarget.Latest, true);

	const editorRender = allocationShape(findMethod(editor, "Editor", "render"));
	const editorLayout = allocationShape(findMethod(editor, "Editor", "layoutText"));
	const editorLayoutBuild = allocationShape(findMethod(editor, "Editor", "buildLayoutText"));
	const editorCacheUpdate = allocationShape(findMethod(editor, "Editor", "updateLayoutCache"));
	const mouseHit = allocationShape(findFunction(layout, "getScrollViewsAt"));
	const selection = allocationShape(findMethod(alt, "TuiAltScreen", "autoScrollSelection"));
	const kitty = allocationShape(findMethod(alt, "TuiAltScreen", "prepareKittyScreen"));
	const hStackRender = allocationShape(findMethod(hStack, "HStack", "render"));
	const vStackRender = allocationShape(findMethod(vStack, "VStack", "render"));

	assert.equal(editorRender.closures, 0);
	assert.equal(editorRender.arrayMethods, 0);
	assert.equal(editorRender.mapOrSetConstructions, 0);
	assert.equal(editorLayout.closures, 0);
	assert.equal(editorLayout.arrayMethods, 0);
	assert.equal(editorLayout.objectLiterals, 0);
	assert.equal(editorLayout.mapOrSetConstructions, 0);
	assert.equal(editorCacheUpdate.closures, 0);
	assert.equal(editorCacheUpdate.arrayMethods, 0);
	assert.equal(editorCacheUpdate.objectLiterals, 0);
	assert.equal(editorCacheUpdate.mapOrSetConstructions, 0);
	assert.ok(editorLayoutBuild.arrayLiterals >= 1);
	assert.ok(mouseHit.closures >= 3);
	assert.ok(mouseHit.objectLiterals >= 1);
	assert.equal(selection.closures, 0);
	assert.equal(selection.arrayMethods, 0);
	assert.ok(kitty.closures >= 1);
	assert.ok(kitty.mapOrSetConstructions >= 1);
	assert.ok(hStackRender.closures >= 4);
	assert.ok(vStackRender.closures >= 2);
});

test("B3 lifecycle allocation fixture exercises production render-time root replacement", () => {
	const result = spawnSync(
		process.execPath,
		[
			"--experimental-strip-types",
			"scripts/bench/tui-b3-plan-gate.ts",
			"--candidate",
			"root-replacement",
			"--warmup",
			"2",
			"--measured",
			"8",
		],
		{ encoding: "utf8" },
	);
	assert.equal(result.status, 0, result.stderr);
	const output = JSON.parse(result.stdout) as {
		candidate: string;
		metrics: Record<string, number>;
	};
	assert.equal(output.candidate, "root-replacement");
	assert.equal(output.metrics.rootReplacementFrames, 8);
	assert.equal(output.metrics.detachedBoxCaches, 0);
	assert.equal(output.metrics.currentLayoutScratchReferences, 0);
	assert.equal(output.metrics.frameWrites, 8);
	assert.equal(output.metrics.disposedOwnerDetachedBoxCaches, 0);
	assert.equal(output.metrics.disposedOwnerLayoutRootReferences, 0);
	assert.equal(output.metrics.disposedOwnerLayoutScratchReferences, 0);
});

test("Editor layout and paste-registry ownership remain private and generation-aware", () => {
	const editorPath = "packages/tui/src/components/editor.ts";
	const source = ts.createSourceFile(editorPath, readFileSync(editorPath, "utf8"), ts.ScriptTarget.Latest, true);
	let editorClass: ts.ClassDeclaration | undefined;
	for (const statement of source.statements) {
		if (ts.isClassDeclaration(statement) && statement.name?.text === "Editor") editorClass = statement;
	}
	assert.ok(editorClass);

	const methods = new Map<string, ts.MethodDeclaration>();
	let pasteGeneration: ts.PropertyDeclaration | undefined;
	for (const member of editorClass.members) {
		if (ts.isMethodDeclaration(member)) methods.set(member.name.getText(source), member);
		if (ts.isPropertyDeclaration(member) && member.name.getText(source) === "pasteLayoutGeneration") {
			pasteGeneration = member;
		}
	}
	for (const methodName of ["buildLayoutText", "getLayoutCacheMetrics", "resetLayoutCacheMetrics"]) {
		const method = methods.get(methodName);
		assert.ok(method, methodName);
		assert.ok(method.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.PrivateKeyword), `${methodName} private`);
	}
	assert.equal(pasteGeneration?.type?.kind, ts.SyntaxKind.NumberKeyword);

	const mutations: string[] = [];
	for (const [methodName, method] of methods) {
		function visit(node: ts.Node): void {
			if (
				ts.isCallExpression(node) &&
				ts.isPropertyAccessExpression(node.expression) &&
				ts.isPropertyAccessExpression(node.expression.expression) &&
				node.expression.expression.expression.kind === ts.SyntaxKind.ThisKeyword &&
				node.expression.expression.name.text === "pastes" &&
				["set", "delete", "clear"].includes(node.expression.name.text)
			) {
				mutations.push(`${methodName}:${node.expression.name.text}`);
			}
			if (
				ts.isBinaryExpression(node) &&
				node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
				ts.isPropertyAccessExpression(node.left) &&
				node.left.expression.kind === ts.SyntaxKind.ThisKeyword &&
				node.left.name.text === "pastes"
			) {
				mutations.push(`${methodName}:assign`);
			}
			ts.forEachChild(node, visit);
		}
		visit(method);
	}
	assert.deepEqual(mutations.sort(), ["clearPastes:clear", "deletePaste:delete", "replacePastes:assign", "setPaste:set"]);
	for (const helperName of ["setPaste", "deletePaste", "clearPastes", "replacePastes"]) {
		const shape = allocationShape(methods.get(helperName)!);
		assert.equal(shape.closures, 0, `${helperName} closures`);
		assert.equal(shape.objectLiterals, 0, `${helperName} wrappers`);
		assert.equal(shape.mapOrSetConstructions, 0, `${helperName} Map/Set`);
	}
});

class CountingEditor extends Editor {
	renderCalls = 0;

	override render(width: number): string[] {
		this.renderCalls++;
		return super.render(width);
	}
}

class CountingVStack extends VStack {
	directRenderCalls = 0;

	override render(width: number): string[] {
		this.directRenderCalls++;
		return super.render(width);
	}
}

test("real Alt frames render Editor but bypass direct VStack.render", async () => {
	const terminal = new FakeTerminal(120, 40);
	const tui = new TuiAltScreen(terminal, false, undefined, { mouse: false });
	const editor = new CountingEditor(tui, EDITOR_THEME);
	editor.focused = true;
	editor.setText("A wrapped editor line with 中文, emoji 👨‍👩‍👧‍👦, and combining e\u0301. ".repeat(6));
	const root = new CountingVStack([editor]);
	tui.setLayoutRoot(root);
	tui.start();
	tui.renderNow();
	const firstEditorCalls = editor.renderCalls;
	tui.renderNow();
	assert.equal(editor.renderCalls, firstEditorCalls + 1);
	assert.equal(root.directRenderCalls, 0);
	await tui.dispose({ preserveScreen: true });
});

test("Editor layout cache preserves fresh-render output and releases oversized state", () => {
	const candidateTerminal = new FakeTerminal(120, 40);
	const referenceTerminal = new FakeTerminal(120, 40);
	const candidateTui = { terminal: candidateTerminal, requestRender(): void {} };
	const referenceTui = { terminal: referenceTerminal, requestRender(): void {} };
	const candidate = new Editor(candidateTui as unknown as TUI, EDITOR_THEME);
	const reference = new Editor(referenceTui as unknown as TUI, EDITOR_THEME);
	candidate.focused = true;
	reference.focused = true;

	function compare(width: number): void {
		reference.invalidate();
		assert.deepEqual(candidate.render(width), reference.render(width));
	}

	const initial = "English words 中文 👨‍👩‍👧‍👦 e\u0301 and a long wrapped tail. ".repeat(8);
	candidate.setText(initial);
	reference.setText(initial);
	compare(120);
	diagnostics(candidate).resetLayoutCacheMetrics();
	compare(120);
	assert.equal(diagnostics(candidate).getLayoutCacheMetrics().layoutCacheHits, 1);

	candidate.handleInput("\x1b[D");
	reference.handleInput("\x1b[D");
	compare(120);
	compare(80);
	candidate.setPaddingX(2);
	reference.setPaddingX(2);
	compare(80);
	candidateTerminal.rows = 60;
	referenceTerminal.rows = 60;
	compare(80);
	candidate.invalidate();
	compare(80);

	const largePaste = "p".repeat(1_001);
	candidate.handleInput(`\x1b[200~${largePaste}\x1b[201~`);
	reference.handleInput(`\x1b[200~${largePaste}\x1b[201~`);
	compare(120);
	const markerText = candidate.getText();
	candidate.setText(markerText);
	reference.setText(markerText);
	const missesBeforeMarkerReset = diagnostics(candidate).getLayoutCacheMetrics().layoutCacheMisses;
	compare(120);
	assert.equal(diagnostics(candidate).getLayoutCacheMetrics().layoutCacheMisses, missesBeforeMarkerReset + 1);

	const oversized = "x".repeat(512 * 1_024 + 1);
	candidate.setText(oversized);
	candidate.render(120);
	const oversizedMetrics = diagnostics(candidate).getLayoutCacheMetrics();
	assert.equal(oversizedMetrics.layoutCacheSourceRecords, 0);
	assert.equal(oversizedMetrics.layoutCacheRetainedSourceCodeUnits, 0);
	assert.equal(oversizedMetrics.layoutCacheLayoutRecords, 0);
	assert.equal(oversizedMetrics.layoutCacheRejectedByCapacity, 1);
	candidate.setText("small");
	candidate.render(120);
	assert.equal(diagnostics(candidate).getLayoutCacheMetrics().layoutCacheRetainedSourceCodeUnits, 5);
	candidate.invalidate();
	assert.equal(diagnostics(candidate).getLayoutCacheMetrics().layoutCacheSourceRecords, 0);
	assert.equal(diagnostics(candidate).getLayoutCacheMetrics().layoutCacheLayoutRecords, 0);
});

test("Editor layout caches are instance-local and a miss in one editor cannot invalidate another", () => {
	const firstTerminal = new FakeTerminal(120, 40);
	const secondTerminal = new FakeTerminal(120, 40);
	const first = new Editor({ terminal: firstTerminal, requestRender(): void {} } as unknown as TUI, EDITOR_THEME);
	const second = new Editor({ terminal: secondTerminal, requestRender(): void {} } as unknown as TUI, EDITOR_THEME);
	first.setText("first editor content ".repeat(20));
	second.setText("second editor content ".repeat(20));
	first.render(120);
	second.render(120);
	diagnostics(first).resetLayoutCacheMetrics();
	diagnostics(second).resetLayoutCacheMetrics();
	first.handleInput("x");
	first.render(120);
	second.render(120);
	assert.equal(diagnostics(first).getLayoutCacheMetrics().layoutCacheMisses, 1);
	assert.equal(diagnostics(first).getLayoutCacheMetrics().layoutCacheHits, 0);
	assert.equal(diagnostics(second).getLayoutCacheMetrics().layoutCacheHits, 1);
	assert.equal(diagnostics(second).getLayoutCacheMetrics().layoutCacheMisses, 0);
});

test("Editor render owns its outer lines and never exposes cached layout records", () => {
	const terminal = new FakeTerminal(120, 40);
	const editor = new Editor({ terminal, requestRender(): void {} } as unknown as TUI, EDITOR_THEME);
	editor.focused = true;
	editor.setText("caller-owned output with 中文 and emoji 😀 ".repeat(8));
	const first = editor.render(120);
	const expected = editor.render(120);
	first[0] = "tampered";
	first.length = 1;
	const next = editor.render(120);
	assert.notStrictEqual(first, next);
	assert.deepEqual(next, expected);
	const metricValues = Object.values(diagnostics(editor).getLayoutCacheMetrics());
	assert.ok(metricValues.every((value) => typeof value === "number"));
});

test("Editor layout validation is linear through 4096 source lines and rejects larger inputs", () => {
	for (const lineCount of [1, 256, 4_096]) {
		const terminal = new FakeTerminal(120, 40);
		const editor = new Editor({ terminal, requestRender(): void {} } as unknown as TUI, EDITOR_THEME);
		const lines = new Array<string>(lineCount);
		for (let index = 0; index < lineCount; index++) lines[index] = `line-${index}`;
		editor.setText(lines.join("\n"));
		editor.render(120);

		const editorState = testState(editor);
		const editorDiagnostics = diagnostics(editor);
		editorDiagnostics.resetLayoutCacheMetrics();
		editor.render(120);
		let metrics = editorDiagnostics.getLayoutCacheMetrics();
		assert.equal(metrics.layoutCacheHits, 1);
		assert.equal(metrics.layoutCacheValidationLineComparisons, lineCount);
		assert.equal(metrics.layoutCacheSourceRecords, lineCount);

		editorState.state.lines = editorState.state.lines.slice();
		editorDiagnostics.resetLayoutCacheMetrics();
		editor.render(120);
		metrics = editorDiagnostics.getLayoutCacheMetrics();
		assert.equal(metrics.layoutCacheHits, 1, `${lineCount} copied array`);
		assert.equal(metrics.layoutCacheValidationLineComparisons, lineCount);

		const equalValues = new Array<string>(lineCount);
		for (let index = 0; index < lineCount; index++) equalValues[index] = `line-${index}`;
		editorState.state.lines = equalValues;
		editorDiagnostics.resetLayoutCacheMetrics();
		editor.render(120);
		metrics = editorDiagnostics.getLayoutCacheMetrics();
		assert.equal(metrics.layoutCacheHits, 1, `${lineCount} equal values`);
		assert.equal(metrics.layoutCacheValidationLineComparisons, lineCount);

		const middle = Math.floor(lineCount / 2);
		const original = editorState.state.lines[middle]!;
		editorState.state.lines[middle] = `${original}-changed`;
		editorDiagnostics.resetLayoutCacheMetrics();
		editor.render(120);
		metrics = editorDiagnostics.getLayoutCacheMetrics();
		assert.equal(metrics.layoutCacheMisses, 1);
		assert.ok(metrics.layoutCacheValidationLineComparisons <= middle + 1);

		editorState.state.lines[middle] = original;
		editorDiagnostics.resetLayoutCacheMetrics();
		editor.render(120);
		metrics = editorDiagnostics.getLayoutCacheMetrics();
		assert.equal(metrics.layoutCacheMisses, 1, `${lineCount} restored source`);
		editorDiagnostics.resetLayoutCacheMetrics();
		editor.render(120);
		metrics = editorDiagnostics.getLayoutCacheMetrics();
		assert.equal(metrics.layoutCacheHits, 1);
		assert.equal(metrics.layoutCacheValidationLineComparisons, lineCount);
	}

	const terminal = new FakeTerminal(120, 40);
	const oversized = new Editor({ terminal, requestRender(): void {} } as unknown as TUI, EDITOR_THEME);
	const oversizedLines = new Array<string>(4_097);
	for (let index = 0; index < oversizedLines.length; index++) oversizedLines[index] = `line-${index}`;
	oversized.setText(oversizedLines.join("\n"));
	diagnostics(oversized).resetLayoutCacheMetrics();
	oversized.render(120);
	const oversizedMetrics = diagnostics(oversized).getLayoutCacheMetrics();
	assert.equal(oversizedMetrics.layoutCacheRejectedByCapacity, 1);
	assert.equal(oversizedMetrics.layoutCacheSourceRecords, 0);
	assert.equal(oversizedMetrics.layoutCacheLayoutRecords, 0);
	assert.equal(oversizedMetrics.layoutCacheRetainedSourceCodeUnits, 0);
});

test("Editor layout key misses only for layout dependencies", () => {
	const candidateTerminal = new FakeTerminal(120, 40);
	const referenceTerminal = new FakeTerminal(120, 40);
	const candidate = new Editor({ terminal: candidateTerminal, requestRender(): void {} } as unknown as TUI, EDITOR_THEME);
	const reference = new Editor({ terminal: referenceTerminal, requestRender(): void {} } as unknown as TUI, EDITOR_THEME);
	const source = new Array<string>(100);
	for (let index = 0; index < source.length; index++) source[index] = `layout dependency line ${index}`;
	candidate.setText(source.join("\n"));
	reference.setText(source.join("\n"));
	candidate.render(120);
	reference.render(120);

	function expectHit(width: number): void {
		diagnostics(candidate).resetLayoutCacheMetrics();
		reference.invalidate();
		assert.deepEqual(candidate.render(width), reference.render(width));
		assert.equal(diagnostics(candidate).getLayoutCacheMetrics().layoutCacheHits, 1);
	}

	candidateTerminal.rows = 60;
	referenceTerminal.rows = 60;
	expectHit(120);
	candidate.focused = true;
	reference.focused = true;
	expectHit(120);
	const wrappedBorder = (value: string): string => `<${value}>`;
	candidate.borderColor = wrappedBorder;
	reference.borderColor = wrappedBorder;
	expectHit(120);
	testState(candidate).applyAutocompleteSuggestions({ items: [{ value: "choice", label: "choice" }], prefix: "" }, "regular");
	testState(reference).applyAutocompleteSuggestions({ items: [{ value: "choice", label: "choice" }], prefix: "" }, "regular");
	expectHit(120);
	testState(candidate).clearAutocompleteUi();
	testState(reference).clearAutocompleteUi();
	expectHit(120);
	testState(candidate).scrollOffset = 90;
	testState(reference).scrollOffset = 90;
	expectHit(120);

	function expectMiss(width: number): void {
		diagnostics(candidate).resetLayoutCacheMetrics();
		reference.invalidate();
		assert.deepEqual(candidate.render(width), reference.render(width));
		assert.equal(diagnostics(candidate).getLayoutCacheMetrics().layoutCacheMisses, 1);
	}

	candidate.handleInput("x");
	reference.handleInput("x");
	expectMiss(120);
	candidate.handleInput("\x1b[D");
	reference.handleInput("\x1b[D");
	expectMiss(120);
	expectMiss(80);
	candidate.setPaddingX(2);
	reference.setPaddingX(2);
	expectMiss(80);
	const paste = "p".repeat(1_001);
	candidate.handleInput(`\x1b[200~${paste}\x1b[201~`);
	reference.handleInput(`\x1b[200~${paste}\x1b[201~`);
	expectMiss(120);
	testState(candidate).undo();
	testState(reference).undo();
	expectMiss(120);
	candidate.invalidate();
	reference.invalidate();
	expectMiss(120);
});

test("Editor retains stable cursor layout across transient cursor frames", () => {
	const candidateTerminal = new FakeTerminal(120, 40);
	const referenceTerminal = new FakeTerminal(120, 40);
	const candidate = new Editor({ terminal: candidateTerminal, requestRender(): void {} } as unknown as TUI, EDITOR_THEME);
	const reference = new Editor({ terminal: referenceTerminal, requestRender(): void {} } as unknown as TUI, EDITOR_THEME);
	candidate.setText("stable cursor layout");
	reference.setText("stable cursor layout");
	assert.deepEqual(candidate.render(120), reference.render(120));
	const initialCursorCol = testState(candidate).state.cursorCol;
	diagnostics(candidate).resetLayoutCacheMetrics();

	for (const cursorCol of [initialCursorCol - 1, initialCursorCol - 2]) {
		testState(candidate).state.cursorCol = cursorCol;
		testState(reference).state.cursorCol = cursorCol;
		reference.invalidate();
		assert.deepEqual(candidate.render(120), reference.render(120));
	}
	assert.equal(diagnostics(candidate).getLayoutCacheMetrics().layoutCacheMisses, 2);

	testState(candidate).state.cursorCol = initialCursorCol;
	testState(reference).state.cursorCol = initialCursorCol;
	reference.invalidate();
	assert.deepEqual(candidate.render(120), reference.render(120));
	assert.equal(diagnostics(candidate).getLayoutCacheMetrics().layoutCacheHits, 1);

	diagnostics(candidate).resetLayoutCacheMetrics();
	for (let frame = 0; frame < 3; frame++) {
		testState(candidate).state.cursorCol = initialCursorCol - 3;
		testState(reference).state.cursorCol = initialCursorCol - 3;
		reference.invalidate();
		assert.deepEqual(candidate.render(120), reference.render(120));
	}
	const promotedMetrics = diagnostics(candidate).getLayoutCacheMetrics();
	assert.equal(promotedMetrics.layoutCacheMisses, 2);
	assert.equal(promotedMetrics.layoutCacheHits, 1);
});
