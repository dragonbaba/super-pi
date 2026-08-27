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
	frameQueueHighWaterMark: number;
	retainedCacheHits: number;
	retainedCacheMisses: number;
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
	frameQueueHighWaterMark: 0,
	retainedCacheHits: 0,
	retainedCacheMisses: 0,
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

	recordOverlayRender(): void {
		this.metrics.overlayRenders++;
	}

	recordTerminalFrame(data: string, diffLines: number): void {
		this.metrics.terminalBytes += utf8ByteLength(data);
		this.metrics.terminalDiffLines += diffLines;
	}

	recordFrameQueueDepth(depth: number): void {
		this.metrics.frameQueueHighWaterMark = Math.max(this.metrics.frameQueueHighWaterMark, depth);
	}
}
