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
import { convertToLlm } from "../packages/coding-agent/src/core/messages.ts";
import { renderPolicyDiagnostic } from "../packages/extensions/resource-lifecycle-guard/policy-diagnostics.ts";
import { sanitizePolicyFeedback } from "../packages/extensions/resource-lifecycle-guard/policy-diagnostics.ts";
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

test("the first reliable redirection diagnostic remains stable when later descriptors appear", () => {
  const scan = inspectHighRiskBashMutation({ command: "echo x 2>&1 3>&2 | head" }, process.cwd());
  assert.equal(scan?.diagnostic?.diagnostic.code, "FD_DUP_UNSUPPORTED");
  assert.equal(scan?.diagnostic?.diagnostic.syntax, "2>&1");
});

test("blocked tool projection keeps the legacy empty-reason fallback and final permission decision", async () => {
  const tool = {
    name: "fixture", label: "fixture", description: "offline", parameters: { type: "object", properties: {} } as any,
    execute: async () => ({ content: [{ type: "text" as const, text: "executed" }], details: {} }),
  } as any;
  async function dispatch(reason: unknown) {
    const agent = new Agent({
      streamFn: () => { throw new Error("offline provider must not be called"); },
      beforeToolCall: async () => ({ block: true, reason } as any),
    });
    agent.state.tools = [tool];
    try { return await agent.dispatchHostTool({ type: "toolCall", id: "reason", name: "fixture", arguments: {} }); }
    finally { agent.abort(); }
  }
  for (const reason of [undefined, null, "", "   "]) {
    const result = await dispatch(reason);
    assert.equal(result.content[0]?.type, "text");
    assert.equal((result.content[0] as any).text, "Tool execution was blocked");
  }
  const feedback = "用户拒绝：" + "说明 ".repeat(200);
  const structured = JSON.stringify({
    ok: false, category: "POLICY_BLOCKED", operation: "bash", permissionMode: "full-access",
    policyReason: "user_rejected", primitives: ["opaque_shell_wrapper", "unverifiable_target"],
    rejectionReason: feedback, stateChanged: false, retryable: false,
  });
  const refusal = await dispatch(structured);
  const refusalText = (refusal.content[0] as any).text as string;
  assert.match(refusalText, /^\[POLICY_BLOCKED:USER_REJECTED\]/);
  assert.doesNotMatch(refusalText, /launcher|native tool|shell bypass/i);
  assert.ok(refusalText.length < 500);
  assert.match(refusalText, /User feedback:/);
  const changed = await dispatch(JSON.stringify({ category: "POLICY_BLOCKED", policyReason: "user_rejected", stateChanged: true, primitives: ["opaque_shell_wrapper"] }));
  assert.match((changed.content[0] as any).text, /\"stateChanged\":true/);
});

test("rejection feedback is bounded and redacts URLs, credentials, and long paths", () => {
  const feedback = sanitizePolicyFeedback("拒绝 https://user:secret@example.invalid/path?q=private_token; token=abc123 C:\\private\\long\\session\\file.jsonl");
  assert.ok(feedback);
  assert.doesNotMatch(feedback!, /user:secret|\?q=private_token|token=abc123|C:\\private/);
  assert.match(feedback!, /URL redacted|credential redacted|path redacted/);
  assert.ok(feedback!.length <= 240);
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

test("provider wire receives one projected refusal after real Agent preflight", async () => {
  const jiti = createJiti(import.meta.url);
  const { default: lifecycle } = await jiti.import<any>("../packages/extensions/resource-lifecycle-guard/index.ts");
  const cwd = process.cwd();
  const runtime = createExtensionRuntime();
  const extensions = [await loadExtensionFromFactory((pi: any) => lifecycle(pi), cwd, createEventBus(), runtime)];
  const sessionManager = SessionManager.inMemory(cwd);
  const runner = new ExtensionRunner(extensions, runtime, cwd, sessionManager, {} as never);
  const model: any = { id: "offline", name: "offline", api: "openai-completions", provider: "fixture", baseUrl: "https://fixture.invalid/v1", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 64000, maxTokens: 128 };
  const wire: any[] = [];
  let backend = 0;
  let requests = 0;
  const providerFetch = async (_url: string | URL, init?: RequestInit) => {
    const payload = JSON.parse(String(init?.body));
    wire.push(payload);
    requests++;
    const body = requests === 1
      ? `data: ${JSON.stringify({ choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: "policy-call", type: "function", function: { name: "bash", arguments: JSON.stringify({ command: USER_COMMANDS[0] }) } }] }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] })}\n\ndata: [DONE]\n\n`
      : `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "replanned" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`;
    return new Response(body, { headers: { "content-type": "text/event-stream" } });
  };
  const activeTools = ["bash"];
  const agent = new Agent({
    initialState: { model },
    convertToLlm,
    streamFn: (requestModel, context, options) => streamSimple(requestModel as any, context, { ...(options as any), apiKey: "offline", fetch: providerFetch }),
    beforeToolCall: async ({ toolCall, args }) => runner.emitToolCall({ type: "tool_call", toolName: toolCall.name, toolCallId: toolCall.id, input: args as Record<string, unknown> } as never),
  });
  runner.bindCore({ getThinkingLevel: () => "off", getActiveTools: () => activeTools } as never, {
    getSignal: () => agent.signal, isProjectTrusted: () => false, getModel: () => agent.state.model,
    isIdle: () => !agent.state.isStreaming, abort: () => agent.abort(), hasPendingMessages: () => false,
  } as never);
  const bash = createBashTool(cwd, { exposeSessionEnvironment: false, operations: { exec: async () => { backend++; return { exitCode: 0 }; } } });
  agent.state.tools = [{ ...bash, execute: (id: any, input: any, signal: any, update: any) => (backend++, (bash.execute as any)(id, input, signal, update)) }];
  try {
    await runner.emit({ type: "session_start" } as never);
    await agent.prompt("wire fixture");
    assert.equal(requests, 2);
    assert.equal(backend, 0);
    const results = agent.state.messages.filter(message => message.role === "toolResult") as any[];
    assert.equal(results.length, 1);
    assert.equal(results[0].toolCallId, "policy-call");
    assert.match(results[0].content[0].text, /^\[POLICY_BLOCKED:FD_DUP_UNSUPPORTED\]/);
    const secondMessages = JSON.stringify(wire[1].messages);
    assert.equal((wire[1].messages as any[]).filter(message => message.role === "tool").length, 1);
    assert.match(secondMessages, /POLICY_BLOCKED:FD_DUP_UNSUPPORTED/);
    assert.doesNotMatch(secondMessages, /unverifiable_dynamic_scope/);
    assert.equal((secondMessages.match(/POLICY_BLOCKED:FD_DUP_UNSUPPORTED/g) ?? []).length, 1);
  } finally {
    agent.abort(); runner.invalidate(); await runner.emit({ type: "session_shutdown" } as never);
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
