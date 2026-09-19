import { isKeyRelease, isKeyRepeat, truncateToWidth, wrapTextWithAnsi } from "@super-pi/tui";
import type { KeybindingsManager, Theme } from "@super-pi/coding-agent";
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

/** Each instance owns its prepared records and one width/selection detail cache. */
export class BoundedMemorySelector<T> {
  private browseIndex = 0;
  private actionIndex = 0;
  private focus: SelectorFocus = "actions";
  private hasFocus = false;
  private settled = false;
  private readonly titleLines: string[];
  private readonly items: BoundedSelectorItem<T>[] = [];
  private readonly browse: number[] = [];
  private readonly actions: number[] = [];
  private readonly safeAction: number;
  private readonly hints: string[];
  private detailIndex: number | undefined;
  private detailWidth = 0;
  private detailLines: string[] = [];
  private detailOffset = 0;
  private visible = 1;
  private detailRows = 1;
  private renderedWidth = 0;
  private renderedRows = 0;
  private actionPainted = false;
  private inputReadyAt = performance.now() + 250;
  private readonly theme: SelectorTheme;
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
    this.keybindings = keybindings;
    this.done = done;
    this.getAvailableRows = getAvailableRows;
    this.titleLines = title.split(UI_LINE_BREAK_PATTERN).slice(0, 3).map(sanitizeTitle);
    for (let index = 0; index < items.length; index++) {
      const item = items[index]!;
      this.items.push({ ...item, label: sanitizeSessionText(item.label, Infinity),
        description: sanitizeSessionText(item.description, Infinity), detail: sanitizeSessionText(item.detail, Infinity) });
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
      this.hint("tui.input.tab") + " 浏览/动作；文件只读",
      this.hint("tui.select.up") + "/" + this.hint("tui.select.down") + " 移动；" + this.hint("tui.select.pageUp") + "/" + this.hint("tui.select.pageDown") + " 路径翻页",
      this.hint("tui.select.confirm") + " 确认动作；" + this.hint("tui.select.cancel") + " 取消",
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
    this.resetAction();
  }

  dispose(): void {
    this.settled = true;
    this.done = undefined;
    this.getAvailableRows = undefined;
    this.detailLines = [];
    this.items.length = 0;
    this.browse.length = 0;
    this.actions.length = 0;
    this.titleLines.length = 0;
    this.hints.length = 0;
  }

  private line(text: string, width: number, color: Parameters<SelectorTheme["fg"]>[0] = "text"): string {
    return this.theme.fg(color, truncateToWidth(text, width, "…"));
  }

  render(width: number): string[] {
    if (this.settled) return [];
    const rows = Math.max(0, Math.floor(this.getAvailableRows?.() ?? 0));
    width = Math.max(0, Math.floor(width));
    if (width !== this.renderedWidth || rows !== this.renderedRows) this.resetAction();
    this.renderedWidth = width;
    this.renderedRows = rows;
    const minimum = this.titleLines.length + this.actions.length + 7;
    if (width < 24 || rows < minimum) {
      this.actionPainted = false;
      return rows === 0 ? [] : [this.line("放大窗口 / " + this.hint("tui.select.cancel") + " 取消", width, "error")];
    }
    // The overlay's actual available rectangle bounds every section; navigation
    // only changes content, never the total number of returned lines.
    const browseOverhead = this.browse.length > 0 ? 1 : 0;
    const remaining = rows - this.titleLines.length - this.actions.length - this.hints.length - 2 - browseOverhead;
    this.visible = this.browse.length > 0 ? Math.min(4, this.browse.length, Math.max(1, remaining - 2)) : 0;
    this.detailRows = Math.max(1, Math.min(4, remaining - this.visible));
    const lines: string[] = [];
    for (const title of this.titleLines) lines.push(this.line(title, width, "accent"));
    if (this.browse.length > 0) {
      lines.push(this.line("只读文件 " + (this.browseIndex + 1) + "/" + this.browse.length, width, "muted"));
      const start = Math.max(0, Math.min(this.browseIndex - Math.floor(this.visible / 2), this.browse.length - this.visible));
      for (let position = start; position < start + this.visible; position++) {
        const item = this.items[this.browse[position]!]!;
        lines.push(this.line((this.focus === "browse" && position === this.browseIndex ? "→ " : "  ") + item.label + " " + item.description, width));
      }
    }
    lines.push(this.line("动作", width, "muted"));
    for (let position = 0; position < this.actions.length; position++) {
      const item = this.items[this.actions[position]!]!;
      const selected = this.focus === "actions" && position === this.actionIndex;
      lines.push(this.line((selected ? "→ " : "  ") + item.label + " " + item.description, width, item.dangerous ? "error" : selected ? "accent" : "text"));
    }
    const index = this.focus === "browse" ? this.browse[this.browseIndex] : this.actions[this.actionIndex];
    if (index !== this.detailIndex || width !== this.detailWidth) {
      this.detailIndex = index;
      this.detailWidth = width;
      this.detailLines = index === undefined || !this.items[index]!.detail ? [] : wrapTextWithAnsi(this.items[index]!.detail!, width);
    }
    this.detailOffset = Math.max(0, Math.min(this.detailOffset, this.detailLines.length - this.detailRows));
    lines.push(this.line("完整路径 " + (this.detailLines.length ? (this.detailOffset + 1) + "/" + this.detailLines.length : "—"), width, "muted"));
    for (let row = 0; row < this.detailRows; row++) lines.push(this.line(this.detailLines[this.detailOffset + row] ?? "", width, "muted"));
    for (const hint of this.hints) lines.push(this.line(hint, width, "dim"));
    this.actionPainted = true;
    return lines;
  }

  handleInput(data: string): void {
    if (this.settled || !this.hasFocus) return;
    if (isKeyRelease(data) || isKeyRepeat(data) || data.includes("\x1b[200~") || data.includes("\x1b[201~")) return;
    if (this.keybindings.matches(data, "tui.select.cancel")) { this.finish(undefined); return; }
    if (performance.now() < this.inputReadyAt) return;
    const rows = Math.max(0, Math.floor(this.getAvailableRows?.() ?? 0));
    if (rows !== this.renderedRows || !this.actionPainted) return;
    if (this.keybindings.matches(data, "tui.input.tab") && this.browse.length > 0) {
      this.focus = this.focus === "browse" ? "actions" : "browse";
      this.resetAction();
      this.detailOffset = 0;
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
    if (this.keybindings.matches(data, "tui.select.confirm") && this.focus === "actions") {
      const item = this.items[this.actions[this.actionIndex]!];
      if (item) this.finish(item.value);
    }
  }

  private finish(value: T | undefined): void {
    if (this.settled) return;
    this.settled = true;
    const done = this.done;
    this.done = undefined;
    done?.(value);
  }
}

function sanitizeTitle(text: string): string { return sanitizeSessionText(text, Infinity); }
