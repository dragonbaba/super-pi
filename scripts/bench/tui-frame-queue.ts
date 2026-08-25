import { TuiBase } from "../../packages/tui/src/tui.ts";
import { runBenchmarkMain, readIntegerOption } from "./benchmark.ts";
import { BENCHMARK_FIXTURE_VERSION } from "./fixtures.ts";
import { FakeTerminal } from "../../tests/helpers/runtime-instrumentation.ts";

const requestCount = readIntegerOption("--requests", 100_000);
const width = readIntegerOption("--width", 120);
const height = readIntegerOption("--height", 40);

class CountingTui extends TuiBase {
	readonly mode = "regular" as const;
	renderCount = 0;
	protected doRender(): void {
		this.renderCount++;
		this.terminal.write("frame");
	}
}

await runBenchmarkMain({
	name: "tui-frame-queue",
	fixture: `${BENCHMARK_FIXTURE_VERSION}:render-requests:${requestCount}:${width}x${height}`,
	run: () => {
		const terminal = new FakeTerminal(width, height);
		const tui = new CountingTui(terminal);
		for (let index = 0; index < requestCount; index++) tui.requestRender();
		tui.renderNow();
		tui.stop();
		return { requests: requestCount, framesRendered: tui.renderCount, terminalBytes: terminal.bytesWritten };
	},
});
