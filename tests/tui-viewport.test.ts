import assert from "node:assert/strict";
import test from "node:test";
import { RetainedContainer } from "../packages/tui/src/components/retained-item.ts";
import { ScrollView } from "../packages/tui/src/components/scroll-view.ts";
import { ViewportContainer } from "../packages/tui/src/components/viewport-container.ts";
import { renderLayoutFrame } from "../packages/tui/src/layout.ts";
import { type Component, Container, CURSOR_MARKER } from "../packages/tui/src/tui.ts";
import { TuiMainScreen } from "../packages/tui/src/tui-main-screen.ts";
import { TuiAltScreen } from "../packages/tui/src/tui-alt-screen.ts";
import { TuiRenderInstrumentation } from "../packages/tui/src/render-instrumentation.ts";
import { isImageLine, registerKittyImageMetadata } from "../packages/tui/src/terminal-image.ts";
import { stripTerminalSequences } from "../packages/tui/src/utils.ts";
import { FakeTerminal } from "./helpers/runtime-instrumentation.ts";

class LinesComponent implements Component {
	renderCalls = 0;
	readonly id: string;
	private lineCount: number;

	constructor(id: string, lineCount = 1) {
		this.id = id;
		this.lineCount = lineCount;
	}

	setLineCount(lineCount: number): void {
		this.lineCount = lineCount;
	}

	render(width: number): string[] {
		this.renderCalls++;
		const lines: string[] = [];
		for (let index = 0; index < this.lineCount; index++) lines.push(`${this.id}:${index}:${width}`);
		return lines;
	}

	invalidate(): void {}
}

class FixedLinesComponent implements Component {
	private readonly lines: string[];

	constructor(lines: string[]) {
		this.lines = lines;
	}

	render(): string[] {
		return this.lines;
	}

	invalidate(): void {}
}

function buildTranscript(itemCount: number): {
	transcript: RetainedContainer;
	items: LinesComponent[];
} {
	const transcript = new RetainedContainer();
	const items: LinesComponent[] = [];
	for (let index = 0; index < itemCount; index++) {
		const component = new LinesComponent(`history-${index}`);
		items.push(component);
		transcript.addRetainedChild(component, {
			id: `history-${index}`,
			version: 1,
			completed: true,
		});
	}
	return { transcript, items };
}

test("bottom viewport visits only enough retained items for 5k and 50k histories", () => {
	for (const itemCount of [5_000, 50_000]) {
		const { transcript, items } = buildTranscript(itemCount);
		assert.equal(transcript.getContentHeight(120), itemCount);
		for (const item of items) item.renderCalls = 0;

		const viewport = transcript.renderViewportTail(120, 40);
		assert.equal(viewport.totalHeight, itemCount);
		assert.equal(viewport.startLine, itemCount - 40);
		assert.equal(viewport.lines.length, 40);
		assert.equal(viewport.lines[0], `history-${itemCount - 40}:0:120`);
		assert.ok(viewport.visitedItems <= 80);
		assert.equal(viewport.measuredItems, 0);
		assert.equal(items.slice(0, -40).reduce((sum, item) => sum + item.renderCalls, 0), 0);
	}
});

test("historical viewport uses cumulative heights instead of walking from the first item", () => {
	const transcript = new RetainedContainer();
	for (let index = 0; index < 50_000; index++) {
		transcript.addRetainedChild(new LinesComponent(`item-${index}`, index % 7 === 0 ? 2 : 1), {
			id: `item-${index}`,
			version: 1,
			completed: true,
		});
	}
	const totalHeight = transcript.getContentHeight(80);
	const startLine = Math.floor(totalHeight / 2);
	const viewport = transcript.renderViewport(80, startLine, 30);

	assert.equal(viewport.totalHeight, totalHeight);
	assert.ok(viewport.startLine <= startLine);
	assert.ok(viewport.lines.length >= 30);
	assert.ok(viewport.visitedItems < 300);
	assert.equal(viewport.measuredItems, 0);
	assert.deepEqual(
		viewport.lines.slice(startLine - viewport.startLine, startLine - viewport.startLine + 30),
		transcript.render(80).slice(startLine, startLine + 30),
	);
});

test("append and active height changes update the height index incrementally", () => {
	const { transcript } = buildTranscript(5_000);
	assert.equal(transcript.getContentHeight(100), 5_000);

	const activeComponent = new LinesComponent("active", 1);
	const active = transcript.addRetainedChild(activeComponent, {
		id: "active",
		version: 0,
		completed: false,
	});
	let viewport = transcript.renderViewportTail(100, 20);
	assert.equal(viewport.totalHeight, 5_001);
	assert.equal(viewport.measuredItems, 1);

	activeComponent.setLineCount(4);
	active.advanceVersion();
	viewport = transcript.renderViewportTail(100, 20);
	assert.equal(viewport.totalHeight, 5_004);
	assert.equal(viewport.measuredItems, 1);
	assert.equal(viewport.lines.at(-1), "active:3:100");
	assert.ok(viewport.visitedItems <= 40);
});

test("targeted dynamic plain child invalidation refreshes height without scanning history", () => {
	const { transcript } = buildTranscript(5_000);
	const dynamic = new LinesComponent("dynamic", 1);
	transcript.addChild(dynamic);
	assert.equal(transcript.getContentHeight(100), 5_001);

	dynamic.setLineCount(5);
	assert.equal(transcript.invalidateViewportChild(dynamic), true);
	const viewport = transcript.renderViewportTail(100, 20);
	assert.equal(viewport.totalHeight, 5_005);
	assert.equal(viewport.measuredItems, 1);
	assert.equal(viewport.lines.at(-1), "dynamic:4:100");
	assert.ok(viewport.visitedItems <= 40);
});

test("presentation boundaries batch-refresh heights once, then return to incremental updates", () => {
	const context = { themeVersion: 0, rendererVersion: 0, expandVersion: 0, settingsVersion: 0 };
	const transcript = new RetainedContainer({ getContext: () => context });
	const items: LinesComponent[] = [];
	for (let index = 0; index < 5_000; index++) {
		const item = new LinesComponent(`item-${index}`);
		items.push(item);
		transcript.addRetainedChild(item, { id: `item-${index}`, version: 1, completed: true });
	}
	assert.equal(transcript.getContentHeight(100), 5_000);
	for (const item of items) item.setLineCount(2);
	context.expandVersion++;
	transcript.invalidateViewportHeights();
	let viewport = transcript.renderViewportTail(100, 20);
	assert.equal(viewport.measuredItems, 5_000);
	assert.equal(viewport.totalHeight, 10_000);

	viewport = transcript.renderViewportTail(100, 20);
	assert.equal(viewport.measuredItems, 0);
	assert.ok(viewport.visitedItems <= 40);
});

test("width changes batch-remeasure once and retain only the latest width", () => {
	const { transcript } = buildTranscript(5_000);
	assert.equal(transcript.getContentHeight(120), 5_000);

	let viewport = transcript.renderViewportTail(80, 40);
	assert.equal(viewport.measuredItems, 5_000);
	assert.equal(transcript.getRetainedStats().cachedItems, 5_000);

	viewport = transcript.renderViewportTail(80, 40);
	assert.equal(viewport.measuredItems, 0);
	assert.equal(transcript.getRetainedStats().cachedItems, 5_000);
	assert.equal(transcript.getRetainedStats().cachedLines, 5_000);
});

test("clear releases viewport index records and height blocks", () => {
	const { transcript } = buildTranscript(50_000);
	assert.equal(transcript.getContentHeight(120), 50_000);
	assert.deepEqual(transcript.getViewportIndexStats(), {
		indexedItems: 50_000,
		heightBlocks: Math.ceil(50_000 / 256),
		dirtyItems: 0,
		totalHeight: 50_000,
		width: 120,
		preparedItems: 0,
	});

	transcript.clear();
	assert.deepEqual(transcript.getViewportIndexStats(), {
		indexedItems: 0,
		heightBlocks: 0,
		dirtyItems: 0,
		totalHeight: 0,
		width: undefined,
		preparedItems: 0,
	});
});

function createGoldenDocument(retained: boolean): { document: Component; scroll: ScrollView } {
	const transcript = retained ? new RetainedContainer() : new Container();
	for (let index = 0; index < 2_000; index++) {
		const component = new LinesComponent(
			index === 1_999 ? `尾部-中😀e\u0301${CURSOR_MARKER}` : `history-${index}`,
			index % 11 === 0 ? 3 : 1,
		);
		if (transcript instanceof RetainedContainer) {
			transcript.addRetainedChild(component, { id: `item-${index}`, version: 1, completed: true });
		} else {
			transcript.addChild(component);
		}
	}
	const document = retained ? new ViewportContainer() : new Container();
	(document as Container).addChild(new LinesComponent("header", 2));
	(document as Container).addChild(transcript);
	const scroll = new ScrollView(document, { follow: "end", primary: true });
	return { document, scroll };
}

test("fullscreen bottom and historical viewports are golden-equivalent to full layout", () => {
	const retained = createGoldenDocument(true);
	const reference = createGoldenDocument(false);
	const render = (root: Component) => renderLayoutFrame(root, 80, 25, () => {}).lines;

	assert.deepEqual(render(retained.scroll), render(reference.scroll));
	retained.scroll.scrollTo(900);
	reference.scroll.scrollTo(900);
	assert.deepEqual(render(retained.scroll), render(reference.scroll));
	retained.scroll.scrollToEnd();
	reference.scroll.scrollToEnd();
	assert.deepEqual(render(retained.scroll), render(reference.scroll));
});

test("viewport item boundaries preserve Kitty cropping when scroll starts inside an image", () => {
	registerKittyImageMetadata({ imageId: 704, columns: 4, rows: 4, widthPx: 40, heightPx: 40 });
	const imageLine = "\x1b_Ga=T,i=704,r=4;payload\x1b\\";
	const create = (retained: boolean): ScrollView => {
		const transcript = retained ? new RetainedContainer() : new Container();
		for (let index = 0; index < 10; index++) {
			const line = new FixedLinesComponent([`prefix-${index}`]);
			if (transcript instanceof RetainedContainer) {
				transcript.addRetainedChild(line, { id: `prefix-${index}`, version: 1, completed: true });
			} else transcript.addChild(line);
		}
		const image = new FixedLinesComponent([imageLine, "", "", "", "after-image"]);
		if (transcript instanceof RetainedContainer) {
			transcript.addRetainedChild(image, { id: "image", version: 1, completed: true });
		} else transcript.addChild(image);
		return new ScrollView(transcript, { follow: "none", primary: true });
	};
	const retained = create(true);
	const reference = create(false);
	renderLayoutFrame(retained, 40, 4, () => {});
	renderLayoutFrame(reference, 40, 4, () => {});
	retained.scrollTo(11);
	reference.scrollTo(11);
	const retainedLines = renderLayoutFrame(retained, 40, 4, () => {}).lines;
	const referenceLines = renderLayoutFrame(reference, 40, 4, () => {}).lines;
	assert.deepEqual(retainedLines, referenceLines);
	assert.equal(isImageLine(retainedLines[0] ?? ""), true);
});

test("fullscreen prompt navigation and selection use absolute virtual document rows", () => {
	const transcript = new RetainedContainer();
	for (let index = 0; index < 1_000; index++) {
		const prefix = index === 100 || index === 800 ? "\x1b]133;A\x07" : "";
		transcript.addRetainedChild(new FixedLinesComponent([`${prefix}row-${index}`]), {
			id: `row-${index}`,
			version: 1,
			completed: true,
		});
	}
	const scroll = new ScrollView(transcript, { follow: "none", primary: true });
	const terminal = new FakeTerminal(80, 20);
	const tui = new TuiAltScreen(terminal, false, undefined, { mouse: false });
	tui.setLayoutRoot(scroll);
	tui.start();
	try {
		tui.renderNow();
		const internals = tui as unknown as {
			scrollToPrompt(direction: -1 | 1): void;
			getSelectionSourceLine(point: { row: number; col: number; scrollView: ScrollView }): string;
			selectionAnchor?: { row: number; col: number; scrollView: ScrollView };
			selectionFocus?: { row: number; col: number; boundary?: boolean; scrollView: ScrollView };
			copySelectionToClipboard(): void;
		};

		internals.scrollToPrompt(1);
		assert.equal(scroll.scrollTop, 100);
		scroll.scrollTo(500);
		tui.renderNow();
		internals.scrollToPrompt(1);
		assert.equal(scroll.scrollTop, 800);
		internals.scrollToPrompt(-1);
		assert.equal(scroll.scrollTop, 100);

		scroll.scrollTo(500);
		tui.renderNow();
		assert.equal(internals.getSelectionSourceLine({ row: 500, col: 0, scrollView: scroll }), "row-500");
		internals.selectionAnchor = { row: 498, col: 0, scrollView: scroll };
		internals.selectionFocus = { row: 502, col: 7, boundary: true, scrollView: scroll };
		internals.copySelectionToClipboard();
		let clipboardWrite: string | undefined;
		for (let index = terminal.writes.length - 1; index >= 0; index--) {
			if (!terminal.writes[index].includes("\x1b]52;c;")) continue;
			clipboardWrite = terminal.writes[index];
			break;
		}
		assert.ok(clipboardWrite);
		const encoded = clipboardWrite.slice("\x1b]52;c;".length, -1);
		assert.equal(Buffer.from(encoded, "base64").toString(), "row-498\nrow-499\nrow-500\nrow-501\nrow-502");
	} finally {
		tui.stop();
	}
});

test("active-only fullscreen frames do not visit completed offscreen history", () => {
	for (const itemCount of [5_000, 50_000]) {
		const { transcript, items } = buildTranscript(itemCount);
		const activeComponent = new LinesComponent("active");
		const active = transcript.addRetainedChild(activeComponent, {
			id: "active",
			version: 0,
			completed: false,
		});
		const document = new ViewportContainer();
		document.addChild(transcript);
		const scroll = new ScrollView(document, { follow: "end", primary: true });
		renderLayoutFrame(scroll, 120, 40, () => {});
		for (const item of items) item.renderCalls = 0;

		activeComponent.setLineCount(2);
		active.advanceVersion();
		const frame = renderLayoutFrame(scroll, 120, 40, () => {});
		assert.ok(frame.lines.at(-1)?.includes("active:1:120"));
		assert.equal(items.slice(0, -39).reduce((sum, item) => sum + item.renderCalls, 0), 0);
	}
});

test("main screen active and overlay frames stay bounded by the visible transcript", () => {
	for (const itemCount of [5_000, 50_000]) {
		const instrumentation = new TuiRenderInstrumentation();
		const transcript = new RetainedContainer({ instrumentation });
		for (let index = 0; index < itemCount; index++) {
			transcript.addRetainedChild(new LinesComponent(`history-${index}`), {
				id: `history-${index}`,
				version: 1,
				completed: true,
			});
		}
		const activeComponent = new LinesComponent("active");
		const active = transcript.addRetainedChild(activeComponent, { id: "active", version: 0 });
		const tui = new TuiMainScreen(new FakeTerminal(120, 40), false);
		tui.setRenderInstrumentation(instrumentation);
		tui.addChild(transcript);
		tui.renderNow();

		instrumentation.reset();
		activeComponent.setLineCount(2);
		active.advanceVersion();
		tui.renderNow();
		let metrics = instrumentation.snapshot();
		assert.equal(metrics.completedItemRenders, 0);
		assert.equal(metrics.activeItemRenders, 1);
		assert.ok(metrics.retainedCacheHits < 100);
		assert.ok(metrics.viewportItemVisits < 100);
		assert.ok(metrics.viewportComposedLines <= 40);
		assert.equal(metrics.generatedLines, itemCount + 2);
		assert.ok(tui.captureRenderState().previousLines.length <= 40);
		assert.deepEqual(
			tui.captureRenderState().previousLines.map(stripTerminalSequences),
			transcript.render(120).slice(-40).map(stripTerminalSequences),
		);

		instrumentation.reset();
		const overlay = tui.showOverlay(new LinesComponent("overlay"), { width: 20 });
		tui.renderNow();
		metrics = instrumentation.snapshot();
		assert.equal(metrics.completedItemRenders, 0);
		assert.ok(metrics.retainedCacheHits < 100);
		assert.ok(metrics.viewportItemVisits < 100);
		overlay.hide();
	}
});
