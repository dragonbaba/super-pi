import { SessionFiles } from "../../packages/coding-agent/src/core/files/session-files.ts";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.ts";
import { createEventBus } from "../../packages/coding-agent/src/core/event-bus.ts";
import { createExtensionRuntime } from "../../packages/coding-agent/src/core/extensions/loader.ts";
import { SessionExecutionPolicy } from "../../packages/coding-agent/src/core/execution-policy.ts";
import type { ToolDefinition } from "../../packages/coding-agent/src/core/extensions/types.ts";
import type { SessionPermissionMode } from "../../packages/coding-agent/src/core/permission-mode.ts";

/** Real session/authorization/journal owner, usable with either the controlled
 * worker fixture or the actual MXC process transport. */
export function sandboxFileSession(cwd: string, mode: "read-only" | "sandbox-write", directories: string[] = []) {
  return fileSession(cwd, "sandbox", mode, directories);
}
export function nativeFileSession(cwd: string) { return fileSession(cwd, "trusted-host", "host-write", []); }
function fileSession(cwd: string, environment: "sandbox" | "trusted-host", mode: SessionPermissionMode, directories: string[]) {
  const runtime = createExtensionRuntime(), manager = SessionManager.inMemory(cwd);
  runtime.appendEntry = (type, data) => { manager.appendCustomEntry(type, data); };
  runtime.appendFileEntry = (type, data) => manager.appendCustomEntry(type, data);
  const policy = runtime.nativePermissions = new SessionExecutionPolicy(runtime, environment, {}, mode, directories);
  const files = runtime.nativeFiles = new SessionFiles(runtime, createEventBus()); files.setCompatibilityBoundary(policy);
  const ctx: any = { cwd, hasUI: false, signal: runtime.executionBoundary.signal, sessionManager: manager };
  let sequence = 0;
  async function invoke(definitions: Record<string, ToolDefinition>, name: string, input: any) {
    const id = "sandbox-call-" + ++sequence, event: any = { type: "tool_call", toolName: name, toolCallId: id, input };
    manager.appendMessage({ role: "assistant", content: [{ type: "toolCall", id, name, arguments: input }], timestamp: 0 } as any);
    let invocation: Awaited<ReturnType<SessionFiles["prepareInvocation"]>>;
    try {
      const grant = await policy.authorize(event, ctx, definitions[name], false, async paths => {
        invocation = await files.prepareInvocation(event, ctx, paths); return invocation?.describePreflight;
      });
      try {
        grant.consume(input, id, name);
        const approved = invocation ? invocation.consume(input, id, name) : input;
        return await definitions[name]!.execute(id, approved as any, ctx.signal, undefined, ctx) as any;
      } finally { grant.release(); }
    } finally { invocation?.release(); }
  }
  async function close() { policy.dispose(); await runtime.executionBoundary.dispose(); await files.dispose(); }
  return { runtime, policy, files, manager, ctx, invoke, close };
}
