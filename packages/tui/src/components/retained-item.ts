import { TuiRenderInstrumentation, utf8ByteLength } from "../render-instrumentation.ts";
import { getKittyImageMetadata } from "../terminal-image.ts";
import { type Component, Container } from "../tui.ts";
import { LINE_VIEWPORT_COMPONENT, type LineViewportComponent } from "./viewport-container.ts";

export interface RetainedRenderContext {
	themeVersion: number;
	rendererVersion: number;
	expandVersion: number;
	settingsVersion: number;
}

const DEFAULT_CONTEXT: Readonly<RetainedRenderContext> = Object.freeze({
	themeVersion: 0,
	rendererVersion: 0,
	expandVersion: 0,
	settingsVersion: 0,
});

export interface RetainedItemOptions {
	id: string;
	version: number;
	completed?: boolean;
	getContext?: () => Readonly<RetainedRenderContext>;
	instrumentation?: TuiRenderInstrumentation;
	onRenderStateChanged?: (item: RetainedItem) => void;
}

interface RetainedCacheKey extends RetainedRenderContext {
	width: number;
	version: number;
	visualGeneration: number;
}

function cacheKeysEqual(left: RetainedCacheKey | undefined, right: RetainedCacheKey): boolean {
	return (
		left !== undefined &&
		left.width === right.width &&
		left.version === right.version &&
		left.visualGeneration === right.visualGeneration &&
		left.themeVersion === right.themeVersion &&
		left.rendererVersion === right.rendererVersion &&
		left.expandVersion === right.expandVersion &&
		left.settingsVersion === right.settingsVersion
	);
}

/** Retains one completed component render and only its latest width/context. */
export class RetainedItem implements Component {
	readonly id: string;
	private inner: Component | undefined;
	private logicalVersion: number;
	private visualGeneration = 0;
	private isCompleted: boolean;
	private frozenVersion: number | undefined;
	private readonly getContext: () => Readonly<RetainedRenderContext>;
	private readonly instrumentation: TuiRenderInstrumentation | undefined;
	private readonly onRenderStateChanged: ((item: RetainedItem) => void) | undefined;
	private cacheKey: RetainedCacheKey | undefined;
	private cachedLines: string[] | undefined;
	private isReleased = false;

	constructor(component: Component, options: RetainedItemOptions) {
		if (!options.id) throw new Error("Retained item id must not be empty");
		if (!Number.isSafeInteger(options.version) || options.version < 0) {
			throw new Error("Retained item version must be a non-negative safe integer");
		}
		this.id = options.id;
		this.inner = component;
		this.logicalVersion = options.version;
		this.isCompleted = options.completed ?? false;
		this.frozenVersion = this.isCompleted ? options.version : undefined;
		this.getContext = options.getContext ?? (() => DEFAULT_CONTEXT);
		this.instrumentation = options.instrumentation;
		this.onRenderStateChanged = options.onRenderStateChanged;
	}

	get component(): Component | undefined {
		return this.inner;
	}

	get completed(): boolean {
		return this.isCompleted;
	}

	get completedVersion(): number | undefined {
		return this.frozenVersion;
	}

	get released(): boolean {
		return this.isReleased;
	}

	get cachedWidth(): number | undefined {
		return this.cacheKey?.width;
	}

	get cachedLineCount(): number {
		return this.cachedLines?.length ?? 0;
	}

	get estimatedCachedBytes(): number {
		let bytes = 0;
		if (this.cachedLines) {
			for (const line of this.cachedLines) bytes += utf8ByteLength(line);
		}
		return bytes;
	}

	updateVersion(version: number): void {
		if (this.isReleased) throw new Error(`Cannot update released retained item ${this.id}`);
		if (this.isCompleted) throw new Error(`Cannot update completed retained item ${this.id}`);
		if (!Number.isSafeInteger(version) || version < this.logicalVersion) {
			throw new Error(`Retained item ${this.id} version must increase monotonically`);
		}
		this.logicalVersion = version;
		this.onRenderStateChanged?.(this);
	}

	advanceVersion(): void {
		this.updateVersion(this.logicalVersion + 1);
	}

	complete(): void {
		if (this.isReleased) throw new Error(`Cannot complete released retained item ${this.id}`);
		if (this.isCompleted) return;
		this.isCompleted = true;
		this.frozenVersion = this.logicalVersion;
		this.clearCache();
		this.onRenderStateChanged?.(this);
	}

	render(width: number): string[] {
		const component = this.inner;
		if (!component || this.isReleased) throw new Error(`Cannot render released retained item ${this.id}`);
		if (!this.isCompleted) {
			const lines = component.render(width);
			this.instrumentation?.recordTranscriptItemRender(false, lines.length);
			return lines;
		}

		const context = this.getContext();
		const nextKey: RetainedCacheKey = {
			width,
			version: this.logicalVersion,
			visualGeneration: this.visualGeneration,
			themeVersion: context.themeVersion,
			rendererVersion: context.rendererVersion,
			expandVersion: context.expandVersion,
			settingsVersion: context.settingsVersion,
		};
		if (cacheKeysEqual(this.cacheKey, nextKey) && this.cachedLines) {
			this.instrumentation?.recordRetainedCacheHit();
			return this.cachedLines;
		}

		const lines = component.render(width);
		this.cacheKey = nextKey;
		this.cachedLines = lines;
		this.instrumentation?.recordRetainedCacheMiss();
		this.instrumentation?.recordTranscriptItemRender(true, lines.length);
		return lines;
	}

	invalidate(): void {
		if (this.isReleased) return;
		this.invalidateRetainedRender();
		this.inner?.invalidate();
	}

	/** Invalidates only retained render state after the component has already updated itself. */
	invalidateRetainedRender(): void {
		if (this.isReleased) return;
		this.visualGeneration++;
		this.clearCache();
		this.onRenderStateChanged?.(this);
	}

	release(): void {
		if (this.isReleased) return;
		this.clearCache();
		this.inner = undefined;
		this.isReleased = true;
	}

	private clearCache(): void {
		this.cacheKey = undefined;
		this.cachedLines = undefined;
	}
}

export interface RetainedContainerOptions {
	getContext?: () => Readonly<RetainedRenderContext>;
	instrumentation?: TuiRenderInstrumentation;
}

export interface RetainedContainerStats {
	retainedItems: number;
	completedItems: number;
	activeItems: number;
	cachedItems: number;
	cachedLines: number;
	estimatedCachedBytes: number;
}

export interface RetainedViewportRender {
	/** Lines intersecting the requested range. */
	lines: string[];
	/** Absolute document line represented by lines[0]. */
	startLine: number;
	totalHeight: number;
	/** Number of item records touched while locating and composing this viewport. */
	visitedItems: number;
	/** Number of item heights refreshed before composing this viewport. */
	measuredItems: number;
	/** Number of per-item height reads used to locate the requested range. */
	targetHeightLookupProbes: number;
	/** Number of cumulative height blocks read to locate the requested range. */
	blockLookupProbes: number;
	/** Number of line references copied into this result. */
	copiedLines: number;
	leadingKittyImage?: { line: string; absoluteRow: number };
}

export interface RetainedViewportIndexStats {
	indexedItems: number;
	heightBlocks: number;
	dirtyItems: number;
	totalHeight: number;
	width: number | undefined;
}

interface RetainedViewportRecord {
	component: Component;
	retained: RetainedItem | undefined;
	height: number;
	index: number;
	preparedLines?: string[];
	/** Flat [start, rows, ...] pairs for Kitty blocks in this item's cached render. */
	kittySpans?: number[];
	kittySpanLines?: readonly string[];
}

const VIEWPORT_HEIGHT_BLOCK_SIZE = 256;

/** Container with session-local ownership and cleanup for retained children. */
export class RetainedContainer extends Container implements LineViewportComponent {
	readonly [LINE_VIEWPORT_COMPONENT] = true as const;
	private readonly retainedById = new Map<string, RetainedItem>();
	private readonly retainedByComponent = new Map<Component, RetainedItem>();
	private readonly options: RetainedContainerOptions;
	private viewportRecords: RetainedViewportRecord[] = [];
	private readonly viewportRecordByComponent = new Map<Component, RetainedViewportRecord>();
	private readonly dirtyViewportRecords = new Set<RetainedViewportRecord>();
	private viewportBlockHeights: number[] = [];
	private viewportTotalHeight = 0;
	private viewportWidth: number | undefined;
	private viewportStructureDirty = false;
	private viewportMeasuredItems = 0;
	private readonly retainedRenderStateChanged = (item: RetainedItem): void => {
		const component = item.component;
		if (!component) return;
		const record = this.viewportRecordByComponent.get(component);
		if (record) this.dirtyViewportRecords.add(record);
	};

	constructor(options: RetainedContainerOptions = {}) {
		super();
		this.options = options;
	}

	override addChild(component: Component): void {
		super.addChild(component);
		this.appendViewportRecord(component, this.retainedByComponent.get(component));
	}

	addRetainedChild(component: Component, options: Omit<RetainedItemOptions, "getContext" | "instrumentation">): RetainedItem {
		this.assertCanRetain(component, options.id);
		const item = this.createRetainedItem(component, options);
		super.addChild(component);
		this.recordRetainedItem(component, item);
		this.appendViewportRecord(component, item);
		return item;
	}

	retainChild(component: Component, options: Omit<RetainedItemOptions, "getContext" | "instrumentation">): RetainedItem {
		if (!this.children.includes(component)) throw new Error("Cannot retain a component outside this container");
		this.assertCanRetain(component, options.id);
		const item = this.createRetainedItem(component, options);
		this.recordRetainedItem(component, item);
		const record = this.viewportRecordByComponent.get(component);
		if (record) {
			record.retained = item;
			this.dirtyViewportRecords.add(record);
		} else {
			this.viewportStructureDirty = true;
		}
		return item;
	}

	private createRetainedItem(
		component: Component,
		options: Omit<RetainedItemOptions, "getContext" | "instrumentation">,
	): RetainedItem {
		return new RetainedItem(component, {
			...options,
			getContext: this.options.getContext,
			instrumentation: this.options.instrumentation,
			onRenderStateChanged: this.retainedRenderStateChanged,
		});
	}

	private recordRetainedItem(component: Component, item: RetainedItem): void {
		this.retainedById.set(item.id, item);
		this.retainedByComponent.set(component, item);
	}

	private assertCanRetain(component: Component, id: string): void {
		if (this.retainedById.has(id)) throw new Error(`Duplicate retained item id: ${id}`);
		if (this.retainedByComponent.has(component)) throw new Error("Component already has retained state");
	}

	getRetainedItem(component: Component): RetainedItem | undefined {
		return this.retainedByComponent.get(component);
	}

	/** Invalidates one child's sidecar cache without propagating back into the component. */
	invalidateRetainedChild(component: Component): boolean {
		const item = this.retainedByComponent.get(component);
		if (!item) return false;
		item.invalidateRetainedRender();
		return true;
	}

	/** Marks a dynamic plain or retained child for one targeted height refresh. */
	invalidateViewportChild(component: Component): boolean {
		this.ensureViewportStructure();
		const record = this.viewportRecordByComponent.get(component);
		if (!record) return false;
		this.dirtyViewportRecords.add(record);
		return true;
	}

	/** Invalidates height metadata at a presentation boundary without re-invalidating child renderers. */
	invalidateViewportHeights(): void {
		this.ensureViewportStructure();
		for (const record of this.viewportRecords) this.dirtyViewportRecords.add(record);
	}

	getRetainedStats(): Readonly<RetainedContainerStats> {
		let completedItems = 0;
		let cachedItems = 0;
		let cachedLines = 0;
		let estimatedCachedBytes = 0;
		for (const item of this.retainedById.values()) {
			if (item.completed) completedItems++;
			if (item.cachedLineCount > 0) cachedItems++;
			cachedLines += item.cachedLineCount;
			estimatedCachedBytes += item.estimatedCachedBytes;
		}
		return Object.freeze({
			retainedItems: this.retainedById.size,
			completedItems,
			activeItems: this.retainedById.size - completedItems,
			cachedItems,
			cachedLines,
			estimatedCachedBytes,
		});
	}

	/** Marks direct children splice/replacement operations for one boundary rebuild. */
	notifyChildrenChanged(): void {
		this.viewportStructureDirty = true;
	}

	getContentHeight(width: number): number {
		this.prepareViewportIndex(width);
		return this.totalViewportHeight();
	}

	getViewportIndexStats(): Readonly<RetainedViewportIndexStats> {
		this.ensureViewportStructure();
		return Object.freeze({
			indexedItems: this.viewportRecords.length,
			heightBlocks: this.viewportBlockHeights.length,
			dirtyItems: this.dirtyViewportRecords.size,
			totalHeight: this.totalViewportHeight(),
			width: this.viewportWidth,
		});
	}

	renderViewport(width: number, startLine: number, height: number): RetainedViewportRender {
		this.prepareViewportIndex(width);
		const totalHeight = this.totalViewportHeight();
		const safeHeight = Math.max(0, Math.floor(height));
		const requestedStart = Math.max(0, Math.min(totalHeight, Math.floor(startLine)));
		if (safeHeight === 0 || requestedStart >= totalHeight) {
			this.options.instrumentation?.recordTranscriptViewport(0, 0);
			return {
				lines: [],
				startLine: requestedStart,
				totalHeight,
				visitedItems: 0,
				measuredItems: this.viewportMeasuredItems,
				targetHeightLookupProbes: 0,
				blockLookupProbes: 0,
				copiedLines: 0,
			};
		}
		const located = this.locateViewportLine(requestedStart);
		return this.composeViewport(
			width,
			located.index,
			located.itemStart,
			requestedStart,
			requestedStart + safeHeight,
			located.targetHeightLookupProbes,
			located.blockLookupProbes,
		);
	}

	renderViewportTail(width: number, height: number): RetainedViewportRender {
		this.prepareViewportIndex(width);
		const totalHeight = this.totalViewportHeight();
		const safeHeight = Math.max(0, Math.floor(height));
		const requestedStart = Math.max(0, totalHeight - safeHeight);
		if (safeHeight === 0 || totalHeight === 0) {
			this.options.instrumentation?.recordTranscriptViewport(0, 0);
			return {
				lines: [],
				startLine: requestedStart,
				totalHeight,
				visitedItems: 0,
				measuredItems: this.viewportMeasuredItems,
				targetHeightLookupProbes: 0,
				blockLookupProbes: 0,
				copiedLines: 0,
			};
		}
		let index = this.viewportRecords.length - 1;
		let itemStart = totalHeight;
		let targetHeightLookupProbes = 0;
		while (index >= 0) {
			const record = this.viewportRecords[index];
			itemStart -= record.height;
			targetHeightLookupProbes++;
			if (itemStart <= requestedStart) break;
			index--;
		}
		return this.composeViewport(
			width,
			Math.max(0, index),
			Math.max(0, itemStart),
			requestedStart,
			totalHeight,
			targetHeightLookupProbes,
			0,
		);
	}

	override render(width: number): string[] {
		this.ensureViewportStructure();
		const safeWidth = Math.max(1, Math.floor(width));
		this.viewportWidth = safeWidth;
		this.dirtyViewportRecords.clear();
		const lines: string[] = [];
		for (const record of this.viewportRecords) {
			const childLines = this.renderViewportRecord(record, safeWidth);
			record.height = childLines.length;
			for (const line of childLines) lines.push(line);
		}
		this.rebuildViewportBlockHeights();
		return lines;
	}

	override invalidate(): void {
		this.ensureViewportStructure();
		for (const record of this.viewportRecords) {
			const child = record.component;
			const retained = record.retained;
			this.dirtyViewportRecords.add(record);
			if (retained) retained.invalidate();
			else child.invalidate();
		}
	}

	override removeChild(component: Component): void {
		const index = this.children.indexOf(component);
		if (index < 0) return;
		const removed = this.children[index];
		this.children.splice(index, 1);
		this.removeViewportRecord(removed);
		const retained = this.retainedByComponent.get(removed);
		if (retained) {
			this.retainedByComponent.delete(removed);
			this.retainedById.delete(retained.id);
			retained.release();
		}
	}

	override clear(): void {
		for (const item of this.retainedById.values()) item.release();
		this.retainedById.clear();
		this.retainedByComponent.clear();
		this.viewportRecords = [];
		this.viewportRecordByComponent.clear();
		this.dirtyViewportRecords.clear();
		this.viewportBlockHeights = [];
		this.viewportTotalHeight = 0;
		this.viewportWidth = undefined;
		this.viewportStructureDirty = false;
		super.clear();
	}

	private appendViewportRecord(component: Component, retained: RetainedItem | undefined): void {
		if (this.viewportStructureDirty) return;
		const record: RetainedViewportRecord = { component, retained, height: 0, index: this.viewportRecords.length };
		this.viewportRecords.push(record);
		this.viewportRecordByComponent.set(component, record);
		this.dirtyViewportRecords.add(record);
		const blockIndex = Math.floor((this.viewportRecords.length - 1) / VIEWPORT_HEIGHT_BLOCK_SIZE);
		this.viewportBlockHeights[blockIndex] ??= 0;
	}

	private removeViewportRecord(component: Component): void {
		if (this.viewportStructureDirty) return;
		const record = this.viewportRecordByComponent.get(component);
		if (!record) {
			this.viewportStructureDirty = true;
			return;
		}
		const index = this.viewportRecords.indexOf(record);
		if (index < 0) {
			this.viewportStructureDirty = true;
			return;
		}
		this.viewportRecords.splice(index, 1);
		for (let nextIndex = index; nextIndex < this.viewportRecords.length; nextIndex++) {
			this.viewportRecords[nextIndex].index = nextIndex;
		}
		this.viewportRecordByComponent.delete(component);
		this.dirtyViewportRecords.delete(record);
		this.rebuildViewportBlockHeights();
	}

	private ensureViewportStructure(): void {
		if (!this.viewportStructureDirty && this.viewportRecords.length === this.children.length) return;
		this.viewportRecords = [];
		this.viewportRecordByComponent.clear();
		this.dirtyViewportRecords.clear();
		this.viewportBlockHeights = [];
		this.viewportTotalHeight = 0;
		for (const component of this.children) {
			const record: RetainedViewportRecord = {
				component,
				retained: this.retainedByComponent.get(component),
				height: 0,
				index: this.viewportRecords.length,
			};
			this.viewportRecords.push(record);
			this.viewportRecordByComponent.set(component, record);
			this.dirtyViewportRecords.add(record);
		}
		this.viewportWidth = undefined;
		this.viewportStructureDirty = false;
		this.rebuildViewportBlockHeights();
	}

	private prepareViewportIndex(width: number): void {
		this.ensureViewportStructure();
		const safeWidth = Math.max(1, Math.floor(width));
		this.viewportMeasuredItems = 0;
		if (this.viewportWidth !== safeWidth) {
			this.viewportWidth = safeWidth;
			this.dirtyViewportRecords.clear();
			for (const record of this.viewportRecords) this.measureViewportRecord(record, safeWidth, false);
			this.rebuildViewportBlockHeights();
			return;
		}
		if (this.dirtyViewportRecords.size === 0) return;
		const retainPreparedLines = this.dirtyViewportRecords.size <= VIEWPORT_HEIGHT_BLOCK_SIZE;
		for (const record of this.dirtyViewportRecords) {
			if (this.viewportRecordByComponent.get(record.component) !== record) continue;
			this.measureViewportRecord(record, safeWidth, retainPreparedLines);
		}
		this.dirtyViewportRecords.clear();
	}

	private measureViewportRecord(record: RetainedViewportRecord, width: number, retainPreparedLines: boolean): void {
		const previousHeight = record.height;
		const lines = this.renderViewportRecord(record, width);
		record.height = lines.length;
		this.updateKittySpans(record, lines);
		record.preparedLines = retainPreparedLines ? lines : undefined;
		this.viewportMeasuredItems++;
		if (this.viewportWidth === width && previousHeight !== record.height) {
			if (this.viewportRecords[record.index] === record) {
				const blockIndex = Math.floor(record.index / VIEWPORT_HEIGHT_BLOCK_SIZE);
				this.viewportBlockHeights[blockIndex] =
					(this.viewportBlockHeights[blockIndex] ?? 0) + record.height - previousHeight;
				this.viewportTotalHeight += record.height - previousHeight;
			}
		}
	}

	private renderViewportRecord(record: RetainedViewportRecord, width: number): string[] {
		if (record.preparedLines) {
			const lines = record.preparedLines;
			record.preparedLines = undefined;
			return lines;
		}
		return record.retained ? record.retained.render(width) : record.component.render(width);
	}

	private rebuildViewportBlockHeights(): void {
		this.viewportBlockHeights = [];
		this.viewportTotalHeight = 0;
		for (let index = 0; index < this.viewportRecords.length; index++) {
			const blockIndex = Math.floor(index / VIEWPORT_HEIGHT_BLOCK_SIZE);
			this.viewportBlockHeights[blockIndex] =
				(this.viewportBlockHeights[blockIndex] ?? 0) + this.viewportRecords[index].height;
			this.viewportTotalHeight += this.viewportRecords[index].height;
		}
	}

	private totalViewportHeight(): number {
		return this.viewportTotalHeight;
	}

	private locateViewportLine(line: number): {
		index: number;
		itemStart: number;
		targetHeightLookupProbes: number;
		blockLookupProbes: number;
	} {
		let itemStart = 0;
		let blockIndex = 0;
		let blockLookupProbes = 0;
		while (
			blockIndex < this.viewportBlockHeights.length &&
			itemStart + this.viewportBlockHeights[blockIndex] <= line
		) {
			blockLookupProbes++;
			itemStart += this.viewportBlockHeights[blockIndex];
			blockIndex++;
		}
		if (blockIndex < this.viewportBlockHeights.length) blockLookupProbes++;
		let index = blockIndex * VIEWPORT_HEIGHT_BLOCK_SIZE;
		let targetHeightLookupProbes = 0;
		while (index < this.viewportRecords.length) {
			const height = this.viewportRecords[index].height;
			targetHeightLookupProbes++;
			if (itemStart + height > line) break;
			itemStart += height;
			index++;
		}
		return {
			index: Math.min(index, Math.max(0, this.viewportRecords.length - 1)),
			itemStart,
			targetHeightLookupProbes,
			blockLookupProbes,
		};
	}

	private composeViewport(
		width: number,
		startIndex: number,
		itemStart: number,
		requestedStart: number,
		requestedEnd: number,
		targetHeightLookupProbes: number,
		blockLookupProbes: number,
	): RetainedViewportRender {
		const lines: string[] = [];
		const resultStart = requestedStart;
		let index = startIndex;
		let visited = 0;
		let leadingKittyImage: RetainedViewportRender["leadingKittyImage"];
		while (index < this.viewportRecords.length && itemStart < requestedEnd) {
			const record = this.viewportRecords[index];
			const childLines = this.renderViewportRecord(record, width);
			visited++;
			this.updateKittySpans(record, childLines);
			if (childLines.length !== record.height) {
				const delta = childLines.length - record.height;
				record.height = childLines.length;
				const blockIndex = Math.floor(index / VIEWPORT_HEIGHT_BLOCK_SIZE);
				this.viewportBlockHeights[blockIndex] = (this.viewportBlockHeights[blockIndex] ?? 0) + delta;
				this.viewportTotalHeight += delta;
			}
			const localStart = Math.max(0, requestedStart - itemStart);
			const localEnd = Math.min(childLines.length, requestedEnd - itemStart);
			if (!leadingKittyImage && localStart > 0 && record.kittySpans) {
				for (let spanIndex = 0; spanIndex < record.kittySpans.length; spanIndex += 2) {
					const imageStart = record.kittySpans[spanIndex];
					const imageRows = record.kittySpans[spanIndex + 1];
					if (imageStart < localStart && imageStart + imageRows > localStart) {
						leadingKittyImage = { line: childLines[imageStart], absoluteRow: itemStart + imageStart };
						break;
					}
				}
			}
			for (let lineIndex = localStart; lineIndex < localEnd; lineIndex++) lines.push(childLines[lineIndex]);
			itemStart += childLines.length;
			index++;
		}
		this.options.instrumentation?.recordTranscriptViewport(
			visited,
			lines.length,
			targetHeightLookupProbes,
			blockLookupProbes,
			lines.length,
		);
		return {
			lines,
			startLine: resultStart,
			totalHeight: this.totalViewportHeight(),
			visitedItems: visited,
			measuredItems: this.viewportMeasuredItems,
			targetHeightLookupProbes,
			blockLookupProbes,
			copiedLines: lines.length,
			leadingKittyImage,
		};
	}

	private updateKittySpans(record: RetainedViewportRecord, lines: readonly string[]): void {
		if (record.kittySpanLines === lines) return;
		let spans: number[] | undefined;
		for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
			const metadata = getKittyImageMetadata(lines[lineIndex]);
			if (!metadata || metadata.rows <= 1) continue;
			spans ??= [];
			spans.push(lineIndex, metadata.rows);
		}
		record.kittySpans = spans;
		// Only alias a line array already owned by a completed retained cache.
		// Active/dynamic records must not turn Kitty metadata into a frame cache.
		record.kittySpanLines = record.retained?.completed ? lines : undefined;
	}
}
