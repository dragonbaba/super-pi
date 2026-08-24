import type { Usage } from "@super-pi/ai/compat";
import type { SessionEntry } from "./session-manager.ts";

export interface UsageTotals {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
}

export function createUsageTotals(): UsageTotals {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		cost: 0,
	};
}

export function addUsageToTotals(totals: UsageTotals, usage: Usage): void {
	totals.input += usage.input;
	totals.output += usage.output;
	totals.cacheRead += usage.cacheRead;
	totals.cacheWrite += usage.cacheWrite;
	totals.cost += usage.cost.total;
}

const COMPACTION_USAGE_LEDGER_SCHEMAS = new Map([
	["compaction-usage-ledger-v1", 1],
	["compaction-usage-ledger-v2", 2],
]);

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value);
}

function isUsage(value: unknown): value is Usage {
	if (!isRecord(value) || !isRecord(value.cost)) return false;
	return (
		isFiniteNumber(value.input) &&
		isFiniteNumber(value.output) &&
		isFiniteNumber(value.cacheRead) &&
		isFiniteNumber(value.cacheWrite) &&
		isFiniteNumber(value.totalTokens) &&
		isFiniteNumber(value.cost.input) &&
		isFiniteNumber(value.cost.output) &&
		isFiniteNumber(value.cost.cacheRead) &&
		isFiniteNumber(value.cost.cacheWrite) &&
		isFiniteNumber(value.cost.total)
	);
}

export function getUnboundCompactionLedgerUsages(entries: SessionEntry[]): Usage[] {
	const boundOperationIds = new Set<string>();
	for (const entry of entries) {
		if (entry.type !== "compaction" || !isRecord(entry.details)) continue;
		const ledger = entry.details.usageLedger;
		if (!isRecord(ledger)) continue;
		for (const operationId of Object.values(ledger)) {
			if (typeof operationId === "string") boundOperationIds.add(operationId);
		}
	}

	const usages: Usage[] = [];
	for (const entry of entries) {
		if (entry.type !== "custom" || !isRecord(entry.data)) continue;
		const schemaVersion = COMPACTION_USAGE_LEDGER_SCHEMAS.get(entry.customType);
		if (
			schemaVersion === undefined ||
			entry.data.schemaVersion !== schemaVersion ||
			entry.data.status !== "provider_completed" ||
			typeof entry.data.operationId !== "string" ||
			boundOperationIds.has(entry.data.operationId) ||
			!isUsage(entry.data.usage)
		) {
			continue;
		}
		usages.push(entry.data.usage);
	}
	return usages;
}

export interface UsageCostBreakdownEntry {
	key: string;
	cost: number;
	tokens: number;
}

/** Group attributable assistant usage by model and all other usage into a separate bucket. */
export function getUsageCostBreakdown(entries: SessionEntry[]): UsageCostBreakdownEntry[] {
	const totalsByKey = new Map<string, UsageTotals>();

	for (const entry of entries) {
		let key: string | undefined;
		let usage: Usage | undefined;
		if (entry.type === "message" && entry.message.role === "assistant") {
			key = `${entry.message.provider}/${entry.message.responseModel ?? entry.message.model}`;
			usage = entry.message.usage;
		} else if (entry.type === "message" && entry.message.role === "toolResult" && entry.message.usage) {
			key = "Tools/summaries";
			usage = entry.message.usage;
		} else if ((entry.type === "branch_summary" || entry.type === "compaction") && entry.usage) {
			key = "Tools/summaries";
			usage = entry.usage;
		}
		if (!key || !usage) continue;

		let totals = totalsByKey.get(key);
		if (!totals) {
			totals = createUsageTotals();
			totalsByKey.set(key, totals);
		}
		addUsageToTotals(totals, usage);
	}

	for (const usage of getUnboundCompactionLedgerUsages(entries)) {
		let totals = totalsByKey.get("Tools/summaries");
		if (!totals) {
			totals = createUsageTotals();
			totalsByKey.set("Tools/summaries", totals);
		}
		addUsageToTotals(totals, usage);
	}

	return Array.from(totalsByKey, ([key, totals]) => ({
		key,
		cost: totals.cost,
		tokens: totals.input + totals.output + totals.cacheRead + totals.cacheWrite,
	}))
		.filter((entry) => entry.cost > 0 || entry.tokens > 0)
		.sort((a, b) => b.cost - a.cost);
}
