import { createHash, type Hash } from "node:crypto";
import type { ImageContent, Message, TextContent, ToolResultMessage } from "@super-pi/ai/compat";
import { estimateContextTokensFromParts, estimateMessageTokens, type Tool } from "@super-pi/ai";
import { estimateToolOutputTokens, type ToolOutputTokenEstimate } from "./tool-output-budget.ts";

export const TOOL_RESULT_PRESENTATION_VERSION = 1 as const;
export const TOOL_RESULT_PRESENTATION_V2_VERSION = 2 as const;
export const TOOL_RESULT_CONTINUATION_VERSION = 1 as const;
export const TOOL_RESULT_ARTIFACT_VERSION = 1 as const;
export const TOOL_RESULT_ARTIFACT_MEDIA_TYPE = "application/vnd.super-pi.tool-result-content" as const;

const MAX_PROJECTION_SHRINK_PASSES = 4;
const MAX_CONTINUATION_SHRINK_PASSES = 8;
const MAX_CONTINUATION_BLOCKS = 256;
const MAX_PROJECTION_RECORD_ENTRIES = 128;
const MAX_RETAINED_PROJECTION_CODE_UNITS = 128 * 1024 * 1024;
const MAX_TERMINAL_SEQUENCE_INTERVALS = 4096;
const CURSOR_PREFIX = "tr1.";
const ARTIFACT_PREFIX = "tra1.";
const SOURCE_IDENTITY_PREFIX = "tool-result-source-v1\0";
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
	/** Present on newly-created projected results; optional for pre-artifact V2 producers. */
	readonly artifact?: ToolResultArtifactV1;
	readonly truncation: ToolResultTruncationV1;
}

export type ToolResultPresentation = ToolResultPresentationV1 | ToolResultPresentationV2;

export interface ToolResultContinuationChunkV1 {
	readonly version: typeof TOOL_RESULT_CONTINUATION_VERSION;
	readonly content: readonly ToolResultPresentationContent[];
	readonly estimatedTokens: number;
	readonly nextCursor?: string;
	readonly done: boolean;
}

export interface ToolResultArtifactV1 {
	readonly version: typeof TOOL_RESULT_ARTIFACT_VERSION;
	readonly id: string;
	/** SHA-256 of the allocation-free `tool-result-source-v1` canonical identity stream. */
	readonly sha256: string;
	/** Byte length of that canonical identity stream; no serialized result copy is retained. */
	readonly bytes: number;
	readonly mediaType: typeof TOOL_RESULT_ARTIFACT_MEDIA_TYPE;
}

export interface ToolResultArtifactReadV1 {
	readonly version: typeof TOOL_RESULT_ARTIFACT_VERSION;
	readonly descriptor: ToolResultArtifactV1;
	/** The canonical content owned by the active persisted session branch; no result copy is made. */
	readonly content: readonly ToolResultPresentationContent[];
}

export type ToolResultArtifactErrorCode = "invalid-artifact" | "stale-artifact";

export class ToolResultArtifactError extends Error {
	readonly code: ToolResultArtifactErrorCode;

	constructor(code: ToolResultArtifactErrorCode, message: string) {
		super(message);
		this.name = "ToolResultArtifactError";
		this.code = code;
	}
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
	artifactDescriptorsCreated: number;
	artifactReads: number;
	artifactRecordHits: number;
	artifactSourceLookupProbes: number;
	artifactIntegrityScans: number;
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
	admissionRejected: number;
	transientProjections: number;
	residentReadHits: number;
	providerReadMisses: number;
	activeContinuationRecordHits: number;
	capacityThrashPrevented: number;
	terminalBoundaryCharactersScanned: number;
	terminalBoundaryLookups: number;
	terminalSequenceIntervals: number;
	terminalIndexCapacityFallbacks: number;
	graphemeBoundaryLookups: number;
	completedDispatchPresentationScopes: number;
	releaseWithoutActiveScope: number;
	activeDispatchPresentationScopes: number;
	dispatchPresentationScopesHighWaterMark: number;
	maximumContentBlocks: number;
	maximumTextCodeUnits: number;
	maximumImageDataCodeUnits: number;
	contextualBudgetCalls: number;
	contextualContextScans: number;
	contextualTurnResults: number;
	contextualProjectionPasses: number;
	contextualBudgetFailures: number;
	contextualToolTokensConsumed: number;
	contextualContextTokensConsumed: number;
	activeContextualCoordinators: number;
	contextualCoordinatorsHighWaterMark: number;
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
	sha256: string;
	artifactBytes: number;
	textCodeUnits: number;
	imageDataCodeUnits: number;
	retainedCodeUnits: number;
	hasTerminalSequences: boolean;
	terminalSequenceIntervals: Uint32Array | undefined;
	terminalSequenceIntervalCount: number;
	terminalIndexCapacityFallback: boolean;
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
	artifact: ToolResultArtifactV1 | undefined;
	imagePolicyProjection: ProjectionBuild | undefined;
	retainedCodeUnits: number;
	validatedMessages: WeakRef<object> | undefined;
	validatedMessageCount: number;
	validatedSourceIndex: number;
	previous: ProjectionRecord | undefined;
	next: ProjectionRecord | undefined;
}

type ProjectionRecordAdmission = "write" | "provider" | "continuation";

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
		artifactDescriptorsCreated: 0,
		artifactReads: 0,
		artifactRecordHits: 0,
		artifactSourceLookupProbes: 0,
		artifactIntegrityScans: 0,
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
		admissionRejected: 0,
		transientProjections: 0,
		residentReadHits: 0,
		providerReadMisses: 0,
		activeContinuationRecordHits: 0,
		capacityThrashPrevented: 0,
		terminalBoundaryCharactersScanned: 0,
		terminalBoundaryLookups: 0,
		terminalSequenceIntervals: 0,
		terminalIndexCapacityFallbacks: 0,
		graphemeBoundaryLookups: 0,
		completedDispatchPresentationScopes: 0,
		releaseWithoutActiveScope: 0,
		activeDispatchPresentationScopes: 0,
		dispatchPresentationScopesHighWaterMark: 0,
		maximumContentBlocks: 0,
		maximumTextCodeUnits: 0,
		maximumImageDataCodeUnits: 0,
		contextualBudgetCalls: 0,
		contextualContextScans: 0,
		contextualTurnResults: 0,
		contextualProjectionPasses: 0,
		contextualBudgetFailures: 0,
		contextualToolTokensConsumed: 0,
		contextualContextTokensConsumed: 0,
		activeContextualCoordinators: 0,
		contextualCoordinatorsHighWaterMark: 0,
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

function isToolResultArtifactV1(value: unknown): value is ToolResultArtifactV1 {
	if (!isPresentationRecord(value)) return false;
	const parsed = typeof value.id === "string" ? parseArtifactId(value.id) : undefined;
	return (
		value.version === TOOL_RESULT_ARTIFACT_VERSION &&
		parsed !== undefined &&
		typeof value.sha256 === "string" &&
		parsed.sha256 === value.sha256 &&
		isNonnegativeSafeInteger(value.bytes) &&
		value.mediaType === TOOL_RESULT_ARTIFACT_MEDIA_TYPE
	);
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
			(value.artifact !== undefined && !isToolResultArtifactV1(value.artifact)) ||
			!isPresentationRecord(value.truncation)
		) return false;
		const cursor = value.continuation.cursor;
		const artifact = value.artifact;
		const truncation = value.truncation;
		const cursorState = typeof cursor === "string" ? parseCursor(cursor) : undefined;
		const artifactState = artifact ? parseArtifactId(artifact.id) : undefined;
		if (
			value.continuation.version === TOOL_RESULT_CONTINUATION_VERSION &&
			typeof cursor === "string" &&
			cursor.startsWith(CURSOR_PREFIX) &&
			cursorState !== undefined &&
			(artifact === undefined || (
				artifactState !== undefined &&
				artifactState.sourceKey === cursorState.sourceKey &&
				artifact.sha256.startsWith(cursorState.sourceDigest)
			)) &&
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
			const uiContent = value.uiContent as readonly ToolResultPresentationContent[];
			return (
				truncation.modelEstimatedTokens <= truncation.budgetTokens &&
				cursorState.estimatedTokens === truncation.originalEstimatedTokens &&
				cursorState.contentBlocks === uiContent.length &&
				cursorState.startBlock <= uiContent.length &&
				cursorState.endBlock <= uiContent.length &&
				isValidPosition(uiContent, { blockIndex: cursorState.startBlock, textOffset: cursorState.startOffset }) &&
				isValidPosition(uiContent, { blockIndex: cursorState.endBlock, textOffset: cursorState.endOffset }) &&
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

function terminalSequenceEnd(
	text: string,
	start: number,
	counters?: ToolResultPresentationCounters,
): number {
	if (counters) counters.terminalBoundaryCharactersScanned++;
	if (text.charCodeAt(start) !== ESCAPE_CODE) return start + 1;
	if (start + 1 >= text.length) return text.length;
	if (counters) counters.terminalBoundaryCharactersScanned++;
	const kind = text.charCodeAt(start + 1);
	if (kind === 0x5b) {
		for (let index = start + 2; index < text.length; index++) {
			if (counters) counters.terminalBoundaryCharactersScanned++;
			const code = text.charCodeAt(index);
			if (code >= 0x40 && code <= 0x7e) return index + 1;
		}
		return text.length;
	}
	if (kind === 0x5d || kind === 0x5f || kind === 0x50 || kind === 0x5e) {
		for (let index = start + 2; index < text.length; index++) {
			if (counters) counters.terminalBoundaryCharactersScanned++;
			const code = text.charCodeAt(index);
			if (kind === 0x5d && code === 0x07) return index + 1;
			if (code === ESCAPE_CODE && text.charCodeAt(index + 1) === 0x5c) return index + 2;
		}
		return text.length;
	}
	return Math.min(text.length, start + 2);
}

function containingTerminalSequenceStart(
	text: string,
	requested: number,
	counters: ToolResultPresentationCounters,
): number {
	counters.terminalBoundaryLookups++;
	let index = 0;
	while (index < requested) {
		counters.terminalBoundaryCharactersScanned++;
		if (text.charCodeAt(index) !== ESCAPE_CODE) {
			index++;
			continue;
		}
		const end = terminalSequenceEnd(text, index, counters);
		if (requested > index && requested < end) return index;
		index = Math.max(index + 1, end);
	}
	return -1;
}

function safeTerminalPrefixOffset(text: string, requested: number, counters: ToolResultPresentationCounters): number {
	const start = containingTerminalSequenceStart(text, requested, counters);
	return start < 0 ? requested : start;
}

function safeTerminalSuffixOffset(text: string, requested: number, counters: ToolResultPresentationCounters): number {
	const start = containingTerminalSequenceStart(text, requested, counters);
	return start < 0 ? requested : terminalSequenceEnd(text, start, counters);
}

function indexedTerminalBoundaryOffset(
	sourceScan: SourceScan,
	blockIndex: number,
	requested: number,
	textLength: number,
	prefix: boolean,
	counters: ToolResultPresentationCounters,
): number {
	if (!sourceScan.hasTerminalSequences) return requested;
	counters.terminalBoundaryLookups++;
	if (sourceScan.terminalIndexCapacityFallback) return prefix ? 0 : textLength;
	const intervals = sourceScan.terminalSequenceIntervals;
	if (!intervals || sourceScan.terminalSequenceIntervalCount === 0) return requested;
	let low = 0;
	let high = sourceScan.terminalSequenceIntervalCount;
	while (low < high) {
		const middle = (low + high) >>> 1;
		const intervalOffset = middle * 3;
		const intervalBlock = intervals[intervalOffset]!;
		const intervalStart = intervals[intervalOffset + 1]!;
		if (intervalBlock < blockIndex || (intervalBlock === blockIndex && intervalStart < requested)) low = middle + 1;
		else high = middle;
	}
	if (low === 0) return requested;
	const intervalOffset = (low - 1) * 3;
	if (intervals[intervalOffset] !== blockIndex) return requested;
	const start = intervals[intervalOffset + 1]!;
	const end = intervals[intervalOffset + 2]!;
	return requested > start && requested < end ? (prefix ? start : end) : requested;
}

function safeIndexedPrefixOffset(
	text: string,
	requested: number,
	blockIndex: number,
	sourceScan: SourceScan,
	counters: ToolResultPresentationCounters,
): number {
	let offset = Math.max(0, Math.min(requested, text.length));
	if (offset === 0 || offset === text.length) return offset;
	offset = indexedTerminalBoundaryOffset(sourceScan, blockIndex, offset, text.length, true, counters);
	if (offset === 0 || offset === text.length) return offset;
	const previous = text.charCodeAt(offset - 1);
	const next = text.charCodeAt(offset);
	if (previous <= 0x7f && next <= 0x7f && !(previous === 0x0d && next === 0x0a)) return offset;
	counters.graphemeBoundaryLookups++;
	const segment = GRAPHEME_SEGMENTER.segment(text).containing(offset);
	return segment && segment.index < offset ? segment.index : offset;
}

function safeIndexedSuffixOffset(
	text: string,
	requested: number,
	blockIndex: number,
	sourceScan: SourceScan,
	counters: ToolResultPresentationCounters,
): number {
	let offset = Math.max(0, Math.min(requested, text.length));
	if (offset === 0 || offset === text.length) return offset;
	offset = indexedTerminalBoundaryOffset(sourceScan, blockIndex, offset, text.length, false, counters);
	if (offset === 0 || offset === text.length) return offset;
	const previous = text.charCodeAt(offset - 1);
	const next = text.charCodeAt(offset);
	if (previous <= 0x7f && next <= 0x7f && !(previous === 0x0d && next === 0x0a)) return offset;
	counters.graphemeBoundaryLookups++;
	const segment = GRAPHEME_SEGMENTER.segment(text).containing(offset);
	return segment && segment.index < offset ? segment.index + segment.segment.length : offset;
}

function locateHeadEnd(
	content: readonly ToolResultPresentationContent[],
	textCodeUnits: number,
	sourceScan: SourceScan,
	counters: ToolResultPresentationCounters,
): ContentPosition {
	let remaining = textCodeUnits;
	for (let index = 0; index < content.length; index++) {
		const block = content[index]!;
		if (block.type !== "text") continue;
		if (remaining < block.text.length) return { blockIndex: index, textOffset: safeIndexedPrefixOffset(block.text, remaining, index, sourceScan, counters) };
		remaining -= block.text.length;
		if (remaining === 0) return { blockIndex: index + 1, textOffset: 0 };
	}
	return { blockIndex: content.length, textOffset: 0 };
}

function locateTailStart(
	content: readonly ToolResultPresentationContent[],
	textCodeUnits: number,
	sourceScan: SourceScan,
	counters: ToolResultPresentationCounters,
): ContentPosition {
	let remaining = textCodeUnits;
	for (let index = content.length - 1; index >= 0; index--) {
		const block = content[index]!;
		if (block.type !== "text") continue;
		if (remaining < block.text.length) {
			return { blockIndex: index, textOffset: safeIndexedSuffixOffset(block.text, block.text.length - remaining, index, sourceScan, counters) };
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

function appendSourceIdentityBlock(
	digest: Hash,
	block: ToolResultPresentationContent,
	artifactBytes: number,
): number {
	if (block.type === "text") {
		const textLength = block.text.length.toString(36);
		digest.update("t").update(textLength).update(":").update(block.text, "utf16le");
		return artifactBytes + 1 + textLength.length + 1 + block.text.length * 2;
	}
	const mimeLength = block.mimeType.length.toString(36);
	const dataLength = block.data.length.toString(36);
	digest.update("i").update(mimeLength).update(":").update(block.mimeType);
	digest.update(dataLength).update(":").update(block.data);
	return artifactBytes + 1 + mimeLength.length + 1 + Buffer.byteLength(block.mimeType) +
		dataLength.length + 1 + Buffer.byteLength(block.data);
}

function validateArtifactIdentity(
	content: readonly ToolResultPresentationContent[],
	expectedSha256: string,
	expectedBytes: number,
	counters: ToolResultPresentationCounters,
): boolean {
	counters.artifactIntegrityScans++;
	const digest = createHash("sha256");
	digest.update(SOURCE_IDENTITY_PREFIX);
	let artifactBytes = Buffer.byteLength(SOURCE_IDENTITY_PREFIX);
	try {
		for (let index = 0; index < content.length; index++) {
			artifactBytes = appendSourceIdentityBlock(digest, content[index]!, artifactBytes);
		}
	} catch {
		return false;
	}
	return artifactBytes === expectedBytes && digest.digest("hex") === expectedSha256;
}

function scanSource(
	content: readonly ToolResultPresentationContent[],
	counters: ToolResultPresentationCounters,
): SourceScan {
	counters.fullSourceEstimatorScans++;
	const estimate = estimateToolOutputTokens(content);
	const digest = createHash("sha256");
	digest.update(SOURCE_IDENTITY_PREFIX);
	let artifactBytes = Buffer.byteLength(SOURCE_IDENTITY_PREFIX);
	let textCodeUnits = 0;
	let imageDataCodeUnits = 0;
	let retainedCodeUnits = 0;
	let hasTerminalSequences = false;
	let terminalSequenceIntervals: Uint32Array | undefined;
	let terminalSequenceIntervalCount = 0;
	let terminalIndexCapacityFallback = false;
	for (let index = 0; index < content.length; index++) {
		const block = content[index]!;
		artifactBytes = appendSourceIdentityBlock(digest, block, artifactBytes);
		if (block.type === "text") {
			textCodeUnits += block.text.length;
			retainedCodeUnits += block.text.length;
			counters.terminalBoundaryCharactersScanned += block.text.length;
			let terminalOffset = block.text.indexOf("\u001b");
			if (terminalOffset >= 0) {
				hasTerminalSequences = true;
				while (terminalOffset < block.text.length) {
					const terminalEnd = terminalSequenceEnd(block.text, terminalOffset);
					if (terminalSequenceIntervalCount < MAX_TERMINAL_SEQUENCE_INTERVALS) {
						terminalSequenceIntervals ??= new Uint32Array(MAX_TERMINAL_SEQUENCE_INTERVALS * 3);
						const intervalOffset = terminalSequenceIntervalCount * 3;
						terminalSequenceIntervals[intervalOffset] = index;
						terminalSequenceIntervals[intervalOffset + 1] = terminalOffset;
						terminalSequenceIntervals[intervalOffset + 2] = terminalEnd;
						terminalSequenceIntervalCount++;
						counters.terminalSequenceIntervals++;
					} else if (!terminalIndexCapacityFallback) {
						terminalIndexCapacityFallback = true;
						counters.terminalIndexCapacityFallbacks++;
					}
					terminalOffset = block.text.indexOf("\u001b", Math.max(terminalOffset + 1, terminalEnd));
					if (terminalOffset < 0) break;
				}
			}
		} else {
			imageDataCodeUnits += block.data.length;
			retainedCodeUnits += block.data.length + block.mimeType.length;
		}
	}
	counters.sourceDigestConstructions++;
	const sha256 = digest.digest("hex");
	return {
		estimate,
		digest: sha256.substring(0, 24),
		sha256,
		artifactBytes,
		textCodeUnits,
		imageDataCodeUnits,
		retainedCodeUnits,
		hasTerminalSequences,
		terminalSequenceIntervals,
		terminalSequenceIntervalCount,
		terminalIndexCapacityFallback,
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
	const start = locateHeadEnd(content, headTextCodeUnits, sourceScan, counters);
	const end = locateTailStart(content, tailTextCodeUnits, sourceScan, counters);
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

function buildFullOmissionProjection(
	content: readonly ToolResultPresentationContent[],
	sourceKey: string,
	sourceDigest: string,
	sourceScan: SourceScan,
	counters: ToolResultPresentationCounters,
): ProjectionBuild {
	const start = { blockIndex: 0, textOffset: 0 };
	const end = { blockIndex: content.length, textOffset: 0 };
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
	const projected: ToolResultPresentationContent[] = [{
		type: "text",
		text: NOTICE_PREFIX + cursor + NOTICE_SUFFIX,
	}];
	counters.modelProjectionArraysCreated++;
	return {
		content: projected,
		noticeBlockIndex: 0,
		start,
		end,
		headTextCodeUnits: 0,
		tailTextCodeUnits: 0,
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
	if (totalTextCodeUnits === 0) {
		const build = buildFullOmissionProjection(content, sourceKey, sourceDigest, sourceScan, counters);
		if (build.estimate.estimatedTokens > budgetTokens) {
			throw new ToolResultContinuationError("budget-too-small", `Tool-result budget ${budgetTokens} cannot contain the fixed continuation notice.`);
		}
		return build;
	}
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

function parseArtifactId(id: string): { sourceKey: string; sha256: string } | undefined {
	if (!id.startsWith(ARTIFACT_PREFIX)) return undefined;
	const sourceKeyStart = ARTIFACT_PREFIX.length;
	const sourceKeyEnd = id.indexOf(".", sourceKeyStart);
	if (sourceKeyEnd < 0 || !isLowerHex(id, sourceKeyStart, sourceKeyEnd, 16)) return undefined;
	const sha256Start = sourceKeyEnd + 1;
	if (!isLowerHex(id, sha256Start, id.length, 64)) return undefined;
	return {
		sourceKey: id.substring(sourceKeyStart, sourceKeyEnd),
		sha256: id.substring(sha256Start),
	};
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
	sourceScan: SourceScan,
	counters: ToolResultPresentationCounters,
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
			let safeOffset = safeIndexedPrefixOffset(block.text, requestedOffset, index, sourceScan, counters);
			if (safeOffset <= offset) {
				safeOffset = Math.min(limit, safeIndexedSuffixOffset(block.text, requestedOffset, index, sourceScan, counters));
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

function createArtifactDescriptor(
	sourceKey: string,
	sourceScan: SourceScan,
	counters: ToolResultPresentationCounters,
): ToolResultArtifactV1 {
	counters.artifactDescriptorsCreated++;
	return {
		version: TOOL_RESULT_ARTIFACT_VERSION,
		id: `${ARTIFACT_PREFIX}${sourceKey}.${sourceScan.sha256}`,
		sha256: sourceScan.sha256,
		bytes: sourceScan.artifactBytes,
		mediaType: TOOL_RESULT_ARTIFACT_MEDIA_TYPE,
	};
}

function artifactRetainedCodeUnits(artifact: ToolResultArtifactV1): number {
	return artifact.id.length + artifact.sha256.length + artifact.mediaType.length;
}

export class ToolResultPresentationOwner {
	private accepting = true;
	private readonly budgetTokens: number | undefined;
	private readonly sessionId: string;
	private readonly projectionRecords: Map<string, ProjectionRecord> | undefined;
	private projectionRecordHead: ProjectionRecord | undefined;
	private projectionRecordTail: ProjectionRecord | undefined;
	readonly counters: ToolResultPresentationCounters;

	constructor(options: ToolResultPresentationOptions, sessionId = "") {
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
		record.validatedMessageCount = 0;
		record.validatedSourceIndex = -1;
		records.delete(record.toolCallId);
		this.counters.projectionRecordEntries--;
		this.counters.retainedProjectionCodeUnits -= record.retainedCodeUnits;
		if (eviction) this.counters.projectionRecordEvictions++;
	}

	private insertProjectionRecord(record: ProjectionRecord, allowEviction: boolean): boolean {
		const records = this.projectionRecords;
		if (!records || record.retainedCodeUnits > MAX_RETAINED_PROJECTION_CODE_UNITS) return false;
		if (
			!allowEviction &&
			(records.size >= MAX_PROJECTION_RECORD_ENTRIES ||
				this.counters.retainedProjectionCodeUnits + record.retainedCodeUnits > MAX_RETAINED_PROJECTION_CODE_UNITS)
		) return false;
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
		return true;
	}

	private ensureRecordProjection(record: ProjectionRecord, issueArtifact: boolean): void {
		let addedRetainedCodeUnits = 0;
		if (
			record.projection === undefined &&
			record.sourceScan.estimate.estimatedTokens > this.budgetTokens!
		) {
			const projection = projectContent(
				record.sourceContent,
				this.budgetTokens!,
				record.sourceKey,
				record.sourceDigest,
				record.sourceScan,
				this.counters,
			);
			if (projection) {
				record.projection = projection;
				addedRetainedCodeUnits += countTextCodeUnits(projection.content);
			}
		}
		if (issueArtifact && record.projection && !record.artifact && this.sessionId.length > 0) {
			record.artifact = createArtifactDescriptor(record.sourceKey, record.sourceScan, this.counters);
			addedRetainedCodeUnits += artifactRetainedCodeUnits(record.artifact);
		}
		if (addedRetainedCodeUnits === 0) return;
		const isResident = this.projectionRecords?.get(record.toolCallId) === record;
		const validatedMessages = record.validatedMessages;
		const validatedMessageCount = record.validatedMessageCount;
		const validatedSourceIndex = record.validatedSourceIndex;
		if (isResident) this.removeProjectionRecord(record, false);
		record.retainedCodeUnits += addedRetainedCodeUnits;
		if (isResident) {
			record.validatedMessages = validatedMessages;
			record.validatedMessageCount = validatedMessageCount;
			record.validatedSourceIndex = validatedSourceIndex;
			this.insertProjectionRecord(record, true);
		}
	}

	private createArtifactResolutionRecord(
		content: readonly ToolResultPresentationContent[],
		toolCallId: string,
	): ProjectionRecord {
		this.counters.projectionRecordMisses++;
		const sourceScan = scanSource(content, this.counters);
		const sourceKey = createSourceKey(this.sessionId, toolCallId, this.counters);
		return {
			toolCallId,
			sourceKey,
			sourceDigest: sourceScan.digest,
			sourceContent: content,
			sourceScan,
			projection: undefined,
			artifact: undefined,
			imagePolicyProjection: undefined,
			retainedCodeUnits: sourceScan.retainedCodeUnits,
			validatedMessages: undefined,
			validatedMessageCount: 0,
			validatedSourceIndex: -1,
			previous: undefined,
			next: undefined,
		};
	}

	private getOrCreateProjectionRecord(
		content: readonly ToolResultPresentationContent[],
		toolCallId: string,
		admission: ProjectionRecordAdmission = "write",
	): ProjectionRecord {
		const records = this.projectionRecords;
		const existing = records?.get(toolCallId);
		if (existing?.sourceContent === content) {
			const staleArtifactOnlyRecord =
				existing.projection === undefined &&
				existing.artifact !== undefined &&
				!validateArtifactIdentity(
					existing.sourceContent,
					existing.sourceScan.sha256,
					existing.sourceScan.artifactBytes,
					this.counters,
				);
			if (staleArtifactOnlyRecord) {
				this.removeProjectionRecord(existing, true);
			} else {
				this.ensureRecordProjection(existing, admission === "write");
				this.counters.projectionRecordHits++;
				return existing;
			}
		}
		const sourceScan = scanSource(content, this.counters);
		if (
			existing &&
			admission === "provider" &&
			existing.sourceScan.sha256 === sourceScan.sha256 &&
			existing.sourceContent.length === content.length &&
			existing.sourceScan.estimate.rawUtf8Bytes === sourceScan.estimate.rawUtf8Bytes &&
			existing.sourceScan.estimate.estimatedTokens === sourceScan.estimate.estimatedTokens
		) {
			this.ensureRecordProjection(existing, false);
			this.counters.projectionRecordHits++;
			return existing;
		}
		this.counters.projectionRecordMisses++;
		const sourceKey = createSourceKey(this.sessionId, toolCallId, this.counters);
		const projection = projectContent(
			content,
			this.budgetTokens!,
			sourceKey,
			sourceScan.digest,
			sourceScan,
			this.counters,
		);
		const artifact = projection && admission === "write" && this.sessionId.length > 0
			? createArtifactDescriptor(sourceKey, sourceScan, this.counters)
			: undefined;
		let retainedCodeUnits = sourceScan.retainedCodeUnits;
		if (projection) retainedCodeUnits += countTextCodeUnits(projection.content);
		if (artifact) retainedCodeUnits += artifactRetainedCodeUnits(artifact);
		const record: ProjectionRecord = {
			toolCallId,
			sourceKey,
			sourceDigest: sourceScan.digest,
			sourceContent: content,
			sourceScan,
			projection,
			artifact,
			imagePolicyProjection: undefined,
			retainedCodeUnits,
			validatedMessages: undefined,
			validatedMessageCount: 0,
			validatedSourceIndex: -1,
			previous: undefined,
			next: undefined,
		};
		if (admission === "provider") {
			const capacityWouldEvict = !!records && (
				records.size >= MAX_PROJECTION_RECORD_ENTRIES ||
				this.counters.retainedProjectionCodeUnits + record.retainedCodeUnits > MAX_RETAINED_PROJECTION_CODE_UNITS
			);
			this.counters.admissionRejected++;
			this.counters.transientProjections++;
			if (capacityWouldEvict) this.counters.capacityThrashPrevented++;
			return record;
		}
		if (admission === "continuation") return record;
		if (existing) this.removeProjectionRecord(existing, true);
		this.insertProjectionRecord(record, true);
		return record;
	}

	private bindValidatedContinuationRecord(record: ProjectionRecord): void {
		const records = this.projectionRecords;
		if (!records || records.get(record.toolCallId) === record) return;
		if (record.retainedCodeUnits > MAX_RETAINED_PROJECTION_CODE_UNITS) return;
		const existing = records.get(record.toolCallId);
		if (existing) this.removeProjectionRecord(existing, true);
		this.insertProjectionRecord(record, true);
	}

	private findProjectionRecord(sourceKey: string, sourceDigest: string): ProjectionRecord | undefined {
		let record = this.projectionRecordHead;
		while (record) {
			if (record.sourceKey === sourceKey && record.sourceDigest === sourceDigest) return record;
			record = record.next;
		}
		return undefined;
	}

	private findArtifactRecord(sourceKey: string, sha256: string): ProjectionRecord | undefined {
		let matched: ProjectionRecord | undefined;
		let record = this.projectionRecordHead;
		while (record) {
			if (record.sourceKey === sourceKey && record.sourceScan.sha256 === sha256) {
				if (matched) {
					throw new ToolResultArtifactError("stale-artifact", "Tool-result artifact identity is ambiguous.");
				}
				matched = record;
			}
			record = record.next;
		}
		return matched;
	}

	private validateContinuationRecord(
		record: ProjectionRecord,
		messages: readonly unknown[],
	): ProjectionRecord {
		if (record.validatedMessages?.deref() === messages) {
			const source = messages[record.validatedSourceIndex];
			if (!isSourceMessageLike(source) || source.toolCallId !== record.toolCallId || source.content !== record.sourceContent) {
				throw new ToolResultContinuationError("stale-cursor", "Continuation source identity changed or moved.");
			}
			if (messages.length === record.validatedMessageCount) return record;
			if (messages.length > record.validatedMessageCount) {
				for (let index = record.validatedMessageCount; index < messages.length; index++) {
					this.counters.continuationSourceLookupProbes++;
					const candidate = messages[index];
					if (isSourceMessageLike(candidate) && candidate.toolCallId === record.toolCallId) {
						throw new ToolResultContinuationError("stale-cursor", "Continuation source identity is duplicated.");
					}
				}
				record.validatedMessageCount = messages.length;
				return record;
			}
		}
		let found = false;
		let sourceIndex = -1;
		for (let index = 0; index < messages.length; index++) {
			this.counters.continuationSourceLookupProbes++;
			const candidate = messages[index];
			if (!isSourceMessageLike(candidate) || candidate.toolCallId !== record.toolCallId) continue;
			if (candidate.content !== record.sourceContent || found) {
				throw new ToolResultContinuationError("stale-cursor", "Continuation source identity changed or is ambiguous.");
			}
			found = true;
			sourceIndex = index;
		}
		if (!found) throw new ToolResultContinuationError("stale-cursor", "Continuation source is not on the active branch.");
		record.validatedMessages = new WeakRef(messages as object);
		record.validatedMessageCount = messages.length;
		record.validatedSourceIndex = sourceIndex;
		return record;
	}

	private resolveContinuationRecord(state: CursorState, messages: readonly unknown[]): ProjectionRecord {
		const cached = this.findProjectionRecord(state.sourceKey, state.sourceDigest);
		if (cached) {
			this.counters.continuationSourceRecordHits++;
			this.counters.activeContinuationRecordHits++;
			return this.validateContinuationRecord(cached, messages);
		}
		let resolved: ProjectionRecord | undefined;
		let resolvedIndex = -1;
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
			const record = this.getOrCreateProjectionRecord(candidate.content, candidate.toolCallId, "continuation");
			if (record.sourceDigest !== state.sourceDigest) continue;
			resolved = record;
			resolvedIndex = index;
		}
		if (!resolved) throw new ToolResultContinuationError("stale-cursor", "Continuation source is not on the active branch.");
		resolved.validatedMessages = new WeakRef(messages as object);
		resolved.validatedMessageCount = messages.length;
		resolved.validatedSourceIndex = resolvedIndex;
		return resolved;
	}

	private validateArtifactRecord(record: ProjectionRecord, messages: readonly unknown[]): ProjectionRecord {
		try {
			const validated = this.validateContinuationRecord(record, messages);
			if (!validateArtifactIdentity(
				validated.sourceContent,
				validated.sourceScan.sha256,
				validated.sourceScan.artifactBytes,
				this.counters,
			)) {
				throw new ToolResultArtifactError("stale-artifact", "Tool-result artifact content no longer matches its digest.");
			}
			return validated;
		} catch (error) {
			if (error instanceof ToolResultArtifactError) throw error;
			if (error instanceof ToolResultContinuationError) {
				throw new ToolResultArtifactError("stale-artifact", "Tool-result artifact source is no longer uniquely active.");
			}
			throw error;
		}
	}

	private resolveArtifactRecord(
		state: { sourceKey: string; sha256: string },
		messages: readonly unknown[],
	): ProjectionRecord {
		const cached = this.findArtifactRecord(state.sourceKey, state.sha256);
		if (cached) {
			this.counters.artifactRecordHits++;
			return this.validateArtifactRecord(cached, messages);
		}
		let resolved: ProjectionRecord | undefined;
		let resolvedIndex = -1;
		let matchedSourceIdentity = false;
		for (let index = 0; index < messages.length; index++) {
			this.counters.artifactSourceLookupProbes++;
			const candidate = messages[index];
			if (!isSourceMessageLike(candidate)) continue;
			if (createSourceKey(this.sessionId, candidate.toolCallId, this.counters) !== state.sourceKey) continue;
			if (matchedSourceIdentity) {
				throw new ToolResultArtifactError("stale-artifact", "Tool-result artifact identity is ambiguous.");
			}
			matchedSourceIdentity = true;
			const record = this.createArtifactResolutionRecord(candidate.content, candidate.toolCallId);
			if (record.sourceScan.sha256 !== state.sha256) continue;
			resolved = record;
			resolvedIndex = index;
		}
		if (!resolved) {
			throw new ToolResultArtifactError("stale-artifact", "Tool-result artifact source is not on the active branch.");
		}
		resolved.validatedMessages = new WeakRef(messages as object);
		resolved.validatedMessageCount = messages.length;
		resolved.validatedSourceIndex = resolvedIndex;
		return resolved;
	}

	private ensureArtifactDescriptor(record: ProjectionRecord): ToolResultArtifactV1 {
		if (record.artifact) return record.artifact;
		const artifact = createArtifactDescriptor(record.sourceKey, record.sourceScan, this.counters);
		const retainedCodeUnits = artifactRetainedCodeUnits(artifact);
		const isResident = this.projectionRecords?.get(record.toolCallId) === record;
		if (
			isResident &&
			this.counters.retainedProjectionCodeUnits + retainedCodeUnits > MAX_RETAINED_PROJECTION_CODE_UNITS
		) {
			this.removeProjectionRecord(record, true);
		} else if (isResident) {
			this.counters.retainedProjectionCodeUnits += retainedCodeUnits;
		}
		record.artifact = artifact;
		record.retainedCodeUnits += retainedCodeUnits;
		return artifact;
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
			record.validatedMessageCount = 0;
			record.validatedSourceIndex = -1;
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
				const artifact = record.artifact;
				const originalTextCodeUnits = record.sourceScan.textCodeUnits;
				const retainedTextCodeUnits = projection.headTextCodeUnits + projection.tailTextCodeUnits;
				presentation = {
					version: TOOL_RESULT_PRESENTATION_V2_VERSION,
					modelContent: projection.content,
					uiContent,
					continuation: { version: TOOL_RESULT_CONTINUATION_VERSION, cursor: projection.cursor },
					artifact,
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

	private getImagePolicyProjection(record: ProjectionRecord, budgetTokens = this.budgetTokens!): ProjectionBuild {
		let projection = record.imagePolicyProjection;
		if (!projection) {
			projection = buildFullOmissionProjection(
				record.sourceContent,
				record.sourceKey,
				record.sourceDigest,
				record.sourceScan,
				this.counters,
			);
		}
		if (projection.estimate.estimatedTokens > budgetTokens) {
			throw new ToolResultContinuationError(
				"budget-too-small",
				`Tool-result budget ${budgetTokens} cannot contain the fixed continuation notice.`,
			);
		}
		const records = this.projectionRecords;
		const retainedCodeUnits = countTextCodeUnits(projection.content);
		if (
			!record.imagePolicyProjection &&
			records?.get(record.toolCallId) === record &&
			this.counters.retainedProjectionCodeUnits + retainedCodeUnits <= MAX_RETAINED_PROJECTION_CODE_UNITS
		) {
			record.imagePolicyProjection = projection;
			record.retainedCodeUnits += retainedCodeUnits;
			this.counters.retainedProjectionCodeUnits += retainedCodeUnits;
		}
		return projection;
	}

	private createModelMessage(
		message: ToolResultMessage,
		content: readonly ToolResultPresentationContent[],
	): ToolResultMessage {
		this.counters.modelMessageWrappersCreated++;
		return {
			role: "toolResult",
			toolCallId: message.toolCallId,
			toolName: message.toolName,
			content: content as ToolResultMessage["content"],
			details: message.details,
			usage: message.usage,
			addedToolNames: message.addedToolNames,
			isError: message.isError,
			timestamp: message.timestamp,
		};
	}

	private fitPostImagePolicyMessage(
		message: ToolResultMessage,
		record: ProjectionRecord,
		projection: ProjectionBuild,
		filtered: ToolResultMessage,
		imagePolicy: (message: Message) => Message,
		budgetTokens = this.budgetTokens!,
	): ToolResultMessage {
		this.counters.postImagePolicyEstimatorScans++;
		let estimate = estimateToolOutputTokens(filtered.content);
		if (estimate.estimatedTokens <= budgetTokens) return filtered;
		const originalHead = projection.headTextCodeUnits;
		const originalTail = projection.tailTextCodeUnits;
		let retainedTextCodeUnits = originalHead + originalTail;
		for (let pass = 0; pass < MAX_PROJECTION_SHRINK_PASSES; pass++) {
			const next = Math.max(
				0,
				Math.min(
					retainedTextCodeUnits - 1,
					Math.floor((retainedTextCodeUnits * Math.max(1, budgetTokens - 2)) / estimate.estimatedTokens),
				),
			);
			retainedTextCodeUnits = next;
			const head = Math.min(originalHead, Math.ceil(next / 2));
			const tail = Math.min(originalTail, next - head);
			const candidateProjection = buildProjection(
				record.sourceContent,
				head,
				tail,
				record.sourceKey,
				record.sourceDigest,
				record.sourceScan,
				this.counters,
			);
			const candidate = imagePolicy(this.createModelMessage(message, candidateProjection.content)) as ToolResultMessage;
			this.counters.postImagePolicyShrinkPasses++;
			this.counters.postImagePolicyEstimatorScans++;
			estimate = estimateToolOutputTokens(candidate.content);
			if (estimate.estimatedTokens <= budgetTokens) return candidate;
		}
		const omission = this.getImagePolicyProjection(record, budgetTokens);
		let candidate = imagePolicy(this.createModelMessage(message, omission.content)) as ToolResultMessage;
		for (let index = 0; index < record.sourceContent.length; index++) {
			const block = record.sourceContent[index]!;
			if (block.type !== "image") continue;
			const probeContent: ToolResultPresentationContent[] = [block];
			this.counters.modelProjectionArraysCreated++;
			const probe = this.createModelMessage(message, probeContent);
			const filteredProbe = imagePolicy(probe) as ToolResultMessage;
			if (filteredProbe === probe) break;
			let retainedImage = false;
			for (let probeIndex = 0; probeIndex < filteredProbe.content.length; probeIndex++) {
				if (filteredProbe.content[probeIndex]?.type !== "image") continue;
				retainedImage = true;
				break;
			}
			if (retainedImage || filteredProbe.content.length === 0) break;
			const withPolicyNoticeContent = new Array<ToolResultPresentationContent>(
				filteredProbe.content.length + omission.content.length,
			);
			let outputIndex = 0;
			for (let probeIndex = 0; probeIndex < filteredProbe.content.length; probeIndex++) {
				withPolicyNoticeContent[outputIndex++] = filteredProbe.content[probeIndex]!;
			}
			for (let omissionIndex = 0; omissionIndex < omission.content.length; omissionIndex++) {
				withPolicyNoticeContent[outputIndex++] = omission.content[omissionIndex]!;
			}
			this.counters.modelProjectionArraysCreated++;
			const withPolicyNotice = this.createModelMessage(message, withPolicyNoticeContent);
			this.counters.postImagePolicyEstimatorScans++;
			if (estimateToolOutputTokens(withPolicyNotice.content).estimatedTokens <= budgetTokens) {
				candidate = withPolicyNotice;
			}
			break;
		}
		this.counters.postImagePolicyShrinkPasses++;
		this.counters.postImagePolicyEstimatorScans++;
		estimate = estimateToolOutputTokens(candidate.content);
		if (estimate.estimatedTokens > budgetTokens) {
			throw new ToolResultContinuationError(
				"budget-too-small",
				`Tool-result budget ${budgetTokens} cannot contain the fixed continuation notice.`,
			);
		}
		return candidate;
	}

	private projectMessageForConfiguredBudget(
		message: ToolResultMessage,
		imagePolicy?: (message: Message) => Message,
	): ToolResultMessage {
		const resident = this.projectionRecords?.get(message.toolCallId);
		if (resident?.sourceContent === message.content) this.counters.residentReadHits++;
		else this.counters.providerReadMisses++;
		const record = this.getOrCreateProjectionRecord(message.content, message.toolCallId, "provider");
		let projection = record.projection;
		let projected = projection ? this.createModelMessage(message, projection.content) : message;
		if (imagePolicy) {
			let filtered = imagePolicy(projected);
			if (filtered !== projected && !projection) {
				this.counters.postImagePolicyEstimatorScans++;
				const filteredEstimate = estimateToolOutputTokens((filtered as ToolResultMessage).content);
				if (filteredEstimate.estimatedTokens > this.budgetTokens!) {
					projection = this.getImagePolicyProjection(record);
					projected = this.createModelMessage(message, projection.content);
					filtered = imagePolicy(projected);
				}
			}
			if (filtered !== projected && projection) {
				filtered = this.fitPostImagePolicyMessage(
					message,
					record,
					projection,
					filtered as ToolResultMessage,
					imagePolicy,
				);
			}
			projected = filtered as ToolResultMessage;
		}
		return projected;
	}

	private projectMessageWithinContextualBudget(
		message: ToolResultMessage,
		toolBudgetTokens: number,
		contextBudgetTokens: number,
		imagePolicy?: (message: Message) => Message,
	): ToolResultMessage {
		let candidateBudget = Math.min(toolBudgetTokens, contextBudgetTokens);
		if (!Number.isSafeInteger(candidateBudget) || candidateBudget <= 0) {
			this.counters.contextualBudgetFailures++;
			throw new ToolResultContinuationError(
				"budget-too-small",
				"The remaining turn/context budget cannot contain a tool-result continuation notice.",
			);
		}
		const resident = this.projectionRecords?.get(message.toolCallId);
		if (resident?.sourceContent === message.content) this.counters.residentReadHits++;
		else this.counters.providerReadMisses++;
		const record = this.getOrCreateProjectionRecord(message.content, message.toolCallId, "provider");
		for (let pass = 0; pass <= MAX_PROJECTION_SHRINK_PASSES; pass++) {
			this.counters.contextualProjectionPasses++;
			let projection: ProjectionBuild | undefined;
			try {
				projection = candidateBudget === this.budgetTokens
					? record.projection
					: projectContent(
							record.sourceContent,
							candidateBudget,
							record.sourceKey,
							record.sourceDigest,
							record.sourceScan,
							this.counters,
						);
			} catch (error) {
				this.rethrowContextualProjectionFailure(error);
			}
			if (projection) this.ensureArtifactDescriptor(record);
			let projected = projection ? this.createModelMessage(message, projection.content) : message;
			try {
				if (imagePolicy) {
					let filtered = imagePolicy(projected);
					if (filtered !== projected && !projection) {
						this.counters.postImagePolicyEstimatorScans++;
						const filteredEstimate = estimateToolOutputTokens((filtered as ToolResultMessage).content);
						if (filteredEstimate.estimatedTokens > candidateBudget) {
							const omission = this.getImagePolicyProjection(record, candidateBudget);
							projected = this.createModelMessage(message, omission.content);
							filtered = imagePolicy(projected);
						}
					}
					if (filtered !== projected && projection) {
						filtered = this.fitPostImagePolicyMessage(
							message,
							record,
							projection,
							filtered as ToolResultMessage,
							imagePolicy,
							candidateBudget,
						);
					}
					projected = filtered as ToolResultMessage;
				}
			} catch (error) {
				this.rethrowContextualProjectionFailure(error);
			}
			const toolEstimate = estimateToolOutputTokens(projected.content).estimatedTokens;
			const contextEstimate = estimateMessageTokens(projected);
			if (toolEstimate <= toolBudgetTokens && contextEstimate <= contextBudgetTokens) return projected;
			if (candidateBudget === 1) break;
			let nextBudget = candidateBudget - 1;
			if (toolEstimate > toolBudgetTokens) {
				nextBudget = Math.min(nextBudget, Math.floor((candidateBudget * toolBudgetTokens) / toolEstimate));
			}
			if (contextEstimate > contextBudgetTokens) {
				nextBudget = Math.min(nextBudget, Math.floor((candidateBudget * contextBudgetTokens) / contextEstimate));
			}
			candidateBudget = Math.max(1, nextBudget);
		}
		this.counters.contextualBudgetFailures++;
		throw new ToolResultContinuationError(
			"budget-too-small",
			"The remaining turn/context budget cannot contain a tool-result continuation notice.",
		);
	}

	private rethrowContextualProjectionFailure(error: unknown): never {
		if (error instanceof ToolResultContinuationError && error.code === "budget-too-small") {
			this.counters.contextualBudgetFailures++;
		}
		throw error;
	}

	private projectMessagesWithinContextualBudget(
		messages: Message[],
		imagePolicy: ((message: Message) => Message) | undefined,
		systemPrompt: string | undefined,
		tools: readonly Tool[] | undefined,
		contextWindow: number,
		maxOutputTokens: number | undefined,
	): Message[] {
		let assistantIndex = -1;
		for (let index = messages.length - 1; index >= 0; index--) {
			const message = messages[index]!;
			if (message.role !== "assistant") continue;
			for (let contentIndex = 0; contentIndex < message.content.length; contentIndex++) {
				if (message.content[contentIndex]?.type !== "toolCall") continue;
				assistantIndex = index;
				break;
			}
			break;
		}
		let currentResultCount = 0;
		let currentResultContextTokens = 0;
		if (assistantIndex >= 0) {
			for (let index = assistantIndex + 1; index < messages.length; index++) {
				const message = messages[index]!;
				if (message.role !== "toolResult") continue;
				currentResultCount++;
				currentResultContextTokens += estimateMessageTokens(message);
			}
		}
		if (currentResultCount === 0) return this.projectMessagesForModel(messages, imagePolicy);

		this.counters.contextualBudgetCalls++;
		this.counters.contextualContextScans++;
		this.counters.contextualTurnResults += currentResultCount;
		this.counters.activeContextualCoordinators++;
		this.counters.contextualCoordinatorsHighWaterMark = Math.max(
			this.counters.contextualCoordinatorsHighWaterMark,
			this.counters.activeContextualCoordinators,
		);
		try {
			const contextEstimate = estimateContextTokensFromParts(systemPrompt, messages, tools).tokens;
			const nonCurrentContextTokens = Math.max(0, contextEstimate - currentResultContextTokens);
			const hasContextLimit = Number.isSafeInteger(contextWindow) && contextWindow > 0;
			const outputReserve = Number.isSafeInteger(maxOutputTokens) && maxOutputTokens! > 0
				? maxOutputTokens!
				: 0;
			let remainingContextTokens = hasContextLimit
				? Math.max(0, contextWindow - outputReserve - nonCurrentContextTokens)
				: 0;
			let remainingToolTokens = this.budgetTokens!;
			let remainingResults = currentResultCount;
			for (let index = 0; index < messages.length; index++) {
				const message = messages[index]!;
				if (message.role !== "toolResult") continue;
				if (index <= assistantIndex) {
					messages[index] = this.projectMessageForConfiguredBudget(message, imagePolicy);
					continue;
				}
				const toolBudget = Math.floor(remainingToolTokens / remainingResults);
				const contextBudget = Math.floor(remainingContextTokens / remainingResults);
				const projected = this.projectMessageWithinContextualBudget(
					message,
					Math.min(this.budgetTokens!, toolBudget),
					contextBudget,
					imagePolicy,
				);
				if (projected !== message) messages[index] = projected;
				const consumedToolTokens = estimateToolOutputTokens(projected.content).estimatedTokens;
				const consumedContextTokens = estimateMessageTokens(projected);
				remainingToolTokens = Math.max(0, remainingToolTokens - consumedToolTokens);
				remainingContextTokens = Math.max(0, remainingContextTokens - consumedContextTokens);
				remainingResults--;
				this.counters.contextualToolTokensConsumed += consumedToolTokens;
				this.counters.contextualContextTokensConsumed += consumedContextTokens;
			}
			return messages;
		} finally {
			this.counters.activeContextualCoordinators--;
		}
	}

	/** Mutates only the caller-owned outer array; legacy message objects remain untouched. */
	projectMessagesForModel(
		messages: Message[],
		imagePolicy?: (message: Message) => Message,
		systemPrompt?: string,
		tools?: readonly Tool[],
		contextWindow?: number,
		maxOutputTokens?: number,
	): Message[] {
		if (!this.accepting || this.budgetTokens === undefined) return messages;
		if (contextWindow !== undefined) {
			return this.projectMessagesWithinContextualBudget(
				messages,
				imagePolicy,
				systemPrompt,
				tools,
				contextWindow,
				maxOutputTokens,
			);
		}
		for (let index = 0; index < messages.length; index++) {
			const message = messages[index]!;
			if (message.role !== "toolResult") continue;
			const projected = this.projectMessageForConfiguredBudget(message, imagePolicy);
			if (projected !== message) messages[index] = projected;
		}
		return messages;
	}

	/** Resolve a session-bound virtual artifact to the canonical content on the active branch. */
	readArtifact(id: string, messages: readonly unknown[]): ToolResultArtifactReadV1 {
		if (!this.accepting) {
			throw new ToolResultArtifactError("stale-artifact", "Tool-result artifact owner is disposed.");
		}
		if (this.sessionId.length === 0) {
			throw new ToolResultArtifactError("stale-artifact", "Tool-result artifacts require a session identity.");
		}
		const state = parseArtifactId(id);
		if (!state) throw new ToolResultArtifactError("invalid-artifact", "Malformed tool-result artifact handle.");
		const record = this.resolveArtifactRecord(state, messages);
		const descriptor = this.ensureArtifactDescriptor(record);
		if (descriptor.id !== id) {
			throw new ToolResultArtifactError("stale-artifact", "Tool-result artifact source no longer matches the handle.");
		}
		this.bindValidatedContinuationRecord(record);
		this.counters.artifactReads++;
		return { version: TOOL_RESULT_ARTIFACT_VERSION, descriptor, content: record.sourceContent };
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
		this.bindValidatedContinuationRecord(record);
		const sourceTextCodeUnits = record.sourceScan.textCodeUnits;
		let requestedTextCodeUnits = Math.max(1, Math.floor((sourceTextCodeUnits * budgetTokens) / Math.max(estimate.estimatedTokens, budgetTokens)));
		let chunkEnd = advancePosition(
			sourceContent,
			start,
			end,
			requestedTextCodeUnits,
			record.sourceScan,
			this.counters,
		);
		let chunkContent: ToolResultPresentationContent[] = [];
		let chunkEstimate: ToolOutputTokenEstimate | undefined;
		let measuredEndBlock = -1;
		let measuredEndOffset = -1;
		for (let pass = 0; pass < MAX_CONTINUATION_SHRINK_PASSES; pass++) {
			chunkContent = [];
			appendRegion(chunkContent, sourceContent, start, chunkEnd, this.counters);
			chunkEstimate = estimateToolOutputTokens(chunkContent);
			measuredEndBlock = chunkEnd.blockIndex;
			measuredEndOffset = chunkEnd.textOffset;
			if (chunkEstimate.estimatedTokens <= budgetTokens && comparePositions(start, chunkEnd) < 0) break;
			requestedTextCodeUnits = Math.max(1, Math.min(requestedTextCodeUnits - 1, Math.floor((requestedTextCodeUnits * budgetTokens) / Math.max(1, chunkEstimate.estimatedTokens))));
			chunkEnd = advancePosition(
				sourceContent,
				start,
				end,
				requestedTextCodeUnits,
				record.sourceScan,
				this.counters,
			);
		}
		if (measuredEndBlock !== chunkEnd.blockIndex || measuredEndOffset !== chunkEnd.textOffset) {
			chunkContent = [];
			appendRegion(chunkContent, sourceContent, start, chunkEnd, this.counters);
			chunkEstimate = estimateToolOutputTokens(chunkContent);
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
