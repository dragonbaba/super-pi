import { enrichModelCapabilities } from "../model-capabilities.ts";
import type { Api, Model } from "../types.ts";

export function profileMistralModel<TApi extends Api>(model: Model<TApi>): Model<TApi> {
	return model.api === "mistral-conversations"
		? enrichModelCapabilities(model, { strictToolSchema: true })
		: model;
}
