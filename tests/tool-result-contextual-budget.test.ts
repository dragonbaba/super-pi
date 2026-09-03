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
	context: ContextualBudgetFixture,
) => Message[];

const SESSION_ID = "contextual-budget-session";

function toolResult(toolCallId: string, repetitions = 40): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId,
		toolName: "fixture",
		content: [{ type: "text", text: "abcdefgh ".repeat(repetitions) }],
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
	return (owner.projectMessagesForModel as ContextualProject)(messages, undefined, context);
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
			{ enabled: true, budgetTokens: 256 },
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
		assert.ok(totalToolResultTokens(first) <= 256, `${resultCount} results exceed the turn envelope`);
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

test("context remaining constrains the turn and fails explicitly below the fixed notice", () => {
	const canonical = toolResult("context-call");
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
	owner.dispose();
});
