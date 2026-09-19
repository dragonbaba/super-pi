import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { BoundedMemorySelector } from "../packages/extensions/session-memory-manager/bounded-selector.ts";
import { inspectBashPermissionScope } from "../packages/extensions/resource-lifecycle-guard/permission-bash.ts";
import { inspectBashResourceLifecycle, inspectHighRiskBashMutation } from "../packages/extensions/resource-lifecycle-guard/core.ts";
import { parseTimeoutInvocation } from "../packages/extensions/resource-lifecycle-guard/timeout-wrapper.ts";
import type { Terminal } from "../packages/tui/src/terminal.ts";
import { TuiMainScreen } from "../packages/tui/src/tui-main-screen.ts";
import { TuiAltScreen } from "../packages/tui/src/tui-alt-screen.ts";
import { getKeybindings } from "../packages/tui/src/keybindings.ts";
import { stripTerminalSequences } from "../packages/tui/src/utils.ts";

const require = createRequire(import.meta.url);
const { Terminal: HeadlessTerminal } = require("@xterm/headless") as {
  Terminal: new (options: Record<string, unknown>) => {
    write(data: string, callback?: () => void): void;
    resize(columns: number, rows: number): void;
    dispose(): void;
    buffer: { active: { length: number; getLine(index: number): { translateToString(trimRight: boolean): string } | undefined } };
  };
};

class CaptureTerminal implements Terminal {
  columns: number;
  rows: number;
  readonly kittyProtocolActive = false;
  readonly writes: string[] = [];
  private readonly emulator: InstanceType<typeof HeadlessTerminal>;
  private input: ((data: string) => void) | undefined;
  private resizeHandler: (() => void) | undefined;
  private pending = 0;

  constructor(columns: number, rows: number) {
    this.columns = columns;
    this.rows = rows;
    this.emulator = new HeadlessTerminal({ columns, cols: columns, rows, scrollback: 1000, allowProposedApi: true });
  }

  start(input: (data: string) => void, resize: () => void): void { this.input = input; this.resizeHandler = resize; }
  stop(): void { this.input = undefined; this.resizeHandler = undefined; }
  async drainInput(): Promise<void> {}
  write(data: string): void {
    this.writes.push(data);
    this.pending++;
    this.emulator.write(data, () => this.pending--);
  }
  writeFrame(data: string, generation: number): void { void generation; this.write(data); }
  setFrameWriteCompletionListener(): void {}
  cancelFrameWrite(): void {}
  moveBy(): void {}
  hideCursor(): void {}
  showCursor(): void {}
  clearLine(): void {}
  clearFromCursor(): void {}
  clearScreen(): void {}
  setTitle(): void {}
  setProgress(): void {}

  emit(data: string): void { this.input?.(data); }
  resizeTo(columns: number, rows: number): void {
    this.columns = columns;
    this.rows = rows;
    this.emulator.resize(columns, rows);
    this.resizeHandler?.();
  }
  async flush(): Promise<void> {
    for (let index = 0; index < 500 && this.pending > 0; index++) await new Promise<void>((resolve) => setTimeout(resolve, 0));
    assert.equal(this.pending, 0);
  }
  visible(): string[] {
    const lines: string[] = [];
    const buffer = this.emulator.buffer.active;
    for (let row = 0; row < this.rows; row++) lines.push(buffer.getLine(buffer.length - this.rows + row)?.translateToString(true) ?? "");
    return lines;
  }
  dispose(): void { this.emulator.dispose(); }
}

const theme = { bold: (value: string) => value, fg: (_tone: string, value: string) => value };
const keybindings = getKeybindings();

function confirmationItems(): Array<{ value: boolean; label: string; selectable?: boolean; detail?: string; dangerous?: boolean }> {
  return [
    { value: false, label: "very-long-session-file-name.jsonl", selectable: false, detail: "/tmp/synthetic/" + "长路径😀e\u0301/".repeat(50) },
    { value: true, label: "永久删除", dangerous: true },
    { value: false, label: "取消，保留全部回收文件" },
  ];
}

test("memory clean selector separates read-only browsing and defaults to cancel", async () => {
  let result: boolean | undefined = undefined;
  const selector = new BoundedMemorySelector("再次确认", confirmationItems(), theme, keybindings, (value) => { result = value; }, () => 24, 1);
  const initial = selector.render(40).join("\n");
  assert.match(initial, /取消/);
  assert.doesNotMatch(initial, /→ 永久删除/);
  selector.focused = true;
  await new Promise<void>((resolve) => setTimeout(resolve, 260));
  selector.render(40);
  selector.handleInput("\u001b[200~\n\u001b[201~");
  assert.equal(result, undefined);
  selector.handleInput("\r");
  assert.equal(result, false);
  assert.equal(selector.render(40).length, 0);
});

test("memory clean selector keeps a fixed detail area and bounds narrow windows", () => {
  const selector = new BoundedMemorySelector("再次确认", confirmationItems(), theme, keybindings, () => {}, () => 24, 0);
  const firstHeight = selector.render(40).length;
  selector.handleInput("tab");
  const browseHeight = selector.render(40).length;
  selector.handleInput("down");
  const nextHeight = selector.render(40).length;
  assert.equal(firstHeight, browseHeight);
  assert.equal(browseHeight, nextHeight);
  assert.ok(selector.render(10).every((line) => stripTerminalSequences(line).length <= 10));
});

test("Main and Alt frames stay bounded while toggling the clean dialog", async () => {
  const mainTerminal = new CaptureTerminal(50, 24);
  const altTerminal = new CaptureTerminal(50, 24);
  const main = new TuiMainScreen(mainTerminal, true);
  const alt = new TuiAltScreen(altTerminal, true);
  const selector = new BoundedMemorySelector("清理", confirmationItems(), theme, keybindings, () => {}, () => 22, 1);
  const altSelector = new BoundedMemorySelector("清理", confirmationItems(), theme, keybindings, () => {}, () => 22, 1);
  main.addChild(selector);
  alt.addChild(altSelector);
  main.setFocus(selector);
  alt.setFocus(altSelector);
  main.start();
  alt.start();
  main.renderNow(true);
  alt.renderNow(true);
  await mainTerminal.flush();
  await altTerminal.flush();
  for (let index = 0; index < 100; index++) {
    mainTerminal.emit(index % 2 === 0 ? "tab" : "down");
    altTerminal.emit(index % 2 === 0 ? "tab" : "down");
    main.renderNow();
    alt.renderNow();
    await mainTerminal.flush();
    await altTerminal.flush();
  }
  const mainPaths = mainTerminal.visible().join("\n").match(/synthetic/g) ?? [];
  const altPaths = altTerminal.visible().join("\n").match(/synthetic/g) ?? [];
  assert.ok(mainPaths.length <= 1);
  assert.ok(altPaths.length <= 1);
  assert.ok(mainTerminal.writes.length < 500);
  assert.ok(altTerminal.writes.length < 500);
  main.stop();
  alt.stop();
  mainTerminal.dispose();
  altTerminal.dispose();
});

const commandOne = "cd /d && timeout 250 find . -maxdepth 5 -type d -iname \"*封神*\" 2>/dev/null | head -20";
const commandTwo = "cd /d && timeout 250 find . -maxdepth 5 -type d -iname \"*216*\" 2>/dev/null | head -15; echo \"=== 8385 ===\"; timeout 200 find . -maxdepth 5 -type d -iname \"*8385*\" 2>/dev/null | head -10";

test("GNU timeout literals are recognized without probing or rewriting", () => {
  assert.deepEqual(parseTimeoutInvocation(["timeout", "250", "find", "."], 0), { supported: true, commandIndex: 2, seconds: 250 });
  assert.equal(parseTimeoutInvocation(["timeout", "0", "find"], 0).supported, false);
  assert.equal(inspectBashResourceLifecycle({ command: commandOne }), undefined);
  assert.equal(inspectBashResourceLifecycle({ command: commandTwo }), undefined);
  const scope = inspectBashPermissionScope({ command: commandOne }, process.cwd());
  assert.equal(scope?.kind, "read-only");
});

test("timeout scan continues into dangerous inner commands and preserves command boundaries", () => {
  const cases = [
    "timeout 250 find . -delete",
    "timeout 250 find . -exec rm -rf {} +",
    "timeout 250 rm -rf ./synthetic",
    "timeout 250 node -e \"require('fs').rmSync('./synthetic', {recursive:true})\"",
    "timeout 250 find . -type f > output.txt",
  ];
  for (const command of cases) {
    const lifecycle = inspectBashResourceLifecycle({ command });
    assert.equal(typeof lifecycle, "undefined", command);
    const scan = inspectHighRiskBashMutation({ command }, process.cwd());
    assert.ok(scan?.primitives.length || scan?.unverifiableScope, command);
  }
  assert.equal(inspectBashPermissionScope({ command: "timeout 250 find . -delete" }, process.cwd())?.kind, "known-mutation");
});

test("timeout keeps unsupported, dynamic, nested and Windows cases conservative", () => {
  for (const command of ["timeout --foreground 250 find .", "timeout 0 find .", "timeout $LIMIT find .", "timeout 250 $PROGRAM .", "timeout.exe 250 find .", "timeout 1 timeout 2 timeout 3 timeout 4 timeout 5 find ."]) {
    const lifecycle = inspectBashResourceLifecycle({ command });
    assert.match(lifecycle ?? "", /SHELL_WRAPPER|SHELL_INSPECTION_LIMIT/);
  }
});
