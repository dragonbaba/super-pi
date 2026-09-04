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

const SESSION_ID = "phase-5b-b-closeout";
const GRAPHEME_SEGMENTER = new Intl.Segmenter("en", { granularity: "grapheme" });

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

function terminalSequenceEnd(text: string, start: number): number {
	if (text.charCodeAt(start) !== 0x1b) return start + 1;
	if (start + 1 >= text.length) return text.length;
	const kind = text.charCodeAt(start + 1);
	if (kind === 0x5b) {
		for (let index = start + 2; index < text.length; index++) {
			const code = text.charCodeAt(index);
			if (code >= 0x40 && code <= 0x7e) return index + 1;
		}
		return text.length;
	}
	if (kind === 0x5d || kind === 0x5f || kind === 0x50 || kind === 0x5e) {
		for (let index = start + 2; index < text.length; index++) {
			const code = text.charCodeAt(index);
			if (kind === 0x5d && code === 0x07) return index + 1;
			if (code === 0x1b && text.charCodeAt(index + 1) === 0x5c) return index + 2;
		}
		return text.length;
	}
	return Math.min(text.length, start + 2);
}

function isTerminalBoundary(text: string, offset: number): boolean {
	for (let index = 0; index < text.length;) {
		if (text.charCodeAt(index) !== 0x1b) {
			index++;
			continue;
		}
		const end = terminalSequenceEnd(text, index);
		if (offset > index && offset < end) return false;
		index = Math.max(index + 1, end);
	}
	return true;
}

function isGraphemeBoundary(text: string, offset: number): boolean {
	if (offset <= 0 || offset >= text.length) return true;
	const segment = GRAPHEME_SEGMENTER.segment(text).containing(offset);
	return segment?.index === offset;
}

function isSurrogateBoundary(text: string, offset: number): boolean {
	if (offset <= 0 || offset >= text.length) return true;
	const before = text.charCodeAt(offset - 1);
	const after = text.charCodeAt(offset);
	return !(before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff);
}

function textCodeUnits(content: readonly ToolResultPresentationContent[]): number {
	let result = 0;
	for (let index = 0; index < content.length; index++) {
		const block = content[index]!;
		if (block.type === "text") result += block.text.length;
	}
	return result;
}

function assertLegalProjectionAndChunks(text: string, budgetTokens: number, toolCallId: string): void {
	const content: ToolResultPresentationContent[] = [{ type: "text", text }];
	const message = toolResult(content, toolCallId);
	const owner = createToolResultPresentationOwner({ enabled: true, budgetTokens }, SESSION_ID)!;
	const presentation = owner.create(content, toolCallId) as ToolResultPresentationV2;
	assert.equal(presentation.version, 2, toolCallId);
	owner.release();
	const notice = presentation.truncation.noticeBlockIndex;
	let sourceOffset = textCodeUnits(presentation.modelContent.slice(0, notice));
	assert.equal(isTerminalBoundary(text, sourceOffset), true, `${toolCallId}: model head terminal boundary`);
	assert.equal(isGraphemeBoundary(text, sourceOffset), true, `${toolCallId}: model head grapheme boundary`);
	assert.equal(isSurrogateBoundary(text, sourceOffset), true, `${toolCallId}: model head surrogate boundary`);
	let cursor: string | undefined = presentation.continuation.cursor;
	let chunks = 0;
	const continuationBudget = Math.max(budgetTokens, 1024);
	while (cursor) {
		const chunk = owner.readContinuation(cursor, [message], continuationBudget);
		assert.ok(chunk.estimatedTokens <= continuationBudget, `${toolCallId}: chunk budget`);
		const chunkCodeUnits = textCodeUnits(chunk.content);
		assert.equal(text.substring(sourceOffset, sourceOffset + chunkCodeUnits),
			chunk.content.map((block) => block.type === "text" ? block.text : "").join(""), `${toolCallId}: chunk order`);
		sourceOffset += chunkCodeUnits;
		assert.equal(isTerminalBoundary(text, sourceOffset), true, `${toolCallId}: chunk terminal boundary`);
		assert.equal(isGraphemeBoundary(text, sourceOffset), true, `${toolCallId}: chunk grapheme boundary`);
		assert.equal(isSurrogateBoundary(text, sourceOffset), true, `${toolCallId}: chunk surrogate boundary`);
		cursor = chunk.nextCursor;
		chunks++;
		assert.ok(chunks < 1024, `${toolCallId}: bounded continuation progress`);
	}
	const tail = presentation.modelContent.slice(notice + 1);
	assert.equal(text.substring(sourceOffset), tail.map((block) => block.type === "text" ? block.text : "").join(""), `${toolCallId}: exact reconstruction`);
	assert.equal(isTerminalBoundary(text, sourceOffset), true, `${toolCallId}: model tail terminal boundary`);
	assert.equal(isGraphemeBoundary(text, sourceOffset), true, `${toolCallId}: model tail grapheme boundary`);
	assert.equal(isSurrogateBoundary(text, sourceOffset), true, `${toolCallId}: model tail surrogate boundary`);
	owner.dispose();
}

test("ANSI OSC and APC sequences stay atomic at model and continuation boundaries", () => {
	const terminalFixtures = [
		["csi", "\u001b[38;2;123;045;067;1;2;3;4;5;6;7;8;9m"],
		["osc8-bel", "\u001b]8;;https://example.test/long/path?q=123456789\u0007link\u001b]8;;\u0007"],
		["osc8-st", "\u001b]8;;https://example.test/long/path?q=abcdef\u001b\\link\u001b]8;;\u001b\\"],
		["apc", "\u001b_payload-abcdefghijklmnopqrstuvwxyz-0123456789\u001b\\"],
		["incomplete", "\u001b]8;;https://example.test/incomplete-terminal-sequence"],
	] as const;
	for (const [name, sequence] of terminalFixtures) {
		for (const budget of [64, 96, 128, 192]) {
			for (let shift = 0; shift <= sequence.length; shift++) {
				const text = "a".repeat(24 + shift) + sequence + "b".repeat(2048);
				assertLegalProjectionAndChunks(text, budget, `${name}-${budget}-${shift}`);
			}
		}
	}
});

test("extended graphemes stay atomic at model and continuation boundaries", () => {
	const tagEmoji = "\u{1f3f4}\u{e0067}\u{e0062}\u{e0065}\u{e006e}\u{e0067}\u{e007f}";
	const unicodeFixtures = [
		["combining-64", "A" + "\u0301".repeat(64)],
		["combining-256", "A" + "\u0301".repeat(256)],
		["skin-tone", "\u{1f44b}\u{1f3ff}"],
		["long-family", "\u{1f468}\u200d\u{1f469}\u200d\u{1f467}\u200d\u{1f466}".repeat(16)],
		["flag", "\u{1f1fa}\u{1f1f8}"],
		["keycap", "1\ufe0f\u20e3"],
		["tag-emoji", tagEmoji],
		["variation", "\u{2764}\ufe0f"],
		["malformed-high", "\ud800"],
		["malformed-low", "\udc00"],
	] as const;
	for (const [name, grapheme] of unicodeFixtures) {
		for (const budget of [64, 96, 128, 192]) {
			const text = "a".repeat(32) + grapheme + "b".repeat(2048);
			assertLegalProjectionAndChunks(text, budget, `${name}-${budget}`);
		}
	}
});

test("repeated provider projection reuses one session-local source scan", () => {
	const text = "0123456789abcdef".repeat((10 * 1024 * 1024) / 16);
	const content: ToolResultPresentationContent[] = [{ type: "text", text }];
	const message = toolResult(content, "repeat-provider-10mib");
	const counters = createToolResultPresentationCounters();
	const owner = createToolResultPresentationOwner({ enabled: true, budgetTokens: 1024, counters }, SESSION_ID)!;
	owner.create(content, message.toolCallId);
	owner.release();
	assert.equal(counters.fullSourceEstimatorScans, 1);
	assert.equal(counters.sourceDigestConstructions, 1);
	const scansBefore = counters.fullSourceEstimatorScans;
	const digestsBefore = counters.sourceDigestConstructions;
	const hitsBefore = counters.projectionRecordHits;
	const missesBefore = counters.projectionRecordMisses;
	for (let request = 0; request < 20; request++) owner.projectMessagesForModel([message]);
	assert.equal(counters.fullSourceEstimatorScans - scansBefore, 0);
	assert.equal(counters.sourceDigestConstructions - digestsBefore, 0);
	assert.equal(counters.projectionRecordHits - hitsBefore, 20);
	assert.equal(counters.projectionRecordMisses - missesBefore, 0);
	owner.dispose();
});

test("1, 10, and 100 historical large results scan once then stay hot", () => {
	for (const resultCount of [1, 10, 100]) {
		const counters = createToolResultPresentationCounters();
		const owner = createToolResultPresentationOwner({ enabled: true, budgetTokens: 256, counters }, `${SESSION_ID}-${resultCount}`)!;
		const messages: ToolResultMessage[] = [];
		for (let index = 0; index < resultCount; index++) {
			const content: ToolResultPresentationContent[] = [{
				type: "text",
				text: `large-${index}-` + "abcdef0123456789".repeat((64 * 1024) / 16),
			}];
			const message = toolResult(content, `large-history-${index}`);
			messages.push(message);
			owner.create(content, message.toolCallId);
			owner.release();
		}
		assert.equal(counters.fullSourceEstimatorScans, resultCount);
		assert.equal(counters.sourceDigestConstructions, resultCount);
		const scansBefore = counters.fullSourceEstimatorScans;
		const hitsBefore = counters.projectionRecordHits;
		for (let request = 0; request < 10; request++) owner.projectMessagesForModel(messages.slice());
		assert.equal(counters.fullSourceEstimatorScans - scansBefore, 0, `${resultCount} results`);
		assert.equal(counters.projectionRecordHits - hitsBefore, resultCount * 10, `${resultCount} results`);
		owner.dispose();
		assert.equal(counters.projectionRecordEntries, 0);
		assert.equal(counters.retainedProjectionCodeUnits, 0);
	}
});

test("100 continuation chunks reuse source scan and 50k-history lookup", () => {
	const text = "continuation-0123456789abcdef".repeat(Math.ceil((10 * 1024 * 1024) / 29));
	const content: ToolResultPresentationContent[] = [{ type: "text", text }];
	const message = toolResult(content, "continuation-10mib");
	const counters = createToolResultPresentationCounters();
	const owner = createToolResultPresentationOwner({ enabled: true, budgetTokens: 128, counters }, SESSION_ID)!;
	const presentation = owner.create(content, message.toolCallId) as ToolResultPresentationV2;
	owner.release();
	const history: unknown[] = new Array(50_000);
	for (let index = 0; index < history.length - 1; index++) history[index] = { role: "user", marker: index };
	history[history.length - 1] = message;
	const scansBefore = counters.fullSourceEstimatorScans;
	let cursor: string | undefined = presentation.continuation.cursor;
	for (let chunkIndex = 0; chunkIndex < 100; chunkIndex++) {
		assert.ok(cursor);
		const chunk = owner.readContinuation(cursor, history, 128);
		assert.ok(chunk.estimatedTokens <= 128);
		cursor = chunk.nextCursor;
	}
	assert.equal(counters.fullSourceEstimatorScans - scansBefore, 0);
	assert.equal(counters.sourceDigestConstructions, 1);
	assert.ok(counters.continuationSourceLookupProbes <= 50_000);
	assert.equal(counters.continuationSourceRecordHits, 100);
	owner.dispose();
});

test("same-metrics replacement source invalidates an existing cursor", () => {
	const original: ToolResultPresentationContent[] = [{ type: "text", text: "A".repeat(16_384) }];
	const replacement: ToolResultPresentationContent[] = [{ type: "text", text: "B".repeat(16_384) }];
	const originalMessage = toolResult(original, "same-metrics-source");
	const replacementMessage = toolResult(replacement, originalMessage.toolCallId);
	const owner = createToolResultPresentationOwner({ enabled: true, budgetTokens: 128 }, SESSION_ID)!;
	const presentation = owner.create(original, originalMessage.toolCallId) as ToolResultPresentationV2;
	owner.release();
	assert.throws(
		() => owner.readContinuation(presentation.continuation.cursor, [replacementMessage], 128),
		(error: unknown) => error instanceof ToolResultContinuationError && error.code === "stale-cursor",
	);
	owner.dispose();
	const resumed = createToolResultPresentationOwner({ enabled: true, budgetTokens: 128 }, SESSION_ID)!;
	assert.throws(
		() => resumed.readContinuation(presentation.continuation.cursor, [replacementMessage], 128),
		(error: unknown) => error instanceof ToolResultContinuationError && error.code === "stale-cursor",
	);
	const replacementPresentation = resumed.create(replacement, replacementMessage.toolCallId) as ToolResultPresentationV2;
	assert.notEqual(replacementPresentation.continuation.cursor, presentation.continuation.cursor);
	resumed.release();
	resumed.dispose();
	const malformed: ToolResultPresentationContent[] = [{ type: "text", text: "x".repeat(16_384) + "\ud800" }];
	const replacementCharacter: ToolResultPresentationContent[] = [{ type: "text", text: "x".repeat(16_384) + "\ufffd" }];
	const malformedOwner = createToolResultPresentationOwner({ enabled: true, budgetTokens: 128 }, SESSION_ID)!;
	const malformedCursor = (malformedOwner.create(malformed, "malformed-identity") as ToolResultPresentationV2).continuation.cursor;
	malformedOwner.release();
	malformedOwner.dispose();
	const replacementOwner = createToolResultPresentationOwner({ enabled: true, budgetTokens: 128 }, SESSION_ID)!;
	const replacementCursor = (replacementOwner.create(replacementCharacter, "malformed-identity") as ToolResultPresentationV2).continuation.cursor;
	assert.notEqual(replacementCursor, malformedCursor);
	replacementOwner.release();
	replacementOwner.dispose();
});

test("resumed continuation rejects duplicate source identity as ambiguous", () => {
	const content: ToolResultPresentationContent[] = [{ type: "text", text: "duplicate-source-".repeat(4096) }];
	const message = toolResult(content, "duplicate-source");
	const initial = createToolResultPresentationOwner({ enabled: true, budgetTokens: 128 }, SESSION_ID)!;
	const presentation = initial.create(content, message.toolCallId) as ToolResultPresentationV2;
	initial.release();
	initial.dispose();
	const resumed = createToolResultPresentationOwner({ enabled: true, budgetTokens: 128 }, SESSION_ID)!;
	assert.throws(
		() => resumed.readContinuation(presentation.continuation.cursor, [message, message], 128),
		(error: unknown) => error instanceof ToolResultContinuationError && error.code === "stale-cursor",
	);
	resumed.dispose();
});

test("resumed continuation lazily scans 50k history once and then stays indexed", () => {
	const content: ToolResultPresentationContent[] = [{ type: "text", text: "resume-chain-".repeat(80_000) }];
	const message = toolResult(content, "resume-50k-history");
	const initial = createToolResultPresentationOwner({ enabled: true, budgetTokens: 128 }, SESSION_ID)!;
	const presentation = initial.create(content, message.toolCallId) as ToolResultPresentationV2;
	initial.release();
	initial.dispose();
	const history: unknown[] = new Array(50_000);
	for (let index = 0; index < history.length - 1; index++) history[index] = { role: "user", marker: index };
	history[history.length - 1] = message;
	const counters = createToolResultPresentationCounters();
	const resumed = createToolResultPresentationOwner({ enabled: true, budgetTokens: 128, counters }, SESSION_ID)!;
	let cursor: string | undefined = presentation.continuation.cursor;
	for (let chunkIndex = 0; chunkIndex < 100; chunkIndex++) {
		assert.ok(cursor);
		cursor = resumed.readContinuation(cursor, history, 128).nextCursor;
	}
	assert.equal(counters.fullSourceEstimatorScans, 1);
	assert.equal(counters.sourceDigestConstructions, 1);
	assert.ok(counters.continuationSourceLookupProbes <= 50_000);
	assert.equal(counters.projectionRecordMisses, 1);
	assert.equal(counters.continuationSourceRecordHits, 99);
	resumed.dispose();
	assert.equal(counters.projectionRecordEntries, 0);
	assert.equal(counters.retainedProjectionCodeUnits, 0);
});

test("session projection index enforces its hard entry capacity and clear releases references", () => {
	const counters = createToolResultPresentationCounters();
	const owner = createToolResultPresentationOwner({ enabled: true, budgetTokens: 128, counters }, SESSION_ID)!;
	for (let index = 0; index < 129; index++) {
		const content: ToolResultPresentationContent[] = [{ type: "text", text: `record-${index}-` + "x".repeat(4096) }];
		owner.create(content, `record-${index}`);
		owner.release();
	}
	assert.equal(counters.projectionRecordEntries, 128);
	assert.equal(counters.projectionRecordHighWaterMark, 128);
	assert.equal(counters.projectionRecordEvictions, 1);
	assert.ok(counters.retainedProjectionCodeUnits > 0);
	owner.clearProjectionRecords();
	assert.equal(counters.projectionRecordEntries, 0);
	assert.equal(counters.retainedProjectionCodeUnits, 0);
	owner.dispose();
});

test("exact resident touch is link-only, exact-identity, and inert after release", () => {
	const counters = createToolResultPresentationCounters();
	const owner = createToolResultPresentationOwner({ enabled: true, budgetTokens: 128, counters }, SESSION_ID)!;
	const emptyEntries = counters.projectionRecordEntries;
	const emptyCodeUnits = counters.retainedProjectionCodeUnits;
	assert.equal(owner.touchExactResidentProjectionRecord([], "missing"), false);
	assert.equal(counters.projectionRecordEntries, emptyEntries);
	assert.equal(counters.retainedProjectionCodeUnits, emptyCodeUnits);

	const text = "touch-singleton-".repeat(2_000);
	const content: ToolResultPresentationContent[] = [{ type: "text", text }];
	owner.create(content, "touch-singleton");
	owner.release();
	const beforeTouch = {
		fullSourceEstimatorScans: counters.fullSourceEstimatorScans,
		sourceDigestConstructions: counters.sourceDigestConstructions,
		artifactIntegrityScans: counters.artifactIntegrityScans,
		projectionRecordEvictions: counters.projectionRecordEvictions,
		projectionRecordEntries: counters.projectionRecordEntries,
		retainedProjectionCodeUnits: counters.retainedProjectionCodeUnits,
	};
	assert.equal(owner.touchExactResidentProjectionRecord(content, "touch-singleton"), true);
	assert.equal(owner.touchExactResidentProjectionRecord(content, "touch-singleton"), true);
	assert.equal(owner.touchExactResidentProjectionRecord([...content], "touch-singleton"), false);
	assert.equal(
		owner.touchExactResidentProjectionRecord([{ type: "text", text }], "touch-singleton"),
		false,
	);
	assert.equal(owner.touchExactResidentProjectionRecord(content, "missing"), false);
	assert.deepEqual(
		{
			fullSourceEstimatorScans: counters.fullSourceEstimatorScans,
			sourceDigestConstructions: counters.sourceDigestConstructions,
			artifactIntegrityScans: counters.artifactIntegrityScans,
			projectionRecordEvictions: counters.projectionRecordEvictions,
			projectionRecordEntries: counters.projectionRecordEntries,
			retainedProjectionCodeUnits: counters.retainedProjectionCodeUnits,
		},
		beforeTouch,
	);
	owner.clearProjectionRecords();
	assert.equal(owner.touchExactResidentProjectionRecord(content, "touch-singleton"), false);
	owner.create(content, "touch-singleton");
	owner.release();
	owner.dispose();
	assert.equal(owner.touchExactResidentProjectionRecord(content, "touch-singleton"), false);
	assert.equal(counters.projectionRecordEntries, 0);
	assert.equal(counters.retainedProjectionCodeUnits, 0);
});

test("exact resident touch preserves continuation validation and artifact identity", () => {
	const counters = createToolResultPresentationCounters();
	const owner = createToolResultPresentationOwner({ enabled: true, budgetTokens: 128, counters }, SESSION_ID)!;
	const content: ToolResultPresentationContent[] = [{ type: "text", text: "touch-validation-".repeat(10_000) }];
	const message = toolResult(content, "touch-validation");
	const history = [message];
	const presentation = owner.create(content, message.toolCallId) as ToolResultPresentationV2;
	owner.release();
	assert.ok(presentation.artifact);
	const firstChunk = owner.readContinuation(presentation.continuation.cursor, history, 128);
	assert.ok(firstChunk.nextCursor);
	const artifactBefore = owner.readArtifact(presentation.artifact.id, history);
	assert.equal(artifactBefore.descriptor, presentation.artifact);
	assert.equal(artifactBefore.content, content);
	const filler: ToolResultPresentationContent[] = [{ type: "text", text: "touch-filler-".repeat(2_000) }];
	owner.create(filler, "touch-filler");
	owner.release();

	const beforeTouch = {
		fullSourceEstimatorScans: counters.fullSourceEstimatorScans,
		sourceDigestConstructions: counters.sourceDigestConstructions,
		artifactIntegrityScans: counters.artifactIntegrityScans,
		projectionRecordEvictions: counters.projectionRecordEvictions,
		projectionRecordEntries: counters.projectionRecordEntries,
		retainedProjectionCodeUnits: counters.retainedProjectionCodeUnits,
		continuationSourceLookupProbes: counters.continuationSourceLookupProbes,
	};
	assert.equal(owner.touchExactResidentProjectionRecord(content, message.toolCallId), true);
	assert.deepEqual(
		{
			fullSourceEstimatorScans: counters.fullSourceEstimatorScans,
			sourceDigestConstructions: counters.sourceDigestConstructions,
			artifactIntegrityScans: counters.artifactIntegrityScans,
			projectionRecordEvictions: counters.projectionRecordEvictions,
			projectionRecordEntries: counters.projectionRecordEntries,
			retainedProjectionCodeUnits: counters.retainedProjectionCodeUnits,
			continuationSourceLookupProbes: counters.continuationSourceLookupProbes,
		},
		beforeTouch,
	);
	const continuationHitsBefore = counters.activeContinuationRecordHits;
	const secondChunk = owner.readContinuation(firstChunk.nextCursor, history, 128);
	assert.ok(secondChunk.content.length > 0);
	assert.equal(counters.fullSourceEstimatorScans, beforeTouch.fullSourceEstimatorScans);
	assert.equal(counters.continuationSourceLookupProbes, beforeTouch.continuationSourceLookupProbes);
	assert.equal(counters.activeContinuationRecordHits, continuationHitsBefore + 1);
	const artifactHitsBefore = counters.artifactRecordHits;
	const artifactAfter = owner.readArtifact(presentation.artifact.id, history);
	assert.equal(artifactAfter.descriptor, artifactBefore.descriptor);
	assert.equal(artifactAfter.content, content);
	assert.equal(counters.artifactRecordHits, artifactHitsBefore + 1);
	owner.dispose();
});

test("exact resident touch preserves relative order and aligns chronological eviction", () => {
	const counters = createToolResultPresentationCounters();
	const owner = createToolResultPresentationOwner({ enabled: true, budgetTokens: 128, counters }, SESSION_ID)!;
	const contents: ToolResultPresentationContent[][] = [];
	for (let index = 0; index < 128; index++) {
		const content: ToolResultPresentationContent[] = [{ type: "text", text: `touch-order-${index}` }];
		contents.push(content);
		owner.create(content, `touch-order-${index}`);
		owner.release();
	}
	assert.equal(owner.touchExactResidentProjectionRecord(contents[0]!, "touch-order-0"), true);
	assert.equal(owner.touchExactResidentProjectionRecord(contents[64]!, "touch-order-64"), true);
	const evictionsBeforeLive = counters.projectionRecordEvictions;
	const liveOne: ToolResultPresentationContent[] = [{ type: "text", text: "live-one" }];
	const liveTwo: ToolResultPresentationContent[] = [{ type: "text", text: "live-two" }];
	owner.create(liveOne, "touch-live-one");
	owner.release();
	owner.create(liveTwo, "touch-live-two");
	owner.release();
	assert.equal(counters.projectionRecordEvictions - evictionsBeforeLive, 2);
	assert.equal(owner.touchExactResidentProjectionRecord(contents[1]!, "touch-order-1"), false);
	assert.equal(owner.touchExactResidentProjectionRecord(contents[2]!, "touch-order-2"), false);
	assert.equal(owner.touchExactResidentProjectionRecord(contents[3]!, "touch-order-3"), true);
	assert.equal(owner.touchExactResidentProjectionRecord(contents[0]!, "touch-order-0"), true);
	assert.equal(owner.touchExactResidentProjectionRecord(contents[64]!, "touch-order-64"), true);
	owner.dispose();
});

test("selected resident touches preserve spare records and perform only necessary capacity eviction", () => {
	const preserveCounters = createToolResultPresentationCounters();
	const preserveOwner = createToolResultPresentationOwner(
		{ enabled: true, budgetTokens: 128, counters: preserveCounters },
		`${SESSION_ID}-preserve`,
	)!;
	const unrelated: ToolResultPresentationContent[] = [{ type: "text", text: "unrelated" }];
	preserveOwner.create(unrelated, "unrelated");
	preserveOwner.release();
	const selected: ToolResultPresentationContent[][] = [];
	for (let index = 0; index < 127; index++) {
		const content: ToolResultPresentationContent[] = [{ type: "text", text: `selected-${index}` }];
		selected.push(content);
		preserveOwner.create(content, `selected-${index}`);
		preserveOwner.release();
	}
	for (let index = 0; index < selected.length; index++) {
		assert.equal(preserveOwner.touchExactResidentProjectionRecord(selected[index]!, `selected-${index}`), true);
	}
	assert.equal(preserveCounters.projectionRecordEntries, 128);
	assert.equal(preserveCounters.projectionRecordEvictions, 0);
	const live: ToolResultPresentationContent[] = [{ type: "text", text: "selected-live" }];
	preserveOwner.create(live, "selected-live");
	preserveOwner.release();
	assert.equal(preserveCounters.projectionRecordEvictions, 1);
	assert.equal(preserveOwner.touchExactResidentProjectionRecord(unrelated, "unrelated"), false);
	assert.equal(preserveOwner.touchExactResidentProjectionRecord(selected[0]!, "selected-0"), true);
	preserveOwner.dispose();

	const fullCounters = createToolResultPresentationCounters();
	const fullOwner = createToolResultPresentationOwner(
		{ enabled: true, budgetTokens: 128, counters: fullCounters },
		`${SESSION_ID}-full`,
	)!;
	fullOwner.create(unrelated, "full-unrelated");
	fullOwner.release();
	const fullSelected: ToolResultPresentationContent[][] = [];
	for (let index = 0; index < 128; index++) {
		const content: ToolResultPresentationContent[] = [{ type: "text", text: `full-selected-${index}` }];
		fullSelected.push(content);
		fullOwner.create(content, `full-selected-${index}`);
		fullOwner.release();
	}
	assert.equal(fullCounters.projectionRecordEvictions, 1);
	const evictionsBeforeTouches = fullCounters.projectionRecordEvictions;
	for (let index = 0; index < fullSelected.length; index++) {
		assert.equal(fullOwner.touchExactResidentProjectionRecord(fullSelected[index]!, `full-selected-${index}`), true);
	}
	assert.equal(fullCounters.projectionRecordEntries, 128);
	assert.equal(fullCounters.projectionRecordEvictions, evictionsBeforeTouches);
	assert.equal(fullOwner.touchExactResidentProjectionRecord(unrelated, "full-unrelated"), false);
	fullOwner.dispose();
});

test("UI candidate inspection classifies resident and transient sources without admission or reordering", () => {
	const counters = createToolResultPresentationCounters();
	const owner = createToolResultPresentationOwner({ enabled: true, budgetTokens: 128, counters }, SESSION_ID)!;
	const residentV1: ToolResultPresentationContent[] = [{ type: "text", text: "resident-small" }];
	const residentV2: ToolResultPresentationContent[] = [{ type: "text", text: "resident-large-".repeat(2_000) }];
	owner.create(residentV1, "inspect-resident-v1");
	owner.release();
	owner.create(residentV2, "inspect-resident-v2");
	owner.release();
	const before = { ...counters };

	assert.equal(owner.inspectToolResultPresentationForUiCandidate(residentV1, "inspect-resident-v1"), "v1");
	assert.equal(owner.inspectToolResultPresentationForUiCandidate(residentV2, "inspect-resident-v2"), "v2");
	assert.equal(
		owner.inspectToolResultPresentationForUiCandidate(
			[{ type: "text", text: "resident-small" }],
			"inspect-resident-v1",
		),
		"v1",
	);
	assert.equal(
		owner.inspectToolResultPresentationForUiCandidate(
			[{ type: "text", text: "transient-large-".repeat(2_000) }],
			"inspect-transient-v2",
		),
		"v2",
	);
	assert.deepEqual(counters, before, "inspection must not mutate owner, admission, artifact, or provider counters");

	const orderCounters = createToolResultPresentationCounters();
	const orderOwner = createToolResultPresentationOwner(
		{ enabled: true, budgetTokens: 128, counters: orderCounters },
		`${SESSION_ID}-inspect-order`,
	)!;
	const oldest: ToolResultPresentationContent[] = [{ type: "text", text: "oldest" }];
	const hot: ToolResultPresentationContent[] = [{ type: "text", text: "hot" }];
	orderOwner.create(oldest, "inspect-order-oldest");
	orderOwner.release();
	orderOwner.create(hot, "inspect-order-hot");
	orderOwner.release();
	assert.equal(orderOwner.inspectToolResultPresentationForUiCandidate(oldest, "inspect-order-oldest"), "v1");
	assert.equal(
		orderOwner.inspectToolResultPresentationForUiCandidate(
			[{ type: "text", text: "discarded" }],
			"inspect-order-discarded",
		),
		"v1",
	);
	for (let index = 0; index < 126; index++) {
		const filler: ToolResultPresentationContent[] = [{ type: "text", text: `inspect-order-${index}` }];
		orderOwner.create(filler, `inspect-order-${index}`);
		orderOwner.release();
	}
	const evictionsBeforeLive = orderCounters.projectionRecordEvictions;
	const live: ToolResultPresentationContent[] = [{ type: "text", text: "inspect-order-live" }];
	orderOwner.create(live, "inspect-order-live");
	orderOwner.release();
	assert.equal(orderCounters.projectionRecordEvictions, evictionsBeforeLive + 1);
	assert.equal(orderOwner.touchExactResidentProjectionRecord(oldest, "inspect-order-oldest"), false);
	assert.equal(orderOwner.touchExactResidentProjectionRecord(hot, "inspect-order-hot"), true);

	owner.clearProjectionRecords();
	assert.equal(owner.inspectToolResultPresentationForUiCandidate(residentV1, "inspect-resident-v1"), "v1");
	assert.equal(counters.projectionRecordEntries, 0);
	assert.equal(counters.retainedProjectionCodeUnits, 0);
	owner.dispose();
	assert.equal(owner.inspectToolResultPresentationForUiCandidate(residentV1, "inspect-resident-v1"), undefined);
	orderOwner.dispose();
});

test("V2 public validation rejects inconsistent bounded metadata without scanning legacy content", () => {
	const content: ToolResultPresentationContent[] = [{ type: "text", text: "validation-source-".repeat(2048) }];
	const legacy: ToolResultPresentationContent[] = [{ type: "text", text: "legacy-full" }];
	const owner = createToolResultPresentationOwner({ enabled: true, budgetTokens: 128 }, SESSION_ID)!;
	const valid = owner.create(content, "validation") as ToolResultPresentationV2;
	owner.release();
	const validArtifact = valid.artifact;
	assert.ok(validArtifact);
	assert.equal(getToolResultModelContent(valid, legacy), valid.modelContent);
	const preArtifactV2 = { ...valid, artifact: undefined };
	assert.equal(
		getToolResultModelContent(preArtifactV2, legacy),
		valid.modelContent,
		"public V2 producers from before artifact support remain compatible",
	);
	const malformed = [
		{ ...valid, truncation: { ...valid.truncation, originalEstimatedTokens: -1 } },
		{ ...valid, truncation: { ...valid.truncation, modelEstimatedTokens: valid.truncation.budgetTokens + 1 } },
		{ ...valid, truncation: { ...valid.truncation, retainedTextCodeUnits: valid.truncation.retainedTextCodeUnits + 1 } },
		{ ...valid, truncation: { ...valid.truncation, omittedTextCodeUnits: valid.truncation.omittedTextCodeUnits + 1 } },
		{ ...valid, truncation: { ...valid.truncation, noticeBlockIndex: valid.modelContent.length } },
		{ ...valid, artifact: { ...validArtifact, id: `tra1.0000000000000000.${validArtifact.sha256}` } },
		{ ...valid, artifact: { ...validArtifact, sha256: "0".repeat(64) } },
		{ ...valid, artifact: { ...validArtifact, bytes: -1 } },
		{ ...valid, artifact: { ...validArtifact, mediaType: "application/octet-stream" } },
		{
			...valid,
			modelContent: valid.modelContent.map((block, index) =>
				index === valid.truncation.noticeBlockIndex ? { type: "text" as const, text: "wrong cursor notice" } : block,
			),
		},
		{ ...valid, modelContent: valid.uiContent },
	];
	for (const candidate of malformed) assert.equal(getToolResultModelContent(candidate, legacy), legacy);
	owner.dispose();
});
