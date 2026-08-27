import assert from "node:assert/strict";
import test from "node:test";
import { RetainedContainer } from "../packages/tui/src/components/retained-item.ts";
import { Text } from "../packages/tui/src/components/text.ts";
import { TuiRenderInstrumentation } from "../packages/tui/src/render-instrumentation.ts";
import { type Component, CURSOR_MARKER } from "../packages/tui/src/tui.ts";
import { TuiMainScreen } from "../packages/tui/src/tui-main-screen.ts";
import { stripTerminalSequences } from "../packages/tui/src/utils.ts";
import { FakeTerminal } from "./helpers/runtime-instrumentation.ts";
import { BashExecutionComponent } from "../packages/coding-agent/src/modes/interactive/components/bash-execution.ts";
import { initTheme } from "../packages/coding-agent/src/modes/interactive/theme/theme.ts";

class MutableLines implements Component {
	renderCalls = 0;
	readonly id: string;
	private lineCount: number;
	private suffix: string;

	constructor(id: string, lineCount = 1, suffix = "") {
		this.id = id;
		this.lineCount = lineCount;
		this.suffix = suffix;
	}

	setLines(lineCount: number, suffix = this.suffix): void {
		this.lineCount = lineCount;
		this.suffix = suffix;
	}

	render(width: number): string[] {
		this.renderCalls++;
		const lines: string[] = [];
		for (let index = 0; index < this.lineCount; index++) lines.push(`${this.id}:${index}:${width}${this.suffix}`);
		return lines;
	}

	invalidate(): void {}
}

class StableHugeItem implements Component {
	renderCalls = 0;
	readonly lines: string[];

	constructor(lineCount: number) {
		this.lines = new Array<string>(lineCount);
		for (let index = 0; index < lineCount; index++) this.lines[index] = `huge-${index}`;
	}

	render(): string[] {
		this.renderCalls++;
		return this.lines;
	}

	invalidate(): void {}
}

function addCompleted(transcript: RetainedContainer, component: Component, id: string): void {
	transcript.addRetainedChild(component, { id, version: 1, completed: true });
}

function fullReferenceLines(transcript: RetainedContainer, width: number): string[] {
	const lines: string[] = [];
	for (const child of transcript.children) {
		for (const line of child.render(width)) lines.push(line);
	}
	return lines;
}

function assertIndexedTailMatchesReference(transcript: RetainedContainer, width: number, height: number): void {
	const viewport = transcript.renderViewportTail(width, height);
	const reference = fullReferenceLines(transcript, width);
	assert.equal(viewport.totalHeight, reference.length);
	assert.equal(transcript.getViewportIndexStats().totalHeight, reference.length);
	assert.deepEqual(viewport.lines, reference.slice(-height));
}

test("5k and 50k active-only frames have the same bounded lookup and copy work", () => {
	const measurements: Array<{
		items: number;
		target: number;
		blocks: number;
		visits: number;
		copied: number;
	}> = [];
	for (const itemCount of [5_000, 50_000]) {
		const instrumentation = new TuiRenderInstrumentation();
		const transcript = new RetainedContainer({ instrumentation });
		for (let index = 0; index < itemCount; index++) addCompleted(transcript, new MutableLines(`h-${index}`), `h-${index}`);
		const activeComponent = new MutableLines("active");
		const active = transcript.addRetainedChild(activeComponent, { id: "active", version: 0 });
		transcript.getContentHeight(120);
		instrumentation.reset();
		activeComponent.setLines(2);
		active.advanceVersion();
		const viewport = transcript.renderViewportTail(120, 40);
		const metrics = instrumentation.snapshot();
		assert.equal(viewport.lines.length, 40);
		assert.equal(viewport.measuredItems, 1);
		assert.equal(metrics.fullHistoryFallbacks, 0);
		assert.equal(metrics.viewportCopiedLines, 40);
		assert.equal(metrics.viewportComposedLines, 40);
		assert.ok(metrics.viewportItemVisits <= 40);
		assert.ok(metrics.viewportTargetHeightLookupProbes <= 40);
		assert.equal(metrics.viewportBlockLookupProbes, 0);
		measurements.push({
			items: itemCount,
			target: metrics.viewportTargetHeightLookupProbes,
			blocks: metrics.viewportBlockLookupProbes,
			visits: metrics.viewportItemVisits,
			copied: metrics.viewportCopiedLines,
		});
	}
	assert.deepEqual(measurements[1], { ...measurements[0], items: 50_000 });
});

test("one 100,000-line retained item copies only the requested middle and bottom windows", () => {
	const instrumentation = new TuiRenderInstrumentation();
	const transcript = new RetainedContainer({ instrumentation });
	const huge = new StableHugeItem(100_000);
	addCompleted(transcript, huge, "huge");
	assert.equal(transcript.getContentHeight(100), 100_000);
	huge.renderCalls = 0;

	for (const start of [50_000, 99_960]) {
		instrumentation.reset();
		const viewport = transcript.renderViewport(100, start, 40);
		assert.equal(viewport.startLine, start);
		assert.equal(viewport.lines.length, 40);
		assert.equal(viewport.lines[0], `huge-${start}`);
		assert.equal(viewport.copiedLines, 40);
		assert.equal(viewport.visitedItems, 1);
		assert.equal(instrumentation.snapshot().viewportCopiedLines, 40);
		assert.equal(instrumentation.snapshot().viewportComposedLines, 40);
		assert.equal(huge.renderCalls, 0);
	}
});

test("50,000 zero-height items and a visible tail stay bounded across 0-N-0", () => {
	const instrumentation = new TuiRenderInstrumentation();
	const transcript = new RetainedContainer({ instrumentation });
	for (let index = 0; index < 50_000; index++) addCompleted(transcript, new MutableLines(`zero-${index}`, 0), `zero-${index}`);
	const tail = new MutableLines("tail", 3);
	const state = transcript.addRetainedChild(tail, { id: "tail", version: 0 });
	assert.equal(transcript.getContentHeight(80), 3);

	for (const height of [20, 0]) {
		instrumentation.reset();
		tail.setLines(height);
		state.advanceVersion();
		const viewport = transcript.renderViewportTail(80, 10);
		assert.equal(viewport.totalHeight, height);
		assert.ok(viewport.visitedItems <= 1);
		assert.ok(viewport.targetHeightLookupProbes <= 1);
		assert.ok(viewport.copiedLines <= 10);
	}
});

test("insert, placeholder replacement, retained move, block boundary mutation, remove, and clear rebuild exactly", () => {
	const transcript = new RetainedContainer();
	const components: MutableLines[] = [];
	for (let index = 0; index < 300; index++) {
		const component = new MutableLines(`item-${index}`);
		components.push(component);
		addCompleted(transcript, component, `item-${index}`);
	}
	assertIndexedTailMatchesReference(transcript, 90, 30);

	const streaming = new MutableLines("streaming", 2);
	transcript.addChild(streaming);
	const custom = new MutableLines("custom", 3);
	const streamingIndex = transcript.children.indexOf(streaming);
	transcript.children.splice(streamingIndex, 0, custom);
	transcript.notifyChildrenChanged();
	assertIndexedTailMatchesReference(transcript, 90, 30);

	const placeholder = new MutableLines("placeholder");
	transcript.children.splice(255, 0, placeholder);
	transcript.notifyChildrenChanged();
	const deferred = new MutableLines("deferred", 4);
	const placeholderIndex = transcript.children.indexOf(placeholder);
	transcript.children.splice(placeholderIndex, 1, deferred);
	transcript.notifyChildrenChanged();
	transcript.retainChild(deferred, { id: "deferred", version: 0 });
	assertIndexedTailMatchesReference(transcript, 90, 30);

	const moved = components[256];
	const movedIndex = transcript.children.indexOf(moved);
	transcript.children.splice(movedIndex, 1);
	transcript.children.splice(255, 0, moved);
	transcript.notifyChildrenChanged();
	assert.equal(transcript.children[255], moved);
	assert.equal(transcript.getRetainedItem(moved)?.completed, true);
	assertIndexedTailMatchesReference(transcript, 90, 30);

	transcript.removeChild(components[10]);
	assert.equal(transcript.getRetainedItem(components[10]), undefined);
	assertIndexedTailMatchesReference(transcript, 90, 30);
	transcript.clear();
	assert.deepEqual(transcript.getViewportIndexStats(), {
		indexedItems: 0,
		heightBlocks: 0,
		dirtyItems: 0,
		totalHeight: 0,
		width: undefined,
	});
});

test("production Bash progress refreshes only its dynamic height and stays bottom-golden", () => {
	initTheme("dark");
	const transcript = new RetainedContainer();
	for (let index = 0; index < 5_000; index++) addCompleted(transcript, new MutableLines(`history-${index}`), `history-${index}`);
	const ui = new TuiMainScreen(new FakeTerminal(100, 30), false);
	const bash = new BashExecutionComponent("for i in 1 2 3; do echo $i; done", ui);
	transcript.addChild(bash);
	assertIndexedTailMatchesReference(transcript, 100, 30);

	bash.appendOutput("one\ntwo 中文 😀\nthree e\u0301\nfour\nfive");
	assert.equal(transcript.invalidateViewportChild(bash), true);
	const progress = transcript.renderViewportTail(100, 30);
	const progressReference = fullReferenceLines(transcript, 100);
	assert.equal(progress.measuredItems, 1);
	assert.equal(progress.totalHeight, progressReference.length);
	assert.deepEqual(progress.lines, progressReference.slice(-30));

	bash.setComplete(0, false);
	assert.equal(transcript.invalidateViewportChild(bash), true);
	assertIndexedTailMatchesReference(transcript, 100, 30);
	ui.stop({ preserveScreen: true });
});

test("cursor and two overlays scan and compose only the visible 50k tail", () => {
	const instrumentation = new TuiRenderInstrumentation();
	const transcript = new RetainedContainer({ instrumentation });
	for (let index = 0; index < 50_000; index++) {
		const suffix = index === 100 ? CURSOR_MARKER : "";
		addCompleted(transcript, new MutableLines(`history-${index}`, 1, suffix), `history-${index}`);
	}
	const activeComponent = new MutableLines("输入-中文😀e\u0301", 1, CURSOR_MARKER);
	const active = transcript.addRetainedChild(activeComponent, { id: "active", version: 0 });
	const terminal = new FakeTerminal(120, 40);
	const tui = new TuiMainScreen(terminal, true);
	tui.setRenderInstrumentation(instrumentation);
	tui.addChild(transcript);
	tui.renderNow();

	instrumentation.reset();
	active.advanceVersion();
	tui.renderNow();
	let metrics = instrumentation.snapshot();
	assert.equal(metrics.cursorScannedLines, 1);
	assert.equal(metrics.completedItemRenders, 0);
	assert.ok(metrics.viewportItemVisits <= 40);
	const golden = transcript.render(120).slice(-40).map(stripTerminalSequences);
	assert.deepEqual(tui.captureRenderState().previousLines.map(stripTerminalSequences), golden);

	activeComponent.setLines(1, "");
	active.advanceVersion();
	instrumentation.reset();
	tui.renderNow();
	metrics = instrumentation.snapshot();
	assert.equal(metrics.cursorScannedLines, 40);
	assert.equal(metrics.completedItemRenders, 0);

	const firstOptions = { width: 18, row: 2, col: 3 };
	const first = tui.showOverlay(new Text("overlay-one"), firstOptions);
	const second = tui.showOverlay(new Text("overlay-two"), { width: 18, row: 2, col: 3 });
	instrumentation.reset();
	tui.renderNow();
	metrics = instrumentation.snapshot();
	assert.equal(metrics.overlayRenders, 2);
	assert.equal(metrics.completedItemRenders, 0);
	const transcriptVisits = metrics.viewportItemVisits;

	firstOptions.row = 4;
	first.focus();
	instrumentation.reset();
	tui.renderNow();
	metrics = instrumentation.snapshot();
	assert.equal(metrics.overlayRenders, 2);
	assert.equal(metrics.viewportItemVisits, transcriptVisits);
	assert.equal(metrics.completedItemRenders, 0);

	second.setHidden(true);
	first.hide();
	instrumentation.reset();
	tui.renderNow();
	metrics = instrumentation.snapshot();
	assert.equal(metrics.overlayRenders, 0);
	assert.equal(metrics.completedItemRenders, 0);
});
