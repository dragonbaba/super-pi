import type { ChildProcessObservation } from "../../utils/child-process.ts";

export type ShellTermination = "exit" | "signal" | "timeout" | "cancelled" | "output_failure" | "not_started" | "unknown";
export interface ShellProcessResult {
  exitCode: number | null;
  observation?: ChildProcessObservation;
  termination?: ShellTermination;
  inputError?: string;
  observationError?: string;
  secondaryObservationError?: string;
  observationErrorsOmitted?: true;
}
const PROCESS_RESULT = Symbol.for("pi.shell-process-result.v1");

/** Completion boundary only. Do not mutate a custom backend's owned result. */
export function normalizeShellProcessResult(result: ShellProcessResult): ShellProcessResult {
  const observation = result.observation;
  if (result.exitCode !== null && !Number.isSafeInteger(result.exitCode)
    || result.termination !== undefined && !TERMINATIONS.has(result.termination)
    || result.termination === "exit" && result.exitCode === null
    || (result.termination === "signal" || result.termination === "not_started") && result.exitCode !== null
    || result.inputError !== undefined && typeof result.inputError !== "string"
    || result.observationError !== undefined && typeof result.observationError !== "string"
    || result.secondaryObservationError !== undefined && (typeof result.secondaryObservationError !== "string" || result.observationError === undefined)
    || result.observationErrorsOmitted !== undefined && (result.observationErrorsOmitted !== true || result.secondaryObservationError === undefined)
    || observation && (typeof observation.started !== "boolean" || typeof observation.outputDrained !== "boolean"
    || observation.spawnAttempted !== undefined && typeof observation.spawnAttempted !== "boolean"
    || observation.exitCode !== result.exitCode || observation.started && (observation.spawnAttempted === false || result.termination === "not_started")
    || !observation.started && (result.exitCode !== null || observation.signal !== null || result.termination !== undefined && result.termination !== "not_started" && result.termination !== "cancelled")
    || result.termination === "exit" && observation.signal !== null
    || result.termination === "signal" && typeof observation.signal !== "string"
    || observation.signal !== null && result.exitCode !== null
    || observation.signal !== null && (typeof observation.signal !== "string" || observation.signal.length > 32))) {
    return { exitCode: null, termination: "unknown", inputError: typeof result.inputError === "string" ? result.inputError.slice(0, 1000) : undefined,
      observationError: "Backend returned inconsistent process observations; completion and effects are unknown." };
  }
  if ((result.inputError?.length ?? 0) <= 1000 && (result.observationError?.length ?? 0) <= 1000 && (result.secondaryObservationError?.length ?? 0) <= 1000) return result;
  return { exitCode: result.exitCode, observation: result.observation, termination: result.termination,
    inputError: result.inputError?.slice(0, 1000), observationError: result.observationError?.slice(0, 1000),
    secondaryObservationError: result.secondaryObservationError?.slice(0, 1000), observationErrorsOmitted: result.observationErrorsOmitted };
}

/** Append one bounded completion diagnostic without replacing earlier evidence. */
export function appendShellObservationError(result: ShellProcessResult, message: string): ShellProcessResult {
  result = normalizeShellProcessResult(result);
  const detail = message.slice(0, 1000);
  return { exitCode: result.exitCode, observation: result.observation, termination: result.termination, inputError: result.inputError,
    observationError: result.observationError ?? detail,
    secondaryObservationError: result.observationError === undefined ? undefined : result.secondaryObservationError ?? detail,
    observationErrorsOmitted: result.secondaryObservationError === undefined ? result.observationErrorsOmitted : true };
}

export function observedShellError(error: unknown, result: ShellProcessResult): Error {
  result = normalizeShellProcessResult(result);
  let failure = error instanceof Error ? error : new Error(String(error));
  try { Object.defineProperty(failure, PROCESS_RESULT, { value: result, configurable: true }); }
  catch {
    // Extension errors and AbortSignal reasons may be frozen/sealed, or already
    // carry a non-configurable observation. Never lose the original failure.
    failure = new Error(failure.message, { cause: error });
    Object.defineProperty(failure, PROCESS_RESULT, { value: result, configurable: true });
  }
  return failure;
}

export function shellProcessResultFromError(error: unknown): ShellProcessResult | undefined {
  return error && typeof error === "object" ? (error as { [PROCESS_RESULT]?: ShellProcessResult })[PROCESS_RESULT] : undefined;
}

/** Final producer facts, independently of command stdout/stderr or short error text. */
export interface ShellExecutionFacts {
  version: 1;
  producer: "local-shell" | "custom-shell" | "agent";
  started: boolean | "unknown";
  executionStatus: "not_executed" | "start_failed" | "exited" | "interrupted" | "unknown";
  sideEffects: "none" | "unknown";
  retryGuidance: "fresh_request" | "inspect_before_retry";
  cwd: string | null;
  exitCode: number | null;
  signal: string | null;
  termination: ShellTermination;
  inputError?: string;
  /** Completion/progress observer or executable-status persistence failure. */
  observationError?: string;
  /** First subsequent observer failure; further failures are explicitly omitted. */
  secondaryObservationError?: string;
  observationErrorsOmitted?: true;
  output: {
    complete: boolean | "unknown";
    tailTruncated: boolean;
    log: "not_needed" | "complete" | "capped" | "failed";
    cleanup: "not_needed" | "removed" | "failed";
    logError?: string;
    cleanupError?: string;
  };
}

const PRODUCERS = new Set(["local-shell", "custom-shell", "agent"]);
const TERMINATIONS = new Set(["exit", "signal", "timeout", "cancelled", "output_failure", "not_started", "unknown"]);
const EXECUTION_STATES = new Set(["not_executed", "start_failed", "exited", "interrupted", "unknown"]);
const LOG_STATES = new Set(["not_needed", "complete", "capped", "failed"]);
const CLEANUP_STATES = new Set(["not_needed", "removed", "failed"]);

export function readShellExecution(details: unknown): ShellExecutionFacts | undefined {
  if (!details || typeof details !== "object") return undefined;
  const value = (details as { shellExecution?: ShellExecutionFacts }).shellExecution;
  if (!value || value.version !== 1 || !PRODUCERS.has(value.producer)
    || value.started !== true && value.started !== false && value.started !== "unknown"
    || !EXECUTION_STATES.has(value.executionStatus)
    || value.sideEffects !== (value.started === false ? "none" : "unknown")
    || value.retryGuidance !== (value.started === false ? "fresh_request" : "inspect_before_retry")
    || value.cwd !== null && (typeof value.cwd !== "string" || value.cwd.length > 32768)
    || value.exitCode !== null && !Number.isSafeInteger(value.exitCode)
    || value.signal !== null && (typeof value.signal !== "string" || value.signal.length > 32)
    || !TERMINATIONS.has(value.termination)
    || value.inputError !== undefined && (typeof value.inputError !== "string" || value.inputError.length > 1000)
    || value.observationError !== undefined && (typeof value.observationError !== "string" || value.observationError.length > 1000)
    || value.secondaryObservationError !== undefined && (value.observationError === undefined || typeof value.secondaryObservationError !== "string" || value.secondaryObservationError.length > 1000)
    || value.observationErrorsOmitted !== undefined && (value.observationErrorsOmitted !== true || value.secondaryObservationError === undefined)
    || !value.output || value.output.complete !== true && value.output.complete !== false && value.output.complete !== "unknown"
    || typeof value.output.tailTruncated !== "boolean"
    || !LOG_STATES.has(value.output.log)
    || !CLEANUP_STATES.has(value.output.cleanup)
    || value.output.logError !== undefined && (typeof value.output.logError !== "string" || value.output.logError.length > 1000)
    || value.output.cleanupError !== undefined && (typeof value.output.cleanupError !== "string" || value.output.cleanupError.length > 1000)) return undefined;
  if (value.started === false && (value.exitCode !== null || value.signal !== null || value.termination !== "not_started" && value.termination !== "cancelled")
    || value.termination === "exit" && (value.exitCode === null || value.signal !== null)
    || value.termination === "signal" && (value.exitCode !== null || value.signal === null)) return undefined;
  if (value.started === false && value.executionStatus !== "not_executed" && value.executionStatus !== "start_failed"
    || value.started === true && (value.termination === "not_started" || value.executionStatus !== (value.termination === "exit" ? "exited" : value.termination === "unknown" ? "unknown" : "interrupted"))
    || value.output.log === "failed" && value.output.complete !== false) return undefined;
  return value;
}

export function shellExecutionSucceeded(value: ShellExecutionFacts): boolean {
  return value.producer === "local-shell" && value.started === true && value.executionStatus === "exited" && typeof value.cwd === "string" && value.cwd.length > 0 && value.termination === "exit"
    && value.exitCode === 0 && value.signal === null && value.output.complete === true && value.output.log !== "failed" && !value.inputError && value.observationError === undefined;
}

export function shellFailureCategory(value: ShellExecutionFacts): string {
  if (value.started === false && value.termination === "cancelled") return "timeout_or_aborted";
  if (value.started === false) return value.executionStatus === "start_failed" ? "start_failed" : "not_executed";
  if (value.inputError) return "input_transport_failed";
  if (value.termination === "timeout" || value.termination === "cancelled") return "timeout_or_aborted";
  if (value.termination === "signal") return "signal_terminated";
  if (value.termination === "output_failure") return "output_log_failed";
  if (value.exitCode !== null && value.exitCode !== 0) return "command_failed";
  if (value.output.log === "failed") return "output_log_failed";
  if (value.output.complete === false) return "output_incomplete";
  if (value.observationError !== undefined) return "observation_failed";
  return "execution_unknown";
}
