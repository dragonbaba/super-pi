import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";
import { RELEASE_COMPONENT_RENDER_CACHE } from "../packages/tui/src/component-cache.ts";
import { Container, type Component, type TUI } from "../packages/tui/src/tui.ts";
import { TuiAltScreen } from "../packages/tui/src/tui-alt-screen.ts";
import { TuiMainScreen } from "../packages/tui/src/tui-main-screen.ts";
import { Editor, type EditorTheme } from "../packages/tui/src/components/editor.ts";
import { VStack } from "../packages/tui/src/components/v-stack.ts";
import type { LayoutFrame } from "../packages/tui/src/layout.ts";
import { FakeTerminal } from "./helpers/runtime-instrumentation.ts";

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
}

interface EditorTestState {
	undo(): void;
}

interface AltDiagnostics {
	layoutRoot: Component | undefined;
	currentLayout: LayoutFrame | undefined;
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

function editorMetrics(editor: Editor): EditorLayoutCacheMetrics {
	return (editor as unknown as EditorDiagnostics).getLayoutCacheMetrics();
}

function altDiagnostics(tui: TuiAltScreen): AltDiagnostics {
	return tui as unknown as AltDiagnostics;
}

function editorTestState(editor: Editor): EditorTestState {
	return editor as unknown as EditorTestState;
}

function createEditorText(lineCount = 512): string {
	const lines = new Array<string>(lineCount);
	for (let index = 0; index < lineCount; index++) {
		lines[index] = `editor-cache-line-${index} 中文 emoji 👨‍👩‍👧‍👦 combining e\u0301`;
	}
	return lines.join("\n");
}

function createNestedRoot(tui: TUI, text = createEditorText()): {
	editor: Editor;
	container: Container;
	root: VStack;
} {
	const editor = new Editor(tui, EDITOR_THEME);
	editor.focused = true;
	editor.setText(text);
	const container = new Container();
	container.addChild(editor);
	return { editor, container, root: new VStack([container]) };
}

function assertCachePrimed(editor: Editor): void {
	const metrics = editorMetrics(editor);
	assert.ok(metrics.layoutCacheSourceRecords > 0);
	assert.ok(metrics.layoutCacheLayoutRecords > 0);
	assert.ok(metrics.layoutCacheRetainedSourceCodeUnits > 0);
	assert.ok(metrics.layoutCacheRetainedLayoutLines > 0);
}

function assertCacheReleased(editor: Editor): void {
	const metrics = editorMetrics(editor);
	assert.equal(metrics.layoutCacheSourceRecords, 0);
	assert.equal(metrics.layoutCacheLayoutRecords, 0);
	assert.equal(metrics.layoutCacheRetainedSourceCodeUnits, 0);
	assert.equal(metrics.layoutCacheRetainedLayoutLines, 0);
}

function assertScratchReleased(tui: TuiAltScreen): void {
	const counts = tui.getAltLayoutRetainedReferenceCounts();
	assert.equal(counts.components, 0);
	assert.equal(counts.lines, 0);
	assert.equal(counts.sources, 0);
	assert.equal(counts.cachedRows, 0);
	assert.equal(counts.sourceCodeUnits, 0);
	assert.equal(counts.paintedCodeUnits, 0);
	assert.equal(counts.indexedComponents, 0);
	assert.equal(counts.screenRows, 0);
	assert.equal(counts.screenCodeUnits, 0);
}

class CountingRoot extends VStack {
	invalidateCalls = 0;
	releaseCalls = 0;

	override invalidate(): void {
		this.invalidateCalls++;
		super.invalidate();
	}

	[RELEASE_COMPONENT_RENDER_CACHE](): void {
		this.releaseCalls++;
	}
}

class ThrowingRoot extends VStack {
	override invalidate(): void {
		super.invalidate();
		throw new Error("fixture invalidate failure");
	}
}

class ThrowingCacheRoot extends VStack {
	[RELEASE_COMPONENT_RENDER_CACHE](): void {
		throw new Error("fixture cache release failure");
	}
}

class CountingCacheContainer extends Container {
	releaseCalls = 0;

	[RELEASE_COMPONENT_RENDER_CACHE](): void {
		this.releaseCalls++;
	}
}

class ReentrantStartContainer extends Container {
	invalidateCalls = 0;
	startError: unknown;
	private readonly tui: TuiMainScreen;

	constructor(tui: TuiMainScreen) {
		super();
		this.tui = tui;
	}

	override invalidate(): void {
		this.invalidateCalls++;
	}

	[RELEASE_COMPONENT_RENDER_CACHE](): void {
		try {
			this.tui.start();
		} catch (error) {
			this.startError = error;
		}
	}
}

function createMainEditorTree(tui: TuiMainScreen, root: Container = new Container()): {
	editor: Editor;
	editorContainer: Container;
	nestedContainer: Container;
	root: Container;
} {
	const editor = new Editor(tui, EDITOR_THEME);
	editor.focused = true;
	editor.setText(createEditorText());
	const nestedContainer = new Container();
	nestedContainer.addChild(editor);
	const editorContainer = new Container();
	editorContainer.addChild(nestedContainer);
	root.addChild(editorContainer);
	tui.addChild(root);
	return { editor, editorContainer, nestedContainer, root };
}

test("Main final dispose releases nested Editor cache while every owner remains reachable", async () => {
	const terminal = new FakeTerminal(120, 40);
	const tui = new TuiMainScreen(terminal, false);
	const tree = createMainEditorTree(tui);
	const children = tui.children;
	const baseText = tree.editor.getExpandedText();
	const paste = "retained-paste-".repeat(80);
	tree.editor.handleInput(`\x1b[200~${paste}\x1b[201~`);
	const expandedText = tree.editor.getExpandedText();
	const cursor = tree.editor.getCursor();
	tui.start();
	tui.renderNow();
	assertCachePrimed(tree.editor);

	await tui.dispose({ preserveScreen: true });
	assertCacheReleased(tree.editor);
	assert.equal(tui.children, children);
	assert.equal(tui.children[0], tree.root);
	assert.equal(tree.root.children[0], tree.editorContainer);
	assert.equal(tree.editorContainer.children[0], tree.nestedContainer);
	assert.equal(tree.nestedContainer.children[0], tree.editor);
	assert.equal(tree.editor.getExpandedText(), expandedText);
	assert.deepEqual(tree.editor.getCursor(), cursor);
	editorTestState(tree.editor).undo();
	assert.equal(tree.editor.getExpandedText(), baseText);
});

test("Main recoverable stop preserves mounted Editor cache and restart behavior", async () => {
	const terminal = new FakeTerminal(120, 40);
	const tui = new TuiMainScreen(terminal, false);
	const tree = createMainEditorTree(tui);
	tui.start();
	tui.renderNow();
	assertCachePrimed(tree.editor);
	const hitsBefore = editorMetrics(tree.editor).layoutCacheHits;

	await tui.stop({ preserveScreen: true });
	assertCachePrimed(tree.editor);
	assert.equal(tui.children[0], tree.root);
	tui.start();
	tui.renderNow();
	assert.ok(editorMetrics(tree.editor).layoutCacheHits > hitsBefore);
	await tui.dispose({ preserveScreen: true });
});

test("Main concurrent disposal releases mounted caches once and closes start reentry", async () => {
	const terminal = new FakeTerminal(120, 40);
	const tui = new TuiMainScreen(terminal, false);
	const root = new ReentrantStartContainer(tui);
	const tree = createMainEditorTree(tui, root);
	const countingRoot = new CountingCacheContainer();
	const countingNested = createMainEditorTree(tui, countingRoot);
	tui.start();
	tui.renderNow();
	assertCachePrimed(tree.editor);
	assertCachePrimed(countingNested.editor);

	const first = tui.dispose({ preserveScreen: true });
	const second = tui.dispose({ preserveScreen: true });
	assert.equal(first, second);
	await Promise.all([first, second]);
	await tui.dispose({ preserveScreen: true });
	assert.match(String(root.startError), /Cannot start a disposed TUI/);
	assert.equal(root.invalidateCalls, 0);
	assert.equal(terminal.started, false);
	assert.equal(countingRoot.releaseCalls, 1);
	assertCacheReleased(tree.editor);
	assertCacheReleased(countingNested.editor);
});

test("Main final disposal continues cache release after an earlier sibling throws", async () => {
	const tui = new TuiMainScreen(new FakeTerminal(120, 40), false);
	const throwingRoot = new ThrowingCacheRoot([]);
	tui.addChild(throwingRoot);
	const laterTree = createMainEditorTree(tui);
	tui.start();
	tui.renderNow();
	assertCachePrimed(laterTree.editor);

	await assert.rejects(tui.dispose({ preserveScreen: true }), /fixture cache release failure/);
	assertCacheReleased(laterTree.editor);
	assert.equal(tui.children[0], throwingRoot);
	assert.equal(tui.children[1], laterTree.root);
});

test("layout-root replacement releases nested Editor cache and Alt scratch immediately", async () => {
	const terminal = new FakeTerminal(120, 40);
	const tui = new TuiAltScreen(terminal, false, undefined, { mouse: false });
	const nested = createNestedRoot(tui);
	const oldRoot = nested.root;
	tui.setLayoutRoot(oldRoot);
	tui.start();
	tui.renderNow();
	assertCachePrimed(nested.editor);

	const replacement = new VStack([]);
	tui.setLayoutRoot(replacement);
	assertCacheReleased(nested.editor);
	assert.equal(altDiagnostics(tui).layoutRoot, replacement);
	assert.equal(altDiagnostics(tui).currentLayout, undefined);
	assertScratchReleased(tui);

	tui.setLayoutRoot(undefined);
	assert.equal(altDiagnostics(tui).layoutRoot, undefined);
	assertScratchReleased(tui);
	assert.equal(oldRoot.children[0], nested.container);
	await tui.dispose({ preserveScreen: true });
});

test("same layout root remains a no-op", async () => {
	const tui = new TuiAltScreen(new FakeTerminal(120, 40), false, undefined, { mouse: false });
	const nested = createNestedRoot(tui);
	const root = new CountingRoot([nested.container]);
	tui.setLayoutRoot(root);
	tui.start();
	tui.renderNow();
	assertCachePrimed(nested.editor);

	tui.setLayoutRoot(root);
	assert.equal(root.invalidateCalls, 0);
	assertCachePrimed(nested.editor);
	await tui.dispose({ preserveScreen: true });
	assert.equal(root.invalidateCalls, 0);
	assert.equal(root.releaseCalls, 1);
});

test("final dispose releases the root and Editor cache while every owner remains reachable", async () => {
	const tui = new TuiAltScreen(new FakeTerminal(120, 40), false, undefined, { mouse: false });
	const nested = createNestedRoot(tui);
	const root = nested.root;
	const editor = nested.editor;
	tui.setLayoutRoot(root);
	tui.start();
	tui.renderNow();
	assertCachePrimed(editor);

	await tui.dispose({ preserveScreen: true });
	assertCacheReleased(editor);
	assert.equal(altDiagnostics(tui).layoutRoot, undefined);
	assert.equal(altDiagnostics(tui).currentLayout, undefined);
	assertScratchReleased(tui);
	assert.equal(root.children[0], nested.container);
});

test("recoverable stop preserves the layout root and permits restart", async () => {
	const tui = new TuiAltScreen(new FakeTerminal(120, 40), false, undefined, { mouse: false });
	const nested = createNestedRoot(tui);
	tui.setLayoutRoot(nested.root);
	tui.start();
	tui.renderNow();
	assertCachePrimed(nested.editor);
	const hitsBefore = editorMetrics(nested.editor).layoutCacheHits;

	await tui.stop({ preserveScreen: true });
	assert.equal(altDiagnostics(tui).layoutRoot, nested.root);
	assertCachePrimed(nested.editor);
	tui.start();
	tui.renderNow();
	assert.equal(altDiagnostics(tui).layoutRoot, nested.root);
	assert.ok(editorMetrics(nested.editor).layoutCacheHits > hitsBefore);
	await tui.dispose({ preserveScreen: true });
});

test("concurrent and repeated dispose release mounted components exactly once", async () => {
	const tui = new TuiAltScreen(new FakeTerminal(120, 40), false, undefined, { mouse: false });
	const nested = createNestedRoot(tui);
	const root = new CountingRoot([nested.container]);
	tui.setLayoutRoot(root);
	tui.start();
	tui.renderNow();
	assertCachePrimed(nested.editor);

	const first = tui.dispose({ preserveScreen: true });
	const second = tui.dispose({ preserveScreen: true });
	assert.equal(first, second);
	await Promise.all([first, second]);
	await tui.dispose({ preserveScreen: true });
	assert.equal(root.invalidateCalls, 0);
	assert.equal(root.releaseCalls, 1);
	assertCacheReleased(nested.editor);
	assertScratchReleased(tui);
});

test("a stopped root can transfer to a new Alt owner after the old owner is disposed", async () => {
	const oldTui = new TuiAltScreen(new FakeTerminal(120, 40), false, undefined, { mouse: false });
	const nested = createNestedRoot(oldTui);
	const originalText = nested.editor.getText();
	oldTui.setLayoutRoot(nested.root);
	oldTui.start();
	oldTui.renderNow();
	await oldTui.stop({ preserveScreen: true });

	const newTerminal = new FakeTerminal(120, 40);
	const newTui = new TuiAltScreen(newTerminal, false, undefined, { mouse: false });
	newTui.setLayoutRoot(nested.root);
	newTui.start();
	newTui.renderNow();
	assertCachePrimed(nested.editor);

	await oldTui.dispose({ preserveScreen: true });
	assertCacheReleased(nested.editor);
	assert.equal(nested.editor.getText(), originalText);
	newTui.renderNow(true);
	assertCachePrimed(nested.editor);
	assert.equal(nested.editor.getText(), originalText);
	await newTui.dispose({ preserveScreen: true });
});

test("replacement and final disposal release ownership across invalidation and cache-release errors", async () => {
	const replacementTui = new TuiAltScreen(new FakeTerminal(120, 40), false, undefined, { mouse: false });
	const replacementNested = createNestedRoot(replacementTui);
	const throwingReplacementRoot = new ThrowingRoot([replacementNested.container]);
	replacementTui.setLayoutRoot(throwingReplacementRoot);
	replacementTui.start();
	replacementTui.renderNow();
	assertCachePrimed(replacementNested.editor);
	const replacement = new VStack([]);
	assert.throws(() => replacementTui.setLayoutRoot(replacement), /fixture invalidate failure/);
	assertCacheReleased(replacementNested.editor);
	assert.equal(altDiagnostics(replacementTui).layoutRoot, replacement);
	assert.equal(altDiagnostics(replacementTui).currentLayout, undefined);
	assertScratchReleased(replacementTui);
	await replacementTui.dispose({ preserveScreen: true });

	const disposeTui = new TuiAltScreen(new FakeTerminal(120, 40), false, undefined, { mouse: false });
	const disposeNested = createNestedRoot(disposeTui);
	const throwingDisposeRoot = new ThrowingCacheRoot([disposeNested.container]);
	disposeTui.setLayoutRoot(throwingDisposeRoot);
	disposeTui.start();
	disposeTui.renderNow();
	await assert.rejects(disposeTui.dispose({ preserveScreen: true }), /fixture cache release failure/);
	assertCacheReleased(disposeNested.editor);
	assert.equal(altDiagnostics(disposeTui).layoutRoot, undefined);
	assert.equal(altDiagnostics(disposeTui).currentLayout, undefined);
	assertScratchReleased(disposeTui);
});

test("lifecycle cleanup remains outside frame and recoverable-stop hot paths", async () => {
	const tuiPath = "packages/tui/src/tui.ts";
	const altPath = "packages/tui/src/tui-alt-screen.ts";
	const benchmarkPath = "scripts/bench/tui-b3-plan-gate.ts";
	const tuiText = await readFile(tuiPath, "utf-8");
	const altText = await readFile(altPath, "utf-8");
	const benchmarkText = await readFile(benchmarkPath, "utf-8");
	const altSource = ts.createSourceFile(altPath, altText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
	let setLayoutRoot: ts.MethodDeclaration | undefined;
	for (const statement of altSource.statements) {
		if (!ts.isClassDeclaration(statement) || statement.name?.text !== "TuiAltScreen") continue;
		for (const member of statement.members) {
			if (ts.isMethodDeclaration(member) && member.name.getText(altSource) === "setLayoutRoot") setLayoutRoot = member;
		}
	}
	assert.ok(setLayoutRoot);
	let forbiddenAllocations = 0;
	function visit(node: ts.Node): void {
		if (
			ts.isArrowFunction(node) ||
			ts.isFunctionExpression(node) ||
			(ts.isNewExpression(node) &&
				ts.isIdentifier(node.expression) &&
				["Map", "Set", "Promise", "AbortController"].includes(node.expression.text))
		) {
			forbiddenAllocations++;
		}
		ts.forEachChild(node, visit);
	}
	visit(setLayoutRoot);
	assert.equal(forbiddenAllocations, 0);
	assert.match(tuiText, /function releaseComponentRenderCaches\(component: Component\)/);
	assert.doesNotMatch(
		tuiText.match(/protected releaseMountedComponentsAfterDispose[\s\S]*?\n\t}\n/)?.[0] ?? "",
		/this\.invalidate\(\)/,
	);
	assert.match(tuiText, /finishDispose[\s\S]*releaseMountedComponentsAfterDispose\(\)/);
	assert.doesNotMatch(tuiText.match(/private async finishTerminalStop[\s\S]*?\n\t}\n/)?.[0] ?? "", /releaseMountedComponents/);
	const finishDispose = tuiText.match(/private async finishDispose[\s\S]*?\n\t}\n/)?.[0] ?? "";
	const disposedIndex = finishDispose.indexOf("this.disposed = true");
	const mountedReleaseIndex = finishDispose.indexOf("this.releaseMountedComponentsAfterDispose()");
	assert.ok(disposedIndex >= 0 && mountedReleaseIndex > disposedIndex);
	assert.match(altText, /releaseMountedComponentsAfterDispose[\s\S]*super\.releaseMountedComponentsAfterDispose\(\)/);
	const disposeIndex = benchmarkText.indexOf("await runtime.dispose()");
	const structuralIndex = benchmarkText.indexOf("runtime.disposedOwnerSnapshot?.()");
	const unreachableIndex = benchmarkText.indexOf("runtime = undefined", structuralIndex);
	assert.ok(disposeIndex >= 0 && structuralIndex > disposeIndex && unreachableIndex > structuralIndex);
	for (const field of [
		"disposedOwnerLayoutCacheSourceRecords",
		"disposedOwnerLayoutCacheLayoutRecords",
		"disposedOwnerRetainedSourceCodeUnits",
		"disposedOwnerRetainedLayoutLines",
		"disposedOwnerLayoutRootReferences",
		"disposedOwnerLayoutScratchReferences",
		"disposedOwnerMainChildrenRetained",
		"--editor-screen",
	]) {
		assert.match(benchmarkText, new RegExp(field));
	}
});
