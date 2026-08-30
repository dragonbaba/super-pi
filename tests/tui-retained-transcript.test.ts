import assert from "node:assert/strict";
import test from "node:test";
import {
	RetainedContainer,
	RetainedItem,
	type RetainedRenderContext,
} from "../packages/tui/src/components/retained-item.ts";
import { TuiRenderInstrumentation } from "../packages/tui/src/render-instrumentation.ts";
import type { Component } from "../packages/tui/src/tui.ts";
import { Image } from "../packages/tui/src/components/image.ts";
import { setCapabilities, setCellDimensions } from "../packages/tui/src/terminal-image.ts";
import { TuiAltScreen } from "../packages/tui/src/tui-alt-screen.ts";
import { TuiMainScreen } from "../packages/tui/src/tui-main-screen.ts";
import { FakeTerminal } from "./helpers/runtime-instrumentation.ts";

class MutableLine implements Component {
	renderCalls = 0;
	invalidations = 0;
	value: string;

	constructor(value: string) {
		this.value = value;
	}

	render(width: number): string[] {
		this.renderCalls++;
		return [`${this.value}:${width}`];
	}

	invalidate(): void {
		this.invalidations++;
	}
}

test("active updates do not rerender 5,000 completed transcript items", () => {
	const instrumentation = new TuiRenderInstrumentation();
	const transcript = new RetainedContainer({ instrumentation });
	for (let index = 0; index < 5_000; index++) {
		transcript.addRetainedChild(new MutableLine(`history-${index}`), {
			id: `history-${index}`,
			version: 1,
			completed: true,
		});
	}
	const activeComponent = new MutableLine("active-0");
	const active = transcript.addRetainedChild(activeComponent, {
		id: "active",
		version: 0,
		completed: false,
	});

	assert.equal(transcript.render(120).length, 5_001);
	instrumentation.reset();
	activeComponent.value = "active-1";
	active.updateVersion(1);
	assert.equal(transcript.render(120).at(-1), "active-1:120");

	assert.deepEqual(instrumentation.snapshot(), {
		rootRenders: 0,
		transcriptItemRenders: 1,
		completedItemRenders: 0,
		activeItemRenders: 1,
		generatedLines: 0,
		visibleLines: 0,
		overlayRenders: 0,
		terminalDiffLines: 0,
		terminalBytes: 0,
		pendingRenderRequestHighWaterMark: 0,
		terminalFrameQueueHighWaterMark: 0,
		terminalActiveWriteHighWaterMark: 0,
		terminalPendingFrameHighWaterMark: 0,
		terminalFramesReplaced: 0,
		terminalFrameWriteErrors: 0,
		physicalTerminalFrameWrites: 0,
		frameStringsGenerated: 0,
		frameStringUtf8BytesGenerated: 0,
		fullSizeFrameCopies: 0,
		maximumFrameUtf8Bytes: 0,
		activeFrameUtf8Bytes: 0,
		pendingFrameUtf8Bytes: 0,
		framePromisesCreated: 0,
		frameAbortControllersCreated: 0,
		frameWrapperObjectsCreated: 0,
		retainedCacheHits: 5_000,
		retainedCacheMisses: 0,
		viewportItemVisits: 0,
		viewportLineArrays: 0,
		viewportComposedLines: 0,
		viewportCopiedLines: 0,
		viewportTargetHeightLookupProbes: 0,
		viewportBlockLookupProbes: 0,
		mutationEventWrites: 1,
		fullHistoryFallbacks: 0,
		cursorScannedLines: 0,
		altLayoutNodesVisited: 0,
		altLayoutBoxObjects: 0,
		altLayoutRectObjects: 0,
		altLayoutClipObjects: 0,
		altLayoutRenderCacheLookupProbes: 0,
		altLayoutRenderCacheRecordCount: 0,
		altLayoutRenderCacheIndexActivations: 0,
		altLayoutScreenArraysCreated: 0,
		altLayoutFullViewportArrayCopies: 0,
		altLayoutStringRepeatCalls: 0,
		altLayoutStringRepeatBytes: 0,
		altLayoutPaintBoxCalls: 0,
		altLayoutChildRenderCalls: 0,
		altLayoutFullWidthRowCacheHits: 0,
		altLayoutCachedSourceCodeUnits: 0,
		altLayoutCachedPaintedCodeUnits: 0,
		altLayoutMaximumCachedRowCodeUnits: 0,
		altLayoutRowCacheRejectedBySize: 0,
	});
});

test("retained children preserve the original component identity", () => {
	const transcript = new RetainedContainer();
	const assistant = new MutableLine("assistant");
	const retained = transcript.addRetainedChild(assistant, {
		id: "assistant",
		version: 1,
		completed: true,
	});

	assert.equal(transcript.children[0], assistant);
	assert.equal(transcript.children.indexOf(assistant), 0);
	const inserted = new MutableLine("tool");
	transcript.children.splice(transcript.children.indexOf(assistant), 0, inserted);
	assert.deepEqual(transcript.children, [inserted, assistant]);

	transcript.removeChild(assistant);
	assert.equal(retained.released, true);
	assert.deepEqual(transcript.children, [inserted]);
});

test("invalid retained metadata does not partially append the original child", () => {
	const transcript = new RetainedContainer();
	const component = new MutableLine("invalid");
	assert.throws(
		() => transcript.addRetainedChild(component, { id: "invalid", version: -1, completed: true }),
		/non-negative safe integer/,
	);
	assert.deepEqual(transcript.children, []);
	assert.equal(transcript.getRetainedStats().retainedItems, 0);
});

test("50,000 retained items preserve output while only the active renderer changes", () => {
	const instrumentation = new TuiRenderInstrumentation();
	const transcript = new RetainedContainer({ instrumentation });
	for (let index = 0; index < 50_000; index++) {
		transcript.addRetainedChild(new MutableLine(String(index)), {
			id: String(index),
			version: 1,
			completed: true,
		});
	}
	const activeComponent = new MutableLine("active-0");
	const active = transcript.addRetainedChild(activeComponent, { id: "active", version: 0 });
	const baseline = transcript.render(80);
	instrumentation.reset();
	activeComponent.value = "active-1";
	active.updateVersion(1);
	const updated = transcript.render(80);

	assert.deepEqual(updated.slice(0, -1), baseline.slice(0, -1));
	assert.equal(updated.at(-1), "active-1:80");
	assert.equal(instrumentation.snapshot().completedItemRenders, 0);
	assert.equal(instrumentation.snapshot().retainedCacheHits, 50_000);
});

test("retained cache keys cover width and presentation versions without retaining old widths", () => {
	const instrumentation = new TuiRenderInstrumentation();
	const context: RetainedRenderContext = {
		themeVersion: 1,
		rendererVersion: 1,
		expandVersion: 1,
		settingsVersion: 1,
	};
	const component = new MutableLine("stable");
	const item = new RetainedItem(component, {
		id: "stable",
		version: 7,
		completed: true,
		instrumentation,
		getContext: () => context,
	});

	assert.deepEqual(item.render(80), ["stable:80"]);
	assert.deepEqual(item.render(80), ["stable:80"]);
	assert.equal(component.renderCalls, 1);
	assert.deepEqual(item.render(100), ["stable:100"]);
	assert.equal(item.cachedWidth, 100);
	assert.equal(item.cachedLineCount, 1);

	context.themeVersion++;
	item.render(100);
	context.rendererVersion++;
	item.render(100);
	context.expandVersion++;
	item.render(100);
	context.settingsVersion++;
	item.render(100);
	assert.equal(component.renderCalls, 6);
	assert.equal(instrumentation.snapshot().retainedCacheHits, 1);
});

test("completion freezes logical version and removal releases retained resources", () => {
	const transcript = new RetainedContainer();
	const component = new MutableLine("active");
	const item = transcript.addRetainedChild(component, { id: "active", version: 1 });
	item.updateVersion(2);
	item.complete();
	item.render(80);
	assert.throws(() => item.updateVersion(3), /completed retained item/i);
	assert.equal(item.completedVersion, 2);
	assert.equal(item.cachedLineCount, 1);

	transcript.removeChild(component);
	assert.equal(item.released, true);
	assert.equal(item.component, undefined);
	assert.equal(item.cachedLineCount, 0);
	assert.throws(() => item.render(80), /released retained item/i);

	const another = transcript.addRetainedChild(new MutableLine("another"), {
		id: "another",
		version: 1,
		completed: true,
	});
	another.render(80);
	assert.deepEqual(transcript.getRetainedStats(), {
		retainedItems: 1,
		completedItems: 1,
		activeItems: 0,
		cachedItems: 1,
		cachedLines: 1,
		estimatedCachedBytes: 10,
	});
	transcript.clear();
	assert.equal(another.released, true);
	assert.deepEqual(transcript.getRetainedStats(), {
		retainedItems: 0,
		completedItems: 0,
		activeItems: 0,
		cachedItems: 0,
		cachedLines: 0,
		estimatedCachedBytes: 0,
	});
});

test("invalidate reaches an image component and refreshes Kitty cell-dimension output", () => {
	setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
	setCellDimensions({ widthPx: 10, heightPx: 20 });
	try {
		const image = new Image("AA==", "image/png", { fallbackColor: (value) => value }, { maxWidthCells: 10 }, {
			widthPx: 100,
			heightPx: 100,
		});
		const transcript = new RetainedContainer();
		transcript.addRetainedChild(image, { id: "image", version: 1, completed: true });
		const initial = transcript.render(20);
		assert.equal(transcript.getContentHeight(20), initial.length);
		setCellDimensions({ widthPx: 5, heightPx: 20 });
		transcript.invalidate();
		const viewport = transcript.renderViewportTail(20, 20);
		const resized = image.render(20);
		assert.equal(viewport.totalHeight, resized.length);
		assert.deepEqual(viewport.lines, resized.slice(-20));
		assert.notEqual(resized.length, initial.length);
		assert.match(resized[0] ?? "", /^\u001b_G/);
	} finally {
		setCellDimensions({ widthPx: 9, heightPx: 18 });
		setCapabilities({ images: null, trueColor: false, hyperlinks: false });
	}
});

test("10,000 active updates stay uncached until the final version is frozen", () => {
	const instrumentation = new TuiRenderInstrumentation();
	const component = new MutableLine("active-0");
	const item = new RetainedItem(component, { id: "active", version: 0, instrumentation });
	for (let version = 1; version <= 10_000; version++) {
		component.value = `active-${version}`;
		item.updateVersion(version);
		assert.equal(item.render(80)[0], `active-${version}:80`);
	}
	assert.equal(item.cachedLineCount, 0);
	assert.equal(instrumentation.snapshot().activeItemRenders, 10_000);

	item.complete();
	assert.equal(item.render(80)[0], "active-10000:80");
	assert.equal(item.render(80)[0], "active-10000:80");
	assert.equal(item.cachedLineCount, 1);
	assert.equal(instrumentation.snapshot().completedItemRenders, 1);
	assert.equal(instrumentation.snapshot().retainedCacheHits, 1);
});

test("TUI instrumentation records root, overlay, diff, bytes, and pending render requests", () => {
	const instrumentation = new TuiRenderInstrumentation();
	const transcript = new RetainedContainer({ instrumentation });
	transcript.addRetainedChild(new MutableLine("history"), { id: "history", version: 1, completed: true });
	const activeComponent = new MutableLine("active-0");
	const active = transcript.addRetainedChild(activeComponent, { id: "active", version: 0 });
	const tui = new TuiMainScreen(new FakeTerminal(80, 20), false);
	tui.setRenderInstrumentation(instrumentation);
	tui.addChild(transcript);
	tui.showOverlay(new MutableLine("overlay"), { width: 20 });
	tui.renderNow();

	let metrics = instrumentation.snapshot();
	assert.equal(metrics.rootRenders, 1);
	assert.equal(metrics.transcriptItemRenders, 2);
	assert.equal(metrics.overlayRenders, 1);
	assert.equal(metrics.generatedLines, 2);
	assert.equal(metrics.visibleLines, 2);
	assert.equal(metrics.terminalDiffLines, 20);
	assert.ok(metrics.terminalBytes > 0);
	assert.equal(metrics.pendingRenderRequestHighWaterMark, 1);

	instrumentation.reset();
	activeComponent.value = "active-1";
	active.updateVersion(1);
	tui.requestRender();
	tui.renderNow();
	metrics = instrumentation.snapshot();
	assert.equal(metrics.completedItemRenders, 0);
	assert.equal(metrics.activeItemRenders, 1);
	assert.equal(metrics.retainedCacheHits, 1);
	assert.equal(metrics.rootRenders, 1);
	assert.equal(metrics.overlayRenders, 1);
	assert.equal(metrics.terminalDiffLines, 1);
	assert.equal(metrics.pendingRenderRequestHighWaterMark, 1);
});

test("instrumentation counts UTF-8 bytes, resets cleanly, and stays isolated per TUI", () => {
	const first = new TuiRenderInstrumentation();
	const second = new TuiRenderInstrumentation();
	const utf8Bytes = Buffer.byteLength("中😀", "utf8");
	first.recordTerminalFrameGenerated(utf8Bytes);
	first.recordTerminalFrame(utf8Bytes, 1);
	assert.equal(first.snapshot().terminalBytes, Buffer.byteLength("中😀", "utf8"));
	assert.equal(first.snapshot().terminalDiffLines, 1);
	assert.equal(first.snapshot().frameStringsGenerated, 1);
	assert.equal(first.snapshot().frameStringUtf8BytesGenerated, utf8Bytes);
	assert.equal(first.snapshot().maximumFrameUtf8Bytes, utf8Bytes);
	assert.equal(first.snapshot().fullSizeFrameCopies, 0);
	assert.equal(first.snapshot().framePromisesCreated, 0);
	assert.equal(first.snapshot().frameAbortControllersCreated, 0);
	assert.equal(first.snapshot().frameWrapperObjectsCreated, 0);
	assert.equal(second.snapshot().terminalBytes, 0);
	first.reset();
	assert.equal(first.snapshot().terminalBytes, 0);
	assert.equal(first.snapshot().frameStringsGenerated, 0);
	assert.equal(second.snapshot().terminalBytes, 0);
});

test("Alt Screen instrumentation records root, overlay, diff, and UTF-8 frame bytes", () => {
	const instrumentation = new TuiRenderInstrumentation();
	const tui = new TuiAltScreen(new FakeTerminal(40, 10), false, undefined, { mouse: false });
	tui.setRenderInstrumentation(instrumentation);
	tui.addChild(new MutableLine("正文-中😀"));
	tui.showOverlay(new MutableLine("浮层-😀"), { width: 12 });
	tui.start();
	try {
		instrumentation.reset();
		tui.renderNow();
		const metrics = instrumentation.snapshot();
		assert.equal(metrics.rootRenders, 1);
		assert.equal(metrics.overlayRenders, 1);
		assert.equal(metrics.generatedLines, 1);
		assert.equal(metrics.visibleLines, 10);
		assert.equal(metrics.terminalDiffLines, 10);
		assert.ok(metrics.terminalBytes > Buffer.byteLength("正文-中😀浮层-😀", "utf8"));
	} finally {
		tui.stop();
	}
});

test("Alt Screen distinguishes generated transcript lines from its visible viewport", () => {
	const instrumentation = new TuiRenderInstrumentation();
	const transcript = new RetainedContainer({ instrumentation });
	for (let index = 0; index < 50_000; index++) {
		transcript.addRetainedChild(new MutableLine(`history-${index}`), {
			id: `history-${index}`,
			version: 1,
			completed: true,
		});
	}
	const tui = new TuiAltScreen(new FakeTerminal(120, 40), false, undefined, { mouse: false });
	tui.setRenderInstrumentation(instrumentation);
	tui.addChild(transcript);
	tui.start();
	try {
		instrumentation.reset();
		tui.renderNow();
		const metrics = instrumentation.snapshot();
		assert.ok(metrics.generatedLines > metrics.visibleLines);
		assert.equal(metrics.generatedLines, 50_000);
		assert.ok(metrics.visibleLines <= 40);
	} finally {
		tui.stop();
	}
});
