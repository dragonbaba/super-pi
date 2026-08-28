import type { AssistantMessage } from "../../packages/ai/src/types.ts";
import { AssistantMessageComponent } from "../../packages/coding-agent/src/modes/interactive/components/assistant-message.ts";
import { UserMessageComponent } from "../../packages/coding-agent/src/modes/interactive/components/user-message.ts";
import { initTheme } from "../../packages/coding-agent/src/modes/interactive/theme/theme.ts";
import { RetainedContainer } from "../../packages/tui/src/components/retained-item.ts";
import { TuiRenderInstrumentation, utf8ByteLength } from "../../packages/tui/src/render-instrumentation.ts";
import type { Terminal } from "../../packages/tui/src/terminal.ts";
import { TuiMainScreen } from "../../packages/tui/src/tui-main-screen.ts";
import { readIntegerOption, runBenchmarkMain } from "./benchmark.ts";
import { BENCHMARK_FIXTURE_VERSION, createTranscriptItems } from "./fixtures.ts";

if (!process.argv.includes("--warmup")) process.argv.push("--warmup", "1");
if (!process.argv.includes("--runs")) process.argv.push("--runs", "1");

const itemCount = readIntegerOption("--items", 5_000);
const width = readIntegerOption("--width", 120);
const height = readIntegerOption("--height", 40);
const sinkBytesPerSecond = readIntegerOption("--terminal-bytes-per-second", 16 * 1024);
const lifecycleTimeoutMs = readIntegerOption("--lifecycle-timeout-ms", 20);
const items = createTranscriptItems(itemCount);
initTheme("dark");

const EMPTY_USAGE = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

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

class GatedReplayTerminal implements Terminal {
	columns = width;
	rows = height;
	kittyProtocolActive = false;
	gated = false;
	writtenFrames = 0;
	activeFrame: string | undefined;
	activeFrameBytes = 0;
	private activeGeneration = 0;
	private frameWriteCompletion: ((generation: number, error?: Error) => void) | undefined;

	start(): void {}
	stop(): void {}
	async drainInput(): Promise<void> {}
	write(): void {}
	setFrameWriteCompletionListener(listener: ((generation: number, error?: Error) => void) | undefined): void {
		this.frameWriteCompletion = listener;
	}
	writeFrame(data: string, generation: number): void {
		this.writtenFrames++;
		if (!this.gated) {
			this.frameWriteCompletion?.(generation);
			return;
		}
		this.activeFrame = data;
		this.activeFrameBytes = utf8ByteLength(data);
		this.activeGeneration = generation;
	}
	releaseActive(): void {
		const generation = this.activeGeneration;
		this.activeFrame = undefined;
		this.activeFrameBytes = 0;
		this.activeGeneration = 0;
		if (generation !== 0) this.frameWriteCompletion?.(generation);
	}
	cancelFrameWrite(generation: number): void {
		if (generation !== this.activeGeneration) return;
		this.activeFrame = undefined;
		this.activeFrameBytes = 0;
		this.activeGeneration = 0;
	}
	moveBy(): void {}
	hideCursor(): void {}
	showCursor(): void {}
	clearLine(): void {}
	clearFromCursor(): void {}
	clearScreen(): void {}
	setTitle(): void {}
	setProgress(): void {}
}

async function waitForFrameCount(terminal: GatedReplayTerminal, count: number): Promise<void> {
	for (let attempt = 0; attempt < 50 && terminal.writtenFrames < count; attempt++) {
		await new Promise<void>((resolve) => setImmediate(resolve));
	}
	if (terminal.writtenFrames < count) throw new Error(`Timed out waiting for terminal frame ${count}`);
}

await runBenchmarkMain({
	name: "tui-full-replay-backpressure",
	fixture: `${BENCHMARK_FIXTURE_VERSION}:phase4c-full-replay:${itemCount}:${width}x${height}:${sinkBytesPerSecond}Bps`,
	run: async () => {
		const transcript = new RetainedContainer();
		for (let index = 0; index < items.length; index++) {
			const text = items[index]!;
			const component = index % 2 === 0
				? new UserMessageComponent(text)
				: new AssistantMessageComponent(assistantMessage(text));
			transcript.addRetainedChild(component, { id: `history-${index}`, version: 1, completed: true });
		}
		const terminal = new GatedReplayTerminal();
		const instrumentation = new TuiRenderInstrumentation();
		const tui = new TuiMainScreen(terminal, false, undefined, lifecycleTimeoutMs);
		tui.setRenderInstrumentation(instrumentation);
		tui.addChild(transcript);
		tui.renderNow();
		await tui.flushTerminalFrames();
		const heapAfterPrimeBytes = collectGarbage();

		instrumentation.reset();
		terminal.gated = true;
		terminal.columns = Math.max(20, width - 24);
		tui.renderNow();
		const firstResizeFrameBytes = terminal.activeFrameBytes;
		const firstResizeFrameLines = instrumentation.snapshot().terminalDiffLines;
		const afterFirstResize = tui.getTerminalFrameQueueSnapshot();
		terminal.columns = width + 24;
		tui.renderNow();
		const atGate = tui.getTerminalFrameQueueSnapshot();
		const activeTerminalFrameReferencesAtGate = terminal.activeFrame === undefined ? 0 : 1;
		const heapWithActiveFrameBytes = process.memoryUsage().heapUsed;

		terminal.releaseActive();
		await waitForFrameCount(terminal, 3);
		const secondResizeFrameBytes = terminal.activeFrameBytes;
		terminal.releaseActive();
		await tui.flushTerminalFrames();
		const afterFlush = tui.getTerminalFrameQueueSnapshot();
		const heapAfterFlushGcBytes = collectGarbage();

		terminal.columns = width;
		tui.renderNow(true);
		const abortFrameBytes = terminal.activeFrameBytes;
		await tui.stop();
		const afterAbort = tui.getTerminalFrameQueueSnapshot();
		const frameMetrics = instrumentation.snapshot();
		const heapAfterAbortGcBytes = collectGarbage();
		transcript.clear();
		tui.clear();
		const heapAfterClearGcBytes = collectGarbage();

		return {
			transcriptItems: itemCount,
			firstResizeFrameBytes,
			secondResizeFrameBytes,
			abortFrameBytes,
			firstResizeFrameLines,
			projectedFirstDrainMs: firstResizeFrameBytes / sinkBytesPerSecond * 1_000,
			queueActiveReferencesAtFirstResize: afterFirstResize.activeWrites,
			queuePendingReferencesAtFirstResize: afterFirstResize.pendingFrames,
			queueActiveReferencesAtGate: atGate.activeWrites,
			queuePendingReferencesAtGate: atGate.pendingFrames,
			queueActiveFrameUtf8BytesAtGate: atGate.activeFrameUtf8Bytes,
			queuePendingFrameUtf8BytesAtGate: atGate.pendingFrameUtf8Bytes,
			renderIntentReferencesAtGate: atGate.pendingRenderIntents,
			activeTerminalFrameReferencesAtGate,
			queueActiveAfterFlush: afterFlush.activeWrites,
			queuePendingAfterFlush: afterFlush.pendingFrames,
			renderIntentAfterFlush: afterFlush.pendingRenderIntents,
			queueActiveAfterAbort: afterAbort.activeWrites,
			queuePendingAfterAbort: afterAbort.pendingFrames,
			renderIntentAfterAbort: afterAbort.pendingRenderIntents,
			terminalFrameReferencesAfterAbort: terminal.activeFrame === undefined ? 0 : 1,
			frameStringsGenerated: frameMetrics.frameStringsGenerated,
			frameStringUtf8BytesGenerated: frameMetrics.frameStringUtf8BytesGenerated,
			maximumFrameUtf8Bytes: frameMetrics.maximumFrameUtf8Bytes,
			fullSizeFrameCopies: frameMetrics.fullSizeFrameCopies,
			framePromisesCreated: frameMetrics.framePromisesCreated,
			frameAbortControllersCreated: frameMetrics.frameAbortControllersCreated,
			frameWrapperObjectsCreated: frameMetrics.frameWrapperObjectsCreated,
			activeFrameUtf8BytesAfterAbort: frameMetrics.activeFrameUtf8Bytes,
			pendingFrameUtf8BytesAfterAbort: frameMetrics.pendingFrameUtf8Bytes,
			heapAfterPrimeBytes,
			heapWithActiveFrameBytes,
			heapAfterFlushGcBytes,
			heapAfterAbortGcBytes,
			heapAfterClearGcBytes,
			heapReleasedByFlushBytes: heapWithActiveFrameBytes - heapAfterFlushGcBytes,
			heapReleasedByAbortBytes: heapWithActiveFrameBytes - heapAfterAbortGcBytes,
		};
	},
	observations: () => ({
		retention: "one-terminal-active-frame+zero-queue-pending+one-render-intent",
		normalWritesHaveAbsoluteDeadline: false,
		lifecycleFlushTimeoutMs: lifecycleTimeoutMs,
		sinkBytesPerSecond,
	}),
});
