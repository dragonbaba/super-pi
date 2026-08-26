import { createHash } from "node:crypto";
import { buildSystemPrompt } from "../../packages/coding-agent/src/core/system-prompt.ts";
import { runBenchmarkMain, readIntegerOption } from "./benchmark.ts";
import { BENCHMARK_FIXTURE_VERSION, createResourceOrderings } from "./fixtures.ts";

const orderingCount = readIntegerOption("--orderings", 100);
const orderings = createResourceOrderings(orderingCount);
const content = "Project context line. 中文上下文。\n".repeat(64);

function sha256(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

function buildPrefix(ordering: readonly string[]): string {
	return buildSystemPrompt({
		cwd: "D:/benchmark/workspace",
		selectedTools: ["read", "bash", "edit", "write"],
		toolSnippets: { read: "Read files", bash: "Run commands", edit: "Edit files", write: "Write files" },
		contextFiles: ordering.map((path) => ({ path, content })),
	});
}

const canonicalPrefixHash = sha256(buildPrefix(orderings[0]!.slice().sort()));
let finalHashSetSha256 = "";

await runBenchmarkMain({
	name: "prefix-build",
	fixture: `${BENCHMARK_FIXTURE_VERSION}:resource-orderings:${orderingCount}:all`,
	run: () => {
		const hashes = new Set<string>();
		let driftCount = 0;
		let prefixBytes = 0;
		for (const ordering of orderings) {
			const prompt = buildPrefix(ordering);
			const hash = sha256(prompt);
			hashes.add(hash);
			if (hash !== canonicalPrefixHash) driftCount++;
			prefixBytes = Buffer.byteLength(prompt);
		}
		finalHashSetSha256 = sha256([...hashes].sort().join("\n"));
		return {
			prefixBytes,
			resourceCount: orderings[0]!.length,
			orderingCount,
			prefixHashDriftCount: driftCount,
			uniquePrefixHashes: hashes.size,
		};
	},
	observations: () => ({ canonicalPrefixSha256: canonicalPrefixHash, prefixHashSetSha256: finalHashSetSha256 }),
});
