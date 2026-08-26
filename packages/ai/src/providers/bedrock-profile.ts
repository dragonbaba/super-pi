import { enrichModelCapabilities } from "../model-capabilities.ts";
import type { Model } from "../types.ts";

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

export function profileBedrockModel(model: Model<"bedrock-converse-stream">): Model<"bedrock-converse-stream"> {
	return enrichModelCapabilities(model, {
		reasoningMode: isBedrockAdaptiveReasoningModel(model) ? "adaptive" : "budget",
	});
}
