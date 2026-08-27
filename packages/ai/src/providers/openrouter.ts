import { openAICompletionsApi } from "../api/openai-completions.lazy.ts";
import { envApiKeyAuth, lazyOAuth } from "../auth/helpers.ts";
import { loadOpenRouterOAuth } from "../auth/oauth/load.ts";
import { createProvider, type Provider } from "../models.ts";
import type { Model } from "../types.ts";
import { OPENROUTER_MODELS } from "./openrouter.models.ts";

const UNKNOWN_COST_ROUTER_IDS = new Set([
	"auto",
	"openrouter/auto",
	"openrouter/auto-beta",
	"openrouter/fusion",
]);

function profileOpenRouterModel(model: Model<"openai-completions">): Model<"openai-completions"> {
	return UNKNOWN_COST_ROUTER_IDS.has(model.id) ? { ...model, costKnown: false } : model;
}

export function openrouterProvider(): Provider<"openai-completions"> {
	return createProvider({
		id: "openrouter",
		name: "OpenRouter",
		baseUrl: "https://openrouter.ai/api/v1",
		auth: {
			apiKey: envApiKeyAuth("OpenRouter API key", ["OPENROUTER_API_KEY"]),
			oauth: lazyOAuth({
				name: "OpenRouter OAuth",
				loginLabel: "Sign in with OpenRouter",
				load: loadOpenRouterOAuth,
			}),
		},
		models: Object.values(OPENROUTER_MODELS),
		profileModel: profileOpenRouterModel,
		api: openAICompletionsApi(),
	});
}
