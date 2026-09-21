import assert from "node:assert/strict";
import test from "node:test";
import { Agent } from "../packages/agent/src/agent.ts";
import { createBashTool } from "../packages/coding-agent/src/core/tools/bash.ts";
import { createEventBus } from "../packages/coding-agent/src/core/event-bus.ts";
import { createExtensionRuntime, ExtensionRunner, loadExtensionFromFactory } from "../packages/coding-agent/src/core/extensions/index.ts";
import { SessionManager } from "../packages/coding-agent/src/core/session-manager.ts";
import { createJiti } from "jiti";
import { initTheme } from "../packages/coding-agent/src/modes/interactive/theme/theme.ts";
import { ToolExecutionComponent } from "../packages/coding-agent/src/modes/interactive/components/tool-execution.ts";
import { getEncoding } from "js-tiktoken";
import { streamSimple } from "../packages/ai/src/api/openai-completions.ts";
import { renderPolicyDiagnostic } from "../packages/extensions/resource-lifecycle-guard/policy-diagnostics.ts";
import { inspectBashResourceLifecycle, inspectHighRiskBashMutation } from "../packages/extensions/resource-lifecycle-guard/core.ts";
import { inspectBashPermissionScope } from "../packages/extensions/resource-lifecycle-guard/permission-bash.ts";

// Offline evidence strings. They are passed to scanners and fixtures only.
const USER_COMMANDS = [
  'tasklist /FI "PID eq 5064" /FO CSV 2>&1 | head -3; echo "---1352---"; tasklist /FI "PID eq 1352" /FO CSV 2>&1 | head -3',
  'echo "=== PID 1352 身份 ==="; wmic process where "ProcessId=1352" get Name,ExecutablePath 2>&1 | head -5; echo "--- 备用查询 ---"; powershell -NoProfile -Command "Get-Process -Id 1352 | Select-Object Id,ProcessName,Path | Format-List" 2>&1 | head -10',
  'cmd /c "wmic process where ProcessId=1352 get Name,ExecutablePath /format:list" 2>&1 | head -8',
  'echo "=== 模拟 Claude Code 连接，抓取源地址 ==="; curl -4 -v --max-time 15 -o /dev/null https://api.anthropic.com/ 2>&1 | grep -iE "Trying|Connected to|bound|from" | head -6',
] as const;

test("offline user command fixtures preserve first blocking evidence", () => {
  const first = inspectHighRiskBashMutation({ command: USER_COMMANDS[0] }, process.cwd());
  assert.ok(first?.unverifiableScope);
  assert.deepEqual(first?.diagnostic?.diagnostic.code, "FD_DUP_UNSUPPORTED");
  assert.equal(inspectBashResourceLifecycle({ command: USER_COMMANDS[1] })?.startsWith("[SHELL_WRAPPER:LAUNCHER_UNSUPPORTED]"), true);
  const third = inspectHighRiskBashMutation({ command: USER_COMMANDS[2] }, process.cwd());
  assert.equal(third?.diagnostic?.diagnostic.code, "FD_DUP_UNSUPPORTED");
  const fourth = inspectHighRiskBashMutation({ command: USER_COMMANDS[3] }, process.cwd());
  assert.deepEqual(fourth?.diagnostic?.diagnostic.code, "FD_DUP_UNSUPPORTED");
});

test("redirection evidence distinguishes syntax from quoted and heredoc data", () => {
  const syntax = inspectHighRiskBashMutation({ command: "tasklist 2>&1 | head" }, process.cwd());
  assert.equal(syntax?.diagnostic?.diagnostic.code, "FD_DUP_UNSUPPORTED");
  assert.equal(inspectHighRiskBashMutation({ command: "printf '%s' '2>&1'" }, process.cwd()), undefined);
  const heredoc = inspectHighRiskBashMutation({ command: "cat <<'EOF'\n2>&1\nEOF" }, process.cwd());
  assert.ok(heredoc?.primitives.includes("heredoc_uninspectable"));
  assert.notEqual(heredoc?.diagnostic?.diagnostic.code, "FD_DUP_UNSUPPORTED");
  assert.equal(inspectBashPermissionScope({ command: "printf '%s' '2>&1'" }, process.cwd())?.unverifiableScope, false);
});

test("multiple causes retain parser order and do not let full-access bypass verification", () => {
  const scan = inspectHighRiskBashMutation({ command: "tasklist 2>&1 | head; rm -rf $TARGET" }, process.cwd());
  assert.ok(scan?.primitives.includes("unverifiable_redirection"));
  assert.ok(scan?.primitives.includes("rm_recursive"));
  assert.equal(scan?.diagnostic?.diagnostic.code, "FD_DUP_UNSUPPORTED");
  assert.equal(scan?.diagnostic?.diagnostic.retryable, false);
});

test("production extension preflight reaches the first refusal without backend or process use", async () => {
  const jiti = createJiti(import.meta.url);
  const { default: lifecycle } = await jiti.import<any>("../packages/extensions/resource-lifecycle-guard/index.ts");
  const cwd = process.cwd();
  const runtime = createExtensionRuntime();
  const extensions = [await loadExtensionFromFactory((pi: any) => lifecycle(pi), cwd, createEventBus(), runtime)];
  const runner = new ExtensionRunner(extensions, runtime, cwd, SessionManager.inMemory(cwd), {} as never);
  const activeTools = ["bash"];
  let executions = 0;
  const agent = new Agent({
    streamFn: () => { throw new Error("offline provider must not be called"); },
    beforeToolCall: async ({ toolCall, args }) => runner.emitToolCall({
      type: "tool_call", toolName: toolCall.name, toolCallId: toolCall.id, input: args as Record<string, unknown>,
    } as never),
  });
  runner.bindCore({ getThinkingLevel: () => "off", getActiveTools: () => activeTools } as never, {
    getSignal: () => agent.signal, isProjectTrusted: () => false, getModel: () => agent.state.model,
    isIdle: () => !agent.state.isStreaming, abort: () => agent.abort(), hasPendingMessages: () => false,
  } as never);
  runner.setUIContext({ ...runner.getUIContext(), select: async () => undefined }, "tui");
  await runner.emit({ type: "session_start" } as never);
  const bash = createBashTool(cwd, {
    exposeSessionEnvironment: false,
    operations: { exec: async () => { executions++; return { exitCode: 0 }; } },
  });
  agent.state.tools = [{ ...bash, execute: (id: any, input: any, signal: any, update: any) => { executions++; return (bash.execute as any)(id, input, signal, update); } }];
  try {
    const lifecycleResult = await agent.dispatchHostTool({ type: "toolCall", id: "wrapper", name: "bash", arguments: { command: USER_COMMANDS[1] } });
    const mutationResult = await agent.dispatchHostTool({ type: "toolCall", id: "fd", name: "bash", arguments: { command: USER_COMMANDS[0] } });
    const lifecycleText = lifecycleResult.content.filter(c => c.type === "text").map(c => c.text).join("\n");
    const mutationText = mutationResult.content.filter(c => c.type === "text").map(c => c.text).join("\n");
    assert.match(lifecycleText, /^\[SHELL_WRAPPER:LAUNCHER_UNSUPPORTED\] Not executed:/);
    assert.match(lifecycleText, /directly inspectable foreground command/);
    activeTools.push("powershell");
    const availableResult = await agent.dispatchHostTool({ type: "toolCall", id: "wrapper-available", name: "bash", arguments: { command: USER_COMMANDS[1] } });
    const availableText = availableResult.content.filter(c => c.type === "text").map(c => c.text).join("\n");
    assert.match(availableText, /Use the enabled native PowerShell tool/);
    assert.match(mutationText, /^\[POLICY_BLOCKED:FD_DUP_UNSUPPORTED\] Not executed:/);
    const machineDetails = mutationResult.details as any;
    assert.equal(machineDetails.diagnostic.code, "FD_DUP_UNSUPPORTED");
    assert.equal(machineDetails.operation, "bash");
    assert.equal(machineDetails.permissionMode, "workspace-write");
    assert.equal(machineDetails.highRisk, true);
    assert.equal(machineDetails.opaqueScript, true);
    assert.equal(machineDetails.stateChanged, false);
    assert.equal(machineDetails.retryable, false);
    assert.equal(executions, 0);
  } finally {
    agent.abort();
    runner.invalidate();
    await runner.emit({ type: "session_shutdown" } as never);
  }
});

test("default TUI keeps the diagnostic code, syntax and recovery readable", () => {
  initTheme("dark");
  const component = new ToolExecutionComponent("bash", "policy", {}, { showImages: false }, undefined, { requestRender(): void {} } as never, process.cwd());
  component.updateResult({ content: [{ type: "text", text: "[POLICY_BLOCKED:FD_DUP_UNSUPPORTED] Not executed:\nBash analysis does not support `2>&1`.\nNext: omit stream merging only if stderr need not pass through the pipe; resubmit for authorization." }], isError: true });
  const rendered = component.render(120).join("\n").replaceAll(/\x1b\[[0-9;]*m/gu, "");
  assert.match(rendered, /FD_DUP_UNSUPPORTED/);
  assert.match(rendered, /2>&1/);
  assert.match(rendered, /Next:/);
});

test("diagnostic token budget is measured through provider serialization", async () => {
  const diagnostic = { code: "FD_DUP_UNSUPPORTED" as const, category: "POLICY_BLOCKED" as const, syntax: "2>&1", retryable: false, action: "omit_syntax" as const };
  const shortText = renderPolicyDiagnostic(diagnostic);
  const legacyJson = JSON.stringify({ ok: false, category: "POLICY_BLOCKED", operation: "bash", permissionMode: "full-access", policyReason: "unverifiable_target", highRisk: true, opaqueScript: true, primitives: ["unverifiable_redirection", "unverifiable_dynamic_scope"], stateChanged: false, retryable: false });
  const encoding = getEncoding("cl100k_base");
  const oldTokens = encoding.encode(legacyJson).length;
  const shortTokens = encoding.encode(shortText).length;
  let wire: any;
  const model: any = { id: "offline", name: "offline", api: "openai-completions", provider: "fixture", baseUrl: "https://fixture.invalid/v1", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 64000, maxTokens: 128 };
  const stream = streamSimple(model, { messages: [{ role: "user", content: shortText, timestamp: 0 }] as any }, { apiKey: "offline", fetch: async (_url, init) => {
    wire = JSON.parse(String(init?.body));
    return new Response('data: {"choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', { headers: { "content-type": "text/event-stream" } });
  } });
  await stream.result();
  const wireText = wire.messages[0].content as string;
  assert.equal(wireText, shortText);
  assert.ok(shortTokens < 128, `${shortTokens} estimated tokens`);
  assert.ok(oldTokens > shortTokens);
  assert.doesNotMatch(JSON.stringify(wire), /unverifiable_dynamic_scope/);
  console.log(JSON.stringify({ legacyJsonEstimatedTokens: oldTokens, candidateShortTextEstimatedTokens: shortTokens, providerWireContentCodeUnits: wireText.length }));
});
