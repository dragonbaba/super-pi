import type { ScrollView } from "./components/scroll-view.ts";
import { allocateStackSizesInto } from "./components/stack.ts";
import { getLayoutNode, type LayoutViewport, type StackLayoutEntry } from "./layout-node.ts";
import { cropKittyImageLine, getKittyImageMetadata, isImageLine } from "./terminal-image.ts";
import { type Component, CURSOR_MARKER, compositeTuiLine } from "./tui.ts";
import { extractAnsiCode, getGraphemeCellRange, sliceByColumn, visibleWidth } from "./utils.ts";
import { isLineViewportComponent } from "./components/viewport-container.ts";

const OSC133_ZONE_PREFIX = /^(?:\x1b\]133;[ABC](?:\x07|\x1b\\))+/;
const FULL_WIDTH_LINE_RESET = "\x1b[0m\x1b]8;;\x07";
const MAX_RETAINED_LAYOUT_ROWS = 4096;
const MAX_RETAINED_LAYOUT_RECORDS = 4096;
const RENDER_CACHE_LINEAR_LIMIT = 24;
const MAX_RETAINED_ROW_CODE_UNITS = 64 * 1024;
const MAX_RETAINED_ROW_CACHE_CODE_UNITS = 512 * 1024;

export interface LayoutRect {
	x: number;
	y: number;
	width: number;
	height: number;
}

export interface LayoutBox {
	component: Component;
	rect: LayoutRect;
	clip: LayoutRect;
	children: LayoutBox[];
	parent?: LayoutBox;
	lines?: readonly string[];
	lineOffset?: number;
	scrollView?: ScrollView;
	scrollContentLines?: readonly string[];
	scrollContentStart?: number;
	scrollLeadingKittyImage?: { line: string; absoluteRow: number };
	layer: number;
}

export interface LayoutFrame {
	root: LayoutBox;
	width: number;
	height: number;
	generatedLineCount: number;
	/**
	 * Scratch-owned frame lines. When a LayoutFrameScratch is supplied, callers
	 * may compose this borrowed array in place for the current frame, but must
	 * consume it before rendering again; a later frame may overwrite its rows.
	 */
	lines: string[];
	primaryScrollView?: ScrollView;
	layoutNodesVisited?: number;
	layoutBoxObjects?: number;
	layoutRectObjects?: number;
	clipObjects?: number;
	screenArraysCreated?: number;
	fullViewportArrayCopies?: number;
	stringRepeatCalls?: number;
	stringRepeatBytes?: number;
	paintBoxCalls?: number;
	childRenderCalls?: number;
	fullWidthRowCacheHits?: number;
	renderCacheLookupProbes?: number;
	renderCacheRecordCount?: number;
	renderCacheIndexActivations?: number;
	cachedSourceCodeUnits?: number;
	cachedPaintedCodeUnits?: number;
	maximumCachedRowCodeUnits?: number;
	rowCacheRejectedBySize?: number;
}

export interface ScrollbarGeometry {
	column: number;
	trackTop: number;
	trackHeight: number;
	thumbTop: number;
	thumbHeight: number;
	maxScrollTop: number;
}

export interface LayoutContext {
	viewportWidth: number;
	viewportHeight: number;
	visibleViewport: LayoutViewport | undefined;
	renderComponents: Array<Component | undefined>;
	renderWidths: number[];
	renderLines: Array<string[] | undefined>;
	renderPreviousIndexes: number[];
	renderCacheIndex: Map<Component, number> | undefined;
	renderCacheIndexActive: boolean;
	renderCount: number;
	visibleEntries: Array<StackLayoutEntry | undefined>;
	visibleEntryCount: number;
	numbers: number[];
	numberCount: number;
	requestRender: () => void;
	primaryScrollView: ScrollView | undefined;
	primaryDocumentLineCount: number | undefined;
	screen: string[];
	previousFullWidthSources: Array<string | undefined>;
	previousFullWidthLines: Array<string | undefined>;
	previousFullWidthModes: Uint8Array;
	currentFullWidthSources: Array<string | undefined>;
	currentFullWidthLines: Array<string | undefined>;
	currentFullWidthModes: Uint8Array;
	previousCachedSourceCodeUnits: number;
	previousCachedPaintedCodeUnits: number;
	previousCachedCodeUnits: number;
	currentCachedSourceCodeUnits: number;
	currentCachedPaintedCodeUnits: number;
	currentCachedCodeUnits: number;
	rowCacheEnabled: boolean;
	layoutNodesVisited: number;
	layoutBoxObjects: number;
	layoutRectObjects: number;
	clipObjects: number;
	screenArraysCreated: number;
	fullViewportArrayCopies: number;
	stringRepeatCalls: number;
	stringRepeatBytes: number;
	paintBoxCalls: number;
	childRenderCalls: number;
	fullWidthRowCacheHits: number;
	renderCacheLookupProbes: number;
	renderCacheRecordCount: number;
	renderCacheIndexActivations: number;
	maximumCachedRowCodeUnits: number;
	rowCacheRejectedBySize: number;
}

/**
 * Per-TUI synchronous Alt layout scratch. It owns only viewport-sized internal
 * arrays, never crosses an await, and never exposes mutable scratch to a child.
 */
export class LayoutFrameScratch {
	private readonly context: LayoutContext = {
		viewportWidth: 1,
		viewportHeight: 1,
		visibleViewport: undefined,
		renderComponents: [],
		renderWidths: [],
		renderLines: [],
		renderPreviousIndexes: [],
		renderCacheIndex: undefined,
		renderCacheIndexActive: false,
		renderCount: 0,
		visibleEntries: [],
		visibleEntryCount: 0,
		numbers: [],
		numberCount: 0,
		requestRender: NOOP_LAYOUT_REQUEST_RENDER,
		primaryScrollView: undefined,
		primaryDocumentLineCount: undefined,
		screen: [],
		previousFullWidthSources: [],
		previousFullWidthLines: [],
		previousFullWidthModes: new Uint8Array(0),
		currentFullWidthSources: [],
		currentFullWidthLines: [],
		currentFullWidthModes: new Uint8Array(0),
		previousCachedSourceCodeUnits: 0,
		previousCachedPaintedCodeUnits: 0,
		previousCachedCodeUnits: 0,
		currentCachedSourceCodeUnits: 0,
		currentCachedPaintedCodeUnits: 0,
		currentCachedCodeUnits: 0,
		rowCacheEnabled: false,
		layoutNodesVisited: 0,
		layoutBoxObjects: 0,
		layoutRectObjects: 0,
		clipObjects: 0,
		screenArraysCreated: 0,
		fullViewportArrayCopies: 0,
		stringRepeatCalls: 0,
		stringRepeatBytes: 0,
		paintBoxCalls: 0,
		childRenderCalls: 0,
		fullWidthRowCacheHits: 0,
		renderCacheLookupProbes: 0,
		renderCacheRecordCount: 0,
		renderCacheIndexActivations: 0,
		maximumCachedRowCodeUnits: 0,
		rowCacheRejectedBySize: 0,
	};
	private screenA: string[] = [];
	private screenB: string[] = [];
	private sourceA: Array<string | undefined> = [];
	private sourceB: Array<string | undefined> = [];
	private cachedLineA: Array<string | undefined> = [];
	private cachedLineB: Array<string | undefined> = [];
	private modeA = new Uint8Array(0);
	private modeB = new Uint8Array(0);
	private sourceCodeUnitsA = 0;
	private sourceCodeUnitsB = 0;
	private paintedCodeUnitsA = 0;
	private paintedCodeUnitsB = 0;
	private nextBufferA = true;
	private previousWidth = 0;
	private previousHeight = 0;
	private inUse = false;

	begin(width: number, height: number, requestRender: () => void): LayoutContext | undefined {
		if (this.inUse) return undefined;
		this.inUse = true;
		const context = this.context;
		context.viewportWidth = width;
		context.viewportHeight = height;
		context.visibleViewport = undefined;
		context.requestRender = requestRender;
		context.primaryScrollView = undefined;
		context.primaryDocumentLineCount = undefined;
		context.renderCount = 0;
		context.renderCacheIndexActive = false;
		context.visibleEntryCount = 0;
		context.numberCount = 0;
		context.layoutNodesVisited = 0;
		context.layoutBoxObjects = 0;
		context.layoutRectObjects = 0;
		context.clipObjects = 0;
		context.screenArraysCreated = 0;
		context.fullViewportArrayCopies = 0;
		context.stringRepeatCalls = 0;
		context.stringRepeatBytes = 0;
		context.paintBoxCalls = 0;
		context.childRenderCalls = 0;
		context.fullWidthRowCacheHits = 0;
		context.renderCacheLookupProbes = 0;
		context.renderCacheRecordCount = 0;
		context.renderCacheIndexActivations = 0;
		context.maximumCachedRowCodeUnits = 0;
		context.rowCacheRejectedBySize = 0;

		if (height > MAX_RETAINED_LAYOUT_ROWS) {
			context.screen = new Array<string>(height);
			context.screenArraysCreated = 1;
			context.previousFullWidthSources = EMPTY_OPTIONAL_LINES;
			context.previousFullWidthLines = EMPTY_OPTIONAL_LINES;
			context.previousFullWidthModes = EMPTY_ROW_MODES;
			context.currentFullWidthSources = EMPTY_OPTIONAL_LINES;
			context.currentFullWidthLines = EMPTY_OPTIONAL_LINES;
			context.currentFullWidthModes = EMPTY_ROW_MODES;
			context.previousCachedSourceCodeUnits = 0;
			context.previousCachedPaintedCodeUnits = 0;
			context.previousCachedCodeUnits = 0;
			context.currentCachedSourceCodeUnits = 0;
			context.currentCachedPaintedCodeUnits = 0;
			context.currentCachedCodeUnits = 0;
			context.rowCacheEnabled = false;
		} else {
			this.ensureRowCapacity(height);
			context.screen = this.nextBufferA ? this.screenA : this.screenB;
			context.currentFullWidthSources = this.nextBufferA ? this.sourceA : this.sourceB;
			context.currentFullWidthLines = this.nextBufferA ? this.cachedLineA : this.cachedLineB;
			context.currentFullWidthModes = this.nextBufferA ? this.modeA : this.modeB;
			context.previousFullWidthSources = this.nextBufferA ? this.sourceB : this.sourceA;
			context.previousFullWidthLines = this.nextBufferA ? this.cachedLineB : this.cachedLineA;
			context.previousFullWidthModes = this.nextBufferA ? this.modeB : this.modeA;
			context.previousCachedSourceCodeUnits = this.nextBufferA ? this.sourceCodeUnitsB : this.sourceCodeUnitsA;
			context.previousCachedPaintedCodeUnits = this.nextBufferA
				? this.paintedCodeUnitsB
				: this.paintedCodeUnitsA;
			context.previousCachedCodeUnits =
				context.previousCachedSourceCodeUnits + context.previousCachedPaintedCodeUnits;
			context.currentCachedSourceCodeUnits = 0;
			context.currentCachedPaintedCodeUnits = 0;
			context.currentCachedCodeUnits = 0;
			if (this.nextBufferA) {
				this.sourceCodeUnitsA = 0;
				this.paintedCodeUnitsA = 0;
			} else {
				this.sourceCodeUnitsB = 0;
				this.paintedCodeUnitsB = 0;
			}
			context.rowCacheEnabled = this.previousWidth === width && this.previousHeight === height;
			this.clearCurrentRows(context, height);
		}
		for (let row = 0; row < height; row++) context.screen[row] = "";
		context.screen.length = height;
		return context;
	}

	complete(width: number, height: number): void {
		const retained = height <= MAX_RETAINED_LAYOUT_ROWS;
		if (retained) {
			if (this.nextBufferA) {
				this.sourceCodeUnitsA = this.context.currentCachedSourceCodeUnits;
				this.paintedCodeUnitsA = this.context.currentCachedPaintedCodeUnits;
			} else {
				this.sourceCodeUnitsB = this.context.currentCachedSourceCodeUnits;
				this.paintedCodeUnitsB = this.context.currentCachedPaintedCodeUnits;
			}
		}
		this.releaseTransientReferences();
		if (retained) {
			this.previousWidth = width;
			this.previousHeight = height;
			this.nextBufferA = !this.nextBufferA;
		} else {
			this.previousWidth = 0;
			this.previousHeight = 0;
		}
		this.inUse = false;
	}

	abort(): void {
		const context = this.context;
		this.screenA.length = 0;
		this.screenB.length = 0;
		this.sourceA.length = 0;
		this.sourceB.length = 0;
		this.cachedLineA.length = 0;
		this.cachedLineB.length = 0;
		this.modeA.fill(0);
		this.modeB.fill(0);
		context.currentCachedSourceCodeUnits = 0;
		context.currentCachedPaintedCodeUnits = 0;
		context.currentCachedCodeUnits = 0;
		this.sourceCodeUnitsA = 0;
		this.sourceCodeUnitsB = 0;
		this.paintedCodeUnitsA = 0;
		this.paintedCodeUnitsB = 0;
		this.previousWidth = 0;
		this.previousHeight = 0;
		this.releaseTransientReferences();
		this.inUse = false;
	}

	clear(): void {
		if (this.inUse) throw new Error("Cannot clear layout scratch during render");
		this.releaseTransientReferences();
		this.screenA = [];
		this.screenB = [];
		this.sourceA = [];
		this.sourceB = [];
		this.cachedLineA = [];
		this.cachedLineB = [];
		this.modeA = new Uint8Array(0);
		this.modeB = new Uint8Array(0);
		this.sourceCodeUnitsA = 0;
		this.sourceCodeUnitsB = 0;
		this.paintedCodeUnitsA = 0;
		this.paintedCodeUnitsB = 0;
		this.previousWidth = 0;
		this.previousHeight = 0;
		this.nextBufferA = true;
		this.context.screen = [];
		this.context.previousFullWidthSources = EMPTY_OPTIONAL_LINES;
		this.context.previousFullWidthLines = EMPTY_OPTIONAL_LINES;
		this.context.previousFullWidthModes = EMPTY_ROW_MODES;
		this.context.currentFullWidthSources = EMPTY_OPTIONAL_LINES;
		this.context.currentFullWidthLines = EMPTY_OPTIONAL_LINES;
		this.context.currentFullWidthModes = EMPTY_ROW_MODES;
		this.context.previousCachedSourceCodeUnits = 0;
		this.context.previousCachedPaintedCodeUnits = 0;
		this.context.previousCachedCodeUnits = 0;
		this.context.currentCachedSourceCodeUnits = 0;
		this.context.currentCachedPaintedCodeUnits = 0;
		this.context.currentCachedCodeUnits = 0;
		this.context.rowCacheEnabled = false;
	}

	getRetainedReferenceCounts(): {
		components: number;
		lines: number;
		sources: number;
		cachedRows: number;
		sourceCodeUnits: number;
		paintedCodeUnits: number;
		maximumRowCodeUnits: number;
		indexedComponents: number;
		screenRows: number;
		screenCodeUnits: number;
	} {
		let components = 0;
		let lines = 0;
		let sources = 0;
		let cachedRows = 0;
		let sourceCodeUnits = 0;
		let paintedCodeUnits = 0;
		let maximumRowCodeUnits = 0;
		let screenRows = 0;
		let screenCodeUnits = 0;
		for (let index = 0; index < this.context.renderComponents.length; index++) {
			if (this.context.renderComponents[index] !== undefined) components++;
			if (this.context.renderLines[index] !== undefined) lines++;
		}
		const rowCount = Math.max(this.sourceA.length, this.sourceB.length);
		for (let index = 0; index < rowCount; index++) {
			const sourceA = this.sourceA[index];
			const sourceB = this.sourceB[index];
			const lineA = this.cachedLineA[index];
			const lineB = this.cachedLineB[index];
			if (sourceA !== undefined) {
				sources++;
				sourceCodeUnits += sourceA.length;
			}
			if (sourceB !== undefined) {
				sources++;
				sourceCodeUnits += sourceB.length;
			}
			if (lineA !== undefined) {
				cachedRows++;
				paintedCodeUnits += lineA.length;
			}
			if (lineB !== undefined) {
				cachedRows++;
				paintedCodeUnits += lineB.length;
			}
			const rowA = (sourceA?.length ?? 0) + (lineA?.length ?? 0);
			const rowB = (sourceB?.length ?? 0) + (lineB?.length ?? 0);
			if (rowA > maximumRowCodeUnits) maximumRowCodeUnits = rowA;
			if (rowB > maximumRowCodeUnits) maximumRowCodeUnits = rowB;
		}
		const screenCount = Math.max(this.screenA.length, this.screenB.length);
		for (let index = 0; index < screenCount; index++) {
			const lineA = this.screenA[index];
			const lineB = this.screenB[index];
			if (lineA !== undefined) {
				screenRows++;
				screenCodeUnits += lineA.length;
			}
			if (lineB !== undefined) {
				screenRows++;
				screenCodeUnits += lineB.length;
			}
		}
		return {
			components,
			lines,
			sources,
			cachedRows,
			sourceCodeUnits,
			paintedCodeUnits,
			maximumRowCodeUnits,
			indexedComponents: this.context.renderCacheIndex?.size ?? 0,
			screenRows,
			screenCodeUnits,
		};
	}

	private ensureRowCapacity(height: number): void {
		if (this.modeA.length >= height) return;
		this.modeA = new Uint8Array(height);
		this.modeB = new Uint8Array(height);
	}

	private clearCurrentRows(context: LayoutContext, height: number): void {
		const oldLength = context.currentFullWidthSources.length;
		for (let row = 0; row < oldLength; row++) {
			context.currentFullWidthSources[row] = undefined;
			context.currentFullWidthLines[row] = undefined;
		}
		context.currentFullWidthSources.length = height;
		context.currentFullWidthLines.length = height;
		context.currentFullWidthModes.fill(0, 0, height);
	}

	private releaseTransientReferences(): void {
		const context = this.context;
		const renderCapacity = context.renderComponents.length;
		const entryCapacity = context.visibleEntries.length;
		const numberCapacity = context.numbers.length;
		context.renderCacheIndex?.clear();
		context.renderCacheIndexActive = false;
		if (renderCapacity > MAX_RETAINED_LAYOUT_RECORDS) {
			context.renderComponents = [];
			context.renderWidths = [];
			context.renderLines = [];
			context.renderPreviousIndexes = [];
			context.renderCacheIndex = undefined;
		} else {
			context.renderComponents.length = 0;
			context.renderWidths.length = 0;
			context.renderLines.length = 0;
			context.renderPreviousIndexes.length = 0;
		}
		if (entryCapacity > MAX_RETAINED_LAYOUT_RECORDS) context.visibleEntries = [];
		else context.visibleEntries.length = 0;
		if (numberCapacity > MAX_RETAINED_LAYOUT_RECORDS * 3) context.numbers = [];
		else context.numbers.length = 0;
		context.renderCount = 0;
		context.visibleEntryCount = 0;
		context.numberCount = 0;
		context.requestRender = NOOP_LAYOUT_REQUEST_RENDER;
		context.primaryScrollView = undefined;
		context.visibleViewport = undefined;
	}
}

const EMPTY_OPTIONAL_LINES: Array<string | undefined> = [];
const EMPTY_ROW_MODES = new Uint8Array(0);
function NOOP_LAYOUT_REQUEST_RENDER(): void {}

function createRect(context: LayoutContext, x: number, y: number, width: number, height: number): LayoutRect {
	context.layoutRectObjects++;
	return { x, y, width, height };
}

function intersect(context: LayoutContext, a: LayoutRect, b: LayoutRect): LayoutRect {
	const x = Math.max(a.x, b.x);
	const y = Math.max(a.y, b.y);
	const right = Math.min(a.x + a.width, b.x + b.width);
	const bottom = Math.min(a.y + a.height, b.y + b.height);
	context.layoutRectObjects++;
	context.clipObjects++;
	return { x, y, width: Math.max(0, right - x), height: Math.max(0, bottom - y) };
}

function getVisibleViewport(context: LayoutContext): LayoutViewport {
	let viewport = context.visibleViewport;
	if (viewport === undefined) {
		viewport = { width: context.viewportWidth, height: context.viewportHeight };
		context.visibleViewport = viewport;
	}
	return viewport;
}

function activateRenderCacheIndex(context: LayoutContext): void {
	let cacheIndex = context.renderCacheIndex;
	if (cacheIndex === undefined) {
		cacheIndex = new Map<Component, number>();
		context.renderCacheIndex = cacheIndex;
	}
	context.renderCacheIndexActive = true;
	context.renderCacheIndexActivations++;
	for (let index = 0; index < context.renderCount; index++) {
		const component = context.renderComponents[index]!;
		const previous = cacheIndex.get(component);
		context.renderPreviousIndexes[index] = previous ?? -1;
		cacheIndex.set(component, index);
	}
}

function renderCached(context: LayoutContext, component: Component, width: number): string[] {
	const safeWidth = Math.max(1, Math.floor(width));
	let lookupProbes = 0;
	if (!context.renderCacheIndexActive && context.renderCount >= RENDER_CACHE_LINEAR_LIMIT) {
		activateRenderCacheIndex(context);
	}
	if (context.renderCacheIndexActive) {
		lookupProbes++;
		let index = context.renderCacheIndex!.get(component);
		while (index !== undefined) {
			lookupProbes++;
			if (context.renderWidths[index] === safeWidth) {
				context.renderCacheLookupProbes += lookupProbes;
				return context.renderLines[index]!;
			}
			const previous = context.renderPreviousIndexes[index]!;
			index = previous < 0 ? undefined : previous;
		}
	} else for (let index = 0; index < context.renderCount; index++) {
		lookupProbes++;
		if (context.renderComponents[index] === component && context.renderWidths[index] === safeWidth) {
			context.renderCacheLookupProbes += lookupProbes;
			return context.renderLines[index]!;
		}
	}
	context.renderCacheLookupProbes += lookupProbes;
	const lines = component.render(safeWidth);
	const index = context.renderCount++;
	context.renderComponents[index] = component;
	context.renderWidths[index] = safeWidth;
	context.renderLines[index] = lines;
	if (context.renderCacheIndexActive) {
		const previous = context.renderCacheIndex!.get(component);
		context.renderPreviousIndexes[index] = previous ?? -1;
		context.renderCacheIndex!.set(component, index);
	}
	context.childRenderCalls++;
	context.renderCacheRecordCount = context.renderCount;
	return lines;
}

function measureHeight(context: LayoutContext, component: Component, width: number): number {
	return renderCached(context, component, width).length;
}

function measureWidth(context: LayoutContext, component: Component, width: number): number {
	const lines = renderCached(context, component, width);
	let max = 0;
	for (let index = 0; index < lines.length; index++) max = Math.max(max, visibleWidth(lines[index]!));
	return max;
}

function measureNaturalHeight(context: LayoutContext, component: Component, width: number): number {
	const safeWidth = Math.max(1, Math.floor(width));
	const node = getLayoutNode(component);
	if (node === undefined) return measureHeight(context, component, safeWidth);
	if (node.type === "scroll") {
		const contentWidth = node.state.getContentWidth(safeWidth);
		if (isLineViewportComponent(node.component)) return node.component.getContentHeight(contentWidth);
		return measureNaturalHeight(context, node.component, contentWidth);
	}
	if (node.type === "hstack") return measureHeight(context, component, safeWidth);

	const entryStart = context.visibleEntryCount;
	const numberStart = context.numberCount;
	for (let index = 0; index < node.entries.length; index++) {
		const entry = node.entries[index]!;
		if (entry.visible !== undefined && !entry.visible(getVisibleViewport(context))) continue;
		context.visibleEntries[context.visibleEntryCount++] = entry;
	}
	const entryCount = context.visibleEntryCount - entryStart;
	try {
		const intrinsicStart = context.numberCount;
		context.numberCount += entryCount;
		const sizeStart = context.numberCount;
		context.numberCount += entryCount;
		for (let index = 0; index < entryCount; index++) {
			const entry = context.visibleEntries[entryStart + index]!;
			context.numbers[intrinsicStart + index] =
				typeof entry.basis === "number"
					? entry.basis
					: measureNaturalHeight(context, entry.component, safeWidth);
		}
		allocateStackSizesInto(
			context.visibleEntries,
			entryStart,
			context.numbers,
			intrinsicStart,
			entryCount,
			undefined,
			node.gap,
			context.numbers,
			sizeStart,
		);
		let height = Math.max(0, entryCount - 1) * node.gap;
		for (let index = 0; index < entryCount; index++) height += context.numbers[sizeStart + index]!;
		return height;
	} finally {
		context.visibleEntryCount = entryStart;
		context.numberCount = numberStart;
	}
}

function translateBox(box: LayoutBox, deltaY: number): void {
	box.rect.y += deltaY;
	for (let index = 0; index < box.children.length; index++) translateBox(box.children[index]!, deltaY);
}

function updateClips(context: LayoutContext, box: LayoutBox, parentClip: LayoutRect): void {
	box.clip = intersect(context, parentClip, box.rect);
	for (let index = 0; index < box.children.length; index++) updateClips(context, box.children[index]!, box.clip);
}

function layoutComponent(
	context: LayoutContext,
	component: Component,
	x: number,
	y: number,
	width: number,
	height: number | undefined,
	clip: LayoutRect,
): LayoutBox {
	context.layoutNodesVisited++;
	const safeWidth = Math.max(1, Math.floor(width));
	const node = getLayoutNode(component);
	if (!node) {
		const lines = renderCached(context, component, safeWidth);
		const allocatedHeight = height === undefined ? lines.length : Math.max(0, Math.floor(height));
		let lineOffset = 0;
		if (lines.length > allocatedHeight && allocatedHeight > 0) {
			let cursorLine = -1;
			for (let index = 0; index < lines.length; index++) {
				if (!lines[index]!.includes(CURSOR_MARKER)) continue;
				cursorLine = index;
				break;
			}
			if (cursorLine >= allocatedHeight) lineOffset = cursorLine - allocatedHeight + 1;
		}
		const rect = createRect(context, x, y, safeWidth, allocatedHeight);
		context.layoutBoxObjects++;
		return {
			component,
			rect,
			clip: intersect(context, clip, rect),
			children: [],
			lines,
			lineOffset,
			layer: 0,
		};
	}

	if (node.type === "scroll") {
		const previousScrollTop = node.state.scrollTop;
		const contentWidth = node.state.getContentWidth(safeWidth);
		if (isLineViewportComponent(node.component)) {
			const contentHeight = node.component.getContentHeight(contentWidth);
			const viewportHeight = height === undefined ? contentHeight : Math.max(0, Math.floor(height));
			node.state.updateLayout(contentHeight, viewportHeight, context.requestRender);
			const rendered = node.component.renderViewport(contentWidth, node.state.scrollTop, viewportHeight);
			const rect = createRect(context, x, y, safeWidth, viewportHeight);
			const childRect = createRect(context, x, y - node.state.scrollTop, contentWidth, contentHeight);
			const childClip = intersect(context, clip, rect);
			context.layoutBoxObjects++;
			const childBox: LayoutBox = {
				component: node.component,
				rect: childRect,
				clip: intersect(context, childClip, childRect),
				children: [],
				lines: rendered.lines,
				lineOffset: -rendered.startLine,
				layer: 0,
			};
			const scrollView = node.state as ScrollView;
			if (node.state.primary || !context.primaryScrollView) {
				context.primaryScrollView = scrollView;
				context.primaryDocumentLineCount = contentHeight;
			}
			context.layoutBoxObjects++;
			const box: LayoutBox = {
				component,
				rect,
				clip: childClip,
				children: [childBox],
				scrollView,
				scrollContentLines: rendered.lines,
				scrollContentStart: rendered.startLine,
				scrollLeadingKittyImage: rendered.leadingKittyImage,
				layer: 0,
			};
			childBox.parent = box;
			return box;
		}
		const childBox = layoutComponent(
			context,
			node.component,
			x,
			y - previousScrollTop,
			contentWidth,
			undefined,
			clip,
		);
		const contentHeight = childBox.rect.height;
		const viewportHeight = height === undefined ? contentHeight : Math.max(0, Math.floor(height));
		node.state.updateLayout(contentHeight, viewportHeight, context.requestRender);
		translateBox(childBox, previousScrollTop - node.state.scrollTop);
		const scrollView = node.state as ScrollView;
		if (node.state.primary || !context.primaryScrollView) {
			context.primaryScrollView = scrollView;
			context.primaryDocumentLineCount = contentHeight;
		}
		const rect = createRect(context, x, y, safeWidth, viewportHeight);
		const childClip = intersect(context, clip, rect);
		context.layoutBoxObjects++;
		const box: LayoutBox = {
			component,
			rect,
			clip: childClip,
			children: [childBox],
			scrollView,
			scrollContentLines: renderCached(context, node.component, contentWidth),
			layer: 0,
		};
		childBox.parent = box;
		updateClips(context, childBox, childClip);
		return box;
	}

	const entryStart = context.visibleEntryCount;
	const numberStart = context.numberCount;
	for (let index = 0; index < node.entries.length; index++) {
		const entry = node.entries[index]!;
		if (entry.visible !== undefined && !entry.visible(getVisibleViewport(context))) continue;
		context.visibleEntries[context.visibleEntryCount++] = entry;
	}
	const entryCount = context.visibleEntryCount - entryStart;
	const gapTotal = Math.max(0, entryCount - 1) * node.gap;
	try {
		if (node.type === "vstack") {
			const intrinsicStart = context.numberCount;
			context.numberCount += entryCount;
			const sizeStart = context.numberCount;
			context.numberCount += entryCount;
			for (let index = 0; index < entryCount; index++) {
				const entry = context.visibleEntries[entryStart + index]!;
				context.numbers[intrinsicStart + index] =
					typeof entry.basis === "number"
						? entry.basis
						: measureNaturalHeight(context, entry.component, safeWidth);
			}
			allocateStackSizesInto(
				context.visibleEntries,
				entryStart,
				context.numbers,
				intrinsicStart,
				entryCount,
				height,
				node.gap,
				context.numbers,
				sizeStart,
			);
			let naturalHeight = gapTotal;
			for (let index = 0; index < entryCount; index++) naturalHeight += context.numbers[sizeStart + index]!;
			const allocatedHeight = height === undefined ? naturalHeight : Math.max(0, Math.floor(height));
			const rect = createRect(context, x, y, safeWidth, allocatedHeight);
			context.layoutBoxObjects++;
			const box: LayoutBox = {
				component,
				rect,
				clip: intersect(context, clip, rect),
				children: [],
				layer: 0,
			};
			let childY = y;
			for (let index = 0; index < entryCount; index++) {
				const entry = context.visibleEntries[entryStart + index]!;
				const childHeight = context.numbers[sizeStart + index]!;
				const child = layoutComponent(context, entry.component, x, childY, safeWidth, childHeight, box.clip);
				child.parent = box;
				box.children.push(child);
				childY += childHeight + node.gap;
			}
			return box;
		}

		const intrinsicWidthStart = context.numberCount;
		context.numberCount += entryCount;
		const widthStart = context.numberCount;
		context.numberCount += entryCount;
		const intrinsicHeightStart = context.numberCount;
		context.numberCount += entryCount;
		for (let index = 0; index < entryCount; index++) {
			const entry = context.visibleEntries[entryStart + index]!;
			context.numbers[intrinsicWidthStart + index] =
				typeof entry.basis === "number" ? entry.basis : measureWidth(context, entry.component, safeWidth);
		}
		allocateStackSizesInto(
			context.visibleEntries,
			entryStart,
			context.numbers,
			intrinsicWidthStart,
			entryCount,
			safeWidth,
			node.gap,
			context.numbers,
			widthStart,
		);
		let naturalHeight = 0;
		for (let index = 0; index < entryCount; index++) {
			const entry = context.visibleEntries[entryStart + index]!;
			const intrinsicHeight = measureNaturalHeight(
				context,
				entry.component,
				Math.max(1, context.numbers[widthStart + index]!),
			);
			context.numbers[intrinsicHeightStart + index] = intrinsicHeight;
			naturalHeight = Math.max(naturalHeight, intrinsicHeight);
		}
		const allocatedHeight = height === undefined ? naturalHeight : Math.max(0, height);
		const rect = createRect(context, x, y, safeWidth, allocatedHeight);
		context.layoutBoxObjects++;
		const box: LayoutBox = {
			component,
			rect,
			clip: intersect(context, clip, rect),
			children: [],
			layer: 0,
		};
		let childX = x;
		for (let index = 0; index < entryCount; index++) {
			const entry = context.visibleEntries[entryStart + index]!;
			const naturalChildHeight = context.numbers[intrinsicHeightStart + index]!;
			const childHeight =
				node.align === "stretch" ? allocatedHeight : Math.min(allocatedHeight, naturalChildHeight);
			let childY = y;
			if (node.align === "center") childY += Math.floor((allocatedHeight - childHeight) / 2);
			else if (node.align === "end") childY += allocatedHeight - childHeight;
			const childWidth = context.numbers[widthStart + index]!;
			if (childWidth === 0) {
				const childRect = createRect(context, childX, childY, 0, childHeight);
				const childClip = createRect(context, childX, childY, 0, 0);
				context.clipObjects++;
				context.layoutBoxObjects++;
				box.children.push({
					component: entry.component,
					rect: childRect,
					clip: childClip,
					children: [],
					parent: box,
					layer: 0,
				});
			} else {
				const child = layoutComponent(
					context,
					entry.component,
					childX,
					childY,
					childWidth,
					childHeight,
					box.clip,
				);
				child.parent = box;
				box.children.push(child);
			}
			childX += childWidth + node.gap;
		}
		return box;
	} finally {
		context.visibleEntryCount = entryStart;
		context.numberCount = numberStart;
	}
}

function repeatSpaces(context: LayoutContext, count: number): string {
	if (count <= 0) return "";
	context.stringRepeatCalls++;
	context.stringRepeatBytes += count;
	return " ".repeat(count);
}

function styleScrollbarCell(
	context: LayoutContext,
	line: string,
	column: number,
	totalWidth: number,
	style: (text: string) => string,
): string {
	if (isImageLine(line)) return line;

	const graphemeRange = getGraphemeCellRange(line, column);
	const start = graphemeRange?.start ?? column;
	const end = graphemeRange?.end ?? column + 1;
	const before = sliceByColumn(line, 0, start, true);
	const target = sliceByColumn(line, start, end - start, true);
	const after = sliceByColumn(line, end, Math.max(0, totalWidth - end), true);

	let targetPrefix = "";
	let targetIndex = 0;
	while (targetIndex < target.length) {
		const ansi = extractAnsiCode(target, targetIndex);
		if (!ansi) break;
		targetPrefix += ansi.code;
		targetIndex += ansi.length;
	}
	const targetText = target.slice(targetIndex) || repeatSpaces(context, end - start);
	const beforePadding = repeatSpaces(context, Math.max(0, start - visibleWidth(before)));
	return `${before}${beforePadding}${targetPrefix}${style(targetText)}${after}`;
}

export function getScrollbarGeometry(box: LayoutBox): ScrollbarGeometry | undefined {
	if (!box.scrollView?.isScrollbarVisible || box.rect.width <= 0 || box.rect.height <= 0) return undefined;

	const contentHeight = box.children[0]?.rect.height ?? box.scrollContentLines?.length ?? 0;
	const trackHeight = box.rect.height;

	const minThumbHeight = Math.min(2, trackHeight);
	const thumbHeight = Math.max(
		minThumbHeight,
		Math.min(trackHeight, Math.round((trackHeight * trackHeight) / contentHeight)),
	);
	const maxScrollTop = Math.max(0, contentHeight - trackHeight);
	const maxThumbTop = trackHeight - thumbHeight;
	const thumbOffset = maxScrollTop === 0 ? 0 : Math.round((box.scrollView.scrollTop / maxScrollTop) * maxThumbTop);
	const column = box.rect.x + box.rect.width - 1;
	if (column < box.clip.x || column >= box.clip.x + box.clip.width) return undefined;

	return {
		column,
		trackTop: box.rect.y,
		trackHeight,
		thumbTop: box.rect.y + thumbOffset,
		thumbHeight,
		maxScrollTop,
	};
}

function markRowUncacheable(context: LayoutContext, row: number): void {
	if (row < 0 || row >= context.currentFullWidthModes.length) return;
	const source = context.currentFullWidthSources[row];
	const painted = context.currentFullWidthLines[row];
	if (source !== undefined) {
		context.currentCachedSourceCodeUnits -= source.length;
		context.currentCachedCodeUnits -= source.length;
	}
	if (painted !== undefined) {
		context.currentCachedPaintedCodeUnits -= painted.length;
		context.currentCachedCodeUnits -= painted.length;
	}
	context.currentFullWidthModes[row] = 2;
	context.currentFullWidthSources[row] = undefined;
	context.currentFullWidthLines[row] = undefined;
}

function cacheFullWidthRow(context: LayoutContext, row: number, source: string, painted: string): boolean {
	if (row < 0 || row >= context.currentFullWidthModes.length) return false;
	const rowCodeUnits = source.length + painted.length;
	const totalCodeUnits = context.previousCachedCodeUnits + context.currentCachedCodeUnits + rowCodeUnits;
	if (rowCodeUnits > MAX_RETAINED_ROW_CODE_UNITS || totalCodeUnits > MAX_RETAINED_ROW_CACHE_CODE_UNITS) {
		context.rowCacheRejectedBySize++;
		markRowUncacheable(context, row);
		return false;
	}
	if (context.currentFullWidthModes[row] !== 0) markRowUncacheable(context, row);
	context.currentFullWidthModes[row] = 1;
	context.currentFullWidthSources[row] = source;
	context.currentFullWidthLines[row] = painted;
	context.currentCachedSourceCodeUnits += source.length;
	context.currentCachedPaintedCodeUnits += painted.length;
	context.currentCachedCodeUnits += rowCodeUnits;
	if (rowCodeUnits > context.maximumCachedRowCodeUnits) context.maximumCachedRowCodeUnits = rowCodeUnits;
	return true;
}

function rejectRowCacheBySize(context: LayoutContext, row: number): void {
	context.rowCacheRejectedBySize++;
	markRowUncacheable(context, row);
}

function paintScrollbar(context: LayoutContext, box: LayoutBox): void {
	const geometry = getScrollbarGeometry(box);
	if (!geometry || !box.scrollView) return;
	const screen = context.screen;
	const totalWidth = context.viewportWidth;

	for (let offset = 0; offset < geometry.thumbHeight; offset++) {
		const row = geometry.thumbTop + offset;
		if (row < box.clip.y || row >= box.clip.y + box.clip.height || row < 0 || row >= screen.length) continue;
		markRowUncacheable(context, row);
		screen[row] = styleScrollbarCell(
			context,
			screen[row] ?? "",
			geometry.column,
			totalWidth,
			box.scrollView.scrollbarStyle,
		);
	}
}

function paintBox(context: LayoutContext, box: LayoutBox): void {
	context.paintBoxCalls++;
	const screen = context.screen;
	const totalWidth = context.viewportWidth;
	if (box.lines) {
		const offset = box.lineOffset ?? 0;
		const firstRow = Math.max(box.rect.y, box.clip.y, 0);
		const lastRow = Math.min(box.rect.y + box.rect.height, box.clip.y + box.clip.height, screen.length);
		for (let row = firstRow; row < lastRow; row++) {
			const sourceLine = box.lines[offset + row - box.rect.y];
			if (sourceLine === undefined) continue;
			let line = sourceLine.replace(OSC133_ZONE_PREFIX, "");
			const imageMetadata = getKittyImageMetadata(line);
			if (imageMetadata) {
				const clipBottom = Math.min(screen.length, box.clip.y + box.clip.height);
				const visibleRows = Math.min(imageMetadata.rows, clipBottom - row);
				if (visibleRows < imageMetadata.rows) line = cropKittyImageLine(line, 0, visibleRows);
			}
			if (isImageLine(line) && box.rect.x === 0 && box.rect.width >= totalWidth) {
				markRowUncacheable(context, row);
				screen[row] = line;
			} else if (screen[row] === "" && box.rect.x === 0 && box.rect.width === totalWidth && !line.includes("\t")) {
				const sourceExceedsRowCache = line.length > MAX_RETAINED_ROW_CODE_UNITS;
				const reusable =
					context.rowCacheEnabled &&
					context.previousFullWidthModes[row] === 1 &&
					context.previousFullWidthSources[row] === line;
				if (reusable) {
					const cached = context.previousFullWidthLines[row];
					if (cached !== undefined) {
						screen[row] = cached;
						context.fullWidthRowCacheHits++;
						cacheFullWidthRow(context, row, line, cached);
						continue;
					}
				}
				const lineWidth = visibleWidth(line);
				if (lineWidth <= totalWidth) {
					const painted =
						FULL_WIDTH_LINE_RESET + line + repeatSpaces(context, totalWidth - lineWidth) + FULL_WIDTH_LINE_RESET;
					screen[row] = painted;
					if (sourceExceedsRowCache) rejectRowCacheBySize(context, row);
					else cacheFullWidthRow(context, row, line, painted);
				} else {
					if (sourceExceedsRowCache) rejectRowCacheBySize(context, row);
					else markRowUncacheable(context, row);
					screen[row] = compositeTuiLine("", line, 0, totalWidth, totalWidth);
				}
			} else {
				markRowUncacheable(context, row);
				screen[row] = compositeTuiLine(screen[row] ?? "", line, box.rect.x, box.rect.width, totalWidth);
			}
		}
	}
	for (let index = 0; index < box.children.length; index++) paintBox(context, box.children[index]!);

	if (box.scrollView && box.scrollContentLines && box.scrollView.scrollTop > 0 && box.rect.height > 0) {
		const leadingKittyImage = box.scrollLeadingKittyImage;
		if (leadingKittyImage && leadingKittyImage.absoluteRow < box.scrollView.scrollTop) {
			const metadata = getKittyImageMetadata(leadingKittyImage.line);
			const hiddenRows = box.scrollView.scrollTop - leadingKittyImage.absoluteRow;
			if (metadata && hiddenRows < metadata.rows) {
				const visibleRows = Math.min(box.rect.height, metadata.rows - hiddenRows);
				const cropped = cropKittyImageLine(leadingKittyImage.line, hiddenRows, visibleRows);
				if (box.rect.x === 0 && box.rect.width >= totalWidth) {
					markRowUncacheable(context, box.rect.y);
					screen[box.rect.y] = cropped;
				}
			}
			paintScrollbar(context, box);
			return;
		}
		for (let imageRow = box.scrollView.scrollTop - 1; imageRow >= 0; imageRow--) {
			const relativeImageRow = imageRow - (box.scrollContentStart ?? 0);
			if (relativeImageRow < 0) break;
			const imageLine = box.scrollContentLines[relativeImageRow] ?? "";
			const metadata = getKittyImageMetadata(imageLine);
			if (metadata) {
				const hiddenRows = box.scrollView.scrollTop - imageRow;
				if (hiddenRows < metadata.rows) {
					const visibleRows = Math.min(box.rect.height, metadata.rows - hiddenRows);
					const cropped = cropKittyImageLine(imageLine, hiddenRows, visibleRows);
					if (box.rect.x === 0 && box.rect.width >= totalWidth) {
						markRowUncacheable(context, box.rect.y);
						screen[box.rect.y] = cropped;
					}
				}
				break;
			}
			if (imageLine !== "") break;
		}
	}

	paintScrollbar(context, box);
}

export function renderLayoutFrame(
	root: Component,
	width: number,
	height: number,
	requestRender: () => void,
	scratch?: LayoutFrameScratch,
): LayoutFrame {
	const safeWidth = Math.max(1, Math.floor(width));
	const safeHeight = Math.max(1, Math.floor(height));
	let activeScratch = scratch;
	let context = activeScratch?.begin(safeWidth, safeHeight, requestRender);
	if (context === undefined) {
		activeScratch = new LayoutFrameScratch();
		context = activeScratch.begin(safeWidth, safeHeight, requestRender)!;
	}
	let completed = false;
	try {
		const rootClip = createRect(context, 0, 0, safeWidth, safeHeight);
		const rootBox = layoutComponent(context, root, 0, 0, safeWidth, safeHeight, rootClip);
		paintBox(context, rootBox);
		const frame: LayoutFrame = {
			root: rootBox,
			width: safeWidth,
			height: safeHeight,
			generatedLineCount: context.primaryDocumentLineCount ?? rootBox.rect.height,
			lines: context.screen,
			layoutNodesVisited: context.layoutNodesVisited,
			layoutBoxObjects: context.layoutBoxObjects,
			layoutRectObjects: context.layoutRectObjects,
			clipObjects: context.clipObjects,
			screenArraysCreated: context.screenArraysCreated,
			fullViewportArrayCopies: context.fullViewportArrayCopies,
			stringRepeatCalls: context.stringRepeatCalls,
			stringRepeatBytes: context.stringRepeatBytes,
			paintBoxCalls: context.paintBoxCalls,
			childRenderCalls: context.childRenderCalls,
			fullWidthRowCacheHits: context.fullWidthRowCacheHits,
			renderCacheLookupProbes: context.renderCacheLookupProbes,
			renderCacheRecordCount: context.renderCacheRecordCount,
			renderCacheIndexActivations: context.renderCacheIndexActivations,
			cachedSourceCodeUnits:
				context.previousCachedSourceCodeUnits + context.currentCachedSourceCodeUnits,
			cachedPaintedCodeUnits:
				context.previousCachedPaintedCodeUnits + context.currentCachedPaintedCodeUnits,
			maximumCachedRowCodeUnits: context.maximumCachedRowCodeUnits,
			rowCacheRejectedBySize: context.rowCacheRejectedBySize,
		};
		if (context.primaryScrollView !== undefined) frame.primaryScrollView = context.primaryScrollView;
		activeScratch!.complete(safeWidth, safeHeight);
		completed = true;
		return frame;
	} finally {
		if (!completed) activeScratch!.abort();
	}
}

function containsPoint(rect: LayoutRect, x: number, y: number): boolean {
	return x >= rect.x && x < rect.x + rect.width && y >= rect.y && y < rect.y + rect.height;
}

export function getScrollViewBox(frame: LayoutFrame, scrollView: ScrollView): LayoutBox | undefined {
	const visit = (box: LayoutBox): LayoutBox | undefined => {
		if (box.scrollView === scrollView) return box;
		for (const child of box.children) {
			const match = visit(child);
			if (match) return match;
		}
		return undefined;
	};
	return visit(frame.root);
}

export function getScrollViewsAt(frame: LayoutFrame, x: number, y: number): ScrollView[] {
	const result: Array<{ scrollView: ScrollView; depth: number }> = [];
	const visit = (box: LayoutBox, depth: number): void => {
		if (!containsPoint(box.clip, x, y)) return;
		if (box.scrollView && containsPoint(box.rect, x, y)) result.push({ scrollView: box.scrollView, depth });
		for (const child of box.children) visit(child, depth + 1);
	};
	visit(frame.root, 0);
	result.sort((a, b) => b.depth - a.depth);
	return result.map((entry) => entry.scrollView);
}
