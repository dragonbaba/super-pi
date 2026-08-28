import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import type { AssistantMessage } from "../../packages/ai/src/types.ts";
import { RetainedContainer } from "../../packages/tui/src/components/retained-item.ts";
import { TuiRenderInstrumentation } from "../../packages/tui/src/render-instrumentation.ts";
import { TuiMainScreen } from "../../packages/tui/src/tui-main-screen.ts";
import { AssistantMessageComponent } from "../../packages/coding-agent/src/modes/interactive/components/assistant-message.ts";
import { UserMessageComponent } from "../../packages/coding-agent/src/modes/interactive/components/user-message.ts";
import { initTheme } from "../../packages/coding-agent/src/modes/interactive/theme/theme.ts";
import { FakeTerminal } from "../../tests/helpers/runtime-instrumentation.ts";
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
const height = readIntegerOption("--height", 40);
const terminalBytesPerSecond = readIntegerOption("--terminal-bytes-per-second", 16 * 1024);
const fullHistoryMode = process.argv.includes("--full-history");
const cpuOnly = process.argv.includes("--cpu-only");
const items = createTranscriptItems(itemCount);
initTheme("dark");

class SlowTerminal extends FakeTerminal {
	private backpressureEnabled = false;
	private sampleWriteCalls = 0;
	private sampleBytes = 0;
	private sampleDelayMs = 0;

	override write(data: string): void {
		super.write(data);
		const bytes = Buffer.byteLength(data);
		const delayMs = this.backpressureEnabled && !cpuOnly ? bytes / terminalBytesPerSecond * 1_000 : 0;
		this.sampleWriteCalls++;
		this.sampleBytes += bytes;
		this.sampleDelayMs += delayMs;
		const deadline = performance.now() + delayMs;
		while (performance.now() < deadline) {
			// Model a terminal/SSH sink whose synchronous write path applies backpressure.
		}
	}

	enableBackpressure(): void {
		this.backpressureEnabled = true;
	}

	beginSample(): void {
		this.sampleWriteCalls = 0;
		this.sampleBytes = 0;
		this.sampleDelayMs = 0;
	}

	get sample() {
		return {
			terminalWriteCalls: this.sampleWriteCalls,
			terminalBytes: this.sampleBytes,
			simulatedTerminalDelayMs: this.sampleDelayMs,
		};
	}
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

const instrumentation = new TuiRenderInstrumentation();
const transcript = new RetainedContainer({ instrumentation });
for (let index = 0; index < items.length; index++) {
	const text = items[index]!;
	const component = index % 2 === 0
		? new UserMessageComponent(text)
		: new AssistantMessageComponent(assistantMessage(text));
	transcript.addRetainedChild(component, { id: `history-${index}`, version: 1, completed: true });
}
const active = new AssistantMessageComponent(assistantMessage("active"));
const activeItem = transcript.addRetainedChild(active, { id: "active", version: 0 });

const terminal = new SlowTerminal(width, height);
const tui = new TuiMainScreen(terminal, false);
tui.setRenderInstrumentation(instrumentation);
tui.addChild(
	fullHistoryMode
		? {
				render: (renderWidth) => transcript.render(renderWidth),
				invalidate: () => transcript.invalidate(),
			}
		: transcript,
);
let generation = 0;
const transcriptSha256 = createHash("sha256").update(items.join("\n")).digest("hex");
// Prime the production renderer without an artificial multi-minute first-frame
// delay. Measured transcript updates then flow through the slow sink.
tui.renderNow();
const retainedStats = transcript.getRetainedStats();
terminal.enableBackpressure();

await runBenchmarkMain({
	name: "tui-transcript",
	fixture: `${BENCHMARK_FIXTURE_VERSION}:real-transcript:${itemCount}:${width}x${height}:${cpuOnly ? "cpu-only" : `slow-${terminalBytesPerSecond}Bps`}`,
	run: () => {
		instrumentation.reset();
		terminal.beginSample();
		active.updateContent(assistantMessage(`active update ${generation++}`), true);
		activeItem.updateVersion(generation);
		tui.renderNow();
		const state = tui.captureRenderState();
		const metrics = instrumentation.snapshot();
		return {
			transcriptItems: itemCount,
			itemRenderCalls: metrics.transcriptItemRenders,
			completedItemRenderCalls: metrics.completedItemRenders,
			activeItemRenderCalls: metrics.activeItemRenders,
			retainedCacheHits: metrics.retainedCacheHits,
			retainedItems: retainedStats.retainedItems,
			completedRetainedItems: retainedStats.completedItems,
			activeRetainedItems: retainedStats.activeItems,
			cachedItems: retainedStats.cachedItems,
			cachedLines: retainedStats.cachedLines,
			estimatedCachedBytes: retainedStats.estimatedCachedBytes,
			rootRenders: metrics.rootRenders,
			generatedLines: metrics.generatedLines,
			visibleLines: Math.min(state.previousLines.length, height),
			viewportItemVisits: metrics.viewportItemVisits,
			viewportComposedLines: metrics.viewportComposedLines,
			viewportCopiedLines: metrics.viewportCopiedLines,
			viewportTargetHeightLookupProbes: metrics.viewportTargetHeightLookupProbes,
			viewportBlockLookupProbes: metrics.viewportBlockLookupProbes,
			fullHistoryFallbacks: metrics.fullHistoryFallbacks,
			cursorScannedLines: metrics.cursorScannedLines,
			overlayRenders: metrics.overlayRenders,
			terminalDiffLines: metrics.terminalDiffLines,
			instrumentedTerminalBytes: metrics.terminalBytes,
			pendingRenderRequestHighWaterMark: metrics.pendingRenderRequestHighWaterMark,
			terminalFrameQueueHighWaterMark: metrics.terminalFrameQueueHighWaterMark,
			terminalActiveWriteHighWaterMark: metrics.terminalActiveWriteHighWaterMark,
			terminalPendingFrameHighWaterMark: metrics.terminalPendingFrameHighWaterMark,
			terminalFramesReplaced: metrics.terminalFramesReplaced,
			terminalFrameWriteErrors: metrics.terminalFrameWriteErrors,
			slowTerminalBytesPerSecond: terminalBytesPerSecond,
			...terminal.sample,
		};
	},
	observations: () => ({
		transcriptSha256,
		transcriptRenderer: fullHistoryMode
			? "TuiMainScreen+RetainedFullHistory+UserMessageComponent+AssistantMessageComponent"
			: "TuiMainScreen+RetainedViewportHeightIndex+UserMessageComponent+AssistantMessageComponent",
		deliveryMode: fullHistoryMode ? "session-local-sidecar+full-history" : "session-local-sidecar+visible-line-window",
			slowTerminal: !cpuOnly,
			cpuOnly,
		preRenderedTranscript: true,
	}),
});
