import type { AssistantMessage } from "../../packages/ai/src/types.ts";
import { AssistantMessageComponent } from "../../packages/coding-agent/src/modes/interactive/components/assistant-message.ts";
import { UserMessageComponent } from "../../packages/coding-agent/src/modes/interactive/components/user-message.ts";
import { initTheme } from "../../packages/coding-agent/src/modes/interactive/theme/theme.ts";
import { RELEASE_COMPONENT_RENDER_CACHE } from "../../packages/tui/src/component-cache.ts";
import { RetainedContainer } from "../../packages/tui/src/components/retained-item.ts";
import { readIntegerOption, runBenchmarkMain } from "./benchmark.ts";
import { BENCHMARK_FIXTURE_VERSION, createTranscriptItems } from "./fixtures.ts";

const EMPTY_USAGE = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const itemCount = readIntegerOption("--items", 5_000);
const width = readIntegerOption("--width", 120);
const cycles = readIntegerOption("--cycles", 5);
const items = createTranscriptItems(itemCount);
initTheme("dark");

if (typeof globalThis.gc !== "function") {
	throw new Error("tui-retained-lifecycle requires node --expose-gc");
}

function assistantMessage(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "benchmark",
		provider: "benchmark",
		model: "benchmark",
		usage: EMPTY_USAGE,
		stopReason: "stop",
		timestamp: 0,
	} as AssistantMessage;
}

function collectGarbage(): number {
	globalThis.gc?.();
	globalThis.gc?.();
	return process.memoryUsage().heapUsed;
}

function createTranscript(): RetainedContainer {
	const transcript = new RetainedContainer();
	for (let index = 0; index < items.length; index++) {
		const text = items[index]!;
		const component = index % 2 === 0
			? new UserMessageComponent(text)
			: new AssistantMessageComponent(assistantMessage(text));
		transcript.addRetainedChild(component, { id: `history-${index}`, version: 1, completed: true });
	}
	return transcript;
}

await runBenchmarkMain({
	name: "tui-retained-lifecycle",
	fixture: `${BENCHMARK_FIXTURE_VERSION}:real-transcript:${itemCount}:${width}:retained-lifecycle:${cycles}`,
	run: () => {
		const initialHeapBytes = collectGarbage();
		const clearHeaps: number[] = [];
		let beforeRenderHeapBytes = 0;
		let afterRenderHeapBytes = 0;
		let resizePeakHeapBytes = 0;
		let retainedItems = 0;
		let cachedItems = 0;
		let cachedLines = 0;
		let estimatedCachedBytes = 0;
		let clearedRetainedItems = -1;
		let clearedCachedItems = -1;
		let clearedCachedLines = -1;
		let clearedEstimatedCachedBytes = -1;
		let indexedItems = 0;
		let heightBlocks = 0;
		let releasedChildren = -1;
		let releasedRetainedItems = -1;
		let releasedRetainedComponents = -1;
		let releasedCachedItems = -1;
		let releasedCachedLines = -1;
		let releasedEstimatedCachedBytes = -1;
		let releasedViewportRecords = -1;
		let releasedViewportRecordComponentReferences = -1;
		let releasedViewportRecordRetainedItemReferences = -1;
		let releasedDirtyViewportRecords = -1;
		let releasedPreparedViewportRecords = -1;
		let releasedViewportBlockHeights = -1;
		let releasedPreparedLineReferences = -1;
		let releasedKittyLineReferences = -1;
		let rebuiltViewportRecords = -1;
		let rebuiltViewportRecordComponentReferences = -1;
		let rereleasedViewportRecords = -1;
		let clearedIndexedItems = -1;
		let clearedHeightBlocks = -1;

		for (let cycle = 0; cycle < cycles; cycle++) {
			const transcript = createTranscript();
			beforeRenderHeapBytes = process.memoryUsage().heapUsed;
			transcript.renderViewportTail(width, 40);
			afterRenderHeapBytes = process.memoryUsage().heapUsed;
			transcript.renderViewportTail(Math.max(20, width - 24), 40);
			resizePeakHeapBytes = Math.max(afterRenderHeapBytes, process.memoryUsage().heapUsed);
			transcript.renderViewportTail(width + 24, 40);
			resizePeakHeapBytes = Math.max(resizePeakHeapBytes, process.memoryUsage().heapUsed);
			const retained = transcript.getRetainedStats();
			const viewportIndex = transcript.getViewportIndexStats();
			retainedItems = retained.retainedItems;
			cachedItems = retained.cachedItems;
			cachedLines = retained.cachedLines;
			estimatedCachedBytes = retained.estimatedCachedBytes;
			indexedItems = viewportIndex.indexedItems;
			heightBlocks = viewportIndex.heightBlocks;

			transcript[RELEASE_COMPONENT_RENDER_CACHE]();
			const released = transcript.getRetainedStats();
			const releasedReferences = transcript.getRetainedLifecycleReferenceCounts();
			releasedChildren = releasedReferences.children;
			releasedRetainedItems = releasedReferences.retainedItems;
			releasedRetainedComponents = releasedReferences.retainedComponents;
			releasedCachedItems = released.cachedItems;
			releasedCachedLines = released.cachedLines;
			releasedEstimatedCachedBytes = released.estimatedCachedBytes;
			releasedViewportRecords = releasedReferences.viewportRecords;
			releasedViewportRecordComponentReferences = releasedReferences.viewportRecordComponentReferences;
			releasedViewportRecordRetainedItemReferences = releasedReferences.viewportRecordRetainedItemReferences;
			releasedDirtyViewportRecords = releasedReferences.dirtyViewportRecords;
			releasedPreparedViewportRecords = releasedReferences.preparedViewportRecords;
			releasedViewportBlockHeights = releasedReferences.viewportBlockHeights;
			releasedPreparedLineReferences = releasedReferences.preparedLineReferences;
			releasedKittyLineReferences = releasedReferences.kittyLineReferences;

			transcript.renderViewportTail(width, 40);
			const rebuiltReferences = transcript.getRetainedLifecycleReferenceCounts();
			rebuiltViewportRecords = rebuiltReferences.viewportRecords;
			rebuiltViewportRecordComponentReferences = rebuiltReferences.viewportRecordComponentReferences;
			transcript[RELEASE_COMPONENT_RENDER_CACHE]();
			rereleasedViewportRecords = transcript.getRetainedLifecycleReferenceCounts().viewportRecords;

			transcript.clear();
			const cleared = transcript.getRetainedStats();
			clearedRetainedItems = cleared.retainedItems;
			clearedCachedItems = cleared.cachedItems;
			clearedCachedLines = cleared.cachedLines;
			clearedEstimatedCachedBytes = cleared.estimatedCachedBytes;
			const clearedViewportIndex = transcript.getViewportIndexStats();
			clearedIndexedItems = clearedViewportIndex.indexedItems;
			clearedHeightBlocks = clearedViewportIndex.heightBlocks;
			clearHeaps.push(collectGarbage());
		}

		const finalHeapBytes = clearHeaps.at(-1) ?? collectGarbage();
		const heapSlopeBytesPerCycle =
			clearHeaps.length > 1 ? (finalHeapBytes - clearHeaps[0]!) / (clearHeaps.length - 1) : 0;
		return {
			transcriptItems: itemCount,
			cycles,
			initialHeapBytes,
			beforeRenderHeapBytes,
			afterRenderHeapBytes,
			resizePeakHeapBytes,
			finalControlledGcHeapBytes: finalHeapBytes,
			heapSlopeBytesPerCycle,
			retainedItems,
			cachedItems,
			cachedLines,
			estimatedCachedBytes,
			indexedItems,
			heightBlocks,
			releasedChildren,
			releasedRetainedItems,
			releasedRetainedComponents,
			releasedCachedItems,
			releasedCachedLines,
			releasedEstimatedCachedBytes,
			releasedViewportRecords,
			releasedViewportRecordComponentReferences,
			releasedViewportRecordRetainedItemReferences,
			releasedDirtyViewportRecords,
			releasedPreparedViewportRecords,
			releasedViewportBlockHeights,
			releasedPreparedLineReferences,
			releasedKittyLineReferences,
			rebuiltViewportRecords,
			rebuiltViewportRecordComponentReferences,
			rereleasedViewportRecords,
			clearedRetainedItems,
			clearedCachedItems,
			clearedCachedLines,
			clearedEstimatedCachedBytes,
			clearedIndexedItems,
			clearedHeightBlocks,
		};
	},
	observations: () => ({
		controlledGc: true,
		retentionMode: "session-local-sidecar+block-height-index",
		resizeWidths: `${width}->${Math.max(20, width - 24)}->${width + 24}`,
	}),
});
