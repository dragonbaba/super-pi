import type { AssistantMessage } from "@super-pi/ai";
import { promptTokens } from "./cache-stats.ts";
import type { SessionEntry } from "./session-manager.ts";

function ascending(a: number, b: number): number { return a - b; }

/** On-demand profile of adjacent completed requests on the latest route of the current branch. */
export function getCacheTurnProfile(branch: readonly SessionEntry[]) {
	const uncached: number[] = [];
	const growth: number[] = [];
	let newer: AssistantMessage | undefined;
	let newerTokens = 0;
	let reportedCache = false;
	for (let index = branch.length - 1; index >= 0; index--) {
		const entry = branch[index]!;
		if (entry.type === "compaction" || entry.type === "branch_summary" || entry.type === "model_change") break;
		if (entry.type !== "message" || entry.message.role !== "assistant") continue;
		const current = entry.message;
		const tokens = promptTokens(current);
		if (!tokens) break;
		if (newer) {
			if (newer.api !== current.api || newer.provider !== current.provider || newer.model !== current.model ||
				(newer.responseModel ?? newer.model) !== (current.responseModel ?? current.model)) break;
			uncached.push(newer.usage.input + newer.usage.cacheWrite);
			growth.push(newerTokens - tokens);
		}
		reportedCache ||= current.usage.cacheRead > 0 || current.usage.cacheWrite > 0;
		newer = current;
		newerTokens = tokens;
	}
	if (!reportedCache || uncached.length === 0) return undefined;
	uncached.sort(ascending);
	growth.sort(ascending);
	const count = uncached.length;
	// Nearest-rank percentiles keep the values in observed whole tokens.
	const middle = Math.ceil(count / 2) - 1;
	return {
		count,
		uncachedMedian: uncached[middle]!,
		uncachedP95: uncached[Math.ceil(0.95 * count) - 1]!,
		growthMedian: growth[middle]!,
	};
}
