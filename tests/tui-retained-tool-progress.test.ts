import assert from "node:assert/strict";
import test from "node:test";
import { setCapabilities, setCellDimensions } from "@super-pi/tui";
import {
	ReadToolGroupComponent,
	ToolExecutionComponent,
	replaceToolPlaceholder,
} from "../packages/coding-agent/src/modes/interactive/components/tool-execution.ts";
import type { ToolDefinition } from "../packages/coding-agent/src/core/extensions/types.ts";
import { initTheme } from "../packages/coding-agent/src/modes/interactive/theme/theme.ts";
import { RetainedContainer } from "../packages/tui/src/components/retained-item.ts";
import { TuiRenderInstrumentation } from "../packages/tui/src/render-instrumentation.ts";
import { isImageLine } from "../packages/tui/src/terminal-image.ts";
import { type Component, Container } from "../packages/tui/src/tui.ts";
import { TuiMainScreen } from "../packages/tui/src/tui-main-screen.ts";
import { FakeTerminal } from "./helpers/runtime-instrumentation.ts";

class CountingHistoryItem implements Component {
	renderCalls = 0;
	private readonly text: string;
	constructor(text: string) {
		this.text = text;
	}
	render(): string[] {
		this.renderCalls++;
		return [this.text];
	}
	invalidate(): void {}
}

function createTool(
	id: string,
	toolDefinition?: ToolDefinition<any, any>,
	onVisualInvalidate?: (component: ToolExecutionComponent) => void,
): ToolExecutionComponent {
	const ui = new TuiMainScreen(new FakeTerminal(100, 30), false);
	return new ToolExecutionComponent(
		"phase4a-progress",
		id,
		{ step: 0 },
		{ onVisualInvalidate },
		toolDefinition,
		ui,
		process.cwd(),
	);
}

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
	for (let attempt = 0; attempt < 200; attempt++) {
		if (predicate()) return;
		await new Promise<void>((resolve) => setTimeout(resolve, 5));
	}
	throw new Error(`Timed out waiting for ${label}`);
}

function updateTool(tool: ToolExecutionComponent, step: number, isPartial = true): void {
	tool.updateArgs({ step });
	tool.updateResult(
		{
			content: [{ type: "text", text: `progress ${step} 中文 😀` }],
			isError: false,
		},
		isPartial,
	);
}

test("5,000 completed items stay retained through 10,000 real tool progress updates", () => {
	initTheme("dark");
	const instrumentation = new TuiRenderInstrumentation();
	const retained = new RetainedContainer({ instrumentation });
	const reference = new Container();
	const retainedHistory: CountingHistoryItem[] = [];
	for (let index = 0; index < 5_000; index++) {
		const retainedItem = new CountingHistoryItem(`history-${index}`);
		retainedHistory.push(retainedItem);
		retained.addRetainedChild(retainedItem, { id: `history-${index}`, version: 1, completed: true });
		reference.addChild(new CountingHistoryItem(`history-${index}`));
	}
	const retainedTool = createTool("retained-tool");
	const referenceTool = createTool("reference-tool");
	const retainedToolState = retained.addRetainedChild(retainedTool, { id: "active-tool", version: 0 });
	reference.addChild(referenceTool);

	retained.render(100);
	instrumentation.reset();
	for (let step = 1; step <= 10_000; step++) {
		updateTool(retainedTool, step);
		retainedToolState.updateVersion(step);
		retained.render(100);
	}
	const progressMetrics = instrumentation.snapshot();
	assert.equal(progressMetrics.completedItemRenders, 0);
	assert.equal(progressMetrics.activeItemRenders, 10_000);
	assert.equal(progressMetrics.retainedCacheHits, 50_000_000);
	assert.ok(retainedHistory.every((item) => item.renderCalls === 1));

	updateTool(referenceTool, 10_000);
	assert.deepEqual(retained.render(100), reference.render(100), "active progress output");

	retainedTool.setExpanded(true);
	referenceTool.setExpanded(true);
	retainedToolState.updateVersion(10_001);
	assert.deepEqual(retained.render(100), reference.render(100), "expanded tool output");

	const retainedPlaceholder = new Container();
	const referencePlaceholder = new Container();
	retained.children.splice(retained.children.indexOf(retainedTool), 0, retainedPlaceholder);
	reference.children.splice(reference.children.indexOf(referenceTool), 0, referencePlaceholder);
	assert.equal(replaceToolPlaceholder(retained.children, retainedPlaceholder, retainedTool), true);
	assert.equal(replaceToolPlaceholder(reference.children, referencePlaceholder, referenceTool), true);
	assert.equal(retained.children.indexOf(retainedTool), reference.children.indexOf(referenceTool));
	assert.equal(retained.getRetainedItem(retainedTool), retainedToolState);
	assert.deepEqual(retained.render(100), reference.render(100), "placeholder replacement");

	updateTool(retainedTool, 10_001, false);
	updateTool(referenceTool, 10_001, false);
	retainedToolState.updateVersion(10_002);
	retainedToolState.complete();
	assert.deepEqual(retained.render(100), reference.render(100), "final tool output");
	assert.equal(retainedToolState.completed, true);
});

test("50,000 completed items keep zero underlying renders for one real tool update", () => {
	initTheme("dark");
	const instrumentation = new TuiRenderInstrumentation();
	const retained = new RetainedContainer({ instrumentation });
	const history: CountingHistoryItem[] = [];
	for (let index = 0; index < 50_000; index++) {
		const component = new CountingHistoryItem(`history-${index}`);
		history.push(component);
		retained.addRetainedChild(component, { id: `history-${index}`, version: 1, completed: true });
	}
	const tool = createTool("directional-tool");
	const toolState = retained.addRetainedChild(tool, { id: "active-tool", version: 0 });
	retained.render(100);
	instrumentation.reset();
	updateTool(tool, 1);
	toolState.updateVersion(1);
	retained.render(100);

	const metrics = instrumentation.snapshot();
	assert.equal(metrics.completedItemRenders, 0);
	assert.equal(metrics.activeItemRenders, 1);
	assert.equal(metrics.retainedCacheHits, 50_000);
	assert.ok(history.every((component) => component.renderCalls === 1));
});

test("a finalized read group stays active until every late result is complete", () => {
	initTheme("dark");
	const group = new ReadToolGroupComponent();
	assert.equal(group.updateArgs("read-1", { path: "README.md" }), true);
	group.markExecutionStarted("read-1");
	group.setArgsComplete("read-1");
	group.finalize();
	assert.equal(group.canFreezeRender(), false);
	group.updateResult("read-1", { content: [{ type: "text", text: "done" }], isError: false }, false);
	assert.equal(group.canFreezeRender(), true);
});

test("deferred image conversion invalidates a completed tool cache", async () => {
	initTheme("dark");
	setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
	setCellDimensions({ widthPx: 9, heightPx: 18 });
	try {
		const transcript = new RetainedContainer();
		const tool = createTool("late-image", undefined, (component) => transcript.invalidateRetainedChild(component));
		const item = transcript.addRetainedChild(tool, { id: "late-image", version: 0 });
		tool.updateResult({
			content: [
				{
					type: "image",
					data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
					mimeType: "image/png",
				},
				{ type: "image", data: "R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==", mimeType: "image/gif" },
			],
			isError: false,
		});
		item.advanceVersion();
		item.complete();
		const primed = transcript.render(100);
		assert.equal(transcript.getContentHeight(100), primed.length);

		await waitFor(() => tool.render(100).filter(isImageLine).length === 2, "deferred second-image PNG conversion");
		const reference = tool.render(100);
		const viewport = transcript.renderViewportTail(100, 40);
		const updated = tool.render(100);
		assert.notDeepEqual(updated, primed);
		assert.deepEqual(updated, reference);
		assert.equal(viewport.totalHeight, reference.length);
		assert.deepEqual(viewport.lines, reference.slice(-40));
	} finally {
		setCellDimensions({ widthPx: 9, heightPx: 18 });
		setCapabilities({ images: null, trueColor: false, hyperlinks: false });
	}
});

test("custom renderer invalidation rerenders only its completed retained tool", () => {
	initTheme("dark");
	const instrumentation = new TuiRenderInstrumentation();
	const transcript = new RetainedContainer({ instrumentation });
	const history: CountingHistoryItem[] = [];
	for (let index = 0; index < 5_000; index++) {
		const component = new CountingHistoryItem(`history-${index}`);
		history.push(component);
		transcript.addRetainedChild(component, { id: `history-${index}`, version: 1, completed: true });
	}

	let visual = "first";
	let capturedInvalidate: (() => void) | undefined;
	let resultRendererCalls = 0;
	const definition = {
		name: "phase4a-progress",
		label: "Phase 4A progress",
		description: "test renderer",
		parameters: {},
		execute: async () => ({ content: [], details: undefined }),
		renderCall: () => new CountingHistoryItem("custom-call"),
		renderResult: (_result: unknown, _options: unknown, _theme: unknown, context: { invalidate: () => void }) => {
			resultRendererCalls++;
			capturedInvalidate = context.invalidate;
			return new CountingHistoryItem(`custom-${visual}`);
		},
	} as unknown as ToolDefinition<any, any>;

	const tool = createTool("late-custom", definition, (component) => transcript.invalidateRetainedChild(component));
	const item = transcript.addRetainedChild(tool, { id: "late-custom", version: 0 });
	tool.updateResult({ content: [{ type: "text", text: "done" }], isError: false });
	item.advanceVersion();
	item.complete();
	const primed = transcript.render(100);
	const callsAfterPrime = resultRendererCalls;
	assert.ok(capturedInvalidate);
	const stableInvalidate = capturedInvalidate;

	instrumentation.reset();
	visual = "second";
	capturedInvalidate();
	const viewport = transcript.renderViewportTail(100, 40);
	const metricsAfterViewport = instrumentation.snapshot();
	const updated = transcript.render(100);
	assert.equal(resultRendererCalls, callsAfterPrime + 1);
	assert.equal(capturedInvalidate, stableInvalidate);
	assert.notDeepEqual(updated, primed);
	assert.ok(updated.some((line) => line.includes("custom-second")));
	assert.equal(viewport.totalHeight, updated.length);
	assert.deepEqual(viewport.lines, updated.slice(-40));
	assert.ok(history.every((component) => component.renderCalls === 1));
	assert.equal(metricsAfterViewport.completedItemRenders, 1);
	assert.ok(metricsAfterViewport.retainedCacheHits < 100);

	transcript.render(100);
	assert.equal(resultRendererCalls, callsAfterPrime + 1);
	assert.equal(instrumentation.snapshot().completedItemRenders, 1);
	assert.ok(instrumentation.snapshot().retainedCacheHits >= 10_001);
});

test("showImages, image width, and Kitty cell dimensions keep the indexed viewport equal to the tool wire view", async () => {
	initTheme("dark");
	setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
	setCellDimensions({ widthPx: 9, heightPx: 18 });
	const context = { themeVersion: 0, rendererVersion: 0, expandVersion: 0, settingsVersion: 0 };
	try {
		const transcript = new RetainedContainer({ getContext: () => context });
		const tool = createTool("image-settings", undefined, (component) => transcript.invalidateRetainedChild(component));
		const item = transcript.addRetainedChild(tool, { id: "image-settings", version: 0 });
		tool.updateResult({
			content: [{ type: "image", data: "R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==", mimeType: "image/gif" }],
			isError: false,
		});
		item.advanceVersion();
		item.complete();
		transcript.renderViewportTail(100, 40);
		await waitFor(() => tool.render(100).some(isImageLine), "settings image conversion");

		const assertIndexed = (): void => {
			const viewport = transcript.renderViewportTail(100, 40);
			const reference = tool.render(100);
			assert.equal(viewport.totalHeight, reference.length);
			assert.equal(transcript.getViewportIndexStats().totalHeight, reference.length);
			assert.deepEqual(viewport.lines, reference.slice(-40));
		};
		assertIndexed();

		tool.setShowImages(false);
		context.settingsVersion++;
		transcript.invalidateViewportHeights();
		assertIndexed();
		tool.setShowImages(true);
		context.settingsVersion++;
		transcript.invalidateViewportHeights();
		assertIndexed();

		tool.setImageWidthCells(20);
		context.settingsVersion++;
		transcript.invalidateViewportHeights();
		assertIndexed();
		tool.setImageWidthCells(60);
		context.settingsVersion++;
		transcript.invalidateViewportHeights();
		assertIndexed();

		setCellDimensions({ widthPx: 5, heightPx: 20 });
		transcript.invalidate();
		assertIndexed();
	} finally {
		setCellDimensions({ widthPx: 9, heightPx: 18 });
		setCapabilities({ images: null, trueColor: false, hyperlinks: false });
	}
});
