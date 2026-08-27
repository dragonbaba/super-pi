import { enrichModelCapabilities } from "../model-capabilities.ts";
import type { Api, Model } from "../types.ts";

function modelMatchCandidates(model: Pick<Model<"bedrock-converse-stream">, "id" | "name">): string[] {
	return [model.id, model.name].flatMap((value) => {
		const lower = value.toLowerCase();
		return [lower, lower.replace(/[\s_.:]+/gu, "-")];
	});
}

export function isBedrockAdaptiveReasoningModel(
	model: Pick<Model<"bedrock-converse-stream">, "id" | "name">,
): boolean {
	return modelMatchCandidates(model).some(
		(value) =>
			value.includes("opus-4-6") ||
			value.includes("opus-4-7") ||
			value.includes("opus-4-8") ||
			value.includes("opus-5") ||
			value.includes("sonnet-4-6") ||
			value.includes("sonnet-5") ||
			value.includes("fable-5"),
	);
}


export function profileBedrockModel<TApi extends Api>(model: Model<TApi>): Model<TApi> {
	if (model.api !== "bedrock-converse-stream") return model;
	return enrichModelCapabilities(model, {
		reasoningMode: isBedrockAdaptiveReasoningModel(model) ? "adaptive" : "budget",
	});
}
