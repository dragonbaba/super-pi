const MIN_RELIABLE_STREAM_DURATION_MS = 100;

export function calculateTokenSpeed(
	outputTokens: number | undefined,
	startedAtMs: number | undefined,
	endedAtMs: number,
): number | undefined {
	if (
		outputTokens === undefined ||
		!Number.isFinite(outputTokens) ||
		outputTokens <= 0 ||
		startedAtMs === undefined ||
		!Number.isFinite(startedAtMs) ||
		!Number.isFinite(endedAtMs)
	) {
		return undefined;
	}

	const durationMs = endedAtMs - startedAtMs;
	if (durationMs < MIN_RELIABLE_STREAM_DURATION_MS) return undefined;
	return outputTokens / (durationMs / 1000);
}

export function formatTokenSpeed(tokensPerSecond: number): string {
	const digits = tokensPerSecond >= 100 ? 0 : 1;
	return `${tokensPerSecond.toFixed(digits)} t/s`;
}
