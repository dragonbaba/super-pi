import type { AgentMessage } from "@super-pi/agent-core";
import type { CompactionPreparation } from "../../packages/coding-agent/src/core/compaction/compaction.ts";
import { createFileOps } from "../../packages/coding-agent/src/core/compaction/utils.ts";

export const compactionFocus = "PRESERVE_FIXTURE_DECISIONS_629";
export function compactionPreparation(scene: string, size = 1): CompactionPreparation {
  const history: AgentMessage[] = [], prefix: AgentMessage[] = [];
  for (let i = 0; i < size; i++) {
    history.push({ role: "user", content: `history ${i}: ` + "H".repeat(2048), timestamp: i });
    prefix.push({ role: "user", content: `prefix ${i}: ` + "P".repeat(2048), timestamp: i });
  }
  const fileOps = createFileOps();
  fileOps.read.add("read-only.txt"); fileOps.read.add("changed.txt"); fileOps.edited.add("changed.txt");
  return { firstKeptEntryId: "retained-entry", messagesToSummarize: scene === "prefix-only" ? [] : history,
    turnPrefixMessages: scene === "non-split" ? [] : prefix, isSplitTurn: scene !== "non-split",
    retainedTail: [{ role: "user", content: "retained suffix", timestamp: size + 1 }],
    tokensBefore: size * 2000, previousSummary: scene === "both" ? "Earlier decisions" : undefined,
    fileOps, settings: { enabled: true, reserveTokens: 1024, keepRecentTokens: 128 } };
}
