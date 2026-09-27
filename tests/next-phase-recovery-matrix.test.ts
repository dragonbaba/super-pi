import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { costSession, costCall as call, costText, costModule, startCostMeasurement, finishCostMeasurement } from "./helpers/next-phase-session.ts";
import { FIXTURE_SNAPSHOT_ID_PATTERN, FIXTURE_SECOND_LINE_ANCHOR_PATTERN } from "./helpers/next-phase-fixture-regex.ts";

function turns(strategy: string, calls: any[]): any[][] { return strategy === "T1" ? calls.map(item => [item]) : [calls]; }
function resultMetrics(f: Awaited<ReturnType<typeof costSession>>, label: string, start: ReturnType<typeof startCostMeasurement>) {
  const timing = finishCostMeasurement(f.metrics, start), { lastWire: _wire, ...metrics } = f.metrics;
  return { matrix: "N4-recovery-context", implementation: process.env.SP_COST_LABEL ?? "candidate", label, ...metrics,
    ...timing, estimator: "super-pi.conservative-v1", actualSerializer: true,
    providerUsage: null, cacheHits: null, actualCost: null, pendingCalls: f.session.agent.state.pendingToolCalls.size };
}

test("N4 cost metrics count the actual Session compaction-start event even when preparation refuses", async () => {
  const f = await costSession();
  try {
    assert.equal(f.metrics.compactions, 0);
    await assert.rejects(f.session.compact("No remote summary for this empty fixture."), /Nothing to compact/);
    assert.equal(f.metrics.compactions, 1); assert.equal(f.metrics.requests, 0);
    assert.equal(f.session.isCompacting, false);
  } finally { await f.release(); }
});

test("N4 estimator timing subtracts only requests inside each measured workload", async () => {
  const f = await costSession();
  try {
    await f.run([[call("setup", "tool_search", { query: "file_batch", limit: 1 })]]);
    assert.equal(f.metrics.estimatorPasses, f.metrics.requests * 2);
    for (let round = 0; round < 2; round++) {
      const requests = f.metrics.requests, start = startCostMeasurement(f.metrics);
      await f.run([]);
      const timing = finishCostMeasurement(f.metrics, start);
      assert.equal(timing.estimatorPasses, (f.metrics.requests - requests) * 2);
      assert.ok(timing.estimatorPasses < f.metrics.estimatorPasses);
      assert.ok(timing.estimatorElapsedMs > 0);
      assert.equal(timing.cpuUs + timing.estimatorCpuUs, timing.inclusiveCpuUs);
      assert.ok(Math.abs(timing.elapsedMs + timing.estimatorElapsedMs - timing.inclusiveElapsedMs) < 0.000001);
    }
  } finally { await f.release(); }
});

test("N4 context matrix: fair T1/T2/T3 short/long/reopen/model-switch/warm activation", { timeout: 180000 }, async t => {
  for (const context of ["short", "long", "reopen", "model-switch", "warm"]) for (const strategy of ["T1", "T2", "T3"]) {
    const f = await costSession({ historyPairs: context === "long" ? 100 : 0 });
    const start = startCostMeasurement(f.metrics);
    try {
      for (let index = 0; index < 4; index++) writeFileSync(join(f.cwd, `file${index}`), `FIRST-${index}\r\n中文 SECOND-${index}\r\n`);
      if (context === "reopen") {
        await f.run([], "Record this session before reopening."); const requests = f.metrics.requests;
        await f.reopen(); assert.equal(f.metrics.requests, requests, "reopening cannot call provider or replay tools");
        assert.equal(f.metrics.toolCalls, 0);
      }
      if (context === "model-switch") await f.switchModel();
      if (strategy === "T3") await f.run([[call("discover", "tool_search", { query: "file_batch", limit: 1 })]]);
      if (context === "warm") {
        // A real prior read activates the same default tool; the cost stays in the task.
        await f.run([[call("warm-read", "read", { path: "file0" })]]);
      }
      await f.run(turns(strategy, [0, 1, 2, 3].map(index => call(`read${index}`, "read", { path: `file${index}` }))));
      const operations = [0, 1, 2, 3].map(index => ({ operation: "edit", path: `file${index}`, edits: [{ oldText: `FIRST-${index}`, newText: `AFTER-${index}` }] }));
      await f.run(strategy === "T3" ? [[call("batch", "file_batch", { operations })]] : turns(strategy, operations.map(({ operation, ...args }, index) => call(`edit${index}`, operation, args))));
      for (const message of f.session.messages) if (message.role === "toolResult") assert.equal(message.isError, false, JSON.stringify(message));
      for (let index = 0; index < 4; index++) assert.equal(readFileSync(join(f.cwd, `file${index}`), "utf8"), `AFTER-${index}\r\n中文 SECOND-${index}\r\n`);
      t.diagnostic(JSON.stringify({ ...resultMetrics(f, `${context}:${strategy}`, start), quality: "four exact updates, CRLF/content preserved", retries: 0, supplementalReads: context === "warm" ? 1 : 0 }));
    } finally { await f.release(); }
    global.gc?.(); t.diagnostic(JSON.stringify({ release: `${context}:${strategy}`, heapAfterFixtureRelease: process.memoryUsage().heapUsed, pendingCalls: 0, removedRoot: !existsSync(f.root) }));
  }
});

test("N4 actual SDK overlimit and whole-batch preflight refusal have zero effects; bounded repair uses a new request", async t => {
  const f = await costSession(), start = startCostMeasurement(f.metrics);
  try {
    await f.run([[call("discover", "tool_search", { query: "file_batch", limit: 1 })]]);
    await f.run([[call("overlimit", "file_batch", { operations: Array.from({ length: 17 }, (_, index) => ({ operation: "write", mode: "create", path: `over/file${index}`, content: "x" })) })]]);
    assert.equal(f.result("overlimit").isError, true); assert.equal(existsSync(join(f.cwd, "over")), false);
    await f.run([[call("preflight", "file_batch", { operations: [{ operation: "write", mode: "create", path: "must/not/exist", content: "x" }, { operation: "delete", path: "missing" }] })]]);
    assert.equal(f.result("preflight").isError, true); assert.equal(existsSync(join(f.cwd, "must")), false);
    await f.run([[call("repaired", "file_batch", { operations: [{ operation: "write", mode: "create", path: "bounded-repair", content: "only requested repair" }] })]]);
    assert.equal(f.result("repaired").isError, false); assert.equal(readFileSync(join(f.cwd, "bounded-repair"), "utf8"), "only requested repair");
    assert.equal(existsSync(join(f.cwd, "over")), false); assert.equal(existsSync(join(f.cwd, "must")), false);
    t.diagnostic(JSON.stringify({ ...resultMetrics(f, "overlimit-preflight-repair", start), failedRequests: 2, retries: 1, quality: "no effects from refused batches; one explicit corrected creation" }));
  } finally { await f.release(); }
});

test("N4 combined actual Session: preview, mixed commit, drift/recovery, shell facts, budget continuation and reopen", { timeout: 90000 }, async t => {
  const { readShellExecution } = await costModule("packages/coding-agent/src/core/tools/shell-execution.ts");
  const { collectChanges } = await costModule("packages/extensions/mutation-guard-write/changes.ts");
  const f = await costSession(), start = startCostMeasurement(f.metrics);
  try {
    for (const path of ["edit", "delete", "move", "stale"]) writeFileSync(join(f.cwd, path), "first\nsecond\n");
    await f.run([[call("discover", "tool_search", { query: "file_batch", limit: 1 })]]);
    await f.run([[call("prior", "read", { path: "edit" })]]);
    const body = costText(f.result("prior")), snapshot = FIXTURE_SNAPSHOT_ID_PATTERN.exec(body)?.[1], anchor = FIXTURE_SECOND_LINE_ANCHOR_PATTERN.exec(body)?.[0];
    assert.ok(snapshot && anchor);
    const operations = [{ operation: "write", mode: "create", path: "新目录/create", content: "中文\r\n" },
      { operation: "edit", path: "edit", snapshot, edits: [{ kind: "replace", start: anchor, newLines: ["SECOND"] }] },
      { operation: "move", path: "move", destination: "moved" }, { operation: "delete", path: "delete" }];
    await f.run([[call("preview", "file_batch", { operations, dryRun: true })]]);
    assert.equal(f.result("preview").isError, false); assert.equal(existsSync(join(f.cwd, "新目录")), false);
    for (const path of ["edit", "delete", "move", "stale"]) assert.equal(readFileSync(join(f.cwd, path), "utf8"), "first\nsecond\n");
    await f.run([[call("mixed", "file_batch", { operations })]]);
    assert.equal(f.result("mixed").isError, false, JSON.stringify(f.result("mixed")));
    assert.equal(readFileSync(join(f.cwd, "edit"), "utf8"), "first\nSECOND\n"); assert.equal(readFileSync(join(f.cwd, "新目录/create"), "utf8"), "中文\r\n");
    assert.equal(existsSync(join(f.cwd, "delete")), false); assert.equal(existsSync(join(f.cwd, "move")), false); assert.equal(readFileSync(join(f.cwd, "moved"), "utf8"), "first\nsecond\n");
    f.recordHook((type, data) => { if (type === "file-mutation-progress-v2" && data.phase === "result" && data.itemId === "drift:0") writeFileSync(join(f.cwd, "stale"), "external"); });
    await f.run([[call("drift", "file_batch", { operations: [{ operation: "write", mode: "create", path: "once", content: "once" },
      { operation: "delete", path: "stale" }, { operation: "write", mode: "create", path: "remaining", content: "desired" }] })]]);
    f.recordHook(); assert.equal(f.result("drift").isError, true);
    const records = collectChanges(f.manager.getBranch(), f.cwd).filter((record: any) => record.toolCallId === "drift");
    assert.deepEqual(records.map((record: any) => record.status), ["succeeded", "failed_no_change", "not_started"]);
    assert.equal(readFileSync(join(f.cwd, "once"), "utf8"), "once"); assert.equal(existsSync(join(f.cwd, "remaining")), false);
    assert.ok((await f.continue([], "已完成，全部通过。")).includes("尚未验证"));
    assert.ok(f.manager.getBranch().some((entry: any) => entry.customType === "false-success-intervention-v1"));
    assert.ok((await f.continue([[call("remaining-preview", "file_batch", { dryRun: true, operations: [
      { operation: "delete", path: "stale" }, { operation: "write", mode: "create", path: "remaining", content: "desired" },
    ] })]], "已完成，全部通过。")).includes("尚未验证"));
    assert.equal(f.result("remaining-preview").isError, false); assert.equal(readFileSync(join(f.cwd, "stale"), "utf8"), "external");
    assert.equal(existsSync(join(f.cwd, "remaining")), false);
    const runner = f.session.extensionRunner, ui = runner.getUIContext(); let action = "Verify current state", editor = "", notices: string[] = [];
    runner.setUIContext({ ...ui, select: async (title: string, choices: string[]) => title === "Session changes" ? choices.find(choice => choice.startsWith("drift:0 ")) : title === "Keep current input or place draft" ? "Replace input" : action,
      getEditorText: () => editor, setEditorText: (text: string) => { editor = text; }, notify: (text: string) => { notices.push(text); },
      custom: async (factory: any) => { const component = await factory({ terminal: { rows: 24 }, requestRender() {} }, {}, {}, () => {}); try { component.render(100); } finally { component.dispose?.(); } } }, "tui");
    const beforeTools = f.metrics.toolCalls; await runner.getCommand("changes").handler("", runner.createContext());
    assert.equal(notices.length, 0); assert.ok(f.manager.getBranch().some((entry: any) => entry.customType === "file-change-verification-v1"));
    action = "Draft remaining request"; await runner.getCommand("changes").handler("", runner.createContext());
    assert.equal(notices.length, 0); assert.ok(editor.includes("remaining")); assert.ok(editor.includes("stale")); assert.equal(editor.includes('"content":"once"'), false);
    assert.equal(f.metrics.toolCalls, beforeTools); assert.equal(existsSync(join(f.cwd, "remaining")), false); runner.setUIContext(ui, "tui");
    assert.ok((await f.continue([], "已完成，全部通过。")).includes("尚未验证"), "filesystem observation/draft cannot erase unfinished obligations");
    const approvals = f.metrics.approvals;
    await f.run([[call("fresh-repair", "file_batch", { operations: [{ operation: "delete", path: "stale" }, { operation: "write", mode: "create", path: "remaining", content: "desired" }] })]]);
    assert.equal(f.result("fresh-repair").isError, false); assert.ok(f.metrics.approvals > approvals); assert.equal(readFileSync(join(f.cwd, "once"), "utf8"), "once");
    await f.run([[call("shell", "bash", { command: "node <<'END'\nconsole.log('中文 multiline');process.exitCode=23;\nEND", cwd: f.cwd })]]);
    assert.equal(readShellExecution(f.result("shell").details)?.exitCode, 23); assert.ok(costText(f.result("shell")).includes("中文 multiline"));
    if (process.platform === "win32") {
      await f.run([[call("find-ps", "tool_search", { query: "powershell", limit: 1 })]]);
      await f.run([[call("powershell", "powershell", { command: "Write-Output '中文'; exit 7", cwd: f.cwd })]]);
      assert.equal(readShellExecution(f.result("powershell").details)?.exitCode, 7);
    }
    await f.run([[call("cap", "bash", { command: "node <<'END'\nprocess.stdout.write('x'.repeat(6*1024*1024)+'\\nFINAL-TAIL');\nEND", cwd: f.cwd })]]);
    const capped = f.result("cap"); assert.equal(readShellExecution(capped.details)?.output.log, "capped"); assert.ok(costText(capped).includes("FINAL-TAIL"));
    const spill = capped.details.fullOutputPath; assert.equal(dirname(spill), tmpdir()); assert.ok(spill.startsWith(join(tmpdir(), "sp-bash-"))); rmSync(spill); rmSync(spill + ".sp-owned", { force: true });
    f.session.configureToolResultBudget({ enabled: true, budgetTokens: 1 }); const requests = f.metrics.requests;
    await f.run([]); assert.equal(f.metrics.requests, requests); assert.equal(f.session.getToolResultBudgetStatus().state, "budget-too-small");
    f.session.configureToolResultBudget({ enabled: true, budgetTokens: 8192 }); await f.run([]);
    assert.equal(f.session.getToolResultBudgetStatus().lastRequest, "applied"); const calls = f.metrics.toolCalls;
    await f.reopen(); assert.equal(f.metrics.toolCalls, calls); assert.equal(readFileSync(join(f.cwd, "remaining"), "utf8"), "desired");
    assert.equal(readFileSync(join(f.cwd, "once"), "utf8"), "once"); assert.equal(existsSync(join(f.cwd, "stale")), false);
    assert.equal(readShellExecution(f.result("shell").details)?.exitCode, 23);
    t.diagnostic(JSON.stringify({ ...resultMetrics(f, "combined", start), retries: 1, quality: "mixed/partial recovery, factual shells, budget continuation and durable reopen verified" }));
  } finally { await f.release(); }
});
