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

	recordOverlayRender(): void {
		this.metrics.overlayRenders++;
	}

	recordTerminalFrame(data: string, diffLines: number): void {
		this.metrics.terminalBytes += utf8ByteLength(data);
		this.metrics.terminalDiffLines += diffLines;
	}

	recordPendingRenderRequest(): void {
		this.metrics.pendingRenderRequestHighWaterMark = 1;
	}
}
