import type { ModelCost, ModelCostRates } from "../src/types.ts";

export interface ModelsDevRates {
	input?: number;
	output?: number;
	cache_read?: number;
	cache_write?: number;
}
export interface ModelsDevCost extends ModelsDevRates {
	tiers?: (ModelsDevRates & { tier?: { type?: string; size?: number } })[];
}

function threshold(value: number | undefined): value is number {
	return value !== undefined && Number.isSafeInteger(value) && value >= 0;
}

/**
 * Catalog-time conversion only. models.dev rates are already dollars/million tokens.
 * A supplied base is a fresh, generator-owned record transferred to the result.
 * Raw catalog rates/tiers are never mutated or retained by the generated cost.
 */
export function getModelsDevCost(cost: ModelsDevCost | undefined, base?: ModelCostRates): ModelCost {
	const result: ModelCost = base ?? {
		input: cost?.input ?? 0,
		output: cost?.output ?? 0,
		cacheRead: cost?.cache_read ?? 0,
		cacheWrite: cost?.cache_write ?? 0,
	};
	if (!cost?.tiers) return result;
	for (const tier of cost.tiers) {
		if (tier.tier?.type !== "context" || !threshold(tier.tier.size)) continue;
		(result.tiers ??= []).push({
			inputTokensAbove: tier.tier.size,
			input: tier.input ?? result.input,
			output: tier.output ?? result.output,
			cacheRead: tier.cache_read ?? result.cacheRead,
			cacheWrite: tier.cache_write ?? result.cacheWrite,
		});
	}
	return result;
}

export interface OpenRouterPricingOverride {
	min_prompt_tokens?: number;
	utc_start?: number;
	utc_end?: number;
	utc_days?: string[];
	prompt?: string;
	completion?: string;
	input_cache_read?: string;
	input_cache_write?: string;
}
export interface OpenRouterPricing {
	prompt?: string;
	completion?: string;
	input_cache_read?: string;
	input_cache_write?: string;
	overrides?: OpenRouterPricingOverride[];
}

function perMillion(value: string | number | undefined, fallback = 0): number {
	if (value === undefined || value === "") return fallback;
	const parsed = typeof value === "number" ? value : Number(value);
	return Number.isFinite(parsed) ? Number((parsed * 1_000_000).toFixed(6)) : fallback;
}

export function getOpenRouterCost(pricing: OpenRouterPricing | undefined): ModelCost {
	const result: ModelCost = {
		input: perMillion(pricing?.prompt),
		output: perMillion(pricing?.completion),
		cacheRead: perMillion(pricing?.input_cache_read),
		cacheWrite: perMillion(pricing?.input_cache_write),
	};
	if (!pricing?.overrides) return result;
	for (const override of pricing.overrides) {
		// The catalog's prompt thresholds use the same strict-above convention as
		// ModelCost. Time-dependent prices cannot be represented by that type.
		if (!threshold(override.min_prompt_tokens) || override.utc_start !== undefined ||
			override.utc_end !== undefined || override.utc_days !== undefined) continue;
		(result.tiers ??= []).push({
			inputTokensAbove: override.min_prompt_tokens,
			input: perMillion(override.prompt, result.input),
			output: perMillion(override.completion, result.output),
			cacheRead: perMillion(override.input_cache_read, result.cacheRead),
			cacheWrite: perMillion(override.input_cache_write, result.cacheWrite),
		});
	}
	return result;
}

/** Gateway brackets use inclusive min and exclusive max, both in prompt tokens. */
export interface AiGatewayPriceTier {
	cost?: string | number;
	min?: number;
	max?: number;
}
export interface AiGatewayPricing {
	input?: string | number;
	output?: string | number;
	input_cache_read?: string | number;
	input_cache_write?: string | number;
	input_tiers?: AiGatewayPriceTier[];
	output_tiers?: AiGatewayPriceTier[];
	input_cache_read_tiers?: AiGatewayPriceTier[];
	input_cache_write_tiers?: AiGatewayPriceTier[];
}
const GATEWAY_TIER_FIELDS = ["input_tiers", "output_tiers", "input_cache_read_tiers", "input_cache_write_tiers"] as const;

function validBracket(bracket: AiGatewayPriceTier): boolean {
	return threshold(bracket.min ?? 0) &&
		(bracket.max === undefined || (threshold(bracket.max) && bracket.max > (bracket.min ?? 0)));
}

function gatewayRate(brackets: AiGatewayPriceTier[] | undefined, tokens: number, fallback: number): number {
	if (brackets) {
		for (const bracket of brackets) {
			if (validBracket(bracket) && (bracket.min ?? 0) <= tokens &&
				(bracket.max === undefined || tokens < bracket.max)) return perMillion(bracket.cost, fallback);
		}
	}
	return fallback;
}

function ascending(left: number, right: number): number { return left - right; }

export function getAiGatewayCost(pricing: AiGatewayPricing | undefined): ModelCost {
	const base: ModelCost = {
		input: perMillion(pricing?.input),
		output: perMillion(pricing?.output),
		cacheRead: perMillion(pricing?.input_cache_read),
		cacheWrite: perMillion(pricing?.input_cache_write),
	};
	if (!pricing || !(pricing.input_tiers?.length || pricing.output_tiers?.length ||
		pricing.input_cache_read_tiers?.length || pricing.input_cache_write_tiers?.length)) return base;
	const boundaries = new Set<number>();
	for (const field of GATEWAY_TIER_FIELDS) {
		const brackets = pricing[field];
		if (!brackets) continue;
		for (const bracket of brackets) {
			if (!validBracket(bracket)) continue;
			if (bracket.min !== undefined && bracket.min > 0) boundaries.add(bracket.min);
			// Include ends as well as starts so gaps revert to the scalar base price.
			if (bracket.max !== undefined) boundaries.add(bracket.max);
		}
	}
	const result: ModelCost = {
		input: gatewayRate(pricing.input_tiers, 0, base.input),
		output: gatewayRate(pricing.output_tiers, 0, base.output),
		cacheRead: gatewayRate(pricing.input_cache_read_tiers, 0, base.cacheRead),
		cacheWrite: gatewayRate(pricing.input_cache_write_tiers, 0, base.cacheWrite),
	};
	const starts = Array.from(boundaries).sort(ascending);
	for (const start of starts) {
		(result.tiers ??= []).push({
			inputTokensAbove: start - 1,
			input: gatewayRate(pricing.input_tiers, start, base.input),
			output: gatewayRate(pricing.output_tiers, start, base.output),
			cacheRead: gatewayRate(pricing.input_cache_read_tiers, start, base.cacheRead),
			cacheWrite: gatewayRate(pricing.input_cache_write_tiers, start, base.cacheWrite),
		});
	}
	return result;
}
