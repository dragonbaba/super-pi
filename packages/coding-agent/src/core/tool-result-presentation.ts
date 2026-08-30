import type { ImageContent, TextContent } from "@super-pi/ai/compat";

export const TOOL_RESULT_PRESENTATION_VERSION = 1 as const;

export type ToolResultPresentationContent = Readonly<TextContent> | Readonly<ImageContent>;

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
	uiOuterArraysCreated: number;
	modelOuterArraysReused: number;
	presentationOuterArrayReferences: number;
	contentBlockReferencesReused: number;
	textStringReferencesReused: number;
	imageDataReferencesReused: number;
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
	counters?: ToolResultPresentationCounters;
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
		let textCodeUnits = 0;
		let imageDataCodeUnits = 0;
		for (let index = 0; index < modelContent.length; index++) {
			const block = modelContent[index]!;
			uiContent[index] = block;
			if (block.type === "text") {
				this.counters.textStringReferencesReused++;
				textCodeUnits += block.text.length;
			} else {
				this.counters.imageDataReferencesReused++;
				imageDataCodeUnits += block.data.length;
			}
		}
		const presentation: ToolResultPresentationV1 = {
			version: TOOL_RESULT_PRESENTATION_VERSION,
			modelContent,
			uiContent,
		};
		this.counters.presentationObjectsCreated++;
		this.counters.uiOuterArraysCreated++;
		this.counters.modelOuterArraysReused++;
		this.counters.presentationOuterArrayReferences += 2;
		this.counters.contentBlockReferencesReused += modelContent.length;
		this.counters.maximumContentBlocks = Math.max(this.counters.maximumContentBlocks, modelContent.length);
		this.counters.maximumTextCodeUnits = Math.max(this.counters.maximumTextCodeUnits, textCodeUnits);
		this.counters.maximumImageDataCodeUnits = Math.max(
			this.counters.maximumImageDataCodeUnits,
			imageDataCodeUnits,
		);
		this.counters.activeDispatchPresentationScopes++;
		this.counters.dispatchPresentationScopesHighWaterMark = Math.max(
			this.counters.dispatchPresentationScopesHighWaterMark,
			this.counters.activeDispatchPresentationScopes,
		);
		return presentation;
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

export function createToolResultPresentationOwner(
	options: ToolResultPresentationOptions | undefined,
): ToolResultPresentationOwner | undefined {
	return options?.enabled === true ? new ToolResultPresentationOwner(options) : undefined;
}
