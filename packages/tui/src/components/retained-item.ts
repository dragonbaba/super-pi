import { TuiRenderInstrumentation, utf8ByteLength } from "../render-instrumentation.ts";
import { getKittyImageMetadata } from "../terminal-image.ts";
import { type Component, Container } from "../tui.ts";
import {
	LINE_VIEWPORT_COMPONENT,
	type LineViewportComponent,
	type LineViewportMutationObservation,
} from "./viewport-container.ts";

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

function getDefaultRetainedContext(): Readonly<RetainedRenderContext> {
	return DEFAULT_CONTEXT;
}

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
		this.getContext = options.getContext ?? getDefaultRetainedContext;
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
		let key = this.cacheKey;
		if (
			key !== undefined &&
			this.cachedLines !== undefined &&
			key.width === width &&
			key.version === this.logicalVersion &&
			key.visualGeneration === this.visualGeneration &&
			key.themeVersion === context.themeVersion &&
			key.rendererVersion === context.rendererVersion &&
			key.expandVersion === context.expandVersion &&
			key.settingsVersion === context.settingsVersion
		) {
			this.instrumentation?.recordRetainedCacheHit();
			return this.cachedLines;
		}

		const lines = component.render(width);
		if (key) {
			key.width = width;
			key.version = this.logicalVersion;
			key.visualGeneration = this.visualGeneration;
			key.themeVersion = context.themeVersion;
			key.rendererVersion = context.rendererVersion;
			key.expandVersion = context.expandVersion;
			key.settingsVersion = context.settingsVersion;
		} else {
			key = {
				width,
				version: this.logicalVersion,
				visualGeneration: this.visualGeneration,
				themeVersion: context.themeVersion,
				rendererVersion: context.rendererVersion,
				expandVersion: context.expandVersion,
				settingsVersion: context.settingsVersion,
			};
			this.cacheKey = key;
		}
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
	preparedItems: number;
}

interface RetainedViewportRecord {
	component: Component;
	retained: RetainedItem | undefined;
	height: number;
	index: number;
	preparedLines?: string[];
	preparedWidth?: number;
	/** Flat [start, rows, ...] pairs for Kitty blocks in this item's cached render. */
	kittySpans?: number[];
	kittySpanLines?: readonly string[];
}

const VIEWPORT_HEIGHT_BLOCK_SIZE = 256;
const MAX_VIEWPORT_MUTATION_EVENTS = 64;
const VIEWPORT_MUTATION_RECORD = 1;
const VIEWPORT_MUTATION_APPEND = 2;
const VIEWPORT_MUTATION_UNSAFE = 3;

/** Container with session-local ownership and cleanup for retained children. */
export class RetainedContainer extends Container implements LineViewportComponent {
	readonly [LINE_VIEWPORT_COMPONENT] = true as const;
	private readonly retainedById = new Map<string, RetainedItem>();
	private readonly retainedByComponent = new Map<Component, RetainedItem>();
	private readonly options: RetainedContainerOptions;
	private viewportRecords: RetainedViewportRecord[] = [];
	private readonly viewportRecordByComponent = new Map<Component, RetainedViewportRecord>();
	private readonly dirtyViewportRecords = new Set<RetainedViewportRecord>();
	private readonly preparedViewportRecords = new Set<RetainedViewportRecord>();
	private viewportBlockHeights: number[] = [];
	private viewportTotalHeight = 0;
	private viewportWidth: number | undefined;
	private viewportStructureDirty = false;
	private viewportMeasuredItems = 0;
	private viewportMutationGeneration = 0;
	private readonly viewportMutationEventGenerations = new Float64Array(MAX_VIEWPORT_MUTATION_EVENTS);
	private readonly viewportMutationEventKinds = new Uint8Array(MAX_VIEWPORT_MUTATION_EVENTS);
	private readonly viewportMutationEventRecordIndices = new Float64Array(MAX_VIEWPORT_MUTATION_EVENTS);
	private readonly viewportMutationEventPreviousHeights = new Float64Array(MAX_VIEWPORT_MUTATION_EVENTS);
	private readonly viewportMutationEventAppendIndices = new Float64Array(MAX_VIEWPORT_MUTATION_EVENTS);
	private viewportMutationEventStart = 0;
	private viewportMutationEventCount = 0;
	private suppressRecordMutation = false;
	private readonly retainedRenderStateChanged = (item: RetainedItem): void => {
		const component = item.component;
		if (!component) return;
		const record = this.viewportRecordByComponent.get(component);
		if (record) this.markViewportRecordDirty(record, !this.suppressRecordMutation);
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
			this.markViewportRecordDirty(record, true);
		} else {
			this.markViewportStructureDirty();
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
		this.markViewportRecordDirty(record, true);
		return true;
	}

	/** Invalidates height metadata at a presentation boundary without re-invalidating child renderers. */
	invalidateViewportHeights(): void {
		this.ensureViewportStructure();
		this.recordUnsafeViewportMutation();
		for (const record of this.viewportRecords) this.markViewportRecordDirty(record, false);
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
		this.markViewportStructureDirty();
	}

	getContentHeight(width: number): number {
		try {
			this.prepareViewportIndex(width, false);
			return this.totalViewportHeight();
		} finally {
			this.clearPreparedViewportLines();
		}
	}

	getViewportIndexStats(): Readonly<RetainedViewportIndexStats> {
		this.ensureViewportStructure();
		return Object.freeze({
			indexedItems: this.viewportRecords.length,
			heightBlocks: this.viewportBlockHeights.length,
			dirtyItems: this.dirtyViewportRecords.size,
			totalHeight: this.totalViewportHeight(),
			width: this.viewportWidth,
			preparedItems: this.preparedViewportRecords.size,
		});
	}

	observeViewportMutation(
		width: number,
		previousToken?: unknown,
		result?: LineViewportMutationObservation,
	): LineViewportMutationObservation {
		this.getContentHeight(width);
		const token = this.viewportMutationGeneration;
		const observation = result ?? { token, kind: "none" };
		observation.token = token;
		observation.kind = "none";
		observation.earliestChangedLine = undefined;
		observation.latestChangedLine = undefined;
		observation.heightChanged = undefined;
		if (previousToken === token) return observation;
		if (typeof previousToken !== "number" || previousToken < 0 || previousToken > token) {
			observation.kind = "unsafe";
			return observation;
		}
		if (this.viewportMutationEventCount === 0) {
			observation.kind = "unsafe";
			return observation;
		}
		const firstGeneration = this.viewportMutationEventGenerations[this.viewportMutationEventStart];
		if (previousToken < firstGeneration - 1) {
			observation.kind = "unsafe";
			return observation;
		}

		let sawAppend = false;
		let appendFloorIndex = Number.POSITIVE_INFINITY;
		let sawRange = false;
		let heightChanged = false;
		let earliestChangedLine = Number.POSITIVE_INFINITY;
		let latestChangedLine = 0;
		for (let eventOffset = 0; eventOffset < this.viewportMutationEventCount; eventOffset++) {
			const eventIndex = (this.viewportMutationEventStart + eventOffset) % MAX_VIEWPORT_MUTATION_EVENTS;
			if (this.viewportMutationEventGenerations[eventIndex] <= previousToken) continue;
			const eventKind = this.viewportMutationEventKinds[eventIndex];
			if (eventKind === VIEWPORT_MUTATION_UNSAFE) {
				observation.kind = "unsafe";
				return observation;
			}
			if (eventKind === VIEWPORT_MUTATION_APPEND) {
				sawAppend = true;
				appendFloorIndex = Math.min(appendFloorIndex, this.viewportMutationEventAppendIndices[eventIndex]);
				continue;
			}
			const recordIndex = this.viewportMutationEventRecordIndices[eventIndex];
			const record = this.viewportRecords[recordIndex];
			if (!record || record.index !== recordIndex || this.viewportRecordByComponent.get(record.component) !== record) {
				observation.kind = "unsafe";
				return observation;
			}
			const recordHeightChanged = record.height !== this.viewportMutationEventPreviousHeights[eventIndex];
			if (sawAppend && record.index >= appendFloorIndex) continue;
			sawRange = true;
			const lineStart = this.getViewportRecordLineStart(record.index);
			earliestChangedLine = Math.min(earliestChangedLine, lineStart);
			heightChanged ||= recordHeightChanged;
			latestChangedLine = Math.max(
				latestChangedLine,
				recordHeightChanged ? this.totalViewportHeight() : lineStart + record.height,
			);
		}
		if (sawAppend && sawRange) {
			observation.kind = "unsafe";
			return observation;
		}
		if (sawAppend) {
			observation.kind = "tail-append";
			return observation;
		}
		if (sawRange) {
			observation.kind = "range";
			observation.earliestChangedLine = earliestChangedLine;
			observation.latestChangedLine = latestChangedLine;
			observation.heightChanged = heightChanged;
		}
		return observation;
	}

	renderViewport(width: number, startLine: number, height: number): RetainedViewportRender {
		try {
			this.prepareViewportIndex(width, true);
			const totalHeight = this.totalViewportHeight();
			const safeHeight = Math.max(0, Math.floor(height));
			const requestedStart = Math.max(0, Math.min(totalHeight, Math.floor(startLine)));
			if (safeHeight === 0 || requestedStart >= totalHeight) {
				this.options.instrumentation?.recordTranscriptViewport(0, 0);
				return this.emptyViewportRender(requestedStart, totalHeight);
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
		} finally {
			this.clearPreparedViewportLines();
		}
	}

	renderViewportTail(width: number, height: number): RetainedViewportRender {
		try {
			this.prepareViewportIndex(width, true);
			const totalHeight = this.totalViewportHeight();
			const safeHeight = Math.max(0, Math.floor(height));
			const requestedStart = Math.max(0, totalHeight - safeHeight);
			if (safeHeight === 0 || totalHeight === 0) {
				this.options.instrumentation?.recordTranscriptViewport(0, 0);
				return this.emptyViewportRender(requestedStart, totalHeight);
			}
			const located = this.locateViewportTail(requestedStart, totalHeight);
			return this.composeViewport(
				width,
				located.index,
				located.itemStart,
				requestedStart,
				totalHeight,
				located.targetHeightLookupProbes,
				located.blockLookupProbes,
			);
		} finally {
			this.clearPreparedViewportLines();
		}
	}

	private emptyViewportRender(startLine: number, totalHeight: number): RetainedViewportRender {
		return {
			lines: [],
			startLine,
			totalHeight,
			visitedItems: 0,
			measuredItems: this.viewportMeasuredItems,
			targetHeightLookupProbes: 0,
			blockLookupProbes: 0,
			copiedLines: 0,
		};
	}

	override render(width: number): string[] {
		this.ensureViewportStructure();
		const safeWidth = Math.max(1, Math.floor(width));
		this.viewportWidth = safeWidth;
		this.dirtyViewportRecords.clear();
		this.clearPreparedViewportLines();
		const lines: string[] = [];
		for (const record of this.viewportRecords) {
			const childLines = this.renderViewportRecord(record, safeWidth);
			record.height = childLines.length;
			for (const line of childLines) lines.push(line);
		}
		this.rebuildViewportBlockHeights();
		this.clearPreparedViewportLines();
		return lines;
	}

	override invalidate(): void {
		this.ensureViewportStructure();
		this.recordUnsafeViewportMutation();
		this.suppressRecordMutation = true;
		try {
			for (const record of this.viewportRecords) {
				const child = record.component;
				const retained = record.retained;
				this.markViewportRecordDirty(record, false);
				if (retained) retained.invalidate();
				else child.invalidate();
			}
		} finally {
			this.suppressRecordMutation = false;
		}
	}

	override removeChild(component: Component): void {
		const index = this.children.indexOf(component);
		if (index < 0) return;
		const removed = this.children[index];
		this.children.splice(index, 1);
		this.recordUnsafeViewportMutation();
		this.removeViewportRecord(removed);
		const retained = this.retainedByComponent.get(removed);
		if (retained) {
			this.retainedByComponent.delete(removed);
			this.retainedById.delete(retained.id);
			retained.release();
		}
	}

	override clear(): void {
		if (this.children.length > 0) this.recordUnsafeViewportMutation();
		for (const item of this.retainedById.values()) item.release();
		this.retainedById.clear();
		this.retainedByComponent.clear();
		this.viewportRecords = [];
		this.viewportRecordByComponent.clear();
		this.dirtyViewportRecords.clear();
		this.clearPreparedViewportLines();
		this.viewportBlockHeights = [];
		this.viewportTotalHeight = 0;
		this.viewportWidth = undefined;
		this.viewportStructureDirty = false;
		super.clear();
	}

	private appendViewportRecord(component: Component, retained: RetainedItem | undefined): void {
		if (this.viewportStructureDirty) {
			this.recordUnsafeViewportMutation();
			return;
		}
		const record: RetainedViewportRecord = { component, retained, height: 0, index: this.viewportRecords.length };
		this.viewportRecords.push(record);
		this.viewportRecordByComponent.set(component, record);
		this.dirtyViewportRecords.add(record);
		this.recordViewportMutation(VIEWPORT_MUTATION_APPEND, record.index, 0, record.index);
		const blockIndex = Math.floor((this.viewportRecords.length - 1) / VIEWPORT_HEIGHT_BLOCK_SIZE);
		this.viewportBlockHeights[blockIndex] ??= 0;
	}

	private markViewportRecordDirty(record: RetainedViewportRecord, recordMutation: boolean): void {
		this.clearPreparedViewportRecord(record);
		if (recordMutation) {
			this.recordViewportMutation(VIEWPORT_MUTATION_RECORD, record.index, record.height, -1);
		}
		this.dirtyViewportRecords.add(record);
	}

	private markViewportStructureDirty(): void {
		this.viewportStructureDirty = true;
		this.recordUnsafeViewportMutation();
	}

	private recordUnsafeViewportMutation(): void {
		this.viewportMutationEventStart = 0;
		this.viewportMutationEventCount = 0;
		this.recordViewportMutation(VIEWPORT_MUTATION_UNSAFE, -1, 0, -1);
	}

	private recordViewportMutation(
		kind: number,
		recordIndex: number,
		previousHeight: number,
		appendIndex: number,
	): void {
		this.options.instrumentation?.recordMutationEventWrite();
		this.viewportMutationGeneration++;
		let eventIndex: number;
		if (this.viewportMutationEventCount < MAX_VIEWPORT_MUTATION_EVENTS) {
			eventIndex =
				(this.viewportMutationEventStart + this.viewportMutationEventCount) % MAX_VIEWPORT_MUTATION_EVENTS;
			this.viewportMutationEventCount++;
		} else {
			eventIndex = this.viewportMutationEventStart;
			this.viewportMutationEventStart = (this.viewportMutationEventStart + 1) % MAX_VIEWPORT_MUTATION_EVENTS;
		}
		this.viewportMutationEventGenerations[eventIndex] = this.viewportMutationGeneration;
		this.viewportMutationEventKinds[eventIndex] = kind;
		this.viewportMutationEventRecordIndices[eventIndex] = recordIndex;
		this.viewportMutationEventPreviousHeights[eventIndex] = previousHeight;
		this.viewportMutationEventAppendIndices[eventIndex] = appendIndex;
	}

	private clearPreparedViewportRecord(record: RetainedViewportRecord): void {
		record.preparedLines = undefined;
		record.preparedWidth = undefined;
		this.preparedViewportRecords.delete(record);
	}

	private clearPreparedViewportLines(): void {
		for (const record of this.preparedViewportRecords) {
			record.preparedLines = undefined;
			record.preparedWidth = undefined;
		}
		this.preparedViewportRecords.clear();
	}

	private removeViewportRecord(component: Component): void {
		if (this.viewportStructureDirty) return;
		const record = this.viewportRecordByComponent.get(component);
		if (!record) {
			this.markViewportStructureDirty();
			return;
		}
		const index = this.viewportRecords.indexOf(record);
		if (index < 0) {
			this.markViewportStructureDirty();
			return;
		}
		this.viewportRecords.splice(index, 1);
		for (let nextIndex = index; nextIndex < this.viewportRecords.length; nextIndex++) {
			this.viewportRecords[nextIndex].index = nextIndex;
		}
		this.viewportRecordByComponent.delete(component);
		this.dirtyViewportRecords.delete(record);
		this.clearPreparedViewportRecord(record);
		this.rebuildViewportBlockHeights();
	}

	private ensureViewportStructure(): void {
		if (!this.viewportStructureDirty && this.viewportRecords.length === this.children.length) return;
		this.viewportRecords = [];
		this.viewportRecordByComponent.clear();
		this.dirtyViewportRecords.clear();
		this.clearPreparedViewportLines();
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

	private prepareViewportIndex(width: number, retainPreparedLines: boolean): void {
		this.ensureViewportStructure();
		const safeWidth = Math.max(1, Math.floor(width));
		this.viewportMeasuredItems = 0;
		if (this.viewportWidth !== safeWidth) {
			this.viewportWidth = safeWidth;
			this.dirtyViewportRecords.clear();
			this.clearPreparedViewportLines();
			for (const record of this.viewportRecords) this.measureViewportRecord(record, safeWidth, false);
			this.rebuildViewportBlockHeights();
			return;
		}
		if (this.dirtyViewportRecords.size === 0) return;
		const retainMeasuredLines = retainPreparedLines && this.dirtyViewportRecords.size <= VIEWPORT_HEIGHT_BLOCK_SIZE;
		for (const record of this.dirtyViewportRecords) {
			if (this.viewportRecordByComponent.get(record.component) !== record) continue;
			this.measureViewportRecord(record, safeWidth, retainMeasuredLines);
		}
		this.dirtyViewportRecords.clear();
	}

	private measureViewportRecord(record: RetainedViewportRecord, width: number, retainPreparedLines: boolean): void {
		const previousHeight = record.height;
		const lines = this.renderViewportRecord(record, width);
		record.height = lines.length;
		this.updateKittySpans(record, lines);
		this.clearPreparedViewportRecord(record);
		if (retainPreparedLines) {
			record.preparedLines = lines;
			record.preparedWidth = width;
			this.preparedViewportRecords.add(record);
		}
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
		if (record.preparedLines && record.preparedWidth === width) {
			const lines = record.preparedLines;
			this.clearPreparedViewportRecord(record);
			return lines;
		}
		this.clearPreparedViewportRecord(record);
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

	private getViewportRecordLineStart(recordIndex: number): number {
		const blockIndex = Math.floor(recordIndex / VIEWPORT_HEIGHT_BLOCK_SIZE);
		const lastBlockIndex = this.viewportBlockHeights.length - 1;
		if (blockIndex > lastBlockIndex / 2) {
			let lineStart = this.viewportTotalHeight;
			for (let index = lastBlockIndex; index > blockIndex; index--) {
				lineStart -= this.viewportBlockHeights[index] ?? 0;
			}
			const blockEnd = Math.min(this.viewportRecords.length, (blockIndex + 1) * VIEWPORT_HEIGHT_BLOCK_SIZE);
			for (let index = blockEnd - 1; index >= recordIndex; index--) lineStart -= this.viewportRecords[index].height;
			return lineStart;
		}
		let lineStart = 0;
		for (let index = 0; index < blockIndex; index++) lineStart += this.viewportBlockHeights[index] ?? 0;
		const firstRecord = blockIndex * VIEWPORT_HEIGHT_BLOCK_SIZE;
		for (let index = firstRecord; index < recordIndex; index++) lineStart += this.viewportRecords[index].height;
		return lineStart;
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

	private locateViewportTail(line: number, totalHeight: number): {
		index: number;
		itemStart: number;
		targetHeightLookupProbes: number;
		blockLookupProbes: number;
	} {
		let blockIndex = this.viewportBlockHeights.length - 1;
		let blockEndHeight = totalHeight;
		let targetHeightLookupProbes = 0;
		let blockLookupProbes = 0;
		while (blockIndex >= 0) {
			const blockHeight = this.viewportBlockHeights[blockIndex] ?? 0;
			const isLastBlock = blockIndex === this.viewportBlockHeights.length - 1;
			if (!isLastBlock || blockHeight === 0) blockLookupProbes++;
			if (blockHeight === 0) {
				blockIndex--;
				continue;
			}
			const blockStartHeight = blockEndHeight - blockHeight;
			if (blockStartHeight > line) {
				blockEndHeight = blockStartHeight;
				blockIndex--;
				continue;
			}
			let index = Math.min(
				this.viewportRecords.length - 1,
				(blockIndex + 1) * VIEWPORT_HEIGHT_BLOCK_SIZE - 1,
			);
			const firstIndex = blockIndex * VIEWPORT_HEIGHT_BLOCK_SIZE;
			let itemStart = blockEndHeight;
			while (index >= firstIndex) {
				itemStart -= this.viewportRecords[index].height;
				targetHeightLookupProbes++;
				if (itemStart <= line) {
					return { index, itemStart, targetHeightLookupProbes, blockLookupProbes };
				}
				index--;
			}
			blockEndHeight = blockStartHeight;
			blockIndex--;
		}
		return { index: 0, itemStart: 0, targetHeightLookupProbes, blockLookupProbes };
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
