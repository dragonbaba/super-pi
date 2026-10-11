import { azureOpenAIResponsesApi } from "../api/azure-openai-responses.lazy.ts";
import { openAICompletionsApi } from "../api/openai-completions.lazy.ts";
import { envApiKeyAuth } from "../auth/helpers.ts";
import { enrichModelCapabilities } from "../model-capabilities.ts";
import { createProvider, type Provider } from "../models.ts";
import type { Model } from "../types.ts";
import { AZURE_OPENAI_RESPONSES_MODELS } from "./azure-openai-responses.models.ts";

type AzureApi = "azure-openai-responses" | "openai-completions";

function profileAzureModel(model: Model<AzureApi>): Model<AzureApi> {
	return model.api === "openai-completions" && model.id === "deepseek-v4-pro"
		? enrichModelCapabilities(model, { thoughtSignatureRoundTrip: true }) : model;
}

export function azureOpenAIResponsesProvider(): Provider<AzureApi> {
	return createProvider({
		id: "azure-openai-responses",
		name: "Azure Foundry",
		auth: { apiKey: envApiKeyAuth("Azure OpenAI API key", ["AZURE_OPENAI_API_KEY"]) },
		models: Object.values(AZURE_OPENAI_RESPONSES_MODELS),
		profileModel: profileAzureModel,
		api: {
			"azure-openai-responses": azureOpenAIResponsesApi(),
			"openai-completions": openAICompletionsApi(),
		},
	});
}
