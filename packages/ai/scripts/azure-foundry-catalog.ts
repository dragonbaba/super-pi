import type { Api, Model } from "../src/types.ts";

/** Call after native metadata so Foundry does not inherit DeepSeek's high/max dialect. */
export function addAzureFoundryModels(models: Model<Api>[]): void {
	if (models.some(model => model.provider === "azure-openai-responses" && model.id === "deepseek-v4-pro")) return;
	const source = models.find((model): model is Model<"openai-completions"> =>
		model.provider === "deepseek" && model.id === "deepseek-v4-pro" && model.api === "openai-completions");
	if (!source) return;
	models.push({
		...source,
		provider: "azure-openai-responses",
		baseUrl: "",
		// Fixed upstream v1.1.0 snapshot: Azure US data zone, checked 2026-09-16.
		cost: { input: 1.925, output: 3.828, cacheRead: 0.165, cacheWrite: 0 },
		compat: {
			...source.compat,
			supportsStore: false,
			supportsDeveloperRole: false,
			supportsMidConvoSystemMessages: true,
			supportsReasoningEffort: true,
			requiresReasoningContentOnAssistantMessages: true,
			thinkingFormat: "openai",
			supportsLongCacheRetention: false,
		},
		thinkingLevelMap: { minimal: null, low: "low", medium: "medium", high: "high", xhigh: null, max: null },
	});
}
