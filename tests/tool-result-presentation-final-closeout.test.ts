import assert from "node:assert/strict";
import test from "node:test";
import type { ToolResultMessage } from "../packages/ai/src/types.ts";
import {
	createToolResultPresentationCounters,
	createToolResultPresentationOwner,
	getToolResultModelContent,
	ToolResultContinuationError,
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
