import { Container } from "../../packages/tui/src/tui.ts";
import { Text } from "../../packages/tui/src/components/text.ts";
import { runBenchmarkMain, readIntegerOption } from "./benchmark.ts";
import { BENCHMARK_FIXTURE_VERSION, createTranscriptItems } from "./fixtures.ts";

const itemCount = readIntegerOption("--items", 5_000);
const width = readIntegerOption("--width", 120);
const height = readIntegerOption("--height", 40);
const items = createTranscriptItems(itemCount);
const root = new Container();
let renderCalls = 0;

class CountingText extends Text {
	override render(renderWidth: number): string[] {
		renderCalls++;
		return super.render(renderWidth);
	}
}

for (const item of items) root.addChild(new CountingText(item, 0, 0));
const active = new CountingText("active", 0, 0);
root.addChild(active);
let generation = 0;

await runBenchmarkMain({
	name: "tui-transcript",
	fixture: `${BENCHMARK_FIXTURE_VERSION}:transcript:${itemCount}:${width}x${height}`,
	run: () => {
		renderCalls = 0;
		active.setText(`active update ${generation++}`);
		const lines = root.render(width);
		return { transcriptItems: itemCount, itemRenderCalls: renderCalls, generatedLines: lines.length, visibleLines: Math.min(lines.length, height) };
	},
});
