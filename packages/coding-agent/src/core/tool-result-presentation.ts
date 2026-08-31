import { createHash } from "node:crypto";
import type { ImageContent, Message, TextContent, ToolResultMessage } from "@super-pi/ai/compat";
import { estimateToolOutputTokens, type ToolOutputTokenEstimate } from "./tool-output-budget.ts";

export const TOOL_RESULT_PRESENTATION_VERSION = 1 as const;
export const TOOL_RESULT_PRESENTATION_V2_VERSION = 2 as const;
export const TOOL_RESULT_CONTINUATION_VERSION = 1 as const;

const MAX_PROJECTION_SHRINK_PASSES = 4;
const MAX_CONTINUATION_BLOCKS = 256;
const MAX_PROJECTION_RECORD_ENTRIES = 128;
const MAX_RETAINED_PROJECTION_CODE_UNITS = 128 * 1024 * 1024;
const CURSOR_PREFIX = "tr1.";
const NOTICE_PREFIX = "[Tool result truncated. Continue with cursor ";
const NOTICE_SUFFIX = ".]";
const ESCAPE_CODE = 0x1b;
const GRAPHEME_SEGMENTER = new Intl.Segmenter("en", { granularity: "grapheme" });

export type ToolResultPresentationContent = Readonly<TextContent> | Readonly<ImageContent>;

/** Phase 5B-A behavior. V1 always exposes the complete legacy result to both consumers. */
export interface ToolResultPresentationV1 {
	readonly version: typeof TOOL_RESULT_PRESENTATION_VERSION;
	readonly modelContent: readonly ToolResultPresentationContent[];
	readonly uiContent?: readonly ToolResultPresentationContent[];
	readonly continuation?: never;
	readonly artifact?: never;
	readonly truncation?: never;
}

export interface ToolResultContinuationV1 {
	readonly version: typeof TOOL_RESULT_CONTINUATION_VERSION;
	readonly cursor: string;
}

export interface ToolResultTruncationV1 {
	readonly version: 1;
	readonly strategy: "text-head-tail";
	readonly budgetTokens: number;
	readonly originalEstimatedTokens: number;
	readonly modelEstimatedTokens: number;
	readonly originalTextCodeUnits: number;
	readonly retainedTextCodeUnits: number;
	readonly omittedTextCodeUnits: number;
	readonly headTextCodeUnits: number;
	readonly tailTextCodeUnits: number;
	readonly noticeBlockIndex: number;
	/** Phase 5B-B budgets text only. Provider image-token billing is not included. */
	readonly imageTokensIncluded: false;
}

/** Complete post-extension content remains in legacy content and `uiContent`. */
export interface ToolResultPresentationV2 {
	readonly version: typeof TOOL_RESULT_PRESENTATION_V2_VERSION;
	readonly modelContent: readonly ToolResultPresentationContent[];
	readonly uiContent: readonly ToolResultPresentationContent[];
	readonly continuation: ToolResultContinuationV1;
	readonly truncation: ToolResultTruncationV1;
	readonly artifact?: never;
}

export type ToolResultPresentation = ToolResultPresentationV1 | ToolResultPresentationV2;

export interface ToolResultContinuationChunkV1 {
	readonly version: typeof TOOL_RESULT_CONTINUATION_VERSION;
	readonly content: readonly ToolResultPresentationContent[];
	readonly estimatedTokens: number;
	readonly nextCursor?: string;
	readonly done: boolean;
}

export type ToolResultContinuationErrorCode = "invalid-cursor" | "stale-cursor" | "budget-too-small";

export class ToolResultContinuationError extends Error {
	readonly code: ToolResultContinuationErrorCode;

	constructor(code: ToolResultContinuationErrorCode, message: string) {
		super(message);
		this.name = "ToolResultContinuationError";
		this.code = code;
	}
}

export interface ToolResultPresentationCounters {
	presentationObjectsCreated: number;
	uiOuterArraysCreated: number;
	modelOuterArraysReused: number;
	presentationOuterArrayReferences: number;
	contentBlockReferencesReused: number;
	textStringReferencesReused: number;
	imageDataReferencesReused: number;
	modelProjectionCalls: number;
	modelProjectionArraysCreated: number;
	modelMessageWrappersCreated: number;
	truncatedPresentationsCreated: number;
	continuationChunksCreated: number;
	continuationCursorStringsCreated: number;
	boundedTextStringsCreated: number;
	projectionRecordHits: number;
	projectionRecordMisses: number;
	projectionRecordEntries: number;
	projectionRecordHighWaterMark: number;
	projectionRecordEvictions: number;
	fullSourceEstimatorScans: number;
	continuationSourceLookupProbes: number;
	continuationSourceRecordHits: number;
	sourceFingerprintConstructions: number;
	sourceDigestConstructions: number;
	retainedProjectionCodeUnits: number;
	postImagePolicyEstimatorScans: number;
	postImagePolicyShrinkPasses: number;
	completedDispatchPresentationScopes: number;
	releaseWithoutActiveScope: number;
	activeDispatchPresentationScopes: number;
	dispatchPresentationScopesHighWaterMark: number;
	maximumContentBlocks: number;
	maximumTextCodeUnits: number;
	maximumImageDataCodeUnits: number;
	ownerDisposeCalls: number;
}

export interface ToolResultPresentationOptions {
	enabled?: boolean;
	/** No production default exists. Projection runs only for a positive integer. */
	budgetTokens?: number;
	counters?: ToolResultPresentationCounters;
}

interface ContentPosition {
	blockIndex: number;
	textOffset: number;
}

interface CursorState {
	sourceKey: string;
	sourceDigest: string;
	startBlock: number;
	startOffset: number;
	endBlock: number;
	endOffset: number;
	contentBlocks: number;
	rawUtf8Bytes: number;
	estimatedTokens: number;
}

interface SourceScan {
	estimate: ToolOutputTokenEstimate;
	digest: string;
	textCodeUnits: number;
	imageDataCodeUnits: number;
	retainedCodeUnits: number;
	hasTerminalSequences: boolean;
}

interface ProjectionBuild {
	content: ToolResultPresentationContent[];
	noticeBlockIndex: number;
	start: ContentPosition;
	end: ContentPosition;
	headTextCodeUnits: number;
	tailTextCodeUnits: number;
	cursor: string;
	estimate: ToolOutputTokenEstimate;
	fullEstimate: ToolOutputTokenEstimate;
}

interface SourceMessageLike {
	role: "toolResult";
	toolCallId: string;
	content: readonly ToolResultPresentationContent[];
}

interface ProjectionRecord {
	toolCallId: string;
	sourceKey: string;
	sourceDigest: string;
	sourceContent: readonly ToolResultPresentationContent[];
	sourceScan: SourceScan;
	projection: ProjectionBuild | undefined;
	retainedCodeUnits: number;
	validatedMessages: readonly unknown[] | undefined;
	previous: ProjectionRecord | undefined;
	next: ProjectionRecord | undefined;
}

export function createToolResultPresentationCounters(): ToolResultPresentationCounters {
	return {
		presentationObjectsCreated: 0,
		uiOuterArraysCreated: 0,
		modelOuterArraysReused: 0,
		presentationOuterArrayReferences: 0,
		contentBlockReferencesReused: 0,
		textStringReferencesReused: 0,
		imageDataReferencesReused: 0,
		modelProjectionCalls: 0,
		modelProjectionArraysCreated: 0,
		modelMessageWrappersCreated: 0,
		truncatedPresentationsCreated: 0,
		continuationChunksCreated: 0,
		continuationCursorStringsCreated: 0,
		boundedTextStringsCreated: 0,
		projectionRecordHits: 0,
		projectionRecordMisses: 0,
		projectionRecordEntries: 0,
		projectionRecordHighWaterMark: 0,
		projectionRecordEvictions: 0,
		fullSourceEstimatorScans: 0,
		continuationSourceLookupProbes: 0,
		continuationSourceRecordHits: 0,
		sourceFingerprintConstructions: 0,
		sourceDigestConstructions: 0,
		retainedProjectionCodeUnits: 0,
		postImagePolicyEstimatorScans: 0,
		postImagePolicyShrinkPasses: 0,
		completedDispatchPresentationScopes: 0,
		releaseWithoutActiveScope: 0,
		activeDispatchPresentationScopes: 0,
		dispatchPresentationScopesHighWaterMark: 0,
		maximumContentBlocks: 0,
		maximumTextCodeUnits: 0,
		maximumImageDataCodeUnits: 0,
		ownerDisposeCalls: 0,
	};
}

function isPresentationRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function isToolResultPresentationV1(value: unknown): value is ToolResultPresentationV1 {
	try {
		if (!isPresentationRecord(value)) return false;
		return (
			value.version === TOOL_RESULT_PRESENTATION_VERSION &&
			Array.isArray(value.modelContent) &&
			(value.uiContent === undefined || (Array.isArray(value.uiContent) && value.uiContent !== value.modelContent))
		);
	} catch {
		return false;
	}
}

function isNonnegativeSafeInteger(value: unknown): value is number {
	return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isPositiveSafeInteger(value: unknown): value is number {
	return Number.isSafeInteger(value) && (value as number) > 0;
}

function isToolResultPresentationV2(value: unknown): value is ToolResultPresentationV2 {
	try {
		if (!isPresentationRecord(value)) return false;
		if (
			value.version !== TOOL_RESULT_PRESENTATION_V2_VERSION ||
			!Array.isArray(value.modelContent) ||
			!Array.isArray(value.uiContent) ||
			value.uiContent === value.modelContent ||
			!isPresentationRecord(value.continuation) ||
			!isPresentationRecord(value.truncation)
		) return false;
		const cursor = value.continuation.cursor;
		const truncation = value.truncation;
		if (
			value.continuation.version === TOOL_RESULT_CONTINUATION_VERSION &&
			typeof cursor === "string" &&
			cursor.startsWith(CURSOR_PREFIX) &&
			parseCursor(cursor) !== undefined &&
			truncation.version === 1 &&
			truncation.strategy === "text-head-tail" &&
			isPositiveSafeInteger(truncation.budgetTokens) &&
			isNonnegativeSafeInteger(truncation.originalEstimatedTokens) &&
			isNonnegativeSafeInteger(truncation.modelEstimatedTokens) &&
			isNonnegativeSafeInteger(truncation.originalTextCodeUnits) &&
			isNonnegativeSafeInteger(truncation.retainedTextCodeUnits) &&
			isNonnegativeSafeInteger(truncation.omittedTextCodeUnits) &&
			isNonnegativeSafeInteger(truncation.headTextCodeUnits) &&
			isNonnegativeSafeInteger(truncation.tailTextCodeUnits) &&
			isNonnegativeSafeInteger(truncation.noticeBlockIndex) &&
			truncation.noticeBlockIndex < value.modelContent.length &&
			truncation.imageTokensIncluded === false
		) {
			const notice = value.modelContent[truncation.noticeBlockIndex];
			return (
				truncation.modelEstimatedTokens <= truncation.budgetTokens &&
				truncation.retainedTextCodeUnits === truncation.headTextCodeUnits + truncation.tailTextCodeUnits &&
				truncation.originalTextCodeUnits >= truncation.retainedTextCodeUnits &&
				truncation.omittedTextCodeUnits === truncation.originalTextCodeUnits - truncation.retainedTextCodeUnits &&
				notice?.type === "text" &&
				notice.text === NOTICE_PREFIX + cursor + NOTICE_SUFFIX
			);
		}
		return false;
	} catch {
		return false;
	}
}

export function getToolResultModelContent(
	presentation: unknown,
	legacyContent: readonly ToolResultPresentationContent[],
): readonly ToolResultPresentationContent[] {
	return isToolResultPresentationV1(presentation) || isToolResultPresentationV2(presentation)
		? presentation.modelContent
		: legacyContent;
}

export function getToolResultUiContent(
	presentation: unknown,
	legacyContent: readonly ToolResultPresentationContent[],
): readonly ToolResultPresentationContent[] {
	return isToolResultPresentationV1(presentation) || isToolResultPresentationV2(presentation)
		? (presentation.uiContent ?? presentation.modelContent)
		: legacyContent;
}

function countTextCodeUnits(content: readonly ToolResultPresentationContent[]): number {
	let total = 0;
	for (let index = 0; index < content.length; index++) {
		const block = content[index]!;
		if (block.type === "text") total += block.text.length;
	}
	return total;
}

function terminalSequenceEnd(text: string, start: number): number {
	if (text.charCodeAt(start) !== ESCAPE_CODE) return start + 1;
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
			if (code === ESCAPE_CODE && text.charCodeAt(index + 1) === 0x5c) return index + 2;
		}
		return text.length;
	}
	return Math.min(text.length, start + 2);
}

function safeTerminalPrefixOffset(text: string, requested: number): number {
	const start = text.lastIndexOf("\u001b", requested - 1);
	if (start < 0) return requested;
	const end = terminalSequenceEnd(text, start);
	return requested > start && requested < end ? start : requested;
}

function safeTerminalSuffixOffset(text: string, requested: number): number {
	const start = text.lastIndexOf("\u001b", requested - 1);
	if (start < 0) return requested;
	const end = terminalSequenceEnd(text, start);
	return requested > start && requested < end ? end : requested;
}

function safePrefixOffset(text: string, requested: number, hasTerminalSequences: boolean): number {
	let offset = Math.max(0, Math.min(requested, text.length));
	if (offset === 0 || offset === text.length) return offset;
	if (hasTerminalSequences) offset = safeTerminalPrefixOffset(text, offset);
	if (offset === 0 || offset === text.length) return offset;
	const previous = text.charCodeAt(offset - 1);
	const next = text.charCodeAt(offset);
	if (previous <= 0x7f && next <= 0x7f) return offset;
	const segment = GRAPHEME_SEGMENTER.segment(text).containing(offset);
	return segment && segment.index < offset ? segment.index : offset;
}

function safeSuffixOffset(text: string, requested: number, hasTerminalSequences: boolean): number {
	let offset = Math.max(0, Math.min(requested, text.length));
	if (offset === 0 || offset === text.length) return offset;
	if (hasTerminalSequences) offset = safeTerminalSuffixOffset(text, offset);
	if (offset === 0 || offset === text.length) return offset;
	const previous = text.charCodeAt(offset - 1);
	const next = text.charCodeAt(offset);
	if (previous <= 0x7f && next <= 0x7f) return offset;
	const segment = GRAPHEME_SEGMENTER.segment(text).containing(offset);
	return segment && segment.index < offset ? segment.index + segment.segment.length : offset;
}

function locateHeadEnd(
	content: readonly ToolResultPresentationContent[],
	textCodeUnits: number,
	hasTerminalSequences: boolean,
): ContentPosition {
	let remaining = textCodeUnits;
	for (let index = 0; index < content.length; index++) {
		const block = content[index]!;
		if (block.type !== "text") continue;
		if (remaining < block.text.length) return { blockIndex: index, textOffset: safePrefixOffset(block.text, remaining, hasTerminalSequences) };
		remaining -= block.text.length;
		if (remaining === 0) return { blockIndex: index + 1, textOffset: 0 };
	}
	return { blockIndex: content.length, textOffset: 0 };
}

function locateTailStart(
	content: readonly ToolResultPresentationContent[],
	textCodeUnits: number,
	hasTerminalSequences: boolean,
): ContentPosition {
	let remaining = textCodeUnits;
	for (let index = content.length - 1; index >= 0; index--) {
		const block = content[index]!;
		if (block.type !== "text") continue;
		if (remaining < block.text.length) {
			return { blockIndex: index, textOffset: safeSuffixOffset(block.text, block.text.length - remaining, hasTerminalSequences) };
		}
		remaining -= block.text.length;
		if (remaining === 0) return { blockIndex: index, textOffset: 0 };
	}
	return { blockIndex: 0, textOffset: 0 };
}

function comparePositions(left: ContentPosition, right: ContentPosition): number {
	if (left.blockIndex !== right.blockIndex) return left.blockIndex - right.blockIndex;
	return left.textOffset - right.textOffset;
}

function appendIdentityHash(value: string, state: number, multiplier: number): number {
	let result = state;
	for (let index = 0; index < value.length; index++) {
		const code = value.charCodeAt(index);
		result = Math.imul(result ^ code, multiplier);
	}
	return result >>> 0;
}

function fixedHex(value: number): string {
	return (value >>> 0).toString(16).padStart(8, "0");
}

function createSourceKey(sessionId: string, toolCallId: string, counters: ToolResultPresentationCounters): string {
	counters.sourceFingerprintConstructions++;
	let first = appendIdentityHash(sessionId, 0x811c9dc5, 0x01000193);
	let second = appendIdentityHash(sessionId, 0x9747b28c, 0x5bd1e995);
	first = Math.imul(first ^ 0, 0x01000193) >>> 0;
	second = Math.imul(second ^ 0, 0x5bd1e995) >>> 0;
	first = appendIdentityHash(toolCallId, first, 0x01000193);
	second = appendIdentityHash(toolCallId, second, 0x5bd1e995);
	return fixedHex(first) + fixedHex(second);
}

function scanSource(
	content: readonly ToolResultPresentationContent[],
	counters: ToolResultPresentationCounters,
): SourceScan {
	counters.fullSourceEstimatorScans++;
	const estimate = estimateToolOutputTokens(content);
	const digest = createHash("sha256");
	digest.update("tool-result-source-v1\0");
	let textCodeUnits = 0;
	let imageDataCodeUnits = 0;
	let retainedCodeUnits = 0;
	let hasTerminalSequences = false;
	for (let index = 0; index < content.length; index++) {
		const block = content[index]!;
		if (block.type === "text") {
			digest.update("t").update(block.text.length.toString(36)).update(":").update(block.text, "utf16le");
			textCodeUnits += block.text.length;
			retainedCodeUnits += block.text.length;
			if (!hasTerminalSequences && block.text.indexOf("\u001b") >= 0) hasTerminalSequences = true;
		} else {
			digest.update("i").update(block.mimeType.length.toString(36)).update(":").update(block.mimeType);
			digest.update(block.data.length.toString(36)).update(":").update(block.data);
			imageDataCodeUnits += block.data.length;
			retainedCodeUnits += block.data.length + block.mimeType.length;
		}
	}
	counters.sourceDigestConstructions++;
	return {
		estimate,
		digest: digest.digest("hex").substring(0, 24),
		textCodeUnits,
		imageDataCodeUnits,
		retainedCodeUnits,
		hasTerminalSequences,
	};
}

function createCursor(
	sourceKey: string,
	sourceDigest: string,
	start: ContentPosition,
	end: ContentPosition,
	contentBlocks: number,
	rawUtf8Bytes: number,
	estimatedTokens: number,
	counters: ToolResultPresentationCounters,
): string {
	counters.continuationCursorStringsCreated++;
	return `${CURSOR_PREFIX}${sourceKey}.${sourceDigest}.${start.blockIndex.toString(36)}.${start.textOffset.toString(36)}.${end.blockIndex.toString(36)}.${end.textOffset.toString(36)}.${contentBlocks.toString(36)}.${rawUtf8Bytes.toString(36)}.${estimatedTokens.toString(36)}`;
}

function appendPrefix(
	result: ToolResultPresentationContent[],
	content: readonly ToolResultPresentationContent[],
	end: ContentPosition,
	counters: ToolResultPresentationCounters,
): void {
	for (let index = 0; index < end.blockIndex && index < content.length; index++) result.push(content[index]!);
	if (end.blockIndex >= content.length || end.textOffset <= 0) return;
	const block = content[end.blockIndex];
	if (!block || block.type !== "text") return;
	result.push({ type: "text", text: block.text.substring(0, end.textOffset) });
	counters.boundedTextStringsCreated++;
}

function appendSuffix(
	result: ToolResultPresentationContent[],
	content: readonly ToolResultPresentationContent[],
	start: ContentPosition,
	counters: ToolResultPresentationCounters,
): void {
	let index = start.blockIndex;
	if (index < content.length && start.textOffset > 0) {
		const block = content[index];
		if (block?.type === "text" && start.textOffset < block.text.length) {
			result.push({ type: "text", text: block.text.substring(start.textOffset) });
			counters.boundedTextStringsCreated++;
		}
		index++;
	}
	for (; index < content.length; index++) result.push(content[index]!);
}

function buildProjection(
	content: readonly ToolResultPresentationContent[],
	headTextCodeUnits: number,
	tailTextCodeUnits: number,
	sourceKey: string,
	sourceDigest: string,
	sourceScan: SourceScan,
	counters: ToolResultPresentationCounters,
): ProjectionBuild {
	const start = locateHeadEnd(content, headTextCodeUnits, sourceScan.hasTerminalSequences);
	const end = locateTailStart(content, tailTextCodeUnits, sourceScan.hasTerminalSequences);
	const actualHeadTextCodeUnits = textCodeUnitsBetween(
		content,
		{ blockIndex: 0, textOffset: 0 },
		start,
	);
	const actualTailTextCodeUnits = textCodeUnitsBetween(
		content,
		end,
		{ blockIndex: content.length, textOffset: 0 },
	);
	const cursor = createCursor(
		sourceKey,
		sourceDigest,
		start,
		end,
		content.length,
		sourceScan.estimate.rawUtf8Bytes,
		sourceScan.estimate.estimatedTokens,
		counters,
	);
	const projected: ToolResultPresentationContent[] = [];
	appendPrefix(projected, content, start, counters);
	const noticeBlockIndex = projected.length;
	projected.push({ type: "text", text: NOTICE_PREFIX + cursor + NOTICE_SUFFIX });
	appendSuffix(projected, content, end, counters);
	counters.modelProjectionArraysCreated++;
	return {
		content: projected,
		noticeBlockIndex,
		start,
		end,
		headTextCodeUnits: actualHeadTextCodeUnits,
		tailTextCodeUnits: actualTailTextCodeUnits,
		cursor,
		estimate: estimateToolOutputTokens(projected),
		fullEstimate: sourceScan.estimate,
	};
}

function projectContent(
	content: readonly ToolResultPresentationContent[],
	budgetTokens: number,
	sourceKey: string,
	sourceDigest: string,
	sourceScan: SourceScan,
	counters: ToolResultPresentationCounters,
): ProjectionBuild | undefined {
	counters.modelProjectionCalls++;
	const fullEstimate = sourceScan.estimate;
	if (fullEstimate.estimatedTokens <= budgetTokens) return undefined;
	const totalTextCodeUnits = sourceScan.textCodeUnits;
	if (totalTextCodeUnits === 0) return undefined;
	let retainedTextCodeUnits = Math.floor((totalTextCodeUnits * Math.max(1, budgetTokens - 48)) / Math.max(1, fullEstimate.estimatedTokens));
	retainedTextCodeUnits = Math.max(0, Math.min(retainedTextCodeUnits, totalTextCodeUnits - 1));
	let build: ProjectionBuild | undefined;
	for (let pass = 0; pass < MAX_PROJECTION_SHRINK_PASSES; pass++) {
		const headTextCodeUnits = Math.ceil(retainedTextCodeUnits / 2);
		const tailTextCodeUnits = retainedTextCodeUnits - headTextCodeUnits;
		build = buildProjection(content, headTextCodeUnits, tailTextCodeUnits, sourceKey, sourceDigest, sourceScan, counters);
		if (build.estimate.estimatedTokens <= budgetTokens && comparePositions(build.start, build.end) < 0) return build;
		if (retainedTextCodeUnits === 0) break;
		const next = Math.floor((retainedTextCodeUnits * Math.max(1, budgetTokens - 2)) / build.estimate.estimatedTokens);
		retainedTextCodeUnits = Math.max(0, Math.min(retainedTextCodeUnits - 1, next));
	}
	if (!build || build.headTextCodeUnits !== 0 || build.tailTextCodeUnits !== 0) {
		build = buildProjection(content, 0, 0, sourceKey, sourceDigest, sourceScan, counters);
	}
	if (build.estimate.estimatedTokens > budgetTokens) {
		throw new ToolResultContinuationError("budget-too-small", `Tool-result budget ${budgetTokens} cannot contain the fixed continuation notice.`);
	}
	return build;
}

function parseBase36(value: string, start: number, end: number): number {
	if (start >= end) return -1;
	let result = 0;
	for (let index = start; index < end; index++) {
		const code = value.charCodeAt(index);
		let digit = -1;
		if (code >= 48 && code <= 57) digit = code - 48;
		else if (code >= 97 && code <= 122) digit = code - 87;
		if (digit < 0 || digit >= 36) return -1;
		result = result * 36 + digit;
		if (!Number.isSafeInteger(result)) return -1;
	}
	return result;
}

function isLowerHex(value: string, start: number, end: number, expectedLength: number): boolean {
	if (end - start !== expectedLength) return false;
	for (let index = start; index < end; index++) {
		const code = value.charCodeAt(index);
		if (!((code >= 48 && code <= 57) || (code >= 97 && code <= 102))) return false;
	}
	return true;
}

function parseCursor(cursor: string): CursorState | undefined {
	if (!cursor.startsWith(CURSOR_PREFIX)) return undefined;
	let start = CURSOR_PREFIX.length;
	let end = cursor.indexOf(".", start);
	if (end < 0 || !isLowerHex(cursor, start, end, 16)) return undefined;
	const sourceKey = cursor.substring(start, end);
	start = end + 1;
	end = cursor.indexOf(".", start);
	if (end < 0 || !isLowerHex(cursor, start, end, 24)) return undefined;
	const sourceDigest = cursor.substring(start, end);
	const values = new Array<number>(7);
	for (let field = 0; field < values.length; field++) {
		start = end + 1;
		end = field === values.length - 1 ? cursor.length : cursor.indexOf(".", start);
		if (end < 0) return undefined;
		const parsed = parseBase36(cursor, start, end);
		if (parsed < 0) return undefined;
		values[field] = parsed;
	}
	if (end !== cursor.length) return undefined;
	return {
		sourceKey,
		sourceDigest,
		startBlock: values[0]!,
		startOffset: values[1]!,
		endBlock: values[2]!,
		endOffset: values[3]!,
		contentBlocks: values[4]!,
		rawUtf8Bytes: values[5]!,
		estimatedTokens: values[6]!,
	};
}

function isSourceMessageLike(value: unknown): value is SourceMessageLike {
	if (!value || typeof value !== "object") return false;
	const candidate = value as Partial<SourceMessageLike>;
	return candidate.role === "toolResult" && typeof candidate.toolCallId === "string" && Array.isArray(candidate.content);
}

function isValidPosition(content: readonly ToolResultPresentationContent[], position: ContentPosition): boolean {
	if (position.blockIndex < 0 || position.blockIndex > content.length || position.textOffset < 0) return false;
	if (position.blockIndex === content.length) return position.textOffset === 0;
	if (position.textOffset === 0) return true;
	const block = content[position.blockIndex];
	return block?.type === "text" && position.textOffset <= block.text.length;
}

function textCodeUnitsBetween(content: readonly ToolResultPresentationContent[], start: ContentPosition, end: ContentPosition): number {
	let total = 0;
	for (let index = start.blockIndex; index <= end.blockIndex && index < content.length; index++) {
		const block = content[index]!;
		if (block.type !== "text") continue;
		const from = index === start.blockIndex ? start.textOffset : 0;
		const to = index === end.blockIndex ? end.textOffset : block.text.length;
		if (to > from) total += to - from;
	}
	return total;
}

function advancePosition(
	content: readonly ToolResultPresentationContent[],
	start: ContentPosition,
	end: ContentPosition,
	requestedTextCodeUnits: number,
	hasTerminalSequences: boolean,
): ContentPosition {
	let remaining = Math.max(1, requestedTextCodeUnits);
	let blocks = 0;
	let index = start.blockIndex;
	let offset = start.textOffset;
	while (index < content.length && (index < end.blockIndex || (index === end.blockIndex && offset < end.textOffset))) {
		if (blocks >= MAX_CONTINUATION_BLOCKS) return { blockIndex: index, textOffset: offset };
		const block = content[index]!;
		if (block.type === "image") {
			index++;
			offset = 0;
			blocks++;
			continue;
		}
		const limit = index === end.blockIndex ? end.textOffset : block.text.length;
		const available = Math.max(0, limit - offset);
		if (remaining < available) {
			const requestedOffset = offset + remaining;
			let safeOffset = safePrefixOffset(block.text, requestedOffset, hasTerminalSequences);
			if (safeOffset <= offset) {
				safeOffset = Math.min(limit, safeSuffixOffset(block.text, requestedOffset, hasTerminalSequences));
			}
			return {
				blockIndex: index,
				textOffset: safeOffset,
			};
		}
		remaining -= available;
		if (index === end.blockIndex) return { blockIndex: end.blockIndex, textOffset: end.textOffset };
		index++;
		offset = 0;
		blocks++;
		if (remaining === 0) return { blockIndex: index, textOffset: 0 };
	}
	return { blockIndex: end.blockIndex, textOffset: end.textOffset };
}

function appendRegion(
	result: ToolResultPresentationContent[],
	content: readonly ToolResultPresentationContent[],
	start: ContentPosition,
	end: ContentPosition,
	counters: ToolResultPresentationCounters,
): void {
	for (let index = start.blockIndex; index <= end.blockIndex && index < content.length; index++) {
		const block = content[index]!;
		if (block.type === "image") {
			if (index < end.blockIndex || end.textOffset > 0) result.push(block);
			continue;
		}
		const from = index === start.blockIndex ? start.textOffset : 0;
		const to = index === end.blockIndex ? end.textOffset : block.text.length;
		if (to <= from) continue;
		if (from === 0 && to === block.text.length) result.push(block);
		else {
			result.push({ type: "text", text: block.text.substring(from, to) });
			counters.boundedTextStringsCreated++;
		}
	}
}

function samePosition(left: ContentPosition, right: ContentPosition): boolean {
	return left.blockIndex === right.blockIndex && left.textOffset === right.textOffset;
}

function boundedTextCodeUnits(
	content: readonly ToolResultPresentationContent[],
	start: number,
	end: number,
): number {
	let total = 0;
	for (let index = start; index < end; index++) {
		const block = content[index]!;
		if (block.type === "text") total += block.text.length;
	}
	return total;
}

function appendBoundedHead(
	result: ToolResultPresentationContent[],
	content: readonly ToolResultPresentationContent[],
	endBlock: number,
	requestedTextCodeUnits: number,
	counters: ToolResultPresentationCounters,
): void {
	let remaining = requestedTextCodeUnits;
	for (let index = 0; index < endBlock; index++) {
		const block = content[index]!;
		if (block.type === "image") {
			result.push(block);
			continue;
		}
		if (remaining >= block.text.length) {
			result.push(block);
			remaining -= block.text.length;
			continue;
		}
		if (remaining > 0) {
			const offset = safePrefixOffset(block.text, remaining, block.text.indexOf("\u001b") >= 0);
			if (offset > 0) {
				result.push({ type: "text", text: block.text.substring(0, offset) });
				counters.boundedTextStringsCreated++;
			}
		}
		return;
	}
}

function appendBoundedTail(
	result: ToolResultPresentationContent[],
	content: readonly ToolResultPresentationContent[],
	startBlock: number,
	requestedTextCodeUnits: number,
	counters: ToolResultPresentationCounters,
): void {
	let remaining = requestedTextCodeUnits;
	let firstBlock = content.length;
	let firstOffset = 0;
	for (let index = content.length - 1; index >= startBlock; index--) {
		const block = content[index]!;
		if (block.type === "image") {
			firstBlock = index;
			firstOffset = 0;
			continue;
		}
		if (remaining >= block.text.length) {
			remaining -= block.text.length;
			firstBlock = index;
			firstOffset = 0;
			continue;
		}
		if (remaining > 0) {
			firstBlock = index;
			firstOffset = safeSuffixOffset(
				block.text,
				block.text.length - remaining,
				block.text.indexOf("\u001b") >= 0,
			);
		}
		break;
	}
	if (firstBlock >= content.length) return;
	let index = firstBlock;
	if (firstOffset > 0) {
		const block = content[index];
		if (block?.type === "text" && firstOffset < block.text.length) {
			result.push({ type: "text", text: block.text.substring(firstOffset) });
			counters.boundedTextStringsCreated++;
		}
		index++;
	}
	for (; index < content.length; index++) result.push(content[index]!);
}

function buildPostImagePolicyView(
	content: readonly ToolResultPresentationContent[],
	noticeBlockIndex: number,
	headTextCodeUnits: number,
	tailTextCodeUnits: number,
	counters: ToolResultPresentationCounters,
): ToolResultPresentationContent[] {
	const result: ToolResultPresentationContent[] = [];
	appendBoundedHead(result, content, noticeBlockIndex, headTextCodeUnits, counters);
	result.push(content[noticeBlockIndex]!);
	appendBoundedTail(result, content, noticeBlockIndex + 1, tailTextCodeUnits, counters);
	counters.modelProjectionArraysCreated++;
	return result;
}

export class ToolResultPresentationOwner {
	private accepting = true;
	private readonly budgetTokens: number | undefined;
	private readonly sessionId: string;
	private readonly projectionRecords: Map<string, ProjectionRecord> | undefined;
	private projectionRecordHead: ProjectionRecord | undefined;
	private projectionRecordTail: ProjectionRecord | undefined;
	readonly counters: ToolResultPresentationCounters;

	constructor(options: ToolResultPresentationOptions, sessionId: string) {
		this.counters = options.counters ?? createToolResultPresentationCounters();
		this.sessionId = sessionId;
		if (options.budgetTokens !== undefined) {
			if (!Number.isSafeInteger(options.budgetTokens) || options.budgetTokens <= 0) {
				throw new TypeError("toolResultPresentation.budgetTokens must be a positive safe integer");
			}
			this.budgetTokens = options.budgetTokens;
			this.projectionRecords = new Map<string, ProjectionRecord>();
		}
	}

	private removeProjectionRecord(record: ProjectionRecord, eviction: boolean): void {
		const records = this.projectionRecords;
		if (!records || records.get(record.toolCallId) !== record) return;
		record.previous ? record.previous.next = record.next : this.projectionRecordHead = record.next;
		record.next ? record.next.previous = record.previous : this.projectionRecordTail = record.previous;
		record.previous = undefined;
		record.next = undefined;
		record.validatedMessages = undefined;
		records.delete(record.toolCallId);
		this.counters.projectionRecordEntries--;
		this.counters.retainedProjectionCodeUnits -= record.retainedCodeUnits;
		if (eviction) this.counters.projectionRecordEvictions++;
	}

	private insertProjectionRecord(record: ProjectionRecord): void {
		const records = this.projectionRecords;
		if (!records || record.retainedCodeUnits > MAX_RETAINED_PROJECTION_CODE_UNITS) return;
		while (
			this.projectionRecordHead &&
			(records.size >= MAX_PROJECTION_RECORD_ENTRIES ||
				this.counters.retainedProjectionCodeUnits + record.retainedCodeUnits > MAX_RETAINED_PROJECTION_CODE_UNITS)
		) this.removeProjectionRecord(this.projectionRecordHead, true);
		record.previous = this.projectionRecordTail;
		if (this.projectionRecordTail) this.projectionRecordTail.next = record;
		else this.projectionRecordHead = record;
		this.projectionRecordTail = record;
		records.set(record.toolCallId, record);
		this.counters.projectionRecordEntries++;
		this.counters.projectionRecordHighWaterMark = Math.max(
			this.counters.projectionRecordHighWaterMark,
			this.counters.projectionRecordEntries,
		);
		this.counters.retainedProjectionCodeUnits += record.retainedCodeUnits;
	}

	private getOrCreateProjectionRecord(
		content: readonly ToolResultPresentationContent[],
		toolCallId: string,
	): ProjectionRecord {
		const records = this.projectionRecords;
		const existing = records?.get(toolCallId);
		if (existing?.sourceContent === content) {
			this.counters.projectionRecordHits++;
			return existing;
		}
		if (existing) this.removeProjectionRecord(existing, true);
		this.counters.projectionRecordMisses++;
		const sourceScan = scanSource(content, this.counters);
		const sourceKey = createSourceKey(this.sessionId, toolCallId, this.counters);
		const projection = projectContent(
			content,
			this.budgetTokens!,
			sourceKey,
			sourceScan.digest,
			sourceScan,
			this.counters,
		);
		let retainedCodeUnits = sourceScan.retainedCodeUnits;
		if (projection) retainedCodeUnits += countTextCodeUnits(projection.content);
		const record: ProjectionRecord = {
			toolCallId,
			sourceKey,
			sourceDigest: sourceScan.digest,
			sourceContent: content,
			sourceScan,
			projection,
			retainedCodeUnits,
			validatedMessages: undefined,
			previous: undefined,
			next: undefined,
		};
		this.insertProjectionRecord(record);
		return record;
	}

	private findProjectionRecord(sourceKey: string, sourceDigest: string): ProjectionRecord | undefined {
		let record = this.projectionRecordHead;
		while (record) {
			if (record.sourceKey === sourceKey && record.sourceDigest === sourceDigest) return record;
			record = record.next;
		}
		return undefined;
	}

	private validateContinuationRecord(
		record: ProjectionRecord,
		messages: readonly unknown[],
	): ProjectionRecord {
		if (record.validatedMessages === messages) return record;
		let found = false;
		for (let index = 0; index < messages.length; index++) {
			this.counters.continuationSourceLookupProbes++;
			const candidate = messages[index];
			if (!isSourceMessageLike(candidate) || candidate.toolCallId !== record.toolCallId) continue;
			if (candidate.content !== record.sourceContent || found) {
				throw new ToolResultContinuationError("stale-cursor", "Continuation source identity changed or is ambiguous.");
			}
			found = true;
		}
		if (!found) throw new ToolResultContinuationError("stale-cursor", "Continuation source is not on the active branch.");
		record.validatedMessages = messages;
		return record;
	}

	private resolveContinuationRecord(state: CursorState, messages: readonly unknown[]): ProjectionRecord {
		const cached = this.findProjectionRecord(state.sourceKey, state.sourceDigest);
		if (cached) {
			this.counters.continuationSourceRecordHits++;
			return this.validateContinuationRecord(cached, messages);
		}
		let resolved: ProjectionRecord | undefined;
		let matchedSourceIdentity = false;
		for (let index = 0; index < messages.length; index++) {
			this.counters.continuationSourceLookupProbes++;
			const candidate = messages[index];
			if (!isSourceMessageLike(candidate)) continue;
			if (createSourceKey(this.sessionId, candidate.toolCallId, this.counters) !== state.sourceKey) continue;
			if (matchedSourceIdentity) {
				throw new ToolResultContinuationError("stale-cursor", "Continuation cursor is ambiguous.");
			}
			matchedSourceIdentity = true;
			const record = this.getOrCreateProjectionRecord(candidate.content, candidate.toolCallId);
			if (record.sourceDigest !== state.sourceDigest) continue;
			resolved = record;
		}
		if (!resolved) throw new ToolResultContinuationError("stale-cursor", "Continuation source is not on the active branch.");
		resolved.validatedMessages = messages;
		return resolved;
	}

	clearProjectionRecords(): void {
		const records = this.projectionRecords;
		if (!records || records.size === 0) return;
		let record = this.projectionRecordHead;
		while (record) {
			const next = record.next;
			record.previous = undefined;
			record.next = undefined;
			record.validatedMessages = undefined;
			record = next;
		}
		records.clear();
		this.projectionRecordHead = undefined;
		this.projectionRecordTail = undefined;
		this.counters.projectionRecordEntries = 0;
		this.counters.retainedProjectionCodeUnits = 0;
	}

	create(legacyContent: readonly ToolResultPresentationContent[]): ToolResultPresentationV1 | undefined;
	create(legacyContent: readonly ToolResultPresentationContent[], toolCallId: string): ToolResultPresentation | undefined;
	create(legacyContent: readonly ToolResultPresentationContent[], toolCallId?: string): ToolResultPresentation | undefined {
		if (!this.accepting) return undefined;
		const uiContent = new Array<ToolResultPresentationContent>(legacyContent.length);
		let textCodeUnits = 0;
		let imageDataCodeUnits = 0;
		for (let index = 0; index < legacyContent.length; index++) {
			const block = legacyContent[index]!;
			uiContent[index] = block;
			if (block.type === "text") {
				this.counters.textStringReferencesReused++;
				textCodeUnits += block.text.length;
			} else {
				this.counters.imageDataReferencesReused++;
				imageDataCodeUnits += block.data.length;
			}
		}
		let presentation: ToolResultPresentation;
		if (this.budgetTokens !== undefined) {
			if (!toolCallId) throw new TypeError("A toolCallId is required for budgeted tool-result presentation");
			const record = this.getOrCreateProjectionRecord(legacyContent, toolCallId);
			const projection = record.projection;
			if (projection) {
				const originalTextCodeUnits = record.sourceScan.textCodeUnits;
				const retainedTextCodeUnits = projection.headTextCodeUnits + projection.tailTextCodeUnits;
				presentation = {
					version: TOOL_RESULT_PRESENTATION_V2_VERSION,
					modelContent: projection.content,
					uiContent,
					continuation: { version: TOOL_RESULT_CONTINUATION_VERSION, cursor: projection.cursor },
					truncation: {
						version: 1,
						strategy: "text-head-tail",
						budgetTokens: this.budgetTokens,
						originalEstimatedTokens: projection.fullEstimate.estimatedTokens,
						modelEstimatedTokens: projection.estimate.estimatedTokens,
						originalTextCodeUnits,
						retainedTextCodeUnits,
						omittedTextCodeUnits: originalTextCodeUnits - retainedTextCodeUnits,
						headTextCodeUnits: projection.headTextCodeUnits,
						tailTextCodeUnits: projection.tailTextCodeUnits,
						noticeBlockIndex: projection.noticeBlockIndex,
						imageTokensIncluded: false,
					},
				};
				this.counters.truncatedPresentationsCreated++;
			} else {
				presentation = { version: TOOL_RESULT_PRESENTATION_VERSION, modelContent: legacyContent, uiContent };
				this.counters.modelOuterArraysReused++;
			}
		} else {
			presentation = { version: TOOL_RESULT_PRESENTATION_VERSION, modelContent: legacyContent, uiContent };
			this.counters.modelOuterArraysReused++;
		}
		this.counters.presentationObjectsCreated++;
		this.counters.uiOuterArraysCreated++;
		this.counters.presentationOuterArrayReferences += 2;
		this.counters.contentBlockReferencesReused += legacyContent.length;
		this.counters.maximumContentBlocks = Math.max(this.counters.maximumContentBlocks, legacyContent.length);
		this.counters.maximumTextCodeUnits = Math.max(this.counters.maximumTextCodeUnits, textCodeUnits);
		this.counters.maximumImageDataCodeUnits = Math.max(this.counters.maximumImageDataCodeUnits, imageDataCodeUnits);
		this.counters.activeDispatchPresentationScopes++;
		this.counters.dispatchPresentationScopesHighWaterMark = Math.max(this.counters.dispatchPresentationScopesHighWaterMark, this.counters.activeDispatchPresentationScopes);
		return presentation;
	}

	/** Mutates only the caller-owned outer array; legacy message objects remain untouched. */
	projectMessagesForModel(messages: Message[]): Message[] {
		if (!this.accepting || this.budgetTokens === undefined) return messages;
		for (let index = 0; index < messages.length; index++) {
			const message = messages[index]!;
			if (message.role !== "toolResult") continue;
			const record = this.getOrCreateProjectionRecord(message.content, message.toolCallId);
			const projection = record.projection;
			if (!projection) continue;
			const projected: ToolResultMessage = {
				role: "toolResult",
				toolCallId: message.toolCallId,
				toolName: message.toolName,
				content: projection.content as ToolResultMessage["content"],
				details: message.details,
				usage: message.usage,
				addedToolNames: message.addedToolNames,
				isError: message.isError,
				timestamp: message.timestamp,
			};
			messages[index] = projected;
			this.counters.modelMessageWrappersCreated++;
		}
		return messages;
	}

	/** Rechecks only the already-bounded model view after SDK image replacement. */
	enforcePostImagePolicyBudgets(messages: Message[], beforeImagePolicy?: readonly Message[]): Message[] {
		if (!this.accepting || this.budgetTokens === undefined) return messages;
		for (let index = 0; index < messages.length; index++) {
			const message = messages[index]!;
			if (message.role !== "toolResult") continue;
			if (beforeImagePolicy?.[index] === message) continue;
			const record = this.projectionRecords?.get(message.toolCallId);
			const projectedContent = record ? (record.projection?.content ?? record.sourceContent) : undefined;
			if (!beforeImagePolicy && message.content === projectedContent) continue;
			this.counters.postImagePolicyEstimatorScans++;
			let estimate = estimateToolOutputTokens(message.content);
			if (estimate.estimatedTokens <= this.budgetTokens) continue;
			let noticeBlockIndex = -1;
			for (let blockIndex = 0; blockIndex < message.content.length; blockIndex++) {
				const block = message.content[blockIndex]!;
				if (
					block.type === "text" &&
					block.text.startsWith(NOTICE_PREFIX + CURSOR_PREFIX) &&
					block.text.endsWith(NOTICE_SUFFIX)
				) {
					noticeBlockIndex = blockIndex;
					break;
				}
			}
			if (noticeBlockIndex < 0) {
				throw new ToolResultContinuationError(
					"budget-too-small",
					`Tool-result budget ${this.budgetTokens} cannot contain the blocked-image placeholder view.`,
				);
			}
			const originalHead = boundedTextCodeUnits(message.content, 0, noticeBlockIndex);
			const originalTail = boundedTextCodeUnits(message.content, noticeBlockIndex + 1, message.content.length);
			let retainedTextCodeUnits = originalHead + originalTail;
			let candidate: ToolResultPresentationContent[] | undefined;
			for (let pass = 0; pass < MAX_PROJECTION_SHRINK_PASSES; pass++) {
				const next = Math.max(
					0,
					Math.min(
						retainedTextCodeUnits - 1,
						Math.floor((retainedTextCodeUnits * Math.max(1, this.budgetTokens - 2)) / estimate.estimatedTokens),
					),
				);
				retainedTextCodeUnits = next;
				const head = Math.min(originalHead, Math.ceil(next / 2));
				const tail = Math.min(originalTail, next - head);
				candidate = buildPostImagePolicyView(message.content, noticeBlockIndex, head, tail, this.counters);
				this.counters.postImagePolicyShrinkPasses++;
				this.counters.postImagePolicyEstimatorScans++;
				estimate = estimateToolOutputTokens(candidate);
				if (estimate.estimatedTokens <= this.budgetTokens) break;
			}
			if (!candidate || estimate.estimatedTokens > this.budgetTokens) {
				candidate = buildPostImagePolicyView(message.content, noticeBlockIndex, 0, 0, this.counters);
				this.counters.postImagePolicyShrinkPasses++;
				this.counters.postImagePolicyEstimatorScans++;
				estimate = estimateToolOutputTokens(candidate);
			}
			if (estimate.estimatedTokens > this.budgetTokens) {
				throw new ToolResultContinuationError(
					"budget-too-small",
					`Tool-result budget ${this.budgetTokens} cannot contain the fixed continuation notice.`,
				);
			}
			messages[index] = {
				role: "toolResult",
				toolCallId: message.toolCallId,
				toolName: message.toolName,
				content: candidate as ToolResultMessage["content"],
				details: message.details,
				usage: message.usage,
				addedToolNames: message.addedToolNames,
				isError: message.isError,
				timestamp: message.timestamp,
			};
			this.counters.modelMessageWrappersCreated++;
		}
		return messages;
	}

	readContinuation(cursor: string, messages: readonly unknown[], budgetTokens: number = this.budgetTokens ?? 0): ToolResultContinuationChunkV1 {
		if (!this.accepting) {
			throw new ToolResultContinuationError("stale-cursor", "Tool-result continuation owner is disposed.");
		}
		if (!Number.isSafeInteger(budgetTokens) || budgetTokens <= 0) {
			throw new ToolResultContinuationError("budget-too-small", "Continuation budget must be a positive integer.");
		}
		const state = parseCursor(cursor);
		if (!state) throw new ToolResultContinuationError("invalid-cursor", "Malformed tool-result continuation cursor.");
		const record = this.resolveContinuationRecord(state, messages);
		const sourceContent = record.sourceContent;
		const estimate = record.sourceScan.estimate;
		if (sourceContent.length !== state.contentBlocks || estimate.rawUtf8Bytes !== state.rawUtf8Bytes || estimate.estimatedTokens !== state.estimatedTokens) {
			throw new ToolResultContinuationError("stale-cursor", "Continuation source no longer matches the cursor.");
		}
		const start = { blockIndex: state.startBlock, textOffset: state.startOffset };
		const end = { blockIndex: state.endBlock, textOffset: state.endOffset };
		if (!isValidPosition(sourceContent, start) || !isValidPosition(sourceContent, end) || comparePositions(start, end) >= 0) {
			throw new ToolResultContinuationError("invalid-cursor", "Continuation cursor positions are invalid.");
		}
		const sourceTextCodeUnits = record.sourceScan.textCodeUnits;
		let requestedTextCodeUnits = Math.max(1, Math.floor((sourceTextCodeUnits * budgetTokens) / Math.max(estimate.estimatedTokens, budgetTokens)));
		let chunkEnd = advancePosition(
			sourceContent,
			start,
			end,
			requestedTextCodeUnits,
			record.sourceScan.hasTerminalSequences,
		);
		let chunkContent: ToolResultPresentationContent[] = [];
		let chunkEstimate: ToolOutputTokenEstimate | undefined;
		for (let pass = 0; pass < MAX_PROJECTION_SHRINK_PASSES; pass++) {
			chunkContent = [];
			appendRegion(chunkContent, sourceContent, start, chunkEnd, this.counters);
			chunkEstimate = estimateToolOutputTokens(chunkContent);
			if (chunkEstimate.estimatedTokens <= budgetTokens && comparePositions(start, chunkEnd) < 0) break;
			requestedTextCodeUnits = Math.max(1, Math.min(requestedTextCodeUnits - 1, Math.floor((requestedTextCodeUnits * budgetTokens) / Math.max(1, chunkEstimate.estimatedTokens))));
			chunkEnd = advancePosition(
				sourceContent,
				start,
				end,
				requestedTextCodeUnits,
				record.sourceScan.hasTerminalSequences,
			);
		}
		if (!chunkEstimate || chunkEstimate.estimatedTokens > budgetTokens || comparePositions(start, chunkEnd) >= 0) {
			throw new ToolResultContinuationError("budget-too-small", `Continuation budget ${budgetTokens} cannot make forward progress.`);
		}
		const done = samePosition(chunkEnd, end);
		const nextCursor = done ? undefined : createCursor(
			state.sourceKey,
			state.sourceDigest,
			chunkEnd,
			end,
			state.contentBlocks,
			state.rawUtf8Bytes,
			state.estimatedTokens,
			this.counters,
		);
		this.counters.continuationChunksCreated++;
		return { version: TOOL_RESULT_CONTINUATION_VERSION, content: chunkContent, estimatedTokens: chunkEstimate.estimatedTokens, nextCursor, done };
	}

	release(): void {
		if (this.counters.activeDispatchPresentationScopes === 0) {
			this.counters.releaseWithoutActiveScope++;
			return;
		}
		this.counters.activeDispatchPresentationScopes--;
		this.counters.completedDispatchPresentationScopes++;
	}

	dispose(): void {
		if (!this.accepting) return;
		this.accepting = false;
		this.clearProjectionRecords();
		this.counters.ownerDisposeCalls++;
	}
}

export function createToolResultPresentationOwner(options: ToolResultPresentationOptions | undefined, sessionId = ""): ToolResultPresentationOwner | undefined {
	return options?.enabled === true ? new ToolResultPresentationOwner(options, sessionId) : undefined;
}
