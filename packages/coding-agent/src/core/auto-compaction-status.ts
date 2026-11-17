import { DEFAULT_AUTO_COMPACTION_PERCENTAGE, getAutoCompactionThreshold, isAutoCompactionPercentage } from "@super-pi/agent-core";

const PERCENTAGE_INPUT = /^(\d+(?:\.\d+)?)\s*%?$/;
export const AUTO_COMPACTION_INPUT_HELP = "Use /autocompact status or /autocompact <1..100 percent>, for example /autocompact 85%.";

export function parseAutoCompactionPercentage(input: string): number | "status" {
	const text = input.trim();
	if (text === "" || text === "status") return "status";
	const match = PERCENTAGE_INPUT.exec(text);
	const value = match ? Number(match[1]) : Number.NaN;
	if (!isAutoCompactionPercentage(value)) throw new Error(AUTO_COMPACTION_INPUT_HELP);
	return value;
}

export function formatAutoCompactionStatus(provider: string, modelId: string, contextWindow: number, percentage: number, enabled: boolean): string {
	const threshold = getAutoCompactionThreshold(contextWindow, percentage);
	const capacity = Number.isFinite(contextWindow) && contextWindow > 0
		? `${threshold} / ${contextWindow} tokens` : "context capacity unavailable";
	return `Auto-compaction ${enabled ? "enabled" : "disabled"}: ${provider}/${modelId}, ${percentage}% (${capacity}). Edits persist for this provider/model; unset pairs default to ${DEFAULT_AUTO_COMPACTION_PERCENTAGE}%. Summary/output reserves remain separate.`;
}
