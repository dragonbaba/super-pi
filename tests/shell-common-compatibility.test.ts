import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

const cwd = process.cwd();

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
  assert.equal(inspectHighRiskBashMutation({ command: "printf '%s' '2>&1'" }, cwd), undefined);
  assert.ok(inspectHighRiskBashMutation({ command: 'printf "%s" "$(rm -rf synthetic)"' }, cwd)?.primitives.includes("rm_recursive"));
});

test("asynchronous spill write failure releases only its owned file", async () => {
  const output = new OutputAccumulator({ tempFilePrefix: "sp-shell-write-failure" });
  output.append(Buffer.alloc(64 * 1024, 0x61));
  const path = output.snapshot({ persistIfTruncated: true }).fullOutputPath;
  assert.ok(path);
  try {
    (output as any).tempFileStream.destroy(new Error("synthetic write failure"));
    await assert.rejects(output.closeTempFile(), /synthetic write failure/);
    await output.discardTempFile();
    assert.equal(existsSync(path), false);
    assert.equal(existsSync(path + ".sp-owned"), false);
  } finally {
    await output.discardTempFile();
  }
});

test("real guard, authorization, Bash and tool-result path handle three feedback command shapes", async (t) => {
  const shellPath = process.env.SP_TEST_BASH ?? (process.platform === "win32" ? "D:\\Git\\bin\\bash.exe" : "/bin/bash");
  if (!existsSync(shellPath)) { t.skip(`Bash unavailable at ${shellPath}`); return; }
  const fixture = mkdtempSync(join(tmpdir(), "sp-shell-compat-"));
  mkdirSync(join(fixture, ".git"));
  writeFileSync(join(fixture, "fixture.bin"), Buffer.from([0x50, 0x49, 0x01, 0x02]));
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
      `cd . && f="fixture.bin" && ls -l "$f" && (command -v cat && cat "$f" | head -c 3) 2>&1 | head -20; echo "---query---"; command -v printf cat; command -V printf; command printf 'prefix-ok' 2>&1 | cat`,
      `for t in printf cat; do printf "%-12s " "$t"; command -v $t || echo "-"; done; echo "---search---"; ls . 2>/dev/null; ls missing-synthetic 2>/dev/null`,
      `cd . && python -c "
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
  } finally {
    agent.abort();
    runner.invalidate();
    await runner.emit({ type: "session_shutdown" } as never);
    if (spill && existsSync(spill)) unlinkSync(spill);
    if (spill && existsSync(spill + ".sp-owned")) unlinkSync(spill + ".sp-owned");
    rmSync(fixture, { recursive: true });
  }
});
