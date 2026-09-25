import { recentMutationEntries } from "../mutation-guard-write/session-evidence.ts";
import type { ExtensionAPI, ToolResultEvent } from "@super-pi/coding-agent";
import {
  beginPromptBoundary,
  completionIntervention,
  createFalseSuccessLifecycleState,
  createFalseSuccessState,
  FALSE_SUCCESS_AUDIT_TYPE,
  goalCompletionIntervention,
  observeInputBoundary,
  observeToolResult,
  resetFalseSuccessState,
  type InterventionAudit,
} from "./core.js";

const TEXT_TYPE = "text" as const;
const GOAL_COMPLETE_TOOL = "goal_complete";

export default function falseSuccessGuard(pi: ExtensionAPI): void {
  const state = createFalseSuccessState();
  const lifecycle = createFalseSuccessLifecycleState();
  // Invocation-owned references, including authorization vetoes that have no tool_result hook.
  const pendingMutations = new Map<string, { name: string; input: Record<string, unknown> }>();

  const reset = (): void => {
    lifecycle.pendingExplicitBoundary = false;
    resetFalseSuccessState(state);
    pendingMutations.clear();
  };
  const appendAudit = (audit: InterventionAudit): void => {
    try {
      pi.appendEntry(FALSE_SUCCESS_AUDIT_TYPE, audit);
    } catch {
      // A persistence failure must not disable the safety intervention itself.
    }
  };

  pi.on("session_start", reset);
  pi.on("session_tree", reset);
  pi.on("session_shutdown", reset);

  pi.on("input", (event) => {
    observeInputBoundary(lifecycle, event);
  });

  pi.on("before_agent_start", (event) => {
    beginPromptBoundary(state, lifecycle, event.prompt);
  });

  pi.on("tool_call", (event, ctx) => {
    if (isNativeOrBatch(event.toolName)) {
      const pending = pendingMutations.get(event.toolCallId);
      if (pending) pending.input = event.input;
      return;
    }
    if (event.toolName !== GOAL_COMPLETE_TOOL) return undefined;
    const intervention = goalCompletionIntervention(state, modelName(ctx.model));
    if (!intervention) return undefined;
    appendAudit(intervention.audit);
    return { block: true, reason: intervention.reason };
  });

  pi.on("tool_execution_start", (event, ctx) => {
    if (!isNativeOrBatch(event.toolName)) return;
    if (pendingMutations.size >= 128) {
      observeToolResult(state, { toolName: "file_batch", input: {}, isError: true, cwd: ctx.cwd });
      return;
    }
    pendingMutations.set(event.toolCallId, { name: event.toolName, input: event.args });
  });
  pi.on("tool_execution_end", (event, ctx) => {
    const pending = pendingMutations.get(event.toolCallId);
    pendingMutations.delete(event.toolCallId);
    if (!pending || pending.name !== event.toolName) return;
    observeToolResult(state, { toolName: pending.name, toolCallId: event.toolCallId, input: pending.input,
      isError: event.isError, details: event.result.details, cwd: ctx.cwd, branch: recentMutationEntries(ctx.sessionManager) });
  });

  pi.on("tool_result", (event: ToolResultEvent, ctx) => {
    if (isNativeOrBatch(event.toolName)) {
      const pending = pendingMutations.get(event.toolCallId);
      if (pending) pending.input = event.input;
      return;
    }
    observeToolResult(state, {
      toolName: event.toolName,
      toolCallId: event.toolCallId,
      input: event.input,
      isError: event.isError,
      text: event.isError ? collectText(event.content, 8_192) : undefined,
      details: event.details,
      cwd: ctx.cwd,
    });
    return undefined;
  });

  pi.on("message_end", (event) => {
    if (event.message.role !== "assistant") return undefined;
    if (event.message.stopReason === "error" || event.message.stopReason === "toolUse") return undefined;
    if (hasToolCall(event.message.content)) return undefined;
    const intervention = completionIntervention(
      state,
      collectText(event.message.content, 1_000_000),
      modelName({ provider: event.message.provider, id: event.message.model }),
    );
    if (!intervention) return undefined;
    appendAudit(intervention.audit);
    return {
      message: {
        ...event.message,
        content: [{ type: TEXT_TYPE, text: intervention.replacement }],
      },
    };
  });
}

function isNativeOrBatch(name: string): boolean { return name === "file_batch" || name === "delete" || name === "move"; }

function collectText(
  content: ReadonlyArray<{ type: string; text?: string }>,
  maxChars: number,
): string {
  let text = "";
  for (const item of content) {
    if (item.type !== "text" || typeof item.text !== "string") continue;
    const separator = text ? "\n" : "";
    const remaining = maxChars - text.length;
    if (remaining <= separator.length) break;
    text += separator;
    text += item.text.slice(0, remaining - separator.length);
    if (text.length >= maxChars) break;
  }
  return text;
}

function hasToolCall(content: ReadonlyArray<{ type: string }>): boolean {
  for (const item of content) {
    if (item.type === "toolCall") return true;
  }
  return false;
}

function modelName(model: { provider?: unknown; id?: unknown } | undefined): string {
  if (!model) return "unknown";
  const provider = typeof model.provider === "string" ? model.provider : "unknown";
  const id = typeof model.id === "string" ? model.id : "unknown";
  return `${provider}/${id}`;
}
