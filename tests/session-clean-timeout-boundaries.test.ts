import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { BoundedMemorySelector } from "../packages/extensions/session-memory-manager/bounded-selector.ts";
import { inspectBashPermissionScope } from "../packages/extensions/resource-lifecycle-guard/permission-bash.ts";
import { inspectBashResourceLifecycle, inspectHighRiskBashMutation } from "../packages/extensions/resource-lifecycle-guard/core.ts";
import { parseTimeoutInvocation } from "../packages/extensions/resource-lifecycle-guard/timeout-wrapper.ts";
import { INTEGER_SECONDS_PATTERN } from "../packages/extensions/resource-lifecycle-guard/regex.ts";
import { TOOL_CALL_ID_SANITIZE_PATTERN } from "../packages/ai/src/api/anthropic-messages-regex.ts";
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
  private frameCompletion: ((generation: number, error?: Error) => void) | undefined;
  private pending = 0;

  constructor(columns: number, rows: number) {
    this.columns = columns;
    this.rows = rows;
    this.emulator = new HeadlessTerminal({ columns, cols: columns, rows, scrollback: 1000, allowProposedApi: true });
  }

  start(input: (data: string) => void, resize: () => void): void { this.input = input; this.resizeHandler = resize; }
  stop(): void { this.input = undefined; this.resizeHandler = undefined; }
  async drainInput(): Promise<void> {}
  write(data: string, completion?: () => void): void {
    this.writes.push(data);
    this.pending++;
    this.emulator.write(data, () => { this.pending--; completion?.(); });
  }
  writeFrame(data: string, generation: number): void { this.write(data, () => this.frameCompletion?.(generation)); }
  setFrameWriteCompletionListener(listener: ((generation: number, error?: Error) => void) | undefined): void { this.frameCompletion = listener; }
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

test("fixed regexes remain stateless across repeated and interleaved checks", () => {
  assert.equal(INTEGER_SECONDS_PATTERN.global, false);
  assert.equal(INTEGER_SECONDS_PATTERN.test("250"), true);
  assert.equal(INTEGER_SECONDS_PATTERN.test("200"), true);
  assert.equal(TOOL_CALL_ID_SANITIZE_PATTERN.global, true);
  assert.equal("a!b".replace(TOOL_CALL_ID_SANITIZE_PATTERN, "_"), "a_b");
  assert.equal(TOOL_CALL_ID_SANITIZE_PATTERN.lastIndex, 0);
  assert.equal("c?d".replace(TOOL_CALL_ID_SANITIZE_PATTERN, "_"), "c_d");
  assert.equal(TOOL_CALL_ID_SANITIZE_PATTERN.lastIndex, 0);
});
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
  assert.doesNotMatch(initial, /undefined/);
  selector.focused = true;
  await new Promise<void>((resolve) => setTimeout(resolve, 260));
  selector.render(40);
  selector.handleInput("\u001b[200~\n\u001b[201~");
  assert.equal(result, undefined);
  selector.render(40);
  await new Promise<void>((resolve) => setTimeout(resolve, 260));
  selector.handleInput("\r");
  assert.equal(result, false);
  assert.equal(selector.render(40).length, 0);
});

test("memory clean selector pages long action lists inside the overlay", async () => {
  let result: number | undefined;
  const items = Array.from({ length: 30 }, (_, index) => ({ value: index, label: `Session ${index}`, detail: `/tmp/synthetic/session-${index}.jsonl` }));
  const selector = new BoundedMemorySelector("选择 Session", items, theme, keybindings, value => { result = value; }, () => 24, 0);
  selector.focused = true;
  const first = selector.render(50).join("\n");
  assert.match(first, /动作 1-8\/30/);
  assert.ok(selector.render(50).length < 24);
  for (let index = 0; index < 29; index++) {
    selector.handleInput("\x1b[B");
    selector.render(50);
  }
  assert.match(selector.render(50).join("\n"), /动作 23-30\/30/);
  await new Promise<void>(resolve => setTimeout(resolve, 270));
  selector.handleInput("\r");
  assert.equal(result, 29);
  assert.equal((selector as any).items.length, 0);
});

test("memory clean selector retains raw Enter with incomplete keybindings", async () => {
  let result: boolean | undefined;
  const incomplete = {
    matches: (data: string, key: string) => key === "tui.select.cancel" && data === "\x1b",
    getKeys: keybindings.getKeys.bind(keybindings),
  };
  const selector = new BoundedMemorySelector("确认", confirmationItems(), theme, incomplete, value => { result = value; }, () => 22, 2);
  selector.focused = true;
  selector.render(40);
  await new Promise<void>(resolve => setTimeout(resolve, 270));
  selector.handleInput("\r");
  assert.equal(result, false);
});
test("memory clean selector keeps a fixed detail area and bounds narrow windows", () => {
  const selector = new BoundedMemorySelector("再次确认", confirmationItems(), theme, keybindings, () => {}, () => 24, 0);
  selector.focused = true;
  const firstHeight = selector.render(40).length;
  selector.handleInput("\t");
  const browseHeight = selector.render(40).length;
  selector.handleInput("\x1b[B");
  const nextHeight = selector.render(40).length;
  assert.equal(firstHeight, browseHeight);
  assert.equal(browseHeight, nextHeight);
  assert.ok(selector.render(10).every((line) => stripTerminalSequences(line).length <= 10));
  const tight = new BoundedMemorySelector("再次确认", confirmationItems(), theme, keybindings, () => {}, () => 11, 1);
  assert.equal(tight.render(40).length, 11);
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
  let browseFrames = 0;
  let actionFrames = 0;
  for (let index = 0; index < 100; index++) {
    mainTerminal.emit("\t");
    altTerminal.emit("\t");
    await new Promise<void>(resolve => setTimeout(resolve, 5));
    main.renderNow(true);
    alt.renderNow(true);
    selector.render(50);
    altSelector.render(50);
    await mainTerminal.flush();
    await altTerminal.flush();
    const expectedBrowse = index % 2 === 0;
    assert.equal((selector as any).focus, expectedBrowse ? "browse" : "actions");
    assert.equal((altSelector as any).focus, expectedBrowse ? "browse" : "actions");
    const mainFrame = mainTerminal.writes[mainTerminal.writes.length - 1] ?? "";
    const altFrame = altTerminal.writes[altTerminal.writes.length - 1] ?? "";
    assert.match(mainFrame, /完整路径/);
    assert.match(altFrame, /完整路径/);
    if (expectedBrowse) browseFrames++; else actionFrames++;
  }
  assert.deepEqual([browseFrames, actionFrames], [50, 50]);
  assert.ok(mainTerminal.writes.length > 1);
  assert.ok(altTerminal.writes.length > 1);
  const mainPaths = mainTerminal.visible().join("\n").match(/synthetic/g) ?? [];
  const altPaths = altTerminal.visible().join("\n").match(/synthetic/g) ?? [];
  assert.ok(mainPaths.length <= 1);
  assert.ok(altPaths.length <= 1);
  assert.ok(mainTerminal.writes.length < 500);
  assert.ok(altTerminal.writes.length < 500);
  mainTerminal.resizeTo(30, 14);
  altTerminal.resizeTo(30, 14);
  main.renderNow(true);
  alt.renderNow(true);
  await mainTerminal.flush();
  await altTerminal.flush();
  main.stop();
  alt.stop();
  selector.dispose();
  altSelector.dispose();
  for (const owner of [selector, altSelector]) {
    assert.equal((owner as any).items.length, 0);
    assert.equal((owner as any).detailLines.length, 0);
    assert.equal((owner as any).done, undefined);
    assert.equal((owner as any).getAvailableRows, undefined);
  }
  mainTerminal.dispose();
  altTerminal.dispose();
});

const commandOne = "cd /d && timeout 250 find . -maxdepth 5 -type d -iname \"*封神*\" 2>/dev/null | head -20";
const commandTwo = "cd /d && timeout 250 find . -maxdepth 5 -type d -iname \"*216*\" 2>/dev/null | head -15; echo \"=== 8385 ===\"; timeout 200 find . -maxdepth 5 -type d -iname \"*8385*\" 2>/dev/null | head -10";

test("GNU timeout literals are recognized without probing or rewriting", () => {
  assert.deepEqual(parseTimeoutInvocation(["timeout", "250", "find", "."], 0), { supported: true, commandIndex: 2, seconds: 250 });
  assert.equal(parseTimeoutInvocation(["timeout", "0", "find"], 0).supported, false);
  assert.equal(parseTimeoutInvocation(["timeout", "--", "250", "find"], 0).supported, false);
  assert.equal(inspectBashResourceLifecycle({ command: commandOne }), undefined);
  assert.equal(inspectBashResourceLifecycle({ command: commandTwo }), undefined);
  const scope = inspectBashPermissionScope({ command: commandOne }, process.cwd());
  assert.equal(scope?.kind, "read-only");
});

test("mutation scans cover compact output redirection forms", () => {
  for (const command of ["echo data >> important.log", "echo data 1> important.log", "echo data 2>>important.log"]) {
    const scan = inspectHighRiskBashMutation({ command }, process.cwd());
    assert.ok(scan?.primitives.includes("output_redirection"), command);
    assert.ok(scan?.targets.some(target => target.endsWith("important.log")), command);
    const scope = inspectBashPermissionScope({ command }, process.cwd());
    assert.equal(scope?.kind, "known-mutation", command);
    assert.ok(scope?.primitives.includes("output_redirection"), command);
  }
  assert.equal(inspectHighRiskBashMutation({ command: "echo diagnostic 2>/dev/null" }, process.cwd()), undefined);
  const duplicatedFd = inspectHighRiskBashMutation({ command: "echo diagnostic 2>&1" }, process.cwd());
  assert.ok(duplicatedFd?.unverifiableScope);
  assert.equal(inspectHighRiskBashMutation({ command: 'echo "literal > text"' }, process.cwd()), undefined);
  assert.equal(inspectBashPermissionScope({ command: 'echo "literal >> text"' }, process.cwd())?.kind, "read-only");
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

test("fragmented paste and repeat confirmations cannot approve; navigation repeats remain usable", async () => {
  let calls = 0;
  let result: boolean | undefined;
  const selector = new BoundedMemorySelector("清理", confirmationItems(), theme, keybindings,
    value => { calls++; result = value; }, () => 22, 1);
  selector.focused = true;
  selector.render(40);
  selector.handleInput("\x1b[A");
  selector.render(40);
  await new Promise<void>(resolve => setTimeout(resolve, 170));
  assert.equal((selector as any).actionIndex, 0);
  for (const fragment of ["\x1b[20", "0~", "\r", "pasted", "\x1b[20", "1~", "\r"]) selector.handleInput(fragment);
  assert.equal(calls, 0);
  selector.render(40);
  assert.match(selector.render(40).join("\n"), /→ 取消/);
  selector.handleInput("\x1b[A");
  selector.render(40);
  await new Promise<void>(resolve => setTimeout(resolve, 270));
  selector.handleInput("\x1b[13;1:2u");
  assert.equal(calls, 0);
  selector.handleInput("\x1b[1;1:2B");
  assert.equal((selector as any).actionIndex, 1, "repeated down navigates to cancel");
  selector.render(40);
  selector.handleInput("\x1b[A");
  selector.render(40);
  await new Promise<void>(resolve => setTimeout(resolve, 170));
  selector.handleInput("\r");
  selector.handleInput("\r");
  assert.equal(calls, 1);
  assert.equal(result, true);
  assert.equal((selector as any).items.length, 0);
});

test("detail cache reuses same path across action focus and releases on cancellation", () => {
  const selector = new BoundedMemorySelector("清理", confirmationItems(), theme, keybindings, () => {}, () => 22, 1);
  selector.focused = true;
  selector.render(40);
  selector.handleInput("\t");
  const first = selector.render(40);
  const cache = (selector as any).detailLines;
  for (let index = 0; index < 100; index++) {
    assert.deepEqual(selector.render(40), first);
    selector.handleInput("\t");
    assert.doesNotMatch(selector.render(40).join("\n"), /synthetic/);
    selector.handleInput("\t");
    selector.render(40);
  }
  selector.render(30);
  assert.notEqual((selector as any).detailLines, cache);
  selector.handleInput("\x1b");
  assert.equal((selector as any).done, undefined);
  assert.equal((selector as any).detailLines.length, 0);
});
