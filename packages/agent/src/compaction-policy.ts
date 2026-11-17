/** Automatic occupancy policy; summary/output reserves are separate budgets. */
export const DEFAULT_AUTO_COMPACTION_PERCENTAGE = 85;

export function isAutoCompactionPercentage(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 1 && value <= 100;
}

export function getAutoCompactionThreshold(contextWindow: number, percentage = DEFAULT_AUTO_COMPACTION_PERCENTAGE): number {
	return Math.floor(contextWindow * (isAutoCompactionPercentage(percentage) ? percentage : DEFAULT_AUTO_COMPACTION_PERCENTAGE) / 100);
}

/** Escaped components distinguish arbitrary provider/model identities, including slashes. */
export function autoCompactionSettingKey(provider: string, modelId: string): string {
	return `${encodeURIComponent(provider)}/${encodeURIComponent(modelId)}`;
}
