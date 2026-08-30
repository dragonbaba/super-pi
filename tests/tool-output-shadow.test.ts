import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { convertResponsesMessages } from "../packages/ai/src/api/openai-responses-shared.ts";
import type { Context, Model, ToolResultMessage, Usage } from "../packages/ai/src/types.ts";
import {
	createToolOutputEstimatorCounters,
	createToolOutputShadowObserver,
	TOOL_OUTPUT_EXACT_ESTIMATOR_ID,
	TOOL_OUTPUT_FALLBACK_ESTIMATOR_ID,
	TOOL_OUTPUT_SHADOW_BUDGETS,
	type ToolOutputExactEstimatorInput,
	type ToolOutputShadowTelemetry,
} from "../packages/coding-agent/src/core/tool-output-budget.ts";

const USAGE: Usage = {
	input: 11,
	output: 7,
	cacheRead: 3,
	cacheWrite: 2,
	totalTokens: 23,
	cost: { input: 0.01, output: 0.02, cacheRead: 0.003, cacheWrite: 0.002, total: 0.035 },
};

const MODEL: Model<"openai-responses"> = {
	id: "shadow-fixture",
	name: "Shadow Fixture",
	api: "openai-responses",
	provider: "fixture",
	baseUrl: "https://example.test",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128_000,
	maxTokens: 4_096,
};

interface PipelineSnapshot {
	returnedContent: unknown;
	sessionHistory: unknown;
	extensionHookInput: unknown;
	providerPayload: unknown;
	uiResult: unknown;
	isError: boolean;
	usage: Usage;
	cost: Usage["cost"];
}

function runControlPipeline(
	enabled: boolean,
	telemetry?: { recordToolOutputShadow(record: ToolOutputShadowTelemetry): void | Promise<void> },
): PipelineSnapshot {
	const content = [{ type: "text" as const, text: "final extension-visible tool output\n第二行 😀" }];
	const result = { content, details: { truncation: { totalBytes: 9_999, totalLines: 77 } }, usage: USAGE };
	const extensionHookInput = structuredClone(result);
	const message: ToolResultMessage = {
		role: "toolResult",
		toolCallId: "call-shadow|fc-shadow",
		toolName: "mcp_fixture_lookup",
		content,
		details: result.details,
		usage: USAGE,
		isError: true,
		timestamp: 3,
	};
	const observer = createToolOutputShadowObserver({ enabled, telemetry });
	observer?.observe(message);
	const context: Context = {
		systemPrompt: "fixture",
		tools: [],
		messages: [
			{ role: "user", content: "run", timestamp: 1 },
			{
				role: "assistant",
				content: [{ type: "toolCall", id: "call-shadow|fc-shadow", name: "mcp_fixture_lookup", arguments: {} }],
				api: MODEL.api,
				provider: MODEL.provider,
				model: MODEL.id,
				usage: USAGE,
				stopReason: "toolUse",
				timestamp: 2,
			},
			message,
		],
	};
	return {
		returnedContent: structuredClone(result.content),
		sessionHistory: structuredClone(context.messages),
		extensionHookInput,
		providerPayload: structuredClone(convertResponsesMessages(MODEL, context, new Set([MODEL.provider]))),
		uiResult: structuredClone({ content: message.content, details: message.details, isError: message.isError }),
		isError: message.isError,
		usage: structuredClone(message.usage!),
		cost: structuredClone(message.usage!.cost),
	};
}

test("shadow off and on are byte-for-byte equivalent at every external result boundary", () => {
	const records: ToolOutputShadowTelemetry[] = [];
	const off = runControlPipeline(false, { recordToolOutputShadow: (record) => { records.push(record); } });
	const on = runControlPipeline(true, { recordToolOutputShadow: (record) => { records.push(record); } });
	assert.equal(JSON.stringify(on), JSON.stringify(off));
	assert.deepEqual(on, off);
	assert.equal(records.length, 1);
	assert.equal(records[0]!.toolCategory, "mcp");
	assert.equal(records[0]!.rawUtf8Bytes, 9_999);
	assert.equal(records[0]!.rawLines, 77);
});

test("shadow telemetry is metadata-only and a throwing or absent consumer is isolated", () => {
	const secret = "SECRET_fixture_token_123";
	const path = "D:/private/project/secret.txt";
	const counters = createToolOutputEstimatorCounters();
	const observer = createToolOutputShadowObserver({
		enabled: true,
		counters,
		telemetry: { recordToolOutputShadow: () => { throw new Error("consumer failure"); } },
	});
	const message = {
		toolName: "read",
		content: [{ type: "text" as const, text: `${secret}\n${path}` }],
		details: { path, args: { token: secret } },
	};
	observer!.observe(message);
	assert.equal(counters.telemetryPayloadsCreated, 1);
	assert.equal(counters.telemetrySinkDrops, 1);
	assert.equal(counters.telemetrySinkRejections, 1);

	let record: ToolOutputShadowTelemetry | undefined;
	const recording = createToolOutputShadowObserver({
		enabled: true,
		telemetry: { recordToolOutputShadow: (value) => { record = value; } },
	});
	recording!.observe(message);
	const serialized = JSON.stringify(record);
	assert.equal(serialized.includes(secret), false);
	assert.equal(serialized.includes(path), false);
	assert.equal(serialized.includes("token"), false);
	assert.equal(serialized.includes("args"), false);

	const noConsumerCounters = createToolOutputEstimatorCounters();
	createToolOutputShadowObserver({ enabled: true, counters: noConsumerCounters })!.observe(message);
	assert.equal(noConsumerCounters.telemetrySinkDrops, 1);
});

test("async telemetry rejection is isolated from final delivery", async () => {
	const counters = createToolOutputEstimatorCounters();
	let unhandledRejections = 0;
	const onUnhandledRejection = (): void => { unhandledRejections++; };
	process.on("unhandledRejection", onUnhandledRejection);
	try {
		const observer = createToolOutputShadowObserver({
			enabled: true,
			counters,
			telemetry: {
				async recordToolOutputShadow(): Promise<void> {
					throw new Error("telemetry rejection");
				},
			},
		})!;
		const message = { toolName: "bash", content: [{ type: "text" as const, text: "persist me" }] };
		const persisted: typeof message[] = [];
		let listenerMessage: typeof message | undefined;
		observer.observe(message);
		listenerMessage = message;
		persisted.push(message);
		await new Promise<void>((resolve) => { setImmediate(resolve); });
		assert.equal(unhandledRejections, 0);
		assert.equal(listenerMessage, message);
		assert.equal(persisted[0], message);
		assert.equal(counters.telemetrySinkDrops, 1);
		assert.equal(counters.telemetrySinkRejections, 1);
		assert.equal(counters.telemetryRejectionObserversAttached, 1);

		const healthyCounters = createToolOutputEstimatorCounters();
		let healthyCalls = 0;
		createToolOutputShadowObserver({
			enabled: true,
			counters: healthyCounters,
			telemetry: {
				async recordToolOutputShadow(): Promise<void> { healthyCalls++; },
			},
		})!.observe(message);
		await Promise.resolve();
		assert.equal(healthyCalls, 1);
		assert.equal(healthyCounters.telemetrySinkCalls, 1);
		assert.equal(healthyCounters.telemetrySinkDrops, 0);
		assert.equal(healthyCounters.telemetrySinkRejections, 0);
	} finally {
		process.off("unhandledRejection", onUnhandledRejection);
	}
});

test("exact resolver is model-aware and receives immutable text-only input", () => {
	const secret = "SECRET_estimator_id/D:/private/path";
	const imageBody = "sensitive-image-base64-body";
	const originalText = "model-visible text";
	const message = {
		toolName: "mcp_fixture",
		content: [
			{ type: "text" as const, text: originalText },
			{ type: "image" as const, data: imageBody, mimeType: "image/png" },
			{ type: "image" as const, data: `${imageBody}-second`, mimeType: secret },
		],
	};
	const resolvedModels: string[] = [];
	const exactInputs: unknown[] = [];
	const records: ToolOutputShadowTelemetry[] = [];
	const observer = createToolOutputShadowObserver({
		enabled: true,
		resolveExactEstimator: (identity) => {
			resolvedModels.push(`${identity.api}/${identity.provider}/${identity.model}`);
			if (identity.model === "unsupported") return undefined;
			const tokens = identity.model === "model-a" ? 11 : 22;
			return {
				estimatorId: secret,
				estimateToolOutputTokens: (input: ToolOutputExactEstimatorInput) => {
					exactInputs.push(input);
					assert.throws(() => { (input.textBlocks as string[])[0] = "mutated"; });
					assert.throws(() => { (input.imageMimeTypes as string[])[0] = imageBody; });
					assert.equal(input.textBlockCount, 1);
					assert.equal(input.imageCount, 2);
					assert.deepEqual(input.imageMimeTypes, ["image/png", "application/octet-stream"]);
					assert.equal(JSON.stringify(input).includes(imageBody), false);
					return tokens;
				},
			} as never;
		},
		telemetry: { recordToolOutputShadow: (record) => { records.push(record); } },
	})!;
	observer.observe(message, { api: "api-a", provider: "provider-a", model: "model-a" });
	observer.observe(message, { api: "api-b", provider: "provider-b", model: "model-b" });
	observer.observe(message, { api: "api-c", provider: "provider-c", model: "unsupported" });
	assert.deepEqual(resolvedModels, ["api-a/provider-a/model-a", "api-b/provider-b/model-b", "api-c/provider-c/unsupported"]);
	assert.equal(exactInputs.length, 2);
	assert.equal(message.content[0].text, originalText);
	assert.equal(records[0]!.estimatedTokens, 11);
	assert.equal(records[1]!.estimatedTokens, 22);
	assert.equal(records[0]!.estimatorId, TOOL_OUTPUT_EXACT_ESTIMATOR_ID);
	assert.equal(records[1]!.estimatorId, TOOL_OUTPUT_EXACT_ESTIMATOR_ID);
	assert.match(records[0]!.estimatorId, /^[a-z0-9][a-z0-9._-]{0,63}$/);
	assert.ok(records[0]!.estimatorId.length <= 64);
	assert.equal(records[2]!.estimatorId, TOOL_OUTPUT_FALLBACK_ESTIMATOR_ID);
	const serialized = JSON.stringify(records);
	assert.equal(serialized.includes(secret), false);
	assert.equal(serialized.includes(imageBody), false);
});

test("shadow budget constants and fixed telemetry payload schema cannot drift", () => {
	let record: ToolOutputShadowTelemetry | undefined;
	createToolOutputShadowObserver({
		enabled: true,
		telemetry: { recordToolOutputShadow: (value) => { record = value; } },
	})!.observe({ toolName: "bash", content: [{ type: "text", text: "x".repeat(20_000) }] });
	assert.deepEqual(TOOL_OUTPUT_SHADOW_BUDGETS, [1024, 2048, 4096, 8192, 16384]);
	for (const budget of TOOL_OUTPUT_SHADOW_BUDGETS) {
		const suffix = `${budget / 1024}k`;
		const values = record as unknown as Record<string, unknown>;
		assert.equal(values[`proposedModelViewTokens${suffix}`], Math.min(record!.estimatedTokens, budget));
		assert.equal(values[`wouldTruncate${suffix}`], record!.estimatedTokens > budget);
	}
	assert.equal(record!.candidateBudgetTokens, null);
	assert.equal(record!.wouldTruncate, null);
	assert.deepEqual(Object.keys(record!).sort(), [
		"candidateBudgetTokens",
		"estimatedModelVisibleTextBytes",
		"estimatedModelVisibleTextTokens",
		"estimatedTokens",
		"estimatorConfidence",
		"estimatorId",
		"estimatorVersion",
		"proposedModelViewTokens16k",
		"proposedModelViewTokens1k",
		"proposedModelViewTokens2k",
		"proposedModelViewTokens4k",
		"proposedModelViewTokens8k",
		"proposedTruncationReason",
		"rawLines",
		"rawUtf8Bytes",
		"toolCategory",
		"wouldTruncate",
		"wouldTruncate16k",
		"wouldTruncate1k",
		"wouldTruncate2k",
		"wouldTruncate4k",
		"wouldTruncate8k",
	].sort());
});

test("parallel, repeated, and multi-session observers keep isolated primitive counters", async () => {
	const countersA = createToolOutputEstimatorCounters();
	const countersB = createToolOutputEstimatorCounters();
	const recordsA: ToolOutputShadowTelemetry[] = [];
	const recordsB: ToolOutputShadowTelemetry[] = [];
	const a = createToolOutputShadowObserver({
		enabled: true,
		counters: countersA,
		telemetry: { recordToolOutputShadow: (record) => { recordsA.push(record); } },
	})!;
	const b = createToolOutputShadowObserver({
		enabled: true,
		counters: countersB,
		telemetry: { recordToolOutputShadow: (record) => { recordsB.push(record); } },
	})!;
	const messages = Array.from({ length: 32 }, (_, index) => ({
		toolName: index % 2 === 0 ? "bash" : "extension_fixture",
		content: [{ type: "text" as const, text: `result-${index}` }],
	}));
	await Promise.all(messages.map(async (message, index) => (index % 2 === 0 ? a : b).observe(message)));
	for (let index = 0; index < 16; index++) a.observe(messages[0]!);
	assert.equal(countersA.estimatorCalls, 32);
	assert.equal(countersB.estimatorCalls, 16);
	assert.equal(recordsA.length, 32);
	assert.equal(recordsB.length, 16);
	assert.notEqual(countersA, countersB);
});

test("dispose releases estimator and telemetry references without retaining outputs", () => {
	let exactCalls = 0;
	let telemetryCalls = 0;
	const counters = createToolOutputEstimatorCounters();
	const observer = createToolOutputShadowObserver({
		enabled: true,
		counters,
		resolveExactEstimator: () => ({ estimateToolOutputTokens: () => { exactCalls++; return 1; } }),
		telemetry: { recordToolOutputShadow: () => { telemetryCalls++; } },
	})!;
	const output = { toolName: "bash", content: [{ type: "text" as const, text: "output" }] };
	observer.observe(output, { api: "fixture", provider: "fixture", model: "fixture-a" });
	observer.dispose();
	observer.observe(output, { api: "fixture", provider: "fixture", model: "fixture-a" });
	assert.equal(exactCalls, 1);
	assert.equal(telemetryCalls, 1);
	assert.equal(counters.activeRetainedReferencesHighWaterMark, 2);
	assert.equal(counters.activeRetainedReferences, 0);
	assert.equal(counters.activeObservations, 0);
});

test("retained reference high-water mark remains monotonic across shared observer counters", () => {
	const counters = createToolOutputEstimatorCounters();
	const first = createToolOutputShadowObserver({
		enabled: true,
		counters,
		resolveExactEstimator: () => undefined,
		telemetry: { recordToolOutputShadow: () => {} },
	})!;
	assert.equal(counters.activeRetainedReferences, 2);
	assert.equal(counters.activeRetainedReferencesHighWaterMark, 2);
	first.dispose();
	assert.equal(counters.activeRetainedReferences, 0);

	const second = createToolOutputShadowObserver({
		enabled: true,
		counters,
		telemetry: { recordToolOutputShadow: () => {} },
	})!;
	assert.equal(counters.activeRetainedReferences, 1);
	assert.equal(counters.activeRetainedReferencesHighWaterMark, 2);

	const concurrent = createToolOutputShadowObserver({
		enabled: true,
		counters,
		resolveExactEstimator: () => undefined,
		telemetry: { recordToolOutputShadow: () => {} },
	})!;
	assert.equal(counters.activeRetainedReferences, 3);
	assert.equal(counters.activeRetainedReferencesHighWaterMark, 3);
	second.dispose();
	concurrent.dispose();
	assert.equal(counters.activeRetainedReferences, 0);
	assert.equal(counters.activeRetainedReferencesHighWaterMark, 3);
});

test("disabled shadow constructs no observer and production insertion follows final extension transformation", () => {
	const counters = createToolOutputEstimatorCounters();
	assert.equal(createToolOutputShadowObserver({ enabled: false, counters }), undefined);
	assert.equal(counters.estimatorCalls, 0);

	const source = readFileSync("packages/coding-agent/src/core/agent-session.ts", "utf8");
	const extension = source.indexOf("if (this._extensionRunner.hasHandlers(event.type)) await this._emitExtensionEvent(event);");
	const shadow = source.indexOf("this._toolOutputShadow?.observe(");
	const listeners = source.indexOf("// Notify all listeners.", shadow);
	const persistence = source.indexOf("// Handle session persistence", shadow);
	assert.ok(extension >= 0 && extension < shadow);
	assert.ok(shadow < listeners && listeners < persistence);
	assert.equal(source.includes("event.message.toolOutput"), false);
});
