import assert from "node:assert/strict";
import test from "node:test";
import { RetainedContainer } from "../packages/tui/src/components/retained-item.ts";
import { ScrollView } from "../packages/tui/src/components/scroll-view.ts";
import { ViewportContainer } from "../packages/tui/src/components/viewport-container.ts";
import { renderLayoutFrame } from "../packages/tui/src/layout.ts";
import { TuiRenderInstrumentation } from "../packages/tui/src/render-instrumentation.ts";
import { registerKittyImageMetadata } from "../packages/tui/src/terminal-image.ts";
import { Container, CURSOR_MARKER, renderFakeCursor, type Component } from "../packages/tui/src/tui.ts";
import { stripTerminalSequences } from "../packages/tui/src/utils.ts";
import { FakeTerminal } from "./helpers/runtime-instrumentation.ts";

class Lines implements Component {
	renderCalls = 0;
	throwOnRender = false;
	readonly lines: string[];
	constructor(lines: string[]) { this.lines = Object.freeze(lines) as unknown as string[]; }
	render(): string[] {
		this.renderCalls++;
		if (this.throwOnRender) throw new Error("tail fixture failure");
		return this.lines;
	}
	invalidate(): void {}
}

test("ordinary tail rows match the requested range without changing borrowed lines", () => {
	const child = new Lines(["1", "2", "3", "4", "5"]);
	const viewport = new ViewportContainer();
	viewport.addChild(child);
	for (const height of [0, 1, 4, 5, 8]) {
		child.renderCalls = 0;
		const rendered = viewport.renderViewportTail(20, height);
		assert.deepEqual(rendered.lines, child.lines.slice(Math.max(0, 5 - height)));
		assert.equal(rendered.startLine, Math.max(0, 5 - height));
		assert.equal(rendered.totalHeight, 5);
		assert.equal(child.renderCalls, 1);
	}
});

test("mixed nested tails preserve indexed offsets and trailing ordinary siblings", () => {
	const retained = new RetainedContainer();
	retained.addRetainedChild(new Lines(["a", "b", "c", "d", "e"]), { id: "history", version: 1, completed: true });
	const nested = new ViewportContainer();
	nested.addChild(new Lines(["prefix"]));
	nested.addChild(retained);
	nested.addChild(new Lines(["f", "g"]));
	const root = new ViewportContainer();
	root.addChild(nested);
	root.addChild(new Lines(["footer"]));
	for (const height of [1, 3, 5, 9]) {
		const rendered = root.renderViewportTail(20, height);
		assert.deepEqual(rendered.lines, ["prefix", "a", "b", "c", "d", "e", "f", "g", "footer"].slice(-height));
		assert.equal(rendered.startLine, 9 - height);
		assert.equal(rendered.totalHeight, 9);
	}
});

test("ordinary tail composition visits only visible text rows and the boundary", () => {
	let rowReads = 0;
	let lengthReads = 0;
	const lines = new Proxy(Array.from({ length: 512 }, (_, index) => `line-${index}`), {
		get(target, key, receiver) {
			if (key === "length") lengthReads++;
			else if (typeof key === "string" && /^\d+$/.test(key)) rowReads++;
			return Reflect.get(target, key, receiver);
		},
	});
	const viewport = new ViewportContainer();
	viewport.addChild({ render: () => lines, invalidate() {} });
	assert.deepEqual(viewport.renderViewportTail(20, 4).lines, ["line-508", "line-509", "line-510", "line-511"]);
	assert.equal(rowReads, 5);
	assert.ok(lengthReads <= 3, `must not walk all 512 rows: ${lengthReads} length reads`);
});

test("nested tail image boundaries match ordinary fullscreen scroll rendering", () => {
	registerKittyImageMetadata({ imageId: 1704, columns: 4, rows: 4, widthPx: 40, heightPx: 40 });
	const imageLine = "\x1b_Ga=T,i=1704,r=4;payload\x1b\\";
	const image = new Lines([imageLine, "", "", "", "after"]);
	const nested = new ViewportContainer();
	nested.addChild(new Lines(["prefix"]));
	nested.addChild(image);
	const root = new ViewportContainer(); root.addChild(nested);
	const rendered = root.renderViewportTail(20, 4);
	assert.deepEqual(rendered.lines, ["", "", "", "after"]);
	assert.deepEqual(rendered.leadingKittyImage, { line: imageLine, absoluteRow: 1 });
	const reference = new Container(); reference.addChild(new Lines(["prefix"])); reference.addChild(image);
	const actualScroll = new ScrollView(root, { follow: "none", primary: true });
	const referenceScroll = new ScrollView(reference, { follow: "none", primary: true });
	for (const scroll of [actualScroll, referenceScroll]) { renderLayoutFrame(scroll, 20, 4, () => {}); scroll.scrollTo(2); }
	assert.deepEqual(renderLayoutFrame(actualScroll, 20, 4, () => {}).lines, renderLayoutFrame(referenceScroll, 20, 4, () => {}).lines);
});

test("ViewportContainer releases borrowed tail arrays and image metadata when an earlier child throws", () => {
	registerKittyImageMetadata({ imageId: 1705, columns: 4, rows: 4, widthPx: 40, heightPx: 40 });
	const failing = new Lines(["prefix"]);
	const retained = new RetainedContainer();
	retained.addRetainedChild(new Lines(["\x1b_Ga=T,i=1705,r=4;payload\x1b\\", "", "", "", "after"]), { id: "image", version: 1, completed: true });
	const owner = new ViewportContainer();
	owner.addChild(failing); owner.addChild(retained);
	const raw = owner as unknown as { tailChildLines: unknown[]; tailChildLeadingKittyImages: unknown[] };
	failing.throwOnRender = true;
	assert.throws(() => owner.renderViewportTail(20, 4), /tail fixture failure/);
	const arrays = [raw.tailChildLines, raw.tailChildLeadingKittyImages];
	for (const entries of arrays) assert.ok(entries.every(value => value === undefined));
	failing.throwOnRender = false;
	assert.deepEqual(owner.renderViewportTail(20, 4), { lines: ["", "", "", "after"], startLine: 2, totalHeight: 6, leadingKittyImage: { line: retained.render(20)[0], absoluteRow: 1 } });
	for (const entries of arrays) assert.ok(entries.every(value => value === undefined));
});
