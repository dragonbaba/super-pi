export type ContextUsageLike = {
	tokens: number | null;
	contextWindow: number;
	percent: number | null;
	autoCompactionThreshold?: number;
	autoCompactionEnabled?: boolean;
	automaticCompactionBlocked?: "paid-boundary-uncommitted";
};

export function exceedsAutoCompactionThreshold(
	usage: ContextUsageLike | undefined,
): boolean {
	if (!usage || usage.tokens === null || usage.tokens <= 0 || usage.contextWindow <= 0) return false;
	if (usage.autoCompactionEnabled === false || usage.automaticCompactionBlocked) return false;
	const threshold = usage.autoCompactionThreshold;
	// Older hosts do not expose their policy; do not guess a second threshold.
	return threshold !== undefined && Number.isFinite(threshold) && threshold >= 0 && usage.tokens >= threshold;
}

export function formatContextDisplay(
	percentage: string,
	contextWindow: string,
	compactionPending: boolean,
): string {
	return compactionPending ? `${percentage} · pending compact` : `${percentage}/${contextWindow}`;
}
