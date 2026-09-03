import assert from "node:assert/strict";
import test from "node:test";
import type { Message, ToolResultMessage } from "@super-pi/ai/compat";
import { estimateToolOutputTokens } from "../packages/coding-agent/src/core/tool-output-budget.ts";
import {
	createToolResultPresentationOwner,
	type ToolResultPresentationContent,
	type ToolResultPresentationOwner,
} from "../packages/coding-agent/src/core/tool-result-presentation.ts";

interface ContextualBudgetFixture {
	systemPrompt?: string;
	tools?: [];
	contextWindow: number;
	maxOutputTokens: number;
}

type ContextualProject = (
	messages: Message[],
	imagePolicy: undefined,
	systemPrompt: string | undefined,
	tools: [] | undefined,
	contextWindow: number,
	maxOutputTokens: number,
) => Message[];

const SESSION_ID = "contextual-budget-session";

function toolResult(toolCallId: string, repetitions = 160): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId,
		toolName: "fixture",
		content: [{ type: "text", text: "abcdefgh ".repeat(repetitions) }],
		isError: false,
		timestamp: 2,
	};
}

function assistantToolTurn(toolCallIds: readonly string[]): Message {
	return {
		role: "assistant",
		content: toolCallIds.map((id) => ({ type: "toolCall", id, name: "fixture", arguments: {} })),
		api: "openai-completions",
		provider: "fixture",
		model: "fixture",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason: "toolUse",
		timestamp: 1,
	};
}

function projectContextually(
	owner: ToolResultPresentationOwner,
	messages: Message[],
	context: ContextualBudgetFixture,
): Message[] {
	return (owner.projectMessagesForModel as ContextualProject)(
		messages,
		undefined,
		context.systemPrompt,
		context.tools,
		context.contextWindow,
		context.maxOutputTokens,
	);
}

function totalToolResultTokens(messages: readonly Message[]): number {
	let total = 0;
	for (const message of messages) {
		if (message.role === "toolResult") total += estimateToolOutputTokens(message.content).estimatedTokens;
	}
	return total;
}

function continuationCursor(message: ToolResultMessage): string | undefined {
	for (const block of message.content) {
		if (block.type !== "text") continue;
		const start = block.text.indexOf("tr1.");
		if (start < 0) continue;
		const end = block.text.indexOf(".]", start);
		if (end > start) return block.text.substring(start, end);
	}
	return undefined;
}

test("per-turn budget deterministically bounds 2/4/8 source-ordered results and retries", () => {
	for (const resultCount of [2, 4, 8]) {
		const ids = Array.from({ length: resultCount }, (_, index) => `call-${resultCount}-${index}`);
		const canonical = ids.map((id) => toolResult(id));
		const owner = createToolResultPresentationOwner(
			{ enabled: true, budgetTokens: 1_024 },
			`${SESSION_ID}-${resultCount}`,
		)!;
		for (let index = 0; index < canonical.length; index++) {
			const presentation = owner.create(canonical[index]!.content, canonical[index]!.toolCallId);
			assert.equal(presentation?.version, 1, "each source remains below the per-tool cap");
		}
		const source = [assistantToolTurn(ids), ...canonical];
		const first = projectContextually(owner, source.slice(), {
			contextWindow: 32_768,
			maxOutputTokens: 4_096,
		});
		assert.ok(totalToolResultTokens(first) <= 1_024, `${resultCount} results exceed the turn envelope`);
		for (let index = 1; index < first.length; index++) {
			const cursor = continuationCursor(first[index] as ToolResultMessage);
			assert.ok(cursor, `result ${index} is missing a continuation`);
			const chunk = owner.readContinuation(cursor, source, 128);
			assert.ok(chunk.content.length > 0);
		}
		const retry = projectContextually(owner, source.slice(), {
			contextWindow: 32_768,
			maxOutputTokens: 4_096,
		});
		assert.deepEqual(retry, first, "retry must not cumulatively deduct the turn budget");
		owner.dispose();
	}
});

test("single small results stay byte-for-byte unchanged while one large result keeps both recovery paths", () => {
	const small = toolResult("single-small", 1);
	const smallSource = [assistantToolTurn([small.toolCallId]), small];
	const smallOwner = createToolResultPresentationOwner(
		{ enabled: true, budgetTokens: 1_024 },
		"single-small-session",
	)!;
	smallOwner.create(small.content, small.toolCallId);
	const smallProjected = projectContextually(smallOwner, smallSource.slice(), {
		contextWindow: 32_768,
		maxOutputTokens: 4_096,
	});
	assert.equal(smallProjected[1], small);
	assert.deepEqual(smallProjected, smallSource);
	smallOwner.dispose();

	const large = toolResult("single-large", 1_000);
	const largeSource = [assistantToolTurn([large.toolCallId]), large];
	const largeOwner = createToolResultPresentationOwner(
		{ enabled: true, budgetTokens: 1_024 },
		"single-large-session",
	)!;
	const presentation = largeOwner.create(large.content, large.toolCallId);
	assert.ok(presentation);
	assert.equal(presentation.version, 2);
	const largeProjected = projectContextually(largeOwner, largeSource.slice(), {
		contextWindow: 32_768,
		maxOutputTokens: 4_096,
	});
	const cursor = continuationCursor(largeProjected[1] as ToolResultMessage);
	assert.ok(cursor);
	assert.ok(largeOwner.readContinuation(cursor, largeSource, 128).content.length > 0);
	if (presentation.version !== 2) throw new Error("expected a bounded V2 presentation");
	assert.ok(presentation.artifact);
	const artifact = largeOwner.readArtifact(presentation.artifact.id, largeSource);
	assert.equal(artifact.content, large.content);
	largeOwner.dispose();
});

test("context remaining constrains the turn and fails explicitly below the fixed notice", () => {
	const canonical = toolResult("context-call", 40);
	const source = [assistantToolTurn([canonical.toolCallId]), canonical];
	const owner = createToolResultPresentationOwner(
		{ enabled: true, budgetTokens: 256 },
		SESSION_ID,
	)!;
	owner.create(canonical.content as ToolResultPresentationContent[], canonical.toolCallId);
	const bounded = projectContextually(owner, source.slice(), {
		contextWindow: 220,
		maxOutputTokens: 64,
	});
	assert.ok(totalToolResultTokens(bounded) < 156);
	assert.ok(continuationCursor(bounded[1] as ToolResultMessage));
	assert.throws(
		() => projectContextually(owner, source.slice(), { contextWindow: 65, maxOutputTokens: 64 }),
		(error: unknown) => error instanceof Error && error.name === "ToolResultContinuationError" && "code" in error && error.code === "budget-too-small",
	);
	assert.equal(owner.counters.activeContextualCoordinators, 0);
	owner.dispose();
});

test("completion order cannot change source-ordered allocation", () => {
	const ids = ["ordered-a", "ordered-b", "ordered-c", "ordered-d"];
	const canonical = ids.map((id) => toolResult(id));
	const source = [assistantToolTurn(ids), ...canonical];
	const natural = createToolResultPresentationOwner(
		{ enabled: true, budgetTokens: 1_024 },
		"deterministic-completion-order",
	)!;
	const reversed = createToolResultPresentationOwner(
		{ enabled: true, budgetTokens: 1_024 },
		"deterministic-completion-order",
	)!;
	for (let index = 0; index < canonical.length; index++) {
		natural.create(canonical[index]!.content, canonical[index]!.toolCallId);
	}
	for (let index = canonical.length - 1; index >= 0; index--) {
		reversed.create(canonical[index]!.content, canonical[index]!.toolCallId);
	}
	const context = { contextWindow: 32_768, maxOutputTokens: 4_096 };
	assert.deepEqual(
		projectContextually(reversed, source.slice(), context),
		projectContextually(natural, source.slice(), context),
	);
	natural.dispose();
	reversed.dispose();
});

test("context clone rebinding accepts canonical content once and rejects modification", () => {
	const canonical = toolResult("clone-call");
	const source = [assistantToolTurn([canonical.toolCallId]), canonical];
	const owner = createToolResultPresentationOwner(
		{ enabled: true, budgetTokens: 1_024 },
		"contextual-clone",
	)!;
	owner.create(canonical.content, canonical.toolCallId);
	owner.clearProjectionRecords();
	const clone = structuredClone(source);
	const projected = projectContextually(owner, clone, { contextWindow: 700, maxOutputTokens: 256 });
	const cursor = continuationCursor(projected[1] as ToolResultMessage);
	assert.ok(cursor);
	assert.ok(owner.readContinuation(cursor, source, 128).content.length > 0);

	owner.clearProjectionRecords();
	const modified = structuredClone(source);
	const modifiedResult = modified[1] as ToolResultMessage;
	modifiedResult.content[0] = { type: "text", text: `changed-${(modifiedResult.content[0] as { text: string }).text}` };
	const rejected = projectContextually(owner, modified, { contextWindow: 700, maxOutputTokens: 256 });
	const rejectedCursor = continuationCursor(rejected[1] as ToolResultMessage);
	assert.ok(rejectedCursor);
	assert.throws(
		() => owner.readContinuation(rejectedCursor, source, 128),
		(error: unknown) => error instanceof Error && "code" in error && error.code === "stale-cursor",
	);
	owner.dispose();
});

test("model/context changes recompute envelopes without retaining a prior turn deduction", () => {
	const canonical = toolResult("model-switch-call");
	const source = [assistantToolTurn([canonical.toolCallId]), canonical];
	const owner = createToolResultPresentationOwner(
		{ enabled: true, budgetTokens: 1_024 },
		"model-switch-budget",
	)!;
	owner.create(canonical.content, canonical.toolCallId);
	const largeWindow = projectContextually(owner, source.slice(), {
		contextWindow: 32_768,
		maxOutputTokens: 4_096,
	});
	const smallWindow = projectContextually(owner, source.slice(), {
		contextWindow: 700,
		maxOutputTokens: 256,
	});
	assert.ok(totalToolResultTokens(smallWindow) < totalToolResultTokens(largeWindow));
	assert.deepEqual(
		projectContextually(owner, source.slice(), { contextWindow: 32_768, maxOutputTokens: 4_096 }),
		largeWindow,
	);
	assert.equal(owner.counters.activeContextualCoordinators, 0);
	assert.equal(owner.counters.contextualCoordinatorsHighWaterMark, 1);
	owner.dispose();
});

test("blocked images and error results remain bounded without exposing base64", () => {
	const result = toolResult("image-error-call");
	result.isError = true;
	result.content.push({ type: "image", data: "QUJD".repeat(10_000), mimeType: "image/png" });
	const source = [assistantToolTurn([result.toolCallId]), result];
	const owner = createToolResultPresentationOwner(
		{ enabled: true, budgetTokens: 256 },
		"contextual-image-error",
	)!;
	owner.create(result.content, result.toolCallId);
	const imagePolicy = (message: Message): Message => {
		if (message.role !== "toolResult") return message;
		const content: ToolResultMessage["content"] = [];
		for (const block of message.content) {
			content.push(block.type === "image" ? { type: "text", text: "[Image blocked]" } : block);
		}
		return { ...message, content };
	};
	const projected = (owner.projectMessagesForModel as (
		messages: Message[],
		policy: (message: Message) => Message,
		systemPrompt: string | undefined,
		tools: [] | undefined,
		contextWindow: number,
		maxOutputTokens: number,
	) => Message[])(source.slice(), imagePolicy, undefined, undefined, 1_024, 256);
	const providerResult = projected[1] as ToolResultMessage;
	assert.equal(providerResult.isError, true);
	assert.equal(providerResult.content.some((block) => block.type === "image"), false);
	assert.equal(JSON.stringify(providerResult).includes("QUJD"), false);
	assert.ok(totalToolResultTokens(projected) <= 256);
	assert.ok(continuationCursor(providerResult));
	owner.dispose();
});
