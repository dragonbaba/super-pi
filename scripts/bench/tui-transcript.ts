import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import type { AssistantMessage } from "../../packages/ai/src/types.ts";
import { Container, type Component } from "../../packages/tui/src/tui.ts";
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
const items = createTranscriptItems(itemCount);
let renderCalls = 0;
initTheme("dark");

class CountingComponent implements Component {
	private readonly inner: Component;
	constructor(inner: Component) {
		this.inner = inner;
	}
	render(renderWidth: number): string[] {
		renderCalls++;
		return this.inner.render(renderWidth);
	}
	invalidate(): void {
		this.inner.invalidate();
	}
}

class SlowTerminal extends FakeTerminal {
	private backpressureEnabled = false;
	private sampleWriteCalls = 0;
	private sampleBytes = 0;
	private sampleDelayMs = 0;

	override write(data: string): void {
		super.write(data);
		const bytes = Buffer.byteLength(data);
		const delayMs = this.backpressureEnabled ? bytes / terminalBytesPerSecond * 1_000 : 0;
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

const transcript = new Container();
for (let index = 0; index < items.length; index++) {
	const text = items[index]!;
	const component = index % 2 === 0
		? new UserMessageComponent(text)
		: new AssistantMessageComponent(assistantMessage(text));
	transcript.addChild(new CountingComponent(component));
}
const active = new AssistantMessageComponent(assistantMessage("active"));
transcript.addChild(new CountingComponent(active));

const terminal = new SlowTerminal(width, height);
const tui = new TuiMainScreen(terminal, false);
tui.addChild(transcript);
let generation = 0;
const transcriptSha256 = createHash("sha256").update(items.join("\n")).digest("hex");
// Prime the production renderer without an artificial multi-minute first-frame
// delay. Measured transcript updates then flow through the slow sink.
tui.renderNow();
terminal.enableBackpressure();

await runBenchmarkMain({
	name: "tui-transcript",
	fixture: `${BENCHMARK_FIXTURE_VERSION}:real-transcript:${itemCount}:${width}x${height}:slow-${terminalBytesPerSecond}Bps`,
	run: () => {
		renderCalls = 0;
		terminal.beginSample();
		active.updateContent(assistantMessage(`active update ${generation++}`), true);
		tui.renderNow();
		const state = tui.captureRenderState();
		return {
			transcriptItems: itemCount,
			itemRenderCalls: renderCalls,
			generatedLines: state.previousLines.length,
			visibleLines: Math.min(state.previousLines.length, height),
			slowTerminalBytesPerSecond: terminalBytesPerSecond,
			...terminal.sample,
		};
	},
	observations: () => ({
		transcriptSha256,
		transcriptRenderer: "TuiMainScreen+UserMessageComponent+AssistantMessageComponent",
		slowTerminal: true,
		preRenderedTranscript: true,
	}),
});
