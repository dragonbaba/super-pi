import assert from "node:assert/strict";
import test from "node:test";
import type { AgentMessage } from "../packages/agent/src/types.ts";
import type { ToolResultMessage } from "../packages/ai/src/types.ts";
import { estimateToolOutputTokens } from "../packages/coding-agent/src/core/tool-output-budget.ts";
import {
	createToolResultPresentationOwner,
	getToolResultModelContent,
	getToolResultUiContent,
	TOOL_RESULT_PRESENTATION_V2_VERSION,
	ToolResultContinuationError,
	type ToolResultPresentationContent,
	type ToolResultPresentationV2,
} from "../packages/coding-agent/src/core/tool-result-presentation.ts";

const SESSION_ID = "phase-5b-b-session";
const BUDGET_TOKENS = 128;

function toolResult(content: ToolResultPresentationContent[], toolCallId = "call-budgeted"): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId,
		toolName: "read",
		content: content as ToolResultMessage["content"],
		isError: false,
		timestamp: 1,
	};
}

function flattenContent(content: readonly ToolResultPresentationContent[]): string {
	let result = "";
	for (let index = 0; index < content.length; index++) {
		const block = content[index]!;
		result += block.type === "text" ? block.text : `\u0000I:${block.mimeType}:${block.data}\u0000`;
	}
	return result;
}

function reconstruct(
	presentation: ToolResultPresentationV2,
	owner: NonNullable<ReturnType<typeof createToolResultPresentationOwner>>,
	messages: AgentMessage[],
): ToolResultPresentationContent[] {
	const result: ToolResultPresentationContent[] = [];
	for (let index = 0; index < presentation.truncation.noticeBlockIndex; index++) {
		result.push(presentation.modelContent[index]!);
	}
	let cursor: string | undefined = presentation.continuation.cursor;
	let calls = 0;
	while (cursor) {
		const chunk = owner.readContinuation(cursor, messages, BUDGET_TOKENS);
		for (let index = 0; index < chunk.content.length; index++) result.push(chunk.content[index]!);
		cursor = chunk.nextCursor;
		calls++;
		assert.ok(calls < 256, "continuation must make bounded forward progress");
	}
	for (let index = presentation.truncation.noticeBlockIndex + 1; index < presentation.modelContent.length; index++) {
		result.push(presentation.modelContent[index]!);
	}
	return result;
}

test("explicit budget creates V2 while absent budget preserves exact V1 semantics", () => {
	const content: ToolResultPresentationContent[] = [{ type: "text", text: "small result" }];
	const v1Owner = createToolResultPresentationOwner({ enabled: true }, SESSION_ID)!;
	const v1 = v1Owner.create(content, "small-call")!;
	assert.equal(v1.version, 1);
	assert.equal(v1.modelContent, content);
	v1Owner.release();
	v1Owner.dispose();

	const budgeted = createToolResultPresentationOwner(
		{ enabled: true, budgetTokens: BUDGET_TOKENS },
		SESSION_ID,
	)!;
	const small = budgeted.create(content, "small-call")!;
	assert.equal(small.version, 1);
	assert.equal(small.modelContent, content);
	assert.deepEqual(small.modelContent, content);
	budgeted.release();
	budgeted.dispose();
	assert.equal(createToolResultPresentationOwner({ enabled: false, budgetTokens: 0 }, SESSION_ID), undefined);
	assert.throws(
		() => createToolResultPresentationOwner({ enabled: true, budgetTokens: 0 }, SESSION_ID),
		/toolResultPresentation\.budgetTokens must be a positive safe integer/,
	);
});

test("V2 head-tail views stay in budget across deterministic text corpora", () => {
	const fixtures = [
		["english", "The quick brown fox jumps over the lazy dog. ".repeat(512)],
		["cjk", "中文工具输出需要稳定保守地截断并可继续读取。".repeat(512)],
		["json", JSON.stringify({ rows: Array.from({ length: 512 }, (_, index) => ({ index, ok: true })) })],
		["code", "export function value(input: number) { return input * 2; }\n".repeat(512)],
		["ansi", "\u001b[31mERROR\u001b[0m request failed\n".repeat(512)],
		["emoji", "🙂👨‍👩‍👧‍👦e\u0301".repeat(1024)],
		["malformed", ("left\ud800right\udc00" as string).repeat(1024)],
	] as const;
	for (const [name, text] of fixtures) {
		const content: ToolResultPresentationContent[] = [{ type: "text", text }];
		const message = toolResult(content, `call-${name}`);
		const owner = createToolResultPresentationOwner(
			{ enabled: true, budgetTokens: BUDGET_TOKENS },
			SESSION_ID,
		)!;
		const presentation = owner.create(content, message.toolCallId)!;
		assert.equal(presentation.version, TOOL_RESULT_PRESENTATION_V2_VERSION, name);
		const v2 = presentation as ToolResultPresentationV2;
		const modelEstimate = estimateToolOutputTokens(v2.modelContent);
		const fullEstimate = estimateToolOutputTokens(content);
		assert.ok(modelEstimate.estimatedTokens <= BUDGET_TOKENS, name);
		assert.ok(modelEstimate.estimatedTokens <= fullEstimate.estimatedTokens * 0.7, name);
		assert.equal(v2.uiContent?.[0], content[0], name);
		assert.equal(flattenContent(reconstruct(v2, owner, [message])), flattenContent(content), name);
		owner.release();
		owner.dispose();
	}
});

test("multiple blocks and images preserve identity and continuation order", () => {
	const imageData = "QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo9PQ==";
	const image = { type: "image" as const, data: imageData, mimeType: "image/png" };
	const content: ToolResultPresentationContent[] = [
		{ type: "text", text: "HEAD ".repeat(512) },
		image,
		{ type: "text", text: "MIDDLE ".repeat(1024) },
		{ type: "text", text: "TAIL ".repeat(512) },
	];
	const message = toolResult(content, "call-image");
	const owner = createToolResultPresentationOwner(
		{ enabled: true, budgetTokens: BUDGET_TOKENS },
		SESSION_ID,
	)!;
	const presentation = owner.create(content, message.toolCallId) as ToolResultPresentationV2;
	assert.equal(presentation.version, 2);
	assert.notEqual(presentation.modelContent, content);
	assert.notEqual(presentation.uiContent, content);
	assert.equal(presentation.uiContent?.[1], image);
	assert.equal((presentation.uiContent?.[1] as typeof image).data, imageData);
	assert.equal(estimateToolOutputTokens(presentation.modelContent).estimatedTokens <= BUDGET_TOKENS, true);
	const restored = reconstruct(presentation, owner, [message]);
	assert.equal(flattenContent(restored), flattenContent(content));
	assert.ok(restored.includes(image), "continuation must reuse the original image block");
	owner.release();
	owner.dispose();
});

test("10 MiB single-line projection is bounded and continuation restores every code unit", () => {
	const text = "0123456789abcdef".repeat((10 * 1024 * 1024) / 16);
	const content: ToolResultPresentationContent[] = [{ type: "text", text }];
	const message = toolResult(content, "call-10mib");
	const owner = createToolResultPresentationOwner(
		{ enabled: true, budgetTokens: 1024 },
		SESSION_ID,
	)!;
	const presentation = owner.create(content, message.toolCallId) as ToolResultPresentationV2;
	assert.equal(presentation.version, 2);
	assert.equal(presentation.uiContent?.[0], content[0]);
	assert.ok(presentation.modelContent.length <= 3);
	assert.ok(estimateToolOutputTokens(presentation.modelContent).estimatedTokens <= 1024);
	assert.ok(presentation.truncation.retainedTextCodeUnits < text.length / 10);
	owner.release();
	owner.dispose();
});

test("same-session resume reproduces projection while stale cursors fail explicitly", () => {
	const content: ToolResultPresentationContent[] = [{ type: "text", text: "resume-source-".repeat(2048) }];
	const message = toolResult(content, "call-resume");
	const first = createToolResultPresentationOwner(
		{ enabled: true, budgetTokens: BUDGET_TOKENS },
		SESSION_ID,
	)!;
	const initial = first.create(content, message.toolCallId) as ToolResultPresentationV2;
	first.release();
	first.dispose();

	const resumed = createToolResultPresentationOwner(
		{ enabled: true, budgetTokens: BUDGET_TOKENS },
		SESSION_ID,
	)!;
	const replay = resumed.create(content, message.toolCallId) as ToolResultPresentationV2;
	assert.deepEqual(replay.modelContent, initial.modelContent);
	assert.deepEqual(replay.truncation, initial.truncation);
	assert.equal(replay.continuation.cursor, initial.continuation.cursor);
	assert.equal(flattenContent(reconstruct(replay, resumed, [message])), flattenContent(content));
	assert.throws(
		() => resumed.readContinuation(initial.continuation.cursor, [], BUDGET_TOKENS),
		(error: unknown) => error instanceof ToolResultContinuationError && error.code === "stale-cursor",
	);
	const otherSession = createToolResultPresentationOwner(
		{ enabled: true, budgetTokens: BUDGET_TOKENS },
		"different-session",
	)!;
	assert.throws(
		() => otherSession.readContinuation(initial.continuation.cursor, [message], BUDGET_TOKENS),
		(error: unknown) => error instanceof ToolResultContinuationError && error.code === "stale-cursor",
	);
	assert.throws(
		() => resumed.readContinuation("not-a-cursor", [message], BUDGET_TOKENS),
		(error: unknown) => error instanceof ToolResultContinuationError && error.code === "invalid-cursor",
	);
	resumed.release();
	resumed.dispose();
	otherSession.dispose();
});

test("provider-neutral projection exposes modelContent only and never mutates legacy content", () => {
	const content: ToolResultPresentationContent[] = [{ type: "text", text: "provider-source-".repeat(2048) }];
	const message = toolResult(content, "call-provider");
	const owner = createToolResultPresentationOwner(
		{ enabled: true, budgetTokens: BUDGET_TOKENS },
		SESSION_ID,
	)!;
	const presentation = owner.create(content, message.toolCallId) as ToolResultPresentationV2;
	owner.release();
	const projected = owner.projectMessagesForModel([message]);
	assert.equal(projected.length, 1);
	assert.notEqual(projected[0], message);
	assert.equal(projected[0]?.role, "toolResult");
	assert.deepEqual(projected[0]?.role === "toolResult" ? projected[0].content : undefined, presentation.modelContent);
	assert.equal(message.content, content);
	assert.equal(message.content[0], content[0]);
	assert.equal("uiContent" in (projected[0] as object), false);
	assert.equal("toolResultPresentation" in (projected[0] as object), false);
	assert.equal(JSON.stringify(projected).includes("provider-source-provider-source-provider-source"), true);
	assert.equal(getToolResultModelContent(presentation, content), presentation.modelContent);
	assert.equal(getToolResultUiContent(presentation, content), presentation.uiContent);
	owner.dispose();

	const noBudgetOwner = createToolResultPresentationOwner({ enabled: true }, SESSION_ID)!;
	const unprojected = [message];
	assert.equal(noBudgetOwner.projectMessagesForModel(unprojected), unprojected);
	assert.equal(unprojected[0], message);
	assert.equal(noBudgetOwner.counters.modelProjectionCalls, 0);
	noBudgetOwner.dispose();
});

test("malformed V2 sidecars conservatively fall back to full legacy content", () => {
	const legacy: ToolResultPresentationContent[] = [{ type: "text", text: "legacy-full" }];
	const malformed = {
		version: 2,
		modelContent: [{ type: "text", text: "partial" }],
		uiContent: legacy,
		continuation: { version: 1 },
		truncation: { version: 1, strategy: "text-head-tail", budgetTokens: 128 },
	};
	assert.equal(getToolResultModelContent(malformed, legacy), legacy);
	assert.equal(getToolResultUiContent(malformed, legacy), legacy);
});
