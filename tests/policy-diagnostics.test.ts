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
import { inspectPowerShellResourceLifecycle } from "../packages/extensions/resource-lifecycle-guard/powershell-lifecycle.ts";
import { inspectBashPermissionScope } from "../packages/extensions/resource-lifecycle-guard/permission-bash.ts";

// Offline evidence strings. They are passed to scanners and fixtures only.
test("native PowerShell lifecycle distinguishes expressions, data and owned foreground launches", () => {
  for (const command of [
    "Add-Type -AssemblyName System.Speech; $s = New-Object System.Speech.Synthesis.SpeechSynthesizer; $s.GetInstalledVoices() | ForEach-Object { $_.VoiceInfo | Select-Object Name,Culture }; $s.Dispose()",
    "$s=New-Object System.Text.StringBuilder; try { [void]$s.Append('Start-Job'); $s.ToString() } finally { $s.Clear() }",
    "Write-Output 'Start-Process foo; Start-Job {}'; # Start-Job\nWrite-Output 1",
    "<# outer <# Start-Job #> nested #> Write-Output 1",
    "& 'C:/Program Files/tool.exe' --help",
    "& { Write-Output 1 }; Write-Output 2 2>&1",
    "Write-Output `&; Write-Output `;", "Write-Output 1 && Write-Output 2",
    "Write-Output -As'Job'", "Write-Output '-AsJob'", "$p.StartInfo.FileName = 'tool.exe'; $p.StartTime",
    "Start-Process -FilePath tool.exe -Wait; Start-Process -FilePath other.exe -Wait",
    "Start-Process tool.exe 2>&1 -Wait", "Start-Process tool.exe -Wait 2>&1",
    "echo $((1 + $null))",
    "[void][object]$s.ToString()", "[System.Collections.Generic.List[string]]$items", "[string[]]$items",
    "[System.Collections.Generic.Dictionary[string,System.Collections.Generic.List[int]]]$items", "[int[][]]$items",
    "Write-Output report.Start (Get-Date)", "Write-Output report.InvokeScript (Get-Date)",
    "Write-Output status=Start-Job", "Write-Output status=-AsJob", "Write-Output status=@options",
    "Start-Process tool.exe -ArgumentList mode=foreground -Wait",
    "$items=@(1,2); $options=@{Name='sample'; Value=1}; Write-Output $options.Name",
    "Write-Output @{Start-Job='data'; Label='safe'}", "Get-CimClass Win32_Process | Select-Object CimClassName",
    "Start-BitsTransfer -Source 'https://example.invalid/a' -Destination 'a.txt'",
    "${name}='safe'; [string]${space name}='safe'; ${name}.ToUpper()",
    "${escaped`}}='safe'; Write-Output ${escaped`}}", "Write-Output { 1 } Start-Job",
    "if ((Write-Output { 1 } Start-Job)) { Write-Output safe } else { Write-Output { 2 } Start-Job }",
  ]) assert.equal(inspectPowerShellResourceLifecycle({ command }), undefined, command);
  for (const command of [
    "Start-Job { Write-Output 1 }", "$job = Start-ThreadJob { Write-Output 1 }", "if ($true) {} Start-Job {}",
    "Start-Process tool.exe", "Start-Process tool.exe -Wait; Start-Process other.exe", "return Start-Process tool.exe",
    "<# outer <# nested #> outer #> Start-Process tool.exe", "Start-Process --% tool.exe -Wait",
    "Start-Process tool.exe -Wait:$false", "Start-Process tool.exe '-Wait'", "Start-Process tool.exe @options -Wait",
    "& $exe", "& (Get-Command tool)", "Write-Output 1 &", "& { Start-Job {} }",
    "Write-Output $(Start-Job {})", 'Write-Output "$(Start-Job {})"',
    "Microsoft.PowerShell.Core\\Start-Job {}", "Sta`rt-Job {}", "Write-Output 1;`\nStart-Job {}",
    "saps tool.exe", "Invoke-Expression $script", "cmd /c start tool.exe",
    "Write-Output 1 & & 'tool.exe'", "Write-Output 1 & '&'", "Write-Output '>' & 1",
    "Sta'rt'-Process tool.exe", 'Start-Proce"ss" tool.exe', "Start-Process tool.exe -Wa'it'",
    "$p = New-Object System.Diagnostics.Process; $p.StartInfo.FileName = 'tool.exe'; $p.Start()",
    "[System.Diagnostics.Process]::Start('tool.exe')", "Write-Output $p.Start()", "($p).Start()", "$p.St'art'()", "$p.Start.Invoke()",
    "$p=New-Object hashtable; $p.AsJob=$true; 1 | ForEach-Object @p -Parallel { Start-Sleep 60 }",
    "1 | ForEach-Object -Parallel { 1 } @p", "1 | % @p -Parallel { 1 }",
    "$ExecutionContext.InvokeCommand.InvokeScript('Start-Job { Start-Sleep 60 }')",
    "Write-Output $ExecutionContext.InvokeCommand.InvokeScript('Start-Job {}')",
    "$ExecutionContext.InvokeCommand.ExpandString('$(Start-Job {})')", "[scriptblock]::Create('Start-Job {}').Invoke()",
    "$method=$p.Start; $method.Invoke()", "$com.Run('tool.exe', 0, $false)", "$task.BeginInvoke()",
    "Write-Output $receiver.$method('Start-Job {}')",
    "(Get-CimClass Win32_Process) | Invoke-CimMethod -MethodName Create -Arguments @{CommandLine='tool.exe'}",
    "Invoke-WmiMethod -Class Win32_Process -Name Create -ArgumentList 'tool.exe'", "$class.InvokeMethod('Create', 'tool.exe')",
    "Start-ScheduledTask -TaskName LongRunner", "Start-BitsTransfer -Source a -Destination b -Asynchronous",
    "Start-BitsTransfer -Source a -Destination b -Async", "Start-BitsTransfer -Source a -Destination b —Asy",
    "Start-Process tool.exe -ArgumentList mode=-Wait", "$h=@{value=Start-Job { 1 }}", "$h=@{value=(Start-Job { 1 })}",
    "$x=Start-Job {1}", "$x += Start-Job {1}", "docker run --env mode=foreground -d image",
    "bash -c 'sleep 30 &'", "docker run -d image", "ForEach-Object -Parallel {} -AsJob",
    "1 | ForEach-Object -Parallel { 1 } -As", "1 | % -Parallel { 1 } -Asj",
    "1 | ForEach-Object -Parallel { 1 } –AsJob", "1 | ForEach-Object -Parallel { 1 } —AsJo", "1 | ForEach-Object -Parallel { 1 } ―AsJob:$true",
    "Write-Output 'unterminated", "x ".repeat(2049), "x".repeat(128 * 1024 + 1),
    "[x]".repeat(1024) + "$",
    "${job}=Start-Job { 1 }", "[object]${space name}=Start-Job { 1 }", "${escaped`}}=Start-Job { 1 }",
    "Write-Output { 1 }; Start-Job {}", "if ((Write-Output { 1 })) {} Start-Job {}",
    "if ($true) { Write-Output { 1 } }; Start-Job {}", "Invoke-Item missing.exe", "ii missing.exe",
  ]) assert.ok(inspectPowerShellResourceLifecycle({ command }), command);
});

const USER_COMMANDS = [
  'tasklist /FI "PID eq 5064" /FO CSV 2>&1 | head -3; echo "---1352---"; tasklist /FI "PID eq 1352" /FO CSV 2>&1 | head -3',
  'echo "=== PID 1352 身份 ==="; wmic process where "ProcessId=1352" get Name,ExecutablePath 2>&1 | head -5; echo "--- 备用查询 ---"; powershell -NoProfile -Command "Get-Process -Id 1352 | Select-Object Id,ProcessName,Path | Format-List" 2>&1 | head -10',
  'cmd /c "wmic process where ProcessId=1352 get Name,ExecutablePath /format:list" 2>&1 | head -8',
  'echo "=== 模拟 Claude Code 连接，抓取源地址 ==="; curl -4 -v --max-time 15 -o /dev/null https://api.anthropic.com/ 2>&1 | grep -iE "Trying|Connected to|bound|from" | head -6',
] as const;

test("offline user command fixtures distinguish descriptor copies from launcher refusals", () => {
  const first = inspectHighRiskBashMutation({ command: USER_COMMANDS[0] }, process.cwd());
  assert.equal(first, undefined);
  assert.equal(inspectBashResourceLifecycle({ command: USER_COMMANDS[1] })?.startsWith("[SHELL_WRAPPER:LAUNCHER_UNSUPPORTED]"), true);
  const third = inspectHighRiskBashMutation({ command: USER_COMMANDS[2] }, process.cwd());
  assert.equal(third, undefined);
  const fourth = inspectHighRiskBashMutation({ command: USER_COMMANDS[3] }, process.cwd());
  assert.equal(fourth, undefined);
});

test("redirection evidence distinguishes syntax from quoted and heredoc data", () => {
  const syntax = inspectHighRiskBashMutation({ command: "tasklist 2>&1 | head" }, process.cwd());
  assert.equal(syntax, undefined);
  assert.equal(inspectHighRiskBashMutation({ command: "printf '%s' '2>&1'" }, process.cwd()), undefined);
  const boundedData = "cat <<'EOF'\n2>&1\nEOF";
  assert.equal(inspectHighRiskBashMutation({ command: boundedData }, process.cwd()), undefined);
  const inputScope = inspectBashPermissionScope({ command: boundedData }, process.cwd());
  assert.ok(inputScope); assert.ok(inputScope.primitives.includes("stdin_data:cat")); assert.equal(inputScope.unverifiableScope, true, "literal data still needs opaque-input authorization");
  const heredoc = inspectHighRiskBashMutation({ command: "cat -n <<'EOF'\n2>&1\nEOF" }, process.cwd());
  assert.ok(heredoc?.primitives.includes("heredoc_uninspectable"));
  assert.notEqual(heredoc?.diagnostic?.diagnostic.code, "FD_DUP_UNSUPPORTED");
  assert.equal(inspectBashPermissionScope({ command: "printf '%s' '2>&1'" }, process.cwd())?.unverifiableScope, false);
});

test("multiple causes retain parser order and do not let full-access bypass verification", () => {
  const scan = inspectHighRiskBashMutation({ command: "tasklist 2>&1 | head; rm -rf $TARGET" }, process.cwd());
  assert.ok(scan?.primitives.includes("rm_recursive"));
  assert.equal(scan?.unverifiableScope, true);
  assert.notEqual(scan?.diagnostic?.diagnostic.code, "FD_DUP_UNSUPPORTED");
});

test("unsupported descriptor syntax stays opaque after static copies", () => {
  const scan = inspectHighRiskBashMutation({ command: "echo x 2>&1 3>&$fd | head" }, process.cwd());
  assert.equal(scan?.unverifiableScope, true);
  assert.ok(scan?.primitives.includes("unverifiable_redirection"));
  assert.notEqual(scan?.diagnostic?.diagnostic.syntax, "2>&1");
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
  const unsafeFeedback = await dispatch(JSON.stringify({
    category: "POLICY_BLOCKED", policyReason: "user_rejected", stateChanged: false,
    rejectionReason: "password=\"correct horse battery staple\"\u0001", retryable: false,
  }));
  assert.equal((unsafeFeedback.details as any)?.rejectionReason, undefined);
  assert.doesNotMatch(JSON.stringify(unsafeFeedback.details), /correct horse battery staple/);
  const changed = await dispatch(JSON.stringify({ category: "POLICY_BLOCKED", policyReason: "user_rejected", stateChanged: true, primitives: ["opaque_shell_wrapper"] }));
  assert.match((changed.content[0] as any).text, /\"stateChanged\":true/);
  const finalDecision = await dispatch(JSON.stringify({
    category: "POLICY_BLOCKED", policyReason: "user_rejected", stateChanged: false,
    primitives: ["oversized_uninspectable"],
    diagnostic: { code: "INSPECTION_LIMIT", category: "POLICY_BLOCKED", retryable: false, action: "change_arguments" },
  }));
  assert.match((finalDecision.content[0] as any).text, /^\[POLICY_BLOCKED:USER_REJECTED\]/);
  assert.doesNotMatch((finalDecision.content[0] as any).text, /INSPECTION_LIMIT/);
});

test("rejection feedback is bounded and redacts URLs, credentials, and long paths", () => {
  const feedback = sanitizePolicyFeedback("拒绝 https://user:secret@example.invalid/path?q=private_token; token=abc123 authorization: Bearer SUPER_SECRET path=\"/synthetic/private/long/session/file.jsonl\" C:\\private\\long\\session\\file.jsonl");
  assert.ok(feedback);
  assert.doesNotMatch(feedback!, /user:secret|\?q=private_token|token=abc123|SUPER_SECRET|\/synthetic\/private|C:\\private/);
  assert.match(feedback!, /URL redacted|credential redacted|path redacted/);
  assert.ok(feedback!.length <= 240);
});

test("policy feedback redacts complete quoted multi-word credentials", () => {
  const feedback = sanitizePolicyFeedback('password="correct horse battery staple" token=FAKE_TOKEN path=/synthetic/private/long/session.jsonl');
  assert.ok(feedback);
  assert.doesNotMatch(feedback!, /correct horse battery staple|FAKE_TOKEN|private\/long/);
  assert.match(feedback!, /credential redacted/);
  assert.match(feedback!, /path redacted/);
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
  let catalogReads = 0;
  const configuredTools: any[] = [];
  runner.bindCore({ getThinkingLevel: () => "off", getActiveTools: () => activeTools, getAllTools: () => { catalogReads++; return configuredTools; } } as never, {
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
    assert.equal(catalogReads, 0);
    activeTools.push("tool_search");
    const unavailable = await agent.dispatchHostTool({ type: "toolCall", id: "wrapper-unavailable", name: "bash", arguments: { command: USER_COMMANDS[1] } });
    assert.doesNotMatch(JSON.stringify(unavailable.content), /Use tool_search/);
    configuredTools.push({ name: "powershell" });
    const discoverable = await agent.dispatchHostTool({ type: "toolCall", id: "wrapper-discoverable", name: "bash", arguments: { command: USER_COMMANDS[1] } });
    if (process.platform === "win32") {
      assert.match(JSON.stringify(discoverable.content), /Use tool_search.*powershell.*read its schema/);
      assert.match(JSON.stringify(discoverable.content), /describeTools.*callTool.*new script/);
    } else assert.doesNotMatch(JSON.stringify(discoverable.content), /Use tool_search|enabled native PowerShell/);
    const expectedCatalogReads = process.platform === "win32" ? 2 : 0;
    assert.equal(catalogReads, expectedCatalogReads);
    activeTools.push("powershell");
    const availableResult = await agent.dispatchHostTool({ type: "toolCall", id: "wrapper-available", name: "bash", arguments: { command: USER_COMMANDS[1] } });
    const availableText = availableResult.content.filter(c => c.type === "text").map(c => c.text).join("\n");
    if (process.platform === "win32") assert.match(availableText, /Use the enabled native PowerShell tool/);
    else assert.match(availableText, /directly inspectable foreground command/);
    assert.equal(catalogReads, expectedCatalogReads, "active or platform-unavailable native tools do not enumerate the catalog");
    assert.match(mutationText, /^\[POLICY_BLOCKED:CONFIRMATION_CANCELLED\] Not executed:/);
    const machineDetails = mutationResult.details as any;
    assert.equal(machineDetails.executionStatus, "not_executed");
    assert.equal(machineDetails.operation, "bash");
    assert.equal(machineDetails.permissionMode, "workspace-write");
    assert.equal(machineDetails.primitives?.includes("unverifiable_redirection"), false);
    assert.equal(machineDetails.opaqueScript, true);
    assert.equal(machineDetails.stateChanged, false);
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
    assert.match(results[0].content[0].text, /^\[POLICY_BLOCKED:CONFIRMATION_REQUIRED\]/);
    const secondMessages = JSON.stringify(wire[1].messages);
    assert.equal((wire[1].messages as any[]).filter(message => message.role === "tool").length, 1);
    assert.match(secondMessages, /POLICY_BLOCKED:CONFIRMATION_REQUIRED/);
    assert.doesNotMatch(secondMessages, /unverifiable_dynamic_scope/);
    assert.equal((secondMessages.match(/POLICY_BLOCKED:CONFIRMATION_REQUIRED/g) ?? []).length, 1);
  } finally {
    agent.abort(); runner.invalidate(); await runner.emit({ type: "session_shutdown" } as never);
  }
});

test("legacy structured refusal keeps a trusted inspection limit and sanitized feedback on the next provider wire", async () => {
  const model: any = { id: "offline", name: "offline", api: "openai-completions", provider: "fixture", baseUrl: "https://fixture.invalid/v1", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 64000, maxTokens: 128 };
  const wire: any[] = [];
  let requests = 0;
  const providerFetch = async (_url: string | URL, init?: RequestInit) => {
    const payload = JSON.parse(String(init?.body));
    wire.push(payload);
    requests++;
    const body = requests === 1
      ? `data: ${JSON.stringify({ choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: "legacy-call", type: "function", function: { name: "bash", arguments: JSON.stringify({ command: "echo fixture" }) } }] }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] })}\n\ndata: [DONE]\n\n`
      : `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "replanned" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`;
    return new Response(body, { headers: { "content-type": "text/event-stream" } });
  };
  const legacyReason = JSON.stringify({
    ok: false,
    category: "POLICY_BLOCKED",
    operation: "bash",
    permissionMode: "workspace-write",
    policyReason: "unverifiable_target",
    primitives: ["oversized_uninspectable"],
    diagnostic: { code: "INSPECTION_LIMIT", category: "POLICY_BLOCKED", retryable: false, action: "change_arguments" },
    rejectionReason: "用户备注 token=FAKE_TOKEN https://example.invalid/query?secret=FAKE C:\\synthetic\\private\\long\\session.jsonl",
    stateChanged: false,
    retryable: false,
  });
  const agent = new Agent({
    initialState: { model },
    convertToLlm,
    streamFn: (requestModel, context, options) => streamSimple(requestModel as any, context, { ...(options as any), apiKey: "offline", fetch: providerFetch }),
    beforeToolCall: async ({ toolCall }) => ({ block: true, reason: legacyReason } as any),
  });
  agent.state.tools = [{ name: "bash", label: "bash", description: "fixture", parameters: { type: "object", properties: {} }, execute: async () => { throw new Error("backend must not run"); } } as any];
  try {
    await agent.prompt("legacy wire fixture");
    assert.equal(requests, 2);
    const result = agent.state.messages.find(message => message.role === "toolResult") as any;
    const text = result.content[0].text as string;
    assert.match(text, /^\[POLICY_BLOCKED:INSPECTION_LIMIT\]/);
    assert.match(text, /analysis limit/);
    assert.doesNotMatch(text, /DYNAMIC_TARGET|FAKE_TOKEN|example\.invalid|private\\long/);
    const secondMessages = JSON.stringify(wire[1].messages);
    assert.match(secondMessages, /POLICY_BLOCKED:INSPECTION_LIMIT/);
    assert.doesNotMatch(secondMessages, /FAKE_TOKEN|example\.invalid|private\\long|DYNAMIC_TARGET/);
    assert.equal((wire[1].messages as any[]).filter(message => message.role === "tool").length, 1);
  } finally {
    agent.abort();
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

test("Bash default error preview keeps the first useful Node exception and exit status", () => {
  initTheme("dark");
  const component = new ToolExecutionComponent("bash", "node-failure", {}, { showImages: false }, undefined, { requestRender(): void {} } as never, process.cwd());
  component.markExecutionStarted();
  component.setArgsComplete();
  const output = [
    "Error: retrying",
    "file:///tmp/synthetic/fixture.mjs:1",
    "const = ;",
    "      ^",
    "",
    "SyntaxError: Unexpected token '='",
    "    at compileSourceTextModule (node:internal/modules/esm/utils:346:16)",
    ...Array.from({ length: 14 }, (_, index) => `    at frame${index} (file:///tmp/synthetic/fixture.mjs:${index + 5}:1)`),
    "Command exited with code 1",
    "[Node script recovery] preserve the first useful error and location; do not retry unchanged source.",
  ].join("\n");
  component.updateResult({ content: [{ type: "text", text: output }], isError: true }, false, true);
  const collapsed = component.render(120).join("\n").replaceAll(/\x1b\[[0-9;]*m/gu, "");
  assert.match(collapsed, /fixture\.mjs:1/);
  assert.match(collapsed, /SyntaxError: Unexpected token/);
  assert.match(collapsed, /const = ;/);
  assert.match(collapsed, /Command exited with code 1/);
  assert.doesNotMatch(collapsed, /Error: retrying/);
  assert.doesNotMatch(collapsed, /frame13/);
  component.setExpanded(true);
  const expanded = component.render(120).join("\n").replaceAll(/\x1b\[[0-9;]*m/gu, "");
  assert.match(expanded, /frame13/);
  assert.match(expanded, /\[Node script recovery\]/);
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
