import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";
import { RELEASE_COMPONENT_RENDER_CACHE } from "../packages/tui/src/component-cache.ts";
import { Container, type Component, type TUI } from "../packages/tui/src/tui.ts";
import { TuiAltScreen } from "../packages/tui/src/tui-alt-screen.ts";
import { TuiMainScreen } from "../packages/tui/src/tui-main-screen.ts";
import { Box } from "../packages/tui/src/components/box.ts";
import { Editor, type EditorTheme } from "../packages/tui/src/components/editor.ts";
import {
	RetainedContainer,
	RetainedItem,
	type RetainedViewportLifecycleReferenceCounts,
} from "../packages/tui/src/components/retained-item.ts";
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

interface BoxDiagnostics {
	cache: unknown;
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

function boxCache(box: Box): unknown {
	return (box as unknown as BoxDiagnostics).cache;
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

class ThrowingCacheRoot extends VStack {
	[RELEASE_COMPONENT_RENDER_CACHE](): void {
		throw new Error("fixture cache release failure");
	}
}

class CountingBox extends Box {
	invalidateCalls = 0;

	override invalidate(): void {
		this.invalidateCalls++;
		super.invalidate();
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

class StaticCacheLine implements Component {
	readonly value: string;
	renderCalls = 0;

	constructor(value: string) {
		this.value = value;
	}

	render(): string[] {
		this.renderCalls++;
		return [this.value];
	}

	invalidate(): void {}
}

class ReentrantLayoutRoot extends Container {
	private replaced = false;
	private readonly tui: TuiAltScreen;
	private readonly replacement: Component;

	constructor(tui: TuiAltScreen, replacement: Component) {
		super();
		this.tui = tui;
		this.replacement = replacement;
	}

	override render(): string[] {
		if (!this.replaced) {
			this.replaced = true;
			this.tui.setLayoutRoot(this.replacement);
		}
		return ["reentrant-old-root"];
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

test("Main final dispose releases retained transcript sidecar cache while owners remain reachable", async () => {
	const tui = new TuiMainScreen(new FakeTerminal(120, 40), false);
	const transcript = new RetainedContainer();
	const component = new StaticCacheLine("retained-sidecar-cache");
	const item = transcript.addRetainedChild(component, { id: "retained-sidecar", version: 1, completed: true });
	tui.addChild(transcript);
	tui.start();
	tui.renderNow();

	const primed = transcript.getRetainedStats();
	assert.equal(primed.retainedItems, 1);
	assert.equal(primed.cachedItems, 1);
	assert.equal(primed.cachedLines, 1);
	assert.ok(primed.estimatedCachedBytes > 0);

	await tui.dispose({ preserveScreen: true });
	assert.deepEqual(transcript.getRetainedStats(), {
		retainedItems: 1,
		completedItems: 1,
		activeItems: 0,
		cachedItems: 0,
		cachedLines: 0,
		estimatedCachedBytes: 0,
	});
	assert.equal(transcript.children[0], component);
	assert.equal(item.released, false);
	assert.equal(item.component, component);
});

test("Main final dispose releases retained viewport indexes while logical owners remain reachable", async () => {
	const tui = new TuiMainScreen(new FakeTerminal(120, 40), false);
	const transcript = new RetainedContainer();
	const completedItems = new Array<RetainedItem>(5_000);
	const completedComponents = new Array<StaticCacheLine>(5_000);
	for (let index = 0; index < completedComponents.length; index++) {
		const component = new StaticCacheLine(`history-${index} \x1b[31mANSI\x1b[0m 中文 👨‍👩‍👧‍👦 e\u0301`);
		completedComponents[index] = component;
		completedItems[index] = transcript.addRetainedChild(component, {
			id: `history-${index}`,
			version: 1,
			completed: true,
		});
	}
	const activeComponent = new StaticCacheLine("active-dynamic");
	const activeItem = transcript.addRetainedChild(activeComponent, { id: "active", version: 1 });
	tui.addChild(transcript);
	tui.start();
	tui.renderNow();
	activeItem.updateVersion(2);

	const primedReferences = transcript.getRetainedLifecycleReferenceCounts();
	assert.equal(primedReferences.viewportRecords, 5_001);
	assert.equal(primedReferences.viewportRecordComponentReferences, 5_001);
	assert.equal(primedReferences.viewportRecordRetainedItemReferences, 5_001);
	assert.ok(primedReferences.dirtyViewportRecords > 0);
	assert.ok(primedReferences.viewportBlockHeights > 0);
	assert.ok(primedReferences.viewportTotalHeight > 0);
	assert.equal(primedReferences.viewportWidthDefined, 1);
	assert.ok(transcript.getRetainedStats().cachedItems > 0);

	await tui.dispose({ preserveScreen: true });
	const released = transcript.getRetainedStats();
	assert.equal(released.cachedItems, 0);
	assert.equal(released.cachedLines, 0);
	assert.equal(released.estimatedCachedBytes, 0);
	const releasedReferences: RetainedViewportLifecycleReferenceCounts =
		transcript.getRetainedLifecycleReferenceCounts();
	assert.deepEqual(releasedReferences, {
		children: 5_001,
		retainedItems: 5_001,
		retainedComponents: 5_001,
		viewportRecords: 0,
		viewportRecordComponentReferences: 0,
		viewportRecordRetainedItemReferences: 0,
		dirtyViewportRecords: 0,
		preparedViewportRecords: 0,
		viewportBlockHeights: 0,
		preparedLineReferences: 0,
		kittyLineReferences: 0,
		viewportTotalHeight: 0,
		viewportWidthDefined: 0,
	});
	assert.equal(transcript.children.length, 5_001);
	assert.equal(transcript.children[0], completedComponents[0]);
	assert.equal(completedItems[0].component, completedComponents[0]);
	assert.equal(completedItems[0].completed, true);
	assert.equal(completedItems[0].completedVersion, 1);
	assert.equal(activeItem.component, activeComponent);
	assert.equal(activeItem.completed, false);
	assert.doesNotThrow(() => activeItem.updateVersion(3));
});

test("Main final dispose traverses a directly mounted RetainedItem into its Editor", async () => {
	const tui = new TuiMainScreen(new FakeTerminal(120, 40), false);
	const editor = new Editor(tui, EDITOR_THEME);
	editor.setText(createEditorText());
	const item = new RetainedItem(editor, { id: "direct-retained-editor", version: 1, completed: true });
	tui.addChild(item);
	tui.start();
	tui.renderNow();
	assertCachePrimed(editor);
	assert.ok(item.cachedLineCount > 0);

	await tui.dispose({ preserveScreen: true });
	assertCacheReleased(editor);
	assert.equal(item.cachedLineCount, 0);
	assert.equal(item.released, false);
	assert.equal(item.component, editor);
});

test("Main final dispose traverses Box ownership without semantic invalidation", async () => {
	const tui = new TuiMainScreen(new FakeTerminal(120, 40), false);
	const editor = new Editor(tui, EDITOR_THEME);
	editor.focused = true;
	editor.setText(createEditorText());
	const nested = new Container();
	nested.addChild(editor);
	const box = new CountingBox(1, 1);
	box.addChild(nested);
	tui.addChild(box);
	tui.start();
	tui.renderNow();
	assertCachePrimed(editor);
	assert.notEqual(boxCache(box), undefined);

	await tui.dispose({ preserveScreen: true });
	assertCacheReleased(editor);
	assert.equal(boxCache(box), undefined);
	assert.equal(box.invalidateCalls, 0);
	assert.equal(tui.children[0], box);
	assert.equal(box.children[0], nested);
	assert.equal(nested.children[0], editor);
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
	const oldRoot = new CountingRoot([nested.container]);
	tui.setLayoutRoot(oldRoot);
	tui.start();
	tui.renderNow();
	assertCachePrimed(nested.editor);

	const replacement = new VStack([]);
	tui.setLayoutRoot(replacement);
	assertCacheReleased(nested.editor);
	assert.equal(oldRoot.invalidateCalls, 0);
	assert.equal(oldRoot.releaseCalls, 1);
	assert.equal(altDiagnostics(tui).layoutRoot, replacement);
	assert.equal(altDiagnostics(tui).currentLayout, undefined);
	assertScratchReleased(tui);

	tui.setLayoutRoot(undefined);
	assert.equal(altDiagnostics(tui).layoutRoot, undefined);
	assertScratchReleased(tui);
	assert.equal(oldRoot.children[0], nested.container);
	await tui.dispose({ preserveScreen: true });
});

test("first explicit layout root releases the previously mounted implicit children", async () => {
	const tui = new TuiAltScreen(new FakeTerminal(120, 40), false, undefined, { mouse: false });
	const nested = createNestedRoot(tui);
	const implicitRoot = new CountingRoot([nested.container]);
	tui.addChild(implicitRoot);
	tui.start();
	tui.renderNow();
	assertCachePrimed(nested.editor);

	const explicitRoot = new VStack([]);
	tui.setLayoutRoot(explicitRoot);
	assertCacheReleased(nested.editor);
	assert.equal(implicitRoot.invalidateCalls, 0);
	assert.equal(implicitRoot.releaseCalls, 1);
	assert.equal(tui.children[0], implicitRoot);
	assert.equal(implicitRoot.children[0], nested.container);
	assert.equal(altDiagnostics(tui).layoutRoot, explicitRoot);
	assertScratchReleased(tui);

	await tui.dispose({ preserveScreen: true });
	assertCacheReleased(nested.editor);
});

test("layout root replacement requested during render completes after scratch ownership ends", async () => {
	const terminal = new FakeTerminal(120, 40);
	const tui = new TuiAltScreen(terminal, false, undefined, { mouse: false });
	const replacement = new StaticCacheLine("reentrant-new-root");
	const reentrantChild = new ReentrantLayoutRoot(tui, replacement);
	const root = new Box(0, 0);
	root.addChild(reentrantChild);
	tui.setLayoutRoot(root);
	tui.start();

	assert.doesNotThrow(() => tui.renderNow(true));
	assert.equal(altDiagnostics(tui).layoutRoot, replacement);
	assert.equal(altDiagnostics(tui).currentLayout, undefined);
	assert.equal(boxCache(root), undefined);
	assertScratchReleased(tui);
	tui.renderNow(true);
	assert.equal(altDiagnostics(tui).layoutRoot, replacement);
	assert.notEqual(altDiagnostics(tui).currentLayout, undefined);
	assert.equal(replacement.renderCalls, 1);

	await tui.dispose({ preserveScreen: true });
	assertScratchReleased(tui);
});

test("layout-root replacement releases Box caches without semantic invalidation", async () => {
	const tui = new TuiAltScreen(new FakeTerminal(120, 40), false, undefined, { mouse: false });
	const nested = createNestedRoot(tui);
	const box = new CountingBox(1, 1);
	box.addChild(nested.container);
	tui.setLayoutRoot(box);
	tui.start();
	tui.renderNow();
	assertCachePrimed(nested.editor);
	assert.notEqual(boxCache(box), undefined);

	const replacement = new VStack([]);
	tui.setLayoutRoot(replacement);
	assertCacheReleased(nested.editor);
	assert.equal(boxCache(box), undefined);
	assert.equal(box.invalidateCalls, 0);
	assert.equal(altDiagnostics(tui).layoutRoot, replacement);
	assertScratchReleased(tui);
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

test("replacement and final disposal release ownership across cache-release errors", async () => {
	const replacementTui = new TuiAltScreen(new FakeTerminal(120, 40), false, undefined, { mouse: false });
	const replacementNested = createNestedRoot(replacementTui);
	const throwingReplacementRoot = new ThrowingCacheRoot([replacementNested.container]);
	replacementTui.setLayoutRoot(throwingReplacementRoot);
	replacementTui.start();
	replacementTui.renderNow();
	assertCachePrimed(replacementNested.editor);
	const replacement = new VStack([]);
	assert.throws(() => replacementTui.setLayoutRoot(replacement), /fixture cache release failure/);
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
	const boxPath = "packages/tui/src/components/box.ts";
	const retainedPath = "packages/tui/src/components/retained-item.ts";
	const layoutPath = "packages/tui/src/layout.ts";
	const benchmarkPath = "scripts/bench/tui-b3-plan-gate.ts";
	const tuiText = await readFile(tuiPath, "utf-8");
	const altText = await readFile(altPath, "utf-8");
	const boxText = await readFile(boxPath, "utf-8");
	const retainedText = await readFile(retainedPath, "utf-8");
	const layoutText = await readFile(layoutPath, "utf-8");
	const benchmarkText = await readFile(benchmarkPath, "utf-8");
	const altSource = ts.createSourceFile(altPath, altText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
	const retainedSource = ts.createSourceFile(retainedPath, retainedText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
	let setLayoutRoot: ts.MethodDeclaration | undefined;
	let releaseRetainedCache: ts.MethodDeclaration | undefined;
	for (const statement of altSource.statements) {
		if (!ts.isClassDeclaration(statement) || statement.name?.text !== "TuiAltScreen") continue;
		for (const member of statement.members) {
			if (ts.isMethodDeclaration(member) && member.name.getText(altSource) === "setLayoutRoot") setLayoutRoot = member;
		}
	}
	for (const statement of retainedSource.statements) {
		if (!ts.isClassDeclaration(statement) || statement.name?.text !== "RetainedContainer") continue;
		for (const member of statement.members) {
			if (ts.isMethodDeclaration(member) && member.name.getText(retainedSource) === "[RELEASE_COMPONENT_RENDER_CACHE]") {
				releaseRetainedCache = member;
			}
		}
	}
	assert.ok(setLayoutRoot);
	assert.ok(releaseRetainedCache);
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
	assert.match(tuiText, /function releaseComponentRenderCaches\(component: Component \| undefined\)/);
	assert.match(tuiText, /GET_COMPONENT_RENDER_CACHE_CHILD/);
	assert.match(tuiText, /GET_COMPONENT_RENDER_CACHE_CHILDREN/);
	assert.match(boxText, /GET_COMPONENT_RENDER_CACHE_CHILDREN/);
	assert.match(boxText, /RELEASE_COMPONENT_RENDER_CACHE/);
	assert.doesNotMatch(setLayoutRoot.getText(altSource), /previousRoot\?\.invalidate/);
	assert.match(setLayoutRoot.getText(altSource), /const previousOwner = previousRoot \?\? this/);
	assert.match(setLayoutRoot.getText(altSource), /previousOwner === this\.activeLayoutCacheOwner/);
	assert.match(setLayoutRoot.getText(altSource), /this\.pendingLayoutCacheRelease = previousOwner/);
	assert.match(altText, /releaseComponentRenderCaches\(pendingLayoutCacheRelease\)/);
	assert.match(altText, /this\.activeLayoutCacheOwner = this\.layoutRoot \?\? this/);
	assert.match(altText, /this\.activeLayoutCacheOwner = undefined/);
	assert.match(setLayoutRoot.getText(altSource), /layoutScratch\.requestClear\(\)/);
	assert.doesNotMatch(setLayoutRoot.getText(altSource), /layoutScratch\.clear\(\)/);
	assert.match(altText, /finally \{\s*this\.layoutScratch\.flushRequestedClear\(\)/);
	assert.match(layoutText, /requestClear\(\): void \{[\s\S]*this\.clearRequested = true/);
	assert.match(layoutText, /flushRequestedClear\(\): void \{[\s\S]*this\.clearRequested/);
	assert.match(
		retainedText,
		/class RetainedItem implements Component[\s\S]*?\[GET_COMPONENT_RENDER_CACHE_CHILD\]\(\): Component \| undefined \{\s*return this\.inner[\s\S]*?\[RELEASE_COMPONENT_RENDER_CACHE\]\(\): void \{\s*this\.clearCache\(\)/,
	);
	assert.match(
		retainedText,
		/class RetainedContainer extends Container implements LineViewportComponent[\s\S]*?\[RELEASE_COMPONENT_RENDER_CACHE\]\(\): void \{[\s\S]*retainedById\.values\(\)/,
	);
	const retainedReleaseText = releaseRetainedCache.getText(retainedSource);
	for (const requiredRelease of [
		"this.viewportRecords = []",
		"this.viewportRecordByComponent.clear()",
		"this.dirtyViewportRecords.clear()",
		"this.preparedViewportRecords.clear()",
		"this.viewportBlockHeights = []",
		"this.viewportTotalHeight = 0",
		"this.viewportWidth = undefined",
		"this.viewportMeasuredItems = 0",
		"this.viewportStructureDirty = true",
		"this.recordUnsafeViewportMutation()",
	]) {
		assert.match(retainedReleaseText, new RegExp(requiredRelease.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
	}
	assert.doesNotMatch(retainedReleaseText, /\.invalidate\(|onRenderStateChanged|new (?:Map|Set|Promise|AbortController)|=>|function\s*\(/);
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
