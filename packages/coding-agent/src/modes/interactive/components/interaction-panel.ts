import { getKeybindings, Input, isKeyRelease, isKeyRepeat, matchesKey, truncateToWidth, wrapTextWithAnsi, type TUI } from "@super-pi/tui";
import type { QuestionPage, QuestionPageResult } from "../../../core/extensions/types.ts";
import { MAX_QUESTION_ANSWER_LENGTH } from "../../../core/tools/question-dialogs.ts";
import { sanitizeDialogChoice, sanitizeDialogText } from "./selector-text.ts";
import { theme } from "../theme/theme.ts";
import { keyHint, rawKeyHint } from "./keybinding-hints.ts";

/** A temporary, keyboard-focused overlay. Content is prepared by its caller at open time. */
export class InteractionPanel {
	private selected = 0;
	private top = 0;
	private width = -1;
	private height = -1;
	private revealChoice = false;
	private page?: QuestionPage;
	private finishPage?: (result?: QuestionPageResult) => void;
	private input?: Input;
	private hasFocus = false;
	get focused(): boolean { return this.hasFocus; }
	set focused(value: boolean) {
		this.hasFocus = value;
		if (this.input) this.input.focused = value;
		this.frame = undefined;
	}
	private get editing(): boolean { return !!this.page && this.selected === this.page.options.length; }
	private get contentRows(): number {
		return Math.max(0, this.height - (this.height >= 4 ? 2 : 1) - (this.editing ? 1 : 0));
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

	static forQuestion(page: QuestionPage, terminal: TUI["terminal"], done: (result?: QuestionPageResult) => void): InteractionPanel {
		const progress = page.count > 1 ? theme.fg("dim", `${page.index + 1}/${page.count}  `) : "";
		let body = progress + theme.bold(sanitizeDialogText(page.title));
		if (page.description) body += "\n" + theme.fg("muted", sanitizeDialogText(page.description));
		const choices = page.options.map(sanitizeDialogChoice);
		if (choices.length) choices.push(`${choices.length + 1}. 自定义回答…`);
		const panel = new InteractionPanel(body, choices, terminal, () => done());
		panel.page = page;
		panel.finishPage = done;
		panel.selected = page.selected;
		panel.input = new Input();
		panel.input.setValue(page.text, page.text.length);
		return panel;
	}

	private submitPage(back: boolean): void {
		const text = this.input!.getValue();
		if (!back && this.editing && (!text.trim() || text.length > MAX_QUESTION_ANSWER_LENGTH)) return;
		this.finishPage?.({ back, selected: this.selected, text });
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
		if (this.editing && height > 1) frame.push(this.input!.render(width)[0]!);
		const multi = this.page !== undefined && this.page.count > 1;
		const confirm = multi ? (this.page!.index + 1 === this.page!.count ? "提交全部答案" : "下一题") : "确认";
		let help = this.choices.length ? "↑↓ 选择  " : "";
		if (this.choices.length || this.page) help += keyHint("tui.select.confirm", confirm) + "  ";
		if (this.lines.length > available) help += "PgUp/PgDn 翻页  ";
		if (!multi) help += keyHint("tui.select.cancel", "关闭");
		else if (this.page!.index > 0) help += rawKeyHint("Esc", "上一题");
		if (this.editing && !this.input!.getValue().trim()) help = "请输入自定义回答  " + help;
		if (this.editing && this.input!.getValue().length > MAX_QUESTION_ANSWER_LENGTH) help = `回答最多 ${MAX_QUESTION_ANSWER_LENGTH} 字符  ` + help;
		frame.push(truncateToWidth(" " + help.trimEnd(), width));
		this.frame = frame;
		return frame;
	}

	handleInput(data: string): void {
		if (!this.done || isKeyRelease(data)) return;
		const kb = getKeybindings();
		const multi = this.page !== undefined && this.page.count > 1;
		if (multi && (matchesKey(data, "escape") || matchesKey(data, "shift+tab"))) {
			if (this.page!.index > 0 && !isKeyRepeat(data)) this.submitPage(true);
			return;
		}
		if (kb.matches(data, "tui.select.cancel")) return this.cancel();
		const down = kb.matches(data, "tui.select.down");
		const up = kb.matches(data, "tui.select.up");
		if ((down || up) && this.choices.length) {
			this.selected = Math.max(0, Math.min(this.choices.length - 1, this.selected + (down ? 1 : -1)));
			this.revealChoice = true;
			this.frame = undefined;
		} else if (kb.matches(data, "tui.select.confirm") && (this.choices.length || this.page) && !isKeyRepeat(data)) {
			if (this.editing && this.height >= 2) return this.submitPage(false);
			const start = this.starts[this.selected];
			if (start === undefined || this.height < 2) return;
			if (start < this.top || start >= this.top + this.contentRows) {
				this.revealChoice = true;
				this.frame = undefined;
			} else if (this.page) this.submitPage(false);
			else this.done(this.selected);
		} else {
			const page = Math.max(1, this.contentRows);
			if (kb.matches(data, "tui.select.pageUp")) this.top -= page;
			else if (kb.matches(data, "tui.select.pageDown")) this.top += page;
			else if (up || down) this.top += down ? 1 : -1;
			else if (this.editing) this.input!.handleInput(data);
			else return;
			this.frame = undefined;
		}
	}

	cancel(): void { this.done?.(); }

	dispose(): void {
		this.done = undefined;
		this.page = undefined;
		this.finishPage = undefined;
		this.input = undefined;
		this.body = "";
		this.choices = [];
		this.lines = [];
		this.starts = [];
		this.frame = undefined;
	}
}
