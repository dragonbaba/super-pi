import { TuiRenderInstrumentation, utf8ByteLength } from "../render-instrumentation.ts";
import { type Component, Container } from "../tui.ts";

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

/** Container with session-local ownership and cleanup for retained children. */
export class RetainedContainer extends Container {
	private readonly retainedById = new Map<string, RetainedItem>();
	private readonly retainedByComponent = new Map<Component, RetainedItem>();
	private readonly options: RetainedContainerOptions;

	constructor(options: RetainedContainerOptions = {}) {
		super();
		this.options = options;
	}

	addRetainedChild(component: Component, options: Omit<RetainedItemOptions, "getContext" | "instrumentation">): RetainedItem {
		this.assertCanRetain(component, options.id);
		const item = this.createRetainedItem(component, options);
		super.addChild(component);
		this.recordRetainedItem(component, item);
		return item;
	}

	retainChild(component: Component, options: Omit<RetainedItemOptions, "getContext" | "instrumentation">): RetainedItem {
		if (!this.children.includes(component)) throw new Error("Cannot retain a component outside this container");
		this.assertCanRetain(component, options.id);
		const item = this.createRetainedItem(component, options);
		this.recordRetainedItem(component, item);
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

	override render(width: number): string[] {
		const lines: string[] = [];
		for (const child of this.children) {
			const retained = this.retainedByComponent.get(child);
			const childLines = retained ? retained.render(width) : child.render(width);
			for (const line of childLines) lines.push(line);
		}
		return lines;
	}

	override invalidate(): void {
		for (const child of this.children) {
			const retained = this.retainedByComponent.get(child);
			if (retained) retained.invalidate();
			else child.invalidate();
		}
	}

	override removeChild(component: Component): void {
		const index = this.children.indexOf(component);
		if (index < 0) return;
		const removed = this.children[index];
		this.children.splice(index, 1);
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
		super.clear();
	}
}
