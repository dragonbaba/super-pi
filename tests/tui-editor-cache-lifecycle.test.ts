import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";
import { RELEASE_COMPONENT_RENDER_CACHE } from "../packages/tui/src/component-cache.ts";
import {
	Container,
	type DetachedComponentReleaseMetrics,
	type Component,
	releaseDetachedComponentRenderCaches,
	type TUI,
} from "../packages/tui/src/tui.ts";
import { TuiAltScreen } from "../packages/tui/src/tui-alt-screen.ts";
import { TuiMainScreen } from "../packages/tui/src/tui-main-screen.ts";
import { Box } from "../packages/tui/src/components/box.ts";
import { Editor, type EditorTheme } from "../packages/tui/src/components/editor.ts";
import {
	RetainedContainer,
	RetainedItem,
	type RetainedViewportLifecycleReferenceCounts,
} from "../packages/tui/src/components/retained-item.ts";
import { ScrollView } from "../packages/tui/src/components/scroll-view.ts";
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
	implicitScrollView: ScrollView;
	layoutRenderOwners: Array<Component | undefined>;
	pendingLayoutCacheReleases: Array<Component | undefined>;
}

interface BoxDiagnostics {
	cache: unknown;
}

interface ScrollViewDiagnostics {
	requestRenderCallback: (() => void) | undefined;
	scrollbarHideTimer: NodeJS.Timeout | undefined;
	transientScrollbarVisible: boolean;
}

interface AltInteractionDiagnostics {
	selectionAnchor: { row: number; col: number; scrollView?: ScrollView } | undefined;
	selectionFocus: { row: number; col: number; scrollView?: ScrollView } | undefined;
	selectionInitialRange:
		| {
				start: { row: number; col: number; scrollView?: ScrollView };
				end: { row: number; col: number; scrollView?: ScrollView };
		  }
		| undefined;
	lastClick: { timestamp: number; count: number; row: number; scrollView?: ScrollView; wordStart: number; wordEnd: number }
		| undefined;
	selectionDragPointer: { x: number; y: number } | undefined;
	selectionAutoScrollDirection: -1 | 0 | 1;
	selectionAutoScrollTimer: NodeJS.Timeout | undefined;
	selectionPressActive: boolean;
	scrollbarDrag: { scrollView: ScrollView; grabOffset: number } | undefined;
	scrollbarDragFrameTimer: NodeJS.Timeout | undefined;
	pendingScrollbarDragScrollTop: number | undefined;
	scrollbarHover: ScrollView | undefined;
	pressedUrl: string | undefined;
	selectionDragged: boolean;
	resolvedSelectionStart: { row: number; col: number; scrollView?: ScrollView } | undefined;
	resolvedSelectionEnd: { row: number; col: number; scrollView?: ScrollView } | undefined;
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

function noOperation(): void {}

function primeAltInteractionState(state: AltInteractionDiagnostics, scroll: ScrollView): {
	anchor: { row: number; col: number; scrollView: ScrollView };
	focus: { row: number; col: number; scrollView: ScrollView };
} {
	const anchor = { row: 1, col: 0, scrollView: scroll };
	const focus = { row: 2, col: 4, scrollView: scroll };
	state.selectionAnchor = anchor;
	state.selectionFocus = focus;
	state.selectionInitialRange = { start: anchor, end: focus };
	state.lastClick = { timestamp: Date.now(), count: 2, row: 1, scrollView: scroll, wordStart: 0, wordEnd: 4 };
	state.selectionDragPointer = { x: 1, y: 19 };
	state.selectionAutoScrollDirection = 1;
	state.selectionAutoScrollTimer = setInterval(noOperation, 60_000);
	state.selectionAutoScrollTimer.unref();
	state.selectionPressActive = true;
	state.scrollbarHover = scroll;
	state.scrollbarDrag = { scrollView: scroll, grabOffset: 0 };
	state.scrollbarDragFrameTimer = setTimeout(noOperation, 60_000);
	state.scrollbarDragFrameTimer.unref();
	state.pendingScrollbarDragScrollTop = 3;
	state.pressedUrl = "https://example.com";
	state.selectionDragged = true;
	state.resolvedSelectionStart = anchor;
	state.resolvedSelectionEnd = focus;
	return { anchor, focus };
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

function scrollDiagnostics(scroll: ScrollView): ScrollViewDiagnostics {
	return scroll as unknown as ScrollViewDiagnostics;
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

class ClearingCacheOwner implements Component {
	releaseCalls = 0;
	private readonly clearOwner: () => void;

	constructor(clearOwner: () => void) {
		this.clearOwner = clearOwner;
	}

	render(): string[] {
		return [];
	}

	invalidate(): void {}

	[RELEASE_COMPONENT_RENDER_CACHE](): void {
		this.releaseCalls++;
		this.clearOwner();
	}
}

class SharedNestedTransitionDriver implements Component {
	private phase = 0;
	private readonly tui: TuiAltScreen;
	private readonly middle: Component;
	private readonly replacement: Component;
	sharedReleaseCallsAfterNested = -1;
	private readonly shared: CountingCacheContainer;

	constructor(
		tui: TuiAltScreen,
		middle: Component,
		replacement: Component,
		shared: CountingCacheContainer,
	) {
		this.tui = tui;
		this.middle = middle;
		this.replacement = replacement;
		this.shared = shared;
	}

	render(): string[] {
		if (this.phase === 0) {
			this.phase = 1;
			this.tui.renderNow(true);
			this.sharedReleaseCallsAfterNested = this.shared.releaseCalls;
		} else if (this.phase === 1) {
			this.phase = 2;
			this.tui.setLayoutRoot(this.middle);
			this.tui.setLayoutRoot(this.replacement);
		}
		return ["shared-transition-driver"];
	}

	invalidate(): void {}
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

class NestedRenderLayoutRoot extends Container {
	private replaced = false;
	private readonly tui: TuiAltScreen;
	private readonly replacement: Component;
	nestedRenderError: unknown;
	owner: CountingCacheContainer | undefined;
	ownerReleaseCallsAfterNested = -1;

	constructor(tui: TuiAltScreen, replacement: Component) {
		super();
		this.tui = tui;
		this.replacement = replacement;
	}

	override render(): string[] {
		if (!this.replaced) {
			this.replaced = true;
			this.tui.setLayoutRoot(this.replacement);
			try {
				this.tui.renderNow();
			} catch (error) {
				this.nestedRenderError = error;
			}
			this.ownerReleaseCallsAfterNested = this.owner?.releaseCalls ?? -1;
		}
		return ["nested-render-old-root"];
	}
}

class DetachAndReattachLayoutRoot extends Container {
	private replaced = false;
	private readonly tui: TuiAltScreen;
	private readonly replacement: Component;
	owner: Component | undefined;

	constructor(tui: TuiAltScreen, replacement: Component) {
		super();
		this.tui = tui;
		this.replacement = replacement;
	}

	override render(): string[] {
		if (!this.replaced) {
			this.replaced = true;
			this.tui.setLayoutRoot(this.replacement);
			this.tui.setLayoutRoot(this.owner);
		}
		return ["reattached-root"];
	}
}

class SameOwnerNestedReplacementChild implements Component {
	private phase = 0;
	private readonly tui: TuiAltScreen;
	private readonly owner: CountingCacheContainer;
	private readonly replacements: readonly (Component | undefined)[];
	private readonly forceNested: boolean;
	private readonly throwAfterReplacement: boolean;
	nestedError: unknown;
	releaseCallsAfterNested = -1;

	constructor(
		tui: TuiAltScreen,
		owner: CountingCacheContainer,
		replacements: readonly (Component | undefined)[],
		forceNested = false,
		throwAfterReplacement = false,
	) {
		this.tui = tui;
		this.owner = owner;
		this.replacements = replacements;
		this.forceNested = forceNested;
		this.throwAfterReplacement = throwAfterReplacement;
	}

	render(): string[] {
		if (this.phase === 0) {
			this.phase = 1;
			try {
				this.tui.renderNow(this.forceNested);
			} catch (error) {
				this.nestedError = error;
			}
			this.releaseCallsAfterNested = this.owner.releaseCalls;
		} else if (this.phase === 1) {
			this.phase = 2;
			for (let index = 0; index < this.replacements.length; index++) {
				this.tui.setLayoutRoot(this.replacements[index]);
			}
			if (this.throwAfterReplacement) throw new Error("nested same-owner fixture failure");
		}
		return ["same-owner-nested-root"];
	}

	invalidate(): void {}
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

test("final cache release snapshots root and nested sibling ownership before invoking hooks", async () => {
	const tui = new TuiMainScreen(new FakeTerminal(120, 40), false);
	const laterRoot = new CountingCacheContainer();
	const clearingRoot = new ClearingCacheOwner(() => { tui.children.length = 0; });
	const nested = new Container();
	const laterNested = new CountingCacheContainer();
	const clearingNested = new ClearingCacheOwner(() => { nested.children.length = 0; });
	nested.addChild(clearingNested);
	nested.addChild(laterNested);
	tui.addChild(clearingRoot);
	tui.addChild(laterRoot);
	tui.addChild(nested);
	tui.start();

	await tui.dispose({ preserveScreen: true });

	assert.equal(clearingRoot.releaseCalls, 1);
	assert.equal(laterRoot.releaseCalls, 1);
	assert.equal(clearingNested.releaseCalls, 1);
	assert.equal(laterNested.releaseCalls, 1);
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

test("implicit and explicit layout ownership preserve shared descendants in both directions", async () => {
	const tui = new TuiAltScreen(new FakeTerminal(120, 40), false, undefined, { mouse: false });
	const shared = new CountingCacheContainer();
	shared.addChild(new StaticCacheLine("implicit-explicit-shared"));
	tui.addChild(shared);
	tui.start();
	tui.renderNow(true);
	const explicitWrapper = new CountingCacheContainer();
	explicitWrapper.addChild(shared);
	const explicitRoot = new VStack([explicitWrapper]);

	tui.setLayoutRoot(explicitRoot);
	assert.equal(shared.releaseCalls, 0);
	tui.renderNow(true);
	assert.notEqual(altDiagnostics(tui).currentLayout, undefined);

	tui.setLayoutRoot(undefined);
	assert.equal(explicitWrapper.releaseCalls, 1);
	assert.equal(shared.releaseCalls, 0);
	tui.renderNow(true);
	assert.notEqual(altDiagnostics(tui).currentLayout, undefined);
	await tui.dispose({ preserveScreen: true });
	assert.equal(shared.releaseCalls, 1);
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

test("nested renderNow cannot release an old layout owner before the outer render exits", async () => {
	const tui = new TuiAltScreen(new FakeTerminal(120, 40), false, undefined, { mouse: false });
	const replacement = new StaticCacheLine("nested-render-new-root");
	const reentrantChild = new NestedRenderLayoutRoot(tui, replacement);
	const oldBox = new Box(0, 0);
	oldBox.addChild(reentrantChild);
	const oldRoot = new CountingCacheContainer();
	oldRoot.addChild(oldBox);
	reentrantChild.owner = oldRoot;
	tui.setLayoutRoot(oldRoot);
	tui.start();

	assert.doesNotThrow(() => tui.renderNow(true));
	assert.equal(reentrantChild.nestedRenderError, undefined);
	assert.equal(reentrantChild.ownerReleaseCallsAfterNested, 0);
	assert.equal(oldRoot.releaseCalls, 1);
	assert.equal(altDiagnostics(tui).layoutRoot, replacement);
	assert.equal(boxCache(oldBox), undefined);
	assertScratchReleased(tui);
	assert.equal(replacement.renderCalls, 1);
	await tui.dispose({ preserveScreen: true });
});

test("deferred root release reevaluates shared descendants at the outer frame exit", async () => {
	for (const replacementKeepsShared of [true, false]) {
		const tui = new TuiAltScreen(new FakeTerminal(120, 40), false, undefined, { mouse: false });
		const shared = new CountingCacheContainer();
		shared.addChild(new StaticCacheLine("shared-live-child"));
		const middleWrapper = new CountingCacheContainer();
		middleWrapper.addChild(shared);
		const middle = new VStack([middleWrapper]);
		const replacementWrapper = new CountingCacheContainer();
		if (replacementKeepsShared) replacementWrapper.addChild(shared);
		else replacementWrapper.addChild(new StaticCacheLine("replacement-only"));
		const replacement = new VStack([replacementWrapper]);
		const oldRoot = new CountingCacheContainer();
		const driver = new SharedNestedTransitionDriver(tui, middle, replacement, shared);
		oldRoot.addChild(driver);
		oldRoot.addChild(shared);
		tui.setLayoutRoot(oldRoot);
		tui.start();

		tui.renderNow(true);
		assert.equal(driver.sharedReleaseCallsAfterNested, 0);
		assert.equal(oldRoot.releaseCalls, 1);
		assert.equal(middleWrapper.releaseCalls, 1);
		assert.equal(shared.releaseCalls, replacementKeepsShared ? 0 : 1);
		assert.equal(altDiagnostics(tui).layoutRoot, replacement);
		tui.renderNow(true);
		assert.notEqual(altDiagnostics(tui).currentLayout, undefined);
		await tui.dispose({ preserveScreen: true });
		assert.equal(shared.releaseCalls, replacementKeepsShared ? 1 : 1);
	}
});

test("selective release identity probes remain linear for disjoint and differently wrapped shared leaves", () => {
	for (const count of [1, 16, 64, 256, 1024]) {
		const detached = new Container();
		const live = new Container();
		const leaves = new Array<CountingCacheContainer>(count);
		for (let index = 0; index < count; index++) {
			const leaf = new CountingCacheContainer();
			leaves[index] = leaf;
			const detachedWrapper = new Container();
			detachedWrapper.addChild(leaf);
			detached.addChild(detachedWrapper);
			if ((index & 1) === 0) {
				const liveWrapper = new Container();
				liveWrapper.addChild(leaf);
				live.addChild(liveWrapper);
			}
		}
		const metrics: DetachedComponentReleaseMetrics = {
			liveNodesScanned: 0,
			detachedNodesScanned: 0,
			releasedNodes: 0,
			identityTableHighWaterMark: 0,
			retainedIdentityEntries: -1,
		};
		releaseDetachedComponentRenderCaches(detached, [live], metrics);
		assert.ok(metrics.liveNodesScanned <= count * 2 + 1);
		assert.ok(metrics.detachedNodesScanned <= count * 2 + 1);
		assert.ok(metrics.identityTableHighWaterMark <= count * 3 + 2);
		assert.equal(metrics.retainedIdentityEntries, 0);
		for (let index = 0; index < count; index++) {
			assert.equal(leaves[index]!.releaseCalls, (index & 1) === 0 ? 0 : 1);
		}
	}
});

test("selective release counts only invoked component release hooks", () => {
	const detached = new Container();
	const releasable = new CountingCacheContainer();
	detached.addChild(releasable);
	const metrics: DetachedComponentReleaseMetrics = {
		liveNodesScanned: 0,
		detachedNodesScanned: 0,
		releasedNodes: 0,
		identityTableHighWaterMark: 0,
		retainedIdentityEntries: -1,
	};

	releaseDetachedComponentRenderCaches(detached, [], metrics);

	assert.equal(metrics.detachedNodesScanned, 2);
	assert.equal(metrics.releasedNodes, 1);
	assert.equal(releasable.releaseCalls, 1);
	assert.equal(metrics.retainedIdentityEntries, 0);
});

test("selective release keeps 5k and 50k retained logical owners while dropping its identity table", () => {
	for (const count of [5_000, 50_000]) {
		const retained = new RetainedContainer();
		const live = new Container();
		for (let index = 0; index < count; index++) {
			const component = new StaticCacheLine(`retained-${index}`);
			retained.addRetainedChild(component, { id: `retained-${index}`, version: 1, completed: true });
			if ((index & 1) === 0) live.addChild(component);
		}
		const children = retained.children;
		const metrics: DetachedComponentReleaseMetrics = {
			liveNodesScanned: 0,
			detachedNodesScanned: 0,
			releasedNodes: 0,
			identityTableHighWaterMark: 0,
			retainedIdentityEntries: -1,
		};
		releaseDetachedComponentRenderCaches(retained, [live], metrics);
		assert.equal(retained.children, children);
		assert.equal(retained.children.length, count);
		assert.ok(metrics.liveNodesScanned <= count / 2 + 1);
		assert.ok(metrics.detachedNodesScanned <= count * 2 + 1);
		assert.ok(metrics.identityTableHighWaterMark <= count * 2 + 2);
		assert.equal(metrics.retainedIdentityEntries, 0);
	}
});

test("selective release preserves the first hook error while releasing later detached siblings", () => {
	const detached = new Container();
	const throwing = new ThrowingCacheRoot([]);
	const later = new CountingCacheContainer();
	const shared = new CountingCacheContainer();
	detached.addChild(throwing);
	detached.addChild(later);
	detached.addChild(shared);
	const live = new Container();
	live.addChild(shared);
	assert.throws(() => releaseDetachedComponentRenderCaches(detached, [live]), /fixture cache release failure/);
	assert.equal(later.releaseCalls, 1);
	assert.equal(shared.releaseCalls, 0);
});

test("selective release isolates throwing hook accessors and releases later siblings", () => {
	const accessorError = new Error("fixture cache release accessor failure");
	const detached = new Container();
	const throwing = new Container();
	const later = new CountingCacheContainer();
	Object.defineProperty(throwing, RELEASE_COMPONENT_RENDER_CACHE, {
		get(): never {
			throw accessorError;
		},
	});
	detached.addChild(throwing);
	detached.addChild(later);
	const metrics: DetachedComponentReleaseMetrics = {
		liveNodesScanned: 0,
		detachedNodesScanned: 0,
		releasedNodes: 0,
		identityTableHighWaterMark: 0,
		retainedIdentityEntries: -1,
	};

	assert.throws(
		() => releaseDetachedComponentRenderCaches(detached, [], metrics),
		(error: unknown) => error === accessorError,
	);
	assert.equal(later.releaseCalls, 1);
	assert.equal(metrics.releasedNodes, 1);
	assert.equal(metrics.retainedIdentityEntries, 0);
});

test("selective release snapshots detached siblings before a release hook mutates their parent", () => {
	const detached = new Container();
	const later = new CountingCacheContainer();
	const clearing = new ClearingCacheOwner(() => { detached.children.length = 0; });
	detached.addChild(clearing);
	detached.addChild(later);

	releaseDetachedComponentRenderCaches(detached, []);

	assert.equal(clearing.releaseCalls, 1);
	assert.equal(later.releaseCalls, 1);
});

test("each nested layout frame releases its own detached owner after that frame exits", async () => {
	const tui = new TuiAltScreen(new FakeTerminal(120, 40), false, undefined, { mouse: false });
	const finalRoot = new StaticCacheLine("nested-final-root");
	const nestedReplacementChild = new ReentrantLayoutRoot(tui, finalRoot);
	const nestedBox = new Box(0, 0);
	nestedBox.addChild(nestedReplacementChild);
	const nestedRoot = new CountingCacheContainer();
	nestedRoot.addChild(nestedBox);

	const outerReplacementChild = new NestedRenderLayoutRoot(tui, nestedRoot);
	const outerBox = new Box(0, 0);
	outerBox.addChild(outerReplacementChild);
	const outerRoot = new CountingCacheContainer();
	outerRoot.addChild(outerBox);
	outerReplacementChild.owner = outerRoot;
	tui.setLayoutRoot(outerRoot);
	tui.start();

	assert.doesNotThrow(() => tui.renderNow(true));
	assert.equal(altDiagnostics(tui).layoutRoot, finalRoot);
	assert.equal(outerRoot.releaseCalls, 1);
	assert.equal(nestedRoot.releaseCalls, 1);
	assert.equal(boxCache(outerBox), undefined);
	assert.equal(boxCache(nestedBox), undefined);
	assertScratchReleased(tui);

	tui.renderNow(true);
	assert.equal(finalRoot.renderCalls, 1);
	await tui.dispose({ preserveScreen: true });
});

test("the outermost active frame owns release when the same layout owner renders at multiple depths", async () => {
	const tui = new TuiAltScreen(new FakeTerminal(120, 40), false, undefined, { mouse: false });
	const replacement = new StaticCacheLine("same-owner-replacement");
	const owner = new CountingCacheContainer();
	const child = new SameOwnerNestedReplacementChild(tui, owner, [replacement]);
	const box = new Box(0, 0);
	box.addChild(child);
	owner.addChild(box);
	tui.setLayoutRoot(owner);
	tui.start();

	assert.doesNotThrow(() => tui.renderNow(true));
	assert.equal(child.nestedError, undefined);
	assert.equal(child.releaseCallsAfterNested, 0);
	assert.equal(owner.releaseCalls, 1);
	assert.equal(boxCache(box), undefined);
	assert.equal(altDiagnostics(tui).layoutRoot, replacement);
	assert.deepEqual(tui.render(120), ["same-owner-replacement"]);

	await tui.dispose({ preserveScreen: true });
	assert.equal(owner.releaseCalls, 1);
});

test("forced same-owner nested render defers release without clearing borrowed scratch", async () => {
	const tui = new TuiAltScreen(new FakeTerminal(120, 40), false, undefined, { mouse: false });
	const replacement = new StaticCacheLine("forced-same-owner-replacement");
	const owner = new CountingCacheContainer();
	const child = new SameOwnerNestedReplacementChild(tui, owner, [replacement], true);
	const box = new Box(0, 0);
	box.addChild(child);
	owner.addChild(box);
	tui.setLayoutRoot(owner);
	tui.start();

	assert.doesNotThrow(() => tui.renderNow(true));
	assert.equal(child.nestedError, undefined);
	assert.equal(child.releaseCallsAfterNested, 0);
	assert.equal(owner.releaseCalls, 1);
	assert.equal(boxCache(box), undefined);
	await tui.dispose({ preserveScreen: true });
});

test("same-owner A to B to A to C replacement releases A once after its outer frame", async () => {
	const tui = new TuiAltScreen(new FakeTerminal(120, 40), false, undefined, { mouse: false });
	const owner = new CountingCacheContainer();
	const transient = new CountingCacheContainer();
	const finalRoot = new StaticCacheLine("same-owner-final-root");
	const child = new SameOwnerNestedReplacementChild(tui, owner, [transient, owner, finalRoot]);
	const box = new Box(0, 0);
	box.addChild(child);
	owner.addChild(box);
	tui.setLayoutRoot(owner);
	tui.start();

	tui.renderNow(true);
	assert.equal(child.releaseCallsAfterNested, 0);
	assert.equal(owner.releaseCalls, 1);
	assert.equal(transient.releaseCalls, 1);
	assert.equal(boxCache(box), undefined);
	assert.equal(altDiagnostics(tui).layoutRoot, finalRoot);
	await tui.dispose({ preserveScreen: true });
	assert.equal(owner.releaseCalls, 1);
});

test("same-owner deferred release survives a nested render error", async () => {
	const tui = new TuiAltScreen(new FakeTerminal(120, 40), false, undefined, { mouse: false });
	const replacement = new StaticCacheLine("same-owner-error-replacement");
	const owner = new CountingCacheContainer();
	const child = new SameOwnerNestedReplacementChild(tui, owner, [replacement], false, true);
	const box = new Box(0, 0);
	box.addChild(child);
	owner.addChild(box);
	tui.setLayoutRoot(owner);
	tui.start();

	assert.doesNotThrow(() => tui.renderNow(true));
	assert.match(String(child.nestedError), /nested same-owner fixture failure/);
	assert.equal(child.releaseCallsAfterNested, 0);
	assert.equal(owner.releaseCalls, 1);
	assert.equal(boxCache(box), undefined);
	await tui.dispose({ preserveScreen: true });
});

test("reattaching a rendering owner cancels its deferred cache release", async () => {
	const tui = new TuiAltScreen(new FakeTerminal(120, 40), false, undefined, { mouse: false });
	const transientRoot = new CountingCacheContainer();
	const reattachingChild = new DetachAndReattachLayoutRoot(tui, transientRoot);
	const root = new CountingCacheContainer();
	root.addChild(reattachingChild);
	reattachingChild.owner = root;
	tui.setLayoutRoot(root);
	tui.start();

	assert.doesNotThrow(() => tui.renderNow(true));
	assert.equal(altDiagnostics(tui).layoutRoot, root);
	assert.equal(root.releaseCalls, 0);
	assert.equal(transientRoot.releaseCalls, 1);
	assertScratchReleased(tui);

	await tui.dispose({ preserveScreen: true });
	assert.equal(root.releaseCalls, 1);
});

test("detached and disposed ScrollView releases TUI callback and auto-hide timer", async () => {
	const document = new Container();
	for (let index = 0; index < 100; index++) document.addChild(new StaticCacheLine(`scroll-line-${index}`));
	const scroll = new ScrollView(document, {
		follow: "none",
		primary: true,
		scrollbar: "auto",
		scrollbarHideDelayMs: 60_000,
	});
	const firstTui = new TuiAltScreen(new FakeTerminal(120, 20), false, undefined, { mouse: false });
	firstTui.setLayoutRoot(scroll);
	firstTui.start();
	firstTui.renderNow();
	scroll.scrollBy(1);
	const firstScrollTop = scroll.scrollTop;
	assert.equal(typeof scrollDiagnostics(scroll).requestRenderCallback, "function");
	assert.ok(scrollDiagnostics(scroll).scrollbarHideTimer);

	firstTui.setLayoutRoot(new VStack([]));
	assert.equal(scrollDiagnostics(scroll).requestRenderCallback, undefined);
	assert.equal(scrollDiagnostics(scroll).scrollbarHideTimer, undefined);
	assert.equal(scroll.scrollTop, firstScrollTop);
	await firstTui.dispose({ preserveScreen: true });

	const secondTui = new TuiAltScreen(new FakeTerminal(120, 20), false, undefined, { mouse: false });
	secondTui.setLayoutRoot(scroll);
	secondTui.start();
	secondTui.renderNow();
	assert.equal(typeof scrollDiagnostics(scroll).requestRenderCallback, "function");
	await secondTui.dispose({ preserveScreen: true });
	assert.equal(scrollDiagnostics(scroll).requestRenderCallback, undefined);
	assert.equal(scrollDiagnostics(scroll).scrollbarHideTimer, undefined);
	assert.equal(scroll.scrollTop, firstScrollTop);
});

test("implicit ScrollView releases and reinstalls its TUI callback across real root ownership", async () => {
	const tui = new TuiAltScreen(new FakeTerminal(120, 20), false, undefined, { mouse: false });
	for (let index = 0; index < 100; index++) tui.addChild(new StaticCacheLine(`implicit-scroll-line-${index}`));
	const diagnostics = altDiagnostics(tui);
	const implicitScrollView = diagnostics.implicitScrollView;
	const children = tui.children;
	tui.start();
	tui.renderNow();
	implicitScrollView.setScrollbar("auto");
	implicitScrollView.scrollBy(-1);
	assert.equal(typeof scrollDiagnostics(implicitScrollView).requestRenderCallback, "function");
	assert.ok(scrollDiagnostics(implicitScrollView).scrollbarHideTimer);
	assert.equal(scrollDiagnostics(implicitScrollView).transientScrollbarVisible, true);

	const explicitRoot = new VStack([]);
	tui.setLayoutRoot(explicitRoot);
	assert.equal(scrollDiagnostics(implicitScrollView).requestRenderCallback, undefined);
	assert.equal(scrollDiagnostics(implicitScrollView).scrollbarHideTimer, undefined);
	assert.equal(scrollDiagnostics(implicitScrollView).transientScrollbarVisible, false);
	assert.equal(tui.children, children);

	tui.setLayoutRoot(undefined);
	tui.renderNow();
	assert.equal(typeof scrollDiagnostics(implicitScrollView).requestRenderCallback, "function");
	await tui.dispose({ preserveScreen: true });
	assert.equal(scrollDiagnostics(implicitScrollView).requestRenderCallback, undefined);
	assert.equal(scrollDiagnostics(implicitScrollView).scrollbarHideTimer, undefined);
	assert.equal(tui.children, children);
});

test("layout-root replacement clears every Alt interaction owner without changing same-root or stop semantics", async () => {
	const document = new Container();
	for (let index = 0; index < 100; index++) document.addChild(new StaticCacheLine(`selection-owner-${index}`));
	const scroll = new ScrollView(document, { primary: true, scrollbar: "auto", scrollbarHideDelayMs: 60_000 });
	const tui = new TuiAltScreen(new FakeTerminal(120, 20), false, undefined, { mouse: false });
	tui.setLayoutRoot(scroll);
	tui.start();
	tui.renderNow();
	const state = tui as unknown as AltInteractionDiagnostics;
	let interaction = primeAltInteractionState(state, scroll);

	tui.setLayoutRoot(scroll);
	assert.equal(state.selectionAnchor, interaction.anchor);
	await tui.stop({ preserveScreen: true });
	assert.equal(state.selectionAnchor, interaction.anchor);
	tui.start();
	tui.renderNow();
	interaction = primeAltInteractionState(state, scroll);
	const before = tui.getAltInteractionRetainedReferenceCounts();
	assert.equal(before.selectionAnchorReferences, 1);
	assert.equal(before.selectionFocusReferences, 1);
	assert.equal(before.selectionInitialRangeReferences, 1);
	assert.equal(before.lastClickReferences, 1);
	assert.equal(before.selectionScrollViewReferences, 7);
	assert.equal(before.selectionTimerReferences, 1);
	assert.equal(before.scrollbarOwnerReferences, 2);
	assert.equal(before.scrollbarTimerReferences, 1);

	const replacement = new StaticCacheLine("selection-owner-replacement");
	tui.setLayoutRoot(replacement);
	const afterReplacement = tui.getAltInteractionRetainedReferenceCounts();
	assert.deepEqual(afterReplacement, {
		selectionAnchorReferences: 0,
		selectionFocusReferences: 0,
		selectionInitialRangeReferences: 0,
		lastClickReferences: 0,
		selectionScrollViewReferences: 0,
		selectionTimerReferences: 0,
		scrollbarOwnerReferences: 0,
		scrollbarTimerReferences: 0,
	});
	assert.equal(state.selectionAnchor, undefined);
	assert.equal(state.selectionFocus, undefined);
	assert.equal(state.selectionInitialRange, undefined);
	assert.equal(state.lastClick, undefined);
	assert.equal(state.selectionDragPointer, undefined);
	assert.equal(state.selectionAutoScrollTimer, undefined);
	assert.equal(state.selectionPressActive, false);
	assert.equal(state.scrollbarHover, undefined);
	assert.equal(state.scrollbarDrag, undefined);
	assert.equal(state.scrollbarDragFrameTimer, undefined);
	assert.equal(state.pendingScrollbarDragScrollTop, undefined);
	assert.equal(state.pressedUrl, undefined);
	assert.equal(state.selectionDragged, false);
	assert.equal(state.resolvedSelectionStart, undefined);
	assert.equal(state.resolvedSelectionEnd, undefined);
	assert.equal(scrollDiagnostics(scroll).requestRenderCallback, undefined);
	tui.renderNow();
	assert.deepEqual(tui.render(120), ["selection-owner-replacement"]);
	interaction = primeAltInteractionState(state, scroll);
	assert.equal(state.selectionAnchor, interaction.anchor);
	await tui.dispose({ preserveScreen: true });
	assert.deepEqual(tui.getAltInteractionRetainedReferenceCounts(), afterReplacement);
});

test("final disposal discards historical reentrant owner slot backing", async () => {
	const tui = new TuiAltScreen(new FakeTerminal(120, 40), false, undefined, { mouse: false });
	const owners = new Array<CountingCacheContainer>(64);
	let root: Component = new StaticCacheLine("deep-layout-final-root");
	for (let depth = owners.length - 1; depth >= 0; depth--) {
		const owner = new CountingCacheContainer();
		const nestedRoot = new NestedRenderLayoutRoot(tui, root);
		nestedRoot.owner = owner;
		owner.addChild(nestedRoot);
		owners[depth] = owner;
		root = owner;
	}
	tui.setLayoutRoot(root);
	tui.start();
	tui.renderNow();
	const diagnostics = altDiagnostics(tui);
	const ownerSlots = diagnostics.layoutRenderOwners;
	const pendingSlots = diagnostics.pendingLayoutCacheReleases;
	for (let index = 0; index < owners.length; index++) assert.equal(owners[index].releaseCalls, 1);
	assert.ok(ownerSlots.length >= 64);
	assert.ok(pendingSlots.length >= 64);

	await tui.dispose({ preserveScreen: true });
	assert.notEqual(diagnostics.layoutRenderOwners, ownerSlots);
	assert.notEqual(diagnostics.pendingLayoutCacheReleases, pendingSlots);
	assert.ok(diagnostics.layoutRenderOwners.length <= 1);
	assert.ok(diagnostics.pendingLayoutCacheReleases.length <= 1);
	assert.equal(diagnostics.layoutRenderOwners.filter(Boolean).length, 0);
	assert.equal(diagnostics.pendingLayoutCacheReleases.filter(Boolean).length, 0);
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
	let releaseLayoutInteractionOwners: ts.MethodDeclaration | undefined;
	let beforeTerminalStop: ts.MethodDeclaration | undefined;
	let releaseRetainedCache: ts.MethodDeclaration | undefined;
	for (const statement of altSource.statements) {
		if (!ts.isClassDeclaration(statement) || statement.name?.text !== "TuiAltScreen") continue;
		for (const member of statement.members) {
			if (ts.isMethodDeclaration(member) && member.name.getText(altSource) === "setLayoutRoot") setLayoutRoot = member;
			if (ts.isMethodDeclaration(member) && member.name.getText(altSource) === "releaseLayoutInteractionOwners") {
				releaseLayoutInteractionOwners = member;
			}
			if (ts.isMethodDeclaration(member) && member.name.getText(altSource) === "beforeTerminalStop") {
				beforeTerminalStop = member;
			}
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
	assert.ok(releaseLayoutInteractionOwners);
	assert.ok(beforeTerminalStop);
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
	visit(releaseLayoutInteractionOwners);
	assert.equal(forbiddenAllocations, 0);
	let interactionCleanupTemporaryStructures = 0;
	function visitInteractionCleanup(node: ts.Node): void {
		if (ts.isObjectLiteralExpression(node) || ts.isArrayLiteralExpression(node)) interactionCleanupTemporaryStructures++;
		ts.forEachChild(node, visitInteractionCleanup);
	}
	visitInteractionCleanup(releaseLayoutInteractionOwners);
	assert.equal(interactionCleanupTemporaryStructures, 0);
	assert.match(tuiText, /function releaseComponentRenderCaches\(component: Component \| undefined\)/);
	assert.match(tuiText, /GET_COMPONENT_RENDER_CACHE_CHILD/);
	assert.match(tuiText, /GET_COMPONENT_RENDER_CACHE_CHILDREN/);
	assert.match(boxText, /GET_COMPONENT_RENDER_CACHE_CHILDREN/);
	assert.match(boxText, /RELEASE_COMPONENT_RENDER_CACHE/);
	assert.doesNotMatch(setLayoutRoot.getText(altSource), /previousRoot\?\.invalidate/);
	assert.match(setLayoutRoot.getText(altSource), /const previousOwner = previousRoot \?\? this/);
	assert.match(setLayoutRoot.getText(altSource), /for \(let depth = 0; depth < this\.layoutRenderDepth; depth\+\+\)/);
	assert.doesNotMatch(
		setLayoutRoot.getText(altSource),
		/for \(let depth = this\.layoutRenderDepth - 1; depth >= 0; depth--\)[\s\S]*this\.layoutRenderOwners\[depth\] !== previousOwner/,
	);
	assert.match(setLayoutRoot.getText(altSource), /this\.layoutRenderOwners\[depth\] !== previousOwner/);
	assert.match(setLayoutRoot.getText(altSource), /this\.pendingLayoutCacheReleases\[depth\] = previousOwner/);
	assert.match(altText, /this\.releaseDetachedLayoutOwner\([\s\S]*pendingLayoutCacheRelease/);
	assert.match(altText, /private layoutRenderDepth = 0/);
	assert.match(altText, /layoutRenderOwners: Array<Component \| undefined> = \[undefined\]/);
	assert.match(altText, /pendingLayoutCacheReleases: Array<Component \| undefined> = \[undefined\]/);
	assert.match(altText, /this\.layoutRenderDepth = layoutRenderDepth \+ 1/);
	assert.match(altText, /this\.layoutRenderOwners\[layoutRenderDepth\] = this\.layoutRoot \?\? this/);
	assert.match(altText, /this\.layoutRenderDepth = layoutRenderDepth/);
	assert.match(altText, /if \(layoutRenderDepth === 0\) this\.layoutScratch\.flushRequestedClear\(\)/);
	assert.match(setLayoutRoot.getText(altSource), /layoutScratch\.requestClear\(\)/);
	assert.doesNotMatch(setLayoutRoot.getText(altSource), /layoutScratch\.clear\(\)/);
	assert.match(altText, /releaseDetachedComponentRenderCaches\(this\.implicitScrollView, liveRoots\)/);
	assert.match(altText, /resetRenderState\(\): void \{[\s\S]*this\.layoutScratch\.requestClear\(\)/);
	assert.match(
		altText,
		/releaseMountedComponentsAfterDispose[\s\S]*this\.layoutRenderOwners = \[\][\s\S]*this\.pendingLayoutCacheReleases = \[\]/,
	);
	assert.doesNotMatch(releaseLayoutInteractionOwners.getText(altSource), /\.invalidate\(|\.render\(|new (?:Map|Set|Promise|AbortController)|=>|function\s*\(/);
	assert.doesNotMatch(beforeTerminalStop.getText(altSource), /releaseLayoutInteractionOwners/);
	assert.match(altText, /afterTerminalStop[\s\S]*finally \{\s*this\.restoreSavedCapabilities\(\);\s*this\.resetRenderState\(\)/);
	assert.match(altText, /releaseMountedComponentsAfterDispose[\s\S]*this\.restoreSavedCapabilities\(\)/);
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
