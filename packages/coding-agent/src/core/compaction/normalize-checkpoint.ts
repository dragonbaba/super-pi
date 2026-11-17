import type { AgentMessage } from "@super-pi/agent-core";
import type { SessionManager } from "../session-manager.ts";
import { estimateTokens } from "./compaction.ts";
import { condenseFailedCodemodeAttempts } from "./failed-attempts.ts";

/** Restore/setup only: durably reduce a checkpoint that no later request consumed.
 * Once any entry follows it, leave the established prefix until the next compaction.
 * The native replacement history is reused byte-for-byte; there is no provider call.
 */
export function normalizeUnconsumedCompaction(manager: SessionManager, keepRecentTokens: number): boolean {
	const checkpoint = manager.getLeafEntry();
	if (checkpoint?.type !== "compaction" || !checkpoint.retainedTail) return false;
	const tail = condenseFailedCodemodeAttempts(checkpoint.retainedTail, keepRecentTokens);
	if (tail === checkpoint.retainedTail) return false;
	const previous = checkpoint.details && typeof checkpoint.details === "object" && !Array.isArray(checkpoint.details) ? checkpoint.details as Record<string, unknown> : {};
	const accounting = previous.contextAccounting && typeof previous.contextAccounting === "object" && !Array.isArray(previous.contextAccounting)
		? previous.contextAccounting as Record<string, unknown> : {};
	const summaryMessage: AgentMessage = { role: "compactionSummary", summary: checkpoint.summary, tokensBefore: checkpoint.tokensBefore, timestamp: 0 };
	let before = estimateTokens(summaryMessage), after = before;
	if (typeof accounting.materializedTokensAfter === "number" && Number.isFinite(accounting.materializedTokensAfter) && accounting.materializedTokensAfter >= 0) before = accounting.materializedTokensAfter;
	else for (const message of checkpoint.retainedTail) before += estimateTokens(message);
	for (const message of tail) after += estimateTokens(message);
	const { usageLedger: _ledger, usageComponents: _components, ...details } = previous;
	manager.appendCompaction(checkpoint.summary, checkpoint.firstKeptEntryId, before, {
		...details,
		contextMaintenance: { version: 1, kind: "completed-failed-codemode-source", previousCheckpointId: checkpoint.id },
		contextAccounting: { ...accounting, schemaVersion: 1, providerUsageState: "unverified", estimateSource: "materialized", materializedTokensAfter: after, keepRecentTokens },
	}, checkpoint.fromHook, undefined, tail);
	return true;
}
