type SessionEntryLike = {
  type?: unknown;
  customType?: unknown;
  data?: unknown;
  details?: unknown;
  message?: unknown;
};

type GoalStateData = {
  goal?: {
    status?: unknown;
  } | null;
};

export const COMPACTION_CONTINUATION_MESSAGE_TYPE = "compaction-auto-continue";

export const COMPACTION_CONTINUATION_PROMPT =
  "Automatic context compaction completed. Continue the current task from the compacted context without waiting for another user prompt. Re-check the remaining work and proceed. If the task is already fully complete, do not invent new work; provide only the final completion response.";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * pi-goal already owns safe continuation for active goals. Detect its durable
 * session entry without importing or coupling to that optional package.
 */
export function hasActiveGoal(entries: readonly SessionEntryLike[]): boolean {
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index];
    if (entry.type !== "custom" || entry.customType !== "goal-state") continue;
    if (!isRecord(entry.data)) return false;
    const goal = (entry.data as GoalStateData).goal;
    return isRecord(goal) && goal.status === "active";
  }
  return false;
}

export function latestAssistantStopReason(entries: readonly SessionEntryLike[]): string | undefined {
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index];
    if (entry.type !== "message" || !isRecord(entry.message)) continue;
    if (entry.message.role !== "assistant") continue;
    return typeof entry.message.stopReason === "string" ? entry.message.stopReason : undefined;
  }
  return undefined;
}

function isOurContinuation(entry: SessionEntryLike): boolean {
  if (entry.type === "custom_message") {
    return entry.customType === COMPACTION_CONTINUATION_MESSAGE_TYPE;
  }
  return (
    entry.type === "message" &&
    isRecord(entry.message) &&
    entry.message.role === "custom" &&
    entry.message.customType === COMPACTION_CONTINUATION_MESSAGE_TYPE
  );
}

function alreadyQueuedForCompaction(
  entries: readonly SessionEntryLike[],
  compactionEntryId: string,
): boolean {
  return entries.some((entry) => {
    if (!isOurContinuation(entry)) return false;
    const details = isRecord(entry.details)
      ? entry.details
      : isRecord(entry.message) && isRecord(entry.message.details)
        ? entry.message.details
        : undefined;
    return details?.compactionEntryId === compactionEntryId;
  });
}

function latestUserInputIsOurContinuation(entries: readonly SessionEntryLike[]): boolean {
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index];
    if (isOurContinuation(entry)) return true;
    if (entry.type === "custom_message") return false;
    if (entry.type !== "message" || !isRecord(entry.message)) continue;
    if (entry.message.role === "user" || entry.message.role === "custom") return false;
  }
  return false;
}

export function shouldQueueCompactionContinuation(params: {
  enabled: boolean;
  reason: "manual" | "threshold" | "overflow";
  willRetry: boolean;
  compactionEntryId?: string;
  branchEntries: readonly SessionEntryLike[];
}): boolean {
  if (!params.enabled || params.reason !== "threshold" || params.willRetry) return false;
  if (hasActiveGoal(params.branchEntries)) return false;
  if (
    params.compactionEntryId &&
    alreadyQueuedForCompaction(params.branchEntries, params.compactionEntryId)
  ) return false;
  // A hidden continuation may itself be truncated. Do not recursively create
  // an unbounded chain; a fresh real user/custom input resets this guard.
  if (latestUserInputIsOurContinuation(params.branchEntries)) return false;

  // `length` is the only reliable protocol-level evidence that generation was
  // cut short. A normal toolUse is expected to continue through Pi's tool loop
  // and is not, by itself, a stranded response.
  return latestAssistantStopReason(params.branchEntries) === "length";
}
