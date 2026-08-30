import { performance } from "node:perf_hooks";
import { HStack } from "../../packages/tui/src/components/h-stack.ts";
import { VStack } from "../../packages/tui/src/components/v-stack.ts";
import { LayoutFrameScratch, renderLayoutFrame } from "../../packages/tui/src/layout.ts";
import type { Component } from "../../packages/tui/src/tui.ts";
import { currentCommit } from "./benchmark.ts";

class StaticLine implements Component {
	private readonly lines: string[];

	constructor(line: string) {
		this.lines = [line];
	}

	render(): string[] {
		return this.lines;
	}

	invalidate(): void {}
}

class StaticRows implements Component {
	readonly lines: string[];

	constructor(lines: string[]) {
		this.lines = lines;
	}

	render(): string[] {
		return this.lines;
	}

	invalidate(): void {}
}

function percentile(sorted: readonly number[], fraction: number): number {
	return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))] ?? 0;
}

function measureLargeLayout(leafCount: number): Record<string, number> {
	const children: Component[] = [];
	for (let index = 0; index < leafCount; index++) children.push(new StaticLine(`leaf-${index}`));
	const root = new VStack(children);
	const scratch = new LayoutFrameScratch();
	for (let index = 0; index < 20; index++) renderLayoutFrame(root, 120, leafCount + 1, NOOP, scratch);
	const durations = new Array<number>(100);
	let frame = renderLayoutFrame(root, 120, leafCount + 1, NOOP, scratch);
	for (let index = 0; index < durations.length; index++) {
		const started = performance.now();
		frame = renderLayoutFrame(root, 120, leafCount + 1, NOOP, scratch);
		durations[index] = performance.now() - started;
	}
	durations.sort(NUMERIC_ASCENDING);
	const retainedBeforeClear = scratch.getRetainedReferenceCounts();
	scratch.clear();
	return {
		leafCount,
		cpuP50Ms: percentile(durations, 0.5),
		cpuP95Ms: percentile(durations, 0.95),
		renderCacheLookupProbes: frame.renderCacheLookupProbes ?? 0,
		renderCacheRecordCount: frame.renderCacheRecordCount ?? 0,
		renderCacheIndexActivations: frame.renderCacheIndexActivations ?? 0,
		indexedComponentsAfterFrame: retainedBeforeClear.indexedComponents,
		indexedComponentsAfterClear: scratch.getRetainedReferenceCounts().indexedComponents,
	};
}

function measureRepeatedComponentWidths(): Record<string, unknown> {
	const component = new StaticLine("shared");
	const root = new HStack([
		{ component, basis: 20 },
		{ component, basis: 40 },
	]);
	const frame = renderLayoutFrame(root, 60, 1, NOOP, new LayoutFrameScratch());
	return {
		renderCacheLookupProbes: frame.renderCacheLookupProbes,
		renderCacheRecordCount: frame.renderCacheRecordCount,
		renderCacheIndexActivations: frame.renderCacheIndexActivations,
	};
}

function measureRowCapacity(): Record<string, unknown> {
	const oneMiBOsc = `\x1b]0;${"x".repeat(1024 * 1024)}\x07`;
	const tenMiB = "y".repeat(10 * 1024 * 1024);
	const cumulativeRows: string[] = [];
	for (let index = 0; index < 140; index++) {
		cumulativeRows.push(`\x1b]0;${"z".repeat(4000)}-${index}\x07`);
	}
	const scratch = new LayoutFrameScratch();
	const oscFrame = renderLayoutFrame(new StaticLine(oneMiBOsc), 120, 1, NOOP, scratch);
	const plainFrame = renderLayoutFrame(new StaticLine(tenMiB), 120, 1, NOOP, scratch);
	const cumulativeFrame = renderLayoutFrame(new StaticRows(cumulativeRows), 120, cumulativeRows.length, NOOP, scratch);
	const retainedAfterCapacity = scratch.getRetainedReferenceCounts();
	renderLayoutFrame(new StaticLine("small"), 120, 1, NOOP, scratch);
	const retainedAfterSmall = scratch.getRetainedReferenceCounts();
	scratch.clear();
	return {
		oneMiBOscRejectedRows: oscFrame.rowCacheRejectedBySize,
		tenMiBRejectedRows: plainFrame.rowCacheRejectedBySize,
		cumulativeRejectedRows: cumulativeFrame.rowCacheRejectedBySize,
		retainedAfterCapacity,
		retainedAfterSmall,
		retainedAfterClear: scratch.getRetainedReferenceCounts(),
	};
}

function NOOP(): void {}
function NUMERIC_ASCENDING(left: number, right: number): number {
	return left - right;
}

const scaling: Record<string, number>[] = [];
for (const leafCount of [16, 64, 256, 1024]) scaling.push(measureLargeLayout(leafCount));

process.stdout.write(
	`${JSON.stringify(
		{
			commit: currentCommit(),
			scaling,
			repeatedComponentWidths: measureRepeatedComponentWidths(),
			rowCapacity: measureRowCapacity(),
		},
		null,
		2,
	)}\n`,
);
