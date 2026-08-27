import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { RetainedContainer } from "../packages/tui/src/components/retained-item.ts";
import { ScrollView } from "../packages/tui/src/components/scroll-view.ts";
import { ViewportContainer } from "../packages/tui/src/components/viewport-container.ts";
import { TuiRenderInstrumentation } from "../packages/tui/src/render-instrumentation.ts";
import type { Terminal } from "../packages/tui/src/terminal.ts";
import { type Component, CURSOR_MARKER } from "../packages/tui/src/tui.ts";
import { TuiAltScreen } from "../packages/tui/src/tui-alt-screen.ts";
import { TuiMainScreen, type TuiMainScreenRenderState } from "../packages/tui/src/tui-main-screen.ts";
import { deleteKittyImage, registerKittyImageMetadata } from "../packages/tui/src/terminal-image.ts";
import { stripTerminalSequences } from "../packages/tui/src/utils.ts";
import { FakeTerminal } from "./helpers/runtime-instrumentation.ts";

const require = createRequire(import.meta.url);
const { Terminal: HeadlessTerminal } = require("@xterm/headless") as {
	Terminal: new (options: Record<string, unknown>) => {
		write(data: string, callback?: () => void): void;
		resize(columns: number, rows: number): void;
		dispose(): void;
		buffer: {
			active: {
				length: number;
				viewportY: number;
				getLine(index: number): { translateToString(trimRight: boolean): string } | undefined;
			};
		};
	};
};

class HeadlessCaptureTerminal implements Terminal {
	readonly writes: string[] = [];
	columns: number;
	rows: number;
	readonly kittyProtocolActive = false;
	private readonly emulator: InstanceType<typeof HeadlessTerminal>;
	private pendingWrites = 0;

	constructor(columns: number, rows: number) {
		this.columns = columns;
		this.rows = rows;
		this.emulator = new HeadlessTerminal({ columns, cols: columns, rows, scrollback: 200_000, allowProposedApi: true });
	}

	start(): void {}
	stop(): void {}
	async drainInput(): Promise<void> {}
	write(data: string): void {
		this.writes.push(data);
		this.pendingWrites++;
		this.emulator.write(data, () => this.pendingWrites--);
	}
	moveBy(): void {}
	hideCursor(): void {}
	showCursor(): void {}
	clearLine(): void {}
	clearFromCursor(): void {}
	clearScreen(): void {}
	setTitle(): void {}
	setProgress(): void {}

	async flush(): Promise<void> {
		for (let attempt = 0; attempt < 1_000 && this.pendingWrites > 0; attempt++) {
			await new Promise<void>((resolve) => setTimeout(resolve, 0));
		}
		assert.equal(this.pendingWrites, 0, "headless terminal writes must drain");
	}

	resize(columns: number, rows: number): void {
		this.columns = columns;
		this.rows = rows;
		this.emulator.resize(columns, rows);
	}

	logicalLines(): string[] {
		const result: string[] = [];
		const buffer = this.emulator.buffer.active;
		for (let index = 0; index < buffer.length; index++) result.push(buffer.getLine(index)?.translateToString(true) ?? "");
		while (result.length > 0 && result.at(-1) === "") result.pop();
		return result;
	}

	visibleLines(): string[] {
		const result: string[] = [];
		const buffer = this.emulator.buffer.active;
		for (let row = 0; row < this.rows; row++) {
			result.push(buffer.getLine(buffer.viewportY + row)?.translateToString(true) ?? "");
		}
		return result;
	}

	dispose(): void {
		this.emulator.dispose();
	}
}

class MutableMainItem implements Component {
	renderCalls = 0;
	readonly id: string;
	private lineCount: number;
	private cursor = false;
	private variant = 0;

	constructor(id: string, lineCount = 1) {
		this.id = id;
		this.lineCount = lineCount;
	}

	setLineCount(lineCount: number): void {
		this.lineCount = lineCount;
	}

	setCursor(cursor: boolean): void {
		this.cursor = cursor;
	}

	advanceVisual(): void {
		this.variant++;
	}

	render(width: number): string[] {
		this.renderCalls++;
		const lines: string[] = [];
		for (let index = 0; index < this.lineCount; index++) {
			const marker = this.cursor && index === this.lineCount - 1 ? CURSOR_MARKER : "";
			lines.push(`${this.id}:${index}:${width}:v${this.variant}${marker}`);
		}
		return lines;
	}

	invalidate(): void {}
}

function plain(line: string): string {
	return stripTerminalSequences(line).replaceAll(CURSOR_MARKER, "").trimEnd();
}

function fullReference(transcript: RetainedContainer, width: number): string[] {
	const result: string[] = [];
	for (const child of transcript.children) {
		for (const line of child.render(width)) result.push(plain(line));
	}
	return result;
}

async function assertMainState(
	label: string,
	terminal: HeadlessCaptureTerminal,
	tui: TuiMainScreen,
	transcript: RetainedContainer,
): Promise<TuiMainScreenRenderState> {
	await terminal.flush();
	const state = tui.captureRenderState();
	const expected = fullReference(transcript, terminal.columns);
	const previousVisible = state.previousLines.slice(-terminal.rows).map(plain);
	assert.deepEqual(previousVisible, expected.slice(-terminal.rows), `${label}: retained visible viewport`);
	assert.deepEqual(terminal.visibleLines().slice(-Math.min(terminal.rows, expected.length)), expected.slice(-terminal.rows), `${label}: terminal viewport`);
	assert.deepEqual(terminal.logicalLines(), expected, `${label}: logical terminal scrollback`);
	const expectedWindowStart = Math.max(0, expected.length - terminal.rows);
	if (state.viewportWindowStart !== undefined) assert.equal(state.viewportWindowStart, expectedWindowStart, `${label}: absolute window start`);
	if (state.viewportDocumentHeight !== undefined) assert.equal(state.viewportDocumentHeight, expected.length, `${label}: document height`);
	assert.equal(state.hardwareCursorRow, Math.max(0, expected.length - 1), `${label}: hardware cursor row`);
	return state;
}

test("Main Screen absolute window survives growth, shrink, append, resize, and Main-Alt-Main restore", async () => {
	const instrumentation = new TuiRenderInstrumentation();
	const transcript = new RetainedContainer({ instrumentation });
	for (let index = 0; index < 200; index++) {
		transcript.addRetainedChild(new MutableMainItem(`history-${index}`), {
			id: `history-${index}`,
			version: 1,
			completed: true,
		});
	}
	const activeComponent = new MutableMainItem("输入-中文😀e\u0301");
	activeComponent.setCursor(true);
	const active = transcript.addRetainedChild(activeComponent, { id: "active", version: 0 });
	const terminal = new HeadlessCaptureTerminal(100, 20);
	const main = new TuiMainScreen(terminal, true);
	main.setRenderInstrumentation(instrumentation);
	main.addChild(transcript);

	main.renderNow();
	let state = await assertMainState("first full replay", terminal, main, transcript);
	assert.equal(state.viewportWindowStart, undefined);
	assert.equal(instrumentation.snapshot().fullHistoryFallbacks, 1);

	instrumentation.reset();
	activeComponent.advanceVisual();
	active.advanceVersion();
	main.renderNow();
	state = await assertMainState("stable active update", terminal, main, transcript);
	assert.equal(state.viewportWindowStart, 181);
	assert.equal(instrumentation.snapshot().fullHistoryFallbacks, 0);
	assert.ok(instrumentation.snapshot().terminalBytes > 0);

	for (const [lineCount, label] of [
		[100, "active grow 1 to 100"],
		[3, "active shrink 100 to 3"],
	] as const) {
		instrumentation.reset();
		activeComponent.setLineCount(lineCount);
		active.advanceVersion();
		main.renderNow();
		await assertMainState(label, terminal, main, transcript);
		assert.equal(instrumentation.snapshot().fullHistoryFallbacks, 1);
	}

	instrumentation.reset();
	const appendedComponent = new MutableMainItem("appended");
	appendedComponent.setCursor(true);
	activeComponent.setCursor(false);
	transcript.addRetainedChild(appendedComponent, { id: "appended", version: 1, completed: true });
	main.renderNow();
	await assertMainState("append while following bottom", terminal, main, transcript);
	assert.equal(instrumentation.snapshot().fullHistoryFallbacks, 0);

	instrumentation.reset();
	activeComponent.setLineCount(1);
	active.advanceVersion();
	main.renderNow();
	await assertMainState("content shrink", terminal, main, transcript);
	assert.equal(instrumentation.snapshot().fullHistoryFallbacks, 1);

	await terminal.flush();
	terminal.resize(100, 30);
	instrumentation.reset();
	main.renderNow();
	await assertMainState("height resize", terminal, main, transcript);
	assert.equal(instrumentation.snapshot().fullHistoryFallbacks, 1);

	await terminal.flush();
	terminal.resize(80, 30);
	instrumentation.reset();
	main.renderNow();
	state = await assertMainState("width resize full fallback", terminal, main, transcript);
	assert.equal(instrumentation.snapshot().fullHistoryFallbacks, 1);

	const captured = state;
	const document = new ViewportContainer();
	document.addChild(transcript);
	const alt = new TuiAltScreen(terminal, true, undefined, { mouse: false });
	alt.setLayoutRoot(new ScrollView(document, { follow: "end", primary: true }));
	alt.start();
	alt.renderNow();
	await terminal.flush();
	alt.stop({ preserveScreen: true });
	await terminal.flush();

	const restored = new TuiMainScreen(terminal, true);
	restored.setRenderInstrumentation(instrumentation);
	restored.addChild(transcript);
	restored.restoreRenderState(captured);
	instrumentation.reset();
	restored.renderNow();
	await assertMainState("Main to Alt to Main capture restore", terminal, restored, transcript);
	assert.equal(instrumentation.snapshot().fullHistoryFallbacks, 0);

	restored.stop();
	await terminal.flush();
	assert.ok(terminal.logicalLines().some((line) => line.includes("appended")), "regular stop preserves transcript");
	terminal.dispose();
});

test("Main Screen bounds only attributed tail and visible-window mutations", async () => {
	const instrumentation = new TuiRenderInstrumentation();
	const context = { themeVersion: 0, rendererVersion: 0, expandVersion: 0, settingsVersion: 0 };
	const transcript = new RetainedContainer({ instrumentation, getContext: () => context });
	const history: MutableMainItem[] = [];
	for (let index = 0; index < 120; index++) {
		const component = new MutableMainItem(`history-${index}`);
		history.push(component);
		transcript.addRetainedChild(component, { id: `history-${index}`, version: 1, completed: true });
	}
	const activeComponent = new MutableMainItem("active");
	activeComponent.setCursor(true);
	const active = transcript.addRetainedChild(activeComponent, { id: "active", version: 0 });
	const terminal = new HeadlessCaptureTerminal(90, 20);
	const main = new TuiMainScreen(terminal, true);
	main.setRenderInstrumentation(instrumentation);
	main.addChild(transcript);

	const renderAndAssert = async (label: string, expectedFallbacks: number): Promise<void> => {
		instrumentation.reset();
		main.renderNow();
		await assertMainState(label, terminal, main, transcript);
		assert.equal(instrumentation.snapshot().fullHistoryFallbacks, expectedFallbacks, `${label}: fallback count`);
	};
	const reenterBoundedWindow = async (label: string): Promise<void> => {
		activeComponent.advanceVisual();
		active.advanceVersion();
		await renderAndAssert(label, 0);
	};

	await renderAndAssert("mutation source first replay", 1);
	await reenterBoundedWindow("mutation source initial visible update");

	history[5].advanceVisual();
	transcript.getRetainedItem(history[5])?.invalidateRetainedRender();
	await renderAndAssert("offscreen same-height content mutation", 1);
	await reenterBoundedWindow("after offscreen content fallback");

	history[6].setLineCount(2);
	transcript.getRetainedItem(history[6])?.invalidateRetainedRender();
	await renderAndAssert("offscreen height mutation", 1);
	await reenterBoundedWindow("after offscreen height fallback");

	const first = transcript.children[8];
	const second = transcript.children[9];
	transcript.children.splice(8, 2, second, first);
	transcript.notifyChildrenChanged();
	await renderAndAssert("same-total reorder rebuild", 1);
	await reenterBoundedWindow("after reorder fallback");

	history[10].advanceVisual();
	context.expandVersion++;
	transcript.invalidateViewportHeights();
	await renderAndAssert("offscreen presentation mutation", 1);
	await reenterBoundedWindow("after presentation fallback");

	const appended = new MutableMainItem("tail-append");
	activeComponent.setCursor(false);
	appended.setCursor(true);
	transcript.addRetainedChild(appended, { id: "tail-append", version: 1, completed: true });
	await renderAndAssert("attributed tail append", 0);

	activeComponent.advanceVisual();
	active.advanceVersion();
	await renderAndAssert("attributed visible active update", 0);

	main.stop({ preserveScreen: true });
	terminal.dispose();
});

test("Main Screen preserves offscreen Kitty IDs until a full fallback deletes them", () => {
	const imageId = 912;
	registerKittyImageMetadata({ imageId, columns: 4, rows: 4, widthPx: 40, heightPx: 40 });
	const imageLine = `\x1b_Ga=T,i=${imageId},r=4;payload\x1b\\`;
	const transcript = new RetainedContainer();
	transcript.addRetainedChild(
		{
			render: () => [imageLine, "", "", ""],
			invalidate: () => {},
		},
		{ id: "offscreen-image", version: 1, completed: true },
	);
	for (let index = 0; index < 100; index++) {
		transcript.addRetainedChild(new MutableMainItem(`text-${index}`), {
			id: `text-${index}`,
			version: 1,
			completed: true,
		});
	}
	const activeComponent = new MutableMainItem("active");
	const active = transcript.addRetainedChild(activeComponent, { id: "active", version: 0 });
	const terminal = new FakeTerminal(80, 20);
	const main = new TuiMainScreen(terminal, false);
	main.addChild(transcript);

	main.renderNow();
	assert.deepEqual(main.captureRenderState().previousKittyImageIds, [imageId]);
	activeComponent.advanceVisual();
	active.advanceVersion();
	main.renderNow();
	assert.deepEqual(main.captureRenderState().previousKittyImageIds, [imageId]);

	const writeStart = terminal.writes.length;
	terminal.columns = 79;
	main.renderNow();
	assert.ok(terminal.writes.slice(writeStart).join("").includes(deleteKittyImage(imageId)));
	assert.deepEqual(main.captureRenderState().previousKittyImageIds, [imageId]);
});

test("fullscreen exit writes the complete retained transcript back to main scrollback", async () => {
	const transcript = new RetainedContainer();
	for (let index = 0; index < 250; index++) {
		transcript.addRetainedChild(new MutableMainItem(`full-${index}`), {
			id: `full-${index}`,
			version: 1,
			completed: true,
		});
	}
	const document = new ViewportContainer();
	document.addChild(transcript);
	const terminal = new HeadlessCaptureTerminal(80, 20);
	const alt = new TuiAltScreen(terminal, false, undefined, { mouse: false });
	alt.setLayoutRoot(new ScrollView(document, { follow: "end", primary: true }));
	alt.start();
	alt.renderNow();
	await terminal.flush();
	alt.stop();
	await terminal.flush();
	assert.deepEqual(terminal.logicalLines(), fullReference(transcript, 80));
	terminal.dispose();
});
