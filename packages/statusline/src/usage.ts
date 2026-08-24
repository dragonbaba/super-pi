import type { SessionEntry } from "@super-pi/coding-agent";

interface UsageLike {
	input?: number;
	output?: number;
	cacheRead?: number;
	cacheWrite?: number;
	cost?: { total?: number };
}

export interface FooterUsageSummary {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	latestCacheHitRate?: number;
}

export function createEmptyFooterUsageSummary(): FooterUsageSummary {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
}

export function addFooterUsage(
	totals: FooterUsageSummary,
	usage: UsageLike | undefined,
	updateLatestCacheHitRate = false,
): void {
	if (!usage) return;
	const input = usage.input ?? 0;
	const cacheRead = usage.cacheRead ?? 0;
	const cacheWrite = usage.cacheWrite ?? 0;
	if (updateLatestCacheHitRate) {
		const promptTokens = input + cacheRead + cacheWrite;
		totals.latestCacheHitRate = promptTokens > 0 ? (cacheRead / promptTokens) * 100 : undefined;
	}
	totals.input += input;
	totals.output += usage.output ?? 0;
	totals.cacheRead += cacheRead;
	totals.cacheWrite += cacheWrite;
	totals.cost += usage.cost?.total ?? 0;
}

export function summarizeFooterUsage(entries: readonly SessionEntry[]): FooterUsageSummary {
	const totals = createEmptyFooterUsageSummary();
	for (const entry of entries) {
		if (entry.type === "message" && entry.message.role === "assistant") {
			addFooterUsage(totals, entry.message.usage, true);
		} else if (entry.type === "message" && entry.message.role === "toolResult") {
			addFooterUsage(totals, entry.message.usage);
		} else if (entry.type === "compaction" || entry.type === "branch_summary") {
			addFooterUsage(totals, entry.usage);
		}
	}
	return totals;
}
