import assert from "node:assert/strict";
import test from "node:test";
import {
	buildPrefixManifest,
	canonicalizeLogicalPath,
	comparePrefixManifests,
	PrefixManifestRecorder,
	serializePrefixManifest,
	type PrefixManifestBuildInput,
} from "../packages/coding-agent/src/core/prefix-manifest.ts";

function baseInput(): PrefixManifestBuildInput {
	return {
		provider: "openai",
		model: "gpt-test",
		api: "openai-responses",
		transport: "sse",
		cacheRetention: "short",
		systemPrompt: "system\n  semantic trailing space  \n",
		tools: [
			{ name: "read", schema: { type: "object", properties: { path: { type: "string" } } } },
			{ name: "write", schema: { type: "object", properties: { path: { type: "string" } } } },
		],
		persistentContext: [
			{ identifier: "project/AGENTS.md", content: "project context", precedence: 0 },
		],
		dynamicInstructionGeneration: 2,
		dynamicInstructions: "append-only instruction",
		requestTransformChain: ["extension-a:before_provider_request"],
		compactionGeneration: 1,
		compactionArtifact: { summaryId: "summary-1" },
		cacheKey: "session-key",
		previousResponseMode: "none",
	};
}

test("PrefixManifest V1 is stable and serializes only bounded metadata", () => {
	const input = baseInput();
	const manifest = buildPrefixManifest(input);
	const serialized = serializePrefixManifest(manifest);

	assert.equal(manifest.schemaVersion, 1);
	assert.equal(manifest.toolCount, 2);
	assert.equal(manifest.systemPromptBytes, Buffer.byteLength(input.systemPrompt));
	assert.equal(serialized, serializePrefixManifest(buildPrefixManifest(baseInput())));
	for (const secret of [
		input.systemPrompt,
		"project context",
		"append-only instruction",
		"session-key",
		"summary-1",
		'"properties"',
	]) {
		assert.equal(serialized.includes(secret), false, `manifest leaked ${secret}`);
	}
});

test("prompt EOL and schema object-key order are canonical while semantic whitespace and arrays are preserved", () => {
	const crlf = baseInput();
	crlf.systemPrompt = "line one\r\n  keep me  \r\n";
	crlf.tools = [{
		name: "read",
		schema: { required: ["path", "line"], type: "object", properties: { line: { type: "number" }, path: { type: "string" } } },
	}, ...crlf.tools.slice(1)];
	const lfReordered = baseInput();
	lfReordered.systemPrompt = "line one\n  keep me  \n";
	lfReordered.tools = [{
		name: "read",
		schema: { properties: { path: { type: "string" }, line: { type: "number" } }, type: "object", required: ["path", "line"] },
	}, ...lfReordered.tools.slice(1)];
	const arrayReordered = baseInput();
	arrayReordered.systemPrompt = lfReordered.systemPrompt;
	arrayReordered.tools = [{
		...lfReordered.tools[0]!,
		schema: { ...(lfReordered.tools[0]!.schema as object), required: ["line", "path"] },
	}, ...arrayReordered.tools.slice(1)];
	const trimmed = baseInput();
	trimmed.systemPrompt = "line one\nkeep me\n";

	const first = buildPrefixManifest(crlf);
	const second = buildPrefixManifest(lfReordered);
	assert.equal(first.systemPromptHash, second.systemPromptHash);
	assert.equal(first.toolSchemaHash, second.toolSchemaHash);
	assert.notEqual(buildPrefixManifest(arrayReordered).toolSchemaHash, second.toolSchemaHash);
	assert.notEqual(buildPrefixManifest(trimmed).systemPromptHash, second.systemPromptHash);
});

test("logical path hashes are separator and Unicode-normalization stable", () => {
	assert.equal(
		canonicalizeLogicalPath("Project\\技能\\Cafe\u0301\\SKILL.md", { caseInsensitive: true }),
		canonicalizeLogicalPath("project/技能/Café/SKILL.md", { caseInsensitive: true }),
	);
});

test("first divergent segment reports deterministic expected-miss diagnostics", () => {
	const baseline = buildPrefixManifest(baseInput());
	const schemaChangedInput = baseInput();
	schemaChangedInput.tools = [
		{ name: "read", schema: { type: "object", properties: { path: { type: "number" } } } },
		...schemaChangedInput.tools.slice(1),
	];
	const schemaDiagnostic = comparePrefixManifests(baseline, buildPrefixManifest(schemaChangedInput));
	assert.deepEqual(schemaDiagnostic, {
		firstDivergentSegment: "tool-schema",
		oldGeneration: 1,
		newGeneration: 1,
		expectedMiss: true,
		reasonCode: "TOOL_SCHEMA_CHANGED",
		changedIdentifiers: ["read"],
	});

	const activatedInput = baseInput();
	activatedInput.tools = [...activatedInput.tools, { name: "grep", schema: { type: "object" } }];
	assert.deepEqual(comparePrefixManifests(baseline, buildPrefixManifest(activatedInput)), {
		firstDivergentSegment: "tool-order",
		oldGeneration: 1,
		newGeneration: 1,
		expectedMiss: true,
		reasonCode: "TOOL_ACTIVATED",
		changedIdentifiers: ["grep"],
	});

	const multipleChanges = baseInput();
	multipleChanges.systemPrompt = "changed first segment";
	multipleChanges.tools = [...multipleChanges.tools, { name: "grep", schema: {} }];
	assert.equal(comparePrefixManifests(baseline, buildPrefixManifest(multipleChanges))?.firstDivergentSegment, "system-prompt");
	assert.equal(comparePrefixManifests(baseline, buildPrefixManifest(baseInput())), undefined);
});

test("transport and semantic tool reordering are diagnosed without claiming activation", () => {
	const baseline = buildPrefixManifest(baseInput());
	const transportChanged = baseInput();
	transportChanged.transport = "websocket";
	assert.equal(comparePrefixManifests(baseline, buildPrefixManifest(transportChanged))?.firstDivergentSegment, "transport");

	const reordered = baseInput();
	reordered.tools = [reordered.tools[1]!, reordered.tools[0]!];
	assert.deepEqual(comparePrefixManifests(baseline, buildPrefixManifest(reordered)), {
		firstDivergentSegment: "tool-order",
		oldGeneration: 1,
		newGeneration: 1,
		expectedMiss: false,
		reasonCode: "UNKNOWN_PREFIX_DRIFT",
		changedIdentifiers: [],
	});
});

test("PrefixManifestRecorder retains only the current manifest and first live drift", () => {
	const recorder = new PrefixManifestRecorder();
	const baseline = buildPrefixManifest(baseInput());
	assert.equal(recorder.record(baseline), undefined);
	assert.equal(recorder.current, baseline);

	const changed = baseInput();
	changed.dynamicInstructionGeneration = (changed.dynamicInstructionGeneration ?? 0) + 1;
	changed.dynamicInstructions = "new instruction";
	const diagnostic = recorder.record(buildPrefixManifest(changed));
	assert.equal(diagnostic?.firstDivergentSegment, "dynamic-instructions");
	assert.equal(diagnostic?.oldGeneration, 2);
	assert.equal(diagnostic?.newGeneration, 3);
	assert.equal(recorder.diagnostic, diagnostic);
});

test("every known manifest segment maps to its first deterministic reason code", () => {
	const baseline = buildPrefixManifest(baseInput());
	const cases: Array<{
		segment: string;
		reason: string;
		mutate(input: PrefixManifestBuildInput): void;
	}> = [
		{ segment: "model", reason: "MODEL_CHANGED", mutate: (input) => { input.model = "gpt-other"; } },
		{ segment: "system-prompt", reason: "UNKNOWN_PREFIX_DRIFT", mutate: (input) => { input.systemPrompt += "changed"; } },
		{
			segment: "persistent-context",
			reason: "PROJECT_CONTEXT_CHANGED",
			mutate: (input) => {
				input.persistentContext = [{ identifier: "project/AGENTS.md", content: "changed", precedence: 0 }];
			},
		},
		{
			segment: "dynamic-instructions",
			reason: "DYNAMIC_INSTRUCTION_CHANGED",
			mutate: (input) => { input.dynamicInstructionGeneration = 3; },
		},
		{
			segment: "request-transform-chain",
			reason: "UNKNOWN_PREFIX_DRIFT",
			mutate: (input) => { input.requestTransformChain = ["extension-b:before_provider_request"]; },
		},
		{ segment: "compaction", reason: "COMPACTION_BOUNDARY", mutate: (input) => { input.compactionGeneration = 2; } },
		{ segment: "cache-key", reason: "CACHE_KEY_CHANGED", mutate: (input) => { input.cacheKey = "other-session"; } },
	];

	for (const fixture of cases) {
		const changed = baseInput();
		fixture.mutate(changed);
		const diagnostic = comparePrefixManifests(baseline, buildPrefixManifest(changed));
		assert.equal(diagnostic?.firstDivergentSegment, fixture.segment);
		assert.equal(diagnostic?.reasonCode, fixture.reason);
	}
});
