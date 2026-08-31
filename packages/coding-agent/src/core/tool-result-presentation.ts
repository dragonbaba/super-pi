import { createHash } from "node:crypto";
import type { ImageContent, Message, TextContent, ToolResultMessage } from "@super-pi/ai/compat";
import { estimateToolOutputTokens, type ToolOutputTokenEstimate } from "./tool-output-budget.ts";

export const TOOL_RESULT_PRESENTATION_VERSION = 1 as const;
export const TOOL_RESULT_PRESENTATION_V2_VERSION = 2 as const;
export const TOOL_RESULT_CONTINUATION_VERSION = 1 as const;

const MAX_PROJECTION_SHRINK_PASSES = 4;
const MAX_CONTINUATION_BLOCKS = 256;
const CURSOR_PREFIX = "tr1.";
const NOTICE_PREFIX = "[Tool result truncated. Continue with cursor ";
const NOTICE_SUFFIX = ".]";

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
	fingerprint: string;
	startBlock: number;
	startOffset: number;
	endBlock: number;
	endOffset: number;
	contentBlocks: number;
	rawUtf8Bytes: number;
	estimatedTokens: number;
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
		return (
			value.continuation.version === TOOL_RESULT_CONTINUATION_VERSION &&
			typeof value.continuation.cursor === "string" &&
			value.continuation.cursor.startsWith(CURSOR_PREFIX) &&
			value.truncation.version === 1 &&
			value.truncation.strategy === "text-head-tail" &&
			Number.isSafeInteger(value.truncation.budgetTokens) &&
			(value.truncation.budgetTokens as number) > 0 &&
			Number.isSafeInteger(value.truncation.noticeBlockIndex) &&
			(value.truncation.noticeBlockIndex as number) >= 0 &&
			(value.truncation.noticeBlockIndex as number) < value.modelContent.length &&
			value.truncation.imageTokensIncluded === false
		);
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

function isCombiningOrJoinCode(code: number): boolean {
	return (
		(code >= 0x0300 && code <= 0x036f) ||
		(code >= 0x1ab0 && code <= 0x1aff) ||
		(code >= 0x1dc0 && code <= 0x1dff) ||
		(code >= 0xfe00 && code <= 0xfe0f) ||
		(code >= 0xfe20 && code <= 0xfe2f) ||
		code === 0x200d
	);
}

function safePrefixOffset(text: string, requested: number): number {
	let offset = Math.max(0, Math.min(requested, text.length));
	if (offset > 0 && offset < text.length) {
		const previous = text.charCodeAt(offset - 1);
		const next = text.charCodeAt(offset);
		if (previous >= 0xd800 && previous <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) offset--;
		let adjustments = 0;
		while (offset > 0 && offset < text.length && adjustments < 16) {
			const code = text.charCodeAt(offset);
			const before = text.charCodeAt(offset - 1);
			if (!isCombiningOrJoinCode(code) && before !== 0x200d) break;
			offset--;
			adjustments++;
		}
	}
	return offset;
}

function safeSuffixOffset(text: string, requested: number): number {
	let offset = Math.max(0, Math.min(requested, text.length));
	if (offset > 0 && offset < text.length) {
		const previous = text.charCodeAt(offset - 1);
		const next = text.charCodeAt(offset);
		if (previous >= 0xd800 && previous <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) offset++;
		let adjustments = 0;
		while (offset < text.length && adjustments < 16) {
			const code = text.charCodeAt(offset);
			const before = offset > 0 ? text.charCodeAt(offset - 1) : 0;
			if (!isCombiningOrJoinCode(code) && before !== 0x200d) break;
			offset++;
			adjustments++;
		}
	}
	return offset;
}

function locateHeadEnd(content: readonly ToolResultPresentationContent[], textCodeUnits: number): ContentPosition {
	let remaining = textCodeUnits;
	for (let index = 0; index < content.length; index++) {
		const block = content[index]!;
		if (block.type !== "text") continue;
		if (remaining < block.text.length) return { blockIndex: index, textOffset: safePrefixOffset(block.text, remaining) };
		remaining -= block.text.length;
		if (remaining === 0) return { blockIndex: index + 1, textOffset: 0 };
	}
	return { blockIndex: content.length, textOffset: 0 };
}

function locateTailStart(content: readonly ToolResultPresentationContent[], textCodeUnits: number): ContentPosition {
	let remaining = textCodeUnits;
	for (let index = content.length - 1; index >= 0; index--) {
		const block = content[index]!;
		if (block.type !== "text") continue;
		if (remaining < block.text.length) {
			return { blockIndex: index, textOffset: safeSuffixOffset(block.text, block.text.length - remaining) };
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

function createSourceFingerprint(sessionId: string, toolCallId: string): string {
	return createHash("sha256").update(sessionId).update("\0").update(toolCallId).digest("hex").substring(0, 24);
}

function createCursor(
	fingerprint: string,
	start: ContentPosition,
	end: ContentPosition,
	contentBlocks: number,
	rawUtf8Bytes: number,
	estimatedTokens: number,
	counters: ToolResultPresentationCounters,
): string {
	counters.continuationCursorStringsCreated++;
	return `${CURSOR_PREFIX}${fingerprint}.${start.blockIndex.toString(36)}.${start.textOffset.toString(36)}.${end.blockIndex.toString(36)}.${end.textOffset.toString(36)}.${contentBlocks.toString(36)}.${rawUtf8Bytes.toString(36)}.${estimatedTokens.toString(36)}`;
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
	fingerprint: string,
	fullEstimate: ToolOutputTokenEstimate,
	counters: ToolResultPresentationCounters,
): ProjectionBuild {
	const start = locateHeadEnd(content, headTextCodeUnits);
	const end = locateTailStart(content, tailTextCodeUnits);
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
	const cursor = createCursor(fingerprint, start, end, content.length, fullEstimate.rawUtf8Bytes, fullEstimate.estimatedTokens, counters);
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
		fullEstimate,
	};
}

function projectContent(
	content: readonly ToolResultPresentationContent[],
	budgetTokens: number,
	sessionId: string,
	toolCallId: string,
	counters: ToolResultPresentationCounters,
): ProjectionBuild | undefined {
	counters.modelProjectionCalls++;
	const fullEstimate = estimateToolOutputTokens(content);
	if (fullEstimate.estimatedTokens <= budgetTokens) return undefined;
	const totalTextCodeUnits = countTextCodeUnits(content);
	if (totalTextCodeUnits === 0) return undefined;
	const fingerprint = createSourceFingerprint(sessionId, toolCallId);
	let retainedTextCodeUnits = Math.floor((totalTextCodeUnits * Math.max(1, budgetTokens - 48)) / Math.max(1, fullEstimate.estimatedTokens));
	retainedTextCodeUnits = Math.max(0, Math.min(retainedTextCodeUnits, totalTextCodeUnits - 1));
	let build: ProjectionBuild | undefined;
	for (let pass = 0; pass < MAX_PROJECTION_SHRINK_PASSES; pass++) {
		const headTextCodeUnits = Math.ceil(retainedTextCodeUnits / 2);
		const tailTextCodeUnits = retainedTextCodeUnits - headTextCodeUnits;
		build = buildProjection(content, headTextCodeUnits, tailTextCodeUnits, fingerprint, fullEstimate, counters);
		if (build.estimate.estimatedTokens <= budgetTokens && comparePositions(build.start, build.end) < 0) return build;
		if (retainedTextCodeUnits === 0) break;
		const next = Math.floor((retainedTextCodeUnits * Math.max(1, budgetTokens - 2)) / build.estimate.estimatedTokens);
		retainedTextCodeUnits = Math.max(0, Math.min(retainedTextCodeUnits - 1, next));
	}
	if (!build || build.headTextCodeUnits !== 0 || build.tailTextCodeUnits !== 0) {
		build = buildProjection(content, 0, 0, fingerprint, fullEstimate, counters);
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

function parseCursor(cursor: string): CursorState | undefined {
	if (!cursor.startsWith(CURSOR_PREFIX)) return undefined;
	let start = CURSOR_PREFIX.length;
	let end = cursor.indexOf(".", start);
	if (end < 0 || end - start !== 24) return undefined;
	const fingerprint = cursor.substring(start, end);
	for (let index = 0; index < fingerprint.length; index++) {
		const code = fingerprint.charCodeAt(index);
		if (!((code >= 48 && code <= 57) || (code >= 97 && code <= 102))) return undefined;
	}
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
		fingerprint,
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
		if (remaining < available) return { blockIndex: index, textOffset: safePrefixOffset(block.text, offset + remaining) };
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

export class ToolResultPresentationOwner {
	private accepting = true;
	private readonly budgetTokens: number | undefined;
	private readonly sessionId: string;
	readonly counters: ToolResultPresentationCounters;

	constructor(options: ToolResultPresentationOptions, sessionId: string) {
		this.counters = options.counters ?? createToolResultPresentationCounters();
		this.sessionId = sessionId;
		if (options.budgetTokens !== undefined) {
			if (!Number.isSafeInteger(options.budgetTokens) || options.budgetTokens <= 0) {
				throw new TypeError("toolResultPresentation.budgetTokens must be a positive safe integer");
			}
			this.budgetTokens = options.budgetTokens;
		}
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
			const projection = projectContent(legacyContent, this.budgetTokens, this.sessionId, toolCallId, this.counters);
			if (projection) {
				const originalTextCodeUnits = countTextCodeUnits(legacyContent);
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
			const projection = projectContent(message.content, this.budgetTokens, this.sessionId, message.toolCallId, this.counters);
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

	readContinuation(cursor: string, messages: readonly unknown[], budgetTokens: number = this.budgetTokens ?? 0): ToolResultContinuationChunkV1 {
		if (!this.accepting) {
			throw new ToolResultContinuationError("stale-cursor", "Tool-result continuation owner is disposed.");
		}
		if (!Number.isSafeInteger(budgetTokens) || budgetTokens <= 0) {
			throw new ToolResultContinuationError("budget-too-small", "Continuation budget must be a positive integer.");
		}
		const state = parseCursor(cursor);
		if (!state) throw new ToolResultContinuationError("invalid-cursor", "Malformed tool-result continuation cursor.");
		let source: SourceMessageLike | undefined;
		for (let index = 0; index < messages.length; index++) {
			const candidate = messages[index];
			if (!isSourceMessageLike(candidate)) continue;
			if (createSourceFingerprint(this.sessionId, candidate.toolCallId) !== state.fingerprint) continue;
			if (source) throw new ToolResultContinuationError("stale-cursor", "Continuation cursor is ambiguous.");
			source = candidate;
		}
		if (!source) throw new ToolResultContinuationError("stale-cursor", "Continuation source is not on the active branch.");
		const estimate = estimateToolOutputTokens(source.content);
		if (source.content.length !== state.contentBlocks || estimate.rawUtf8Bytes !== state.rawUtf8Bytes || estimate.estimatedTokens !== state.estimatedTokens) {
			throw new ToolResultContinuationError("stale-cursor", "Continuation source no longer matches the cursor.");
		}
		const start = { blockIndex: state.startBlock, textOffset: state.startOffset };
		const end = { blockIndex: state.endBlock, textOffset: state.endOffset };
		if (!isValidPosition(source.content, start) || !isValidPosition(source.content, end) || comparePositions(start, end) >= 0) {
			throw new ToolResultContinuationError("invalid-cursor", "Continuation cursor positions are invalid.");
		}
		const sourceTextCodeUnits = countTextCodeUnits(source.content);
		let requestedTextCodeUnits = Math.max(1, Math.floor((sourceTextCodeUnits * budgetTokens) / Math.max(estimate.estimatedTokens, budgetTokens)));
		let chunkEnd = advancePosition(source.content, start, end, requestedTextCodeUnits);
		let chunkContent: ToolResultPresentationContent[] = [];
		let chunkEstimate: ToolOutputTokenEstimate | undefined;
		for (let pass = 0; pass < MAX_PROJECTION_SHRINK_PASSES; pass++) {
			chunkContent = [];
			appendRegion(chunkContent, source.content, start, chunkEnd, this.counters);
			chunkEstimate = estimateToolOutputTokens(chunkContent);
			if (chunkEstimate.estimatedTokens <= budgetTokens && comparePositions(start, chunkEnd) < 0) break;
			requestedTextCodeUnits = Math.max(1, Math.min(requestedTextCodeUnits - 1, Math.floor((requestedTextCodeUnits * budgetTokens) / Math.max(1, chunkEstimate.estimatedTokens))));
			chunkEnd = advancePosition(source.content, start, end, requestedTextCodeUnits);
		}
		if (!chunkEstimate || chunkEstimate.estimatedTokens > budgetTokens || comparePositions(start, chunkEnd) >= 0) {
			throw new ToolResultContinuationError("budget-too-small", `Continuation budget ${budgetTokens} cannot make forward progress.`);
		}
		const done = samePosition(chunkEnd, end);
		const nextCursor = done ? undefined : createCursor(state.fingerprint, chunkEnd, end, state.contentBlocks, state.rawUtf8Bytes, state.estimatedTokens, this.counters);
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
		this.counters.ownerDisposeCalls++;
	}
}

export function createToolResultPresentationOwner(options: ToolResultPresentationOptions | undefined, sessionId = ""): ToolResultPresentationOwner | undefined {
	return options?.enabled === true ? new ToolResultPresentationOwner(options, sessionId) : undefined;
}
