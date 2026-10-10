import { enrichModelCapabilities } from "../model-capabilities.ts";
import type { Api, Model } from "../types.ts";
import { isHaiku55Model, profileHaiku55Model } from "./haiku-55-profile.ts";

// Opus 4.6 and Sonnet 4.6 reject binding controls; share the allowlist with replay profiling.
const THINKING_BLOCK_BINDING_MODEL = /(?:^|[^a-z0-9])(?:opus[-_.:\s]+(?:4[-_.:\s]+[78]|5)|(?:sonnet|fable)[-_.:\s]+5)(?=$|[^a-z0-9])/i;

export function isBedrockThinkingBlockBindingModel(model: Pick<Model<Api>, "id" | "name">): boolean {
	return isHaiku55Model(model) || THINKING_BLOCK_BINDING_MODEL.test(model.id) || THINKING_BLOCK_BINDING_MODEL.test(model.name);
}

function modelMatchCandidates(model: Pick<Model<"bedrock-converse-stream">, "id" | "name">): string[] {
	return [model.id, model.name].flatMap((value) => {
		const lower = value.toLowerCase();
		return [lower, lower.replace(/[\s_.:]+/gu, "-")];
	});
}

export function isBedrockAdaptiveReasoningModel(
	model: Pick<Model<"bedrock-converse-stream">, "id" | "name">,
): boolean {
	if (isHaiku55Model(model)) return true;
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
	return enrichModelCapabilities(profileHaiku55Model(model), {
		reasoningMode: isBedrockAdaptiveReasoningModel(model) ? "adaptive" : "budget",
		thoughtSignatureRoundTrip: isBedrockThinkingBlockBindingModel(model) ? true : undefined,
	});
}
