import { allocateStackSizes, Stack, type StackChild, type StackOptions, visibleStackEntries } from "./stack.ts";

export class VStack extends Stack {
	protected readonly layoutType = "vstack" as const;

	constructor(children: StackChild[] = [], options: StackOptions = {}) {
		super(children, options);
	}

	override render(width: number): string[] {
		const viewport = { width: Math.max(1, width), height: Number.MAX_SAFE_INTEGER };
		const entries = visibleStackEntries(this.entries, viewport);
		const rendered: string[][] = [];
		const intrinsicSizes: number[] = [];
		for (const entry of entries) {
			const childLines = entry.component.render(viewport.width);
			rendered.push(childLines);
			intrinsicSizes.push(childLines.length);
		}
		const sizes = allocateStackSizes(entries, intrinsicSizes, undefined, this.gap);
		const lines: string[] = [];
		for (let index = 0; index < entries.length; index++) {
			if (index > 0) {
				for (let gap = 0; gap < this.gap; gap++) lines.push("");
			}
			const childLines = rendered[index]!;
			const visibleCount = Math.min(childLines.length, sizes[index]!);
			for (let row = 0; row < visibleCount; row++) lines.push(childLines[row]!);
			for (let padding = visibleCount; padding < sizes[index]!; padding++) lines.push("");
		}
		return lines;
	}
}

export type { StackChild, StackEntry, StackEntryOptions, StackOptions } from "./stack.ts";
