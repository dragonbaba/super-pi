import assert from "node:assert/strict";
import test from "node:test";
import {
	buildPrefixManifest,
	compareCanonicalIdentifiers,
	serializePrefixManifest,
	type PrefixManifestBuildInput,
} from "../packages/coding-agent/src/core/prefix-manifest.ts";

interface ResourceFixture {
	identifier: string;
	content: string;
	precedence: number;
}

function shuffled<T>(values: readonly T[], seed: number): T[] {
	const result = [...values];
	let state = seed || 1;
	for (let index = result.length - 1; index > 0; index--) {
		state = (state * 1664525 + 1013904223) >>> 0;
		const selected = state % (index + 1);
		[result[index], result[selected]] = [result[selected]!, result[index]!];
	}
	return result;
}

test("100 randomized sibling discovery orders produce one final manifest", () => {
	const resources: ResourceFixture[] = Array.from({ length: 64 }, (_, index) => ({
		identifier: `skills\\group-${index % 8}\\skill-${String(index).padStart(2, "0")}.md`,
		content: `resource-${index}\r\nbody`,
		precedence: 10,
	}));
	const manifests = new Set<string>();
	for (let seed = 1; seed <= 100; seed++) {
		const discovered = shuffled(resources, seed);
		const canonicalPromptResources = [...discovered].sort((left, right) =>
			compareCanonicalIdentifiers(left.identifier, right.identifier),
		);
		const input: PrefixManifestBuildInput = {
			provider: "fixture",
			model: "fixture",
			api: "fixture",
			transport: "sse",
			systemPrompt: canonicalPromptResources.map((resource) => `${resource.identifier}\n${resource.content}`).join("\n"),
			tools: [{ name: "read", schema: { properties: { path: { type: "string" } }, type: "object" } }],
			persistentContext: discovered,
			dynamicInstructionGeneration: 0,
			dynamicInstructions: "",
			requestTransformChain: [],
			compactionGeneration: 0,
			previousResponseMode: "none",
		};
		manifests.add(serializePrefixManifest(buildPrefixManifest(input)));
	}

	assert.equal(manifests.size, 1);
});

test("semantic tool and context precedence order remains observable", () => {
	const create = (tools: string[], context: ResourceFixture[]) => buildPrefixManifest({
		provider: "fixture",
		model: "fixture",
		api: "fixture",
		transport: "sse",
		systemPrompt: "stable",
		tools: tools.map((name) => ({ name, schema: {} })),
		persistentContext: context,
		dynamicInstructionGeneration: 0,
		dynamicInstructions: "",
		requestTransformChain: [],
		compactionGeneration: 0,
		previousResponseMode: "none",
	});
	const contexts = [
		{ identifier: "global/AGENTS.md", content: "global", precedence: 0 },
		{ identifier: "project/AGENTS.md", content: "project", precedence: 1 },
	];

	assert.notEqual(create(["read", "write"], contexts).toolOrderHash, create(["write", "read"], contexts).toolOrderHash);
	assert.notEqual(
		create(["read"], contexts).persistentContextHash,
		create(["read"], [
			{ ...contexts[1]!, precedence: 0 },
			{ ...contexts[0]!, precedence: 1 },
		]).persistentContextHash,
	);
});
