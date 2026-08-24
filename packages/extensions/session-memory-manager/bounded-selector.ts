import type { KeybindingsManager, Theme } from "@super-pi/coding-agent";

export interface BoundedSelectorItem<T> {
  value: T;
  label: string;
  description?: string;
  detail?: string;
  selectable?: boolean;
  tone?: "normal" | "danger";
}

type SelectorKeybindings = Pick<KeybindingsManager, "matches">;
type SelectorTheme = Pick<Theme, "bold" | "fg">;

const COMBINING_MARK = /\p{Mark}/u;

function codePointCellWidth(symbol: string): number {
  const codePoint = symbol.codePointAt(0) ?? 0;
  if (codePoint === 0 || codePoint < 0x20 || (codePoint >= 0x7f && codePoint < 0xa0)) return 0;
  if (COMBINING_MARK.test(symbol) || codePoint === 0x200d || (codePoint >= 0xfe00 && codePoint <= 0xfe0f)) return 0;
  if (
    codePoint >= 0x1100 && (
      codePoint <= 0x115f ||
      codePoint === 0x2329 ||
      codePoint === 0x232a ||
      (codePoint >= 0x2e80 && codePoint <= 0xa4cf && codePoint !== 0x303f) ||
      (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
      (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
      (codePoint >= 0xfe10 && codePoint <= 0xfe19) ||
      (codePoint >= 0xfe30 && codePoint <= 0xfe6f) ||
      (codePoint >= 0xff00 && codePoint <= 0xff60) ||
      (codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
      (codePoint >= 0x1f300 && codePoint <= 0x1faff) ||
      (codePoint >= 0x20000 && codePoint <= 0x3fffd)
    )
  ) return 2;
  return 1;
}

export function terminalCellWidth(text: string): number {
  let width = 0;
  for (const symbol of text) width += codePointCellWidth(symbol);
  return width;
}

function takeStart(text: string, maxWidth: number): string {
  let result = "";
  let width = 0;
  for (const symbol of text) {
    const symbolWidth = codePointCellWidth(symbol);
    if (width + symbolWidth > maxWidth) break;
    result += symbol;
    width += symbolWidth;
  }
  return result;
}

function takeEnd(text: string, maxWidth: number): string {
  const symbols = [...text];
  let result = "";
  let width = 0;
  for (let index = symbols.length - 1; index >= 0; index--) {
    const symbol = symbols[index];
    const symbolWidth = codePointCellWidth(symbol);
    if (width + symbolWidth > maxWidth) break;
    result = symbol + result;
    width += symbolWidth;
  }
  return result;
}

export function truncateMiddleToTerminalWidth(text: string, maxWidth: number): string {
  const normalized = text.replace(/[\r\n]+/gu, " ").trim();
  if (terminalCellWidth(normalized) <= maxWidth) return normalized;
  if (maxWidth <= 1) return maxWidth === 1 ? "…" : "";
  const available = maxWidth - 1;
  const leftWidth = Math.ceil(available / 2);
  const rightWidth = Math.floor(available / 2);
  return `${takeStart(normalized, leftWidth)}…${takeEnd(normalized, rightWidth)}`;
}

function wrapToTerminalWidth(text: string, maxWidth: number, maxLines: number): string[] {
  const normalized = text.replace(/[\r\n]+/gu, " ").trim();
  if (!normalized) return [];
  const lines: string[] = [];
  let line = "";
  let lineWidth = 0;
  for (const symbol of normalized) {
    const symbolWidth = codePointCellWidth(symbol);
    if (line && lineWidth + symbolWidth > maxWidth) {
      lines.push(line);
      line = "";
      lineWidth = 0;
      if (lines.length === maxLines) break;
    }
    line += symbol;
    lineWidth += symbolWidth;
  }
  if (lines.length < maxLines && line) lines.push(line);
  const consumedWidth = lines.reduce((total, item) => total + terminalCellWidth(item), 0);
  if (consumedWidth < terminalCellWidth(normalized)) {
    const last = lines.length - 1;
    lines[last] = truncateMiddleToTerminalWidth(`${lines[last]}…`, maxWidth);
  }
  return lines;
}

export class BoundedMemorySelector<T> {
  private selectedIndex = 0;
  private settled = false;
  private readonly title: string;
  private readonly items: readonly BoundedSelectorItem<T>[];
  private readonly maxVisible: number;
  private readonly theme: SelectorTheme;
  private readonly keybindings: SelectorKeybindings;
  private readonly done: (result: T | undefined) => void;
  private readonly maxDetailLines: number;

  constructor(
    title: string,
    items: readonly BoundedSelectorItem<T>[],
    maxVisible: number,
    theme: SelectorTheme,
    keybindings: SelectorKeybindings,
    done: (result: T | undefined) => void,
    maxDetailLines = 4,
  ) {
    this.title = title;
    this.items = items;
    this.maxVisible = maxVisible;
    this.theme = theme;
    this.keybindings = keybindings;
    this.done = done;
    this.maxDetailLines = Math.max(1, maxDetailLines);
  }

  setSelectedIndex(index: number): void {
    this.selectedIndex = Math.max(0, Math.min(index, this.items.length - 1));
  }

  invalidate(): void {}

  render(width: number): string[] {
    const contentWidth = Math.max(8, width - 2);
    const lines = this.title.split(/\r?\n/u).slice(0, 3).map((line) =>
      this.theme.fg("accent", this.theme.bold(truncateMiddleToTerminalWidth(line, contentWidth)))
    );
    lines.push("");

    const visible = Math.max(1, Math.min(this.maxVisible, this.items.length));
    const start = Math.max(0, Math.min(this.selectedIndex - Math.floor(visible / 2), this.items.length - visible));
    const end = Math.min(start + visible, this.items.length);
    for (let index = start; index < end; index++) {
      const item = this.items[index];
      const selected = index === this.selectedIndex;
      const prefix = selected ? "→ " : "  ";
      const description = item.description ? `  ${item.description}` : "";
      const text = truncateMiddleToTerminalWidth(`${prefix}${item.label}${description}`, contentWidth);
      const color = item.tone === "danger" ? "error" : selected ? "accent" : "text";
      lines.push(this.theme.fg(color, selected ? this.theme.bold(text) : text));
    }
    if (this.items.length > visible) {
      lines.push(this.theme.fg(
        "dim",
        truncateMiddleToTerminalWidth(`  ${this.selectedIndex + 1}/${this.items.length}  PgUp/PgDn 翻页`, contentWidth),
      ));
    }

    const selected = this.items[this.selectedIndex];
    if (selected?.detail) {
      lines.push("");
      for (const detailLine of wrapToTerminalWidth(selected.detail, contentWidth, this.maxDetailLines)) {
        lines.push(this.theme.fg("muted", detailLine));
      }
    }
    lines.push(
      "",
      this.theme.fg("dim", truncateMiddleToTerminalWidth("↑↓/j/k 滚动  Enter 选择  Esc 取消", contentWidth)),
    );
    return lines;
  }

  handleInput(data: string): void {
    if (this.settled || this.items.length === 0) return;
    if (this.keybindings.matches(data, "tui.select.up") || data === "k") {
      this.selectedIndex = this.selectedIndex === 0 ? this.items.length - 1 : this.selectedIndex - 1;
      return;
    }
    if (this.keybindings.matches(data, "tui.select.down") || data === "j") {
      this.selectedIndex = this.selectedIndex === this.items.length - 1 ? 0 : this.selectedIndex + 1;
      return;
    }
    if (this.keybindings.matches(data, "tui.select.pageUp")) {
      this.selectedIndex = Math.max(0, this.selectedIndex - this.maxVisible);
      return;
    }
    if (this.keybindings.matches(data, "tui.select.pageDown")) {
      this.selectedIndex = Math.min(this.items.length - 1, this.selectedIndex + this.maxVisible);
      return;
    }
    if (this.keybindings.matches(data, "tui.select.confirm") || data === "\n") {
      const selected = this.items[this.selectedIndex];
      if (!selected || selected.selectable === false) return;
      this.settled = true;
      this.done(selected.value);
      return;
    }
    if (this.keybindings.matches(data, "tui.select.cancel")) {
      this.settled = true;
      this.done(undefined);
    }
  }
}
