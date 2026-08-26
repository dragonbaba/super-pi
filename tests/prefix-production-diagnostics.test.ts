import assert from "node:assert/strict";
import test from "node:test";
import { buildSystemPrompt } from "../packages/coding-agent/src/core/system-prompt.ts";
import {
	buildPrefixManifest,
	compareCanonicalIdentifiers,
	comparePrefixManifests,
	createScopedContextIdentifier,
	createScopedExtensionIdentifier,
	sha256Canonical,
	type PrefixManifestBuildInput,
} from "../packages/coding-agent/src/core/prefix-manifest.ts";

function productionLikeInput(options: {
	contextContent?: string;
	selectedTools?: string[];
	basePrompt?: string;
} = {}): PrefixManifestBuildInput {
	const selectedTools = options.selectedTools ?? ["read"];
	const contextContent = options.contextContent ?? "project policy";
	return {
		provider: "openai-codex",
		model: "gpt-test",
		api: "openai-codex-responses",
		transport: "sse",
		cacheRetention: "short",
		systemPrompt: buildSystemPrompt({
			cwd: "D:/workspace",
			customPrompt: options.basePrompt,
			selectedTools,
			toolSnippets: { read: "Read files", write: "Write files" },
			contextFiles: [{ path: "D:/workspace/AGENTS.md", content: contextContent }],
		}),
		tools: selectedTools.map((name) => ({ name, schema: { type: "object", properties: {} } })),
		persistentContext: [{ identifier: "workspace:AGENTS.md", content: contextContent, precedence: 0 }],
		previousResponseMode: "none",
	};
}

test("aggregate system prompt drift preserves production-like context and tool causes", () => {
	const baseline = buildPrefixManifest(productionLikeInput());
	const contextChanged = buildPrefixManifest(productionLikeInput({ contextContent: "changed policy" }));
	const toolActivated = buildPrefixManifest(productionLikeInput({ selectedTools: ["read", "write"] }));
	const basePromptChanged = buildPrefixManifest(productionLikeInput({ basePrompt: "different base prompt" }));

	assert.equal(comparePrefixManifests(baseline, contextChanged)?.firstDivergentSegment, "system-prompt");
	assert.equal(comparePrefixManifests(baseline, contextChanged)?.reasonCode, "PROJECT_CONTEXT_CHANGED");
	assert.equal(comparePrefixManifests(baseline, toolActivated)?.firstDivergentSegment, "system-prompt");
	assert.equal(comparePrefixManifests(baseline, toolActivated)?.reasonCode, "TOOL_ACTIVATED");
	assert.equal(comparePrefixManifests(baseline, basePromptChanged)?.reasonCode, "UNKNOWN_PREFIX_DRIFT");
});

test("canonical identifier comparison is a total order across NFC collisions", () => {
	const composed = "Caf\u00e9";
	const decomposed = "Cafe\u0301";
	assert.notEqual(compareCanonicalIdentifiers(composed, decomposed), 0);
	assert.deepEqual(
		[composed, decomposed].sort(compareCanonicalIdentifiers),
		[decomposed, composed].sort(compareCanonicalIdentifiers),
	);
});

test("cache retention and previous-response drift have dedicated causal mappings", () => {
	const baselineInput = productionLikeInput();
	const baseline = buildPrefixManifest(baselineInput);
	const retention = buildPrefixManifest({ ...baselineInput, cacheRetention: "long" });
	const continuation = buildPrefixManifest({ ...baselineInput, previousResponseMode: "response-id" });
	const retentionDiagnostic = comparePrefixManifests(baseline, retention);
	const continuationDiagnostic = comparePrefixManifests(baseline, continuation);

	assert.equal(retentionDiagnostic?.reasonCode, "CACHE_RETENTION_CHANGED");
	assert.equal(continuationDiagnostic?.reasonCode, "PREVIOUS_RESPONSE_MODE_CHANGED");
	assert.equal("oldGeneration" in (retentionDiagnostic ?? {}), false);
	assert.equal("newGeneration" in (continuationDiagnostic ?? {}), false);
});

test("external context identifiers cannot escape through drift diagnostics", () => {
	const secretRoot = "D:/Users/private-owner/elsewhere";
	const baselineInput = productionLikeInput();
	baselineInput.persistentContext = [{
		identifier: `${secretRoot}/AGENTS.md`,
		content: "one",
		precedence: 0,
	}];
	const changedInput = { ...baselineInput, persistentContext: [{
		identifier: `${secretRoot}/AGENTS.md`,
		content: "two",
		precedence: 0,
	}] };
	const diagnostic = comparePrefixManifests(
		buildPrefixManifest(baselineInput),
		buildPrefixManifest(changedInput),
	);

	assert.equal(diagnostic?.changedIdentifiers.some((identifier) => identifier.includes("private-owner")), false);
	assert.equal(diagnostic?.changedIdentifiers.every((identifier) => identifier.startsWith("external-context:")), true);
});

test("event-scoped absolute paths are hashed before entering manifest diagnostics", () => {
	const baselineInput = productionLikeInput();
	baselineInput.persistentContext = [{
		identifier: "before_provider_request:workspace:D:/Users/private-owner/AGENTS.md",
		content: "one",
		precedence: 0,
	}];
	const changedInput = {
		...baselineInput,
		persistentContext: [{ ...baselineInput.persistentContext[0]!, content: "two" }],
	};
	const diagnostic = comparePrefixManifests(buildPrefixManifest(baselineInput), buildPrefixManifest(changedInput));
	assert.equal(diagnostic?.changedIdentifiers.some((identifier) => identifier.includes("private-owner")), false);
	assert.match(diagnostic?.changedIdentifiers[0] ?? "", /^external-context:[a-f0-9]{64}$/);
});

test("Windows scoped identities use native relative casing without exposing the root", {
	skip: process.platform !== "win32",
}, () => {
	const workspaceRoot = "C:\\Repo\\Project";
	const identifier = createScopedContextIdentifier("c:\\repo\\project\\nested\\AGENTS.md", { workspaceRoot });
	assert.equal(identifier, "workspace:nested/AGENTS.md");
	assert.equal(identifier.toLowerCase().includes("c:/repo"), false);
});

test("global and external paths use stable non-reversible scope identities", () => {
	const workspaceRoot = "D:/workspace/project";
	const globalRoot = "D:/Users/private-owner/.pi/agent";
	const global = createScopedContextIdentifier(`${globalRoot}/AGENTS.md`, { workspaceRoot, globalRoot });
	const external = createScopedContextIdentifier("D:/private/customer/AGENTS.md", { workspaceRoot, globalRoot });
	const firstExtension = createScopedExtensionIdentifier({
		path: "D:/private/one/index.ts",
		resolvedPath: "D:/private/one/index.ts",
		sourceInfo: { source: "local", scope: "temporary", origin: "top-level" },
	}, workspaceRoot);
	const secondExtension = createScopedExtensionIdentifier({
		path: "D:/private/two/index.ts",
		resolvedPath: "D:/private/two/index.ts",
		sourceInfo: { source: "local", scope: "temporary", origin: "top-level" },
	}, workspaceRoot);
	const globalExtension = createScopedExtensionIdentifier({
		path: `${globalRoot}/extensions/sample/index.ts`,
		resolvedPath: `${globalRoot}/extensions/sample/index.ts`,
		sourceInfo: {
			source: "local",
			scope: "user",
			origin: "top-level",
			baseDir: `${globalRoot}/extensions`,
		},
	}, workspaceRoot);

	assert.equal(global, "global-context:AGENTS.md");
	assert.match(external, /^external-context:[a-f0-9]{64}$/);
	assert.match(firstExtension, /^external-extension:[a-f0-9]{64}$/);
	assert.match(globalExtension, /^global-extension:[a-f0-9]{64}$/);
	assert.notEqual(firstExtension, secondExtension);
	for (const identifier of [global, external, firstExtension, secondExtension, globalExtension]) {
		assert.equal(identifier.includes("private-owner"), false);
		assert.equal(identifier.includes("D:/private"), false);
	}
});

test("unwired dynamic instruction and compaction observations are explicitly unavailable", () => {
	const input = productionLikeInput();
	delete input.dynamicInstructionGeneration;
	delete input.dynamicInstructions;
	delete input.compactionGeneration;
	delete input.compactionArtifact;
	const manifest = buildPrefixManifest(input);

	assert.equal(manifest.dynamicInstructionObservationState, "unavailable");
	assert.equal(manifest.compactionObservationState, "unavailable");
	assert.equal("dynamicInstructionGeneration" in manifest, false);
	assert.equal("dynamicInstructionHash" in manifest, false);
	assert.equal("compactionGeneration" in manifest, false);
});

test("non-prefix request body changes do not create false prefix drift", () => {
	const input = productionLikeInput();
	const baseEffective = {
		transport: "sse",
		previousResponseMode: "none" as const,
		instructionsHash: "instructions-hash",
		instructionsBytes: 17,
		toolOrderHash: "tool-order-hash",
		toolIdentifierSetHash: "tool-set-hash",
		toolsHash: "tools-hash",
		toolCount: 1,
		cacheKeyHash: "cache-key-hash",
		cacheRetentionHash: "cache-retention-hash",
		cachePolicyHash: "cache-policy-hash",
		cacheBoundaryHash: "cache-boundary-hash",
		prefixHash: "prefix-hash",
		requestTransformOutputHash: "request-one",
	};
	const first = buildPrefixManifest({ ...input, effectiveDispatch: baseEffective });
	const second = buildPrefixManifest({
		...input,
		effectiveDispatch: { ...baseEffective, requestTransformOutputHash: "request-two" },
	});

	assert.equal(comparePrefixManifests(first, second), undefined);
});

test("effective manifests ignore intent-only context changes until an effective component drifts", () => {
	const baselineInput = productionLikeInput();
	const intentChangedInput = {
		...baselineInput,
		persistentContext: [{ identifier: "workspace:AGENTS.md", content: "changed", precedence: 0 }],
		systemPrompt: "configured prompt changed before onPayload",
	};
	assert.equal(
		comparePrefixManifests(buildPrefixManifest(baselineInput), buildPrefixManifest(intentChangedInput))?.reasonCode,
		"PROJECT_CONTEXT_CHANGED",
	);
	const effective = {
		transport: "sse",
		previousResponseMode: "none" as const,
		instructionsHash: "fixed-instructions",
		instructionsBytes: 18,
		toolOrderHash: "fixed-tool-order",
		toolIdentifierSetHash: "fixed-tool-set",
		toolsHash: "fixed-tools",
		toolCount: 1,
		cacheRetentionHash: "fixed-cache-retention",
		cachePolicyHash: "fixed-cache-policy",
		cacheBoundaryHash: "fixed-cache-boundary",
		prefixHash: "fixed-prefix",
		requestTransformOutputHash: "request-one",
	};
	const baseline = buildPrefixManifest({ ...baselineInput, effectiveDispatch: effective });
	const changedContext = buildPrefixManifest({
		...intentChangedInput,
		effectiveDispatch: { ...effective, requestTransformOutputHash: "request-two" },
	});
	assert.equal(comparePrefixManifests(baseline, changedContext), undefined);
});

test("effective tool-set changes are activation drift even when intent tools stay fixed", () => {
	const input = productionLikeInput();
	const base = {
		transport: "sse",
		previousResponseMode: "none" as const,
		instructionsHash: "fixed-instructions",
		instructionsBytes: 18,
		toolOrderHash: "read-order",
		toolIdentifierSetHash: "read-set",
		toolsHash: "read-tools",
		toolCount: 1,
		cacheRetentionHash: "fixed-cache-retention",
		cachePolicyHash: "fixed-cache-policy",
		cacheBoundaryHash: "fixed-cache-boundary",
		prefixHash: "read-prefix",
		requestTransformOutputHash: "read-request",
	};
	const added = {
		...base,
		toolOrderHash: "read-write-order",
		toolIdentifierSetHash: "read-write-set",
		toolsHash: "read-write-tools",
		toolCount: 2,
		prefixHash: "read-write-prefix",
		requestTransformOutputHash: "read-write-request",
	};
	const diagnostic = comparePrefixManifests(
		buildPrefixManifest({ ...input, effectiveDispatch: base }),
		buildPrefixManifest({ ...input, effectiveDispatch: added }),
	);
	assert.equal(diagnostic?.reasonCode, "TOOL_ACTIVATED");
	assert.equal(diagnostic?.expectedMiss, true);
});

test("effective cache-key drift keeps its dedicated reason ahead of aggregate prefix hash", () => {
	const input = productionLikeInput();
	const effective = {
		transport: "sse",
		previousResponseMode: "none" as const,
		instructionsHash: "fixed-instructions",
		instructionsBytes: 18,
		toolOrderHash: "fixed-order",
		toolIdentifierSetHash: "fixed-set",
		toolsHash: "fixed-tools",
		toolCount: 1,
		cacheKeyHash: "cache-a",
		cacheRetentionHash: "fixed-cache-retention",
		cachePolicyHash: "fixed-cache-policy",
		cacheBoundaryHash: "fixed-cache-boundary",
		prefixHash: "prefix-a",
		requestTransformOutputHash: "request-a",
	};
	const diagnostic = comparePrefixManifests(
		buildPrefixManifest({ ...input, effectiveDispatch: effective }),
		buildPrefixManifest({
			...input,
			effectiveDispatch: {
				...effective,
				cacheKeyHash: "cache-b",
				prefixHash: "prefix-b",
				requestTransformOutputHash: "request-b",
			},
		}),
	);
	assert.equal(diagnostic?.reasonCode, "CACHE_KEY_CHANGED");
	assert.equal(diagnostic?.firstDivergentSegment, "cache-key");
});

test("effective policy classification does not infer from cache-key presence", () => {
	const input = productionLikeInput();
	const effective = {
		transport: "sse",
		previousResponseMode: "none" as const,
		instructionsHash: "fixed-instructions",
		instructionsBytes: 18,
		toolOrderHash: "fixed-order",
		toolIdentifierSetHash: "fixed-set",
		toolsHash: "fixed-tools",
		toolCount: 1,
		cacheRetentionHash: "fixed-cache-retention",
		cachePolicyHash: "fixed-cache-policy",
		cacheBoundaryHash: "fixed-cache-boundary",
		prefixHash: "fixed-prefix",
		requestTransformOutputHash: "fixed-request",
	};
	const withoutKey = buildPrefixManifest({ ...input, effectiveDispatch: effective });
	const withKey = buildPrefixManifest({
		...input,
		effectiveDispatch: { ...effective, cacheKeyHash: "new-key", prefixHash: "key-prefix" },
	});
	assert.equal(comparePrefixManifests(withoutKey, withKey)?.reasonCode, "CACHE_KEY_CHANGED");

	const changedPolicy = buildPrefixManifest({
		...input,
		effectiveDispatch: { ...effective, cachePolicyHash: "changed-policy", prefixHash: "policy-prefix" },
	});
	assert.equal(comparePrefixManifests(withoutKey, changedPolicy)?.reasonCode, "CACHE_POLICY_CHANGED");
});

test("effective short-to-long cache retention drift survives no-op filtering", () => {
	const input = productionLikeInput();
	const shortPolicy = {
		transport: "sse",
		previousResponseMode: "none" as const,
		instructionsHash: "fixed-instructions",
		instructionsBytes: 18,
		toolOrderHash: "fixed-order",
		toolIdentifierSetHash: "fixed-set",
		toolsHash: "fixed-tools",
		toolCount: 1,
		cacheRetentionHash: "resolved-short-retention",
		cachePolicyHash: "resolved-short-policy",
		cacheBoundaryHash: "fixed-cache-boundary",
		prefixHash: "short-prefix",
		requestTransformOutputHash: "short-transform-prefix",
	};
	const longPolicy = {
		...shortPolicy,
		cacheRetentionHash: "resolved-long-retention",
	};
	const diagnostic = comparePrefixManifests(
		buildPrefixManifest({ ...input, cacheRetention: "short", effectiveDispatch: shortPolicy }),
		buildPrefixManifest({ ...input, cacheRetention: "long", effectiveDispatch: longPolicy }),
	);
	assert.equal(diagnostic?.firstDivergentSegment, "cache-retention");
	assert.equal(diagnostic?.reasonCode, "CACHE_RETENTION_CHANGED");
	assert.equal(diagnostic?.expectedMiss, true);
});

test("configured cache retention changes do not drift when effective policy is unchanged", () => {
	const input = productionLikeInput();
	const resolvedPolicy = {
		transport: "sse",
		previousResponseMode: "none" as const,
		instructionsHash: "fixed-instructions",
		instructionsBytes: 18,
		toolOrderHash: "fixed-order",
		toolIdentifierSetHash: "fixed-set",
		toolsHash: "fixed-tools",
		toolCount: 1,
		cacheRetentionHash: "same-provider-retention",
		cachePolicyHash: "same-provider-policy",
		cacheBoundaryHash: "fixed-cache-boundary",
		prefixHash: "same-prefix",
		requestTransformOutputHash: "same-transform-prefix",
	};
	assert.equal(comparePrefixManifests(
		buildPrefixManifest({ ...input, cacheRetention: "short", effectiveDispatch: resolvedPolicy }),
		buildPrefixManifest({ ...input, cacheRetention: "long", effectiveDispatch: resolvedPolicy }),
	), undefined);
});

test("canonical hashing rejects non-JSON container types instead of aliasing plain objects", () => {
	assert.throws(() => sha256Canonical(new Map([["key", "value"]])), /Unsupported canonical object/);
	assert.throws(() => sha256Canonical(new Date("2026-01-01T00:00:00.000Z")), /Unsupported canonical object/);
	assert.notEqual(sha256Canonical({}), sha256Canonical({ key: "value" }));
});
