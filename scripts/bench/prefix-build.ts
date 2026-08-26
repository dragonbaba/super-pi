import { createHash } from "node:crypto";
import {
	buildPrefixManifest,
	compareCanonicalIdentifiers,
	serializePrefixManifest,
} from "../../packages/coding-agent/src/core/prefix-manifest.ts";
import { buildSystemPrompt } from "../../packages/coding-agent/src/core/system-prompt.ts";
import { runBenchmarkMain, readIntegerOption } from "./benchmark.ts";
import { BENCHMARK_FIXTURE_VERSION, createResourceOrderings } from "./fixtures.ts";

const orderingCount = readIntegerOption("--orderings", 100);
const orderings = createResourceOrderings(orderingCount);
const contextKibibytes = readIntegerOption("--context-kib", 128);
const resourceCount = orderings[0]!.length;
const contentLine = "Project context line. 中文上下文。\n";
const contentBytesPerResource = Math.ceil((contextKibibytes * 1024) / resourceCount);
const content = contentLine.repeat(Math.ceil(contentBytesPerResource / Buffer.byteLength(contentLine)));

function sha256(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

function buildPrefix(ordering: readonly string[]): { prompt: string; manifest: string } {
	const canonicalOrdering = [...ordering].sort(compareCanonicalIdentifiers);
	const prompt = buildSystemPrompt({
		cwd: "D:/benchmark/workspace",
		selectedTools: ["read", "bash", "edit", "write"],
		toolSnippets: { read: "Read files", bash: "Run commands", edit: "Edit files", write: "Write files" },
		contextFiles: canonicalOrdering.map((path) => ({ path, content })),
	});
	const manifest = buildPrefixManifest({
		provider: "benchmark",
		model: "benchmark",
		api: "benchmark",
		transport: "sse",
		systemPrompt: prompt,
		tools: ["read", "bash", "edit", "write"].map((name) => ({
			name,
			schema: { type: "object", properties: { path: { type: "string" } } },
		})),
		persistentContext: ordering.map((path) => ({ identifier: path, content, precedence: 0 })),
		previousResponseMode: "none",
	});
	return { prompt, manifest: serializePrefixManifest(manifest) };
}

const canonicalManifestHash = sha256(buildPrefix(orderings[0]!).manifest);
let finalHashSetSha256 = "";

await runBenchmarkMain({
	name: "prefix-build",
	fixture: `${BENCHMARK_FIXTURE_VERSION}:resource-orderings:${orderingCount}:${contextKibibytes}KiB:prefix-manifest-v1`,
	run: () => {
		const hashes = new Set<string>();
		let driftCount = 0;
		let prefixBytes = 0;
		let manifestBytes = 0;
		for (const ordering of orderings) {
			const { prompt, manifest } = buildPrefix(ordering);
			const hash = sha256(manifest);
			hashes.add(hash);
			if (hash !== canonicalManifestHash) driftCount++;
			prefixBytes = Buffer.byteLength(prompt);
			manifestBytes = Buffer.byteLength(manifest);
		}
		finalHashSetSha256 = sha256([...hashes].sort().join("\n"));
		return {
			prefixBytes,
			manifestBytes,
			resourceCount,
			orderingCount,
			manifestHashDriftCount: driftCount,
			uniqueManifestHashes: hashes.size,
		};
	},
	observations: () => ({ canonicalManifestSha256: canonicalManifestHash, manifestHashSetSha256: finalHashSetSha256 }),
});
