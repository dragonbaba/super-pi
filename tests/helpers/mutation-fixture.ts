import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type test from "node:test";
import { createJiti } from "jiti";
import { Agent } from "../../packages/agent/src/agent.ts";
import { createEventBus } from "../../packages/coding-agent/src/core/event-bus.ts";
import { createExtensionRuntime, ExtensionRunner, loadExtensionFromFactory } from "../../packages/coding-agent/src/core/extensions/index.ts";
import { wrapToolDefinition } from "../../packages/coding-agent/src/core/tools/tool-definition-wrapper.ts";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.ts";
import { convertToLlm } from "../../packages/coding-agent/src/core/messages.ts";
const jiti = createJiti(import.meta.url);
const { default: mutation } = await jiti.import<any>("../../packages/extensions/mutation-guard-write/index.ts");
const { default: lifecycle } = await jiti.import<any>("../../packages/extensions/resource-lifecycle-guard/index.ts");
const { default: loop } = await jiti.import<any>("../../packages/extensions/tool-loop-guardrails/index.ts");
export const { MutationWriteGuard } = await jiti.import<any>("../../packages/extensions/mutation-guard-write/core.ts");

export async function mutationFixture(t: test.TestContext) {
  const cwd = mkdtempSync(join(tmpdir(), "sp-file-batch-"));
  const session = SessionManager.create(cwd, join(cwd, "sessions"));
  const runtime = createExtensionRuntime();
  const extensions = [];
  for (const factory of [mutation, lifecycle, loop]) extensions.push(await loadExtensionFromFactory(factory, cwd, createEventBus(), runtime));
  const runner = new ExtensionRunner(extensions, runtime, cwd, session, {} as never);
  let advanceTurn = true;
  let approvals = 0, decision = "仅允许本次";
  let approvalHook = () => {};
  let recordHook = (_data: any) => {};
  const agent = new Agent({ convertToLlm, streamFn: () => { throw new Error("No live model"); },
    beforeToolCall: async ({ toolCall, args }) => { if (advanceTurn) await runner.emit({ type: "turn_start" } as never); return runner.emitToolCall({ type: "tool_call", toolName: toolCall.name, toolCallId: toolCall.id, input: args } as never); },
    afterToolCall: ({ toolCall, args, result, isError }) => runner.emitToolResult({ type: "tool_result", toolName: toolCall.name, toolCallId: toolCall.id, input: args, content: result.content, details: result.details, isError } as never),
  });
  runner.bindCore({ getThinkingLevel: () => "off", getActiveTools: () => agent.state.tools.map(t => t.name),
    appendEntry: (kind: string, data: any) => { if (kind === "file-mutation-progress-v2") recordHook(data); session.appendCustomEntry(kind, data); },
  } as never, { getSignal: () => agent.signal, isProjectTrusted: () => false, getModel: () => agent.state.model, isIdle: () => true, abort: () => agent.abort(), hasPendingMessages: () => false } as never);
  runner.setUIContext({ ...runner.getUIContext(), select: async () => { approvals++; approvalHook(); return decision; } }, "tui");
  await runner.emit({ type: "session_start" } as never);
  agent.state.tools = runner.getAllRegisteredTools().map(r => wrapToolDefinition(r.definition, () => runner.createContext()));
  t.after(async () => { agent.abort(); runner.invalidate(); await runner.emit({ type: "session_shutdown" } as never); rmSync(cwd, { recursive: true, force: true }); });
  return { cwd, session, runner, agent, async freezeTurn() { advanceTurn = false; await runner.emit({ type: "turn_start" } as never); }, approvals: () => approvals, deny() { decision = "拒绝"; }, onApprove(fn: () => void) { approvalHook = fn; }, onRecord(fn: (data: any) => void) { recordHook = fn; },
    async call(name: string, input: any, id = name) {
      session.appendMessage({ role: "assistant", content: [{ type: "toolCall", id, name, arguments: input }], timestamp: 0 } as never);
      const result = await agent.dispatchHostTool({ type: "toolCall", id, name, arguments: input });
      session.appendMessage(result);
      return result;
    } };
}
