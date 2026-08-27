import { mistralConversationsApi } from "../api/mistral-conversations.lazy.ts";
import { envApiKeyAuth } from "../auth/helpers.ts";
import { createProvider, type Provider } from "../models.ts";
import { MISTRAL_MODELS } from "./mistral.models.ts";
import { profileMistralModel } from "./mistral-profile.ts";

const MISTRAL_MODEL_CATALOG = Object.values(MISTRAL_MODELS);

export function mistralProvider(): Provider<"mistral-conversations"> {
	return createProvider({
		id: "mistral",
		name: "Mistral",
		baseUrl: "https://api.mistral.ai",
		auth: { apiKey: envApiKeyAuth("Mistral API key", ["MISTRAL_API_KEY"]) },
		models: MISTRAL_MODEL_CATALOG,
		profileModel: profileMistralModel,
		api: mistralConversationsApi(),
	});
}
