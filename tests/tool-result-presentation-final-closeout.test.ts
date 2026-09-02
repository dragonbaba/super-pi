import assert from "node:assert/strict";
import test from "node:test";
import type { ToolResultMessage } from "../packages/ai/src/types.ts";
import { estimateToolOutputTokens } from "../packages/coding-agent/src/core/tool-output-budget.ts";
import {
	createToolResultPresentationCounters,
	createToolResultPresentationOwner,
	getToolResultModelContent,
	ToolResultContinuationError,
	ToolResultPresentationOwner,
	type ToolResultPresentationContent,
	type ToolResultPresentationV2,
} from "../packages/coding-agent/src/core/tool-result-presentation.ts";

const SESSION_ID = "phase-5b-b-final-closeout";
const TEXT_64_KIB = "0123456789abcdef".repeat((64 * 1024) / 16);

function toolResult(content: ToolResultPresentationContent[], toolCallId: string): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId,
		toolName: "read",
		content: content as ToolResultMessage["content"],
		isError: false,
		timestamp: 1,
	};
}

function textContent(content: readonly ToolResultPresentationContent[]): string {
	let result = "";
	for (let index = 0; index < content.length; index++) {
		const block = content[index]!;
		if (block.type === "text") result += block.text;
	}
	return result;
}

test("provider reads over the entry cap do not cascade resident eviction", () => {
	for (const resultCount of [129, 256]) {
		const counters = createToolResultPresentationCounters();
		const owner = createToolResultPresentationOwner(
			{ enabled: true, budgetTokens: 256, counters },
			`${SESSION_ID}-${resultCount}`,
		)!;
		const messages = new Array<ToolResultMessage>(resultCount);
		for (let index = 0; index < resultCount; index++) {
			const content: ToolResultPresentationContent[] = [{ type: "text", text: `${index}:` + TEXT_64_KIB }];
			messages[index] = toolResult(content, `capacity-${index}`);
			owner.create(content, `capacity-${index}`);
			owner.release();
		}
		const hitsBefore = counters.residentReadHits;
		const missesBefore = counters.providerReadMisses;
		const scansBefore = counters.fullSourceEstimatorScans;
		const evictionsBefore = counters.projectionRecordEvictions;
		for (let request = 0; request < 10; request++) owner.projectMessagesForModel(messages.slice());
		const overflow = resultCount - 128;
		assert.equal(counters.residentReadHits - hitsBefore, 128 * 10, `${resultCount}: resident hits`);
		assert.ok(counters.providerReadMisses - missesBefore <= overflow * 10, `${resultCount}: provider misses`);
		assert.ok(counters.fullSourceEstimatorScans - scansBefore <= overflow * 10, `${resultCount}: scans`);
		assert.equal(counters.projectionRecordEvictions - evictionsBefore, 0, `${resultCount}: read evictions`);
		assert.equal(counters.admissionRejected, overflow * 10, `${resultCount}: rejected admission`);
		assert.equal(counters.transientProjections, overflow * 10, `${resultCount}: transient projection`);
		assert.equal(counters.capacityThrashPrevented, overflow * 10, `${resultCount}: prevented thrash`);
		owner.dispose();
	}
});

test("an evicted continuation scans source and 50k history once then stays active", () => {
	const counters = createToolResultPresentationCounters();
	const owner = createToolResultPresentationOwner({ enabled: true, budgetTokens: 128, counters }, SESSION_ID)!;
	const evictedContent: ToolResultPresentationContent[] = [{ type: "text", text: "evicted-continuation-".repeat(80_000) }];
	const evictedMessage = toolResult(evictedContent, "evicted-continuation");
	const presentation = owner.create(evictedContent, evictedMessage.toolCallId) as ToolResultPresentationV2;
	owner.release();
	for (let index = 0; index < 128; index++) {
		const content: ToolResultPresentationContent[] = [{ type: "text", text: `resident-${index}-` + TEXT_64_KIB }];
		owner.create(content, `resident-${index}`);
		owner.release();
	}
	const history: unknown[] = new Array(50_000);
	for (let index = 0; index < history.length - 1; index++) history[index] = { role: "user", index };
	history[history.length - 1] = evictedMessage;
	const scansBefore = counters.fullSourceEstimatorScans;
	const probesBefore = counters.continuationSourceLookupProbes;
	let cursor: string | undefined = presentation.continuation.cursor;
	for (let chunkIndex = 0; chunkIndex < 100; chunkIndex++) {
		assert.ok(cursor);
		cursor = owner.readContinuation(cursor, history, 128).nextCursor;
	}
	assert.equal(counters.fullSourceEstimatorScans - scansBefore, 1);
	assert.ok(counters.continuationSourceLookupProbes - probesBefore <= 50_000);
	assert.equal(counters.activeContinuationRecordHits, 99);
	owner.dispose();
});

test("terminal boundary work does not repeatedly scan the consumed prefix", () => {
	const text = "\u001b]8;;https://example.test/at-start\u001b\\link\u001b]8;;\u001b\\" + "x".repeat(1024 * 1024);
	const content: ToolResultPresentationContent[] = [{ type: "text", text }];
	const message = toolResult(content, "terminal-linear");
	const counters = createToolResultPresentationCounters();
	const owner = createToolResultPresentationOwner({ enabled: true, budgetTokens: 128, counters }, SESSION_ID)!;
	const presentation = owner.create(content, message.toolCallId) as ToolResultPresentationV2;
	owner.release();
	const boundaryScansBefore = counters.terminalBoundaryCharactersScanned;
	let cursor: string | undefined = presentation.continuation.cursor;
	let chunks = 0;
	while (cursor && chunks < 100) {
		cursor = owner.readContinuation(cursor, [message], 3_000).nextCursor;
		chunks++;
	}
	assert.ok(chunks >= 20, `continuation produced ${chunks} chunks`);
	const scanned = counters.terminalBoundaryCharactersScanned - boundaryScansBefore;
	assert.ok(scanned <= text.length * 2, `terminal boundary scanned ${scanned} for ${text.length} code units`);
	assert.ok(counters.terminalSequenceIntervals > 0);
	owner.dispose();
});

test("continuation shrink converges across dense ANSI to plain-text transitions", () => {
	const ansiUnit = "\u001b[38;2;1;2;3mline\u001b[0m\u001b]8;;https://e.test\u0007url\u001b]8;;\u0007\u001b_payload\u001b\\";
	const content: ToolResultPresentationContent[] = [{
		type: "text",
		text: ansiUnit.repeat(750) + "tail".repeat(512 * 1024),
	}];
	const message = toolResult(content, "dense-ansi-transition");
	const owner = createToolResultPresentationOwner({ enabled: true, budgetTokens: 128 }, SESSION_ID)!;
	const presentation = owner.create(content, message.toolCallId) as ToolResultPresentationV2;
	owner.release();
	let cursor = presentation.continuation.cursor;
	for (let index = 0; index < 12; index++) {
		const chunk = owner.readContinuation(cursor, [message], 3_000);
		assert.ok(chunk.estimatedTokens <= 3_000);
		assert.ok(chunk.content.length > 0);
		assert.ok(chunk.nextCursor);
		cursor = chunk.nextCursor;
	}
	owner.dispose();
});

test("same-array continuation validation checks append and source mutations", () => {
	const content: ToolResultPresentationContent[] = [{ type: "text", text: "validation-source-".repeat(20_000) }];
	const message = toolResult(content, "validation-source");
	const counters = createToolResultPresentationCounters();
	const owner = createToolResultPresentationOwner({ enabled: true, budgetTokens: 128, counters }, SESSION_ID)!;
	const presentation = owner.create(content, message.toolCallId) as ToolResultPresentationV2;
	owner.release();
	const messages: unknown[] = [message];
	let chunk = owner.readContinuation(presentation.continuation.cursor, messages, 128);
	const probesAfterInitial = counters.continuationSourceLookupProbes;
	messages.push({ role: "user", content: "unrelated" });
	chunk = owner.readContinuation(chunk.nextCursor!, messages, 128);
	assert.equal(counters.continuationSourceLookupProbes - probesAfterInitial, 1, "only appended tail is checked");
	messages.push(message);
	assert.throws(
		() => owner.readContinuation(chunk.nextCursor!, messages, 128),
		(error: unknown) => error instanceof ToolResultContinuationError && error.code === "stale-cursor",
	);
	owner.dispose();

	const replacementOwner = createToolResultPresentationOwner({ enabled: true, budgetTokens: 128 }, SESSION_ID)!;
	const replacementPresentation = replacementOwner.create(content, message.toolCallId) as ToolResultPresentationV2;
	replacementOwner.release();
	const replacementMessages: unknown[] = [message, { role: "user", content: "tail" }];
	const first = replacementOwner.readContinuation(replacementPresentation.continuation.cursor, replacementMessages, 128);
	replacementMessages[0] = toolResult([{ type: "text", text: "changed-source---".repeat(20_000) }], message.toolCallId);
	assert.throws(
		() => replacementOwner.readContinuation(first.nextCursor!, replacementMessages, 128),
		(error: unknown) => error instanceof ToolResultContinuationError && error.code === "stale-cursor",
	);
	replacementOwner.dispose();
});

test("new outer arrays revalidate and reordered source arrays fail stale", () => {
	const content: ToolResultPresentationContent[] = [{ type: "text", text: "outer-array-source-".repeat(20_000) }];
	const message = toolResult(content, "outer-array-source");
	const counters = createToolResultPresentationCounters();
	const owner = createToolResultPresentationOwner({ enabled: true, budgetTokens: 128, counters }, SESSION_ID)!;
	const presentation = owner.create(content, message.toolCallId) as ToolResultPresentationV2;
	owner.release();
	const firstMessages: unknown[] = [{ role: "user", content: "head" }, message];
	const first = owner.readContinuation(presentation.continuation.cursor, firstMessages, 128);
	const probesBefore = counters.continuationSourceLookupProbes;
	const equivalentOuter: unknown[] = [{ role: "user", content: "head" }, message];
	const second = owner.readContinuation(first.nextCursor!, equivalentOuter, 128);
	assert.equal(counters.continuationSourceLookupProbes - probesBefore, equivalentOuter.length);
	equivalentOuter.reverse();
	assert.throws(
		() => owner.readContinuation(second.nextCursor!, equivalentOuter, 128),
		(error: unknown) => error instanceof ToolResultContinuationError && error.code === "stale-cursor",
	);
	owner.dispose();
});

test("V2 public validation binds cursor metrics and positions to the complete UI source", () => {
	const content: ToolResultPresentationContent[] = [{ type: "text", text: "shape-source-".repeat(4096) }];
	const legacy: ToolResultPresentationContent[] = [{ type: "text", text: "legacy" }];
	const owner = createToolResultPresentationOwner({ enabled: true, budgetTokens: 128 }, SESSION_ID)!;
	const presentation = owner.create(content, "shape-source") as ToolResultPresentationV2;
	owner.release();
	const cursorFields = presentation.continuation.cursor.split(".");
	function replaceCursorField(index: number, value: string): string {
		const fields = cursorFields.slice();
		fields[index] = value;
		return fields.join(".");
	}
	const malformedCursors = [
		replaceCursorField(7, (content.length + 1).toString(36)),
		replaceCursorField(9, (presentation.truncation.originalEstimatedTokens + 1).toString(36)),
		replaceCursorField(5, (content.length + 1).toString(36)),
	];
	for (const cursor of malformedCursors) {
		const notice = `[Tool result truncated. Continue with cursor ${cursor}.]`;
		const modelContent = presentation.modelContent.map((block, index) =>
			index === presentation.truncation.noticeBlockIndex ? { type: "text" as const, text: notice } : block);
		const malformed = { ...presentation, modelContent, continuation: { ...presentation.continuation, cursor } };
		assert.equal(getToolResultModelContent(malformed, legacy), legacy);
	}
	owner.dispose();
});

test("provider context clones cannot evict the persisted continuation record", () => {
	const content: ToolResultPresentationContent[] = [{ type: "text", text: "context-clone-".repeat(20_000) }];
	const message = toolResult(content, "context-clone");
	const counters = createToolResultPresentationCounters();
	const owner = createToolResultPresentationOwner({ enabled: true, budgetTokens: 128, counters }, SESSION_ID)!;
	const presentation = owner.create(content, message.toolCallId) as ToolResultPresentationV2;
	owner.release();
	const clonedMessages = structuredClone([message]);
	owner.projectMessagesForModel(clonedMessages);
	const chunk = owner.readContinuation(presentation.continuation.cursor, [message], 128);
	assert.ok(chunk.content.length > 0);
	assert.equal(counters.projectionRecordEvictions, 0);
	assert.equal(counters.projectionRecordEntries, 1);
	owner.dispose();
});

test("CRLF remains one grapheme at model and continuation cuts", () => {
	const text = "x".repeat(118) + "\r\n" + "y".repeat(584);
	const content: ToolResultPresentationContent[] = [{ type: "text", text }];
	const message = toolResult(content, "crlf-boundary");
	const owner = createToolResultPresentationOwner({ enabled: true, budgetTokens: 89 }, SESSION_ID)!;
	const presentation = owner.create(content, message.toolCallId) as ToolResultPresentationV2;
	owner.release();
	const notice = presentation.truncation.noticeBlockIndex;
	const head = textContent(presentation.modelContent.slice(0, notice));
	assert.equal(head.endsWith("\r"), false);
	let cursor: string | undefined = presentation.continuation.cursor;
	let previousEndedWithCr = false;
	while (cursor) {
		const chunk = owner.readContinuation(cursor, [message], 1_024);
		const text = textContent(chunk.content);
		assert.equal(previousEndedWithCr && text.startsWith("\n"), false);
		previousEndedWithCr = text.endsWith("\r");
		cursor = chunk.nextCursor;
	}
	owner.dispose();
});

test("the exported owner constructor keeps its one-argument V1 contract", () => {
	const owner = new ToolResultPresentationOwner({ enabled: true });
	const content: ToolResultPresentationContent[] = [{ type: "text", text: "legacy" }];
	assert.equal(owner.create(content)?.version, 1);
	owner.release();
	owner.dispose();
});

test("continuation re-estimates the final bounded shrink candidate", () => {
	const content: ToolResultPresentationContent[] = [
		{ type: "text", text: "a\n".repeat(43) },
		{ type: "text", text: "abcdef0123456789".repeat(30) },
		{ type: "text", text: "z".repeat(1_000) },
	];
	const message = toolResult(content, "final-shrink-estimate");
	const owner = createToolResultPresentationOwner({ enabled: true, budgetTokens: 56 }, SESSION_ID)!;
	const presentation = owner.create(content, message.toolCallId) as ToolResultPresentationV2;
	owner.release();
	const chunk = owner.readContinuation(presentation.continuation.cursor, [message], 88);
	assert.ok(chunk.content.length > 0);
	assert.ok(chunk.estimatedTokens <= 88);
	owner.dispose();
});

test("image-policy fitting widens the provider cursor around every dropped source unit", () => {
	const sourceText = "abcdef0123456789".repeat(1_000);
	const content: ToolResultPresentationContent[] = [
		{ type: "image", data: "aGVsbG8=", mimeType: "image/png" },
		{ type: "text", text: sourceText },
	];
	const message = toolResult(content, "image-policy-cursor");
	const owner = createToolResultPresentationOwner({ enabled: true, budgetTokens: 64 }, SESSION_ID)!;
	owner.create(content, message.toolCallId);
	owner.release();
	const messages = [message];
	owner.projectMessagesForModel(messages, (candidate) => {
		if (candidate.role !== "toolResult") return candidate;
		const replaced = [] as ToolResultMessage["content"];
		for (let index = 0; index < candidate.content.length; index++) {
			const block = candidate.content[index]!;
			replaced.push(block.type === "image" ? { type: "text", text: "Image reading is disabled." } : block);
		}
		return { ...candidate, content: replaced };
	});
	const projected = messages[0]!;
	assert.equal(projected.role, "toolResult");
	assert.ok(estimateToolOutputTokens(projected.content).estimatedTokens <= 64);
	const notice = projected.content.find((block) => block.type === "text" && block.text.startsWith("[Tool result truncated. Continue with cursor "));
	assert.ok(notice?.type === "text");
	const cursor = notice.text.substring("[Tool result truncated. Continue with cursor ".length, notice.text.length - 2);
	let nextCursor: string | undefined = cursor;
	let reconstructed = "";
	while (nextCursor) {
		const chunk = owner.readContinuation(nextCursor, [message], 1_024);
		reconstructed += textContent(chunk.content);
		nextCursor = chunk.nextCursor;
	}
	assert.equal(reconstructed, sourceText);
	owner.dispose();
});

test("oversized empty text-block structure is projected and continued within budget", () => {
	const content: ToolResultPresentationContent[] = new Array(1_000);
	for (let index = 0; index < content.length; index++) content[index] = { type: "text", text: "" };
	assert.ok(estimateToolOutputTokens(content).estimatedTokens > 64);
	const message = toolResult(content, "empty-text-blocks");
	const owner = createToolResultPresentationOwner({ enabled: true, budgetTokens: 64 }, SESSION_ID)!;
	const presentation = owner.create(content, message.toolCallId) as ToolResultPresentationV2;
	owner.release();
	assert.equal(presentation.version, 2);
	assert.ok(estimateToolOutputTokens(presentation.modelContent).estimatedTokens <= 64);
	let cursor: string | undefined = presentation.continuation.cursor;
	let chunks = 0;
	while (cursor) {
		const chunk = owner.readContinuation(cursor, [message], 64);
		assert.ok(chunk.estimatedTokens <= 64);
		cursor = chunk.nextCursor;
		chunks++;
		assert.ok(chunks <= 4);
	}
	assert.equal(chunks, 4);
	owner.dispose();
});
