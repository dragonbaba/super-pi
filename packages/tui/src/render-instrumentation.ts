export interface TuiRenderMetrics {
	rootRenders: number;
	transcriptItemRenders: number;
	completedItemRenders: number;
	activeItemRenders: number;
	generatedLines: number;
	visibleLines: number;
	overlayRenders: number;
	terminalDiffLines: number;
	terminalBytes: number;
	pendingRenderRequestHighWaterMark: number;
	terminalFrameQueueHighWaterMark: number;
	terminalActiveWriteHighWaterMark: number;
	terminalPendingFrameHighWaterMark: number;
	terminalFramesReplaced: number;
	terminalFrameWriteErrors: number;
	physicalTerminalFrameWrites: number;
	frameStringsGenerated: number;
	frameStringUtf8BytesGenerated: number;
	fullSizeFrameCopies: number;
	maximumFrameUtf8Bytes: number;
	activeFrameUtf8Bytes: number;
	pendingFrameUtf8Bytes: number;
	framePromisesCreated: number;
	frameAbortControllersCreated: number;
	frameWrapperObjectsCreated: number;
	retainedCacheHits: number;
	retainedCacheMisses: number;
	viewportItemVisits: number;
	viewportLineArrays: number;
	viewportComposedLines: number;
	viewportCopiedLines: number;
	viewportTargetHeightLookupProbes: number;
	viewportBlockLookupProbes: number;
	mutationEventWrites: number;
	fullHistoryFallbacks: number;
	cursorScannedLines: number;
	altLayoutNodesVisited: number;
	altLayoutBoxObjects: number;
	altLayoutRectObjects: number;
	altLayoutClipObjects: number;
	altLayoutRenderCacheMapsCreated: number;
	altLayoutNestedRenderCacheMapsCreated: number;
	altLayoutScreenArraysCreated: number;
	altLayoutFullViewportArrayCopies: number;
	altLayoutStringRepeatCalls: number;
	altLayoutStringRepeatBytes: number;
	altLayoutPaintBoxCalls: number;
	altLayoutChildRenderCalls: number;
	altLayoutFullWidthRowCacheHits: number;
}

const EMPTY_METRICS: TuiRenderMetrics = {
	rootRenders: 0,
	transcriptItemRenders: 0,
	completedItemRenders: 0,
	activeItemRenders: 0,
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
	retainedCacheHits: 0,
	retainedCacheMisses: 0,
	viewportItemVisits: 0,
	viewportLineArrays: 0,
	viewportComposedLines: 0,
	viewportCopiedLines: 0,
	viewportTargetHeightLookupProbes: 0,
	viewportBlockLookupProbes: 0,
	mutationEventWrites: 0,
	fullHistoryFallbacks: 0,
	cursorScannedLines: 0,
	altLayoutNodesVisited: 0,
	altLayoutBoxObjects: 0,
	altLayoutRectObjects: 0,
	altLayoutClipObjects: 0,
	altLayoutRenderCacheMapsCreated: 0,
	altLayoutNestedRenderCacheMapsCreated: 0,
	altLayoutScreenArraysCreated: 0,
	altLayoutFullViewportArrayCopies: 0,
	altLayoutStringRepeatCalls: 0,
	altLayoutStringRepeatBytes: 0,
	altLayoutPaintBoxCalls: 0,
	altLayoutChildRenderCalls: 0,
	altLayoutFullWidthRowCacheHits: 0,
};

export function utf8ByteLength(value: string): number {
	let bytes = 0;
	for (let index = 0; index < value.length; index++) {
		const codeUnit = value.charCodeAt(index);
		if (codeUnit <= 0x7f) bytes++;
		else if (codeUnit <= 0x7ff) bytes += 2;
		else if (codeUnit >= 0xd800 && codeUnit <= 0xdbff && index + 1 < value.length) {
			const next = value.charCodeAt(index + 1);
			if (next >= 0xdc00 && next <= 0xdfff) {
				bytes += 4;
				index++;
			} else bytes += 3;
		} else bytes += 3;
	}
	return bytes;
}

/** Per-TUI counters used by transcript and terminal-frame benchmarks. */
export class TuiRenderInstrumentation {
	private metrics: TuiRenderMetrics = { ...EMPTY_METRICS };

	reset(): void {
		this.metrics = { ...EMPTY_METRICS };
	}

	snapshot(): Readonly<TuiRenderMetrics> {
		return Object.freeze({ ...this.metrics });
	}

	recordRootRender(generatedLines: number, visibleLines: number): void {
		this.metrics.rootRenders++;
		this.metrics.generatedLines += generatedLines;
		this.metrics.visibleLines += visibleLines;
	}

	recordTranscriptItemRender(completed: boolean, _generatedLines: number): void {
		this.metrics.transcriptItemRenders++;
		if (completed) this.metrics.completedItemRenders++;
		else this.metrics.activeItemRenders++;
	}

	recordRetainedCacheHit(): void {
		this.metrics.retainedCacheHits++;
	}

	recordRetainedCacheMiss(): void {
		this.metrics.retainedCacheMisses++;
	}

	recordTranscriptViewport(
		itemVisits: number,
		composedLines: number,
		targetHeightLookupProbes = 0,
		blockLookupProbes = 0,
		copiedLines = composedLines,
	): void {
		this.metrics.viewportLineArrays++;
		this.metrics.viewportItemVisits += itemVisits;
		this.metrics.viewportComposedLines += composedLines;
		this.metrics.viewportCopiedLines += copiedLines;
		this.metrics.viewportTargetHeightLookupProbes += targetHeightLookupProbes;
		this.metrics.viewportBlockLookupProbes += blockLookupProbes;
	}

	recordFullHistoryFallback(): void {
		this.metrics.fullHistoryFallbacks++;
	}

	recordMutationEventWrite(): void {
		this.metrics.mutationEventWrites++;
	}

	recordCursorScan(linesScanned: number): void {
		this.metrics.cursorScannedLines += linesScanned;
	}

	recordAltLayoutFrame(
		nodesVisited: number,
		boxObjects: number,
		rectObjects: number,
		clipObjects: number,
		renderCacheMapsCreated: number,
		nestedRenderCacheMapsCreated: number,
		screenArraysCreated: number,
		fullViewportArrayCopies: number,
		stringRepeatCalls: number,
		stringRepeatBytes: number,
		paintBoxCalls: number,
		childRenderCalls: number,
		fullWidthRowCacheHits: number,
	): void {
		this.metrics.altLayoutNodesVisited += nodesVisited;
		this.metrics.altLayoutBoxObjects += boxObjects;
		this.metrics.altLayoutRectObjects += rectObjects;
		this.metrics.altLayoutClipObjects += clipObjects;
		this.metrics.altLayoutRenderCacheMapsCreated += renderCacheMapsCreated;
		this.metrics.altLayoutNestedRenderCacheMapsCreated += nestedRenderCacheMapsCreated;
		this.metrics.altLayoutScreenArraysCreated += screenArraysCreated;
		this.metrics.altLayoutFullViewportArrayCopies += fullViewportArrayCopies;
		this.metrics.altLayoutStringRepeatCalls += stringRepeatCalls;
		this.metrics.altLayoutStringRepeatBytes += stringRepeatBytes;
		this.metrics.altLayoutPaintBoxCalls += paintBoxCalls;
		this.metrics.altLayoutChildRenderCalls += childRenderCalls;
		this.metrics.altLayoutFullWidthRowCacheHits += fullWidthRowCacheHits;
	}

	recordOverlayRender(): void {
		this.metrics.overlayRenders++;
	}

	recordTerminalFrame(utf8Bytes: number, diffLines: number): void {
		this.metrics.physicalTerminalFrameWrites++;
		this.metrics.terminalBytes += utf8Bytes;
		this.metrics.terminalDiffLines += diffLines;
	}

	recordTerminalFrameGenerated(utf8Bytes: number): void {
		this.metrics.frameStringsGenerated++;
		this.metrics.frameStringUtf8BytesGenerated += utf8Bytes;
		this.metrics.maximumFrameUtf8Bytes = Math.max(this.metrics.maximumFrameUtf8Bytes, utf8Bytes);
	}

	recordPendingRenderRequest(): void {
		this.metrics.pendingRenderRequestHighWaterMark = 1;
	}

	recordTerminalFrameQueueDepth(
		activeWrites: 0 | 1,
		pendingFrames: 0 | 1,
		activeFrameUtf8Bytes = 0,
		pendingFrameUtf8Bytes = 0,
	): void {
		this.metrics.activeFrameUtf8Bytes = activeFrameUtf8Bytes;
		this.metrics.pendingFrameUtf8Bytes = pendingFrameUtf8Bytes;
		this.metrics.terminalActiveWriteHighWaterMark = Math.max(
			this.metrics.terminalActiveWriteHighWaterMark,
			activeWrites,
		);
		this.metrics.terminalPendingFrameHighWaterMark = Math.max(
			this.metrics.terminalPendingFrameHighWaterMark,
			pendingFrames,
		);
		this.metrics.terminalFrameQueueHighWaterMark = Math.max(
			this.metrics.terminalFrameQueueHighWaterMark,
			activeWrites + pendingFrames,
		);
	}

	recordTerminalFrameReplaced(): void {
		this.metrics.terminalFramesReplaced++;
	}

	recordTerminalFrameWriteError(): void {
		this.metrics.terminalFrameWriteErrors++;
	}
}
