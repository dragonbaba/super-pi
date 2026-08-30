import type { ImageContent, TextContent } from "@super-pi/ai/compat";

export const TOOL_RESULT_PRESENTATION_VERSION = 1 as const;

export type ToolResultPresentationContent = TextContent | ImageContent;

/**
 * Phase 5B-A final-result ownership boundary.
 *
 * `modelContent` is the final post-extension content array already owned by the
 * ToolResultMessage. `uiContent` owns a distinct outer array but reuses the
 * finalized content-block and string references. Content blocks are immutable
 * by contract after this boundary.
 */
export interface ToolResultPresentationV1 {
	readonly version: typeof TOOL_RESULT_PRESENTATION_VERSION;
	readonly modelContent: readonly ToolResultPresentationContent[];
	readonly uiContent?: readonly ToolResultPresentationContent[];
	/** Reserved for a later phase; 5B-A never creates continuation state. */
	readonly continuation?: never;
	/** Reserved for a later phase; 5B-A never creates artifacts. */
	readonly artifact?: never;
	/** Reserved for a later phase; 5B-A never truncates either view. */
	readonly truncation?: never;
}

export type ToolResultPresentation = ToolResultPresentationV1;

export interface ToolResultPresentationCounters {
	presentationObjectsCreated: number;
	outerArraysCreated: number;
	outerArraysOwned: number;
	modelOuterArraysReused: number;
	contentBlockReferencesReused: number;
	textStringReferencesReused: number;
	imageDataReferencesReused: number;
	presentationsReleased: number;
	releaseWithoutActivePresentation: number;
	activePresentations: number;
	activePresentationsHighWaterMark: number;
	maximumContentBlocks: number;
	maximumInputCharacters: number;
	ownerDisposeCalls: number;
}

export interface ToolResultPresentationOptions {
	enabled?: boolean;
	counters?: ToolResultPresentationCounters;
}

export function createToolResultPresentationCounters(): ToolResultPresentationCounters {
	return {
		presentationObjectsCreated: 0,
		outerArraysCreated: 0,
		outerArraysOwned: 0,
		modelOuterArraysReused: 0,
		contentBlockReferencesReused: 0,
		textStringReferencesReused: 0,
		imageDataReferencesReused: 0,
		presentationsReleased: 0,
		releaseWithoutActivePresentation: 0,
		activePresentations: 0,
		activePresentationsHighWaterMark: 0,
		maximumContentBlocks: 0,
		maximumInputCharacters: 0,
		ownerDisposeCalls: 0,
	};
}

function isToolResultPresentationV1(value: unknown): value is ToolResultPresentationV1 {
	try {
		if (!value || typeof value !== "object" || Array.isArray(value)) return false;
		const candidate = value as {
			version?: unknown;
			modelContent?: unknown;
			uiContent?: unknown;
		};
		return (
			candidate.version === TOOL_RESULT_PRESENTATION_VERSION &&
			Array.isArray(candidate.modelContent) &&
			(candidate.uiContent === undefined ||
				(Array.isArray(candidate.uiContent) && candidate.uiContent !== candidate.modelContent))
		);
	} catch {
		return false;
	}
}

/** Unknown or malformed versions conservatively use the legacy message content. */
export function getToolResultModelContent(
	presentation: unknown,
	legacyContent: readonly ToolResultPresentationContent[],
): readonly ToolResultPresentationContent[] {
	return isToolResultPresentationV1(presentation) ? presentation.modelContent : legacyContent;
}

/** Unknown or malformed versions conservatively use the legacy message content. */
export function getToolResultUiContent(
	presentation: unknown,
	legacyContent: readonly ToolResultPresentationContent[],
): readonly ToolResultPresentationContent[] {
	return isToolResultPresentationV1(presentation)
		? (presentation.uiContent ?? presentation.modelContent)
		: legacyContent;
}

export class ToolResultPresentationOwner {
	private accepting = true;
	readonly counters: ToolResultPresentationCounters;

	constructor(options: ToolResultPresentationOptions) {
		this.counters = options.counters ?? createToolResultPresentationCounters();
	}

	create(modelContent: readonly ToolResultPresentationContent[]): ToolResultPresentationV1 | undefined {
		if (!this.accepting) return undefined;
		const uiContent = new Array<ToolResultPresentationContent>(modelContent.length);
		let inputCharacters = 0;
		for (let index = 0; index < modelContent.length; index++) {
			const block = modelContent[index]!;
			uiContent[index] = block;
			if (block.type === "text") {
				this.counters.textStringReferencesReused++;
				inputCharacters += block.text.length;
			} else {
				this.counters.imageDataReferencesReused++;
				inputCharacters += block.data.length;
			}
		}
		const presentation: ToolResultPresentationV1 = {
			version: TOOL_RESULT_PRESENTATION_VERSION,
			modelContent,
			uiContent,
		};
		this.counters.presentationObjectsCreated++;
		this.counters.outerArraysCreated++;
		this.counters.outerArraysOwned += 2;
		this.counters.modelOuterArraysReused++;
		this.counters.contentBlockReferencesReused += modelContent.length;
		this.counters.maximumContentBlocks = Math.max(this.counters.maximumContentBlocks, modelContent.length);
		this.counters.maximumInputCharacters = Math.max(this.counters.maximumInputCharacters, inputCharacters);
		this.counters.activePresentations++;
		this.counters.activePresentationsHighWaterMark = Math.max(
			this.counters.activePresentationsHighWaterMark,
			this.counters.activePresentations,
		);
		return presentation;
	}

	release(): void {
		if (this.counters.activePresentations === 0) {
			this.counters.releaseWithoutActivePresentation++;
			return;
		}
		this.counters.activePresentations--;
		this.counters.presentationsReleased++;
	}

	dispose(): void {
		if (!this.accepting) return;
		this.accepting = false;
		this.counters.ownerDisposeCalls++;
	}
}

export function createToolResultPresentationOwner(
	options: ToolResultPresentationOptions | undefined,
): ToolResultPresentationOwner | undefined {
	return options?.enabled === true ? new ToolResultPresentationOwner(options) : undefined;
}
