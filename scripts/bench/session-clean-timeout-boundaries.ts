import { performance } from "node:perf_hooks";
import { BoundedMemorySelector } from "../../packages/extensions/session-memory-manager/bounded-selector.ts";
import { inspectBashPermissionScope } from "../../packages/extensions/resource-lifecycle-guard/permission-bash.ts";
import { inspectBashResourceLifecycle, inspectHighRiskBashMutation } from "../../packages/extensions/resource-lifecycle-guard/core.ts";
import { getKeybindings } from "../../packages/tui/src/keybindings.ts";
import type { Terminal } from "../../packages/tui/src/terminal.ts";
import { TuiAltScreen } from "../../packages/tui/src/tui-alt-screen.ts";
import { TuiMainScreen } from "../../packages/tui/src/tui-main-screen.ts";
import { runBenchmarkMain, readIntegerOption } from "./benchmark.ts";

class NoopTerminal implements Terminal {
  readonly kittyProtocolActive = false;
  columns: number;
  rows: number;
  frameWrites = 0;
  frameBytes = 0;
  private input: ((data: string) => void) | undefined;
  private resize: (() => void) | undefined;
  private completion: ((generation: number, error?: Error) => void) | undefined;

  constructor(columns: number, rows: number) {
    this.columns = columns;
    this.rows = rows;
  }

  start(input: (data: string) => void, resize: () => void): void { this.input = input; this.resize = resize; }
  stop(): void { this.input = undefined; this.resize = undefined; }
  async drainInput(): Promise<void> {}
  write(): void {}
  writeFrame(data: string, generation: number): void {
    this.frameWrites++;
    this.frameBytes += data.length;
    this.completion?.(generation);
  }
  setFrameWriteCompletionListener(listener: ((generation: number, error?: Error) => void) | undefined): void { this.completion = listener; }
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
    this.resize?.();
  }
}

const theme = { bold: (value: string) => value, fg: (_tone: string, value: string) => value };
const keybindings = getKeybindings();

function selectorItems(): Array<{ value: number; label: string; selectable?: boolean; detail?: string; dangerous?: boolean }> {
  const items = [{
    value: -1,
    label: "session-long-name.jsonl",
    selectable: false,
    detail: "/tmp/synthetic/" + "长路径😀e\u0301/".repeat(40),
  }];
  for (let index = 0; index < 30; index++) items.push({ value: index, label: `动作 ${index}`, dangerous: index === 0 });
  return items;
}

interface SelectorRun {
  main: NoopTerminal;
  alt: NoopTerminal;
  selectors: BoundedMemorySelector<number>[];
  renderCalls: number;
  renderedLines: number;
  wrapCalls: number;
  maximumDetailLines: number;
  maximumFrameBytes: number;
}

function instrumentSelector(selector: BoundedMemorySelector<number>, counters: { renderCalls: number; renderedLines: number }): void {
  const original = selector.render.bind(selector);
  (selector as unknown as { render: (width: number) => string[] }).render = (width: number) => {
    counters.renderCalls++;
    const lines = original(width);
    counters.renderedLines += lines.length;
    return lines;
  };
}

function runSelectorFixture(iterations: number): SelectorRun {
  const main = new NoopTerminal(60, 24);
  const alt = new NoopTerminal(60, 24);
  const counters = { renderCalls: 0, renderedLines: 0 };
  const selectors = [
    new BoundedMemorySelector("清理", selectorItems(), theme, keybindings, () => {}, () => 22, 30),
    new BoundedMemorySelector("清理", selectorItems(), theme, keybindings, () => {}, () => 22, 30),
  ];
  for (const selector of selectors) instrumentSelector(selector, counters);
  const mainScreen = new TuiMainScreen(main, true);
  const altScreen = new TuiAltScreen(alt, true);
  mainScreen.addChild(selectors[0]!);
  altScreen.addChild(selectors[1]!);
  mainScreen.setFocus(selectors[0]!);
  altScreen.setFocus(selectors[1]!);
  mainScreen.start();
  altScreen.start();
  mainScreen.renderNow(true);
  altScreen.renderNow(true);
  for (let index = 0; index < iterations; index++) {
    selectors[0]!.handleInput("\t");
    selectors[1]!.handleInput("\t");
    mainScreen.renderNow(true);
    altScreen.renderNow(true);
  }
  selectors[0]!.handleInput("\t");
  selectors[1]!.handleInput("\t");
  mainScreen.renderNow(true);
  altScreen.renderNow(true);
  main.resizeTo(42, 16);
  alt.resizeTo(42, 16);
  mainScreen.renderNow(true);
  altScreen.renderNow(true);
  const wrapCalls = ((selectors[0] as unknown as { detailWrapCount: number }).detailWrapCount)
    + ((selectors[1] as unknown as { detailWrapCount: number }).detailWrapCount);
  const maximumDetailLines = Math.max(
    (selectors[0] as unknown as { detailLines: string[] }).detailLines.length,
    (selectors[1] as unknown as { detailLines: string[] }).detailLines.length,
  );
  const maximumFrameBytes = Math.max(main.frameBytes, alt.frameBytes);
  mainScreen.stop();
  altScreen.stop();
  for (const selector of selectors) selector.dispose();
  const releasedItems = selectors.every(selector => (selector as unknown as { items: unknown[] }).items.length === 0);
  const releasedDetails = selectors.every(selector => (selector as unknown as { detailLines: unknown[] }).detailLines.length === 0);
  if (!releasedItems || !releasedDetails) throw new Error("selector retained owned records after dispose");
  return { main, alt, selectors, renderCalls: counters.renderCalls, renderedLines: counters.renderedLines, wrapCalls, maximumDetailLines, maximumFrameBytes };
}

const shellCases = [
  "printf '%s\\n' $((8 >> 1))",
  "cat <<'EOF'\nliteral > victim.txt\nEOF",
  "cat <<'EOF'\nliteral > victim.txt\nEOF\necho x > after.txt",
  "timeout 250 find . -type f > output.txt",
  "cat <<EOF\n$(echo nested > nested.txt)\nEOF",
  "echo diagnostic 2>&1",
];

function runShellFixture(iterations: number): { calls: number; mutationFindings: number; permissionFindings: number; lifecycleRefusals: number; summaryBytes: number } {
  let calls = 0;
  let mutationFindings = 0;
  let permissionFindings = 0;
  let lifecycleRefusals = 0;
  let summaryBytes = 0;
  for (let iteration = 0; iteration < iterations; iteration++) {
    for (const command of shellCases) {
      const lifecycle = inspectBashResourceLifecycle({ command });
      const mutation = inspectHighRiskBashMutation({ command }, process.cwd());
      const permission = inspectBashPermissionScope({ command }, process.cwd());
      calls += 3;
      if (mutation) mutationFindings++;
      if (permission?.kind !== "read-only") permissionFindings++;
      if (lifecycle) lifecycleRefusals++;
      summaryBytes += (mutation?.targets.length ?? 0) + (permission?.targets.length ?? 0);
    }
  }
  return { calls, mutationFindings, permissionFindings, lifecycleRefusals, summaryBytes };
}

const iterations = readIntegerOption("--iterations", 100);
await runBenchmarkMain({
  name: "session-clean-timeout-boundaries-production-paths",
  fixture: "bounded-selector-main-alt-and-shell-contexts",
  run: () => {
    if (typeof globalThis.gc === "function") globalThis.gc();
    const before = process.memoryUsage().heapUsed;
    const started = performance.now();
    const selector = runSelectorFixture(iterations);
    const shell = runShellFixture(iterations);
    const elapsedMs = performance.now() - started;
    if (typeof globalThis.gc === "function") globalThis.gc();
    return {
      selectorRenderCalls: selector.renderCalls,
      selectorRenderedLines: selector.renderedLines,
      selectorDetailWrapCalls: selector.wrapCalls,
      selectorMaximumDetailLines: selector.maximumDetailLines,
      selectorMaximumFrameBytes: selector.maximumFrameBytes,
      mainFrameWrites: selector.main.frameWrites,
      altFrameWrites: selector.alt.frameWrites,
      shellCalls: shell.calls,
      shellMutationFindings: shell.mutationFindings,
      shellPermissionFindings: shell.permissionFindings,
      shellLifecycleRefusals: shell.lifecycleRefusals,
      shellSummaryBytes: shell.summaryBytes,
      sampledHeapDeltaBytes: process.memoryUsage().heapUsed - before,
      fixtureElapsedMs: elapsedMs,
    };
  },
  observations: () => ({
    baselineCommit: "6e08fd47440796b528941ce0dba21213796db582",
    comparison: "candidate runtime sample; baseline is immutable source comparison without a second worktree",
    selectorOwner: "one selector-owned detail array per instance; cleared by dispose",
    shellOwner: "call-owned parser views; no command rewrite or external probe",
    objectPool: false,
    realFilesystemAccess: false,
  }),
});
