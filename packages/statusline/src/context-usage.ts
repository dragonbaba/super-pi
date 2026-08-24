const SP_084_DEFAULT_COMPACTION_RESERVE_TOKENS = 16_384;

export type ContextUsageLike = {
	tokens: number | null;
	contextWindow: number;
	percent: number | null;
};

export function exceedsAutoCompactionThreshold(
	usage: ContextUsageLike | undefined,
	reserveTokens = SP_084_DEFAULT_COMPACTION_RESERVE_TOKENS,
): boolean {
	if (!usage || usage.tokens === null || usage.tokens <= 0 || usage.contextWindow <= 0) return false;
	if (!Number.isFinite(reserveTokens) || reserveTokens < 0) return false;
	return usage.tokens > usage.contextWindow - reserveTokens;
}

export function formatContextDisplay(
	percentage: string,
	contextWindow: string,
	compactionPending: boolean,
): string {
	return compactionPending ? `${percentage} · pending compact` : `${percentage}/${contextWindow}`;
}
