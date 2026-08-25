import { truncateHead, truncateTail } from "../../packages/coding-agent/src/core/tools/truncate.ts";
import { runBenchmarkMain, readIntegerOption } from "./benchmark.ts";
import { BENCHMARK_FIXTURE_VERSION, createToolOutput } from "./fixtures.ts";

const outputMebibytes = readIntegerOption("--mebibytes", 1);
const output = createToolOutput(outputMebibytes);

await runBenchmarkMain({
	name: "tool-output",
	fixture: `${BENCHMARK_FIXTURE_VERSION}:tool-output:${outputMebibytes}MiB`,
	run: () => {
		const head = truncateHead(output);
		const tail = truncateTail(output);
		return {
			rawBytes: Buffer.byteLength(output),
			headBytes: head.outputBytes,
			tailBytes: tail.outputBytes,
			totalLines: head.totalLines,
		};
	},
});
