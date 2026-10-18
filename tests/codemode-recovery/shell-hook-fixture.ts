import assert from "node:assert/strict";
import type { TestContext } from "node:test";
import { createJiti } from "jiti";
import { createEventBus } from "../../packages/coding-agent/src/core/event-bus.ts";
import { createExtensionRuntime, ExtensionRunner, loadExtensionFromFactory } from "../../packages/coding-agent/src/core/extensions/index.ts";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.ts";
import { getShellCwdBinding } from "../../packages/coding-agent/src/core/tools/shell-cwd.ts";
import { workspace } from "./guard-fixture.ts";

const jiti = createJiti(import.meta.url);
const { default: lifecycle } = await jiti.import<typeof import("../../packages/extensions/resource-lifecycle-guard/index.ts")>("../../packages/extensions/resource-lifecycle-guard/index.ts");

export async function shellHookFixture(t: TestContext, mode: "full-access" | "workspace-write",
  nativePowerShell: "active" | "discoverable" | "unavailable" = process.platform === "win32" ? "active" : "unavailable", managedTasks = false, bashParameters?: object) {
  const cwd = workspace(t), runtime = createExtensionRuntime(), manager = SessionManager.inMemory(cwd);
  const runner = new ExtensionRunner(
    [await loadExtensionFromFactory(lifecycle, cwd, createEventBus(), runtime)], runtime, cwd, manager, {} as never,
  );
  const controller = new AbortController();
  let dialogs = 0, sequence = 0, catalogReads = 0;
  // Only metadata is exposed: this fixture has no shell tool implementation or provider.
  runner.bindCore({ getThinkingLevel: () => "off",
    getActiveTools: () => ["bash", ...(managedTasks ? ["tasks"] : []), ...(nativePowerShell === "active" ? ["powershell"] : nativePowerShell === "discoverable" ? ["tool_search"] : [])],
    getAllTools: () => { catalogReads++; return [{ name: "bash", parameters: bashParameters }, { name: "powershell", available: nativePowerShell !== "unavailable" }, ...runner.getAllRegisteredTools().map(tool => tool.definition)]; },
    appendEntry: (kind: string, data: unknown) => { manager.appendCustomEntry(kind, data); },
  } as never, {
    getSignal: () => controller.signal, isProjectTrusted: () => false, getModel: () => undefined,
    isIdle: () => true, abort: () => controller.abort(), hasPendingMessages: () => false,
  } as never);
  runner.setUIContext({ ...runner.getUIContext(), select: async (_title, choices) => {
    dialogs++; assert.ok(choices.includes("仅允许本次")); return "仅允许本次";
  } }, "tui");
  t.after(async () => {
    controller.abort();
    try { await runner.emit({ type: "session_shutdown", reason: "quit" }); } finally { runner.invalidate(); }
  });
  await runner.emit({ type: "session_start", reason: "startup" });
  const permissions = runner.getCommand("permissions")!;
  await permissions.handler(mode, runner.createCommandContext());
  await permissions.handler(mode === "full-access" ? "never-ask" : "ask", runner.createCommandContext());
  return { runner, cwd, dialogs: () => dialogs, catalogReads: () => catalogReads,
    async authorize(command: string, toolName: "bash" | "powershell" = "bash", executionCwd = cwd) {
      const input = { command, cwd: executionCwd, timeout: 60 }, id = `hook-${++sequence}`;
      const outcome = await runner.emitToolCall({ type: "tool_call", toolName, toolCallId: id, input });
      return { outcome, input, id, toolName };
    },
  };
}

export function assertFinalAuthorization(call: Awaited<ReturnType<Awaited<ReturnType<typeof shellHookFixture>>["authorize"]>>) {
  const { outcome, input, id, toolName } = call;
  assert.notEqual(outcome?.block, true, outcome?.reason);
  assert.ok(outcome?.finalAuthorization, "the complete hook must return finalAuthorization");
  let approved: unknown;
  try {
    approved = outcome.finalAuthorization.consume(input, id, toolName);
    assert.deepEqual(approved, { ...input, purpose: undefined, background: undefined });
    const binding = getShellCwdBinding(approved);
    assert.ok(binding, "cwd must be prepared and transferred through final authorization");
    binding.beforeSpawn(binding.canonical); // Validate the handoff, without spawning anything.
  } finally {
    getShellCwdBinding(approved)?.release();
    outcome.finalAuthorization.release();
  }
}
