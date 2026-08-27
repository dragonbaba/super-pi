import assert from "node:assert/strict";
import test from "node:test";
import {
	ReadToolGroupComponent,
	ToolExecutionComponent,
	replaceToolPlaceholder,
} from "../packages/coding-agent/src/modes/interactive/components/tool-execution.ts";
import { initTheme } from "../packages/coding-agent/src/modes/interactive/theme/theme.ts";
import { RetainedContainer } from "../packages/tui/src/components/retained-item.ts";
import { TuiRenderInstrumentation } from "../packages/tui/src/render-instrumentation.ts";
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

function createTool(id: string): ToolExecutionComponent {
	const ui = new TuiMainScreen(new FakeTerminal(100, 30), false);
	return new ToolExecutionComponent("phase4a-progress", id, { step: 0 }, {}, undefined, ui, process.cwd());
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
