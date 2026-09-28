import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createAgentSession } from "../packages/coding-agent/src/core/sdk.ts";
import { DefaultResourceLoader } from "../packages/coding-agent/src/core/resource-loader.ts";
import { SettingsManager } from "../packages/coding-agent/src/core/settings-manager.ts";
import { SessionManager } from "../packages/coding-agent/src/core/session-manager.ts";
import { getShellCwdBinding } from "../packages/coding-agent/src/core/tools/shell-cwd.ts";
import { collectStructuredMutationReceipts } from "../packages/extensions/mutation-guard-write/session-evidence.ts";
import { ALPHA_MODEL, alphaModelRuntime } from "./helpers/alpha-session.ts";

const bashPath = process.platform !== "win32" ? "/bin/bash" : existsSync("D:/Git/bin/bash.exe") ? "D:/Git/bin/bash.exe" : join(process.env.ProgramFiles!, "Git/bin/bash.exe");

test("A+B+C actual SDK Session: mixed tools, final handoffs, partial receipts and reopen", { timeout: 60000 }, async t => {
  const root = mkdtempSync(join(tmpdir(), "sp-abc-integration-"));
  const cwd = join(root, "workspace"), agentDir = join(root, "agent"); mkdirSync(cwd); mkdirSync(agentDir);
  const settingsManager = SettingsManager.inMemory({ shellPath: bashPath });
  let disagree = false;
  const auxiliary = (pi: any) => pi.on("tool_call", (event: any) => {
    if (disagree && (event.toolName === "bash" || event.toolName === "powershell")) return { finalAuthorization: {
      consume(args: any) { return { command: args.command, cwd: "different", timeout: args.timeout, purpose: args.purpose }; }, release() {},
    } };
  });
  const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager, noContextFiles: true, noSkills: true, noThemes: true, noPromptTemplates: true, additionalExtensionPaths: [resolve(import.meta.dirname, "../packages/extensions")], extensionFactories: [auxiliary] });
  await loader.reload();
  const manager = SessionManager.create(cwd, join(root, "sessions"));
  const options = { cwd, agentDir, settingsManager, resourceLoader: loader, sessionManager: manager, model: ALPHA_MODEL, modelRuntime: alphaModelRuntime(), noTools: "builtin" as const };
  let { session } = await createAgentSession(options);
  t.after(async () => { session.dispose(); await new Promise<void>(resolve => setImmediate(resolve)); rmSync(root, { recursive: true, force: true }); });
  let runner = session.extensionRunner;
  const expected = ["read", "edit", "write", "delete", "move", "file_batch", "bash", "powershell"];
  for (const name of expected) assert.equal(session.getAllTools().filter(tool => tool.name === name).length, 1, name);
  session.setActiveToolsByName(expected);
  let approvals = 0, decision = "仅允许本次", onApproval = () => {};
  await session.bindExtensions({ uiContext: { ...runner.getUIContext(), select: async () => { approvals++; onApproval(); return decision; } }, mode: "tui" });
  let afterAuthorization: (args: any) => void | Promise<void> = () => {};
  const originalBefore = session.agent.beforeToolCall!;
  session.agent.beforeToolCall = async (context, signal) => { const result = await originalBefore(context, signal); await afterAuthorization(context.args); return result; };
  let calls = 0;
  async function call(name: string, args: any) {
    await runner.emit({ type: "turn_start" } as never);
    const id = `mixed-${++calls}`;
    manager.appendMessage({ role: "assistant", content: [{ type: "toolCall", id, name, arguments: args }], timestamp: 0 } as never);
    const result = await session.agent.dispatchHostTool({ type: "toolCall", id, name, arguments: args });
    assert.equal(session.agent.state.pendingToolCalls.size, 0); assert.equal(session.agent.state.isStreaming, false);
    assert.equal(((runner as any).finalAuthorizations?.size ?? 0), 0);
    return result;
  }
  assert.equal((await call("write", { path: "sub/marker.txt", content: "sub-target\n" })).isError, false);
  assert.equal((await call("write", { path: "marker.txt", content: "session-target\n" })).isError, false);
  assert.equal((await call("read", { path: "marker.txt" })).isError, false);
  assert.equal((await call("edit", { path: "marker.txt", edits: [{ oldText: "session-target", newText: "session-edited" }] })).isError, false);
  assert.equal((await call("move", { path: "sub/marker.txt", destination: "sub/moved.txt" })).isError, false);
  const beforeDelete = approvals;
  assert.equal((await call("delete", { path: "sub/moved.txt" })).isError, false); assert.equal(approvals, beforeDelete + 1);
  const preview = await call("file_batch", { dryRun: true, operations: [{ operation: "write", mode: "create", path: "new/deep/a", content: "a" }] });
  assert.equal(preview.isError, false); assert.equal(existsSync(join(cwd, "new")), false);
  writeFileSync(join(cwd, "delete-me"), "old");
  assert.equal((await call("write", { path: "./@literal", content: "literal" })).isError, false);
  const beforeBatch = approvals;
  assert.equal((await call("file_batch", { operations: [{ operation: "delete", path: "delete-me" }, { operation: "delete", path: "@literal" }, { operation: "write", mode: "create", path: "@new/a", content: "a" }, { operation: "write", mode: "create", path: "new/b", content: "b" }] })).isError, false);
  assert.equal(approvals, beforeBatch + 1, "one necessary authorization for the whole batch");
  assert.equal(readFileSync(join(cwd, "new/a"), "utf8"), "a"); assert.equal(existsSync(join(cwd, "@new")), false); assert.equal(existsSync(join(cwd, "@literal")), false);
  const append = manager.appendCustomEntry.bind(manager);
  let failAfterFirst = true;
  t.mock.method(manager, "appendCustomEntry", function(kind: string, data: any) {
    const value = append(kind, data);
    if (failAfterFirst && kind === "file-mutation-progress-v2" && data.phase === "result") { failAfterFirst = false; writeFileSync(join(cwd, "current"), "concurrent"); }
    return value;
  });
  writeFileSync(join(cwd, "current"), "before");
  const partial = await call("file_batch", { operations: [{ operation: "write", mode: "create", path: "first", content: "first" }, { operation: "delete", path: "current" }, { operation: "write", mode: "create", path: "last", content: "last" }] });
  assert.deepEqual((partial.details as any).items.map((item: any) => item.status), ["succeeded", "failed_no_change", "not_started"]);
  assert.equal(existsSync(join(cwd, "last")), false);
  const shellNames = process.platform === "win32" ? ["bash", "powershell"] : ["bash"];
  writeFileSync(join(cwd, "sub/marker.txt"), "sub-target");
  for (const name of shellNames) {
    const command = name === "bash" ? "cat marker.txt" : "Get-Content -LiteralPath marker.txt";
    let binding: ReturnType<typeof getShellCwdBinding>;
    afterAuthorization = args => { binding = getShellCwdBinding(args); };
    const explicit = await call(name, { command, cwd: "sub" }); assert.equal(explicit.isError, false, JSON.stringify(explicit));
    assert.equal((explicit.details as any).cwd, realpathSync.native(join(cwd, "sub"))); assert.equal(binding!.isReleased, true);
    assert.ok(explicit.content.some(item => item.type === "text" && item.text.includes("sub-target")));
    const omitted = await call(name, { command }); assert.equal(omitted.isError, false, JSON.stringify(omitted));
    assert.ok(omitted.content.some(item => item.type === "text" && item.text.includes("session-edited")));
    assert.equal(runner.createContext().cwd, cwd);
    const mutating = name === "bash" ? "printf forbidden > forbidden" : "Set-Content -LiteralPath forbidden -Value forbidden";
    for (const failure of ["deny", "cancel", "permission", "drift", "handoff"]) {
      const outside = join(root, `${name}-${failure}`); mkdirSync(outside);
      decision = failure === "deny" ? "拒绝" : "仅允许本次";
      onApproval = () => { if (failure === "drift") { renameSync(outside, outside + "-old"); mkdirSync(outside); } };
      afterAuthorization = async args => { binding = getShellCwdBinding(args); if (failure === "cancel") session.agent.abort(); if (failure === "permission") await runner.getCommand("permissions")!.handler("read-only", runner.createContext() as never); };
      disagree = failure === "handoff";
      const result = await call(name, { command: mutating, cwd: outside });
      assert.equal(result.isError, true, `${name}/${failure}: ${JSON.stringify(result)}`);
      assert.equal(existsSync(join(outside, "forbidden")), false); assert.equal(binding?.isReleased, true, `${name}/${failure} binding`);
      if (failure === "permission") await runner.getCommand("permissions")!.handler("workspace-write", runner.createContext() as never);
      if (failure === "drift") assert.ok(JSON.stringify(result).includes("SHELL_CWD_CHANGED"));
      if (failure === "handoff") assert.ok(JSON.stringify(result).includes("snapshots disagree"));
      disagree = false; decision = "仅允许本次"; onApproval = () => {}; afterAuthorization = () => {};
    }
  }
  // Reacquire all paths of the failed batch after mixed shell faults. A leaked
  // mutation queue would prevent this real invocation from completing.
  assert.equal((await call("file_batch", { dryRun: true, operations: [
    { operation: "delete", path: "first" }, { operation: "delete", path: "current" },
    { operation: "write", mode: "create", path: "last", content: "not applied" },
  ] })).isError, false);
  const beforeReceipts = collectStructuredMutationReceipts(manager.getBranch());
  assert.equal(beforeReceipts.filter((item: any) => item.toolCallId === partial.toolCallId && item.status === "succeeded").length, 1);
  const file = manager.getSessionFile()!; assert.ok(file);
  session.dispose(); const reopened = SessionManager.open(file);
  ({ session } = await createAgentSession({ ...options, sessionManager: reopened })); runner = session.extensionRunner; await session.bindExtensions({});
  const receipts = collectStructuredMutationReceipts(reopened.getBranch());
  assert.deepEqual(receipts, beforeReceipts);
  assert.equal(readFileSync(join(cwd, "first"), "utf8"), "first"); assert.equal(readFileSync(join(cwd, "current"), "utf8"), "concurrent"); assert.equal(existsSync(join(cwd, "last")), false);
  assert.equal(session.agent.state.pendingToolCalls.size, 0); assert.equal(((runner as any).finalAuthorizations?.size ?? 0), 0);
  t.diagnostic(JSON.stringify({ mixedCalls: calls, approvals, receipts: receipts.length, pendingTools: 0, finalAuthorizations: 0, shellBackends: shellNames, reopened: true }));
});
