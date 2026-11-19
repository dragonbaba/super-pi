import { getKeybindings, isKeyRelease, isKeyRepeat, truncateToWidth, wrapTextWithAnsi, type TUI } from "@super-pi/tui";
import { theme } from "../theme/theme.ts";
import { keyHint } from "./keybinding-hints.ts";

/** A temporary, keyboard-focused overlay. Content is prepared by its caller at open time. */
export class InteractionPanel {
	private selected = 0;
	private top = 0;
	private width = -1;
	private height = -1;
	private revealChoice = false;
	private get contentRows(): number {
		return Math.max(0, this.height - (this.height >= 4 ? 2 : 1));
	}
	private starts: number[] = [];
	private lines: string[] = [];
	private frame: string[] | undefined;
	private body: string;
	private choices: readonly string[];
	private readonly terminal: TUI["terminal"];
	private done: ((index?: number) => void) | undefined;

	constructor(body: string, choices: readonly string[], terminal: TUI["terminal"], done: (index?: number) => void) {
		this.body = body;
		this.choices = choices;
		this.terminal = terminal;
		this.done = done;
	}

	invalidate(): void {
		this.width = -1;
		this.frame = undefined;
	}

	render(width: number): string[] {
		if (!this.done) return this.lines;
		const height = Math.max(1, this.terminal.rows);
		if (width !== this.width) {
			this.width = width;
			this.lines = wrapTextWithAnsi(this.body, Math.max(1, width - 2));
			this.starts.length = 0;
			if (this.choices.length) this.lines.push("");
			for (let i = 0; i < this.choices.length; i++) {
				this.starts.push(this.lines.length);
				const wrapped = wrapTextWithAnsi(this.choices[i]!, Math.max(1, width - 4));
				for (let j = 0; j < wrapped.length; j++) {
					this.lines.push(wrapped[j]!);
				}
			}
			this.frame = undefined;
		}
		if (this.frame && this.height === height) return this.frame;
		this.height = height;
		const available = this.contentRows;
		if (this.revealChoice) {
			const start = this.starts[this.selected] ?? 0;
			const end = this.starts[this.selected + 1] ?? this.lines.length;
			this.top = Math.min(start, Math.max(this.top, end - available));
			this.revealChoice = false;
		}
		this.top = Math.max(0, Math.min(this.top, this.lines.length - available));
		const frame: string[] = [];
		if (height >= 4) frame.push(theme.fg("borderMuted", "─".repeat(width)));
		const firstChoice = this.starts[0] ?? this.lines.length;
		const selectedStart = this.starts[this.selected] ?? this.lines.length;
		const selectedEnd = this.starts[this.selected + 1] ?? this.lines.length;
		for (let i = this.top; i < Math.min(this.lines.length, this.top + available); i++) {
			let row = this.lines[i]!;
			if (i >= selectedStart && i < selectedEnd) row = theme.bg("selectedBg", theme.fg("accent", (i === selectedStart ? "› " : "  ") + row));
			else if (i >= firstChoice) row = "  " + row;
			frame.push(truncateToWidth(" " + row, width));
		}
		let help = this.choices.length ? "↑↓ 选择  " + keyHint("tui.select.confirm", "确认") + "  " : "";
		if (this.lines.length > available) help += "PgUp/PgDn 翻页  ";
		frame.push(truncateToWidth(" " + keyHint("tui.select.cancel", "关闭") + "  " + help.trimEnd(), width));
		this.frame = frame;
		return frame;
	}

	handleInput(data: string): void {
		if (!this.done || isKeyRelease(data)) return;
		const kb = getKeybindings();
		if (kb.matches(data, "tui.select.cancel")) return this.cancel();
		const down = kb.matches(data, "tui.select.down");
		const up = kb.matches(data, "tui.select.up");
		if ((down || up) && this.choices.length) {
			this.selected = Math.max(0, Math.min(this.choices.length - 1, this.selected + (down ? 1 : -1)));
			this.revealChoice = true;
			this.frame = undefined;
		} else if (kb.matches(data, "tui.select.confirm") && this.choices.length && !isKeyRepeat(data)) {
			const start = this.starts[this.selected];
			if (start === undefined || this.height < 2) return;
			if (start < this.top || start >= this.top + this.contentRows) {
				this.revealChoice = true;
				this.frame = undefined;
			} else this.done(this.selected);
		} else {
			const page = Math.max(1, this.contentRows);
			if (kb.matches(data, "tui.select.pageUp")) this.top -= page;
			else if (kb.matches(data, "tui.select.pageDown")) this.top += page;
			else if (up || down) this.top += down ? 1 : -1;
			else return;
			this.frame = undefined;
		}
	}

	cancel(): void { this.done?.(); }

	dispose(): void {
		this.done = undefined;
		this.body = "";
		this.choices = [];
		this.lines = [];
		this.starts = [];
		this.frame = undefined;
	}
}
