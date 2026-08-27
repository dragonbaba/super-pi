import { type Component, Container } from "../tui.ts";

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
			resultStart ??= childStart;
			for (const line of childLines) lines.push(line);
		}
		childStart = childEnd;
	}

	return { lines, startLine: resultStart ?? requestedStart, totalHeight, leadingKittyImage };
}

/** Small composition root that preserves line ranges supplied by a retained transcript child. */
export class ViewportContainer extends Container implements LineViewportComponent {
	readonly [LINE_VIEWPORT_COMPONENT] = true as const;

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
}
