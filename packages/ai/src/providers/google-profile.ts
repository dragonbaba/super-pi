import { enrichModelCapabilities } from "../model-capabilities.ts";
import type { Api, Model, ModelThinkingLevel } from "../types.ts";

function geminiMajorVersion(modelId: string): number | undefined {
	const match = /(?:^|[/_-])gemini-(\d+)(?:\.|-|$)/u.exec(modelId.toLowerCase());
	return match ? Number.parseInt(match[1]!, 10) : undefined;
}

function isLevelReasoningModel(modelId: string): boolean {
	const lower = modelId.toLowerCase();
	const major = geminiMajorVersion(lower);
	return (
		(major !== undefined && major >= 3) ||
		lower === "gemini-flash-latest" ||
		lower === "gemini-flash-lite-latest" ||
		/(?:^|[/_-])gemma-?4(?:-|$)/u.test(lower)
	);
}

function budgetDefaults(modelId: string): Partial<Record<Exclude<ModelThinkingLevel, "off">, number>> {
	const lower = modelId.toLowerCase();
	const known25 = lower.includes("2.5-pro") || lower.includes("2.5-flash");
	const high = lower.includes("2.5-pro") ? 32_768 : known25 ? 24_576 : -1;
	const minimal = lower.includes("2.5-flash-lite") ? 512 : known25 ? 128 : -1;
	if (!known25) return { minimal: -1, low: -1, medium: -1, high: -1, xhigh: -1, max: -1 };
	return { minimal, low: 2_048, medium: 8_192, high, xhigh: high, max: high };
}

/** Enrich a Google-owned catalog model before the generic profile normalizer runs. */
export function profileGoogleModel<TApi extends Api>(model: Model<TApi>): Model<TApi> {
	if (model.api !== "google-generative-ai" && model.api !== "google-vertex") return model;
	const levels = isLevelReasoningModel(model.id);
	return enrichModelCapabilities(
		{
			...model,
			thinkingBudgetMap: levels ? undefined : budgetDefaults(model.id),
		},
		{
			strictToolSchema: (geminiMajorVersion(model.id) ?? 0) >= 3,
			reasoningMode: levels ? "levels" : "budget",
		},
	);
}
