import { mistralConversationsApi } from "../api/mistral-conversations.lazy.ts";
import { envApiKeyAuth } from "../auth/helpers.ts";
import { createProvider, type Provider } from "../models.ts";
import { enrichModelCapabilities } from "../model-capabilities.ts";
import { MISTRAL_MODELS } from "./mistral.models.ts";

export function mistralProvider(): Provider<"mistral-conversations"> {
	return createProvider({
		id: "mistral",
		name: "Mistral",
		baseUrl: "https://api.mistral.ai",
		auth: { apiKey: envApiKeyAuth("Mistral API key", ["MISTRAL_API_KEY"]) },
		models: Object.values(MISTRAL_MODELS).map((model) =>
			enrichModelCapabilities(model, { strictToolSchema: true }),
		),
		api: mistralConversationsApi(),
	});
}
