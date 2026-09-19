import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import test from "node:test";
import { BoundedMemorySelector } from "../packages/extensions/session-memory-manager/bounded-selector.ts";
import { inspectBashPermissionScope } from "../packages/extensions/resource-lifecycle-guard/permission-bash.ts";
import { inspectBashResourceLifecycle, inspectHighRiskBashMutation } from "../packages/extensions/resource-lifecycle-guard/core.ts";
import { parseTimeoutInvocation } from "../packages/extensions/resource-lifecycle-guard/timeout-wrapper.ts";
import { INTEGER_SECONDS_PATTERN } from "../packages/extensions/resource-lifecycle-guard/regex.ts";
import { prepareShellAnalysis } from "../packages/extensions/resource-lifecycle-guard/shell-substitution.ts";
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

test("redirection analysis keeps arithmetic and heredoc data out of file targets", () => {
  for (const arithmetic of ["printf '%s\\n' $((8 >> 1))", 'printf "%s\\n" "$((8 >> 1))"', "printf '%s\\n' $((8 << 1))"]) {
    assert.equal(inspectBashResourceLifecycle({ command: arithmetic }), undefined);
    assert.equal(inspectHighRiskBashMutation({ command: arithmetic }, process.cwd()), undefined);
    assert.equal(inspectBashPermissionScope({ command: arithmetic }, process.cwd())?.kind, "read-only");
  }

  const quotedHere = "cat <<'EOF'\nliteral > victim.txt\nliteral >> other.txt\nliteral 1> third.txt\nliteral 2>> fourth.txt\nliteral => compare\nEOF";
  assert.match(inspectBashResourceLifecycle({ command: quotedHere }) ?? "", /SHELL_HEREDOC/);
  const hereMutation = inspectHighRiskBashMutation({ command: quotedHere }, process.cwd());
  assert.ok(hereMutation?.primitives.includes("heredoc_uninspectable"));
  assert.equal(hereMutation?.targets.length, 0);
  const herePermission = inspectBashPermissionScope({ command: quotedHere }, process.cwd());
  assert.equal(herePermission?.kind, "opaque-script");
  assert.equal(herePermission?.targets.length, 0);

  const multipleHere = "cat <<A <<B\nbody > one.txt\nA\nbody >> two.txt\nB";
  assert.equal(inspectHighRiskBashMutation({ command: multipleHere }, process.cwd())?.targets.length, 0);
  assert.equal(inspectBashPermissionScope({ command: multipleHere }, process.cwd())?.targets.length, 0);

  const followingWrite = "cat <<'EOF'\nliteral > victim.txt\nEOF\necho x > after.txt";
  const followingMutation = inspectHighRiskBashMutation({ command: followingWrite }, process.cwd());
  assert.ok(followingMutation?.targets.some(target => target.endsWith("after.txt")));
  assert.equal(followingMutation?.targets.some(target => target.endsWith("victim.txt")), false);
  assert.ok(inspectBashPermissionScope({ command: followingWrite }, process.cwd())?.primitives.includes("output_redirection"));

  const nested = "cat <<EOF\n$(echo nested > nested.txt)\nEOF";
  const nestedMutation = inspectHighRiskBashMutation({ command: nested }, process.cwd());
  assert.ok(nestedMutation?.targets.some(target => target.endsWith("nested.txt")));
  assert.ok(inspectBashPermissionScope({ command: nested }, process.cwd())?.targets.some(target => target.endsWith("nested.txt")));

  const timeoutHere = "timeout 250 cat <<'EOF'\nliteral > victim.txt\nEOF\necho x > timeout-after.txt";
  const timeoutMutation = inspectHighRiskBashMutation({ command: timeoutHere }, process.cwd());
  assert.ok(timeoutMutation?.targets.some(target => target.endsWith("timeout-after.txt")));
  assert.equal(timeoutMutation?.targets.some(target => target.endsWith("victim.txt")), false);
});

test("heredoc analysis preserves real declaration-line and following-command redirections", () => {
  const cases = [
    ["before", "cat > before.txt <<'EOF'\npayload > body.txt\nEOF", ["before.txt"]],
    ["after", "cat <<'EOF' > after.txt\npayload > body.txt\nEOF", ["after.txt"]],
    ["both", "cat > before.txt <<'EOF' > after.txt\npayload >> body.txt\nEOF", ["before.txt", "after.txt"]],
    ["sibling", "cat <<'EOF'; echo data > sibling.txt\npayload\nEOF", ["sibling.txt"]],
    ["pipe", "cat <<'EOF' | cat > pipe.txt\npayload > body.txt\nEOF", ["pipe.txt"]],
    ["multiple", "cat <<A > first.txt <<B > second.txt\nbody > first-body.txt\nA\nbody > second-body.txt\nB", ["first.txt", "second.txt"]],
    ["timeout", "timeout 250 cat <<'EOF' > timeout.txt; echo data > timeout-sibling.txt\npayload\nEOF", ["timeout.txt", "timeout-sibling.txt"]],
    ["after-delimiter", "cat <<'EOF'\npayload > body.txt\nEOF\necho data > after.txt", ["after.txt"]],
  ] as const;

  for (const [name, command, expectedTargets] of cases) {
    const view = prepareShellAnalysis(command);
    for (const target of expectedTargets) assert.match(view.command, new RegExp(target.replace(".", "\\.")), name);
    const mutation = inspectHighRiskBashMutation({ command }, process.cwd());
    const permission = inspectBashPermissionScope({ command }, process.cwd());
    for (const target of expectedTargets) {
      assert.ok(mutation?.targets.some(candidate => candidate.endsWith(target)), `${name}: mutation ${target}`);
      assert.ok(permission?.targets.some(candidate => candidate.endsWith(target)), `${name}: permission ${target}`);
    }
    assert.ok(mutation?.primitives.includes("heredoc_uninspectable"), `${name}: mutation classification`);
    assert.equal(permission?.kind, "opaque-script", `${name}: permission classification`);
    assert.match(inspectBashResourceLifecycle({ command }) ?? "", /SHELL_HEREDOC/, `${name}: lifecycle classification`);
  }

  const quotedBody = "cat <<'EOF'\nliteral > fake.txt\nliteral >> fake-two.txt\nEOF";
  assert.equal(inspectHighRiskBashMutation({ command: quotedBody }, process.cwd())?.targets.length, 0);
  assert.equal(inspectBashPermissionScope({ command: quotedBody }, process.cwd())?.targets.length, 0);

  const nested = "cat <<EOF\n$(echo nested > nested.txt)\nEOF";
  assert.ok(inspectHighRiskBashMutation({ command: nested }, process.cwd())?.targets.some(target => target.endsWith("nested.txt")));
  assert.ok(inspectBashPermissionScope({ command: nested }, process.cwd())?.targets.some(target => target.endsWith("nested.txt")));

  const tabHere = "cat <<-EOF\n\tpayload > fake-tab.txt\n\tEOF\necho data > after-tab.txt";
  assert.ok(inspectHighRiskBashMutation({ command: tabHere }, process.cwd())?.targets.some(target => target.endsWith("after-tab.txt")));
  assert.equal(inspectHighRiskBashMutation({ command: tabHere }, process.cwd())?.targets.some(target => target.endsWith("fake-tab.txt")), false);

  const dynamicDelimiter = "cat <<$TAG\npayload > unknown-body.txt\n$TAG\necho data > after-unknown.txt";
  const dynamicView = prepareShellAnalysis(dynamicDelimiter);
  assert.equal(dynamicView.uncertain, true);
  assert.ok(inspectHighRiskBashMutation({ command: dynamicDelimiter }, process.cwd())?.unverifiableScope);
  assert.equal(inspectBashPermissionScope({ command: dynamicDelimiter }, process.cwd())?.kind, "opaque-script");
});

test("focused benchmark separates ordinary, sampling, and lifecycle measurement", () => {
  const benchmark = "./scripts/bench/session-clean-timeout-boundaries.ts";
  const runJson = (args: string[], script?: string): { metrics: Record<string, number>; observations: Record<string, unknown> } => {
    const output = script === undefined
      ? execFileSync(process.execPath, ["--expose-gc", "--experimental-strip-types", benchmark, ...args], { cwd: process.cwd(), encoding: "utf8", maxBuffer: 4 * 1024 * 1024 })
      : execFileSync(process.execPath, ["--expose-gc", "--experimental-strip-types", "--input-type=module", "--eval", script], { cwd: process.cwd(), encoding: "utf8", maxBuffer: 4 * 1024 * 1024 });
    return JSON.parse(output) as { metrics: Record<string, number>; observations: Record<string, unknown> };
  };
  const ordinary = runJson([], "globalThis.gc=()=>{throw new Error('ordinary benchmark called explicit gc')}; process.argv=[process.argv[0],'bench','--warmup','1','--runs','1','--iterations','1']; await import('./scripts/bench/session-clean-timeout-boundaries.ts')");
  assert.match(String(ordinary.observations.timing), /ordinary fixture timing/);
  assert.equal("postGcHeapDeltaBytes" in ordinary.metrics, false);
  assert.equal("selectorWeakOwnerReleasedCount" in ordinary.metrics, false);
  assert.ok(ordinary.metrics.selectorMaximumCacheLines >= ordinary.metrics.selectorFinalCacheLines);
  assert.ok(ordinary.metrics.selectorMaximumVisibleDetailRows > 0);

  const sampled = runJson(["--warmup", "1", "--runs", "1", "--iterations", "1", "--sample"]);
  assert.match(String(sampled.observations.sampling), /selector and shell phases sampled separately/);
  assert.ok(sampled.metrics.selectorSampledNodeCount > 0);
  assert.ok(sampled.metrics.shellSampledNodeCount > 0);
  assert.equal("postGcHeapDeltaBytes" in sampled.metrics, false);
  assert.equal(sampled.observations.includeObjectsCollectedByMinorOrMajorGC, true);

  const lifecycle = runJson(["--warmup", "1", "--runs", "1", "--iterations", "1", "--lifecycle"]);
  assert.match(String(lifecycle.observations.lifecycle), /three bounded GC turns/);
  assert.equal(lifecycle.metrics.selectorWeakOwnerReleasedCount, 2);
  assert.equal(lifecycle.metrics.selectorInitialDetailCacheReleasedCount, 2);
  assert.equal(lifecycle.metrics.selectorResizedDetailCacheReleasedCount, 2);
  assert.equal(typeof lifecycle.metrics.postGcHeapDeltaBytes, "number");
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
  const initialWraps = (selector as any).detailWrapCount;
  assert.ok(initialWraps > 0);
  for (let index = 0; index < 100; index++) {
    assert.deepEqual(selector.render(40), first);
    assert.equal((selector as any).detailWrapCount, initialWraps);
    selector.handleInput("\t");
    assert.doesNotMatch(selector.render(40).join("\n"), /synthetic/);
    assert.equal((selector as any).detailWrapCount, initialWraps);
    selector.handleInput("\t");
    selector.render(40);
    assert.strictEqual((selector as any).detailLines, cache);
    assert.equal((selector as any).detailWrapCount, initialWraps);
  }
  selector.render(30);
  assert.notEqual((selector as any).detailLines, cache);
  assert.equal((selector as any).detailWrapCount, initialWraps + 1);
  const other = new BoundedMemorySelector("清理", confirmationItems(), theme, keybindings, () => {}, () => 22, 1);
  other.focused = true;
  other.render(40);
  other.handleInput("\t");
  other.render(40);
  assert.notStrictEqual((other as any).detailLines, (selector as any).detailLines);
  other.dispose();
  selector.handleInput("\x1b");
  assert.equal((selector as any).done, undefined);
  assert.equal((selector as any).detailLines.length, 0);
  assert.equal((selector as any).detailText, undefined);
});
