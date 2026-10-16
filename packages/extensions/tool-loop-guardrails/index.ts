import { CallLedger } from "./call-ledger.ts";
import { parseRetryPolicy, RetryWait } from "./transient-retry.ts";
import { MUTATION_READ_SOURCE } from "../../coding-agent/src/core/tools/read-window.ts";
import process from "node:process";
import { realpathSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import {
  createReadToolDefinition,
  getShellCwdBinding,
  prepareShellCwd,
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
import { SNAPSHOT_FAILURE_RE } from "./regex.ts";
import { MAX_SUBSTITUTIONS, MAX_SUBSTITUTION_NESTING } from "../resource-lifecycle-guard/shell-substitution.ts";

const GUARDRAIL_CONTENT_TYPE = "text" as const;
const MAX_FAILURE_TEXT_CHARS = 8_192;
const LOOP_REMINDER_CUSTOM_TYPE = "tool-loop-reminder-v1";
const FAILURE_ADVISORY_CUSTOM_TYPE = "tool-failure-advisory-v1";
const ScopedBashParameters = Type.Object({
  command: Type.String({ description: "Bash command to execute" }),
  cwd: Type.Optional(Type.String({ description: "Working directory; defaults to the current Pi workspace", maxLength: 4096 })),
  timeout: Type.Optional(Type.Number({ description: "Timeout in seconds: 60 means one minute (optional, no default timeout)" })),
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
  const calls = new CallLedger();
  let configurationError: string | undefined;
  pi.registerFlag?.("tool-transient-retry", { type: "string", description: "JSON transient tool retry policy: maxAttempts, maxWaitMs, baseDelayMs, maxDelayMs" });
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

  pi.registerTool({
    ...upstreamBash,
    name: "bash",
    label: "bash (MSYS argv protected)",
    description: `Execute a Bash command in an explicit working directory. Returns bounded stdout/stderr. Prefer cwd over cd ... && ... when one package directory is intended. With resource-lifecycle-guard: max ${MAX_SUBSTITUTIONS} command substitutions ($() or backticks) per script, nesting max ${MAX_SUBSTITUTION_NESTING}; split larger batches.`,
    promptGuidelines: [
      "Set bash.cwd to the verified task directory; inspect SP_* only when current model or Session details are needed.",
      "For Node scripts, use node -e when the one-off source can be passed reliably; complex quoting or reusable code may use an explicit file or supported stdin. Script length does not decide permission, and a file does not bypass approval.",
    ],
    parameters: ScopedBashParameters,
    prepareArguments(args, ctx) {
      const input = upstreamBash.prepareArguments!(args) as ScopedBashInput;
      if (input?.cwd === undefined) return input;
      if (!ctx) throw new Error("[SHELL_CWD_UNSUPPORTED] Explicit scoped cwd requires a Session context for settings preflight.");
      if (typeof input.cwd !== "string" || !input.cwd || input.cwd.length > 4096 || input.cwd.includes("\0")) return input;
      // This synchronous metadata/settings preflight precedes every permission hook.
      // No binding or settings definition survives this check; execution revalidates.
      const trusted = ctx.isProjectTrusted(true);
      const target = realpathSync.native(resolve(ctx.cwd, input.cwd));
      const root = trusted ? realpathSync.native(ctx.cwd) : ctx.cwd;
      const definition = createConfiguredMsysBashDefinition(target, trusted && insideProject(target, root));
      definition.prepareArguments!(input);
      return input;
    },
    async execute(toolCallId, input: ScopedBashInput, signal, onUpdate, ctx) {
      const binding = await prepareShellCwd(input, ctx.cwd);
      try {
        const effectiveCwd = binding?.canonical ?? resolveBashCallCwd(input, ctx.cwd);
        binding?.beforeSpawn(binding.canonical);
        const trusted = ctx.isProjectTrusted(binding !== undefined);
        const projectRoot = binding?.sessionCanonical ?? ctx.cwd;
        const projectTrusted = trusted && insideProject(effectiveCwd, projectRoot);
        // Explicit directory definitions are invocation-owned: a failed identity check
        // must never leave settings from a replacement directory in the path cache.
        const bash = binding ? createConfiguredMsysBashDefinition(effectiveCwd, projectTrusted) : bashFor(effectiveCwd, projectTrusted);
        return await bash.execute(toolCallId, input, signal, onUpdate, ctx);
      } finally { binding?.release(); }
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
        calls.rememberRepair(toolCallId, note);
      }
      const sessionId = ctx.sessionManager?.getSessionId?.();
      if (!sessionId) return result;
      const annotation = await issueSnapshotForRead(sessionId, ctx.cwd, input, result);
      if (!annotation) return result;
      const content = [...result.content, { type: GUARDRAIL_CONTENT_TYPE, text: annotation, readBoundary: "metadata" as const }];
      const source = (result.content as any)[MUTATION_READ_SOURCE];
      if (source) Object.defineProperty(content, MUTATION_READ_SOURCE, { value: source });
      return { ...result, content };
    },
  });

  pi.on("agent_start", () => {
    resetGuardState(state);
    calls.clear();
    configurationError = undefined;
    try { state.retry.policy = parseRetryPolicy(pi.getFlag?.("tool-transient-retry")); }
    catch (error) { configurationError = String(error).slice(0, 512); }
  });
  pi.on("turn_start", () => { resetBatchState(state); });
  pi.on("agent_end", () => { calls.clear(); resetGuardState(state); });
  pi.on("tool_execution_end", (event) => {
    for (const id of calls.pending.keys()) {
      const pending = calls.pending.get(id)!;
      if (id === event.toolCallId || pending.parent === event.toolCallId) {
        const retry = state.retry.operations.get(pending.key);
        if (retry) retry.inFlight = false;
      }
    }
    calls.end(event.toolCallId);
  });

  pi.on("tool_call", async (event, ctx) => {
    if (configurationError) return { block: true, reason: `[TOOL_RETRY_CONFIG] ${configurationError}` };
    if (!calls.canAdmit(event.toolCallId, event.parentToolCallId)) {
      return { block: true, reason: "[GUARD_CAPACITY] Invocation metadata capacity or identity limit reached; await pending calls or start a fresh user run." };
    }
    const pending = calls.remember(event.toolCallId, "", event.parentToolCallId);
    try {
    const effectiveCwd = event.toolName === "bash" || event.toolName === "powershell"
      ? resolveBashCallCwd(event.input, ctx.cwd) : ctx.cwd;
    const preparation = await prepareDeterministicCall(event.toolName, event.input, effectiveCwd);
    if (ctx.signal?.aborted || calls.pending.get(event.toolCallId) !== pending) {
      calls.finish(event.toolCallId);
      return { block: true, reason: "Operation aborted before tool admission" };
    }
    // Hash after preparation: a synchronous admission decision uses exactly this input.
    const key = callKey(event.toolName, event.input);
    pending.key = key;
    const nestedKey = event.parentToolCallId ? `${event.parentToolCallId}\0${key}` : undefined;
    const releasedAt = nestedKey ? calls.released.get(event.parentToolCallId!)?.get(nestedKey) : undefined;
    const overlapped = releasedAt !== undefined && event.nestedIssuedAt !== undefined && event.nestedIssuedAt <= releasedAt;
    const duplicate = inspectBatchCall(state, event.toolName, event.input, nestedKey ?? key, nestedKey ? calls.nested : state.batchCalls, overlapped);
    if (duplicate) {
      if (event.input && typeof event.input === "object") attachRepairKind(event.input as Record<PropertyKey, unknown>, "batch_duplicate_blocked");
      calls.finish(event.toolCallId);
      return { block: true, reason: duplicate };
    }
    pending.nestedKey = nestedKey;
    if (preparation.repairNote) calls.rememberRepair(event.toolCallId, preparation.repairNote);
    if (preparation.blockReason) return { block: true, reason: preparation.blockReason };
    const reason = inspectBeforeCall(state, event.toolName, event.input, key);
    if (reason) {
      if (event.input && typeof event.input === "object") attachRepairKind(event.input as Record<PropertyKey, unknown>, "repeated_call_blocked");
      calls.finish(event.toolCallId);
      return { block: true, reason };
    }
    const retry = state.retry.operations.get(key);
    if (retry) {
      retry.inFlight = true;
      const delay = state.retry.delay(retry);
      // Reserve the scheduled delay before yielding; simultaneous parents cannot spend it twice.
      retry.waitMs += delay;
      retry.attempts++;
      pending.retryAttemptReserved = true;
      const started = performance.now();
      const wait = pending.wait = new RetryWait();
      const completed = await wait.start(delay, ctx.signal);
      retry.elapsedWaitMs += performance.now() - started;
      pending.wait = undefined;
      if (!completed || calls.pending.get(event.toolCallId) !== pending) {
        retry.inFlight = false;
        calls.finish(event.toolCallId);
        return { block: true, reason: "Operation aborted during transient retry backoff" };
      }
    }
    return undefined;
    } catch (error) {
      calls.finish(event.toolCallId);
      throw error;
    }
  });

  pi.on("tool_result", async (event: ToolResultEvent, ctx) => {
    const pending = calls.finish(event.toolCallId);
    // Unadmitted/blocked calls have no identity to record. Do not hash result-stage inputs.
    if (!pending) return undefined;
    const key = pending.key;
    const retry = state.retry.operations.get(key);
    if (retry) retry.inFlight = false;
    const repeatReminder = observeRepeatedCall(state, event.toolName, event.input, key);
    const failureText = event.isError ? boundedFailureText(event.content) : "";
    const warning = recordResult(state, event.toolName, event.input, event.isError, failureText, key, event.details, pending.retryAttemptReserved);
    const recoveryHint = event.isError
      ? await failureRecoveryHint(event.toolName, event.input, failureText, getShellCwdBinding(event.input)?.canonical ?? ctx.cwd, event.details)
      : undefined;
    const repairNote = pending?.repairNote;
    // One steering note for a snapshot failure at the repetition threshold.
    // Keep both counters/guards; do not deduplicate content from other tools or calls.
    const snapshotWarning = warning && event.toolName === "edit" && SNAPSHOT_FAILURE_RE.test(failureText);
    if (repeatReminder && !snapshotWarning) sendHiddenAdvisory(pi, LOOP_REMINDER_CUSTOM_TYPE, repeatReminder);
    if (warning) sendHiddenAdvisory(pi, FAILURE_ADVISORY_CUSTOM_TYPE, warning);
    if (!repairNote && !recoveryHint) return undefined;
    const content = [...event.content];
    if (repairNote) content.push({ type: GUARDRAIL_CONTENT_TYPE, text: repairNote });
    if (recoveryHint) content.push({ type: GUARDRAIL_CONTENT_TYPE, text: recoveryHint });
    return { content };
  });
}
