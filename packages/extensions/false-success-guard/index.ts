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

  const reset = (): void => {
    lifecycle.pendingExplicitBoundary = false;
    resetFalseSuccessState(state);
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

  pi.on("input", (event) => {
    observeInputBoundary(lifecycle, event);
  });

  pi.on("before_agent_start", (event) => {
    beginPromptBoundary(state, lifecycle, event.prompt);
  });

  pi.on("tool_call", (event, ctx) => {
    if (event.toolName !== GOAL_COMPLETE_TOOL) return undefined;
    const intervention = goalCompletionIntervention(state, modelName(ctx.model));
    if (!intervention) return undefined;
    appendAudit(intervention.audit);
    return { block: true, reason: intervention.reason };
  });

  pi.on("tool_result", (event: ToolResultEvent, ctx) => {
    observeToolResult(state, {
      toolName: event.toolName,
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
