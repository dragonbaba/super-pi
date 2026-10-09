import { profileHaiku55Model } from "../src/providers/haiku-55-profile.ts";
import type { Api, Model } from "../src/types.ts";

/** Offline fallback until remote catalogs publish Haiku 5.5. Keep their record if present. */
export function ensureHaiku55CatalogModel(models: Model<Api>[]): void {
	if (models.some((model) => model.provider === "anthropic" && model.id === "claude-haiku-5-5")) return;
	// https://platform.claude.com/docs/en/models/haiku-5-5/overview
	models.push(profileHaiku55Model({
		id: "claude-haiku-5-5",
		name: "Claude Haiku 5.5",
		api: "anthropic-messages",
		provider: "anthropic",
		baseUrl: "https://api.anthropic.com",
		reasoning: true,
		input: ["text", "image"],
		cost: {
			input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125,
			tiers: [{ inputTokensAbove: 100_000, input: 0.5, output: 2.5, cacheRead: 0.05, cacheWrite: 0.625 }],
		},
		contextWindow: 1_000_000,
		maxTokens: 128_000,
		compat: { supportsStrictTools: true },
	}));
}
