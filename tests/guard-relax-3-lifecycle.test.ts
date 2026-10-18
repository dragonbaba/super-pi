import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync } from "node:fs";
import { createBashToolDefinition, createLocalBashOperations } from "../packages/coding-agent/src/core/tools/bash.ts";
import { wrapToolDefinition, createToolDefinitionFromAgentTool } from "../packages/coding-agent/src/core/tools/tool-definition-wrapper.ts";
import { shellHookFixture, assertFinalAuthorization } from "./codemode-recovery/shell-hook-fixture.ts";
import { consumeBackgroundShellLaunch, consumeForegroundShellLaunch } from "../packages/coding-agent/src/core/tools/shell-background.ts";
import { getShellCwdBinding } from "../packages/coding-agent/src/core/tools/shell-cwd.ts";

test("PR3 representative lifecycle availability and managed handoff acceptance", async t => {
  type Result = "allow" | "ask" | "deny" | "confirmation_required" | "managed";
  type Row = readonly [string, "tui" | "rpc" | "print" | "json", boolean | "history-error" | "unsupported-backend" | "replacement-tool" | "changed-backend" | "restored-tasks", Result, Result, ("bash" | "powershell")?];
  const rows: readonly Row[] = [
    ["npm test", "tui", true, "allow", "ask"],
    ...["docker run -d nginx", "docker compose up -d", "systemctl restart nginx", "systemctl start nginx", "service nginx start", "pm2 start server.js"]
      .map(command => [command, "tui", true, "allow", "ask"] as const),
    ["systemctl restart nginx", "tui", true, "allow", "ask", "powershell"],
    ["Start-Service nginx", "tui", true, "allow", "ask", "powershell"],
    ["Set-Service nginx -Status Running", "tui", true, "allow", "ask", "powershell"],
    ["npm run dev &", "tui", true, "deny", "deny"],
    ["nohup node s.js > log 2>&1 &", "tui", true, "deny", "deny"],
    ["setsid node s.js", "tui", true, "deny", "deny"], ["disown", "rpc", true, "deny", "deny"],
    ["Start-Process node.exe", "tui", true, "deny", "deny", "powershell"],
    ["npm run dev &", "print", true, "allow", "confirmation_required"],
    ["nohup node s.js > log 2>&1 &", "json", true, "allow", "confirmation_required"],
    ["npm run dev &", "print", false, "allow", "confirmation_required"],
    ["nohup node s.js > log 2>&1 &", "print", false, "allow", "confirmation_required"],
    ["Start-Process node.exe", "print", false, "allow", "confirmation_required", "powershell"],
    ["npm run dev &", "tui", false, "allow", "ask"],
    ["npm run dev &", "tui", "history-error", "allow", "ask"],
    ["npm run dev &", "tui", "unsupported-backend", "allow", "ask"],
    ["npm run dev &", "tui", "replacement-tool", "allow", "ask"],
    ["npm run dev &", "tui", "changed-backend", "allow", "ask"],
    ["nohup node s.js &", "tui", "restored-tasks", "allow", "ask"],
    ["npm run dev", "tui", true, "managed", "managed"],
    ["rm -rf .", "print", false, "deny", "deny"],
    ['pwsh -Command "Write-Output 1"', "print", false, "deny", "deny"],
  ];
  for (const [command, surface, tasks, full, workspace, toolName = "bash"] of rows) for (const mode of ["full-access", "workspace-write"] as const) {
    const changedOps = tasks === "changed-backend" ? createLocalBashOperations() : undefined;
    const backend = tasks === "unsupported-backend" ? createBashToolDefinition(process.cwd(), { commandPrefix: "echo setup" }) : changedOps ? createToolDefinitionFromAgentTool(wrapToolDefinition(createBashToolDefinition(process.cwd(), { operations: changedOps }))) : undefined;
    if (changedOps) changedOps.exec = async () => { throw new Error("Fixture never executes the replacement backend"); };
    const f = await shellHookFixture(t, mode, undefined, tasks !== false && tasks !== "restored-tasks", backend ?? (tasks === "replacement-tool" ? {} : undefined)), expected = mode === "full-access" ? full : workspace;
    if (tasks === "history-error") {
      const file = `${f.cwd}/history`; mkdirSync(`${file}.tasks-shell-v1.sqlite`);
      t.mock.method(f.runner.createContext().sessionManager, "getSessionFile", () => file);
      await assert.rejects(f.runner.emitToolCall({ type: "tool_call", toolName, toolCallId: "unavailable", input: { command: "npm run dev", cwd: f.cwd, background: true } }), /Task history unavailable/);
    }
    f.runner.setUIContext(surface === "tui" || surface === "rpc" ? f.runner.getUIContext() : undefined, surface);
    const input = { command, cwd: backend || tasks === "replacement-tool" ? undefined : f.cwd, timeout: 60, ...(expected === "managed" ? { background: true } : {}) }, id = "acceptance";
    if (backend) assert.throws(() => backend.prepareArguments!({ ...input, cwd: f.cwd, background: true }), /SHELL_BACKGROUND_UNSUPPORTED/);
    const outcome = await f.runner.emitToolCall({ type: "tool_call", toolName, toolCallId: id, input });
    if (tasks === "restored-tasks") f.setManagedTasks(true);
    const label = `${mode}/${surface}/tasks=${tasks}: ${command}`;
    if (expected === "deny" || expected === "confirmation_required") {
      assert.equal(outcome?.block, true, label); assert.equal(outcome?.finalAuthorization, undefined);
      if (expected === "confirmation_required") assert.match(outcome!.reason!, /confirmation_required/);
      else if (tasks) { assert.doesNotMatch(outcome!.reason!, /[\r\n]/); assert.match(outcome!.reason!, /remove '&'.*background: true.*explicit cwd/); }
    } else if (expected === "managed") {
      assert.notEqual(outcome?.block, true, outcome?.reason); assert.ok(outcome?.finalAuthorization);
      const approved = outcome.finalAuthorization.consume(input, id, toolName) as object;
      const binding = getShellCwdBinding(approved)!; let executions = 0, release!: () => void;
      const released = new Promise<void>(resolve => { release = resolve; });
      const accepted = consumeBackgroundShellLaunch(approved)(async () => {
        binding.beforeSpawn(binding.canonical); executions++; return { content: [{ type: "text", text: "controlled completion" }], details: undefined };
      }, undefined, () => { binding.release(); release(); });
      await released; outcome.finalAuthorization.release();
      assert.ok(accepted.details?.backgroundTask?.id); assert.equal(executions, 1); assert.equal(binding.isReleased, true);
    } else if (backend || tasks === "replacement-tool" || tasks === "restored-tasks") {
      assert.notEqual(outcome?.block, true, outcome?.reason); assert.ok(outcome?.finalAuthorization);
      const approved = outcome.finalAuthorization.consume(input, id, toolName) as object;
      assert.deepEqual(approved, { ...input, purpose: undefined, background: undefined });
      try { if (tasks === "restored-tasks") assert.equal(consumeForegroundShellLaunch(approved), undefined, "raw launches cannot gain foreground handoff after approval"); }
      finally { getShellCwdBinding(approved)?.release(); outcome.finalAuthorization.release(); }
    } else assertFinalAuthorization({ outcome, input: input as typeof input & { cwd: string }, id, toolName });
    assert.equal(f.dialogs(), expected === "ask" || (expected === "managed" && mode === "workspace-write") ? 1 : 0, label);
    if (command === "npm test") assert.ok(f.catalogReads() <= 1, `${label}: authorization and consume read the catalog at most once (got ${f.catalogReads()})`);
  }
});
