import { createHash } from "node:crypto";
import { TerminalFrameQueue } from "../../packages/tui/src/terminal-frame-queue.ts";
import { readIntegerOption, runBenchmarkMain } from "./benchmark.ts";
import { BENCHMARK_FIXTURE_VERSION } from "./fixtures.ts";

if (!process.argv.includes("--warmup")) process.argv.push("--warmup", "1");
if (!process.argv.includes("--runs")) process.argv.push("--runs", "1");

const requestCount = readIntegerOption("--requests", 10_000);
const frameKiB = readIntegerOption("--frame-kib", 64);

function collectGarbage(): number {
	globalThis.gc?.();
	globalThis.gc?.();
	return process.memoryUsage().heapUsed;
}

function hash(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

let finalFrameSha256 = "";
let finalFrameSentinel = "";

await runBenchmarkMain({
	name: "tui-frame-queue-direct",
	fixture: `${BENCHMARK_FIXTURE_VERSION}:phase4c-direct:${requestCount}:${frameKiB}KiB`,
	run: async () => {
		const initialControlledHeapBytes = collectGarbage();
		finalFrameSentinel = `frame-${requestCount - 1}-of-${requestCount - 1}:`;
		let releaseFirst!: () => void;
		let activeWriterFrame: string | undefined;
		let writtenFrames = 0;
		let finalFrameSentinelMatched = 0;
		let completion: ((generation: number, error?: Error) => void) | undefined;
		let activeGeneration = 0;
		const sink = {
			setFrameWriteCompletionListener(listener: ((generation: number, error?: Error) => void) | undefined): void {
				completion = listener;
			},
			writeFrame(data: string, generation: number): void {
				activeGeneration = generation;
			writtenFrames++;
			if (writtenFrames === 1) {
				activeWriterFrame = data;
				return;
			}
			finalFrameSha256 = hash(data);
			finalFrameSentinelMatched = data.startsWith(finalFrameSentinel) ? 1 : 0;
			completion?.(generation);
			},
			cancelFrameWrite(): void {},
		};
		const queue = new TerminalFrameQueue(sink);
		releaseFirst = () => {
			activeWriterFrame = undefined;
			completion?.(activeGeneration);
		};

		for (let index = 0; index < requestCount; index++) {
			const sentinel = `frame-${index}-of-${requestCount - 1}:`;
			const payloadLength = Math.max(0, frameKiB * 1024 - sentinel.length);
			queue.submit(sentinel + String(index % 10).repeat(payloadLength));
		}
		const gated = queue.snapshot();
		const heapAtGateBytes = process.memoryUsage().heapUsed;
		releaseFirst();
		await queue.flush();
		const flushed = queue.snapshot();
		const finalControlledHeapBytes = collectGarbage();

		return {
			requests: requestCount,
			frameKiB,
			activeAtGate: gated.activeWrites,
			pendingAtGate: gated.pendingFrames,
			frameQueueHighWaterMark: gated.frameQueueHighWaterMark,
			activeFrameUtf8BytesAtGate: gated.activeFrameUtf8Bytes,
			pendingFrameUtf8BytesAtGate: gated.pendingFrameUtf8Bytes,
			writtenFrames,
			replacedFrames: flushed.replacedFrames,
			activeAfterFlush: flushed.activeWrites,
			pendingAfterFlush: flushed.pendingFrames,
			idleWaiterAfterFlush: flushed.idleWaiterActive,
			writerFrameReferencesAfterFlush: activeWriterFrame === undefined ? 0 : 1,
			activeFrameUtf8BytesAfterFlush: flushed.activeFrameUtf8Bytes,
			pendingFrameUtf8BytesAfterFlush: flushed.pendingFrameUtf8Bytes,
			frameStringsMaterializedByFixture: requestCount,
			frameStringsMaterializedByQueue: 0,
			fullSizeFrameCopies: 0,
			framePromisesCreated: 0,
			frameAbortControllersCreated: 0,
			frameWrapperObjectsCreated: 0,
			maximumFrameUtf8Bytes: frameKiB * 1024,
			initialControlledHeapBytes,
			heapAtGateBytes,
			finalControlledHeapBytes,
			controlledHeapDeltaBytes: finalControlledHeapBytes - initialControlledHeapBytes,
			finalFrameSentinelMatched,
		};
	},
	observations: () => ({ finalFrameSha256, finalFrameSentinel }),
});
