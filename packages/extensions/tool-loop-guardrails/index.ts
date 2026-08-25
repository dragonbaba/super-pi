import process from "node:process";
import { isAbsolute, relative, resolve } from "node:path";
import {
  createReadToolDefinition,
  type ExtensionAPI,
  type ReadToolInput,
  type ToolResultEvent,
} from "@super-pi/coding-agent";
import { Type, type Static } from "typebox";
import {
  attachRepairKind,
  callKey,
  createGuardState,
  failureRecoveryHint,
  inspectBatchCall,
  inspectBeforeCall,
  observeRepeatedCall,
  prepareDeterministicCall,
  recordResult,
  repairReadOffsetFromError,
  resetBatchState,
  resetGuardState,
} from "./core.js";
import { createConfiguredMsysBashDefinition } from "./msys-bash.js";
import { issueSnapshotForRead } from "../mutation-guard-write/snapshot-line-edit.ts";

const GUARDRAIL_CONTENT_TYPE = "text" as const;
const MAX_PENDING_REPAIR_NOTES = 64;
const MAX_FAILURE_TEXT_CHARS = 8_192;
const LOOP_REMINDER_CUSTOM_TYPE = "tool-loop-reminder-v1";
const FAILURE_ADVISORY_CUSTOM_TYPE = "tool-failure-advisory-v1";
const ScopedBashParameters = Type.Object({
  command: Type.String({ description: "Bash command to execute" }),
  cwd: Type.Optional(Type.String({ description: "Working directory; defaults to the current Pi workspace", maxLength: 4096 })),
  timeout: Type.Optional(Type.Number({ description: "Timeout in seconds (optional, no default timeout)" })),
  purpose: Type.Optional(Type.String({ description: "Why the command is needed", maxLength: 800 })),
});
type ScopedBashInput = Static<typeof ScopedBashParameters>;

export function resolveBashCallCwd(input: unknown, defaultCwd: string): string {
  if (!input || typeof input !== "object") return defaultCwd;
  const requested = (input as { cwd?: unknown }).cwd;
  return typeof requested === "string" && requested.length > 0 ? resolve(defaultCwd, requested) : defaultCwd;
}

function insideProject(path: string, projectRoot: string): boolean {
  const suffix = relative(projectRoot, path);
  return suffix === "" || (!suffix.startsWith("..") && !isAbsolute(suffix));
}

function boundedFailureText(content: ToolResultEvent["content"]): string {
  let output = "";
  for (const item of content) {
    if (item.type !== "text" || item.text.length === 0) continue;
    const separator = output.length > 0 ? "\n" : "";
    const remaining = MAX_FAILURE_TEXT_CHARS - output.length;
    if (remaining <= separator.length) break;
    output += separator;
    output += item.text.slice(0, remaining - separator.length);
    if (output.length >= MAX_FAILURE_TEXT_CHARS) break;
  }
  return output;
}

function sendHiddenAdvisory(pi: ExtensionAPI, customType: string, content: string): void {
  pi.sendMessage({
    customType,
    content,
    display: false,
  }, { deliverAs: "steer" });
}

export default function toolLoopGuardrails(pi: ExtensionAPI): void {
  const state = createGuardState();
  const pendingCalls = new Map<string, { key?: string; repairNote?: string }>();
  let nativeReadCwd = process.cwd();
  let nativeRead = createReadToolDefinition(nativeReadCwd);
  const upstreamRead = nativeRead;
  let nativeBashCwd = process.cwd();
  let nativeBashProjectTrusted = false;
  let nativeBash = createConfiguredMsysBashDefinition(nativeBashCwd, nativeBashProjectTrusted);
  const upstreamBash = nativeBash;

  const readFor = (cwd: string): typeof nativeRead => {
    if (cwd !== nativeReadCwd) {
      nativeReadCwd = cwd;
      nativeRead = createReadToolDefinition(cwd);
    }
    return nativeRead;
  };

  const bashFor = (cwd: string, projectTrusted: boolean): typeof nativeBash => {
    if (cwd !== nativeBashCwd || projectTrusted !== nativeBashProjectTrusted) {
      nativeBashCwd = cwd;
      nativeBashProjectTrusted = projectTrusted;
      nativeBash = createConfiguredMsysBashDefinition(cwd, projectTrusted);
    }
    return nativeBash;
  };

  const ensurePendingCapacity = (toolCallId: string): void => {
    if (pendingCalls.has(toolCallId) || pendingCalls.size < MAX_PENDING_REPAIR_NOTES) return;
    const oldest = pendingCalls.keys().next().value;
    if (oldest !== undefined) pendingCalls.delete(oldest);
  };
  const rememberCallKey = (toolCallId: string, key: string): void => {
    ensurePendingCapacity(toolCallId);
    const pending = pendingCalls.get(toolCallId);
    if (pending) pending.key = key;
    else pendingCalls.set(toolCallId, { key });
  };
  const rememberRepairNote = (toolCallId: string, repairNote: string): void => {
    ensurePendingCapacity(toolCallId);
    const pending = pendingCalls.get(toolCallId);
    if (pending) pending.repairNote = repairNote;
    else pendingCalls.set(toolCallId, { repairNote });
  };

  pi.registerTool({
    ...upstreamBash,
    name: "bash",
    label: "bash (MSYS argv protected)",
    description: "Execute a Bash command in an explicit working directory. Returns bounded stdout/stderr. Prefer cwd over cd ... && ... when one package directory is intended.",
    promptGuidelines: [
      "Set bash.cwd to the verified task directory; inspect SP_* only when current model or Session details are needed.",
    ],
    parameters: ScopedBashParameters,
    async execute(toolCallId, input: ScopedBashInput, signal, onUpdate, ctx) {
      const effectiveCwd = resolveBashCallCwd(input, ctx.cwd);
      const projectTrusted = ctx.isProjectTrusted() && insideProject(effectiveCwd, ctx.cwd);
      const bash = bashFor(effectiveCwd, projectTrusted);
      return bash.execute(toolCallId, { command: input.command, timeout: input.timeout }, signal, onUpdate, ctx);
    },
  });

  pi.registerTool({
    ...upstreamRead,
    name: "read",
    label: "read (offset repaired)",
    async execute(toolCallId, input: ReadToolInput, signal, onUpdate, ctx) {
      const read = readFor(ctx.cwd);
      let result;
      try {
        result = await read.execute(toolCallId, input, signal, onUpdate, ctx);
      } catch (error) {
        if (!(error instanceof Error)) throw error;
        const note = repairReadOffsetFromError(input, error.message);
        if (!note) throw error;
        result = await read.execute(toolCallId, input, signal, onUpdate, ctx);
        attachRepairKind(input, "read_offset_clamped");
        rememberRepairNote(toolCallId, note);
      }
      const sessionId = ctx.sessionManager?.getSessionId?.();
      if (!sessionId) return result;
      const annotation = await issueSnapshotForRead(sessionId, ctx.cwd, input, result);
      if (!annotation) return result;
      return { ...result, content: [...result.content, { type: GUARDRAIL_CONTENT_TYPE, text: annotation }] };
    },
  });

  pi.on("agent_start", () => {
    resetGuardState(state);
    pendingCalls.clear();
  });
  pi.on("turn_start", () => resetBatchState(state));

  pi.on("tool_call", async (event, ctx) => {
    const key = callKey(event.toolName, event.input);
    rememberCallKey(event.toolCallId, key);
    const duplicate = inspectBatchCall(state, event.toolName, event.input, key);
    if (duplicate) {
      if (event.input && typeof event.input === "object") {
        attachRepairKind(event.input as Record<PropertyKey, unknown>, "batch_duplicate_blocked");
      }
      return { block: true, reason: duplicate };
    }
    const effectiveCwd = event.toolName === "bash" || event.toolName === "powershell"
      ? resolveBashCallCwd(event.input, ctx.cwd)
      : ctx.cwd;
    const preparation = await prepareDeterministicCall(event.toolName, event.input, effectiveCwd);
    if (preparation.blockReason) return { block: true, reason: preparation.blockReason };
    if (preparation.repairNote) rememberRepairNote(event.toolCallId, preparation.repairNote);
    const reason = inspectBeforeCall(state, event.toolName, event.input, key);
    if (!reason) return undefined;
    if (event.input && typeof event.input === "object") {
      attachRepairKind(event.input as Record<PropertyKey, unknown>, "repeated_call_blocked");
    }
    return { block: true, reason };
  });

  pi.on("tool_result", async (event: ToolResultEvent, ctx) => {
    const pending = pendingCalls.get(event.toolCallId);
    pendingCalls.delete(event.toolCallId);
    const key = pending?.key ?? callKey(event.toolName, event.input);
    const repeatReminder = observeRepeatedCall(state, event.toolName, event.input, key);
    const failureText = event.isError ? boundedFailureText(event.content) : "";
    const warning = recordResult(state, event.toolName, event.input, event.isError, failureText, key);
    const recoveryHint = event.isError
      ? await failureRecoveryHint(event.toolName, event.input, failureText, ctx.cwd)
      : undefined;
    const repairNote = pending?.repairNote;
    if (repeatReminder) sendHiddenAdvisory(pi, LOOP_REMINDER_CUSTOM_TYPE, repeatReminder);
    if (warning) sendHiddenAdvisory(pi, FAILURE_ADVISORY_CUSTOM_TYPE, warning);
    if (!repairNote && !recoveryHint) return undefined;
    const content = [...event.content];
    if (repairNote) content.push({ type: GUARDRAIL_CONTENT_TYPE, text: repairNote });
    if (recoveryHint) content.push({ type: GUARDRAIL_CONTENT_TYPE, text: recoveryHint });
    return { content };
  });
}
