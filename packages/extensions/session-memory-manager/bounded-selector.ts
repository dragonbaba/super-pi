import { isKeyRelease, isKeyRepeat, truncateToWidth, wrapTextWithAnsi } from "@super-pi/tui";
import type { KeybindingsManager, Theme } from "@super-pi/coding-agent";
import { DynamicBorder } from "@super-pi/coding-agent";
import { UI_LINE_BREAK_PATTERN } from "./regex.ts";
import { sanitizeSessionText } from "./ui-text.ts";

export interface BoundedSelectorItem<T> {
  value: T;
  label: string;
  description?: string;
  detail?: string;
  selectable?: boolean;
  dangerous?: boolean;
  tone?: "normal" | "danger";
}

type SelectorKeybindings = Pick<KeybindingsManager, "matches" | "getKeys">;
type SelectorTheme = Pick<Theme, "bold" | "fg">;
type SelectorFocus = "browse" | "actions";
type PreparedSelectorItem<T> = BoundedSelectorItem<T> & { display: string };

/** Each instance owns its prepared records and one width/selection detail cache. */
export class BoundedMemorySelector<T> {
  private browseIndex = 0;
  private actionIndex = 0;
  private focus: SelectorFocus = "actions";
  private hasFocus = false;
  private settled = false;
  private readonly titleLines: string[];
  private readonly items: PreparedSelectorItem<T>[] = [];
  private readonly browse: number[] = [];
  private readonly actions: number[] = [];
  private readonly safeAction: number;
  private readonly hints: string[];
  private detailIndex: number | undefined;
  private detailText: string | undefined;
  private detailWidth = 0;
  private detailLines: string[] = [];
  /** Deterministic test/diagnostic counter for actual production wrapping calls. */
  private detailWrapCount = 0;
  private detailOffset = 0;
  private detailsExpanded = true;
  private pasteActive = false;
  private pastePrefix = "";
  private visible = 1;
  private actionVisible = 1;
  private detailRows = 1;
  private renderedWidth = 0;
  private renderedRows = 0;
  private actionPainted = false;
  private inputReadyAt = performance.now() + 250;
  private readonly theme: SelectorTheme;
  private readonly border: DynamicBorder;
  private borderWidth = 0;
  private borderLine = "";
  private readonly keybindings: SelectorKeybindings;
  private done: ((result: T | undefined) => void) | undefined;
  private getAvailableRows: (() => number) | undefined;

  constructor(
    title: string,
    items: readonly BoundedSelectorItem<T>[],
    theme: SelectorTheme,
    keybindings: SelectorKeybindings,
    done: ((result: T | undefined) => void) | undefined,
    getAvailableRows: (() => number) | undefined,
    initialIndex = 0,
  ) {
    this.theme = theme;
    this.border = new DynamicBorder((value) => this.theme.fg("border", value));
    this.keybindings = keybindings;
    this.done = done;
    this.getAvailableRows = getAvailableRows;
    this.titleLines = title.split(UI_LINE_BREAK_PATTERN).slice(0, 3).map(sanitizeTitle);
    for (let index = 0; index < items.length; index++) {
      const item = items[index]!;
      const label = sanitizeSessionText(item.label, Infinity);
      const description = sanitizeSessionText(item.description, Infinity);
      const detail = sanitizeSessionText(item.detail, Infinity);
      this.items.push({ ...item, label, description, detail, display: description ? `${label} ${description}` : label });
      if (item.selectable === false) this.browse.push(index);
      else this.actions.push(index);
    }
    const requested = this.actions.indexOf(initialIndex);
    let safeAction = -1;
    for (let position = this.actions.length - 1; position >= 0; position--) {
      if (!this.items[this.actions[position]!]!.dangerous) {
        safeAction = position;
        break;
      }
    }
    this.safeAction = requested >= 0 && !this.items[initialIndex]!.dangerous ? requested : Math.max(0, safeAction);
    this.actionIndex = this.safeAction;
		this.hints = [
			this.hint("tui.input.tab") + " 候选/操作；候选文件只读",
      this.hint("tui.select.up") + "/" + this.hint("tui.select.down") + " 移动；" + this.hint("tui.select.pageUp") + "/" + this.hint("tui.select.pageDown") + " 路径翻页",
      this.hint("tui.editor.cursorLeft") + "/" + this.hint("tui.editor.cursorRight") + " 展开/折叠详情；" + this.hint("tui.select.confirm") + " 确认；" + this.hint("tui.select.cancel") + " 取消",
    ];
  }

  get focused(): boolean { return this.hasFocus; }
  set focused(value: boolean) {
    if (value === this.hasFocus) return;
    this.hasFocus = value;
    this.resetAction();
    this.inputReadyAt = performance.now() + 250;
  }

  private hint(key: Parameters<SelectorKeybindings["getKeys"]>[0]): string {
    return this.keybindings.getKeys(key).join("/") || "未绑定";
  }

  private resetAction(): void {
    this.actionIndex = this.safeAction;
    this.actionPainted = false;
  }

  invalidate(): void {
    this.detailWidth = 0;
    this.borderWidth = 0;
    this.borderLine = "";
    this.resetAction();
  }

  dispose(): void {
    this.settled = true;
    this.done = undefined;
    this.getAvailableRows = undefined;
    this.detailLines = [];
    this.detailIndex = undefined;
    this.detailText = undefined;
    this.detailWidth = 0;
    this.borderWidth = 0;
    this.borderLine = "";
    this.pasteActive = false;
    this.pastePrefix = "";
    this.items.length = 0;
    this.browse.length = 0;
    this.actions.length = 0;
    this.titleLines.length = 0;
    this.hints.length = 0;
  }

  private line(text: string, width: number, color: Parameters<SelectorTheme["fg"]>[0] = "text"): string {
    return this.theme.fg(color, truncateToWidth(text, width, "…"));
  }

  private separator(width: number): string {
    if (width !== this.borderWidth) {
      this.borderWidth = width;
      this.borderLine = this.border.render(width)[0] ?? "";
    }
    return this.borderLine;
  }

  render(width: number): string[] {
    if (this.settled) return [];
    const rows = Math.max(0, Math.floor(this.getAvailableRows?.() ?? 0));
    width = Math.max(0, Math.floor(width));
    if (width !== this.renderedWidth || rows !== this.renderedRows) this.resetAction();
    this.renderedWidth = width;
    this.renderedRows = rows;
    // The overlay's actual available rectangle bounds every section. Action rows
    // are a viewport over the full action index, so a long Session history does
    // not turn the fixed-height overlay into an unusable resize warning.
    const browseOverhead = this.browse.length > 0 ? 1 : 0;
    const fixedRows = this.titleLines.length + this.hints.length + browseOverhead + 4;
    const minimum = fixedRows + (this.browse.length > 0 ? 1 : 0) + 1 + 1;
    if (width < 24 || rows < minimum) {
      this.actionPainted = false;
      return rows === 0 ? [] : [this.line("放大窗口 / " + this.hint("tui.select.cancel") + " 取消", width, "error")];
    }
    let remaining = rows - fixedRows;
    this.visible = this.browse.length > 0 ? Math.min(4, this.browse.length, Math.max(1, remaining - 2)) : 0;
    remaining -= this.visible;
    this.actionVisible = this.actions.length > 0
      ? Math.min(8, this.actions.length, Math.max(1, remaining - 1))
      : 0;
    remaining -= this.actionVisible;
    this.detailRows = Math.max(1, Math.min(4, remaining));
    const lines: string[] = [];
    for (const title of this.titleLines) lines.push(this.line(title, width, "accent"));
    lines.push(this.separator(width));
    if (this.browse.length > 0) {
		lines.push(this.line("候选文件 " + (this.browseIndex + 1) + "/" + this.browse.length, width, "muted"));
      const start = Math.max(0, Math.min(this.browseIndex - Math.floor(this.visible / 2), this.browse.length - this.visible));
      for (let position = start; position < start + this.visible; position++) {
        const item = this.items[this.browse[position]!]!;
        lines.push(this.line((this.focus === "browse" && position === this.browseIndex ? "→ " : "  ") + item.display, width));
      }
    }
    const actionTotal = this.actions.length;
    const actionStart = actionTotal === 0
      ? 0
      : Math.max(0, Math.min(this.actionIndex - Math.floor(this.actionVisible / 2), actionTotal - this.actionVisible));
    const actionEnd = Math.min(actionTotal, actionStart + this.actionVisible);
		lines.push(this.line(actionTotal > this.actionVisible
			? `操作 ${actionStart + 1}-${actionEnd}/${actionTotal}`
			: "操作", width, "muted"));
    for (let position = actionStart; position < actionEnd; position++) {
      const item = this.items[this.actions[position]!]!;
      const selected = this.focus === "actions" && position === this.actionIndex;
      lines.push(this.line((selected ? "→ " : "  ") + item.display, width, item.dangerous ? "error" : selected ? "accent" : "text"));
    }
    const index = this.browse.length > 0 ? this.browse[this.browseIndex] : this.actions[this.actionIndex];
    const detail = index === undefined ? undefined : this.items[index]!.detail;
    this.detailRows = detail && this.detailsExpanded ? Math.max(1, Math.min(4, remaining)) : 0;
		if (detail && (index !== this.detailIndex || width !== this.detailWidth || detail !== this.detailText)) {
      this.detailIndex = index;
      this.detailText = detail;
      this.detailWidth = width;
      this.detailLines = wrapTextWithAnsi(detail, width);
      this.detailWrapCount++;
    }
    const detailCount = detail && index === this.detailIndex && detail === this.detailText ? this.detailLines.length : 0;
    this.detailOffset = Math.max(0, Math.min(this.detailOffset, detailCount - this.detailRows));
		lines.push(this.separator(width));
		lines.push(this.line("所选文件详情 " + (this.detailsExpanded ? (detailCount ? (this.detailOffset + 1) + "/" + detailCount : "—") : "已折叠"), width, "muted"));
    for (let row = 0; row < this.detailRows; row++) lines.push(this.line((detailCount ? this.detailLines[this.detailOffset + row] : "") ?? "", width, "muted"));
    for (const hint of this.hints) lines.push(this.line(hint, width, "dim"));
    this.actionPainted = true;
    return lines;
  }

  handleInput(data: string): void {
    if (this.settled || !this.hasFocus) return;
    if (this.consumePaste(data) || isKeyRelease(data)) return;
    const repeated = isKeyRepeat(data);
    if (this.keybindings.matches(data, "tui.select.cancel")) { this.finish(undefined); return; }
    const rows = Math.max(0, Math.floor(this.getAvailableRows?.() ?? 0));
    if (rows !== this.renderedRows || !this.actionPainted) return;
    if (!repeated && this.keybindings.matches(data, "tui.input.tab") && this.browse.length > 0) {
      this.focus = this.focus === "browse" ? "actions" : "browse";
      this.resetAction();
      this.detailOffset = 0;
      return;
    }
    if (!repeated && (this.keybindings.matches(data, "tui.editor.cursorLeft") || this.keybindings.matches(data, "tui.editor.cursorRight"))) {
      this.detailsExpanded = !this.detailsExpanded;
      this.detailOffset = 0;
      this.actionPainted = false;
      return;
    }
    const up = this.keybindings.matches(data, "tui.select.up") || data === "k";
    const down = this.keybindings.matches(data, "tui.select.down") || data === "j";
    if (up || down) {
      const count = this.focus === "browse" ? this.browse.length : this.actions.length;
      if (count === 0) return;
      const delta = up ? -1 : 1;
      if (this.focus === "browse") this.browseIndex = (this.browseIndex + delta + count) % count;
      else { this.actionIndex = (this.actionIndex + delta + count) % count; this.inputReadyAt = performance.now() + 150; }
      this.actionPainted = false;
      this.detailOffset = 0;
      return;
    }
    if (this.keybindings.matches(data, "tui.select.pageUp")) { this.detailOffset = Math.max(0, this.detailOffset - this.detailRows); return; }
    if (this.keybindings.matches(data, "tui.select.pageDown")) { this.detailOffset += this.detailRows; return; }
    const confirm = data === "\r" || data === "\n" || this.keybindings.matches(data, "tui.select.confirm");
    if (!repeated && performance.now() >= this.inputReadyAt && confirm && this.focus === "actions") {
      const item = this.items[this.actions[this.actionIndex]!];
      if (item) this.finish(item.value);
    }
  }

  // Input buffering normally assembles paste markers. Keep a bounded local
  // boundary too, so fragmented extension input cannot approve an action.
  private consumePaste(data: string): boolean {
    const input = this.pastePrefix ? this.pastePrefix + data : data;
    this.pastePrefix = "";
    const marker = this.pasteActive ? "\x1b[201~" : "\x1b[200~";
    const start = input.indexOf(marker);
    if (start >= 0) {
      if (!this.pasteActive) {
        this.pasteActive = true;
        this.consumePaste(input.slice(start + marker.length));
      } else {
        this.pasteActive = false;
      }
      this.resetAction();
      this.inputReadyAt = performance.now() + 250;
      return true;
    }
    // A standalone Esc remains cancellation. Longer incomplete marker prefixes
    // retain at most five characters, never the pasted content.
    for (let length = Math.min(marker.length - 1, input.length); length >= 4; length--) {
      if (input.endsWith(marker.slice(0, length))) {
        this.pastePrefix = marker.slice(0, length);
        return true;
      }
    }
    return this.pasteActive;
  }

  private finish(value: T | undefined): void {
    if (this.settled) return;
    const done = this.done;
    this.dispose();
    done?.(value);
  }
}

function sanitizeTitle(text: string): string { return sanitizeSessionText(text, Infinity); }
