import { createHash } from "node:crypto";
import { TuiRenderInstrumentation } from "../../packages/tui/src/render-instrumentation.ts";
import type { Terminal } from "../../packages/tui/src/terminal.ts";
import { TuiBase } from "../../packages/tui/src/tui.ts";
import { readIntegerOption, runBenchmarkMain } from "./benchmark.ts";
import { BENCHMARK_FIXTURE_VERSION } from "./fixtures.ts";

const requestCount = readIntegerOption("--requests", 100_000);
const width = readIntegerOption("--width", 120);
const height = readIntegerOption("--height", 40);
const frameKiB = readIntegerOption("--frame-kib", 0);

function collectGarbage(): number {
	globalThis.gc?.();
	globalThis.gc?.();
	return process.memoryUsage().heapUsed;
}

function hash(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

class GatedBenchmarkTerminal implements Terminal {
	readonly writes: string[] = [];
	readonly releases: Array<() => void> = [];
	columns = width;
	rows = height;
	kittyProtocolActive = false;
	activeWrites = 0;
	maximumActiveWrites = 0;
	private frameWriteCompletion: ((generation: number, error?: Error) => void) | undefined;
	private readonly releaseGenerations: number[] = [];

	start(): void {}
	stop(): void {}
	async drainInput(): Promise<void> {}
	write(): void {}
	setFrameWriteCompletionListener(listener: ((generation: number, error?: Error) => void) | undefined): void {
		this.frameWriteCompletion = listener;
	}
	writeFrame(data: string, generation: number): void {
		this.writes.push(data);
		this.activeWrites++;
		this.maximumActiveWrites = Math.max(this.maximumActiveWrites, this.activeWrites);
		this.releaseGenerations.push(generation);
		this.releases.push(this.releaseNextFrame);
	}
	private readonly releaseNextFrame = (): void => {
		const generation = this.releaseGenerations.shift();
		if (generation === undefined) return;
		this.activeWrites--;
		this.frameWriteCompletion?.(generation);
	};
	cancelFrameWrite(): void {}
	moveBy(): void {}
	hideCursor(): void {}
	showCursor(): void {}
	clearLine(): void {}
	clearFromCursor(): void {}
	clearScreen(): void {}
	setTitle(): void {}
	setProgress(): void {}
}

class QueueBenchmarkTui extends TuiBase {
	readonly mode = "regular" as const;
	generation = 0;
	doRenderCalls = 0;
	generatedFrameStrings = 0;

	protected doRender(): void {
		this.doRenderCalls++;
		this.generatedFrameStrings++;
		const sentinel = `frame-${this.generation}-of-${requestCount - 1}:`;
		const payloadBytes = Math.max(0, frameKiB * 1024 - sentinel.length);
		this.writeTerminalFrame(sentinel + String(this.generation % 10).repeat(payloadBytes), 1);
	}
}

let finalFrameSha256 = "";
let finalFrameSentinel = "";

await runBenchmarkMain({
	name: "tui-frame-queue",
	fixture: `${BENCHMARK_FIXTURE_VERSION}:phase4c-production-frame-queue-v2:${requestCount}:${width}x${height}:${frameKiB}KiB`,
	run: async () => {
		const initialControlledHeapBytes = collectGarbage();
		const terminal = new GatedBenchmarkTerminal();
		const instrumentation = new TuiRenderInstrumentation();
		const tui = new QueueBenchmarkTui(terminal);
		tui.setRenderInstrumentation(instrumentation);
		tui.renderNow();
		for (let index = 1; index < requestCount; index++) {
			tui.generation = index;
			tui.renderNow();
		}
		const heapAfterRequestsBytes = process.memoryUsage().heapUsed;
		terminal.releases[0]?.();
		await new Promise<void>((resolve) => setImmediate(resolve));
		terminal.releases[1]?.();
		await tui.flushTerminalFrames();
		const metrics = instrumentation.snapshot();
		const finalFrame = terminal.writes.at(-1) ?? "";
		finalFrameSha256 = hash(finalFrame);
		finalFrameSentinel = `frame-${requestCount - 1}-of-${requestCount - 1}:`;
		const finalControlledHeapBytes = collectGarbage();
		return {
			requests: requestCount,
			doRenderCalls: tui.doRenderCalls,
			generatedFrameStrings: tui.generatedFrameStrings,
			writtenFrames: terminal.writes.length,
			uniqueWrittenFrames: new Set(terminal.writes).size,
			maximumActiveWrites: terminal.maximumActiveWrites,
			pendingRenderIntentHighWaterMark: metrics.pendingRenderRequestHighWaterMark,
			frameQueueHighWaterMark: metrics.terminalFrameQueueHighWaterMark,
			activeWriteHighWaterMark: metrics.terminalActiveWriteHighWaterMark,
			pendingFrameHighWaterMark: metrics.terminalPendingFrameHighWaterMark,
			instrumentedFrameStringsGenerated: metrics.frameStringsGenerated,
			instrumentedFrameStringUtf8BytesGenerated: metrics.frameStringUtf8BytesGenerated,
			maximumFrameUtf8Bytes: metrics.maximumFrameUtf8Bytes,
			fullSizeFrameCopies: metrics.fullSizeFrameCopies,
			framePromisesCreated: metrics.framePromisesCreated,
			frameAbortControllersCreated: metrics.frameAbortControllersCreated,
			frameWrapperObjectsCreated: metrics.frameWrapperObjectsCreated,
			activeFrameUtf8BytesAfterFlush: metrics.activeFrameUtf8Bytes,
			pendingFrameUtf8BytesAfterFlush: metrics.pendingFrameUtf8Bytes,
			activeWritesAfterFlush: terminal.activeWrites,
			frameKiB,
			initialControlledHeapBytes,
			heapAfterRequestsBytes,
			finalControlledHeapBytes,
			controlledHeapDeltaBytes: finalControlledHeapBytes - initialControlledHeapBytes,
			finalFrameSentinelMatched: finalFrame.startsWith(finalFrameSentinel) ? 1 : 0,
		};
	},
	observations: () => ({ finalFrameSha256, finalFrameSentinel }),
});
