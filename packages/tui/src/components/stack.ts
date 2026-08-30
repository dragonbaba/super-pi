import { LAYOUT_NODE, type LayoutViewport, type StackLayoutEntry, type StackLayoutNode } from "../layout-node.ts";
import { type Component, Container } from "../tui.ts";

export interface StackEntryOptions {
	basis?: number | "auto";
	grow?: number;
	shrink?: number;
	minSize?: number;
	maxSize?: number;
	visible?: (viewport: LayoutViewport) => boolean;
}

export interface StackEntry extends StackEntryOptions {
	component: Component;
}

export type StackChild = Component | StackEntry;

export interface StackOptions {
	gap?: number;
	align?: "stretch" | "start" | "center" | "end";
}

function isStackEntry(child: StackChild): child is StackEntry {
	return !("render" in child);
}

function normalizeSize(value: number | undefined, fallback: number): number {
	return value === undefined || !Number.isFinite(value) ? fallback : Math.max(0, Math.floor(value));
}

export abstract class Stack extends Container {
	protected readonly entries: StackLayoutEntry[] = [];
	protected readonly gap: number;
	protected readonly align: "stretch" | "start" | "center" | "end";
	protected abstract readonly layoutType: "vstack" | "hstack";
	private layoutNode: StackLayoutNode | undefined;

	constructor(children: StackChild[] = [], options: StackOptions = {}) {
		super();
		this.gap = normalizeSize(options.gap, 0);
		this.align = options.align ?? "stretch";
		for (const child of children) {
			if (isStackEntry(child)) this.addChild(child.component, child);
			else this.addChild(child);
		}
	}

	override addChild(component: Component, options: StackEntryOptions = {}): void {
		super.addChild(component);
		this.entries.push({
			component,
			...(options.basis === undefined ? {} : { basis: options.basis }),
			...(options.grow === undefined ? {} : { grow: normalizeSize(options.grow, 0) }),
			...(options.shrink === undefined ? {} : { shrink: normalizeSize(options.shrink, 1) }),
			...(options.minSize === undefined ? {} : { minSize: normalizeSize(options.minSize, 0) }),
			...(options.maxSize === undefined ? {} : { maxSize: normalizeSize(options.maxSize, Number.MAX_SAFE_INTEGER) }),
			...(options.visible === undefined ? {} : { visible: options.visible }),
		});
	}

	override removeChild(component: Component): void {
		super.removeChild(component);
		const index = this.entries.findIndex((entry) => entry.component === component);
		if (index !== -1) this.entries.splice(index, 1);
	}

	override clear(): void {
		super.clear();
		this.entries.length = 0;
	}

	[LAYOUT_NODE](): StackLayoutNode {
		let node = this.layoutNode;
		if (node !== undefined) return node;
		node = {
			type: this.layoutType,
			entries: this.entries,
			gap: this.gap,
			align: this.align,
		};
		this.layoutNode = node;
		return node;
	}
}

export function visibleStackEntries(
	entries: readonly StackLayoutEntry[],
	viewport: LayoutViewport,
): StackLayoutEntry[] {
	return entries.filter((entry) => entry.visible?.(viewport) ?? true);
}

function clampSize(size: number, entry: StackLayoutEntry): number {
	const min = Math.max(0, Math.floor(entry.minSize ?? 0));
	const max = Math.max(min, Math.floor(entry.maxSize ?? Number.MAX_SAFE_INTEGER));
	return Math.max(min, Math.min(max, Math.max(0, Math.floor(size))));
}

export function allocateStackSizes(
	entries: readonly StackLayoutEntry[],
	intrinsicSizes: readonly number[],
	availableSize: number | undefined,
	gap: number,
): number[] {
	const sizes = new Array<number>(entries.length);
	allocateStackSizesInto(entries, 0, intrinsicSizes, 0, entries.length, availableSize, gap, sizes, 0);
	return sizes;
}

/** Caller-owned range variant used by the synchronous Alt layout scratch. */
export function allocateStackSizesInto(
	entries: readonly StackLayoutEntry[],
	entryOffset: number,
	intrinsicSizes: readonly number[],
	intrinsicOffset: number,
	count: number,
	availableSize: number | undefined,
	gap: number,
	sizes: number[],
	sizeOffset: number,
): void {
	for (let index = 0; index < count; index++) {
		const entry = entries[entryOffset + index]!;
		sizes[sizeOffset + index] = clampSize(
			entry.basis === undefined || entry.basis === "auto"
				? (intrinsicSizes[intrinsicOffset + index] ?? 0)
				: entry.basis,
			entry,
		);
	}
	if (availableSize === undefined) return;

	const contentSize = Math.max(0, Math.floor(availableSize) - Math.max(0, count - 1) * gap);
	let total = 0;
	for (let index = 0; index < count; index++) total += sizes[sizeOffset + index]!;
	if (total < contentSize) {
		distributeRange(sizes, sizeOffset, entries, entryOffset, count, contentSize - total, "grow");
	} else if (total > contentSize) {
		distributeRange(sizes, sizeOffset, entries, entryOffset, count, total - contentSize, "shrink");
	}
}

function distributeRange(
	sizes: number[],
	sizeOffset: number,
	entries: readonly StackLayoutEntry[],
	entryOffset: number,
	count: number,
	amount: number,
	mode: "grow" | "shrink",
): void {
	let remaining = amount;
	while (remaining > 0) {
		let candidateCount = 0;
		let totalWeight = 0;
		for (let index = 0; index < count; index++) {
			const entry = entries[entryOffset + index]!;
			const size = sizes[sizeOffset + index]!;
			const eligible =
				mode === "grow"
					? (entry.grow ?? 0) > 0 && size < (entry.maxSize ?? Number.MAX_SAFE_INTEGER)
					: (entry.shrink ?? 1) > 0 && size > (entry.minSize ?? 0);
			if (!eligible) continue;
			candidateCount++;
			totalWeight += mode === "grow" ? (entry.grow ?? 0) : (entry.shrink ?? 1) * Math.max(1, size);
		}
		if (candidateCount === 0) return;

		let distributed = 0;
		for (let index = 0; index < count; index++) {
			if (remaining <= 0) break;
			const entry = entries[entryOffset + index]!;
			const sizeIndex = sizeOffset + index;
			const size = sizes[sizeIndex]!;
			const eligible =
				mode === "grow"
					? (entry.grow ?? 0) > 0 && size < (entry.maxSize ?? Number.MAX_SAFE_INTEGER)
					: (entry.shrink ?? 1) > 0 && size > (entry.minSize ?? 0);
			if (!eligible) continue;
			const weight = mode === "grow" ? (entry.grow ?? 0) : (entry.shrink ?? 1) * Math.max(1, size);
			const proposed = Math.max(1, Math.floor((remaining * weight) / totalWeight));
			const capacity =
				mode === "grow"
					? (entry.maxSize ?? Number.MAX_SAFE_INTEGER) - size
					: size - (entry.minSize ?? 0);
			const delta = Math.min(remaining, proposed, capacity);
			if (delta <= 0) continue;
			sizes[sizeIndex] = size + (mode === "grow" ? delta : -delta);
			remaining -= delta;
			distributed += delta;
		}
		if (distributed === 0) return;
	}
}
