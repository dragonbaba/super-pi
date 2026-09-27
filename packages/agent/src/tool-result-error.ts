import type { AgentToolResult } from "./types.ts";

const RESULT = Symbol.for("pi.tool-result-error.v1");

/** A producer can throw while retaining the observed result for Agent/Session. */
export class ToolResultError<T = unknown> extends Error {
  readonly [RESULT]: AgentToolResult<T>;
  constructor(message: string, result: AgentToolResult<T>, options?: ErrorOptions) {
    super(message, options);
    this.name = "ToolResultError";
    this[RESULT] = result;
  }
}

/** Symbol identity also works across source/Jiti and built package copies. */
export function toolResultFromError(error: unknown): AgentToolResult<unknown> | undefined {
  if (!error || typeof error !== "object") return undefined;
  const result = (error as { [RESULT]?: AgentToolResult<unknown> })[RESULT];
  return result && typeof result === "object" && Array.isArray(result.content) ? result : undefined;
}
