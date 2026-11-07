import assert from "node:assert/strict";
import test from "node:test";
import { RetainedContainer } from "../packages/tui/src/components/retained-item.ts";
import { ScrollView } from "../packages/tui/src/components/scroll-view.ts";
import { ViewportContainer } from "../packages/tui/src/components/viewport-container.ts";
import { renderLayoutFrame } from "../packages/tui/src/layout.ts";
import { getLayoutFrameScopeState } from "../packages/tui/src/layout-frame-scope.ts";
import { TuiRenderInstrumentation } from "../packages/tui/src/render-instrumentation.ts";
import type { Component } from "../packages/tui/src/tui.ts";
import { TuiAltScreen } from "../packages/tui/src/tui-alt-screen.ts";
import { FakeTerminal } from "./helpers/runtime-instrumentation.ts";

class CountingLine implements Component {
	renders = 0;
	value: string;
	constructor(value: string) { this.value = value; }
	render(width: number): string[] { this.renders++; return [`${this.value}:${width}`]; }
	invalidate(): void {}
}

class ThrowingLine implements Component {
	render(): string[] { throw new Error("frame render failure"); }
	invalidate(): void {}
}

function noop(): void {}

function assertScopeReleased(): void {
	assert.deepEqual(getLayoutFrameScopeState(), { depth: 0, registeredOwners: 0, retainedOwnerSlots: 0 });
}

function assertNoPreparedLines(container: RetainedContainer): void {
	const counts = container.getRetainedLifecycleReferenceCounts();
	assert.equal(counts.preparedLineReferences, 0);
	assert.equal(counts.preparedViewportRecords, 0);
}

test("an active retained item renders once per fullscreen frame and nothing outlives the frame", () => {
	const instrumentation = new TuiRenderInstrumentation();
	const transcript = new RetainedContainer({ instrumentation });
	for (let index = 0; index < 50; index++) {
		transcript.addRetainedChild(new CountingLine(`done-${index}`), { id: `done-${index}`, version: 1, completed: true });
	}
	const activeLine = new CountingLine("active-0");
	const active = transcript.addRetainedChild(activeLine, { id: "active", version: 0 });
	const tui = new TuiAltScreen(new FakeTerminal(80, 20), false, undefined, { mouse: false });
	tui.setRenderInstrumentation(instrumentation);
	tui.addChild(transcript);
	tui.start();
	try {
		tui.renderNow();
		for (let version = 1; version <= 100; version++) {
			activeLine.value = `active-${version}`;
			active.updateVersion(version);
			const before = activeLine.renders;
			instrumentation.reset();
			tui.renderNow();
			assert.equal(activeLine.renders - before, 1, `frame ${version}`);
			assert.equal(instrumentation.snapshot().activeItemRenders, 1);
			assert.equal(instrumentation.snapshot().completedItemRenders, 0);
			assertNoPreparedLines(transcript);
			assertScopeReleased();
		}
		const screen = (tui as unknown as { previousScreen: string[] }).previousScreen;
		assert.ok(screen.some((line) => line.includes("active-100:")));
	} finally {
		tui.stop();
	}
});

test("off-screen retained children measured only for height release their lines at frame end", () => {
	const upper = new RetainedContainer();
	const upperActive = new CountingLine("upper-0");
	const upperItem = upper.addRetainedChild(upperActive, { id: "upper", version: 0 });
	const lower = new RetainedContainer();
	for (let index = 0; index < 40; index++) {
		lower.addRetainedChild(new CountingLine(`lower-${index}`), { id: `lower-${index}`, version: 1, completed: true });
	}
	const document = new ViewportContainer();
	document.addChild(upper);
	document.addChild(lower);
	const root = new ScrollView(document, { follow: "end", primary: true });
	renderLayoutFrame(root, 60, 10, noop);
	upperActive.value = "upper-1";
	upperItem.updateVersion(1);
	const frame = renderLayoutFrame(root, 60, 10, noop);
	assert.ok(!frame.lines.some((line) => line.includes("upper-")), "upper child stays above the tail");
	assertNoPreparedLines(upper);
	assertNoPreparedLines(lower);
	assertScopeReleased();
});

test("a frame that throws after measuring still releases prepared lines and the scope", () => {
	const transcript = new RetainedContainer();
	const activeLine = new CountingLine("active-0");
	const active = transcript.addRetainedChild(activeLine, { id: "active", version: 0 });
	const document = new ViewportContainer();
	document.addChild(transcript);
	const root = new ScrollView(document, { follow: "end", primary: true });
	renderLayoutFrame(root, 60, 10, noop);
	activeLine.value = "active-1";
	active.updateVersion(1);
	document.addChild(new ThrowingLine());
	assert.throws(() => renderLayoutFrame(root, 60, 10, noop), /frame render failure/);
	assertNoPreparedLines(transcript);
	assertScopeReleased();
});

test("height queries outside a layout frame keep the previous release-immediately behaviour", () => {
	const transcript = new RetainedContainer();
	const activeLine = new CountingLine("active-0");
	const active = transcript.addRetainedChild(activeLine, { id: "active", version: 0 });
	assert.equal(transcript.getContentHeight(40), 1);
	activeLine.value = "active-1";
	active.updateVersion(1);
	assert.equal(transcript.getContentHeight(40), 1);
	assertNoPreparedLines(transcript);
	assertScopeReleased();
	const rendered = transcript.renderViewport(40, 0, 5);
	assert.deepEqual(rendered.lines, ["active-1:40"]);
});
