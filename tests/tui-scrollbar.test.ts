import assert from "node:assert/strict";
import test from "node:test";
import { ScrollView, type ScrollViewScrollbar } from "../packages/tui/src/components/scroll-view.ts";
import { ViewportContainer } from "../packages/tui/src/components/viewport-container.ts";
import { VStack } from "../packages/tui/src/components/v-stack.ts";
import { LayoutFrameScratch, renderLayoutFrame } from "../packages/tui/src/layout.ts";
import type { Component } from "../packages/tui/src/tui.ts";
import { TuiAltScreen } from "../packages/tui/src/tui-alt-screen.ts";
import { visibleWidth } from "../packages/tui/src/utils.ts";
import { FakeTerminal } from "./helpers/runtime-instrumentation.ts";

const THUMB = "\x1b[7m \x1b[27m";

class Lines implements Component {
	readonly widths: number[] = [];
	private readonly lines: string[];

	constructor(lines: string[]) {
		this.lines = lines;
	}

	render(width: number): string[] {
		this.widths.push(width);
		return this.lines;
	}

	invalidate(): void {}
}

function numberedLines(count: number, prefix = "line"): string[] {
	const lines: string[] = [];
	for (let index = 0; index < count; index++) lines.push(`${prefix}-${index}`);
	return lines;
}

function createScroll(scrollbar: ScrollViewScrollbar, lines = numberedLines(100)) {
	const content = new Lines(lines);
	const document = new ViewportContainer();
	document.addChild(content);
	const scroll = new ScrollView(document, {
		follow: "end",
		primary: true,
		scrollbar,
		scrollbarStyle: (text) => `\x1b[7m${text}\x1b[27m`,
		scrollbarHideDelayMs: 60_000,
	});
	return { content, scroll };
}

function render(root: Component, scratch: LayoutFrameScratch, width = 40, height = 10) {
	return renderLayoutFrame(root, width, height, () => {}, scratch);
}

function thumbRows(lines: readonly string[]): number[] {
	const rows: number[] = [];
	// The composite fallback re-serializes the cell's closing SGR as a reset, so match its opening.
	for (let row = 0; row < lines.length; row++) if (lines[row]!.includes("\x1b[7m ")) rows.push(row);
	return rows;
}

test("auto and always scrollbars reserve the last column; hidden keeps the full width", () => {
	for (const [scrollbar, expected] of [
		["auto", 39],
		["always", 39],
		["hidden", 40],
	] as const) {
		const { content, scroll } = createScroll(scrollbar);
		render(scroll, new LayoutFrameScratch());
		assert.equal(content.widths.at(-1), expected, scrollbar);
		assert.equal(scroll.getContentWidth(1), 1, "a one-column viewport never reserves");
	}
});

test("hidden auto scrollbar keeps every reserved row on the cached full-width fast path", () => {
	const { scroll } = createScroll("auto");
	const scratch = new LayoutFrameScratch();
	const first = render(scroll, scratch);
	assert.equal(scroll.isScrollbarVisible, false);
	for (const line of first.lines) assert.equal(visibleWidth(line), 40);
	const steady = render(scroll, scratch);
	assert.equal(steady.fullWidthRowCacheHits, 10);
	assert.equal(steady.scrollbarInlineRows, 0);
	assert.equal(steady.scrollbarCompositeRows, 0);
	assert.equal(steady.stringRepeatCalls, 0);
	assert.deepEqual(thumbRows(steady.lines), []);
});

test("visible scrollbar paints thumb cells inline while the other rows stay cached", () => {
	const { scroll } = createScroll("auto");
	const scratch = new LayoutFrameScratch();
	render(scroll, scratch);
	scroll.scrollBy(-45);
	assert.equal(scroll.isScrollbarVisible, true);
	render(scroll, scratch);
	const frame = render(scroll, scratch);
	const rows = thumbRows(frame.lines);
	assert.equal(rows.length, 2, "10-row track over 100 lines uses the minimum thumb height");
	assert.equal(frame.scrollbarInlineRows, 2);
	assert.equal(frame.scrollbarCompositeRows, 0);
	assert.equal(frame.fullWidthRowCacheHits, 8);
	for (const row of rows) {
		const line = frame.lines[row]!;
		assert.equal(visibleWidth(line), 40);
		assert.ok(line.endsWith(`${THUMB}\x1b[0m\x1b]8;;\x07`), "thumb sits in the reserved last column");
	}
	for (let row = 0; row < frame.lines.length; row++) assert.equal(visibleWidth(frame.lines[row]!), 40);

	scroll.setScrollbar("hidden");
	const hidden = render(scroll, scratch);
	assert.deepEqual(thumbRows(hidden.lines), []);
});

test("thumb rows that cannot use the fast path fall back to a line composite", () => {
	const lines = numberedLines(100);
	for (let index = 0; index < lines.length; index++) lines[index] = `tab\t${index}`;
	const { scroll } = createScroll("always", lines);
	const frame = render(scroll, new LayoutFrameScratch());
	const rows = thumbRows(frame.lines);
	assert.equal(rows.length, 2);
	assert.equal(frame.scrollbarInlineRows, 0);
	assert.equal(frame.scrollbarCompositeRows, 2);
	for (const row of rows) assert.equal(visibleWidth(frame.lines[row]!), 40);
});

test("scrollbar inside a stack with a dock keeps the dock rows untouched", () => {
	const { scroll } = createScroll("always");
	const dock = new Lines(["dock-status", "dock-footer"]);
	const root = new VStack([
		{ component: scroll, basis: 0, grow: 1, minSize: 1 },
		{ component: dock, basis: "auto", minSize: 1 },
	]);
	const frame = render(root, new LayoutFrameScratch());
	const rows = thumbRows(frame.lines);
	assert.deepEqual(rows, [6, 7], "follow-end thumb sits at the bottom of the 8-row track");
	assert.ok(!frame.lines[8]!.includes(THUMB));
	assert.ok(!frame.lines[9]!.includes(THUMB));
	assert.equal(dock.widths.at(-1), 40);
});

function createTui(scrollbar: ScrollViewScrollbar, lines = numberedLines(100)) {
	const { scroll } = createScroll(scrollbar, lines);
	const ui = new TuiAltScreen(new FakeTerminal(40, 10), false, undefined, { mouse: false });
	ui.setLayoutRoot(scroll);
	ui.start();
	ui.renderNow();
	const state = ui as unknown as {
		handleViewportInput(data: string): unknown;
		scrollbarDrag: { grabOffset: number } | undefined;
		selectionAnchor: unknown;
		selectionPressActive: boolean;
	};
	// SGR mouse coordinates are 1-based.
	const press = (x: number, y: number) => state.handleViewportInput(`\x1b[<0;${x + 1};${y + 1}M`);
	const drag = (x: number, y: number) => state.handleViewportInput(`\x1b[<32;${x + 1};${y + 1}M`);
	const move = (x: number, y: number) => state.handleViewportInput(`\x1b[<35;${x + 1};${y + 1}M`);
	const release = (x: number, y: number) => state.handleViewportInput(`\x1b[<0;${x + 1};${y + 1}m`);
	return { ui, scroll, state, press, drag, move, release };
}

test("hovering the hidden auto scrollbar column reveals the bar until the pointer leaves", async () => {
	const { ui, scroll, move } = createTui("auto");
	assert.equal(scroll.isScrollbarVisible, false);
	move(39, 4);
	assert.equal(scroll.isScrollbarVisible, true);
	ui.renderNow();
	move(10, 4);
	assert.equal(scroll.isScrollbarVisible, true, "auto-hide starts after the pointer leaves");
	await ui.dispose({ preserveScreen: true });
	assert.equal(scroll.isScrollbarVisible, false);
});

test("pressing the scrollbar track jumps the thumb under the pointer and continues as a drag", async () => {
	const { ui, scroll, state, press, drag, release } = createTui("auto");
	assert.equal(scroll.scrollTop, 90);
	press(39, 0);
	assert.ok(state.scrollbarDrag, "track press starts a scrollbar drag");
	assert.equal(state.scrollbarDrag!.grabOffset, 1);
	assert.equal(scroll.scrollTop, 0, "thumb centred on row 0 clamps to the top");
	assert.equal(state.selectionAnchor, undefined, "scrollbar press never starts a text selection");
	assert.equal(state.selectionPressActive, false);
	ui.renderNow();

	drag(39, 5);
	// The first drag motion after the jump is coalesced into the drag frame timer.
	release(39, 5);
	assert.equal(state.scrollbarDrag, undefined);
	assert.equal(scroll.scrollTop, Math.round((4 / 8) * 90));
	await ui.dispose({ preserveScreen: true });
});

test("pressing the thumb keeps the grab offset", async () => {
	const { ui, scroll, state, press, release } = createTui("always");
	ui.renderNow();
	press(39, 9);
	assert.equal(state.scrollbarDrag!.grabOffset, 1);
	assert.equal(scroll.scrollTop, 90, "pressing the thumb does not jump");
	release(39, 9);
	await ui.dispose({ preserveScreen: true });
});

test("a non-overflowing scrollbar column stays available to text selection", async () => {
	const { ui, state, press, release } = createTui("always", numberedLines(3));
	press(39, 1);
	assert.equal(state.scrollbarDrag, undefined);
	assert.equal(state.selectionPressActive, true);
	release(39, 1);
	await ui.dispose({ preserveScreen: true });
});
