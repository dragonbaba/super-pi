import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
	anthropicMessagesApi,
	azureOpenAIResponsesApi,
	bedrockConverseStreamApi,
	getStreamedToolArgumentOwnership,
	googleGenerativeAIApi,
	googleVertexApi,
	mistralConversationsApi,
	openAICodexResponsesApi,
	openAICompletionsApi,
	openAIResponsesApi,
	piMessagesApi,
} from "@super-pi/ai/compat";
import type { KnownApi, ProviderStreams, StreamedToolArgumentOwnership } from "@super-pi/ai";

type ContractEntry = readonly [
	api: KnownApi,
	ownership: StreamedToolArgumentOwnership,
	factory: () => ProviderStreams & { readonly streamedToolArgumentOwnership: StreamedToolArgumentOwnership },
	modulePath: string,
];

const CONTRACT_MATRIX: readonly ContractEntry[] = [
	["anthropic-messages", "mutation-with-generation", anthropicMessagesApi, "anthropic-messages.ts"],
	["bedrock-converse-stream", "mutation-with-generation", bedrockConverseStreamApi, "bedrock-converse-stream.ts"],
	["openai-responses", "mutation-with-generation", openAIResponsesApi, "openai-responses.ts"],
	["azure-openai-responses", "mutation-with-generation", azureOpenAIResponsesApi, "azure-openai-responses.ts"],
	["openai-codex-responses", "mutation-with-generation", openAICodexResponsesApi, "openai-codex-responses.ts"],
	["openai-completions", "mutation-with-generation", openAICompletionsApi, "openai-completions.ts"],
	["mistral-conversations", "mutation-with-generation", mistralConversationsApi, "mistral-conversations.ts"],
	["pi-messages", "replacement-object", piMessagesApi, "pi-messages.ts"],
	["google-generative-ai", "replacement-object", googleGenerativeAIApi, "google-generative-ai.ts"],
	["google-vertex", "replacement-object", googleVertexApi, "google-vertex.ts"],
];

test("every built-in adapter declares one streamed tool-argument ownership contract", () => {
	for (const [api, expected, factory] of CONTRACT_MATRIX) {
		assert.equal(factory().streamedToolArgumentOwnership, expected, `${api} lazy provider`);
		assert.equal(getStreamedToolArgumentOwnership(api), expected, `${api} registry`);
	}
});

test("adapter implementation modules own the contract instead of a central API exception table", () => {
	for (const [api, expected, , modulePath] of CONTRACT_MATRIX) {
		const source = readFileSync(`packages/ai/src/api/${modulePath}`, "utf8");
		assert.match(
			source,
			new RegExp(`export const streamedToolArgumentOwnership = ["']${expected}["'] as const`),
			api,
		);
		assert.equal(
			source.match(/\bstreamedToolArgumentOwnership\b/g)?.length,
			1,
			`${api} wire implementation must only declare host metadata once`,
		);
	}
});

test("streamed tool-argument ownership remains host-only metadata", () => {
	const identityAndDispatchPaths = [
		"packages/ai/src/model-capabilities.ts",
		"packages/ai/src/models-store.ts",
		"packages/ai/src/models.ts",
		"packages/ai/src/utils/effective-dispatch.ts",
		"packages/coding-agent/src/core/models-store.ts",
		"packages/coding-agent/src/core/prefix-manifest.ts",
	];
	for (const filePath of identityAndDispatchPaths) {
		const source = readFileSync(filePath, "utf8");
		assert.doesNotMatch(source, /streamedToolArgumentOwnership/, filePath);
	}

	const lazySource = readFileSync("packages/ai/src/api/lazy.ts", "utf8");
	assert.match(lazySource, /const api: ProviderStreams = \{\s*streamedToolArgumentOwnership,/);
	assert.doesNotMatch(lazySource, /(?:context|options|payload|params)\s*\.\s*streamedToolArgumentOwnership/);
});

test("legacy and custom adapters may omit ownership and enter the counted compatibility boundary", () => {
	const compatSource = readFileSync("packages/ai/src/compat.ts", "utf8");
	assert.match(
		compatSource,
		/streamedToolArgumentOwnership\?: StreamedToolArgumentOwnership;/,
		"custom providers keep the metadata optional",
	);
	assert.match(
		compatSource,
		/getStreamedToolArgumentOwnership\(api: Api\): StreamedToolArgumentOwnership \| undefined/,
	);

	const toolSource = readFileSync(
		"packages/coding-agent/src/modes/interactive/components/tool-execution.ts",
		"utf8",
	);
	assert.match(toolSource, /toolArgsMissingGenerationUpdates\+\+;/);
	assert.match(toolSource, /if \(this\.args === args\) \{[\s\S]*?this\.updateDisplay\(\);[\s\S]*?return;/);
	assert.doesNotMatch(toolSource, /toolArgsMissingGenerationDiagnostics/);
});

test("mutation adapters expose transient generations and replacement adapters replace arguments", () => {
	const mutationSources = [
		"anthropic-messages.ts",
		"bedrock-converse-stream.ts",
		"openai-responses-shared.ts",
		"openai-completions.ts",
		"mistral-conversations.ts",
	];
	for (const modulePath of mutationSources) {
		const source = readFileSync(`packages/ai/src/api/${modulePath}`, "utf8");
		assert.match(source, /partialJson|partialArgs/, modulePath);
	}

	for (const modulePath of ["pi-messages.ts", "google-generative-ai.ts", "google-vertex.ts"]) {
		const source = readFileSync(`packages/ai/src/api/${modulePath}`, "utf8");
		assert.match(source, /\.arguments\s*=|arguments:\s*\(/, modulePath);
	}
});
