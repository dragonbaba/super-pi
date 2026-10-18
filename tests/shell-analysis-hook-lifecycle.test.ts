import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
import { createEventBus } from "../packages/coding-agent/src/core/event-bus.ts";
import { createExtensionRuntime, ExtensionRunner, loadExtensionFromFactory } from "../packages/coding-agent/src/core/extensions/index.ts";
import { SessionManager } from "../packages/coding-agent/src/core/session-manager.ts";
import { getShellCwdBinding } from "../packages/coding-agent/src/core/tools/shell-cwd.ts";
import { workspace } from "./codemode-recovery/guard-fixture.ts";

const jiti = createJiti(import.meta.url);
const { default: guard } = await jiti.import<typeof import("../packages/extensions/resource-lifecycle-guard/index.ts")>("../packages/extensions/resource-lifecycle-guard/index.ts");
const { shellAnalysisOwnership } = await jiti.import<typeof import("../packages/extensions/resource-lifecycle-guard/shell-analysis.ts")>("../packages/extensions/resource-lifecycle-guard/shell-analysis.ts");

for (const lifecycle of ["complete", "denied", "cancel", "throw", "command-change", "generation-change", "lifecycle-block"] as const) {
  test(`real hook releases analysis before returning final authority: ${lifecycle}`, async t => {
    const cwd = workspace(t), runtime = createExtensionRuntime(), manager = SessionManager.inMemory(cwd);
    const runner = new ExtensionRunner([await loadExtensionFromFactory(guard, cwd, createEventBus(), runtime)], runtime, cwd, manager, {} as never);
    const cancellation = new AbortController();
    const input = { command: lifecycle === "lifecycle-block" ? "npm run dev &" : "python -c 'print(1)'", cwd, timeout: 60 };
    runner.bindCore({ getThinkingLevel: () => "off", getActiveTools: () => ["bash", "tasks"], getAllTools: () => [{ name: "bash", supportsManagedBackground: true }, ...runner.getAllRegisteredTools().map(tool => tool.definition)],
      appendEntry: (kind: string, data: unknown) => manager.appendCustomEntry(kind, data) } as never,
    { getSignal: () => cancellation.signal, isProjectTrusted: () => false, getModel: () => undefined,
      isIdle: () => true, abort: () => cancellation.abort(), hasPendingMessages: () => false } as never);
    let approvals = 0;
    runner.setUIContext({ ...runner.getUIContext(), select: async () => {
      approvals++;
      assert.equal(shellAnalysisOwnership.liveOwners, 1, "one hook owns analysis while approval is pending");
      if (lifecycle === "throw") throw new Error("fixture approval error");
      if (lifecycle === "cancel") cancellation.abort();
      if (lifecycle === "command-change") input.command = "printf changed";
      if (lifecycle === "generation-change") await runner.emit({ type: "session_tree", reason: "branch" } as never);
      return lifecycle === "denied" ? "拒绝" : "仅允许本次";
    } }, "tui");
    await runner.emit({ type: "session_start", reason: "startup" });
    const before = shellAnalysisOwnership.created;
    try {
      let outcome: Awaited<ReturnType<typeof runner.emitToolCall>>;
      try { outcome = await runner.emitToolCall({ type: "tool_call", toolName: "bash", toolCallId: lifecycle, input }); }
      catch (error) { assert.ok(["throw", "cancel", "generation-change"].includes(lifecycle), String(error)); }
      assert.equal(shellAnalysisOwnership.created, before + 1);
      assert.equal(shellAnalysisOwnership.liveOwners, 0);
      assert.equal(shellAnalysisOwnership.liveEntries, 0);
      assert.equal(shellAnalysisOwnership.liveBytes, 0);
      assert.equal(approvals, lifecycle === "lifecycle-block" ? 0 : 1);
      if (lifecycle === "complete") {
        assert.ok(outcome?.finalAuthorization);
        const approved = outcome.finalAuthorization.consume(input, lifecycle, "bash");
        getShellCwdBinding(approved)?.release();
        outcome.finalAuthorization.release();
      } else assert.equal(outcome?.finalAuthorization, undefined);
    } finally { cancellation.abort(); await runner.emit({ type: "session_shutdown", reason: "quit" }); runner.invalidate(); }
  });
}
