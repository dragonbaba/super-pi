import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ts from "typescript";
import { Agent } from "../packages/agent/src/agent.ts";
import { createBashTool, createLocalBashOperations, createShellToolDefinition } from "../packages/coding-agent/src/core/tools/bash.ts";
import { OutputAccumulator } from "../packages/coding-agent/src/core/tools/output-accumulator.ts";
import { wrapToolDefinition } from "../packages/coding-agent/src/core/tools/tool-definition-wrapper.ts";
import { createEventBus } from "../packages/coding-agent/src/core/event-bus.ts";
import { createExtensionRuntime, ExtensionRunner, loadExtensionFromFactory } from "../packages/coding-agent/src/core/extensions/index.ts";
import { SessionManager } from "../packages/coding-agent/src/core/session-manager.ts";
import { initTheme } from "../packages/coding-agent/src/modes/interactive/theme/theme.ts";
import { ToolExecutionComponent } from "../packages/coding-agent/src/modes/interactive/components/tool-execution.ts";
import { createJiti } from "jiti";
import { inspectBashResourceLifecycle, inspectHighRiskBashMutation } from "../packages/extensions/resource-lifecycle-guard/core.ts";
import { inspectBashPermissionScope } from "../packages/extensions/resource-lifecycle-guard/permission-bash.ts";
import { classifyError, collectSessionErrors } from "../packages/extensions/session-tool-errors/core.ts";

const cwd = process.cwd();

test("Bash output hot methods retain zero per-append callbacks, promises or abort controllers", () => {
  const path = "packages/coding-agent/src/core/tools/output-accumulator.ts";
  const source = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true);
  const methods = new Set(["append", "appendDecodedData", "appendDecodedText", "trimTail", "getSnapshotText", "shouldUseTempFile", "writeTempData", "snapshot"]);
  const seen = new Set<string>();
  let inlineCallbacks = 0, promises = 0, abortControllers = 0, promiseTails = 0, objectLiterals = 0, arrayLiterals = 0;
  function audit(node: ts.Node): void {
    if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) inlineCallbacks++;
    if (ts.isObjectLiteralExpression(node)) objectLiterals++;
    if (ts.isArrayLiteralExpression(node)) arrayLiterals++;
    if (ts.isNewExpression(node)) {
      const name = node.expression.getText(source);
      if (name === "Promise") promises++;
      if (name === "AbortController") abortControllers++;
    }
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
      && ["then", "catch", "finally"].includes(node.expression.name.text)) promiseTails++;
    ts.forEachChild(node, audit);
  }
  for (const statement of source.statements) {
    if (!ts.isClassDeclaration(statement) || statement.name?.text !== "OutputAccumulator") continue;
    for (const member of statement.members) {
      if (!ts.isMethodDeclaration(member) || !member.body || !methods.has(member.name.getText(source))) continue;
      seen.add(member.name.getText(source));
      audit(member.body);
    }
  }
  assert.deepEqual(seen, methods);
  const bashPath = "packages/coding-agent/src/core/tools/bash.ts";
  const bashSource = ts.createSourceFile(bashPath, readFileSync(bashPath, "utf8"), ts.ScriptTarget.Latest, true);
  let dataHandlerCount = 0;
  function findDataHandler(node: ts.Node): void {
    if (ts.isVariableDeclaration(node) && node.name.getText(bashSource) === "handleData" && node.initializer && ts.isArrowFunction(node.initializer)) {
      dataHandlerCount++;
      audit(node.initializer.body);
    } else ts.forEachChild(node, findDataHandler);
  }
  findDataHandler(bashSource);
  assert.equal(dataHandlerCount, 1);
  assert.deepEqual({ inlineCallbacks, promises, abortControllers, promiseTails, objectLiterals, arrayLiterals },
    { inlineCallbacks: 0, promises: 0, abortControllers: 0, promiseTails: 0, objectLiterals: 4, arrayLiterals: 0 });
});

test("Bash output allocation gate measures append cost and releases spill owners", () => {
  const stdout = execFileSync(process.execPath,
    ["--expose-gc", "--experimental-strip-types", "scripts/bench/shell-common-compatibility.ts", "--allocation-gate"],
    { cwd, encoding: "utf8", timeout: 30_000 });
  const report = JSON.parse(stdout.trim().split(/\r?\n/).at(-1)!);
  assert.equal(report.mode, "allocation-gate");
  assert.equal(report.counters.appendCalls, 96);
  assert.equal(report.counters.snapshotCalls, 96);
  assert.equal(report.counters.spillFilesCreated, 1);
  assert.equal(report.counters.spillFileCapped, true);
  assert.ok(report.counters.spillFileBytes <= 5 * 1024 * 1024);
  assert.equal(report.counters.spillErrors, 0);
  assert.equal(report.counters.releasedLifecycles, 20);
  assert.equal(report.counters.liveOwnersAfterGc, 0);
  assert.ok(Number.isFinite(report.sampledBytesPerAppend));
  assert.ok(report.sampledBytesPerAppend < 128_000);
  assert.ok(Array.isArray(report.topAllocationSites));
});

function findTestBash(): string | undefined {
  if (process.env.SP_TEST_BASH) return process.env.SP_TEST_BASH;
  if (process.platform !== "win32") return "/bin/bash";
  const programFiles = process.env.ProgramFiles;
  if (programFiles) {
    const installed = join(programFiles, "Git", "bin", "bash.exe");
    if (existsSync(installed)) return installed;
  }
  const local = "D:\\Git\\bin\\bash.exe";
  return existsSync(local) ? local : undefined;
}

test("command -v/-V query names and variables without treating them as executables", () => {
  for (const command of [
    'command -v bash',
    'command -V "$candidate"',
    'for candidate in printf cat; do command -v "$candidate"; done',
    'printf "%s" "$(command -v "$candidate")"',
  ]) {
    assert.equal(inspectBashResourceLifecycle({ command }), undefined, command);
    const scope = inspectBashPermissionScope({ command }, cwd);
    assert.ok(scope, command);
    assert.equal(scope.unverifiableScope, false, command);
    assert.equal(inspectHighRiskBashMutation({ command }, cwd), undefined, command);
  }
  assert.match(inspectBashResourceLifecycle({ command: 'command "$candidate" --help' }) ?? "", /SHELL_DYNAMIC_EXECUTABLE/);
  assert.match(inspectBashResourceLifecycle({ command: 'exec "$candidate" --help' }) ?? "", /SHELL_DYNAMIC_EXECUTABLE/);
  assert.ok(inspectHighRiskBashMutation({ command: 'command rm -rf synthetic' }, cwd)?.primitives.includes("rm_recursive"));
  assert.ok(inspectHighRiskBashMutation({ command: 'exec rm -rf synthetic' }, cwd)?.primitives.includes("rm_recursive"));
  assert.ok(inspectHighRiskBashMutation({ command: 'for t in synthetic; do rm -rf "$t"; done' }, cwd)?.primitives.includes("rm_recursive"));
});

test("static descriptor copies preserve bounded file targets and order", () => {
  for (const command of [
    'printf "%s\\n" out 2>&1 | cat',
    '(printf "%s\\n" out 1>&2) | cat',
    '{ printf "%s\\n" out; } >merged.log 2>&1',
    '{ printf "%s\\n" out; } 2>&1 >split.log | cat',
    'printf "%s\\n" out 2>errors.log 1>&2',
    'printf "%s\\n" out 2>&1>compact.log',
    'printf "%s\\n" out 3<&0',
  ]) {
    const high = inspectHighRiskBashMutation({ command }, cwd);
    assert.notEqual(high?.unverifiableScope, true, command);
    assert.equal(high?.diagnostic?.diagnostic.code, undefined, command);
    const scope = inspectBashPermissionScope({ command }, cwd);
    assert.equal(scope?.unverifiableScope, false, command);
  }
  for (const command of ["2>&$fd", "2>&-", "{fd}>&1", "2>&1-"]) {
    const high = inspectHighRiskBashMutation({ command: `printf x ${command}` }, cwd);
    assert.equal(high?.unverifiableScope, true, command);
  }
  const compact = inspectHighRiskBashMutation({ command: 'printf out 2>&1>compact.log' }, cwd);
  assert.ok(compact?.targets.some(target => target.endsWith("compact.log")));
  assert.equal(inspectHighRiskBashMutation({ command: 'cat <fixture.bin' }, cwd)?.unverifiableScope, true);
  for (const command of ["[[ a < b ]]", "[[ b > a ]]", "[[ a < b && c > d ]]"]) {
    assert.notEqual(inspectHighRiskBashMutation({ command }, cwd)?.unverifiableScope, true, command);
    const scope = inspectBashPermissionScope({ command }, cwd);
    assert.equal(scope?.unverifiableScope, false, command);
    assert.equal(scope?.kind, "read-only", command);
  }
  assert.ok(inspectHighRiskBashMutation({ command: "[[ a < b ]] >.git/config" }, cwd)?.targets.some(target => target.endsWith(".git\\config") || target.endsWith(".git/config")));
  assert.equal(inspectBashPermissionScope({ command: "[[ a < b ]] >.git/config" }, cwd)?.kind, "known-mutation");
  assert.equal(inspectBashPermissionScope({ command: "'[[' a < b ]]" }, cwd)?.unverifiableScope, true);
  assert.equal(inspectBashPermissionScope({ command: "[[ a < b ']]'" }, cwd)?.unverifiableScope, true);
  assert.equal(inspectHighRiskBashMutation({ command: "printf '%s' '2>&1'" }, cwd), undefined);
  assert.ok(inspectHighRiskBashMutation({ command: 'printf "%s" "$(rm -rf synthetic)"' }, cwd)?.primitives.includes("rm_recursive"));
  for (const command of [
    "for t in cd; do printf '%s' 'cd'; done",
    "if true; then printf '%s' 'cd'; fi",
    "printf '%s' 'cd' | cat",
  ]) assert.equal(inspectBashResourceLifecycle({ command }), undefined, command);
});

test("asynchronous spill write failure releases only its owned file", async () => {
  const abort = new AbortController();
  const output = new OutputAccumulator({
    tempFilePrefix: "sp-shell-write-failure",
    onSpillError: (error: Error) => abort.abort(error),
  });
  output.append(Buffer.alloc(64 * 1024, 0x61));
  const path = output.snapshot({ persistIfTruncated: true }).fullOutputPath;
  assert.ok(path);
  try {
    (output as any).tempFileStream.destroy(new Error("synthetic write failure"));
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(abort.signal.aborted, true, "an asynchronous log failure must interrupt a quiet command");
    await assert.rejects(output.closeTempFile(), /synthetic write failure/);
    await output.discardTempFile();
    assert.equal(existsSync(path), false);
    assert.equal(existsSync(path + ".sp-owned"), false);
  } finally {
    await output.discardTempFile();
  }
});

test("an asynchronous spill stream failure aborts a quiet Bash execution", async () => {
  const fixture = mkdtempSync(join(tmpdir(), "sp-shell-async-error-"));
  const original = fs.createWriteStream;
  let aborted = false;
  fs.createWriteStream = ((...args: Parameters<typeof fs.createWriteStream>) => {
    const stream = original(...args);
    setImmediate(() => stream.destroy(new Error("synthetic asynchronous spill failure")));
    return stream;
  }) as typeof fs.createWriteStream;
  syncBuiltinESMExports();
  try {
    const tool = createBashTool(fixture, { exposeSessionEnvironment: false, operations: {
      async exec(_command, _cwd, options) {
        options.onData(Buffer.alloc(64 * 1024, 0x61));
        await new Promise<void>((resolve, reject) => {
          const deadline = setTimeout(() => reject(new Error("spill failure did not interrupt the quiet command")), 2000);
          const onAbort = () => { clearTimeout(deadline); aborted = true; resolve(); };
          if (options.signal?.aborted) onAbort();
          else options.signal?.addEventListener("abort", onAbort, { once: true });
        });
        throw new Error("aborted");
      },
    } });
    await assert.rejects(tool.execute("async-spill", { command: "printf synthetic" }), /SHELL_LOG_FAILED.*synthetic asynchronous spill failure/);
    assert.equal(aborted, true);
  } finally {
    fs.createWriteStream = original;
    syncBuiltinESMExports();
    rmSync(fixture, { recursive: true });
  }
});

test("blocked Bash calls preserve custom non-record refusal details", async () => {
  for (const originalDetails of ["custom detail", ["custom", "detail"]]) {
    let executions = 0;
    const agent = new Agent({
      streamFn: () => { throw new Error("offline provider must not be called"); },
      beforeToolCall: async () => ({ block: true, reason: "synthetic refusal", details: originalDetails }),
    });
    agent.state.tools = [createBashTool(cwd, { operations: {
      async exec() { executions++; return { exitCode: 0 }; },
    } })];
    try {
      const result = await agent.dispatchHostTool({ type: "toolCall", id: "custom-refusal", name: "bash", arguments: { command: "printf synthetic" } });
      assert.equal(result.isError, true);
      assert.equal((result.details as any).executionStatus, "not_executed");
      assert.deepEqual((result.details as any).originalDetails, originalDetails);
      assert.equal(executions, 0);
    } finally { agent.abort(); }
  }
});

test("a standalone ripgrep no-match stays an expected empty result after the runtime status prefix", async () => {
  const fixture = mkdtempSync(join(tmpdir(), "sp-shell-rg-empty-"));
  const agent = new Agent({ streamFn: () => { throw new Error("offline provider must not be called"); } });
  agent.state.tools = [createBashTool(fixture, { operations: { async exec() { return { exitCode: 1 }; } } })];
  try {
    const command = "rg -n absent fixture.bin";
    const result = await agent.dispatchHostTool({ type: "toolCall", id: "rg-empty", name: "bash", arguments: { command } });
    assert.equal(result.isError, true);
    const text = (result.content[0] as { text: string }).text;
    assert.match(text, /^\[SHELL_RUNTIME_FAILED\]/);
    assert.equal(classifyError("bash", text).category, "empty_nonzero_exit");
    const session = SessionManager.inMemory(fixture);
    session.appendMessage({ role: "assistant", content: [{ type: "toolCall", id: "rg-empty", name: "bash", arguments: { command } }], stopReason: "toolUse", timestamp: Date.now() } as never);
    session.appendMessage(result);
    assert.deepEqual(collectSessionErrors(session.getBranch()), []);
    session.appendMessage({ role: "assistant", content: [{ type: "toolCall", id: "rg-error", name: "bash", arguments: { command } }], stopReason: "toolUse", timestamp: Date.now() } as never);
    session.appendMessage({ ...result, toolCallId: "rg-error", content: [{ type: "text", text: "[SHELL_RUNTIME_FAILED] synthetic error\n\nCommand exited with code 1" }] });
    assert.equal(collectSessionErrors(session.getBranch()).length, 1, "a real ripgrep error must not be suppressed as no-match");
  } finally {
    agent.abort();
    rmSync(fixture, { recursive: true });
  }
});

test("real guard, authorization, Bash and tool-result path handle three feedback command shapes", async (t) => {
  const shellPath = findTestBash();
  if (!shellPath || !existsSync(shellPath)) {
    if (process.env.CI) assert.fail("Required Bash integration test could not find Git Bash or /bin/bash");
    t.skip(`Bash unavailable at ${shellPath ?? "known locations"}`);
    return;
  }
  const fixture = mkdtempSync(join(tmpdir(), "sp-shell-compat-"));
  mkdirSync(join(fixture, ".git"));
  mkdirSync(join(fixture, "subdir"));
  writeFileSync(join(fixture, "fixture.bin"), Buffer.from([0x50, 0x49, 0x01, 0x02]));
  writeFileSync(join(fixture, "subdir", "fixture.bin"), Buffer.from([0x50, 0x49, 0x01, 0x02]));
  const jiti = createJiti(import.meta.url);
  const { default: lifecycle } = await jiti.import<any>("../packages/extensions/resource-lifecycle-guard/index.ts");
  const runtime = createExtensionRuntime();
  const runner = new ExtensionRunner(
    [await loadExtensionFromFactory((pi: any) => lifecycle(pi), fixture, createEventBus(), runtime)],
    runtime, fixture, SessionManager.inMemory(fixture), {} as never,
  );
  let decision = "仅允许本次";
  let approvals = 0;
  let executions = 0;
  const agent = new Agent({
    streamFn: () => { throw new Error("offline provider must not be called"); },
    beforeToolCall: async ({ toolCall, args }) => runner.emitToolCall({
      type: "tool_call", toolName: toolCall.name, toolCallId: toolCall.id, input: args as Record<string, unknown>,
    } as never),
  });
  runner.bindCore({ getThinkingLevel: () => "off", getActiveTools: () => ["bash"] } as never, {
    getSignal: () => agent.signal, isProjectTrusted: () => false, getModel: () => agent.state.model,
    isIdle: () => !agent.state.isStreaming, abort: () => agent.abort(), hasPendingMessages: () => false,
  } as never);
  runner.setUIContext({ ...runner.getUIContext(), select: async () => { approvals++; return decision; } }, "tui");
  const local = createLocalBashOperations({ shellPath });
  let spill: string | undefined;
  agent.state.tools = [createBashTool(fixture, { exposeSessionEnvironment: false, operations: {
    exec: (command, executionCwd, options) => { executions++; return local.exec(command, executionCwd, options); },
  } })];
  try {
    await runner.emit({ type: "session_start" } as never);
    const commands = [
      `cd subdir && f="fixture.bin" && ls -l "$f" && (command -v cat && cat "$f" | head -c 3) 2>&1 | head -20; echo "---query---"; command -v printf cat; command -V printf; command printf 'prefix-ok' 2>&1 | cat`,
      `for t in printf cat; do printf "%-12s " "$t"; command -v $t || echo "-"; done; echo "---search---"; ls . 2>/dev/null; ls missing-synthetic 2>/dev/null`,
      `cd subdir && python -c "
import struct
d=open('fixture.bin','rb').read()
print(struct.unpack_from('<H', d, 0)[0])
" 2>&1 | head -60`,
    ];
    for (let index = 0; index < commands.length; index++) {
      const result = await agent.dispatchHostTool({ type: "toolCall", id: `feedback-${index}`, name: "bash", arguments: { command: commands[index] } });
      assert.equal(result.isError, index === 1, JSON.stringify(result.content));
      if (index === 1) assert.match((result.content[0] as any).text, /Command exited with code 2/);
      assert.doesNotMatch((result.content[0] as any).text, /FD_DUP_UNSUPPORTED|SHELL_WRAPPER/);
    }
    assert.equal(executions, 3, "each authorized call executes once");
    const quoted = await agent.dispatchHostTool({ type: "toolCall", id: "quoted", name: "bash", arguments: { command: `printf '%s' '2>&1'` } });
    assert.equal(quoted.isError, false);
    assert.match((quoted.content[0] as any).text, /2>&1/);
    assert.equal(executions, 4);

    const joined = await agent.dispatchHostTool({ type: "toolCall", id: "joined", name: "bash", arguments: { command: "{ printf out; printf err >&2; } >joined.log 2>&1; cat joined.log" } });
    const split = await agent.dispatchHostTool({ type: "toolCall", id: "split", name: "bash", arguments: { command: "{ printf out; printf err >&2; } 2>&1 >split.log | cat; cat split.log" } });
    assert.equal(joined.isError, false, JSON.stringify(joined.content));
    assert.equal(split.isError, false, JSON.stringify(split.content));
    assert.equal(readFileSync(join(fixture, "joined.log"), "utf8"), "outerr");
    assert.equal(readFileSync(join(fixture, "split.log"), "utf8"), "out");
    assert.equal(executions, 6);

    decision = "拒绝";
    const denied = await agent.dispatchHostTool({ type: "toolCall", id: "denied", name: "bash", arguments: { command: "printf data >denied.log 2>&1" } });
    assert.equal(denied.isError, true);
    assert.match((denied.content[0] as any).text, /USER_REJECTED|CONFIRMATION_CANCELLED/);
    assert.equal(executions, 6);
    assert.equal(existsSync(join(fixture, "denied.log")), false);
    const protectedResult = await agent.dispatchHostTool({ type: "toolCall", id: "protected", name: "bash", arguments: { command: "printf data >.git/config 2>&1" } });
    assert.equal(protectedResult.isError, true);
    assert.equal(executions, 6);
    assert.equal(existsSync(join(fixture, ".git", "config")), false);
    const dynamic = await agent.dispatchHostTool({ type: "toolCall", id: "dynamic-fd", name: "bash", arguments: { command: "printf data 2>&$fd" } });
    assert.equal(dynamic.isError, true);
    assert.equal(executions, 6);
    const nested = await agent.dispatchHostTool({ type: "toolCall", id: "nested-protected", name: "bash", arguments: { command: 'printf "%s" "$(rm -rf .git)"' } });
    assert.equal(nested.isError, true);
    assert.equal(executions, 6);
    assert.equal(existsSync(join(fixture, ".git")), true);
    for (const [id, command] of [
      ["zero-iteration-cd", "for x in; do cd subdir; done; printf data >.git/config"],
      ["escaped-cd", "for x in; do c\\d subdir; done; printf data >.git/config"],
      ["quoted-cd", "for x in; do 'c'd subdir; done; printf data >.git/config"],
      ["select-empty-cd", "select x in; do cd subdir; done; printf data >.git/config"],
      ["conditional-cd", "if false; then cd subdir; fi; printf data >.git/config"],
      ["case-cd", "case no in yes) cd subdir;; esac; printf data >.git/config"],
      ["short-circuit-cd", "false && cd subdir; printf data >.git/config"],
      ["failed-left-and-cd", "cd missing-synthetic && :; printf data >.git/config"],
      ["failed-left-or-cd", "cd missing-synthetic || :; printf data >.git/config"],
      ["failed-left-and-delete", "cd missing-synthetic && :; find . -delete"],
      ["failed-left-command-write", "cd missing-synthetic && :; command printf data >.git/config"],
      ["pipeline-group-cd", "{ cd subdir; } | cat; printf data >.git/config"],
      ["pipeline-cd", "cd subdir | cat; printf data >.git/config"],
      ["subshell-cd", "(cd subdir); printf data >.git/config"],
      ["wrapped-loop-cd", "bash -c 'for x in; do cd subdir; done; printf data >.git/config'"],
      ["wrapped-escaped-cd", "bash -c 'for x in; do c\\d subdir; done; printf data >.git/config'"],
    ]) {
      assert.match(inspectBashResourceLifecycle({ command }) ?? "", /SHELL_UNINSPECTABLE/);
      assert.equal(inspectHighRiskBashMutation({ command }, fixture)?.unverifiableScope, true);
      assert.equal(inspectBashPermissionScope({ command }, fixture)?.unverifiableScope, true);
      const result = await agent.dispatchHostTool({ type: "toolCall", id, name: "bash", arguments: { command } });
      assert.equal(result.isError, true);
      assert.equal((result.details as any).executionStatus, "not_executed");
      assert.equal(executions, 6);
      assert.equal(existsSync(join(fixture, ".git", "config")), false);
    }
    const lifecycleRefusal = await agent.dispatchHostTool({ type: "toolCall", id: "lifecycle", name: "bash", arguments: { command: 'command "$candidate" --help' } });
    assert.equal(lifecycleRefusal.isError, true);
    assert.equal((lifecycleRefusal.details as any).executionStatus, "not_executed");
    assert.equal(executions, 6);
    initTheme("dark");
    const show = (result: any) => {
      const component = new ToolExecutionComponent("bash", "shell-status", { command: "synthetic" }, { showImages: false }, undefined, { requestRender() {} } as never, fixture);
      component.markExecutionStarted();
      component.setArgsComplete();
      component.updateResult(result, false, result.isError);
      return component.render(120).join("\n").replaceAll(/\x1b\[[0-9;]*m/gu, "");
    };
    assert.doesNotMatch(show(lifecycleRefusal), /Took 0\.0s|Took \d/);

    const large = Buffer.alloc(6 * 1024 * 1024, 0x78);
    agent.state.tools = [createBashTool(fixture, { exposeSessionEnvironment: false, operations: {
      async exec(_command, _cwd, options) { executions++; options.onData(large); return { exitCode: 0 }; },
    } })];
    const capped = await agent.dispatchHostTool({ type: "toolCall", id: "capped", name: "bash", arguments: { command: "printf synthetic" } });
    assert.equal(capped.isError, false, JSON.stringify(capped.content));
    assert.equal((capped.details as any).spillFileCapped, true);
    assert.match((capped.content[0] as any).text, /Capped output file \(5 MiB; later output unavailable\)/);
    assert.doesNotMatch((capped.content[0] as any).text, /Full output:/);
    spill = (capped.details as any).fullOutputPath as string;
    assert.ok(spill && existsSync(spill));
    assert.ok(statSync(spill).size <= 5 * 1024 * 1024);
    assert.match(readFileSync(spill).subarray(-100).toString(), /later output was not persisted/);
    assert.match(show(capped), /Capped output file \(5 MiB; later output unavailable\)/);
    assert.doesNotMatch(show(capped), /Full output:/);

    const saved = SessionManager.create(fixture, join(fixture, "sessions"));
    saved.appendMessage(lifecycleRefusal);
    saved.appendMessage(capped);
    saved.ensureOperationStorage();
    const file = saved.getSessionFile();
    assert.ok(file);
    const reopened = SessionManager.open(file);
    const messages = reopened.getBranch().filter(entry => entry.type === "message").map(entry => (entry as any).message);
    assert.equal(messages[0].details.executionStatus, "not_executed");
    assert.equal(messages[1].details.spillFileCapped, true);
    assert.match(show(messages[1]), /Capped output file/);
    assert.equal(executions, 7, "reopening and rendering never replays a command");
    unlinkSync(spill);
    unlinkSync(spill + ".sp-owned");
    spill = undefined;

    const failureCases = [
      ["launch", async () => { throw Object.assign(new Error("synthetic launch failure"), { code: "ENOENT" }); }, "SHELL_START_FAILED"],
      ["runtime", async (_command: string, _cwd: string, options: any) => { options.onData(Buffer.from("stderr fixture")); return { exitCode: 7 }; }, "SHELL_RUNTIME_FAILED"],
      ["abort", async () => { throw new Error("aborted"); }, "SHELL_INTERRUPTED"],
      ["timeout", async () => { throw new Error("timeout:1"); }, "SHELL_INTERRUPTED"],
    ] as const;
    for (const [name, injected, code] of failureCases) {
      agent.state.tools = [createBashTool(fixture, { exposeSessionEnvironment: false, operations: {
        exec: (command, executionCwd, options) => { executions++; return injected(command, executionCwd, options); },
      } })];
      const result = await agent.dispatchHostTool({ type: "toolCall", id: name, name: "bash", arguments: { command: "printf synthetic" } });
      assert.equal(result.isError, true);
      assert.match((result.content[0] as any).text, new RegExp(`^\\[${code}\\]`));
    }
    const failedDefinition = createShellToolDefinition(fixture, {
      name: "bash", label: "bash", shellName: "bash", prompt: "$", promptSnippet: "fixture", tempFilePrefix: "missing/subdir",
    }, { exposeSessionEnvironment: false, operations: {
      async exec(_command, _cwd, options) { executions++; options.onData(Buffer.alloc(64 * 1024, 0x61)); return { exitCode: 0 }; },
    } });
    agent.state.tools = [wrapToolDefinition(failedDefinition)];
    const logFailed = await agent.dispatchHostTool({ type: "toolCall", id: "log-failed", name: "bash", arguments: { command: "printf synthetic" } });
    assert.equal(logFailed.isError, true);
    assert.match((logFailed.content[0] as any).text, /^\[SHELL_LOG_FAILED\]/);
    assert.doesNotMatch((logFailed.content[0] as any).text, /Full output:/);
    assert.equal(executions, 12);
    assert.ok(approvals >= 2);
    assert.equal(readFileSync(join(fixture, "fixture.bin")).length, 4);

    decision = "仅允许本次";
    agent.state.tools = [createBashTool(fixture, { exposeSessionEnvironment: false, operations: {
      exec: (command, executionCwd, options) => { executions++; return local.exec(command, executionCwd, options); },
    } })];
    const bracket = await agent.dispatchHostTool({ type: "toolCall", id: "bracket-compare", name: "bash", arguments: { command: "[[ a < b ]] && printf bracket-ok" } });
    assert.equal(bracket.isError, false, JSON.stringify(bracket.content));
    assert.match((bracket.content[0] as { text: string }).text, /bracket-ok/);
    assert.equal(executions, 13);
    decision = "拒绝";
    const bracketWrite = await agent.dispatchHostTool({ type: "toolCall", id: "bracket-write", name: "bash", arguments: { command: "[[ a < b ]] >.git/config" } });
    assert.equal(bracketWrite.isError, true, JSON.stringify(bracketWrite));
    assert.equal(executions, 13);
    assert.equal(existsSync(join(fixture, ".git", "config")), false);
    decision = "仅允许本次";
    for (const name of ["command", "exec"]) {
      writeFileSync(join(fixture, name), "#!/usr/bin/env bash\nprintf synthetic >.git/config\n");
      const command = `./${name} -v harmless`;
      assert.equal(inspectBashResourceLifecycle({ command }), undefined);
      assert.equal(inspectHighRiskBashMutation({ command }, fixture)?.unverifiableScope, true);
      const scope = inspectBashPermissionScope({ command }, fixture);
      assert.equal(scope?.unverifiableScope, true);
      assert.notEqual(scope?.kind, "read-only");
      const result = await agent.dispatchHostTool({ type: "toolCall", id: `external-${name}`, name: "bash", arguments: { command } });
      assert.equal(result.isError, true);
      assert.equal((result.details as any).executionStatus, "not_executed");
      assert.equal(executions, 13);
      assert.equal(existsSync(join(fixture, ".git", "config")), false);
    }
    const safeChain = await agent.dispatchHostTool({ type: "toolCall", id: "safe-conditional-cd", name: "bash", arguments: {
      command: "cd subdir && printf synthetic >local.log; echo after",
    } });
    assert.equal(safeChain.isError, false, JSON.stringify(safeChain.content));
    assert.equal(readFileSync(join(fixture, "subdir", "local.log"), "utf8"), "synthetic");
    assert.match((safeChain.content[0] as { text: string }).text, /after/);
    assert.equal(executions, 14);
  } finally {
    agent.abort();
    runner.invalidate();
    await runner.emit({ type: "session_shutdown" } as never);
    if (spill && existsSync(spill)) unlinkSync(spill);
    if (spill && existsSync(spill + ".sp-owned")) unlinkSync(spill + ".sp-owned");
    rmSync(fixture, { recursive: true });
  }
});
