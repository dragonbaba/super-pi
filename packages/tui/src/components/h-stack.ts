import { compositeTuiLine } from "../tui.ts";
import { visibleWidth } from "../utils.ts";
import { allocateStackSizes, Stack, type StackChild, type StackOptions, visibleStackEntries } from "./stack.ts";

export class HStack extends Stack {
	protected readonly layoutType = "hstack" as const;

	constructor(children: StackChild[] = [], options: StackOptions = {}) {
		super(children, options);
	}

	override render(width: number): string[] {
		const safeWidth = Math.max(1, width);
		const viewport = { width: safeWidth, height: Number.MAX_SAFE_INTEGER };
		const entries = visibleStackEntries(this.entries, viewport);
		if (entries.length === 0) return [];

		const intrinsicWidths: number[] = [];
		for (const entry of entries) {
			const lines = entry.component.render(safeWidth);
			let intrinsicWidth = 0;
			for (const line of lines) intrinsicWidth = Math.max(intrinsicWidth, visibleWidth(line));
			intrinsicWidths.push(intrinsicWidth);
		}
		const widths = allocateStackSizes(entries, intrinsicWidths, safeWidth, this.gap);
		const rendered: string[][] = [];
		let height = 0;
		for (let index = 0; index < entries.length; index++) {
			const childLines = widths[index] === 0 ? [] : entries[index]!.component.render(widths[index]!);
			rendered.push(childLines);
			height = Math.max(height, childLines.length);
		}
		const result = new Array<string>(height).fill("");
		let x = 0;
		for (let index = 0; index < rendered.length; index++) {
			const lines = rendered[index]!;
			const childWidth = widths[index]!;
			let offset = 0;
			if (this.align === "center") offset = Math.floor((height - lines.length) / 2);
			else if (this.align === "end") offset = height - lines.length;
			for (let row = 0; row < lines.length; row++) {
				const target = row + offset;
				if (target < 0 || target >= result.length) continue;
				result[target] = compositeTuiLine(result[target]!, lines[row]!, x, childWidth, safeWidth);
			}
			x += childWidth + this.gap;
		}
		return result;
	}
}
