import { RELEASE_COMPONENT_RENDER_CACHE } from "../component-cache.ts";
import { type Component, Container } from "../tui.ts";
import { getKittyImageMetadata } from "../terminal-image.ts";

export const LINE_VIEWPORT_COMPONENT = Symbol.for("@super-pi/tui/line-viewport-component");

export interface LineViewportRender {
	/** Lines intersecting the requested range. */
	lines: string[];
	/** Absolute line represented by lines[0]. */
	startLine: number;
	totalHeight: number;
	/** Kitty image header immediately above startLine when its reserved rows cross the range. */
	leadingKittyImage?: { line: string; absoluteRow: number };
}

export type LineViewportMutationKind = "none" | "tail-append" | "range" | "unsafe";

/** Bounded change attribution consumed by Main Screen visible-window rendering. */
export interface LineViewportMutationObservation {
	/** Opaque component-owned token to pass back on the next observation. */
	token: unknown;
	kind: LineViewportMutationKind;
	/** Current-document line range for attributed content mutations. */
	earliestChangedLine?: number;
	latestChangedLine?: number;
	/** Whether the attributed range changed document height. */
	heightChanged?: boolean;
}

export interface LineViewportComponent extends Component {
	readonly [LINE_VIEWPORT_COMPONENT]: true;
	/**
	 * Returns indexed document height for the requested width.
	 *
	 * Contract for dynamic transcript children: when a non-retained child changes
	 * its rendered height without a width change, the host must notify its owning
	 * indexed container before the next height or viewport query. RetainedContainer
	 * hosts do this with `invalidateViewportChild(component)`; insertion, movement,
	 * and replacement instead require `notifyChildrenChanged()`.
	 */
	getContentHeight(width: number): number;
	renderViewport(width: number, startLine: number, height: number): LineViewportRender;
	renderViewportTail(width: number, height: number): LineViewportRender;
	/**
	 * Attributes changes since `previousToken`. Unknown, structural, presentation,
	 * reordered, and removed mutations must report `unsafe`; height changes must
	 * identify their affected range so the host can reject offscreen changes.
	 */
	observeViewportMutation(
		width: number,
		previousToken?: unknown,
		result?: LineViewportMutationObservation,
	): LineViewportMutationObservation;
}

export function isLineViewportComponent(component: Component): component is LineViewportComponent {
	return (component as Partial<LineViewportComponent>)[LINE_VIEWPORT_COMPONENT] === true;
}

export function getComponentsContentHeight(components: readonly Component[], width: number): number {
	const safeWidth = Math.max(1, Math.floor(width));
	let totalHeight = 0;
	for (const child of components) {
		totalHeight += isLineViewportComponent(child) ? child.getContentHeight(safeWidth) : child.render(safeWidth).length;
	}
	return totalHeight;
}

export function renderComponentsViewport(
	components: readonly Component[],
	width: number,
	startLine: number,
	height: number,
	knownTotalHeight?: number,
): LineViewportRender {
	const safeWidth = Math.max(1, Math.floor(width));
	const safeHeight = Math.max(0, Math.floor(height));
	const totalHeight = knownTotalHeight ?? getComponentsContentHeight(components, safeWidth);
	const requestedStart = Math.max(0, Math.min(totalHeight, Math.floor(startLine)));
	const requestedEnd = Math.min(totalHeight, requestedStart + safeHeight);
	if (safeHeight === 0 || requestedStart >= totalHeight) {
		return { lines: [], startLine: requestedStart, totalHeight };
	}

	const lines: string[] = [];
	let childStart = 0;
	let resultStart: number | undefined;
	let leadingKittyImage: LineViewportRender["leadingKittyImage"];
	for (const child of components) {
		if (isLineViewportComponent(child)) {
			const childHeight = child.getContentHeight(safeWidth);
			const childEnd = childStart + childHeight;
			if (childEnd > requestedStart && childStart < requestedEnd) {
				const localStart = Math.max(0, requestedStart - childStart);
				const localHeight = Math.max(0, requestedEnd - Math.max(requestedStart, childStart));
				const rendered =
					requestedEnd === totalHeight && childEnd === totalHeight
						? child.renderViewportTail(safeWidth, localHeight)
						: child.renderViewport(safeWidth, localStart, localHeight);
				resultStart ??= childStart + rendered.startLine;
				if (rendered.leadingKittyImage && !leadingKittyImage) {
					leadingKittyImage = {
						line: rendered.leadingKittyImage.line,
						absoluteRow: childStart + rendered.leadingKittyImage.absoluteRow,
					};
				}
				for (const line of rendered.lines) lines.push(line);
			}
			childStart = childEnd;
			continue;
		}

		const childLines = child.render(safeWidth);
		const childEnd = childStart + childLines.length;
		if (childEnd > requestedStart && childStart < requestedEnd) {
			const localStart = Math.max(0, requestedStart - childStart);
			const localEnd = Math.min(childLines.length, requestedEnd - childStart);
			resultStart ??= childStart + localStart;
			if (!leadingKittyImage && localStart > 0) {
				for (let lineIndex = localStart - 1; lineIndex >= 0; lineIndex--) {
					const line = childLines[lineIndex] ?? "";
					const metadata = getKittyImageMetadata(line);
					if (metadata) {
						if (lineIndex + metadata.rows > localStart) {
							leadingKittyImage = { line, absoluteRow: childStart + lineIndex };
						}
						break;
					}
					if (line !== "") break;
				}
			}
			for (let lineIndex = localStart; lineIndex < localEnd; lineIndex++) lines.push(childLines[lineIndex]);
		}
		childStart = childEnd;
	}

	return { lines, startLine: resultStart ?? requestedStart, totalHeight, leadingKittyImage };
}

/** Small composition root that preserves line ranges supplied by a retained transcript child. */
export class ViewportContainer extends Container implements LineViewportComponent {
	readonly [LINE_VIEWPORT_COMPONENT] = true as const;
	private mutationGeneration = 0;
	private childMutationTokens: unknown[] = [];
	private readonly childMutationScratch: LineViewportMutationObservation = { token: 0, kind: "none" };
	private childHeights: number[] = [];
	private childHeightWidth: number | undefined;
	private tailChildLines: Array<readonly string[] | undefined> = [];
	private tailChildStarts: number[] = [];
	private tailChildLeadingKittyImages: Array<LineViewportRender["leadingKittyImage"]> = [];

	[RELEASE_COMPONENT_RENDER_CACHE](): void {
		this.mutationGeneration++;
		this.childMutationTokens = [];
		this.childHeights = [];
		this.tailChildLines = [];
		this.tailChildStarts = [];
		this.tailChildLeadingKittyImages = [];
		this.childHeightWidth = undefined;
		this.childMutationScratch.token = undefined;
		this.childMutationScratch.kind = "none";
		this.childMutationScratch.earliestChangedLine = undefined;
		this.childMutationScratch.latestChangedLine = undefined;
		this.childMutationScratch.heightChanged = undefined;
	}

	/** Low-frequency final-unmount diagnostics; never called from viewport rendering. */
	getViewportLifecycleReferenceCounts(): {
		children: number;
		childMutationTokens: number;
		childHeights: number;
		tailChildLines: number;
		tailChildStarts: number;
		tailChildLeadingKittyImages: number;
		childMutationScratchToken: 0 | 1;
		childHeightWidth: 0 | 1;
	} {
		return {
			children: this.children.length,
			childMutationTokens: this.childMutationTokens.length,
			childHeights: this.childHeights.length,
			tailChildLines: this.tailChildLines.length,
			tailChildStarts: this.tailChildStarts.length,
			tailChildLeadingKittyImages: this.tailChildLeadingKittyImages.length,
			childMutationScratchToken: this.childMutationScratch.token === undefined ? 0 : 1,
			childHeightWidth: this.childHeightWidth === undefined ? 0 : 1,
		};
	}

	private markStructureMutation(): void {
		this.mutationGeneration++;
		this.childMutationTokens.length = 0;
		this.childHeights.length = 0;
		this.childHeightWidth = undefined;
	}

	override addChild(component: Component): void {
		super.addChild(component);
		this.markStructureMutation();
	}

	override removeChild(component: Component): void {
		const previousLength = this.children.length;
		super.removeChild(component);
		if (this.children.length !== previousLength) {
			this.markStructureMutation();
		}
	}

	override clear(): void {
		if (this.children.length > 0) {
			this.markStructureMutation();
		}
		super.clear();
	}

	override invalidate(): void {
		this.mutationGeneration++;
		this.childHeightWidth = undefined;
		super.invalidate();
	}

	getContentHeight(width: number): number {
		const safeWidth = Math.max(1, Math.floor(width));
		this.childHeightWidth = safeWidth;
		this.childHeights.length = this.children.length;
		let totalHeight = 0;
		for (let index = 0; index < this.children.length; index++) {
			const child = this.children[index];
			const height = isLineViewportComponent(child)
				? child.getContentHeight(safeWidth)
				: child.render(safeWidth).length;
			this.childHeights[index] = height;
			totalHeight += height;
		}
		return totalHeight;
	}

	renderViewport(width: number, startLine: number, height: number): LineViewportRender {
		const totalHeight = this.getContentHeight(width);
		return renderComponentsViewport(this.children, width, startLine, height, totalHeight);
	}

	renderViewportTail(width: number, height: number): LineViewportRender {
		const safeWidth = Math.max(1, Math.floor(width));
		const safeHeight = Math.max(0, Math.floor(height));
		const childCount = this.children.length;
		this.childHeightWidth = safeWidth;
		this.childHeights.length = childCount;
		this.tailChildLines.length = childCount;
		this.tailChildStarts.length = childCount;
		this.tailChildLeadingKittyImages.length = childCount;
		let remaining = safeHeight;
		let totalHeight = 0;
		for (let index = childCount - 1; index >= 0; index--) {
			const child = this.children[index];
			let childHeight: number;
			if (isLineViewportComponent(child)) {
				if (remaining > 0) {
					const rendered = child.renderViewportTail(safeWidth, remaining);
					childHeight = rendered.totalHeight;
					this.tailChildLines[index] = rendered.lines;
					this.tailChildStarts[index] = rendered.startLine;
					this.tailChildLeadingKittyImages[index] = rendered.leadingKittyImage;
				} else {
					childHeight = child.getContentHeight(safeWidth);
					this.tailChildLines[index] = undefined;
					this.tailChildStarts[index] = childHeight;
					this.tailChildLeadingKittyImages[index] = undefined;
				}
			} else {
				const childLines = child.render(safeWidth);
				childHeight = childLines.length;
				this.tailChildLines[index] = remaining > 0 ? childLines : undefined;
				this.tailChildStarts[index] = Math.max(0, childHeight - remaining);
				this.tailChildLeadingKittyImages[index] = undefined;
			}
			this.childHeights[index] = childHeight;
			totalHeight += childHeight;
			remaining = Math.max(0, remaining - childHeight);
		}

		const requestedStart = Math.max(0, totalHeight - safeHeight);
		const lines: string[] = [];
		let childAbsoluteStart = 0;
		let leadingKittyImage: LineViewportRender["leadingKittyImage"];
		try {
			for (let index = 0; index < childCount; index++) {
				const childLines = this.tailChildLines[index];
				if (childLines) {
					const childLineStart = this.tailChildStarts[index];
					for (let lineIndex = 0; lineIndex < childLines.length; lineIndex++) {
						const absoluteLine = childAbsoluteStart + childLineStart + lineIndex;
						if (absoluteLine >= requestedStart && lines.length < safeHeight) lines.push(childLines[lineIndex]);
					}
					const childLeading = this.tailChildLeadingKittyImages[index];
					if (!leadingKittyImage && childLeading) {
						leadingKittyImage = {
							line: childLeading.line,
							absoluteRow: childAbsoluteStart + childLeading.absoluteRow,
						};
					}
				}
				childAbsoluteStart += this.childHeights[index];
			}
		} finally {
			for (let index = 0; index < childCount; index++) {
				this.tailChildLines[index] = undefined;
				this.tailChildLeadingKittyImages[index] = undefined;
			}
		}
		return { lines, startLine: requestedStart, totalHeight, leadingKittyImage };
	}

	observeViewportMutation(
		width: number,
		previousToken?: unknown,
		result?: LineViewportMutationObservation,
	): LineViewportMutationObservation {
		const observationResult = result ?? { token: this.mutationGeneration, kind: "none" };
		const generationBeforeChildren = this.mutationGeneration;
		let aggregateKind: LineViewportMutationKind = previousToken === generationBeforeChildren ? "none" : "unsafe";
		let earliestChangedLine: number | undefined;
		let latestChangedLine: number | undefined;
		let heightChanged = false;
		let childStart = 0;
		let changedChildren = 0;
		const hasCachedHeights =
			this.childHeightWidth === Math.max(1, Math.floor(width)) && this.childHeights.length === this.children.length;
		this.childMutationTokens.length = this.children.length;
		for (let index = 0; index < this.children.length; index++) {
			const child = this.children[index];
			if (isLineViewportComponent(child)) {
				const observation = child.observeViewportMutation(
					width,
					this.childMutationTokens[index],
					this.childMutationScratch,
				);
				this.childMutationTokens[index] = observation.token;
				if (observation.kind !== "none") {
					changedChildren++;
					if (aggregateKind !== "none" || changedChildren > 1 || observation.kind === "unsafe") {
						aggregateKind = "unsafe";
					} else {
						aggregateKind = observation.kind;
						if (observation.earliestChangedLine !== undefined) {
							earliestChangedLine = childStart + observation.earliestChangedLine;
						}
						if (observation.latestChangedLine !== undefined) {
							latestChangedLine = childStart + observation.latestChangedLine;
						}
						heightChanged = observation.heightChanged === true;
					}
				}
			} else {
				this.childMutationTokens[index] = undefined;
			}
			childStart += hasCachedHeights
				? this.childHeights[index]
				: isLineViewportComponent(child)
					? child.getContentHeight(width)
					: child.render(width).length;
		}
		if (changedChildren > 0) this.mutationGeneration++;
		observationResult.token = this.mutationGeneration;
		observationResult.kind = aggregateKind;
		observationResult.earliestChangedLine = earliestChangedLine;
		observationResult.latestChangedLine = latestChangedLine;
		observationResult.heightChanged = heightChanged;
		return observationResult;
	}
}
