import { buildSystemPrompt } from "../../packages/coding-agent/src/core/system-prompt.ts";
import { runBenchmarkMain, readIntegerOption } from "./benchmark.ts";
import { BENCHMARK_FIXTURE_VERSION, createResourceOrderings } from "./fixtures.ts";

const orderingCount = readIntegerOption("--orderings", 100);
const orderings = createResourceOrderings(orderingCount);
const content = "Project context line. 中文上下文。\n".repeat(64);
let orderingIndex = 0;

await runBenchmarkMain({
	name: "prefix-build",
	fixture: `${BENCHMARK_FIXTURE_VERSION}:resource-orderings:${orderingCount}`,
	run: () => {
		const ordering = orderings[orderingIndex++ % orderings.length]!;
		const prompt = buildSystemPrompt({
			cwd: "D:/benchmark/workspace",
			selectedTools: ["read", "bash", "edit", "write"],
			toolSnippets: { read: "Read files", bash: "Run commands", edit: "Edit files", write: "Write files" },
			contextFiles: ordering.map((path) => ({ path, content })),
		});
		return { prefixBytes: Buffer.byteLength(prompt), resourceCount: ordering.length };
	},
});
