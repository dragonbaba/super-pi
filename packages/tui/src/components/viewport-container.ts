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
	observeViewportMutation(width: number, previousToken?: unknown): LineViewportMutationObservation;
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
	private mutationKind: Exclude<LineViewportMutationKind, "none"> = "unsafe";

	override addChild(component: Component): void {
		super.addChild(component);
		this.mutationGeneration++;
		this.mutationKind = "unsafe";
	}

	override removeChild(component: Component): void {
		const previousLength = this.children.length;
		super.removeChild(component);
		if (this.children.length !== previousLength) {
			this.mutationGeneration++;
			this.mutationKind = "unsafe";
		}
	}

	override clear(): void {
		if (this.children.length > 0) {
			this.mutationGeneration++;
			this.mutationKind = "unsafe";
		}
		super.clear();
	}

	override invalidate(): void {
		this.mutationGeneration++;
		this.mutationKind = "unsafe";
		super.invalidate();
	}

	getContentHeight(width: number): number {
		return getComponentsContentHeight(this.children, width);
	}

	renderViewport(width: number, startLine: number, height: number): LineViewportRender {
		const totalHeight = this.getContentHeight(width);
		return renderComponentsViewport(this.children, width, startLine, height, totalHeight);
	}

	renderViewportTail(width: number, height: number): LineViewportRender {
		const totalHeight = this.getContentHeight(width);
		return this.renderViewport(width, Math.max(0, totalHeight - Math.max(0, Math.floor(height))), height);
	}

	observeViewportMutation(width: number, previousToken?: unknown): LineViewportMutationObservation {
		const previous = previousToken as
			| { ownGeneration: number; childTokens: readonly unknown[] }
			| undefined;
		const childTokens: unknown[] = [];
		let aggregateKind: LineViewportMutationKind =
			previous && previous.ownGeneration === this.mutationGeneration ? "none" : this.mutationKind;
		let earliestChangedLine: number | undefined;
		let latestChangedLine: number | undefined;
		let heightChanged = false;
		let childStart = 0;
		let changedChildren = 0;
		for (let index = 0; index < this.children.length; index++) {
			const child = this.children[index];
			if (isLineViewportComponent(child)) {
				const observation = child.observeViewportMutation(width, previous?.childTokens[index]);
				childTokens.push(observation.token);
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
				childStart += child.getContentHeight(width);
			} else {
				childTokens.push(undefined);
				childStart += child.render(width).length;
			}
		}
		return {
			token: { ownGeneration: this.mutationGeneration, childTokens },
			kind: aggregateKind,
			earliestChangedLine,
			latestChangedLine,
			heightChanged,
		};
	}
}
