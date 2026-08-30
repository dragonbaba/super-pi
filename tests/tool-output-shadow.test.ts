import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { convertResponsesMessages } from "../packages/ai/src/api/openai-responses-shared.ts";
import type { Context, Model, ToolResultMessage, Usage } from "../packages/ai/src/types.ts";
import {
	createToolOutputEstimatorCounters,
	createToolOutputShadowObserver,
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
	telemetry?: { recordToolOutputShadow(record: ToolOutputShadowTelemetry): void },
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
	assert.equal(counters.telemetryPayloadsDropped, 1);

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
	assert.equal(noConsumerCounters.telemetryPayloadsDropped, 1);
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
		exactEstimator: {
			estimatorId: "exact.fixture",
			estimateToolOutputTokens: () => { exactCalls++; return 1; },
		},
		telemetry: { recordToolOutputShadow: () => { telemetryCalls++; } },
	})!;
	const output = { toolName: "bash", content: [{ type: "text" as const, text: "output" }] };
	observer.observe(output);
	observer.dispose();
	observer.observe(output);
	assert.equal(exactCalls, 1);
	assert.equal(telemetryCalls, 1);
	assert.equal(counters.finalRetainedReferences, 0);
	assert.equal(counters.fullStringCopies, 0);
	assert.equal(counters.fullStringSerializations, 0);
	assert.equal(counters.temporaryLineArrays, 0);
});

test("disabled shadow constructs no observer and production insertion follows final extension transformation", () => {
	const counters = createToolOutputEstimatorCounters();
	assert.equal(createToolOutputShadowObserver({ enabled: false, counters }), undefined);
	assert.equal(counters.estimatorCalls, 0);

	const source = readFileSync("packages/coding-agent/src/core/agent-session.ts", "utf8");
	const extension = source.indexOf("if (this._extensionRunner.hasHandlers(event.type)) await this._emitExtensionEvent(event);");
	const shadow = source.indexOf("this._toolOutputShadow?.observe(event.message);");
	const listeners = source.indexOf("// Notify all listeners.", shadow);
	const persistence = source.indexOf("// Handle session persistence", shadow);
	assert.ok(extension >= 0 && extension < shadow);
	assert.ok(shadow < listeners && listeners < persistence);
	assert.equal(source.includes("event.message.toolOutput"), false);
});
